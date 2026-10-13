import { PlannerConfig, PlannerResult, Point } from './types';
import { theme } from '../styles/theme';
import { smoothPath, toPathPoints, pathLength, computeSmoothness, resamplePath } from '../utils/interpolation';
import { isPointBlocked, minDistanceToObstacles } from '../utils/geometry';

interface Node {
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
  parent: Node | null;
}

function heuristic(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function nodeKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function runAStar(config: PlannerConfig): PlannerResult {
  const startTime = performance.now();
  const { start, goal, obstacles, bounds, resolution, roads } = config;
  const res = resolution || 0.5;

  const sx = Math.round(start.x / res) * res;
  const sy = Math.round(start.y / res) * res;
  const gx = Math.round(goal.x / res) * res;
  const gy = Math.round(goal.y / res) * res;

  const openSet: Node[] = [];
  const closedSet = new Set<string>();

  const startNode: Node = {
    x: sx, y: sy,
    g: 0,
    h: heuristic({ x: sx, y: sy }, { x: gx, y: gy }),
    f: 0,
    parent: null,
  };
  startNode.f = startNode.g + startNode.h;
  openSet.push(startNode);

  let nodesExplored = 0;
  const maxNodes = 200000;

  // 8-connected neighbors
  const dirs = [
    [res, 0], [-res, 0], [0, res], [0, -res],
    [res, res], [res, -res], [-res, res], [-res, -res],
  ];
  const dirCosts = [
    res, res, res, res,
    res * Math.SQRT2, res * Math.SQRT2, res * Math.SQRT2, res * Math.SQRT2,
  ];

  while (openSet.length > 0 && nodesExplored < maxNodes) {
    let bestIdx = 0;
    for (let i = 1; i < openSet.length; i++) {
      if (openSet[i].f < openSet[bestIdx].f) bestIdx = i;
    }
    const current = openSet.splice(bestIdx, 1)[0];
    nodesExplored++;

    if (Math.abs(current.x - gx) < res && Math.abs(current.y - gy) < res) {
      const rawPath: Point[] = [];
      let node: Node | null = current;
      while (node) {
        rawPath.unshift({ x: node.x, y: node.y });
        node = node.parent;
      }

      const smoothed = smoothPath(rawPath, 3);
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
        algorithm: 'astar',
        color: theme.colors.pathA,
      };
    }

    const key = nodeKey(current.x, current.y);
    if (closedSet.has(key)) continue;
    closedSet.add(key);

    for (let i = 0; i < dirs.length; i++) {
      const nx = Math.round((current.x + dirs[i][0]) * 100) / 100;
      const ny = Math.round((current.y + dirs[i][1]) * 100) / 100;
      const nKey = nodeKey(nx, ny);

      if (closedSet.has(nKey)) continue;
      if (nx < bounds.minX || nx > bounds.maxX || ny < bounds.minY || ny > bounds.maxY) continue;
      if (isPointBlocked({ x: nx, y: ny }, obstacles, 0.8, roads)) continue;

      const g = current.g + dirCosts[i];
      const h = heuristic({ x: nx, y: ny }, { x: gx, y: gy });

      const existing = openSet.find(n => nodeKey(n.x, n.y) === nKey);
      if (existing && existing.g <= g) continue;

      const neighbor: Node = { x: nx, y: ny, g, h, f: g + h, parent: current };

      if (existing) {
        existing.g = g;
        existing.f = g + h;
        existing.parent = current;
      } else {
        openSet.push(neighbor);
      }
    }
  }

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
    algorithm: 'astar',
    color: theme.colors.pathA,
  };
}
