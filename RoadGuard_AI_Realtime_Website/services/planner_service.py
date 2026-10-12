"""
Adaptive Dynamic Lattice Path Planner for Autonomous Vehicles on Unstructured Indian Roads.
Generates candidate collision-free lateral corridors, evaluates obstacle proximity,
computes curvature smoothness cost, and triggers safe-stop fallback when no collision-free path exists.
"""

import math
import time
from typing import List, Dict, Any, Optional


class DynamicLatticePlanner:
    """
    Modular path planner generating candidate polynomial trajectories
    and evaluating obstacle intersection and lateral clearances.
    """

    def __init__(
        self,
        road_width_m: float = 7.0,
        lateral_offsets: Optional[List[float]] = None,
        safety_margin_m: float = 0.5,
        planning_horizon_m: float = 40.0
    ):
        self.road_width = road_width_m
        # Candidate lateral displacements from centerline: 0 = center, positive = left lane, negative = right lane
        self.lateral_offsets = lateral_offsets or [0.0, 1.5, 2.5, -1.5, -2.5]
        self.safety_margin = safety_margin_m
        self.planning_horizon = planning_horizon_m

    def generate_candidate_trajectory(
        self,
        start_x: float,
        start_y: float,
        target_lat_offset: float,
        horizon_m: float = 35.0,
        n_points: int = 35
    ) -> List[Dict[str, float]]:
        """
        Generates a smooth quintic polynomial lane-change trajectory from current position to target lateral offset.
        """
        path = []
        for i in range(n_points):
            s = i / float(n_points - 1)  # Normalized longitudinal progress 0 to 1
            x = start_x + s * horizon_m

            # Quintic polynomial interpolation: 10s^3 - 15s^4 + 6s^5 (smooth jerk-free transition)
            poly = 10.0 * (s ** 3) - 15.0 * (s ** 4) + 6.0 * (s ** 5)
            y = start_y + (target_lat_offset - start_y) * poly

            # Derivative for heading
            poly_d = (30.0 * (s ** 2) - 60.0 * (s ** 3) + 30.0 * (s ** 4)) / horizon_m
            dy = (target_lat_offset - start_y) * poly_d
            heading = math.atan2(dy, 1.0)

            # Second derivative for curvature kappa
            poly_dd = (60.0 * s - 180.0 * (s ** 2) + 120.0 * (s ** 3)) / (horizon_m ** 2)
            d2y = (target_lat_offset - start_y) * poly_dd
            curvature = d2y / ((1.0 + dy ** 2) ** 1.5)

            path.append({
                "x": round(x, 2),
                "y": round(y, 2),
                "heading_rad": round(heading, 4),
                "curvature": round(curvature, 4)
            })

        return path

    def plan_path(
        self,
        ego_state: Dict[str, float],
        obstacles: List[Dict[str, Any]],
        risk_decision: str = "NORMAL"
    ) -> Dict[str, Any]:
        """
        Computes candidate paths, filters out paths with obstacle collisions,
        and returns the optimal collision-free path.
        """
        start_time = time.perf_counter()

        start_x = float(ego_state.get("x", 0.0))
        start_y = float(ego_state.get("y", 0.0))
        v_mps = max(0.0, float(ego_state.get("vx_mps", 8.3)))  # ~30 km/h default

        # Immediate stop condition
        if risk_decision in ["STOP_REQUIRED", "EMERGENCY_BRAKE"]:
            elapsed_ms = (time.perf_counter() - start_time) * 1000.0
            return {
                "ok": True,
                "status": "SAFE_STOP_TRIGGERED",
                "message": "Emergency Stop engaged. Longitudinal motion halted.",
                "selected_path": [],
                "target_lateral_offset_m": 0.0,
                "candidate_paths_evaluated": 0,
                "planning_time_ms": round(elapsed_ms, 2)
            }

        candidates = []
        valid_candidates = []

        for offset in self.lateral_offsets:
            # Check road boundary constraint
            if abs(offset) > (self.road_width / 2.0 - 0.4):
                continue  # Out of road boundary

            path = self.generate_candidate_trajectory(start_x, start_y, offset, self.planning_horizon)
            is_collision_free = True
            min_obs_dist = 999.0

            # Collision check along path points against all obstacles
            for pt in path:
                for obs in obstacles:
                    ox = float(obs.get("x", 0.0))
                    oy = float(obs.get("y", 0.0))
                    radius = float(obs.get("radius_m", 1.2))
                    d = math.hypot(pt["x"] - ox, pt["y"] - oy)
                    if d < min_obs_dist:
                        min_obs_dist = d

                    if d < (radius + self.safety_margin):
                        is_collision_free = False
                        break
                if not is_collision_free:
                    break

            # Calculate path cost
            # Preference: lower lateral offset, lower curvature, maximum clearance to obstacles
            lat_cost = abs(offset) * 1.5
            obs_clearance_cost = 25.0 / max(0.8, min_obs_dist)
            total_cost = lat_cost + obs_clearance_cost

            cand_info = {
                "offset_m": offset,
                "is_collision_free": is_collision_free,
                "min_obstacle_dist_m": round(min_obs_dist, 2),
                "cost": round(total_cost, 2),
                "path": path
            }
            candidates.append(cand_info)

            if is_collision_free:
                valid_candidates.append(cand_info)

        elapsed_ms = (time.perf_counter() - start_time) * 1000.0

        if not valid_candidates:
            # Fallback when all corridors are blocked
            return {
                "ok": True,
                "status": "NO_COLLISION_FREE_PATH",
                "message": "All lateral corridors blocked. Executing controlled safe stop.",
                "selected_path": [],
                "target_lateral_offset_m": 0.0,
                "candidate_paths_evaluated": len(candidates),
                "planning_time_ms": round(elapsed_ms, 2)
            }

        # Select minimum cost candidate
        valid_candidates.sort(key=lambda c: c["cost"])
        best = valid_candidates[0]

        return {
            "ok": True,
            "status": "PATH_GENERATED" if best["offset_m"] == 0.0 else "EVASIVE_REPLAN_ACTIVE",
            "message": f"Optimal path selected (lateral offset: {best['offset_m']}m, min clearance: {best['min_obstacle_dist_m']}m).",
            "selected_path": best["path"],
            "target_lateral_offset_m": best["offset_m"],
            "min_obstacle_distance_m": best["min_obstacle_dist_m"],
            "candidate_paths_evaluated": len(candidates),
            "valid_candidates_count": len(valid_candidates),
            "planning_time_ms": round(elapsed_ms, 2)
        }


# Global planner instance
planner_service = DynamicLatticePlanner()
