# City Command Mode — Architecture & Build Plan

A new full-city simulation mode for av-planner-sim: autonomous car + pedestrian traffic
across a configurable city grid (default 20×20 blocks), observed and controlled through a
3D command-center view. Built to professional standards — the kind of tool a city traffic
department could use to predict transportation flow.

## Decisions (locked 2026-06-10)

| Question | Decision |
|---|---|
| Product goal | Credible simulation engine + polished command center (both) |
| Agent scale | 10,000+ agents, full WebGL pipeline |
| Command center | Tabbed UI: Heatmaps, KPIs, Time/Demand, Inspect, Experiments |
| Visual style | Full 3D perspective via three.js |
| Experiments | Interventions (signal retiming, road closures, demand modifiers) + A/B run comparison |
| AV tie-in | AV fleet as first-class layer (configurable % of vehicles, fleet KPIs) |
| City size | User-configurable before run; 20×20 default |
| Existing mode | Planner Lab (current 2D comparison mode) remains untouched as a sibling mode |

## Why the current code can't do this (audit summary)

- NPC vehicles are free-floating particles: no lane graph, no routes, no destinations,
  edge teleport-wrap. Flow cannot be measured because nothing is going anywhere.
- No pedestrians, no sidewalk network; crosswalks are painted but inert.
- No road network graph at all — roads are render/collision rectangles only.
- No metrics layer: zero instrumentation of travel time, queues, throughput.
- Sim state lives in the Zustand store with per-vehicle object spreads per frame —
  collapses well before 1,000 agents, let alone 10,000.

What carries over: the parameterized `CityGenerator` (already takes rows/cols/block
dims), the four planners + worker runner (reused for AV fleet routing), the design
system, and the Planner Lab mode as-is.

## Target architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Main thread                                                 │
│  React shell: mode switch, config screen, command center    │
│  tabs, charts (Zustand = UI state ONLY)                     │
│  Three.js renderer: instanced vehicles/peds, extruded city, │
│  day/night lighting, heatmap overlays, raycast picking      │
└──────────────▲──────────────────────────────────────────────┘
               │ SharedArrayBuffer (agent state, SoA typed arrays)
               │ postMessage (commands, metrics snapshots)
┌──────────────▼──────────────────────────────────────────────┐
│ Sim worker (fixed 10 Hz timestep, time scale 1×–64×)        │
│  Road network graph (lane-level) + sidewalk/crosswalk graph │
│  Demand engine: zone O-D matrix × time-of-day curves        │
│  Vehicle model: IDM car-following, lane changing, signals   │
│  Pedestrian model: sidewalk routing, crosswalk yield        │
│  AV fleet: planner-routed subset with distinct behavior     │
│  Metrics engine: per-edge density/speed, queues, travel     │
│  times, throughput → ring buffers → snapshot to main thread │
└─────────────────────────────────────────────────────────────┘
```

Key principles:
- **Structure-of-arrays in SharedArrayBuffer**: position, heading, speed, laneRef,
  routeProgress, kind (car/AV/ped) as Float32/Int32 arrays. Renderer interpolates
  between sim ticks for smooth 60 fps motion at any time scale.
- **Determinism**: seeded RNG everywhere; same seed + config + interventions =
  identical run. Required for honest A/B comparison.
- **Fallback**: if cross-origin isolation is unavailable (SAB requires COOP/COEP
  headers — configure in vite.config and on deploy), fall back to transferable
  ArrayBuffer snapshots per tick.

## Core data model (new)

1. **RoadNetwork** — directed lane-level graph. Nodes at intersection lane entry/exit
   points; edges are lane segments (with geometry, speed limit, capacity) and
   intersection connector arcs (with signal-phase + turn-type tags). Built from the
   existing `CityLayout` generator output.
2. **WalkNetwork** — sidewalk loops around each block + crosswalk edges at
   intersections (gated by signal phase).
3. **Zoning** — generator assigns each building a land use (residential, office,
   commercial, civic, park) with capacity weights. The O-D demand matrix derives from
   zoning: morning peak residential→office, midday commercial churn, evening reverse
   commute, night trickle. 24h clock compressed (configurable, e.g. 24 min = 24 h).
4. **Signal controller** — per-intersection phase plans (NS/EW green + protected
   turns where lanes ≥2), editable timing, queue detection per approach.

## Behavior models

- **Vehicles**: Intelligent Driver Model (IDM) for longitudinal control — the standard
  microsimulation car-following model; gives realistic shockwaves and queue dynamics
  cheaply. Discrete lane changes (gap acceptance) when beneficial for route or speed.
  Routes via A* over the lane graph with congestion-aware edge costs; optional periodic
  reroute (models navigation apps).
- **Pedestrians**: point agents on the walk graph; queue at crosswalks until walk
  phase, cross at ~1.4 m/s; vehicles yield to occupied crosswalks on turns.
- **AV fleet**: configurable share (0–30%). AVs route using the selected planner
  family with congestion-aware costs, drive with tighter headways/smoother profiles,
  never run yellows. Rendered visually distinct (sensor halo / detection-box aesthetic
  when inspected). Fleet vs. human KPIs tracked separately.

## Command center (tabbed)

1. **Heatmaps** — per-edge color overlays on the 3D road geometry: speed ratio,
   density, pedestrian density on sidewalks; layer toggles (cars / people / both).
2. **KPIs** — live city-wide stats with sparkline history: active agents, avg travel
   time vs. free-flow, total throughput, top-5 bottleneck intersections, avg queue
   length, AV vs. human comparison.
3. **Time/Demand** — 24h clock, time-scale control, pause/scrub of metric history,
   day/night visual cycle, demand profile editor (peak multipliers, event injection
   e.g. "stadium event at block X").
4. **Inspect** — raycast picking: intersection (signal phasing + per-approach queues),
   road segment (flow/speed/density), agent (route, ETA, state). Follow-camera mode.
5. **Experiments** — interventions: close road/lane, retime a signal (or all),
   demand ±%, AV fleet %. Run manager: record KPI time series per seeded run,
   baseline-vs-variant side-by-side charts and deltas, CSV/JSON export.

## 3D rendering (three.js)

- Extruded buildings (InstancedMesh, height from zoning + seed), road planes with
  generated lane-marking textures, signal heads, simple props (trees on park blocks).
- Vehicles: ~3 low-poly body variants via InstancedMesh with per-instance color;
  pedestrians: instanced capsules. 10k+ instances is comfortable for three.js.
- Day/night: animated sun/sky lighting, emissive building windows, headlights/
  taillights (emissive sprites) at night, signal glow.
- Camera: orbit/pan/zoom with limits, preset views, agent-follow mode.
- Heatmaps as vertex colors / data textures on road geometry — no extra draw calls.

## Build phases

**Phase 1 — Network + engine foundation** (the load-bearing phase)
Lane-graph + walk-graph builders from CityLayout; zoning; sim worker skeleton with
SoA state, fixed timestep, seeded RNG; IDM vehicles routing over the graph with
signal stops; spawn/despawn from O-D demand. Validate at 20×20 with 5k vehicles
(headless perf test before any 3D work).

**Phase 2 — 3D city renderer**
three.js scene from the same CityLayout; instanced vehicles reading the SAB with
interpolation; camera rig; day/night cycle. First "wow" milestone.

**Phase 3 — Pedestrians + signals v2**
Walk-graph agents, crosswalk phases, vehicle yielding; protected turns; queue
detection feeding the metrics engine.

**Phase 4 — Command center**
Metrics engine + ring buffers; tabbed UI; heatmap overlays; KPI charts; inspect/
picking; time controls. Second milestone — the screenshot moment.

**Phase 5 — Experiments + AV fleet**
Interventions, run recording, A/B comparison view, export; AV fleet behavior +
fleet KPIs; config screen (city size 8×8–30×30, density, seed, AV %, demand
profile) shown before each run.

**Phase 6 — Professionalization pass**
Perf budget enforcement (sim tick <8 ms at 10k agents, 60 fps render), error
boundaries, README rewrite with screenshots/GIFs, deploy with COOP/COEP headers.

## Risks

- **SharedArrayBuffer headers** on hosting (Vercel: set COOP/COEP in headers config);
  fallback path keeps it working regardless.
- **Intersection deadlock/gridlock** at high demand — needs queue-spillback handling
  ("don't block the box") and demand caps; budget tuning time in Phase 3.
- **Scope**: full 3D + 10k agents + A/B tooling is a large build. Phases 1–2 are
  independently demoable; cut from the tail, never the foundation.
