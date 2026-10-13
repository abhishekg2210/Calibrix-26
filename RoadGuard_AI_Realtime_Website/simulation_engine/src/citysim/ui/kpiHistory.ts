import { StatsMsg } from '../engine/protocol';

/** One sampled KPI point (built from worker stats messages, ~2Hz). */
export interface KpiSample {
  t: number;            // sim seconds
  clockHour: number;
  activeVehicles: number;
  activePeds: number;
  avgSpeedKmh: number;
  delayIndex: number;
  throughputPerMin: number; // completed vehicle trips per sim minute
  waitingPeds: number;
}

const MAX_SAMPLES = 1200;

export class KpiHistory {
  samples: KpiSample[] = [];
  private lastArrivals = 0;
  private lastT = 0;

  push(msg: StatsMsg) {
    const s = msg.stats;
    const dt = s.t - this.lastT;
    const dA = s.arrivals - this.lastArrivals;
    const throughput = dt > 0.5 ? (dA / dt) * 60 : (this.samples.at(-1)?.throughputPerMin ?? 0);
    if (dt > 0.5) {
      this.lastT = s.t;
      this.lastArrivals = s.arrivals;
    }
    this.samples.push({
      t: s.t,
      clockHour: msg.clockHour,
      activeVehicles: s.activeVehicles,
      activePeds: s.activePeds,
      avgSpeedKmh: s.avgSpeed * 3.6,
      delayIndex: s.delayIndex,
      throughputPerMin: throughput,
      waitingPeds: s.waitingPeds,
    });
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }

  series(key: keyof KpiSample): number[] {
    return this.samples.map(s => s[key] as number);
  }

  clear() {
    this.samples = [];
    this.lastArrivals = 0;
    this.lastT = 0;
  }
}
