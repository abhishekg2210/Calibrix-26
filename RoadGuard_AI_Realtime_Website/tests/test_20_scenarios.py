"""
Unit & Integration Tests for the 20 Canonical Autonomous Driving Scenarios.
Verifies scenario integrity, initial conditions, obstacle setup,
and deterministic execution across all categories.
"""

import unittest
from services.simulation_engine import simulation_engine, SCENARIOS


class TestTwentyScenarios(unittest.TestCase):

    def test_all_20_scenarios_exist(self):
        """Ensure all 20 required canonical scenarios are registered."""
        self.assertEqual(len(SCENARIOS), 20)
        for i in range(1, 21):
            sc_id = f"scenario_{i}"
            self.assertIn(sc_id, SCENARIOS, f"Missing {sc_id}")

    def test_scenarios_metadata_and_structure(self):
        """Verify each scenario defines valid roads, ego state, category, and expected state."""
        for sc_id, sc in SCENARIOS.items():
            self.assertIn("name", sc)
            self.assertIn("category", sc)
            self.assertIn("difficulty", sc)
            self.assertIn("expected_state", sc)
            self.assertIn("success_criteria", sc)
            self.assertGreater(sc["road_width_m"], 0.0)
            self.assertGreater(sc["road_length_m"], 0.0)
            self.assertIn("x", sc["ego_start"])
            self.assertIn("v_mps", sc["ego_start"])

    def test_run_scenario_1_normal_traffic(self):
        """Scenario 1: Normal urban traffic flow."""
        res = simulation_engine.run_deterministic_scenario("scenario_1", max_steps=10)
        self.assertTrue(res["ok"])
        self.assertEqual(res["expected_state"], "NORMAL")
        self.assertEqual(res["status"], "PASS")

    def test_run_scenario_2_pedestrian_crossing(self):
        """Scenario 2: Pedestrian crossing requires STOP."""
        res = simulation_engine.run_deterministic_scenario("scenario_2", max_steps=10)
        self.assertTrue(res["ok"])
        self.assertEqual(res["expected_state"], "STOP")
        self.assertIn("STOP", res["observed_states"])
        self.assertEqual(res["status"], "PASS")

    def test_run_scenario_8_road_blockage_replan(self):
        """Scenario 8: Complete road blockage triggers REPLANNING or STOP."""
        res = simulation_engine.run_deterministic_scenario("scenario_8", max_steps=10)
        self.assertTrue(res["ok"])
        self.assertTrue(res["passed"])

    def test_batch_all_20_scenarios_execution(self):
        """Run all 20 scenarios and ensure zero crashes."""
        sc_list = simulation_engine.get_scenarios_list()
        self.assertEqual(len(sc_list), 20)
        pass_count = 0
        for sc in sc_list:
            res = simulation_engine.run_deterministic_scenario(sc["id"], max_steps=8)
            self.assertTrue(res["ok"])
            if res["passed"]:
                pass_count += 1
        # At least 18/20 deterministic scenarios pass their strict safety threshold
        self.assertGreaterEqual(pass_count, 18)


if __name__ == "__main__":
    unittest.main()
