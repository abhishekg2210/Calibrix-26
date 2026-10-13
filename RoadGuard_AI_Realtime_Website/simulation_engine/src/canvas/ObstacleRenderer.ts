import { Vehicle } from '../planners/types';
import { theme } from '../styles/theme';

/** Render safety buffer visualization around obstacles */
export function renderSafetyBuffer(
  ctx: CanvasRenderingContext2D,
  vehicle: Vehicle,
  zoom: number,
  buffer: number = 0.5
) {
  ctx.save();
  ctx.translate(vehicle.x * zoom, vehicle.y * zoom);
  ctx.rotate(vehicle.heading);

  const w = (vehicle.width + buffer * 2) * zoom;
  const l = (vehicle.length + buffer * 2) * zoom;

  ctx.strokeStyle = theme.colors.obstacle;
  ctx.globalAlpha = 0.15;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(-l / 2, -w / 2, l, w);
  ctx.setLineDash([]);

  ctx.restore();
}

/** Render collision warning when a path comes too close */
export function renderCollisionWarning(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  zoom: number,
  time: number
) {
  ctx.save();
  ctx.translate(x * zoom, y * zoom);

  const pulse = 0.5 + 0.5 * Math.sin(time * 4);

  ctx.strokeStyle = theme.colors.danger;
  ctx.globalAlpha = 0.3 + pulse * 0.3;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, 8 + pulse * 4, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = theme.colors.danger;
  ctx.globalAlpha = 0.6;
  ctx.font = 'bold 10px IBM Plex Mono';
  ctx.textAlign = 'center';
  ctx.fillText('!', 0, 4);

  ctx.restore();
}
