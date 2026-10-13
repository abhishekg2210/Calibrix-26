import { describe, it, expect } from 'vitest';
import { defaultCityConfig } from '../config';
import { generateCityModel } from '../model/generate';
import { buildLaneGraph, edgePointAt } from '../graph/laneGraph';
import { Router } from '../engine/router';
import { DemandEngine } from '../engine/demand';
import { Rng } from '../engine/rng';

describe('lane graph', () => {
  const cfg = defaultCityConfig({ rows: 6, cols: 6, seed: 7 });
  const model = generateCityModel(cfg);
  const graph = buildLaneGraph(model);

  it('has sane edge geometry', () => {
    for (const e of graph.edges) {
      expect(e.length).toBeGreaterThan(0.5);
      expect(Number.isFinite(e.length)).toBe(true);
      expect(e.pts.length).toBeGreaterThanOrEqual(4);
      expect(e.cum[e.cum.length - 1]).toBeCloseTo(e.length, 3);
    }
  });

  it('every road edge can continue (>=1 connector)', () => {
    for (const e of graph.edges) {
      if (e.kind === 0) {
        expect(e.next.length, `road edge ${e.id} (dir ${e.dir} lane ${e.lane}) has no exit`).toBeGreaterThan(0);
        for (const n of e.next) expect(graph.edges[n].kind).toBe(1);
      }
    }
  });

  it('every connector leads to a road edge', () => {
    for (const e of graph.edges) {
      if (e.kind === 1) {
        expect(e.next.length).toBeGreaterThan(0);
        for (const n of e.next) expect(graph.edges[n].kind).toBe(0);
      }
    }
  });

  it('connector endpoints match adjacent road edge endpoints', () => {
    for (const e of graph.edges) {
      if (e.kind !== 1) continue;
      for (const nId of e.next) {
        const n = graph.edges[nId];
        const ex = e.pts[e.pts.length - 2], ey = e.pts[e.pts.length - 1];
        expect(Math.hypot(n.pts[0] - ex, n.pts[1] - ey)).toBeLessThan(0.01);
      }
    }
  });

  it('edgePointAt interpolates within bounds', () => {
    const e = graph.edges.find(x => x.kind === 1 && x.turnType !== 0)!;
    const out = { x: 0, y: 0, heading: 0 };
    for (let p = 0; p <= e.length; p += e.length / 10) {
      edgePointAt(e, p, out);
      expect(Number.isFinite(out.x)).toBe(true);
      expect(Number.isFinite(out.heading)).toBe(true);
    }
  });

  it('routes exist between random building curb points', () => {
    const router = new Router(graph);
    const demand = new DemandEngine(cfg, model, graph, new Rng(1));
    const rng = new Rng(99);
    const nb = model.buildings.length;
    let ok = 0;
    for (let trial = 0; trial < 120; trial++) {
      const a = rng.int(nb), b = rng.int(nb);
      const ea = demand.curbEdge[a], eb = demand.curbEdge[b];
      if (ea < 0 || eb < 0 || ea === eb) continue;
      const seg = graph.edges[eb].segId;
      const route = router.route(ea, graph.segs[seg].laneEdges);
      expect(route, `no route ${ea} -> ${eb}`).not.toBeNull();
      // Route must be contiguous — each step a continuation or parallel lane.
      for (let i = 1; i < route!.length; i++) {
        const prev = graph.edges[route![i - 1]];
        const cur = route![i];
        const valid = prev.next.includes(cur) || prev.leftEdge === cur || prev.rightEdge === cur;
        expect(valid, `discontinuous route at step ${i}`).toBe(true);
      }
      ok++;
    }
    expect(ok).toBeGreaterThan(60);
  });

  it('generation is deterministic', () => {
    const g2 = buildLaneGraph(generateCityModel(cfg));
    expect(g2.edges.length).toBe(graph.edges.length);
    for (let i = 0; i < graph.edges.length; i += 97) {
      expect(g2.edges[i].length).toBeCloseTo(graph.edges[i].length, 6);
      expect(g2.edges[i].next).toEqual(graph.edges[i].next);
    }
  });

  it('20x20 builds with expected scale', () => {
    const big = buildLaneGraph(generateCityModel(defaultCityConfig({ rows: 20, cols: 20 })));
    expect(big.edges.length).toBeGreaterThan(8000);
    expect(big.segs.length).toBe(2 * (21 * 20) * 2);
  });
});
