import unittest
import json
import os
import zipfile
import io
import time

# Ensure test uses test environment
os.environ["SECRET_KEY"] = "test_secret_key_12345"
os.environ["DEMO_EMAIL"] = "admin@irie.ai"
os.environ["DEMO_PASSWORD"] = "Admin@123"

from app import app
from database import init_db, get_db
from services.serial_service import serial_service
from services.routing_service import calculate_routes

class IrieComprehensiveTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    def setUp(self):
        self.client = app.test_client()

    # -------------------------------------------------------------------------
    # Acceptance Test A: Unauthenticated Protection
    # -------------------------------------------------------------------------
    def test_unauthenticated_user_redirected(self):
        res = self.client.get('/')
        self.assertEqual(res.status_code, 302)
        self.assertIn('/login', res.headers.get('Location', ''))

    def test_unauthenticated_api_rejected(self):
        res = self.client.get('/api/alerts')
        self.assertEqual(res.status_code, 401)
        data = res.get_json()
        self.assertFalse(data['ok'])
        self.assertIn('Authentication required', data['error'])

    # -------------------------------------------------------------------------
    # Acceptance Test B: Login & Logout Flow
    # -------------------------------------------------------------------------
    def test_login_success_and_logout(self):
        # 1. Login with correct credentials
        res = self.client.post('/api/auth/login', json={
            'identifier': 'admin@irie.ai',
            'password': 'Admin@123'
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data['ok'])
        self.assertEqual(data['user']['email'], 'admin@irie.ai')

        # 2. Access protected route with active session
        res_dash = self.client.get('/')
        self.assertEqual(res_dash.status_code, 200)
        self.assertIn(b'IRIE', res_dash.data)

        # 3. Logout
        res_logout = self.client.post('/api/auth/logout')
        self.assertEqual(res_logout.status_code, 200)

        # 4. Verify access is revoked
        res_after = self.client.get('/')
        self.assertEqual(res_after.status_code, 302)

    def test_login_invalid_credentials(self):
        res = self.client.post('/api/auth/login', json={
            'identifier': 'admin@irie.ai',
            'password': 'WrongPassword999'
        })
        self.assertEqual(res.status_code, 401)
        data = res.get_json()
        self.assertFalse(data['ok'])

    # -------------------------------------------------------------------------
    # Acceptance Test C: User Registration
    # -------------------------------------------------------------------------
    def test_user_registration(self):
        test_user = f"tester_{time.time_ns()}"
        res = self.client.post('/api/auth/register', json={
            'username': test_user,
            'email': f"{test_user}@irie.ai",
            'password': 'TestPassword123',
            'full_name': 'Test Researcher',
            'role': 'operator'
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data['ok'])
        self.assertEqual(data['user']['username'], test_user)

    # -------------------------------------------------------------------------
    # Acceptance Test D & E: Route Calculation & Multi-Alternatives
    # -------------------------------------------------------------------------
    def test_route_calculation_with_multiple_alternatives(self):
        # Authenticate first
        self.client.post('/api/auth/login', json={
            'identifier': 'admin@irie.ai',
            'password': 'Admin@123'
        })

        # Coimbatore to Sulur corridor
        start = {'lat': 11.016844, 'lng': 76.955833}
        end = {'lat': 11.025000, 'lng': 76.980000}

        res = self.client.post('/api/route', json={'start': start, 'end': end})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data['ok'])
        self.assertGreaterEqual(len(data['routes']), 1)
        primary = data['routes'][0]
        self.assertIn('distance_km', primary)
        self.assertIn('duration_min', primary)
        self.assertIn('geometry', primary)
        self.assertTrue(primary['is_recommended'])

    def test_route_missing_coordinates_validation(self):
        self.client.post('/api/auth/login', json={
            'identifier': 'admin@irie.ai',
            'password': 'Admin@123'
        })
        res = self.client.post('/api/route', json={'start': None, 'end': None})
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertFalse(data['ok'])

    # -------------------------------------------------------------------------
    # Acceptance Test F & G: Vehicle Health & Sensor Damage Alerts
    # -------------------------------------------------------------------------
    def test_vehicle_damage_simulation_and_alert_generation(self):
        self.client.post('/api/auth/login', json={
            'identifier': 'admin@irie.ai',
            'password': 'Admin@123'
        })

        # 1. Trigger severe impact (4.2G)
        res_sim = self.client.post('/api/telemetry/simulate', json={
            'action': 'impact',
            'g_force': 4.2
        })
        self.assertEqual(res_sim.status_code, 200)

        # 2. Check telemetry state
        res_tel = self.client.get('/api/telemetry')
        t = res_tel.get_json()['telemetry']
        self.assertEqual(t['vehicle_health'], 'DAMAGED')
        self.assertGreaterEqual(t['vibration_g'], 4.0)

        # 3. Check that an alert was logged in the alerts database
        res_alerts = self.client.get('/api/alerts')
        alerts = res_alerts.get_json()['alerts']
        self.assertTrue(any(a['severity'] == 'CRITICAL' and 'Impact' in a['title'] for a in alerts))

        # 4. Reset health to normal
        res_reset = self.client.post('/api/telemetry/simulate', json={'action': 'reset'})
        self.assertEqual(res_reset.status_code, 200)
        t_after = self.client.get('/api/telemetry').get_json()['telemetry']
        self.assertEqual(t_after['vehicle_health'], 'NORMAL')

    def test_low_battery_alert(self):
        self.client.post('/api/auth/login', json={
            'identifier': 'admin@irie.ai',
            'password': 'Admin@123'
        })

        res_sim = self.client.post('/api/telemetry/simulate', json={
            'action': 'low_battery',
            'volts': 10.3
        })
        self.assertEqual(res_sim.status_code, 200)

        t = self.client.get('/api/telemetry').get_json()['telemetry']
        self.assertEqual(t['vehicle_health'], 'WARNING')

    # -------------------------------------------------------------------------
    # Acceptance Test H & I: Serial Telemetry Message Parsing
    # -------------------------------------------------------------------------
    def test_serial_telemetry_json_parsing(self):
        raw_json = '{"lat":11.018,"lng":76.960,"spd":32.5,"hdg":90.0,"bat":12.2,"vib":0.4,"tilt":2.0}'
        parsed = serial_service._parse_telemetry_line(raw_json)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed['lat'], 11.018)
        self.assertEqual(parsed['lng'], 76.960)
        self.assertEqual(parsed['speed'], 32.5)

    def test_serial_telemetry_csv_parsing(self):
        raw_csv = '$IRIE,11.018,76.960,32.5,90.0,12.2,0.4,2.0'
        parsed = serial_service._parse_telemetry_line(raw_csv)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed['lat'], 11.018)
        self.assertEqual(parsed['lng'], 76.960)
        self.assertEqual(parsed['speed'], 32.5)

    # -------------------------------------------------------------------------
    # Acceptance Test J: Rerouting Request & Decision Flow
    # -------------------------------------------------------------------------
    def test_reroute_request_and_decision(self):
        self.client.post('/api/auth/login', json={
            'identifier': 'admin@irie.ai',
            'password': 'Admin@123'
        })

        hazard = {'title': 'Flooded Road', 'lat': 11.017, 'lng': 76.956}
        affected = {'id': 1, 'name': 'Route 1: NH Highway', 'duration_min': 15.0}
        suggested = {'id': 2, 'name': 'Route 2: Ring Road', 'duration_min': 17.5}

        # 1. Create reroute request
        res_req = self.client.post('/api/route/reroute-request', json={
            'hazard': hazard,
            'affected_route': affected,
            'suggested_route': suggested
        })
        self.assertEqual(res_req.status_code, 200)

        # 2. Resolve decision (Accept)
        res_dec = self.client.post('/api/route/reroute-decision', json={'decision': 'accept'})
        self.assertEqual(res_dec.status_code, 200)
        data = res_dec.get_json()
        self.assertTrue(data['ok'])
        self.assertEqual(data['action'], 'accepted')
        self.assertEqual(data['route_id'], 2)

    # -------------------------------------------------------------------------
    # Acceptance Test K: Project Export (.ZIP Archive)
    # -------------------------------------------------------------------------
    def test_project_zip_export(self):
        self.client.post('/api/auth/login', json={
            'identifier': 'admin@irie.ai',
            'password': 'Admin@123'
        })

        res = self.client.get('/api/export-project')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.content_type, 'application/zip')
        
        # Verify valid zip
        zip_buf = io.BytesIO(res.data)
        with zipfile.ZipFile(zip_buf, 'r') as z:
            names = z.namelist()
            self.assertTrue(any('app.py' in n for n in names))
            self.assertTrue(any('README.md' in n for n in names))

    # -------------------------------------------------------------------------
    # Acceptance Test L: Leaflet Interactive Hazards & Entity Management
    # -------------------------------------------------------------------------
    def test_leaflet_interactive_hazard_types_and_lifecycle(self):
        self.client.post('/api/auth/login', json={
            'identifier': 'admin@irie.ai',
            'password': 'Admin@123'
        })

        # Test adding Obstacle
        res1 = self.client.post('/api/hazards', json={
            'type': 'Obstacle',
            'lat': 11.0168,
            'lng': 76.9558,
            'severity': 'Medium'
        })
        self.assertEqual(res1.status_code, 201)
        h1 = res1.get_json()['hazard']
        self.assertEqual(h1['type'], 'Obstacle')

        # Test adding Pedestrian Moving
        res2 = self.client.post('/api/hazards', json={
            'type': 'Pedestrian Moving',
            'lat': 11.0180,
            'lng': 76.9600,
            'severity': 'High',
            'is_moving': True
        })
        self.assertEqual(res2.status_code, 201)
        h2 = res2.get_json()['hazard']
        self.assertEqual(h2['type'], 'Pedestrian Moving')
        self.assertTrue(h2['is_moving'])

        # Test adding Construction Working
        res3 = self.client.post('/api/hazards', json={
            'type': 'Construction Working',
            'lat': 11.0200,
            'lng': 76.9650,
            'severity': 'Medium'
        })
        self.assertEqual(res3.status_code, 201)
        h3 = res3.get_json()['hazard']
        self.assertEqual(h3['type'], 'Construction Working')

        # Test adding Road Blocked
        res4 = self.client.post('/api/hazards', json={
            'type': 'Road Blocked',
            'lat': 11.0220,
            'lng': 76.9700
        })
        self.assertEqual(res4.status_code, 201)
        h4 = res4.get_json()['hazard']
        self.assertEqual(h4['type'], 'Road Blocked')
        self.assertEqual(h4['severity'], 'Critical')

        # Test deleting a hazard
        res_del = self.client.post('/api/hazards/delete', json={'id': h1['id']})
        self.assertEqual(res_del.status_code, 200)

        # Verify deletion reflected in get
        res_get = self.client.get('/api/hazards')
        hazards = res_get.get_json()['hazards']
        self.assertFalse(any(h['id'] == h1['id'] for h in hazards))

        # Test clearing all hazards
        res_clear = self.client.post('/api/hazards/clear')
        self.assertEqual(res_clear.status_code, 200)
        res_get_after = self.client.get('/api/hazards')
        self.assertEqual(len(res_get_after.get_json()['hazards']), 0)

if __name__ == '__main__':
    unittest.main()
