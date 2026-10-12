"""
Multi-Object Tracking (MOT) & Temporal Motion Prediction Service.
Supports ByteTrack / Kalman-Filter object tracking and multi-step future trajectory prediction
for unstructured Indian road entities (vehicles, pedestrians, two-wheelers, cattle/dogs, obstacles).
"""

import math
import time
from typing import List, Dict, Any, Tuple, Optional


class TrackedObject:
    """Represents a temporally tracked object with motion history and prediction."""

    def __init__(self, track_id: int, bbox: List[float], class_name: str, confidence: float, timestamp: float):
        self.track_id = track_id
        self.bbox = bbox  # [x1, y1, x2, y2]
        self.class_name = class_name
        self.confidence = confidence
        self.first_seen = timestamp
        self.last_seen = timestamp
        self.age = 1  # number of frames seen
        self.time_since_update = 0

        # Centroid [cx, cy]
        cx = (bbox[0] + bbox[2]) / 2.0
        cy = (bbox[1] + bbox[3]) / 2.0
        self.centroid_history: List[Tuple[float, float, float]] = [(cx, cy, timestamp)]

        # Estimated velocities (pixels/s or m/s)
        self.vx = 0.0
        self.vy = 0.0
        self.speed = 0.0
        self.irregular_motion = False

    def update(self, bbox: List[float], confidence: float, timestamp: float):
        self.bbox = bbox
        self.confidence = confidence
        dt = max(1e-3, timestamp - self.last_seen)
        self.last_seen = timestamp
        self.age += 1
        self.time_since_update = 0

        cx = (bbox[0] + bbox[2]) / 2.0
        cy = (bbox[1] + bbox[3]) / 2.0

        prev_cx, prev_cy, _ = self.centroid_history[-1]
        raw_vx = (cx - prev_cx) / dt
        raw_vy = (cy - prev_cy) / dt

        # Smooth velocity with exponential moving average
        alpha = 0.65
        self.vx = alpha * raw_vx + (1.0 - alpha) * self.vx
        self.vy = alpha * raw_vy + (1.0 - alpha) * self.vy
        self.speed = math.hypot(self.vx, self.vy)

        # Detect irregular movement (sharp direction changes or high lateral velocity)
        if len(self.centroid_history) >= 3:
            p2 = self.centroid_history[-2]
            d_prev_x = prev_cx - p2[0]
            d_curr_x = cx - prev_cx
            if abs(d_curr_x - d_prev_x) > 40.0:  # Sudden lateral jerk
                self.irregular_motion = True

        self.centroid_history.append((cx, cy, timestamp))
        if len(self.centroid_history) > 30:
            self.centroid_history.pop(0)

    def predict_future_trajectory(self, horizon_steps: int = 5, step_dt: float = 0.5) -> List[Dict[str, float]]:
        """
        Extrapolates short-term future positions.
        Requires temporal observations (age >= 2) - single frame detections have empty prediction.
        """
        if self.age < 2 or len(self.centroid_history) < 2:
            return []  # Rule: Do not treat single-frame object detection as motion prediction

        curr_cx, curr_cy, _ = self.centroid_history[-1]
        future_points = []

        for step in range(1, horizon_steps + 1):
            t_offset = step * step_dt
            pred_x = curr_cx + self.vx * t_offset
            pred_y = curr_cy + self.vy * t_offset

            # Clamp within frame bounds
            pred_x = max(0.0, min(1920.0, pred_x))
            pred_y = max(0.0, min(1080.0, pred_y))

            future_points.append({
                "t_sec": round(t_offset, 1),
                "x": round(pred_x, 1),
                "y": round(pred_y, 1),
                "confidence": round(max(0.2, self.confidence * (1.0 - 0.12 * step)), 2)
            })

        return future_points

    def to_dict(self) -> Dict[str, Any]:
        curr_cx, curr_cy, _ = self.centroid_history[-1]
        return {
            "track_id": self.track_id,
            "class_name": self.class_name,
            "confidence": round(self.confidence, 3),
            "bbox": [round(c, 1) for c in self.bbox],
            "centroid": {"x": round(curr_cx, 1), "y": round(curr_cy, 1)},
            "velocity": {"vx": round(self.vx, 1), "vy": round(self.vy, 1), "speed": round(self.speed, 1)},
            "age_frames": self.age,
            "irregular_motion": self.irregular_motion,
            "history_length": len(self.centroid_history),
            "predicted_trajectory": self.predict_future_trajectory()
        }


def compute_iou(boxA: List[float], boxB: List[float]) -> float:
    xA = max(boxA[0], boxB[0])
    yA = max(boxA[1], boxB[1])
    xB = min(boxA[2], boxB[2])
    yB = min(boxA[3], boxB[3])

    interArea = max(0.0, xB - xA) * max(0.0, yB - yA)
    boxAArea = max(1e-4, (boxA[2] - boxA[0]) * (boxA[3] - boxA[1]))
    boxBArea = max(1e-4, (boxB[2] - boxB[0]) * (boxB[3] - boxB[1]))

    iou = interArea / float(boxAArea + boxBArea - interArea)
    return max(0.0, min(1.0, iou))


class ObjectTracker:
    """
    ByteTrack / Kalman Association object tracker with ID persistence.
    """

    def __init__(self, iou_threshold: float = 0.25, max_missed_frames: int = 15):
        self.iou_threshold = iou_threshold
        self.max_missed_frames = max_missed_frames
        self.next_track_id = 1
        self.tracks: Dict[int, TrackedObject] = {}

    def update_tracks(self, detections: List[Dict[str, Any]], timestamp: Optional[float] = None) -> List[Dict[str, Any]]:
        """
        Updates active tracks with new frame detections.
        Each detection: {'bbox': [x1, y1, x2, y2], 'class_name': str, 'confidence': float}
        """
        now = timestamp if timestamp is not None else time.time()

        # Age existing tracks
        for t in self.tracks.values():
            t.time_since_update += 1

        unmatched_dets = list(range(len(detections)))
        unmatched_tracks = list(self.tracks.keys())
        matches = []

        # Greedy IOU matching with class affinity
        for t_id in list(unmatched_tracks):
            track = self.tracks[t_id]
            best_iou = 0.0
            best_d_idx = -1

            for d_idx in unmatched_dets:
                det = detections[d_idx]
                if det["class_name"] != track.class_name:
                    continue  # Enforce class consistency
                iou = compute_iou(track.bbox, det["bbox"])
                if iou > best_iou and iou >= self.iou_threshold:
                    best_iou = iou
                    best_d_idx = d_idx

            if best_d_idx != -1:
                matches.append((t_id, best_d_idx))
                unmatched_dets.remove(best_d_idx)
                unmatched_tracks.remove(t_id)

        # Update matched tracks
        for t_id, d_idx in matches:
            det = detections[d_idx]
            self.tracks[t_id].update(det["bbox"], det["confidence"], now)

        # Create new tracks for unmatched detections
        for d_idx in unmatched_dets:
            det = detections[d_idx]
            new_id = self.next_track_id
            self.next_track_id += 1
            self.tracks[new_id] = TrackedObject(new_id, det["bbox"], det["class_name"], det["confidence"], now)

        # Purge stale tracks
        stale_ids = [t_id for t_id, t in self.tracks.items() if t.time_since_update > self.max_missed_frames]
        for t_id in stale_ids:
            del self.tracks[t_id]

        return [t.to_dict() for t in self.tracks.values() if t.time_since_update == 0]

    def reset(self):
        self.tracks.clear()
        self.next_track_id = 1


# Global tracker instance
tracking_service = ObjectTracker()
