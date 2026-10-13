import { create } from 'zustand';
import {
  Vehicle,
  Lane,
  PlannerResult,
  PlannerAlgorithm,
  SimulationState,
} from '../planners/types';
import { CityMap } from '../city/types';
import { cityBuildingsToObstacles } from '../city/CityGenerator';
import { createCityScenario } from '../scenarios/CityScenario';
import { uid } from '../utils/performance';
import { SimMode } from '../simulation/SimEngine';

interface ViewState {
  offsetX: number;
  offsetY: number;
  zoom: number;
  viewMode: 'sim' | 'pm';
}

interface Store extends SimulationState, ViewState {
  cityMap: CityMap | null;
  simMode: SimMode;
  primaryPlanner: PlannerAlgorithm | null;

  // View controls
  setOffset: (x: number, y: number) => void;
  setZoom: (zoom: number) => void;
  setViewMode: (mode: 'sim' | 'pm') => void;

  // Simulation controls
  setEgo: (x: number, y: number, heading?: number) => void;
  setGoal: (x: number, y: number, heading?: number) => void;
  addObstacle: (x: number, y: number, heading?: number) => void;
  addDynamicObstacle: (x: number, y: number, heading: number, velocity: number, trajectory: { x: number; y: number }[]) => void;
  removeVehicle: (id: string) => void;
  updateVehicle: (id: string, updates: Partial<Vehicle>) => void;
  setSelected: (id: string | null) => void;
  addLane: (lane: Lane) => void;

  // Planner controls
  togglePlanner: (alg: PlannerAlgorithm) => void;
  setPrimaryPlanner: (alg: PlannerAlgorithm) => void;
  setPlannerResults: (results: PlannerResult[]) => void;
  setRunning: (running: boolean) => void;
  setAnimating: (animating: boolean) => void;
  setAnimationProgress: (progress: number) => void;
  setSimMode: (mode: SimMode) => void;

  // Scenario
  loadScenario: (scenario: {
    ego: Vehicle;
    goal: { x: number; y: number; heading: number };
    obstacles: Vehicle[];
    lanes: Lane[];
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
    id: string;
  }) => void;
  loadCityScenario: () => void;

  // Reset
  reset: () => void;
}

const DEFAULT_BOUNDS = { minX: -50, maxX: 50, minY: -30, maxY: 30 };

const initialState: SimulationState & ViewState & { cityMap: CityMap | null; simMode: SimMode; primaryPlanner: PlannerAlgorithm | null } = {
  vehicles: [],
  ego: null,
  goal: null,
  lanes: [],
  plannerResults: [],
  isRunning: false,
  isAnimating: false,
  selectedId: null,
  activePlanners: ['astar', 'rrt', 'lattice', 'learned'],
  currentScenario: null,
  animationProgress: 0,
  bounds: DEFAULT_BOUNDS,
  offsetX: 0,
  offsetY: 0,
  zoom: 5,
  viewMode: 'sim',
  cityMap: null,
  simMode: 'idle',
  primaryPlanner: 'astar',
};

export const useStore = create<Store>((set, get) => ({
  ...initialState,

  setOffset: (x, y) => set({ offsetX: x, offsetY: y }),
  setZoom: (zoom) => set({ zoom: Math.max(2, Math.min(80, zoom)) }),
  setViewMode: (mode) => set({ viewMode: mode }),

  setEgo: (x, y, heading = 0) => {
    const ego: Vehicle = {
      id: 'ego',
      x, y, heading,
      width: 2, length: 4.5,
      type: 'ego',
    };
    set({ ego });
  },

  setGoal: (x, y, heading = 0) => set({ goal: { x, y, heading } }),

  addObstacle: (x, y, heading = 0) => {
    const obstacle: Vehicle = {
      id: uid(),
      x, y, heading,
      width: 2, length: 4.5,
      type: 'obstacle',
    };
    set(s => ({ vehicles: [...s.vehicles, obstacle] }));
  },

  addDynamicObstacle: (x, y, heading, velocity, trajectory) => {
    const obstacle: Vehicle = {
      id: uid(),
      x, y, heading,
      width: 2, length: 4.5,
      type: 'dynamic',
      velocity,
      trajectory,
    };
    set(s => ({ vehicles: [...s.vehicles, obstacle] }));
  },

  removeVehicle: (id) => {
    const s = get();
    if (id === 'ego') {
      set({ ego: null, selectedId: null });
    } else {
      set({
        vehicles: s.vehicles.filter(v => v.id !== id),
        selectedId: s.selectedId === id ? null : s.selectedId,
      });
    }
  },

  updateVehicle: (id, updates) => {
    if (id === 'ego') {
      set(s => ({ ego: s.ego ? { ...s.ego, ...updates } : null }));
    } else {
      set(s => ({
        vehicles: s.vehicles.map(v => v.id === id ? { ...v, ...updates } : v),
      }));
    }
  },

  setSelected: (id) => set({ selectedId: id }),

  addLane: (lane) => set(s => ({ lanes: [...s.lanes, lane] })),

  togglePlanner: (alg) => set(s => ({
    activePlanners: s.activePlanners.includes(alg)
      ? s.activePlanners.filter(a => a !== alg)
      : [...s.activePlanners, alg],
  })),

  setPrimaryPlanner: (alg) => set({ primaryPlanner: alg }),

  setPlannerResults: (results) => set({ plannerResults: results }),
  setRunning: (running) => set({ isRunning: running }),
  setAnimating: (animating) => set({ isAnimating: animating }),
  setAnimationProgress: (progress) => set({ animationProgress: progress }),
  setSimMode: (mode) => set({ simMode: mode }),

  loadScenario: (scenario) => {
    set({
      ego: scenario.ego,
      goal: scenario.goal,
      vehicles: scenario.obstacles,
      lanes: scenario.lanes,
      bounds: scenario.bounds,
      currentScenario: scenario.id,
      plannerResults: [],
      isRunning: false,
      isAnimating: false,
      animationProgress: 0,
      selectedId: null,
      simMode: 'idle',
    });
  },

  loadCityScenario: () => {
    const { cityMap, scenario } = createCityScenario();
    const buildingObstacles = cityBuildingsToObstacles(cityMap.buildings);
    const allObstacles = [...scenario.setup.obstacles, ...buildingObstacles];

    set({
      cityMap,
      ego: scenario.setup.ego,
      goal: scenario.setup.goal,
      vehicles: allObstacles,
      lanes: scenario.setup.lanes,
      bounds: scenario.setup.bounds,
      currentScenario: scenario.id,
      plannerResults: [],
      isRunning: false,
      isAnimating: false,
      animationProgress: 0,
      selectedId: null,
      simMode: 'idle',
    });
  },

  reset: () => {
    const s = get();
    if (s.cityMap) {
      get().loadCityScenario();
    } else {
      set({
        ...initialState,
        zoom: s.zoom,
        offsetX: s.offsetX,
        offsetY: s.offsetY,
        activePlanners: s.activePlanners,
        primaryPlanner: s.primaryPlanner,
      });
    }
  },
}));
