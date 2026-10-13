import { CityMap } from '../city/types';
import { theme } from '../styles/theme';

const city = theme.colors.city;

/** Render road surfaces, intersection boxes, and buildings */
export function renderCityBase(
  ctx: CanvasRenderingContext2D,
  cityMap: CityMap,
  zoom: number
) {
  ctx.save();

  // --- Road surfaces ---
  ctx.fillStyle = city.roadSurface;
  for (const road of cityMap.roads) {
    if (road.orientation === 'horizontal') {
      const x = road.start.x * zoom;
      const y = (road.start.y - road.width / 2) * zoom;
      const w = (road.end.x - road.start.x) * zoom;
      const h = road.width * zoom;
      ctx.fillRect(x, y, w, h);
    } else {
      const x = (road.start.x - road.width / 2) * zoom;
      const y = road.start.y * zoom;
      const w = road.width * zoom;
      const h = (road.end.y - road.start.y) * zoom;
      ctx.fillRect(x, y, w, h);
    }
  }

  // --- Intersection boxes (slightly lighter) ---
  ctx.fillStyle = city.intersection;
  for (const int of cityMap.intersections) {
    const x = (int.center.x - int.width / 2) * zoom;
    const y = (int.center.y - int.height / 2) * zoom;
    ctx.fillRect(x, y, int.width * zoom, int.height * zoom);
  }

  // --- Buildings ---
  for (const bld of cityMap.buildings) {
    const x = (bld.x - bld.width / 2) * zoom;
    const y = (bld.y - bld.height / 2) * zoom;
    const w = bld.width * zoom;
    const h = bld.height * zoom;

    // Fill
    ctx.fillStyle = city.buildingFill;
    ctx.fillRect(x, y, w, h);

    // Border (only when zoomed enough to see it)
    if (zoom >= 6) {
      ctx.strokeStyle = city.buildingBorder;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    }
  }

  ctx.restore();
}

/** Render lane markings — solid edges, dashed dividers, crosswalks */
export function renderCityLanes(
  ctx: CanvasRenderingContext2D,
  cityMap: CityMap,
  zoom: number
) {
  ctx.save();

  const markingColor = city.laneMarking;

  for (const lane of cityMap.lanes) {
    if (lane.points.length < 2) continue;

    ctx.strokeStyle = markingColor;

    if (lane.type === 'solid') {
      // Center dividers are thicker
      const isCenter = lane.id.includes('-center');
      ctx.globalAlpha = isCenter ? 0.3 : 0.2;
      ctx.lineWidth = isCenter ? 1.5 : 1;
      ctx.setLineDash([]);
    } else {
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 1;
      // Skip dashed lines when zoomed too far out
      if (zoom < 8) {
        continue;
      }
      ctx.setLineDash([6, 10]);
    }

    ctx.beginPath();
    ctx.moveTo(lane.points[0].x * zoom, lane.points[0].y * zoom);
    for (let i = 1; i < lane.points.length; i++) {
      ctx.lineTo(lane.points[i].x * zoom, lane.points[i].y * zoom);
    }
    ctx.stroke();
  }

  ctx.setLineDash([]);

  // --- Crosswalks at intersections ---
  if (zoom >= 10) {
    renderCrosswalks(ctx, cityMap, zoom);
  }

  ctx.restore();
}

function renderCrosswalks(
  ctx: CanvasRenderingContext2D,
  cityMap: CityMap,
  zoom: number
) {
  ctx.fillStyle = city.crosswalk;
  ctx.globalAlpha = 0.15;

  const stripeWidth = 0.6;
  const stripeGap = 0.6;
  const crosswalkDepth = 2;

  for (const int of cityMap.intersections) {
    const hw = int.width / 2;
    const hh = int.height / 2;

    // North crosswalk
    drawCrosswalkStripes(ctx, int.center.x, int.center.y - hh - crosswalkDepth / 2,
      int.width - 2, crosswalkDepth, 'horizontal', stripeWidth, stripeGap, zoom);
    // South crosswalk
    drawCrosswalkStripes(ctx, int.center.x, int.center.y + hh + crosswalkDepth / 2,
      int.width - 2, crosswalkDepth, 'horizontal', stripeWidth, stripeGap, zoom);
    // West crosswalk
    drawCrosswalkStripes(ctx, int.center.x - hw - crosswalkDepth / 2, int.center.y,
      crosswalkDepth, int.height - 2, 'vertical', stripeWidth, stripeGap, zoom);
    // East crosswalk
    drawCrosswalkStripes(ctx, int.center.x + hw + crosswalkDepth / 2, int.center.y,
      crosswalkDepth, int.height - 2, 'vertical', stripeWidth, stripeGap, zoom);
  }
}

function drawCrosswalkStripes(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  width: number, height: number,
  orientation: 'horizontal' | 'vertical',
  stripeW: number, gapW: number,
  zoom: number
) {
  if (orientation === 'horizontal') {
    const startX = cx - width / 2;
    let x = startX;
    while (x < cx + width / 2) {
      ctx.fillRect(x * zoom, (cy - height / 2) * zoom, stripeW * zoom, height * zoom);
      x += stripeW + gapW;
    }
  } else {
    const startY = cy - height / 2;
    let y = startY;
    while (y < cy + height / 2) {
      ctx.fillRect((cx - width / 2) * zoom, y * zoom, width * zoom, stripeW * zoom);
      y += stripeW + gapW;
    }
  }
}

/** Render traffic signals at intersection corners */
export function renderTrafficSignals(
  ctx: CanvasRenderingContext2D,
  cityMap: CityMap,
  zoom: number,
  timeMs: number
) {
  if (zoom < 6) return; // too small to see

  ctx.save();

  const signalRadius = Math.max(2, Math.min(4, zoom * 0.2));

  for (const int of cityMap.intersections) {
    // Determine current signal state based on time
    const cycle = int.signal.cycleTimeMs;
    const phase = ((timeMs + int.signal.phaseOffsetMs) % cycle) / cycle;

    let nsColor: string;
    let ewColor: string;

    if (phase < 0.4) {
      nsColor = theme.colors.success; // green
      ewColor = theme.colors.danger;  // red
    } else if (phase < 0.45) {
      nsColor = theme.colors.obstacle; // yellow
      ewColor = theme.colors.danger;   // red
    } else if (phase < 0.85) {
      nsColor = theme.colors.danger;   // red
      ewColor = theme.colors.success;  // green
    } else if (phase < 0.9) {
      nsColor = theme.colors.danger;   // red
      ewColor = theme.colors.obstacle; // yellow
    } else {
      nsColor = theme.colors.danger;
      ewColor = theme.colors.danger; // all red brief phase
    }

    const hw = int.width / 2;
    const hh = int.height / 2;
    const inset = 1.5;

    // NW corner — controls NS traffic (top side)
    drawSignalLight(ctx, (int.center.x - hw + inset) * zoom, (int.center.y - hh + inset) * zoom, signalRadius, nsColor);
    // NE corner — controls EW traffic (right side)
    drawSignalLight(ctx, (int.center.x + hw - inset) * zoom, (int.center.y - hh + inset) * zoom, signalRadius, ewColor);
    // SE corner — controls NS traffic (bottom side)
    drawSignalLight(ctx, (int.center.x + hw - inset) * zoom, (int.center.y + hh - inset) * zoom, signalRadius, nsColor);
    // SW corner — controls EW traffic (left side)
    drawSignalLight(ctx, (int.center.x - hw + inset) * zoom, (int.center.y + hh - inset) * zoom, signalRadius, ewColor);
  }

  ctx.restore();
}

function drawSignalLight(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  radius: number,
  color: string
) {
  // Dark housing
  ctx.fillStyle = '#0a0c12';
  ctx.beginPath();
  ctx.arc(x, y, radius + 1.5, 0, Math.PI * 2);
  ctx.fill();

  // Light
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  // Glow
  ctx.globalAlpha = 0.2;
  ctx.beginPath();
  ctx.arc(x, y, radius * 2.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.globalAlpha = 1;
}
