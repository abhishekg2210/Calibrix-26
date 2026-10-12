"""
Comprehensive Automated Tests for Interactive Driving Simulation (PS 06).
Validates 5 Canonical Indian Road Scenarios, Kinematic Simulation Engine,
Obstacle Predictions, Dynamic Path Planning Decisions, and API Parity (FastAPI & Flask).
"""

import unittest
from services.simulation_engine import simulation_engine, SCENARIOS
from fastapi_app import app as fastapi_app
from app import app as flask_app
from starlette.testclient import TestClient


class DrivingSimulationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fastapi_client = TestClient(fastapi_app)
        cls.flask_client = flask_app.test_client()

    # -------------------------------------------------------------------------
    # 1. SCENARIO CONFIGURATION TESTS (PHASE 1 & 2)
    # -------------------------------------------------------------------------

    def test_all_scenarios_configured(self):
        scenarios = simulation_engine.get_scenarios_list()
        self.assertGreaterEqual(len(scenarios), 20)
        expected_ids = {f"scenario_{i}" for i in range(1, 21)}
        actual_ids = {s["id"] for s in scenarios}
        self.assertTrue(expected_ids.issubset(actual_ids))

    def test_scenario_1_normal_traffic(self):
        sc = simulation_engine.get_scenario("scenario_1")
        self.assertIsNotNone(sc)
        self.assertEqual(sc["id"], "scenario_1")
        self.assertIn("Traffic", sc["name"])
        self.assertGreater(len(sc["obstacles"]), 0)
        lead_car = sc["obstacles"][0]
        self.assertEqual(lead_car["type"], "car")

    def test_scenario_2_pedestrian_crossing(self):
        sc = simulation_engine.get_scenario("scenario_2")
        self.assertIsNotNone(sc)
        self.assertEqual(sc["id"], "scenario_2")
        self.assertIn("Pedestrian", sc["name"])
        ped = sc["obstacles"][0]
        self.assertEqual(ped["type"], "pedestrian")
        self.assertLess(ped["vy"], 0.0)  # Crossing towards centerline

    def test_scenario_3_child_occlusion(self):
        sc = simulation_engine.get_scenario("scenario_3")
        self.assertIsNotNone(sc)
        self.assertEqual(sc["id"], "scenario_3")
        self.assertIn("Child", sc["name"])
        ped_child = next(o for o in sc["obstacles"] if o["id"] == "PED_CHILD")
        self.assertEqual(ped_child["type"], "pedestrian")

    def test_scenario_4_sudden_braking(self):
        sc = simulation_engine.get_scenario("scenario_4")
        self.assertIsNotNone(sc)
        self.assertEqual(sc["id"], "scenario_4")
        self.assertIn("Braking", sc["name"])
        lead = sc["obstacles"][0]
        self.assertEqual(lead["type"], "car")

    def test_scenario_5_motorcycle_cutin(self):
        sc = simulation_engine.get_scenario("scenario_5")
        self.assertIsNotNone(sc)
        self.assertEqual(sc["id"], "scenario_5")
        self.assertIn("Motorcycle", sc["name"])
        mtr = sc["obstacles"][0]
        self.assertEqual(mtr["type"], "motorcycle")

    # -------------------------------------------------------------------------
    # 2. PLANNING DECISIONS & RISK ASSESSMENT TESTS (PHASE 3)
    # -------------------------------------------------------------------------

    def test_simulation_step_nominal_cruise_when_clear(self):
        ego = {"x": 5.0, "y": 0.0, "v_mps": 8.0, "heading_rad": 0.0}
        res = simulation_engine.step_simulation(ego, obstacles=[])
        self.assertTrue(res["ok"])
        self.assertEqual(res["action"], "NOMINAL_CRUISE")
        self.assertEqual(res["risk_level"], "LOW")
        self.assertEqual(res["target_lateral_offset_m"], 0.0)

    def test_simulation_step_lateral_replan_on_centerline_obstacle(self):
        ego = {"x": 5.0, "y": 0.0, "v_mps": 7.0, "heading_rad": 0.0}
        # Obstacle 33m ahead on centerline (y=0) with room for smooth polynomial lane change
        obstacles = [
            {
                "id": "POT_01",
                "type": "pothole",
                "x": 38.0,
                "y": 0.0,
                "vx": 0.0,
                "vy": 0.0,
                "radius_m": 0.8
            }
        ]
        res = simulation_engine.step_simulation(ego, obstacles=obstacles)
        self.assertTrue(res["ok"])
        self.assertIn(res["action"], ["LATERAL_REPLAN", "REDUCE_SPEED"])

    def test_simulation_step_emergency_stop_when_imminent_collision(self):
        ego = {"x": 5.0, "y": 0.0, "v_mps": 8.0, "heading_rad": 0.0}
        # Obstacle immediately 5m ahead on centerline
        obstacles = [
            {
                "id": "CAT_01",
                "type": "cattle",
                "x": 8.0,
                "y": 0.0,
                "vx": 0.0,
                "vy": 0.0,
                "radius_m": 1.6
            }
        ]
        res = simulation_engine.step_simulation(ego, obstacles=obstacles)
        self.assertTrue(res["ok"])
        self.assertEqual(res["action"], "EMERGENCY_STOP")
        self.assertEqual(res["risk_level"], "CRITICAL")

    def test_obstacle_future_predictions_generated(self):
        ego = {"x": 5.0, "y": 0.0, "v_mps": 8.0}
        obstacles = [
            {
                "id": "PED_01",
                "type": "pedestrian",
                "x": 30.0,
                "y": 3.0,
                "vx": -0.2,
                "vy": -1.2,
                "radius_m": 0.7
            }
        ]
        res = simulation_engine.step_simulation(ego, obstacles=obstacles)
        self.assertTrue(res["ok"])
        self.assertIn("obstacle_predictions", res)
        preds = res["obstacle_predictions"]
        self.assertEqual(len(preds), 1)
        fut_pts = preds[0]["future_positions"]
        self.assertEqual(len(fut_pts), 3)  # t=1s, 2s, 3s
        self.assertEqual(fut_pts[0]["t_sec"], 1.0)
        self.assertEqual(fut_pts[1]["t_sec"], 2.0)
        self.assertEqual(fut_pts[2]["t_sec"], 3.0)

    # -------------------------------------------------------------------------
    # 3. BACKEND API ENDPOINTS TESTS (FASTAPI & FLASK)
    # -------------------------------------------------------------------------

    def test_fastapi_simulation_endpoints(self):
        # 1. Scenarios listing
        res = self.fastapi_client.get("/api/autonomous/simulation/scenarios")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["ok"])
        self.assertGreaterEqual(len(data["scenarios"]), 20)

        # 2. Scenario detail
        sc_res = self.fastapi_client.get("/api/autonomous/simulation/scenario/scenario_1")
        self.assertEqual(sc_res.status_code, 200)
        sc_data = sc_res.json()
        self.assertTrue(sc_data["ok"])
        self.assertEqual(sc_data["scenario"]["id"], "scenario_1")

        # 3. Simulation Step
        step_res = self.fastapi_client.post(
            "/api/autonomous/simulation/step",
            json={
                "ego_state": {"x": 5.0, "y": 0.0, "v_mps": 8.0},
                "obstacles": [],
                "planner_mode": "frenet_lattice"
            }
        )
        self.assertEqual(step_res.status_code, 200)
        step_data = step_res.json()
        self.assertTrue(step_data["ok"])
        self.assertEqual(step_data["action"], "NOMINAL_CRUISE")

    def test_flask_simulation_endpoints(self):
        # 1. Scenarios listing
        res = self.flask_client.get("/api/autonomous/simulation/scenarios")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["ok"])
        self.assertGreaterEqual(len(data["scenarios"]), 20)

        # 2. Scenario detail
        sc_res = self.flask_client.get("/api/autonomous/simulation/scenario/scenario_2")
        self.assertEqual(sc_res.status_code, 200)
        sc_data = sc_res.get_json()
        self.assertTrue(sc_data["ok"])
        self.assertEqual(sc_data["scenario"]["id"], "scenario_2")

        # 3. Simulation Step
        step_res = self.flask_client.post(
            "/api/autonomous/simulation/step",
            json={
                "ego_state": {"x": 5.0, "y": 0.0, "v_mps": 8.0},
                "obstacles": [],
                "planner_mode": "frenet_lattice"
            }
        )
        self.assertEqual(step_res.status_code, 200)
        step_data = step_res.get_json()
        self.assertTrue(step_data["ok"])
        self.assertEqual(step_data["action"], "NOMINAL_CRUISE")


if __name__ == "__main__":
    unittest.main()
