import { KpiSample } from './kpiHistory';
import { SimStats } from '../engine/sim';

/** A recorded simulation run for A/B comparison. */
export interface RunRecord {
  label: string;
  samples: KpiSample[];
  final: SimStats | null;
  /** Human-readable description of the configuration + interventions. */
  configSummary: string;
}

export function runToCsv(label: string, samples: KpiSample[]): string {
  const header = 'run,sim_seconds,clock_hour,active_vehicles,active_pedestrians,avg_speed_kmh,delay_index,throughput_trips_per_min,waiting_pedestrians';
  const rows = samples.map(s =>
    `${label},${s.t.toFixed(1)},${s.clockHour.toFixed(3)},${s.activeVehicles},${s.activePeds},${s.avgSpeedKmh.toFixed(2)},${s.delayIndex.toFixed(3)},${s.throughputPerMin.toFixed(2)},${s.waitingPeds}`,
  );
  return [header, ...rows].join('\n');
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
