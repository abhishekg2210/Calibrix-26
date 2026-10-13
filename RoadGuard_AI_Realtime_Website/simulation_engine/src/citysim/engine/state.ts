/**
 * Structure-of-arrays vehicle state. Slots are recycled via a free list;
 * iteration is always by ascending slot for determinism.
 */
export class VehicleState {
  readonly cap: number;
  count = 0;                 // live vehicles
  highWater = 0;             // highest slot ever used + 1 (iteration bound)

  alive: Uint8Array;
  isAV: Uint8Array;
  colorIdx: Uint8Array;
  edge: Int32Array;          // current lane-graph edge
  pos: Float64Array;         // distance along edge (front bumper)
  speed: Float64Array;       // m/s
  routeIdx: Int32Array;      // index into routes[slot]
  destPos: Float64Array;     // stop position on final route edge
  spawnT: Float64Array;      // sim time of spawn
  freeflowS: Float64Array;   // estimated free-flow trip seconds
  lateral: Float32Array;     // lane-change visual offset (m, signed)
  stuckS: Float32Array;      // seconds spent fully stopped (reroute trigger)
  waitS: Float32Array;       // cumulative stopped seconds this trip (delay metric)

  // world-space pose, recomputed every tick for snapshots
  x: Float32Array;
  y: Float32Array;
  heading: Float32Array;

  routes: (Int32Array | null)[];

  private free: number[] = [];

  constructor(cap: number) {
    this.cap = cap;
    this.alive = new Uint8Array(cap);
    this.isAV = new Uint8Array(cap);
    this.colorIdx = new Uint8Array(cap);
    this.edge = new Int32Array(cap);
    this.pos = new Float64Array(cap);
    this.speed = new Float64Array(cap);
    this.routeIdx = new Int32Array(cap);
    this.destPos = new Float64Array(cap);
    this.spawnT = new Float64Array(cap);
    this.freeflowS = new Float64Array(cap);
    this.lateral = new Float32Array(cap);
    this.stuckS = new Float32Array(cap);
    this.waitS = new Float32Array(cap);
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.heading = new Float32Array(cap);
    this.routes = new Array(cap).fill(null);
  }

  /** Returns slot id or -1 if full. */
  acquire(): number {
    let slot: number;
    if (this.free.length > 0) slot = this.free.pop()!;
    else if (this.highWater < this.cap) slot = this.highWater++;
    else return -1;
    this.alive[slot] = 1;
    this.count++;
    return slot;
  }

  release(slot: number) {
    this.alive[slot] = 0;
    this.routes[slot] = null;
    this.count--;
    this.free.push(slot);
    // Keep free list deterministic regardless of release order within a tick.
    if (this.free.length > 1) this.free.sort((a, b) => b - a);
  }
}
