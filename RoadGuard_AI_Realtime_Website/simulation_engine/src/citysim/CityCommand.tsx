import { useEffect, useRef, useState } from 'react';
import { defaultCityConfig, CityConfig, SignalTiming } from './config';
import { CitySimClient, InterpolatedAgents } from './engine/client';
import { CityScene } from './render/CityScene';
import { StatsMsg, StaticScene, KIND_AV, KIND_PED } from './engine/protocol';
import CommandPanel from './ui/CommandPanel';
import ConfigScreen from './ui/ConfigScreen';
import { HeatmapMode, Selection, AgentInfo, PanelApi, Tab } from './ui/panelTypes';
import { KpiHistory } from './ui/kpiHistory';
import { RunRecord, runToCsv, downloadCsv } from './ui/runStore';
import { theme } from '../styles/theme';

/**
 * City Command mode: 3D live city simulation + command center panel.
 * React renders the chrome; the sim worker and three.js scene live in refs.
 */
export default function CityCommand() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<CitySimClient | null>(null);
  const sceneRef = useRef<CityScene | null>(null);
  const agentsRef = useRef<InterpolatedAgents | null>(null);
  const selectionRef = useRef<Selection>(null);
  const followRef = useRef<{ on: boolean; id: number }>({ on: false, id: -1 });
  const heatmapModeRef = useRef<HeatmapMode>('none');
  const cfgRef = useRef<CityConfig>(defaultCityConfig());

  const [history] = useState(() => new KpiHistory());
  const [sceneData, setSceneData] = useState<StaticScene | null>(null);
  const [stats, setStats] = useState<StatsMsg | null>(null);
  const [clockHour, setClockHour] = useState(7.5);
  const [speed, setSpeed] = useState(1);
  const [demandMult, setDemandMultState] = useState(1);
  const [heatmapMode, setHeatmapModeState] = useState<HeatmapMode>('none');
  const [selection, setSelectionState] = useState<Selection>(null);
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [following, setFollowingState] = useState(false);
  const [tab, setTab] = useState<Tab>('KPIS');
  // Lab / experiments state
  const [configOpen, setConfigOpen] = useState(true);
  const [closeMode, setCloseModeState] = useState(false);
  const closeModeRef = useRef(false);
  const [closedSegs, setClosedSegs] = useState<number[]>([]);
  const closedSegsRef = useRef<number[]>([]);
  // cfg mirrors cfgRef for render-time reads (lint: no ref reads in render).
  const [cfg, setCfg] = useState<CityConfig>(() => defaultCityConfig());
  const [signal, setSignalState] = useState<SignalTiming>(() => defaultCityConfig().signal);
  const [avSharePct, setAvSharePctState] = useState(() => Math.round(defaultCityConfig().avShare * 100));
  const [baseline, setBaseline] = useState<RunRecord | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const host = hostRef.current!;
    const client = new CitySimClient();
    clientRef.current = client;
    let raf = 0;
    let lastT = performance.now();

    client.onStats = msg => {
      setStats(msg);
      history.push(msg);
      applyHeatmap(sceneRef.current, msg, heatmapModeRef.current);
      setAgentInfo(findAgentInfo(selectionRef.current, agentsRef.current));
    };

    client.onReady = () => {
      cancelAnimationFrame(raf);
      sceneRef.current?.dispose();
      const cfg = cfgRef.current;
      const scene = new CityScene(canvas, client.scene!, cfg.maxVehicles + cfg.maxPedestrians);
      sceneRef.current = scene;
      scene.resize(host.clientWidth, host.clientHeight);
      setSceneData(client.scene);
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__city = { scene, client };
      }

      lastT = performance.now();
      const loop = () => {
        raf = requestAnimationFrame(loop);
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastT) / 1000);
        lastT = now;
        const agents = client.sample(dt);
        if (agents) {
          agentsRef.current = agents;
          scene.setAgents(agents);
          scene.setClockHour(agents.clockHour);
          setClockHour(h => (Math.abs(h - agents.clockHour) > 0.02 ? agents.clockHour : h));
          updateFollowAndMarker(scene, agents, followRef.current);
        }
        scene.render();
      };
      loop();
    };

    const onResize = () => sceneRef.current?.resize(host.clientWidth, host.clientHeight);
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      sceneRef.current?.dispose();
      sceneRef.current = null;
      client.dispose();
      clientRef.current = null;
    };
  }, [history]);

  /** (Re)start a run with the given config — fresh sim, fresh history. */
  const launch = (newCfg: CityConfig) => {
    cfgRef.current = newCfg;
    setCfg(newCfg);
    setConfigOpen(false);
    history.clear();
    setStats(null);
    setSelectionState(null);
    selectionRef.current = null;
    followRef.current = { on: false, id: -1 };
    setClosedSegs([]);
    closedSegsRef.current = [];
    setCloseModeState(false);
    closeModeRef.current = false;
    setSignalState(newCfg.signal);
    setAvSharePctState(Math.round(newCfg.avShare * 100));
    setDemandMultState(1); // live multiplier on top of cfg.demandScale
    setSpeed(1);
    agentsRef.current = null;
    clientRef.current?.init(newCfg);
  };

  const setSelection = (sel: Selection) => {
    setSelectionState(sel);
    selectionRef.current = sel;
    setAgentInfo(findAgentInfo(sel, agentsRef.current));
  };

  // ----- selection via click (ignore drags) -----
  const downPos = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    downPos.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = downPos.current;
    downPos.current = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    const scene = sceneRef.current;
    const client = clientRef.current;
    if (!scene || !client?.scene) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    const pt = scene.pickGround(ndcX, ndcY);
    if (!pt) return;

    // Closure mode: clicks toggle road segments instead of inspecting.
    if (closeModeRef.current) {
      const sel = classifyPick(pt, client.scene, null);
      if (sel?.kind === 'segment') toggleSegClosed(sel.id);
      return;
    }

    const sel = classifyPick(pt, client.scene, agentsRef.current);
    setSelection(sel);
    setFollowingState(false);
    followRef.current = { on: false, id: sel?.kind === 'agent' ? sel.id : -1 };
    positionMarker(scene, sel, client.scene, agentsRef.current);
    if (sel) setTab('INSPECT');
  };

  const toggleSegClosed = (segId: number) => {
    const cur = closedSegsRef.current;
    const isClosed = cur.includes(segId);
    const next = isClosed ? cur.filter(s => s !== segId) : [...cur, segId];
    closedSegsRef.current = next;
    setClosedSegs(next);
    clientRef.current?.send({ type: 'setSegClosed', segId, closed: !isClosed });
    sceneRef.current?.setClosedSegs(next);
  };

  // ----- panel API -----
  const setHeatmapMode = (m: HeatmapMode) => {
    setHeatmapModeState(m);
    heatmapModeRef.current = m;
    applyHeatmap(sceneRef.current, stats, m);
  };
  const changeSpeed = (s: number) => {
    setSpeed(s);
    clientRef.current?.setSpeed(s);
  };
  const setDemandMult = (d: number) => {
    setDemandMultState(d);
    clientRef.current?.send({ type: 'setDemand', multiplier: d });
  };
  const clearSelection = () => {
    setSelection(null);
    followRef.current = { on: false, id: -1 };
    sceneRef.current?.setMarker(0, 0, false);
  };
  const setFollowing = (f: boolean) => {
    setFollowingState(f);
    followRef.current.on = f;
  };

  // ----- lab API -----
  const setCloseMode = (b: boolean) => {
    setCloseModeState(b);
    closeModeRef.current = b;
  };
  const setAvSharePct = (p: number) => {
    setAvSharePctState(p);
    clientRef.current?.send({ type: 'setAvShare', share: p / 100 });
  };
  const setSignal = (s: SignalTiming) => {
    setSignalState(s);
    clientRef.current?.send({ type: 'setSignalTiming', timing: s });
  };
  const configSummary = () => `${cfg.rows}×${cfg.cols} · seed ${cfg.seed}`;
  const saveBaseline = () => {
    setBaseline({
      label: 'baseline',
      samples: [...history.samples],
      final: stats?.stats ?? null,
      configSummary: configSummary(),
    });
  };
  const exportCsv = () => {
    let csv = runToCsv('current', history.samples);
    if (baseline) csv += '\n' + runToCsv('baseline', baseline.samples).split('\n').slice(1).join('\n');
    downloadCsv(`citysim-run-${cfgRef.current.seed}.csv`, csv);
  };

  const hh = Math.floor(clockHour);
  const mm = Math.floor((clockHour - hh) * 60);

  return (
    <div style={ui.layout}>
      <div ref={hostRef} style={ui.host}>
        <canvas
          ref={canvasRef}
          style={ui.canvas}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        />
        {!sceneData && !configOpen && <div style={ui.loading}>GENERATING CITY…</div>}
        {sceneData && (
          <div style={ui.hud}>
            <span style={ui.clock}>{String(hh).padStart(2, '0')}:{String(mm).padStart(2, '0')}</span>
            {stats && (
              <span style={ui.stat}>
                {stats.stats.activeVehicles.toLocaleString()} VEH · {stats.stats.activePeds.toLocaleString()} PED ·
                {' '}{(stats.stats.avgSpeed * 3.6).toFixed(0)} KM/H
              </span>
            )}
            {closeMode && <span style={{ ...ui.stat, color: theme.colors.danger }}>CLOSURE MODE</span>}
          </div>
        )}
        {configOpen && (
          <ConfigScreen
            initial={cfg}
            onLaunch={launch}
            onCancel={sceneData ? () => setConfigOpen(false) : null}
          />
        )}
      </div>
      {sceneData && (
        <CommandPanel api={{
          stats, history, scene: sceneData,
          heatmapMode, setHeatmapMode,
          speed, setSpeed: changeSpeed,
          demandMult, setDemandMult,
          selection, clearSelection, agentInfo,
          following, setFollowing,
          clockHour, tab, setTab,
          lab: {
            avSharePct, setAvSharePct,
            signal, setSignal,
            closeMode, setCloseMode,
            closedSegs,
            reopenSeg: toggleSegClosed,
            baseline, saveBaseline,
            clearBaseline: () => setBaseline(null),
            restartRun: () => launch({ ...cfgRef.current }),
            exportCsv,
            openConfig: () => setConfigOpen(true),
          },
        } satisfies PanelApi} />
      )}
    </div>
  );
}

function findAgentInfo(sel: Selection, agents: InterpolatedAgents | null): AgentInfo | null {
  if (sel?.kind !== 'agent' || !agents) return null;
  for (let i = 0; i < agents.count; i++) {
    if (agents.ids[i] === sel.id) {
      return {
        id: sel.id,
        kind: agents.kinds[i] === KIND_AV ? 'av' : agents.kinds[i] === KIND_PED ? 'ped' : 'car',
        speedKmh: agents.data[i * 4 + 3] * 3.6,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------- helpers

function applyHeatmap(scene: CityScene | null, msg: StatsMsg | null, mode: HeatmapMode) {
  if (!scene || !msg) return;
  if (mode === 'speed') {
    const v = msg.segSpeeds;
    const norm = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) norm[i] = Math.max(0, Math.min(1, (v[i] - 0.5) / 11.5));
    scene.setHeatmap(norm, 0, 1);
    scene.setBlockHeatmap(null, 1);
  } else if (mode === 'density') {
    const d = msg.segDensity;
    const norm = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) norm[i] = 1 - Math.max(0, Math.min(1, d[i] / 110));
    scene.setHeatmap(norm, 0, 1);
    scene.setBlockHeatmap(null, 1);
  } else if (mode === 'peds') {
    scene.setHeatmap(null, 0, 1);
    scene.setBlockHeatmap(msg.blockPeds, 25);
  } else {
    scene.setHeatmap(null, 0, 1);
    scene.setBlockHeatmap(null, 1);
  }
}

function classifyPick(
  pt: { x: number; y: number },
  scene: NonNullable<CitySimClient['scene']>,
  agents: InterpolatedAgents | null,
): Selection {
  // Agents first (smallest targets).
  if (agents) {
    let best = -1, bestD = 6;
    for (let i = 0; i < agents.count; i++) {
      const d = Math.hypot(agents.data[i * 4] - pt.x, agents.data[i * 4 + 1] - pt.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) return { kind: 'agent', id: agents.ids[best] };
  }
  // Intersections.
  const rw = scene.model.roadWidth;
  for (const it of scene.model.intersections) {
    if (Math.abs(it.x - pt.x) < rw * 0.7 && Math.abs(it.y - pt.y) < rw * 0.7) {
      return { kind: 'intersection', id: it.id };
    }
  }
  // Road segments (perpendicular distance to directed-half centerline).
  let bestSeg = -1, bestD = Infinity;
  for (const s of scene.segs) {
    const d = pointSegDist(pt.x, pt.y, s.ax, s.ay, s.bx, s.by);
    if (d < bestD) { bestD = d; bestSeg = s.id; }
  }
  if (bestSeg >= 0 && bestD < scene.model.laneWidth * 2) {
    return { kind: 'segment', id: bestSeg };
  }
  return null;
}

function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function positionMarker(
  scene: CityScene,
  sel: Selection,
  staticScene: NonNullable<CitySimClient['scene']>,
  agents: InterpolatedAgents | null,
) {
  if (!sel) { scene.setMarker(0, 0, false); return; }
  if (sel.kind === 'intersection') {
    const it = staticScene.model.intersections[sel.id];
    scene.setMarker(it.x, it.y, true, staticScene.model.roadWidth * 0.8);
  } else if (sel.kind === 'segment') {
    const s = staticScene.segs[sel.id];
    scene.setMarker((s.ax + s.bx) / 2, (s.ay + s.by) / 2, true, 9);
  } else if (agents) {
    for (let i = 0; i < agents.count; i++) {
      if (agents.ids[i] === sel.id) {
        scene.setMarker(agents.data[i * 4], agents.data[i * 4 + 1], true, 4);
        return;
      }
    }
  }
}

function updateFollowAndMarker(
  scene: CityScene,
  agents: InterpolatedAgents,
  follow: { on: boolean; id: number },
) {
  if (follow.id < 0) return;
  for (let i = 0; i < agents.count; i++) {
    if (agents.ids[i] === follow.id) {
      const x = agents.data[i * 4], y = agents.data[i * 4 + 1];
      scene.setMarker(x, y, true, 4);
      if (follow.on) {
        const t = scene.controls.target;
        const dx = x - t.x, dz = y - t.z;
        scene.camera.position.x += dx;
        scene.camera.position.z += dz;
        t.set(x, 0, y);
      }
      return;
    }
  }
  // Agent despawned: drop the marker.
  scene.setMarker(0, 0, false);
  follow.id = -1;
  follow.on = false;
}

const ui: Record<string, React.CSSProperties> = {
  layout: { display: 'flex', width: '100%', height: '100%', overflow: 'hidden' },
  host: { position: 'relative', flex: 1, overflow: 'hidden', background: theme.colors.base },
  canvas: { width: '100%', height: '100%', display: 'block' },
  loading: {
    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: theme.fonts.mono, fontSize: 12, letterSpacing: '0.2em', color: theme.colors.textSecondary,
  },
  hud: {
    position: 'absolute', top: 12, left: 12, display: 'flex', alignItems: 'center', gap: 14,
    background: 'rgba(20,22,32,0.82)', border: `1px solid ${theme.colors.border}`,
    borderRadius: 4, padding: '8px 14px', backdropFilter: 'blur(6px)', pointerEvents: 'none',
  },
  clock: {
    fontFamily: theme.fonts.mono, fontSize: 18, fontWeight: 600, color: theme.colors.accent,
    letterSpacing: '0.08em', minWidth: 64,
  },
  stat: {
    fontFamily: theme.fonts.mono, fontSize: 10, letterSpacing: '0.06em',
    color: theme.colors.textSecondary, textTransform: 'uppercase',
  },
};
