import { Lane, Point } from '../planners/types';

export interface CityLayout {
  blockWidth: number;
  blockHeight: number;
  roadWidth: number;
  lanesPerDirection: number;
  laneWidth: number;
  rows: number;
  cols: number;
}

export interface RoadSegment {
  id: string;
  orientation: 'horizontal' | 'vertical';
  start: Point;
  end: Point;
  width: number;
}

export interface Intersection {
  id: string;
  center: Point;
  width: number;
  height: number;
  signal: TrafficSignal;
}

export interface TrafficSignal {
  nsState: 'red' | 'yellow' | 'green';
  ewState: 'red' | 'yellow' | 'green';
  cycleTimeMs: number;
  phaseOffsetMs: number;
}

export interface Building {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CityMap {
  roads: RoadSegment[];
  intersections: Intersection[];
  buildings: Building[];
  lanes: Lane[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  layout: CityLayout;
}
