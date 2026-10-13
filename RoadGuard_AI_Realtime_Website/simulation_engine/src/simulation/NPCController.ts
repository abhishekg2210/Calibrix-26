import { Vehicle } from '../planners/types';
import { CityMap } from '../city/types';
import { normalizeAngle } from '../utils/geometry';
import {
  findIntersectionAhead, findVehicleAhead,
  isLaneClear, isInIntersection, getExitRoads,
  getSignalState,
} from './trafficUtils';

export interface NPCState {
  vehicleId: string;
  currentSpeed: number;
  targetSpeed: number;
  state: 'driving' | 'stopping' | 'turning' | 'lane_changing';
  turnTimer: number;         // time spent in current turn
  turnDuration: number;      // total turn time
  turnStartHeading: number;
  turnEndHeading: number;
  laneChangeTimer: number;
  laneChangeDir: number;     // +1 right, -1 left
  laneChangeCooldown: number;
  accel: number;
}

export function createNPCState(vehicle: Vehicle): NPCState {
  return {
    vehicleId: vehicle.id,
    currentSpeed: (vehicle.velocity || 13) * 0.5, // start at half speed
    targetSpeed: vehicle.velocity || 13,
    state: 'driving',
    turnTimer: 0,
    turnDuration: 1.5,
    turnStartHeading: vehicle.heading,
    turnEndHeading: vehicle.heading,
    laneChangeTimer: 0,
    laneChangeDir: 0,
    laneChangeCooldown: 5 + Math.random() * 10,
    accel: 3, // m/s²
  };
}

export function updateNPC(
  vehicle: Vehicle,
  npcState: NPCState,
  deltaS: number,
  cityMap: CityMap,
  allVehicles: Vehicle[],
  simTimeMs: number
): { vehicle: Partial<Vehicle>; npcState: Partial<NPCState> } {
  const vUpdate: Partial<Vehicle> = {};
  const sUpdate: Partial<NPCState> = {};

  switch (npcState.state) {
    case 'driving':
      return updateDriving(vehicle, npcState, deltaS, cityMap, allVehicles, simTimeMs);
    case 'stopping':
      return updateStopping(vehicle, npcState, deltaS, cityMap, allVehicles, simTimeMs);
    case 'turning':
      return updateTurning(vehicle, npcState, deltaS);
    case 'lane_changing':
      return updateLaneChanging(vehicle, npcState, deltaS);
    default:
      return { vehicle: vUpdate, npcState: sUpdate };
  }
}

function updateDriving(
  vehicle: Vehicle,
  state: NPCState,
  deltaS: number,
  cityMap: CityMap,
  allVehicles: Vehicle[],
  simTimeMs: number
): { vehicle: Partial<Vehicle>; npcState: Partial<NPCState> } {
  let targetSpeed = state.targetSpeed;
  const vUpdate: Partial<Vehicle> = {};
  const sUpdate: Partial<NPCState> = {};

  // Check for vehicle ahead
  const ahead = findVehicleAhead(vehicle, allVehicles, 15);
  if (ahead) {
    if (ahead.dist < 8) {
      targetSpeed = 0; // stop
    } else {
      targetSpeed = Math.min(targetSpeed, (ahead.dist - 5) * 2);
    }
  }

  // Check for red light ahead
  const intAhead = findIntersectionAhead(vehicle, vehicle.heading, cityMap, 25);
  if (intAhead && intAhead.dist < 20) {
    const isHorizontal = Math.abs(Math.cos(vehicle.heading)) > 0.7;
    const signalDir = isHorizontal ? 'ew' : 'ns';
    const signal = getSignalState(intAhead.intersection, signalDir, simTimeMs);

    if (signal === 'red' && intAhead.dist > 4) {
      // Stop before intersection
      const stopDist = intAhead.dist - intAhead.intersection.width / 2 - 3;
      if (stopDist < 15) {
        targetSpeed = Math.max(0, stopDist * 1.5);
      }
      if (stopDist < 2) {
        targetSpeed = 0;
        sUpdate.state = 'stopping';
      }
    } else if (signal === 'yellow' && intAhead.dist > 8) {
      targetSpeed = Math.min(targetSpeed, 5);
    }
  }

  // Check if we're entering an intersection — decide to turn
  const currentInt = isInIntersection(vehicle, cityMap);
  if (currentInt && state.state === 'driving') {
    const exits = getExitRoads(currentInt, vehicle.heading, cityMap);
    if (exits.length > 0) {
      // Weight: straight 60%, left 20%, right 20%
      const r = pseudoRandom(vehicle.id, simTimeMs);
      let chosen;
      const straight = exits.find(e => e.turnType === 'straight');
      const lefts = exits.filter(e => e.turnType === 'left');
      const rights = exits.filter(e => e.turnType === 'right');

      if (r < 0.6 && straight) {
        chosen = straight;
      } else if (r < 0.8 && lefts.length > 0) {
        chosen = lefts[0];
      } else if (rights.length > 0) {
        chosen = rights[0];
      } else {
        chosen = straight || exits[0];
      }

      if (chosen && Math.abs(normalizeAngle(chosen.heading - vehicle.heading)) > 0.3) {
        sUpdate.state = 'turning';
        sUpdate.turnTimer = 0;
        sUpdate.turnDuration = 1.2;
        sUpdate.turnStartHeading = vehicle.heading;
        sUpdate.turnEndHeading = chosen.heading;
        targetSpeed = 6; // slow for turn
      }
    }
  }

  // Lane change consideration
  sUpdate.laneChangeCooldown = (state.laneChangeCooldown || 0) - deltaS;
  if (state.laneChangeCooldown <= 0 && state.state === 'driving' && !currentInt) {
    // Consider lane change if car ahead is slow
    if (ahead && ahead.dist < 12) {
      const dir = Math.random() > 0.5 ? 1 : -1;
      const laneWidth = 3.5;
      if (isLaneClear(vehicle, dir * laneWidth, allVehicles)) {
        sUpdate.state = 'lane_changing';
        sUpdate.laneChangeTimer = 0;
        sUpdate.laneChangeDir = dir;
        sUpdate.laneChangeCooldown = 8 + Math.random() * 8;
      } else {
        sUpdate.laneChangeCooldown = 3;
      }
    } else {
      sUpdate.laneChangeCooldown = 5 + Math.random() * 5;
    }
  }

  // Apply speed
  const speed = approachSpeed(state.currentSpeed, targetSpeed, state.accel, deltaS);
  sUpdate.currentSpeed = speed;

  // Move forward
  const dist = speed * deltaS;
  vUpdate.x = vehicle.x + Math.cos(vehicle.heading) * dist;
  vUpdate.y = vehicle.y + Math.sin(vehicle.heading) * dist;

  // Wrap around city bounds (keep vehicles in the city)
  const b = cityMap.bounds;
  if (vUpdate.x! < b.minX + 5) vUpdate.x = b.maxX - 5;
  if (vUpdate.x! > b.maxX - 5) vUpdate.x = b.minX + 5;
  if (vUpdate.y! < b.minY + 5) vUpdate.y = b.maxY - 5;
  if (vUpdate.y! > b.maxY - 5) vUpdate.y = b.minY + 5;

  return { vehicle: vUpdate, npcState: sUpdate };
}

function updateStopping(
  vehicle: Vehicle,
  state: NPCState,
  deltaS: number,
  cityMap: CityMap,
  allVehicles: Vehicle[],
  simTimeMs: number
): { vehicle: Partial<Vehicle>; npcState: Partial<NPCState> } {
  const sUpdate: Partial<NPCState> = {};
  const vUpdate: Partial<Vehicle> = {};

  // Check if light turned green
  const intAhead = findIntersectionAhead(vehicle, vehicle.heading, cityMap, 20);
  if (intAhead) {
    const isHorizontal = Math.abs(Math.cos(vehicle.heading)) > 0.7;
    const signalDir = isHorizontal ? 'ew' : 'ns';
    const signal = getSignalState(intAhead.intersection, signalDir, simTimeMs);

    if (signal === 'green') {
      sUpdate.state = 'driving';
      sUpdate.currentSpeed = 0;
    }
  } else {
    // No intersection ahead, resume driving
    sUpdate.state = 'driving';
  }

  // Decelerate to stop
  const speed = approachSpeed(state.currentSpeed, 0, state.accel * 2, deltaS);
  sUpdate.currentSpeed = speed;

  const dist = speed * deltaS;
  vUpdate.x = vehicle.x + Math.cos(vehicle.heading) * dist;
  vUpdate.y = vehicle.y + Math.sin(vehicle.heading) * dist;

  return { vehicle: vUpdate, npcState: sUpdate };
}

function updateTurning(
  vehicle: Vehicle,
  state: NPCState,
  deltaS: number
): { vehicle: Partial<Vehicle>; npcState: Partial<NPCState> } {
  const sUpdate: Partial<NPCState> = {};
  const vUpdate: Partial<Vehicle> = {};

  const timer = state.turnTimer + deltaS;
  sUpdate.turnTimer = timer;

  const t = Math.min(1, timer / state.turnDuration);
  // Smooth ease in/out
  const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

  const heading = lerpAngle(state.turnStartHeading, state.turnEndHeading, ease);
  vUpdate.heading = heading;

  // Slow speed through turn
  const turnSpeed = 5;
  sUpdate.currentSpeed = turnSpeed;

  const dist = turnSpeed * deltaS;
  vUpdate.x = vehicle.x + Math.cos(heading) * dist;
  vUpdate.y = vehicle.y + Math.sin(heading) * dist;

  if (t >= 1) {
    sUpdate.state = 'driving';
    vUpdate.heading = state.turnEndHeading;
  }

  return { vehicle: vUpdate, npcState: sUpdate };
}

function updateLaneChanging(
  vehicle: Vehicle,
  state: NPCState,
  deltaS: number
): { vehicle: Partial<Vehicle>; npcState: Partial<NPCState> } {
  const sUpdate: Partial<NPCState> = {};
  const vUpdate: Partial<Vehicle> = {};

  const duration = 2.0;
  const timer = state.laneChangeTimer + deltaS;
  sUpdate.laneChangeTimer = timer;

  const t = Math.min(1, timer / duration);
  const laneWidth = 3.5;

  // Lateral movement
  const lateralSpeed = (laneWidth / duration) * state.laneChangeDir;
  const sinH = Math.sin(vehicle.heading);
  const cosH = Math.cos(vehicle.heading);

  // Move forward + laterally
  const speed = state.currentSpeed;
  const dist = speed * deltaS;
  vUpdate.x = vehicle.x + cosH * dist - sinH * lateralSpeed * deltaS;
  vUpdate.y = vehicle.y + sinH * dist + cosH * lateralSpeed * deltaS;

  if (t >= 1) {
    sUpdate.state = 'driving';
  }

  sUpdate.currentSpeed = speed;

  return { vehicle: vUpdate, npcState: sUpdate };
}

function approachSpeed(current: number, target: number, accel: number, dt: number): number {
  if (current < target) {
    return Math.min(target, current + accel * dt);
  } else {
    return Math.max(target, current - accel * 2 * dt); // brake harder than accelerate
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let diff = b - a;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return a + diff * t;
}

function pseudoRandom(id: string, time: number): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  // Use time to vary decisions at different intersections
  const combined = Math.abs(hash + Math.floor(time / 5000));
  return (combined % 100) / 100;
}
