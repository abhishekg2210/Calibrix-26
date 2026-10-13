import { PlannerResult, Point } from '../planners/types';
import { theme } from '../styles/theme';

interface PathAnimation {
  result: PlannerResult;
  progress: number; // 0 to 1
  complete: boolean;
}

export class PathAnimator {
  private animations: Map<string, PathAnimation> = new Map();
  private drawSpeed = 60; // meters per second

  startAnimation(results: PlannerResult[]) {
    this.animations.clear();
    for (const result of results) {
      if (result.metrics.success) {
        this.animations.set(result.algorithm, {
          result,
          progress: 0,
          complete: false,
        });
      }
    }
  }

  update(deltaMs: number): boolean {
    let anyActive = false;
    for (const [, anim] of this.animations) {
      if (anim.complete) continue;
      anyActive = true;
      const pathLen = this.getPathLength(anim.result.path);
      const progressPerMs = this.drawSpeed / pathLen / 1000;
      anim.progress = Math.min(1, anim.progress + progressPerMs * deltaMs);
      if (anim.progress >= 1) anim.complete = true;
    }
    return anyActive;
  }

  isComplete(): boolean {
    for (const [, anim] of this.animations) {
      if (!anim.complete) return false;
    }
    return this.animations.size > 0;
  }

  clear() {
    this.animations.clear();
  }

  render(
    ctx: CanvasRenderingContext2D,
    zoom: number,
    hoveredAlgorithm: string | null
  ) {
    for (const [alg, anim] of this.animations) {
      this.renderPath(ctx, anim, zoom, hoveredAlgorithm, alg);
    }
  }

  /** Render completed paths (no animation) */
  renderStatic(
    ctx: CanvasRenderingContext2D,
    results: PlannerResult[],
    zoom: number,
    hoveredAlgorithm: string | null
  ) {
    for (const result of results) {
      if (!result.metrics.success || result.path.length < 2) continue;
      const anim: PathAnimation = { result, progress: 1, complete: true };
      this.renderPath(ctx, anim, zoom, hoveredAlgorithm, result.algorithm);
    }
  }

  private renderPath(
    ctx: CanvasRenderingContext2D,
    anim: PathAnimation,
    zoom: number,
    hoveredAlgorithm: string | null,
    algorithm: string
  ) {
    const { result, progress } = anim;
    const path = result.path;
    if (path.length < 2) return;

    const pointCount = Math.floor(path.length * progress);
    if (pointCount < 2) return;

    const dimmed = hoveredAlgorithm !== null && hoveredAlgorithm !== algorithm;

    ctx.save();

    // Draw exploration tree for RRT* (very subtle)
    if (result.explorationTree && result.explorationTree.length > 0) {
      ctx.strokeStyle = theme.colors.border;
      ctx.globalAlpha = dimmed ? 0.03 : 0.08;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (const edge of result.explorationTree) {
        ctx.moveTo(edge.from.x * zoom, edge.from.y * zoom);
        ctx.lineTo(edge.to.x * zoom, edge.to.y * zoom);
      }
      ctx.stroke();
    }

    // Main path line
    ctx.strokeStyle = result.color;
    ctx.globalAlpha = dimmed ? 0.2 : 0.85;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.beginPath();
    ctx.moveTo(path[0].x * zoom, path[0].y * zoom);
    for (let i = 1; i < pointCount; i++) {
      ctx.lineTo(path[i].x * zoom, path[i].y * zoom);
    }
    ctx.stroke();

    // Waypoint dots (only when not dimmed)
    if (!dimmed && anim.complete) {
      ctx.fillStyle = result.color;
      ctx.globalAlpha = 0.4;
      const step = Math.max(1, Math.floor(path.length / 30));
      for (let i = 0; i < path.length; i += step) {
        ctx.beginPath();
        ctx.arc(path[i].x * zoom, path[i].y * zoom, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Animated head (drawing in progress)
    if (!anim.complete && pointCount > 0) {
      const head = path[pointCount - 1];
      const hx = head.x * zoom;
      const hy = head.y * zoom;

      // Outer glow
      const gradient = ctx.createRadialGradient(hx, hy, 0, hx, hy, 10);
      gradient.addColorStop(0, result.color);
      gradient.addColorStop(1, 'transparent');
      ctx.fillStyle = gradient;
      ctx.globalAlpha = 0.15;
      ctx.beginPath();
      ctx.arc(hx, hy, 10, 0, Math.PI * 2);
      ctx.fill();

      // Bright center
      ctx.fillStyle = result.color;
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(hx, hy, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private getPathLength(path: Point[]): number {
    let len = 0;
    for (let i = 1; i < path.length; i++) {
      const dx = path[i].x - path[i - 1].x;
      const dy = path[i].y - path[i - 1].y;
      len += Math.sqrt(dx * dx + dy * dy);
    }
    return Math.max(len, 1);
  }
}
