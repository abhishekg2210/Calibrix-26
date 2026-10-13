import { theme } from '../../styles/theme';
import { PanelApi } from './panelTypes';
import Sparkline from './Sparkline';

/**
 * Experiments tab: interventions (closures, signal retiming, AV fleet share)
 * and A/B run comparison against a saved baseline.
 */
export default function LabTab({ api }: { api: PanelApi }) {
  const lab = api.lab;
  const live = api.history;
  const base = lab.baseline;

  return (
    <>
      <div style={S.sectionTitle}>RUN CONTROL</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button style={S.btn} onClick={lab.openConfig}>NEW CITY…</button>
        <button style={S.btn} onClick={lab.restartRun}>RESTART RUN</button>
        <button style={S.btn} onClick={lab.exportCsv}>EXPORT CSV</button>
      </div>

      <div style={S.sectionTitle}>A/B COMPARISON</div>
      {!base ? (
        <>
          <div style={S.desc}>
            Run a scenario, save it as the baseline, then RESTART (same seed),
            apply interventions, and compare the curves.
          </div>
          <button style={{ ...S.btn, marginTop: 8 }} onClick={lab.saveBaseline}>SAVE CURRENT AS BASELINE</button>
        </>
      ) : (
        <>
          <div style={S.row}>
            <span style={S.rowLabel}>BASELINE</span>
            <span style={S.rowValue}>{base.samples.length} samples · {base.configSummary}</span>
          </div>
          <CompareChart label="DELAY INDEX" k="delayIndex" api={api} />
          <CompareChart label="NETWORK SPEED (KM/H)" k="avgSpeedKmh" api={api} />
          <CompareChart label="ACTIVE VEHICLES" k="activeVehicles" api={api} />
          <CompareChart label="THROUGHPUT (TRIPS/MIN)" k="throughputPerMin" api={api} />
          <DeltaTable api={api} />
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={S.btn} onClick={lab.saveBaseline}>OVERWRITE BASELINE</button>
            <button style={S.btn} onClick={lab.clearBaseline}>CLEAR</button>
          </div>
        </>
      )}
      {base === null && live.samples.length < 10 && (
        <div style={S.desc}>Let the sim run a while before saving a baseline.</div>
      )}

      <div style={S.sectionTitle}>ROAD CLOSURES</div>
      <label style={{ ...S.toggleRow, ...(lab.closeMode ? S.toggleActive : {}) }}>
        <input
          type="checkbox"
          checked={lab.closeMode}
          onChange={e => lab.setCloseMode(e.target.checked)}
          style={{ accentColor: theme.colors.danger }}
        />
        <span style={S.rowLabel}>CLOSURE MODE — click roads on the map to close them</span>
      </label>
      {lab.closedSegs.map(id => (
        <div key={id} style={S.row}>
          <span style={S.rowLabel}>SEGMENT #{id}</span>
          <button style={S.miniBtn} onClick={() => lab.reopenSeg(id)}>REOPEN</button>
        </div>
      ))}

      <div style={S.sectionTitle}>AV FLEET · {lab.avSharePct}%</div>
      <input
        type="range" min={0} max={50} step={1} value={lab.avSharePct}
        onChange={e => lab.setAvSharePct(Number(e.target.value))}
        style={{ width: '100%', accentColor: theme.colors.accent }}
      />
      <div style={S.desc}>
        Share of newly spawned vehicles that are AVs (teal) — tighter headways,
        smoother profiles, planner-routed. Fleet KPIs on the KPIS tab.
      </div>

      <div style={S.sectionTitle}>SIGNAL TIMING (ALL INTERSECTIONS)</div>
      <SignalSlider label="N-S GREEN" value={api.lab.signal.nsStraightS} min={6} max={30}
        onChange={v => lab.setSignal({ ...lab.signal, nsStraightS: v })} />
      <SignalSlider label="E-W GREEN" value={api.lab.signal.ewStraightS} min={6} max={30}
        onChange={v => lab.setSignal({ ...lab.signal, ewStraightS: v })} />
      <SignalSlider label="LEFT PHASES" value={api.lab.signal.nsLeftS} min={2} max={12}
        onChange={v => lab.setSignal({ ...lab.signal, nsLeftS: v, ewLeftS: v })} />
      <div style={S.desc}>Asymmetric greens favor one axis — try it with a closure on the other.</div>
    </>
  );
}

function CompareChart({ label, k, api }: { label: string; k: 'delayIndex' | 'avgSpeedKmh' | 'activeVehicles' | 'throughputPerMin'; api: PanelApi }) {
  const base = api.lab.baseline!;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={S.chartLabel}>{label} <span style={{ color: theme.colors.textMuted }}>— gray = baseline</span></div>
      <Sparkline data={api.history.series(k)} baseline={base.samples.map(s => s[k] as number)} />
    </div>
  );
}

function DeltaTable({ api }: { api: PanelApi }) {
  const base = api.lab.baseline!;
  const cur = api.history.samples;
  if (cur.length < 5 || base.samples.length < 5) return null;
  const tail = (arr: number[]) => {
    const n = Math.min(20, arr.length);
    let s = 0;
    for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
    return s / n;
  };
  const rows: Array<{ label: string; k: 'delayIndex' | 'avgSpeedKmh' | 'activeVehicles' | 'throughputPerMin'; fmt: (v: number) => string; lowerBetter: boolean }> = [
    { label: 'DELAY INDEX', k: 'delayIndex', fmt: v => v.toFixed(2), lowerBetter: true },
    { label: 'SPEED', k: 'avgSpeedKmh', fmt: v => `${v.toFixed(1)} km/h`, lowerBetter: false },
    { label: 'THROUGHPUT', k: 'throughputPerMin', fmt: v => `${v.toFixed(1)}/min`, lowerBetter: false },
  ];
  return (
    <div style={{ marginBottom: 10 }}>
      {rows.map(r => {
        const b = tail(base.samples.map(s => s[r.k] as number));
        const c = tail(cur.map(s => s[r.k] as number));
        const delta = c - b;
        const good = r.lowerBetter ? delta < 0 : delta > 0;
        return (
          <div key={r.k} style={S.row}>
            <span style={S.rowLabel}>{r.label}</span>
            <span style={{ ...S.rowValue, color: Math.abs(delta) < 1e-3 ? theme.colors.text : good ? theme.colors.success : theme.colors.danger }}>
              {r.fmt(c)} ({delta >= 0 ? '+' : ''}{r.fmt(delta).replace(' km/h', '').replace('/min', '')})
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SignalSlider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={S.chartLabel}>{label} · {value.toFixed(0)}s</div>
      <input
        type="range" min={min} max={max} step={1} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: theme.colors.accent }}
      />
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  sectionTitle: {
    fontFamily: theme.fonts.mono, fontSize: 9, letterSpacing: '0.12em',
    color: theme.colors.textSecondary, margin: '16px 0 8px',
  },
  chartLabel: { fontFamily: theme.fonts.mono, fontSize: 8, letterSpacing: '0.1em', color: theme.colors.textMuted, marginBottom: 3 },
  desc: { fontFamily: theme.fonts.mono, fontSize: 9, color: theme.colors.textMuted, marginTop: 4, lineHeight: 1.5 },
  row: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px',
    background: theme.colors.surfaceRaised, borderRadius: 2, marginBottom: 4,
  },
  rowLabel: { fontFamily: theme.fonts.mono, fontSize: 9, color: theme.colors.textSecondary, letterSpacing: '0.06em' },
  rowValue: { fontFamily: theme.fonts.mono, fontSize: 10, color: theme.colors.text },
  btn: {
    fontFamily: theme.fonts.mono, fontSize: 9, letterSpacing: '0.08em',
    color: theme.colors.text, background: theme.colors.surfaceRaised,
    border: `1px solid ${theme.colors.border}`, borderRadius: 2, padding: '6px 10px', cursor: 'pointer',
  },
  miniBtn: {
    fontFamily: theme.fonts.mono, fontSize: 8, letterSpacing: '0.06em',
    color: theme.colors.accent, background: 'transparent',
    border: `1px solid ${theme.colors.border}`, borderRadius: 2, padding: '3px 8px', cursor: 'pointer',
  },
  toggleRow: {
    display: 'flex', gap: 10, alignItems: 'center', padding: '8px',
    borderRadius: 3, cursor: 'pointer',
  },
  toggleActive: { background: 'rgba(224,92,92,0.08)' },
};
