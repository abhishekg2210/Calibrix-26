"""
detect_webcam.py
----------------
Real-time obstacle detection from webcam or RTSP/HTTP camera streams.

Features:
  - Live bounding boxes, labels, and confidence scores
  - FPS counter
  - Press 'q' to quit, 's' to save the current frame, 'r' to record video

Usage:
    python src/inference/detect_webcam.py --weights models/weights/best.pt
    python src/inference/detect_webcam.py --source 0 --weights models/weights/best.pt
    python src/inference/detect_webcam.py --source rtsp://cam_ip/stream
"""

import argparse
import time
from pathlib import Path
from typing import List, Optional, Tuple

import cv2
import numpy as np
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


# ─── Webcam Detector ──────────────────────────────────────────────────────────

class WebcamDetector:
    """
    Real-time obstacle detection on live camera streams.

    Args:
        weights:        Path to model weights.
        conf_threshold: Detection confidence threshold.
        iou_threshold:  NMS IoU threshold.
        max_det:        Max detections per frame.
        device:         Compute device.
        half:           FP16 inference.
        class_names:    Override class names.
        display_size:   ``(width, height)`` to resize the display window.
    """

    def __init__(
        self,
        weights: str = "models/weights/best.pt",
        conf_threshold: float = 0.40,
        iou_threshold: float = 0.45,
        max_det: int = 50,
        device: str = "0",
        half: bool = False,
        class_names: Optional[List[str]] = None,
        display_size: Optional[Tuple[int, int]] = None,
    ):
        self.conf = conf_threshold
        self.iou = iou_threshold
        self.max_det = max_det
        self.device = device
        self.half = half
        self.class_names = class_names or CLASS_NAMES
        self.colors = generate_color_palette(len(self.class_names))
        self.display_size = display_size  # (width, height)

        logger.info(f"Loading model: {weights}")
        self.model = YOLO(weights)
        logger.info("WebcamDetector ready.")

    # ── Live Detection Loop ────────────────────────────────────────────────────

    def run(
        self,
        source: int = 0,
        output_dir: str = "runs/inference/webcam",
        window_name: str = "Autonomous Obstacle Detection",
    ) -> None:
        """
        Open a camera stream and run detection in a continuous loop.

        Keyboard controls:
          - ``q``:  Quit
          - ``s``:  Save current annotated frame as PNG
          - ``r``:  Toggle video recording

        Args:
            source:      Camera index (int) or stream URL (str).
            output_dir:  Directory for saved frames / recordings.
            window_name: OpenCV window title.
        """
        output_dir = ensure_dir(output_dir)

        cap = cv2.VideoCapture(source)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open camera source: {source}")

        # Get camera properties
        cam_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        cam_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        cam_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        logger.info(f"Camera opened: {cam_w}x{cam_h} @ {cam_fps:.1f} FPS")

        fps_counter = _FPSCounter()
        recording = False
        writer: Optional[cv2.VideoWriter] = None
        frame_count = 0
        saved_count = 0

        cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
        if self.display_size:
            cv2.resizeWindow(window_name, *self.display_size)

        logger.info("Starting webcam detection. Press 'q'=quit | 's'=save | 'r'=record")

        try:
            while True:
                ret, frame = cap.read()
                if not ret:
                    logger.warning("Frame capture failed — retrying...")
                    time.sleep(0.05)
                    continue

                fps_counter.tick()
                fps_val = fps_counter.fps()
                frame_count += 1

                # ── Inference ─────────────────────────────────────────────
                results = self.model.predict(
                    source=frame,
                    conf=self.conf,
                    iou=self.iou,
                    max_det=self.max_det,
                    device=self.device,
                    half=self.half,
                    verbose=False,
                )

                # Parse detections
                boxes, labels, confs, det_colors = [], [], [], []
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

                # Annotate
                annotated = draw_detections(frame, boxes, labels, confs, det_colors)
                annotated = draw_fps(annotated, fps_val)
                annotated = self._draw_status(
                    annotated, frame_count, len(boxes), recording
                )

                # ── Recording ────────────────────────────────────────────
                if recording and writer is not None:
                    writer.write(annotated)

                # ── Display ──────────────────────────────────────────────
                cv2.imshow(window_name, annotated)
                key = cv2.waitKey(1) & 0xFF

                if key == ord("q"):
                    logger.info("Quit signal received.")
                    break
                elif key == ord("s"):
                    save_path = output_dir / f"frame_{frame_count:06d}.png"
                    cv2.imwrite(str(save_path), annotated)
                    saved_count += 1
                    logger.info(f"Frame saved: {save_path}")
                elif key == ord("r"):
                    if not recording:
                        rec_path = output_dir / f"recording_{int(time.time())}.mp4"
                        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
                        writer = cv2.VideoWriter(
                            str(rec_path), fourcc, cam_fps, (cam_w, cam_h)
                        )
                        recording = True
                        logger.info(f"Recording started: {rec_path}")
                    else:
                        if writer:
                            writer.release()
                            writer = None
                        recording = False
                        logger.info("Recording stopped.")

        except KeyboardInterrupt:
            logger.info("Interrupted by user.")
        finally:
            cap.release()
            if writer:
                writer.release()
            cv2.destroyAllWindows()
            logger.info(
                f"Session ended | Frames: {frame_count} | "
                f"Saved: {saved_count}"
            )

    # ── Overlays ──────────────────────────────────────────────────────────────

    @staticmethod
    def _draw_status(
        img: np.ndarray,
        frame_idx: int,
        num_dets: int,
        recording: bool,
    ) -> np.ndarray:
        """Overlay frame index, detection count, and recording indicator."""
        img = img.copy()
        h, w = img.shape[:2]

        # Status bar background
        cv2.rectangle(img, (0, h - 30), (w, h), (30, 30, 30), -1)

        cv2.putText(
            img,
            f"Frame: {frame_idx}  |  Detections: {num_dets}",
            (10, h - 8),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (200, 200, 200), 1,
        )

        if recording:
            cv2.circle(img, (w - 20, h - 15), 7, (0, 0, 255), -1)
            cv2.putText(img, "REC", (w - 55, h - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)

        return img


# ─── FPS Counter ─────────────────────────────────────────────────────────────

class _FPSCounter:
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
        description="Real-time obstacle detection from webcam",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--source", default="0",
                        help="Camera index (0) or stream URL.")
    parser.add_argument("--weights", default="models/weights/best.pt")
    parser.add_argument("--config", default="configs/training_config.yaml")
    parser.add_argument("--conf", type=float, default=None)
    parser.add_argument("--iou", type=float, default=None)
    parser.add_argument("--device", default="0")
    parser.add_argument("--half", action="store_true")
    parser.add_argument("--output", default="runs/inference/webcam")
    parser.add_argument("--display-width", type=int, default=1280)
    parser.add_argument("--display-height", type=int, default=720)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    cfg = load_config(args.config)
    inf_cfg = cfg.inference

    # Parse source: integer camera index or string URL/path
    try:
        source = int(args.source)
    except ValueError:
        source = args.source

    detector = WebcamDetector(
        weights=args.weights,
        conf_threshold=args.conf or inf_cfg.get("conf_threshold", 0.40),
        iou_threshold=args.iou or inf_cfg.get("iou_threshold", 0.45),
        device=args.device,
        half=args.half or inf_cfg.get("half", False),
        display_size=(args.display_width, args.display_height),
    )

    detector.run(source=source, output_dir=args.output)


if __name__ == "__main__":
    main()
