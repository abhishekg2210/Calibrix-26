import { PlannerConfig, PlannerResult } from '../planners/types';
import { runAStar } from '../planners/AStar';
import { runRRTStar } from '../planners/RRTStar';
import { runLatticePlanner } from '../planners/LatticePlanner';
import { runLearnedPlanner } from '../planners/LearnedPlanner';

self.onmessage = (e: MessageEvent<{ algorithm: string; config: PlannerConfig }>) => {
  const { algorithm, config } = e.data;

  let result: PlannerResult;

  switch (algorithm) {
    case 'astar':
      result = runAStar(config);
      break;
    case 'rrt':
      result = runRRTStar(config);
      break;
    case 'lattice':
      result = runLatticePlanner(config);
      break;
    case 'learned':
      result = runLearnedPlanner(config);
      break;
    default:
      result = {
        path: [],
        metrics: { computeTimeMs: 0, pathLengthMeters: 0, smoothness: 0, safetyMarginMeters: 0, nodesExplored: 0, success: false },
        algorithm,
        color: '#ffffff',
      };
  }

  self.postMessage(result);
};
