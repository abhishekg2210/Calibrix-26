import time
import math
import threading
from datetime import datetime
from typing import Dict, Any, List, Optional
from queue import Queue

class TelemetryService:
    def __init__(self):
        self.lock = threading.Lock()
        self.subscribers: List[Queue] = []

        # Current vehicle state
        self.state: Dict[str, Any] = {
            "lat": 11.016844,
            "lng": 76.955833,
            "speed_kmh": 0.0,
            "heading": 45.0,
            "battery_voltage": 12.4,
            "battery_pct": 88.0,
            "vibration_g": 0.35,
            "tilt_deg": 1.8,
            "motor_temp_c": 36.2,
            "vehicle_health": "NORMAL", # NORMAL, WARNING, DAMAGED, DISCONNECTED
            "status": "Ready · Prototype Standby",
            "hardware_connected": False,
            "is_simulated": True,
            "port_name": "None",
            "last_update": datetime.now().isoformat(timespec="seconds")
        }

        # Simulation along active route
        self.sim_active = False
        self.sim_route_coords: List[List[float]] = [] # [[lng, lat], ...]
        self.sim_index = 0
        self.sim_thread: Optional[threading.Thread] = None

        # Start simulation background worker
        self._start_sim_worker()

    def get_state(self) -> Dict[str, Any]:
        with self.lock:
            return dict(self.state)

    def subscribe(self) -> Queue:
        q = Queue(maxsize=30)
        with self.lock:
            self.subscribers.append(q)
        return q

    def unsubscribe(self, q: Queue):
        with self.lock:
            if q in self.subscribers:
                self.subscribers.remove(q)

    def broadcast(self):
        with self.lock:
            snapshot = dict(self.state)
            dead_subs = []
            for q in self.subscribers:
                try:
                    if q.full():
                        q.get_nowait()
                    q.put_nowait(snapshot)
                except Exception:
                    dead_subs.append(q)
            for d in dead_subs:
                if d in self.subscribers:
                    self.subscribers.remove(d)

    def update_from_hardware(self, telemetry: Dict[str, Any]):
        with self.lock:
            self.state["hardware_connected"] = True
            self.state["is_simulated"] = False
            self.state["port_name"] = telemetry.get("port", self.state.get("port_name", "COM"))
            if "lat" in telemetry and telemetry["lat"] is not None:
                self.state["lat"] = float(telemetry["lat"])
            if "lng" in telemetry and telemetry["lng"] is not None:
                self.state["lng"] = float(telemetry["lng"])
            if "speed" in telemetry:
                self.state["speed_kmh"] = round(float(telemetry["speed"]), 1)
            if "heading" in telemetry:
                self.state["heading"] = round(float(telemetry["heading"]), 1)
            if "battery_voltage" in telemetry:
                bv = float(telemetry["battery_voltage"])
                self.state["battery_voltage"] = round(bv, 2)
                self.state["battery_pct"] = round(max(0, min(100, (bv - 10.5) / (12.6 - 10.5) * 100)), 1)
            if "vibration" in telemetry:
                self.state["vibration_g"] = round(float(telemetry["vibration"]), 2)
            if "tilt" in telemetry:
                self.state["tilt_deg"] = round(float(telemetry["tilt"]), 1)

            # Evaluate health based on sensor inputs
            vib = self.state["vibration_g"]
            bat = self.state["battery_voltage"]
            if vib >= 3.5:
                self.state["vehicle_health"] = "DAMAGED"
                self.state["status"] = "Impact Spike Detected (>3.5G)"
            elif bat < 11.0:
                self.state["vehicle_health"] = "WARNING"
                self.state["status"] = "Low Battery Warning (<11.0V)"
            elif self.state["vehicle_health"] not in ["DAMAGED", "WARNING"]:
                self.state["vehicle_health"] = "NORMAL"
                self.state["status"] = "Hardware Telemetry Active"

            self.state["last_update"] = datetime.now().isoformat(timespec="seconds")
        self.broadcast()

    def set_active_route_for_simulation(self, geojson_geometry: Dict[str, Any]):
        with self.lock:
            if geojson_geometry and "coordinates" in geojson_geometry:
                self.sim_route_coords = geojson_geometry["coordinates"]
                self.sim_index = 0
                if self.sim_route_coords:
                    # set start position
                    start_pt = self.sim_route_coords[0]
                    self.state["lng"] = start_pt[0]
                    self.state["lat"] = start_pt[1]
                self.sim_active = True
                self.state["status"] = "Simulation Active · Cruising Route"
                self.state["speed_kmh"] = 28.5
        self.broadcast()

    def toggle_simulation(self, active: bool):
        with self.lock:
            self.sim_active = active
            if not active:
                self.state["speed_kmh"] = 0.0
                self.state["status"] = "Simulation Paused"
            else:
                self.state["status"] = "Simulation Resumed"
                self.state["speed_kmh"] = 24.0
        self.broadcast()

    def trigger_simulated_impact(self, g_force: float = 4.2):
        with self.lock:
            self.state["vibration_g"] = round(g_force, 2)
            self.state["vehicle_health"] = "DAMAGED"
            self.state["speed_kmh"] = 0.0
            self.state["status"] = f"CRITICAL: Structural Impact Registered ({g_force:.1f}G)"
            self.state["last_update"] = datetime.now().isoformat(timespec="seconds")
        self.broadcast()

    def trigger_simulated_low_battery(self, volts: float = 10.4):
        with self.lock:
            self.state["battery_voltage"] = round(volts, 2)
            self.state["battery_pct"] = 12.0
            self.state["vehicle_health"] = "WARNING"
            self.state["status"] = f"WARNING: Low Battery Voltage ({volts:.1f}V)"
            self.state["last_update"] = datetime.now().isoformat(timespec="seconds")
        self.broadcast()

    def reset_vehicle_health(self):
        with self.lock:
            self.state["vibration_g"] = 0.32
            self.state["battery_voltage"] = 12.5
            self.state["battery_pct"] = 92.0
            self.state["vehicle_health"] = "NORMAL"
            self.state["status"] = "System Status Restored to Normal"
            self.state["last_update"] = datetime.now().isoformat(timespec="seconds")
        self.broadcast()

    def _start_sim_worker(self):
        def worker():
            while True:
                time.sleep(1.2)
                should_broadcast = False
                with self.lock:
                    if self.sim_active and self.sim_route_coords and len(self.sim_route_coords) > 1:
                        if self.sim_index < len(self.sim_route_coords) - 1:
                            curr_pt = self.sim_route_coords[self.sim_index]
                            next_pt = self.sim_route_coords[self.sim_index + 1]

                            # Calculate heading
                            d_lng = next_pt[0] - curr_pt[0]
                            d_lat = next_pt[1] - curr_pt[1]
                            angle = math.degrees(math.atan2(d_lng, d_lat))
                            if angle < 0:
                                angle += 360

                            self.state["heading"] = round(angle, 1)
                            self.state["lng"] = next_pt[0]
                            self.state["lat"] = next_pt[1]
                            self.state["speed_kmh"] = 28.0 + round(math.sin(self.sim_index * 0.4) * 6.0, 1)

                            # Gentle battery consumption
                            if self.state["battery_pct"] > 5.0:
                                self.state["battery_pct"] = round(self.state["battery_pct"] - 0.05, 1)
                                self.state["battery_voltage"] = round(10.5 + (self.state["battery_pct"] / 100.0) * 2.1, 2)

                            self.sim_index += 1
                            self.state["last_update"] = datetime.now().isoformat(timespec="seconds")
                            should_broadcast = True
                        else:
                            # Reached destination
                            self.sim_active = False
                            self.state["speed_kmh"] = 0.0
                            self.state["status"] = "Destination Reached · Vehicle Halted"
                            self.state["last_update"] = datetime.now().isoformat(timespec="seconds")
                            should_broadcast = True
                if should_broadcast:
                    self.broadcast()

        self.sim_thread = threading.Thread(target=worker, daemon=True)
        self.sim_thread.start()

telemetry_service = TelemetryService()
