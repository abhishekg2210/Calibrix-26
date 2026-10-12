"""
Unit and Integration Tests for A* Road-Graph Path Planning Engine (Phase 3).
Tests:
1. Shortest path optimality and connection between origin and destination.
2. One-way road directionality constraints.
3. Disconnected graph and no-path handling.
4. Invalid node input validation.
5. Impassable hard road closures forcing alternate route selection.
6. Risk-aware cost penalization for active hazards and construction.
7. K-alternative route discovery.
8. Admissibility and consistency of Haversine heuristic.
"""

import unittest
from services.astar_planner import AStarRoadPlanner, haversine_distance_m


class AStarPlannerTests(unittest.TestCase):

    def setUp(self):
        self.planner = AStarRoadPlanner()

    def test_shortest_path_optimality(self):
        """Verifies that A* finds the optimal path connecting start to goal."""
        res = self.planner.plan_path("railway_stn", "gandhipuram")
        self.assertTrue(res["ok"])
        self.assertEqual(res["path_nodes"][0], "railway_stn")
        self.assertEqual(res["path_nodes"][-1], "gandhipuram")
        self.assertGreater(res["distance_km"], 0.0)
        self.assertGreater(res["duration_min"], 0.0)
        # Optimal direct path: railway_stn -> collectorate -> gandhipuram
        self.assertIn("collectorate", res["path_nodes"])

    def test_one_way_street_enforcement(self):
        """One-way street from crosscut to gandhipuram should not allow reverse traversal."""
        # e6_crosscut_gandhi is one-way: crosscut -> gandhipuram
        # Check if direct edge from gandhipuram -> crosscut exists
        gandhi_edges = self.planner.adjacency.get("gandhipuram", [])
        reverse_exists = any(
            self.planner.edges[eid].to_node == "crosscut" for eid in gandhi_edges
        )
        self.assertFalse(reverse_exists, "One-way street must not allow reverse edge creation.")

    def test_hard_road_closure_forces_alternative_route(self):
        """When Dr. Nanjappa Road (e2_coll_gandhi) is closed, planner must divert via RS Puram or Race Course."""
        # Baseline path
        baseline = self.planner.plan_path("railway_stn", "gandhipuram")
        self.assertIn("collectorate", baseline["path_nodes"])

        # Close the direct edge
        self.planner.edges["e2_coll_gandhi"].is_closed = True

        rerouted = self.planner.plan_path("railway_stn", "gandhipuram")
        self.assertTrue(rerouted["ok"])
        self.assertEqual(rerouted["path_nodes"][0], "railway_stn")
        self.assertEqual(rerouted["path_nodes"][-1], "gandhipuram")
        self.assertNotIn("e2_coll_gandhi", rerouted["edge_ids"])
        # Should divert via western bypass (rs_puram) or eastern ring
        self.assertTrue(
            "rs_puram" in rerouted["path_nodes"] or "race_course" in rerouted["path_nodes"] or "avinashi_rd_hub" in rerouted["path_nodes"]
        )

    def test_hazard_penalties_evaluated(self):
        """Active hazards along an edge increase duration and risk score."""
        baseline = self.planner.plan_path("railway_stn", "gandhipuram")
        base_dur = baseline["duration_min"]

        # Add construction hazard near Dr. Nanjappa Road
        coll_node = self.planner.nodes["collectorate"]
        hazard = {
            "lat": coll_node.lat + 0.005,
            "lng": coll_node.lng,
            "type": "Construction Working",
            "severity": "Medium",
            "confidence": 0.9,
            "verified": True
        }
        self.planner.apply_hazards([hazard], distance_threshold_m=1000.0)

        with_hazard = self.planner.plan_path("railway_stn", "gandhipuram")
        self.assertTrue(with_hazard["ok"])
        # Either the path took longer due to hazard penalty or diverted
        self.assertTrue(
            with_hazard["duration_min"] > base_dur or with_hazard["path_nodes"] != baseline["path_nodes"]
        )

    def test_disconnected_graph_no_path_found(self):
        """When an isolated node has no edges, planner returns clear no-path result."""
        self.planner.add_node("isolated_island", 11.2000, 76.8000, "Isolated Outpost")
        res = self.planner.plan_path("railway_stn", "isolated_island")
        self.assertFalse(res["ok"])
        self.assertIn("No viable path found", res["error"])
        self.assertTrue(res.get("is_blocked", False))

    def test_invalid_node_input(self):
        """Invalid node names must return an error rather than raising an uncaught exception."""
        res = self.planner.plan_path("non_existent_start", "gandhipuram")
        self.assertFalse(res["ok"])
        self.assertIn("Invalid start", res["error"])

    def test_alternative_paths_generation(self):
        """Planner generates multiple distinct viable alternative routes."""
        alts = self.planner.plan_alternatives("railway_stn", "peelamedu", k=3)
        self.assertGreaterEqual(len(alts), 2)
        # Verify first is marked recommended
        self.assertTrue(alts[0]["is_recommended"])
        # Verify alternative has different edge IDs or distance
        self.assertNotEqual(alts[0]["edge_ids"], alts[1]["edge_ids"])

    def test_haversine_heuristic_admissibility(self):
        """Heuristic value must never exceed actual minimum travel time."""
        h_val = self.planner.heuristic("railway_stn", "peelamedu", max_speed_kmh=80.0)
        res = self.planner.plan_path("railway_stn", "peelamedu")
        actual_time_s = res["duration_min"] * 60.0
        self.assertLessEqual(h_val, actual_time_s)


if __name__ == '__main__':
    unittest.main()
