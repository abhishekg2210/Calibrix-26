import { CityConfig, SignalTiming } from '../config';
import { CityModel } from '../model/types';
import { SimStats } from './sim';

/** Messages between the main thread and the sim worker. */

export interface SceneSeg {
  id: number;
  orientation: 'h' | 'v';
  dir: number;
  ax: number; ay: number; bx: number; by: number;
  lanes: number;
  length: number;
  fromInter: number;
  toInter: number;
}

/** One-time static payload for the renderer. */
export interface StaticScene {
  model: CityModel;
  segs: SceneSeg[];
}

export const KIND_CAR = 0;
export const KIND_AV = 1;
export const KIND_PED = 2;

/** Pedestrian slots are offset so agent ids never collide with vehicles. */
export const PED_ID_BASE = 1 << 20;

export interface SnapshotMsg {
  type: 'snapshot';
  t: number;             // sim seconds
  clockHour: number;     // 0..24
  count: number;
  /** Stable agent ids, parallel to data. */
  ids: Int32Array;
  /** [x, y, heading, speed] per agent. */
  data: Float32Array;
  /** KIND_* per agent. */
  kinds: Uint8Array;
  /** Current phase per intersection (PHASE_* or 4=all-red). */
  signalPhases: Uint8Array;
}

export interface StatsMsg {
  type: 'stats';
  stats: SimStats;
  clockHour: number;
  /** EMA average speed per directed road segment (m/s). */
  segSpeeds: Float32Array;
  /** Vehicles per lane-km per directed road segment (sampled). */
  segDensity: Float32Array;
  /** Cumulative vehicles through each intersection. */
  interThroughput: Int32Array;
  /** Stopped vehicles queued at each intersection (sampled). */
  interQueue: Int32Array;
  /** Pedestrians per block (sampled). */
  blockPeds: Int32Array;
  /** Achieved sim speed multiplier (may lag the requested one under load). */
  achievedSpeed: number;
}

export type WorkerOutMsg =
  | { type: 'ready'; scene: StaticScene }
  | SnapshotMsg
  | StatsMsg;

export type WorkerInMsg =
  | { type: 'init'; cfg: CityConfig }
  | { type: 'setSpeed'; multiplier: number } // 0 pauses
  | { type: 'setDemand'; multiplier: number }
  | { type: 'setAvShare'; share: number }
  | { type: 'setSegClosed'; segId: number; closed: boolean }
  | { type: 'setSignalTiming'; timing: SignalTiming };
