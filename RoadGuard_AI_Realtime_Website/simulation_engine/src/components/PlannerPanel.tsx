import { useStore } from '../state/store';
import { PlannerResult, PlannerAlgorithm } from '../planners/types';
import { theme } from '../styles/theme';

const PLANNER_INFO: Record<PlannerAlgorithm, { name: string; fullName: string }> = {
  astar: { name: 'A*', fullName: 'A* Grid Search' },
  rrt: { name: 'RRT*', fullName: 'RRT* Sampling' },
  lattice: { name: 'LATTICE', fullName: 'Lattice Planner' },
  learned: { name: 'LEARNED', fullName: 'Neural Cost Field' },
};

const styles = {
  panel: {
    width: 260,
    background: theme.colors.surface,
    borderLeft: `1px solid ${theme.colors.border}`,
    overflowY: 'auto' as const,
    flexShrink: 0,
  } as React.CSSProperties,
  section: {
    padding: '14px 16px',
    borderBottom: `1px solid ${theme.colors.border}`,
  } as React.CSSProperties,
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  } as React.CSSProperties,
  plannerName: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
  } as React.CSSProperties,
  metricRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '3px 0',
  } as React.CSSProperties,
  metricLabel: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
    color: theme.colors.textSecondary,
  } as React.CSSProperties,
  metricValue: {
    fontFamily: theme.fonts.mono,
    fontSize: 13,
    fontWeight: 400,
    color: theme.colors.text,
  } as React.CSSProperties,
  colorDot: (color: string) => ({
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  } as React.CSSProperties),
  noData: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    color: theme.colors.textMuted,
    letterSpacing: '0.06em',
    textTransform: 'uppercase' as const,
  } as React.CSSProperties,
  toggle: {
    width: 14,
    height: 14,
    borderRadius: 2,
    border: `1px solid ${theme.colors.border}`,
    background: 'transparent',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 9,
    color: theme.colors.accent,
    padding: 0,
  } as React.CSSProperties,
};

function PlannerSection({
  alg,
  result,
  isActive,
  isPrimary,
  onToggle,
  onSelectPrimary,
}: {
  alg: PlannerAlgorithm;
  result?: PlannerResult;
  isActive: boolean;
  isPrimary: boolean;
  onToggle: () => void;
  onSelectPrimary: () => void;
}) {
  const info = PLANNER_INFO[alg];
  const color = result?.color || theme.colors.textMuted;

  return (
    <div
      style={{
        ...styles.section,
        opacity: isActive ? 1 : 0.4,
        borderLeft: isPrimary ? `2px solid ${theme.colors.accent}` : '2px solid transparent',
        cursor: 'pointer',
      }}
      onClick={onSelectPrimary}
    >
      <div style={styles.sectionHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={styles.colorDot(color)} />
          <span style={{ ...styles.plannerName, color }}>{info.name}</span>
        </div>
        <button
          style={{
            ...styles.toggle,
            borderColor: isActive ? theme.colors.borderActive : theme.colors.border,
            background: isActive ? theme.colors.accentSubtle : 'transparent',
          }}
          onClick={onToggle}
          title={isActive ? 'Disable planner' : 'Enable planner'}
        >
          {isActive ? '✓' : ''}
        </button>
      </div>

      <div style={{ ...styles.metricLabel, marginBottom: 8, fontSize: 9, color: theme.colors.textMuted }}>
        {info.fullName}
      </div>

      {result && result.metrics.success ? (
        <>
          <Metric label="Path Length" value={`${result.metrics.pathLengthMeters.toFixed(1)}m`} />
          <Metric label="Compute" value={`${result.metrics.computeTimeMs.toFixed(1)}ms`} />
          <Metric label="Smoothness" value={result.metrics.smoothness.toFixed(2)} />
          <Metric label="Safety Margin" value={`${result.metrics.safetyMarginMeters.toFixed(1)}m`} />
          <Metric label="Nodes" value={result.metrics.nodesExplored.toLocaleString()} />
        </>
      ) : result && !result.metrics.success ? (
        <span style={{ ...styles.noData, color: theme.colors.danger }}>NO PATH FOUND</span>
      ) : (
        <span style={styles.noData}>AWAITING RUN</span>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={styles.metricRow}>
      <span style={styles.metricLabel}>{label}</span>
      <span style={styles.metricValue}>{value}</span>
    </div>
  );
}

export default function PlannerPanel() {
  const activePlanners = useStore(s => s.activePlanners);
  const plannerResults = useStore(s => s.plannerResults);
  const togglePlanner = useStore(s => s.togglePlanner);
  const primaryPlanner = useStore(s => s.primaryPlanner);
  const setPrimaryPlanner = useStore(s => s.setPrimaryPlanner);

  const allAlgs: PlannerAlgorithm[] = ['astar', 'rrt', 'lattice', 'learned'];

  return (
    <div style={styles.panel}>
      {allAlgs.map(alg => (
        <PlannerSection
          key={alg}
          alg={alg}
          result={plannerResults.find(r => r.algorithm === alg)}
          isActive={activePlanners.includes(alg)}
          isPrimary={primaryPlanner === alg}
          onToggle={() => togglePlanner(alg)}
          onSelectPrimary={() => setPrimaryPlanner(alg)}
        />
      ))}
    </div>
  );
}
