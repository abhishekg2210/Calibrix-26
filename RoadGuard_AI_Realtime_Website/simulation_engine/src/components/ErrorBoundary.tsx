import { Component, ReactNode } from 'react';
import { theme } from '../styles/theme';

interface Props {
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Containment for runtime failures in a mode — the rest of the app survives. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 12, fontFamily: theme.fonts.mono, color: theme.colors.textSecondary, padding: 40,
        }}>
          <div style={{ fontSize: 12, letterSpacing: '0.14em', color: theme.colors.danger }}>
            {this.props.label} CRASHED
          </div>
          <div style={{ fontSize: 10, maxWidth: 520, lineHeight: 1.6, textAlign: 'center' }}>
            {this.state.error.message}
          </div>
          {/* Chunk-load failures are cached by React.lazy — a state reset can
              never recover them, so reload the page outright. */}
          <button
            onClick={() => window.location.reload()}
            style={{
              fontFamily: theme.fonts.mono, fontSize: 10, letterSpacing: '0.08em',
              color: theme.colors.text, background: theme.colors.surfaceRaised,
              border: `1px solid ${theme.colors.border}`, borderRadius: 2,
              padding: '8px 16px', cursor: 'pointer',
            }}
          >
            RELOAD MODE
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
