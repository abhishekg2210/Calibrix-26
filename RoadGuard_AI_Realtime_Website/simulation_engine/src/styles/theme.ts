export const theme = {
  colors: {
    base: '#0c0e14',
    surface: '#141620',
    surfaceRaised: '#1a1d2a',
    border: '#252a3a',
    borderActive: '#4a9ead',
    accent: '#5bb8c9',
    accentActive: '#7ad4e4',
    accentSubtle: 'rgba(91,184,201,0.08)',
    text: '#e8ecf1',
    textSecondary: '#8891a4',
    textMuted: '#505868',
    pathA: '#5bb8c9',
    pathB: '#6ee7a0',
    pathC: '#c084fc',
    pathD: '#e8ecf1',
    obstacle: '#e8a44a',
    danger: '#e05c5c',
    success: '#5cb886',
    city: {
      roadSurface: '#1a1c22',
      intersection: '#1e2028',
      buildingFill: '#161824',
      buildingBorder: '#1e2230',
      laneMarking: '#e8ecf1',
      crosswalk: '#e8ecf1',
      sidewalk: '#12141c',
    },
  },
  fonts: {
    display: "'Outfit', sans-serif",
    mono: "'IBM Plex Mono', monospace",
  },
  radii: {
    panel: '4px',
    button: '2px',
  },
  transitions: {
    fast: '150ms ease-out',
  },
} as const;

export type Theme = typeof theme;
