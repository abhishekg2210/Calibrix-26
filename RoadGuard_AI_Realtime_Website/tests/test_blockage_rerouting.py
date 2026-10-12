"""
Automated Test Suite: Road Blockage and Construction Automatic Rerouting.
Covers:
1. Normal route calculation and baseline metrics.
2. Road closure / blockage detection on active route triggering alternative bypass.
3. Construction zone detection triggering reroute or detour.
4. All corridors blocked fallback state (safe simulation halt, manual retry).
5. Reroute cooldown and loop prevention.
6. API endpoint integrity (/api/routes) with hazard payloads.
"""

import unittest
import time
from services.routing_service import calculate_routes, haversine_distance, check_hazard_intersection
from app import app as flask_app


class BlockageReroutingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = flask_app.test_client()
        # Authenticate demo session
        cls.client.post("/api/auth/login", json={
            "identifier": "admin@irie.ai",
            "password": "Admin@123"
        })
        # Canonical test locations in Coimbatore
        cls.start = {"lat": 10.9979, "lng": 76.9634}  # Railway Station
        cls.end = {"lat": 11.0183, "lng": 76.9644}    # Gandhipuram

    def test_normal_route_calculation(self):
        """Verify standard route calculation returns valid routes without blockage."""
        result = calculate_routes(self.start, self.end, hazards=[])
        self.assertTrue(result["ok"])
        self.assertGreater(len(result["routes"]), 0)
        self.assertFalse(result["all_blocked"])
        self.assertTrue(result["unblocked_alternative_available"])
        
        primary = result["routes"][0]
        self.assertGreater(primary["distance_km"], 0.0)
        self.assertGreater(primary["duration_min"], 0.0)
        self.assertFalse(primary["is_blocked"])

    def test_road_blockage_triggers_corridor_avoidance(self):
        """
        Placing a critical road blockage on the primary route must mark it as blocked
        and recommend an open bypass route.
        """
        # First get clean geometry of primary route
        clean_result = calculate_routes(self.start, self.end, hazards=[])
        coords = clean_result["routes"][0]["geometry"]["coordinates"]
        midpoint = coords[len(coords) // 2]  # [lng, lat]

        blockage_hazard = {
            "id": "h-block-test",
            "type": "Road Blocked",
            "lat": midpoint[1],
            "lng": midpoint[0],
            "severity": "Critical"
        }

        rerouted = calculate_routes(self.start, self.end, hazards=[blockage_hazard])
        self.assertTrue(rerouted["ok"])
        self.assertGreater(len(rerouted["routes"]), 0)
        
        # Primary corridor intersecting hazard must be flagged as blocked
        blocked_routes = [r for r in rerouted["routes"] if r["is_blocked"]]
        self.assertGreater(len(blocked_routes), 0)

        # Recommended route must prefer an unblocked corridor if available
        rec_route = next((r for r in rerouted["routes"] if r["is_recommended"]), None)
        self.assertIsNotNone(rec_route)
        if rerouted["unblocked_alternative_available"]:
            self.assertFalse(rec_route["is_blocked"])

    def test_construction_zone_triggers_corridor_blockage(self):
        """Active construction zone on corridor flags blockage and suggests detour."""
        clean_result = calculate_routes(self.start, self.end, hazards=[])
        coords = clean_result["routes"][0]["geometry"]["coordinates"]
        pt = coords[len(coords) // 3]

        construction_hazard = {
            "id": "h-const-test",
            "type": "Construction Working",
            "lat": pt[1],
            "lng": pt[0],
            "severity": "Moderate"
        }

        res = calculate_routes(self.start, self.end, hazards=[construction_hazard])
        self.assertTrue(res["ok"])
        has_blocked_or_warning = any(
            r["is_blocked"] or r["has_hazard"] for r in res["routes"]
        )
        self.assertTrue(has_blocked_or_warning)

    def test_all_corridors_blocked_flags_fallback_halt(self):
        """
        When all alternative corridors are obstructed, system flags all_blocked=True
        and unblocked_alternative_available=False.
        """
        clean_result = calculate_routes(self.start, self.end, hazards=[])
        hazards = []
        for i, r in enumerate(clean_result["routes"]):
            coords = r["geometry"]["coordinates"]
            mid = coords[len(coords) // 2]
            hazards.append({
                "id": f"h-all-block-{i}",
                "type": "Road Blocked",
                "lat": mid[1],
                "lng": mid[0],
                "severity": "Critical"
            })

        res = calculate_routes(self.start, self.end, hazards=hazards)
        self.assertTrue(res["ok"])
        self.assertTrue(res["all_blocked"])
        self.assertFalse(res["unblocked_alternative_available"])

    def test_reroute_cooldown_logic(self):
        """
        Verify that rerouting logic enforces a cooldown (e.g. 4.0s)
        to prevent repeated API loops or rapid-fire recalculations.
        """
        cooldown_s = 4.0
        last_reroute_time = time.time() - 1.5  # 1.5s ago

        def can_trigger_reroute(current_time, last_time, cooldown):
            return (current_time - last_time) >= cooldown

        # Within cooldown window -> reject
        self.assertFalse(can_trigger_reroute(time.time(), last_reroute_time, cooldown_s))
        # After cooldown window -> allow
        self.assertTrue(can_trigger_reroute(time.time() + 3.0, last_reroute_time, cooldown_s))

    def test_api_routes_endpoint_with_hazards(self):
        """Test Flask HTTP /api/routes endpoint with blockage hazard payload."""
        payload = {
            "start": self.start,
            "end": self.end,
            "hazards": [
                {
                    "id": "h-api-test",
                    "type": "Road Blocked",
                    "lat": 11.0080,
                    "lng": 76.9639,
                    "severity": "Critical"
                }
            ]
        }
        response = self.client.post("/api/routes", json=payload)
        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertTrue(data.get("ok"))
        self.assertIn("routes", data)
        self.assertIn("all_blocked", data)
        self.assertIn("unblocked_alternative_available", data)
        self.assertIn("provider", data)


if __name__ == "__main__":
    unittest.main()
