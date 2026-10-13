import { CitySim } from '../engine/sim';
import { SIM_DT, CityConfig } from '../config';
import { makePlan } from '../engine/signals';
import { WorkerInMsg, WorkerOutMsg, StaticScene, KIND_CAR, KIND_AV, KIND_PED, PED_ID_BASE } from '../engine/protocol';

/**
 * Sim worker: owns the CitySim, paces it against real time at the requested
 * speed multiplier, and streams snapshots + stats back to the main thread.
 */

let sim: CitySim | null = null;
let speed = 1;            // requested sim-seconds per real second (0 = paused)
let lastReal = 0;
let accumulator = 0;      // pending sim seconds
let lastStatsReal = 0;
let achievedSpeed = 1;
let timer: ReturnType<typeof setInterval> | null = null;

const FRAME_MS = 33;              // pacing interval
const MAX_TICK_MS_PER_FRAME = 24; // compute budget; speed degrades gracefully

function post(msg: WorkerOutMsg, transfer: Transferable[] = []) {
  (postMessage as (m: WorkerOutMsg, t?: Transferable[]) => void)(msg, transfer);
}

function buildScene(s: CitySim): StaticScene {
  return {
    model: s.model,
    segs: s.graph.segs.map(g => ({
      id: g.id, orientation: g.orientation, dir: g.dir,
      ax: g.ax, ay: g.ay, bx: g.bx, by: g.by,
      lanes: g.laneEdges.length, length: g.length,
      fromInter: g.fromInter, toInter: g.toInter,
    })),
  };
}

function sendSnapshot(s: CitySim) {
  const v = s.veh;
  const p = s.peds;
  const count = v.count + p.count;
  const ids = new Int32Array(count);
  const data = new Float32Array(count * 4);
  const kinds = new Uint8Array(count);
  let w = 0;
  for (let i = 0; i < v.highWater; i++) {
    if (!v.alive[i]) continue;
    ids[w] = i;
    data[w * 4] = v.x[i];
    data[w * 4 + 1] = v.y[i];
    data[w * 4 + 2] = v.heading[i];
    data[w * 4 + 3] = v.speed[i];
    kinds[w] = v.isAV[i] ? KIND_AV : KIND_CAR;
    w++;
  }
  for (let i = 0; i < p.highWater; i++) {
    if (!p.alive[i]) continue;
    ids[w] = PED_ID_BASE + i;
    data[w * 4] = p.x[i];
    data[w * 4 + 1] = p.y[i];
    data[w * 4 + 2] = p.heading[i];
    data[w * 4 + 3] = p.speed[i];
    kinds[w] = KIND_PED;
    w++;
  }
  const signalPhases = new Uint8Array(s.signals.current);
  post(
    {
      type: 'snapshot',
      t: s.t,
      clockHour: s.demand.clockHour(s.t),
      count, ids, data, kinds, signalPhases,
    },
    [ids.buffer, data.buffer, kinds.buffer, signalPhases.buffer],
  );
}

function sendStats(s: CitySim) {
  post({
    type: 'stats',
    stats: s.stats(),
    clockHour: s.demand.clockHour(s.t),
    segSpeeds: new Float32Array(s.segAvgSpeed),
    segDensity: new Float32Array(s.segDensity),
    interThroughput: new Int32Array(s.interThroughput),
    interQueue: new Int32Array(s.interQueue),
    blockPeds: new Int32Array(s.blockPeds),
    achievedSpeed,
  });
}

function frame() {
  if (!sim) return;
  const now = performance.now();
  const realDt = Math.min(0.25, (now - lastReal) / 1000);
  lastReal = now;
  accumulator += realDt * speed;

  const budgetEnd = now + MAX_TICK_MS_PER_FRAME;
  let ticked = false;
  let simAdvanced = 0;
  while (accumulator >= SIM_DT) {
    sim.tick();
    accumulator -= SIM_DT;
    simAdvanced += SIM_DT;
    ticked = true;
    if (performance.now() > budgetEnd) {
      // Out of budget: drop the backlog so we degrade speed, not latency.
      accumulator = 0;
      break;
    }
  }
  // EMA of what we actually achieved vs real time.
  if (realDt > 0) {
    achievedSpeed = achievedSpeed * 0.9 + (simAdvanced / realDt) * 0.1;
  }

  if (ticked) sendSnapshot(sim);
  if (now - lastStatsReal > 500) {
    lastStatsReal = now;
    sendStats(sim);
  }
}

function init(cfg: CityConfig) {
  if (timer !== null) clearInterval(timer);
  sim = new CitySim(cfg);
  speed = 1;
  accumulator = 0;
  achievedSpeed = 1;
  lastReal = performance.now();
  lastStatsReal = 0;
  post({ type: 'ready', scene: buildScene(sim) });
  sendSnapshot(sim);
  sendStats(sim);
  timer = setInterval(frame, FRAME_MS);
}

onmessage = (ev: MessageEvent<WorkerInMsg>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      init(msg.cfg);
      break;
    case 'setSpeed':
      speed = Math.max(0, Math.min(64, msg.multiplier));
      break;
    case 'setDemand':
      if (sim) sim.demandMultiplier = Math.max(0, Math.min(5, msg.multiplier));
      break;
    case 'setAvShare':
      if (sim) sim.avShare = Math.max(0, Math.min(0.5, msg.share));
      break;
    case 'setSegClosed':
      if (sim) {
        const seg = sim.graph.segs[msg.segId];
        if (seg) {
          for (const eid of seg.laneEdges) sim.graph.edges[eid].closed = msg.closed;
          if (msg.closed) sim.rerouteAroundClosures();
        }
      }
      break;
    case 'setSignalTiming':
      if (sim) {
        sim.cfg.signal = msg.timing;
        sim.signals.setGlobalPlan(makePlan(sim.cfg));
      }
      break;
  }
};
