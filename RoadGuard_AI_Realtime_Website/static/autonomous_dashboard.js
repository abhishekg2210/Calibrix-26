/**
 * RoadGuard AI - Autonomous Driving Research Console (PS 06)
 * Upgraded Frontend Controller for Perception, Real Video Upload & Inference,
 * MathWorks 3D Trajectory Simulator, Simulink Bicycle Model, & Verification Matrix.
 */

(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  // Global state for research console
  const researchState = {
    activeTab: 'tab-cockpit',
    backendType: 'Detecting...',
    perceptionModel: null,
    activeScenarioId: 'scenario_1',
    simulinkLoopTimer: null,
    simulinkParams: {},
    carlaStatus: null,
    activeSimCaseIndex: 0,
    trajectoryAnimPhase: 0.0
  };

  // ---------------------------------------------------------------------------
  // 1. BACKEND HEALTH & TAB NAVIGATION
  // ---------------------------------------------------------------------------

  async function checkBackendHealth() {
    const t0 = performance.now();
    try {
      const res = await fetch('/api/health');
      const pingMs = Math.round(performance.now() - t0);
      const data = await res.json();

      const healthBadge = $('backendHealthBadge');
      if (healthBadge) {
        researchState.backendType = data.backend || 'Backend';
        healthBadge.textContent = `BACKEND: ${data.backend || 'API'} ONLINE (${pingMs}ms)`;
        healthBadge.className = 'badge-pill badge-live';
      }

      if (data.perception) {
        updatePerceptionBadge(data.perception);
      }
    } catch (err) {
      const healthBadge = $('backendHealthBadge');
      if (healthBadge) {
        healthBadge.textContent = 'BACKEND: OFFLINE / UNREACHABLE';
        healthBadge.className = 'badge-pill badge-offline';
      }
    }
  }

  function updatePerceptionBadge(perception) {
    researchState.perceptionModel = perception;
    const badge = $('modelStatusBadge');
    if (!badge) return;

    if (perception.configured) {
      badge.textContent = `ENGINE: ${perception.model_type} (ACTIVE)`;
      badge.className = 'badge-pill badge-live';
    } else {
      badge.textContent = 'ENGINE: NOT CONFIGURED (Setup Required)';
      badge.className = 'badge-pill badge-offline';
      badge.title = perception.setup_instructions || 'Model weights not found.';
    }
  }

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
    if (targetTab === 'tab-simulink') {
      loadSimulinkSpec();
      renderRealisticTrajectorySimulation();
    }
    if (targetTab === 'tab-scenarios') loadScenariosList();
    if (targetTab === 'tab-carla') checkCarlaStatus();
    if (targetTab === 'tab-dataset') loadDatasetHardwareAndValidation();
    if (targetTab === 'tab-verification') loadVerificationMatrix();
    if (targetTab === 'tab-perception') checkBackendHealth();
  }

  // ---------------------------------------------------------------------------
  // 2. VIDEO UPLOAD, VALIDATION, & REAL YOLO INFERENCE (PHASE B & C)
  // ---------------------------------------------------------------------------

  const ALLOWED_VIDEO_EXTS = ['.mp4', '.avi', '.mov', '.mkv', '.webm'];
  const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

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

    // 1. Client-Side Format Validation
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!ALLOWED_VIDEO_EXTS.includes(ext)) {
      alert(`Invalid video format '${ext}'. Allowed road-video formats: ${ALLOWED_VIDEO_EXTS.join(', ')}.`);
      e.target.value = '';
      return;
    }

    // 2. Client-Side File-Size Validation
    if (file.size === 0) {
      alert('Selected video file is empty (0 bytes).');
      e.target.value = '';
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      alert(`Selected file size (${sizeMB} MB) exceeds maximum allowed limit of 50 MB.`);
      e.target.value = '';
      return;
    }

    // Update UI source labels
    const uploadStatus = $('uploadProgressStatus');
    const sourceBadge = $('frontCamSourceBadge');
    const sourceLabel = $('videoSourceTypeLabel');

    if (sourceBadge) sourceBadge.textContent = `SOURCE: UPLOADED VIDEO ('${file.name}')`;
    if (sourceLabel) sourceLabel.textContent = `FILE: ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;

    if (uploadStatus) {
      uploadStatus.style.display = 'block';
      uploadStatus.textContent = `Uploading '${file.name}' (${(file.size / (1024 * 1024)).toFixed(1)} MB)...`;
    }

    appendEventLog('UPLOAD', `Uploading road video '${file.name}' (${(file.size / (1024 * 1024)).toFixed(1)} MB).`);

    const formData = new FormData();
    formData.append('video', file);

    try {
      const res = await fetch('/api/autonomous/upload-video', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();

      if (!res.ok || !data.ok) {
        const errorMsg = data.error || 'Video upload failed.';
        alert(`Upload Error: ${errorMsg}`);
        if (uploadStatus) uploadStatus.textContent = `Upload failed: ${errorMsg}`;
        appendEventLog('ERROR', `Upload rejected: ${errorMsg}`);
        return;
      }

      if (uploadStatus) {
        uploadStatus.textContent = `Video validated. Starting YOLO frame-by-frame inference (Job ID: ${data.job_id})...`;
      }

      appendEventLog('VALIDATED', `Video validated: ${data.metadata.resolution}, ${data.metadata.fps} FPS. Processing started.`);

      // Poll video analysis job
      pollVideoJob(data.job_id, file.name);

    } catch (err) {
      alert(`Network error uploading video: ${err.message}`);
      if (uploadStatus) uploadStatus.textContent = `Network error: ${err.message}`;
      appendEventLog('ERROR', `Network failure uploading video: ${err.message}`);
    }
  }

  function pollVideoJob(jobId, fileName) {
    const uploadStatus = $('uploadProgressStatus');
    const frontImg = $('frontCamImage');
    const frontPlaceholder = $('frontCamPlaceholder');

    let lastSnapshotSeen = null;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/autonomous/video-status/${jobId}`);
        const data = await res.json();

        if (data.ok && data.job) {
          const job = data.job;
          const status = job.status;
          const pct = job.progress_pct || 0;
          const analyzed = job.analyzed_frames || 0;
          const activeCount = job.active_detections_count || 0;

          if (uploadStatus) {
            uploadStatus.textContent = `Processing '${fileName}': Analyzed ${analyzed} frames (${pct}%)... Active Obstacles: ${activeCount}`;
          }

          // Live frame streaming from snapshots
          if (job.snapshots && job.snapshots.length > 0) {
            const latest = job.snapshots[job.snapshots.length - 1];
            if (latest !== lastSnapshotSeen) {
              lastSnapshotSeen = latest;
              if (frontImg) {
                frontImg.src = `/api/autonomous/video-snapshot/${jobId}/${latest}?t=${Date.now()}`;
                frontImg.hidden = false;
              }
              if (frontPlaceholder) frontPlaceholder.hidden = true;
            }
          }

          // Ingest new events from backend job
          if (job.events && job.events.length > 0) {
            const latestEvt = job.events[job.events.length - 1];
            if (!job._lastReportedEvt || job._lastReportedEvt !== latestEvt.message) {
              job._lastReportedEvt = latestEvt.message;
              appendEventLog(latestEvt.type, latestEvt.message);
            }
          }

          if (status === 'COMPLETED' && job.result) {
            clearInterval(interval);
            if (uploadStatus) {
              uploadStatus.textContent = `Analysis Completed: ${job.result.frames_analyzed} frames analyzed. Found ${job.result.total_objects_detected} total objects.`;
            }
            renderVideoAnalysisResults(job.result, jobId);
          } else if (status === 'FAILED') {
            clearInterval(interval);
            if (uploadStatus) {
              uploadStatus.textContent = `Analysis Failed: ${job.error}`;
            }
            appendEventLog('ERROR', `Video analysis job failed: ${job.error}`);
          }
        }
      } catch (err) {
        clearInterval(interval);
        console.warn('Video status polling error:', err);
      }
    }, 1200);
  }

  function renderVideoAnalysisResults(result, jobId) {
    const infMetric = $('infTimeMetric');
    if (infMetric) infMetric.textContent = `${result.avg_inference_latency_ms} ms`;

    // Render snapshot
    if (result.snapshots && result.snapshots.length > 0) {
      const frontImg = $('frontCamImage');
      const frontPlaceholder = $('frontCamPlaceholder');
      if (frontImg) {
        frontImg.src = `/api/autonomous/video-snapshot/${jobId}/${result.snapshots[0]}`;
        frontImg.hidden = false;
      }
      if (frontPlaceholder) frontPlaceholder.hidden = true;
    }

    // Populate detected objects table with real detections from last frame
    if (result.timeline && result.timeline.length > 0) {
      const last = result.timeline[result.timeline.length - 1];
      if (last.detections) {
        renderDetectionsTableFromRaw(last.detections);
      }
    }

    appendEventLog('SUMMARY', `Inference finished. Class Summary: ${JSON.stringify(result.detected_classes_summary)}.`);
  }

  async function runFrameDetection() {
    const btn = $('testDetectionBtn');
    if (btn) btn.disabled = true;

    try {
      appendEventLog('FRAME_TEST', 'Executing single-frame YOLO forward pass...');
      const res = await fetch('/api/autonomous/detect-frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await res.json();

      if (data.ok) {
        const frontImg = $('frontCamImage');
        const frontPlaceholder = $('frontCamPlaceholder');
        if (frontImg && data.annotated_image_preview) {
          frontImg.src = data.annotated_image_preview;
          frontImg.hidden = false;
        }
        if (frontPlaceholder) frontPlaceholder.hidden = true;

        if ($('infTimeMetric')) $('infTimeMetric').textContent = `${data.inference_latency_ms} ms`;

        // Render real detected objects
        renderDetectionsTableFromRaw(data.detections || []);
        appendEventLog('DETECTION', `Detected ${data.detections_count} objects in frame. Inference: ${data.inference_latency_ms} ms.`);
      } else {
        alert(data.error || 'Frame detection failed.');
      }
    } catch (err) {
      alert(`Frame detection error: ${err.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderDetectionsTableFromRaw(detections) {
    const tbody = $('detectedObjectsTbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!detections || detections.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#6b8274;">No objects detected in current frame corridor.</td></tr>';
      return;
    }

    detections.forEach((d, idx) => {
      const row = document.createElement('tr');
      const box = d.bbox || [0, 0, 0, 0];
      const cx = Math.round((box[0] + box[2]) / 2);
      const cy = Math.round((box[1] + box[3]) / 2);

      row.innerHTML = `
        <td><b>#${idx + 1}</b></td>
        <td><span class="badge-pill badge-live">${d.class_name}</span></td>
        <td>${Math.round(d.confidence * 100)}%</td>
        <td>(${cx}, ${cy}) [Box: ${box.join(', ')}]</td>
        <td>Measured Tensor Output</td>
        <td><small style="color:#00e59b;">Active Bounding Box</small></td>
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

    const tbody = $('detectedObjectsTbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#6b8274;">Perception standby. Click \'Test Frame Detection\' or upload a video.</td></tr>';

    const uploadStatus = $('uploadProgressStatus');
    if (uploadStatus) uploadStatus.style.display = 'none';

    appendEventLog('STANDBY', 'Perception feed cleared. System monitoring standby.');
  }

  function appendEventLog(type, message) {
    const eventLog = $('eventLog');
    if (!eventLog) return;

    const timeStr = new Date().toTimeString().split(' ')[0];
    const eventEl = document.createElement('div');
    eventEl.className = 'event';

    const dotColor = (type === 'ERROR') ? 'red' : ((type === 'DETECTION' || type === 'COMPLETED') ? 'green' : 'amber');

    eventEl.innerHTML = `
      <span class="event-dot ${dotColor}"></span>
      <div>
        <b>[${timeStr}] ${type}</b>
        <small>${message}</small>
        <time>Just now</time>
      </div>
    `;

    eventLog.insertBefore(eventEl, eventLog.firstChild);
    while (eventLog.children.length > 20) {
      eventLog.removeChild(eventLog.lastChild);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. REALISTIC 3D TRAJECTORY VISUALIZER (MathWorks Automated Driving Toolbox)
  // ---------------------------------------------------------------------------

  const SIMULATION_CASES = [
    {
      name: "Case 1: Highway Evasion & Lane Change",
      subtitle: "Approaching slower truck #58 at 35m. Optimal path (cyan) maneuvers to left lane; center collision path (red) rejected.",
      obstacles: [
        { id: 58, xRel: 0, zRel: 130, width: 44, height: 38, type: "truck", color: "#e65100", speedKmh: 20 },
        { id: 10, xRel: 95, zRel: 180, width: 36, height: 28, type: "car", color: "#fb8c00", speedKmh: 45 },
        { id: 3,  xRel: -130, zRel: 230, width: 38, height: 30, type: "car", color: "#8e24aa", speedKmh: 60 }
      ],
      selectedPathOffset: -55,
      collisionPathOffset: 0
    },
    {
      name: "Case 2: Sudden Pedestrian Crossing (Unmarked Road)",
      subtitle: "Pedestrian #14 crossing into corridor at 20m. Evasive path yields with emergency lateral clearance.",
      obstacles: [
        { id: 14, xRel: 25, zRel: 110, width: 18, height: 32, type: "pedestrian", color: "#00e676", speedKmh: 4 },
        { id: 62, xRel: -90, zRel: 220, width: 38, height: 28, type: "car", color: "#3949ab", speedKmh: 35 }
      ],
      selectedPathOffset: -65,
      collisionPathOffset: 25
    },
    {
      name: "Case 3: Informal Two-Wheeler Merge (Urban)",
      subtitle: "Motorcycle #21 merging diagonally from right shoulder. Trajectory adjusts speed to 18 km/h.",
      obstacles: [
        { id: 21, xRel: 30, zRel: 120, width: 22, height: 26, type: "motorcycle", color: "#ffb300", speedKmh: 28 },
        { id: 4,  xRel: -80, zRel: 170, width: 38, height: 30, type: "car", color: "#43a047", speedKmh: 40 }
      ],
      selectedPathOffset: -40,
      collisionPathOffset: 30
    },
    {
      name: "Case 4: Pothole & Road Damage Avoidance",
      subtitle: "Severe road crater #7 in middle of lane. Lattice generator calculates within-lane lateral deflection (+1.2m).",
      obstacles: [
        { id: 7,  xRel: 0, zRel: 100, width: 30, height: 16, type: "pothole", color: "#e53935", speedKmh: 0 },
        { id: 78, xRel: 80, zRel: 240, width: 36, height: 28, type: "car", color: "#0288d1", speedKmh: 50 }
      ],
      selectedPathOffset: 55,
      collisionPathOffset: 0
    },
    {
      name: "Case 5: Cattle Herd Roadblock (Safe Stop)",
      subtitle: "Cattle #40 & #41 blocking all drivable corridors. All candidate trajectories rejected; immediate safe stop.",
      obstacles: [
        { id: 40, xRel: -20, zRel: 120, width: 36, height: 30, type: "cattle", color: "#ec407a", speedKmh: 0 },
        { id: 41, xRel: 45, zRel: 125, width: 36, height: 30, type: "cattle", color: "#d81b60", speedKmh: 0 }
      ],
      selectedPathOffset: 0,
      collisionPathOffset: 0,
      isFullStop: true
    }
  ];

  function renderRealisticTrajectorySimulation() {
    const canvas = $('trajectorySimCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const currentCase = SIMULATION_CASES[researchState.activeSimCaseIndex % SIMULATION_CASES.length];

    // Clear background
    ctx.fillStyle = '#060d09';
    ctx.fillRect(0, 0, w, h);

    // Horizon line
    const horizonY = 75;
    const vanishX = w * 0.62 + Math.sin(researchState.trajectoryAnimPhase * 0.5) * 8; // subtle highway curve
    const egoX = w * 0.48;
    const egoY = h - 25;

    // Draw Curving Asphalt Surface (Perspective Quadrilateral)
    ctx.beginPath();
    ctx.moveTo(vanishX - 85, horizonY);
    ctx.lineTo(vanishX + 110, horizonY);
    ctx.lineTo(w * 0.88, h);
    ctx.lineTo(w * 0.12, h);
    ctx.closePath();
    ctx.fillStyle = '#1c2420';
    ctx.fill();

    // Road side boundary markings
    ctx.strokeStyle = '#e0a800'; // Yellow left margin line
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(w * 0.12, h);
    ctx.lineTo(vanishX - 85, horizonY);
    ctx.stroke();

    ctx.strokeStyle = '#ffffff'; // White right shoulder line
    ctx.beginPath();
    ctx.moveTo(w * 0.88, h);
    ctx.lineTo(vanishX + 110, horizonY);
    ctx.stroke();

    // Dashed Lane dividers (4 lanes)
    [-0.32, 0.02, 0.36].forEach(laneRatio => {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.lineWidth = 2;
      ctx.setLineDash([16, 14]);
      ctx.lineDashOffset = -researchState.trajectoryAnimPhase * 18;
      ctx.beginPath();
      ctx.moveTo(w * 0.5 + laneRatio * 380, h);
      ctx.lineTo(vanishX + laneRatio * 90, horizonY);
      ctx.stroke();
    });
    ctx.setLineDash([]); // Reset dash

    // Draw Candidate Trajectory Fan (7 splines radiating forward from Ego)
    const fanOffsets = [-85, -55, -28, 0, 28, 55, 85];
    fanOffsets.forEach(off => {
      const isSelected = (!currentCase.isFullStop && off === currentCase.selectedPathOffset);
      const isCollision = (off === currentCase.collisionPathOffset);

      ctx.beginPath();
      ctx.moveTo(egoX, egoY - 35);

      const midY = (egoY + horizonY) * 0.55;
      const endY = horizonY + 70;
      const ctrlX = egoX + off * 0.6;
      const endX = vanishX + off * 0.7;

      ctx.quadraticCurveTo(ctrlX, midY, endX, endY);

      if (isSelected) {
        ctx.strokeStyle = '#00e5ff'; // Bright Cyan selected trajectory
        ctx.lineWidth = 4;
        ctx.shadowColor = 'rgba(0, 229, 255, 0.8)';
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else if (isCollision) {
        ctx.strokeStyle = '#ff3344'; // Red collision trajectory
        ctx.lineWidth = 2.5;
        ctx.stroke();
      } else {
        ctx.strokeStyle = 'rgba(140, 160, 150, 0.45)'; // Gray candidate paths
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    });

    // Draw Safe Stop Bar if full stop
    if (currentCase.isFullStop) {
      ctx.strokeStyle = '#ff1744';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(egoX - 70, egoY - 90);
      ctx.lineTo(egoX + 70, egoY - 90);
      ctx.stroke();
      ctx.fillStyle = '#ff1744';
      ctx.font = 'bold 11px Manrope, sans-serif';
      ctx.fillText('EMERGENCY SAFE STOP ACTIVATED (ZERO FREE PATHS)', egoX - 140, egoY - 100);
    }

    // Draw 3D Obstacles
    currentCase.obstacles.forEach(obs => {
      const scale = 1.0 - (obs.zRel / 320);
      const obsScreenY = horizonY + (h - horizonY) * (1.0 - obs.zRel / 260);
      const obsScreenX = vanishX + obs.xRel * scale * 1.5;

      const ow = obs.width * scale * 1.3;
      const oh = obs.height * scale * 1.3;

      // Draw historical trail (small white square breadcrumbs)
      for (let i = 1; i <= 3; i++) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
        ctx.fillRect(obsScreenX - 3, obsScreenY + i * 16 * scale, 5 * scale, 5 * scale);
      }

      // 3D Obstacle Box (Front & Top face)
      ctx.fillStyle = obs.color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(obsScreenX - ow / 2, obsScreenY - oh, ow, oh);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(obsScreenX - ow / 2, obsScreenY - oh, ow, oh);
      ctx.globalAlpha = 1.0;

      // Track ID Label
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px monospace';
      ctx.fillText(`#${obs.id}`, obsScreenX - ow / 2 + 2, obsScreenY - oh - 4);

      // Radar Detection: Red Circle (●)
      ctx.fillStyle = '#ff1744';
      ctx.beginPath();
      ctx.arc(obsScreenX, obsScreenY - oh * 0.5, 4.5, 0, Math.PI * 2);
      ctx.fill();

      // Vision Detection: Blue Triangle (▲)
      ctx.fillStyle = '#2979ff';
      ctx.beginPath();
      ctx.moveTo(obsScreenX - ow / 2 - 6, obsScreenY - oh * 0.5);
      ctx.lineTo(obsScreenX - ow / 2 - 1, obsScreenY - oh * 0.5 - 7);
      ctx.lineTo(obsScreenX - ow / 2 + 4, obsScreenY - oh * 0.5);
      ctx.closePath();
      ctx.fill();
    });

    // Draw Ego Vehicle (3D Blue Car Box at bottom)
    const egoW = 76;
    const egoH = 50;
    // Base shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(egoX - egoW / 2 + 5, egoY - 5, egoW - 10, 8);

    // Front/Rear 3D Box
    const grad = ctx.createLinearGradient(egoX - egoW / 2, egoY - egoH, egoX + egoW / 2, egoY);
    grad.addColorStop(0, '#1565c0');
    grad.addColorStop(1, '#0d47a1');
    ctx.fillStyle = grad;
    ctx.fillRect(egoX - egoW / 2, egoY - egoH, egoW, egoH);
    ctx.strokeStyle = '#64b5f6';
    ctx.lineWidth = 2;
    ctx.strokeRect(egoX - egoW / 2, egoY - egoH, egoW, egoH);

    // Windshield & lights
    ctx.fillStyle = '#90caf9';
    ctx.fillRect(egoX - egoW / 2 + 10, egoY - egoH + 6, egoW - 20, 14);
    ctx.fillStyle = '#ff1744'; // Red tail lights
    ctx.fillRect(egoX - egoW / 2 + 4, egoY - 10, 12, 6);
    ctx.fillRect(egoX + egoW / 2 - 16, egoY - 10, 12, 6);

    // Ego label
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px Manrope, sans-serif';
    ctx.fillText('EGO VEHICLE (L=2.7m)', egoX - 52, egoY + 14);

    // Draw Legend in Top Right (Exact MathWorks visual match)
    const legX = w - 160;
    const legY = 16;
    ctx.fillStyle = 'rgba(10, 18, 14, 0.88)';
    ctx.fillRect(legX, legY, 148, 88);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(legX, legY, 148, 88);

    ctx.font = '10px Manrope, sans-serif';
    ctx.fillStyle = '#ffffff';

    // Tracks item
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(legX + 8, legY + 8, 8, 8);
    ctx.fillText('Tracks', legX + 24, legY + 16);

    // History item
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.strokeRect(legX + 8, legY + 28, 8, 8);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.fillText('(history)', legX + 24, legY + 36);

    // Radar item
    ctx.fillStyle = '#ff1744';
    ctx.beginPath();
    ctx.arc(legX + 12, legY + 48, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Radar Detections', legX + 24, legY + 52);

    // Vision item
    ctx.fillStyle = '#2979ff';
    ctx.beginPath();
    ctx.moveTo(legX + 8, legY + 70);
    ctx.lineTo(legX + 12, legY + 63);
    ctx.lineTo(legX + 16, legY + 70);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Vision Detections', legX + 24, legY + 68);
  }

  function cycleRealisticScenario() {
    researchState.activeSimCaseIndex = (researchState.activeSimCaseIndex + 1) % SIMULATION_CASES.length;
    const currentCase = SIMULATION_CASES[researchState.activeSimCaseIndex];
    const tag = $('simCaseTag');
    if (tag) tag.textContent = `SCENARIO: ${currentCase.name.toUpperCase()}`;
    appendEventLog('SIMULINK', `Switched trajectory scene to ${currentCase.name}. ${currentCase.subtitle}`);
    renderRealisticTrajectorySimulation();
  }

  // ---------------------------------------------------------------------------
  // 4. MATHWORKS SIMULINK BICYCLE MODEL CO-SIMULATION
  // ---------------------------------------------------------------------------

  async function loadSimulinkSpec() {
    try {
      const res = await fetch('/api/autonomous/simulink/model-spec');
      const data = await res.json();
      if (data.ok) {
        researchState.simulinkParams = data.parameters;
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

    const cycleCaseBtn = $('cycleSimCaseBtn');
    if (cycleCaseBtn) {
      cycleCaseBtn.addEventListener('click', cycleRealisticScenario);
    }

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

    // Step animation phase for realistic 3D canvas
    researchState.trajectoryAnimPhase += 0.08;
    renderRealisticTrajectorySimulation();
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
      }, 90);
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
    if ($('simMetricVx')) $('simMetricVx').textContent = `${stepData.telemetry.speed_kmh} km/h`;
    if ($('simMetricLatG')) $('simMetricLatG').textContent = `${stepData.telemetry.lateral_g} G`;
    if ($('simMetricYawRate')) $('simMetricYawRate').textContent = `${stepData.telemetry.yaw_rate_deg_s} °/s`;
    if ($('simMetricSlip')) $('simMetricSlip').textContent = `${stepData.telemetry.slip_deg}°`;
    if ($('simulinkStateflowMode')) $('simulinkStateflowMode').textContent = stepData.stateflow_state;
  }

  // ---------------------------------------------------------------------------
  // 5. FIVE INDIAN ROAD SCENARIOS BENCH (PHASE F INTERFACE)
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
  // 6. CARLA STATUS & DATASET VALIDATION
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
    checkBackendHealth();
    renderRealisticTrajectorySimulation();
  });

})();
