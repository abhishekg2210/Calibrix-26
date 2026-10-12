"""
FastAPI Implementation for Adaptive Path Planning and Collision Avoidance Research Prototype.
Provides documented OpenAPI / Swagger endpoints at /docs and /redoc.
Shares the exact same modular services with the Flask application.
"""

import time
from typing import Dict, Any, List, Optional
from fastapi import FastAPI, UploadFile, File, Form, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from services.perception_service import perception_service
from services.tracking_service import tracking_service
from services.collision_risk_service import collision_risk_service
from services.planner_service import planner_service
from services.simulink_service import simulink_service
from services.pathweaver_adapter import pathweaver_adapter
from services.carla_service import carla_service
from services.dataset_service import dataset_service

app = FastAPI(
    title="RoadGuard AI - Autonomous Driving Research API",
    description="Adaptive Path Planning and Collision Avoidance for Autonomous Vehicles on Unstructured Indian Roads (PS 06)",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -----------------------------------------------------------------------------
# 1. HEALTH & SYSTEM READINESS
# -----------------------------------------------------------------------------

@app.get("/api/health", summary="Health Check")
def health_check():
    return {
        "status": "healthy",
        "service": "RoadGuard Autonomous Driving Research API (FastAPI)",
        "timestamp": time.time()
    }

@app.get("/api/ready", summary="Service Readiness Probe")
def readiness_probe():
    carla_stat = carla_service.check_connection()
    return {
        "ready": True,
        "services": {
            "perception": perception_service.get_status(),
            "tracking": {"status": "READY", "active_tracks": len(tracking_service.tracks)},
            "collision_risk": {"status": "READY"},
            "planner": {"status": "READY"},
            "simulink": simulink_service.get_model_spec()["co_simulation_status"],
            "carla": carla_stat["status"]
        }
    }

@app.get("/api/autonomous/feature-matrix", summary="Transparent Feature Verification Matrix")
def feature_matrix():
    carla_stat = carla_service.check_connection()
    hw_info = dataset_service.get_hardware_info()
    return {
        "ok": True,
        "working": [
            {"feature": "YOLOv8 Perception Engine", "status": "WORKING"},
            {"feature": "Multi-Object Tracking (ByteTrack / Kalman)", "status": "WORKING"},
            {"feature": "Time-To-Collision (TTC) Risk Engine", "status": "WORKING"},
            {"feature": "Dynamic Lattice Path Planner", "status": "WORKING"},
            {"feature": "Simulink Bicycle Model Solver", "status": "WORKING"},
            {"feature": "Stateflow Finite State Machine", "status": "WORKING"},
            {"feature": "PathWeaver Compatibility Adapter", "status": "WORKING"}
        ],
        "simulated": [
            {"feature": "Multi-Camera Rig (Left, Right, Rear)", "status": "SIMULATED"},
            {"feature": "Vehicle Telemetry", "status": "SIMULATED"},
            {"feature": "Deterministic 5 Indian Road Scenarios", "status": "SIMULATED"}
        ],
        "not_configured": [
            {"feature": "Live CARLA 3D Simulator Server (127.0.0.1:2000)", "status": "CONNECTED" if carla_stat["connected"] else "NOT_CONFIGURED"},
            {"feature": "Direct MATLAB Engine Connection", "status": "NOT_CONFIGURED"}
        ]
    }

# -----------------------------------------------------------------------------
# 2. PERCEPTION & TRACKING
# -----------------------------------------------------------------------------

@app.get("/api/autonomous/perception/status", summary="Perception Model Status")
def perception_status():
    return {"ok": True, "perception": perception_service.get_status()}

# -----------------------------------------------------------------------------
# 3. COLLISION RISK & PATH PLANNING
# -----------------------------------------------------------------------------

class RiskRequest(BaseModel):
    tracked_objects: List[Dict[str, Any]] = []
    ego_speed_kmh: float = 35.0

@app.post("/api/autonomous/risk-assessment", summary="Collision Risk Evaluation")
def assess_risk(req: RiskRequest):
    return collision_risk_service.assess_risk(req.tracked_objects, ego_speed_kmh=req.ego_speed_kmh)

class PlanRequest(BaseModel):
    ego_state: Dict[str, float] = {"x": 0.0, "y": 0.0, "vx_mps": 9.7}
    obstacles: List[Dict[str, Any]] = []
    risk_decision: str = "NORMAL"

@app.post("/api/autonomous/plan-path", summary="Dynamic Lattice Path Planning")
def plan_path(req: PlanRequest):
    return planner_service.plan_path(req.ego_state, req.obstacles, risk_decision=req.risk_decision)

# -----------------------------------------------------------------------------
# 4. MATHWORKS SIMULINK & PATHWEAVER
# -----------------------------------------------------------------------------

@app.get("/api/autonomous/simulink/model-spec", summary="Simulink Model Specifications")
def simulink_spec():
    return simulink_service.get_model_spec()

class SimulinkStepRequest(BaseModel):
    steering_deg: float = 0.0
    target_velocity_mps: float = 10.0
    dt: float = 0.05
    risk_level: str = "NORMAL"

@app.post("/api/autonomous/simulink/run-step", summary="Bicycle Model Numerical Step")
def simulink_step(req: SimulinkStepRequest):
    return simulink_service.step_simulation(req.steering_deg, req.target_velocity_mps, dt=req.dt, risk_level=req.risk_level)

@app.get("/api/autonomous/pathweaver/info", summary="PathWeaver Adapter Info")
def pathweaver_info():
    return pathweaver_adapter.get_info()

# -----------------------------------------------------------------------------
# 5. CARLA SIMULATION & 5 SCENARIOS
# -----------------------------------------------------------------------------

@app.get("/api/autonomous/carla/status", summary="CARLA Simulator Connection Probe")
def carla_status():
    return carla_service.check_connection()

@app.get("/api/autonomous/scenarios", summary="List 5 Indian Road Scenarios")
def list_scenarios():
    return {"ok": True, "scenarios": carla_service.get_scenarios()}

class ScenarioRunRequest(BaseModel):
    scenario_id: str = "scenario_1"

@app.post("/api/autonomous/scenarios/run", summary="Run Scenario Benchmark")
def run_scenario(req: ScenarioRunRequest):
    return carla_service.run_scenario_benchmark(req.scenario_id)

# -----------------------------------------------------------------------------
# 6. DATASET MANAGEMENT
# -----------------------------------------------------------------------------

@app.get("/api/autonomous/dataset/hardware", summary="Hardware Detection")
def dataset_hardware():
    return {"ok": True, "hardware": dataset_service.get_hardware_info()}

@app.get("/api/autonomous/dataset/validate", summary="Validate YOLO Dataset")
def dataset_validate(dataset_name: str = "indian_road_benchmark"):
    return dataset_service.validate_dataset(dataset_name)
