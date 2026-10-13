import { CityConfig } from '../config';
import { Rng } from '../engine/rng';
import { CityModel, CityBuilding, CityIntersection, LandUse } from './types';

/**
 * Generate the physical city: grid geometry, zoned buildings with heights.
 * Deterministic for a given config (uses cfg.seed).
 *
 * Zoning: commercial/office core in the center, residential periphery,
 * parks and civic sprinkled in between — so commute demand has structure.
 */
export function generateCityModel(cfg: CityConfig): CityModel {
  const { rows, cols, blockWidth, blockHeight, roadWidth } = cfg;
  const rng = new Rng(cfg.seed ^ 0x5151);

  const totalWidth = cols * blockWidth + (cols + 1) * roadWidth;
  const totalHeight = rows * blockHeight + (rows + 1) * roadWidth;
  const originX = -totalWidth / 2;
  const originY = -totalHeight / 2;

  const vRoadX: number[] = [];
  for (let j = 0; j <= cols; j++) vRoadX.push(originX + j * (blockWidth + roadWidth) + roadWidth / 2);
  const hRoadY: number[] = [];
  for (let i = 0; i <= rows; i++) hRoadY.push(originY + i * (blockHeight + roadWidth) + roadWidth / 2);

  const intersections: CityIntersection[] = [];
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j <= cols; j++) {
      intersections.push({
        id: i * (cols + 1) + j,
        row: i, col: j,
        x: vRoadX[j], y: hRoadY[i],
        size: roadWidth,
      });
    }
  }

  const buildings: CityBuilding[] = [];
  let bid = 0;
  const cR = (rows - 1) / 2;
  const cC = (cols - 1) / 2;
  const maxDist = Math.hypot(cR, cC) || 1;

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      // Normalized distance from city center: 0 core -> 1 edge.
      const d = Math.hypot(i - cR, j - cC) / maxDist;
      const zone = pickBlockZone(d, rng);

      const sidewalk = 2.5;
      const left = originX + (j + 1) * roadWidth + j * blockWidth + sidewalk;
      const top = originY + (i + 1) * roadWidth + i * blockHeight + sidewalk;
      const w = blockWidth - sidewalk * 2;
      const h = blockHeight - sidewalk * 2;

      if (zone === 'park') {
        // One flat slab marks the park footprint (rendered as greenery).
        buildings.push({
          id: bid++, x: left + w / 2, y: top + h / 2,
          width: w, depth: h, height: 0.5, landUse: 'park',
          blockRow: i, blockCol: j,
        });
        continue;
      }

      // Subdivide block into 1/2/4 buildings.
      const split = rng.next();
      const gap = 2;
      const cells: Array<{ x: number; y: number; w: number; h: number }> = [];
      if (split < 0.25) {
        cells.push({ x: left, y: top, w, h });
      } else if (split < 0.6) {
        const hw = (w - gap) / 2;
        cells.push({ x: left, y: top, w: hw, h });
        cells.push({ x: left + hw + gap, y: top, w: hw, h });
      } else {
        const hw = (w - gap) / 2, hh = (h - gap) / 2;
        for (let bi = 0; bi < 2; bi++)
          for (let bj = 0; bj < 2; bj++)
            cells.push({ x: left + bj * (hw + gap), y: top + bi * (hh + gap), w: hw, h: hh });
      }

      for (const c of cells) {
        // Mostly the block zone, occasionally mixed-in commercial at street level areas.
        const use: LandUse = rng.next() < 0.85 ? zone : (zone === 'residential' ? 'commercial' : 'residential');
        buildings.push({
          id: bid++,
          x: c.x + c.w / 2, y: c.y + c.h / 2,
          width: c.w, depth: c.h,
          height: buildingHeight(use, d, rng),
          landUse: use,
          blockRow: i, blockCol: j,
        });
      }
    }
  }

  return {
    rows, cols, blockWidth, blockHeight, roadWidth,
    lanesPerDirection: cfg.lanesPerDirection,
    laneWidth: cfg.laneWidth,
    originX, originY, totalWidth, totalHeight,
    intersections, buildings, vRoadX, hRoadY,
  };
}

function pickBlockZone(d: number, rng: Rng): LandUse {
  // Core: offices + commercial. Mid ring: mixed. Periphery: residential.
  let weights: Record<LandUse, number>;
  if (d < 0.3) {
    weights = { office: 4, commercial: 3.5, residential: 1.5, civic: 1, park: 0.5 };
  } else if (d < 0.6) {
    weights = { office: 2, commercial: 3, residential: 4, civic: 0.7, park: 1 };
  } else {
    weights = { office: 0.3, commercial: 1.2, residential: 7, civic: 0.4, park: 1.2 };
  }
  const keys = Object.keys(weights) as LandUse[];
  return keys[rng.weighted(keys.map(k => weights[k]))];
}

function buildingHeight(use: LandUse, d: number, rng: Rng): number {
  const core = 1 - d; // taller toward center
  switch (use) {
    case 'office': return 24 + core * 60 + rng.next() * 30;
    case 'commercial': return 10 + core * 25 + rng.next() * 12;
    case 'civic': return 12 + rng.next() * 10;
    case 'residential': return 8 + core * 14 + rng.next() * 10;
    case 'park': return 0.5;
  }
}
