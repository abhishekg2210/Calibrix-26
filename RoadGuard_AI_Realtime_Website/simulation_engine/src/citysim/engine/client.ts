import { CityConfig } from '../config';
import { WorkerInMsg, WorkerOutMsg, StaticScene, SnapshotMsg, StatsMsg } from './protocol';

/**
 * Main-thread handle to the sim worker. Buffers the last two snapshots and
 * interpolates agent poses for smooth 60fps rendering regardless of sim rate.
 */

export interface InterpolatedAgents {
  count: number;
  ids: Int32Array;
  /** [x, y, heading, speed] per agent (interpolated). */
  data: Float32Array;
  kinds: Uint8Array;
  signalPhases: Uint8Array;
  t: number;
  clockHour: number;
}

export class CitySimClient {
  private worker: Worker;
  scene: StaticScene | null = null;
  private prev: SnapshotMsg | null = null;
  private next: SnapshotMsg | null = null;
  private prevIndex = new Map<number, number>();
  latestStats: StatsMsg | null = null;
  /** Render-side sim clock, eased toward the newest snapshot. */
  private renderT = 0;
  private speed = 1;

  onReady: (() => void) | null = null;
  onStats: ((s: StatsMsg) => void) | null = null;

  // reusable output buffers
  private out: InterpolatedAgents = {
    count: 0,
    ids: new Int32Array(0),
    data: new Float32Array(0),
    kinds: new Uint8Array(0),
    signalPhases: new Uint8Array(0),
    t: 0,
    clockHour: 0,
  };

  constructor() {
    this.worker = new Worker(new URL('../workers/simWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerOutMsg>) => this.handle(ev.data);
  }

  private handle(msg: WorkerOutMsg) {
    switch (msg.type) {
      case 'ready':
        this.scene = msg.scene;
        this.onReady?.();
        break;
      case 'snapshot':
        if (this.next) {
          this.prev = this.next;
          this.prevIndex.clear();
          for (let i = 0; i < this.prev.count; i++) this.prevIndex.set(this.prev.ids[i], i);
        }
        this.next = msg;
        if (!this.prev) this.renderT = msg.t;
        break;
      case 'stats':
        this.latestStats = msg;
        this.onStats?.(msg);
        break;
    }
  }

  send(msg: WorkerInMsg) {
    this.worker.postMessage(msg);
  }

  init(cfg: CityConfig) {
    this.scene = null;
    this.prev = this.next = null;
    this.send({ type: 'init', cfg });
  }

  setSpeed(multiplier: number) {
    this.speed = multiplier;
    this.send({ type: 'setSpeed', multiplier });
  }

  dispose() {
    this.worker.terminate();
  }

  /**
   * Advance the render clock by realDt and return interpolated agent poses.
   * Agents present only in the newer snapshot appear at their new pose;
   * agents that despawned simply drop out.
   */
  sample(realDt: number): InterpolatedAgents | null {
    const next = this.next;
    if (!next) return null;
    const prev = this.prev;

    this.renderT += realDt * this.speed;
    // Stay inside the buffered window; if we fall behind (worker faster) snap forward.
    const minT = prev ? prev.t : next.t;
    if (this.renderT < minT) this.renderT = minT;
    if (this.renderT > next.t) this.renderT = next.t;

    const out = this.out;
    if (out.ids.length < next.count) {
      out.ids = new Int32Array(next.count + 256);
      out.data = new Float32Array((next.count + 256) * 4);
      out.kinds = new Uint8Array(next.count + 256);
    }
    out.count = next.count;
    out.kinds.set(next.kinds.subarray(0, next.count));
    out.ids.set(next.ids.subarray(0, next.count));
    out.signalPhases = next.signalPhases;
    out.t = this.renderT;
    out.clockHour = next.clockHour;

    const span = prev ? next.t - prev.t : 0;
    const alpha = span > 1e-6 ? (this.renderT - prev!.t) / span : 1;

    for (let i = 0; i < next.count; i++) {
      const id = next.ids[i];
      const ni = i * 4;
      const nx = next.data[ni], ny = next.data[ni + 1], nh = next.data[ni + 2], nv = next.data[ni + 3];
      const pi = prev ? this.prevIndex.get(id) : undefined;
      if (pi === undefined || alpha >= 1) {
        out.data[ni] = nx; out.data[ni + 1] = ny; out.data[ni + 2] = nh; out.data[ni + 3] = nv;
      } else {
        const pj = pi * 4;
        const px = prev!.data[pj], py = prev!.data[pj + 1], ph = prev!.data[pj + 2], pv = prev!.data[pj + 3];
        out.data[ni] = px + (nx - px) * alpha;
        out.data[ni + 1] = py + (ny - py) * alpha;
        out.data[ni + 2] = lerpAngle(ph, nh, alpha);
        out.data[ni + 3] = pv + (nv - pv) * alpha;
      }
    }
    return out;
  }
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}
