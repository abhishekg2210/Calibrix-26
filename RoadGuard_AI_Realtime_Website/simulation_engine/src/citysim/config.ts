/** Configuration for a City Command simulation run. */

export interface CityConfig {
  /** Blocks in each dimension (8–30). */
  rows: number;
  cols: number;
  blockWidth: number;   // meters (x)
  blockHeight: number;  // meters (y)
  roadWidth: number;    // meters, full road incl. both directions
  lanesPerDirection: number;
  laneWidth: number;
  /** RNG seed — same seed + config => identical run. */
  seed: number;
  /** Peak simultaneous vehicles / pedestrians. */
  maxVehicles: number;
  maxPedestrians: number;
  /** Demand intensity multiplier (1 = default). */
  demandScale: number;
  /** Fraction of spawned vehicles that are AVs (0–0.5). */
  avShare: number;
  /** Real seconds for one full 24h sim day at 1x speed. */
  daySimSeconds: number;
  /** Sim clock time of day at start, hours [0,24). */
  startHour: number;
  /** Signal timing (sim-seconds at clock rate, i.e. perceived realistic seconds). */
  signal: SignalTiming;
}

export interface SignalTiming {
  nsStraightS: number;
  nsLeftS: number;
  ewStraightS: number;
  ewLeftS: number;
  allRedS: number;
}

// Short cycles suit short blocks: queue storage between intersections is
// limited, so long reds guarantee spillback.
export const DEFAULT_SIGNAL: SignalTiming = {
  nsStraightS: 12,
  nsLeftS: 4.5,
  ewStraightS: 12,
  ewLeftS: 4.5,
  allRedS: 1.2,
};

export function defaultCityConfig(overrides: Partial<CityConfig> = {}): CityConfig {
  return {
    rows: 20,
    cols: 20,
    blockWidth: 56,
    blockHeight: 44,
    roadWidth: 14,
    lanesPerDirection: 2,
    laneWidth: 3.5,
    seed: 42,
    maxVehicles: 4000,
    maxPedestrians: 6000,
    demandScale: 1,
    avShare: 0.1,
    daySimSeconds: 1440, // 24 min = 24 h at 1x
    startHour: 7.5,      // start just before morning rush
    signal: { ...DEFAULT_SIGNAL },
    ...overrides,
  };
}

/** Sim fixed timestep (seconds of sim time per tick). */
export const SIM_DT = 0.1;

/** Clock seconds advanced per sim second. */
export function clockRate(cfg: CityConfig): number {
  return 86400 / cfg.daySimSeconds;
}
