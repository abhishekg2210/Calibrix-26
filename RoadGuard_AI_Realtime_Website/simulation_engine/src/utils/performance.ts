/** Precise timing for planner benchmarking */
export function timeExecution<T>(fn: () => T): { result: T; timeMs: number } {
  const start = performance.now();
  const result = fn();
  const timeMs = performance.now() - start;
  return { result, timeMs };
}

/** Generate a unique ID */
export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}
