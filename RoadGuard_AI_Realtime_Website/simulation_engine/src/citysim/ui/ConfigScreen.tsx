import { useState } from 'react';
import { theme } from '../../styles/theme';
import { CityConfig, defaultCityConfig } from '../config';

/**
 * Pre-run configuration: city size, demand, AV share, seed. Shown before the
 * first launch and via NEW CITY in the Lab tab.
 */

const DEMAND_PRESETS = [
  { label: 'LIGHT', value: 0.6, desc: 'Quiet suburb energy' },
  { label: 'NORMAL', value: 1.0, desc: 'Calibrated to network capacity' },
  { label: 'HEAVY', value: 1.5, desc: 'Sustained congestion' },
  { label: 'CRUSH', value: 2.2, desc: 'Deliberate overload — watch it grind' },
];

interface Props {
  initial: CityConfig;
  onLaunch: (cfg: CityConfig) => void;
  onCancel: (() => void) | null;
}

export default function ConfigScreen({ initial, onLaunch, onCancel }: Props) {
  const [size, setSize] = useState(initial.rows);
  const [demand, setDemand] = useState(initial.demandScale);
  const [avPct, setAvPct] = useState(Math.round(initial.avShare * 100));
  const [seed, setSeed] = useState(initial.seed);
  const [startHour, setStartHour] = useState(initial.startHour);

  const launch = () => {
    onLaunch(defaultCityConfig({
      rows: size,
      cols: size,
      demandScale: demand,
      avShare: avPct / 100,
      seed,
      startHour,
      // Scale agent caps with city area (20x20 = 1x).
      maxVehicles: Math.round(4000 * (size * size) / 400),
      maxPedestrians: Math.round(6000 * (size * size) / 400),
    }));
  };

  return (
    <div style={S.backdrop}>
      <div style={S.card}>
        <div style={S.title}>CITY CONFIGURATION</div>

        <div style={S.label}>GRID SIZE · {size}×{size} BLOCKS ({(size * size).toLocaleString()} blocks, {((size + 1) ** 2).toLocaleString()} intersections)</div>
        <input type="range" min={8} max={28} step={1} value={size}
          onChange={e => setSize(Number(e.target.value))} style={S.slider} />

        <div style={S.label}>DEMAND</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {DEMAND_PRESETS.map(p => (
            <button key={p.label}
              style={{ ...S.preset, ...(Math.abs(demand - p.value) < 0.01 ? S.presetActive : {}) }}
              onClick={() => setDemand(p.value)}
              title={p.desc}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div style={S.desc}>{DEMAND_PRESETS.find(p => Math.abs(demand - p.value) < 0.01)?.desc ?? `${demand.toFixed(1)}× custom`}</div>

        <div style={S.label}>AV FLEET SHARE · {avPct}%</div>
        <input type="range" min={0} max={50} step={1} value={avPct}
          onChange={e => setAvPct(Number(e.target.value))} style={S.slider} />

        <div style={S.label}>START TIME · {String(Math.floor(startHour)).padStart(2, '0')}:{String(Math.round((startHour % 1) * 60)).padStart(2, '0')}</div>
        <input type="range" min={0} max={23.5} step={0.5} value={startHour}
          onChange={e => setStartHour(Number(e.target.value))} style={S.slider} />

        <div style={S.label}>SEED · {seed}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="number" value={seed}
            onChange={e => setSeed(Number(e.target.value) || 1)}
            style={S.seedInput}
          />
          <button style={S.preset} onClick={() => setSeed(Math.floor(1 + Math.random() * 99999))}>RANDOMIZE</button>
        </div>
        <div style={S.desc}>Same seed + same config = identical run. The foundation of honest A/B tests.</div>

        <div style={{ display: 'flex', gap: 8, marginTop: 22 }}>
          <button style={S.launch} onClick={launch}>LAUNCH CITY</button>
          {onCancel && <button style={S.cancel} onClick={onCancel}>CANCEL</button>}
        </div>
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(12,14,20,0.88)', backdropFilter: 'blur(4px)', zIndex: 10,
  },
  card: {
    width: 420, background: theme.colors.surface, border: `1px solid ${theme.colors.border}`,
    borderRadius: 6, padding: '24px 28px 28px',
  },
  title: {
    fontFamily: theme.fonts.display, fontSize: 15, fontWeight: 300, letterSpacing: '0.14em',
    color: theme.colors.text, marginBottom: 6,
  },
  label: {
    fontFamily: theme.fonts.mono, fontSize: 9, letterSpacing: '0.1em',
    color: theme.colors.textSecondary, margin: '16px 0 6px',
  },
  slider: { width: '100%', accentColor: theme.colors.accent },
  preset: {
    fontFamily: theme.fonts.mono, fontSize: 9, letterSpacing: '0.06em',
    color: theme.colors.textSecondary, background: 'transparent',
    border: `1px solid ${theme.colors.border}`, borderRadius: 2, padding: '6px 10px', cursor: 'pointer',
  },
  presetActive: { color: theme.colors.base, background: theme.colors.accent, borderColor: theme.colors.accent },
  desc: { fontFamily: theme.fonts.mono, fontSize: 9, color: theme.colors.textMuted, marginTop: 5, lineHeight: 1.5 },
  seedInput: {
    fontFamily: theme.fonts.mono, fontSize: 11, color: theme.colors.text,
    background: theme.colors.surfaceRaised, border: `1px solid ${theme.colors.border}`,
    borderRadius: 2, padding: '5px 8px', width: 110,
  },
  launch: {
    fontFamily: theme.fonts.mono, fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
    color: theme.colors.base, background: theme.colors.accent, border: 'none',
    borderRadius: 3, padding: '10px 22px', cursor: 'pointer',
  },
  cancel: {
    fontFamily: theme.fonts.mono, fontSize: 10, letterSpacing: '0.08em',
    color: theme.colors.textSecondary, background: 'transparent',
    border: `1px solid ${theme.colors.border}`, borderRadius: 3, padding: '10px 16px', cursor: 'pointer',
  },
};
