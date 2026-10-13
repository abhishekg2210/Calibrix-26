import { Play, RotateCcw, Car, Square, Waypoints, BarChart3, Zap, StopCircle } from 'lucide-react';
import { useStore } from '../state/store';
import { setInteractionMode, getPathAnimator, getSimEngine } from '../canvas/simCanvasRegistry';
import { runPlanners } from '../planners/PlannerRunner';
import { cityToRoadRects } from '../city/CityGenerator';
import { theme } from '../styles/theme';

const btnBase: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: theme.colors.textSecondary,
  background: theme.colors.surface,
  // Non-shorthand border: hover handlers mutate borderColor, and React 19
  // errors when a shorthand and its longhand conflict across rerenders.
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: theme.colors.border,
  borderRadius: 2,
  padding: '6px 14px',
  cursor: 'pointer',
  transition: theme.transitions.fast,
};

const styles = {
  bar: {
    height: 52,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 16px',
    background: theme.colors.surface,
    borderTop: `1px solid ${theme.colors.border}`,
    flexShrink: 0,
  } as React.CSSProperties,
  group: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  } as React.CSSProperties,
  divider: {
    width: 1,
    height: 24,
    background: theme.colors.border,
    margin: '0 8px',
  } as React.CSSProperties,
};

function ToolButton({
  children,
  onClick,
  accent = false,
  active = false,
  danger = false,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  accent?: boolean;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const style: React.CSSProperties = {
    ...btnBase,
    ...(accent ? {
      color: theme.colors.accent,
      borderColor: theme.colors.borderActive,
      background: theme.colors.accentSubtle,
    } : {}),
    ...(active ? {
      borderColor: theme.colors.borderActive,
      color: theme.colors.text,
    } : {}),
    ...(danger ? {
      color: theme.colors.danger,
      borderColor: theme.colors.danger,
      background: 'rgba(224,92,92,0.08)',
    } : {}),
    ...(disabled ? {
      opacity: 0.4,
      cursor: 'default',
    } : {}),
  };

  return (
    <button
      style={style}
      onClick={disabled ? undefined : onClick}
      onMouseEnter={e => {
        if (disabled) return;
        e.currentTarget.style.background = theme.colors.surfaceRaised;
        e.currentTarget.style.borderColor = theme.colors.borderActive;
        e.currentTarget.style.color = theme.colors.text;
      }}
      onMouseLeave={e => {
        if (disabled) return;
        e.currentTarget.style.background = accent ? theme.colors.accentSubtle : (danger ? 'rgba(224,92,92,0.08)' : theme.colors.surface);
        e.currentTarget.style.borderColor = accent || active ? theme.colors.borderActive : (danger ? theme.colors.danger : theme.colors.border);
        e.currentTarget.style.color = accent ? theme.colors.accent : (danger ? theme.colors.danger : (active ? theme.colors.text : theme.colors.textSecondary));
      }}
    >
      {children}
    </button>
  );
}

export default function ControlBar() {
  const {
    ego, goal, isRunning, isAnimating, activePlanners, vehicles, lanes, bounds,
    cityMap, simMode, primaryPlanner, plannerResults,
    setRunning, setAnimating, setPlannerResults, setSimMode,
    reset, viewMode, setViewMode,
  } = useStore();

  const isSimulating = simMode === 'simulating';
  const isDone = simMode === 'done';

  const handlePlan = async () => {
    if (!ego || !goal) return;
    if (isRunning || isAnimating || isSimulating) return;

    setRunning(true);
    try {
      const roads = cityMap ? cityToRoadRects(cityMap) : undefined;
      const results = await runPlanners(
        { x: ego.x, y: ego.y, heading: ego.heading },
        { x: goal.x, y: goal.y, heading: goal.heading },
        vehicles,
        lanes,
        bounds,
        activePlanners,
        roads
      );
      setPlannerResults(results);
      setAnimating(true);
      getPathAnimator().startAnimation(results);
    } finally {
      setRunning(false);
    }
  };

  const handleSimulate = () => {
    if (!ego || !goal || isSimulating) return;

    // Find the primary planner's result
    const result = plannerResults.find(r => r.algorithm === primaryPlanner);
    if (!result || !result.metrics.success) return;

    // Start simulation engine
    const engine = getSimEngine();
    engine.start(vehicles, result.path);
    setSimMode('simulating');
  };

  const handleStop = () => {
    getSimEngine().stop();
    setSimMode('idle');
  };

  const handleReset = () => {
    getSimEngine().stop();
    getPathAnimator().clear();
    reset();
  };

  const hasPlan = plannerResults.some(r => r.algorithm === primaryPlanner && r.metrics.success);

  return (
    <div style={styles.bar}>
      <div style={styles.group}>
        <ToolButton accent onClick={handlePlan} disabled={isSimulating}>
          <Play size={12} /> {isRunning ? 'PLANNING...' : 'PLAN'}
        </ToolButton>

        {isSimulating ? (
          <ToolButton danger onClick={handleStop}>
            <StopCircle size={12} /> STOP
          </ToolButton>
        ) : (
          <ToolButton
            active={hasPlan}
            onClick={handleSimulate}
            disabled={!hasPlan}
          >
            <Zap size={12} /> SIMULATE
          </ToolButton>
        )}

        <ToolButton onClick={handleReset}>
          <RotateCcw size={12} /> RESET
        </ToolButton>

        <div style={styles.divider} />

        <ToolButton onClick={() => setInteractionMode('place-ego')} disabled={isSimulating}>
          <Car size={12} /> EGO
        </ToolButton>
        <ToolButton onClick={() => setInteractionMode('place-goal')} disabled={isSimulating}>
          <Waypoints size={12} /> GOAL
        </ToolButton>
        <ToolButton onClick={() => setInteractionMode('place-obstacle')} disabled={isSimulating}>
          <Square size={12} /> OBSTACLE
        </ToolButton>
      </div>

      <div style={styles.group}>
        {isDone && (
          <span style={{
            fontFamily: theme.fonts.mono,
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '0.08em',
            color: theme.colors.success,
            textTransform: 'uppercase',
          }}>
            ARRIVED
          </span>
        )}
        <ToolButton
          active={viewMode === 'pm'}
          onClick={() => setViewMode(viewMode === 'sim' ? 'pm' : 'sim')}
        >
          <BarChart3 size={12} /> PM VIEW
        </ToolButton>
      </div>
    </div>
  );
}
