// Temporary debug harness: runs all four planners on the city scenario
// exactly as ControlBar does. Run with: npx tsx scripts/debugPlanners.ts
import { createCityScenario } from '../src/scenarios/CityScenario';
import { cityToRoadRects } from '../src/city/CityGenerator';
import { runAStar } from '../src/planners/AStar';
import { runRRTStar } from '../src/planners/RRTStar';
import { runLatticePlanner } from '../src/planners/LatticePlanner';
import { runLearnedPlanner } from '../src/planners/LearnedPlanner';
import { PlannerConfig } from '../src/planners/types';

const { cityMap, scenario } = createCityScenario();
const roads = cityToRoadRects(cityMap);
const { ego, goal, obstacles, lanes, bounds } = scenario.setup;

const config: PlannerConfig = {
  start: { x: ego.x, y: ego.y, heading: ego.heading },
  goal,
  obstacles,
  lanes,
  bounds,
  resolution: 1.0,
  roads,
};

console.log('start', { x: ego.x, y: ego.y }, 'goal', { x: goal.x, y: goal.y });

const planners = [
  ['astar', runAStar],
  ['rrt', runRRTStar],
  ['lattice', runLatticePlanner],
  ['learned', runLearnedPlanner],
] as const;

for (const [name, fn] of planners) {
  const r = fn(config);
  const m = r.metrics;
  console.log(
    name.padEnd(8),
    'success:', m.success,
    'len:', m.pathLengthMeters.toFixed(1),
    'ms:', m.computeTimeMs.toFixed(0),
    'nodes:', m.nodesExplored,
    'safety:', m.safetyMarginMeters.toFixed(2),
    'smooth:', m.smoothness.toFixed(2),
  );
  if (name === 'lattice' && r.path.length > 0) {
    // sample every ~50th point to see where the path wanders
    const pts = r.path.filter((_, i) => i % 200 === 0).map(p => `(${p.x.toFixed(0)},${p.y.toFixed(0)})`);
    console.log('  lattice waypoints:', pts.join(' '));
  }
}
