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
from services.tracking_service import ObjectTracker
from services.collision_risk_service import collision_risk_service

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
    Centralized service for video upload validation, multi-camera rig management,
    and asynchronous YOLO perception + tracking analysis.
    """

    def __init__(self):
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._camera_sources: Dict[str, Dict[str, Any]] = {
            "front": {
                "cam_id": "front",
                "label": "Camera 01 (Front)",
                "role": "Primary Forward Perception Sensor",
                "source_type": "STANDBY",
                "filename": None,
                "video_path": None,
                "status_badge": "STANDBY"
            },
            "rear": {
                "cam_id": "rear",
                "label": "Camera 02 (Rear)",
                "role": "180° Reverse Perspective",
                "source_type": "SIMULATED_DERIVED",
                "filename": None,
                "video_path": None,
                "status_badge": "SIMULATED (DERIVED FROM FRONT)"
            },
            "left": {
                "cam_id": "left",
                "label": "Camera 03 (Left Blind-Spot)",
                "role": "90° Flank Blind-Spot Sensor",
                "source_type": "SIMULATED_DERIVED",
                "filename": None,
                "video_path": None,
                "status_badge": "SIMULATED (SIDE FLANK PROJECTION)"
            },
            "right": {
                "cam_id": "right",
                "label": "Camera 04 (Right Shoulder)",
                "role": "90° Roadside Shoulder Sensor",
                "source_type": "SIMULATED_DERIVED",
                "filename": None,
                "video_path": None,
                "status_badge": "SIMULATED (SHOULDER MARGIN PROJECTION)"
            }
        }
        self._lock = threading.Lock()

    def list_available_videos(self) -> List[Dict[str, Any]]:
        """Scans the uploads/videos directory and returns detailed metadata for existing videos."""
        videos = []
        if not os.path.exists(UPLOAD_VIDEOS_DIR):
            return videos

        for fname in sorted(os.listdir(UPLOAD_VIDEOS_DIR)):
            ext = os.path.splitext(fname)[1].lower()
            if ext in ALLOWED_VIDEO_EXTENSIONS:
                fpath = os.path.join(UPLOAD_VIDEOS_DIR, fname)
                try:
                    fsize = os.path.getsize(fpath)
                    mtime = os.path.getmtime(fpath)
                    if fsize > 1000:
                        cap = cv2.VideoCapture(fpath)
                        is_open = cap.isOpened()
                        total_f = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) if is_open else 0
                        fps_val = float(cap.get(cv2.CAP_PROP_FPS) or 25.0) if is_open else 25.0
                        w_val = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) if is_open else 0
                        h_val = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) if is_open else 0
                        cap.release()
                        if is_open and total_f > 0 and w_val > 0 and h_val > 0:
                            dur_sec = round(total_f / max(1.0, fps_val), 1)
                            is_sample_urban = (fsize > 10 * 1024 * 1024)
                            label = f"Urban Road & Pedestrian Crossing ({round(fsize / (1024 * 1024), 1)} MB)" if is_sample_urban else f"Road Video '{fname}' ({round(fsize / (1024 * 1024), 1)} MB)"

                            videos.append({
                                "filename": fname,
                                "display_name": label,
                                "size_bytes": fsize,
                                "size_mb": round(fsize / (1024 * 1024), 2),
                                "duration_seconds": dur_sec,
                                "total_frames": total_f,
                                "fps": round(fps_val, 1),
                                "resolution": f"{w_val}x{h_val}",
                                "modified_timestamp": mtime,
                                "url": f"/api/autonomous/video-file/{fname}"
                            })
                except Exception:
                    continue

        videos.sort(key=lambda x: x["modified_timestamp"], reverse=True)
        return videos

    def get_camera_sources(self) -> Dict[str, Any]:
        """Returns the current state and source labels for all four cameras in the rig."""
        with self._lock:
            return {
                "ok": True,
                "cameras": {k: dict(v) for k, v in self._camera_sources.items()},
                "synchronization": {
                    "master_clock": "CAMERA_01_FRONT",
                    "status": "HARDWARE_SYNCHRONIZED" if all(c.get("source_type") == "PHYSICAL_VIDEO" for c in self._camera_sources.values()) else "DERIVED_SYNCHRONIZED"
                }
            }

    def set_camera_source(self, cam_id: str, filename: str, source_type: str = "PHYSICAL_VIDEO") -> Dict[str, Any]:
        """Updates a camera rig slot with a specific uploaded or configured video."""
        cam_id = cam_id.lower().strip()
        if cam_id not in self._camera_sources:
            return {"ok": False, "error": f"Invalid camera id '{cam_id}'. Must be front, rear, left, or right."}

        fpath = os.path.join(UPLOAD_VIDEOS_DIR, filename)
        if not os.path.exists(fpath):
            return {"ok": False, "error": f"Video file '{filename}' does not exist on server."}

        with self._lock:
            cam = self._camera_sources[cam_id]
            cam["source_type"] = source_type
            cam["filename"] = filename
            cam["video_path"] = fpath
            if source_type == "PHYSICAL_VIDEO":
                cam["status_badge"] = f"SOURCE: PHYSICAL {cam_id.upper()} VIDEO FEED"
            else:
                cam["status_badge"] = f"SOURCE: SIMULATED ({filename})"

        return {"ok": True, "camera": dict(self._camera_sources[cam_id])}

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

    def create_job(self, original_filename: str, saved_path: str, metadata: Dict[str, Any], options: Optional[Dict[str, Any]] = None) -> str:
        """Initializes a new asynchronous video analysis job record with configurable options."""
        job_id = f"job_{uuid.uuid4().hex[:10]}"
        snapshot_dir = os.path.join(SNAPSHOTS_DIR, job_id)
        os.makedirs(snapshot_dir, exist_ok=True)

        opts = options or {}
        sample_interval = max(1, int(opts.get("sample_interval") or opts.get("frame_skip") or 2))
        max_frames = int(opts.get("max_frames") or 0)  # 0 or None means analyze full video
        conf_thresh = float(opts.get("conf_threshold") or 0.35)
        iou_thresh = float(opts.get("iou_threshold") or 0.25)

        job_record = {
            "job_id": job_id,
            "filename": original_filename,
            "video_path": saved_path,
            "snapshot_dir": snapshot_dir,
            "metadata": metadata,
            "options": {
                "sample_interval": sample_interval,
                "max_frames": max_frames,
                "conf_threshold": conf_thresh,
                "iou_threshold": iou_thresh
            },
            "status": "PROCESSING",
            "cancelled": False,
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
                    "message": f"Uploaded road video '{original_filename}' ({metadata.get('resolution')}, {metadata.get('fps')} FPS, {metadata.get('total_frames')} frames). Config: step={sample_interval}, max_frames={'FULL VIDEO' if max_frames <= 0 else max_frames}."
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

    def get_or_create_job_for_video(self, filename: str, options: Optional[Dict[str, Any]] = None, force_new: bool = False) -> Tuple[bool, Optional[str], Optional[str], Optional[Dict[str, Any]]]:
        """
        Looks for an active or completed job for this video file,
        or creates a new job if none exists or force_new is requested.
        Returns: (success, job_id, error_msg, metadata)
        """
        safe_name = os.path.basename(filename)
        video_path = os.path.join(UPLOAD_VIDEOS_DIR, safe_name)
        if not os.path.exists(video_path):
            return False, None, f"Video '{safe_name}' not found on server.", None

        if not force_new:
            with self._lock:
                for j_id, j in self._jobs.items():
                    if j.get("video_path") == video_path and j.get("status") in ("COMPLETED", "RUNNING", "PROCESSING"):
                        return True, j_id, None, j.get("metadata")

        is_readable, err, meta = self.validate_video_file_readable(video_path)
        if not is_readable:
            return False, None, err, None

        job_id = self.create_job(safe_name, video_path, meta, options=options)
        return True, job_id, None, meta

    def pause_job(self, job_id: str) -> Tuple[bool, str]:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return False, "Job not found"
            if job["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
                return False, f"Cannot pause job in {job['status']} state"
            job["status"] = "PAUSED"
            job["events"].append({
                "timestamp": time.strftime("%H:%M:%S"),
                "type": "CONTROL",
                "message": "Video analysis paused by user."
            })
            return True, "Job paused"

    def resume_job(self, job_id: str) -> Tuple[bool, str]:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return False, "Job not found"
            if job["status"] != "PAUSED":
                return False, f"Job is not paused (current status: {job['status']})"
            job["status"] = "PROCESSING"
            job["events"].append({
                "timestamp": time.strftime("%H:%M:%S"),
                "type": "CONTROL",
                "message": "Video analysis resumed."
            })
            return True, "Job resumed"

    def cancel_job(self, job_id: str) -> Tuple[bool, str]:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return False, "Job not found"
            job["cancelled"] = True
            job["status"] = "CANCELLED"
            job["events"].append({
                "timestamp": time.strftime("%H:%M:%S"),
                "type": "CONTROL",
                "message": "Video analysis cancelled by user."
            })
            return True, "Job cancelled"

    def restart_job(self, job_id: str, options: Optional[Dict[str, Any]] = None) -> Tuple[bool, Optional[str], str]:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return False, None, "Job not found"
            video_path = job["video_path"]
            filename = job["filename"]
            meta = job["metadata"]
            # Cancel current
            job["cancelled"] = True

        new_id = self.create_job(filename, video_path, meta, options=options)
        return True, new_id, "Job restarted"

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        """Returns the job record or None if not found."""
        with self._lock:
            return self._jobs.get(job_id)

    def _run_analysis_worker(self, job_id: str):
        """Asynchronous worker that processes the full video frame by frame with real YOLO inference."""
        job = self.get_job(job_id)
        if not job:
            return

        video_path = job["video_path"]
        snapshot_dir = job["snapshot_dir"]
        opts = job.get("options", {})
        sample_interval = max(1, int(opts.get("sample_interval") or 2))
        max_frames_limit = int(opts.get("max_frames") or 0)
        conf_thresh = float(opts.get("conf_threshold") or 0.35)
        iou_thresh = float(opts.get("iou_threshold") or 0.25)

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

            frame_idx = 0
            analyzed_count = 0
            inference_times: List[float] = []
            class_summary: Dict[str, int] = {}
            timeline = []
            snapshots = []
            job_tracker = ObjectTracker(iou_threshold=iou_thresh)
            t_work_start = time.perf_counter()

            # Initialize annotated output video writer (matching pun33th45/detect_video pipeline)
            out_detected_filename = f"{os.path.splitext(job['filename'])[0]}_detected.mp4"
            out_detected_path = os.path.join(UPLOAD_VIDEOS_DIR, out_detected_filename)
            video_writer = None
            try:
                fourcc = cv2.VideoWriter_fourcc(*"mp4v")
                video_writer = cv2.VideoWriter(out_detected_path, fourcc, fps, (width, height))
            except Exception:
                video_writer = None

            last_annotated_frame = None

            # Check model availability and set confidence
            perception_service.set_confidence_threshold(conf_thresh)
            model_status = perception_service.get_status()
            with self._lock:
                job["annotated_video_filename"] = out_detected_filename
                job["annotated_video_path"] = out_detected_path
                job["annotated_video_url"] = f"/api/autonomous/video/download-detected/{job_id}"
                job["events"].append({
                    "timestamp": time.strftime("%H:%M:%S"),
                    "type": "INFERENCE_START",
                    "message": f"Inference pipeline initialized: {model_status.get('status_text')} (Threshold: {conf_thresh}, Sample step: {sample_interval}, Max frames: {'FULL CLIP' if max_frames_limit <= 0 else max_frames_limit})."
                })

            while cap.isOpened():
                # Check for cancellation
                if job.get("cancelled") or job.get("status") == "CANCELLED":
                    break

                # Handle pause state
                while job.get("status") == "PAUSED" and not job.get("cancelled"):
                    time.sleep(0.2)

                if job.get("cancelled"):
                    break

                # Stop if user set a specific max frames limit
                if max_frames_limit > 0 and analyzed_count >= max_frames_limit:
                    break

                ret, frame = cap.read()
                if not ret or frame is None:
                    break

                if frame_idx % sample_interval == 0:
                    time_s = round(frame_idx / fps, 2)
                    dets, inf_ms = perception_service.detect_image(frame)
                    inference_times.append(inf_ms)

                    # Update Multi-Object Tracker
                    tracks = job_tracker.update_tracks(dets, timestamp=time_s)

                    # Collision Risk & Pedestrian Safety Assessment
                    risk = collision_risk_service.assess_risk(
                        tracks, ego_speed_kmh=35.0, frame_width=width, frame_height=height
                    )

                    # Forward travel crossing envelope check
                    is_ped_crossing = any(
                        t.get("class_name") in ["Pedestrian", "Dog/cattle"] and
                        abs(t["centroid"]["x"] - (width / 2.0)) < (width * 0.28) and
                        t["centroid"]["y"] > (height * 0.42)
                        for t in tracks
                    )

                    # Update class counts
                    frame_classes: Dict[str, int] = {}
                    for d in dets:
                        cname = d["class_name"]
                        class_summary[cname] = class_summary.get(cname, 0) + 1
                        frame_classes[cname] = frame_classes.get(cname, 0) + 1

                    # Render annotated frame with real bounding boxes, track labels, and FPS counter
                    annotated_frame = frame.copy()
                    for t in tracks:
                        box = [int(v) for v in t["bbox"]]
                        c_info = perception_service.TAXONOMY_INFO.get(t["class_name"], {})
                        color = c_info.get("color", (0, 255, 0))
                        cv2.rectangle(annotated_frame, (box[0], box[1]), (box[2], box[3]), color, 2)
                        lbl = f"#{t['track_id']} {t['class_name']} {int(t['confidence'] * 100)}%"
                        (tw, th), _ = cv2.getTextSize(lbl, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
                        cv2.rectangle(annotated_frame, (box[0], max(0, box[1] - th - 6)), (box[0] + tw + 4, box[1]), color, -1)
                        cv2.putText(annotated_frame, lbl, (box[0] + 2, max(12, box[1] - 4)),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)

                    # Real FPS counter overlay (top-left)
                    cur_fps = round(1000.0 / max(1.0, inf_ms), 1)
                    cv2.putText(annotated_frame, f"FPS: {cur_fps}", (12, 32),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.85, (0, 255, 0), 2, cv2.LINE_AA)

                    # Frame info readout
                    cv2.putText(annotated_frame, f"Frame {frame_idx}/{total_frames}  Dets: {len(dets)}",
                                (12, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (220, 220, 220), 1, cv2.LINE_AA)

                    # Hazard indicator banner if pedestrian in crossing envelope
                    if is_ped_crossing:
                        cv2.rectangle(annotated_frame, (0, 0), (width, 36), (0, 0, 220), -1)
                        cv2.putText(annotated_frame, "[CRITICAL HAZARD] PEDESTRIAN IN EGO TRAVEL PATH - STOP",
                                    (14, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2, cv2.LINE_AA)

                    last_annotated_frame = annotated_frame
                    if video_writer is not None:
                        video_writer.write(annotated_frame)

                    # Save snapshots periodically (every 20 sampled frames or on critical hazard)
                    snapshot_filename = None
                    if (analyzed_count % 20 == 0 or is_ped_crossing) and len(snapshots) < 80:
                        snapshot_filename = f"frame_{frame_idx:05d}.jpg"
                        snap_path = os.path.join(snapshot_dir, snapshot_filename)
                        cv2.imwrite(snap_path, annotated_frame)
                        snapshots.append(snapshot_filename)

                    # Event log entry for notable events
                    if (dets and analyzed_count % 15 == 0) or is_ped_crossing:
                        det_summary_str = ", ".join([f"{count} {cls}" for cls, count in frame_classes.items()])
                        ev_msg = f"Frame {frame_idx} (t={time_s}s): Detected {len(dets)} objects ({det_summary_str}). Latency: {inf_ms}ms."
                        if is_ped_crossing:
                            ev_msg = f"[CRITICAL HAZARD] Frame {frame_idx} (t={time_s}s): Vulnerable road user crossing ego corridor!"
                        with self._lock:
                            job["events"].append({
                                "timestamp": time.strftime("%H:%M:%S"),
                                "type": "ALERT" if is_ped_crossing else "DETECTION",
                                "message": ev_msg
                            })

                    # Map detections with track_ids
                    enriched_detections = []
                    for d in dets:
                        d_cx = (d["bbox"][0] + d["bbox"][2]) / 2.0
                        d_cy = (d["bbox"][1] + d["bbox"][3]) / 2.0
                        matching_track = next((t for t in tracks if t["class_name"] == d["class_name"] and abs(t["centroid"]["x"] - d_cx) < 25.0), None)
                        enriched_detections.append({
                            **d,
                            "track_id": matching_track["track_id"] if matching_track else f"T{len(enriched_detections)+1}",
                            "in_path": abs(d_cx - (width / 2.0)) < (width * 0.28)
                        })

                    timeline.append({
                        "frame_idx": frame_idx,
                        "time_s": time_s,
                        "timestamp_sec": time_s,  # Seamless compatibility with frontend
                        "detections_count": len(dets),
                        "detections": enriched_detections,
                        "tracks": tracks,
                        "risk": {
                            "decision_state": "STOP_REQUIRED" if is_ped_crossing else risk.get("decision_state", "CONTINUE"),
                            "target_speed_kmh": 0.0 if is_ped_crossing else risk.get("target_speed_kmh", 35.0),
                            "min_distance_m": risk.get("min_distance_m"),
                            "min_ttc_s": 1.2 if is_ped_crossing else risk.get("min_ttc_s"),
                            "status_text": "PEDESTRIAN CROSSING IN PATH — HOLDING 0 KM/H STOP" if is_ped_crossing else risk.get("status_text", "")
                        },
                        "pedestrian_crossing_active": is_ped_crossing,
                        "inference_ms": inf_ms
                    })

                    analyzed_count += 1

                    # Compute progress against expected frames
                    target_total = max_frames_limit if max_frames_limit > 0 else max(1, total_frames // sample_interval)
                    pct = round((analyzed_count / float(max(1, target_total))) * 100.0, 1)
                    with self._lock:
                        job["progress_pct"] = min(99.0, pct)
                        job["current_frame"] = frame_idx
                        job["analyzed_frames"] = analyzed_count
                        job["active_detections_count"] = len(dets)
                        job["detected_classes_summary"] = dict(class_summary)
                        job["snapshots"] = list(snapshots)

                else:
                    # Write last annotated frame or original frame for skipped intervals to maintain video playback timing
                    if video_writer is not None:
                        video_writer.write(last_annotated_frame if last_annotated_frame is not None else frame)

                frame_idx += 1

            cap.release()
            if video_writer is not None:
                video_writer.release()

            if job.get("cancelled"):
                with self._lock:
                    job["status"] = "CANCELLED"
                    job["events"].append({
                        "timestamp": time.strftime("%H:%M:%S"),
                        "type": "CANCELLED",
                        "message": f"Job cancelled. Processed {analyzed_count} frames before stopping."
                    })
                return

            elapsed_total = max(0.001, time.perf_counter() - t_work_start)
            avg_inf = round(sum(inference_times) / max(1, len(inference_times)), 2)
            processing_fps = round(analyzed_count / elapsed_total, 1)
            total_objs_found = sum(class_summary.values())

            annotated_ready = os.path.exists(out_detected_path) and os.path.getsize(out_detected_path) > 1000

            result_data = {
                "total_frames_in_video": total_frames,
                "frames_analyzed": analyzed_count,
                "fps": fps,
                "processing_fps": processing_fps,
                "resolution": f"{width}x{height}",
                "avg_inference_latency_ms": avg_inf,
                "total_objects_detected": total_objs_found,
                "detected_classes_summary": class_summary,
                "snapshots": snapshots,
                "timeline": timeline,
                "annotated_video_filename": out_detected_filename,
                "annotated_video_path": out_detected_path,
                "annotated_video_url": f"/api/autonomous/video/download-detected/{job_id}",
                "annotated_video_available": annotated_ready
            }

            with self._lock:
                job["status"] = "COMPLETED"
                job["progress_pct"] = 100.0
                job["completed_at"] = time.time()
                job["result"] = result_data
                job["annotated_video_filename"] = out_detected_filename
                job["annotated_video_path"] = out_detected_path
                job["annotated_video_url"] = f"/api/autonomous/video/download-detected/{job_id}"
                job["events"].append({
                    "timestamp": time.strftime("%H:%M:%S"),
                    "type": "COMPLETED",
                    "message": f"Video analysis complete: {analyzed_count} frames analyzed across full clip. Found {total_objs_found} total objects. Avg latency: {avg_inf} ms."
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
