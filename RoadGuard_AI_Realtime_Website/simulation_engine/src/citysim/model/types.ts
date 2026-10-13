/** City model: physical layout + land use. Pure data, shared by sim worker and renderer. */

export type LandUse = 'residential' | 'office' | 'commercial' | 'civic' | 'park';

export interface CityBuilding {
  id: number;
  x: number;       // center x (m)
  y: number;       // center y (m)
  width: number;   // x extent
  depth: number;   // y extent
  height: number;  // z extent (for 3D)
  landUse: LandUse;
  blockRow: number;
  blockCol: number;
}

export interface CityIntersection {
  id: number;
  row: number;     // 0..rows
  col: number;     // 0..cols
  x: number;
  y: number;
  size: number;    // square, == roadWidth
}

/** One directed road group between two intersections (all lanes one direction). */
export interface RoadSegmentInfo {
  id: number;
  orientation: 'h' | 'v';
  /** Direction of travel: 0=E(+x) 1=S(+y) 2=W(-x) 3=N(-y) */
  dir: number;
  fromInter: number;
  toInter: number;
  ax: number; ay: number; // centerline start (at exit boundary of fromInter)
  bx: number; by: number; // centerline end (at entry boundary of toInter)
}

export interface CityModel {
  rows: number;
  cols: number;
  blockWidth: number;
  blockHeight: number;
  roadWidth: number;
  lanesPerDirection: number;
  laneWidth: number;
  originX: number;
  originY: number;
  totalWidth: number;
  totalHeight: number;
  intersections: CityIntersection[];
  buildings: CityBuilding[];
  /** Road centerline x for vertical road j. */
  vRoadX: number[];
  /** Road centerline y for horizontal road i. */
  hRoadY: number[];
}

export const DIR_E = 0;
export const DIR_S = 1;
export const DIR_W = 2;
export const DIR_N = 3;

export const DIR_VEC: ReadonlyArray<readonly [number, number]> = [
  [1, 0],   // E
  [0, 1],   // S
  [-1, 0],  // W
  [0, -1],  // N
];

/** Right-hand side unit vector of a direction (right-hand traffic). */
export const RIGHT_VEC: ReadonlyArray<readonly [number, number]> = [
  [0, 1],   // E -> +y
  [-1, 0],  // S -> -x
  [0, -1],  // W -> -y
  [1, 0],   // N -> +x
];

export function oppositeDir(d: number): number {
  return (d + 2) % 4;
}

/** Direction after a right turn. E->S->W->N->E */
export function rightOf(d: number): number {
  return (d + 1) % 4;
}

/** Direction after a left turn. */
export function leftOf(d: number): number {
  return (d + 3) % 4;
}

export function dirHeading(d: number): number {
  return [0, Math.PI / 2, Math.PI, -Math.PI / 2][d];
}
