"""
Scenario 4: Dense Market Area with Sudden Animal / Cattle Crossing Event.
Demonstrates non-standard VRU classification, distance estimation, and controlled safety stop.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from services.carla_service import carla_service


def run_scenario():
    print("=" * 70)
    print("SCENARIO 4: DENSE MARKET AREA - SUDDEN CATTLE CROSSING")
    print("=" * 70)
    res = carla_service.run_scenario_benchmark("scenario_4")
    print(f"Outcome: {'SUCCESS' if res['success'] else 'FAILED'}")
    for step in res["timeline"]:
        print(f"t={step['time_s']}s | Speed: {step['ego_speed_kmh']} km/h | Risk: {step['risk_decision']:<15} | Action: {step['planner_action']}")
    return res


if __name__ == "__main__":
    run_scenario()
