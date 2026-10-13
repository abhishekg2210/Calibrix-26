import { Vehicle } from '../planners/types';
import { pointInVehicle } from '../utils/geometry';

export type InteractionMode = 'select' | 'place-ego' | 'place-goal' | 'place-obstacle';

interface DragState {
  vehicleId: string;
  startWorldX: number;
  startWorldY: number;
  vehicleStartX: number;
  vehicleStartY: number;
}

export class InteractionHandler {
  private mode: InteractionMode = 'select';
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panOffsetStartX = 0;
  private panOffsetStartY = 0;
  private drag: DragState | null = null;
  private isDragging = false;

  setMode(mode: InteractionMode) {
    this.mode = mode;
  }

  getMode() {
    return this.mode;
  }

  /** Convert screen coordinates to world coordinates */
  screenToWorld(
    screenX: number,
    screenY: number,
    canvasWidth: number,
    canvasHeight: number,
    offsetX: number,
    offsetY: number,
    zoom: number
  ): { x: number; y: number } {
    const x = (screenX - canvasWidth / 2 - offsetX) / zoom;
    const y = (screenY - canvasHeight / 2 - offsetY) / zoom;
    return { x, y };
  }

  handleMouseDown(
    e: MouseEvent,
    canvasWidth: number,
    canvasHeight: number,
    offsetX: number,
    offsetY: number,
    zoom: number,
    vehicles: Vehicle[],
    ego: Vehicle | null,
    callbacks: {
      setEgo: (x: number, y: number) => void;
      setGoal: (x: number, y: number) => void;
      addObstacle: (x: number, y: number) => void;
      setSelected: (id: string | null) => void;
      setOffset: (x: number, y: number) => void;
    }
  ): void {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const world = this.screenToWorld(sx, sy, canvasWidth, canvasHeight, offsetX, offsetY, zoom);

    // Middle mouse button → pan
    if (e.button === 1) {
      e.preventDefault();
      this.isPanning = true;
      this.panStartX = e.clientX;
      this.panStartY = e.clientY;
      this.panOffsetStartX = offsetX;
      this.panOffsetStartY = offsetY;
      return;
    }

    // Right click → add obstacle
    if (e.button === 2) {
      e.preventDefault();
      callbacks.addObstacle(Math.round(world.x * 2) / 2, Math.round(world.y * 2) / 2);
      return;
    }

    // Left click
    if (e.button === 0) {
      // Check if clicking on a vehicle
      const allVehicles = ego ? [ego, ...vehicles] : [...vehicles];
      for (const v of allVehicles) {
        if (pointInVehicle(world, v)) {
          callbacks.setSelected(v.id);
          this.drag = {
            vehicleId: v.id,
            startWorldX: world.x,
            startWorldY: world.y,
            vehicleStartX: v.x,
            vehicleStartY: v.y,
          };
          this.isDragging = false;
          return;
        }
      }

      // Not on a vehicle — handle based on mode
      switch (this.mode) {
        case 'place-ego':
          callbacks.setEgo(Math.round(world.x * 2) / 2, Math.round(world.y * 2) / 2);
          this.mode = 'select';
          break;
        case 'place-goal':
          callbacks.setGoal(Math.round(world.x * 2) / 2, Math.round(world.y * 2) / 2);
          this.mode = 'select';
          break;
        case 'place-obstacle':
          callbacks.addObstacle(Math.round(world.x * 2) / 2, Math.round(world.y * 2) / 2);
          break;
        case 'select':
        default:
          callbacks.setSelected(null);
          // Start panning with left mouse on empty space
          this.isPanning = true;
          this.panStartX = e.clientX;
          this.panStartY = e.clientY;
          this.panOffsetStartX = offsetX;
          this.panOffsetStartY = offsetY;
          break;
      }
    }
  }

  handleMouseMove(
    e: MouseEvent,
    canvasWidth: number,
    canvasHeight: number,
    offsetX: number,
    offsetY: number,
    zoom: number,
    callbacks: {
      setOffset: (x: number, y: number) => void;
      updateVehicle: (id: string, updates: Partial<Vehicle>) => void;
    }
  ): void {
    if (this.isPanning) {
      const dx = e.clientX - this.panStartX;
      const dy = e.clientY - this.panStartY;
      callbacks.setOffset(this.panOffsetStartX + dx, this.panOffsetStartY + dy);
      return;
    }

    if (this.drag) {
      const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = this.screenToWorld(sx, sy, canvasWidth, canvasHeight, offsetX, offsetY, zoom);

      const dx = world.x - this.drag.startWorldX;
      const dy = world.y - this.drag.startWorldY;

      if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
        this.isDragging = true;
      }

      callbacks.updateVehicle(this.drag.vehicleId, {
        x: this.drag.vehicleStartX + dx,
        y: this.drag.vehicleStartY + dy,
      });
    }
  }

  handleMouseUp(): void {
    this.isPanning = false;
    this.drag = null;
    this.isDragging = false;
  }

  handleWheel(
    e: WheelEvent,
    zoom: number,
    callbacks: { setZoom: (zoom: number) => void }
  ): void {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -2 : 2;
    callbacks.setZoom(zoom + delta);
  }
}
