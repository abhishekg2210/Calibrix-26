import { StatsMsg, StaticScene } from '../engine/protocol';
import { SignalTiming } from '../config';
import { KpiHistory } from './kpiHistory';
import { RunRecord } from './runStore';

export type HeatmapMode = 'none' | 'speed' | 'density' | 'peds';

export type Selection =
  | { kind: 'intersection'; id: number }
  | { kind: 'segment'; id: number }
  | { kind: 'agent'; id: number }
  | null;

export interface AgentInfo {
  id: number;
  kind: 'car' | 'av' | 'ped';
  speedKmh: number;
}

export const TABS = ['KPIS', 'HEATMAP', 'TIME', 'INSPECT', 'LAB'] as const;
export type Tab = typeof TABS[number];

export interface PanelApi {
  stats: StatsMsg | null;
  history: KpiHistory;
  scene: StaticScene;
  heatmapMode: HeatmapMode;
  setHeatmapMode: (m: HeatmapMode) => void;
  speed: number;
  setSpeed: (s: number) => void;
  demandMult: number;
  setDemandMult: (d: number) => void;
  selection: Selection;
  clearSelection: () => void;
  agentInfo: AgentInfo | null;
  following: boolean;
  setFollowing: (f: boolean) => void;
  clockHour: number;
  tab: Tab;
  setTab: (t: Tab) => void;
  lab: LabApi;
}

/** Experiments tab API. */
export interface LabApi {
  avSharePct: number;
  setAvSharePct: (p: number) => void;
  signal: SignalTiming;
  setSignal: (s: SignalTiming) => void;
  /** When on, canvas clicks close/reopen road segments instead of inspecting. */
  closeMode: boolean;
  setCloseMode: (b: boolean) => void;
  closedSegs: number[];
  reopenSeg: (id: number) => void;
  baseline: RunRecord | null;
  saveBaseline: () => void;
  clearBaseline: () => void;
  restartRun: () => void;
  exportCsv: () => void;
  openConfig: () => void;
}
