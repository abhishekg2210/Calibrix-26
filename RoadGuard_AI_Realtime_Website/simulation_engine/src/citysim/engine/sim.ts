import { CityConfig, SIM_DT } from '../config';
import { CityModel } from '../model/types';
import { generateCityModel } from '../model/generate';
import { buildLaneGraph, edgePointAt, LaneGraph, LaneEdge, TURN_RIGHT, TURN_STRAIGHT } from '../graph/laneGraph';
import { buildWalkGraph, WalkGraph } from '../graph/walkGraph';
import { Router } from './router';
import { SignalController } from './signals';
import { DemandEngine, TripRequest } from './demand';
import { VehicleState } from './state';
import { PedSim } from './peds';
import { Rng } from './rng';

/**
 * Headless city traffic simulation. Pure TypeScript — runs identically in a
 * web worker and in Node (tests). Fixed timestep, fully deterministic for a
 * given config.
 */

const VEH_LEN = 4.6;
const LOOKAHEAD_M = 70;
const SPAWN_CLEAR_M = 9;
const STOP_MARGIN = 0.6;
const ENTRY_ZONE_M = VEH_LEN + 2.5;
const ABANDON_TRIP_S = 1500;
const CONGESTION_UPDATE_S = 5;

// Why a vehicle is being held — drives stuck/reroute policy.
const STOP_NONE = 0;
const STOP_DEST = 1;
const STOP_SIGNAL = 2;     // legitimate wait, never reroute
const STOP_SPILLBACK = 3;  // gridlock candidate, reroute slowly
const STOP_LANECHANGE = 4; // can't find a merge gap, reroute quickly
const REROUTE_LANECHANGE_S = 8;
const REROUTE_GRIDLOCK_S = 60;

interface IdmParams { T: number; aMax: number; b: number; s0: number }
const HUMAN: IdmParams = { T: 1.3, aMax: 2.0, b: 2.6, s0: 2.0 };
const AV: IdmParams = { T: 0.8, aMax: 2.2, b: 2.4, s0: 1.6 };

export interface SimStats {
  t: number;
  activeVehicles: number;
  arrivals: number;
  abandoned: number;
  spawned: number;
  /** Mean travel-time / free-flow-time over completed trips (>= 1). */
  delayIndex: number;
  avgTripS: number;
  avgSpeed: number;
  activePeds: number;
  pedArrivals: number;
  waitingPeds: number;
  /** Fleet split: delay index per driver class (1 = free flow). */
  avDelayIndex: number;
  humanDelayIndex: number;
  avArrivals: number;
  activeAVs: number;
}

export class CitySim {
  readonly cfg: CityConfig;
  readonly model: CityModel;
  readonly graph: LaneGraph;
  readonly walkGraph: WalkGraph;
  readonly router: Router;
  readonly signals: SignalController;
  readonly demand: DemandEngine;
  readonly veh: VehicleState;
  readonly peds: PedSim;
  rng: Rng;

  t = 0; // sim seconds

  // runtime-adjustable (Experiments)
  demandMultiplier = 1;
  avShare: number;

  // per-vehicle driving variance
  private speedFactor: Float32Array;

  // per-edge occupancy, rebuilt each tick, sorted by pos ascending
  private occ: number[][];

  // metrics
  arrivals = 0;
  abandoned = 0;
  spawnedTotal = 0;
  private travelTimeSum = 0;
  private freeflowSum = 0;
  // per-class accumulators for fleet comparison
  private avTravelSum = 0;
  private avFreeflowSum = 0;
  avArrivals = 0;
  // per-segment speed accumulation for congestion-aware routing + heatmaps
  segSpeedSum: Float64Array;
  segSpeedCount: Int32Array;
  segAvgSpeed: Float32Array;     // EMA, m/s
  segDensity: Float32Array;      // vehicles per km of lane (sampled)
  interThroughput: Int32Array;   // vehicles entering each intersection (cumulative)
  interQueue: Int32Array;        // stopped vehicles queued per intersection (sampled)
  blockPeds: Int32Array;         // pedestrians per block (sampled)
  private lastCongestionUpdate = 0;

  private scratch = { x: 0, y: 0, heading: 0 };

  constructor(cfg: CityConfig) {
    this.cfg = cfg;
    this.rng = new Rng(cfg.seed);
    this.model = generateCityModel(cfg);
    this.graph = buildLaneGraph(this.model);
    this.router = new Router(this.graph);

    const nInter = this.model.intersections.length;
    const interRow = new Int32Array(nInter);
    const interCol = new Int32Array(nInter);
    for (const it of this.model.intersections) { interRow[it.id] = it.row; interCol[it.id] = it.col; }
    this.signals = new SignalController(cfg, nInter, interRow, interCol);

    this.demand = new DemandEngine(cfg, this.model, this.graph, this.rng.fork());
    this.veh = new VehicleState(cfg.maxVehicles);
    this.walkGraph = buildWalkGraph(this.model);
    this.peds = new PedSim(this.walkGraph, this.model, nInter, cfg.maxPedestrians, this.rng.fork());
    this.speedFactor = new Float32Array(cfg.maxVehicles).fill(1);
    this.avShare = cfg.avShare;

    this.occ = Array.from({ length: this.graph.edges.length }, () => []);
    const nSeg = this.graph.segs.length;
    this.segSpeedSum = new Float64Array(nSeg);
    this.segSpeedCount = new Int32Array(nSeg);
    this.segAvgSpeed = new Float32Array(nSeg).fill(13.4);
    this.segDensity = new Float32Array(nSeg);
    this.interThroughput = new Int32Array(nInter);
    this.interQueue = new Int32Array(nInter);
    this.blockPeds = new Int32Array(this.model.rows * this.model.cols);
  }

  /** Advance one fixed timestep. */
  tick(): void {
    const dt = SIM_DT;
    this.t += dt;

    this.signals.update(this.t);
    this.rebuildOccupancy();

    const { walks } = this.spawn(dt);
    for (const w of walks) this.peds.trySpawn(w, this.t);
    // Peds first so crosswalk occupancy is fresh for vehicle yield checks.
    this.peds.tick(dt, this.signals);
    this.updateVehicles(dt);
    this.opportunisticReroutes();
    this.updateCongestion();
  }

  /**
   * Navigation-app behavior: a small share of moving vehicles re-checks its
   * route against live congestion each second, spreading load off hotspots.
   */
  private opportunisticReroutes() {
    const v = this.veh;
    // ~2% of vehicles per 10 sim-seconds => 0.2%/s; ticks are 0.1s.
    const perTick = Math.max(1, Math.floor(v.count * 0.0002));
    for (let n = 0; n < perTick; n++) {
      const i = this.rng.int(v.highWater);
      if (!v.alive[i]) continue;
      const e = this.graph.edges[v.edge[i]];
      // Only mid-road, not in the box or at the destination edge.
      if (e.kind !== 0) continue;
      const route = v.routes[i]!;
      if (v.routeIdx[i] >= route.length - 2) continue;
      this.reroute(i);
    }
  }

  // ---------------------------------------------------------------- spawning

  private spawn(dt: number): { walks: TripRequest[] } {
    const { drives, walks } = this.demand.generate(this.t, dt, this.demandMultiplier, this.avShare);
    for (const req of drives) this.trySpawnVehicle(req);
    return { walks };
  }

  private trySpawnVehicle(req: TripRequest): boolean {
    // Cheap rejections before the (expensive) routing call.
    if (this.veh.count >= this.veh.cap) return false;
    const edges = this.graph.edges;
    if (edges[req.originEdge].closed) return false;

    // Entry zone must be clear.
    for (const other of this.occ[req.originEdge]) {
      if (Math.abs(this.veh.pos[other] - req.originPos) < SPAWN_CLEAR_M) return false;
    }

    const destSeg = edges[req.destEdge].segId;
    const goalLanes = destSeg >= 0 ? this.graph.segs[destSeg].laneEdges : [req.destEdge];
    const route = this.router.route(req.originEdge, goalLanes);
    if (!route || route.length === 0) return false;

    const slot = this.veh.acquire();
    if (slot < 0) return false;

    const v = this.veh;
    v.isAV[slot] = req.isAV ? 1 : 0;
    v.colorIdx[slot] = this.rng.int(8);
    v.edge[slot] = req.originEdge;
    v.pos[slot] = req.originPos;
    v.speed[slot] = edges[req.originEdge].speedLimit * 0.3;
    v.routeIdx[slot] = 0;
    v.routes[slot] = route;
    v.spawnT[slot] = this.t;
    v.lateral[slot] = 0;
    v.stuckS[slot] = 0;
    v.waitS[slot] = 0;
    this.speedFactor[slot] = req.isAV ? 1 : 0.9 + this.rng.next() * 0.2;

    // Destination stop point on whichever lane of the dest segment the route ends.
    const lastEdge = edges[route[route.length - 1]];
    const destPosOnFinal = lastEdge.id === req.destEdge || lastEdge.segId === destSeg
      ? Math.max(3, Math.min(lastEdge.length - 3, req.destPos))
      : lastEdge.length - 3;
    v.destPos[slot] = destPosOnFinal;

    // Free-flow estimate for the delay index. Parallel-lane steps cover the
    // same physical stretch as their predecessor — count each stretch once.
    let ff = 0;
    for (let i = 0; i < route.length; i++) {
      const e = edges[route[i]];
      if (i > 0) {
        const prev = edges[route[i - 1]];
        if (e.id === prev.leftEdge || e.id === prev.rightEdge) continue;
      }
      ff += e.length / e.speedLimit;
    }
    v.freeflowS[slot] = Math.max(1, ff);

    this.occInsert(req.originEdge, slot);
    this.spawnedTotal++;
    return true;
  }

  // ------------------------------------------------------------- occupancy

  private rebuildOccupancy() {
    for (const list of this.occ) list.length = 0;
    const v = this.veh;
    for (let i = 0; i < v.highWater; i++) {
      if (!v.alive[i]) continue;
      this.occ[v.edge[i]].push(i);
    }
    const pos = v.pos;
    for (const list of this.occ) {
      if (list.length > 1) list.sort((a, b) => (pos[a] - pos[b]) || (a - b));
    }
  }

  private occInsert(edgeId: number, slot: number) {
    const list = this.occ[edgeId];
    const pos = this.veh.pos;
    let i = list.length;
    while (i > 0 && pos[list[i - 1]] > pos[slot]) i--;
    list.splice(i, 0, slot);
  }

  private occRemove(edgeId: number, slot: number) {
    const list = this.occ[edgeId];
    const i = list.indexOf(slot);
    if (i >= 0) list.splice(i, 1);
  }

  // --------------------------------------------------------------- vehicles

  private updateVehicles(dt: number) {
    const v = this.veh;
    for (let i = 0; i < v.highWater; i++) {
      if (!v.alive[i]) continue;
      this.updateVehicle(i, dt);
    }
  }

  private updateVehicle(i: number, dt: number) {
    const v = this.veh;
    const edges = this.graph.edges;
    let e = edges[v.edge[i]];
    const route = v.routes[i]!;
    const params = v.isAV[i] ? AV : HUMAN;

    // Trip babysitting.
    if (this.t - v.spawnT[i] > ABANDON_TRIP_S) {
      this.despawn(i, false);
      return;
    }

    // Lane-change step pending?
    this.maybeExecuteLaneChange(i, e, route, params);
    e = edges[v.edge[i]];

    const speed = v.speed[i];
    const vMax = e.speedLimit * this.speedFactor[i];

    // --- constraints: collect the most restrictive IDM acceleration ---
    let acc = this.idmFree(speed, vMax, params);

    // Leader on current edge or ahead on route.
    const leader = this.findLeader(i, e, route);
    if (leader.found) {
      const a = this.idmInteract(speed, vMax, leader.gap, speed - leader.speed, params);
      if (a < acc) acc = a;
    }

    // Stop line / destination / blocked-lane-change stops.
    const stop = this.stopTarget(i, e, route);
    const stopReason = this.stopReason;
    if (stop >= 0) {
      const gap = stop - v.pos[i];
      const a = this.idmInteract(speed, vMax, gap, speed, params);
      if (a < acc) acc = a;
    }

    // Slow ahead of a lower-speed connector.
    const nextIdx = v.routeIdx[i] + 1;
    if (nextIdx < route.length) {
      const ne = edges[route[nextIdx]];
      if (ne.speedLimit < speed) {
        const distToEnd = e.length - v.pos[i];
        const allowed = Math.sqrt(ne.speedLimit * ne.speedLimit + 2 * params.b * Math.max(0, distToEnd));
        if (allowed < vMax) {
          const a = this.idmFree(speed, Math.max(allowed, 1), params);
          if (a < acc) acc = a;
        }
      }
    }

    // --- integrate ---
    let ns = speed + acc * dt;
    if (ns < 0) ns = 0;
    v.speed[i] = ns;
    v.pos[i] += ns * dt;

    // Stuck accounting. Waiting at a red is legitimate; a failed merge or a
    // spillback jam should eventually trigger a (congestion-aware) reroute.
    if (ns < 0.15) {
      v.waitS[i] += dt;
      if (stopReason === STOP_LANECHANGE) {
        v.stuckS[i] += dt;
        if (v.stuckS[i] > REROUTE_LANECHANGE_S) {
          v.stuckS[i] = 0;
          this.reroute(i);
          return;
        }
      } else if (stopReason === STOP_SPILLBACK || (stopReason === STOP_NONE && leader.found)) {
        v.stuckS[i] += dt;
        if (v.stuckS[i] > REROUTE_GRIDLOCK_S) {
          v.stuckS[i] = 0;
          this.reroute(i);
          return;
        }
      }
    } else if (ns > 1) {
      v.stuckS[i] = 0;
    }

    // --- arrival on final edge ---
    // The vehicle "pulls off" into its destination before fully stopping —
    // parking in the travel lane would throttle the whole lane.
    const lastIdx = route.length - 1;
    if (v.routeIdx[i] === lastIdx && v.destPos[i] - v.pos[i] < 5) {
      this.despawn(i, true);
      return;
    }

    // --- edge transitions ---
    while (v.pos[i] > edges[v.edge[i]].length) {
      const cur = edges[v.edge[i]];
      const idx = v.routeIdx[i];
      if (idx >= lastIdx) {
        // Ran off the end of the final edge (destPos at very end): arrive.
        this.despawn(i, true);
        return;
      }
      const nextId = route[idx + 1];
      const ne = edges[nextId];
      // Parallel lane steps are taken via maybeExecuteLaneChange, never by
      // running off the end. If we're here with a parallel next step the
      // change never found a gap — reroute from this edge.
      if (ne.id === cur.leftEdge || ne.id === cur.rightEdge) {
        v.pos[i] = cur.length;
        v.speed[i] = 0;
        this.reroute(i);
        return;
      }
      v.pos[i] -= cur.length;
      this.occRemove(cur.id, i);
      v.edge[i] = nextId;
      v.routeIdx[i] = idx + 1;
      this.occInsert(nextId, i);
      if (ne.kind === 1) this.interThroughput[ne.interId]++;
    }

    // --- world pose + lane-change easing ---
    const ee = edges[v.edge[i]];
    edgePointAt(ee, v.pos[i], this.scratch);
    let lat = v.lateral[i];
    if (lat !== 0) {
      const decay = (this.graph.laneWidth / 1.0) * dt;
      lat = Math.abs(lat) <= decay ? 0 : lat - Math.sign(lat) * decay;
      v.lateral[i] = lat;
    }
    const h = this.scratch.heading;
    v.x[i] = this.scratch.x - Math.sin(h) * lat;
    v.y[i] = this.scratch.y + Math.cos(h) * lat;
    v.heading[i] = h;

    // Per-segment speed sample.
    if (ee.segId >= 0) {
      this.segSpeedSum[ee.segId] += ns;
      this.segSpeedCount[ee.segId]++;
    }
  }

  /** IDM free-road term. */
  private idmFree(v: number, v0: number, p: IdmParams): number {
    const r = v / Math.max(v0, 0.1);
    return p.aMax * (1 - r * r * r * r);
  }

  /** IDM interaction term for a leader (or stop line) at gap `s`, closing speed dv. */
  private idmInteract(v: number, v0: number, s: number, dv: number, p: IdmParams): number {
    if (s <= 0.3) return -p.b * 4; // emergency
    const sStar = p.s0 + Math.max(0, v * p.T + (v * dv) / (2 * Math.sqrt(p.aMax * p.b)));
    const r = v / Math.max(v0, 0.1);
    return p.aMax * (1 - r * r * r * r - (sStar / s) * (sStar / s));
  }

  private findLeader(i: number, e: LaneEdge, route: Int32Array): { found: boolean; gap: number; speed: number } {
    const v = this.veh;
    const myPos = v.pos[i];

    // Same edge: nearest vehicle ahead.
    const list = this.occ[e.id];
    for (let li = 0; li < list.length; li++) {
      const o = list[li];
      if (o !== i && v.pos[o] > myPos) {
        return { found: true, gap: v.pos[o] - VEH_LEN - myPos, speed: v.speed[o] };
      }
    }

    // Ahead along route within lookahead.
    let acc = e.length - myPos;
    let idx = v.routeIdx[i] + 1;
    const edges = this.graph.edges;
    while (acc < LOOKAHEAD_M && idx < route.length) {
      const ne = edges[route[idx]];
      // Skip parallel-lane steps (same physical stretch, handled at change time).
      if (ne.id === edges[route[idx - 1]].leftEdge || ne.id === edges[route[idx - 1]].rightEdge) {
        idx++;
        continue;
      }
      const l2 = this.occ[ne.id];
      if (l2.length > 0) {
        const o = l2[0]; // lowest pos = nearest to entry
        return { found: true, gap: acc + v.pos[o] - VEH_LEN - myPos, speed: v.speed[o] };
      }
      acc += ne.length;
      idx++;
    }
    return { found: false, gap: 0, speed: 0 };
  }

  /** Reason code set by stopTarget() for the stuck/reroute policy. */
  private stopReason = STOP_NONE;

  /**
   * Returns a stop position on the current edge (or -1): signal stop line,
   * spillback hold, destination curb, or end-of-lane hold while a mandatory
   * lane change waits for a gap. Sets this.stopReason.
   */
  private stopTarget(i: number, e: LaneEdge, route: Int32Array): number {
    const v = this.veh;
    const idx = v.routeIdx[i];
    const edges = this.graph.edges;
    this.stopReason = STOP_NONE;

    // Destination on final edge.
    if (idx === route.length - 1) {
      this.stopReason = STOP_DEST;
      return v.destPos[i];
    }

    const next = edges[route[idx + 1]];

    // Pending lane change: hold short of the end so we can still merge.
    if (next.id === e.leftEdge || next.id === e.rightEdge) {
      this.stopReason = STOP_LANECHANGE;
      return e.length - 6;
    }

    if (next.kind !== 1) return -1;
    // Entering an intersection: check signal + closure + spillback.
    if (e.kind === 1) return -1; // already inside the box — committed

    const distToLine = e.length - v.pos[i];
    if (distToLine > 40) return -1;

    // Turning vehicles yield to pedestrians on the exit-side crosswalk.
    if (next.turnType !== TURN_STRAIGHT && this.crosswalkBlocked(next)) {
      this.stopReason = STOP_SIGNAL;
      return e.length - STOP_MARGIN;
    }

    const open = this.signals.isOpen(next.interId, next.phaseMask) && !next.closed;
    if (!open) {
      // Right turn on red: stop first, then go when the box and the
      // receiving lane are clear of conflicting traffic.
      if (!next.closed && next.turnType === TURN_RIGHT && this.canTurnRightOnRed(i, e, next, route, idx)) {
        return -1;
      }
      this.stopReason = next.closed ? STOP_SPILLBACK : STOP_SIGNAL;
      return e.length - STOP_MARGIN;
    }

    // "Don't block the box": platoon discharge — follow into the connector
    // once the previous entrant clears its mouth, provided the receiving
    // lane has room for this vehicle clear of the intersection.
    const connOcc = this.occ[next.id];
    if (connOcc.length > 0 && this.veh.pos[connOcc[0]] < VEH_LEN + 2.5) {
      this.stopReason = STOP_SPILLBACK;
      return e.length - STOP_MARGIN;
    }
    const afterIdx = idx + 2;
    if (afterIdx < route.length) {
      const target = edges[route[afterIdx]];
      const tOcc = this.occ[target.id];
      if (tOcc.length > 0) {
        // Queue-tail vehicle's rear bumper must leave room past the box exit.
        const tailRear = this.veh.pos[tOcc[0]] - VEH_LEN;
        if (tailRear < ENTRY_ZONE_M) {
          this.stopReason = STOP_SPILLBACK;
          return e.length - STOP_MARGIN;
        }
      }
    }
    return -1;
  }

  /**
   * RTOR gate: vehicle must have stopped at the line; the turn connector must
   * be empty, every connector merging into the same receiving lane must be
   * empty (no crossing platoon), and the receiving lane tail must leave room.
   */
  /** Pedestrians on the crosswalk this connector exits across? */
  private crosswalkBlocked(conn: LaneEdge): boolean {
    return this.peds.crosswalkOcc[conn.interId * 4 + conn.dir] > 0;
  }

  private canTurnRightOnRed(i: number, e: LaneEdge, conn: LaneEdge, route: Int32Array, idx: number): boolean {
    const v = this.veh;
    const distToLine = e.length - v.pos[i];
    if (distToLine > 4 || v.speed[i] > 1.5) return false;
    if (this.occ[conn.id].length > 0) return false;
    if (this.crosswalkBlocked(conn)) return false;
    const afterIdx = idx + 2;
    if (afterIdx >= route.length) return false;
    const target = this.graph.edges[route[afterIdx]];
    for (const f of this.graph.feeders[target.id]) {
      if (f !== conn.id && this.occ[f].length > 0) return false;
    }
    const tOcc = this.occ[target.id];
    if (tOcc.length > 0 && this.veh.pos[tOcc[0]] - VEH_LEN < ENTRY_ZONE_M + 4) return false;
    return true;
  }

  private maybeExecuteLaneChange(i: number, e: LaneEdge, route: Int32Array, params: IdmParams) {
    const v = this.veh;
    const idx = v.routeIdx[i];
    if (idx + 1 >= route.length || e.kind !== 0) return;
    const targetId = route[idx + 1];
    if (targetId !== e.leftEdge && targetId !== e.rightEdge) return;

    const myPos = v.pos[i];
    const mySpeed = v.speed[i];
    // Relax acceptance the closer we are to the end of the lane.
    const urgency = Math.min(1, myPos / Math.max(1, e.length - 25));
    const needAhead = (params.s0 + mySpeed * params.T) * (1 - 0.55 * urgency) + VEH_LEN;
    const needBehind = (params.s0 + 8 * params.T) * (1 - 0.55 * urgency) + VEH_LEN;

    for (const o of this.occ[targetId]) {
      const d = v.pos[o] - myPos;
      if (d >= 0 && d < needAhead) return;
      if (d < 0 && -d < needBehind) return;
    }

    // Take the gap.
    const fromLane = e.lane;
    this.occRemove(e.id, i);
    v.edge[i] = targetId;
    v.routeIdx[i] = idx + 1;
    this.occInsert(targetId, i);
    const toLane = this.graph.edges[targetId].lane;
    v.lateral[i] += (fromLane - toLane) * this.graph.laneWidth;
  }

  private reroute(i: number) {
    const v = this.veh;
    const route = v.routes[i]!;
    const lastEdge = this.graph.edges[route[route.length - 1]];
    const destSeg = lastEdge.segId;
    const goalLanes = destSeg >= 0 ? this.graph.segs[destSeg].laneEdges : [lastEdge.id];
    const destPos = v.destPos[i];

    const newRoute = this.router.route(v.edge[i], goalLanes);
    if (!newRoute || newRoute.length === 0) {
      this.despawn(i, false);
      return;
    }
    v.routes[i] = newRoute;
    v.routeIdx[i] = 0;
    const nl = this.graph.edges[newRoute[newRoute.length - 1]];
    v.destPos[i] = Math.max(3, Math.min(nl.length - 3, destPos));
  }

  private despawn(i: number, arrived: boolean) {
    const v = this.veh;
    this.occRemove(v.edge[i], i);
    if (arrived) {
      this.arrivals++;
      this.travelTimeSum += this.t - v.spawnT[i];
      this.freeflowSum += v.freeflowS[i];
      if (v.isAV[i]) {
        this.avArrivals++;
        this.avTravelSum += this.t - v.spawnT[i];
        this.avFreeflowSum += v.freeflowS[i];
      }
    } else {
      this.abandoned++;
    }
    v.release(i);
  }

  /**
   * Reroute every vehicle whose remaining route uses a closed edge. Called
   * after a closure intervention so traffic diverts immediately instead of
   * piling against the barrier.
   */
  rerouteAroundClosures() {
    const v = this.veh;
    const edges = this.graph.edges;
    this.rebuildOccupancy();
    for (let i = 0; i < v.highWater; i++) {
      if (!v.alive[i]) continue;
      const route = v.routes[i]!;
      for (let r = v.routeIdx[i] + 1; r < route.length; r++) {
        if (edges[route[r]].closed) {
          this.reroute(i);
          break;
        }
      }
    }
  }

  // ---------------------------------------------------------------- metrics

  private updateCongestion() {
    if (this.t - this.lastCongestionUpdate < CONGESTION_UPDATE_S) return;
    this.lastCongestionUpdate = this.t;
    const segs = this.graph.segs;
    for (let s = 0; s < segs.length; s++) {
      const n = this.segSpeedCount[s];
      if (n > 0) {
        const avg = this.segSpeedSum[s] / n;
        // EMA toward the sampled mean.
        this.segAvgSpeed[s] = this.segAvgSpeed[s] * 0.5 + avg * 0.5;
      } else {
        // No traffic: relax toward free flow.
        this.segAvgSpeed[s] = this.segAvgSpeed[s] * 0.8 + 13.4 * 0.2;
      }
      this.segSpeedSum[s] = 0;
      this.segSpeedCount[s] = 0;
      // Push live cost into the router for all lanes of this segment.
      const mult = Math.min(10, Math.max(1, 13.4 / Math.max(1, this.segAvgSpeed[s])));
      for (const eid of segs[s].laneEdges) this.router.congestion[eid] = mult;
    }

    // Queue lengths: stopped vehicles within 45m of each stop line.
    const v = this.veh;
    this.interQueue.fill(0);
    for (let inter = 0; inter < this.graph.interApproaches.length; inter++) {
      let q = 0;
      for (const eid of this.graph.interApproaches[inter]) {
        const e = this.graph.edges[eid];
        for (const o of this.occ[eid]) {
          if (v.speed[o] < 1 && e.length - v.pos[o] < 45) q++;
        }
      }
      this.interQueue[inter] = q;
    }

    // Density per segment (veh per lane-km).
    for (let s = 0; s < segs.length; s++) {
      let n = 0;
      for (const eid of segs[s].laneEdges) n += this.occ[eid].length;
      const laneKm = (segs[s].length * segs[s].laneEdges.length) / 1000;
      this.segDensity[s] = laneKm > 0 ? n / laneKm : 0;
    }

    // Pedestrians per block.
    this.blockPeds.fill(0);
    const m = this.model;
    const p = this.peds;
    const pitchX = m.blockWidth + m.roadWidth;
    const pitchY = m.blockHeight + m.roadWidth;
    for (let i = 0; i < p.highWater; i++) {
      if (!p.alive[i]) continue;
      const bx = Math.min(m.cols - 1, Math.max(0, Math.floor((p.x[i] - m.originX - m.roadWidth / 2) / pitchX)));
      const by = Math.min(m.rows - 1, Math.max(0, Math.floor((p.y[i] - m.originY - m.roadWidth / 2) / pitchY)));
      this.blockPeds[by * m.cols + bx]++;
    }
  }

  stats(): SimStats {
    const v = this.veh;
    let speedSum = 0, n = 0, nAV = 0;
    for (let i = 0; i < v.highWater; i++) {
      if (v.alive[i]) {
        speedSum += v.speed[i];
        n++;
        if (v.isAV[i]) nAV++;
      }
    }
    const humanArr = this.arrivals - this.avArrivals;
    return {
      t: this.t,
      activeVehicles: v.count,
      arrivals: this.arrivals,
      abandoned: this.abandoned,
      spawned: this.spawnedTotal,
      delayIndex: this.arrivals > 0 ? (this.travelTimeSum / this.arrivals) / (this.freeflowSum / this.arrivals) : 1,
      avgTripS: this.arrivals > 0 ? this.travelTimeSum / this.arrivals : 0,
      avgSpeed: n > 0 ? speedSum / n : 0,
      activePeds: this.peds.count,
      pedArrivals: this.peds.arrivals,
      waitingPeds: this.peds.waitingCount,
      avDelayIndex: this.avArrivals > 0 ? (this.avTravelSum / this.avArrivals) / (this.avFreeflowSum / this.avArrivals) : 1,
      humanDelayIndex: humanArr > 0 ? ((this.travelTimeSum - this.avTravelSum) / humanArr) / ((this.freeflowSum - this.avFreeflowSum) / humanArr) : 1,
      avArrivals: this.avArrivals,
      activeAVs: nAV,
    };
  }

  /** Deterministic state hash for testing. */
  hash(): number {
    const v = this.veh;
    let h = 2166136261 >>> 0;
    const mix = (x: number) => {
      h ^= (x * 2654435761) >>> 0;
      h = Math.imul(h, 16777619) >>> 0;
    };
    mix(v.count);
    for (let i = 0; i < v.highWater; i++) {
      if (!v.alive[i]) continue;
      mix(i);
      mix(Math.round(v.pos[i] * 1000));
      mix(v.edge[i]);
      mix(Math.round(v.speed[i] * 1000));
    }
    return h;
  }
}
