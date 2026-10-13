import { PathPoint, Point } from '../planners/types';
import { angleBetween, distance } from './geometry';

/** Smooth a path using Chaikin's corner-cutting algorithm */
export function smoothPath(points: Point[], iterations: number = 3): Point[] {
  let current = points;
  for (let iter = 0; iter < iterations; iter++) {
    if (current.length < 3) return current;
    const next: Point[] = [current[0]];
    for (let i = 0; i < current.length - 1; i++) {
      const p0 = current[i];
      const p1 = current[i + 1];
      next.push({
        x: p0.x * 0.75 + p1.x * 0.25,
        y: p0.y * 0.75 + p1.y * 0.25,
      });
      next.push({
        x: p0.x * 0.25 + p1.x * 0.75,
        y: p0.y * 0.25 + p1.y * 0.75,
      });
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

/** Convert a point array into PathPoints with heading, velocity, curvature */
export function toPathPoints(
  points: Point[],
  defaultVelocity: number = 5
): PathPoint[] {
  if (points.length < 2) return [];

  return points.map((p, i) => {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];

    const heading = angleBetween(prev, next);

    let curvature = 0;
    if (i > 0 && i < points.length - 1) {
      const prev2 = points[i - 1];
      const next2 = points[i + 1];
      const dx1 = p.x - prev2.x;
      const dy1 = p.y - prev2.y;
      const dx2 = next2.x - p.x;
      const dy2 = next2.y - p.y;
      const cross = dx1 * dy2 - dy1 * dx2;
      const d1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      const d2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      if (d1 > 0.001 && d2 > 0.001) {
        curvature = (2 * cross) / (d1 * d2 * (d1 + d2));
      }
    }

    return {
      x: p.x,
      y: p.y,
      heading,
      velocity: defaultVelocity,
      curvature,
    };
  });
}

/** Compute total path length */
export function pathLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += distance(points[i - 1], points[i]);
  }
  return len;
}

/** Compute smoothness score (0-1, higher = smoother) based on curvature variance */
export function computeSmoothness(points: PathPoint[]): number {
  if (points.length < 3) return 1;
  const curvatures = points.map(p => Math.abs(p.curvature));
  const maxCurv = Math.max(...curvatures, 0.001);
  const normalized = curvatures.map(c => c / maxCurv);
  const mean = normalized.reduce((a, b) => a + b, 0) / normalized.length;
  const variance = normalized.reduce((a, c) => a + (c - mean) ** 2, 0) / normalized.length;
  return Math.max(0, Math.min(1, 1 - Math.sqrt(variance)));
}

/** Resample a path to have evenly spaced points */
export function resamplePath(points: Point[], spacing: number = 0.5): Point[] {
  if (points.length < 2) return points;
  const result: Point[] = [points[0]];
  let accumulated = 0;
  let prevPoint = points[0];

  for (let i = 1; i < points.length; i++) {
    let d = distance(prevPoint, points[i]);
    // Emit as many evenly spaced points as fit along this segment
    while (d > 1e-9 && accumulated + d >= spacing) {
      const t = (spacing - accumulated) / d;
      const newPoint = {
        x: prevPoint.x + (points[i].x - prevPoint.x) * t,
        y: prevPoint.y + (points[i].y - prevPoint.y) * t,
      };
      result.push(newPoint);
      prevPoint = newPoint;
      d = distance(prevPoint, points[i]);
      accumulated = 0;
    }
    accumulated += d;
    prevPoint = points[i];
  }

  const last = points[points.length - 1];
  if (distance(result[result.length - 1], last) > 0.1) {
    result.push(last);
  }
  return result;
}
