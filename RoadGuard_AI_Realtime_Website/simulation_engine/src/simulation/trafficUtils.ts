import { CityMap, Intersection, RoadSegment } from '../city/types';
import { Vehicle, Point } from '../planners/types';

export type SignalColor = 'red' | 'yellow' | 'green';

export interface RoadInfo {
  road: RoadSegment;
  laneCenter: number;       // perpendicular offset from road center
  direction: 1 | -1;        // +1 = positive axis direction, -1 = negative
  laneIndex: number;
  distanceAlongRoad: number; // how far along the road
}

/** Get the traffic signal color for a given direction at a given time */
export function getSignalState(
  intersection: Intersection,
  direction: 'ns' | 'ew',
  timeMs: number
): SignalColor {
  const cycle = intersection.signal.cycleTimeMs;
  const phase = ((timeMs + intersection.signal.phaseOffsetMs) % cycle) / cycle;

  if (direction === 'ns') {
    if (phase < 0.4) return 'green';
    if (phase < 0.45) return 'yellow';
    if (phase < 0.9) return 'red';
    return 'red'; // all-red phase
  } else {
    if (phase < 0.4) return 'red';
    if (phase < 0.45) return 'red';
    if (phase < 0.85) return 'green';
    if (phase < 0.9) return 'yellow';
    return 'red';
  }
}

/** Find which road a vehicle is on based on position */
export function findCurrentRoad(
  pos: Point,
  heading: number,
  cityMap: CityMap
): RoadSegment | null {
  const isHorizontalish = Math.abs(Math.cos(heading)) > Math.abs(Math.sin(heading));

  for (const road of cityMap.roads) {
    if (road.orientation === 'horizontal' && isHorizontalish) {
      if (Math.abs(pos.y - road.start.y) < road.width / 2 &&
          pos.x >= road.start.x && pos.x <= road.end.x) {
        return road;
      }
    } else if (road.orientation === 'vertical' && !isHorizontalish) {
      if (Math.abs(pos.x - road.start.x) < road.width / 2 &&
          pos.y >= road.start.y && pos.y <= road.end.y) {
        return road;
      }
    }
  }
  return null;
}

/** Find the nearest intersection ahead of a vehicle */
export function findIntersectionAhead(
  pos: Point,
  heading: number,
  cityMap: CityMap,
  maxDist: number = 30
): { intersection: Intersection; dist: number } | null {
  const cosH = Math.cos(heading);
  const sinH = Math.sin(heading);

  let closest: { intersection: Intersection; dist: number } | null = null;

  for (const int of cityMap.intersections) {
    const dx = int.center.x - pos.x;
    const dy = int.center.y - pos.y;

    // Project onto heading direction
    const ahead = dx * cosH + dy * sinH;
    if (ahead < 2 || ahead > maxDist) continue; // must be ahead

    // Check lateral distance
    const lateral = Math.abs(-dx * sinH + dy * cosH);
    if (lateral > int.width / 2 + 2) continue;

    if (!closest || ahead < closest.dist) {
      closest = { intersection: int, dist: ahead };
    }
  }
  return closest;
}

/** Check if there's a vehicle ahead in the same lane */
export function findVehicleAhead(
  vehicle: Vehicle,
  allVehicles: Vehicle[],
  maxDist: number = 20
): { vehicle: Vehicle; dist: number } | null {
  const cosH = Math.cos(vehicle.heading);
  const sinH = Math.sin(vehicle.heading);

  let closest: { vehicle: Vehicle; dist: number } | null = null;

  for (const other of allVehicles) {
    if (other.id === vehicle.id) continue;

    const dx = other.x - vehicle.x;
    const dy = other.y - vehicle.y;

    // Project onto heading direction
    const ahead = dx * cosH + dy * sinH;
    if (ahead < 1 || ahead > maxDist) continue;

    // Check lateral distance (same lane = within ~3m)
    const lateral = Math.abs(-dx * sinH + dy * cosH);
    if (lateral > 3) continue;

    if (!closest || ahead < closest.dist) {
      closest = { vehicle: other, dist: ahead };
    }
  }
  return closest;
}

/** Check if the adjacent lane is clear for a lane change */
export function isLaneClear(
  vehicle: Vehicle,
  lateralOffset: number, // positive = right, negative = left
  allVehicles: Vehicle[],
  checkDist: number = 15
): boolean {
  const cosH = Math.cos(vehicle.heading);
  const sinH = Math.sin(vehicle.heading);

  // Target position in adjacent lane
  const targetX = vehicle.x - sinH * lateralOffset;
  const targetY = vehicle.y + cosH * lateralOffset;

  for (const other of allVehicles) {
    if (other.id === vehicle.id) continue;

    const dx = other.x - targetX;
    const dy = other.y - targetY;
    const ahead = dx * cosH + dy * sinH;
    const lateral = Math.abs(-dx * sinH + dy * cosH);

    // Check if vehicle is in the target lane and within range
    if (lateral < 3 && Math.abs(ahead) < checkDist) {
      return false;
    }
  }
  return true;
}

/** Check if a position is inside an intersection box */
export function isInIntersection(
  pos: Point,
  cityMap: CityMap
): Intersection | null {
  for (const int of cityMap.intersections) {
    if (Math.abs(pos.x - int.center.x) < int.width / 2 &&
        Math.abs(pos.y - int.center.y) < int.height / 2) {
      return int;
    }
  }
  return null;
}

/** Get available exit roads from an intersection */
export function getExitRoads(
  intersection: Intersection,
  entryHeading: number,
  cityMap: CityMap
): { road: RoadSegment; heading: number; turnType: 'straight' | 'left' | 'right' }[] {
  const exits: { road: RoadSegment; heading: number; turnType: 'straight' | 'left' | 'right' }[] = [];
  const cx = intersection.center.x;
  const cy = intersection.center.y;

  // Normalize entry heading to determine entry direction
  const normH = ((entryHeading % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

  for (const road of cityMap.roads) {
    if (road.orientation === 'horizontal') {
      if (Math.abs(road.start.y - cy) < 1) {
        // Road passes through this intersection
        if (cx >= road.start.x && cx <= road.end.x) {
          // Can exit east or west
          exits.push({
            road,
            heading: 0, // east
            turnType: getTurnType(normH, 0),
          });
          exits.push({
            road,
            heading: Math.PI, // west
            turnType: getTurnType(normH, Math.PI),
          });
        }
      }
    } else {
      if (Math.abs(road.start.x - cx) < 1) {
        if (cy >= road.start.y && cy <= road.end.y) {
          exits.push({
            road,
            heading: Math.PI / 2, // south
            turnType: getTurnType(normH, Math.PI / 2),
          });
          exits.push({
            road,
            heading: -Math.PI / 2, // north
            turnType: getTurnType(normH, -Math.PI / 2 + 2 * Math.PI),
          });
        }
      }
    }
  }

  // Filter out U-turns (exit heading ~= opposite of entry)
  return exits.filter(e => {
    const diff = Math.abs(((e.heading - entryHeading + Math.PI) % (2 * Math.PI)) - Math.PI);
    return diff > 0.5; // not a U-turn
  });
}

function getTurnType(entryH: number, exitH: number): 'straight' | 'left' | 'right' {
  let diff = exitH - entryH;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;

  if (Math.abs(diff) < 0.3) return 'straight';
  if (diff > 0) return 'right'; // positive = clockwise = right turn
  return 'left';
}
