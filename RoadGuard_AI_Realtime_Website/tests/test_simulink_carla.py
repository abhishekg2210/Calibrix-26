import unittest
from services.simulink_service import simulink_service
from services.carla_service import carla_service
from services.pathweaver_adapter import pathweaver_adapter


class SimulinkAndCarlaTests(unittest.TestCase):
    def test_simulink_bicycle_model_spec(self):
        spec = simulink_service.get_model_spec()
        self.assertTrue(spec["ok"])
        self.assertIn("wheelbase_m", spec["parameters"])
        self.assertEqual(len(spec["suggested_mathworks_tools"]), 6)

    def test_simulink_step_integration(self):
        simulink_service.reset()
        res = simulink_service.step_simulation(steering_target_deg=5.0, target_velocity_mps=10.0, dt=0.05, risk_level="NORMAL")
        self.assertTrue(res["ok"])
        self.assertGreater(res["state"]["x"], 0.0)
        self.assertEqual(res["stateflow_state"], "CRUISE_LANE_FOLLOWING")

    def test_simulink_stateflow_transition_on_stop(self):
        simulink_service.reset()
        res = simulink_service.step_simulation(steering_target_deg=0.0, target_velocity_mps=10.0, dt=0.05, risk_level="STOP_REQUIRED")
        self.assertEqual(res["stateflow_state"], "EMERGENCY_SAFE_STOP")
        self.assertEqual(res["telemetry"]["speed_kmh"], 0.0)

    def test_carla_connection_probe(self):
        status = carla_service.check_connection()
        self.assertIn("connected", status)
        self.assertIn("status", status)
        self.assertIn(status["status"], ["ONLINE_CONNECTED", "NOT_CONFIGURED_OFFLINE"])

    def test_carla_deterministic_scenario_benchmark(self):
        res = carla_service.run_scenario_benchmark("scenario_1")
        self.assertTrue(res["ok"])
        self.assertIn("timeline", res)
        self.assertGreater(len(res["timeline"]), 5)
        self.assertIn("average_planning_latency_ms", res["evaluation_metrics"])

    def test_pathweaver_adapter_profile(self):
        waypoints = [{"x": 0.0, "y": 0.0}, {"x": 20.0, "y": 2.0}, {"x": 40.0, "y": 0.0}]
        traj = pathweaver_adapter.generate_trajectory(waypoints)
        self.assertTrue(traj["ok"])
        self.assertGreater(traj["trajectory_points_count"], 10)


if __name__ == '__main__':
    unittest.main()
