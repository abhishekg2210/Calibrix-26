/**
 * RoadGuard AI - Autonomous Driving Research Console (PS 06)
 * Upgraded Frontend Controller for Perception, Multi-Cam, Simulink, CARLA, Scenarios, & Dataset.
 */

(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  // Global state for research console
  const researchState = {
    activeTab: 'tab-cockpit',
    perceptionModel: null,
    activeScenarioId: 'scenario_1',
    simulinkLoopTimer: null,
    simulinkParams: {},
    carlaStatus: null
  };

  // ---------------------------------------------------------------------------
  // 1. TAB NAVIGATION
  // ---------------------------------------------------------------------------
  function initTabNavigation() {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetTab = tab.getAttribute('data-tab');
        switchTab(targetTab);
      });
    });
  }

  function switchTab(targetTab) {
    researchState.activeTab = targetTab;

    // Update active tab button style
    document.querySelectorAll('.nav-tab').forEach(t => {
      t.classList.toggle('active', t.getAttribute('data-tab') === targetTab);
    });

    // Toggle views
    const viewMap = {
      'tab-cockpit': 'view-cockpit',
      'tab-perception': 'view-perception',
      'tab-simulink': 'view-simulink',
      'tab-scenarios': 'view-scenarios',
      'tab-carla': 'view-carla',
      'tab-dataset': 'view-dataset',
      'tab-verification': 'view-verification'
    };

    Object.entries(viewMap).forEach(([tabId, viewId]) => {
      const viewEl = $(viewId);
      if (viewEl) {
        viewEl.hidden = (tabId !== targetTab);
      }
    });

    // Invalidate Leaflet map size when returning to cockpit
    if (targetTab === 'tab-cockpit' && window.roadguardMapInstance) {
      setTimeout(() => window.roadguardMapInstance.invalidateSize(), 150);
    }

    // Trigger initial data loads for active tab
    if (targetTab === 'tab-simulink') loadSimulinkSpec();
    if (targetTab === 'tab-scenarios') loadScenariosList();
    if (targetTab === 'tab-carla') checkCarlaStatus();
    if (targetTab === 'tab-dataset') loadDatasetHardwareAndValidation();
    if (targetTab === 'tab-verification') loadVerificationMatrix();
    if (targetTab === 'tab-perception') loadPerceptionStatus();
  }

  // ---------------------------------------------------------------------------
  // 2. AI PERCEPTION & CAMERA ANALYSIS
  // ---------------------------------------------------------------------------
  async function loadPerceptionStatus() {
    try {
      const res = await fetch('/api/autonomous/perception/status');
      const data = await res.json();
      if (data.ok && data.perception) {
        researchState.perceptionModel = data.perception;
        const badge = $('modelStatusBadge');
        if (badge) {
          badge.textContent = `ENGINE: ${data.perception.model_type} (${data.perception.status_text})`;
        }
      }
    } catch (e) {
      console.warn('Perception status check failed:', e);
    }
  }

  function initPerceptionControls() {
    const uploadInput = $('videoUploadInput');
    if (uploadInput) {
      uploadInput.addEventListener('change', handleVideoUpload);
    }

    const testFrameBtn = $('testDetectionBtn');
    if (testFrameBtn) {
      testFrameBtn.addEventListener('click', runFrameDetection);
    }

    const clearAnalysisBtn = $('clearAnalysisBtn');
    if (clearAnalysisBtn) {
      clearAnalysisBtn.addEventListener('click', clearPerceptionCanvas);
    }
  }

  async function handleVideoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const uploadStatus = $('uploadProgressStatus');
    if (uploadStatus) {
      uploadStatus.textContent = `Uploading '${file.name}' (${(file.size / (1024 * 1024)).toFixed(1)} MB)...`;
      uploadStatus.style.display = 'inline-block';
    }

    const formData = new FormData();
    formData.append('video', file);

    try {
      const res = await fetch('/api/autonomous/upload-video', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (!data.ok) {
        alert(data.error || 'Video upload failed.');
        if (uploadStatus) uploadStatus.textContent = 'Upload failed';
        return;
      }

      if (uploadStatus) {
        uploadStatus.textContent = `Processing frames... (Job ID: ${data.job_id})`;
      }

      // Poll video analysis job
      pollVideoJob(data.job_id);

    } catch (err) {
      alert(`Network error uploading video: ${err.message}`);
      if (uploadStatus) uploadStatus.textContent = 'Upload error';
    }
  }

  function pollVideoJob(jobId) {
    const uploadStatus = $('uploadProgressStatus');
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/autonomous/video-status/${jobId}`);
        const data = await res.json();
        if (data.ok && data.job) {
          const status = data.job.status;
          if (uploadStatus) {
            uploadStatus.textContent = `Video Analysis: ${status}...`;
          }

          if (status === 'COMPLETED' && data.job.result) {
            clearInterval(interval);
            if (uploadStatus) uploadStatus.textContent = `Analysis Completed (${data.job.result.frames_analyzed} frames analyzed)`;
            renderVideoAnalysisResults(data.job.result, jobId);
          } else if (status === 'FAILED') {
            clearInterval(interval);
            if (uploadStatus) uploadStatus.textContent = `Analysis Failed: ${data.job.error}`;
          }
        }
      } catch (err) {
        clearInterval(interval);
      }
    }, 1500);
  }

  function renderVideoAnalysisResults(result, jobId) {
    // Render latency and summary metrics
    const infMetric = $('infTimeMetric');
    if (infMetric) infMetric.textContent = `${result.avg_inference_latency_ms} ms`;

    // Render snapshot on front camera
    if (result.snapshots && result.snapshots.length > 0) {
      const frontImg = $('frontCamImage');
      const frontPlaceholder = $('frontCamPlaceholder');
      if (frontImg) {
        frontImg.src = `/api/autonomous/video-snapshot/${jobId}/${result.snapshots[0]}`;
        frontImg.hidden = false;
      }
      if (frontPlaceholder) frontPlaceholder.hidden = true;
    }

    // Populate timeline and detected objects
    if (result.timeline && result.timeline.length > 0) {
      const last = result.timeline[result.timeline.length - 1];
      updateRiskBanner(last.risk_state, last.target_speed_kmh, `Peak Scene Risk: ${result.peak_risk_state}`);
    }
  }

  async function runFrameDetection() {
    const btn = $('testDetectionBtn');
    if (btn) btn.disabled = true;

    try {
      const res = await fetch('/api/autonomous/detect-frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();

      if (data.ok) {
        // Display preview
        const frontImg = $('frontCamImage');
        const frontPlaceholder = $('frontCamPlaceholder');
        if (frontImg && data.annotated_image_preview) {
          frontImg.src = data.annotated_image_preview;
          frontImg.hidden = false;
        }
        if (frontPlaceholder) frontPlaceholder.hidden = true;

        // Update latency metrics
        if ($('infTimeMetric')) $('infTimeMetric').textContent = `${data.inference_latency_ms} ms`;
        if ($('planTimeMetric') && data.path_plan) $('planTimeMetric').textContent = `${data.path_plan.planning_time_ms} ms`;

        // Update Risk Banner
        if (data.risk_assessment) {
          updateRiskBanner(
            data.risk_assessment.decision_state,
            data.risk_assessment.target_speed_kmh,
            data.risk_assessment.status_text,
            data.risk_assessment.min_ttc_s,
            data.risk_assessment.min_distance_m
          );
        }

        // Populate Detected Objects Table
        renderDetectionsTable(data.tracked_objects || []);
      }
    } catch (err) {
      alert(`Frame detection error: ${err.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function updateRiskBanner(decisionState, targetSpeed, statusText, ttc, dist) {
    const banner = $('riskStatusBanner');
    if (!banner) return;

    banner.className = `risk-status-banner ${decisionState.toLowerCase().replace(/_/g, '-')}`;

    const titleEl = $('riskDecisionTitle');
    if (titleEl) titleEl.textContent = `DECISION STATE: ${decisionState.replace(/_/g, ' ')}`;

    const textEl = $('riskDecisionSubtitle');
    if (textEl) textEl.textContent = statusText || 'Scene safe. Cruising within roadway margins.';

    const speedEl = $('riskTargetSpeed');
    if (speedEl) speedEl.textContent = `${targetSpeed !== undefined ? targetSpeed : 35.0} km/h`;

    const ttcEl = $('riskMinTTC');
    if (ttcEl) ttcEl.textContent = ttc ? `${ttc} s` : 'SAFE';

    const distEl = $('riskMinDist');
    if (distEl) distEl.textContent = dist ? `${dist} m` : 'CLEAR';
  }

  function renderDetectionsTable(tracks) {
    const tbody = $('detectedObjectsTbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!tracks || tracks.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#6b8274;">No objects detected in current frame corridor.</td></tr>';
      return;
    }

    tracks.forEach(t => {
      const row = document.createElement('tr');
      const hasPred = t.predicted_trajectory && t.predicted_trajectory.length > 0;
      row.innerHTML = `
        <td><b>#${t.track_id}</b></td>
        <td><span class="badge-pill badge-live">${t.class_name}</span></td>
        <td>${Math.round(t.confidence * 100)}%</td>
        <td>(${t.centroid.x}, ${t.centroid.y})</td>
        <td>${t.velocity ? t.velocity.speed + ' px/s' : '0.0'}</td>
        <td><small style="color:${hasPred ? '#00e59b' : '#ffb84d'};">${hasPred ? 'Extrapolating Path (5 steps)' : 'Single Observation (Needs history)'}</small></td>
      `;
      tbody.appendChild(row);
    });
  }

  function clearPerceptionCanvas() {
    const frontImg = $('frontCamImage');
    const frontPlaceholder = $('frontCamPlaceholder');
    if (frontImg) {
      frontImg.src = '';
      frontImg.hidden = true;
    }
    if (frontPlaceholder) frontPlaceholder.hidden = false;

    updateRiskBanner('NORMAL', 35.0, 'Perception standby. System monitoring sensors.');
    const tbody = $('detectedObjectsTbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#6b8274;">Perception standby. Click \'Test Frame Detection\' or upload a video.</td></tr>';
  }

  // ---------------------------------------------------------------------------
  // 3. MATHWORKS SIMULINK BICYCLE MODEL CO-SIMULATION
  // ---------------------------------------------------------------------------
  async function loadSimulinkSpec() {
    try {
      const res = await fetch('/api/autonomous/simulink/model-spec');
      const data = await res.json();
      if (data.ok) {
        researchState.simulinkParams = data.parameters;
        // Update input slider labels
        if ($('paramWheelbaseVal')) $('paramWheelbaseVal').textContent = `${data.parameters.wheelbase_m} m`;
        if ($('paramMassVal')) $('paramMassVal').textContent = `${data.parameters.mass_kg} kg`;
        if ($('paramSteerVal')) $('paramSteerVal').textContent = `${data.parameters.max_steer_deg}°`;
        if ($('simulinkStateflowMode')) $('simulinkStateflowMode').textContent = data.stateflow_mode;
      }
    } catch (e) {
      console.warn('Could not load Simulink spec:', e);
    }
  }

  function initSimulinkControls() {
    const stepBtn = $('simulinkStepBtn');
    if (stepBtn) {
      stepBtn.addEventListener('click', () => stepSimulink(1));
    }

    const runLoopBtn = $('simulinkRunLoopBtn');
    if (runLoopBtn) {
      runLoopBtn.addEventListener('click', toggleSimulinkLoop);
    }

    const resetBtn = $('simulinkResetBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', resetSimulink);
    }

    // Sliders
    const massSlider = $('sliderMass');
    if (massSlider) {
      massSlider.addEventListener('input', e => {
        const val = parseFloat(e.target.value);
        if ($('paramMassVal')) $('paramMassVal').textContent = `${val} kg`;
        updateSimulinkParam('mass_kg', val);
      });
    }

    const wheelbaseSlider = $('sliderWheelbase');
    if (wheelbaseSlider) {
      wheelbaseSlider.addEventListener('input', e => {
        const val = parseFloat(e.target.value);
        if ($('paramWheelbaseVal')) $('paramWheelbaseVal').textContent = `${val} m`;
        updateSimulinkParam('wheelbase_m', val);
      });
    }
  }

  async function updateSimulinkParam(key, val) {
    try {
      await fetch('/api/autonomous/simulink/update-params', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: val })
      });
    } catch (e) {}
  }

  async function stepSimulink(steps = 1) {
    const steerAngle = parseFloat($('simSteerInput') ? $('simSteerInput').value : 0.0);
    const targetVel = parseFloat($('simSpeedInput') ? $('simSpeedInput').value : 10.0);

    try {
      const res = await fetch('/api/autonomous/simulink/run-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          steering_deg: steerAngle,
          target_velocity_mps: targetVel,
          dt: 0.05,
          risk_level: 'NORMAL'
        })
      });
      const data = await res.json();
      if (data.ok) {
        updateSimulinkTelemetry(data);
      }
    } catch (e) {
      console.warn('Simulink step failed:', e);
    }
  }

  function toggleSimulinkLoop() {
    const btn = $('simulinkRunLoopBtn');
    if (researchState.simulinkLoopTimer) {
      clearInterval(researchState.simulinkLoopTimer);
      researchState.simulinkLoopTimer = null;
      if (btn) btn.textContent = '▶ Run Continuous Co-Simulation';
    } else {
      if (btn) btn.textContent = '⏹ Stop Co-Simulation';
      researchState.simulinkLoopTimer = setInterval(() => {
        stepSimulink(1);
      }, 100);
    }
  }

  async function resetSimulink() {
    if (researchState.simulinkLoopTimer) {
      clearInterval(researchState.simulinkLoopTimer);
      researchState.simulinkLoopTimer = null;
      if ($('simulinkRunLoopBtn')) $('simulinkRunLoopBtn').textContent = '▶ Run Continuous Co-Simulation';
    }
    await loadSimulinkSpec();
    stepSimulink(1);
  }

  function updateSimulinkTelemetry(stepData) {
    const s = stepData.state;
    if ($('simMetricVx')) $('simMetricVx').textContent = `${stepData.telemetry.speed_kmh} km/h`;
    if ($('simMetricLatG')) $('simMetricLatG').textContent = `${stepData.telemetry.lateral_g} G`;
    if ($('simMetricYawRate')) $('simMetricYawRate').textContent = `${stepData.telemetry.yaw_rate_deg_s} °/s`;
    if ($('simMetricSlip')) $('simMetricSlip').textContent = `${stepData.telemetry.slip_deg}°`;
    if ($('simulinkStateflowMode')) $('simulinkStateflowMode').textContent = stepData.stateflow_state;
  }

  // ---------------------------------------------------------------------------
  // 4. FIVE INDIAN ROAD SCENARIOS BENCH
  // ---------------------------------------------------------------------------
  async function loadScenariosList() {
    try {
      const res = await fetch('/api/autonomous/scenarios');
      const data = await res.json();
      if (data.ok && data.scenarios) {
        renderScenarioCards(data.scenarios);
      }
    } catch (e) {
      console.warn('Scenarios load error:', e);
    }
  }

  function renderScenarioCards(scenarios) {
    const container = $('scenariosCardsGrid');
    if (!container) return;
    container.innerHTML = '';

    const iconMap = {
      'scenario_1': '🌾',
      'scenario_2': '🚦',
      'scenario_3': '🛣️',
      'scenario_4': '🐂',
      'scenario_5': '⛔'
    };

    scenarios.forEach(scen => {
      const card = document.createElement('div');
      card.className = `scenario-card ${scen.id === researchState.activeScenarioId ? 'active' : ''}`;
      card.setAttribute('data-id', scen.id);

      card.innerHTML = `
        <div class="scenario-card-head">
          <span class="scenario-icon">${iconMap[scen.id] || '🚗'}</span>
          <span class="badge-pill badge-simulated">${scen.map}</span>
        </div>
        <h4>${scen.name}</h4>
        <p>${scen.description}</p>
        <div class="scenario-actors-tags">
          ${scen.actors.map(a => `<span class="actor-tag">${a.role}: ${a.blueprint.split('.')[1] || a.blueprint}</span>`).join('')}
        </div>
      `;

      card.addEventListener('click', () => {
        document.querySelectorAll('.scenario-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        researchState.activeScenarioId = scen.id;
        renderSelectedScenarioDetails(scen);
      });

      container.appendChild(card);
    });

    // Render active scenario details
    const activeScen = scenarios.find(s => s.id === researchState.activeScenarioId) || scenarios[0];
    if (activeScen) renderSelectedScenarioDetails(activeScen);
  }

  function renderSelectedScenarioDetails(scen) {
    if ($('activeScenarioTitle')) $('activeScenarioTitle').textContent = scen.name;
    if ($('activeScenarioDesc')) $('activeScenarioDesc').textContent = scen.description;
    if ($('activeScenarioMap')) $('activeScenarioMap').textContent = scen.map;
    if ($('activeScenarioAssetNote')) $('activeScenarioAssetNote').textContent = scen.asset_notes;
  }

  function initScenarioControls() {
    const runBtn = $('runScenarioBtn');
    if (runBtn) {
      runBtn.addEventListener('click', executeScenarioBenchmark);
    }

    const exportBtn = $('exportScenarioBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', exportScenarioResultsJSON);
    }
  }

  let latestScenarioResult = null;

  async function executeScenarioBenchmark() {
    const btn = $('runScenarioBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Running Evaluation...';
    }

    try {
      const res = await fetch('/api/autonomous/scenarios/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario_id: researchState.activeScenarioId })
      });
      const data = await res.json();
      if (data.ok) {
        latestScenarioResult = data;
        renderScenarioTimeline(data);
      }
    } catch (err) {
      alert(`Scenario execution error: ${err.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '▶ Run Scenario Benchmark';
      }
    }
  }

  function renderScenarioTimeline(data) {
    const tbody = $('scenarioTimelineTbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    // Verdict Badge
    const verdictEl = $('scenarioVerdictBadge');
    if (verdictEl) {
      verdictEl.textContent = data.success ? 'TEST VERDICT: PASSED (COLLISION-FREE)' : 'TEST VERDICT: FAILED';
      verdictEl.className = `badge-pill ${data.success ? 'badge-live' : 'badge-offline'}`;
    }

    if ($('scenarioAvgLatency')) $('scenarioAvgLatency').textContent = `${data.evaluation_metrics.average_planning_latency_ms} ms`;
    if ($('scenarioExecMode')) $('scenarioExecMode').textContent = data.execution_mode;

    data.timeline.forEach(step => {
      const tr = document.createElement('tr');
      const riskClass = step.risk_decision === 'STOP_REQUIRED' || step.risk_decision === 'NO_SAFE_PATH_AVAILABLE' ? 'color:var(--red);font-weight:800;' :
                        step.risk_decision === 'HIGH_RISK' ? 'color:#ff9800;font-weight:700;' :
                        step.risk_decision === 'CAUTION' ? 'color:var(--amber);' : 'color:var(--green);';

      tr.innerHTML = `
        <td>${step.time_s}s</td>
        <td>${step.ego_speed_kmh} km/h</td>
        <td style="${riskClass}">${step.risk_decision}</td>
        <td><code>${step.planner_action}</code></td>
        <td>${step.detected_objects.map(d => `${d.class_name} (${d.dist_m}m)`).join(', ')}</td>
        <td>${step.planning_latency_ms} ms</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function exportScenarioResultsJSON() {
    if (!latestScenarioResult) {
      alert('Please run a scenario benchmark first before exporting results.');
      return;
    }
    const blob = new Blob([JSON.stringify(latestScenarioResult, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${latestScenarioResult.scenario.id}_benchmark_results.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------------------------------------------------------------------------
  // 5. CARLA SIMULATION BRIDGE
  // ---------------------------------------------------------------------------
  async function checkCarlaStatus() {
    try {
      const res = await fetch('/api/autonomous/carla/status');
      const data = await res.json();
      researchState.carlaStatus = data;

      const badge = $('carlaServerBadge');
      if (badge) {
        badge.textContent = data.connected ? 'CARLA 0.9.13+: ONLINE (PORT 2000)' : 'CARLA SERVER: OFFLINE / STANDBY';
        badge.className = `badge-pill ${data.connected ? 'badge-live' : 'badge-offline'}`;
      }

      const instructionsEl = $('carlaInstructionsText');
      if (instructionsEl) instructionsEl.textContent = data.instructions;
    } catch (e) {
      console.warn('CARLA probe failed:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // 6. DATASET VALIDATION & TRAINING STUDIO
  // ---------------------------------------------------------------------------
  async function loadDatasetHardwareAndValidation() {
    try {
      const [hwRes, valRes] = await Promise.all([
        fetch('/api/autonomous/dataset/hardware'),
        fetch('/api/autonomous/dataset/validate')
      ]);
      const hwData = await hwRes.json();
      const valData = await valRes.json();

      if (hwData.ok) {
        if ($('dsHardwareDevice')) $('dsHardwareDevice').textContent = hwData.hardware.device_name;
        if ($('dsCudaBadge')) {
          $('dsCudaBadge').textContent = hwData.hardware.cuda_available ? 'CUDA ACTIVE' : 'CPU FALLBACK';
          $('dsCudaBadge').className = `badge-pill ${hwData.hardware.cuda_available ? 'badge-live' : 'badge-simulated'}`;
        }
      }

      if (valData.ok) {
        if ($('dsTrainImagesCount')) $('dsTrainImagesCount').textContent = valData.train_images_count;
        if ($('dsValImagesCount')) $('dsValImagesCount').textContent = valData.val_images_count;
        if ($('dsAnnotationsCount')) $('dsAnnotationsCount').textContent = valData.total_annotations;
        if ($('dsValidationStatusBadge')) {
          $('dsValidationStatusBadge').textContent = valData.status;
          $('dsValidationStatusBadge').className = `badge-pill ${valData.invalid_annotations_count === 0 ? 'badge-live' : 'badge-offline'}`;
        }
      }
    } catch (e) {
      console.warn('Dataset info check failed:', e);
    }
  }

  function initDatasetControls() {
    const trainBtn = $('startTrainingBtn');
    if (trainBtn) {
      trainBtn.addEventListener('click', startModelTraining);
    }
  }

  async function startModelTraining() {
    const epochs = parseInt($('trainEpochsInput') ? $('trainEpochsInput').value : 5);
    const batch = parseInt($('trainBatchInput') ? $('trainBatchInput').value : 8);

    const btn = $('startTrainingBtn');
    if (btn) btn.disabled = true;

    try {
      const res = await fetch('/api/autonomous/dataset/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epochs, batch_size: batch })
      });
      const data = await res.json();
      if (data.ok) {
        alert(data.message);
        pollTrainingJob(data.job_id);
      } else {
        alert(data.error || 'Failed to start training.');
      }
    } catch (err) {
      alert(`Training invocation error: ${err.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function pollTrainingJob(jobId) {
    const logBox = $('trainingLogsTerminal');
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/autonomous/dataset/job-status/${jobId}`);
        const data = await res.json();
        if (data.ok && data.job) {
          if (logBox) {
            logBox.textContent = data.job.logs.join('\n');
            logBox.scrollTop = logBox.scrollHeight;
          }
          if (data.job.status === 'COMPLETED' || data.job.status === 'FAILED') {
            clearInterval(interval);
          }
        }
      } catch (e) {
        clearInterval(interval);
      }
    }, 2000);
  }

  // ---------------------------------------------------------------------------
  // 7. SYSTEM VERIFICATION MATRIX
  // ---------------------------------------------------------------------------
  async function loadVerificationMatrix() {
    try {
      const res = await fetch('/api/autonomous/feature-matrix');
      const data = await res.json();
      if (!data.ok) return;

      const workingTbody = $('matrixWorkingTbody');
      if (workingTbody) {
        workingTbody.innerHTML = data.working.map(w => `
          <tr>
            <td><b>${w.feature}</b></td>
            <td>${w.detail}</td>
            <td><span class="matrix-status-pill working">WORKING</span></td>
          </tr>
        `).join('');
      }

      const simulatedTbody = $('matrixSimulatedTbody');
      if (simulatedTbody) {
        simulatedTbody.innerHTML = data.simulated.map(s => `
          <tr>
            <td><b>${s.feature}</b></td>
            <td>${s.detail}</td>
            <td><span class="matrix-status-pill simulated">SIMULATED</span></td>
          </tr>
        `).join('');
      }

      const notConfigTbody = $('matrixNotConfiguredTbody');
      if (notConfigTbody) {
        notConfigTbody.innerHTML = data.not_configured.map(n => `
          <tr>
            <td><b>${n.feature}</b></td>
            <td>${n.detail}</td>
            <td><span class="matrix-status-pill not-configured">${n.status}</span></td>
          </tr>
        `).join('');
      }
    } catch (e) {
      console.warn('Matrix load error:', e);
    }
  }

  // ---------------------------------------------------------------------------
  // INITIALIZATION ON DOM READY
  // ---------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    initTabNavigation();
    initPerceptionControls();
    initSimulinkControls();
    initScenarioControls();
    initDatasetControls();
    loadPerceptionStatus();
  });

})();
