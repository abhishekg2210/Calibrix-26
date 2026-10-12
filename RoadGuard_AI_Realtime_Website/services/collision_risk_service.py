"""
Collision Risk Assessment Engine for Unstructured Indian Road Navigation.
Computes ground-plane distance estimation, Time-To-Collision (TTC),
sensor uncertainty, predictive trajectory corridor intersections,
and manages a finite-state machine with hysteresis and minimum dwell times:
- CONTINUE
- CAUTION / REDUCE_SPEED
- SLOW DOWN
- STOP_REQUIRED / EMERGENCY_BRAKE
- REPLAN / REPLAN_PATH
- NO_SAFE_PATH_AVAILABLE / SAFE_STOP
"""

import math
import time
from typing import List, Dict, Any, Optional, Tuple


class CollisionRiskEngine:
    """
    Evaluates collision risk by fusing object bounding boxes, tracking velocities,
    future predicted trajectories, ego-vehicle speed, ground-plane distance estimates,
    and measurement uncertainty.
    """

    def __init__(
        self,
        caution_ttc_s: float = 4.5,
        stop_ttc_s: float = 1.3,
        critical_clearance_m: float = 2.8,
        reaction_time_s: float = 0.4,
        max_decel_mps2: float = 6.0,
        min_state_hold_s: float = 2.0
    ):
        self.caution_ttc = caution_ttc_s
        self.stop_ttc = stop_ttc_s
        self.critical_clearance = critical_clearance_m
        self.reaction_time = reaction_time_s
        self.max_decel = max_decel_mps2
        self.min_state_hold_s = min_state_hold_s

        # State machine hysteresis tracking
        self.current_state = "CONTINUE"
        self.last_state_change = 0.0
        self.last_reason = "Path clear. Cruising nominally."

    def estimate_ground_distance(self, bbox: List[float], frame_height: int = 720) -> Tuple[float, float]:
        """
        Estimates ground distance in meters based on the bottom coordinate of the bounding box.
        Returns: (distance_m, uncertainty_0_to_1)
        """
        # y2 is bottom edge where object touches the road surface
        y2 = bbox[3] if len(bbox) > 3 else frame_height * 0.5
        norm_y = max(0.1, min(1.0, y2 / float(frame_height)))

        # Perspective ground mapping
        horizon = 0.38
        if norm_y <= horizon:
            return 80.0, 0.65  # High distance uncertainty near horizon

        dist = 2.2 / (norm_y - horizon) ** 1.15
        dist = max(1.5, min(100.0, dist))

        # Uncertainty increases with distance
        uncertainty = min(0.85, 0.15 + (dist / 100.0) * 0.7)
        return round(dist, 2), round(uncertainty, 3)

    def assess_risk(
        self,
        tracked_objects: List[Dict[str, Any]],
        ego_speed_kmh: float = 30.0,
        lateral_clearance_left_m: float = 3.5,
        lateral_clearance_right_m: float = 3.5,
        frame_width: int = 1280,
        frame_height: int = 720
    ) -> Dict[str, Any]:
        """
        Evaluates scene safety and returns decision state with explainable reasons
        and hysteresis to prevent alert flickering.
        """
        now = time.time()
        ego_v_mps = max(0.0, ego_speed_kmh / 3.6)
        stopping_distance_m = (ego_v_mps * self.reaction_time) + ((ego_v_mps ** 2) / (2.0 * self.max_decel))
        stopping_distance_m = max(2.5, stopping_distance_m)

        evaluated_hazards = []
        min_ttc = 999.0
        min_dist = 999.0
        most_critical_object = None

        center_x = frame_width / 2.0
        corridor_half_width = frame_width * 0.22  # Ego forward path corridor

        has_blocking_obstacle = False
        both_lanes_blocked = False
        predicted_corridor_intrusion = False
        intrusion_reason = ""

        for obj in tracked_objects:
            bbox = obj.get("bbox", [0, 0, 0, 0])
            cx = (bbox[0] + bbox[2]) / 2.0 if len(bbox) >= 4 else center_x

            # Use directly provided ground distance if available (e.g. simulation or radar/lidar)
            if "ground_distance_m" in obj:
                dist_m = float(obj["ground_distance_m"])
                dist_uncertainty = float(obj.get("distance_uncertainty", 0.1))
            else:
                dist_m, dist_uncertainty = self.estimate_ground_distance(bbox, frame_height)

            # Relative velocity calculation
            obj_speed_mps = float(obj.get("speed_mps", 0.0))
            if obj_speed_mps > 0:
                # Same direction forward traffic
                closing_speed_mps = max(0.05, ego_v_mps - obj_speed_mps)
            else:
                vy_px = obj.get("velocity", {}).get("vy", 0.0)
                obj_rel_speed_mps = (vy_px / 40.0) if abs(vy_px) > 1.0 else 0.0
                closing_speed_mps = max(0.1, ego_v_mps + obj_rel_speed_mps)

            # Time to collision
            if closing_speed_mps > 0.3 and dist_m > 0:
                ttc_s = dist_m / closing_speed_mps
            else:
                ttc_s = 999.0

            in_ego_path = abs(cx - center_x) < corridor_half_width
            is_lateral_intrusion = obj.get("irregular_motion", False) or (abs(cx - center_x) < corridor_half_width * 1.6)

            # Check predicted future trajectory steps for short-horizon corridor overlap
            future_pts = obj.get("predicted_trajectory", [])
            for pt in future_pts:
                pred_x = pt.get("x", cx)
                if abs(pred_x - center_x) < corridor_half_width and pt.get("t_sec", 1.0) <= 2.0:
                    predicted_corridor_intrusion = True
                    intrusion_reason = f"Predicted cut-in by {obj.get('class_name', 'Actor')} #{obj.get('track_id', '')} in {pt.get('t_sec')}s"
                    break

            hazard_eval = {
                "track_id": obj.get("track_id"),
                "class_name": obj.get("class_name"),
                "distance_m": dist_m,
                "ttc_s": round(ttc_s, 2) if ttc_s < 900 else None,
                "in_ego_path": in_ego_path,
                "uncertainty": dist_uncertainty,
                "confidence": obj.get("confidence", 0.8),
                "predicted_intrusion": predicted_corridor_intrusion
            }
            evaluated_hazards.append(hazard_eval)

            if in_ego_path or is_lateral_intrusion or predicted_corridor_intrusion:
                if ttc_s < min_ttc:
                    min_ttc = ttc_s
                    most_critical_object = hazard_eval
                if dist_m < min_dist:
                    min_dist = dist_m

                if dist_m < (stopping_distance_m + 3.0) or obj.get("class_name") in ["Construction barrier", "Road Blocked"]:
                    has_blocking_obstacle = True

        # Check lateral clearance
        if has_blocking_obstacle:
            if lateral_clearance_left_m < 2.0 and lateral_clearance_right_m < 2.0:
                both_lanes_blocked = True

        # Candidate target decision
        candidate_state = "CONTINUE"
        candidate_status_text = "Path clear. Autonomous cruising within road boundaries."
        candidate_action = "MAINTAIN_SPEED"
        candidate_target_speed = ego_speed_kmh

        crit_name = most_critical_object['class_name'] if most_critical_object else 'Obstacle'

        if both_lanes_blocked or (has_blocking_obstacle and min_dist < 4.0):
            candidate_state = "NO_SAFE_PATH_AVAILABLE"
            candidate_status_text = "Corridor completely obstructed - No safe lateral bypass available."
            candidate_action = "SAFE_STOP"
            candidate_target_speed = 0.0
        elif min_ttc <= self.stop_ttc or (has_blocking_obstacle and min_dist <= stopping_distance_m):
            candidate_state = "STOP_REQUIRED"
            candidate_status_text = f"Imminent collision hazard detected ({crit_name} at {min_dist:.1f}m, TTC {min_ttc:.1f}s). Immediate braking required."
            candidate_action = "EMERGENCY_BRAKE"
            candidate_target_speed = 0.0
        elif has_blocking_obstacle:
            candidate_state = "REPLAN"
            candidate_status_text = f"Obstruction detected at {min_dist:.1f}m. Initiating lateral corridor replanning."
            candidate_action = "REPLAN_PATH"
            candidate_target_speed = min(ego_speed_kmh, 15.0)
        elif predicted_corridor_intrusion:
            candidate_state = "CAUTION"
            candidate_status_text = f"Predictive Warning: {intrusion_reason}. Reducing speed."
            candidate_action = "REDUCE_SPEED"
            candidate_target_speed = min(ego_speed_kmh, 18.0)
        elif min_ttc <= self.caution_ttc or min_dist < 18.0:
            candidate_state = "CAUTION"
            candidate_status_text = f"Caution: Dynamic entity nearby ({crit_name} at {min_dist:.1f}m). Reduce speed."
            candidate_action = "REDUCE_SPEED"
            candidate_target_speed = min(ego_speed_kmh, 20.0)
        else:
            candidate_state = "CONTINUE"
            candidate_status_text = "Path clear. Autonomous cruising within road boundaries."
            candidate_action = "MAINTAIN_SPEED"
            candidate_target_speed = ego_speed_kmh

        # State transition with hysteresis
        # Elevating severity (CONTINUE -> CAUTION -> REPLAN -> STOP) happens instantly
        # De-escalating severity requires minimum hold time to prevent alert flickering
        severity_rank = {
            "CONTINUE": 0,
            "CAUTION": 1,
            "REPLAN": 2,
            "STOP_REQUIRED": 3,
            "NO_SAFE_PATH_AVAILABLE": 4
        }

        curr_rank = severity_rank.get(self.current_state, 0)
        cand_rank = severity_rank.get(candidate_state, 0)

        if cand_rank > curr_rank:
            # Escalation is immediate
            self.current_state = candidate_state
            self.last_state_change = now
            self.last_reason = candidate_status_text
        elif cand_rank < curr_rank:
            # De-escalation holds state for minimum duration
            if (now - self.last_state_change) >= self.min_state_hold_s:
                self.current_state = candidate_state
                self.last_state_change = now
                self.last_reason = candidate_status_text

        return {
            "ok": True,
            "decision_state": self.current_state,
            "status_text": self.last_reason,
            "action_code": candidate_action,
            "target_speed_kmh": round(candidate_target_speed, 1),
            "ego_speed_kmh": round(ego_speed_kmh, 1),
            "stopping_distance_m": round(stopping_distance_m, 2),
            "min_distance_m": round(min_dist, 1) if min_dist < 900 else None,
            "min_ttc_s": round(min_ttc, 2) if min_ttc < 900 else None,
            "critical_object": most_critical_object,
            "evaluated_hazards": evaluated_hazards,
            "predicted_intrusion": predicted_corridor_intrusion
        }


# Global risk engine instance
collision_risk_service = CollisionRiskEngine()
