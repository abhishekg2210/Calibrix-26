import { useRef, useEffect, useCallback } from 'react';
import { useStore } from '../state/store';
import { renderCityBase, renderCityLanes, renderTrafficSignals } from './CityRenderer';
import { renderVehicle, renderGoal } from './VehicleRenderer';
import { renderSafetyBuffer } from './ObstacleRenderer';
import { interactionHandler, pathAnimator, simEngine } from './simCanvasRegistry';
import { theme } from '../styles/theme';

export default function SimulationCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);

  // The RAF loop reads fresh state via useStore.getState() each frame, so the
  // component itself never needs to re-render on store changes.
  useEffect(() => {
    const render = (time: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);
    }

    // Get fresh state for simulation tick
    const state = useStore.getState();

    // Delta time
    const deltaMs = lastTimeRef.current > 0 ? time - lastTimeRef.current : 16;
    lastTimeRef.current = time;

    // --- Simulation tick ---
    if (state.simMode === 'simulating' && state.cityMap) {
      simEngine.tick(
        deltaMs,
        state.ego!,
        state.vehicles,
        state.cityMap,
        state.updateVehicle
      );

      // Check if sim finished
      if (simEngine.getMode() === 'done') {
        state.setSimMode('done');
      }
    }

    // Re-read state after potential sim tick mutations
    const s = useStore.getState();

    // Clear
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = theme.colors.base;
    ctx.fillRect(0, 0, w, h);

    // Transform to world coordinates
    ctx.save();
    ctx.translate(w / 2 + s.offsetX, h / 2 + s.offsetY);

    // City: roads, buildings, lanes
    if (s.cityMap) {
      renderCityBase(ctx, s.cityMap, s.zoom);
      renderCityLanes(ctx, s.cityMap, s.zoom);
    }

    // Safety buffers for non-building obstacles (only when not simulating)
    if (s.simMode === 'idle') {
      for (const v of s.vehicles) {
        if (!v.id.startsWith('bld-obs-') && !v.id.startsWith('npc-')) {
          renderSafetyBuffer(ctx, v, s.zoom);
        }
      }
    }

    // Paths
    if (s.isAnimating) {
      const stillGoing = pathAnimator.update(deltaMs);
      if (!stillGoing && pathAnimator.isComplete()) {
        s.setAnimating(false);
      }
      pathAnimator.render(ctx, s.zoom, null);
    } else if (s.plannerResults.length > 0 && s.simMode !== 'simulating') {
      // During simulation, only show the primary planner's path
      if (s.simMode === 'done') {
        const primary = s.plannerResults.filter(r => r.algorithm === s.primaryPlanner);
        pathAnimator.renderStatic(ctx, primary, s.zoom, null);
      } else {
        pathAnimator.renderStatic(ctx, s.plannerResults, s.zoom, null);
      }
    } else if (s.simMode === 'simulating' && s.plannerResults.length > 0) {
      // Show only primary path during simulation
      const primary = s.plannerResults.filter(r => r.algorithm === s.primaryPlanner);
      pathAnimator.renderStatic(ctx, primary, s.zoom, null);
    }

    // Vehicles
    for (const v of s.vehicles) {
      renderVehicle(ctx, v, s.zoom, v.id === s.selectedId);
    }

    // Ego vehicle
    if (s.ego) {
      renderVehicle(ctx, s.ego, s.zoom, s.selectedId === 'ego');
    }

    // Goal
    if (s.goal) {
      renderGoal(ctx, s.goal, s.zoom);
    }

    // Traffic signals
    if (s.cityMap) {
      renderTrafficSignals(ctx, s.cityMap, s.zoom, time);
    }

    ctx.restore();

    // Cursor mode indicator
    const mode = interactionHandler.getMode();
    if (mode !== 'select') {
      ctx.fillStyle = theme.colors.textSecondary;
      ctx.globalAlpha = 0.6;
      ctx.font = '10px IBM Plex Mono';
      ctx.textAlign = 'right';
      const labels: Record<string, string> = {
        'place-ego': 'CLICK TO PLACE EGO VEHICLE',
        'place-goal': 'CLICK TO PLACE GOAL',
        'place-obstacle': 'CLICK TO PLACE OBSTACLE  ·  ESC TO CANCEL',
      };
      ctx.fillText(labels[mode] || '', w - 16, h - 16);
      ctx.globalAlpha = 1;
    }

    // Sim status overlay
    if (s.simMode === 'simulating') {
      const egoState = simEngine.getEgoState();
      ctx.fillStyle = theme.colors.text;
      ctx.globalAlpha = 0.7;
      ctx.font = '10px IBM Plex Mono';
      ctx.textAlign = 'left';
      ctx.fillText(`SPEED: ${(egoState.currentSpeed * 2.237).toFixed(0)} MPH`, 12, h - 36);
      ctx.fillText(`DIST: ${egoState.totalDistance.toFixed(0)}m`, 12, h - 22);
      ctx.fillText(`TIME: ${egoState.elapsedTime.toFixed(1)}s`, 12, h - 8);
      ctx.globalAlpha = 1;
    }

    if (s.simMode === 'done') {
      const egoState = simEngine.getEgoState();
      ctx.fillStyle = theme.colors.success;
      ctx.globalAlpha = 0.9;
      ctx.font = '12px IBM Plex Mono';
      ctx.textAlign = 'center';
      ctx.fillText('DESTINATION REACHED', w / 2, h - 24);
      ctx.font = '10px IBM Plex Mono';
      ctx.fillStyle = theme.colors.textSecondary;
      ctx.fillText(
        `${egoState.totalDistance.toFixed(0)}m in ${egoState.elapsedTime.toFixed(1)}s`,
        w / 2, h - 8
      );
      ctx.globalAlpha = 1;
    }

    animFrameRef.current = requestAnimationFrame(render);
    };

    animFrameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  // Event handlers
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const s = useStore.getState();
    const rect = canvas.getBoundingClientRect();
    interactionHandler.handleMouseDown(
      e.nativeEvent,
      rect.width, rect.height,
      s.offsetX, s.offsetY, s.zoom,
      s.vehicles, s.ego,
      {
        setEgo: s.setEgo,
        setGoal: s.setGoal,
        addObstacle: s.addObstacle,
        setSelected: s.setSelected,
        setOffset: s.setOffset,
      }
    );
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const s = useStore.getState();
    const rect = canvas.getBoundingClientRect();
    interactionHandler.handleMouseMove(
      e.nativeEvent,
      rect.width, rect.height,
      s.offsetX, s.offsetY, s.zoom,
      { setOffset: s.setOffset, updateVehicle: s.updateVehicle }
    );
  }, []);

  const handleMouseUp = useCallback(() => {
    interactionHandler.handleMouseUp();
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    const s = useStore.getState();
    interactionHandler.handleWheel(e.nativeEvent, s.zoom, { setZoom: s.setZoom });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        interactionHandler.setMode('select');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height: '100%', display: 'block', cursor: interactionHandler.getMode() !== 'select' ? 'crosshair' : 'default' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onContextMenu={handleContextMenu}
    />
  );
}
