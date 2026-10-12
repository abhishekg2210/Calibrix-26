"""
Simulation Engine for Adaptive Path Planning and Collision Avoidance on Unstructured Indian Roads.
Provides kinematic simulation, obstacle dynamics, candidate trajectory generation,
and rule-based decision evaluation across 5 Indian road scenarios.
"""

import math
import time
from typing import List, Dict, Any, Optional
from services.planner_service import planner_service
from services.collision_risk_service import collision_risk_service


# -----------------------------------------------------------------------------
# 5 CANONICAL INDIAN ROAD SCENARIOS (PS 06)
# -----------------------------------------------------------------------------

SCENARIOS: Dict[str, Dict[str, Any]] = {
    "scenario_1": {
        "id": "scenario_1",
        "name": "Pedestrian Suddenly Crossing Road",
        "description": "Pedestrian walks briskly across unmarked lane directly into ego vehicle corridor.",
        "road_width_m": 7.5,
        "road_length_m": 120.0,
        "ego_start": {"x": 5.0, "y": 0.0, "v_mps": 8.5, "heading_rad": 0.0},
        "target": {"x": 105.0, "y": 0.0},
        "obstacles": [
            {
                "id": "PED_01",
                "type": "pedestrian",
                "name": "Crossing Pedestrian",
                "x": 38.0,
                "y": 3.4,
                "vx": -0.2,
                "vy": -1.4,
                "radius_m": 0.65,
                "speed_mps": 1.4,
                "active": True
            }
        ]
    },
    "scenario_2": {
        "id": "scenario_2",
        "name": "Motorcycle Merging from Side Lane",
        "description": "Two-wheeler enters roadway abruptly from dirt shoulder without lane demarcation.",
        "road_width_m": 7.5,
        "road_length_m": 120.0,
        "ego_start": {"x": 5.0, "y": 0.0, "v_mps": 9.0, "heading_rad": 0.0},
        "target": {"x": 105.0, "y": 0.0},
        "obstacles": [
            {
                "id": "MTR_01",
                "type": "motorcycle",
                "name": "Merging Motorcycle",
                "x": 32.0,
                "y": -3.2,
                "vx": 3.5,
                "vy": 1.1,
                "radius_m": 1.1,
                "speed_mps": 3.8,
                "active": True
            }
        ]
    },
    "scenario_3": {
        "id": "scenario_3",
        "name": "Severe Pothole in Vehicle Path",
        "description": "Deep asphalt fissure directly on vehicle centerline requiring prompt lateral replan.",
        "road_width_m": 7.5,
        "road_length_m": 120.0,
        "ego_start": {"x": 5.0, "y": 0.0, "v_mps": 8.0, "heading_rad": 0.0},
        "target": {"x": 105.0, "y": 0.0},
        "obstacles": [
            {
                "id": "POT_01",
                "type": "pothole",
                "name": "Deep Road Pothole",
                "x": 42.0,
                "y": 0.1,
                "vx": 0.0,
                "vy": 0.0,
                "radius_m": 1.3,
                "speed_mps": 0.0,
                "active": True
            }
        ]
    },
    "scenario_4": {
        "id": "scenario_4",
        "name": "Dog or Cattle Wandering Across Roadway",
        "description": "Stray bovine or canine moves unpredictably into the road requiring deceleration and safe stop.",
        "road_width_m": 7.5,
        "road_length_m": 120.0,
        "ego_start": {"x": 5.0, "y": 0.0, "v_mps": 8.0, "heading_rad": 0.0},
        "target": {"x": 105.0, "y": 0.0},
        "obstacles": [
            {
                "id": "CAT_01",
                "type": "cattle",
                "name": "Stray Cattle",
                "x": 35.0,
                "y": 1.8,
                "vx": -0.1,
                "vy": -0.7,
                "radius_m": 1.6,
                "speed_mps": 0.7,
                "active": True
            }
        ]
    },
    "scenario_5": {
        "id": "scenario_5",
        "name": "Dense Traffic with Road Blockage",
        "description": "Multiple vehicles and construction barricade block center and right corridors.",
        "road_width_m": 8.0,
        "road_length_m": 120.0,
        "ego_start": {"x": 5.0, "y": 0.0, "v_mps": 7.5, "heading_rad": 0.0},
        "target": {"x": 105.0, "y": 0.0},
        "obstacles": [
            {
                "id": "AUT_01",
                "type": "auto_rickshaw",
                "name": "Slow Auto-Rickshaw",
                "x": 30.0,
                "y": 0.0,
                "vx": 2.2,
                "vy": 0.0,
                "radius_m": 1.4,
                "speed_mps": 2.2,
                "active": True
            },
            {
                "id": "BLK_01",
                "type": "blockade",
                "name": "Road Barrier / Debris",
                "x": 50.0,
                "y": -1.8,
                "vx": 0.0,
                "vy": 0.0,
                "radius_m": 1.8,
                "speed_mps": 0.0,
                "active": True
            },
            {
                "id": "CAR_01",
                "type": "car",
                "name": "Parked Vehicle",
                "x": 65.0,
                "y": -2.2,
                "vx": 0.0,
                "vy": 0.0,
                "radius_m": 2.1,
                "speed_mps": 0.0,
                "active": True
            }
        ]
    }
}


class SimulationEngine:
    """
    Manages scenario lifecycle, updates physics states over dt,
    calls planning and collision assessment algorithms, and outputs telemetry.
    """

    def __init__(self):
        self.scenarios = SCENARIOS

    def get_scenarios_list(self) -> List[Dict[str, Any]]:
        return [
            {
                "id": sc["id"],
                "name": sc["name"],
                "description": sc["description"],
                "obstacles_count": len(sc["obstacles"])
            }
            for sc in self.scenarios.values()
        ]

    def get_scenario(self, scenario_id: str) -> Optional[Dict[str, Any]]:
        sc = self.scenarios.get(scenario_id)
        if not sc:
            return None
        # Return deep copy representation
        import copy
        return copy.deepcopy(sc)

    def step_simulation(
        self,
        ego_state: Dict[str, float],
        obstacles: List[Dict[str, Any]],
        planner_mode: str = "frenet_lattice",
        dt: float = 0.1
    ) -> Dict[str, Any]:
        """
        Executes a discrete time step of the autonomous driving simulation:
        1. Predicts obstacle positions over horizon
        2. Evaluates candidate trajectories
        3. Assesses collision risk and selects decision
        4. Calculates next vehicle state
        """
        start_time = time.perf_counter()

        # Step 1: Predict obstacle future positions (1s, 2s, 3s)
        predictions = []
        for obs in obstacles:
            ox = float(obs.get("x", 0.0))
            oy = float(obs.get("y", 0.0))
            vx = float(obs.get("vx", 0.0))
            vy = float(obs.get("vy", 0.0))
            rad = float(obs.get("radius_m", 1.0))

            pred_points = []
            for t_future in [1.0, 2.0, 3.0]:
                px = ox + vx * t_future
                py = oy + vy * t_future
                pred_points.append({"t_sec": t_future, "x": round(px, 2), "y": round(py, 2)})

            predictions.append({
                "obstacle_id": obs.get("id", "UNKNOWN"),
                "type": obs.get("type", "object"),
                "current_pos": {"x": round(ox, 2), "y": round(oy, 2)},
                "future_positions": pred_points
            })

        # Step 2: Risk Assessment
        # Map simulated objects into tracking format
        sim_tracked_objects = []
        ego_x = float(ego_state.get("x", 0.0))
        ego_y = float(ego_state.get("y", 0.0))
        ego_v = float(ego_state.get("v_mps", 8.0))

        min_distance_to_obstacle = 999.0
        most_critical_obstacle = None

        for obs in obstacles:
            ox = float(obs.get("x", 0.0))
            oy = float(obs.get("y", 0.0))
            dist = math.hypot(ox - ego_x, oy - ego_y)
            if dist < min_distance_to_obstacle:
                min_distance_to_obstacle = dist
                most_critical_obstacle = obs

            # Synthetic bounding box for risk engine
            sim_tracked_objects.append({
                "track_id": obs.get("id", "OBS"),
                "class_name": obs.get("type", "obstacle"),
                "class_id": 1,
                "confidence": 0.95,
                "bbox": [500, 300, 700, 500],
                "ground_distance_m": round(dist, 2),
                "distance_uncertainty": 0.15,
                "speed_mps": obs.get("speed_mps", 0.0),
                "heading_deg": 0.0,
                "is_active": True
            })

        risk_assessment = collision_risk_service.assess_risk(
            tracked_objects=sim_tracked_objects,
            ego_speed_kmh=ego_v * 3.6
        )

        risk_decision = risk_assessment.get("decision", "CONTINUE")

        # Step 3: Candidate Trajectory Planning
        plan_result = planner_service.plan_path(
            ego_state={"x": ego_x, "y": ego_y, "vx_mps": ego_v},
            obstacles=obstacles,
            risk_decision=risk_decision
        )

        # Step 4: Decision synthesis
        action = "NOMINAL_CRUISE"
        explanation = "Clear corridor ahead. Maintaining target cruising speed."

        if plan_result["status"] == "SAFE_STOP_TRIGGERED" or plan_result["status"] == "NO_COLLISION_FREE_PATH":
            action = "EMERGENCY_STOP"
            explanation = "Imminent collision or all corridors blocked. Emergency braking engaged."
        elif plan_result["status"] == "EVASIVE_REPLAN_ACTIVE":
            target_lat = plan_result["target_lateral_offset_m"]
            corridor = "Left Lane" if target_lat > 0 else "Right Lane"
            action = "LATERAL_REPLAN"
            explanation = f"Obstacle in center path. Executing smooth lateral evasion to {corridor} (Clearance: {plan_result.get('min_obstacle_distance_m', 0)}m)."
        elif min_distance_to_obstacle < 15.0:
            action = "REDUCE_SPEED"
            explanation = f"Obstacle detected within {round(min_distance_to_obstacle, 1)}m. Decelerating."

        # Determine risk level based on physical distance & planner action
        if action == "EMERGENCY_STOP" or min_distance_to_obstacle < 5.5:
            risk_level = "CRITICAL"
        elif action in ["LATERAL_REPLAN", "REDUCE_SPEED"] or min_distance_to_obstacle < 20.0:
            risk_level = "MODERATE"
        else:
            risk_level = "LOW"

        elapsed_ms = (time.perf_counter() - start_time) * 1000.0

        return {
            "ok": True,
            "action": action,
            "explanation": explanation,
            "risk_level": risk_level,
            "risk_score": 0.9 if risk_level == "CRITICAL" else (0.5 if risk_level == "MODERATE" else 0.1),
            "time_to_collision_s": round(min_distance_to_obstacle / max(0.5, ego_v), 1) if min_distance_to_obstacle < 100 else 99.0,
            "min_obstacle_distance_m": round(min_distance_to_obstacle, 2),
            "selected_path": plan_result.get("selected_path", []),
            "target_lateral_offset_m": plan_result.get("target_lateral_offset_m", 0.0),
            "candidate_paths_evaluated": plan_result.get("candidate_paths_evaluated", 5),
            "obstacle_predictions": predictions,
            "planning_latency_ms": round(elapsed_ms, 2)
        }


simulation_engine = SimulationEngine()
