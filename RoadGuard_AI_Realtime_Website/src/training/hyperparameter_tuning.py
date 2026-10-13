"""
hyperparameter_tuning.py
------------------------
Automated hyperparameter optimisation using Optuna for YOLOv8 training.

Search space includes:
  - Learning rate (lr0, lrf)
  - Batch size
  - Augmentation parameters
  - Loss weights

Usage:
    python src/training/hyperparameter_tuning.py \
        --config configs/training_config.yaml \
        --n-trials 20 \
        --timeout 7200
"""

import argparse
import json
from pathlib import Path
from typing import Optional

import optuna
import yaml
from ultralytics import YOLO

from src.utils.config import load_config
from src.utils.helper_functions import set_seed
from src.utils.logger import get_logger

logger = get_logger(__name__)


# ─── Objective ────────────────────────────────────────────────────────────────

def objective(
    trial: optuna.Trial,
    config_path: str,
    epochs: int = 20,
    data_yaml: Optional[str] = None,
) -> float:
    """
    Optuna objective function.  Each call trains a short YOLOv8 run and
    returns the validation mAP@50 as the optimisation target.

    Args:
        trial:       Optuna trial object.
        config_path: Path to base configuration YAML.
        epochs:      Short training epochs per trial (default: 20).
        data_yaml:   Optional override for dataset YAML path.

    Returns:
        mAP@50 score (higher is better).
    """
    cfg = load_config(config_path)

    # ── Suggest hyperparameters ────────────────────────────────────────────
    lr0 = trial.suggest_float("lr0", 1e-5, 1e-2, log=True)
    lrf = trial.suggest_float("lrf", 0.001, 0.1, log=True)
    batch_size = trial.suggest_categorical("batch_size", [8, 16, 32])
    weight_decay = trial.suggest_float("weight_decay", 1e-5, 1e-3, log=True)
    warmup_epochs = trial.suggest_float("warmup_epochs", 1.0, 5.0)

    # Augmentation
    hsv_s = trial.suggest_float("hsv_s", 0.3, 0.9)
    hsv_v = trial.suggest_float("hsv_v", 0.2, 0.6)
    scale = trial.suggest_float("scale", 0.3, 0.7)
    fliplr = trial.suggest_float("fliplr", 0.3, 0.7)
    mosaic = trial.suggest_float("mosaic", 0.5, 1.0)

    # Loss weights
    box_loss = trial.suggest_float("box", 4.0, 10.0)
    cls_loss = trial.suggest_float("cls", 0.3, 1.5)

    # Model architecture
    arch = trial.suggest_categorical("architecture", ["yolov8n", "yolov8s", "yolov8m"])

    logger.info(
        f"Trial {trial.number} | arch={arch} | lr0={lr0:.5f} | "
        f"batch={batch_size} | scale={scale:.2f}"
    )

    # ── Train ──────────────────────────────────────────────────────────────
    try:
        model = YOLO(f"{arch}.pt")
        results = model.train(
            data=data_yaml or cfg.dataset.get("data_yaml", "configs/dataset.yaml"),
            imgsz=cfg.model.get("input_size", 640),
            epochs=epochs,
            batch=batch_size,
            lr0=lr0,
            lrf=lrf,
            weight_decay=weight_decay,
            warmup_epochs=warmup_epochs,
            hsv_s=hsv_s,
            hsv_v=hsv_v,
            scale=scale,
            fliplr=fliplr,
            mosaic=mosaic,
            box=box_loss,
            cls=cls_loss,
            amp=True,
            device=cfg.training.get("device", "0"),
            project="runs/hptuning",
            name=f"trial_{trial.number}",
            verbose=False,
            plots=False,
        )

        # Extract mAP@50
        metrics = results.results_dict
        map50 = metrics.get("metrics/mAP50(B)", 0.0)

    except Exception as exc:
        logger.warning(f"Trial {trial.number} failed: {exc}")
        return 0.0

    logger.info(f"Trial {trial.number} mAP@50 = {map50:.4f}")
    return float(map50)


# ─── Runner ───────────────────────────────────────────────────────────────────

def run_hyperparameter_tuning(
    config_path: str,
    n_trials: int = 30,
    epochs_per_trial: int = 20,
    timeout: Optional[int] = None,
    study_name: str = "yolo_obstacle_hptuning",
    output_dir: Path = Path("runs/hptuning"),
    data_yaml: Optional[str] = None,
) -> optuna.Study:
    """
    Launch an Optuna study to find optimal hyperparameters.

    Args:
        config_path:       Base configuration YAML.
        n_trials:          Number of trials to run.
        epochs_per_trial:  Training epochs per trial (keep low for speed).
        timeout:           Max seconds to run (``None`` = no limit).
        study_name:        Optuna study name.
        output_dir:        Directory for study artefacts.
        data_yaml:         Dataset YAML path override.

    Returns:
        Completed :class:`optuna.Study` object.
    """
    output_dir.mkdir(parents=True, exist_ok=True)

    # SQLite storage for persistence / parallelism
    storage_path = output_dir / f"{study_name}.db"
    storage_url = f"sqlite:///{storage_path}"

    sampler = optuna.samplers.TPESampler(seed=42)
    pruner = optuna.pruners.MedianPruner(n_startup_trials=5, n_warmup_steps=5)

    study = optuna.create_study(
        study_name=study_name,
        storage=storage_url,
        direction="maximize",
        sampler=sampler,
        pruner=pruner,
        load_if_exists=True,
    )

    logger.info(f"Starting Optuna study: {study_name}")
    logger.info(f"Trials: {n_trials} | Epochs/trial: {epochs_per_trial}")

    study.optimize(
        lambda trial: objective(trial, config_path, epochs_per_trial, data_yaml),
        n_trials=n_trials,
        timeout=timeout,
        show_progress_bar=True,
    )

    # ── Report best trial ──────────────────────────────────────────────────
    best = study.best_trial
    logger.info("=" * 60)
    logger.info(f"Best Trial #{best.number} — mAP@50: {best.value:.4f}")
    logger.info("Best Hyperparameters:")
    for key, val in best.params.items():
        logger.info(f"  {key}: {val}")
    logger.info("=" * 60)

    # Save best params as YAML
    best_params_path = output_dir / "best_params.yaml"
    with open(best_params_path, "w") as f:
        yaml.dump(best.params, f, default_flow_style=False)
    logger.info(f"Best params saved: {best_params_path}")

    # ── Visualisation ─────────────────────────────────────────────────────
    _plot_study(study, output_dir)

    return study


def _plot_study(study: optuna.Study, output_dir: Path) -> None:
    """Generate and save Optuna visualisation plots."""
    try:
        import matplotlib.pyplot as plt

        # Optimisation history
        fig = optuna.visualization.matplotlib.plot_optimization_history(study)
        plt.savefig(output_dir / "optimization_history.png", bbox_inches="tight", dpi=150)
        plt.close()

        # Parameter importance
        fig = optuna.visualization.matplotlib.plot_param_importances(study)
        plt.savefig(output_dir / "param_importances.png", bbox_inches="tight", dpi=150)
        plt.close()

        logger.info(f"Study plots saved to {output_dir}")
    except Exception as exc:
        logger.warning(f"Could not generate study plots: {exc}")


# ─── CLI ─────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Hyperparameter tuning for YOLOv8 obstacle detection",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--config", default="configs/training_config.yaml")
    parser.add_argument("--n-trials", type=int, default=30)
    parser.add_argument("--epochs", type=int, default=20,
                        help="Epochs per trial (keep low for speed).")
    parser.add_argument("--timeout", type=int, default=None,
                        help="Max total seconds to run.")
    parser.add_argument("--study-name", default="yolo_obstacle_hptuning")
    parser.add_argument("--output-dir", type=Path, default=Path("runs/hptuning"))
    parser.add_argument("--data", type=str, default=None,
                        help="Override dataset YAML path.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    run_hyperparameter_tuning(
        config_path=args.config,
        n_trials=args.n_trials,
        epochs_per_trial=args.epochs,
        timeout=args.timeout,
        study_name=args.study_name,
        output_dir=args.output_dir,
        data_yaml=args.data,
    )


if __name__ == "__main__":
    main()
