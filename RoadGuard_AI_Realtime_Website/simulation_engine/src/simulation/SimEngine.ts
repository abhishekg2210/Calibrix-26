import { Vehicle, PathPoint } from '../planners/types';
import { CityMap } from '../city/types';
import { NPCState, createNPCState, updateNPC } from './NPCController';
import { EgoSimState, createEgoSimState, updateEgo } from './EgoController';

export type SimMode = 'idle' | 'simulating' | 'done';

export class SimEngine {
  private npcStates: Map<string, NPCState> = new Map();
  private egoState: EgoSimState = createEgoSimState();
  private simTime: number = 0;
  private mode: SimMode = 'idle';
  private egoPath: PathPoint[] = [];

  getMode() { return this.mode; }
  getEgoState() { return this.egoState; }
  getSimTime() { return this.simTime; }

  start(
    vehicles: Vehicle[],
    egoPath: PathPoint[]
  ) {
    this.mode = 'simulating';
    this.simTime = 0;
    this.egoPath = egoPath;
    this.egoState = createEgoSimState();
    this.npcStates.clear();

    // Initialize NPC states for all dynamic/obstacle vehicles (non-building)
    for (const v of vehicles) {
      if (v.id === 'ego' || v.id.startsWith('bld-obs-')) continue;
      this.npcStates.set(v.id, createNPCState(v));
    }
  }

  stop() {
    this.mode = 'idle';
  }

  tick(
    deltaMs: number,
    ego: Vehicle,
    vehicles: Vehicle[],
    cityMap: CityMap,
    updateVehicleFn: (id: string, updates: Partial<Vehicle>) => void,
  ) {
    if (this.mode !== 'simulating') return;

    const deltaS = Math.min(deltaMs / 1000, 0.05); // cap at 50ms to prevent jumps
    this.simTime += deltaMs;

    // Collect all current vehicles for lookahead checks
    const allVehicles = ego ? [ego, ...vehicles] : vehicles;

    // Update NPC vehicles
    for (const v of vehicles) {
      if (v.id === 'ego' || v.id.startsWith('bld-obs-')) continue;

      let npcState = this.npcStates.get(v.id);
      if (!npcState) {
        npcState = createNPCState(v);
        this.npcStates.set(v.id, npcState);
      }

      const { vehicle: vUpdate, npcState: sUpdate } = updateNPC(
        v, npcState, deltaS, cityMap, allVehicles, this.simTime
      );

      // Apply updates
      if (Object.keys(vUpdate).length > 0) {
        updateVehicleFn(v.id, vUpdate);
      }
      Object.assign(npcState, sUpdate);
    }

    // Update ego vehicle
    if (ego && this.egoPath.length > 0) {
      const { vehicle: egoUpdate, egoState: egoSUpdate } = updateEgo(
        ego, this.egoState, this.egoPath, deltaS, cityMap, allVehicles, this.simTime
      );

      if (Object.keys(egoUpdate).length > 0) {
        updateVehicleFn('ego', egoUpdate);
      }
      Object.assign(this.egoState, egoSUpdate);

      if (this.egoState.arrived) {
        this.mode = 'done';
      }
    }
  }
}
