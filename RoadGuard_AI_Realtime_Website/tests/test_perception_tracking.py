import unittest
import numpy as np
from services.perception_service import perception_service
from services.tracking_service import ObjectTracker, compute_iou


class PerceptionAndTrackingTests(unittest.TestCase):
    def test_class_taxonomy_and_mappings(self):
        self.assertIn("Vehicle", perception_service.TAXONOMY_INFO)
        self.assertIn("Motorcycle/bicycle", perception_service.TAXONOMY_INFO)
        self.assertIn("Pedestrian", perception_service.TAXONOMY_INFO)
        self.assertIn("Dog/cattle", perception_service.TAXONOMY_INFO)
        self.assertIn("Pothole", perception_service.TAXONOMY_INFO)
        self.assertIn("Construction barrier/road blockage", perception_service.TAXONOMY_INFO)

    def test_iou_computation(self):
        boxA = [100.0, 100.0, 200.0, 200.0]
        boxB = [100.0, 100.0, 200.0, 200.0]
        self.assertAlmostEqual(compute_iou(boxA, boxB), 1.0, places=3)

        boxC = [300.0, 300.0, 400.0, 400.0]
        self.assertAlmostEqual(compute_iou(boxA, boxC), 0.0, places=3)

    def test_tracker_id_persistence(self):
        tracker = ObjectTracker(iou_threshold=0.3)
        # Frame 1: Detection
        dets1 = [{"bbox": [50.0, 50.0, 100.0, 100.0], "class_name": "Vehicle", "confidence": 0.88}]
        tracks1 = tracker.update_tracks(dets1, timestamp=0.0)
        self.assertEqual(len(tracks1), 1)
        track_id = tracks1[0]["track_id"]

        # Frame 2: Slightly moved object with same class
        dets2 = [{"bbox": [54.0, 52.0, 104.0, 102.0], "class_name": "Vehicle", "confidence": 0.89}]
        tracks2 = tracker.update_tracks(dets2, timestamp=0.1)
        self.assertEqual(len(tracks2), 1)
        self.assertEqual(tracks2[0]["track_id"], track_id)
        self.assertEqual(tracks2[0]["age_frames"], 2)

    def test_no_motion_prediction_on_single_frame(self):
        tracker = ObjectTracker()
        dets = [{"bbox": [200.0, 200.0, 250.0, 300.0], "class_name": "Pedestrian", "confidence": 0.9}]
        tracks = tracker.update_tracks(dets, timestamp=0.0)
        # Rule: Do not treat single-frame object detection as motion prediction
        self.assertEqual(len(tracks[0]["predicted_trajectory"]), 0)

    def test_multi_step_prediction_after_temporal_observations(self):
        tracker = ObjectTracker()
        # Frame 1
        tracker.update_tracks([{"bbox": [100.0, 100.0, 150.0, 200.0], "class_name": "Pedestrian", "confidence": 0.9}], timestamp=0.0)
        # Frame 2 (moving rightward)
        tracks2 = tracker.update_tracks([{"bbox": [115.0, 100.0, 165.0, 200.0], "class_name": "Pedestrian", "confidence": 0.9}], timestamp=0.2)

        preds = tracks2[0]["predicted_trajectory"]
        self.assertGreater(len(preds), 0)
        # Verify rightward extrapolated velocity
        self.assertGreater(preds[0]["x"], tracks2[0]["centroid"]["x"])


if __name__ == '__main__':
    unittest.main()
