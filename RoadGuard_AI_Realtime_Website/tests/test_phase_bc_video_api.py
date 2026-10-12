"""
Automated Tests for Phase B (Backend Integration & Health) and Phase C (Video Analysis & YOLO Perception).
Tests both Flask and FastAPI backends, file upload validation, size limits,
codec verification, and real inference execution on a generated sample road video.
"""

import os
import io
import time
import tempfile
import unittest
import cv2
import numpy as np

# Flask application & test client
from app import app as flask_app
from services.perception_service import perception_service
from services.video_analysis_service import video_analysis_service, MAX_VIDEO_SIZE_BYTES

# FastAPI application & test client
from fastapi.testclient import TestClient
from fastapi_app import app as fastapi_app


def create_sample_road_video(output_path: str, num_frames: int = 15, width: int = 640, height: int = 480) -> str:
    """Creates a genuine, decodable MP4 video file with synthetic moving vehicles and pedestrians."""
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(output_path, fourcc, 20.0, (width, height))

    for i in range(num_frames):
        frame = np.zeros((height, width, 3), dtype=np.uint8)
        # Asphalt road surface
        cv2.rectangle(frame, (0, int(height * 0.4)), (width, height), (40, 40, 40), -1)
        # Moving vehicle (orange box)
        car_x = int(100 + i * 15)
        cv2.rectangle(frame, (car_x, 260), (car_x + 90, 360), (0, 140, 255), -1)
        # Moving pedestrian (green box)
        ped_x = int(500 - i * 6)
        cv2.rectangle(frame, (ped_x, 250), (ped_x + 30, 370), (0, 255, 0), -1)
        out.write(frame)

    out.release()
    return output_path


class PhaseBCVideoApiTests(unittest.TestCase):

    def setUp(self):
        self.flask_client = flask_app.test_client()
        self.fastapi_client = TestClient(fastapi_app)
        self.temp_dir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir, ignore_errors=True)

    # -------------------------------------------------------------------------
    # 1. HEALTH AND READINESS TESTS (PHASE B)
    # -------------------------------------------------------------------------

    def test_flask_health_endpoint(self):
        res = self.flask_client.get("/api/health")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "healthy")
        self.assertEqual(data["backend"], "Flask")
        self.assertIn("perception", data)
        self.assertIn("video_pipeline", data)
        self.assertIn("mp4", data["video_pipeline"]["allowed_formats"])

    def test_fastapi_health_endpoint(self):
        res = self.fastapi_client.get("/api/health")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "healthy")
        self.assertEqual(data["backend"], "FastAPI")
        self.assertIn("perception", data)
        self.assertTrue(data["perception"]["configured"])

    def test_perception_model_status_and_classes(self):
        status = perception_service.get_status()
        self.assertIn("configured", status)
        self.assertIn("model_type", status)
        self.assertIn("Vehicle", status["classes_supported"])
        self.assertIn("Pedestrian", status["classes_supported"])
        self.assertIn("Motorcycle/bicycle", status["classes_supported"])

    # -------------------------------------------------------------------------
    # 2. VIDEO UPLOAD VALIDATION TESTS (PHASE C)
    # -------------------------------------------------------------------------

    def test_upload_rejects_missing_file(self):
        res_flask = self.flask_client.post("/api/autonomous/upload-video", data={})
        self.assertEqual(res_flask.status_code, 400)
        self.assertFalse(res_flask.get_json()["ok"])

        res_fast = self.fastapi_client.post("/api/autonomous/upload-video")
        self.assertEqual(res_fast.status_code, 422)  # Missing multipart field

    def test_upload_rejects_disallowed_extension(self):
        fake_file = (io.BytesIO(b"malicious script contents"), "danger.exe")
        res = self.flask_client.post(
            "/api/autonomous/upload-video",
            data={"video": fake_file},
            content_type="multipart/form-data"
        )
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertIn("Invalid video format", data["error"])

    def test_upload_rejects_empty_file(self):
        empty_file = (io.BytesIO(b""), "empty_road.mp4")
        res = self.flask_client.post(
            "/api/autonomous/upload-video",
            data={"video": empty_file},
            content_type="multipart/form-data"
        )
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertIn("empty", data["error"].lower())

    def test_upload_rejects_corrupted_video_header(self):
        corrupt_file = (io.BytesIO(b"NOT_A_REAL_VIDEO_HEADER_JUST_RANDOM_BYTES"), "corrupt.mp4")
        res = self.flask_client.post(
            "/api/autonomous/upload-video",
            data={"video": corrupt_file},
            content_type="multipart/form-data"
        )
        self.assertEqual(res.status_code, 400)
        data = res.get_json()
        self.assertIn("decode", data["error"].lower())

    def test_upload_size_limit_validation(self):
        # Directly test validation service for oversized limit
        is_valid, err, code = video_analysis_service.validate_upload("large_road.mp4", file_size=60 * 1024 * 1024)
        self.assertFalse(is_valid)
        self.assertEqual(code, 413)
        self.assertIn("exceeds maximum allowed limit", err)

    # -------------------------------------------------------------------------
    # 3. END-TO-END VIDEO INFERENCE TEST (PHASE C)
    # -------------------------------------------------------------------------

    def test_end_to_end_video_upload_and_inference(self):
        # Create genuine test video
        video_path = os.path.join(self.temp_dir, "test_road_sample.mp4")
        create_sample_road_video(video_path, num_frames=12)
        self.assertTrue(os.path.exists(video_path))

        with open(video_path, "rb") as f:
            res = self.flask_client.post(
                "/api/autonomous/upload-video",
                data={"video": (f, "test_road_sample.mp4")},
                content_type="multipart/form-data"
            )

        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["ok"])
        job_id = data["job_id"]
        self.assertTrue(job_id.startswith("job_"))

        # Poll status until worker finishes (up to 10 seconds)
        completed = False
        final_job = None
        for _ in range(20):
            time.sleep(0.5)
            stat_res = self.flask_client.get(f"/api/autonomous/video-status/{job_id}")
            self.assertEqual(stat_res.status_code, 200)
            stat_data = stat_res.get_json()
            job = stat_data.get("job", {})
            if job.get("status") == "COMPLETED":
                completed = True
                final_job = job
                break

        self.assertTrue(completed, f"Job {job_id} did not complete in time.")
        self.assertEqual(final_job["progress_pct"], 100.0)
        self.assertGreater(final_job["analyzed_frames"], 0)
        self.assertIn("result", final_job)
        self.assertGreater(len(final_job["events"]), 0)

        # Check snapshot retrieval if generated
        if final_job.get("snapshots"):
            snap_file = final_job["snapshots"][0]
            snap_res = self.flask_client.get(f"/api/autonomous/video-snapshot/{job_id}/{snap_file}")
            self.assertEqual(snap_res.status_code, 200)
            self.assertEqual(snap_res.content_type, "image/jpeg")
            snap_res.close()

    # -------------------------------------------------------------------------
    # 4. SINGLE FRAME DETECTION TEST
    # -------------------------------------------------------------------------

    def test_detect_frame_endpoint(self):
        res = self.flask_client.post("/api/autonomous/detect-frame", json={})
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["ok"])
        self.assertIn("inference_latency_ms", data)
        self.assertIn("annotated_image_preview", data)
        self.assertTrue(data["annotated_image_preview"].startswith("data:image/jpeg;base64,"))


if __name__ == "__main__":
    unittest.main()
