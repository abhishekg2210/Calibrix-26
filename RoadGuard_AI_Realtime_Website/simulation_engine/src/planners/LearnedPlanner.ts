import { PlannerConfig, PlannerResult, Point } from './types';
import { theme } from '../styles/theme';
import { toPathPoints, pathLength, computeSmoothness, resamplePath, smoothPath } from '../utils/interpolation';
import { isPointBlocked, minDistanceToObstacles } from '../utils/geometry';

/**
 * Simplified "learned" planner — mimics a neural planner that has learned a
 * value function (cost-to-go) over the drivable surface. The field is built
 * by propagating cost outward from the goal across a coarse road-constrained
 * grid (the function a trained network would approximate), then the path is
 * a greedy policy rollout: from the start, repeatedly step to the lowest-value
 * neighbor cell. Unlike local gradient descent on a hand-built potential
 * field, a goal-propagated value field has no local minima, so the rollout
 * cannot get stuck behind buildings at city scale.
 */

const CELL = 1.5;            // value-field grid resolution (m)
const OBSTACLE_BUFFER = 0.8; // collision buffer around vehicles (m)

export function runLearnedPlanner(config: PlannerConfig): PlannerResult {
  const startTime = performance.now();
  const { start, goal, obstacles, bounds, roads } = config;

  const cols = Math.max(2, Math.ceil((bounds.maxX - bounds.minX) / CELL));
  const rows = Math.max(2, Math.ceil((bounds.maxY - bounds.minY) / CELL));
  const cellCount = cols * rows;

  const toIdx = (cx: number, cy: number) => cy * cols + cx;
  const cellX = (cx: number) => bounds.minX + (cx + 0.5) * CELL;
  const cellY = (cy: number) => bounds.minY + (cy + 0.5) * CELL;
  const toCell = (p: Point) => ({
    cx: Math.min(cols - 1, Math.max(0, Math.floor((p.x - bounds.minX) / CELL))),
    cy: Math.min(rows - 1, Math.max(0, Math.floor((p.y - bounds.minY) / CELL))),
  });

  // Rasterize the drivable surface plus a soft obstacle-proximity penalty —
  // the "features" the value function is built over
  const blocked = new Uint8Array(cellCount);
  const penalty = new Float32Array(cellCount);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const p = { x: cellX(cx), y: cellY(cy) };
      const i = toIdx(cx, cy);
      if (isPointBlocked(p, obstacles, OBSTACLE_BUFFER, roads)) {
        blocked[i] = 1;
      } else {
        const d = minDistanceToObstacles(p, obstacles);
        if (d < 3) penalty[i] = (3 - d) * 1.5;
      }
    }
  }

  // Start/goal may sit on a blocked cell edge after rasterization — snap to
  // the nearest free cell within a small ring
  const findFreeCellNear = (p: Point): number => {
    const { cx, cy } = toCell(p);
    if (!blocked[toIdx(cx, cy)]) return toIdx(cx, cy);
    for (let radius = 1; radius <= 8; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          if (!blocked[toIdx(nx, ny)]) return toIdx(nx, ny);
        }
      }
    }
    return -1;
  };

  const startIdx = findFreeCellNear(start);
  const goalIdx = findFreeCellNear(goal);

  // Dijkstra from the goal over free cells → cost-to-go value field
  const value = new Float32Array(cellCount).fill(Infinity);
  const visited = new Uint8Array(cellCount);
  let nodesExplored = 0;

  if (startIdx >= 0 && goalIdx >= 0) {
    const heap: number[] = [];
    const push = (i: number) => {
      heap.push(i);
      let c = heap.length - 1;
      while (c > 0) {
        const par = (c - 1) >> 1;
        if (value[heap[par]] <= value[heap[c]]) break;
        [heap[par], heap[c]] = [heap[c], heap[par]];
        c = par;
      }
    };
    const pop = (): number => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        let p = 0;
        for (;;) {
          const l = 2 * p + 1;
          const r = l + 1;
          let m = p;
          if (l < heap.length && value[heap[l]] < value[heap[m]]) m = l;
          if (r < heap.length && value[heap[r]] < value[heap[m]]) m = r;
          if (m === p) break;
          [heap[p], heap[m]] = [heap[m], heap[p]];
          p = m;
        }
      }
      return top;
    };

    value[goalIdx] = 0;
    push(goalIdx);

    while (heap.length > 0) {
      const i = pop();
      if (visited[i]) continue;
      visited[i] = 1;
      nodesExplored++;
      if (i === startIdx) break;

      const cx = i % cols;
      const cy = (i / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const ni = toIdx(nx, ny);
          if (blocked[ni] || visited[ni]) continue;
          const stepCost = (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) * CELL + penalty[ni];
          const nv = value[i] + stepCost;
          if (nv < value[ni]) {
            value[ni] = nv;
            push(ni);
          }
        }
      }
    }
  }

  if (startIdx < 0 || goalIdx < 0 || value[startIdx] === Infinity) {
    return {
      path: [],
      metrics: {
        computeTimeMs: performance.now() - startTime,
        pathLengthMeters: 0,
        smoothness: 0,
        safetyMarginMeters: 0,
        nodesExplored,
        success: false,
      },
      algorithm: 'learned',
      color: theme.colors.pathD,
    };
  }

  // Policy rollout: greedily descend the value field. Every settled cell has
  // a neighbor with strictly lower value, so this always reaches the goal.
  const rawPath: Point[] = [{ x: start.x, y: start.y }];
  let ci = startIdx;
  for (let step = 0; step < cellCount && ci !== goalIdx; step++) {
    const cx = ci % cols;
    const cy = (ci / cols) | 0;
    let best = ci;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        const ni = toIdx(nx, ny);
        if (value[ni] < value[best]) best = ni;
      }
    }
    if (best === ci) break;
    ci = best;
    rawPath.push({ x: cellX(ci % cols), y: cellY((ci / cols) | 0) });
  }
  rawPath.push({ x: goal.x, y: goal.y });

  const success = ci === goalIdx;

  if (!success) {
    return {
      path: [],
      metrics: {
        computeTimeMs: performance.now() - startTime,
        pathLengthMeters: 0,
        smoothness: 0,
        safetyMarginMeters: 0,
        nodesExplored,
        success: false,
      },
      algorithm: 'learned',
      color: theme.colors.pathD,
    };
  }

  const smoothed = smoothPath(rawPath, 4);
  const resampled = resamplePath(smoothed, 0.3);
  const pathPoints = toPathPoints(resampled);
  const len = pathLength(resampled);
  const smoothness = computeSmoothness(pathPoints);

  let minSafety = Infinity;
  for (const p of resampled) {
    const d = minDistanceToObstacles(p, obstacles);
    if (d < minSafety) minSafety = d;
  }

  return {
    path: pathPoints,
    metrics: {
      computeTimeMs: performance.now() - startTime,
      pathLengthMeters: len,
      smoothness,
      safetyMarginMeters: minSafety === Infinity ? 0 : minSafety,
      nodesExplored,
      success: true,
    },
    algorithm: 'learned',
    color: theme.colors.pathD,
  };
}
