"""
train.py
--------
Production training pipeline for YOLOv8-based obstacle detection.

Features:
  - Transfer learning from pre-trained YOLOv8 weights
  - Configurable model variants (n / s / m / l / x)
  - Full augmentation suite
  - Learning rate scheduling (cosine)
  - Early stopping
  - AMP (FP16) training
  - Experiment logging
  - Post-training metric summary

Usage:
    python src/training/train.py --config configs/training_config.yaml
    python src/training/train.py --config configs/training_config.yaml \
        --model yolov8s --epochs 50 --batch 32
"""

import argparse
import os
import shutil
import sys
from pathlib import Path
from typing import Optional

import torch
import yaml
from ultralytics import YOLO

from src.utils.config import load_config
from src.utils.helper_functions import get_device_info, set_seed
from src.utils.logger import get_logger, setup_project_logger

logger = get_logger(__name__)


# ─── Trainer Class ────────────────────────────────────────────────────────────

class ObstacleDetectionTrainer:
    """
    Encapsulates the full YOLOv8 training pipeline.

    Args:
        config_path: Path to the YAML training configuration file.
        overrides:   Dict of dot-notation config overrides, e.g.
                     ``{"training.epochs": 50}``.
    """

    def __init__(self, config_path: str, overrides: Optional[dict] = None):
        self.cfg = load_config(config_path, overrides=overrides)
        self.logger = setup_project_logger(self.cfg)
        set_seed(self.cfg.get("project", {}).get("seed", 42))
        self._log_environment()

    # ── Setup ─────────────────────────────────────────────────────────────────

    def _log_environment(self) -> None:
        """Log runtime environment information."""
        info = get_device_info()
        self.logger.info("=" * 60)
        self.logger.info(" Autonomous Vehicle Obstacle Detection — Training")
        self.logger.info("=" * 60)
        for k, v in info.items():
            self.logger.info(f"  {k}: {v}")
        self.logger.info("=" * 60)

    def _resolve_model(self) -> YOLO:
        """
        Load a YOLO model from pretrained weights or a custom checkpoint.

        Returns:
            Initialised :class:`ultralytics.YOLO` model.
        """
        model_cfg = self.cfg.model
        weights = model_cfg.get("pretrained_weights", "yolov8m.pt")
        arch = model_cfg.get("architecture", "yolov8m")

        # Check for existing checkpoint (resume)
        if self.cfg.training.get("resume", False):
            checkpoint_dir = Path(self.cfg.model.get("checkpoints_dir", "models/checkpoints"))
            last_ckpt = checkpoint_dir / "last.pt"
            if last_ckpt.exists():
                self.logger.info(f"Resuming from checkpoint: {last_ckpt}")
                return YOLO(str(last_ckpt))

        # Use pretrained weights
        weights_dir = Path(model_cfg.get("weights_dir", "models/weights"))
        weights_dir.mkdir(parents=True, exist_ok=True)

        if Path(weights).exists():
            self.logger.info(f"Loading weights: {weights}")
            return YOLO(weights)

        # Download standard YOLOv8 weights
        self.logger.info(f"Loading pretrained YOLOv8: {weights}")
        return YOLO(weights)

    # ── Training ──────────────────────────────────────────────────────────────

    def train(self) -> dict:
        """
        Execute the full training run.

        Returns:
            Dictionary of final training metrics.
        """
        t_cfg = self.cfg.training
        m_cfg = self.cfg.model
        a_cfg = self.cfg.augmentation

        model = self._resolve_model()

        # Build training arguments
        train_args = {
            # Dataset
            "data":         self.cfg.dataset.get("data_yaml", "configs/dataset.yaml"),
            "imgsz":        m_cfg.get("input_size", 640),
            "cache":        t_cfg.get("cache", False),

            # Hardware
            "device":       t_cfg.get("device", "0"),
            "workers":      t_cfg.get("workers", 8),
            "amp":          t_cfg.get("amp", True),

            # Training duration
            "epochs":       t_cfg.get("epochs", 100),
            "batch":        t_cfg.get("batch_size", 16),
            "patience":     t_cfg.get("patience", 20),

            # Optimiser
            "optimizer":    t_cfg.get("optimizer", "AdamW"),
            "lr0":          t_cfg.get("lr0", 0.001),
            "lrf":          t_cfg.get("lrf", 0.01),
            "momentum":     t_cfg.get("momentum", 0.937),
            "weight_decay": t_cfg.get("weight_decay", 0.0005),

            # LR Warmup
            "warmup_epochs":     t_cfg.get("warmup_epochs", 3.0),
            "warmup_momentum":   t_cfg.get("warmup_momentum", 0.8),
            "warmup_bias_lr":    t_cfg.get("warmup_bias_lr", 0.1),

            # Scheduler
            "cos_lr":       t_cfg.get("cos_lr", True),

            # Loss
            "box":          t_cfg.get("box_loss_gain", 7.5),
            "cls":          t_cfg.get("cls_loss_gain", 0.5),
            "dfl":          t_cfg.get("dfl_loss_gain", 1.5),

            # Augmentation
            "hsv_h":        a_cfg.get("hsv_h", 0.015),
            "hsv_s":        a_cfg.get("hsv_s", 0.7),
            "hsv_v":        a_cfg.get("hsv_v", 0.4),
            "degrees":      a_cfg.get("degrees", 0.0),
            "translate":    a_cfg.get("translate", 0.1),
            "scale":        a_cfg.get("scale", 0.5),
            "shear":        a_cfg.get("shear", 0.0),
            "perspective":  a_cfg.get("perspective", 0.0),
            "flipud":       a_cfg.get("flipud", 0.0),
            "fliplr":       a_cfg.get("fliplr", 0.5),
            "mosaic":       a_cfg.get("mosaic", 1.0),
            "mixup":        a_cfg.get("mixup", 0.0),
            "copy_paste":   a_cfg.get("copy_paste", 0.0),

            # Logging / Saving
            "project":      t_cfg.get("project_dir", "runs/train"),
            "name":         t_cfg.get("experiment_name", "obstacle_detection_v1"),
            "save_period":  self.cfg.logging.get("save_period", 10),
            "plots":        True,
            "verbose":      True,
        }

        self.logger.info("Starting training with the following configuration:")
        for k, v in train_args.items():
            self.logger.info(f"  {k}: {v}")

        # ── Run training ──────────────────────────────────────────────────────
        results = model.train(**train_args)

        # ── Post-training ─────────────────────────────────────────────────────
        self._copy_best_weights(train_args["project"], train_args["name"])
        self._log_results(results)

        return results

    def _copy_best_weights(self, project_dir: str, experiment_name: str) -> None:
        """Copy best.pt from the run directory to models/weights/."""
        run_dir = Path(project_dir) / experiment_name
        best_pt = run_dir / "weights" / "best.pt"
        if best_pt.exists():
            weights_dir = Path(self.cfg.model.get("weights_dir", "models/weights"))
            weights_dir.mkdir(parents=True, exist_ok=True)
            dst = weights_dir / "best.pt"
            shutil.copy2(str(best_pt), str(dst))
            self.logger.info(f"Best weights saved to: {dst}")

        last_pt = run_dir / "weights" / "last.pt"
        if last_pt.exists():
            ckpt_dir = Path(self.cfg.model.get("checkpoints_dir", "models/checkpoints"))
            ckpt_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(last_pt), str(ckpt_dir / "last.pt"))

    def _log_results(self, results) -> None:
        """Log final training metrics."""
        try:
            metrics = results.results_dict
            self.logger.info("=" * 60)
            self.logger.info("Training Complete — Final Metrics")
            self.logger.info("=" * 60)
            for key, val in metrics.items():
                self.logger.info(f"  {key}: {val:.4f}" if isinstance(val, float) else f"  {key}: {val}")
        except Exception as exc:
            self.logger.warning(f"Could not parse results: {exc}")

    # ── Validation Only ───────────────────────────────────────────────────────

    def validate(self, weights: Optional[str] = None) -> dict:
        """
        Run validation on the best model.

        Args:
            weights: Path to model weights.  Defaults to ``models/weights/best.pt``.

        Returns:
            Validation metrics dictionary.
        """
        if weights is None:
            weights = str(
                Path(self.cfg.model.get("weights_dir", "models/weights")) / "best.pt"
            )

        model = YOLO(weights)
        eval_cfg = self.cfg.evaluation

        metrics = model.val(
            data=self.cfg.dataset.get("data_yaml", "configs/dataset.yaml"),
            imgsz=self.cfg.model.get("input_size", 640),
            batch=self.cfg.training.get("batch_size", 16),
            conf=eval_cfg.get("conf_threshold", 0.25),
            iou=eval_cfg.get("iou_threshold", 0.45),
            device=self.cfg.training.get("device", "0"),
            project=eval_cfg.get("output_dir", "runs/eval"),
            name="validation",
            plots=True,
            save_json=eval_cfg.get("save_json", True),
        )

        self.logger.info("Validation complete.")
        return metrics


# ─── CLI ─────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train YOLOv8 obstacle detection model",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--config", type=str, default="configs/training_config.yaml",
        help="Path to training configuration YAML."
    )
    parser.add_argument("--model", type=str, default=None,
                        help="Override model architecture (e.g. yolov8s).")
    parser.add_argument("--epochs", type=int, default=None,
                        help="Override number of training epochs.")
    parser.add_argument("--batch", type=int, default=None,
                        help="Override batch size.")
    parser.add_argument("--device", type=str, default=None,
                        help="Override compute device (e.g. 0, cpu).")
    parser.add_argument("--data", type=str, default=None,
                        help="Override path to dataset.yaml.")
    parser.add_argument("--resume", action="store_true",
                        help="Resume training from last checkpoint.")
    parser.add_argument("--validate-only", action="store_true",
                        help="Skip training; run validation only.")
    parser.add_argument("--weights", type=str, default=None,
                        help="Weights path for validation-only mode.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    # Build overrides from CLI flags
    overrides = {}
    if args.model:
        overrides["model.architecture"] = args.model
        overrides["model.pretrained_weights"] = f"{args.model}.pt"
    if args.epochs:
        overrides["training.epochs"] = args.epochs
    if args.batch:
        overrides["training.batch_size"] = args.batch
    if args.device:
        overrides["training.device"] = args.device
    if args.data:
        overrides["dataset.data_yaml"] = args.data
    if args.resume:
        overrides["training.resume"] = True

    trainer = ObstacleDetectionTrainer(args.config, overrides=overrides or None)

    if args.validate_only:
        trainer.validate(weights=args.weights)
    else:
        trainer.train()


if __name__ == "__main__":
    main()
