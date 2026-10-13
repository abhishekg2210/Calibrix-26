import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { StaticScene, KIND_AV } from '../engine/protocol';
import { InterpolatedAgents } from '../engine/client';
import { LandUse } from '../model/types';

/**
 * Three.js renderer for City Command. City plan coordinates (x, y) map to
 * world (x, height, y). Everything heavy is instanced: one draw call each for
 * buildings, road markings, signals, vehicles, pedestrians.
 */

const CAR_PALETTE = [0x8a93a6, 0x5e6878, 0xb8bfcc, 0x7d6e5e, 0x46506b, 0x6e7d8f, 0x9aa4b8, 0x55617a];
const AV_COLOR = 0x5bb8c9; // Q's Lab accent teal

const ZONE_COLORS: Record<LandUse, number> = {
  office: 0x55648a,
  commercial: 0x6e6280,
  residential: 0x6e6358,
  civic: 0x768896,
  park: 0x3a5c48,
};

export class CityScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private skyDay = new THREE.Color(0x9db4c8);
  private skyDusk = new THREE.Color(0x6b5a6e);
  private skyNight = new THREE.Color(0x0c0e14);
  private fog: THREE.Fog;

  private vehicles: THREE.InstancedMesh;
  private peds: THREE.InstancedMesh;
  private signalHeads: THREE.InstancedMesh;
  /** intersection id -> first signal instance index (4 per intersection: E,S,W,N). */
  private signalBase: Int32Array;

  private buildingsMesh: THREE.InstancedMesh;
  private roadMesh: THREE.Mesh;
  /** Per-directed-segment overlay quads for heatmaps (Phase 4). */
  private heatmapMesh: THREE.Mesh;
  private heatmapColors: Float32Array;
  private heatmapOn = false;

  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private staticScene: StaticScene;
  private slabMesh!: THREE.InstancedMesh;
  private slabBase = new THREE.Color(0x3a3f48);
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private marker: THREE.Mesh;

  constructor(canvas: HTMLCanvasElement, staticScene: StaticScene, maxAgents: number) {
    this.staticScene = staticScene;
    const m = staticScene.model;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.35;

    this.scene = new THREE.Scene();
    this.scene.background = this.skyDay.clone();
    const diag = Math.hypot(m.totalWidth, m.totalHeight);
    this.fog = new THREE.Fog(0x9db4c8, diag * 0.9, diag * 2.2);
    this.scene.fog = this.fog;

    this.camera = new THREE.PerspectiveCamera(55, 1, 1, diag * 4);
    this.camera.position.set(0, m.totalHeight * 0.55, m.totalHeight * 0.65);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.45;
    this.controls.minDistance = 25;
    this.controls.maxDistance = diag * 1.6;

    this.hemi = new THREE.HemisphereLight(0xbfd4e6, 0x32363e, 0.9);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2dd, 1.6);
    this.sun.position.set(diag * 0.4, diag * 0.5, diag * 0.2);
    this.scene.add(this.sun);

    this.buildGround();
    this.roadMesh = this.buildRoads();
    this.buildMarkings();
    this.buildingsMesh = this.buildBuildings();
    const sig = this.buildSignals();
    this.signalHeads = sig.mesh;
    this.signalBase = sig.base;
    const hm = this.buildHeatmapOverlay();
    this.heatmapMesh = hm.mesh;
    this.heatmapColors = hm.colors;

    this.vehicles = this.buildVehicles(maxAgents);
    this.peds = this.buildPeds(maxAgents);

    // Selection marker ring.
    const ring = new THREE.RingGeometry(5, 6.4, 32);
    ring.rotateX(-Math.PI / 2);
    this.marker = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ color: 0x5bb8c9, transparent: true, opacity: 0.9, depthWrite: false }));
    this.marker.position.y = 0.3;
    this.marker.visible = false;
    this.scene.add(this.marker);

    // Closure barriers (red bars across closed directed segments).
    const barGeo = new THREE.BoxGeometry(1, 1.6, 1);
    this.closureBars = new THREE.InstancedMesh(barGeo, new THREE.MeshBasicMaterial({ color: 0xe05c5c }), 128);
    this.closureBars.count = 0;
    this.scene.add(this.closureBars);
  }

  private closureBars!: THREE.InstancedMesh;

  /** Show barrier bars across the given closed directed segments. */
  setClosedSegs(segIds: number[]) {
    const segs = this.staticScene.segs;
    const laneSpan = this.staticScene.model.laneWidth * 2;
    let w = 0;
    for (const id of segIds) {
      if (w >= 128) break;
      const s = segs[id];
      if (!s) continue;
      const mx = (s.ax + s.bx) / 2, my = (s.ay + s.by) / 2;
      this.dummy.position.set(mx, 0.9, my);
      this.dummy.rotation.set(0, 0, 0);
      if (s.orientation === 'h') this.dummy.scale.set(2, 1, laneSpan);
      else this.dummy.scale.set(laneSpan, 1, 2);
      this.dummy.updateMatrix();
      this.closureBars.setMatrixAt(w++, this.dummy.matrix);
    }
    this.closureBars.count = w;
    this.closureBars.instanceMatrix.needsUpdate = true;
  }

  /** Cast a click (NDC coords) onto the ground plane; returns city (x, y). */
  pickGround(ndcX: number, ndcY: number): { x: number; y: number } | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.groundPlane, hit)) {
      return { x: hit.x, y: hit.z };
    }
    return null;
  }

  setMarker(x: number, y: number, visible: boolean, radius = 6) {
    this.marker.visible = visible;
    this.marker.position.set(x, 0.3, y);
    const s = radius / 6;
    this.marker.scale.set(s, 1, s);
  }

  // ------------------------------------------------------------- static city

  private buildGround() {
    const m = this.staticScene.model;
    const pad = 400;
    const g = new THREE.PlaneGeometry(m.totalWidth + pad, m.totalHeight + pad);
    const mat = new THREE.MeshLambertMaterial({ color: 0x232830 });
    const mesh = new THREE.Mesh(g, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -0.3;
    this.scene.add(mesh);

    // Sidewalk plates: one slightly-raised slab per block (also tintable as
    // the pedestrian-density heatmap surface).
    const slab = new THREE.BoxGeometry(1, 1, 1);
    const slabMat = new THREE.MeshLambertMaterial();
    const inst = new THREE.InstancedMesh(slab, slabMat, m.rows * m.cols);
    let w = 0;
    for (let i = 0; i < m.rows; i++) {
      for (let j = 0; j < m.cols; j++) {
        const cx = m.originX + (j + 1) * m.roadWidth + j * m.blockWidth + m.blockWidth / 2;
        const cy = m.originY + (i + 1) * m.roadWidth + i * m.blockHeight + m.blockHeight / 2;
        this.dummy.position.set(cx, 0.08, cy);
        this.dummy.scale.set(m.blockWidth + 3, 0.16, m.blockHeight + 3);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.updateMatrix();
        inst.setMatrixAt(w, this.dummy.matrix);
        inst.setColorAt(w, this.slabBase);
        w++;
      }
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    this.scene.add(inst);
    this.slabMesh = inst;
  }

  /** Pedestrian-density tint per block; null restores the base slab color. */
  setBlockHeatmap(values: Int32Array | null, max: number) {
    const inst = this.slabMesh;
    if (!values) {
      for (let i = 0; i < inst.count; i++) inst.setColorAt(i, this.slabBase);
    } else {
      const hot = new THREE.Color(0xc084fc); // ped accent: violet
      for (let i = 0; i < inst.count; i++) {
        const t = Math.min(1, values[i] / Math.max(1, max));
        inst.setColorAt(i, this.color.copy(this.slabBase).lerp(hot, Math.pow(t, 0.6)));
      }
    }
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  }

  private buildRoads(): THREE.Mesh {
    const m = this.staticScene.model;
    // One merged geometry: a quad per road (full length, both directions).
    const quads: number[] = [];
    // CCW winding viewed from +y so the surface faces the camera.
    const push = (cx: number, cy: number, w: number, h: number) => {
      const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cy - h / 2, z1 = cy + h / 2;
      quads.push(x0, 0, z0, x1, 0, z1, x1, 0, z0, x0, 0, z0, x0, 0, z1, x1, 0, z1);
    };
    for (const y of m.hRoadY) push(m.originX + m.totalWidth / 2, y, m.totalWidth, m.roadWidth);
    for (const x of m.vRoadX) push(x, m.originY + m.totalHeight / 2, m.roadWidth, m.totalHeight);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(quads, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ color: 0x1d2026 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = 0.02;
    this.scene.add(mesh);
    return mesh;
  }

  private buildMarkings() {
    const m = this.staticScene.model;
    const segs = this.staticScene.segs;
    type Mark = { x: number; y: number; w: number; h: number; rot: number; c: number };
    const marks: Mark[] = [];

    // Center lines per road (full length, muted yellow).
    for (const y of m.hRoadY) marks.push({ x: m.originX + m.totalWidth / 2, y, w: m.totalWidth, h: 0.25, rot: 0, c: 0x8a7a4a });
    for (const x of m.vRoadX) marks.push({ x, y: m.originY + m.totalHeight / 2, w: 0.25, h: m.totalHeight, rot: 0, c: 0x8a7a4a });

    // For each directed seg, a dashed divider sits between its two lanes.
    for (const s of segs) {
      if (s.lanes < 2) continue;
      const horiz = s.orientation === 'h';
      // Right-hand offset of the divider from road center: laneWidth per side.
      const lw = m.laneWidth;
      const off = lw; // boundary between lane 0 and lane 1
      // RIGHT_VEC: E->+y, S->-x, W->-y, N->+x
      const rv = s.dir === 0 ? [0, 1] : s.dir === 1 ? [-1, 0] : s.dir === 2 ? [0, -1] : [1, 0];
      const cx0 = horiz ? Math.min(s.ax, s.bx) : s.ax;
      const cy0 = horiz ? s.ay : Math.min(s.ay, s.by);
      const roadCenter = horiz
        ? (s.dir === 0 ? s.ay - lw : s.ay + lw)
        : (s.dir === 1 ? s.ax + lw : s.ax - lw);
      const dashLen = 3, pitch = 9;
      const n = Math.floor((s.length - 4) / pitch);
      for (let k = 0; k <= n; k++) {
        const d = 4 + k * pitch;
        if (horiz) {
          marks.push({ x: cx0 + d, y: roadCenter + rv[1] * off, w: dashLen, h: 0.18, rot: 0, c: 0xb8bfc8 });
        } else {
          marks.push({ x: roadCenter + rv[0] * off, y: cy0 + d, w: 0.18, h: dashLen, rot: 0, c: 0xb8bfc8 });
        }
      }
    }

    // Stop lines + crosswalks at every intersection approach.
    const half = m.roadWidth / 2;
    for (const it of this.staticScene.model.intersections) {
      for (let d = 0; d < 4; d++) {
        // Crosswalk stripes across each approach, just outside the box.
        const stripes = 4;
        for (let sIdx = 0; sIdx < stripes; sIdx++) {
          const t = -half + 1.2 + sIdx * ((m.roadWidth - 2.4) / (stripes - 1));
          const dist = half + 1.6;
          if (d === 0) marks.push({ x: it.x - dist, y: it.y + t, w: 1.0, h: 1.6, rot: 0, c: 0x9099a8 });
          if (d === 2) marks.push({ x: it.x + dist, y: it.y + t, w: 1.0, h: 1.6, rot: 0, c: 0x9099a8 });
          if (d === 1) marks.push({ x: it.x + t, y: it.y - dist, w: 1.6, h: 1.0, rot: 0, c: 0x9099a8 });
          if (d === 3) marks.push({ x: it.x + t, y: it.y + dist, w: 1.6, h: 1.0, rot: 0, c: 0x9099a8 });
        }
      }
    }

    const box = new THREE.BoxGeometry(1, 0.05, 1);
    const mat = new THREE.MeshBasicMaterial();
    const inst = new THREE.InstancedMesh(box, mat, marks.length);
    for (let i = 0; i < marks.length; i++) {
      const mk = marks[i];
      this.dummy.position.set(mk.x, 0.05, mk.y);
      this.dummy.scale.set(mk.w, 1, mk.h);
      this.dummy.rotation.set(0, mk.rot, 0);
      this.dummy.updateMatrix();
      inst.setMatrixAt(i, this.dummy.matrix);
      inst.setColorAt(i, this.color.setHex(mk.c).multiplyScalar(0.55));
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    this.scene.add(inst);
  }

  private buildBuildings(): THREE.InstancedMesh {
    const bs = this.staticScene.model.buildings;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial();
    const inst = new THREE.InstancedMesh(geo, mat, bs.length);
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      this.dummy.position.set(b.x, b.height / 2, b.y);
      this.dummy.scale.set(b.width, b.height, b.depth);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      inst.setMatrixAt(i, this.dummy.matrix);
      const base = ZONE_COLORS[b.landUse];
      // Slight deterministic variation so facades aren't flat.
      const vary = 0.9 + ((b.id * 2654435761) % 100) / 500;
      inst.setColorAt(i, this.color.setHex(base).multiplyScalar(vary));
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    this.scene.add(inst);
    return inst;
  }

  private buildSignals(): { mesh: THREE.InstancedMesh; base: Int32Array } {
    const inters = this.staticScene.model.intersections;
    const half = this.staticScene.model.roadWidth / 2;
    const geo = new THREE.SphereGeometry(0.7, 8, 8);
    const mat = new THREE.MeshBasicMaterial();
    const inst = new THREE.InstancedMesh(geo, mat, inters.length * 4);
    const base = new Int32Array(inters.length);
    let w = 0;
    for (const it of inters) {
      base[it.id] = w;
      // Heads hover near each approach corner: order E, S, W, N (approach dir).
      const off = half + 1.2;
      const pos = [
        [it.x - off, it.y + off], // E approaches from west, head at SW corner
        [it.x - off, it.y - off], // S approaches from north, head at NW corner
        [it.x + off, it.y - off], // W approaches from east, head at NE corner
        [it.x + off, it.y + off], // N approaches from south, head at SE corner
      ];
      for (let d = 0; d < 4; d++) {
        this.dummy.position.set(pos[d][0], 5.2, pos[d][1]);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.rotation.set(0, 0, 0);
        this.dummy.updateMatrix();
        inst.setMatrixAt(w, this.dummy.matrix);
        inst.setColorAt(w, this.color.setHex(0xe05c5c));
        w++;
      }
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    this.scene.add(inst);
    return { mesh: inst, base };
  }

  private buildHeatmapOverlay(): { mesh: THREE.Mesh; colors: Float32Array } {
    const m = this.staticScene.model;
    const segs = this.staticScene.segs;
    const positions = new Float32Array(segs.length * 6 * 3);
    const colors = new Float32Array(segs.length * 6 * 3);
    const halfW = m.laneWidth * 2 * 0.5; // both lanes of one direction
    let p = 0;
    for (const s of segs) {
      const horiz = s.orientation === 'h';
      const x0 = horiz ? Math.min(s.ax, s.bx) : s.ax - halfW;
      const x1 = horiz ? Math.max(s.ax, s.bx) : s.ax + halfW;
      const z0 = horiz ? s.ay - halfW : Math.min(s.ay, s.by);
      const z1 = horiz ? s.ay + halfW : Math.max(s.ay, s.by);
      // CCW from above (matches buildRoads winding).
      const quad = [x0, z0, x1, z1, x1, z0, x0, z0, x0, z1, x1, z1];
      for (let v = 0; v < 6; v++) {
        positions[p * 3] = quad[v * 2];
        positions[p * 3 + 1] = 0;
        positions[p * 3 + 2] = quad[v * 2 + 1];
        p++;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = 0.2;
    mesh.visible = false;
    this.scene.add(mesh);
    return { mesh, colors };
  }

  // ----------------------------------------------------------------- agents

  private buildVehicles(cap: number): THREE.InstancedMesh {
    // Simple car: body + cabin merged.
    const body = new THREE.BoxGeometry(4.4, 1.25, 1.9);
    body.translate(0, 0.85, 0);
    const cabin = new THREE.BoxGeometry(2.1, 0.85, 1.7);
    cabin.translate(-0.25, 1.85, 0);
    const geo = mergeGeometries([body, cabin]);
    const mat = new THREE.MeshLambertMaterial();
    const inst = new THREE.InstancedMesh(geo, mat, cap);
    inst.count = 0;
    inst.frustumCulled = false;
    this.scene.add(inst);
    return inst;
  }

  private buildPeds(cap: number): THREE.InstancedMesh {
    const geo = new THREE.CapsuleGeometry(0.32, 1.1, 2, 6);
    geo.translate(0, 0.9, 0);
    const mat = new THREE.MeshLambertMaterial();
    const inst = new THREE.InstancedMesh(geo, mat, cap);
    inst.count = 0;
    inst.frustumCulled = false;
    this.scene.add(inst);
    return inst;
  }

  /** Push the latest interpolated agent state into the instanced meshes. */
  setAgents(a: InterpolatedAgents) {
    let vCount = 0, pCount = 0;
    const veh = this.vehicles, ped = this.peds;
    for (let i = 0; i < a.count; i++) {
      const x = a.data[i * 4], y = a.data[i * 4 + 1], h = a.data[i * 4 + 2];
      const kind = a.kinds[i];
      if (kind === 2) {
        this.dummy.position.set(x, 0.16, y);
        this.dummy.rotation.set(0, -h, 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        ped.setMatrixAt(pCount, this.dummy.matrix);
        ped.setColorAt(pCount, this.color.setHex(CAR_PALETTE[(a.ids[i] >> 2) & 7]).multiplyScalar(1.15));
        pCount++;
      } else {
        this.dummy.position.set(x, 0.05, y);
        this.dummy.rotation.set(0, -h, 0);
        this.dummy.scale.set(1, 1, 1);
        this.dummy.updateMatrix();
        veh.setMatrixAt(vCount, this.dummy.matrix);
        if (kind === KIND_AV) {
          veh.setColorAt(vCount, this.color.setHex(AV_COLOR));
        } else {
          veh.setColorAt(vCount, this.color.setHex(CAR_PALETTE[a.ids[i] & 7]));
        }
        vCount++;
      }
    }
    veh.count = vCount;
    ped.count = pCount;
    veh.instanceMatrix.needsUpdate = true;
    ped.instanceMatrix.needsUpdate = true;
    if (veh.instanceColor) veh.instanceColor.needsUpdate = true;
    if (ped.instanceColor) ped.instanceColor.needsUpdate = true;

    this.updateSignals(a.signalPhases);
  }

  private updateSignals(phases: Uint8Array) {
    const inst = this.signalHeads;
    const green = 0x5cb886, red = 0xe05c5c, amber = 0xe8a44a;
    for (let inter = 0; inter < phases.length; inter++) {
      const p = phases[inter];
      const b = this.signalBase[inter];
      // Heads ordered E,S,W,N (approach directions).
      for (let d = 0; d < 4; d++) {
        const isNS = d === 1 || d === 3;
        let c = red;
        if (p === 0 && isNS) c = green;
        else if (p === 1 && isNS) c = amber;
        else if (p === 2 && !isNS) c = green;
        else if (p === 3 && !isNS) c = amber;
        inst.setColorAt(b + d, this.color.setHex(c));
      }
    }
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------- heatmap API

  setHeatmap(values: Float32Array | null, min: number, max: number) {
    if (!values) {
      this.heatmapOn = false;
      this.heatmapMesh.visible = false;
      return;
    }
    this.heatmapOn = true;
    this.heatmapMesh.visible = true;
    const colors = this.heatmapColors;
    const lo = new THREE.Color(0xe05c5c);   // congested
    const mid = new THREE.Color(0xe8a44a);
    const hi = new THREE.Color(0x5cb886);   // free flow
    for (let s = 0; s < values.length; s++) {
      const t = Math.max(0, Math.min(1, (values[s] - min) / (max - min)));
      const c = t < 0.5 ? lo.clone().lerp(mid, t * 2) : mid.clone().lerp(hi, (t - 0.5) * 2);
      for (let v = 0; v < 6; v++) {
        colors[(s * 6 + v) * 3] = c.r;
        colors[(s * 6 + v) * 3 + 1] = c.g;
        colors[(s * 6 + v) * 3 + 2] = c.b;
      }
    }
    (this.heatmapMesh.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  get heatmapVisible() { return this.heatmapOn; }

  // ------------------------------------------------------------ time of day

  /** Drive lighting/sky from the 24h clock. */
  setClockHour(h: number) {
    // Sun elevation: up between ~5.5h and ~18.5h.
    const dayT = Math.max(0, Math.sin(((h - 5.5) / 13) * Math.PI)); // 0 night .. 1 noon
    const duskT = Math.exp(-Math.pow((h - 6.5) / 1.2, 2)) + Math.exp(-Math.pow((h - 17.8) / 1.2, 2));

    this.sun.intensity = 0.3 + dayT * 1.7;
    this.sun.color.setHex(0xfff2dd).lerp(new THREE.Color(0xff9a5a), Math.min(1, duskT));
    this.hemi.intensity = 0.55 + dayT * 1.0;

    const sky = this.skyNight.clone().lerp(this.skyDay, dayT).lerp(this.skyDusk, Math.min(0.6, duskT));
    (this.scene.background as THREE.Color).copy(sky);
    this.fog.color.copy(sky);

    // Sun position swings east -> west.
    const az = ((h - 6) / 12) * Math.PI; // 6h east horizon, 18h west
    const m = this.staticScene.model;
    const r = Math.hypot(m.totalWidth, m.totalHeight);
    this.sun.position.set(Math.cos(az) * r, Math.max(0.08, Math.sin(az)) * r * 0.8, r * 0.25);
  }

  // ----------------------------------------------------------------- frame

  resize(w: number, hgt: number) {
    this.renderer.setSize(w, hgt, false);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.dispose();
    this.controls.dispose();
  }
}

/** Minimal geometry merge (positions/normals only) to avoid the examples dep. */
function mergeGeometries(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0;
  for (const g of geos) {
    const ng = g.index ? g.toNonIndexed() : g;
    total += ng.getAttribute('position').count;
    g.userData.nonIndexed = ng;
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let off = 0;
  for (const g of geos) {
    const ng = g.userData.nonIndexed as THREE.BufferGeometry;
    pos.set((ng.getAttribute('position') as THREE.BufferAttribute).array as Float32Array, off * 3);
    nor.set((ng.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array, off * 3);
    off += ng.getAttribute('position').count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}
