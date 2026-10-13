import { useEffect, useRef } from 'react';
import { theme } from '../../styles/theme';

interface Props {
  data: number[];
  /** Optional comparison series, drawn dimmer behind the live one. */
  baseline?: number[];
  width?: number;
  height?: number;
  color?: string;
  /** Fixed y-range; otherwise auto-scales to the data (incl. baseline). */
  min?: number;
  max?: number;
}

/** Tiny canvas sparkline, Q's Lab styled. */
export default function Sparkline({ data, baseline, width = 270, height = 36, color = theme.colors.accent, min, max }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    if (data.length < 2) return;

    let lo = min ?? Infinity, hi = max ?? -Infinity;
    if (min === undefined || max === undefined) {
      const scan = baseline ? [...data, ...baseline] : data;
      for (const v of scan) {
        if (min === undefined && v < lo) lo = v;
        if (max === undefined && v > hi) hi = v;
      }
    }
    if (hi - lo < 1e-6) hi = lo + 1;

    const plot = (series: number[], stroke: string, lw: number, fill: string | null) => {
      if (series.length < 2) return;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.beginPath();
      for (let i = 0; i < series.length; i++) {
        const x = (i / (series.length - 1)) * (width - 2) + 1;
        const y = height - 3 - ((series[i] - lo) / (hi - lo)) * (height - 6);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (fill) {
        ctx.lineTo(width - 1, height);
        ctx.lineTo(1, height);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
      }
    };

    if (baseline) plot(baseline, theme.colors.textMuted, 1, null);
    plot(data, color, 1.4, color + '22');
  }, [data, baseline, width, height, color, min, max]);

  return <canvas ref={ref} style={{ width, height, display: 'block' }} />;
}
