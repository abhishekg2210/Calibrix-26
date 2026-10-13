import { Vehicle } from '../planners/types';
import { theme } from '../styles/theme';

// Muted obstacle car colors — deterministic from ID
const OBSTACLE_COLORS = [
  '#4a5568', // slate
  '#5a4a3a', // brown
  '#3a4a5a', // steel
  '#5a3a4a', // maroon
  '#3a5a4a', // forest
  '#4a4a5a', // indigo
];

function hashColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return OBSTACLE_COLORS[Math.abs(hash) % OBSTACLE_COLORS.length];
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  w: number, h: number,
  r: number
) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

export function renderVehicle(
  ctx: CanvasRenderingContext2D,
  vehicle: Vehicle,
  zoom: number,
  isSelected: boolean
) {
  const { x, y, heading, width, length, type } = vehicle;

  // Skip building-obstacles (rendered by CityRenderer)
  if (vehicle.id.startsWith('bld-obs-')) return;

  ctx.save();
  ctx.translate(x * zoom, y * zoom);
  ctx.rotate(heading);

  const w = width * zoom;
  const l = length * zoom;
  const r = Math.min(w, l) * 0.15; // corner radius

  // Colors by type
  let bodyColor: string;
  let fillAlpha: number;
  let strokeAlpha: number;

  switch (type) {
    case 'ego':
      bodyColor = theme.colors.accent;
      fillAlpha = 0.3;
      strokeAlpha = 1;
      break;
    case 'dynamic':
      bodyColor = hashColor(vehicle.id);
      fillAlpha = 0.6;
      strokeAlpha = 0.8;
      break;
    default:
      bodyColor = hashColor(vehicle.id);
      fillAlpha = 0.5;
      strokeAlpha = 0.7;
  }

  // --- Ego vehicle glow ---
  if (type === 'ego') {
    ctx.shadowColor = theme.colors.accent;
    ctx.shadowBlur = 8;
  }

  // --- Car body (rounded rectangle) ---
  ctx.globalAlpha = fillAlpha;
  ctx.fillStyle = bodyColor;
  roundRect(ctx, -l / 2, -w / 2, l, w, r);
  ctx.fill();

  // Outline
  ctx.globalAlpha = strokeAlpha;
  ctx.strokeStyle = bodyColor;
  ctx.lineWidth = type === 'ego' ? 1.5 : 1;
  roundRect(ctx, -l / 2, -w / 2, l, w, r);
  ctx.stroke();

  // Clear shadow for subsequent drawing
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  // --- Windshield (front 25% of car) ---
  const wsStart = l * 0.1;
  const wsEnd = l * 0.35;
  const wsInset = w * 0.12;
  const wsColor = type === 'ego'
    ? 'rgba(91,184,201,0.25)'
    : 'rgba(200,210,225,0.15)';

  ctx.fillStyle = wsColor;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.moveTo(wsStart, -w / 2 + wsInset);
  ctx.lineTo(wsEnd, -w / 2 + wsInset * 0.6);
  ctx.lineTo(wsEnd, w / 2 - wsInset * 0.6);
  ctx.lineTo(wsStart, w / 2 - wsInset);
  ctx.closePath();
  ctx.fill();

  // --- Rear window ---
  const rwStart = -l * 0.1;
  const rwEnd = -l * 0.28;
  ctx.fillStyle = wsColor;
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.moveTo(rwStart, -w / 2 + wsInset);
  ctx.lineTo(rwEnd, -w / 2 + wsInset * 0.8);
  ctx.lineTo(rwEnd, w / 2 - wsInset * 0.8);
  ctx.lineTo(rwStart, w / 2 - wsInset);
  ctx.closePath();
  ctx.fill();

  // --- Headlights (small bright rectangles at front) ---
  if (zoom >= 10) {
    const hlSize = Math.max(1.5, w * 0.08);
    const hlColor = type === 'ego' ? theme.colors.accentActive : '#d4d8e0';
    ctx.fillStyle = hlColor;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(l / 2 - hlSize * 0.5, -w / 2 + hlSize * 0.5, hlSize, hlSize);
    ctx.fillRect(l / 2 - hlSize * 0.5, w / 2 - hlSize * 1.5, hlSize, hlSize);

    // Taillights (red)
    ctx.fillStyle = '#e05c5c';
    ctx.globalAlpha = 0.5;
    ctx.fillRect(-l / 2, -w / 2 + hlSize * 0.5, hlSize * 0.7, hlSize);
    ctx.fillRect(-l / 2, w / 2 - hlSize * 1.5, hlSize * 0.7, hlSize);
  }

  // --- Selected highlight ---
  if (isSelected) {
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = theme.colors.borderActive;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    roundRect(ctx, -l / 2 - 3, -w / 2 - 3, l + 6, w + 6, r + 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // --- Velocity arrow for dynamic obstacles ---
  if (type === 'dynamic' && vehicle.velocity) {
    const arrowLen = vehicle.velocity * zoom * 0.5;
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = theme.colors.textSecondary;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(l / 2 + 4, 0);
    ctx.lineTo(l / 2 + 4 + arrowLen, 0);
    ctx.stroke();

    ctx.fillStyle = theme.colors.textSecondary;
    ctx.beginPath();
    ctx.moveTo(l / 2 + 4 + arrowLen, 0);
    ctx.lineTo(l / 2 + 4 + arrowLen - 5, -3);
    ctx.lineTo(l / 2 + 4 + arrowLen - 5, 3);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

export function renderGoal(
  ctx: CanvasRenderingContext2D,
  goal: { x: number; y: number; heading: number },
  zoom: number
) {
  const sx = goal.x * zoom;
  const sy = goal.y * zoom;

  ctx.save();
  ctx.translate(sx, sy);

  // Pulsing outer ring
  ctx.strokeStyle = theme.colors.accent;
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, 14, 0, Math.PI * 2);
  ctx.stroke();

  // Inner ring
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, 7, 0, Math.PI * 2);
  ctx.stroke();

  // Center dot
  ctx.fillStyle = theme.colors.accentActive;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(0, 0, 3, 0, Math.PI * 2);
  ctx.fill();

  // Heading indicator
  ctx.strokeStyle = theme.colors.accent;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(goal.heading) * 18, Math.sin(goal.heading) * 18);
  ctx.stroke();

  // Label
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = theme.colors.textSecondary;
  ctx.font = '9px IBM Plex Mono';
  ctx.textAlign = 'center';
  ctx.fillText('DEST', 0, -20);

  ctx.restore();
}
