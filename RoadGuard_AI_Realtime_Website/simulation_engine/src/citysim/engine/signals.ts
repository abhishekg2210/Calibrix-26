import { CityConfig } from '../config';
import { PHASE_NS_STRAIGHT, PHASE_NS_LEFT, PHASE_EW_STRAIGHT, PHASE_EW_LEFT } from '../graph/laneGraph';

/**
 * Fixed-time signal controller. Each intersection cycles through
 * NS-straight -> NS-left -> EW-straight -> EW-left with all-red clearance
 * between phases.
 *
 * Time domains: physics (vehicle speeds, signal cycles) runs in sim seconds
 * at realistic rates. The compressed 24h "clock" only shapes demand curves —
 * signal durations here are sim seconds, NOT clock seconds.
 *
 * `phaseOffsets` stagger intersections to create green waves; timing is
 * editable at runtime (Experiments tab).
 */

export const PHASE_ALL_RED = 4;

export interface SignalPlan {
  durations: Float64Array;  // sim-seconds per phase slot (incl. interleaved all-red)
  cycle: number;            // total sim-seconds
  /** slot index -> open phase (PHASE_* or PHASE_ALL_RED) */
  slotPhase: Uint8Array;
}

export class SignalController {
  private nInter: number;
  private offsets: Float64Array;
  plan: SignalPlan;
  /** Current open phase per intersection (PHASE_* or PHASE_ALL_RED). */
  current: Uint8Array;
  /** Sim-seconds remaining in the current slot, per intersection. */
  remaining: Float64Array;
  /** Per-intersection plan override (Experiments). null = global plan. */
  private overrides: Map<number, SignalPlan> = new Map();

  constructor(cfg: CityConfig, nInter: number, interRow: Int32Array, interCol: Int32Array) {
    this.nInter = nInter;
    this.plan = makePlan(cfg);
    this.current = new Uint8Array(nInter);
    this.remaining = new Float64Array(nInter);
    this.offsets = new Float64Array(nInter);
    // Stagger offsets so the whole grid doesn't stop and start in sync —
    // a diagonal progression gives loose green waves in both axes.
    for (let i = 0; i < nInter; i++) {
      this.offsets[i] = ((interRow[i] * 7 + interCol[i] * 13) % 8) * (this.plan.cycle / 8);
    }
    this.update(0);
  }

  setGlobalPlan(plan: SignalPlan) {
    this.plan = plan;
    this.overrides.clear();
  }

  setIntersectionPlan(inter: number, plan: SignalPlan | null) {
    if (plan) this.overrides.set(inter, plan);
    else this.overrides.delete(inter);
  }

  planFor(inter: number): SignalPlan {
    return this.overrides.get(inter) ?? this.plan;
  }

  /** Recompute current phase for all intersections at sim time t (seconds). */
  update(t: number) {
    for (let i = 0; i < this.nInter; i++) {
      const plan = this.planFor(i);
      let local = (t + this.offsets[i]) % plan.cycle;
      let slot = 0;
      while (local >= plan.durations[slot]) {
        local -= plan.durations[slot];
        slot++;
      }
      this.current[i] = plan.slotPhase[slot];
      this.remaining[i] = plan.durations[slot] - local;
    }
  }

  /** Is the given movement phase open at this intersection? */
  isOpen(inter: number, phaseMask: number): boolean {
    const p = this.current[inter];
    return p !== PHASE_ALL_RED && (phaseMask & (1 << p)) !== 0;
  }
}

export function makePlan(cfg: CityConfig): SignalPlan {
  const s = cfg.signal;
  // Slots: NS-straight, allred, NS-left, allred, EW-straight, allred, EW-left, allred
  const durations = Float64Array.from([
    s.nsStraightS, s.allRedS,
    s.nsLeftS, s.allRedS,
    s.ewStraightS, s.allRedS,
    s.ewLeftS, s.allRedS,
  ]);
  const slotPhase = Uint8Array.from([
    PHASE_NS_STRAIGHT, PHASE_ALL_RED,
    PHASE_NS_LEFT, PHASE_ALL_RED,
    PHASE_EW_STRAIGHT, PHASE_ALL_RED,
    PHASE_EW_LEFT, PHASE_ALL_RED,
  ]);
  let cycle = 0;
  for (const d of durations) cycle += d;
  return { durations, cycle, slotPhase };
}
