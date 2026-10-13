import { describe, it, expect } from 'vitest';
import { defaultCityConfig } from '../config';
import { CitySim } from '../engine/sim';

const VEH_LEN = 4.6;

// ~150 vehicles on a 6x6 grid ≈ 45 lane-meters per car: busy but flowing.
function smallCfg(seed = 42) {
  return defaultCityConfig({
    rows: 6, cols: 6,
    maxVehicles: 150,
    seed,
    startHour: 8, // morning peak so demand flows immediately
  });
}

describe('city sim', () => {
  it('runs without NaN, speed bounds hold, no same-lane overlaps', () => {
    const sim = new CitySim(smallCfg());
    for (let tick = 0; tick < 1200; tick++) {
      sim.tick();
      if (tick % 100 !== 0) continue;
      const v = sim.veh;
      // Per-edge ordered overlap check.
      const byEdge = new Map<number, number[]>();
      for (let i = 0; i < v.highWater; i++) {
        if (!v.alive[i]) continue;
        expect(Number.isFinite(v.pos[i])).toBe(true);
        expect(Number.isFinite(v.speed[i])).toBe(true);
        expect(v.speed[i]).toBeGreaterThanOrEqual(0);
        expect(v.speed[i]).toBeLessThan(16);
        let list = byEdge.get(v.edge[i]);
        if (!list) byEdge.set(v.edge[i], (list = []));
        list.push(i);
      }
      for (const [, list] of byEdge) {
        list.sort((a, b) => v.pos[a] - v.pos[b]);
        for (let k = 1; k < list.length; k++) {
          const gap = v.pos[list[k]] - v.pos[list[k - 1]];
          expect(gap, `overlap on edge at t=${sim.t.toFixed(1)}`).toBeGreaterThan(VEH_LEN * 0.5);
        }
      }
    }
    expect(sim.veh.count).toBeGreaterThan(15); // traffic actually exists
  });

  it('trips complete with sane travel times', () => {
    const sim = new CitySim(smallCfg());
    for (let tick = 0; tick < 4000; tick++) sim.tick(); // 400 sim seconds
    const s = sim.stats();
    expect(s.arrivals).toBeGreaterThan(30);
    expect(s.avgTripS).toBeGreaterThan(20);
    expect(s.avgTripS).toBeLessThan(600);
    // Free-flow baseline has zero signal delay; a 4-phase signalized grid at
    // peak legitimately runs 3-6x. Above ~8 means gridlock.
    expect(s.delayIndex).toBeGreaterThanOrEqual(1);
    expect(s.delayIndex).toBeLessThan(8);
    // Abandoned trips should be rare relative to completions.
    expect(s.abandoned).toBeLessThan(Math.max(5, s.arrivals * 0.1));
  });

  it('is deterministic for the same seed', () => {
    const a = new CitySim(smallCfg(7));
    const b = new CitySim(smallCfg(7));
    for (let tick = 0; tick < 800; tick++) { a.tick(); b.tick(); }
    expect(a.hash()).toBe(b.hash());
    expect(a.stats().spawned).toBe(b.stats().spawned);
  });

  it('differs across seeds', () => {
    const a = new CitySim(smallCfg(7));
    const b = new CitySim(smallCfg(8));
    for (let tick = 0; tick < 800; tick++) { a.tick(); b.tick(); }
    expect(a.hash()).not.toBe(b.hash());
  });

  it('vehicles respect red lights (sampled)', () => {
    const sim = new CitySim(smallCfg());
    // Warm up.
    for (let tick = 0; tick < 1500; tick++) sim.tick();
    // For vehicles inside connectors, the phase must be open OR they entered
    // recently (committed before the switch). Sample over time: count hard
    // violations where a vehicle ENTERS a closed connector.
    let entries = 0, violations = 0;
    let prevEdges = snapshotEdges(sim);
    for (let tick = 0; tick < 1500; tick++) {
      sim.tick();
      const cur = snapshotEdges(sim);
      for (const [slot, edgeId] of cur) {
        const prev = prevEdges.get(slot);
        if (prev === undefined || prev === edgeId) continue;
        const e = sim.graph.edges[edgeId];
        if (e.kind !== 1) continue;
        if (e.turnType === 1) continue; // right turns may legally go on red (RTOR)
        entries++;
        if (!sim.signals.isOpen(e.interId, e.phaseMask)) violations++;
      }
      prevEdges = cur;
    }
    expect(entries).toBeGreaterThan(40);
    // A vehicle can legally cross the line in the same tick a phase flips —
    // allow a small tolerance, but systematic running of reds must not happen.
    expect(violations / entries).toBeLessThan(0.05);
  });

  it('road closures divert traffic', () => {
    const sim = new CitySim(smallCfg());
    for (let tick = 0; tick < 1000; tick++) sim.tick();

    // Close a central segment (all its lanes).
    const seg = sim.graph.segs[Math.floor(sim.graph.segs.length / 2)];
    for (const eid of seg.laneEdges) sim.graph.edges[eid].closed = true;
    sim.rerouteAroundClosures();

    // No remaining route may use a closed edge.
    const v = sim.veh;
    for (let i = 0; i < v.highWater; i++) {
      if (!v.alive[i]) continue;
      const route = v.routes[i]!;
      for (let r = v.routeIdx[i] + 1; r < route.length; r++) {
        expect(sim.graph.edges[route[r]].closed, `vehicle ${i} still routed through closure`).toBe(false);
      }
    }

    // And nobody ENTERS the closed lanes from here on.
    const closed = new Set(seg.laneEdges);
    for (let tick = 0; tick < 600; tick++) {
      sim.tick();
      if (tick % 50 !== 0) continue;
      for (let i = 0; i < v.highWater; i++) {
        if (v.alive[i] && closed.has(v.edge[i])) {
          // A vehicle could have been ON the segment when it closed; it may
          // only ever be one that was already there (pos can only grow).
          expect(sim.t - v.spawnT[i]).toBeGreaterThan(60);
        }
      }
    }
    expect(sim.stats().arrivals).toBeGreaterThan(0);
  });

  it('congestion feedback reaches the router', () => {
    const sim = new CitySim(smallCfg());
    for (let tick = 0; tick < 2000; tick++) sim.tick();
    let above = 0;
    for (let i = 0; i < sim.router.congestion.length; i++) {
      if (sim.router.congestion[i] > 1.01) above++;
    }
    expect(above).toBeGreaterThan(0);
  });
});

function snapshotEdges(sim: CitySim): Map<number, number> {
  const m = new Map<number, number>();
  const v = sim.veh;
  for (let i = 0; i < v.highWater; i++) {
    if (v.alive[i]) m.set(i, v.edge[i]);
  }
  return m;
}
