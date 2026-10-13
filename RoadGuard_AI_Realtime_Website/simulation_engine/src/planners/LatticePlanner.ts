import { PlannerConfig, PlannerResult, Point } from './types';
import { theme } from '../styles/theme';
import { toPathPoints, pathLength, computeSmoothness, resamplePath } from '../utils/interpolation';
import { isPointBlocked, minDistanceToObstacles, distance, normalizeAngle } from '../utils/geometry';

interface LatticeNode {
  x: number;
  y: number;
  heading: number;
  cost: number;
  parent: number;
  primitive: Point[];
}

interface MotionPrimitive {
  points: Point[];
  endDx: number;
  endDy: number;
  endHeading: number;
  cost: number;
}

function generatePrimitives(): MotionPrimitive[] {
  const primitives: MotionPrimitive[] = [];

  // Straight motions at various lengths (longer for city scale)
  const lengths = [3, 5, 8, 16];
  for (const len of lengths) {
    const steps = Math.max(8, len); // keep collision samples ~1m apart
    const pts: Point[] = [];
    for (let i = 0; i <= steps; i++) {
      pts.push({ x: (len * i) / steps, y: 0 });
    }
    primitives.push({
      points: pts,
      endDx: len,
      endDy: 0,
      endHeading: 0,
      cost: len,
    });
  }

  // 90-degree turns (critical for city grid navigation)
  const turnRadii = [5, 6, 8];
  const turnAngle = Math.PI / 2;

  for (const radius of turnRadii) {
    const steps = 12;
    // Left 90
    const leftPts: Point[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = (turnAngle * i) / steps;
      leftPts.push({
        x: radius * Math.sin(t),
        y: radius * (1 - Math.cos(t)),
      });
    }
    const arcLen = radius * turnAngle;
    primitives.push({
      points: leftPts,
      endDx: radius * Math.sin(turnAngle),
      endDy: radius * (1 - Math.cos(turnAngle)),
      endHeading: turnAngle,
      cost: arcLen * 1.1,
    });

    // Right 90
    const rightPts: Point[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = (turnAngle * i) / steps;
      rightPts.push({
        x: radius * Math.sin(t),
        y: -radius * (1 - Math.cos(t)),
      });
    }
    primitives.push({
      points: rightPts,
      endDx: radius * Math.sin(turnAngle),
      endDy: -radius * (1 - Math.cos(turnAngle)),
      endHeading: -turnAngle,
      cost: arcLen * 1.1,
    });
  }

  // Gentle curves (lane changes, slight corrections)
  const gentleAngles = [Math.PI / 6, Math.PI / 4];
  for (const radius of [6, 8]) {
    for (const angle of gentleAngles) {
      const steps = 8;
      const leftPts: Point[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = (angle * i) / steps;
        leftPts.push({
          x: radius * Math.sin(t),
          y: radius * (1 - Math.cos(t)),
        });
      }
      primitives.push({
        points: leftPts,
        endDx: radius * Math.sin(angle),
        endDy: radius * (1 - Math.cos(angle)),
        endHeading: angle,
        cost: radius * angle * 1.1,
      });

      const rightPts: Point[] = [];
      for (let i = 0; i <= steps; i++) {
        const t = (angle * i) / steps;
        rightPts.push({
          x: radius * Math.sin(t),
          y: -radius * (1 - Math.cos(t)),
        });
      }
      primitives.push({
        points: rightPts,
        endDx: radius * Math.sin(angle),
        endDy: -radius * (1 - Math.cos(angle)),
        endHeading: -angle,
        cost: radius * angle * 1.1,
      });
    }
  }

  return primitives;
}

function transformPrimitive(primitive: MotionPrimitive, x: number, y: number, heading: number): Point[] {
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  return primitive.points.map(p => ({
    x: x + p.x * cos - p.y * sin,
    y: y + p.x * sin + p.y * cos,
  }));
}

function latticeKey(x: number, y: number, heading: number): string {
  const qx = Math.round(x);
  const qy = Math.round(y);
  const qh = Math.round(heading / (Math.PI / 4)) * (Math.PI / 4);
  return `${qx},${qy},${qh.toFixed(1)}`;
}

export function runLatticePlanner(config: PlannerConfig): PlannerResult {
  const startTime = performance.now();
  const { start, goal, obstacles, bounds, roads } = config;

  const primitives = generatePrimitives();
  const nodes: LatticeNode[] = [{
    x: start.x,
    y: start.y,
    heading: start.heading,
    cost: 0,
    parent: -1,
    primitive: [],
  }];

  const openSet: number[] = [0];
  const closedSet = new Set<string>();
  const bestCostByKey = new Map<string, number>();
  const goalDist = 3.0;
  const maxNodes = 25000;
  // Inflate the heuristic: Euclidean distance badly underestimates road
  // distance in a Manhattan grid, leaving a huge equal-cost band to explore
  const heuristicWeight = 1.5;

  let bestGoalNode = -1;

  while (openSet.length > 0 && nodes.length < maxNodes) {
    let bestIdx = 0;
    let bestF = Infinity;
    for (let i = 0; i < openSet.length; i++) {
      const node = nodes[openSet[i]];
      const h = distance(node, goal);
      const f = node.cost + h * heuristicWeight;
      if (f < bestF) {
        bestF = f;
        bestIdx = i;
      }
    }

    const currentIdx = openSet.splice(bestIdx, 1)[0];
    const current = nodes[currentIdx];
    const key = latticeKey(current.x, current.y, current.heading);

    if (closedSet.has(key)) continue;
    closedSet.add(key);

    if (distance(current, goal) < goalDist) {
      bestGoalNode = currentIdx;
      break;
    }

    for (const prim of primitives) {
      const worldPoints = transformPrimitive(prim, current.x, current.y, current.heading);
      const endPoint = worldPoints[worldPoints.length - 1];

      if (endPoint.x < bounds.minX || endPoint.x > bounds.maxX ||
          endPoint.y < bounds.minY || endPoint.y > bounds.maxY) continue;

      // Check road awareness and collisions along primitive
      let blocked = false;
      for (let i = 0; i < worldPoints.length; i++) {
        if (isPointBlocked(worldPoints[i], obstacles, 0.6, roads)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      const newHeading = normalizeAngle(current.heading + prim.endHeading);
      const newKey = latticeKey(endPoint.x, endPoint.y, newHeading);
      if (closedSet.has(newKey)) continue;

      const newCost = current.cost + prim.cost;
      const existingCost = bestCostByKey.get(newKey);
      if (existingCost !== undefined && existingCost <= newCost) continue;
      bestCostByKey.set(newKey, newCost);

      nodes.push({
        x: endPoint.x,
        y: endPoint.y,
        heading: newHeading,
        cost: newCost,
        parent: currentIdx,
        primitive: worldPoints,
      });
      openSet.push(nodes.length - 1);
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
      algorithm: 'lattice',
      color: theme.colors.pathC,
    };
  }

  const allPoints: Point[] = [];
  const chain: number[] = [];
  let current = bestGoalNode;
  while (current !== -1) {
    chain.unshift(current);
    current = nodes[current].parent;
  }

  for (const idx of chain) {
    const node = nodes[idx];
    if (node.primitive.length > 0) {
      for (let i = allPoints.length === 0 ? 0 : 1; i < node.primitive.length; i++) {
        allPoints.push(node.primitive[i]);
      }
    } else {
      allPoints.push({ x: node.x, y: node.y });
    }
  }
  allPoints.push({ x: goal.x, y: goal.y });

  const resampled = resamplePath(allPoints, 0.3);
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
    algorithm: 'lattice',
    color: theme.colors.pathC,
  };
}
