import unittest
from services.collision_risk_service import CollisionRiskEngine


class CollisionRiskTests(unittest.TestCase):
    def setUp(self):
        self.engine = CollisionRiskEngine()

    def test_distance_estimation(self):
        # Bounding box near bottom of screen (close object)
        dist_close, unc_close = self.engine.estimate_ground_distance([400, 500, 600, 700], frame_height=720)
        # Bounding box near horizon (far object)
        dist_far, unc_far = self.engine.estimate_ground_distance([400, 300, 450, 360], frame_height=720)

        self.assertLess(dist_close, dist_far)
        self.assertLess(unc_close, unc_far)

    def test_risk_decision_continue_when_clear(self):
        res = self.engine.assess_risk([], ego_speed_kmh=40.0)
        self.assertEqual(res["decision_state"], "CONTINUE")
        self.assertEqual(res["action_code"], "MAINTAIN_SPEED")

    def test_risk_decision_caution_on_nearby_object(self):
        obj = {
            "track_id": 1,
            "class_name": "Vehicle",
            "bbox": [550, 320, 730, 410],  # Distance in caution range ~ 24m
            "velocity": {"vy": 5.0},
            "confidence": 0.9,
            "irregular_motion": False
        }
        res = self.engine.assess_risk([obj], ego_speed_kmh=30.0)
        self.assertIn(res["decision_state"], ["CAUTION", "REPLAN", "HIGH_RISK"])

    def test_risk_decision_stop_required_on_imminent_obstacle(self):
        # Object right in front at very close distance (< 4m)
        obj = {
            "track_id": 2,
            "class_name": "Pedestrian",
            "bbox": [580, 580, 700, 700],  # Close distance
            "velocity": {"vy": 30.0},
            "confidence": 0.95,
            "irregular_motion": False
        }
        res = self.engine.assess_risk([obj], ego_speed_kmh=35.0)
        self.assertEqual(res["decision_state"], "STOP_REQUIRED")
        self.assertEqual(res["action_code"], "EMERGENCY_BRAKE")
        self.assertEqual(res["target_speed_kmh"], 0.0)

    def test_risk_decision_no_safe_path_when_lanes_blocked(self):
        obj = {
            "track_id": 3,
            "class_name": "Road Blocked",
            "bbox": [500, 550, 780, 680],
            "velocity": {"vy": 0.0},
            "confidence": 0.98,
            "irregular_motion": False
        }
        # Lateral clearances zero (blocked corridor)
        res = self.engine.assess_risk([obj], ego_speed_kmh=25.0, lateral_clearance_left_m=0.5, lateral_clearance_right_m=0.5)
        self.assertEqual(res["decision_state"], "NO_SAFE_PATH_AVAILABLE")
        self.assertEqual(res["action_code"], "SAFE_STOP")


if __name__ == '__main__':
    unittest.main()
