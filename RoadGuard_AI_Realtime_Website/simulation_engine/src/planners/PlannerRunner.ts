import { PlannerConfig, PlannerResult, PlannerAlgorithm, Vehicle, Lane, RoadRect } from './types';
import { runAStar } from './AStar';
import { runRRTStar } from './RRTStar';
import { runLatticePlanner } from './LatticePlanner';
import { runLearnedPlanner } from './LearnedPlanner';

type PlannerFn = (config: PlannerConfig) => PlannerResult;

const plannerFns: Record<PlannerAlgorithm, PlannerFn> = {
  astar: runAStar,
  rrt: runRRTStar,
  lattice: runLatticePlanner,
  learned: runLearnedPlanner,
};

function runInWorker(algorithm: PlannerAlgorithm, config: PlannerConfig): Promise<PlannerResult> {
  return new Promise((resolve) => {
    try {
      const worker = new Worker(
        new URL('../workers/plannerWorker.ts', import.meta.url),
        { type: 'module' }
      );

      const timeout = setTimeout(() => {
        worker.terminate();
        resolve(plannerFns[algorithm](config));
      }, 15000);

      worker.onmessage = (e: MessageEvent<PlannerResult>) => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(e.data);
      };

      worker.onerror = () => {
        clearTimeout(timeout);
        worker.terminate();
        resolve(plannerFns[algorithm](config));
      };

      worker.postMessage({ algorithm, config });
    } catch {
      resolve(plannerFns[algorithm](config));
    }
  });
}

export async function runPlanners(
  start: { x: number; y: number; heading: number },
  goal: { x: number; y: number; heading: number },
  obstacles: Vehicle[],
  lanes: Lane[],
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  activePlanners: PlannerAlgorithm[],
  roads?: RoadRect[]
): Promise<PlannerResult[]> {
  // Filter out building obstacles when we have road constraints
  // (road-awareness replaces building collision for path planning)
  const vehicleObstacles = roads
    ? obstacles.filter(o => !o.id.startsWith('bld-obs-'))
    : obstacles;

  const config: PlannerConfig = {
    start,
    goal,
    obstacles: vehicleObstacles,
    lanes,
    bounds,
    resolution: roads ? 1.0 : 0.5, // coarser resolution for city-scale navigation
    roads,
  };

  const promises = activePlanners.map(alg => runInWorker(alg, config));
  return Promise.all(promises);
}
