import { CityModel, DIR_VEC, RIGHT_VEC, rightOf, leftOf } from '../model/types';

/**
 * Lane-level directed road network.
 *
 * Edges are the atoms of the network — vehicles always live on exactly one
 * edge at a distance `pos` along it. Two kinds:
 *  - road edges: one lane of one directed road segment between two intersections
 *  - connectors: turn/straight movements through an intersection, signal-gated
 *
 * Routing is edge-based A*: neighbors(edge) = edge.next (continuations) plus
 * parallel-lane edges (lane changes, small penalty).
 */

export const TURN_STRAIGHT = 0;
export const TURN_RIGHT = 1;
export const TURN_LEFT = 2;

// Signal phases. NS = traffic on vertical roads (dirs S/N), EW = horizontal (E/W).
export const PHASE_NS_STRAIGHT = 0;
export const PHASE_NS_LEFT = 1;
export const PHASE_EW_STRAIGHT = 2;
export const PHASE_EW_LEFT = 3;
export const PHASE_COUNT = 4;

export interface LaneEdge {
  id: number;
  kind: 0 | 1;              // 0 = road, 1 = connector
  /** Polyline geometry (straights: 2 pts; turns: sampled bezier). */
  pts: Float32Array;        // [x0,y0,x1,y1,...]
  cum: Float32Array;        // cumulative arc length per point, cum[0]=0
  length: number;
  speedLimit: number;       // m/s
  dir: number;              // direction of travel (road) / exit direction (connector)
  lane: number;             // lane index: 0 = innermost(left) .. lpd-1 = curb(right)
  segId: number;            // directed road-segment group id (roads), -1 for connectors
  interId: number;          // intersection id (connectors), -1 for roads
  turnType: number;         // connectors only
  phaseMask: number;        // bitmask of phases this connector is open; 0xF for roads
  next: number[];           // edge ids continuing after this edge
  leftEdge: number;         // parallel lane edge toward lane-1 (-1 if none), roads only
  rightEdge: number;        // parallel lane edge toward lane+1
  closed: boolean;          // intervention: closed to routing/entry
}

/** Directed road segment metadata (heatmap/metrics granularity). */
export interface RoadSeg {
  id: number;
  orientation: 'h' | 'v';
  dir: number;
  fromInter: number;
  toInter: number;
  /** Centerline of this directed half of the road. */
  ax: number; ay: number; bx: number; by: number;
  laneEdges: number[];      // edge ids, by lane index
  length: number;
}

export interface LaneGraph {
  edges: LaneEdge[];
  segs: RoadSeg[];
  /** Connector edge ids per intersection id. */
  interConnectors: number[][];
  /** Road edge ids entering each intersection (approach edges). */
  interApproaches: number[][];
  /** For each road edge: connector ids that feed into it (merge conflicts). */
  feeders: number[][];
  lanesPerDirection: number;
  laneWidth: number;
}

const ROAD_SPEED = 13.4;        // ~30 mph
const STRAIGHT_CONN_SPEED = 10;
const RIGHT_TURN_SPEED = 5.5;
const LEFT_TURN_SPEED = 6.5;

export function buildLaneGraph(model: CityModel): LaneGraph {
  const { rows, cols, roadWidth, lanesPerDirection: lpd, laneWidth, vRoadX, hRoadY } = model;
  const half = roadWidth / 2;
  const interId = (i: number, j: number) => i * (cols + 1) + j;

  const edges: LaneEdge[] = [];
  const segs: RoadSeg[] = [];
  // Node keys: entry/exit points around intersections, used only at build time.
  const outgoingFromExit = new Map<string, number[]>(); // exit node -> road edge ids leaving it
  const entryEdges = new Map<string, number>();          // entry node -> road edge arriving at it

  const entKey = (ii: number, d: number, k: number) => `${ii}|e|${d}|${k}`;
  const exiKey = (ii: number, d: number, k: number) => `${ii}|x|${d}|${k}`;

  /** Stop-line point where dir-d traffic in lane k enters intersection (i,j). */
  function entryPoint(i: number, j: number, d: number, k: number): [number, number] {
    const cx = vRoadX[j], cy = hRoadY[i];
    const v = DIR_VEC[d], r = RIGHT_VEC[d];
    const off = (k + 0.5) * laneWidth;
    return [cx - v[0] * half + r[0] * off, cy - v[1] * half + r[1] * off];
  }
  /** Point where dir-d traffic in lane k exits intersection (i,j). */
  function exitPoint(i: number, j: number, d: number, k: number): [number, number] {
    const cx = vRoadX[j], cy = hRoadY[i];
    const v = DIR_VEC[d], r = RIGHT_VEC[d];
    const off = (k + 0.5) * laneWidth;
    return [cx + v[0] * half + r[0] * off, cy + v[1] * half + r[1] * off];
  }

  function addRoadEdge(
    fromI: number, fromJ: number, toI: number, toJ: number,
    d: number, k: number, segId: number,
  ): number {
    const [ax, ay] = exitPoint(fromI, fromJ, d, k);
    const [bx, by] = entryPoint(toI, toJ, d, k);
    const length = Math.hypot(bx - ax, by - ay);
    const id = edges.length;
    edges.push({
      id, kind: 0,
      pts: new Float32Array([ax, ay, bx, by]),
      cum: new Float32Array([0, length]),
      length,
      speedLimit: ROAD_SPEED,
      dir: d, lane: k, segId, interId: -1,
      turnType: TURN_STRAIGHT, phaseMask: 0xf,
      next: [], leftEdge: -1, rightEdge: -1, closed: false,
    });
    const fromKey = exiKey(interId(fromI, fromJ), d, k);
    let list = outgoingFromExit.get(fromKey);
    if (!list) outgoingFromExit.set(fromKey, (list = []));
    list.push(id);
    entryEdges.set(entKey(interId(toI, toJ), d, k), id);
    return id;
  }

  // --- Road edges: horizontal roads ---
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j < cols; j++) {
      for (const d of [0, 2]) { // E, W
        const [fi, fj, ti, tj] = d === 0 ? [i, j, i, j + 1] : [i, j + 1, i, j];
        const segId = segs.length;
        const laneEdges: number[] = [];
        for (let k = 0; k < lpd; k++) laneEdges.push(addRoadEdge(fi, fj, ti, tj, d, k, segId));
        const e0 = edges[laneEdges[0]];
        segs.push({
          id: segId, orientation: 'h', dir: d,
          fromInter: interId(fi, fj), toInter: interId(ti, tj),
          ax: e0.pts[0], ay: hRoadY[i] + (d === 0 ? 1 : -1) * (laneWidth * lpd) / 2,
          bx: e0.pts[2], by: hRoadY[i] + (d === 0 ? 1 : -1) * (laneWidth * lpd) / 2,
          laneEdges, length: e0.length,
        });
      }
    }
  }
  // --- Road edges: vertical roads ---
  for (let j = 0; j <= cols; j++) {
    for (let i = 0; i < rows; i++) {
      for (const d of [1, 3]) { // S, N
        const [fi, fj, ti, tj] = d === 1 ? [i, j, i + 1, j] : [i + 1, j, i, j];
        const segId = segs.length;
        const laneEdges: number[] = [];
        for (let k = 0; k < lpd; k++) laneEdges.push(addRoadEdge(fi, fj, ti, tj, d, k, segId));
        const e0 = edges[laneEdges[0]];
        segs.push({
          id: segId, orientation: 'v', dir: d,
          fromInter: interId(fi, fj), toInter: interId(ti, tj),
          ax: vRoadX[j] + (d === 1 ? -1 : 1) * (laneWidth * lpd) / 2, ay: e0.pts[1],
          bx: vRoadX[j] + (d === 1 ? -1 : 1) * (laneWidth * lpd) / 2, by: e0.pts[3],
          laneEdges, length: e0.length,
        });
      }
    }
  }

  // Parallel-lane adjacency.
  for (const seg of segs) {
    for (let k = 0; k < seg.laneEdges.length; k++) {
      const e = edges[seg.laneEdges[k]];
      e.leftEdge = k > 0 ? seg.laneEdges[k - 1] : -1;
      e.rightEdge = k < seg.laneEdges.length - 1 ? seg.laneEdges[k + 1] : -1;
    }
  }

  // --- Connectors ---
  const nInter = (rows + 1) * (cols + 1);
  const interConnectors: number[][] = Array.from({ length: nInter }, () => []);
  const interApproaches: number[][] = Array.from({ length: nInter }, () => []);

  function movementPhase(d: number, turn: number): number {
    const isNS = d === 1 || d === 3;
    if (turn === TURN_LEFT) return isNS ? PHASE_NS_LEFT : PHASE_EW_LEFT;
    return isNS ? PHASE_NS_STRAIGHT : PHASE_EW_STRAIGHT;
  }

  function addConnector(i: number, j: number, d: number, k: number, turn: number): number | null {
    const outDir = turn === TURN_STRAIGHT ? d : turn === TURN_RIGHT ? rightOf(d) : leftOf(d);
    const ii = interId(i, j);
    // Turns land in the matching curb/inner lane of the exit road.
    const outLane = turn === TURN_STRAIGHT ? k : turn === TURN_RIGHT ? lpd - 1 : 0;
    const outEdges = outgoingFromExit.get(exiKey(ii, outDir, outLane));
    if (!outEdges || outEdges.length === 0) return null;

    const [ax, ay] = entryPoint(i, j, d, k);
    const [bx, by] = exitPoint(i, j, outDir, outLane);

    let pts: Float32Array, cum: Float32Array, length: number;
    if (turn === TURN_STRAIGHT) {
      length = Math.hypot(bx - ax, by - ay);
      pts = new Float32Array([ax, ay, bx, by]);
      cum = new Float32Array([0, length]);
    } else {
      // Quadratic bezier through the corner control point.
      const horizIn = d === 0 || d === 2;
      const cxp = horizIn ? bx : ax;
      const cyp = horizIn ? ay : by;
      const SAMPLES = 12;
      pts = new Float32Array((SAMPLES + 1) * 2);
      cum = new Float32Array(SAMPLES + 1);
      let prevX = ax, prevY = ay, acc = 0;
      for (let s = 0; s <= SAMPLES; s++) {
        const t = s / SAMPLES;
        const mt = 1 - t;
        const x = mt * mt * ax + 2 * mt * t * cxp + t * t * bx;
        const y = mt * mt * ay + 2 * mt * t * cyp + t * t * by;
        pts[s * 2] = x; pts[s * 2 + 1] = y;
        if (s > 0) acc += Math.hypot(x - prevX, y - prevY);
        cum[s] = acc;
        prevX = x; prevY = y;
      }
      length = acc;
    }

    const id = edges.length;
    edges.push({
      id, kind: 1, pts, cum, length,
      speedLimit: turn === TURN_STRAIGHT ? STRAIGHT_CONN_SPEED : turn === TURN_RIGHT ? RIGHT_TURN_SPEED : LEFT_TURN_SPEED,
      dir: outDir, lane: outLane, segId: -1, interId: ii,
      turnType: turn, phaseMask: 1 << movementPhase(d, turn),
      next: [...outEdges], leftEdge: -1, rightEdge: -1, closed: false,
    });
    interConnectors[ii].push(id);
    return id;
  }

  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j <= cols; j++) {
      const ii = interId(i, j);
      for (let d = 0; d < 4; d++) {
        for (let k = 0; k < lpd; k++) {
          const inEdge = entryEdges.get(entKey(ii, d, k));
          if (inEdge === undefined) continue; // no approach from this direction
          interApproaches[ii].push(inEdge);

          // Standard lane discipline: inner lane = straight+left, curb lane = straight+right.
          // Single-lane roads: everything.
          const wanted: number[] = [TURN_STRAIGHT];
          if (lpd === 1) { wanted.push(TURN_RIGHT, TURN_LEFT); }
          else if (k === 0) { wanted.push(TURN_LEFT); }
          else if (k === lpd - 1) { wanted.push(TURN_RIGHT); }

          const made: number[] = [];
          for (const t of wanted) {
            const cid = addConnector(i, j, d, k, t);
            if (cid !== null) made.push(cid);
          }
          // Boundary fallback: lane must have at least one way out.
          if (made.length === 0) {
            for (const t of [TURN_RIGHT, TURN_LEFT]) {
              const cid = addConnector(i, j, d, k, t);
              if (cid !== null) { made.push(cid); break; }
            }
          }
          const e = edges[inEdge];
          for (const cid of made) e.next.push(cid);
        }
      }
    }
  }

  // Reverse index: which connectors merge into each road edge.
  const feeders: number[][] = Array.from({ length: edges.length }, () => []);
  for (const e of edges) {
    if (e.kind !== 1) continue;
    for (const n of e.next) feeders[n].push(e.id);
  }

  return { edges, segs, interConnectors, interApproaches, feeders, lanesPerDirection: lpd, laneWidth };
}

/** Position + heading at distance `pos` along an edge's polyline. */
export function edgePointAt(e: LaneEdge, pos: number, out: { x: number; y: number; heading: number }): void {
  const cum = e.cum, pts = e.pts;
  const n = cum.length;
  const p = pos <= 0 ? 0 : pos >= e.length ? e.length : pos;
  // Find segment (linear scan — polylines are tiny).
  let s = 1;
  while (s < n - 1 && cum[s] < p) s++;
  const segLen = cum[s] - cum[s - 1] || 1e-6;
  const t = (p - cum[s - 1]) / segLen;
  const x0 = pts[(s - 1) * 2], y0 = pts[(s - 1) * 2 + 1];
  const x1 = pts[s * 2], y1 = pts[s * 2 + 1];
  out.x = x0 + (x1 - x0) * t;
  out.y = y0 + (y1 - y0) * t;
  out.heading = Math.atan2(y1 - y0, x1 - x0);
}
