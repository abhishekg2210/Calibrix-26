import { InteractionHandler, InteractionMode } from './InteractionHandler';
import { PathAnimator } from './PathRenderer';
import { SimEngine } from '../simulation/SimEngine';

/**
 * Planner Lab singletons shared between the canvas component and the control
 * bar (kept outside SimulationCanvas.tsx so that file only exports a
 * component, as fast-refresh requires).
 */
export const interactionHandler = new InteractionHandler();
export const pathAnimator = new PathAnimator();
export const simEngine = new SimEngine();

export function setInteractionMode(mode: InteractionMode) {
  interactionHandler.setMode(mode);
}

export function getInteractionMode() {
  return interactionHandler.getMode();
}

export function getPathAnimator() {
  return pathAnimator;
}

export function getSimEngine() {
  return simEngine;
}
