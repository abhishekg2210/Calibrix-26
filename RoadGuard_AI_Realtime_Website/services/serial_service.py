import json
import logging
import threading
import time
from typing import List, Dict, Any, Optional
import serial
import serial.tools.list_ports
from services.telemetry_service import telemetry_service

logger = logging.getLogger("IRIE.Serial")

class SerialService:
    def __init__(self):
        self.serial_conn: Optional[serial.Serial] = None
        self.port_name: Optional[str] = None
        self.baud_rate: int = 9600
        self.is_connected: bool = False
        self.worker_thread: Optional[threading.Thread] = None
        self.stop_signal = threading.Event()
        self.packets_count: int = 0
        self.last_packet_time: Optional[str] = None

    def list_ports(self) -> List[Dict[str, str]]:
        """List all available physical and virtual serial ports on the system."""
        ports = serial.tools.list_ports.comports()
        port_list = []
        for p in ports:
            port_list.append({
                "device": p.device,
                "description": p.description,
                "hwid": p.hwid
            })
        return port_list

    def connect(self, port: str = "AUTO", baud: int = 9600) -> Dict[str, Any]:
        """Connect to a designated port or auto-detect first Arduino/USB-Serial device."""
        self.disconnect()
        self.stop_signal.clear()
        self.baud_rate = baud

        target_port = port
        if port == "AUTO" or not port:
            available = self.list_ports()
            # Prioritize ports mentioning Arduino, USB, CH340, CP210, FTDI
            for p in available:
                desc = p["description"].lower()
                if "arduino" in desc or "ch340" in desc or "cp210" in desc or "usb-serial" in desc:
                    target_port = p["device"]
                    break
            if target_port == "AUTO" and available:
                target_port = available[0]["device"]

        if not target_port or target_port == "AUTO":
            return {
                "ok": False,
                "error": "No serial COM ports detected on the system. Plug in your Arduino via USB or use Simulation Mode.",
                "available_ports": self.list_ports()
            }

        try:
            self.serial_conn = serial.Serial(target_port, self.baud_rate, timeout=1.0)
            self.port_name = target_port
            self.is_connected = True
            self.packets_count = 0

            # Start worker thread
            self.worker_thread = threading.Thread(target=self._reader_loop, daemon=True)
            self.worker_thread.start()

            return {
                "ok": True,
                "port": self.port_name,
                "baud": self.baud_rate,
                "message": f"Successfully connected to Arduino on {self.port_name}."
            }
        except Exception as e:
            self.is_connected = False
            self.serial_conn = None
            return {
                "ok": False,
                "error": f"Failed to open port {target_port}: {str(e)}",
                "available_ports": self.list_ports()
            }

    def disconnect(self) -> Dict[str, Any]:
        """Disconnect active serial connection."""
        self.stop_signal.set()
        if self.serial_conn and self.serial_conn.is_open:
            try:
                self.serial_conn.close()
            except Exception:
                pass
        self.is_connected = False
        self.serial_conn = None
        # Notify telemetry service that physical hardware is disconnected
        curr = telemetry_service.get_state()
        curr["hardware_connected"] = False
        curr["port_name"] = "Disconnected"
        telemetry_service.broadcast()
        return {"ok": True, "message": "Serial port disconnected."}

    def get_status(self) -> Dict[str, Any]:
        return {
            "is_connected": self.is_connected,
            "port": self.port_name or "None",
            "baud": self.baud_rate,
            "packets_count": self.packets_count,
            "last_packet_time": self.last_packet_time,
            "available_ports": self.list_ports()
        }

    def _reader_loop(self):
        while not self.stop_signal.is_set() and self.serial_conn and self.serial_conn.is_open:
            try:
                line = self.serial_conn.readline().decode('utf-8', errors='ignore').strip()
                if not line:
                    continue
                parsed = self._parse_telemetry_line(line)
                if parsed:
                    self.packets_count += 1
                    self.last_packet_time = time.strftime('%H:%M:%S')
                    parsed["port"] = self.port_name
                    telemetry_service.update_from_hardware(parsed)
            except Exception as e:
                logger.error(f"Serial reader exception: {e}")
                time.sleep(0.5)

    def _parse_telemetry_line(self, line: str) -> Optional[Dict[str, Any]]:
        """
        Parses JSON or standard delimited telemetry format:
        Format 1 (JSON):
          {"lat": 11.0168, "lng": 76.9558, "spd": 24.5, "hdg": 45, "bat": 12.4, "vib": 0.4, "tilt": 1.2}
        Format 2 (NMEA CSV):
          $IRIE,11.0168,76.9558,24.5,45.0,12.4,0.4,1.2
        """
        # Try JSON
        if line.startswith("{") and line.endswith("}"):
            try:
                d = json.loads(line)
                return {
                    "lat": d.get("lat"),
                    "lng": d.get("lng"),
                    "speed": d.get("spd") or d.get("speed"),
                    "heading": d.get("hdg") or d.get("heading"),
                    "battery_voltage": d.get("bat") or d.get("battery_voltage"),
                    "vibration": d.get("vib") or d.get("vibration"),
                    "tilt": d.get("tilt")
                }
            except Exception:
                pass

        # Try CSV format
        if line.startswith("$IRIE,"):
            parts = line.split(",")
            try:
                # $IRIE,lat,lng,speed,heading,battery,vibration,tilt
                return {
                    "lat": float(parts[1]) if len(parts) > 1 and parts[1] else None,
                    "lng": float(parts[2]) if len(parts) > 2 and parts[2] else None,
                    "speed": float(parts[3]) if len(parts) > 3 and parts[3] else None,
                    "heading": float(parts[4]) if len(parts) > 4 and parts[4] else None,
                    "battery_voltage": float(parts[5]) if len(parts) > 5 and parts[5] else None,
                    "vibration": float(parts[6]) if len(parts) > 6 and parts[6] else None,
                    "tilt": float(parts[7]) if len(parts) > 7 and parts[7] else None,
                }
            except Exception:
                pass

        return None

serial_service = SerialService()
