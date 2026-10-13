import { Vehicle, PathPoint } from '../planners/types';
import { CityMap } from '../city/types';
import { distance } from '../utils/geometry';
import { findIntersectionAhead, getSignalState } from './trafficUtils';

export interface EgoSimState {
  pathIndex: number;          // current index along the path
  pathProgress: number;       // 0-1 progress between pathIndex and pathIndex+1
  currentSpeed: number;       // m/s
  targetSpeed: number;        // m/s (~13 m/s = 30mph)
  arrived: boolean;
  totalDistance: number;       // distance traveled
  elapsedTime: number;        // seconds
}

export function createEgoSimState(): EgoSimState {
  return {
    pathIndex: 0,
    pathProgress: 0,
    currentSpeed: 0,
    targetSpeed: 13, // ~30 mph
    arrived: false,
    totalDistance: 0,
    elapsedTime: 0,
  };
}

export function updateEgo(
  ego: Vehicle,
  egoState: EgoSimState,
  path: PathPoint[],
  deltaS: number,
  cityMap: CityMap,
  allVehicles: Vehicle[],
  simTimeMs: number
): { vehicle: Partial<Vehicle>; egoState: Partial<EgoSimState> } {
  if (egoState.arrived || path.length < 2) {
    return { vehicle: {}, egoState: {} };
  }

  const vUpdate: Partial<Vehicle> = {};
  const sUpdate: Partial<EgoSimState> = {};

  let targetSpeed = egoState.targetSpeed;

  // Check for red light ahead
  const intAhead = findIntersectionAhead(ego, ego.heading, cityMap, 20);
  if (intAhead && intAhead.dist < 18) {
    const isHorizontal = Math.abs(Math.cos(ego.heading)) > 0.7;
    const signalDir = isHorizontal ? 'ew' : 'ns';
    const signal = getSignalState(intAhead.intersection, signalDir, simTimeMs);

    if (signal === 'red') {
      const stopDist = intAhead.dist - intAhead.intersection.width / 2 - 3;
      if (stopDist < 12) {
        targetSpeed = Math.max(0, stopDist * 1.5);
      }
    } else if (signal === 'yellow' && intAhead.dist > 8) {
      targetSpeed = Math.min(targetSpeed, 5);
    }
  }

  // Check for vehicle ahead
  const cosH = Math.cos(ego.heading);
  const sinH = Math.sin(ego.heading);
  for (const other of allVehicles) {
    if (other.id === 'ego' || other.id.startsWith('bld-obs-')) continue;
    const dx = other.x - ego.x;
    const dy = other.y - ego.y;
    const ahead = dx * cosH + dy * sinH;
    const lateral = Math.abs(-dx * sinH + dy * cosH);
    if (ahead > 1 && ahead < 12 && lateral < 3) {
      targetSpeed = Math.min(targetSpeed, Math.max(0, (ahead - 5) * 2));
    }
  }

  // Approach target speed
  const accel = 3; // m/s²
  let speed = egoState.currentSpeed;
  if (speed < targetSpeed) {
    speed = Math.min(targetSpeed, speed + accel * deltaS);
  } else {
    speed = Math.max(targetSpeed, speed - accel * 2 * deltaS);
  }
  sUpdate.currentSpeed = speed;

  // Move along path
  let distToTravel = speed * deltaS;
  let idx = egoState.pathIndex;
  let prog = egoState.pathProgress;

  while (distToTravel > 0 && idx < path.length - 1) {
    const segLen = distance(path[idx], path[idx + 1]);
    const remaining = segLen * (1 - prog);

    if (distToTravel < remaining) {
      prog += distToTravel / segLen;
      distToTravel = 0;
    } else {
      distToTravel -= remaining;
      idx++;
      prog = 0;
    }
  }

  sUpdate.pathIndex = idx;
  sUpdate.pathProgress = prog;
  sUpdate.totalDistance = (egoState.totalDistance || 0) + speed * deltaS;
  sUpdate.elapsedTime = (egoState.elapsedTime || 0) + deltaS;

  // Check if arrived
  if (idx >= path.length - 1) {
    sUpdate.arrived = true;
    vUpdate.x = path[path.length - 1].x;
    vUpdate.y = path[path.length - 1].y;
    vUpdate.heading = path[path.length - 1].heading;
    sUpdate.currentSpeed = 0;
    return { vehicle: vUpdate, egoState: sUpdate };
  }

  // Interpolate position
  const p0 = path[idx];
  const p1 = path[idx + 1];
  vUpdate.x = p0.x + (p1.x - p0.x) * prog;
  vUpdate.y = p0.y + (p1.y - p0.y) * prog;
  vUpdate.heading = p0.heading + (p1.heading - p0.heading) * prog;

  return { vehicle: vUpdate, egoState: sUpdate };
}
