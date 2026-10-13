export interface Point {
  x: number;
  y: number;
}

export interface PathPoint extends Point {
  heading: number;
  velocity: number;
  curvature: number;
}

export interface Vehicle {
  id: string;
  x: number;
  y: number;
  heading: number;
  width: number;
  length: number;
  type: 'ego' | 'obstacle' | 'dynamic';
  velocity?: number;
  trajectory?: Point[];
}

export interface Lane {
  id: string;
  points: Point[];
  width: number;
  type: 'solid' | 'dashed';
}

export interface PlannerResult {
  path: PathPoint[];
  metrics: {
    computeTimeMs: number;
    pathLengthMeters: number;
    smoothness: number;
    safetyMarginMeters: number;
    nodesExplored: number;
    success: boolean;
  };
  algorithm: string;
  color: string;
  explorationTree?: { from: Point; to: Point }[];
}

export interface RoadRect {
  x: number;      // center x
  y: number;      // center y
  hw: number;     // half width
  hh: number;     // half height
}

export interface PlannerConfig {
  start: { x: number; y: number; heading: number };
  goal: { x: number; y: number; heading: number };
  obstacles: Vehicle[];
  lanes: Lane[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  resolution: number;
  roads?: RoadRect[];  // if provided, points off-road are blocked
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  challenge: string;
  setup: {
    ego: Vehicle;
    goal: { x: number; y: number; heading: number };
    obstacles: Vehicle[];
    lanes: Lane[];
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
  };
  recommendedPlanners: string[];
  pmInsight: string;
}

export type PlannerAlgorithm = 'astar' | 'rrt' | 'lattice' | 'learned';

export interface SimulationState {
  vehicles: Vehicle[];
  ego: Vehicle | null;
  goal: { x: number; y: number; heading: number } | null;
  lanes: Lane[];
  plannerResults: PlannerResult[];
  isRunning: boolean;
  isAnimating: boolean;
  selectedId: string | null;
  activePlanners: PlannerAlgorithm[];
  currentScenario: string | null;
  animationProgress: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}
