# RoadGuard AI — Real-Time Adaptive Navigation Prototype

RoadGuard AI is a software-first web application for traffic-aware route planning, route comparison, user-reported road hazards, browser GPS tracking, and optional Arduino telemetry. It preserves the original IRIE Flask services and replaces the previous dashboard with a responsive navigation console.

> **Important safety and data note:** This is a research/demo navigation prototype, not certified autonomous-driving software. Google Maps does not automatically detect every pothole, animal, pedestrian, or construction barrier. Hazards in this application are user-reported and unverified unless a separately configured source verifies them. Camera/LiDAR/radar panels are virtual demo status only. No physical vehicle is controlled by the demo drive.

## Features

- Responsive dark RoadGuard AI dashboard.
- Interactive map: Google Maps JavaScript API when configured; otherwise OpenStreetMap tiles through Leaflet.
- Origin/destination coordinate selection and location geocoding; Google Places autocomplete when the Google browser key is configured.
- Google Routes API server integration for traffic-aware route candidates and available alternatives when configured.
- OSRM/OpenStreetMap routing fallback when Google Routes is not configured; fallback ETAs are **not live traffic ETAs**.
- Selectable route polylines, distance/time cards, and hazard proximity review.
- User-submitted hazard reports with coordinates, severity, source, timestamp, confidence, and an explicit unverified status.
- Approval-mode alternative selection and automatic-mode route selection when a candidate alternative avoids known reported hazard points.
- Browser geolocation tracking with permission and a separately labelled simulated route playback mode.
- Existing Flask authentication, telemetry endpoints, SQLite data, serial/Arduino support, vehicle health alerts, and firmware retained where present.
- `.env.example`, tests, and setup guidance.

## Requirements

- Python 3.10+
- Modern browser
- Internet access for CDN assets and external map/routing services
- Optional Google Maps Platform project and API keys for genuine Google Maps, Places, traffic layer, and Google Routes API
- Optional Arduino hardware and USB serial driver for hardware telemetry

## Windows PowerShell quick start

```powershell
cd RoadGuard_AI_Realtime_Website
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `.env` and set a strong `SECRET_KEY`. Then run:

```powershell
python app.py
```

Open `http://127.0.0.1:5000`.

The inherited login system seeds a demo account on a fresh database. The default values are `admin@irie.ai` / `Admin@123` unless you override `DEMO_EMAIL` and `DEMO_PASSWORD` in `.env`. Change these credentials for any shared deployment. The generated archive does not include a `.env` file or API credentials.

## Google Maps Platform setup

Google Maps is optional so the app can start without credentials. To activate the real Google map and traffic layer:

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Maps JavaScript API** and **Places API** for the browser map and autocomplete.
3. Enable **Routes API** for route calculations.
4. Configure billing as required by Google Maps Platform.
5. Create a browser key restricted by HTTP referrer and only the APIs required for browser use. Set it as `GOOGLE_MAPS_BROWSER_KEY`.
6. Create a separate server key restricted to Routes API and appropriate server usage. Set it as `GOOGLE_MAPS_SERVER_API_KEY`.
7. Add localhost referrer restrictions for local development and your real domain for deployment.
8. Restart Flask after changing `.env`.

Example `.env` entries:

```ini
SECRET_KEY=replace-with-a-long-random-secret
GOOGLE_MAPS_BROWSER_KEY=your_browser_restricted_key
GOOGLE_MAPS_SERVER_API_KEY=your_server_restricted_key
```

Never commit `.env`, expose the server key to frontend code, or use an unrestricted key. The frontend receives only the browser key. The backend uses `GOOGLE_MAPS_SERVER_API_KEY` (or the legacy `GOOGLE_MAPS_API_KEY`) to call `https://routes.googleapis.com/directions/v2:computeRoutes` with a field mask and `TRAFFIC_AWARE_OPTIMAL` preference. Google traffic-aware values are displayed only when the API returns them.

If the Google browser key is absent or invalid, the interface falls back to OpenStreetMap. If the server Routes key is missing, route calculations use the existing OSRM/OpenStreetMap routing service. The fallback does not provide Google live traffic data and can be rate-limited or unavailable.

## How to use

1. Sign in to the local application.
2. Enter an origin and destination. When Google Places is configured, choose suggestions; otherwise use a location name or coordinate pair (`latitude, longitude`). You can also click the map to set points.
3. Select **Calculate routes**. Google Routes is preferred when configured; otherwise the OSRM fallback is used.
4. Select a route card to change the highlighted route.
5. Use **Start GPS** to request browser location permission. GPS is not silently accessed.
6. Use **Demo drive** only after calculating a route. It moves a simulated marker along the selected route and never controls a physical car.
7. Use **Report** to submit a hazard at the entered coordinates or current location. Reports are stored as unverified and are not automatically treated as official closures.
8. Hazard proximity is compared against the sampled route geometry. If an alternative candidate avoids known report locations, the UI can offer a manual route switch or select it in automatic mode. This is a prototype heuristic, not a guarantee of safety.

## Backend endpoints

- `GET /api/config` — public configuration flags; never returns server credentials.
- `POST /api/google/routes` — calls Google Routes API when server key is configured.
- `POST /api/route` — existing route service fallback and route history logging.
- `GET /api/hazards` / `POST /api/hazards` — session hazard feed and user reports.
- `GET /api/telemetry` and `GET /api/telemetry/stream` — existing telemetry state and SSE stream.
- Existing authentication, alerts, serial and telemetry endpoints remain available.

## Tests

```powershell
python -m unittest discover -s tests -v
```

The test suite verifies inherited authentication, route service behaviors, telemetry parsing, alert handling, project export, and the added configuration/hazard endpoints where covered. Live Google API integration tests require valid configured keys and should be performed separately; automated tests do not claim to verify a real Google account or traffic response without those credentials.

## Arduino telemetry (optional)

The original `arduino/irie_telemetry_firmware.ino` and serial service are retained. Review the firmware and wiring comments before connecting hardware. Configure `SERIAL_PORT` (for example `COM3`) and `SERIAL_BAUD_RATE` in `.env`. USB serial, GPS, and sensors are not required for software-only operation.

## Project structure

```text
RoadGuard_AI_Realtime_Website/
├── app.py
├── database.py
├── requirements.txt
├── .env.example
├── README.md
├── arduino/irie_telemetry_firmware.ino
├── services/                  # routing, telemetry, serial, auth, alerts
├── static/app.js              # map provider, routes, hazards, GPS, demo drive
├── static/style.css           # responsive RoadGuard AI dashboard
├── templates/index.html       # main application
├── templates/login.html
├── templates/register.html
└── tests/
```

## Known limitations

- Google Maps and Routes API require the user's own keys, billing setup, enabled APIs, and correct key restrictions. No API key is included.
- Without Google keys, the map/routing fallback depends on OpenStreetMap/OSRM public services and internet access.
- Public OSRM routing may return a limited number of alternatives and is not a live traffic service.
- Hazard reports are stored in application memory for the current server process in this version; they are not a verified public crowdsourced feed and may reset after restart.
- Route/hazard proximity uses sampled route points and a configurable distance threshold; it is not a certified road-closure avoidance system.
- No live external hazard feed, trained camera perception model, real LiDAR/radar input, or vehicle actuator control is bundled.
- Browser GPS requires HTTPS in deployed environments (localhost is generally treated as a secure context) and explicit permission.
- This app is a decision-support/research prototype. A human driver must follow road rules, signage, and actual conditions.

## Security before deployment

- Replace the demo password and set a high-entropy `SECRET_KEY`.
- Use HTTPS, secure cookies, CSRF protections for state-changing browser endpoints, request limits, and a persistent database appropriate for deployment.
- Restrict browser and server API keys and rotate any credential that was ever committed.
- Do not expose the debug server to the public internet. Deploy behind a production WSGI server and reverse proxy.
