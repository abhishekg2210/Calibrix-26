"""
visualize_dataset.py
--------------------
Visualise dataset samples with YOLO-format annotations overlaid as bounding
boxes.  Also produces class-distribution bar charts and grid previews.

Usage:
    python src/dataset/visualize_dataset.py \
        --data-dir data/processed \
        --split train \
        --num-samples 16 \
        --output runs/viz
"""

import argparse
import random
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import matplotlib.pyplot as plt
import numpy as np
from tqdm import tqdm

from src.utils.helper_functions import generate_color_palette, load_image
from src.utils.logger import get_logger

logger = get_logger(__name__)

CLASS_NAMES = [
    "pedestrian", "bicycle", "car", "motorcycle",
    "bus", "truck", "traffic_light", "stop_sign",
]


# ─── Core Drawing ─────────────────────────────────────────────────────────────

def draw_yolo_annotations(
    img: np.ndarray,
    label_path: Path,
    class_names: List[str],
    colors: List[Tuple[int, int, int]],
    thickness: int = 2,
) -> np.ndarray:
    """
    Draw YOLO bounding boxes (normalised coords) onto an image.

    Args:
        img:         BGR image array.
        label_path:  Path to the YOLO ``.txt`` label file.
        class_names: List of class name strings.
        colors:      Per-class BGR colour tuples.
        thickness:   Line thickness.

    Returns:
        Annotated copy of *img*.
    """
    img = img.copy()
    h, w = img.shape[:2]

    if not label_path.exists():
        return img

    for line in label_path.read_text().strip().splitlines():
        parts = line.strip().split()
        if len(parts) < 5:
            continue

        cls_id = int(parts[0])
        cx, cy, bw, bh = map(float, parts[1:5])

        x1 = int((cx - bw / 2) * w)
        y1 = int((cy - bh / 2) * h)
        x2 = int((cx + bw / 2) * w)
        y2 = int((cy + bh / 2) * h)

        color = colors[cls_id % len(colors)]
        label = class_names[cls_id] if cls_id < len(class_names) else str(cls_id)

        cv2.rectangle(img, (x1, y1), (x2, y2), color, thickness)

        # Label background
        (text_w, text_h), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
        cv2.rectangle(img, (x1, y1 - text_h - 4), (x1 + text_w, y1), color, -1)
        cv2.putText(img, label, (x1, y1 - 2),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)

    return img


# ─── Grid Preview ─────────────────────────────────────────────────────────────

def visualize_sample_grid(
    data_dir: Path,
    split: str = "train",
    num_samples: int = 16,
    output_dir: Optional[Path] = None,
    seed: int = 42,
    class_names: Optional[List[str]] = None,
) -> None:
    """
    Create a grid of annotated sample images and optionally save as PNG.

    Args:
        data_dir:    Root dataset directory (contains ``images/`` and ``labels/``).
        split:       Dataset split: ``"train"``, ``"val"``, or ``"test"``.
        num_samples: Number of samples to display.
        output_dir:  If provided, save the grid PNG here.
        seed:        Random seed for sample selection.
        class_names: Class names list; defaults to the project list.
    """
    if class_names is None:
        class_names = CLASS_NAMES

    img_dir = data_dir / "images" / split
    lbl_dir = data_dir / "labels" / split

    image_paths = sorted(img_dir.glob("*.*"))
    if not image_paths:
        logger.warning(f"No images found in {img_dir}")
        return

    random.seed(seed)
    sample_paths = random.sample(image_paths, min(num_samples, len(image_paths)))
    colors = generate_color_palette(len(class_names))

    grid_size = int(np.ceil(np.sqrt(len(sample_paths))))
    cell_size = 320
    grid_img = np.zeros((grid_size * cell_size, grid_size * cell_size, 3), dtype=np.uint8)

    for idx, img_path in enumerate(tqdm(sample_paths, desc="Building grid")):
        img = load_image(img_path)
        lbl_path = lbl_dir / f"{img_path.stem}.txt"
        annotated = draw_yolo_annotations(img, lbl_path, class_names, colors)

        # Resize to cell size
        annotated = cv2.resize(annotated, (cell_size, cell_size))

        row, col = divmod(idx, grid_size)
        y1, y2 = row * cell_size, (row + 1) * cell_size
        x1, x2 = col * cell_size, (col + 1) * cell_size
        grid_img[y1:y2, x1:x2] = annotated

    # Convert BGR → RGB for matplotlib
    grid_rgb = cv2.cvtColor(grid_img, cv2.COLOR_BGR2RGB)

    plt.figure(figsize=(16, 16))
    plt.imshow(grid_rgb)
    plt.axis("off")
    plt.title(f"Dataset Samples — {split.capitalize()} Split ({len(sample_paths)} images)")
    plt.tight_layout()

    if output_dir:
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        save_path = output_dir / f"samples_{split}.png"
        plt.savefig(save_path, dpi=150, bbox_inches="tight")
        logger.info(f"Grid saved: {save_path}")

    plt.show()


# ─── Class Distribution ───────────────────────────────────────────────────────

def plot_class_distribution(
    data_dir: Path,
    splits: Optional[List[str]] = None,
    output_dir: Optional[Path] = None,
    class_names: Optional[List[str]] = None,
) -> Dict[str, Dict[str, int]]:
    """
    Count per-class annotations for each split and plot a grouped bar chart.

    Args:
        data_dir:    Root dataset directory.
        splits:      Splits to analyse; defaults to ``["train", "val", "test"]``.
        output_dir:  If provided, save the chart PNG here.
        class_names: Override default class names.

    Returns:
        Nested dictionary ``{split: {class_name: count}}``.
    """
    if splits is None:
        splits = ["train", "val", "test"]
    if class_names is None:
        class_names = CLASS_NAMES

    stats: Dict[str, Dict[str, int]] = {}

    for split in splits:
        lbl_dir = data_dir / "labels" / split
        if not lbl_dir.exists():
            logger.warning(f"Labels directory not found: {lbl_dir}")
            continue

        counts: Dict[str, int] = {name: 0 for name in class_names}
        for lbl_file in tqdm(list(lbl_dir.glob("*.txt")), desc=f"Counting {split}"):
            for line in lbl_file.read_text().strip().splitlines():
                parts = line.split()
                if parts:
                    cls_id = int(parts[0])
                    if cls_id < len(class_names):
                        counts[class_names[cls_id]] += 1
        stats[split] = counts

    # Plot
    fig, ax = plt.subplots(figsize=(14, 6))
    x = np.arange(len(class_names))
    width = 0.25

    for i, (split, counts) in enumerate(stats.items()):
        values = [counts[name] for name in class_names]
        ax.bar(x + i * width, values, width, label=split.capitalize())

    ax.set_xlabel("Class", fontsize=12)
    ax.set_ylabel("Instance Count", fontsize=12)
    ax.set_title("Class Distribution per Split", fontsize=14)
    ax.set_xticks(x + width)
    ax.set_xticklabels(class_names, rotation=45, ha="right")
    ax.legend()
    plt.tight_layout()

    if output_dir:
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        save_path = output_dir / "class_distribution.png"
        plt.savefig(save_path, dpi=150, bbox_inches="tight")
        logger.info(f"Class distribution chart saved: {save_path}")

    plt.show()
    return stats


# ─── Bounding Box Statistics ──────────────────────────────────────────────────

def plot_bbox_statistics(
    data_dir: Path,
    split: str = "train",
    output_dir: Optional[Path] = None,
) -> None:
    """
    Plot distributions of bounding box widths, heights, and aspect ratios.

    Args:
        data_dir:   Root dataset directory.
        split:      Dataset split.
        output_dir: If provided, save the figure here.
    """
    lbl_dir = data_dir / "labels" / split
    if not lbl_dir.exists():
        logger.warning(f"Labels directory not found: {lbl_dir}")
        return

    widths, heights, aspect_ratios = [], [], []

    for lbl_file in tqdm(list(lbl_dir.glob("*.txt")), desc="Parsing boxes"):
        for line in lbl_file.read_text().strip().splitlines():
            parts = line.split()
            if len(parts) >= 5:
                _, _, _, w, h = parts[:5]
                w, h = float(w), float(h)
                widths.append(w)
                heights.append(h)
                aspect_ratios.append(w / (h + 1e-6))

    fig, axes = plt.subplots(1, 3, figsize=(15, 4))
    axes[0].hist(widths, bins=50, color="steelblue", edgecolor="white")
    axes[0].set_title("Box Width Distribution (normalised)")
    axes[0].set_xlabel("Width")

    axes[1].hist(heights, bins=50, color="darkorange", edgecolor="white")
    axes[1].set_title("Box Height Distribution (normalised)")
    axes[1].set_xlabel("Height")

    axes[2].hist(aspect_ratios, bins=50, color="seagreen", edgecolor="white")
    axes[2].set_title("Aspect Ratio Distribution")
    axes[2].set_xlabel("Width / Height")

    plt.suptitle(f"Bounding Box Statistics — {split.capitalize()} Split", fontsize=14)
    plt.tight_layout()

    if output_dir:
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        save_path = output_dir / f"bbox_stats_{split}.png"
        plt.savefig(save_path, dpi=150, bbox_inches="tight")
        logger.info(f"BBox stats saved: {save_path}")

    plt.show()


# ─── CLI ─────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Visualise dataset samples and statistics",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--data-dir", type=Path, default=Path("data/processed"))
    parser.add_argument("--split", default="train", choices=["train", "val", "test"])
    parser.add_argument("--num-samples", type=int, default=16)
    parser.add_argument("--output", type=Path, default=Path("runs/viz"))
    parser.add_argument("--no-grid", action="store_true", help="Skip grid visualisation.")
    parser.add_argument("--no-dist", action="store_true", help="Skip class distribution.")
    parser.add_argument("--no-bbox", action="store_true", help="Skip bbox statistics.")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if not args.no_grid:
        visualize_sample_grid(
            args.data_dir,
            split=args.split,
            num_samples=args.num_samples,
            output_dir=args.output,
        )

    if not args.no_dist:
        plot_class_distribution(
            args.data_dir,
            output_dir=args.output,
        )

    if not args.no_bbox:
        plot_bbox_statistics(
            args.data_dir,
            split=args.split,
            output_dir=args.output,
        )


if __name__ == "__main__":
    main()
