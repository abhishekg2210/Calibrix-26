import { Lane } from '../planners/types';
import { theme } from '../styles/theme';

export function renderLane(
  ctx: CanvasRenderingContext2D,
  lane: Lane,
  zoom: number
) {
  if (lane.points.length < 2) return;

  ctx.save();
  ctx.strokeStyle = theme.colors.textMuted;
  ctx.lineWidth = 1;

  if (lane.type === 'dashed') {
    ctx.setLineDash([8, 12]);
    ctx.globalAlpha = 0.35;
  } else {
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.45;
  }

  ctx.beginPath();
  ctx.moveTo(lane.points[0].x * zoom, lane.points[0].y * zoom);
  for (let i = 1; i < lane.points.length; i++) {
    ctx.lineTo(lane.points[i].x * zoom, lane.points[i].y * zoom);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.restore();
}

export function renderAllLanes(
  ctx: CanvasRenderingContext2D,
  lanes: Lane[],
  zoom: number
) {
  for (const lane of lanes) {
    renderLane(ctx, lane, zoom);
  }
}
