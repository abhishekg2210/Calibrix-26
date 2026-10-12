import time
from datetime import datetime
from typing import Dict, Any, List, Optional
from database import get_db

class AlertService:
    def __init__(self):
        self.debounce_cache: Dict[str, float] = {}
        self.debounce_interval_sec: float = 12.0
        self.pending_reroute: Optional[Dict[str, Any]] = None

    def create_alert(
        self,
        title: str,
        message: str,
        severity: str = "INFO", # CRITICAL, WARNING, INFO
        alert_type: str = "HAZARD", # HAZARD, DAMAGE, BATTERY, DISCONNECT, REROUTE
        lat: Optional[float] = None,
        lng: Optional[float] = None,
        force: bool = False
    ) -> Optional[Dict[str, Any]]:
        """Creates a timestamped alert with debounce suppression."""
        now = time.time()
        debounce_key = f"{alert_type}:{title}"
        if not force and debounce_key in self.debounce_cache:
            if now - self.debounce_cache[debounce_key] < self.debounce_interval_sec:
                return None # Suppressed duplicate alert
        self.debounce_cache[debounce_key] = now

        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO alerts (title, message, severity, alert_type, lat, lng, is_resolved)
            VALUES (?, ?, ?, ?, ?, ?, 0)
        ''', (title, message, severity.upper(), alert_type.upper(), lat, lng))
        conn.commit()
        alert_id = cursor.lastrowid
        conn.close()

        return {
            "id": alert_id,
            "title": title,
            "message": message,
            "severity": severity.upper(),
            "alert_type": alert_type.upper(),
            "lat": lat,
            "lng": lng,
            "is_resolved": False,
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }

    def get_alerts(self, limit: int = 50, unresolved_only: bool = False) -> List[Dict[str, Any]]:
        conn = get_db()
        cursor = conn.cursor()
        query = 'SELECT * FROM alerts'
        if unresolved_only:
            query += ' WHERE is_resolved = 0'
        query += ' ORDER BY id DESC LIMIT ?'
        cursor.execute(query, (limit,))
        rows = cursor.fetchall()
        conn.close()
        return [dict(r) for r in rows]

    def resolve_alert(self, alert_id: int):
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('UPDATE alerts SET is_resolved = 1 WHERE id = ?', (alert_id,))
        conn.commit()
        conn.close()

    def create_reroute_request(
        self,
        hazard: Dict[str, Any],
        affected_route: Dict[str, Any],
        suggested_route: Dict[str, Any],
        mode: str = "approval"
    ) -> Dict[str, Any]:
        """Creates an owner reroute notification / approval request."""
        time_diff = round(suggested_route.get("duration_min", 0) - affected_route.get("duration_min", 0), 1)
        sign = "+" if time_diff > 0 else ""
        time_str = f"{sign}{time_diff} min" if time_diff != 0 else "same time"

        request_data = {
            "id": int(time.time()),
            "hazard_title": hazard.get("title", "Road Obstruction"),
            "hazard_type": hazard.get("type", "Blockage"),
            "affected_route_id": affected_route.get("id", 1),
            "affected_route_name": affected_route.get("name", "Current Route"),
            "suggested_route_id": suggested_route.get("id", 2),
            "suggested_route_name": suggested_route.get("name", "Alternative Route"),
            "time_diff_str": time_str,
            "reason": f"Hazard detected on {affected_route.get('name')}. {suggested_route.get('name')} bypasses the incident area ({time_str}).",
            "source": "IRIE Road Hazard Telemetry Engine",
            "status": "AUTO_APPLIED" if mode == "automatic" else "PENDING_APPROVAL",
            "created_at": datetime.now().strftime("%H:%M:%S")
        }

        self.pending_reroute = request_data

        # Also log alert in database
        severity = "WARNING" if mode == "approval" else "INFO"
        self.create_alert(
            title=f"Reroute Recommendation: {hazard.get('title', 'Hazard Ahead')}",
            message=request_data["reason"],
            severity=severity,
            alert_type="REROUTE",
            lat=hazard.get("lat"),
            lng=hazard.get("lng")
        )

        return request_data

    def get_pending_reroute(self) -> Optional[Dict[str, Any]]:
        return self.pending_reroute

    def resolve_reroute(self, decision: str) -> Dict[str, Any]:
        if not self.pending_reroute:
            return {"ok": False, "error": "No pending reroute request found."}
        
        if decision == "accept":
            self.pending_reroute["status"] = "ACCEPTED"
            res = dict(self.pending_reroute)
            self.pending_reroute = None
            return {"ok": True, "action": "accepted", "route_id": res["suggested_route_id"]}
        else:
            self.pending_reroute["status"] = "REJECTED"
            res = dict(self.pending_reroute)
            self.pending_reroute = None
            return {"ok": True, "action": "rejected", "route_id": res["affected_route_id"]}

alert_service = AlertService()
