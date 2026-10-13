import { useStore } from '../state/store';
import { theme } from '../styles/theme';

export type AppMode = 'planner' | 'city';

const styles = {
  header: {
    height: 48,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 20px',
    background: theme.colors.surface,
    borderBottom: `1px solid ${theme.colors.border}`,
    flexShrink: 0,
  } as React.CSSProperties,
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: 24,
  } as React.CSSProperties,
  title: {
    fontFamily: theme.fonts.display,
    fontWeight: 300,
    fontSize: 16,
    color: theme.colors.text,
    letterSpacing: '0.12em',
  } as React.CSSProperties,
  modeGroup: {
    display: 'flex',
    border: `1px solid ${theme.colors.border}`,
    borderRadius: 3,
    overflow: 'hidden',
  } as React.CSSProperties,
  modeBtn: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: '0.1em',
    textTransform: 'uppercase' as const,
    color: theme.colors.textSecondary,
    background: 'transparent',
    border: 'none',
    padding: '6px 14px',
    cursor: 'pointer',
    transition: theme.transitions.fast,
  } as React.CSSProperties,
  modeBtnActive: {
    color: theme.colors.base,
    background: theme.colors.accent,
  } as React.CSSProperties,
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
  } as React.CSSProperties,
  label: {
    fontFamily: theme.fonts.mono,
    fontSize: 10,
    fontWeight: 500,
    letterSpacing: '0.08em',
    textTransform: 'uppercase' as const,
    color: theme.colors.textSecondary,
  } as React.CSSProperties,
  scenarioBtn: {
    fontFamily: theme.fonts.mono,
    fontSize: 11,
    fontWeight: 400,
    color: theme.colors.text,
    background: theme.colors.surfaceRaised,
    // Non-shorthand border: hover handlers mutate borderColor (React 19
    // errors on shorthand/longhand conflicts across rerenders).
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: theme.colors.border,
    borderRadius: 2,
    padding: '4px 12px',
    cursor: 'pointer',
    transition: theme.transitions.fast,
    letterSpacing: '0.04em',
  } as React.CSSProperties,
};

interface Props {
  mode: AppMode;
  onModeChange: (m: AppMode) => void;
}

export default function Header({ mode, onModeChange }: Props) {
  const currentScenario = useStore(s => s.currentScenario);

  return (
    <div style={styles.header}>
      <div style={styles.left}>
        <span style={styles.title}>AV PLANNER SIM</span>
        <div style={styles.modeGroup}>
          <button
            style={{ ...styles.modeBtn, ...(mode === 'planner' ? styles.modeBtnActive : {}) }}
            onClick={() => onModeChange('planner')}
          >
            Planner Lab
          </button>
          <button
            style={{ ...styles.modeBtn, ...(mode === 'city' ? styles.modeBtnActive : {}) }}
            onClick={() => onModeChange('city')}
          >
            City Command
          </button>
        </div>
      </div>
      {mode === 'planner' && (
        <div style={styles.right}>
          <span style={styles.label}>SCENARIO</span>
          <button
            style={styles.scenarioBtn}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = theme.colors.borderActive;
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = theme.colors.border;
            }}
          >
            {currentScenario || 'Free Place'} ▾
          </button>
        </div>
      )}
    </div>
  );
}
