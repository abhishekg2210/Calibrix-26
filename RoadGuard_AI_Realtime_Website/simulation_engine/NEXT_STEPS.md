# AV Planner Sim — Next Steps

## Completed (City Command — June 2026)

- [x] City Command mode: full-city traffic simulation (see docs/CITY_SIM_PLAN.md)
- [x] Lane-level directed road graph + sidewalk/crosswalk graph
- [x] Worker-based deterministic sim: IDM car-following, lane changes, 4-phase signals,
      RTOR, anti-spillback, pedestrians with crosswalk gating, vehicle yielding
- [x] Zone-based O-D demand over a compressed 24h clock (rush hours, overnight drain)
- [x] three.js 3D renderer: instanced buildings/vehicles/peds/signals, day/night cycle
- [x] Command center: KPI sparklines, speed/density/ped heatmaps, drill-down inspect,
      follow camera, time controls
- [x] Experiments: road closures with auto-divert, signal retiming, AV fleet share,
      baseline A/B comparison with delta table, CSV export
- [x] Pre-run config screen (size 8–28, demand presets, AV share, seed, start time)
- [x] 22-test engine suite: graph invariants, determinism, collision/red-light safety,
      day-cycle equilibrium, closure diversion, perf budget (~2ms/tick @ 4k vehicles)

## City Command — future ideas

- [ ] Per-intersection signal plan editing (UI exists for global only)
- [ ] Saved runs library (more than one baseline) + run persistence
- [ ] Transit layer: buses on fixed routes with stops
- [ ] Incidents: random lane blockages with response-time experiments
- [ ] SharedArrayBuffer state sharing (headers already shipped; snapshot transfer
      is currently fast enough)
- [ ] Ego-vehicle drive mode inside the living city using the Planner Lab planners

## Original Planner Lab roadmap

## Completed

### Phase 1: Canvas + Grid + Interaction
- [x] Project scaffolding (Vite + React 18 + TypeScript + Zustand + Lucide React)
- [x] Design system: Q's Lab color palette, typography (Outfit + IBM Plex Mono), CSS variables
- [x] Zustand store with simulation state and UI state
- [x] SimulationCanvas with requestAnimationFrame render loop, DPR handling
- [x] InteractionHandler — click to place ego/goal/obstacle, drag vehicles, pan, zoom
- [x] Header, ControlBar, PlannerPanel UI components

### Phase 2: Planning Algorithms
- [x] A* grid-based planner with road-awareness (blocks off-road points)
- [x] RRT* sampling-based planner with road-biased sampling
- [x] Lattice planner with 90-degree turn primitives for city navigation
- [x] Learned planner with road-aware cost field
- [x] PlannerRunner orchestrator with web worker support + main-thread fallback
- [x] Shared utilities: path smoothing, resampling, curvature/smoothness computation

### Phase 3: Path Visualization
- [x] PathAnimator with traveling-head drawing animation + subtle glow
- [x] Static path rendering after animation completes
- [x] RRT* exploration tree visualization
- [x] Multi-path rendering with distinct colors per planner

### City View + Live Simulation
- [x] Top-down city rendering: roads, buildings, intersections, lane markings, crosswalks
- [x] Traffic signals with cycling red/yellow/green states (time-based)
- [x] City generator: configurable grid layout (currently 10×6 blocks, ~470×240m)
- [x] Car-like vehicle rendering: rounded rects, windshields, headlights, taillights, varied colors
- [x] 25 NPC vehicles placed on roads with random speeds and headings
- [x] Road-awareness for planners: `isOnRoad()` check, `RoadRect` data, off-road blocking
- [x] NPC driving controller: lane following, red light stops, intersection turns, lane changes
- [x] Ego path-following controller: follows planned path at realistic speed, stops at red lights
- [x] Simulation engine: tick-based updates for all vehicles each frame
- [x] Two-mode UX: **PLAN** (draws all paths statically) + **SIMULATE** (live animation)
- [x] Primary planner selection (click planner in sidebar to set as simulation planner)
- [x] ARRIVED state with "DESTINATION REACHED" message and stats
- [x] HUD overlay during simulation: speed (MPH), distance, elapsed time

---

## Remaining Work

### Path Quality Improvements
- [x] Fix `resamplePath` extrapolation bug — inputs coarser than the resample
      spacing produced garbage points (NaN / off-map), inflating RRT*/Lattice
      path metrics
- [x] RRT* at city scale: 8m steps, area-weighted sampling on road rects,
      road-aware segment checks, post-shortcut pass
- [x] Lattice at city scale: weighted A* (1.5× heuristic), open-set dedupe,
      stop at first goal pop, 16m straight primitive
- [x] Learned planner at city scale: goal-propagated Dijkstra value field over
      a road-constrained grid + greedy policy rollout (local gradient descent
      got stuck behind buildings)
- [ ] Fix path cutting through buildings — ensure post-smoothing doesn't push points off-road
- [ ] A* performance: use binary heap priority queue instead of array scan (currently O(n) per pop)

### Simulation Realism
- [ ] NPC cars should avoid each other better (current car-ahead check is basic)
- [ ] NPC cars that leave the city should respawn at an edge entrance
- [ ] Ego should decelerate smoothly when approaching stopped NPC cars
- [ ] Speed display should show 0 when ego is stopped at a red light (currently shows last speed)
- [ ] Add more NPC vehicles (40-50) for denser traffic feel

### Phase 4: Scenarios (from original plan)
- [ ] Highway Lane Change scenario
- [ ] Parallel Parking scenario
- [ ] Intersection scenario (4-way with cross traffic)
- [ ] Emergency Avoidance scenario
- [ ] Scenario selector dropdown in Header

### Phase 5: PM Dashboard + Comparison View
- [ ] PM Dashboard overlay with comparison table
- [ ] Best-in-class metric highlighting
- [ ] Bar chart metric visualization
- [ ] Product recommendation generation based on metrics
- [ ] AlgorithmExplainer modal (how each planner works, PM-accessible language)
- [ ] Scenario analysis with investment recommendations

### Phase 6: Polish + Documentation
- [ ] Loading animation (staggered panel fade-in)
- [ ] Path hover interaction — brighten hovered path, dim others
- [ ] Micro-interactions (hover effects, placement ring animation)
- [ ] Responsive design (tablet, mobile layouts)
- [ ] Keyboard shortcuts (R=reset, Space=run, 1-4=scenario, Delete=remove)
- [ ] Follow ego camera mode (camera tracks ego vehicle during simulation)
- [ ] README with screenshots, architecture, learning journey
- [ ] Deploy to Vercel

---

## Known Issues
- Paths can cut through building corners after smoothing — need road-constrained smoothing
- Web workers fall back to main thread silently
- Canvas cursor doesn't always update immediately when switching interaction modes
- NPC driving behavior is basic — no proper lane tracking, turns are heading-interpolated
