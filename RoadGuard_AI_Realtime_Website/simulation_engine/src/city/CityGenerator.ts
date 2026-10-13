import { Lane, Vehicle, RoadRect } from '../planners/types';
import { CityLayout, CityMap, RoadSegment, Intersection, Building } from './types';

export function generateCity(layout: CityLayout): CityMap {
  const { blockWidth, blockHeight, roadWidth, lanesPerDirection, laneWidth, rows, cols } = layout;

  const totalWidth = cols * blockWidth + (cols + 1) * roadWidth;
  const totalHeight = rows * blockHeight + (rows + 1) * roadWidth;
  const originX = -totalWidth / 2;
  const originY = -totalHeight / 2;

  const roads: RoadSegment[] = [];
  const intersections: Intersection[] = [];
  const buildings: Building[] = [];
  const lanes: Lane[] = [];

  // Helper: get the center Y of the i-th horizontal road (0-indexed, top to bottom)
  const hRoadY = (i: number) => originY + i * (blockHeight + roadWidth) + roadWidth / 2;
  // Helper: get the center X of the j-th vertical road
  const vRoadX = (j: number) => originX + j * (blockWidth + roadWidth) + roadWidth / 2;

  // --- Generate horizontal roads ---
  for (let i = 0; i <= rows; i++) {
    const cy = hRoadY(i);
    roads.push({
      id: `hroad-${i}`,
      orientation: 'horizontal',
      start: { x: originX, y: cy },
      end: { x: originX + totalWidth, y: cy },
      width: roadWidth,
    });
  }

  // --- Generate vertical roads ---
  for (let j = 0; j <= cols; j++) {
    const cx = vRoadX(j);
    roads.push({
      id: `vroad-${j}`,
      orientation: 'vertical',
      start: { x: cx, y: originY },
      end: { x: cx, y: originY + totalHeight },
      width: roadWidth,
    });
  }

  // --- Generate intersections ---
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j <= cols; j++) {
      const cx = vRoadX(j);
      const cy = hRoadY(i);
      const phaseOffset = ((i + j) % 2) * 0.5; // alternating green wave

      intersections.push({
        id: `int-${i}-${j}`,
        center: { x: cx, y: cy },
        width: roadWidth,
        height: roadWidth,
        signal: {
          nsState: phaseOffset === 0 ? 'green' : 'red',
          ewState: phaseOffset === 0 ? 'red' : 'green',
          cycleTimeMs: 8000,
          phaseOffsetMs: phaseOffset * 8000,
        },
      });
    }
  }

  // --- Generate buildings ---
  const sidewalk = 1.5;
  const buildingGap = 1.2;

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      // Block bounds
      const blockLeft = originX + (j + 1) * roadWidth + j * blockWidth + sidewalk;
      const blockTop = originY + (i + 1) * roadWidth + i * blockHeight + sidewalk;
      const blockW = blockWidth - sidewalk * 2;
      const blockH = blockHeight - sidewalk * 2;

      // Seed from position for deterministic variation
      const seed = i * cols + j;

      // Split each block into 2-4 buildings
      if (seed % 3 === 0) {
        // Single large building
        buildings.push({
          id: `bld-${i}-${j}-0`,
          x: blockLeft + blockW / 2,
          y: blockTop + blockH / 2,
          width: blockW,
          height: blockH,
        });
      } else if (seed % 3 === 1) {
        // Two buildings side by side
        const halfW = (blockW - buildingGap) / 2;
        buildings.push({
          id: `bld-${i}-${j}-0`,
          x: blockLeft + halfW / 2,
          y: blockTop + blockH / 2,
          width: halfW,
          height: blockH,
        });
        buildings.push({
          id: `bld-${i}-${j}-1`,
          x: blockLeft + halfW + buildingGap + halfW / 2,
          y: blockTop + blockH / 2,
          width: halfW,
          height: blockH,
        });
      } else {
        // Four buildings (2x2 grid)
        const halfW = (blockW - buildingGap) / 2;
        const halfH = (blockH - buildingGap) / 2;
        for (let bi = 0; bi < 2; bi++) {
          for (let bj = 0; bj < 2; bj++) {
            buildings.push({
              id: `bld-${i}-${j}-${bi * 2 + bj}`,
              x: blockLeft + bj * (halfW + buildingGap) + halfW / 2,
              y: blockTop + bi * (halfH + buildingGap) + halfH / 2,
              width: halfW,
              height: halfH,
            });
          }
        }
      }
    }
  }

  // --- Generate lane markings ---
  const halfRoad = roadWidth / 2;

  // Horizontal road lanes
  for (let i = 0; i <= rows; i++) {
    const cy = hRoadY(i);
    const xStart = originX;
    const xEnd = originX + totalWidth;

    // Solid edge lines
    lanes.push({
      id: `hlane-${i}-top`,
      points: [{ x: xStart, y: cy - halfRoad }, { x: xEnd, y: cy - halfRoad }],
      width: roadWidth,
      type: 'solid',
    });
    lanes.push({
      id: `hlane-${i}-bot`,
      points: [{ x: xStart, y: cy + halfRoad }, { x: xEnd, y: cy + halfRoad }],
      width: roadWidth,
      type: 'solid',
    });

    // Center divider (double solid)
    lanes.push({
      id: `hlane-${i}-center`,
      points: [{ x: xStart, y: cy }, { x: xEnd, y: cy }],
      width: roadWidth,
      type: 'solid',
    });

    // Dashed lane dividers within each direction
    for (let l = 1; l < lanesPerDirection; l++) {
      const offset = l * laneWidth;
      lanes.push({
        id: `hlane-${i}-dash-top-${l}`,
        points: [{ x: xStart, y: cy - offset }, { x: xEnd, y: cy - offset }],
        width: roadWidth,
        type: 'dashed',
      });
      lanes.push({
        id: `hlane-${i}-dash-bot-${l}`,
        points: [{ x: xStart, y: cy + offset }, { x: xEnd, y: cy + offset }],
        width: roadWidth,
        type: 'dashed',
      });
    }
  }

  // Vertical road lanes
  for (let j = 0; j <= cols; j++) {
    const cx = vRoadX(j);
    const yStart = originY;
    const yEnd = originY + totalHeight;

    lanes.push({
      id: `vlane-${j}-left`,
      points: [{ x: cx - halfRoad, y: yStart }, { x: cx - halfRoad, y: yEnd }],
      width: roadWidth,
      type: 'solid',
    });
    lanes.push({
      id: `vlane-${j}-right`,
      points: [{ x: cx + halfRoad, y: yStart }, { x: cx + halfRoad, y: yEnd }],
      width: roadWidth,
      type: 'solid',
    });
    lanes.push({
      id: `vlane-${j}-center`,
      points: [{ x: cx, y: yStart }, { x: cx, y: yEnd }],
      width: roadWidth,
      type: 'solid',
    });

    for (let l = 1; l < lanesPerDirection; l++) {
      const offset = l * laneWidth;
      lanes.push({
        id: `vlane-${j}-dash-left-${l}`,
        points: [{ x: cx - offset, y: yStart }, { x: cx - offset, y: yEnd }],
        width: roadWidth,
        type: 'dashed',
      });
      lanes.push({
        id: `vlane-${j}-dash-right-${l}`,
        points: [{ x: cx + offset, y: yStart }, { x: cx + offset, y: yEnd }],
        width: roadWidth,
        type: 'dashed',
      });
    }
  }

  const margin = 5;
  const bounds = {
    minX: originX - margin,
    maxX: originX + totalWidth + margin,
    minY: originY - margin,
    maxY: originY + totalHeight + margin,
  };

  return { roads, intersections, buildings, lanes, bounds, layout };
}

/** Convert buildings to Vehicle obstacles for planner collision detection */
export function cityBuildingsToObstacles(buildings: Building[]): Vehicle[] {
  return buildings.map(b => ({
    id: `bld-obs-${b.id}`,
    x: b.x,
    y: b.y,
    heading: 0,
    width: b.height, // Vehicle width = building's Y dimension
    length: b.width, // Vehicle length = building's X dimension
    type: 'obstacle' as const,
  }));
}

/** Get the center of a specific lane on a road for vehicle placement.
 *  laneIndex: 0 = rightmost lane of the "positive" direction, etc.
 *  direction: 1 = positive direction (right/down), -1 = negative (left/up)
 */
export function getLaneCenter(
  roadCenter: number,
  laneWidth: number,
  lanesPerDirection: number,
  laneIndex: number,
  direction: 1 | -1
): number {
  // Lanes are arranged: [neg lanes | center | pos lanes]
  // Positive direction lanes are on the positive side of center
  const offset = (laneIndex + 0.5) * laneWidth;
  return roadCenter + direction * offset;
}

/** Generate road rectangles for planner road-awareness checks */
export function cityToRoadRects(cityMap: CityMap): RoadRect[] {
  const rects: RoadRect[] = [];

  for (const road of cityMap.roads) {
    if (road.orientation === 'horizontal') {
      const cx = (road.start.x + road.end.x) / 2;
      const cy = road.start.y;
      rects.push({
        x: cx,
        y: cy,
        hw: (road.end.x - road.start.x) / 2,
        hh: road.width / 2,
      });
    } else {
      const cx = road.start.x;
      const cy = (road.start.y + road.end.y) / 2;
      rects.push({
        x: cx,
        y: cy,
        hw: road.width / 2,
        hh: (road.end.y - road.start.y) / 2,
      });
    }
  }

  // Also include intersection boxes as drivable
  for (const int of cityMap.intersections) {
    rects.push({
      x: int.center.x,
      y: int.center.y,
      hw: int.width / 2,
      hh: int.height / 2,
    });
  }

  return rects;
}
