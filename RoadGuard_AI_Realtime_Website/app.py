import os
import io
import json
import time
import zipfile
import math
import requests
from datetime import datetime, timezone
from flask import Flask, render_template, request, jsonify, session, redirect, url_for, Response, send_file
from dotenv import load_dotenv

# Load environment variables from .env
load_dotenv(override=True)

from database import init_db, get_db
from services.auth_service import authenticate_user, create_user, get_user_by_id, login_required
from services.routing_service import calculate_routes
from services.telemetry_service import telemetry_service
from services.serial_service import serial_service
from services.alert_service import alert_service
from services.autonomous_routes import autonomous_bp

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "irie_dev_secret_key_8f7b3c2e1d0a5f4e")
app.config["GOOGLE_MAPS_BROWSER_KEY"] = os.environ.get("GOOGLE_MAPS_BROWSER_KEY", "")

# Register Autonomous Driving Research Blueprint
app.register_blueprint(autonomous_bp)

# Initialize SQLite database and seed demo account on startup
init_db()

# Auto-connect serial if configured
initial_serial_port = os.environ.get("SERIAL_PORT", "AUTO")
if initial_serial_port:
    serial_service.connect(initial_serial_port, int(os.environ.get("SERIAL_BAUD_RATE", 9600)))

# -----------------------------------------------------------------------------
# PAGE ROUTES
# -----------------------------------------------------------------------------

@app.get("/")
@app.get("/simulation")
@app.get("/driving-simulation")
@login_required
def home():
    user = get_user_by_id(session.get("user_id"))
    reroute_mode = os.environ.get("REROUTE_MODE", "approval")
    return render_template("index.html", user=user, reroute_mode=reroute_mode)

@app.get("/login")
def login():
    if session.get("user_id"):
        return redirect(url_for("home"))
    demo_email = os.environ.get("DEMO_EMAIL", "admin@irie.ai")
    demo_password = os.environ.get("DEMO_PASSWORD", "Admin@123")
    return render_template("login.html", demo_email=demo_email, demo_password=demo_password)

@app.get("/register")
def register():
    if session.get("user_id"):
        return redirect(url_for("home"))
    return render_template("register.html")

# -----------------------------------------------------------------------------
# AUTHENTICATION API
# -----------------------------------------------------------------------------

@app.post("/api/auth/login")
def api_login():
    data = request.get_json(silent=True) or {}
    identifier = data.get("identifier") or data.get("email") or ""
    password = data.get("password") or ""

    user, error = authenticate_user(identifier, password)
    if error or not user:
        return jsonify(ok=False, error=error or "Invalid credentials"), 401

    session["user_id"] = user["id"]
    session["role"] = user["role"]
    session.permanent = True if data.get("remember") else False

    alert_service.create_alert(
        title="User Logged In",
        message=f"{user['username']} ({user['role']}) accessed IRIE Fleet Console.",
        severity="INFO",
        alert_type="SYSTEM"
    )

    return jsonify(ok=True, user=user, redirect_url=url_for("home"))

@app.post("/api/auth/register")
def api_register():
    data = request.get_json(silent=True) or {}
    username = data.get("username", "")
    email = data.get("email", "")
    password = data.get("password", "")
    full_name = data.get("full_name", "")
    role = data.get("role", "operator")

    user, error = create_user(username, email, password, full_name, role)
    if error:
        return jsonify(ok=False, error=error), 400

    session["user_id"] = user["id"]
    session["role"] = user["role"]
    return jsonify(ok=True, user=user, redirect_url=url_for("home"))

@app.post("/api/auth/logout")
def api_logout():
    username = "User"
    if session.get("user_id"):
        u = get_user_by_id(session.get("user_id"))
        if u:
            username = u["username"]
    session.clear()
    alert_service.create_alert(
        title="User Logged Out",
        message=f"{username} signed out of IRIE Console.",
        severity="INFO",
        alert_type="SYSTEM"
    )
    return jsonify(ok=True, redirect_url=url_for("login"))

@app.get("/api/auth/me")
def api_me():
    if not session.get("user_id"):
        return jsonify(ok=False, error="Unauthenticated"), 401
    user = get_user_by_id(session.get("user_id"))
    return jsonify(ok=True, user=user)

# -----------------------------------------------------------------------------
# ROUTING & HAZARDS API
# -----------------------------------------------------------------------------

@app.post("/api/route")
@login_required
def api_route():
    data = request.get_json(silent=True) or {}
    start = data.get("start")
    end = data.get("end")
    active_hazards = data.get("hazards") if data.get("hazards") is not None else app.config.get("ROADGUARD_HAZARDS", [])
    if not active_hazards and app.config.get("ROADGUARD_HAZARDS"):
        active_hazards = app.config.get("ROADGUARD_HAZARDS", [])

    if not start or not end:
        return jsonify(ok=False, error="Please select both start and destination points on the map."), 400

    res = calculate_routes(start, end, active_hazards=active_hazards)
    if not res.get("ok"):
        return jsonify(ok=False, error=res.get("error", "Failed to calculate route.")), 502

    # Log route calculation to database
    try:
        conn = get_db()
        cursor = conn.cursor()
        primary = res["routes"][0]
        cursor.execute('''
            INSERT INTO routes_history (user_id, start_lat, start_lng, end_lat, end_lng, primary_distance_km, primary_duration_min, alternatives_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            session.get("user_id"),
            float(start["lat"]),
            float(start["lng"]),
            float(end["lat"]),
            float(end["lng"]),
            primary["distance_km"],
            primary["duration_min"],
            len(res["routes"]) - 1
        ))
        conn.commit()
        conn.close()
    except Exception:
        pass

    # Update telemetry simulation route if currently in simulation mode
    if res["routes"]:
        telemetry_service.set_active_route_for_simulation(res["routes"][0]["geometry"])

    return jsonify(
        ok=True,
        routes=res["routes"],
        total_alternatives=res.get("total_alternatives", 0),
        provider=res.get("provider"),
        traffic_live=res.get("traffic_live", False),
        note=res.get("note")
    )

@app.post("/api/route/reroute-request")
@login_required
def api_reroute_request():
    data = request.get_json(silent=True) or {}
    hazard = data.get("hazard") or {}
    affected_route = data.get("affected_route") or {}
    suggested_route = data.get("suggested_route") or {}
    mode = os.environ.get("REROUTE_MODE", "approval")

    req = alert_service.create_reroute_request(hazard, affected_route, suggested_route, mode=mode)
    return jsonify(ok=True, reroute_request=req, mode=mode)

@app.post("/api/route/reroute-decision")
@login_required
def api_reroute_decision():
    data = request.get_json(silent=True) or {}
    decision = data.get("decision", "reject") # 'accept' or 'reject'
    res = alert_service.resolve_reroute(decision)
    return jsonify(res)

# -----------------------------------------------------------------------------
# TELEMETRY & HARDWARE API
# -----------------------------------------------------------------------------

@app.get("/api/telemetry")
def api_telemetry():
    state = telemetry_service.get_state()
    state["serial_status"] = serial_service.get_status()
    return jsonify(ok=True, telemetry=state)

@app.get("/api/telemetry/stream")
def api_telemetry_stream():
    """Server-Sent Events (SSE) stream for live vehicle position and sensor updates."""
    def event_stream():
        q = telemetry_service.subscribe()
        try:
            # Yield initial state immediately
            initial_state = telemetry_service.get_state()
            initial_state["serial_status"] = serial_service.get_status()
            yield f"data: {json.dumps(initial_state)}\n\n"
            
            while True:
                state = q.get()
                state["serial_status"] = serial_service.get_status()
                yield f"data: {json.dumps(state)}\n\n"
        except GeneratorExit:
            telemetry_service.unsubscribe(q)
        except Exception:
            telemetry_service.unsubscribe(q)

    return Response(event_stream(), mimetype="text/event-stream")

@app.post("/api/telemetry/simulate")
@login_required
def api_simulate_telemetry():
    data = request.get_json(silent=True) or {}
    action = data.get("action")

    if action == "impact":
        g_force = float(data.get("g_force", 4.2))
        telemetry_service.trigger_simulated_impact(g_force)
        curr = telemetry_service.get_state()
        alert_service.create_alert(
            title="VEHICLE DAMAGE ALERT: Severe Impact Registered",
            message=f"Accelerometers recorded a violent deceleration spike of {g_force:.1f}G. Immediate vehicle inspection required.",
            severity="CRITICAL",
            alert_type="DAMAGE",
            lat=curr["lat"],
            lng=curr["lng"],
            force=True
        )
        return jsonify(ok=True, message=f"Simulated impact spike of {g_force:.1f}G registered.")

    elif action == "low_battery":
        volts = float(data.get("volts", 10.4))
        telemetry_service.trigger_simulated_low_battery(volts)
        curr = telemetry_service.get_state()
        alert_service.create_alert(
            title="LOW BATTERY WARNING",
            message=f"Battery pack voltage dropped below safety threshold ({volts:.1f}V / 12%). Return to charging dock.",
            severity="WARNING",
            alert_type="BATTERY",
            lat=curr["lat"],
            lng=curr["lng"],
            force=True
        )
        return jsonify(ok=True, message=f"Simulated low battery condition ({volts:.1f}V) triggered.")

    elif action == "reset":
        telemetry_service.reset_vehicle_health()
        alert_service.create_alert(
            title="Vehicle Health Reset",
            message="Vehicle diagnostics and sensor status manually restored to NORMAL.",
            severity="INFO",
            alert_type="SYSTEM"
        )
        return jsonify(ok=True, message="Vehicle health restored to Normal.")

    elif action == "toggle_movement":
        active = bool(data.get("active", True))
        telemetry_service.toggle_simulation(active)
        return jsonify(ok=True, active=active)

    return jsonify(ok=False, error="Invalid simulation action"), 400

@app.get("/api/hardware/ports")
@login_required
def api_hardware_ports():
    ports = serial_service.list_ports()
    status = serial_service.get_status()
    return jsonify(ok=True, ports=ports, status=status)

@app.post("/api/hardware/connect")
@login_required
def api_hardware_connect():
    data = request.get_json(silent=True) or {}
    port = data.get("port", "AUTO")
    baud = int(data.get("baud", 9600))
    res = serial_service.connect(port, baud)
    return jsonify(res)

@app.post("/api/hardware/disconnect")
@login_required
def api_hardware_disconnect():
    res = serial_service.disconnect()
    return jsonify(res)

# -----------------------------------------------------------------------------
# ALERTS & INCIDENTS API
# -----------------------------------------------------------------------------

@app.get("/api/alerts")
@login_required
def api_get_alerts():
    limit = int(request.args.get("limit", 40))
    alerts = alert_service.get_alerts(limit=limit)
    pending_reroute = alert_service.get_pending_reroute()
    return jsonify(ok=True, alerts=alerts, pending_reroute=pending_reroute)

@app.post("/api/alerts/resolve")
@login_required
def api_resolve_alert():
    data = request.get_json(silent=True) or {}
    alert_id = data.get("alert_id")
    if not alert_id:
        return jsonify(ok=False, error="Alert ID required"), 400
    alert_service.resolve_alert(int(alert_id))
    return jsonify(ok=True, message="Alert resolved.")

# -----------------------------------------------------------------------------
# SYSTEM SETTINGS & EXPORT
# -----------------------------------------------------------------------------

@app.get("/api/settings")
@login_required
def api_get_settings():
    return jsonify(
        ok=True,
        reroute_mode=os.environ.get("REROUTE_MODE", "approval"),
        max_impact_threshold_g=float(os.environ.get("MAX_IMPACT_THRESHOLD_G", 3.5)),
        low_battery_threshold_v=float(os.environ.get("LOW_BATTERY_THRESHOLD_V", 11.1)),
        serial_port=os.environ.get("SERIAL_PORT", "AUTO"),
        serial_baud=int(os.environ.get("SERIAL_BAUD_RATE", 9600)),
        has_google_key=bool(os.environ.get("GOOGLE_MAPS_API_KEY")),
        has_mapbox_key=bool(os.environ.get("MAPBOX_ACCESS_TOKEN"))
    )

@app.post("/api/settings")
@login_required
def api_update_settings():
    data = request.get_json(silent=True) or {}
    if "reroute_mode" in data:
        os.environ["REROUTE_MODE"] = str(data["reroute_mode"])
    return jsonify(ok=True, message="Settings updated successfully.")

@app.get("/api/status")
def api_status():
    return jsonify(
        ok=True,
        time=datetime.now().isoformat(timespec="seconds"),
        routing="IRIE Multi-Alternative Engine (OSRM + Dynamic Corridor)",
        hardware=serial_service.get_status(),
        telemetry_active=True
    )

@app.get("/api/export-project")
@login_required
def api_export_project():
    """Generates and downloads a clean ZIP archive of the complete IRIE project."""
    base_dir = os.path.dirname(os.path.abspath(__file__))
    zip_buffer = io.BytesIO()

    # Directories to exclude from export
    exclude_dirs = {'.venv', '__pycache__', '.git', '.idea', '.vscode'}
    exclude_extensions = {'.pyc', '.log'}

    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
        for root, dirs, files in os.walk(base_dir):
            dirs[:] = [d for d in dirs if d not in exclude_dirs]
            for file in files:
                if any(file.endswith(ext) for ext in exclude_extensions):
                    continue
                # Do not package active sqlite database or live .venv files
                if file.endswith('.db') or file == 'irie.db':
                    continue
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, base_dir)
                zip_file.write(full_path, arcname=os.path.join("IRIE_Arduino_Route_Planner", rel_path))

    zip_buffer.seek(0)
    return send_file(
        zip_buffer,
        mimetype="application/zip",
        as_attachment=True,
        download_name="IRIE_Arduino_Route_Planner_Complete.zip"
    )


# -----------------------------------------------------------------------------
# ROADGUARD REAL ROUTING / HAZARD API
# -----------------------------------------------------------------------------
@app.get("/api/config")
def api_config():
    """Only public browser configuration is returned. Never expose server API keys."""
    return jsonify(
        ok=True,
        map_engine="leaflet",
        google_maps_browser_key="",  # Leaflet map is the active, reliable engine
        google_maps_enabled=False,
        google_routes_enabled=bool(os.environ.get("GOOGLE_MAPS_SERVER_API_KEY") or os.environ.get("GOOGLE_MAPS_API_KEY")),
        routing_fallback="OSRM/OpenStreetMap",
        mode="Leaflet Interactive Perception & Obstacle Simulation"
    )

@app.post("/api/google/routes")
@login_required
def api_google_routes():
    data = request.get_json(silent=True) or {}
    start, end = data.get("start"), data.get("end")
    if not start or not end:
        return jsonify(ok=False, error="Origin and destination coordinates are required."), 400
    key = os.environ.get("GOOGLE_MAPS_SERVER_API_KEY") or os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key or key.startswith("531560"):
        return jsonify(ok=False, configured=False, error="Google Routes API server key is not configured. Falling back to Leaflet/OSRM routing."), 503
    try:
        origin = {"location": {"latLng": {"latitude": float(start["lat"]), "longitude": float(start["lng"])}}}
        destination = {"location": {"latLng": {"latitude": float(end["lat"]), "longitude": float(end["lng"])}}}
        payload = {"origin": origin, "destination": destination, "travelMode": "DRIVE",
                   "routingPreference": "TRAFFIC_AWARE_OPTIMAL", "computeAlternativeRoutes": True,
                   "polylineQuality": "HIGH_QUALITY", "languageCode": "en-IN", "units": "METRIC"}
        headers = {"Content-Type": "application/json", "X-Goog-Api-Key": key,
                   "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.description,routes.legs.steps.navigationInstruction.instructions"}
        response = requests.post("https://routes.googleapis.com/directions/v2:computeRoutes", json=payload, headers=headers, timeout=18)
        if response.status_code != 200:
            return jsonify(ok=False, error=f"Google Routes API returned HTTP {response.status_code}. Using Leaflet OSRM engine.", provider="Google Routes API"), 502
        body = response.json()
        result=[]
        for i, route in enumerate(body.get("routes", [])):
            duration_s = int(str(route.get("duration", "0s")).rstrip("s") or 0)
            static_s = int(str(route.get("staticDuration", "0s")).rstrip("s") or 0)
            result.append({"id": f"google-{i}", "provider":"Google Routes API", "summary": route.get("description") or ("Recommended route" if i == 0 else f"Alternative {i}"),
                          "distance_km": round(route.get("distanceMeters", 0)/1000, 2), "duration_min": round(duration_s/60),
                          "static_duration_min": round(static_s/60), "traffic_aware": True,
                          "encoded_polyline": route.get("polyline", {}).get("encodedPolyline", ""), "is_recommended": i == 0})
        if not result:
            return jsonify(ok=False, error="Google returned no route candidates."), 502
        return jsonify(ok=True, provider="Google Routes API", traffic_live=True, routes=result)
    except requests.RequestException:
        return jsonify(ok=False, error="Could not reach Google Routes API. Using OSRM fallback."), 502
    except (KeyError, TypeError, ValueError) as exc:
        return jsonify(ok=False, error=f"Invalid route request: {exc}"), 400

@app.get("/api/hazards")
def api_hazards_get():
    return jsonify(ok=True, hazards=app.config.setdefault("ROADGUARD_HAZARDS", []))

@app.post("/api/hazards")
@login_required
def api_hazards_post():
    data = request.get_json(silent=True) or {}
    try:
        lat, lng = float(data.get("lat")), float(data.get("lng"))
        if not (-90 <= lat <= 90 and -180 <= lng <= 180): raise ValueError()
    except (TypeError, ValueError):
        return jsonify(ok=False, error="Valid latitude and longitude are required."), 400

    allowed = {
        "Obstacle", "Pedestrian Moving", "Animal Crossing", "Construction Working", "Road Blocked",
        "Pothole", "Road crack", "Waterlogging", "Construction", "Barricade",
        "Road closure", "Accident", "Pedestrian", "Animal crossing", "Moving vehicle", "Other"
    }
    kind = data.get("type", "Obstacle")
    if kind not in allowed:
        kind = "Obstacle"

    severity = data.get("severity", "Medium")
    if severity not in {"Low", "Medium", "High", "Critical"}:
        severity = "Medium"
    if kind == "Road Blocked":
        severity = "Critical"
    elif kind == "Pedestrian Moving" and severity == "Low":
        severity = "High"

    hazard = {
        "id": f"h-{int(time.time()*1000)}",
        "lat": lat,
        "lng": lng,
        "type": kind,
        "severity": severity,
        "description": data.get("description") or f"{kind} active on corridor",
        "is_moving": bool(data.get("is_moving", kind == "Pedestrian Moving")),
        "speed_kmh": float(data.get("speed_kmh", 4.5 if kind == "Pedestrian Moving" else 0.0)),
        "heading": float(data.get("heading", 90.0)),
        "radius_m": float(data.get("radius_m", 120.0 if kind == "Construction Working" else (60.0 if kind == "Road Blocked" else 30.0))),
        "source": data.get("source", "User Report"),
        "verified": bool(data.get("verified", False)),
        "confidence": float(data.get("confidence", 0.96 if data.get("verified") else 0.75)),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "ACTIVE" if data.get("verified") else "UNVERIFIED"
    }
    app.config.setdefault("ROADGUARD_HAZARDS", []).insert(0, hazard)
    app.config["ROADGUARD_HAZARDS"] = app.config["ROADGUARD_HAZARDS"][:100]
    alert_service.create_alert(
        title=f"Perception Alert: {kind} Added",
        message=f"{hazard['description']} at {lat:.5f}, {lng:.5f}. Corridor safety evaluated.",
        severity=severity.upper(),
        alert_type="HAZARD",
        lat=lat,
        lng=lng
    )
    return jsonify(ok=True, hazard=hazard), 201

@app.route("/api/hazards/delete", methods=["GET", "POST"])
@login_required
def api_hazards_delete():
    data = request.get_json(silent=True) or {}
    hazard_id = data.get("id") or data.get("hazard_id") or request.args.get("id")
    if not hazard_id:
        return jsonify(ok=False, error="Hazard ID required."), 400
    hazards = app.config.setdefault("ROADGUARD_HAZARDS", [])
    app.config["ROADGUARD_HAZARDS"] = [h for h in hazards if h.get("id") != hazard_id]
    return jsonify(ok=True, message="Hazard removed successfully.")

@app.route("/api/hazards/clear", methods=["GET", "POST"])
@login_required
def api_hazards_clear_all():
    app.config["ROADGUARD_HAZARDS"] = []
    alert_service.create_alert(
        title="Hazards Cleared",
        message="All obstacles, pedestrians, and road blocks cleared by operator.",
        severity="INFO",
        alert_type="SYSTEM"
    )
    return jsonify(ok=True, message="All hazards cleared.")

@app.post("/api/hazards/clear-demo")
@login_required
def api_hazards_clear_demo():
    app.config["ROADGUARD_HAZARDS"] = [h for h in app.config.setdefault("ROADGUARD_HAZARDS", []) if h.get("source") != "Simulation"]
    return jsonify(ok=True)


if __name__ == "__main__":
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", 5000))
    app.run(host=host, port=port, debug=True)
