import { LaneGraph, LaneEdge, TURN_LEFT, TURN_RIGHT } from '../graph/laneGraph';

/**
 * Edge-based A* router. States are edges; successors are edge.next plus
 * parallel-lane edges (lane changes, penalized). Costs are travel times
 * with optional live congestion multipliers per edge.
 */

const LANE_CHANGE_PENALTY_S = 4;
const LEFT_TURN_PENALTY_S = 6;   // expected signal delay bias
const RIGHT_TURN_PENALTY_S = 2;
const STRAIGHT_PENALTY_S = 3;    // crossing an intersection at all costs time

class MinHeap {
  private ids: Int32Array;
  private keys: Float64Array;
  private n = 0;
  constructor(cap: number) {
    this.ids = new Int32Array(cap);
    this.keys = new Float64Array(cap);
  }
  get size() { return this.n; }
  clear() { this.n = 0; }
  push(id: number, key: number) {
    if (this.n === this.ids.length) {
      const ids = new Int32Array(this.n * 2); ids.set(this.ids); this.ids = ids;
      const keys = new Float64Array(this.n * 2); keys.set(this.keys); this.keys = keys;
    }
    let i = this.n++;
    this.ids[i] = id; this.keys[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p); i = p;
    }
  }
  pop(): number {
    const top = this.ids[0];
    this.n--;
    if (this.n > 0) {
      this.ids[0] = this.ids[this.n]; this.keys[0] = this.keys[this.n];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.n && this.keys[l] < this.keys[m]) m = l;
        if (r < this.n && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    const ti = this.ids[a]; this.ids[a] = this.ids[b]; this.ids[b] = ti;
    const tk = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = tk;
  }
}

export class Router {
  private graph: LaneGraph;
  private heap: MinHeap;
  private gScore: Float64Array;
  private cameFrom: Int32Array;
  private visitStamp: Int32Array;
  private stamp = 0;
  /** Live congestion multiplier per edge (1 = free flow). Updated by metrics. */
  congestion: Float32Array;
  /** Edge end coordinates for the heuristic. */
  private endX: Float32Array;
  private endY: Float32Array;

  constructor(graph: LaneGraph) {
    this.graph = graph;
    const n = graph.edges.length;
    this.heap = new MinHeap(1024);
    this.gScore = new Float64Array(n);
    this.cameFrom = new Int32Array(n);
    this.visitStamp = new Int32Array(n);
    this.congestion = new Float32Array(n).fill(1);
    this.endX = new Float32Array(n);
    this.endY = new Float32Array(n);
    for (const e of graph.edges) {
      this.endX[e.id] = e.pts[e.pts.length - 2];
      this.endY[e.id] = e.pts[e.pts.length - 1];
    }
  }

  private edgeCost(e: LaneEdge): number {
    let c = (e.length / e.speedLimit) * this.congestion[e.id];
    if (e.kind === 1) {
      c += e.turnType === TURN_LEFT ? LEFT_TURN_PENALTY_S
        : e.turnType === TURN_RIGHT ? RIGHT_TURN_PENALTY_S
        : STRAIGHT_PENALTY_S;
    }
    return c;
  }

  /**
   * Route from startEdge to any edge in goalEdges (lane alternatives of the
   * destination segment). Returns edge id path INCLUDING startEdge, or null.
   */
  route(startEdge: number, goalEdges: number[]): Int32Array | null {
    const { edges } = this.graph;
    if (edges[startEdge].closed) return null;
    const goalSet = new Set<number>();
    let gx = 0, gy = 0;
    for (const g of goalEdges) {
      if (!edges[g].closed) {
        goalSet.add(g);
        gx = this.endX[g]; gy = this.endY[g];
      }
    }
    if (goalSet.size === 0) return null;
    if (goalSet.has(startEdge)) return Int32Array.of(startEdge);

    const MAX_SPEED = 14;
    const h = (id: number) => Math.hypot(this.endX[id] - gx, this.endY[id] - gy) / MAX_SPEED;

    this.stamp++;
    const stamp = this.stamp;
    this.heap.clear();
    this.gScore[startEdge] = 0;
    this.cameFrom[startEdge] = -1;
    this.visitStamp[startEdge] = stamp;
    this.heap.push(startEdge, h(startEdge));

    let expansions = 0;
    const MAX_EXPANSIONS = edges.length * 2;

    while (this.heap.size > 0 && expansions++ < MAX_EXPANSIONS) {
      const cur = this.heap.pop();
      if (goalSet.has(cur)) return this.reconstruct(cur);
      const e = edges[cur];
      const gCur = this.gScore[cur];

      const relax = (nbId: number, extra: number) => {
        const nb = edges[nbId];
        if (nb.closed) return;
        const tentative = gCur + this.edgeCost(nb) + extra;
        if (this.visitStamp[nbId] !== stamp || tentative < this.gScore[nbId]) {
          this.visitStamp[nbId] = stamp;
          this.gScore[nbId] = tentative;
          this.cameFrom[nbId] = cur;
          this.heap.push(nbId, tentative + h(nbId));
        }
      };

      for (const nbId of e.next) relax(nbId, 0);
      if (e.kind === 0) {
        if (e.leftEdge >= 0) relax(e.leftEdge, LANE_CHANGE_PENALTY_S);
        if (e.rightEdge >= 0) relax(e.rightEdge, LANE_CHANGE_PENALTY_S);
      }
    }
    return null;
  }

  private reconstruct(goal: number): Int32Array {
    const out: number[] = [];
    let cur = goal;
    while (cur !== -1) {
      out.push(cur);
      cur = this.cameFrom[cur];
    }
    out.reverse();
    return Int32Array.from(out);
  }
}
