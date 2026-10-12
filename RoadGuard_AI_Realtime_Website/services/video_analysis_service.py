"""
Video Analysis Service for Autonomous Driving Research Prototype.
Handles video upload validation, file size limits, asynchronous processing,
real frame-by-frame YOLO inference, snapshot persistence, and event logging.
"""

import os
import time
import uuid
import threading
from typing import Dict, Any, List, Optional, Tuple
import cv2

from services.perception_service import perception_service

# Configuration & limits
MAX_VIDEO_SIZE_BYTES = 50 * 1024 * 1024  # 50 MB
ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".webm"}

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UPLOAD_VIDEOS_DIR = os.path.join(BASE_DIR, "uploads", "videos")
SNAPSHOTS_DIR = os.path.join(BASE_DIR, "uploads", "snapshots")

os.makedirs(UPLOAD_VIDEOS_DIR, exist_ok=True)
os.makedirs(SNAPSHOTS_DIR, exist_ok=True)


class VideoAnalysisService:
    """
    Centralized service for video upload validation and asynchronous YOLO analysis.
    Shared cleanly by both FastAPI and Flask.
    """

    def __init__(self):
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    def validate_upload(self, filename: str, file_size: Optional[int] = None) -> Tuple[bool, Optional[str], int]:
        """
        Validates uploaded file against allowed video extensions and size limits.
        Returns: (is_valid, error_message, status_code)
        """
        if not filename or filename.strip() == "":
            return False, "No file selected. Please select a road video file.", 400

        ext = os.path.splitext(filename)[1].lower()
        if ext not in ALLOWED_VIDEO_EXTENSIONS:
            allowed_list = ", ".join(sorted(ALLOWED_VIDEO_EXTENSIONS))
            return False, f"Invalid video format '{ext}'. Allowed road-video formats: {allowed_list}.", 400

        if file_size is not None:
            if file_size == 0:
                return False, "Uploaded video file is empty (0 bytes).", 400
            if file_size > MAX_VIDEO_SIZE_BYTES:
                size_mb = round(file_size / (1024 * 1024), 1)
                limit_mb = round(MAX_VIDEO_SIZE_BYTES / (1024 * 1024))
                return False, f"File size ({size_mb} MB) exceeds maximum allowed limit of {limit_mb} MB.", 413

        return True, None, 200

    def validate_video_file_readable(self, file_path: str) -> Tuple[bool, Optional[str], Dict[str, Any]]:
        """
        Opens the saved video file using OpenCV to ensure headers and codecs are valid.
        """
        if not os.path.exists(file_path):
            return False, "Saved video file does not exist on disk.", 500

        cap = cv2.VideoCapture(file_path)
        if not cap.isOpened():
            return False, "Could not open or decode video. File may be corrupted or use an unsupported codec.", 400

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = float(cap.get(cv2.CAP_PROP_FPS) or 25.0)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        
        # Read test frame
        ret, test_frame = cap.read()
        cap.release()

        if not ret or test_frame is None:
            return False, "Video contains zero decodable frames.", 400

        metadata = {
            "total_frames": total_frames,
            "fps": round(fps, 1),
            "width": width,
            "height": height,
            "resolution": f"{width}x{height}"
        }
        return True, None, metadata

    def create_job(self, original_filename: str, saved_path: str, metadata: Dict[str, Any]) -> str:
        """Initializes a new asynchronous video analysis job record."""
        job_id = f"job_{uuid.uuid4().hex[:10]}"
        snapshot_dir = os.path.join(SNAPSHOTS_DIR, job_id)
        os.makedirs(snapshot_dir, exist_ok=True)

        job_record = {
            "job_id": job_id,
            "filename": original_filename,
            "video_path": saved_path,
            "snapshot_dir": snapshot_dir,
            "metadata": metadata,
            "status": "PROCESSING",
            "progress_pct": 0.0,
            "current_frame": 0,
            "total_frames": metadata.get("total_frames", 0),
            "analyzed_frames": 0,
            "active_detections_count": 0,
            "detected_classes_summary": {},
            "snapshots": [],
            "events": [
                {
                    "timestamp": time.strftime("%H:%M:%S"),
                    "type": "UPLOAD",
                    "message": f"Uploaded road video '{original_filename}' ({metadata.get('resolution')}, {metadata.get('fps')} FPS)."
                }
            ],
            "result": None,
            "error": None,
            "started_at": time.time(),
            "completed_at": None
        }

        with self._lock:
            self._jobs[job_id] = job_record

        # Launch processing in a daemon thread
        worker = threading.Thread(target=self._run_analysis_worker, args=(job_id,), daemon=True)
        worker.start()

        return job_id

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        """Returns the job record or None if not found."""
        with self._lock:
            return self._jobs.get(job_id)

    def _run_analysis_worker(self, job_id: str):
        """Asynchronous worker that processes the video frame by frame with real YOLO inference."""
        job = self.get_job(job_id)
        if not job:
            return

        video_path = job["video_path"]
        snapshot_dir = job["snapshot_dir"]

        try:
            cap = cv2.VideoCapture(video_path)
            if not cap.isOpened():
                with self._lock:
                    job["status"] = "FAILED"
                    job["error"] = "Failed to open video file for inference."
                return

            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            fps = float(cap.get(cv2.CAP_PROP_FPS) or 25.0)
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

            # Limit max frames to analyze for fast interactive response (up to 75 sampled frames)
            max_sampled_frames = 60
            sample_interval = max(1, int(total_frames / max_sampled_frames)) if total_frames > max_sampled_frames else 2

            frame_idx = 0
            analyzed_count = 0
            inference_times: List[float] = []
            class_summary: Dict[str, int] = {}
            timeline = []
            snapshots = []

            # Check model availability
            model_status = perception_service.get_status()
            with self._lock:
                job["events"].append({
                    "timestamp": time.strftime("%H:%M:%S"),
                    "type": "INFERENCE_START",
                    "message": f"Inference pipeline initialized: {model_status.get('status_text')} (Threshold: {model_status.get('confidence_threshold')})."
                })

            while cap.isOpened() and analyzed_count < max_sampled_frames:
                ret, frame = cap.read()
                if not ret:
                    break

                if frame_idx % sample_interval == 0:
                    time_s = round(frame_idx / fps, 2)
                    dets, inf_ms = perception_service.detect_image(frame)
                    inference_times.append(inf_ms)

                    # Update class counts
                    frame_classes: Dict[str, int] = {}
                    for d in dets:
                        cname = d["class_name"]
                        class_summary[cname] = class_summary.get(cname, 0) + 1
                        frame_classes[cname] = frame_classes.get(cname, 0) + 1

                    # Save snapshot every 6 sampled frames
                    snapshot_filename = None
                    if analyzed_count % 6 == 0:
                        snapshot_filename = f"frame_{frame_idx:05d}.jpg"
                        snap_path = os.path.join(snapshot_dir, snapshot_filename)
                        
                        # Draw bounding boxes and confidence on frame
                        annotated_frame = frame.copy()
                        for d in dets:
                            box = [int(v) for v in d["bbox"]]
                            color = perception_service.TAXONOMY_INFO.get(d["class_name"], {}).get("color", (0, 255, 0))
                            cv2.rectangle(annotated_frame, (box[0], box[1]), (box[2], box[3]), color, 2)
                            lbl = f"{d['class_name']} {int(d['confidence'] * 100)}%"
                            cv2.putText(annotated_frame, lbl, (box[0], max(16, box[1] - 6)),
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2, cv2.LINE_AA)
                        
                        cv2.imwrite(snap_path, annotated_frame)
                        snapshots.append(snapshot_filename)

                    # Event log entry for notable detections
                    if dets and analyzed_count % 4 == 0:
                        det_summary_str = ", ".join([f"{count} {cls}" for cls, count in frame_classes.items()])
                        with self._lock:
                            job["events"].append({
                                "timestamp": time.strftime("%H:%M:%S"),
                                "type": "DETECTION",
                                "message": f"Frame {frame_idx} (t={time_s}s): Detected {len(dets)} objects ({det_summary_str}). Inference: {inf_ms}ms."
                            })

                    timeline.append({
                        "frame_idx": frame_idx,
                        "time_s": time_s,
                        "detections_count": len(dets),
                        "detections": dets,
                        "inference_ms": inf_ms
                    })

                    analyzed_count += 1

                    # Update real progress
                    pct = round((analyzed_count / float(max_sampled_frames)) * 100, 1)
                    with self._lock:
                        job["progress_pct"] = min(99.0, pct)
                        job["current_frame"] = frame_idx
                        job["analyzed_frames"] = analyzed_count
                        job["active_detections_count"] = len(dets)
                        job["detected_classes_summary"] = dict(class_summary)
                        job["snapshots"] = list(snapshots)

                frame_idx += 1

            cap.release()

            avg_inf = round(sum(inference_times) / max(1, len(inference_times)), 2)
            total_objs_found = sum(class_summary.values())

            result_data = {
                "total_frames_in_video": total_frames,
                "frames_analyzed": analyzed_count,
                "fps": fps,
                "resolution": f"{width}x{height}",
                "avg_inference_latency_ms": avg_inf,
                "total_objects_detected": total_objs_found,
                "detected_classes_summary": class_summary,
                "snapshots": snapshots,
                "timeline": timeline
            }

            with self._lock:
                job["status"] = "COMPLETED"
                job["progress_pct"] = 100.0
                job["completed_at"] = time.time()
                job["result"] = result_data
                job["events"].append({
                    "timestamp": time.strftime("%H:%M:%S"),
                    "type": "COMPLETED",
                    "message": f"Video analysis complete: {analyzed_count} frames analyzed. Found {total_objs_found} total objects. Avg latency: {avg_inf} ms."
                })

        except Exception as e:
            with self._lock:
                job["status"] = "FAILED"
                job["error"] = str(e)
                job["events"].append({
                    "timestamp": time.strftime("%H:%M:%S"),
                    "type": "ERROR",
                    "message": f"Video analysis encountered an error: {str(e)}"
                })


video_analysis_service = VideoAnalysisService()
