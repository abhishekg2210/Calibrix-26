import { CityModel } from '../model/types';
import { PHASE_NS_STRAIGHT, PHASE_EW_STRAIGHT } from './laneGraph';

/**
 * Pedestrian network: a sidewalk ring around each block plus signal-gated
 * crosswalk edges at intersections.
 *
 * Nodes are block corners (4 per block: NW, NE, SW, SE). Side edges run along
 * block faces; crosswalk edges connect corners of neighboring blocks across a
 * road and are only walkable during the straight phase of the PARALLEL
 * traffic direction (crossing a vertical road <=> walking east-west <=> walk
 * with EW straight green).
 */

export const CORNER_NW = 0;
export const CORNER_NE = 1;
export const CORNER_SW = 2;
export const CORNER_SE = 3;

export interface WalkEdge {
  id: number;
  a: number;            // node ids
  b: number;
  length: number;
  kind: 0 | 1;          // 0 = sidewalk, 1 = crosswalk
  /** Crosswalks: intersection id and which side of it (dir index E,S,W,N). */
  interId: number;
  side: number;
  /** Crosswalks: phase that must be active to start crossing. */
  walkPhase: number;
}

export interface WalkGraph {
  /** Node positions. */
  nx: Float32Array;
  ny: Float32Array;
  nodeCount: number;
  edges: WalkEdge[];
  /** Adjacency: edge ids per node. */
  nodeEdges: number[][];
  /** node id for block (i,j) corner c. */
  cornerNode(i: number, j: number, c: number): number;
}

export function buildWalkGraph(model: CityModel): WalkGraph {
  const { rows, cols, blockWidth, blockHeight, roadWidth } = model;
  const inset = 1.2; // walk line sits just inside the block face
  const nodeCount = rows * cols * 4;
  const nx = new Float32Array(nodeCount);
  const ny = new Float32Array(nodeCount);
  const nodeEdges: number[][] = Array.from({ length: nodeCount }, () => []);
  const edges: WalkEdge[] = [];

  const cornerNode = (i: number, j: number, c: number) => (i * cols + j) * 4 + c;

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const left = model.originX + (j + 1) * roadWidth + j * blockWidth;
      const top = model.originY + (i + 1) * roadWidth + i * blockHeight;
      const right = left + blockWidth;
      const bottom = top + blockHeight;
      const set = (c: number, x: number, y: number) => {
        const n = cornerNode(i, j, c);
        nx[n] = x; ny[n] = y;
      };
      set(CORNER_NW, left + inset, top + inset);
      set(CORNER_NE, right - inset, top + inset);
      set(CORNER_SW, left + inset, bottom - inset);
      set(CORNER_SE, right - inset, bottom - inset);
    }
  }

  function addEdge(a: number, b: number, kind: 0 | 1, interId = -1, side = -1, walkPhase = -1) {
    const id = edges.length;
    const length = Math.hypot(nx[a] - nx[b], ny[a] - ny[b]);
    edges.push({ id, a, b, length, kind, interId, side, walkPhase });
    nodeEdges[a].push(id);
    nodeEdges[b].push(id);
  }

  // Sidewalk edges along each block face.
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      addEdge(cornerNode(i, j, CORNER_NW), cornerNode(i, j, CORNER_NE), 0);
      addEdge(cornerNode(i, j, CORNER_SW), cornerNode(i, j, CORNER_SE), 0);
      addEdge(cornerNode(i, j, CORNER_NW), cornerNode(i, j, CORNER_SW), 0);
      addEdge(cornerNode(i, j, CORNER_NE), cornerNode(i, j, CORNER_SE), 0);
    }
  }

  // Crosswalk edges at each interior intersection corner pairing.
  // Intersection (i,j) sits at road-row i, road-col j with neighbor blocks:
  // NW block (i-1,j-1), NE (i-1,j), SW (i,j-1), SE (i,j).
  const interId = (i: number, j: number) => i * (cols + 1) + j;
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j <= cols; j++) {
      const ii = interId(i, j);
      const nwOK = i > 0 && j > 0;
      const neOK = i > 0 && j < cols;
      const swOK = i < rows && j > 0;
      const seOK = i < rows && j < cols;
      // North side: crosses the vertical road -> walk with EW straight.
      if (nwOK && neOK) {
        addEdge(cornerNode(i - 1, j - 1, CORNER_SE), cornerNode(i - 1, j, CORNER_SW), 1, ii, 3, PHASE_EW_STRAIGHT);
      }
      // South side.
      if (swOK && seOK) {
        addEdge(cornerNode(i, j - 1, CORNER_NE), cornerNode(i, j, CORNER_NW), 1, ii, 1, PHASE_EW_STRAIGHT);
      }
      // West side: crosses the horizontal road -> walk with NS straight.
      if (nwOK && swOK) {
        addEdge(cornerNode(i - 1, j - 1, CORNER_SE), cornerNode(i, j - 1, CORNER_NE), 1, ii, 2, PHASE_NS_STRAIGHT);
      }
      // East side.
      if (neOK && seOK) {
        addEdge(cornerNode(i - 1, j, CORNER_SW), cornerNode(i, j, CORNER_NW), 1, ii, 0, PHASE_NS_STRAIGHT);
      }
    }
  }

  return { nx, ny, nodeCount, edges, nodeEdges, cornerNode };
}

/**
 * A* over walk nodes. Returns a node path or null. Uses scratch arrays sized
 * to the graph; instantiate one router per sim.
 */
export class WalkRouter {
  private g: WalkGraph;
  private dist: Float64Array;
  private prevEdge: Int32Array;
  private stampArr: Int32Array;
  private stamp = 0;
  private heapIds: Int32Array;
  private heapKeys: Float64Array;
  private heapN = 0;

  constructor(g: WalkGraph) {
    this.g = g;
    this.dist = new Float64Array(g.nodeCount);
    this.prevEdge = new Int32Array(g.nodeCount);
    this.stampArr = new Int32Array(g.nodeCount);
    this.heapIds = new Int32Array(1024);
    this.heapKeys = new Float64Array(1024);
  }

  private push(id: number, key: number) {
    if (this.heapN === this.heapIds.length) {
      const ids = new Int32Array(this.heapN * 2); ids.set(this.heapIds); this.heapIds = ids;
      const ks = new Float64Array(this.heapN * 2); ks.set(this.heapKeys); this.heapKeys = ks;
    }
    let i = this.heapN++;
    this.heapIds[i] = id; this.heapKeys[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.heapKeys[p] <= this.heapKeys[i]) break;
      this.swap(i, p); i = p;
    }
  }

  private pop(): number {
    const top = this.heapIds[0];
    this.heapN--;
    if (this.heapN > 0) {
      this.heapIds[0] = this.heapIds[this.heapN];
      this.heapKeys[0] = this.heapKeys[this.heapN];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.heapN && this.heapKeys[l] < this.heapKeys[m]) m = l;
        if (r < this.heapN && this.heapKeys[r] < this.heapKeys[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    const ti = this.heapIds[a]; this.heapIds[a] = this.heapIds[b]; this.heapIds[b] = ti;
    const tk = this.heapKeys[a]; this.heapKeys[a] = this.heapKeys[b]; this.heapKeys[b] = tk;
  }

  /** Returns sequence of edge ids from start node to goal node, or null. */
  route(start: number, goal: number): Int32Array | null {
    if (start === goal) return Int32Array.of();
    const g = this.g;
    this.stamp++;
    const stamp = this.stamp;
    this.heapN = 0;
    this.dist[start] = 0;
    this.prevEdge[start] = -1;
    this.stampArr[start] = stamp;
    const gx = g.nx[goal], gy = g.ny[goal];
    const h = (n: number) => Math.hypot(g.nx[n] - gx, g.ny[n] - gy);
    this.push(start, h(start));

    let guard = 0;
    const MAX = g.nodeCount * 8;
    while (this.heapN > 0 && guard++ < MAX) {
      const cur = this.pop();
      if (cur === goal) return this.reconstruct(goal);
      const d = this.dist[cur];
      for (const eid of g.nodeEdges[cur]) {
        const e = g.edges[eid];
        const nb = e.a === cur ? e.b : e.a;
        // Small penalty for crosswalks (expected wait).
        const nd = d + e.length + (e.kind === 1 ? 18 : 0);
        if (this.stampArr[nb] !== stamp || nd < this.dist[nb]) {
          this.stampArr[nb] = stamp;
          this.dist[nb] = nd;
          this.prevEdge[nb] = eid;
          this.push(nb, nd + h(nb));
        }
      }
    }
    return null;
  }

  private reconstruct(goal: number): Int32Array {
    const out: number[] = [];
    let cur = goal;
    while (this.prevEdge[cur] !== -1) {
      const e = this.g.edges[this.prevEdge[cur]];
      out.push(e.id);
      cur = e.a === cur ? e.b : e.a;
    }
    out.reverse();
    return Int32Array.from(out);
  }
}
