import { describe, it, expect } from 'vitest';
import { defaultCityConfig } from '../config';
import { CitySim } from '../engine/sim';

describe('performance @ 20x20', () => {
  it('sustains thousands of vehicles within tick budget', () => {
    // Stress configuration: demand deliberately past capacity to slam the
    // vehicle count toward the cap — this measures compute cost, not realism
    // (daycycle.test covers flow quality at default demand).
    const sim = new CitySim(defaultCityConfig({
      rows: 20, cols: 20,
      maxVehicles: 5000,
      demandScale: 3.5,
      startHour: 7.8,
      seed: 42,
    }));

    let peak = 0;
    const RAMP_TICKS = 5000; // 500 sim seconds
    for (let t = 0; t < RAMP_TICKS; t++) {
      sim.tick();
      if (sim.veh.count > peak) peak = sim.veh.count;
    }
    expect(peak).toBeGreaterThan(3000);

    const MEASURE = 600;
    const t0 = performance.now();
    for (let t = 0; t < MEASURE; t++) sim.tick();
    const msPerTick = (performance.now() - t0) / MEASURE;

    console.log(`[perf] peak=${peak} active=${sim.veh.count} msPerTick=${msPerTick.toFixed(2)} arrivals=${sim.stats().arrivals}`);

    // Budget: 8ms/tick @ 10Hz leaves plenty of headroom in the worker.
    // CI machines vary; 15ms is the hard fail line.
    expect(msPerTick).toBeLessThan(15);
  }, 120_000);
});
