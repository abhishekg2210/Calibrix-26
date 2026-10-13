# AV Planner Sim — Implementation Plan

## The Vision

A browser-based interactive autonomous vehicle path planning simulator. Users place vehicles, set destinations, add obstacles, and watch different planning algorithms solve the path in real time. Classical planners vs AI-based planners, side by side, with a Product Manager dashboard comparing their performance.

This is your NVIDIA AV Planning & Controls PM portfolio piece. It demonstrates domain knowledge acquisition, technical depth, product thinking, and the ability to communicate complex AV concepts visually.

**Design direction: Q's Lab.** 70% Apple, 30% Tron. Think: a classified research facility's planning interface — the kind of screen Q would pull up to brief Bond on a vehicle's autonomous capabilities. Dark backgrounds but not pure black — deep charcoal (#0c0e14) with structure and depth. Panels have subtle borders and just enough surface differentiation to feel like physical screens in a lab, not floating holograms. Typography is the star: clean, confident, information-dense. Glow effects are used sparingly and only on active/live elements (a running path, a selected vehicle) — everything else is matte, precise, and quiet. The grid exists but is barely visible — architectural reference lines, not a sci-fi floor. Color accents are cool and restrained: slate blue for structure, a single accent color (cyan or teal) for active state only, warm white for text. The overall feeling: serious, competent, expensive. Not a nightclub. A research lab where important decisions are made.

**Stack:** React 18 + TypeScript + Vite + HTML5 Canvas (no game engine, no Three.js — keep it lightweight and demonstrate raw capability)

---

## Design Language

### Color Palette

```
--base:          #0c0e14    /* Deep charcoal with a hint of navy — not pure black */
--surface:       #141620    /* Panel backgrounds — visible step up from base */
--surface-raised:#1a1d2a    /* Hovered or elevated panels */
--border:        #252a3a    /* Panel borders — subtle but structural */
--border-active: #4a9ead    /* Active/focused element borders — teal, not neon */
--accent:        #5bb8c9    /* Primary accent — muted teal. Used sparingly. */
--accent-active: #7ad4e4    /* Bright accent — ONLY on live/running elements */
--accent-subtle: rgba(91,184,201,0.08)  /* Barely-there accent wash for active panels */
--text:          #e8ecf1    /* Primary text — warm off-white */
--text-secondary:#8891a4    /* Secondary text, labels */
--text-muted:    #505868    /* Tertiary text, disabled state */
--path-a:        #5bb8c9    /* Planner A (A*) — teal */
--path-b:        #6ee7a0    /* Planner B (RRT*) — soft green */
--path-c:        #c084fc    /* Planner C (Lattice) — muted purple */
--path-d:        #e8ecf1    /* Planner D (Learned) — white */
--obstacle:      #e8a44a    /* Obstacles — warm amber, not neon */
--danger:        #e05c5c    /* Collision, emergency — muted red */
--success:       #5cb886    /* Optimal, safe — muted green */
```

### Typography

```
Display/Headings:  "Outfit" (Google Fonts) — geometric, clean, quietly confident
                   Weight 300 (light) for headings, 500 for labels, 600 for key metrics
Body/Data:         "IBM Plex Mono" — monospace for metrics, coordinates, data
                   Weight 400 for values, 500 for labels
Sizing:            Headings 14-18px (restrained, not huge). Labels 10-11px uppercase tracked.
                   Data values 13-14px. Nothing shouts. Information density > visual impact.
```

### Visual Rules

- **Subtle rounded corners:** 4px on panels, 2px on buttons. Not sharp (too aggressive) and not round (too soft). Clinical precision.
- **1px borders** on panels. Color: `--border` for default, `--border-active` for focused. Never brighter than `--accent`.
- **No glow on UI elements.** No box-shadows with color. Drop shadows are 0 0 12px rgba(0,0,0,0.4) — depth, not light.
- **Glow ONLY on the canvas** — path trails and the ego vehicle get a subtle bloom effect. The UI panels around the canvas are matte and still.
- **Grid lines** on the canvas are `--border` color at 0.15 opacity. Static. No pulsing. Just structural reference lines, like graph paper.
- **Path trails** are the one place you see life — they draw with a traveling head that has a soft glow (8px radius, 0.2 opacity). Once drawn, paths are solid lines with no glow.
- **Transitions:** 150ms ease-out for UI state changes. Snappy, not languid.
- **Minimal icons.** Geometric shapes for canvas elements. Small, tasteful UI icons (Lucide-style) acceptable in the control bar.
- **Uppercase tracking** on all labels: `letter-spacing: 0.08em; text-transform: uppercase; font-size: 10px`. This is the Q's lab signature — everything looks classified.

### Layout

```
┌─────────────────────────────────────────────────────────┐
│  AV PLANNER SIM                         [scenario ▾]    │  ← Header: 48px, glass panel
├──────────────────────────────────┬──────────────────────┤
│                                  │  PLANNER A           │
│                                  │  ────────────────    │
│                                  │  Algorithm: A*       │
│         SIMULATION CANVAS        │  Path length: 42.3m  │
│                                  │  Compute: 12ms       │
│         (full interactive        │  Smoothness: 0.87    │
│          planning visualization) │  Safety margin: 1.2m │
│                                  │                      │
│                                  ├──────────────────────┤
│                                  │  PLANNER B           │
│                                  │  ────────────────    │
│                                  │  Algorithm: RRT*     │
│                                  │  Path length: 44.1m  │
│                                  │  Compute: 28ms       │
│                                  │  Smoothness: 0.72    │
│                                  │  Safety margin: 1.8m │
├──────────────────────────────────┴──────────────────────┤
│  ▶ RUN   ↺ RESET   [+car] [+obstacle] [+lane]   PM VIEW│  ← Controls: 52px
└─────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
av-planner-sim/
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── canvas/
│   │   ├── SimulationCanvas.tsx         # Main canvas renderer
│   │   ├── GridRenderer.ts              # Background grid with subtle pulse
│   │   ├── VehicleRenderer.ts           # Draw vehicles (ego + obstacles)
│   │   ├── PathRenderer.ts              # Animate planned paths with glow trail
│   │   ├── ObstacleRenderer.ts          # Static and dynamic obstacles
│   │   ├── LaneRenderer.ts              # Road lanes and markings
│   │   └── InteractionHandler.ts        # Click to place, drag to move, scroll to zoom
│   ├── planners/
│   │   ├── types.ts                     # Shared types: Point, Path, PlannerResult
│   │   ├── AStar.ts                     # A* grid-based planner
│   │   ├── RRTStar.ts                   # RRT* sampling-based planner
│   │   ├── LatticePlanner.ts            # Lattice planner with motion primitives
│   │   ├── LearnedPlanner.ts            # Simplified AI/learned planner
│   │   └── PlannerRunner.ts             # Orchestrator: run planners and collect metrics
│   ├── scenarios/
│   │   ├── types.ts                     # Scenario configuration types
│   │   ├── highway.ts                   # Highway lane change scenario
│   │   ├── parking.ts                   # Parallel parking scenario
│   │   ├── intersection.ts              # 4-way intersection scenario
│   │   └── emergency.ts                 # Emergency obstacle avoidance
│   ├── components/
│   │   ├── Header.tsx                   # App header with scenario selector
│   │   ├── PlannerPanel.tsx             # Side panel showing planner metrics
│   │   ├── ControlBar.tsx               # Bottom controls (run, reset, add elements)
│   │   ├── PMDashboard.tsx              # Product Manager comparison view
│   │   ├── ScenarioSelector.tsx         # Dropdown/cards to pick scenario
│   │   ├── MetricCard.tsx               # Individual metric display
│   │   ├── AlgorithmExplainer.tsx        # Modal explaining how each planner works
│   │   └── GlowButton.tsx              # Styled button with Tron glow effect
│   ├── state/
│   │   ├── store.ts                     # Zustand store (lighter than Redux for this)
│   │   ├── simulationState.ts           # Vehicles, obstacles, paths, running state
│   │   └── uiState.ts                   # Active planner, selected scenario, view mode
│   ├── styles/
│   │   ├── theme.ts                     # Design tokens
│   │   ├── globals.css                  # Base styles, font imports
│   │   └── animations.ts               # Keyframe definitions for path drawing, glow pulse
│   └── utils/
│       ├── geometry.ts                  # Distance, angle, collision detection helpers
│       ├── interpolation.ts             # Path smoothing, cubic spline interpolation
│       └── performance.ts              # Timing utilities for planner benchmarking
├── public/
│   └── index.html
├── package.json
├── tsconfig.json
└── README.md
```

---

## Phase 1: Canvas + Grid + Interaction (Days 1-2)

### Goal
Build the simulation canvas with a glowing grid, vehicle placement, and basic interaction.

### Step 1: Project Setup

```bash
npm create vite@latest av-planner-sim -- --template react-ts
cd av-planner-sim
npm install zustand
npm run dev
```

Only dependency beyond React: Zustand for state management (lighter than Redux for a simulation app).

### Step 2: Canvas Setup (`src/canvas/SimulationCanvas.tsx`)

```typescript
// Full-screen HTML5 Canvas with 2D context
// Render loop using requestAnimationFrame
// Device pixel ratio handling for crisp rendering on retina displays
// Coordinate system: world coordinates (meters) mapped to screen pixels
// Default zoom: 1 meter = 20 pixels
// Pan: click and drag empty space
// Zoom: mouse wheel

// The canvas background is deep charcoal (#0c0e14) — not pure black
// Everything drawn ON the canvas uses the muted, structured palette
// The canvas should feel like a high-end planning display in a research lab
```

### Step 3: Grid Renderer (`src/canvas/GridRenderer.ts`)

```typescript
// Draw a subtle structural grid on the canvas — like engineering graph paper
// Grid lines: 1 meter spacing, color: --border at 0.15 opacity
// Major grid lines every 5 meters: 0.25 opacity
// Grid is STATIC — no pulsing, no animation. It's a reference, not a feature.
// When zoomed out, minor grid lines fade away — only major lines visible
// Axis labels at the edges: distance markers in meters, --text-muted color
// The grid says "precision instrument" not "sci-fi movie"
```

### Step 4: Vehicle Renderer (`src/canvas/VehicleRenderer.ts`)

```typescript
// Vehicles are drawn as clean rectangles — technical diagram style
// Ego vehicle: teal (--accent) outline, 1.5px border, filled with --accent at 0.08 opacity
// Obstacle vehicles: amber (--obstacle) outline, 1px, filled at 0.06 opacity
// No glow on vehicles in default state. Selected vehicle gets a 2px --border-active border.
// Direction shown by a small triangle at the front (same color as outline)
// Vehicle dimensions: ~4.5m × 2m (realistic car proportions)
// When a vehicle has a planned path, a faint dotted line extends ahead (0.2 opacity)
// Overall feel: like a top-down technical schematic, not a video game

// Vehicle data structure:
interface Vehicle {
  id: string;
  x: number;          // center position in meters
  y: number;
  heading: number;    // radians
  width: number;      // meters (typically 2)
  length: number;     // meters (typically 4.5)
  type: 'ego' | 'obstacle' | 'dynamic';
  velocity?: number;  // m/s for dynamic obstacles
}
```

### Step 5: Interaction Handler (`src/canvas/InteractionHandler.ts`)

```typescript
// Click on empty space: place the ego vehicle (first click) or destination (second click)
// Click on a vehicle: select it (show resize handles and rotation)
// Drag a vehicle: move it
// Right-click: add an obstacle vehicle at that position
// Mouse wheel: zoom in/out
// Middle click + drag: pan the viewport
// Keyboard shortcuts:
//   R: reset simulation
//   Space: run/pause planners
//   1-4: select scenario
//   Delete: remove selected element
```

### Step 6: Basic UI Shell

Build `Header.tsx` and `ControlBar.tsx` with the Q's Lab aesthetic:
- Header: "AV PLANNER SIM" in Outfit 300 weight, scenario selector dropdown, all uppercase tracked labels
- Control bar: Run, Reset, Add Car, Add Obstacle, Add Lane buttons
- All buttons: 4px border-radius, 1px `--border` border, `--surface` background, hover shifts to `--surface-raised` with `--border-active` border. No glow. Just a confident state change.
- Panels feel like screens in a research facility — structured, information-dense, matte

### Verification
- Deep charcoal canvas with subtle static grid lines
- Click to place a teal ego vehicle
- Click again to set a teal destination marker
- Right-click to place amber obstacle vehicles
- Drag vehicles to reposition them
- Zoom and pan work smoothly
- UI panels feel like a research instrument — structured, matte, professional

---

## Phase 2: Planning Algorithms (Days 3-5)

### Goal
Implement 3-4 planning algorithms that find paths from the ego vehicle to the destination while avoiding obstacles.

### Step 1: Shared Types (`src/planners/types.ts`)

```typescript
interface Point {
  x: number;
  y: number;
}

interface PathPoint extends Point {
  heading: number;    // radians
  velocity: number;   // m/s
  curvature: number;  // 1/meters
}

interface PlannerResult {
  path: PathPoint[];
  metrics: {
    computeTimeMs: number;
    pathLengthMeters: number;
    smoothness: number;        // 0-1, higher = smoother
    safetyMarginMeters: number; // min distance to any obstacle
    nodesExplored: number;
    success: boolean;
  };
  algorithm: string;
  color: string;              // rendering color for this planner's path
}

interface PlannerConfig {
  start: { x: number; y: number; heading: number };
  goal: { x: number; y: number; heading: number };
  obstacles: Vehicle[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  resolution: number;  // grid resolution in meters (for A*)
}
```

### Step 2: A* Planner (`src/planners/AStar.ts`)

```typescript
// Classic grid-based A* pathfinding
// 1. Discretize the world into a grid (resolution: 0.5m)
// 2. Mark cells occupied by obstacles (with safety buffer)
// 3. Find shortest path from start to goal using A* with Euclidean heuristic
// 4. Post-process: smooth the path using cubic spline interpolation
//
// Characteristics to demonstrate understanding:
// - Fast for simple environments
// - Resolution-dependent (finer grid = better path but slower)
// - Produces grid-aligned paths that need smoothing
// - Doesn't naturally handle vehicle kinematic constraints
//
// Color: cyan (#00e5ff)
```

### Step 3: RRT* Planner (`src/planners/RRTStar.ts`)

```typescript
// Rapidly-exploring Random Tree Star
// 1. Start with the start node as the only node in the tree
// 2. Randomly sample a point in the space
// 3. Find the nearest node in the tree to that sample
// 4. Extend from nearest node toward sample (step size: 1m)
// 5. Check if the new edge is collision-free
// 6. If yes, add to tree. RRT* also rewires nearby nodes for optimality.
// 7. Repeat until a node reaches the goal region
//
// Characteristics:
// - Probabilistically complete (will find a path if one exists)
// - Handles complex obstacle configurations well
// - Path quality improves with more iterations
// - Paths can be jagged — need smoothing
// - Non-deterministic (different result each run)
//
// Visual: show the tree growing in real-time (dim cyan branches)
// Final path highlighted in green (#00e676)
```

### Step 4: Lattice Planner (`src/planners/LatticePlanner.ts`)

```typescript
// Lattice-based planner using pre-computed motion primitives
// This is closer to how production AV planners work
//
// 1. Define motion primitives: short pre-computed trajectories
//    - Straight (multiple lengths)
//    - Left turn (multiple radii)
//    - Right turn (multiple radii)
//    - Lane change maneuver
// 2. From the start, expand the graph by applying each primitive
// 3. Check collision for each primitive
// 4. Use A* on the motion primitive graph to find optimal sequence
// 5. Result: a kinematically feasible path (respects turning radius)
//
// Characteristics:
// - Produces smooth, driveable paths natively
// - Computationally expensive (many primitives to check)
// - Quality depends on primitive set design
// - Most production-realistic of the three
//
// Color: magenta (#e040fb) — distinguishes the "advanced" planner
```

### Step 5: Learned Planner (Simplified) (`src/planners/LearnedPlanner.ts`)

```typescript
// This is a SIMPLIFIED representation of how AI-based planners work
// We're not training a neural network — we're demonstrating the concept
//
// Approach: use a cost-field-based planner where the "cost field"
// mimics what a learned model would produce
//
// 1. Generate a cost field across the space:
//    - Low cost near the goal
//    - High cost near obstacles (with learned-style soft boundaries)
//    - Medium cost for deviations from "natural" driving lines
//    - Cost influenced by road context (prefer lane centers)
// 2. Follow gradient descent through the cost field
// 3. Apply smoothing for kinematic feasibility
//
// The key insight this demonstrates: learned planners don't search
// a graph — they evaluate a continuous cost landscape shaped by
// training data. The "search" is implicit in the cost field.
//
// Color: white (#f0f4f8) — clean, elegant, "intelligent"
//
// Add a note in the UI: "Simplified representation of neural planner behavior"
```

### Step 6: Planner Runner (`src/planners/PlannerRunner.ts`)

```typescript
// Orchestrator that runs multiple planners on the same scenario
// 1. Takes the current simulation state (ego, goal, obstacles)
// 2. Runs each enabled planner
// 3. Times each planner precisely (performance.now())
// 4. Collects metrics from each
// 5. Returns array of PlannerResult

// Run planners in web workers if possible (non-blocking UI)
// If web workers are too complex, run sequentially with
// requestIdleCallback to keep the UI responsive
```

### Verification
- All 4 planners produce valid paths from start to goal
- Paths avoid obstacles
- Each planner's path is drawn in its assigned color
- Metrics (compute time, path length, smoothness, safety) are accurate
- A* is fastest but produces grid-aligned paths
- RRT* shows the tree growing before finding the path
- Lattice produces the smoothest, most car-like path
- Learned planner follows natural driving lines

---

## Phase 3: Path Visualization + Animation (Days 6-7)

### Goal
Make the paths look stunning. Tron-quality light trails.

### Step 1: Path Drawing Animation (`src/canvas/PathRenderer.ts`)

```typescript
// When a planner completes, its path draws itself smoothly
// NOT a Tron light-trail explosion — think: an engineering tool
// plotting a solution on a dark display
//
// Animation:
// 1. A small bright point (the "head") travels along the path at ~60m/s
// 2. Behind the head, the path line appears as a solid 2px line
// 3. The head has a SUBTLE bloom: 4px bright center, 10px soft glow at 0.15 opacity
// 4. Once the head reaches destination, path remains as a solid line (no glow, no pulse)
// 5. The drawn path is clean and static — the animation is the drawing, not the result
//
// Path rendering (after animation):
// - Main line: 2px, planner's assigned color at 0.85 opacity
// - No persistent glow. No pulse. Just a clean, confident line.
// - Waypoints shown as small 3px dots along the path
//
// When multiple planners shown: paths layer with slight transparency
// Hover over a path: brightens to full opacity, others dim to 0.3
// This creates a "technical comparison" feel, not a light show
```

### Step 2: Vehicle Animation

```typescript
// When "Run" is pressed and a planner succeeds:
// The ego vehicle DRIVES along the selected path
// - Smooth interpolation along the path points
// - Vehicle heading updates to match path tangent
// - Speed: configurable (default 5 m/s for visualization)
// - Wheels turn (tiny detail but adds realism)
// - Trail behind the vehicle: fading cyan line showing where it's been
```

### Step 3: Obstacle Visualization

```typescript
// Static obstacles: amber rectangle, solid 1px border
// Dynamic obstacles: amber rectangle with a velocity arrow
// Safety buffer: dashed amber circle showing the planner's safety margin
// Collision zone: if a path comes too close, highlight in red with pulse
```

### Step 4: RRT* Tree Visualization

```typescript
// The RRT* tree is visually interesting — show it growing
// Each branch: very dim line in --border color at 0.1 opacity
// Branches appear with no animation — they're just there (instant render per iteration)
// The final path through the tree: planner's assigned color, solid line
// Toggle: show/hide the exploration tree (default: hidden — opt-in for the curious)
// When shown, the tree is quiet background texture, not a spectacle
// This visualization demonstrates WHY RRT* is slower but more thorough
```

### Verification
- Paths draw themselves with a clean traveling-head animation
- After drawing, paths are solid static lines — no persistent glow or pulse
- Multiple paths visible simultaneously with distinct muted colors
- Vehicle drives along the selected path smoothly
- RRT* tree visualization available as an opt-in toggle
- Everything runs at 60fps
- The visual effect is refined and professional — Q's lab, not a rave

---

## Phase 4: Scenarios (Days 8-9)

### Goal
Pre-built scenarios that demonstrate different planning challenges.

### Step 1: Scenario System (`src/scenarios/types.ts`)

```typescript
interface Scenario {
  id: string;
  name: string;
  description: string;
  challenge: string;          // what planning challenge this demonstrates
  setup: {
    ego: Vehicle;
    goal: { x: number; y: number; heading: number };
    obstacles: Vehicle[];
    lanes: Lane[];            // road lane markings
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
  };
  recommendedPlanners: string[];
  pmInsight: string;          // product manager perspective on this scenario
}
```

### Step 2: Highway Lane Change (`src/scenarios/highway.ts`)

```typescript
// 3-lane highway with traffic
// Ego vehicle in lane 1, needs to reach lane 3
// Other vehicles at various speeds in lanes 2 and 3
// Challenge: find a gap in traffic and execute a smooth lane change
//
// PM insight: "Highway lane changes are the most common AV maneuver.
// The planner must balance safety (large gaps) with efficiency (don't
// wait too long). Classical planners handle this well; AI planners
// can learn to mimic human-like lane change behavior."
//
// Road markings: dashed lane lines, shoulder lines
// Traffic: 3-5 vehicles at varying speeds
```

### Step 3: Parallel Parking (`src/scenarios/parking.ts`)

```typescript
// Parallel parking spot between two parked cars
// Tight space: only 1.5× car length available
// Challenge: multi-point turn maneuver with tight clearances
//
// PM insight: "Parking is harder than driving for planners because
// it requires reverse motion, tight clearance tolerance, and
// multi-step maneuvers. Specialized parking planners exist for this
// reason — general driving planners often struggle in tight spaces."
//
// Parked cars as obstacles, curb line, parking space markers
```

### Step 4: Intersection (`src/scenarios/intersection.ts`)

```typescript
// 4-way intersection with stop signs
// Ego approaching from south, needs to turn left
// Other vehicles approaching from east and west
// Challenge: navigate intersection with right-of-way rules
//
// PM insight: "Intersections combine path planning with behavioral
// prediction. The planner needs to predict what other vehicles will
// do and plan accordingly. This is where AI planners shine — they
// can learn interaction patterns from data."
//
// Road markings: stop lines, crosswalks, lane markings
// Cross traffic: 2-3 vehicles with trajectories
```

### Step 5: Emergency Avoidance (`src/scenarios/emergency.ts`)

```typescript
// Ego vehicle driving straight at moderate speed
// Suddenly: obstacle appears in path (simulated pedestrian or debris)
// Challenge: immediate re-plan around obstacle
// Time constraint: planner must complete in < 100ms
//
// PM insight: "Emergency scenarios test planner latency. A planner
// that produces beautiful paths in 500ms is useless when a pedestrian
// steps into the road. This is why production AV systems run planners
// at high frequency (10-20 Hz) and why compute budget matters."
//
// Trigger: obstacle spawns 15m ahead after pressing Run
// Show replanning animation: old path fades, new path draws
```

### Verification
- All 4 scenarios load with pre-configured setups
- Scenario selector in header switches between them
- Each scenario demonstrates a distinct planning challenge
- PM insights are displayed in the UI for each scenario
- Planners produce visually different results per scenario

---

## Phase 5: PM Dashboard + Comparison View (Days 10-12)

### Goal
Build the "Product Manager View" — the layer that transforms this from an engineering demo into a product thinking showcase.

### Step 1: PM Dashboard (`src/components/PMDashboard.tsx`)

```typescript
// Toggle between "SIM VIEW" and "PM VIEW" in the control bar
// PM View is a full-screen overlay with comparison analytics
//
// Layout:
// ┌────────────────────────────────────────────────────────┐
// │  PLANNER COMPARISON — [scenario name]                  │
// ├────────────┬────────────┬────────────┬────────────────┤
// │            │  A*        │  RRT*      │  LATTICE       │
// ├────────────┼────────────┼────────────┼────────────────┤
// │ Path length│  42.3m     │  44.1m     │  43.8m         │
// │ Compute    │  12ms ●    │  89ms      │  156ms         │
// │ Smoothness │  0.65      │  0.72      │  0.94 ●        │
// │ Safety     │  0.8m      │  1.8m ●    │  1.2m          │
// │ Feasible?  │  Partial   │  Yes       │  Yes ●         │
// │ Verdict    │  Fast but  │  Thorough  │  Production    │
// │            │  rough     │  but slow  │  ready         │
// └────────────┴────────────┴────────────┴────────────────┘
//
// ● = best in class for that metric (highlighted in green)
//
// Below the table: a "Product Recommendation" section
// "For this scenario, the Lattice Planner is recommended because..."
// This is generated based on the metrics — demonstrates product judgment
```

### Step 2: Metric Visualization

```typescript
// Bar charts comparing planners (horizontal bars, Tron-styled)
// Each metric gets a bar chart row:
//   Planner A: ████████░░ 42.3m
//   Planner B: █████████░ 44.1m
//   Planner C: ████████░░ 43.8m
// Bars use each planner's color
// Best value is highlighted with a glow
```

### Step 3: Algorithm Explainer (`src/components/AlgorithmExplainer.tsx`)

```typescript
// Click on any planner name to see a modal explaining how it works
// Simple, PM-accessible language — not academic papers
// Include:
//   - How it works (3-4 sentences)
//   - When to use it
//   - Tradeoffs
//   - Real-world usage (which AV companies use this approach)
// This demonstrates you can communicate technical concepts to stakeholders
```

### Step 4: Scenario Analysis

```typescript
// For each scenario, generate a brief analysis:
// "In the parking scenario, classical planners struggle because..."
// "The highway scenario favors planners that can handle dynamic obstacles..."
// This is the PM analysis layer — you're not just showing algorithms,
// you're explaining which problems they solve and which they don't.
//
// Include a "Recommendation" for each scenario:
// "Invest in: Lattice planners for parking (highest smoothness + feasibility)"
// "Invest in: AI planners for intersections (best at handling uncertainty)"
// This mimics the actual job: deciding where to invest R&D resources
```

### Verification
- PM Dashboard shows comparison table for all planners
- Best-in-class metrics are highlighted
- Product recommendation is generated based on data
- Algorithm explainers are clear and accessible
- Scenario analysis demonstrates product thinking
- The PM View alone could be presented in an interview

---

## Phase 6: Polish + Documentation (Days 13-14)

### Step 1: Loading Animation

```typescript
// On first load: deep charcoal screen, then content fades in cleanly
// No dramatic grid-drawing animation — that's too Tron
// Instead: panels fade in with a staggered 100ms delay each (top → left → right → bottom)
// "AV PLANNER SIM" appears immediately (no character-by-character — too theatrical)
// Scenario 1 auto-loads after 600ms
// Total load: under 1 second. Respect the user's time. Q doesn't do fanfare.
```

### Step 2: Micro-interactions

```typescript
// Hover over a planner's path: path brightens, others dim — clean transition
// Hover over a metric: tooltip appears (no delay, 150ms fade-in)
// Button hover: background shifts from --surface to --surface-raised, border to --border-active
// Scenario switch: crossfade (200ms). No drama.
// Vehicle placement: small ring animation at placement point (expands from 0 to 12px, fades out)
// Selected element: 2px --border-active border replaces default 1px border. That's it.
// RULE: if you're debating whether an animation is too much, remove it.
```

### Step 3: Responsive Design

```typescript
// Full-screen desktop experience (primary target)
// Tablet: canvas takes full width, panels stack below
// Mobile: simplified view — canvas + scenario selector + run button only
// PM Dashboard adapts to mobile with stacked cards instead of table
```

### Step 4: README

Write a README that covers:
- What this project demonstrates (AV path planning fundamentals)
- The 4 planning algorithms and their tradeoffs
- The PM Dashboard and why it exists
- Design direction: Apple × Tron Legacy
- How to run locally
- Architecture decisions
- Your learning journey: "I built this to deeply understand AV planning and controls"
- Screenshots or GIF of the app in action

### Step 5: Deploy

```bash
npm run build
# Deploy to Vercel
vercel
```

### Step 6: Demo Video

Record a 90-second walkthrough:
1. App loads with the Tron animation
2. Select "Highway Lane Change" scenario
3. Run all planners — watch paths draw themselves
4. Compare: A* is fast but rough, Lattice is smooth but slow
5. Switch to PM View — show comparison dashboard
6. Switch to "Parallel Parking" — show how planners handle tight spaces
7. Voiceover: "I built this to learn AV path planning for a Product Manager role at NVIDIA"

---

## Architecture Decision Records

### ADR 1: Why a browser-based simulator?
A PM for AV planning doesn't need to build production C++ planners. But they DO need to understand how planners work, what metrics matter, and how to compare approaches. A browser-based visualizer lets me demonstrate understanding of the domain while showcasing product thinking (the PM Dashboard layer).

### ADR 2: Why implement planners from scratch instead of using a library?
Implementing A*, RRT*, and a Lattice planner from scratch forced me to understand the algorithms at a level deep enough to discuss tradeoffs intelligently. Using a library would give me results without understanding. The code IS the learning artifact.

### ADR 3: Why the PM Dashboard?
The NVIDIA role requires "identifying the right problems for teams to work on" and "influencing technical direction." The PM Dashboard layer shows I can analyze planner performance data and make product recommendations — which is literally the job.

### ADR 4: Why the Q's Lab aesthetic?
AV technology is precision engineering. The UI should feel like a classified research tool, not a sci-fi movie. The 70/30 Apple/Tron ratio means: Apple's restraint and typography confidence, with just enough edge lighting on the canvas to make path animations feel alive. A PM who ships a polished, tasteful visualization demonstrates attention to detail and product craft — qualities the posting values ("you care about the end product"). The restraint itself is a design decision: knowing when NOT to add effects shows more sophistication than making everything glow.

---

## How This Maps to the NVIDIA Role

| Job Requirement | How This Project Demonstrates It |
|---|---|
| "Deeply understand technical aspects of planning and controls" | Implemented 4 planners from scratch, can explain tradeoffs |
| "Identify the right problems to work on" | PM Dashboard analyzes which planner suits which scenario |
| "Convert requirements into competitive roadmaps" | Scenario analysis recommends where to invest |
| "Proactively identify areas of improvement" | Comparison metrics surface planner weaknesses |
| "Strong technical skills in motion planning" | Working implementations of A*, RRT*, Lattice, and learned planners |
| "Creative problem solver who handles ambiguity" | Built an unfamiliar domain project from scratch in 2 weeks |
| "Strive to learn new things" | The project IS the learning artifact |

---

## Getting Started

```bash
npm create vite@latest av-planner-sim -- --template react-ts
cd av-planner-sim
npm install zustand
npm run dev
```

Then tell Claude Code: "Read this plan and start Phase 1. The design direction is Q's Lab — 70% Apple restraint, 30% Tron edge. Deep charcoal backgrounds (#0c0e14), muted teal accent color, static grid lines, uppercase tracked labels, and glow ONLY on active canvas elements like path animations. Everything else is matte, precise, and quiet. Think: classified research facility planning display."
