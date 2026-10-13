import { PlannerConfig, PlannerResult, Point } from './types';
import { theme } from '../styles/theme';
import { smoothPath, toPathPoints, pathLength, computeSmoothness, resamplePath } from '../utils/interpolation';
import { isPointBlocked, segmentBlocked, minDistanceToObstacles, distance } from '../utils/geometry';

interface RRTNode {
  x: number;
  y: number;
  parent: number;
  cost: number;
}

export function runRRTStar(config: PlannerConfig): PlannerResult {
  const startTime = performance.now();
  const { start, goal, obstacles, bounds, roads } = config;

  // City-scale tuning: long steps so the tree can span hundreds of meters
  const stepSize = 8.0;
  const goalRadius = 4.0;
  const rewireRadius = 12.0;
  const maxIterations = 12000;
  const goalBias = 0.1;

  // Area-weighted sampling directly on road rects — rejection sampling wastes
  // most of the iteration budget when roads cover a fraction of the bounds
  const useRoads = !!(roads && roads.length > 0);
  const cumAreas: number[] = [];
  let totalArea = 0;
  if (useRoads) {
    for (const r of roads!) {
      totalArea += 4 * r.hw * r.hh;
      cumAreas.push(totalArea);
    }
  }

  const sampleFree = (): Point => {
    if (useRoads) {
      const t = Math.random() * totalArea;
      let idx = 0;
      while (idx < cumAreas.length - 1 && cumAreas[idx] < t) idx++;
      const r = roads![idx];
      return {
        x: r.x + (Math.random() * 2 - 1) * r.hw,
        y: r.y + (Math.random() * 2 - 1) * r.hh,
      };
    }
    return {
      x: bounds.minX + Math.random() * (bounds.maxX - bounds.minX),
      y: bounds.minY + Math.random() * (bounds.maxY - bounds.minY),
    };
  };

  const nodes: RRTNode[] = [{ x: start.x, y: start.y, parent: -1, cost: 0 }];
  const tree: { from: Point; to: Point }[] = [];

  let bestGoalNode = -1;
  let bestGoalCost = Infinity;

  for (let iter = 0; iter < maxIterations; iter++) {
    const sample: Point = Math.random() < goalBias
      ? { x: goal.x, y: goal.y }
      : sampleFree();

    let nearestIdx = 0;
    let nearestDist = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      const d = distance(nodes[i], sample);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = i;
      }
    }

    const nearest = nodes[nearestIdx];
    const d = distance(nearest, sample);
    const newPoint: Point = d <= stepSize
      ? sample
      : {
          x: nearest.x + (sample.x - nearest.x) / d * stepSize,
          y: nearest.y + (sample.y - nearest.y) / d * stepSize,
        };

    if (isPointBlocked(newPoint, obstacles, 0.6, roads)) continue;
    if (segmentBlocked(nearest, newPoint, obstacles, 0.6, roads)) continue;

    const nearbyIndices: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
      if (distance(nodes[i], newPoint) < rewireRadius) {
        nearbyIndices.push(i);
      }
    }

    let bestParent = nearestIdx;
    let bestCost = nearest.cost + distance(nearest, newPoint);

    for (const idx of nearbyIndices) {
      const candidateCost = nodes[idx].cost + distance(nodes[idx], newPoint);
      if (candidateCost < bestCost) {
        if (!segmentBlocked(nodes[idx], newPoint, obstacles, 0.6, roads)) {
          bestParent = idx;
          bestCost = candidateCost;
        }
      }
    }

    const newNode: RRTNode = {
      x: newPoint.x,
      y: newPoint.y,
      parent: bestParent,
      cost: bestCost,
    };
    const newIdx = nodes.length;
    nodes.push(newNode);
    tree.push({ from: nodes[bestParent], to: newPoint });

    for (const idx of nearbyIndices) {
      const rewireCost = bestCost + distance(newPoint, nodes[idx]);
      if (rewireCost < nodes[idx].cost) {
        if (!segmentBlocked(newPoint, nodes[idx], obstacles, 0.6, roads)) {
          nodes[idx].parent = newIdx;
          nodes[idx].cost = rewireCost;
        }
      }
    }

    if (distance(newPoint, goal) < goalRadius) {
      if (bestCost < bestGoalCost) {
        bestGoalCost = bestCost;
        bestGoalNode = newIdx;
      }
    }
  }

  if (bestGoalNode === -1) {
    return {
      path: [],
      metrics: {
        computeTimeMs: performance.now() - startTime,
        pathLengthMeters: 0,
        smoothness: 0,
        safetyMarginMeters: 0,
        nodesExplored: nodes.length,
        success: false,
      },
      algorithm: 'rrt',
      color: theme.colors.pathB,
      explorationTree: tree,
    };
  }

  // Re-select the cheapest goal-reaching node — rewiring keeps lowering node
  // costs after a goal node is first registered
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].cost < bestGoalCost && distance(nodes[i], goal) < goalRadius) {
      bestGoalCost = nodes[i].cost;
      bestGoalNode = i;
    }
  }

  const rawPath: Point[] = [];
  let current = bestGoalNode;
  for (let guard = 0; current !== -1 && guard <= nodes.length; guard++) {
    rawPath.unshift({ x: nodes[current].x, y: nodes[current].y });
    current = nodes[current].parent;
  }
  if (distance(rawPath[rawPath.length - 1], goal) > 1e-6) {
    rawPath.push({ x: goal.x, y: goal.y });
  }

  // Shortcut pass: greedily skip to the farthest waypoint reachable by a
  // straight collision-free segment — removes the random-tree wandering
  const shortcut: Point[] = [rawPath[0]];
  let si = 0;
  while (si < rawPath.length - 1) {
    let sj = rawPath.length - 1;
    while (sj > si + 1 && segmentBlocked(rawPath[si], rawPath[sj], obstacles, 0.6, roads)) sj--;
    shortcut.push(rawPath[sj]);
    si = sj;
  }

  // Densify before corner-cut smoothing so long shortcut segments don't get
  // their corners cut through buildings
  const dense = resamplePath(shortcut, 1.5);
  const smoothed = smoothPath(dense, 3);
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
      nodesExplored: nodes.length,
      success: true,
    },
    algorithm: 'rrt',
    color: theme.colors.pathB,
    explorationTree: tree,
  };
}
