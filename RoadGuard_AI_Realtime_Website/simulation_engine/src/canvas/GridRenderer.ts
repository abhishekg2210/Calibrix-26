import { theme } from '../styles/theme';

export function renderGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  offsetX: number,
  offsetY: number,
  zoom: number
) {
  const minorSpacing = 1; // 1 meter
  const majorSpacing = 5; // 5 meters

  // Calculate visible world bounds
  const worldLeft = -offsetX / zoom - width / (2 * zoom);
  const worldRight = -offsetX / zoom + width / (2 * zoom);
  const worldTop = -offsetY / zoom - height / (2 * zoom);
  const worldBottom = -offsetY / zoom + height / (2 * zoom);

  // Skip minor grid when zoomed out too far
  const drawMinor = zoom >= 10;

  ctx.save();

  // Minor grid lines
  if (drawMinor) {
    ctx.strokeStyle = theme.colors.border;
    ctx.globalAlpha = 0.15;
    ctx.lineWidth = 1;
    ctx.beginPath();

    const startX = Math.floor(worldLeft / minorSpacing) * minorSpacing;
    const startY = Math.floor(worldTop / minorSpacing) * minorSpacing;

    for (let x = startX; x <= worldRight; x += minorSpacing) {
      if (x % majorSpacing === 0) continue; // skip major lines
      const sx = width / 2 + (x + offsetX / zoom) * zoom;
      ctx.moveTo(Math.round(sx) + 0.5, 0);
      ctx.lineTo(Math.round(sx) + 0.5, height);
    }

    for (let y = startY; y <= worldBottom; y += minorSpacing) {
      if (y % majorSpacing === 0) continue;
      const sy = height / 2 + (y + offsetY / zoom) * zoom;
      ctx.moveTo(0, Math.round(sy) + 0.5);
      ctx.lineTo(width, Math.round(sy) + 0.5);
    }

    ctx.stroke();
  }

  // Major grid lines
  ctx.strokeStyle = theme.colors.border;
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 1;
  ctx.beginPath();

  const startMajorX = Math.floor(worldLeft / majorSpacing) * majorSpacing;
  const startMajorY = Math.floor(worldTop / majorSpacing) * majorSpacing;

  for (let x = startMajorX; x <= worldRight; x += majorSpacing) {
    const sx = width / 2 + (x + offsetX / zoom) * zoom;
    ctx.moveTo(Math.round(sx) + 0.5, 0);
    ctx.lineTo(Math.round(sx) + 0.5, height);
  }

  for (let y = startMajorY; y <= worldBottom; y += majorSpacing) {
    const sy = height / 2 + (y + offsetY / zoom) * zoom;
    ctx.moveTo(0, Math.round(sy) + 0.5);
    ctx.lineTo(width, Math.round(sy) + 0.5);
  }

  ctx.stroke();

  // Axis labels
  if (zoom >= 8) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = theme.colors.textMuted;
    ctx.font = '9px IBM Plex Mono';
    ctx.textAlign = 'center';

    for (let x = startMajorX; x <= worldRight; x += majorSpacing) {
      const sx = width / 2 + (x + offsetX / zoom) * zoom;
      if (sx > 30 && sx < width - 10) {
        ctx.fillText(`${x}m`, sx, height - 6);
      }
    }

    ctx.textAlign = 'left';
    for (let y = startMajorY; y <= worldBottom; y += majorSpacing) {
      const sy = height / 2 + (y + offsetY / zoom) * zoom;
      if (sy > 10 && sy < height - 20) {
        ctx.fillText(`${y}m`, 4, sy - 3);
      }
    }
  }

  ctx.restore();
}
