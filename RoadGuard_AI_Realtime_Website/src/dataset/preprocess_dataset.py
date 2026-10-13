"""
preprocess_dataset.py
---------------------
Convert raw dataset annotations (COCO JSON / KITTI TXT) to YOLO format
and split the data into train / val / test sets.

Pipeline:
  1. Parse raw annotations
  2. Filter to obstacle-detection classes
  3. Convert to YOLO format  (class_id cx cy w h  — all normalised)
  4. Split images + labels into train / val / test
  5. Write dataset.yaml

Usage:
    python src/dataset/preprocess_dataset.py --dataset coco \
        --raw-dir data/raw --output-dir data/processed \
        --train-split 0.8 --val-split 0.1
"""

import argparse
import json
import random
import shutil
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
from tqdm import tqdm

from src.utils.config import load_config
from src.utils.logger import get_logger

logger = get_logger(__name__)


# ─── Class Mappings ───────────────────────────────────────────────────────────

# COCO category_id → project class_id mapping
COCO_TO_PROJECT: Dict[int, int] = {
    1:  0,   # person         → pedestrian
    2:  1,   # bicycle
    3:  2,   # car
    4:  3,   # motorcycle
    6:  4,   # bus
    8:  5,   # truck
    10: 6,   # traffic light
    13: 7,   # stop sign
}

CLASS_NAMES = [
    "pedestrian", "bicycle", "car", "motorcycle",
    "bus", "truck", "traffic_light", "stop_sign",
]


# ─── COCO → YOLO ─────────────────────────────────────────────────────────────

def convert_coco_to_yolo(
    annotations_json: Path,
    images_dir: Path,
    output_dir: Path,
) -> List[Path]:
    """
    Convert COCO-format annotations to YOLO label files.

    Args:
        annotations_json: Path to COCO ``instances_*.json``.
        images_dir:       Directory containing COCO images.
        output_dir:       Output directory (images + labels will be placed here).

    Returns:
        List of processed image :class:`Path` objects.
    """
    logger.info(f"Converting COCO annotations: {annotations_json}")

    with open(annotations_json, "r") as f:
        coco = json.load(f)

    # Build lookup tables
    img_id_to_info: Dict[int, dict] = {img["id"]: img for img in coco["images"]}
    img_id_to_anns: Dict[int, List[dict]] = {}
    for ann in coco["annotations"]:
        img_id_to_anns.setdefault(ann["image_id"], []).append(ann)

    images_out = output_dir / "images"
    labels_out = output_dir / "labels"
    images_out.mkdir(parents=True, exist_ok=True)
    labels_out.mkdir(parents=True, exist_ok=True)

    processed: List[Path] = []

    for img_info in tqdm(coco["images"], desc="Converting COCO → YOLO"):
        img_id = img_info["id"]
        filename = img_info["file_name"]
        img_w = img_info["width"]
        img_h = img_info["height"]

        src_img = images_dir / filename
        if not src_img.exists():
            continue

        anns = img_id_to_anns.get(img_id, [])
        yolo_lines: List[str] = []

        for ann in anns:
            coco_cat_id = ann["category_id"]
            if coco_cat_id not in COCO_TO_PROJECT:
                continue  # Skip non-obstacle classes
            if ann.get("iscrowd", 0):
                continue

            proj_cls = COCO_TO_PROJECT[coco_cat_id]
            x, y, w, h = ann["bbox"]   # COCO: top-left + width/height (pixels)

            # Convert to YOLO: centre-x, centre-y, width, height (normalised)
            cx = (x + w / 2) / img_w
            cy = (y + h / 2) / img_h
            nw = w / img_w
            nh = h / img_h

            # Clamp to [0, 1]
            cx, cy, nw, nh = (
                max(0.0, min(1.0, cx)),
                max(0.0, min(1.0, cy)),
                max(0.0, min(1.0, nw)),
                max(0.0, min(1.0, nh)),
            )

            yolo_lines.append(f"{proj_cls} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")

        if not yolo_lines:
            continue  # Skip images with no relevant annotations

        # Copy image
        stem = Path(filename).stem
        dst_img = images_out / Path(filename).name
        shutil.copy2(str(src_img), str(dst_img))

        # Write YOLO label
        label_file = labels_out / f"{stem}.txt"
        label_file.write_text("\n".join(yolo_lines), encoding="utf-8")

        processed.append(dst_img)

    logger.info(f"Converted {len(processed)} images with obstacle annotations.")
    return processed


# ─── KITTI → YOLO ────────────────────────────────────────────────────────────

KITTI_CLASS_MAP: Dict[str, int] = {
    "pedestrian": 0,
    "person_sitting": 0,
    "cyclist": 1,
    "car": 2,
    "van": 2,
    "tram": 4,
    "truck": 5,
    "misc": -1,
    "dontcare": -1,
}


def convert_kitti_to_yolo(
    kitti_label_dir: Path,
    kitti_image_dir: Path,
    output_dir: Path,
) -> List[Path]:
    """
    Convert KITTI label files to YOLO format.

    Args:
        kitti_label_dir: Directory containing KITTI ``.txt`` label files.
        kitti_image_dir: Directory containing KITTI images.
        output_dir:      Output root directory.

    Returns:
        List of processed image paths.
    """
    logger.info("Converting KITTI annotations to YOLO format...")

    images_out = output_dir / "images"
    labels_out = output_dir / "labels"
    images_out.mkdir(parents=True, exist_ok=True)
    labels_out.mkdir(parents=True, exist_ok=True)

    label_files = sorted(kitti_label_dir.glob("*.txt"))
    processed: List[Path] = []

    for label_file in tqdm(label_files, desc="Converting KITTI → YOLO"):
        stem = label_file.stem

        # Find matching image
        img_path = None
        for ext in (".png", ".jpg", ".jpeg"):
            candidate = kitti_image_dir / f"{stem}{ext}"
            if candidate.exists():
                img_path = candidate
                break

        if img_path is None:
            continue

        img = cv2.imread(str(img_path))
        if img is None:
            continue
        img_h, img_w = img.shape[:2]

        yolo_lines: List[str] = []

        for line in label_file.read_text().strip().splitlines():
            parts = line.split()
            if len(parts) < 15:
                continue

            obj_type = parts[0].lower()
            cls_id = KITTI_CLASS_MAP.get(obj_type, -1)
            if cls_id < 0:
                continue

            # KITTI bbox: x1, y1, x2, y2 (pixels)
            x1, y1, x2, y2 = float(parts[4]), float(parts[5]), float(parts[6]), float(parts[7])
            cx = ((x1 + x2) / 2) / img_w
            cy = ((y1 + y2) / 2) / img_h
            nw = (x2 - x1) / img_w
            nh = (y2 - y1) / img_h

            yolo_lines.append(f"{cls_id} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")

        if not yolo_lines:
            continue

        shutil.copy2(str(img_path), str(images_out / img_path.name))
        (labels_out / f"{stem}.txt").write_text("\n".join(yolo_lines))
        processed.append(images_out / img_path.name)

    logger.info(f"Converted {len(processed)} KITTI images.")
    return processed


# ─── Train / Val / Test Split ─────────────────────────────────────────────────

def split_dataset(
    image_paths: List[Path],
    output_dir: Path,
    train_ratio: float = 0.8,
    val_ratio: float = 0.1,
    seed: int = 42,
) -> Dict[str, List[Path]]:
    """
    Split image paths into train / val / test and copy to structured directories.

    Expected layout after splitting::

        output_dir/
          images/train/   images/val/   images/test/
          labels/train/   labels/val/   labels/test/

    Args:
        image_paths: List of image :class:`Path` objects (labels share the same stem).
        output_dir:  Root output directory.
        train_ratio: Fraction for training.
        val_ratio:   Fraction for validation.
        seed:        Random seed for reproducibility.

    Returns:
        Dictionary mapping split name to list of image paths.
    """
    test_ratio = 1.0 - train_ratio - val_ratio
    assert test_ratio >= 0, "train_ratio + val_ratio must be ≤ 1.0"

    random.seed(seed)
    shuffled = list(image_paths)
    random.shuffle(shuffled)

    n = len(shuffled)
    n_train = int(n * train_ratio)
    n_val = int(n * val_ratio)

    splits = {
        "train": shuffled[:n_train],
        "val": shuffled[n_train:n_train + n_val],
        "test": shuffled[n_train + n_val:],
    }

    for split_name, paths in splits.items():
        img_dir = output_dir / "images" / split_name
        lbl_dir = output_dir / "labels" / split_name
        img_dir.mkdir(parents=True, exist_ok=True)
        lbl_dir.mkdir(parents=True, exist_ok=True)

        for img_path in tqdm(paths, desc=f"Copying {split_name}"):
            # Image
            dst_img = img_dir / img_path.name
            if not dst_img.exists():
                shutil.copy2(str(img_path), str(dst_img))

            # Label (same stem, .txt extension, in labels/ sibling)
            src_lbl = img_path.parent.parent / "labels" / f"{img_path.stem}.txt"
            if src_lbl.exists():
                dst_lbl = lbl_dir / src_lbl.name
                if not dst_lbl.exists():
                    shutil.copy2(str(src_lbl), str(dst_lbl))

        logger.info(f"{split_name}: {len(paths)} images")

    return splits


# ─── Write dataset.yaml ───────────────────────────────────────────────────────

def write_dataset_yaml(output_dir: Path, num_classes: int = 8) -> Path:
    """Write a YOLO-compatible ``dataset.yaml`` to *output_dir*."""
    yaml_content = f"""# Auto-generated YOLO dataset config
path: {output_dir.resolve()}
train: images/train
val: images/val
test: images/test

nc: {num_classes}

names:
"""
    for i, name in enumerate(CLASS_NAMES[:num_classes]):
        yaml_content += f"  {i}: {name}\n"

    yaml_path = output_dir / "dataset.yaml"
    yaml_path.write_text(yaml_content, encoding="utf-8")
    logger.info(f"Dataset YAML written: {yaml_path}")
    return yaml_path


# ─── CLI ─────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Preprocess datasets for Autonomous Obstacle Detection",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--dataset", choices=["coco", "kitti"], default="coco")
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/processed"))
    parser.add_argument("--train-split", type=float, default=0.8)
    parser.add_argument("--val-split", type=float, default=0.1)
    parser.add_argument("--seed", type=int, default=42)
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.dataset == "coco":
        ann_json = args.raw_dir / "annotations" / "instances_train2017.json"
        images_dir = args.raw_dir / "train2017"
        all_images = convert_coco_to_yolo(ann_json, images_dir, args.output_dir)
    elif args.dataset == "kitti":
        kitti_dir = args.raw_dir / "kitti"
        all_images = convert_kitti_to_yolo(
            kitti_dir / "training" / "label_2",
            kitti_dir / "training" / "image_2",
            args.output_dir,
        )
    else:
        raise ValueError(f"Unknown dataset: {args.dataset}")

    split_dataset(
        all_images,
        args.output_dir,
        train_ratio=args.train_split,
        val_ratio=args.val_split,
        seed=args.seed,
    )
    write_dataset_yaml(args.output_dir)
    logger.info("Preprocessing complete.")


if __name__ == "__main__":
    main()
