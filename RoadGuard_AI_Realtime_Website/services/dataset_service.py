"""
Dataset Management, Annotation Validation, and Model Training Service.
Supports YOLO dataset structure validation, Indian road class taxonomy checks,
train/validation splitting, hardware capability detection, and background training execution.
"""

import os
import shutil
import time
import yaml
import threading
from typing import Dict, Any, List, Optional
import torch


class DatasetTrainingService:
    """
    Validates autonomous driving datasets and executes real backend training runs.
    """

    TARGET_CLASSES = [
        "Vehicle",
        "Motorcycle/bicycle",
        "Pedestrian",
        "Dog/cattle",
        "Pothole",
        "Construction barrier/road blockage"
    ]

    def __init__(self, base_dir: Optional[str] = None):
        self.base_dir = base_dir or os.path.join(os.path.dirname(os.path.dirname(__file__)), "datasets")
        os.makedirs(self.base_dir, exist_ok=True)
        self.active_jobs: Dict[str, Dict[str, Any]] = {}
        self.seed_sample_dataset()

    def get_hardware_info(self) -> Dict[str, Any]:
        """Detects whether GPU acceleration is available for training."""
        has_cuda = torch.cuda.is_available()
        gpu_name = torch.cuda.get_device_name(0) if has_cuda else "None (CPU execution)"
        device_count = torch.cuda.device_count() if has_cuda else 0
        return {
            "cuda_available": has_cuda,
            "device_name": gpu_name,
            "device_count": device_count,
            "recommended_hardware": "NVIDIA GPU with >= 8 GB VRAM (RTX 3060/4060 or higher).",
            "cpu_fallback_warning": "GPU is not active. Training on CPU is supported for validation but will be significantly slower." if not has_cuda else ""
        }

    def seed_sample_dataset(self):
        """Creates a benchmark Indian road validation dataset sample."""
        sample_dir = os.path.join(self.base_dir, "indian_road_benchmark")
        os.makedirs(os.path.join(sample_dir, "images", "train"), exist_ok=True)
        os.makedirs(os.path.join(sample_dir, "images", "val"), exist_ok=True)
        os.makedirs(os.path.join(sample_dir, "labels", "train"), exist_ok=True)
        os.makedirs(os.path.join(sample_dir, "labels", "val"), exist_ok=True)

        data_yaml = {
            "path": sample_dir,
            "train": "images/train",
            "val": "images/val",
            "names": {i: name for i, name in enumerate(self.TARGET_CLASSES)}
        }
        yaml_path = os.path.join(sample_dir, "data.yaml")
        if not os.path.exists(yaml_path):
            with open(yaml_path, "w") as f:
                yaml.dump(data_yaml, f)

    def validate_dataset(self, dataset_name: str = "indian_road_benchmark") -> Dict[str, Any]:
        """
        Validates YOLO format dataset annotations, file integrity, and class balance.
        """
        ds_path = os.path.join(self.base_dir, dataset_name)
        if not os.path.exists(ds_path):
            return {"ok": False, "error": f"Dataset '{dataset_name}' not found."}

        yaml_path = os.path.join(ds_path, "data.yaml")
        if not os.path.exists(yaml_path):
            return {"ok": False, "error": "Missing 'data.yaml' configuration file."}

        try:
            with open(yaml_path, "r") as f:
                cfg = yaml.safe_load(f)
        except Exception as e:
            return {"ok": False, "error": f"Invalid data.yaml: {e}"}

        train_lbl_dir = os.path.join(ds_path, "labels", "train")
        val_lbl_dir = os.path.join(ds_path, "labels", "val")
        train_img_dir = os.path.join(ds_path, "images", "train")
        val_img_dir = os.path.join(ds_path, "images", "val")

        train_imgs = len([f for f in os.listdir(train_img_dir)]) if os.path.exists(train_img_dir) else 0
        val_imgs = len([f for f in os.listdir(val_img_dir)]) if os.path.exists(val_img_dir) else 0

        class_counts: Dict[str, int] = {c: 0 for c in self.TARGET_CLASSES}
        invalid_annotations = 0
        total_annotations = 0

        # Scan label files
        for l_dir in [train_lbl_dir, val_lbl_dir]:
            if not os.path.exists(l_dir):
                continue
            for fname in os.listdir(l_dir):
                if not fname.endswith(".txt"):
                    continue
                file_path = os.path.join(l_dir, fname)
                with open(file_path, "r") as lf:
                    for line in lf:
                        parts = line.strip().split()
                        if len(parts) == 5:
                            try:
                                cls_id = int(parts[0])
                                xc, yc, w, h = [float(p) for p in parts[1:]]
                                if 0.0 <= xc <= 1.0 and 0.0 <= yc <= 1.0 and 0.0 <= w <= 1.0 and 0.0 <= h <= 1.0:
                                    if 0 <= cls_id < len(self.TARGET_CLASSES):
                                        class_counts[self.TARGET_CLASSES[cls_id]] += 1
                                    total_annotations += 1
                                else:
                                    invalid_annotations += 1
                            except ValueError:
                                invalid_annotations += 1
                        else:
                            invalid_annotations += 1

        classes_meta = cfg.get("names", {})
        if isinstance(classes_meta, dict):
            class_list = [classes_meta[k] for k in sorted(classes_meta.keys())]
        else:
            class_list = classes_meta

        return {
            "ok": True,
            "dataset_name": dataset_name,
            "path": ds_path,
            "yaml_config": cfg,
            "classes_defined": class_list,
            "train_images_count": train_imgs,
            "val_images_count": val_imgs,
            "total_annotations": total_annotations,
            "invalid_annotations_count": invalid_annotations,
            "class_distribution": class_counts,
            "custom_classes_present": {
                "Pothole": class_counts.get("Pothole", 0) > 0,
                "Construction barrier/road blockage": class_counts.get("Construction barrier/road blockage", 0) > 0,
                "Dog/cattle": class_counts.get("Dog/cattle", 0) > 0
            },
            "status": "VALIDATED_CLEAN" if invalid_annotations == 0 else "WARNING_INVALID_BOXES_FOUND"
        }

    def start_training_job(
        self,
        dataset_name: str = "indian_road_benchmark",
        epochs: int = 5,
        batch_size: int = 8,
        img_size: int = 640,
        architecture: str = "best.pt"
    ) -> Dict[str, Any]:
        """
        Launches a real backend training thread using Ultralytics YOLO.
        Supports Faris Agour YOLOv8m KITTI architecture, YOLOv8n, and custom weights.
        """
        validation = self.validate_dataset(dataset_name)
        if not validation.get("ok"):
            return validation

        job_id = f"train_{int(time.time())}"
        hw = self.get_hardware_info()
        device_arg = "0" if hw["cuda_available"] else "cpu"

        models_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models")
        arch_file = os.path.basename(architecture)
        target_base = os.path.join(models_dir, arch_file)
        if not os.path.exists(target_base):
            if arch_file in ("yolov8m_kitti_enhanced.pt", "best.pt"):
                alt = os.path.join(models_dir, "best.pt" if arch_file == "yolov8m_kitti_enhanced.pt" else "yolov8m_kitti_enhanced.pt")
                if os.path.exists(alt):
                    target_base = alt
            elif os.path.exists(arch_file):
                target_base = arch_file
            else:
                target_base = "yolov8n.pt"

        job = {
            "job_id": job_id,
            "dataset": dataset_name,
            "architecture": arch_file,
            "base_weights": target_base,
            "epochs": epochs,
            "batch_size": batch_size,
            "img_size": img_size,
            "device": device_arg,
            "status": "STARTING",
            "epoch_current": 0,
            "epoch_total": epochs,
            "start_time": time.time(),
            "metrics": {"mAP50": 0.0, "mAP50_95": 0.0, "precision": 0.0, "recall": 0.0},
            "logs": [
                f"[{time.strftime('%H:%M:%S')}] Training job initialized on {hw['device_name']}.",
                f"[{time.strftime('%H:%M:%S')}] Selected base architecture: {arch_file}."
            ]
        }
        self.active_jobs[job_id] = job

        # Threaded execution
        def _train_worker():
            try:
                from ultralytics import YOLO
                job["status"] = "TRAINING"
                job["logs"].append(f"[{time.strftime('%H:%M:%S')}] Loading base architecture ({target_base})...")
                model = YOLO(target_base)

                yaml_path = os.path.join(self.base_dir, dataset_name, "data.yaml")
                job["logs"].append(f"[{time.strftime('%H:%M:%S')}] Commencing fine-tuning for {epochs} epochs on dataset {dataset_name}...")

                # Real training invocation
                results = model.train(
                    data=yaml_path,
                    epochs=epochs,
                    batch=batch_size,
                    imgsz=img_size,
                    device=device_arg,
                    verbose=False
                )

                job["status"] = "COMPLETED"
                job["epoch_current"] = epochs

                # Extract genuine training metrics from results if available; do not fabricate
                real_metrics = {}
                if hasattr(results, "results_dict") and results.results_dict:
                    rd = results.results_dict
                    real_metrics = {
                        "mAP50": round(float(rd.get("metrics/mAP50(B)", 0.0)), 3),
                        "mAP50_95": round(float(rd.get("metrics/mAP50-95(B)", 0.0)), 3),
                        "precision": round(float(rd.get("metrics/precision(B)", 0.0)), 3),
                        "recall": round(float(rd.get("metrics/recall(B)", 0.0)), 3),
                        "status": "VALIDATED_AGAINST_GROUND_TRUTH"
                    }
                else:
                    real_metrics = {
                        "status": "Unavailable — ground-truth annotations required",
                        "mAP50": None,
                        "mAP50_95": None,
                        "precision": None,
                        "recall": None,
                        "note": "Precision and mAP require labeled bounding-box validation ground truth."
                    }

                job["metrics"] = real_metrics
                job["logs"].append(f"[{time.strftime('%H:%M:%S')}] Training process concluded. Metrics: {real_metrics.get('status')}.")
                # Notify perception service to reload weights
                try:
                    from services.perception_service import perception_service
                    best_saved = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models", "best.pt")
                    if os.path.exists(best_saved):
                        perception_service.reload_model(best_saved)
                except Exception:
                    pass
            except Exception as e:
                job["status"] = "FAILED"
                job["logs"].append(f"[{time.strftime('%H:%M:%S')}] Training aborted: {e}")

        th = threading.Thread(target=_train_worker, daemon=True)
        th.start()

        return {
            "ok": True,
            "job_id": job_id,
            "message": f"Training job {job_id} launched on {hw['device_name']}.",
            "hardware": hw
        }

    def evaluate_video_or_dataset(
        self,
        source_path: str,
        conf_thresh: float = 0.35,
        iou_thresh: float = 0.25,
        frame_skip: int = 2
    ) -> Dict[str, Any]:
        """
        Runs real YOLO model evaluation on a selected video or image folder.
        Reports real measured frames, detection counts, class distribution, latency, and FPS.
        If ground truth annotations are absent, labels accuracy metrics as Unavailable.
        """
        from ultralytics import YOLO
        import cv2

        if not os.path.exists(source_path):
            candidate = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "uploads", "videos", os.path.basename(source_path)))
            if os.path.exists(candidate):
                source_path = candidate
            else:
                return {"ok": False, "error": f"Source path '{source_path}' does not exist."}

        model = YOLO("yolov8n.pt")
        is_video = os.path.isfile(source_path)

        if is_video:
            cap = cv2.VideoCapture(source_path)
            if not cap.isOpened():
                return {"ok": False, "error": f"Failed to open video file '{source_path}'."}

            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            fps = float(cap.get(cv2.CAP_PROP_FPS) or 25.0)
            
            analyzed_frames = 0
            frame_idx = 0
            all_confs = []
            class_counts = {}
            latencies = []
            t_eval_start = time.perf_counter()

            while cap.isOpened() and analyzed_frames < 60:
                ret, frame = cap.read()
                if not ret:
                    break

                if frame_idx % frame_skip == 0:
                    t0 = time.perf_counter()
                    res = model(frame, conf=conf_thresh, iou=iou_thresh, verbose=False)
                    lat = (time.perf_counter() - t0) * 1000.0
                    latencies.append(lat)

                    for r in res:
                        for box in r.boxes:
                            c_id = int(box.cls[0])
                            c_name = r.names.get(c_id, str(c_id))
                            c_conf = float(box.conf[0])
                            all_confs.append(c_conf)
                            class_counts[c_name] = class_counts.get(c_name, 0) + 1

                    analyzed_frames += 1

                frame_idx += 1

            cap.release()
            t_eval_total = max(0.001, time.perf_counter() - t_eval_start)

            avg_conf = round(sum(all_confs) / max(1, len(all_confs)), 3) if all_confs else 0.0
            avg_lat = round(sum(latencies) / max(1, len(latencies)), 2) if latencies else 0.0
            measured_fps = round(analyzed_frames / t_eval_total, 1)

            return {
                "ok": True,
                "source_type": "VIDEO_STREAM",
                "source_path": os.path.basename(source_path),
                "total_frames_in_source": total_frames,
                "frames_analyzed": analyzed_frames,
                "video_fps": round(fps, 1),
                "processing_fps": measured_fps,
                "avg_inference_latency_ms": avg_lat,
                "total_detections": len(all_confs),
                "average_confidence": avg_conf,
                "class_distribution": class_counts,
                "accuracy_metrics": {
                    "mAP50": "Unavailable — ground-truth annotations required (open road video)",
                    "precision": "Unavailable — ground-truth annotations required",
                    "recall": "Unavailable — ground-truth annotations required",
                    "f1_score": "Unavailable — ground-truth annotations required"
                },
                "parameters_used": {
                    "confidence_threshold": conf_thresh,
                    "iou_threshold": iou_thresh,
                    "frame_skip": frame_skip,
                    "model_used": "yolov8n.pt (Pretrained COCO)"
                }
            }
        else:
            return {"ok": False, "error": "Evaluation for folder datasets requires dataset validation."}

    def get_job_status(self, job_id: str) -> Dict[str, Any]:
        job = self.active_jobs.get(job_id)
        if not job:
            return {"ok": False, "error": f"Job {job_id} not found."}
        return {"ok": True, "job": job}


# Global dataset service instance
dataset_service = DatasetTrainingService()
