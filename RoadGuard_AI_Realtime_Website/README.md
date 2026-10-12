# RoadGuard AI — Adaptive Path Planning and Collision Avoidance for Autonomous Vehicles on Unstructured Indian Roads (PS 06)

RoadGuard AI is a functional research prototype designed for **Problem Statement PS 06 (Software)**: *Adaptive Path Planning and Collision Avoidance for Autonomous Vehicles on Unstructured Indian Roads*.

The project preserves the existing website structure, Leaflet/Google navigation cockpit, authentication, and hazard reporting system while adding a full research console featuring:
1. **Real AI Perception**: Pretrained YOLOv8 object detection with extensible Indian road taxonomy.
2. **Multi-Object Tracking & Motion Prediction**: ByteTrack Kalman/IoU tracker with 5-step future trajectory extrapolation.
3. **Collision-Risk Assessment**: 5 formal decision states (`CONTINUE`, `CAUTION`, `STOP_REQUIRED`, `REPLAN`, `NO_SAFE_PATH_AVAILABLE`).
4. **Adaptive Path Planning**: Quintic polynomial dynamic lattice planner with obstacle collision rejection and emergency safe-stop fallback.
5. **MathWorks Simulink Co-Simulation**: 3-DOF non-linear bicycle model ($L=2.7\text{m}, m=1500\text{kg}$), Stateflow finite state machine, live interactive parameter tuning, and exportable `.m` bridge script (`simulink/simulink_bridge.m`).
6. **PathWeaver Adapter**: Documented trajectory profile adapter (`services/pathweaver_adapter.py`) with Hermite spline smoothing.
7. **5 Repeatable Indian Road Scenarios**: Automated deterministic evaluation across village roads, urban intersections, highway merges, dense markets, and sudden cattle crossings.
8. **Decoupled CARLA Simulator Bridge**: Socket heartbeat probe (`127.0.0.1:2000`) and offline benchmark runner that never crashes if CARLA is not installed.
9. **Dataset & Training Studio**: CUDA/CPU hardware detection, YOLO annotation format validation, and asynchronous background training worker.
10. **Dual Backend Support**: Native Flask backend + standalone high-performance FastAPI backend (`fastapi_app.py`).

> **Safety & Research Integrity Note:** This is an academic research prototype, not certified production autonomous-driving safety software. Normal video is explicitly distinguished from live camera feeds, simulated actors are distinguished from real vehicles, and simulated models are cleanly distinguished from physical sensors.

---

## MathWorks Tools Alignment (PS 06)

In accordance with MathWorks tool recommendations for PS 06, the prototype integrates:
- **Vehicle Dynamics Blockset**: 3-DOF bicycle model equations of motion governing longitudinal acceleration, lateral slip, and yaw dynamics.
- **Stateflow**: Finite state supervisory machine transitioning between `LANE_FOLLOWING`, `LATERAL_EVASIVE`, and `SAFE_STOP`.
- **Navigation Toolbox**: Lattice trajectory generation, obstacle avoidance cost functions, and Frenet frame discretization.
- **Automated Driving Toolbox / RoadRunner**: Standard sensor coordinates, scenario specifications, and actor collision margins.

The live interactive dashboard includes an SVG block diagram, interactive vehicle parameter sliders, real-time RK4 numerical telemetry, and an exportable MATLAB script (`simulink_bridge.m`).

---

## 20 Canonical Benchmark Scenarios (PS 06)

The benchmark suite is categorized across 6 difficulty tiers with deterministic evaluation and safety-state transitions:

| Tier | Scenarios | Focus & Safety Objective | Expected State |
|---|---|---|---|
| **Tier A: Baseline Urban** | `scenario_1`, `scenario_10`, `scenario_12` | Nominal flow, traffic congestion, and red light stop line approach | `NORMAL` / `STOP` |
| **Tier B: Vulnerable Users** | `scenario_2`, `scenario_3`, `scenario_4` | Crossing pedestrians, occluded child emergence, sudden braking | `STOP` / `SLOW DOWN` |
| **Tier C: Cut-In & Evasion** | `scenario_5`, `scenario_6`, `scenario_9`, `scenario_11` | Motorcycle cut-in, lane intrusion, stalled vehicles, emergency ambulance yield | `CAUTION` / `REPLAN` |
| **Tier D: Blockages & Rerouting** | `scenario_7`, `scenario_8`, `scenario_17`, `scenario_18` | Construction lane taper, total road closure, unroutable blockage, dynamic hazard | `REPLAN` / `STOP` |
| **Tier E: Sensor Faults & Edge Cases**| `scenario_13`, `scenario_14`, `scenario_15` | Low-confidence occlusion, GPS canyon multipath jump, camera heartbeat timeout | `CAUTION` / `STOP` |
| **Tier F: Complex & Policy Cases** | `scenario_16`, `scenario_19`, `scenario_20` | Dual simultaneous hazards, legal one-way directed graph constraints, false hazard rejection | `NORMAL` / `REPLAN` |

Execute any scenario deterministically via the web console (`/api/autonomous/scenarios/run`) or run the full 20-scenario batch audit (`/api/autonomous/simulation/run-all-scenarios`).

---

## Quick Start (Windows PowerShell)

```powershell
cd RoadGuard_AI_Realtime_Website

# 1. Activate Virtual Environment
.\.venv\Scripts\Activate.ps1

# 2. Install Dependencies
pip install -r requirements.txt

# 3. Configure Environment
Copy-Item .env.example .env

# 4. Run Flask Research Console
python app.py
```
Open `http://127.0.0.1:5000` in your browser. Default login: `admin@roadguard.ai` / `Admin@123` (or `admin@irie.ai`).

### Alternatively: Run with High-Performance FastAPI
```powershell
uvicorn fastapi_app:app --host 127.0.0.1 --port 8000 --reload
```
Interactive Swagger API documentation available at `http://127.0.0.1:8000/docs`.

---

## Running the Automated Test Suite

The comprehensive automated test suite verifies all perception, tracking, risk assessment, A* graph planning, 20 scenarios, Simulink integration, and route APIs:

```powershell
python -m unittest discover -s tests -v
```
**Current status**: **101 / 101 tests passing (100% OK)** in ~52 seconds.

---

## Project Architecture

```text
RoadGuard_AI_Realtime_Website/
├── app.py                            # Flask application & blueprint registration
├── fastapi_app.py                    # Standalone FastAPI research application
├── database.py                       # SQLite persistence for auth & logs
├── requirements.txt                  # Python dependencies
├── .env.example                      # Configuration template
├── services/
│   ├── perception_service.py         # YOLOv8 inference & Indian road taxonomy
│   ├── tracking_service.py           # ByteTrack MOT & 5-step motion prediction
│   ├── collision_risk_service.py     # 5-state risk engine, distance & TTC
│   ├── astar_planner.py              # Genuine road-graph A* path planner (priority queue & K-alternatives)
│   ├── sumo_service.py               # Eclipse SUMO & TraCI microscopic co-simulation & IDM fallback
│   ├── video_analysis_service.py     # Unbounded full-clip video analysis & interactive job control
│   ├── simulation_engine.py          # 20 canonical benchmark scenarios across 6 difficulty tiers
│   ├── planner_service.py            # Quintic dynamic lattice path planner
│   ├── simulink_service.py           # 3-DOF bicycle model & Stateflow FSM
│   ├── pathweaver_adapter.py         # PathWeaver trajectory adapter
│   ├── carla_service.py              # CARLA socket heartbeat & benchmark runner
│   ├── dataset_service.py            # Hardware detection & background trainer
│   └── autonomous_routes.py          # REST API endpoints for research dashboard
├── simulink/
│   ├── simulink_bridge.m             # MATLAB co-simulation script
│   └── bicycle_model_spec.json       # Mathematical blockset specification
├── dataset/                          # YOLO format images & annotations
├── static/
│   ├── autonomous_dashboard.css      # Dark research console stylesheet
│   ├── autonomous_dashboard.js       # Dynamic tab, video, Simulink, 20-scenario controller
│   ├── app.js                        # Existing Leaflet navigation controller & in-lane evasion
│   └── style.css                     # Existing core styling
├── templates/
│   ├── index.html                    # Unified cockpit, 20 scenarios & research console
│   ├── login.html                    # Professional RoadGuard AI login
│   └── register.html                 # Professional RoadGuard AI registration
└── tests/                            # 101 unit & integration tests (100% PASS)
```

---

## Pushing to GitHub

To commit and push all upgrades to your GitHub repository:

```powershell
cd "c:\Users\venkat\Downloads\RoadGuard_AI_Realtime_Website (1)\RoadGuard_AI_Realtime_Website"

# Check git status
git status

# Stage all files
git add .

# Commit changes
git commit -m "feat: Renovation across all 12 phases - A* routing, full-clip YOLO, 20 scenarios, and Simulink integration"

# Push to your GitHub repository
git push origin main
```


