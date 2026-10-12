import unittest
import os
import json
from app import app as flask_app
from services.mathworks_service import mathworks_service
from services.video_analysis_service import video_analysis_service
from services.dataset_service import dataset_service


class TestMultiCamMathWorksPerception(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = flask_app.test_client()

    def test_mathworks_service_scan(self):
        """MathWorks service must scan environment honestly without claiming uninstalled toolboxes."""
        status = mathworks_service.scan_environment(force_refresh=True)
        self.assertTrue(status["ok"])
        self.assertIn("matlab_detected", status)
        self.assertIn("toolboxes", status)
        self.assertIn("co_simulation_bridge", status)

        # Check all 7 required toolboxes are tracked
        toolboxes = status["toolboxes"]
        self.assertEqual(len(toolboxes), 7)
        tb_ids = [tb["id"] for tb in toolboxes]
        self.assertIn("automated_driving_toolbox", tb_ids)
        self.assertIn("navigation_toolbox", tb_ids)
        self.assertIn("roadrunner", tb_ids)
        self.assertIn("simulink", tb_ids)
        self.assertIn("vehicle_dynamics_blockset", tb_ids)
        self.assertIn("deep_learning_toolbox", tb_ids)
        self.assertIn("bicycle_model", tb_ids)

        for tb in toolboxes:
            self.assertIn("status", tb)
            self.assertIn("is_ready", tb)
            self.assertIn("setup_guide", tb)

    def test_video_listing(self):
        """list_available_videos returns metadata for uploaded videos."""
        videos = video_analysis_service.list_available_videos()
        self.assertIsInstance(videos, list)
        if len(videos) > 0:
            v0 = videos[0]
            self.assertIn("filename", v0)
            self.assertIn("resolution", v0)
            self.assertIn("fps", v0)
            self.assertIn("duration_seconds", v0)

    def test_camera_sources_registry(self):
        """Camera sources registry supports front, rear, left, right."""
        res = video_analysis_service.get_camera_sources()
        self.assertTrue(res["ok"])
        cams = res["cameras"]
        self.assertIn("front", cams)
        self.assertIn("rear", cams)
        self.assertIn("left", cams)
        self.assertIn("right", cams)

        # Invalid camera ID handling
        err_res = video_analysis_service.set_camera_source("invalid_cam", "test.mp4")
        self.assertFalse(err_res["ok"])

    def test_api_mathworks_status(self):
        """GET /api/autonomous/mathworks/status returns genuine status."""
        resp = self.client.get("/api/autonomous/mathworks/status")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data["ok"])
        self.assertIn("toolboxes", data)

    def test_api_cameras(self):
        """GET /api/autonomous/cameras returns all 4 cameras."""
        resp = self.client.get("/api/autonomous/cameras")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data["ok"])
        self.assertEqual(len(data["cameras"]), 4)

    def test_api_videos(self):
        """GET /api/autonomous/videos lists road videos."""
        resp = self.client.get("/api/autonomous/videos")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data["ok"])
        self.assertIsInstance(data["videos"], list)

    def test_api_analyze_video_existing(self):
        """POST /api/autonomous/analyze-video with existing video returns job."""
        videos = video_analysis_service.list_available_videos()
        if videos:
            vname = videos[0]["filename"]
            resp = self.client.post("/api/autonomous/analyze-video",
                                    data=json.dumps({"filename": vname}),
                                    content_type="application/json")
            self.assertEqual(resp.status_code, 200)
            data = resp.get_json()
            self.assertTrue(data["ok"])
            self.assertIn("job_id", data)

    def test_honest_accuracy_reporting(self):
        """dataset_service does not fabricate accuracy when ground truth is absent."""
        videos = video_analysis_service.list_available_videos()
        if videos:
            vname = videos[0]["filename"]
            eval_res = dataset_service.evaluate_video_or_dataset(vname)
            self.assertTrue(eval_res["ok"])
            accuracy_metrics = eval_res["accuracy_metrics"]
            self.assertIn("Unavailable", accuracy_metrics["mAP50"])
            self.assertIn("Unavailable", accuracy_metrics["precision"])
            self.assertIn("Unavailable", accuracy_metrics["recall"])
            self.assertIn("Unavailable", accuracy_metrics["f1_score"])


if __name__ == "__main__":
    unittest.main()
