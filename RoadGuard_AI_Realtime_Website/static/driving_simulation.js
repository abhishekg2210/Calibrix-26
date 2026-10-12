/**
 * RoadGuard AI - Interactive Autonomous Driving Simulation (PS 06)
 * Real-time Canvas-based simulation for Unstructured Indian Roads
 * Implements 5 scenarios, dynamic obstacles, candidate trajectory lattice,
 * kinematic vehicle physics, motion prediction, and real-time decision synthesis.
 */

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // STATE MANAGEMENT
  // --------------------------------------------------------------------------
  const simState = {
    running: false,
    speedMultiplier: 1.0,
    time: 0.0,
    dt: 0.033, // ~30 FPS physics step
    animId: null,
    scenarioId: 'scenario_1',
    plannerMode: 'frenet_lattice', // 'frenet_lattice', 'pathweaver', 'emergency_brake'
    placementType: null,

    // Road Geometry (in meters)
    road: {
      length_m: 130.0,
      width_m: 7.5,
      lane_width_m: 3.5,
      shoulder_width_m: 2.2,
      scale: 16.0, // pixels per meter
      viewOffsetX: 60, // Camera track offset
      viewOffsetY: 0
    },

    // Autonomous Ego Vehicle (Kinematic Bicycle State)
    ego: {
      x: 8.0,           // longitudinal m
      y: 0.0,           // lateral m (0 = center, + = left, - = right)
      v: 8.5,           // longitudinal velocity m/s (~30 km/h)
      target_v: 8.5,    // desired cruising velocity m/s
      a: 0.0,           // acceleration m/s^2
      heading: 0.0,     // rad
      steering: 0.0,    // rad
      wheelbase_m: 2.6,
      width_m: 1.85,
      length_m: 4.4,
      target_lat: 0.0,  // active lateral target corridor
      selected_path: []
    },

    // Destination
    target: { x: 115.0, y: 0.0 },

    // Dynamic & Static Obstacles
    obstacles: [],

    // Planner & Decision State
    activeDecision: 'NOMINAL_CRUISE',
    decisionExplanation: 'Clear corridor ahead. Maintaining target cruising speed.',
    riskLevel: 'LOW',
    timeToCollision: 99.0,
    minClearance: 99.0,
    candidatePaths: [],
    predictions: [],
    collisionsCount: 0,
    evasionsCount: 0,
    emergencyStopsCount: 0,
    historyTrail: [],

    // UI elements
    canvas: null,
    ctx: null
  };

  // --------------------------------------------------------------------------
  // SCENARIO DEFINITIONS (5 INDIAN ROAD SCENARIOS)
  // --------------------------------------------------------------------------
  const SCENARIOS = {
    scenario_1: {
      id: 'scenario_1',
      name: 'Scenario 1: Pedestrian Suddenly Crossing Road',
      desc: 'Pedestrian briskly steps out from roadside dirt shoulder directly across the vehicle travel corridor.',
      egoStart: { x: 8.0, y: 0.0, v: 8.5 },
      obstacles: [
        {
          id: 'PED-01',
          type: 'pedestrian',
          name: 'Crossing Pedestrian',
          x: 42.0,
          y: 3.4,
          vx: -0.15,
          vy: -1.35,
          radius_m: 0.7,
          color: '#fb7185',
          behavior: 'cross_road'
        }
      ]
    },
    scenario_2: {
      id: 'scenario_2',
      name: 'Scenario 2: Motorcycle Merging from Side Lane',
      desc: 'Two-wheeler abruptly cuts in from the unpaved shoulder at angled trajectory with no turn signal.',
      egoStart: { x: 8.0, y: 0.0, v: 9.0 },
      obstacles: [
        {
          id: 'MTR-01',
          type: 'motorcycle',
          name: 'Merging Two-Wheeler',
          x: 36.0,
          y: -3.4,
          vx: 3.8,
          vy: 1.25,
          radius_m: 1.1,
          color: '#38bdf8',
          behavior: 'merge_diagonal'
        }
      ]
    },
    scenario_3: {
      id: 'scenario_3',
      name: 'Scenario 3: Severe Pothole in Vehicle Path',
      desc: 'Deep structural road pothole directly on centerline corridor requiring smooth lateral replan.',
      egoStart: { x: 8.0, y: 0.0, v: 8.0 },
      obstacles: [
        {
          id: 'POT-01',
          type: 'pothole',
          name: 'Deep Asphalt Pothole',
          x: 45.0,
          y: 0.1,
          vx: 0.0,
          vy: 0.0,
          radius_m: 1.3,
          color: '#f59e0b',
          behavior: 'static'
        }
      ]
    },
    scenario_4: {
      id: 'scenario_4',
      name: 'Scenario 4: Stray Cattle Wandering Across Roadway',
      desc: 'Large bovine wanders into the traffic corridor, causing immediate deceleration and safe stop trigger.',
      egoStart: { x: 8.0, y: 0.0, v: 8.0 },
      obstacles: [
        {
          id: 'CAT-01',
          type: 'cattle',
          name: 'Stray Cattle (Cow)',
          x: 38.0,
          y: 1.6,
          vx: -0.1,
          vy: -0.65,
          radius_m: 1.7,
          color: '#a78bfa',
          behavior: 'wander_slow'
        }
      ]
    },
    scenario_5: {
      id: 'scenario_5',
      name: 'Scenario 5: Dense Traffic with Road Blockage',
      desc: 'Multi-corridor blockage: slow auto-rickshaw ahead, construction barrier in right lane, parked car on shoulder.',
      egoStart: { x: 8.0, y: 0.0, v: 7.5 },
      obstacles: [
        {
          id: 'AUT-01',
          type: 'auto_rickshaw',
          name: 'Slow Auto-Rickshaw',
          x: 32.0,
          y: 0.0,
          vx: 2.2,
          vy: 0.0,
          radius_m: 1.4,
          color: '#facc15',
          behavior: 'move_forward'
        },
        {
          id: 'BLK-01',
          type: 'blockade',
          name: 'Construction Barrier',
          x: 52.0,
          y: -1.8,
          vx: 0.0,
          vy: 0.0,
          radius_m: 1.8,
          color: '#f97316',
          behavior: 'static'
        },
        {
          id: 'CAR-01',
          type: 'car',
          name: 'Parked Vehicle',
          x: 68.0,
          y: -2.3,
          vx: 0.0,
          vy: 0.0,
          radius_m: 2.1,
          color: '#94a3b8',
          behavior: 'static'
        }
      ]
    }
  };

  // --------------------------------------------------------------------------
  // INITIALIZATION & LIFECYCLE
  // --------------------------------------------------------------------------
  function initSimulation() {
    simState.canvas = document.getElementById('drivingSimCanvas');
    if (!simState.canvas) return;
    simState.ctx = simState.canvas.getContext('2d');

    // Handle high DPI
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);

    // Setup event listeners
    setupControls();

    // Canvas click to place custom obstacles
    simState.canvas.addEventListener('click', handleCanvasClick);

    // Load initial scenario
    loadScenario('scenario_1');

    // Render initial static frame
    render();
  }

  function resizeCanvas() {
    if (!simState.canvas) return;
    const rect = simState.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    simState.canvas.width = rect.width * dpr;
    simState.canvas.height = rect.height * dpr;
    simState.ctx.scale(dpr, dpr);
  }

  function loadScenario(scenarioId) {
    const sc = SCENARIOS[scenarioId] || SCENARIOS.scenario_1;
    simState.scenarioId = scenarioId;
    simState.time = 0.0;
    simState.running = false;
    simState.activeDecision = 'NOMINAL_CRUISE';
    simState.decisionExplanation = sc.desc;
    simState.riskLevel = 'LOW';
    simState.historyTrail = [];

    // Reset Ego
    simState.ego.x = sc.egoStart.x;
    simState.ego.y = sc.egoStart.y;
    simState.ego.v = sc.egoStart.v;
    simState.ego.target_v = sc.egoStart.v;
    simState.ego.a = 0.0;
    simState.ego.heading = 0.0;
    simState.ego.steering = 0.0;
    simState.ego.target_lat = 0.0;

    // Deep copy obstacles
    simState.obstacles = JSON.parse(JSON.stringify(sc.obstacles));

    // Update UI elements
    updateUIElements();
    updatePlayPauseButton();
    render();
  }

  // --------------------------------------------------------------------------
  // USER CONTROLS SETUP
  // --------------------------------------------------------------------------
  function setupControls() {
    const playBtn = document.getElementById('simPlayBtn');
    const resetBtn = document.getElementById('simResetBtn');
    const scenarioSelect = document.getElementById('simScenarioSelect');
    const speedSelect = document.getElementById('simSpeedSelect');
    const plannerSelect = document.getElementById('simPlannerSelect');
    const addObstacleBtn = document.getElementById('simAddObstacleBtn');
    const clearCustomBtn = document.getElementById('simClearCustomBtn');

    if (playBtn) {
      playBtn.addEventListener('click', () => {
        if (simState.running) {
          pauseSimulation();
        } else {
          startSimulation();
        }
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        pauseSimulation();
        loadScenario(simState.scenarioId);
      });
    }

    if (scenarioSelect) {
      scenarioSelect.addEventListener('change', (e) => {
        pauseSimulation();
        loadScenario(e.target.value);
      });
    }

    if (speedSelect) {
      speedSelect.addEventListener('change', (e) => {
        simState.speedMultiplier = parseFloat(e.target.value) || 1.0;
      });
    }

    if (plannerSelect) {
      plannerSelect.addEventListener('change', (e) => {
        simState.plannerMode = e.target.value;
        const modeBadge = document.getElementById('simPlannerModeBadge');
        if (modeBadge) modeBadge.textContent = e.target.options[e.target.selectedIndex].text;
      });
    }

    if (addObstacleBtn) {
      addObstacleBtn.addEventListener('click', () => {
        const typeSelect = document.getElementById('simObstacleTypeSelect');
        const type = typeSelect ? typeSelect.value : 'pedestrian';
        spawnObstacleAhead(type);
      });
    }

    if (clearCustomBtn) {
      clearCustomBtn.addEventListener('click', () => {
        // Reset to original scenario obstacles
        const sc = SCENARIOS[simState.scenarioId];
        simState.obstacles = JSON.parse(JSON.stringify(sc.obstacles));
        render();
        updateActorTable();
      });
    }
  }

  function startSimulation() {
    if (simState.running) return;
    simState.running = true;
    updatePlayPauseButton();
    lastFrameTime = performance.now();
    simLoop();
  }

  function pauseSimulation() {
    simState.running = false;
    updatePlayPauseButton();
    if (simState.animId) {
      cancelAnimationFrame(simState.animId);
      simState.animId = null;
    }
  }

  function updatePlayPauseButton() {
    const playBtn = document.getElementById('simPlayBtn');
    if (!playBtn) return;
    if (simState.running) {
      playBtn.innerHTML = '<span>⏸</span> Pause';
      playBtn.classList.add('active');
    } else {
      playBtn.innerHTML = '<span>▶</span> Start Simulation';
      playBtn.classList.remove('active');
    }
  }

  function spawnObstacleAhead(type) {
    const spawnX = Math.min(simState.road.length_m - 15.0, simState.ego.x + 28.0 + Math.random() * 10.0);
    const spawnY = (Math.random() - 0.5) * 4.0;
    const newId = `${type.substring(0, 3).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;

    const obsProps = {
      pedestrian: { name: 'Added Pedestrian', vx: -0.1, vy: -1.2, radius_m: 0.7, color: '#fb7185', behavior: 'cross_road' },
      motorcycle: { name: 'Added Motorcycle', vx: 3.5, vy: 0.8, radius_m: 1.1, color: '#38bdf8', behavior: 'merge_diagonal' },
      auto_rickshaw: { name: 'Added Auto-Rickshaw', vx: 2.0, vy: 0.0, radius_m: 1.4, color: '#facc15', behavior: 'move_forward' },
      pothole: { name: 'Road Defect / Pothole', vx: 0.0, vy: 0.0, radius_m: 1.3, color: '#f59e0b', behavior: 'static' },
      cattle: { name: 'Stray Cattle', vx: -0.05, vy: -0.5, radius_m: 1.6, color: '#a78bfa', behavior: 'wander_slow' },
      blockade: { name: 'Road Blockade', vx: 0.0, vy: 0.0, radius_m: 1.8, color: '#f97316', behavior: 'static' }
    };

    const prop = obsProps[type] || obsProps.pedestrian;
    simState.obstacles.push({
      id: newId,
      type: type,
      name: prop.name,
      x: spawnX,
      y: spawnY,
      vx: prop.vx,
      vy: prop.vy,
      radius_m: prop.radius_m,
      color: prop.color,
      behavior: prop.behavior
    });

    render();
    updateActorTable();
  }

  function handleCanvasClick(e) {
    const rect = simState.canvas.getBoundingClientRect();
    const clickPxX = e.clientX - rect.left;
    const clickPxY = e.clientY - rect.top;

    // Convert pixel coordinates to road meter coordinates
    const meterX = (clickPxX - simState.road.viewOffsetX) / simState.road.scale + simState.ego.x - 15.0;
    const centerY = rect.height / 2.0;
    const meterY = -(clickPxY - centerY) / simState.road.scale;

    // If within road bounds, add an obstacle
    if (Math.abs(meterY) <= simState.road.width_m / 2.0 + 1.5 && meterX > 0 && meterX < simState.road.length_m) {
      const typeSelect = document.getElementById('simObstacleTypeSelect');
      const type = typeSelect ? typeSelect.value : 'pothole';
      const newId = `MAN-${Math.floor(Math.random() * 900 + 100)}`;

      simState.obstacles.push({
        id: newId,
        type: type,
        name: `Interactive ${type}`,
        x: Math.round(meterX * 10) / 10,
        y: Math.round(meterY * 10) / 10,
        vx: 0.0,
        vy: 0.0,
        radius_m: type === 'pothole' ? 1.2 : 1.5,
        color: '#f59e0b',
        behavior: 'static'
      });

      render();
      updateActorTable();
    }
  }

  // --------------------------------------------------------------------------
  // SIMULATION MAIN LOOP
  // --------------------------------------------------------------------------
  let lastFrameTime = performance.now();

  function simLoop() {
    if (!simState.running) return;

    const now = performance.now();
    const elapsedSec = (now - lastFrameTime) / 1000.0;
    lastFrameTime = now;

    // Clamped physics delta time
    const dt = Math.min(0.066, Math.max(0.016, elapsedSec)) * simState.speedMultiplier;
    simState.time += dt;

    // 1. Update Obstacle Physics
    updateObstacles(dt);

    // 2. Compute Short-term Obstacle Predictions (1s, 2s, 3s)
    computeObstaclePredictions();

    // 3. Generate Candidate Trajectories & Evaluate Collision Risk
    evaluatePlanningAndRisk(dt);

    // 4. Update Vehicle Kinematics
    updateVehiclePhysics(dt);

    // 5. Check Completion or Collision
    checkTerminalConditions();

    // 6. Render Frame
    render();

    // 7. Update Dashboard HUD & Tables
    updateUIElements();

    simState.animId = requestAnimationFrame(simLoop);
  }

  // --------------------------------------------------------------------------
  // 1. OBSTACLE PHYSICS UPDATE
  // --------------------------------------------------------------------------
  function updateObstacles(dt) {
    const halfRoad = simState.road.width_m / 2.0 + 1.2;

    simState.obstacles.forEach(obs => {
      if (obs.behavior === 'static') return;

      obs.x += obs.vx * dt;
      obs.y += obs.vy * dt;

      // Behavior: Crossing road reverses or stops at far boundary
      if (obs.behavior === 'cross_road') {
        if (obs.y < -halfRoad) {
          obs.vy = -obs.vy * 0.8; // bounce / slow wander
        }
      } else if (obs.behavior === 'merge_diagonal') {
        // Motorcycle merges into travel lane then straightens out
        if (Math.abs(obs.y) < 1.0) {
          obs.vy = 0.0; // straightened into lane
          obs.vx = Math.max(obs.vx, 4.5); // accelerates ahead
        }
      } else if (obs.behavior === 'wander_slow') {
        // Cattle wandering: subtle random lateral nudge
        obs.vy += (Math.random() - 0.5) * 0.4 * dt;
        obs.vy = Math.max(-1.0, Math.min(1.0, obs.vy));
        if (Math.abs(obs.y) > halfRoad) {
          obs.vy = -obs.vy;
        }
      }
    });
  }

  // --------------------------------------------------------------------------
  // 2. SHORT-TERM OBSTACLE PREDICTIONS (1s, 2s, 3s)
  // --------------------------------------------------------------------------
  function computeObstaclePredictions() {
    simState.predictions = simState.obstacles.map(obs => {
      const futurePoints = [1.0, 2.0, 3.0].map(t => ({
        t_sec: t,
        x: obs.x + obs.vx * t,
        y: obs.y + obs.vy * t
      }));
      return {
        id: obs.id,
        current: { x: obs.x, y: obs.y },
        future: futurePoints
      };
    });
  }

  // --------------------------------------------------------------------------
  // 3. CANDIDATE TRAJECTORY LATTICE & RISK EVALUATION (PHASE 3)
  // --------------------------------------------------------------------------
  function evaluatePlanningAndRisk(dt) {
    const ego = simState.ego;
    const horizon_m = 35.0;
    const n_pts = 30;

    // Lateral offsets to evaluate (-2.5m = right lane, 0 = center, +2.5m = left lane)
    const lateralOffsets = [0.0, 1.5, 2.4, -1.5, -2.4];
    const candidatePaths = [];

    // Calculate nearest obstacle distance
    let minObsDist = 999.0;
    let mostCriticalObs = null;

    simState.obstacles.forEach(obs => {
      const d = Math.hypot(obs.x - ego.x, obs.y - ego.y);
      if (d < minObsDist) {
        minObsDist = d;
        mostCriticalObs = obs;
      }
    });
    simState.minClearance = minObsDist;

    // Time to collision approximation
    const closingSpeed = ego.v - (mostCriticalObs && mostCriticalObs.vx ? mostCriticalObs.vx : 0.0);
    simState.timeToCollision = closingSpeed > 0.5 ? Math.max(0.1, minObsDist / closingSpeed) : 99.0;

    // Evaluate each candidate trajectory
    let bestPath = null;
    let minCost = 999999.0;

    lateralOffsets.forEach(targetLat => {
      // Out of boundary check
      if (Math.abs(targetLat) > (simState.road.width_m / 2.0 - 0.4)) return;

      const path = [];
      let pathMinObsDist = 999.0;
      let isFeasible = true;

      for (let i = 0; i < n_pts; i++) {
        const s = i / (n_pts - 1);
        const px = ego.x + s * horizon_m;

        // Quintic polynomial lateral transition
        const poly = 10.0 * Math.pow(s, 3) - 15.0 * Math.pow(s, 4) + 6.0 * Math.pow(s, 5);
        const py = ego.y + (targetLat - ego.y) * poly;

        // Check distance to all predicted obstacles at point arrival time
        const t_arrival = s * (horizon_m / Math.max(3.0, ego.v));

        for (let obs of simState.obstacles) {
          const predX = obs.x + obs.vx * t_arrival;
          const predY = obs.y + obs.vy * t_arrival;
          const d = Math.hypot(px - predX, py - predY);

          if (d < pathMinObsDist) pathMinObsDist = d;

          // Collision margin: obstacle radius + vehicle width/2 + buffer
          if (d < (obs.radius_m + 1.1)) {
            isFeasible = false;
          }
        }

        path.push({ x: px, y: py });
      }

      // Cost function: J = w_lat * |d| + w_obs * (1/min_dist) + w_change * |targetLat - ego.target_lat|
      const latCost = Math.abs(targetLat) * 1.5;
      const obsCost = 30.0 / Math.max(0.6, pathMinObsDist);
      const smoothnessCost = Math.abs(targetLat - ego.target_lat) * 2.0;
      const totalCost = latCost + obsCost + smoothnessCost;

      const candidate = {
        targetLat: targetLat,
        path: path,
        isFeasible: isFeasible,
        minObsDist: pathMinObsDist,
        cost: totalCost
      };

      candidatePaths.push(candidate);

      if (isFeasible && totalCost < minCost) {
        minCost = totalCost;
        bestPath = candidate;
      }
    });

    simState.candidatePaths = candidatePaths;

    // ------------------------------------------------------------------------
    // DECISION STATE MACHINE
    // ------------------------------------------------------------------------
    if (simState.plannerMode === 'emergency_brake' || minObsDist < 4.2 || (simState.timeToCollision < 1.3 && minObsDist < 12.0)) {
      // 1. Emergency Braking / Safe Stop
      simState.activeDecision = 'EMERGENCY_STOP';
      simState.riskLevel = 'CRITICAL';
      simState.decisionExplanation = `CRITICAL COLLISION RISK: Obstacle at ${minObsDist.toFixed(1)}m (TTC: ${simState.timeToCollision.toFixed(1)}s). Safe stop engaged.`;
      ego.a = -6.0; // Max braking deceleration
      ego.target_v = 0.0;
      simState.emergencyStopsCount++;
    } else if (!bestPath) {
      // 2. All corridors blocked
      simState.activeDecision = 'EMERGENCY_STOP';
      simState.riskLevel = 'CRITICAL';
      simState.decisionExplanation = `ALL CORRIDORS BLOCKED: No feasible lateral collision-free path exists. Controlled stop triggered.`;
      ego.a = -5.0;
      ego.target_v = 0.0;
    } else if (bestPath.targetLat !== 0.0) {
      // 3. Lateral Replan / Evasion Active
      const corridorName = bestPath.targetLat > 0 ? 'Left Lane' : 'Right Lane';
      simState.activeDecision = 'LATERAL_REPLAN';
      simState.riskLevel = 'MODERATE';
      simState.decisionExplanation = `Obstacle in center corridor. Executing smooth lateral evasion to ${corridorName} (Clearance: ${bestPath.minObsDist.toFixed(1)}m).`;
      ego.target_lat = bestPath.targetLat;
      ego.target_v = Math.min(ego.target_v, 7.0); // Slightly reduce speed during lane change
      ego.a = (ego.target_v - ego.v) * 0.8;
      ego.selected_path = bestPath.path;
      simState.evasionsCount++;
    } else if (minObsDist < 18.0) {
      // 4. Caution / Reduce Speed Ahead
      simState.activeDecision = 'REDUCE_SPEED';
      simState.riskLevel = 'MODERATE';
      simState.decisionExplanation = `Approaching dynamic hazard within ${minObsDist.toFixed(1)}m. Reducing cruising speed for driver safety.`;
      ego.target_lat = 0.0;
      ego.target_v = 5.0;
      ego.a = (ego.target_v - ego.v) * 1.2;
      ego.selected_path = bestPath.path;
    } else {
      // 5. Nominal Cruise
      simState.activeDecision = 'NOMINAL_CRUISE';
      simState.riskLevel = 'LOW';
      simState.decisionExplanation = `Corridor clear (Separation: ${minObsDist > 100 ? '>100m' : minObsDist.toFixed(1) + 'm'}). Cruising at nominal speed.`;
      ego.target_lat = 0.0;
      ego.target_v = SCENARIOS[simState.scenarioId].egoStart.v;
      ego.a = (ego.target_v - ego.v) * 1.0;
      ego.selected_path = bestPath ? bestPath.path : [];
    }
  }

  // --------------------------------------------------------------------------
  // 4. VEHICLE KINEMATIC BICYCLE UPDATE
  // --------------------------------------------------------------------------
  function updateVehiclePhysics(dt) {
    const ego = simState.ego;

    // Velocity integration with bounds
    ego.v += ego.a * dt;
    ego.v = Math.max(0.0, Math.min(15.0, ego.v));

    // Lateral tracking controller: P-control on target lateral displacement
    const latError = ego.target_lat - ego.y;
    ego.steering = Math.max(-0.45, Math.min(0.45, latError * 0.28));

    // Kinematic Bicycle Model:
    // x_dot = v * cos(heading)
    // y_dot = v * sin(heading)
    // heading_dot = (v / L) * tan(steering)
    ego.heading += (ego.v / ego.wheelbase_m) * Math.tan(ego.steering) * dt;

    // Dampen heading back to road orientation
    ego.heading *= 0.94;

    ego.x += ego.v * Math.cos(ego.heading) * dt;
    ego.y += ego.v * Math.sin(ego.heading) * dt;

    // Keep history trail for visual breadcrumbs
    if (Math.random() < 0.3) {
      simState.historyTrail.push({ x: ego.x, y: ego.y });
      if (simState.historyTrail.length > 50) simState.historyTrail.shift();
    }
  }

  // --------------------------------------------------------------------------
  // 5. TERMINAL CONDITIONS (DESTINATION / COLLISION)
  // --------------------------------------------------------------------------
  function checkTerminalConditions() {
    // Destination reached
    if (simState.ego.x >= simState.target.x) {
      pauseSimulation();
      simState.activeDecision = 'DESTINATION_REACHED';
      simState.decisionExplanation = 'Autonomous ego vehicle has successfully reached the destination safely.';
      render();
      updateUIElements();
      return;
    }

    // Physical collision check
    for (let obs of simState.obstacles) {
      const d = Math.hypot(obs.x - simState.ego.x, obs.y - simState.ego.y);
      if (d < (obs.radius_m + 0.9)) {
        simState.collisionsCount++;
        simState.activeDecision = 'COLLISION_DETECTED';
        simState.riskLevel = 'CRITICAL';
        simState.decisionExplanation = `COLLISION EVENT with ${obs.name} at x=${obs.x.toFixed(1)}m. Vehicle stopped.`;
        simState.ego.v = 0.0;
        pauseSimulation();
        render();
        updateUIElements();
        break;
      }
    }
  }

  // --------------------------------------------------------------------------
  // 6. RENDER SIMULATION (CANVAS)
  // --------------------------------------------------------------------------
  function render() {
    const ctx = simState.ctx;
    const canvas = simState.canvas;
    if (!ctx || !canvas) return;

    const w = canvas.width / (window.devicePixelRatio || 1);
    const h = canvas.height / (window.devicePixelRatio || 1);

    ctx.clearRect(0, 0, w, h);

    // Camera follow ego vehicle horizontally
    const cameraX = simState.ego.x;
    const scale = simState.road.scale;
    const originPxX = w * 0.22 - cameraX * scale;
    const centerPxY = h / 2.0;

    // Helper: Meter -> Canvas Pixel
    function toPx(mx, my) {
      return {
        x: originPxX + mx * scale,
        y: centerPxY - my * scale
      };
    }

    // A. Background (Indian roadside terrain - dirt/grass landscape)
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    // Dirt roadside shoulders
    const roadHalfH = (simState.road.width_m / 2.0) * scale;
    const shoulderH = simState.road.shoulder_width_m * scale;

    ctx.fillStyle = '#33271e'; // Unpaved reddish-brown Indian roadside dirt
    ctx.fillRect(0, centerPxY - roadHalfH - shoulderH, w, shoulderH);
    ctx.fillRect(0, centerPxY + roadHalfH, w, shoulderH);

    // Dirt shoulder boundary texture lines
    ctx.strokeStyle = '#4a3728';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, centerPxY - roadHalfH - shoulderH, w, shoulderH);
    ctx.strokeRect(0, centerPxY + roadHalfH, w, shoulderH);

    // B. Asphalt Road Surface
    ctx.fillStyle = '#1e293b'; // Dark aged asphalt
    ctx.fillRect(0, centerPxY - roadHalfH, w, roadHalfH * 2);

    // Irregular road boundaries (unmarked Indian road edges)
    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 2.0;
    ctx.setLineDash([12, 10]);
    ctx.beginPath();
    ctx.moveTo(0, centerPxY - roadHalfH);
    ctx.lineTo(w, centerPxY - roadHalfH);
    ctx.moveTo(0, centerPxY + roadHalfH);
    ctx.lineTo(w, centerPxY + roadHalfH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Centerline markings (unmarked or worn dashed white line)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = 2.0;
    ctx.setLineDash([16, 18]);
    ctx.beginPath();
    ctx.moveTo(0, centerPxY);
    ctx.lineTo(w, centerPxY);
    ctx.stroke();
    ctx.setLineDash([]);

    // C. Destination Flag Marker
    const targetPx = toPx(simState.target.x, simState.target.y);
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 3.0;
    ctx.beginPath();
    ctx.moveTo(targetPx.x, centerPxY - roadHalfH);
    ctx.lineTo(targetPx.x, centerPxY + roadHalfH);
    ctx.stroke();

    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.fillText('🏁 TARGET DESTINATION', targetPx.x + 8, centerPxY - roadHalfH + 18);

    // D. Candidate Trajectory Lattice (Gray / Cyan fan)
    if (simState.candidatePaths && simState.candidatePaths.length > 0) {
      simState.candidatePaths.forEach(cand => {
        if (!cand.path || cand.path.length === 0) return;

        ctx.strokeStyle = cand.isFeasible ? 'rgba(56, 189, 248, 0.22)' : 'rgba(244, 63, 94, 0.28)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash(cand.isFeasible ? [4, 4] : [2, 4]);

        ctx.beginPath();
        cand.path.forEach((pt, idx) => {
          const px = toPx(pt.x, pt.y);
          if (idx === 0) ctx.moveTo(px.x, px.y);
          else ctx.lineTo(px.x, px.y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      });
    }

    // E. Selected Optimal Trajectory (Vivid Neon Cyan)
    if (simState.ego.selected_path && simState.ego.selected_path.length > 0) {
      ctx.strokeStyle = '#06b6d4'; // Bright Cyan
      ctx.lineWidth = 3.5;
      ctx.shadowColor = '#06b6d4';
      ctx.shadowBlur = 10;

      ctx.beginPath();
      simState.ego.selected_path.forEach((pt, idx) => {
        const px = toPx(pt.x, pt.y);
        if (idx === 0) ctx.moveTo(px.x, px.y);
        else ctx.lineTo(px.x, px.y);
      });
      ctx.stroke();
      ctx.shadowBlur = 0; // reset
    }

    // F. Ego Vehicle History Trail
    if (simState.historyTrail.length > 1) {
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.35)';
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      simState.historyTrail.forEach((pt, idx) => {
        const px = toPx(pt.x, pt.y);
        if (idx === 0) ctx.moveTo(px.x, px.y);
        else ctx.lineTo(px.x, px.y);
      });
      ctx.stroke();
    }

    // G. Obstacles & Motion Predictions
    simState.obstacles.forEach(obs => {
      const obsPx = toPx(obs.x, obs.y);
      const radPx = obs.radius_m * scale;

      // 1. Collision Exclusion Buffer Zone (Translucent Red Circle)
      ctx.fillStyle = 'rgba(239, 68, 68, 0.14)';
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(obsPx.x, obsPx.y, radPx + 1.2 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // 2. Motion Prediction Vectors (Ghost circles at 1s, 2s, 3s)
      if (Math.hypot(obs.vx, obs.vy) > 0.1) {
        ctx.strokeStyle = 'rgba(251, 113, 133, 0.6)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(obsPx.x, obsPx.y);

        [1.0, 2.0, 3.0].forEach(t => {
          const futurePx = toPx(obs.x + obs.vx * t, obs.y + obs.vy * t);
          ctx.lineTo(futurePx.x, futurePx.y);

          // Draw ghost point
          ctx.fillStyle = 'rgba(251, 113, 133, 0.35)';
          ctx.beginPath();
          ctx.arc(futurePx.x, futurePx.y, radPx * 0.75, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 3. Render Specific Obstacle Geometry
      renderObstacleGraphic(ctx, obs, obsPx, radPx);

      // Label & Distance tag
      ctx.fillStyle = '#ffffff';
      ctx.font = '10px Inter, sans-serif';
      const distFromEgo = Math.hypot(obs.x - simState.ego.x, obs.y - simState.ego.y).toFixed(1);
      ctx.fillText(`${obs.id} (${distFromEgo}m)`, obsPx.x - radPx, obsPx.y - radPx - 6);
    });

    // H. Ego Autonomous Vehicle
    renderEgoVehicle(ctx, toPx(simState.ego.x, simState.ego.y), scale);
  }

  // --------------------------------------------------------------------------
  // GRAPHICS HELPERS
  // --------------------------------------------------------------------------
  function renderObstacleGraphic(ctx, obs, obsPx, radPx) {
    ctx.save();
    ctx.translate(obsPx.x, obsPx.y);

    if (obs.type === 'pedestrian') {
      // Pedestrian: Animated head and shoulder circle
      ctx.fillStyle = '#fb7185';
      ctx.beginPath();
      ctx.arc(0, 0, radPx, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Head
      ctx.fillStyle = '#fecdd3';
      ctx.beginPath();
      ctx.arc(0, 0, radPx * 0.45, 0, Math.PI * 2);
      ctx.fill();

    } else if (obs.type === 'motorcycle') {
      // Motorcycle / Scooter
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(-radPx * 1.4, -radPx * 0.4, radPx * 2.8, radPx * 0.8);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.0;
      ctx.strokeRect(-radPx * 1.4, -radPx * 0.4, radPx * 2.8, radPx * 0.8);

      // Rider helmet
      ctx.fillStyle = '#0284c7';
      ctx.beginPath();
      ctx.arc(0, 0, radPx * 0.5, 0, Math.PI * 2);
      ctx.fill();

    } else if (obs.type === 'pothole') {
      // Pothole: Irregular dark fissure
      ctx.fillStyle = '#090d16';
      ctx.beginPath();
      ctx.ellipse(0, 0, radPx * 1.2, radPx * 0.85, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2.0;
      ctx.stroke();

      // Hazard warning pattern
      ctx.fillStyle = '#f59e0b';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('POTHOLE', -radPx * 0.9, 3);

    } else if (obs.type === 'cattle') {
      // Stray Cow / Cattle
      ctx.fillStyle = '#a78bfa';
      ctx.beginPath();
      ctx.ellipse(0, 0, radPx * 1.3, radPx * 0.75, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#c4b5fd';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Ears / Horns
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px sans-serif';
      ctx.fillText('CATTLE', -radPx * 0.8, 3);

    } else if (obs.type === 'auto_rickshaw') {
      // Auto-rickshaw (Green and yellow Indian three-wheeler)
      ctx.fillStyle = '#15803d'; // Green base
      ctx.fillRect(-radPx * 1.1, -radPx * 0.8, radPx * 2.2, radPx * 1.6);
      ctx.fillStyle = '#eab308'; // Yellow top
      ctx.fillRect(-radPx * 0.8, -radPx * 0.7, radPx * 1.6, radPx * 1.4);
      ctx.strokeStyle = '#000000';
      ctx.strokeRect(-radPx * 1.1, -radPx * 0.8, radPx * 2.2, radPx * 1.6);

    } else {
      // Generic car / blockade
      ctx.fillStyle = obs.color || '#f97316';
      ctx.fillRect(-radPx * 1.2, -radPx * 0.8, radPx * 2.4, radPx * 1.6);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-radPx * 1.2, -radPx * 0.8, radPx * 2.4, radPx * 1.6);
    }

    ctx.restore();
  }

  function renderEgoVehicle(ctx, egoPx, scale) {
    const ego = simState.ego;
    const lenPx = ego.length_m * scale;
    const widPx = ego.width_m * scale;

    ctx.save();
    ctx.translate(egoPx.x, egoPx.y);
    ctx.rotate(ego.heading);

    // Headlights Beam Projection (Sweeping road ahead)
    const beamLen = 28.0 * scale;
    const grad = ctx.createRadialGradient(lenPx / 2, 0, 5, lenPx / 2 + beamLen, 0, beamLen * 0.6);
    grad.addColorStop(0, 'rgba(56, 189, 248, 0.45)');
    grad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(lenPx / 2, 0);
    ctx.lineTo(lenPx / 2 + beamLen, -widPx * 1.8);
    ctx.lineTo(lenPx / 2 + beamLen, widPx * 1.8);
    ctx.closePath();
    ctx.fill();

    // Vehicle Chassis
    ctx.fillStyle = '#0284c7'; // Deep Autonomous Cyan Body
    ctx.fillRect(-lenPx / 2, -widPx / 2, lenPx, widPx);

    // Outline
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2.0;
    ctx.strokeRect(-lenPx / 2, -widPx / 2, lenPx, widPx);

    // Windshield (Black glass)
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(-lenPx * 0.15, -widPx * 0.4, lenPx * 0.45, widPx * 0.8);

    // Roof & LiDAR sensor puck
    ctx.fillStyle = '#0369a1';
    ctx.fillRect(-lenPx * 0.35, -widPx * 0.35, lenPx * 0.4, widPx * 0.7);

    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.arc(-lenPx * 0.1, 0, 4, 0, Math.PI * 2);
    ctx.fill();

    // Front Headlights
    ctx.fillStyle = '#fef08a';
    ctx.fillRect(lenPx / 2 - 3, -widPx / 2 + 2, 3, 5);
    ctx.fillRect(lenPx / 2 - 3, widPx / 2 - 7, 3, 5);

    // Rear Taillights
    ctx.fillStyle = '#ef4444';
    ctx.fillRect(-lenPx / 2, -widPx / 2 + 2, 3, 5);
    ctx.fillRect(-lenPx / 2, widPx / 2 - 7, 3, 5);

    ctx.restore();
  }

  // --------------------------------------------------------------------------
  // 7. DASHBOARD HUD & ACTOR TABLE UPDATES
  // --------------------------------------------------------------------------
  function updateUIElements() {
    // Decision Banner
    const decisionBadge = document.getElementById('simDecisionBadge');
    const decisionDesc = document.getElementById('simDecisionDesc');

    if (decisionBadge) {
      decisionBadge.textContent = simState.activeDecision.replace('_', ' ');
      decisionBadge.className = 'sim-decision-badge';

      if (simState.activeDecision === 'NOMINAL_CRUISE') {
        decisionBadge.classList.add('nominal');
      } else if (simState.activeDecision === 'REDUCE_SPEED') {
        decisionBadge.classList.add('caution');
      } else if (simState.activeDecision === 'LATERAL_REPLAN') {
        decisionBadge.classList.add('replan');
      } else if (simState.activeDecision === 'EMERGENCY_STOP' || simState.activeDecision === 'COLLISION_DETECTED') {
        decisionBadge.classList.add('danger');
      }
    }

    if (decisionDesc) {
      decisionDesc.textContent = simState.decisionExplanation;
    }

    // Telemetry Readouts
    setElemText('simSpeedReadout', (simState.ego.v * 3.6).toFixed(1));
    setElemText('simAccelReadout', simState.ego.a.toFixed(2));
    setElemText('simSteeringReadout', ((simState.ego.steering * 180) / Math.PI).toFixed(1));
    setElemText('simLateralOffsetReadout', simState.ego.y.toFixed(2));
    setElemText('simProgressReadout', `${simState.ego.x.toFixed(1)} / ${simState.target.x.toFixed(0)}m`);
    setElemText('simTtcReadout', simState.timeToCollision > 20 ? '> 20s' : `${simState.timeToCollision.toFixed(1)}s`);
    setElemText('simTimeReadout', `${simState.time.toFixed(1)}s`);
    setElemText('simClearanceReadout', simState.minClearance > 100 ? '>100m' : `${simState.minClearance.toFixed(1)}m`);

    // Update Actor Table
    updateActorTable();
  }

  function setElemText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function updateActorTable() {
    const tbody = document.getElementById('simActorTableBody');
    if (!tbody) return;

    if (simState.obstacles.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No active obstacles in corridor</td></tr>';
      return;
    }

    tbody.innerHTML = simState.obstacles.map(obs => {
      const dist = Math.hypot(obs.x - simState.ego.x, obs.y - simState.ego.y);
      const isCritical = dist < 12.0;
      const statusClass = isCritical ? 'risk-critical' : dist < 25.0 ? 'risk-caution' : 'risk-safe';
      const statusLabel = isCritical ? 'CRITICAL' : dist < 25.0 ? 'CAUTION' : 'CLEAR';

      return `
        <tr>
          <td><span class="actor-dot" style="background:${obs.color || '#38bdf8'}"></span> <b>${obs.id}</b></td>
          <td>${obs.name}</td>
          <td>(${obs.x.toFixed(1)}, ${obs.y.toFixed(1)})</td>
          <td>${dist.toFixed(1)}m</td>
          <td><span class="badge ${statusClass}">${statusLabel}</span></td>
        </tr>
      `;
    }).join('');
  }

  // --------------------------------------------------------------------------
  // EXPORT / INITIALIZE ON DOM READY
  // --------------------------------------------------------------------------
  window.DrivingSimulation = {
    init: initSimulation,
    loadScenario: loadScenario,
    start: startSimulation,
    pause: pauseSimulation,
    spawnObstacleAhead: spawnObstacleAhead
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSimulation);
  } else {
    initSimulation();
  }
})();
