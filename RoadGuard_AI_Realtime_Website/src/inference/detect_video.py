"""
detect_video.py
---------------
Run obstacle detection on video files with real-time bounding boxes,
class labels, confidence scores, and FPS counter.

Features:
  - Frame-by-frame YOLOv8 inference
  - FPS counter overlay
  - Output video writing (MP4)
  - Optional frame skipping for speed
  - Detection statistics export

Usage:
    python src/inference/detect_video.py \
        --source path/to/video.mp4 \
        --weights models/weights/best.pt \
        --output runs/inference/videos
"""

import argparse
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
from tqdm import tqdm
from ultralytics import YOLO

from src.utils.config import load_config
from src.utils.helper_functions import (
    draw_detections,
    draw_fps,
    ensure_dir,
    generate_color_palette,
)
from src.utils.logger import get_logger

logger = get_logger(__name__)

CLASS_NAMES = [
    "pedestrian", "bicycle", "car", "motorcycle",
    "bus", "truck", "traffic_light", "stop_sign",
]


# ─── Video Detector ───────────────────────────────────────────────────────────

class VideoDetector:
    """
    Frame-by-frame obstacle detection on video files.

    Args:
        weights:        Path to YOLOv8 model weights.
        conf_threshold: Minimum confidence threshold.
        iou_threshold:  IoU threshold for NMS.
        max_det:        Maximum detections per frame.
        device:         Compute device.
        half:           FP16 inference.
        class_names:    Class name list.
        frame_skip:     Process every N-th frame (1 = all frames).
    """

    def __init__(
        self,
        weights: str = "models/weights/best.pt",
        conf_threshold: float = 0.35,
        iou_threshold: float = 0.45,
        max_det: int = 100,
        device: str = "0",
        half: bool = False,
        class_names: Optional[List[str]] = None,
        frame_skip: int = 1,
    ):
        self.conf = conf_threshold
        self.iou = iou_threshold
        self.max_det = max_det
        self.device = device
        self.half = half
        self.class_names = class_names or CLASS_NAMES
        self.colors = generate_color_palette(len(self.class_names))
        self.frame_skip = max(1, frame_skip)

        logger.info(f"Loading model: {weights}")
        self.model = YOLO(weights)
        logger.info("VideoDetector ready.")

    # ── Main Process ──────────────────────────────────────────────────────────

    def process_video(
        self,
        source: str,
        output_dir: str = "runs/inference/videos",
        show: bool = False,
        save_stats: bool = True,
    ) -> Dict[str, Any]:
        """
        Detect obstacles in every frame of a video file.

        Args:
            source:     Path to input video file.
            output_dir: Directory to save the annotated output video.
            show:       Display each frame in a window (requires display).
            save_stats: Save per-frame detection stats as JSON.

        Returns:
            Dictionary with processing statistics.
        """
        source = Path(source)
        if not source.exists():
            raise FileNotFoundError(f"Video not found: {source}")

        output_dir = ensure_dir(output_dir)
        out_path = output_dir / f"{source.stem}_detected.mp4"

        cap = cv2.VideoCapture(str(source))
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video: {source}")

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps_src = cap.get(cv2.CAP_PROP_FPS)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        logger.info(
            f"Video: {source.name} | {width}x{height} | "
            f"{fps_src:.1f} FPS | {total_frames} frames"
        )

        # Video writer
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(str(out_path), fourcc, fps_src, (width, height))

        frame_stats: List[Dict] = []
        fps_counter = _FPSCounter()
        processed = 0

        for frame_idx in tqdm(range(total_frames), desc="Processing video"):
            ret, frame = cap.read()
            if not ret:
                break

            # Skip frames if requested
            if frame_idx % self.frame_skip != 0 and processed > 0:
                writer.write(frame)
                continue

            fps_counter.tick()
            t0 = time.perf_counter()

            # Run inference
            results = self.model.predict(
                source=frame,
                conf=self.conf,
                iou=self.iou,
                max_det=self.max_det,
                device=self.device,
                half=self.half,
                verbose=False,
            )

            elapsed_ms = (time.perf_counter() - t0) * 1000
            fps_val = fps_counter.fps()

            # Parse detections
            boxes, labels, confs, det_colors = [], [], [], []
            frame_dets = []

            for result in results:
                if result.boxes is None:
                    continue
                for box in result.boxes:
                    cls_id = int(box.cls.item())
                    conf_val = float(box.conf.item())
                    xyxy = box.xyxy[0].tolist()
                    cls_name = (
                        self.class_names[cls_id]
                        if cls_id < len(self.class_names)
                        else str(cls_id)
                    )
                    boxes.append(xyxy)
                    labels.append(cls_name)
                    confs.append(conf_val)
                    det_colors.append(self.colors[cls_id % len(self.colors)])
                    frame_dets.append({
                        "class_id": cls_id,
                        "class_name": cls_name,
                        "confidence": round(conf_val, 4),
                        "bbox": [round(v, 2) for v in xyxy],
                    })

            # Draw
            annotated = draw_detections(frame, boxes, labels, confs, det_colors)
            annotated = draw_fps(annotated, fps_val)

            # Frame info overlay
            cv2.putText(
                annotated,
                f"Frame: {frame_idx}/{total_frames}  Det: {len(frame_dets)}",
                (10, 60),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1,
            )

            writer.write(annotated)
            frame_stats.append({
                "frame": frame_idx,
                "detections": frame_dets,
                "inference_ms": round(elapsed_ms, 2),
                "fps": round(fps_val, 2),
            })
            processed += 1

            if show:
                cv2.imshow("Obstacle Detection", annotated)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    logger.info("Stopped by user (Q key).")
                    break

        cap.release()
        writer.release()
        if show:
            cv2.destroyAllWindows()

        # ── Summary ───────────────────────────────────────────────────────────
        total_dets = sum(len(f["detections"]) for f in frame_stats)
        avg_fps = sum(f["fps"] for f in frame_stats) / max(1, len(frame_stats))
        avg_ms = sum(f["inference_ms"] for f in frame_stats) / max(1, len(frame_stats))

        stats = {
            "source": str(source),
            "output": str(out_path),
            "total_frames": total_frames,
            "processed_frames": processed,
            "total_detections": total_dets,
            "avg_fps": round(avg_fps, 2),
            "avg_inference_ms": round(avg_ms, 2),
        }

        logger.info(
            f"Done | Output: {out_path} | "
            f"Avg FPS: {avg_fps:.1f} | Avg Inf: {avg_ms:.1f} ms"
        )

        if save_stats:
            stats_path = output_dir / f"{source.stem}_stats.json"
            stats_path.write_text(
                json.dumps({"summary": stats, "frames": frame_stats}, indent=2)
            )
            logger.info(f"Stats saved: {stats_path}")

        return stats


# ─── FPS Counter ─────────────────────────────────────────────────────────────

class _FPSCounter:
    """Rolling average FPS counter."""

    def __init__(self, window: int = 30):
        self._window = window
        self._times: List[float] = []

    def tick(self) -> None:
        self._times.append(time.perf_counter())
        if len(self._times) > self._window:
            self._times.pop(0)

    def fps(self) -> float:
        if len(self._times) < 2:
            return 0.0
        return (len(self._times) - 1) / (self._times[-1] - self._times[0] + 1e-9)


# ─── CLI ─────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Obstacle detection on video",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--source", required=True, help="Input video path.")
    parser.add_argument("--weights", default="models/weights/best.pt")
    parser.add_argument("--config", default="configs/training_config.yaml")
    parser.add_argument("--conf", type=float, default=None)
    parser.add_argument("--iou", type=float, default=None)
    parser.add_argument("--output", default="runs/inference/videos")
    parser.add_argument("--device", default="0")
    parser.add_argument("--half", action="store_true")
    parser.add_argument("--frame-skip", type=int, default=1,
                        help="Process every N-th frame.")
    parser.add_argument("--show", action="store_true",
                        help="Display frames in real time.")
    parser.add_argument("--no-stats", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cfg = load_config(args.config)
    inf_cfg = cfg.inference

    detector = VideoDetector(
        weights=args.weights,
        conf_threshold=args.conf or inf_cfg.get("conf_threshold", 0.35),
        iou_threshold=args.iou or inf_cfg.get("iou_threshold", 0.45),
        device=args.device,
        half=args.half or inf_cfg.get("half", False),
        frame_skip=args.frame_skip,
    )

    detector.process_video(
        source=args.source,
        output_dir=args.output,
        show=args.show,
        save_stats=not args.no_stats,
    )


if __name__ == "__main__":
    main()
