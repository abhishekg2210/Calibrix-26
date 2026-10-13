# AV Planner Sim

A browser-based autonomous-vehicle and urban-traffic simulation suite with two modes:

- **Planner Lab** — interactive AV path-planning comparison: run A*, RRT*, Lattice, and
  Learned planners side-by-side on a city scenario, then simulate the drive with live
  NPC traffic.
- **City Command** — a full-city transportation digital twin: thousands of individually
  simulated vehicles and pedestrians on a configurable grid (default 20×20 blocks),
  observed through a 3D command center with live heatmaps, KPIs, drill-down inspection,
  and intervention experiments with A/B run comparison.

## City Command

### Simulation engine (`src/citysim/engine`, runs in a web worker)

- **Lane-level road network**: a directed graph where every lane of every road segment
  and every signalized turn movement is an edge. ~10,000 edges at 20×20.
- **Microscopic traffic model**: IDM (Intelligent Driver Model) car-following, discrete
  lane changes with gap acceptance, protected-phase signals, right-turn-on-red with
  yield, "don't block the box" spillback discipline, and crosswalk yielding.
- **Zone-based demand**: buildings carry land uses (residential / office / commercial /
  civic / park) generated with a downtown core and residential periphery. Trips are
  produced and attracted by zone weights under time-of-day curves over a compressed
  24-hour clock — morning commutes flow inward, evening reverses, the city drains
  overnight. Demand is sized to network capacity via Little's law.
- **Pedestrians**: sidewalk-graph agents with signal-gated crosswalks; turning vehicles
  yield to occupied crosswalks.
- **Congestion-aware routing**: edge-based A* with live per-segment congestion costs,
  opportunistic en-route rerouting (navigation-app behavior), and automatic diversion
  around road closures.
- **Determinism**: same seed + config ⇒ identical run, the foundation for honest A/B
  experiments.
- **Performance**: structure-of-arrays state; ~2 ms per 100 ms sim tick with 4,000
  active vehicles (validated by `perf.test.ts`). Snapshots stream to the renderer at
  10 Hz with interpolation to 60 fps.

### Command center

| Tab | What it does |
|-----|--------------|
| KPIS | Live cards + sparklines: actives, network speed, delay index, throughput, AV-vs-human fleet comparison, worst bottleneck intersections |
| HEATMAP | Road overlays for traffic speed / density, block overlay for pedestrian density |
| TIME | 24h clock, demand curve with live marker, sim speed (pause–64×), demand multiplier |
| INSPECT | Click any intersection, road segment, or agent for live detail; follow-camera mode |
| LAB | Road closures (click-to-close), global signal retiming, AV fleet share, baseline save + A/B comparison charts with deltas, CSV export |

### 3D renderer (`src/citysim/render`)

three.js with everything instanced (buildings, vehicles, pedestrians, signals, road
markings — one draw call each), day/night lighting driven by the sim clock, orbit
camera, raycast picking.

## Planner Lab

Runs up to 4 planning algorithms simultaneously and compares paths and metrics
(length, compute time, smoothness, safety margin):

| Algorithm | Approach |
|-----------|----------|
| **A\*** | Grid search with Euclidean heuristic |
| **RRT\*** | Sampling-based tree with rewiring |
| **Lattice** | Pre-computed motion primitives |
| **Learned** | Cost-field gradient descent mimicking a neural planner |

## Run it

```bash
cd av-planner-sim
npm install
npm run dev       # dev server
npm test          # engine test suite (graph invariants, determinism, IDM safety,
                  # signal compliance, day-cycle equilibrium, closures, perf budget)
npm run build     # production build
```

Open the printed localhost URL, switch to **City Command**, configure the city
(size, demand, AV share, seed) and launch.

### Suggested experiment

1. Launch a 20×20 city at NORMAL demand, run at 16–64× through a morning rush.
2. LAB → save as baseline.
3. RESTART RUN (same seed), close 2–3 segments around the core, watch the delay
   index diverge from the gray baseline curves — then retime signals to compensate.
4. EXPORT CSV for both runs.

## Tech

React 19 + TypeScript + Vite · three.js (WebGL) · Zustand (Planner Lab state) ·
Web Worker simulation core · Vitest. No game engine.

## Architecture

```
src/
  citysim/             # City Command mode
    config.ts          # CityConfig + defaults
    model/             # city generation: grid, buildings, zoning
    graph/             # lane-level road graph + sidewalk/crosswalk graph
    engine/            # worker-side sim: IDM vehicles, peds, signals, demand,
                       # router, metrics, protocol, main-thread client
    workers/           # sim worker entry
    render/            # three.js scene (instanced everything)
    ui/                # command center: tabs, sparklines, config screen, lab
  planners/            # A*, RRT*, Lattice, Learned + worker runner
  canvas/              # Planner Lab 2D canvas renderers
  simulation/          # Planner Lab NPC/ego controllers
  city/, scenarios/    # Planner Lab city + scenario
  components/          # shared UI chrome
```
