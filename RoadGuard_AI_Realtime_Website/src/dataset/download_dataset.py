"""
download_dataset.py
-------------------
Scripts to download and prepare datasets for obstacle detection training.

Supported datasets:
  - COCO 2017 (primary — vehicles & pedestrians)
  - KITTI Object Detection
  - BDD100K (requires manual token)

Usage:
    python src/dataset/download_dataset.py --dataset coco --output data/raw
    python src/dataset/download_dataset.py --dataset kitti --output data/raw
"""

import argparse
import hashlib
import os
import shutil
import zipfile
from pathlib import Path
from typing import Optional
from urllib.request import urlretrieve

from tqdm import tqdm

from src.utils.logger import get_logger

logger = get_logger(__name__)


# ─── URL Registry ─────────────────────────────────────────────────────────────

DATASET_URLS = {
    "coco": {
        "train_images": "http://images.cocodataset.org/zips/train2017.zip",
        "val_images":   "http://images.cocodataset.org/zips/val2017.zip",
        "test_images":  "http://images.cocodataset.org/zips/test2017.zip",
        "annotations":  "http://images.cocodataset.org/annotations/annotations_trainval2017.zip",
    },
    "kitti": {
        "left_images":  "https://s3.eu-central-1.amazonaws.com/avg-kitti/data_object_image_2.zip",
        "labels":       "https://s3.eu-central-1.amazonaws.com/avg-kitti/data_object_label_2.zip",
        "calibration":  "https://s3.eu-central-1.amazonaws.com/avg-kitti/data_object_calib.zip",
    },
}

# COCO class IDs relevant to obstacle detection
COCO_OBSTACLE_CLASSES = {
    0:  "pedestrian",   # person
    1:  "bicycle",
    2:  "car",
    3:  "motorcycle",
    5:  "bus",
    7:  "truck",
    9:  "traffic_light",
    11: "stop_sign",
}


# ─── Download Helpers ─────────────────────────────────────────────────────────

class _TqdmUpTo(tqdm):
    """Provides ``update_to(b, bsize, tsize)`` for :func:`urlretrieve`."""

    def update_to(self, b: int = 1, bsize: int = 1, tsize: Optional[int] = None) -> None:
        if tsize is not None:
            self.total = tsize
        self.update(b * bsize - self.n)


def _download_file(url: str, destination: Path) -> Path:
    """
    Download a file from *url* to *destination*, showing a progress bar.

    Args:
        url:         Source URL.
        destination: Local file path.

    Returns:
        Path to the downloaded file.
    """
    destination.parent.mkdir(parents=True, exist_ok=True)
    logger.info(f"Downloading {url} → {destination}")

    with _TqdmUpTo(unit="B", unit_scale=True, miniters=1, desc=destination.name) as t:
        urlretrieve(url, filename=str(destination), reporthook=t.update_to)

    logger.info(f"Download complete: {destination}")
    return destination


def _extract_zip(zip_path: Path, extract_dir: Path) -> None:
    """
    Extract a ZIP archive with a progress bar.

    Args:
        zip_path:    Path to the .zip file.
        extract_dir: Directory to extract into.
    """
    extract_dir.mkdir(parents=True, exist_ok=True)
    logger.info(f"Extracting {zip_path.name} → {extract_dir}")

    with zipfile.ZipFile(str(zip_path), "r") as zf:
        members = zf.namelist()
        for member in tqdm(members, desc="Extracting", unit="file"):
            zf.extract(member, str(extract_dir))

    logger.info("Extraction complete.")


# ─── COCO Downloader ──────────────────────────────────────────────────────────

def download_coco(
    output_dir: Path,
    splits: Optional[list] = None,
    keep_zip: bool = False,
) -> None:
    """
    Download COCO 2017 dataset (images + annotations).

    Args:
        output_dir: Root directory for raw data.
        splits:     List of splits to download: ``["train", "val", "test"]``.
                    Defaults to ``["train", "val"]``.
        keep_zip:   If False, delete ZIP files after extraction.
    """
    splits = splits or ["train", "val"]
    output_dir = Path(output_dir)
    coco_urls = DATASET_URLS["coco"]

    # Annotations (always)
    ann_zip = output_dir / "annotations_trainval2017.zip"
    if not ann_zip.exists():
        _download_file(coco_urls["annotations"], ann_zip)
    _extract_zip(ann_zip, output_dir)
    if not keep_zip:
        ann_zip.unlink(missing_ok=True)

    # Images per split
    for split in splits:
        zip_name = f"{split}2017.zip"
        img_zip = output_dir / zip_name
        key = f"{split}_images"
        if key not in coco_urls:
            logger.warning(f"No URL for COCO split '{split}', skipping.")
            continue
        if not img_zip.exists():
            _download_file(coco_urls[key], img_zip)
        _extract_zip(img_zip, output_dir)
        if not keep_zip:
            img_zip.unlink(missing_ok=True)

    logger.info(f"COCO dataset ready at: {output_dir}")


# ─── KITTI Downloader ─────────────────────────────────────────────────────────

def download_kitti(
    output_dir: Path,
    keep_zip: bool = False,
) -> None:
    """
    Download KITTI object detection dataset.

    Args:
        output_dir: Root directory for raw data.
        keep_zip:   If False, delete ZIP files after extraction.
    """
    output_dir = Path(output_dir)
    kitti_urls = DATASET_URLS["kitti"]

    for name, url in kitti_urls.items():
        zip_name = url.split("/")[-1]
        zip_path = output_dir / zip_name
        if not zip_path.exists():
            _download_file(url, zip_path)
        _extract_zip(zip_path, output_dir / "kitti")
        if not keep_zip:
            zip_path.unlink(missing_ok=True)

    logger.info(f"KITTI dataset ready at: {output_dir / 'kitti'}")


# ─── CLI ─────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download datasets for Autonomous Obstacle Detection",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--dataset",
        choices=["coco", "kitti", "all"],
        default="coco",
        help="Dataset to download.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/raw"),
        help="Output directory for raw data.",
    )
    parser.add_argument(
        "--splits",
        nargs="+",
        default=["train", "val"],
        help="Dataset splits to download (COCO only).",
    )
    parser.add_argument(
        "--keep-zip",
        action="store_true",
        help="Keep ZIP files after extraction.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.dataset in ("coco", "all"):
        logger.info("=== Downloading COCO 2017 ===")
        download_coco(args.output, splits=args.splits, keep_zip=args.keep_zip)

    if args.dataset in ("kitti", "all"):
        logger.info("=== Downloading KITTI ===")
        download_kitti(args.output, keep_zip=args.keep_zip)

    logger.info("Dataset download finished.")


if __name__ == "__main__":
    main()
