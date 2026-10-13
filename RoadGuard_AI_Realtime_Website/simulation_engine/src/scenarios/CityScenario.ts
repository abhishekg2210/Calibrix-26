import { Vehicle, Scenario } from '../planners/types';
import { CityMap } from '../city/types';
import { generateCity, getLaneCenter } from '../city/CityGenerator';

const CITY_LAYOUT = {
  blockWidth: 40,
  blockHeight: 30,
  roadWidth: 14,
  lanesPerDirection: 2,
  laneWidth: 3.5,
  rows: 6,
  cols: 10,
};

export function createCityScenario(): { cityMap: CityMap; scenario: Scenario } {
  const cityMap = generateCity(CITY_LAYOUT);
  const { roadWidth, laneWidth, lanesPerDirection, blockWidth, blockHeight, rows, cols } = CITY_LAYOUT;

  const totalWidth = cols * blockWidth + (cols + 1) * roadWidth;
  const totalHeight = rows * blockHeight + (rows + 1) * roadWidth;
  const originX = -totalWidth / 2;
  const originY = -totalHeight / 2;

  const hRoadY = (i: number) => originY + i * (blockHeight + roadWidth) + roadWidth / 2;
  const vRoadX = (j: number) => originX + j * (blockWidth + roadWidth) + roadWidth / 2;

  // Place ego on bottom-left area heading east
  const egoRoadY = hRoadY(rows - 1);
  const egoLaneY = getLaneCenter(egoRoadY, laneWidth, lanesPerDirection, 0, -1);
  const egoX = vRoadX(1) + roadWidth / 2 + 5;

  const ego: Vehicle = {
    id: 'ego',
    x: egoX,
    y: egoLaneY,
    heading: 0,
    width: 2,
    length: 4.5,
    type: 'ego',
  };

  // Place goal on upper-right area
  const goalRoadY = hRoadY(1);
  const goalLaneY = getLaneCenter(goalRoadY, laneWidth, lanesPerDirection, 0, -1);
  const goalX = vRoadX(cols - 1) - roadWidth / 2 - 5;

  const goal = { x: goalX, y: goalLaneY, heading: 0 };

  // Generate 25 NPC vehicles scattered across roads
  const obstacles: Vehicle[] = [];
  const rng = seedRandom(42);

  for (let n = 0; n < 25; n++) {
    const isHorizontal = rng() > 0.5;
    let x: number, y: number, heading: number;

    if (isHorizontal) {
      const roadIdx = Math.floor(rng() * (rows + 1));
      const roadCenterY = hRoadY(roadIdx);
      const dir = rng() > 0.5 ? -1 : 1;
      const laneIdx = Math.floor(rng() * lanesPerDirection);
      y = getLaneCenter(roadCenterY, laneWidth, lanesPerDirection, laneIdx, dir as 1 | -1);
      heading = dir === -1 ? 0 : Math.PI; // -1 = top lanes = heading east
      // Random position along road (avoid intersections)
      const col = Math.floor(rng() * cols);
      const blockStart = vRoadX(col) + roadWidth / 2 + 3;
      const blockEnd = vRoadX(col + 1) - roadWidth / 2 - 3;
      x = blockStart + rng() * (blockEnd - blockStart);
    } else {
      const roadIdx = Math.floor(rng() * (cols + 1));
      const roadCenterX = vRoadX(roadIdx);
      const dir = rng() > 0.5 ? -1 : 1;
      const laneIdx = Math.floor(rng() * lanesPerDirection);
      x = getLaneCenter(roadCenterX, laneWidth, lanesPerDirection, laneIdx, dir as 1 | -1);
      heading = dir === 1 ? Math.PI / 2 : -Math.PI / 2;
      const row = Math.floor(rng() * rows);
      const blockStart = hRoadY(row) + roadWidth / 2 + 3;
      const blockEnd = hRoadY(row + 1) - roadWidth / 2 - 3;
      y = blockStart + rng() * (blockEnd - blockStart);
    }

    // Check for overlap with ego or other obstacles
    const tooClose = obstacles.some(o =>
      Math.abs(o.x - x) < 6 && Math.abs(o.y - y) < 6
    ) || (Math.abs(ego.x - x) < 8 && Math.abs(ego.y - y) < 8);

    if (tooClose) continue;

    obstacles.push({
      id: `npc-${n}`,
      x, y, heading,
      width: 2,
      length: 4.5,
      type: 'dynamic',
      velocity: 11 + rng() * 5, // 25-35 mph
    });
  }

  const scenario: Scenario = {
    id: 'city-navigation',
    name: 'City Navigation',
    description: 'Navigate through a 10×6 city grid from southwest to northeast',
    challenge: 'Multi-turn navigation through city streets with live traffic',
    setup: {
      ego,
      goal,
      obstacles,
      lanes: cityMap.lanes,
      bounds: cityMap.bounds,
    },
    recommendedPlanners: ['astar', 'rrt', 'lattice', 'learned'],
    pmInsight: 'City navigation combines path planning with traffic awareness. The planner must find a route through the street grid while respecting road structure and avoiding other vehicles.',
  };

  return { cityMap, scenario };
}

// Simple seeded random for deterministic NPC placement
function seedRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return s / 2147483647;
  };
}
