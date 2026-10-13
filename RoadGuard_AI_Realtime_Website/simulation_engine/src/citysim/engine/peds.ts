import { WalkGraph, WalkRouter } from '../graph/walkGraph';
import { CityModel } from '../model/types';
import { SignalController } from './signals';
import { Rng } from './rng';
import { TripRequest } from './demand';

/**
 * Pedestrian simulation over the walk graph. Point agents: walk along edges,
 * queue at crosswalks until their walk phase, despawn on arrival. Tracks
 * per-intersection-side crosswalk occupancy so vehicles can yield.
 */
export class PedSim {
  private g: WalkGraph;
  private router: WalkRouter;
  private rng: Rng;
  private model: CityModel;

  readonly cap: number;
  count = 0;
  highWater = 0;
  alive: Uint8Array;
  /** Route as edge ids; segIdx = current edge index. */
  routes: (Int32Array | null)[];
  segIdx: Int32Array;
  /** Current edge traversal: fromNode, toNode and distance along. */
  fromNode: Int32Array;
  toNode: Int32Array;
  pos: Float64Array;
  speed: Float32Array;        // personal walking speed
  waiting: Uint8Array;        // 1 = held at crosswalk
  /** Perpendicular jitter so crowds don't collapse onto a line. */
  jitter: Float32Array;
  x: Float32Array;
  y: Float32Array;
  heading: Float32Array;
  spawnT: Float64Array;

  /** Crossing pedestrians per intersection side: [interId*4 + side]. */
  crosswalkOcc: Uint8Array;
  /** Waiting pedestrians per intersection (KPI). */
  waitingCount = 0;
  arrivals = 0;

  private free: number[] = [];

  constructor(g: WalkGraph, model: CityModel, nInter: number, cap: number, rng: Rng) {
    this.g = g;
    this.model = model;
    this.router = new WalkRouter(g);
    this.rng = rng;
    this.cap = cap;
    this.alive = new Uint8Array(cap);
    this.routes = new Array(cap).fill(null);
    this.segIdx = new Int32Array(cap);
    this.fromNode = new Int32Array(cap);
    this.toNode = new Int32Array(cap);
    this.pos = new Float64Array(cap);
    this.speed = new Float32Array(cap);
    this.waiting = new Uint8Array(cap);
    this.jitter = new Float32Array(cap);
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.heading = new Float32Array(cap);
    this.spawnT = new Float64Array(cap);
    this.crosswalkOcc = new Uint8Array(nInter * 4);
  }

  /** Nearest corner node of a building's own block. */
  private buildingNode(buildingId: number): number {
    const b = this.model.buildings[buildingId];
    const base = (b.blockRow * this.model.cols + b.blockCol) * 4;
    let best = base, bestD = Infinity;
    for (let c = 0; c < 4; c++) {
      const n = base + c;
      const d = Math.hypot(this.g.nx[n] - b.x, this.g.ny[n] - b.y);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  trySpawn(req: TripRequest, t: number): boolean {
    if (this.count >= this.cap) return false;
    const a = this.buildingNode(req.originBuilding);
    const b = this.buildingNode(req.destBuilding);
    if (a === b) return false;
    const route = this.router.route(a, b);
    if (!route || route.length === 0) return false;

    let slot: number;
    if (this.free.length > 0) slot = this.free.pop()!;
    else if (this.highWater < this.cap) slot = this.highWater++;
    else return false;

    this.alive[slot] = 1;
    this.count++;
    this.routes[slot] = route;
    this.segIdx[slot] = 0;
    this.setEdgeTraversal(slot, a, route[0]);
    this.pos[slot] = 0;
    this.speed[slot] = 1.15 + this.rng.next() * 0.55;
    this.waiting[slot] = 0;
    this.jitter[slot] = (this.rng.next() - 0.5) * 1.6;
    this.spawnT[slot] = t;
    this.updatePose(slot);
    return true;
  }

  private setEdgeTraversal(slot: number, from: number, edgeId: number) {
    const e = this.g.edges[edgeId];
    this.fromNode[slot] = from;
    this.toNode[slot] = e.a === from ? e.b : e.a;
  }

  tick(dt: number, signals: SignalController) {
    this.crosswalkOcc.fill(0);
    this.waitingCount = 0;
    const g = this.g;

    for (let i = 0; i < this.highWater; i++) {
      if (!this.alive[i]) continue;
      const route = this.routes[i]!;
      let idx = this.segIdx[i];
      let e = g.edges[route[idx]];

      // Crosswalk gate at the start of a crossing.
      if (e.kind === 1 && this.pos[i] < 0.5) {
        // Enter only while the walk phase is on AND enough time remains —
        // a real "don't start on flashing hand" rule.
        const open = signals.current[e.interId] === e.walkPhase
          && signals.remaining[e.interId] > e.length / this.speed[i] * 0.55;
        if (!open) {
          this.waiting[i] = 1;
          this.waitingCount++;
          continue;
        }
      }
      this.waiting[i] = 0;

      this.pos[i] += this.speed[i] * dt;

      // Mark crosswalk occupancy while on it.
      if (e.kind === 1) {
        const k = e.interId * 4 + e.side;
        if (this.crosswalkOcc[k] < 255) this.crosswalkOcc[k]++;
      }

      while (this.pos[i] >= g.edges[route[idx]].length) {
        this.pos[i] -= g.edges[route[idx]].length;
        const arrivedAt = this.toNode[i];
        idx++;
        if (idx >= route.length) {
          this.despawn(i);
          idx = -1;
          break;
        }
        this.segIdx[i] = idx;
        this.setEdgeTraversal(i, arrivedAt, route[idx]);
        e = g.edges[route[idx]];
        // If the next edge is a crosswalk and we just landed at its start,
        // hold any remaining progress for the gate check next tick.
        if (e.kind === 1) { this.pos[i] = 0; break; }
      }
      if (idx === -1) continue;
      this.updatePose(i);
    }
  }

  private updatePose(i: number) {
    const g = this.g;
    const a = this.fromNode[i], b = this.toNode[i];
    const ax = g.nx[a], ay = g.ny[a], bx = g.nx[b], by = g.ny[b];
    const e = g.edges[this.routes[i]![this.segIdx[i]]];
    const t = Math.min(1, this.pos[i] / e.length);
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len, py = dx / len;
    this.x[i] = ax + dx * t + px * this.jitter[i];
    this.y[i] = ay + dy * t + py * this.jitter[i];
    this.heading[i] = Math.atan2(dy, dx);
  }

  private despawn(i: number) {
    this.alive[i] = 0;
    this.routes[i] = null;
    this.count--;
    this.arrivals++;
    this.free.push(i);
    if (this.free.length > 1) this.free.sort((a, b) => b - a);
  }
}
