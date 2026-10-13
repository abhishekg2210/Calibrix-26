import { CityConfig, clockRate } from '../config';
import { CityModel, LandUse } from '../model/types';
import { LaneGraph, RoadSeg } from '../graph/laneGraph';
import { Rng } from './rng';

/**
 * Zone-based origin–destination demand.
 *
 * Trip purposes have time-of-day intensity curves over the compressed 24h
 * clock and zone production/attraction weights. The result: morning flow
 * residential -> office core, evening reverse, midday commercial churn.
 */

export interface TripRequest {
  originBuilding: number;
  destBuilding: number;
  /** Curb position for vehicle trips. */
  originEdge: number;
  originPos: number;
  destEdge: number;
  destPos: number;
  distM: number;     // straight-line, for mode choice
  isAV: boolean;
}

interface Purpose {
  name: string;
  /** Intensity at clock hour h (0..1-ish). */
  curve: (h: number) => number;
  production: Record<LandUse, number>;  // origin weights
  attraction: Record<LandUse, number>;  // destination weights
}

const gauss = (h: number, mu: number, sigma: number) => {
  // wrap-around distance on 24h circle
  let d = Math.abs(h - mu);
  if (d > 12) d = 24 - d;
  return Math.exp(-(d * d) / (2 * sigma * sigma));
};

const PURPOSES: Purpose[] = [
  {
    name: 'commute-am',
    curve: h => gauss(h, 8.1, 1.1),
    production: { residential: 10, office: 0.2, commercial: 0.3, civic: 0.2, park: 0 },
    attraction: { residential: 0.3, office: 10, commercial: 2.5, civic: 1.5, park: 0.1 },
  },
  {
    name: 'commute-pm',
    curve: h => gauss(h, 17.4, 1.4),
    production: { residential: 0.3, office: 10, commercial: 2.5, civic: 1.5, park: 0.1 },
    attraction: { residential: 10, office: 0.2, commercial: 1.5, civic: 0.2, park: 0.4 },
  },
  {
    name: 'errands',
    curve: h => 0.55 * gauss(h, 12.6, 2.6),
    production: { residential: 4, office: 4, commercial: 1, civic: 1, park: 0.5 },
    attraction: { residential: 0.5, office: 0.5, commercial: 8, civic: 2, park: 1.5 },
  },
  {
    name: 'leisure',
    curve: h => 0.5 * gauss(h, 20.0, 1.8),
    production: { residential: 6, office: 0.5, commercial: 0.5, civic: 0.2, park: 0.2 },
    attraction: { residential: 1.5, office: 0.1, commercial: 5, civic: 0.5, park: 3 },
  },
  {
    name: 'base',
    curve: () => 0.1,
    production: { residential: 3, office: 2, commercial: 2, civic: 1, park: 0.5 },
    attraction: { residential: 3, office: 2, commercial: 2, civic: 1, park: 0.5 },
  },
];

/** Trips shorter than this (straight line) become pedestrian trips. */
export const WALK_DIST_M = 220;

/** Total trip intensity at clock hour h (shared with UI curve display). */
export function demandIntensity(h: number): number {
  let sum = 0;
  for (const p of PURPOSES) sum += p.curve(h);
  return Math.min(1.35, sum);
}

export class DemandEngine {
  private cfg: CityConfig;
  private model: CityModel;
  private rng: Rng;
  /** Per-building curb point on the nearest curb-lane edge. */
  curbEdge: Int32Array;
  curbPos: Float64Array;
  /** Buildings by land use for weighted picking. */
  private byUse: Record<LandUse, number[]>;
  /** Peak vehicle spawns per sim second, derived from maxVehicles. */
  private peakRate: number;
  private carryover = 0;

  constructor(cfg: CityConfig, model: CityModel, graph: LaneGraph, rng: Rng) {
    this.cfg = cfg;
    this.model = model;
    this.rng = rng;

    const n = model.buildings.length;
    this.curbEdge = new Int32Array(n).fill(-1);
    this.curbPos = new Float64Array(n);
    this.byUse = { residential: [], office: [], commercial: [], civic: [], park: [] };
    for (const b of model.buildings) this.byUse[b.landUse].push(b.id);

    this.computeCurbPoints(graph);

    // Size peak demand from network capacity via Little's law:
    // sustainable active vehicles = lane-meters at "busy" density, and trip
    // duration must use the CONGESTED effective speed (signals + queues), not
    // free flow — otherwise inflow permanently exceeds outflow and the city
    // ratchets into gridlock. demandScale > 1 pushes past capacity
    // deliberately (gridlock experiments); maxVehicles stays a hard ceiling.
    let laneMeters = 0;
    for (const s of graph.segs) laneMeters += s.length * s.laneEdges.length;
    const sustainable = Math.min(laneMeters / 70, cfg.maxVehicles * 0.85);
    const avgTripM = 0.45 * (model.totalWidth + model.totalHeight);
    const avgTripS = avgTripM / 3.2; // congested effective speed
    // Empirical calibration: intersection service (not lane storage) binds in
    // the demand-heavy core, so raw lane-density targets oversaturate it.
    const FLOW_CALIBRATION = 0.55;
    this.peakRate = (sustainable / avgTripS) * FLOW_CALIBRATION;
  }

  /**
   * Map each building to a (edge, pos) curb point on the curb lane of one of
   * the four directed road segments circulating its block (E top, S right,
   * W bottom, N left — a clockwise loop).
   */
  private computeCurbPoints(graph: LaneGraph) {
    // Index directed segs by (orientation, dir, fromInter,toInter) -> nearest lookup per block instead:
    // For block (i,j): top road = h road i between inters (i,j)-(i,j+1) dir E;
    // bottom = h road i+1 dir W; left = v road j dir N; right = v road j+1 dir S.
    const { cols } = this.model;
    const interId = (i: number, j: number) => i * (cols + 1) + j;
    const segByKey = new Map<string, RoadSeg>();
    for (const s of graph.segs) segByKey.set(`${s.fromInter}|${s.toInter}`, s);

    for (const b of this.model.buildings) {
      const i = b.blockRow, j = b.blockCol;
      const candidates: RoadSeg[] = [];
      const push = (s: RoadSeg | undefined) => { if (s) candidates.push(s); };
      push(segByKey.get(`${interId(i, j)}|${interId(i, j + 1)}`));         // E along top
      push(segByKey.get(`${interId(i, j + 1)}|${interId(i + 1, j + 1)}`)); // S along right
      push(segByKey.get(`${interId(i + 1, j + 1)}|${interId(i + 1, j)}`)); // W along bottom
      push(segByKey.get(`${interId(i + 1, j)}|${interId(i, j)}`));         // N along left

      let best: RoadSeg | null = null;
      let bestD = Infinity;
      let bestT = 0;
      for (const s of candidates) {
        // Project building center onto segment centerline.
        const dx = s.bx - s.ax, dy = s.by - s.ay;
        const len2 = dx * dx + dy * dy || 1e-9;
        let t = ((b.x - s.ax) * dx + (b.y - s.ay) * dy) / len2;
        t = Math.max(0.12, Math.min(0.88, t));
        const px = s.ax + dx * t, py = s.ay + dy * t;
        const d = Math.hypot(b.x - px, b.y - py);
        if (d < bestD) { bestD = d; best = s; bestT = t; }
      }
      if (best) {
        const curbLane = best.laneEdges[best.laneEdges.length - 1];
        this.curbEdge[b.id] = curbLane;
        this.curbPos[b.id] = bestT * best.length;
      }
    }
  }

  /** Total vehicle-trip intensity in [0,1] at clock hour h. */
  intensity(h: number): number {
    return demandIntensity(h);
  }

  /** Clock hour for sim time t. */
  clockHour(t: number): number {
    return (this.cfg.startHour + (t * clockRate(this.cfg)) / 3600) % 24;
  }

  /**
   * Generate trip requests for this tick. Walk-length trips are returned in
   * `walks` (consumed by the pedestrian system; ignored until Phase 3).
   */
  generate(t: number, dt: number, demandMultiplier: number, avShare: number): { drives: TripRequest[]; walks: TripRequest[] } {
    const h = this.clockHour(t);
    const rate = this.peakRate * this.intensity(h) * this.cfg.demandScale * demandMultiplier;
    // Pedestrian demand rides along at a fixed multiple of vehicle demand.
    const expected = rate * dt * 1.5 + this.carryover;
    let n = Math.floor(expected);
    this.carryover = expected - n;

    const drives: TripRequest[] = [];
    const walks: TripRequest[] = [];

    // Purpose weights at this hour.
    const weights = PURPOSES.map(p => p.curve(h));

    while (n-- > 0) {
      const p = PURPOSES[this.rng.weighted(weights)];
      const ob = this.pickBuilding(p.production);
      const db = this.pickBuilding(p.attraction);
      if (ob < 0 || db < 0) continue;
      const o = this.model.buildings[ob];
      const d = this.model.buildings[db];
      if (o.blockRow === d.blockRow && o.blockCol === d.blockCol) continue;
      if (this.curbEdge[ob] < 0 || this.curbEdge[db] < 0) continue;

      const dist = Math.hypot(o.x - d.x, o.y - d.y);
      const req: TripRequest = {
        originBuilding: ob, destBuilding: db,
        originEdge: this.curbEdge[ob], originPos: this.curbPos[ob],
        destEdge: this.curbEdge[db], destPos: this.curbPos[db],
        distM: dist,
        isAV: this.rng.next() < avShare,
      };
      // Mode choice: short trips walk; medium trips sometimes walk; nobody
      // walks across the whole city in one go.
      if (dist < WALK_DIST_M) walks.push(req);
      else if (dist < 480 && this.rng.next() < 0.3) walks.push(req);
      else drives.push(req);
    }
    return { drives, walks };
  }

  private pickBuilding(weights: Record<LandUse, number>): number {
    const uses = Object.keys(weights) as LandUse[];
    const usable = uses.filter(u => this.byUse[u].length > 0 && weights[u] > 0);
    if (usable.length === 0) return -1;
    const u = usable[this.rng.weighted(usable.map(x => weights[x]))];
    const list = this.byUse[u];
    return list[this.rng.int(list.length)];
  }
}
