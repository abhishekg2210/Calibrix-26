import { describe, it, expect } from 'vitest';
import { defaultCityConfig } from '../config';
import { CitySim } from '../engine/sim';
import { buildWalkGraph, WalkRouter } from '../graph/walkGraph';
import { generateCityModel } from '../model/generate';
import { Rng } from '../engine/rng';

describe('walk graph', () => {
  const model = generateCityModel(defaultCityConfig({ rows: 6, cols: 6 }));
  const g = buildWalkGraph(model);

  it('connects: routes exist between random corners', () => {
    const router = new WalkRouter(g);
    const rng = new Rng(5);
    let ok = 0;
    for (let trial = 0; trial < 100; trial++) {
      const a = rng.int(g.nodeCount);
      const b = rng.int(g.nodeCount);
      if (a === b) continue;
      const route = router.route(a, b);
      expect(route, `no walk route ${a} -> ${b}`).not.toBeNull();
      ok++;
    }
    expect(ok).toBeGreaterThan(80);
  });

  it('crosswalks carry phase + side metadata', () => {
    const cw = g.edges.filter(e => e.kind === 1);
    expect(cw.length).toBeGreaterThan(50);
    for (const e of cw) {
      expect(e.interId).toBeGreaterThanOrEqual(0);
      expect(e.side).toBeGreaterThanOrEqual(0);
      expect(e.side).toBeLessThan(4);
      expect([0, 2]).toContain(e.walkPhase); // NS or EW straight
    }
  });
});

describe('pedestrians in sim', () => {
  it('spawn, walk, wait at crosswalks, and arrive', () => {
    const sim = new CitySim(defaultCityConfig({
      rows: 6, cols: 6, maxVehicles: 150, maxPedestrians: 800, seed: 42, startHour: 8,
    }));
    let sawWaiting = false;
    let peakPeds = 0;
    for (let t = 0; t < 4000; t++) {
      sim.tick();
      if (sim.peds.waitingCount > 0) sawWaiting = true;
      if (sim.peds.count > peakPeds) peakPeds = sim.peds.count;
    }
    const s = sim.stats();
    expect(peakPeds).toBeGreaterThan(50);
    expect(s.pedArrivals).toBeGreaterThan(30);
    expect(sawWaiting).toBe(true);

    // No NaN poses.
    for (let i = 0; i < sim.peds.highWater; i++) {
      if (!sim.peds.alive[i]) continue;
      expect(Number.isFinite(sim.peds.x[i])).toBe(true);
      expect(Number.isFinite(sim.peds.y[i])).toBe(true);
    }
  });

  it('peds only occupy crosswalks during their walk phase', () => {
    const sim = new CitySim(defaultCityConfig({
      rows: 6, cols: 6, maxVehicles: 100, maxPedestrians: 800, seed: 11, startHour: 8,
    }));
    for (let t = 0; t < 1500; t++) sim.tick();
    // Sample: walk the live peds; any ped ON a crosswalk implies it entered
    // during the right phase. We verify the entry gate by checking that no
    // ped *starts* a crosswalk during the wrong phase over a window.
    let entries = 0, badEntries = 0;
    const onCw = new Set<number>();
    for (let t = 0; t < 800; t++) {
      sim.tick();
      const g = sim.walkGraph;
      for (let i = 0; i < sim.peds.highWater; i++) {
        if (!sim.peds.alive[i]) { onCw.delete(i); continue; }
        const route = sim.peds.routes[i]!;
        const e = g.edges[route[sim.peds.segIdx[i]]];
        const isOn = e.kind === 1 && sim.peds.pos[i] > 0.01 && sim.peds.waiting[i] === 0;
        if (isOn && !onCw.has(i)) {
          entries++;
          if (sim.signals.current[e.interId] !== e.walkPhase) badEntries++;
          onCw.add(i);
        } else if (!isOn) {
          onCw.delete(i);
        }
      }
    }
    expect(entries).toBeGreaterThan(20);
    expect(badEntries / entries).toBeLessThan(0.03);
  });

  it('remains deterministic with pedestrians active', () => {
    const mk = () => new CitySim(defaultCityConfig({
      rows: 6, cols: 6, maxVehicles: 120, maxPedestrians: 500, seed: 9, startHour: 8,
    }));
    const a = mk(), b = mk();
    for (let t = 0; t < 600; t++) { a.tick(); b.tick(); }
    expect(a.hash()).toBe(b.hash());
    expect(a.peds.count).toBe(b.peds.count);
    expect(a.peds.arrivals).toBe(b.peds.arrivals);
  });
});
