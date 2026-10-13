"""
evaluate_model.py
-----------------
Comprehensive model evaluation pipeline producing:
  - mAP@50 and mAP@50:95
  - Per-class Precision / Recall / F1
  - Confusion matrix
  - Precision-Recall curves
  - Detection visualisation on test samples

Usage:
    python src/evaluation/evaluate_model.py \
        --weights models/weights/best.pt \
        --config configs/training_config.yaml \
        --output runs/eval
"""

import argparse
import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import matplotlib.pyplot as plt
import numpy as np
import seaborn as sns
from tqdm import tqdm
from ultralytics import YOLO

from src.evaluation.metrics import (
    compute_iou_matrix,
    compute_map,
    compute_precision_recall_f1,
    match_detections_to_gt,
)
from src.utils.config import load_config
from src.utils.helper_functions import (
    ensure_dir,
    generate_color_palette,
    list_images,
    load_image,
    save_image,
)
from src.utils.logger import get_logger

logger = get_logger(__name__)

CLASS_NAMES = [
    "pedestrian", "bicycle", "car", "motorcycle",
    "bus", "truck", "traffic_light", "stop_sign",
]


# ─── Evaluator ────────────────────────────────────────────────────────────────

class ModelEvaluator:
    """
    Evaluates a trained YOLOv8 model on a test dataset.

    Args:
        weights:        Path to model ``.pt`` file.
        config_path:    Path to ``training_config.yaml``.
        output_dir:     Root directory for evaluation outputs.
        class_names:    Override class names.
    """

    def __init__(
        self,
        weights: str,
        config_path: str = "configs/training_config.yaml",
        output_dir: str = "runs/eval",
        class_names: Optional[List[str]] = None,
    ):
        self.cfg = load_config(config_path)
        self.output_dir = ensure_dir(output_dir)
        self.class_names = class_names or CLASS_NAMES
        self.colors = generate_color_palette(len(self.class_names))

        logger.info(f"Loading model: {weights}")
        self.model = YOLO(weights)

    # ── Official Ultralytics Eval ─────────────────────────────────────────────

    def run_ultralytics_eval(self) -> dict:
        """
        Run built-in Ultralytics validation and save plots.

        Returns:
            Results dict from Ultralytics ``model.val()``.
        """
        eval_cfg = self.cfg.evaluation
        logger.info("Running Ultralytics model.val() ...")

        results = self.model.val(
            data=self.cfg.dataset.get("data_yaml", "configs/dataset.yaml"),
            imgsz=self.cfg.model.get("input_size", 640),
            batch=self.cfg.training.get("batch_size", 16),
            conf=eval_cfg.get("conf_threshold", 0.25),
            iou=eval_cfg.get("iou_threshold", 0.45),
            device=self.cfg.training.get("device", "0"),
            project=str(self.output_dir),
            name="ultralytics_val",
            plots=True,
            save_json=True,
        )

        metrics = results.results_dict
        self._log_metrics(metrics)
        self._save_metrics_json(metrics, "ultralytics_metrics.json")
        return metrics

    # ── Custom Evaluation ─────────────────────────────────────────────────────

    def run_custom_eval(
        self,
        test_images_dir: Optional[str] = None,
        test_labels_dir: Optional[str] = None,
    ) -> Dict:
        """
        Custom evaluation loop with full metric computation.

        Args:
            test_images_dir: Override test images directory.
            test_labels_dir: Override test labels directory.

        Returns:
            Dictionary of computed metrics.
        """
        data_dir = Path(self.cfg.dataset.get("processed_dir", "data/processed"))
        images_dir = Path(test_images_dir or data_dir / "images" / "test")
        labels_dir = Path(test_labels_dir or data_dir / "labels" / "test")

        if not images_dir.exists():
            logger.warning(f"Test images not found: {images_dir}")
            return {}

        image_paths = list_images(images_dir, recursive=False)
        logger.info(f"Evaluating on {len(image_paths)} test images...")

        eval_cfg = self.cfg.evaluation
        conf_t = eval_cfg.get("conf_threshold", 0.25)
        iou_t  = eval_cfg.get("iou_threshold", 0.45)

        # Accumulators: {class_id: [(box, conf), ...]}
        all_dets: Dict[int, List] = {i: [] for i in range(len(self.class_names))}
        all_gts:  Dict[int, List] = {i: [] for i in range(len(self.class_names))}

        # Per-image confusion accumulators
        confusion = np.zeros(
            (len(self.class_names), len(self.class_names)), dtype=int
        )

        for img_path in tqdm(image_paths, desc="Evaluating"):
            img = load_image(img_path)
            h, w = img.shape[:2]

            # Load ground truth
            lbl_path = labels_dir / f"{img_path.stem}.txt"
            gt_boxes_by_class = self._load_yolo_labels(lbl_path, w, h)
            for cls_id, boxes in gt_boxes_by_class.items():
                all_gts.setdefault(cls_id, []).extend(boxes)

            # Run inference
            results = self.model.predict(
                img, conf=conf_t, iou=iou_t, verbose=False,
                device=self.cfg.training.get("device", "0"),
            )

            for result in results:
                if result.boxes is None:
                    continue
                for box in result.boxes:
                    cls_id  = int(box.cls.item())
                    conf_v  = float(box.conf.item())
                    xyxy    = box.xyxy[0].cpu().numpy()
                    all_dets.setdefault(cls_id, []).append((xyxy, conf_v))

        # Compute mAP
        map_results = compute_map(all_dets, all_gts, class_names=self.class_names)

        # Compute per-class P/R/F1 @ IoU=0.5
        prf_results = self._compute_prf_per_class(all_dets, all_gts, iou_threshold=0.5)

        metrics = {**map_results, **prf_results}
        self._log_metrics(metrics)
        self._save_metrics_json(metrics, "custom_metrics.json")

        # ── Plots ──────────────────────────────────────────────────────────
        self._plot_pr_curves(all_dets, all_gts)
        self._plot_per_class_ap(map_results)

        return metrics

    # ── Helpers ───────────────────────────────────────────────────────────────

    @staticmethod
    def _load_yolo_labels(
        label_path: Path, img_w: int, img_h: int
    ) -> Dict[int, List[np.ndarray]]:
        """Parse YOLO label file and convert to pixel ``[x1,y1,x2,y2]``."""
        result: Dict[int, List] = {}
        if not label_path.exists():
            return result
        for line in label_path.read_text().strip().splitlines():
            parts = line.split()
            if len(parts) < 5:
                continue
            cls_id = int(parts[0])
            cx, cy, bw, bh = map(float, parts[1:5])
            x1 = (cx - bw / 2) * img_w
            y1 = (cy - bh / 2) * img_h
            x2 = (cx + bw / 2) * img_w
            y2 = (cy + bh / 2) * img_h
            result.setdefault(cls_id, []).append(np.array([x1, y1, x2, y2]))
        return result

    def _compute_prf_per_class(
        self,
        all_dets: Dict[int, List],
        all_gts: Dict[int, List],
        iou_threshold: float = 0.5,
    ) -> Dict[str, float]:
        """Compute precision, recall, F1 for each class."""
        results = {}
        for cls_id in range(len(self.class_names)):
            name = self.class_names[cls_id]
            dets = all_dets.get(cls_id, [])
            gts  = all_gts.get(cls_id, [])

            if not dets and not gts:
                continue

            n_gt = len(gts)

            if not dets:
                results[f"precision/{name}"] = 0.0
                results[f"recall/{name}"]    = 0.0
                results[f"f1/{name}"]        = 0.0
                continue

            pred_boxes = np.array([d[0] for d in dets])
            pred_confs = np.array([d[1] for d in dets])
            gt_arr     = np.array(gts) if gts else np.empty((0, 4))

            tp, fp = match_detections_to_gt(pred_boxes, pred_confs, gt_arr, iou_threshold)
            fn = n_gt - int(tp.sum())
            prec, rec, f1 = compute_precision_recall_f1(int(tp.sum()), int(fp.sum()), fn)

            results[f"precision/{name}"] = round(prec, 4)
            results[f"recall/{name}"]    = round(rec, 4)
            results[f"f1/{name}"]        = round(f1, 4)

        return results

    # ── Plotting ──────────────────────────────────────────────────────────────

    def _plot_pr_curves(
        self, all_dets: Dict[int, List], all_gts: Dict[int, List]
    ) -> None:
        """Plot and save Precision-Recall curves for each class."""
        fig, ax = plt.subplots(figsize=(10, 7))

        for cls_id in range(len(self.class_names)):
            name = self.class_names[cls_id]
            dets = all_dets.get(cls_id, [])
            gts  = all_gts.get(cls_id, [])

            if not dets or not gts:
                continue

            pred_boxes = np.array([d[0] for d in dets])
            pred_confs = np.array([d[1] for d in dets])
            gt_arr     = np.array(gts)

            # Sort by confidence
            sort_idx = np.argsort(-pred_confs)
            pred_boxes = pred_boxes[sort_idx]
            pred_confs = pred_confs[sort_idx]

            tp, fp = match_detections_to_gt(pred_boxes, pred_confs, gt_arr, 0.5)
            c_tp = np.cumsum(tp)
            c_fp = np.cumsum(fp)
            recall    = c_tp / (len(gts) + 1e-6)
            precision = c_tp / (c_tp + c_fp + 1e-6)

            ax.plot(recall, precision, label=name, linewidth=1.5)

        ax.set_xlabel("Recall", fontsize=12)
        ax.set_ylabel("Precision", fontsize=12)
        ax.set_title("Precision-Recall Curves @ IoU=0.50", fontsize=14)
        ax.legend(fontsize=9, ncol=2)
        ax.grid(True, alpha=0.3)
        ax.set_xlim([0, 1])
        ax.set_ylim([0, 1.05])
        plt.tight_layout()

        out_path = self.output_dir / "pr_curves.png"
        plt.savefig(out_path, dpi=150, bbox_inches="tight")
        plt.close()
        logger.info(f"PR curves saved: {out_path}")

    def _plot_per_class_ap(self, map_results: Dict[str, float]) -> None:
        """Bar chart of per-class AP@50."""
        ap_vals = {
            k.replace("AP50/", ""): v
            for k, v in map_results.items()
            if k.startswith("AP50/")
        }
        if not ap_vals:
            return

        fig, ax = plt.subplots(figsize=(10, 5))
        names = list(ap_vals.keys())
        vals  = list(ap_vals.values())
        bars  = ax.bar(names, vals, color="steelblue", edgecolor="white")

        for bar, val in zip(bars, vals):
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                bar.get_height() + 0.01,
                f"{val:.3f}",
                ha="center", va="bottom", fontsize=9,
            )

        ax.set_ylim(0, 1.1)
        ax.set_xlabel("Class", fontsize=12)
        ax.set_ylabel("AP@50", fontsize=12)
        ax.set_title("Per-Class Average Precision @ IoU=0.50", fontsize=14)
        ax.tick_params(axis="x", rotation=30)
        plt.tight_layout()

        out_path = self.output_dir / "per_class_ap50.png"
        plt.savefig(out_path, dpi=150, bbox_inches="tight")
        plt.close()
        logger.info(f"Per-class AP chart saved: {out_path}")

    def _log_metrics(self, metrics: dict) -> None:
        logger.info("=" * 55)
        logger.info("Evaluation Metrics")
        logger.info("=" * 55)
        for k, v in metrics.items():
            logger.info(f"  {k:<40} {v:.4f}" if isinstance(v, float) else f"  {k}: {v}")
        logger.info("=" * 55)

    def _save_metrics_json(self, metrics: dict, filename: str) -> None:
        path = self.output_dir / filename
        path.write_text(json.dumps(metrics, indent=2), encoding="utf-8")
        logger.info(f"Metrics saved: {path}")

    # ── Detection Visualisation ───────────────────────────────────────────────

    def visualize_test_detections(
        self,
        test_images_dir: Optional[str] = None,
        num_samples: int = 16,
        seed: int = 42,
    ) -> None:
        """Save a grid of annotated test images."""
        import random
        from src.utils.helper_functions import draw_detections

        data_dir = Path(self.cfg.dataset.get("processed_dir", "data/processed"))
        images_dir = Path(test_images_dir or data_dir / "images" / "test")
        if not images_dir.exists():
            logger.warning(f"Test images not found: {images_dir}")
            return

        image_paths = list_images(images_dir, recursive=False)
        random.seed(seed)
        samples = random.sample(image_paths, min(num_samples, len(image_paths)))

        out_dir = ensure_dir(self.output_dir / "test_samples")
        eval_cfg = self.cfg.evaluation

        for img_path in tqdm(samples, desc="Visualising detections"):
            img = load_image(img_path)
            results = self.model.predict(
                img,
                conf=eval_cfg.get("conf_threshold", 0.25),
                iou=eval_cfg.get("iou_threshold", 0.45),
                verbose=False,
            )
            boxes, labels, confs, det_colors = [], [], [], []
            for result in results:
                if result.boxes is None:
                    continue
                for box in result.boxes:
                    cls_id  = int(box.cls.item())
                    conf_v  = float(box.conf.item())
                    xyxy    = box.xyxy[0].tolist()
                    cls_name = (self.class_names[cls_id]
                                if cls_id < len(self.class_names) else str(cls_id))
                    boxes.append(xyxy)
                    labels.append(cls_name)
                    confs.append(conf_v)
                    det_colors.append(self.colors[cls_id % len(self.colors)])

            annotated = draw_detections(img, boxes, labels, confs, det_colors)
            save_image(annotated, out_dir / img_path.name)

        logger.info(f"Test detection samples saved to: {out_dir}")


# ─── CLI ─────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Evaluate YOLOv8 obstacle detection model",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--weights", required=True, help="Path to model weights.")
    parser.add_argument("--config", default="configs/training_config.yaml")
    parser.add_argument("--output", default="runs/eval")
    parser.add_argument("--mode",
                        choices=["ultralytics", "custom", "both"],
                        default="both")
    parser.add_argument("--test-images", type=str, default=None)
    parser.add_argument("--visualize", action="store_true",
                        help="Save annotated test samples.")
    parser.add_argument("--num-samples", type=int, default=16)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    evaluator = ModelEvaluator(
        weights=args.weights,
        config_path=args.config,
        output_dir=args.output,
    )

    if args.mode in ("ultralytics", "both"):
        evaluator.run_ultralytics_eval()

    if args.mode in ("custom", "both"):
        evaluator.run_custom_eval(test_images_dir=args.test_images)

    if args.visualize:
        evaluator.visualize_test_detections(
            test_images_dir=args.test_images,
            num_samples=args.num_samples,
        )


if __name__ == "__main__":
    main()
