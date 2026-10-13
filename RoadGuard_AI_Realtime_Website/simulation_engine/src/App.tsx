import { lazy, Suspense, useEffect, useState } from 'react';
import Header, { AppMode } from './components/Header';
import ControlBar from './components/ControlBar';
import PlannerPanel from './components/PlannerPanel';
import ErrorBoundary from './components/ErrorBoundary';
import SimulationCanvas from './canvas/SimulationCanvas';
import { useStore } from './state/store';
import { theme } from './styles/theme';

// City Command pulls in three.js — only load it when the mode opens.
const CityCommand = lazy(() => import('./citysim/CityCommand'));

const styles = {
  app: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100vh',
    width: '100vw',
    background: theme.colors.base,
    overflow: 'hidden',
  },
  body: {
    flex: 1,
    display: 'flex',
    overflow: 'hidden',
  },
  canvasArea: {
    flex: 1,
    position: 'relative' as const,
    overflow: 'hidden',
  },
  suspense: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: theme.fonts.mono,
    fontSize: 12,
    letterSpacing: '0.2em',
    color: theme.colors.textSecondary,
  },
};

export default function App() {
  const loadCityScenario = useStore(s => s.loadCityScenario);
  const [mode, setMode] = useState<AppMode>('planner');

  useEffect(() => {
    loadCityScenario();
  }, [loadCityScenario]);

  return (
    <div style={styles.app}>
      <Header mode={mode} onModeChange={setMode} />
      {mode === 'planner' ? (
        <>
          <div style={styles.body}>
            <div style={styles.canvasArea}>
              <SimulationCanvas />
            </div>
            <PlannerPanel />
          </div>
          <ControlBar />
        </>
      ) : (
        <div style={styles.body}>
          <ErrorBoundary label="CITY COMMAND">
            <Suspense fallback={<div style={styles.suspense}>LOADING CITY COMMAND…</div>}>
              <CityCommand />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
}
