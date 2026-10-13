"""
detect_image.py
---------------
Run obstacle detection on single images or image directories.

Outputs annotated images with bounding boxes, class labels, and confidence
scores.  Results can also be exported as JSON.

Usage:
    # Single image
    python src/inference/detect_image.py \
        --source path/to/image.jpg \
        --weights models/weights/best.pt \
        --output runs/inference/images

    # Directory
    python src/inference/detect_image.py \
        --source path/to/images/ \
        --weights models/weights/best.pt
"""

import argparse
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import cv2
import numpy as np
from ultralytics import YOLO

from src.utils.config import load_config
from src.utils.helper_functions import (
    draw_detections,
    ensure_dir,
    generate_color_palette,
    list_images,
    load_image,
    save_image,
    timer,
)
from src.utils.logger import get_logger

logger = get_logger(__name__)

CLASS_NAMES = [
    "pedestrian", "bicycle", "car", "motorcycle",
    "bus", "truck", "traffic_light", "stop_sign",
]


# ─── Detector ────────────────────────────────────────────────────────────────

class ImageDetector:
    """
    High-level wrapper for single-image and batch-image YOLOv8 inference.

    Args:
        weights:        Path to YOLOv8 model weights (``.pt`` or ``.onnx``).
        conf_threshold: Minimum confidence to keep a detection.
        iou_threshold:  IoU threshold for NMS.
        max_det:        Maximum detections per image.
        device:         Inference device (``"0"``, ``"cpu"``).
        half:           Use FP16 inference.
        class_names:    List of class name strings.
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
    ):
        self.weights = weights
        self.conf = conf_threshold
        self.iou = iou_threshold
        self.max_det = max_det
        self.device = device
        self.half = half
        self.class_names = class_names or CLASS_NAMES
        self.colors = generate_color_palette(len(self.class_names))

        logger.info(f"Loading model: {weights}")
        self.model = YOLO(weights)
        logger.info(f"Model loaded | device={device} | half={half}")

    # ── Core inference ────────────────────────────────────────────────────────

    def predict(
        self,
        image: Union[str, Path, np.ndarray],
    ) -> Tuple[np.ndarray, List[Dict[str, Any]]]:
        """
        Run inference on a single image.

        Args:
            image: Image path or BGR NumPy array.

        Returns:
            Tuple of (annotated_bgr_image, list_of_detection_dicts).
            Each detection dict has keys: ``class_id``, ``class_name``,
            ``confidence``, ``bbox`` (``[x1, y1, x2, y2]``).
        """
        if isinstance(image, (str, Path)):
            img = load_image(image)
        else:
            img = image.copy()

        results = self.model.predict(
            source=img,
            conf=self.conf,
            iou=self.iou,
            max_det=self.max_det,
            device=self.device,
            half=self.half,
            verbose=False,
        )

        detections: List[Dict[str, Any]] = []
        boxes_list: List[List[float]] = []
        labels_list: List[str] = []
        confs_list: List[float] = []
        det_colors: List[Tuple[int, int, int]] = []

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
                    else result.names.get(cls_id, str(cls_id))
                )

                detections.append({
                    "class_id":   cls_id,
                    "class_name": cls_name,
                    "confidence": round(conf_val, 4),
                    "bbox":       [round(v, 2) for v in xyxy],
                })
                boxes_list.append(xyxy)
                labels_list.append(cls_name)
                confs_list.append(conf_val)
                det_colors.append(self.colors[cls_id % len(self.colors)])

        annotated = draw_detections(img, boxes_list, labels_list, confs_list, det_colors)
        return annotated, detections

    # ── Batch processing ──────────────────────────────────────────────────────

    def detect_directory(
        self,
        source_dir: Union[str, Path],
        output_dir: Union[str, Path],
        save_json: bool = True,
    ) -> Dict[str, List[Dict]]:
        """
        Run inference on all images in a directory.

        Args:
            source_dir: Directory containing input images.
            output_dir: Directory to write annotated images.
            save_json:  If True, save per-image detections as JSON.

        Returns:
            Dictionary mapping filename to list of detection dicts.
        """
        source_dir = Path(source_dir)
        output_dir = ensure_dir(output_dir)
        image_paths = list_images(source_dir, recursive=False)

        if not image_paths:
            logger.warning(f"No images found in {source_dir}")
            return {}

        logger.info(f"Detecting {len(image_paths)} images in {source_dir}")
        all_results: Dict[str, List[Dict]] = {}
        total_time = 0.0

        for img_path in image_paths:
            t0 = time.perf_counter()
            annotated, dets = self.predict(img_path)
            elapsed = time.perf_counter() - t0
            total_time += elapsed

            # Save annotated image
            out_img_path = output_dir / img_path.name
            save_image(annotated, out_img_path)
            all_results[img_path.name] = dets

            logger.info(
                f"{img_path.name}: {len(dets)} detections | "
                f"{elapsed * 1000:.1f} ms"
            )

        avg_ms = total_time / len(image_paths) * 1000
        logger.info(f"Avg inference: {avg_ms:.1f} ms | FPS: {1000/avg_ms:.1f}")

        if save_json:
            json_path = output_dir / "detections.json"
            json_path.write_text(
                json.dumps(all_results, indent=2), encoding="utf-8"
            )
            logger.info(f"Detections saved: {json_path}")

        return all_results


# ─── CLI ─────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Obstacle detection on images",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--source", type=str, required=True,
                        help="Image path or directory.")
    parser.add_argument("--weights", type=str, default="models/weights/best.pt")
    parser.add_argument("--config", type=str, default="configs/training_config.yaml")
    parser.add_argument("--conf", type=float, default=None)
    parser.add_argument("--iou", type=float, default=None)
    parser.add_argument("--output", type=str, default="runs/inference/images")
    parser.add_argument("--device", type=str, default="0")
    parser.add_argument("--half", action="store_true", help="Use FP16 inference.")
    parser.add_argument("--no-save-json", action="store_true")
    parser.add_argument("--show", action="store_true",
                        help="Display result with OpenCV window.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    cfg = load_config(args.config)
    inf_cfg = cfg.inference

    detector = ImageDetector(
        weights=args.weights,
        conf_threshold=args.conf or inf_cfg.get("conf_threshold", 0.35),
        iou_threshold=args.iou or inf_cfg.get("iou_threshold", 0.45),
        device=args.device,
        half=args.half or inf_cfg.get("half", False),
    )

    source = Path(args.source)

    if source.is_dir():
        detector.detect_directory(
            source, args.output, save_json=not args.no_save_json
        )
    else:
        annotated, dets = detector.predict(source)

        out_dir = ensure_dir(args.output)
        out_path = out_dir / source.name
        save_image(annotated, out_path)
        logger.info(f"Result saved: {out_path}")

        if not args.no_save_json:
            json_path = out_dir / f"{source.stem}_detections.json"
            json_path.write_text(json.dumps(dets, indent=2))

        # Print detections summary
        for det in dets:
            print(f"  {det['class_name']:<16} {det['confidence']:.2f}  "
                  f"bbox={det['bbox']}")

        if args.show:
            cv2.imshow("Detection Result", annotated)
            cv2.waitKey(0)
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
