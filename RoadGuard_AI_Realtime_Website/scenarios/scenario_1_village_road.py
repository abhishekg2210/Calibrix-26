"""
Scenario 1: Unmarked Village Road with Sudden Pedestrian Crossing.
Demonstrates pedestrian emergence from roadside blind spot and emergency collision avoidance.
"""

import sys
import os
import json
import time

# Ensure services are importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from services.carla_service import carla_service


def run_scenario():
    print("=" * 70)
    print("SCENARIO 1: UNMARKED VILLAGE ROAD - SUDDEN PEDESTRIAN CROSSING")
    print("=" * 70)
    status = carla_service.check_connection()
    print(f"CARLA Server Status: {status['status']} ({status['host']}:{status['port']})")
    
    res = carla_service.run_scenario_benchmark("scenario_1")
    print(f"Scenario Name: {res['scenario']['name']}")
    print(f"Description: {res['scenario']['description']}")
    print(f"Execution Mode: {res['execution_mode']}")
    print(f"Test Outcome: {'SUCCESS (Collision Avoided)' if res['success'] else 'FAILED'}")
    print("\n--- Event Timeline ---")
    for step in res["timeline"]:
        print(f"t={step['time_s']}s | Speed: {step['ego_speed_kmh']} km/h | Risk: {step['risk_decision']:<15} | Action: {step['planner_action']}")
    print(f"\nAverage Planning Latency: {res['evaluation_metrics']['average_planning_latency_ms']} ms")
    return res


if __name__ == "__main__":
    run_scenario()
