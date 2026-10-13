import { Point, Vehicle, RoadRect } from '../planners/types';

export function distance(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

export function angleBetween(a: Point, b: Point): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

export function normalizeAngle(angle: number): number {
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

/** Get the 4 corners of a vehicle in world coordinates */
export function getVehicleCorners(v: Vehicle): Point[] {
  const cos = Math.cos(v.heading);
  const sin = Math.sin(v.heading);
  const hw = v.width / 2;
  const hl = v.length / 2;

  const corners = [
    { x: -hl, y: -hw },
    { x: hl, y: -hw },
    { x: hl, y: hw },
    { x: -hl, y: hw },
  ];

  return corners.map(c => ({
    x: v.x + c.x * cos - c.y * sin,
    y: v.y + c.x * sin + c.y * cos,
  }));
}

/** Check if a point is inside a vehicle's bounding box */
export function pointInVehicle(p: Point, v: Vehicle): boolean {
  const cos = Math.cos(-v.heading);
  const sin = Math.sin(-v.heading);
  const dx = p.x - v.x;
  const dy = p.y - v.y;
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  return Math.abs(localX) <= v.length / 2 && Math.abs(localY) <= v.width / 2;
}

/** Check if a point collides with any obstacle (with safety buffer) */
export function pointCollidesWithObstacles(
  p: Point,
  obstacles: Vehicle[],
  buffer: number = 0.5
): boolean {
  for (const obs of obstacles) {
    const cos = Math.cos(-obs.heading);
    const sin = Math.sin(-obs.heading);
    const dx = p.x - obs.x;
    const dy = p.y - obs.y;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    if (
      Math.abs(localX) <= obs.length / 2 + buffer &&
      Math.abs(localY) <= obs.width / 2 + buffer
    ) {
      return true;
    }
  }
  return false;
}

/** Check if a line segment collides with any obstacle */
export function segmentCollidesWithObstacles(
  a: Point,
  b: Point,
  obstacles: Vehicle[],
  buffer: number = 0.5,
  steps: number = 10
): boolean {
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = lerpPoint(a, b, t);
    if (pointCollidesWithObstacles(p, obstacles, buffer)) return true;
  }
  return false;
}

/** Minimum distance from a point to any obstacle surface */
export function minDistanceToObstacles(p: Point, obstacles: Vehicle[]): number {
  let minDist = Infinity;
  for (const obs of obstacles) {
    const cos = Math.cos(-obs.heading);
    const sin = Math.sin(-obs.heading);
    const dx = p.x - obs.x;
    const dy = p.y - obs.y;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;

    const clampedX = Math.max(-obs.length / 2, Math.min(obs.length / 2, localX));
    const clampedY = Math.max(-obs.width / 2, Math.min(obs.width / 2, localY));
    const dist = Math.sqrt((localX - clampedX) ** 2 + (localY - clampedY) ** 2);
    minDist = Math.min(minDist, dist);
  }
  return minDist;
}

/** Check if a point is on any road surface */
export function isOnRoad(p: Point, roads: RoadRect[]): boolean {
  for (const r of roads) {
    if (Math.abs(p.x - r.x) <= r.hw && Math.abs(p.y - r.y) <= r.hh) {
      return true;
    }
  }
  return false;
}

/** Check if any sampled point along a segment is blocked (obstacles or off-road) */
export function segmentBlocked(
  a: Point,
  b: Point,
  obstacles: Vehicle[],
  buffer: number,
  roads?: RoadRect[],
  sampleSpacing: number = 1.0
): boolean {
  const steps = Math.max(2, Math.ceil(distance(a, b) / sampleSpacing));
  for (let i = 0; i <= steps; i++) {
    const p = lerpPoint(a, b, i / steps);
    if (isPointBlocked(p, obstacles, buffer, roads)) return true;
  }
  return false;
}

/** Combined check: point is blocked if it collides with obstacles OR is off-road */
export function isPointBlocked(
  p: Point,
  obstacles: Vehicle[],
  buffer: number,
  roads?: RoadRect[]
): boolean {
  if (roads && roads.length > 0 && !isOnRoad(p, roads)) return true;
  return pointCollidesWithObstacles(p, obstacles, buffer);
}
