import unittest
import os

# Importing app initializes the local SQLite demo database, matching project behavior.
import app as roadguard_app

class RoadGuardExtensionTests(unittest.TestCase):
    def setUp(self):
        roadguard_app.app.config['TESTING'] = True
        self.client = roadguard_app.app.test_client()
        self.client.post('/api/auth/login', json={'identifier': os.environ.get('DEMO_EMAIL','admin@irie.ai'), 'password': os.environ.get('DEMO_PASSWORD','Admin@123')})

    def test_public_config_never_exposes_server_key(self):
        response = self.client.get('/api/config')
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertIn('google_maps_enabled', body)
        self.assertNotIn('google_maps_server_key', body)
        self.assertNotIn('GOOGLE_MAPS_SERVER_API_KEY', body)

    def test_hazard_report_validation(self):
        response = self.client.post('/api/hazards', json={'lat': 200, 'lng': 10, 'type': 'Pothole'})
        self.assertEqual(response.status_code, 400)

    def test_hazard_report_saved_as_unverified(self):
        response = self.client.post('/api/hazards', json={'lat': 11.0168, 'lng': 76.9558, 'type': 'Animal crossing', 'severity': 'High'})
        self.assertEqual(response.status_code, 201)
        hazard = response.get_json()['hazard']
        self.assertFalse(hazard['verified'])
        self.assertEqual(hazard['status'], 'UNVERIFIED')

    def test_google_routes_requires_key_or_returns_api_response(self):
        response = self.client.post('/api/google/routes', json={'start': {'lat': 11.0, 'lng': 76.9}, 'end': {'lat': 11.1, 'lng': 77.0}})
        self.assertIn(response.status_code, (200, 502, 503))
        self.assertIn('ok', response.get_json())

if __name__ == '__main__':
    unittest.main()
