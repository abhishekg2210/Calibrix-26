import unittest
import os
import json
import app as roadguard_app


class AutonomousAPITests(unittest.TestCase):
    def setUp(self):
        roadguard_app.app.config['TESTING'] = True
        self.client = roadguard_app.app.test_client()
        self.client.post('/api/auth/login', json={
            'identifier': os.environ.get('DEMO_EMAIL', 'admin@irie.ai'),
            'password': os.environ.get('DEMO_PASSWORD', 'Admin@123')
        })

    def test_health_endpoint(self):
        res = self.client.get('/api/health')
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data['status'], 'healthy')
        self.assertIn('python_version', data['environment'])

    def test_ready_endpoint(self):
        res = self.client.get('/api/ready')
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data['ready'])
        self.assertIn('perception', data['services'])
        self.assertIn('planner', data['services'])

    def test_feature_matrix_endpoint(self):
        res = self.client.get('/api/autonomous/feature-matrix')
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data['ok'])
        self.assertGreater(len(data['working']), 0)
        self.assertGreater(len(data['simulated']), 0)
        self.assertGreater(len(data['not_configured']), 0)

    def test_detect_frame_endpoint(self):
        res = self.client.post('/api/autonomous/detect-frame', json={})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data['ok'])
        self.assertIn('detections', data)
        self.assertIn('tracked_objects', data)
        self.assertIn('risk_assessment', data)
        self.assertIn('path_plan', data)

    def test_simulink_model_spec_endpoint(self):
        res = self.client.get('/api/autonomous/simulink/model-spec')
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data['ok'])
        self.assertIn('parameters', data)

    def test_scenarios_list_and_run(self):
        res_list = self.client.get('/api/autonomous/scenarios')
        self.assertEqual(res_list.status_code, 200)
        scenarios = res_list.get_json()['scenarios']
        self.assertEqual(len(scenarios), 5)

        res_run = self.client.post('/api/autonomous/scenarios/run', json={'scenario_id': 'scenario_1'})
        self.assertEqual(res_run.status_code, 200)
        run_data = res_run.get_json()
        self.assertTrue(run_data['ok'])
        self.assertIn('timeline', run_data)
        self.assertIn('evaluation_metrics', run_data)

    def test_dataset_hardware_and_validate(self):
        hw = self.client.get('/api/autonomous/dataset/hardware').get_json()
        self.assertTrue(hw['ok'])
        self.assertIn('cuda_available', hw['hardware'])

        val = self.client.get('/api/autonomous/dataset/validate').get_json()
        self.assertTrue(val['ok'])
        self.assertIn('classes_defined', val)


if __name__ == '__main__':
    unittest.main()
