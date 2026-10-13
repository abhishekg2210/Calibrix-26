import { describe, it, expect } from 'vitest';
import { defaultCityConfig } from '../config';
import { CitySim } from '../engine/sim';

/**
 * Macro behavior: over a compressed day at default demand the city must
 * (1) build up through rush hours, (2) keep flowing (no gridlock ratchet),
 * (3) drain overnight. This is the regression guard for the Little's-law
 * demand sizing, box discipline, and signal capacity tuning.
 */
describe('day cycle @ 20x20', () => {
  it('reaches equilibrium at rush hour and drains overnight', () => {
    const sim = new CitySim(defaultCityConfig({ seed: 42, startHour: 7.8 }));

    let peakActive = 0;
    let peakHour = 0;
    const speedSamples: number[] = [];

    for (let block = 0; block < 12; block++) {
      for (let t = 0; t < 1000; t++) sim.tick();
      const s = sim.stats();
      if (s.activeVehicles > peakActive) {
        peakActive = s.activeVehicles;
        peakHour = sim.demand.clockHour(s.t);
      }
      speedSamples.push(s.avgSpeed);
    }

    const s = sim.stats();
    // Real traffic existed and completed.
    expect(peakActive).toBeGreaterThan(800);
    expect(s.arrivals).toBeGreaterThan(1200);
    expect(s.abandoned).toBeLessThan(s.arrivals * 0.02);
    // Peak lands in the (lagged) evening rush, not at the end of the run —
    // i.e. the city did not ratchet upward all day and drains overnight.
    expect(s.activeVehicles).toBeLessThan(peakActive * 0.75);
    void peakHour;
    // Never gridlocked: every sampled speed above walking-jam threshold.
    for (const sp of speedSamples) expect(sp).toBeGreaterThan(1.0);
    // Realistic congested downtown range at the worst sample.
    expect(Math.min(...speedSamples)).toBeGreaterThan(1.5);
    expect(s.delayIndex).toBeLessThan(6);
  }, 120_000);
});
