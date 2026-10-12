"""
AI Perception & Object Detection Service for Unstructured Indian Roads.
Supports pre-trained YOLO (Ultralytics), OpenCV Computer Vision baseline,
and an extensible configuration for Indian road classes:
- Vehicle (Cars, Trucks, Buses, Auto-rickshaws)
- Motorcycle/bicycle (Two-wheelers, Scooters, Bicycles)
- Pedestrian (People, Crossing Pedestrians)
- Dog/cattle (Stray dogs, Cows, Buffaloes)
- Pothole (Road surface craters, depressions) [Custom Class]
- Construction barrier/road blockage [Custom Class]
"""

import os
import time
import math
from typing import List, Dict, Any, Tuple, Optional
import cv2
import numpy as np


class IndianRoadPerceptionEngine:
    """
    Modular Perception Engine with clear status indicators, error handling,
    and extensible Indian Road taxonomy.
    """

    CLASS_MAPPINGS = {
        # COCO mapped classes
        "person": "Pedestrian",
        "car": "Vehicle",
        "truck": "Vehicle",
        "bus": "Vehicle",
        "motorcycle": "Motorcycle/bicycle",
        "bicycle": "Motorcycle/bicycle",
        "dog": "Dog/cattle",
        "cow": "Dog/cattle",
        "horse": "Dog/cattle",
        "sheep": "Dog/cattle",
        # Custom classes supported by Indian Roads fine-tuned models
        "pothole": "Pothole",
        "barrier": "Construction barrier/road blockage",
        "barricade": "Construction barrier/road blockage",
        "autorickshaw": "Vehicle"
    }

    TAXONOMY_INFO = {
        "Vehicle": {"color": (0, 165, 255), "category": "Core Transport", "source": "COCO Pre-trained / Fine-tuned"},
        "Motorcycle/bicycle": {"color": (255, 191, 0), "category": "Vulnerable Road User", "source": "COCO Pre-trained"},
        "Pedestrian": {"color": (0, 255, 0), "category": "Vulnerable Road User", "source": "COCO Pre-trained"},
        "Dog/cattle": {"color": (255, 105, 180), "category": "Animal Crossing", "source": "COCO Animals (Dog/Cow)"},
        "Pothole": {"color": (0, 0, 255), "category": "Road Surface Damage", "source": "Custom Model (Annotation Required)"},
        "Construction barrier/road blockage": {"color": (255, 0, 255), "category": "Infrastructure Hazard", "source": "Custom Model (Annotation Required)"}
    }

    def __init__(self, models_dir: Optional[str] = None):
        self.models_dir = models_dir or os.path.join(os.path.dirname(os.path.dirname(__file__)), "models")
        os.makedirs(self.models_dir, exist_ok=True)
        self.model = None
        self.model_type = "UNINITIALIZED"
        self.model_status_text = "Not loaded"
        self.confidence_threshold = 0.35
        self.init_engine()

    def init_engine(self):
        """Initializes YOLO if weights are available, otherwise activates OpenCV CV baseline."""
        try:
            from ultralytics import YOLO
            # Look for local custom weights first
            custom_weights = os.path.join(self.models_dir, "indian_roads_yolo.pt")
            default_weights = os.path.join(self.models_dir, "yolov8n.pt")

            if os.path.exists(custom_weights):
                self.model = YOLO(custom_weights)
                self.model_type = "YOLO_INDIAN_ROADS_CUSTOM"
                self.model_status_text = "Custom Indian Roads YOLO Model Loaded"
            elif os.path.exists(default_weights):
                self.model = YOLO(default_weights)
                self.model_type = "YOLO_PRETRAINED_COCO"
                self.model_status_text = "Pretrained YOLOv8n COCO Model Loaded"
            else:
                # Attempt to download or initialize yolov8n
                try:
                    self.model = YOLO("yolov8n.pt")
                    self.model_type = "YOLO_PRETRAINED_COCO"
                    self.model_status_text = "Pretrained YOLOv8n COCO Model Active"
                except Exception as dl_err:
                    self.model = None
                    self.model_type = "OPENCV_CV_BASELINE"
                    self.model_status_text = f"YOLO weights unavailable ({dl_err}). Using OpenCV CV Baseline."
        except ImportError:
            self.model = None
            self.model_type = "OPENCV_CV_BASELINE"
            self.model_status_text = "Ultralytics not installed. OpenCV CV Baseline active."
        except Exception as e:
            self.model = None
            self.model_type = "OPENCV_CV_BASELINE"
            self.model_status_text = f"Fallback to OpenCV Baseline: {e}"

    def get_status(self) -> Dict[str, Any]:
        return {
            "model_type": self.model_type,
            "status_text": self.model_status_text,
            "classes_supported": list(self.TAXONOMY_INFO.keys()),
            "custom_classes_note": "Potholes and Construction barriers require custom training weights or simulation metadata.",
            "confidence_threshold": self.confidence_threshold
        }

    def detect_image(self, frame: np.ndarray) -> Tuple[List[Dict[str, Any]], float]:
        """
        Runs object detection on a BGR image frame.
        Returns: (list_of_detections, inference_time_ms)
        Each detection: {'bbox': [x1, y1, x2, y2], 'class_name': str, 'confidence': float, 'raw_label': str}
        """
        start_time = time.perf_counter()
        detections: List[Dict[str, Any]] = []

        if frame is None or frame.size == 0:
            return [], 0.0

        h, w = frame.shape[:2]

        if self.model is not None and "YOLO" in self.model_type:
            try:
                results = self.model(frame, conf=self.confidence_threshold, verbose=False)
                for r in results:
                    boxes = r.boxes
                    for box in boxes:
                        cls_id = int(box.cls[0])
                        raw_name = r.names.get(cls_id, str(cls_id))
                        conf = float(box.conf[0])
                        coords = box.xyxy[0].tolist()

                        mapped_class = self.CLASS_MAPPINGS.get(raw_name.lower(), None)
                        if mapped_class:
                            detections.append({
                                "bbox": [float(coords[0]), float(coords[1]), float(coords[2]), float(coords[3])],
                                "class_name": mapped_class,
                                "raw_label": raw_name,
                                "confidence": round(conf, 3)
                            })
            except Exception as yolo_err:
                print(f"[Perception Error] YOLO inference failed: {yolo_err}")

        # If no YOLO detections or running baseline, use OpenCV motion/contour/color detector
        if not detections and self.model_type == "OPENCV_CV_BASELINE":
            # Computer Vision road saliency detector
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            blur = cv2.GaussianBlur(gray, (5, 5), 0)
            edges = cv2.Canny(blur, 50, 150)

            # Restrict detection to road ROI (lower half)
            roi = edges[int(h * 0.4):, :]
            contours, _ = cv2.findContours(roi, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

            for cnt in contours:
                area = cv2.contourArea(cnt)
                if area > 1200:
                    bx, by, bw, bh = cv2.boundingRect(cnt)
                    by += int(h * 0.4)
                    aspect = float(bw) / max(1.0, float(bh))
                    cls_guess = "Vehicle" if aspect > 1.2 else ("Pedestrian" if aspect < 0.6 else "Motorcycle/bicycle")
                    detections.append({
                        "bbox": [float(bx), float(by), float(bx + bw), float(by + bh)],
                        "class_name": cls_guess,
                        "raw_label": f"cv_{cls_guess.lower()}",
                        "confidence": 0.72
                    })
            # Cap maximum contours
            detections = sorted(detections, key=lambda d: (d["bbox"][2] - d["bbox"][0]) * (d["bbox"][3] - d["bbox"][1]), reverse=True)[:8]

        inference_ms = (time.perf_counter() - start_time) * 1000.0
        return detections, round(inference_ms, 2)

    def annotate_frame(
        self,
        frame: np.ndarray,
        tracked_objects: List[Dict[str, Any]],
        risk_info: Optional[Dict[str, Any]] = None
    ) -> np.ndarray:
        """
        Draws bounding boxes, tracking IDs, confidence scores,
        predicted future motion paths, and risk banner onto image.
        """
        annotated = frame.copy()
        h, w = annotated.shape[:2]

        for obj in tracked_objects:
            bbox = obj.get("bbox", [0, 0, 0, 0])
            x1, y1, x2, y2 = [int(v) for v in bbox]
            cls_name = obj.get("class_name", "Object")
            track_id = obj.get("track_id", 0)
            conf = obj.get("confidence", 0.0)
            color = self.TAXONOMY_INFO.get(cls_name, {}).get("color", (0, 255, 0))

            # Bounding box
            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)

            # Label banner
            label = f"ID #{track_id} {cls_name} {int(conf * 100)}%"
            t_size, _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
            cv2.rectangle(annotated, (x1, max(0, y1 - 22)), (x1 + t_size[0] + 8, y1), color, -1)
            cv2.putText(annotated, label, (x1 + 4, max(12, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)

            # Draw predicted trajectory vector if present
            preds = obj.get("predicted_trajectory", [])
            if preds and len(preds) >= 2:
                for i in range(len(preds) - 1):
                    pA = (int(preds[i]["x"]), int(preds[i]["y"]))
                    pB = (int(preds[i + 1]["x"]), int(preds[i + 1]["y"]))
                    cv2.line(annotated, pA, pB, (0, 255, 255), 2, cv2.LINE_AA)
                    cv2.circle(annotated, pB, 3, (0, 200, 255), -1)

        # Draw Risk HUD banner
        if risk_info:
            decision = risk_info.get("decision_state", "CONTINUE")
            bg_color = (0, 180, 0)
            if decision == "STOP_REQUIRED" or decision == "NO_SAFE_PATH_AVAILABLE":
                bg_color = (0, 0, 220)
            elif decision == "HIGH_RISK":
                bg_color = (0, 69, 255)
            elif decision == "CAUTION" or decision == "REPLAN":
                bg_color = (0, 191, 255)

            cv2.rectangle(annotated, (0, 0), (w, 38), bg_color, -1)
            hud_text = f"DECISION: {decision} | SPEED: {risk_info.get('target_speed_kmh', 0)} km/h | {risk_info.get('status_text', '')}"
            cv2.putText(annotated, hud_text[:110], (16, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2, cv2.LINE_AA)

        return annotated

    def process_video(
        self,
        video_path: str,
        output_dir: str,
        tracker=None,
        risk_engine=None,
        planner=None,
        max_frames: int = 60,
        sample_interval: int = 2
    ) -> Dict[str, Any]:
        """
        Processes a video file frame-by-frame through perception, tracking, risk, and planning.
        Saves keyframe snapshots into output_dir.
        """
        os.makedirs(output_dir, exist_ok=True)
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return {"ok": False, "error": f"Could not open video file: {video_path}"}

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 25.0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        frames_analyzed = 0
        frame_idx = 0
        timeline = []
        inference_times = []
        class_summary: Dict[str, int] = {}
        highest_risk = "NORMAL"
        saved_snapshots = []

        if tracker is not None:
            tracker.reset()

        while cap.isOpened() and frames_analyzed < max_frames:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % sample_interval == 0:
                ts = frame_idx / fps
                dets, inf_ms = self.detect_image(frame)
                inference_times.append(inf_ms)

                for d in dets:
                    cls = d["class_name"]
                    class_summary[cls] = class_summary.get(cls, 0) + 1

                # Tracking
                tracks = tracker.update_tracks(dets, timestamp=ts) if tracker else []

                # Risk
                risk = risk_engine.assess_risk(tracks, ego_speed_kmh=35.0, frame_width=width, frame_height=height) if risk_engine else {"decision_state": "NORMAL", "target_speed_kmh": 35.0}

                # Path Planning
                obstacles_for_planner = []
                for t in tracks:
                    cx = t["centroid"]["x"]
                    cy = t["centroid"]["y"]
                    # Map pixel to local ego coordinate meters (x: longitudinal, y: lateral)
                    long_m = max(2.0, (1.0 - (cy / float(height))) * 45.0)
                    lat_m = ((cx / float(width)) - 0.5) * 8.0
                    obstacles_for_planner.append({"x": round(long_m, 1), "y": round(lat_m, 1), "radius_m": 1.2})

                plan = planner.plan_path({"x": 0.0, "y": 0.0, "vx_mps": 9.7}, obstacles_for_planner, risk.get("decision_state")) if planner else {"status": "CRUISING", "planning_time_ms": 2.0}

                # Update peak risk
                state = risk.get("decision_state", "NORMAL")
                risk_ranks = {"NORMAL": 0, "CAUTION": 1, "REPLAN": 2, "HIGH_RISK": 3, "STOP_REQUIRED": 4, "NO_SAFE_PATH_AVAILABLE": 5}
                if risk_ranks.get(state, 0) > risk_ranks.get(highest_risk, 0):
                    highest_risk = state

                # Save snapshot every 10 sampled frames
                if frames_analyzed % 6 == 0:
                    annotated = self.annotate_frame(frame, tracks, risk)
                    snap_name = f"frame_{frame_idx:04d}.jpg"
                    snap_path = os.path.join(output_dir, snap_name)
                    cv2.imwrite(snap_path, annotated)
                    saved_snapshots.append(snap_name)

                timeline.append({
                    "frame_idx": frame_idx,
                    "time_s": round(ts, 2),
                    "detections_count": len(dets),
                    "tracked_objects": [t["class_name"] for t in tracks],
                    "risk_state": state,
                    "target_speed_kmh": risk.get("target_speed_kmh", 35.0),
                    "planner_status": plan.get("status", "OK"),
                    "inference_ms": inf_ms,
                    "planning_ms": plan.get("planning_time_ms", 2.0)
                })

                frames_analyzed += 1

            frame_idx += 1

        cap.release()

        avg_inf_ms = round(sum(inference_times) / max(1, len(inference_times)), 2)
        return {
            "ok": True,
            "total_frames_in_video": total_frames,
            "frames_analyzed": frames_analyzed,
            "fps": fps,
            "resolution": f"{width}x{height}",
            "avg_inference_latency_ms": avg_inf_ms,
            "detected_classes_summary": class_summary,
            "peak_risk_state": highest_risk,
            "snapshots": saved_snapshots,
            "timeline": timeline
        }


# Global perception engine instance
perception_service = IndianRoadPerceptionEngine()
