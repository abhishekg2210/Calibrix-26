import { useEffect, useRef } from 'react';
import { theme } from '../../styles/theme';
import { demandIntensity } from '../engine/demand';
import Sparkline from './Sparkline';
import LabTab from './LabTab';
import { PanelApi, HeatmapMode, TABS } from './panelTypes';

export default function CommandPanel({ api }: { api: PanelApi }) {
  const { tab, setTab } = api;

  return (
    <div style={S.panel}>
      <div style={S.tabs}>
        {TABS.map(t => (
          <button key={t} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div style={S.body}>
        {tab === 'KPIS' && <KpisTab api={api} />}
        {tab === 'HEATMAP' && <HeatmapTab api={api} />}
        {tab === 'TIME' && <TimeTab api={api} />}
        {tab === 'INSPECT' && <InspectTab api={api} />}
        {tab === 'LAB' && <LabTab api={api} />}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ KPIS

function KpisTab({ api }: { api: PanelApi }) {
  const s = api.stats?.stats;
  const h = api.history;
  if (!s) return <Hint text="WAITING FOR DATA" />;

  const bottlenecks = topQueues(api);

  return (
    <>
      <div style={S.kpiGrid}>
        <Kpi label="VEHICLES" value={s.activeVehicles.toLocaleString()} />
        <Kpi label="PEDESTRIANS" value={s.activePeds.toLocaleString()} />
        <Kpi label="AVG SPEED" value={`${(s.avgSpeed * 3.6).toFixed(1)} km/h`} />
        <Kpi label="DELAY INDEX" value={`${s.delayIndex.toFixed(2)}×`} />
        <Kpi label="TRIPS DONE" value={s.arrivals.toLocaleString()} />
        <Kpi label="AVG TRIP" value={`${(s.avgTripS / 60).toFixed(1)} min`} />
      </div>

      <Chart label="ACTIVE VEHICLES" data={h.series('activeVehicles')} color={theme.colors.accent} />
      <Chart label="ACTIVE PEDESTRIANS" data={h.series('activePeds')} color={theme.colors.pathC} />
      <Chart label="NETWORK SPEED (KM/H)" data={h.series('avgSpeedKmh')} color={theme.colors.pathB} />
      <Chart label="THROUGHPUT (TRIPS/MIN)" data={h.series('throughputPerMin')} color={theme.colors.obstacle} />

      {s.avArrivals > 5 && (
        <>
          <div style={S.sectionTitle}>AV FLEET VS HUMAN DRIVERS</div>
          <div style={S.row}>
            <span style={S.rowLabel}>ACTIVE AVS</span>
            <span style={S.rowValue}>{s.activeAVs.toLocaleString()}</span>
          </div>
          <div style={S.row}>
            <span style={S.rowLabel}>AV DELAY INDEX</span>
            <span style={{ ...S.rowValue, color: theme.colors.accent }}>{s.avDelayIndex.toFixed(2)}×</span>
          </div>
          <div style={S.row}>
            <span style={S.rowLabel}>HUMAN DELAY INDEX</span>
            <span style={S.rowValue}>{s.humanDelayIndex.toFixed(2)}×</span>
          </div>
          <div style={S.row}>
            <span style={S.rowLabel}>AV ADVANTAGE</span>
            <span style={{ ...S.rowValue, color: s.humanDelayIndex >= s.avDelayIndex ? theme.colors.success : theme.colors.danger }}>
              {(((s.humanDelayIndex - s.avDelayIndex) / Math.max(0.01, s.humanDelayIndex)) * 100).toFixed(1)}% less delay
            </span>
          </div>
        </>
      )}

      <div style={S.sectionTitle}>WORST BOTTLENECKS</div>
      {bottlenecks.length === 0 && <Hint text="NO QUEUES DETECTED" />}
      {bottlenecks.map(b => (
        <div key={b.id} style={S.row}>
          <span style={S.rowLabel}>INT {b.label}</span>
          <span style={S.rowValue}>{b.queue} queued</span>
        </div>
      ))}
    </>
  );
}

function topQueues(api: PanelApi): Array<{ id: number; label: string; queue: number }> {
  const q = api.stats?.interQueue;
  if (!q) return [];
  const inters = api.scene.model.intersections;
  const idx = Array.from(q.keys());
  idx.sort((a, b) => q[b] - q[a]);
  return idx.slice(0, 5).filter(i => q[i] > 0).map(i => ({
    id: i,
    label: `${String.fromCharCode(65 + (inters[i].col % 26))}${inters[i].row}`,
    queue: q[i],
  }));
}

// ---------------------------------------------------------------- HEATMAP

function HeatmapTab({ api }: { api: PanelApi }) {
  const modes: Array<{ m: HeatmapMode; label: string; desc: string }> = [
    { m: 'none', label: 'NONE', desc: 'Plain city view' },
    { m: 'speed', label: 'TRAFFIC SPEED', desc: 'Road color: red = crawling, green = free flow' },
    { m: 'density', label: 'TRAFFIC DENSITY', desc: 'Road color: red = packed, green = empty' },
    { m: 'peds', label: 'PEDESTRIAN DENSITY', desc: 'Block color: violet = crowded sidewalks' },
  ];
  return (
    <>
      <div style={S.sectionTitle}>OVERLAY</div>
      {modes.map(x => (
        <label key={x.m} style={{ ...S.radioRow, ...(api.heatmapMode === x.m ? S.radioActive : {}) }}>
          <input
            type="radio"
            checked={api.heatmapMode === x.m}
            onChange={() => api.setHeatmapMode(x.m)}
            style={{ accentColor: theme.colors.accent }}
          />
          <div>
            <div style={S.rowLabel}>{x.label}</div>
            <div style={S.desc}>{x.desc}</div>
          </div>
        </label>
      ))}
      {(api.heatmapMode === 'speed' || api.heatmapMode === 'density') && (
        <div style={{ marginTop: 14 }}>
          <div style={S.sectionTitle}>LEGEND</div>
          <div style={S.legendBar} />
          <div style={S.legendLabels}>
            <span>{api.heatmapMode === 'speed' ? 'JAMMED' : 'PACKED'}</span>
            <span>{api.heatmapMode === 'speed' ? 'FREE FLOW' : 'EMPTY'}</span>
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ TIME

function TimeTab({ api }: { api: PanelApi }) {
  const hh = Math.floor(api.clockHour);
  const mm = Math.floor((api.clockHour - hh) * 60);
  return (
    <>
      <div style={S.bigClock}>{String(hh).padStart(2, '0')}:{String(mm).padStart(2, '0')}</div>
      <DemandCurve hour={api.clockHour} />

      <div style={S.sectionTitle}>SIMULATION SPEED</div>
      <div style={{ display: 'flex', gap: 6 }}>
        {[0, 1, 4, 16, 64].map(s => (
          <button
            key={s}
            style={{ ...S.speedBtn, ...(api.speed === s ? S.speedBtnActive : {}) }}
            onClick={() => api.setSpeed(s)}
          >
            {s === 0 ? 'PAUSE' : `${s}×`}
          </button>
        ))}
      </div>
      {api.stats && api.speed > 0 && api.stats.achievedSpeed < api.speed * 0.8 && (
        <div style={S.desc}>compute-bound: running ~{api.stats.achievedSpeed.toFixed(0)}×</div>
      )}

      <div style={S.sectionTitle}>DEMAND MULTIPLIER · {api.demandMult.toFixed(1)}×</div>
      <input
        type="range" min={0} max={3} step={0.1} value={api.demandMult}
        onChange={e => api.setDemandMult(Number(e.target.value))}
        style={{ width: '100%', accentColor: theme.colors.accent }}
      />
      <div style={S.desc}>1.0 = calibrated network capacity. Push higher to overload the grid.</div>
    </>
  );
}

function DemandCurve({ hour }: { hour: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const W = 280, H = 70;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = theme.colors.textMuted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let px = 0; px <= W; px++) {
      const h = (px / W) * 24;
      const v = demandIntensity(h) / 1.35;
      const y = H - 6 - v * (H - 14);
      if (px === 0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
    }
    ctx.stroke();
    // current time marker
    const mx = (hour / 24) * W;
    ctx.strokeStyle = theme.colors.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mx, 4); ctx.lineTo(mx, H - 4);
    ctx.stroke();
    ctx.fillStyle = theme.colors.textMuted;
    ctx.font = `8px ${theme.fonts.mono}`;
    ctx.fillText('0H', 2, H - 1);
    ctx.fillText('12H', W / 2 - 8, H - 1);
    ctx.fillText('24H', W - 18, H - 1);
  }, [hour]);
  return (
    <div style={{ marginTop: 10 }}>
      <div style={S.sectionTitle}>DEMAND CURVE (24H)</div>
      <canvas ref={ref} style={{ width: 280, height: 70 }} />
    </div>
  );
}

// --------------------------------------------------------------- INSPECT

function InspectTab({ api }: { api: PanelApi }) {
  const sel = api.selection;
  if (!sel) return <Hint text="CLICK AN INTERSECTION, ROAD, OR AGENT IN THE CITY" />;

  if (sel.kind === 'intersection') {
    const it = api.scene.model.intersections[sel.id];
    const q = api.stats?.interQueue?.[sel.id] ?? 0;
    const tp = api.stats?.interThroughput?.[sel.id] ?? 0;
    return (
      <>
        <div style={S.sectionTitle}>INTERSECTION {String.fromCharCode(65 + (it.col % 26))}{it.row}</div>
        <Row label="GRID" value={`row ${it.row} · col ${it.col}`} />
        <Row label="QUEUE" value={`${q} vehicles`} />
        <Row label="THROUGHPUT" value={`${tp.toLocaleString()} total`} />
        <button style={S.clearBtn} onClick={api.clearSelection}>CLEAR SELECTION</button>
      </>
    );
  }
  if (sel.kind === 'segment') {
    const seg = api.scene.segs[sel.id];
    const sp = api.stats?.segSpeeds?.[sel.id];
    const den = api.stats?.segDensity?.[sel.id];
    const dirName = ['EAST', 'SOUTH', 'WEST', 'NORTH'][seg.dir];
    return (
      <>
        <div style={S.sectionTitle}>ROAD SEGMENT #{seg.id}</div>
        <Row label="DIRECTION" value={dirName} />
        <Row label="LENGTH" value={`${seg.length.toFixed(0)} m · ${seg.lanes} lanes`} />
        <Row label="AVG SPEED" value={sp !== undefined ? `${(sp * 3.6).toFixed(1)} km/h` : '—'} />
        <Row label="DENSITY" value={den !== undefined ? `${den.toFixed(0)} veh/lane-km` : '—'} />
        <button style={S.clearBtn} onClick={api.clearSelection}>CLEAR SELECTION</button>
      </>
    );
  }
  // agent
  const a = api.agentInfo;
  return (
    <>
      <div style={S.sectionTitle}>{a ? a.kind.toUpperCase() : 'AGENT'} #{sel.id}</div>
      <Row label="SPEED" value={a ? `${a.speedKmh.toFixed(1)} km/h` : 'despawned'} />
      <label style={{ ...S.radioRow, marginTop: 8 }}>
        <input
          type="checkbox"
          checked={api.following}
          onChange={e => api.setFollowing(e.target.checked)}
          style={{ accentColor: theme.colors.accent }}
        />
        <span style={S.rowLabel}>FOLLOW CAMERA</span>
      </label>
      <button style={S.clearBtn} onClick={api.clearSelection}>CLEAR SELECTION</button>
    </>
  );
}

// ------------------------------------------------------------- primitives

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div style={S.kpi}>
      <div style={S.kpiValue}>{value}</div>
      <div style={S.kpiLabel}>{label}</div>
    </div>
  );
}

function Chart({ label, data, color }: { label: string; data: number[]; color: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={S.chartLabel}>{label}</div>
      <Sparkline data={data} color={color} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={S.row}>
      <span style={S.rowLabel}>{label}</span>
      <span style={S.rowValue}>{value}</span>
    </div>
  );
}

function Hint({ text }: { text: string }) {
  return <div style={S.hint}>{text}</div>;
}

const S: Record<string, React.CSSProperties> = {
  panel: {
    width: 320, flexShrink: 0, display: 'flex', flexDirection: 'column',
    background: theme.colors.surface, borderLeft: `1px solid ${theme.colors.border}`,
  },
  tabs: { display: 'flex', borderBottom: `1px solid ${theme.colors.border}` },
  tab: {
    flex: 1, fontFamily: theme.fonts.mono, fontSize: 9, letterSpacing: '0.08em',
    color: theme.colors.textSecondary, background: 'transparent', border: 'none',
    padding: '10px 0', cursor: 'pointer', borderBottom: '2px solid transparent',
  },
  tabActive: { color: theme.colors.accent, borderBottom: `2px solid ${theme.colors.accent}` },
  body: { flex: 1, overflowY: 'auto', padding: 14 },
  kpiGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 },
  kpi: {
    background: theme.colors.surfaceRaised, border: `1px solid ${theme.colors.border}`,
    borderRadius: 3, padding: '8px 10px',
  },
  kpiValue: { fontFamily: theme.fonts.mono, fontSize: 16, color: theme.colors.text, fontWeight: 600 },
  kpiLabel: { fontFamily: theme.fonts.mono, fontSize: 8, letterSpacing: '0.1em', color: theme.colors.textMuted, marginTop: 2 },
  sectionTitle: {
    fontFamily: theme.fonts.mono, fontSize: 9, letterSpacing: '0.12em',
    color: theme.colors.textSecondary, margin: '14px 0 8px',
  },
  chartLabel: { fontFamily: theme.fonts.mono, fontSize: 8, letterSpacing: '0.1em', color: theme.colors.textMuted, marginBottom: 3 },
  row: {
    display: 'flex', justifyContent: 'space-between', padding: '6px 8px',
    background: theme.colors.surfaceRaised, borderRadius: 2, marginBottom: 4,
  },
  rowLabel: { fontFamily: theme.fonts.mono, fontSize: 10, color: theme.colors.textSecondary, letterSpacing: '0.06em' },
  rowValue: { fontFamily: theme.fonts.mono, fontSize: 10, color: theme.colors.text },
  radioRow: {
    display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 8px',
    borderRadius: 3, cursor: 'pointer', marginBottom: 2,
  },
  radioActive: { background: theme.colors.accentSubtle },
  desc: { fontFamily: theme.fonts.mono, fontSize: 9, color: theme.colors.textMuted, marginTop: 2, lineHeight: 1.5 },
  legendBar: {
    height: 8, borderRadius: 2,
    background: 'linear-gradient(90deg, #e05c5c, #e8a44a, #5cb886)',
  },
  legendLabels: {
    display: 'flex', justifyContent: 'space-between',
    fontFamily: theme.fonts.mono, fontSize: 8, color: theme.colors.textMuted, marginTop: 3,
  },
  bigClock: {
    fontFamily: theme.fonts.mono, fontSize: 34, fontWeight: 600,
    color: theme.colors.accent, letterSpacing: '0.06em',
  },
  speedBtn: {
    fontFamily: theme.fonts.mono, fontSize: 10, color: theme.colors.textSecondary,
    background: 'transparent', border: `1px solid ${theme.colors.border}`, borderRadius: 2,
    padding: '5px 10px', cursor: 'pointer',
  },
  speedBtnActive: { color: theme.colors.base, background: theme.colors.accent, borderColor: theme.colors.accent },
  clearBtn: {
    marginTop: 12, fontFamily: theme.fonts.mono, fontSize: 9, letterSpacing: '0.08em',
    color: theme.colors.textSecondary, background: 'transparent',
    border: `1px solid ${theme.colors.border}`, borderRadius: 2, padding: '6px 12px', cursor: 'pointer',
  },
  hint: {
    fontFamily: theme.fonts.mono, fontSize: 10, color: theme.colors.textMuted,
    letterSpacing: '0.06em', lineHeight: 1.7, padding: '20px 8px', textAlign: 'center',
  },
};
