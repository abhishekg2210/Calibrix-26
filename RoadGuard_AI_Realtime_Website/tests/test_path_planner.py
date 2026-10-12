import unittest
from services.planner_service import DynamicLatticePlanner


class PathPlannerTests(unittest.TestCase):
    def setUp(self):
        self.planner = DynamicLatticePlanner(road_width_m=7.0, lateral_offsets=[0.0, 1.5, 2.5, -1.5, -2.5], safety_margin_m=0.5)

    def test_nominal_path_when_no_obstacles(self):
        ego = {"x": 0.0, "y": 0.0, "vx_mps": 10.0}
        plan = self.planner.plan_path(ego, obstacles=[], risk_decision="NORMAL")
        self.assertTrue(plan["ok"])
        self.assertEqual(plan["status"], "PATH_GENERATED")
        self.assertEqual(plan["target_lateral_offset_m"], 0.0)
        self.assertGreater(len(plan["selected_path"]), 0)

    def test_lateral_replan_when_centerline_blocked(self):
        ego = {"x": 0.0, "y": 0.0, "vx_mps": 8.0}
        # Obstacle placed directly ahead on centerline (x=20m, y=0.0m)
        obstacles = [{"x": 20.0, "y": 0.0, "radius_m": 0.7}]
        plan = self.planner.plan_path(ego, obstacles=obstacles, risk_decision="REPLAN")
        self.assertTrue(plan["ok"])
        self.assertEqual(plan["status"], "EVASIVE_REPLAN_ACTIVE")
        # Lateral offset must be non-zero to detour around obstacle
        self.assertNotEqual(plan["target_lateral_offset_m"], 0.0)
        self.assertGreater(plan["min_obstacle_distance_m"], 1.2)

    def test_safe_stop_when_all_corridors_blocked(self):
        ego = {"x": 0.0, "y": 0.0, "vx_mps": 8.0}
        # Obstacles spanning center, left, and right lanes
        obstacles = [
            {"x": 20.0, "y": 0.0, "radius_m": 1.5},
            {"x": 20.0, "y": 1.5, "radius_m": 1.5},
            {"x": 20.0, "y": 2.8, "radius_m": 1.5},
            {"x": 20.0, "y": -1.5, "radius_m": 1.5},
            {"x": 20.0, "y": -2.8, "radius_m": 1.5}
        ]
        plan = self.planner.plan_path(ego, obstacles=obstacles, risk_decision="REPLAN")
        self.assertTrue(plan["ok"])
        self.assertEqual(plan["status"], "NO_COLLISION_FREE_PATH")
        self.assertEqual(len(plan["selected_path"]), 0)

    def test_safe_stop_triggered_on_stop_required_risk(self):
        ego = {"x": 0.0, "y": 0.0, "vx_mps": 8.0}
        plan = self.planner.plan_path(ego, obstacles=[], risk_decision="STOP_REQUIRED")
        self.assertTrue(plan["ok"])
        self.assertEqual(plan["status"], "SAFE_STOP_TRIGGERED")


if __name__ == '__main__':
    unittest.main()
