"""
Collision Risk Assessment Engine for Unstructured Indian Road Navigation.
Computes distance estimation, Time-To-Collision (TTC), sensor uncertainty,
and evaluates configurable decision states:
- CONTINUE
- CAUTION / REDUCE_SPEED
- STOP_REQUIRED
- REPLAN
- NO_SAFE_PATH_AVAILABLE
"""

import math
from typing import List, Dict, Any, Optional


class CollisionRiskEngine:
    """
    Evaluates collision risk by fusing object bounding boxes, tracking velocities,
    ego-vehicle speed, ground-plane distance estimates, and measurement uncertainty.
    """

    def __init__(
        self,
        caution_ttc_s: float = 4.5,
        stop_ttc_s: float = 1.3,
        critical_clearance_m: float = 2.8,
        reaction_time_s: float = 0.4,
        max_decel_mps2: float = 6.0
    ):
        self.caution_ttc = caution_ttc_s
        self.stop_ttc = stop_ttc_s
        self.critical_clearance = critical_clearance_m
        self.reaction_time = reaction_time_s
        self.max_decel = max_decel_mps2

    def estimate_ground_distance(self, bbox: List[float], frame_height: int = 720) -> Tuple[float, float]:
        """
        Estimates ground distance in meters based on the bottom coordinate of the bounding box.
        Returns: (distance_m, uncertainty_0_to_1)
        """
        # y2 is bottom edge where object touches the road surface
        y2 = bbox[3]
        norm_y = max(0.1, min(1.0, y2 / float(frame_height)))

        # Perspective ground mapping: objects near horizon (norm_y ~ 0.4) are ~50-80m away;
        # objects at bottom of frame (norm_y ~ 0.95) are ~2-3m away.
        horizon = 0.38
        if norm_y <= horizon:
            return 80.0, 0.65  # High distance uncertainty near horizon

        # Inverse linear ground model calibrated for 1.3m hood camera height
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
        Evaluates scene safety and returns decision state with documented metrics.
        """
        ego_v_mps = max(0.0, ego_speed_kmh / 3.6)
        stopping_distance_m = (ego_v_mps * self.reaction_time) + ((ego_v_mps ** 2) / (2.0 * self.max_decel))
        stopping_distance_m = max(2.5, stopping_distance_m)

        evaluated_hazards = []
        min_ttc = 999.0
        min_dist = 999.0
        most_critical_object = None

        center_x = frame_width / 2.0
        corridor_half_width = frame_width * 0.22  # Ego vehicle forward path corridor

        has_blocking_obstacle = False
        both_lanes_blocked = False

        for obj in tracked_objects:
            bbox = obj.get("bbox", [0, 0, 0, 0])
            cx = (bbox[0] + bbox[2]) / 2.0
            dist_m, dist_uncertainty = self.estimate_ground_distance(bbox, frame_height)

            # Object relative velocity
            vy_px = obj.get("velocity", {}).get("vy", 0.0)
            # Positive vy_px means moving towards camera (downward)
            obj_rel_speed_mps = (vy_px / 40.0) if abs(vy_px) > 1.0 else 0.0
            closing_speed_mps = ego_v_mps + obj_rel_speed_mps

            # Time to collision calculation
            if closing_speed_mps > 0.5 and dist_m > 0:
                ttc_s = dist_m / closing_speed_mps
            else:
                ttc_s = 999.0  # Moving away or stationary with stationary ego

            in_ego_path = abs(cx - center_x) < corridor_half_width
            is_lateral_intrusion = obj.get("irregular_motion", False) or (abs(cx - center_x) < corridor_half_width * 1.6)

            hazard_eval = {
                "track_id": obj.get("track_id"),
                "class_name": obj.get("class_name"),
                "distance_m": dist_m,
                "ttc_s": round(ttc_s, 2) if ttc_s < 900 else None,
                "in_ego_path": in_ego_path,
                "uncertainty": dist_uncertainty,
                "confidence": obj.get("confidence", 0.8)
            }
            evaluated_hazards.append(hazard_eval)

            if in_ego_path or is_lateral_intrusion:
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

        # Decision State Determination
        if both_lanes_blocked or (has_blocking_obstacle and min_dist < 4.0):
            decision_state = "NO_SAFE_PATH_AVAILABLE"
            status_text = "Corridor completely obstructed - No safe lateral bypass available."
            action_code = "SAFE_STOP"
            target_speed_kmh = 0.0
        elif min_ttc <= self.stop_ttc or (has_blocking_obstacle and min_dist <= stopping_distance_m):
            decision_state = "STOP_REQUIRED"
            status_text = f"Imminent collision hazard detected ({most_critical_object['class_name'] if most_critical_object else 'Obstacle'} at {min_dist:.1f}m, TTC {min_ttc:.1f}s). Immediate braking required."
            action_code = "EMERGENCY_BRAKE"
            target_speed_kmh = 0.0
        elif has_blocking_obstacle:
            decision_state = "REPLAN"
            status_text = f"Obstruction detected at {min_dist:.1f}m. Initiating lateral corridor replanning."
            action_code = "REPLAN_PATH"
            target_speed_kmh = min(ego_speed_kmh, 15.0)
        elif min_ttc <= self.caution_ttc or min_dist < 18.0:
            decision_state = "CAUTION"
            status_text = f"Caution: Dynamic entity nearby ({most_critical_object['class_name'] if most_critical_object else 'Entity'} at {min_dist:.1f}m). Reduce speed."
            action_code = "REDUCE_SPEED"
            target_speed_kmh = min(ego_speed_kmh, 20.0)
        else:
            decision_state = "CONTINUE"
            status_text = "Path clear. Autonomous cruising within road boundaries."
            action_code = "MAINTAIN_SPEED"
            target_speed_kmh = ego_speed_kmh

        return {
            "ok": True,
            "decision_state": decision_state,
            "status_text": status_text,
            "action_code": action_code,
            "target_speed_kmh": round(target_speed_kmh, 1),
            "ego_speed_kmh": round(ego_speed_kmh, 1),
            "stopping_distance_m": round(stopping_distance_m, 2),
            "min_distance_m": round(min_dist, 1) if min_dist < 900 else None,
            "min_ttc_s": round(min_ttc, 2) if min_ttc < 900 else None,
            "critical_object": most_critical_object,
            "evaluated_hazards": evaluated_hazards
        }


# Global risk engine instance
collision_risk_service = CollisionRiskEngine()
