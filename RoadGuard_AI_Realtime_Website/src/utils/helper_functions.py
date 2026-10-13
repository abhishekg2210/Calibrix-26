"""
helper_functions.py
-------------------
General-purpose utility functions used throughout the project.

Covers:
  - Random seed fixing for reproducibility
  - Device selection (CUDA / MPS / CPU)
  - Bounding-box helpers
  - Image I/O wrappers
  - Timer context manager
  - Colour palette generation
"""

import random
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, Generator, List, Optional, Tuple, Union

import cv2
import numpy as np
import torch

from src.utils.logger import get_logger

logger = get_logger(__name__)


# ─── Reproducibility ─────────────────────────────────────────────────────────

def set_seed(seed: int = 42) -> None:
    """
    Fix random seeds for full reproducibility across Python, NumPy, and PyTorch.

    Args:
        seed: Integer seed value.
    """
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False
    logger.debug(f"Random seed set to {seed}")


# ─── Device ──────────────────────────────────────────────────────────────────

def get_device(device_str: Optional[str] = None) -> torch.device:
    """
    Resolve and return the best available :class:`torch.device`.

    Args:
        device_str: ``"cpu"``, ``"cuda"``, ``"cuda:0"``, ``"mps"``, or ``None``
                    (auto-detect).

    Returns:
        :class:`torch.device` instance.
    """
    if device_str and device_str != "auto":
        device = torch.device(device_str)
    elif torch.cuda.is_available():
        device = torch.device("cuda")
    elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        device = torch.device("mps")
    else:
        device = torch.device("cpu")

    logger.info(f"Using device: {device}")
    return device


def get_device_info() -> Dict[str, str]:
    """Return a dictionary of device information for diagnostics."""
    info: Dict[str, str] = {
        "torch_version": torch.__version__,
        "cuda_available": str(torch.cuda.is_available()),
    }
    if torch.cuda.is_available():
        info["cuda_version"] = torch.version.cuda or "N/A"
        info["gpu_name"] = torch.cuda.get_device_name(0)
        info["gpu_memory_gb"] = f"{torch.cuda.get_device_properties(0).total_memory / 1e9:.1f}"
    return info


# ─── Image I/O ───────────────────────────────────────────────────────────────

def load_image(path: Union[str, Path]) -> np.ndarray:
    """
    Load an image from disk as a BGR NumPy array.

    Args:
        path: Path to the image file.

    Returns:
        BGR image array (H, W, C).

    Raises:
        FileNotFoundError: If the file does not exist.
        ValueError:        If OpenCV cannot decode the file.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Image not found: {path}")

    img = cv2.imread(str(path))
    if img is None:
        raise ValueError(f"Could not decode image: {path}")
    return img


def save_image(img: np.ndarray, path: Union[str, Path]) -> None:
    """
    Write a BGR NumPy array to disk.

    Args:
        img:  BGR image array.
        path: Destination file path (directory is created if missing).
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), img)


def resize_image(
    img: np.ndarray,
    target_size: Tuple[int, int],
    keep_aspect: bool = True,
) -> np.ndarray:
    """
    Resize an image while optionally preserving aspect ratio (letterbox).

    Args:
        img:         BGR image array.
        target_size: ``(width, height)`` tuple.
        keep_aspect: If True, pad with black to preserve ratio.

    Returns:
        Resized (and possibly padded) image.
    """
    if not keep_aspect:
        return cv2.resize(img, target_size)

    target_w, target_h = target_size
    h, w = img.shape[:2]
    scale = min(target_w / w, target_h / h)
    new_w, new_h = int(w * scale), int(h * scale)

    resized = cv2.resize(img, (new_w, new_h))
    canvas = np.zeros((target_h, target_w, 3), dtype=np.uint8)
    x_offset = (target_w - new_w) // 2
    y_offset = (target_h - new_h) // 2
    canvas[y_offset:y_offset + new_h, x_offset:x_offset + new_w] = resized
    return canvas


# ─── Bounding Box Helpers ─────────────────────────────────────────────────────

def xyxy_to_xywh(box: List[float]) -> List[float]:
    """Convert ``[x1, y1, x2, y2]`` to ``[x, y, w, h]``."""
    x1, y1, x2, y2 = box
    return [x1, y1, x2 - x1, y2 - y1]


def xywh_to_xyxy(box: List[float]) -> List[float]:
    """Convert ``[x, y, w, h]`` to ``[x1, y1, x2, y2]``."""
    x, y, w, h = box
    return [x, y, x + w, y + h]


def normalize_box(
    box: List[float], img_w: int, img_h: int
) -> List[float]:
    """
    Normalise pixel ``[x1, y1, x2, y2]`` coordinates to ``[0, 1]`` range.

    Args:
        box:   ``[x1, y1, x2, y2]`` in pixels.
        img_w: Image width in pixels.
        img_h: Image height in pixels.

    Returns:
        Normalised ``[x1, y1, x2, y2]`` floats.
    """
    x1, y1, x2, y2 = box
    return [x1 / img_w, y1 / img_h, x2 / img_w, y2 / img_h]


def compute_iou(box1: List[float], box2: List[float]) -> float:
    """
    Compute Intersection-over-Union of two ``[x1, y1, x2, y2]`` boxes.

    Args:
        box1: First bounding box.
        box2: Second bounding box.

    Returns:
        IoU score in ``[0.0, 1.0]``.
    """
    xi1 = max(box1[0], box2[0])
    yi1 = max(box1[1], box2[1])
    xi2 = min(box1[2], box2[2])
    yi2 = min(box1[3], box2[3])

    inter_area = max(0, xi2 - xi1) * max(0, yi2 - yi1)
    box1_area = (box1[2] - box1[0]) * (box1[3] - box1[1])
    box2_area = (box2[2] - box2[0]) * (box2[3] - box2[1])
    union_area = box1_area + box2_area - inter_area

    return inter_area / (union_area + 1e-6)


# ─── Visualisation Helpers ────────────────────────────────────────────────────

def generate_color_palette(num_classes: int) -> List[Tuple[int, int, int]]:
    """
    Generate a visually distinct BGR colour palette.

    Args:
        num_classes: Number of classes.

    Returns:
        List of ``(B, G, R)`` tuples.
    """
    np.random.seed(42)
    colors = []
    for i in range(num_classes):
        hue = int(180 * i / num_classes)
        color_hsv = np.array([[[hue, 200, 200]]], dtype=np.uint8)
        color_bgr = cv2.cvtColor(color_hsv, cv2.COLOR_HSV2BGR)[0][0]
        colors.append(tuple(int(c) for c in color_bgr))
    return colors


def draw_detections(
    img: np.ndarray,
    boxes: List[List[float]],
    labels: List[str],
    confidences: List[float],
    colors: Optional[List[Tuple[int, int, int]]] = None,
    thickness: int = 2,
    font_scale: float = 0.6,
) -> np.ndarray:
    """
    Draw bounding boxes with labels and confidence scores on an image.

    Args:
        img:          BGR image (modified in-place copy).
        boxes:        List of ``[x1, y1, x2, y2]`` pixel boxes.
        labels:       Corresponding class label strings.
        confidences:  Corresponding confidence scores ``[0, 1]``.
        colors:       Per-detection BGR colour tuples.
        thickness:    Box line thickness.
        font_scale:   Label font scale.

    Returns:
        Annotated BGR image.
    """
    img = img.copy()
    default_color = (0, 255, 0)

    for i, (box, label, conf) in enumerate(zip(boxes, labels, confidences)):
        x1, y1, x2, y2 = [int(v) for v in box]
        color = colors[i] if colors else default_color
        text = f"{label} {conf:.2f}"

        # Bounding box
        cv2.rectangle(img, (x1, y1), (x2, y2), color, thickness)

        # Label background
        (text_w, text_h), baseline = cv2.getTextSize(
            text, cv2.FONT_HERSHEY_SIMPLEX, font_scale, thickness
        )
        cv2.rectangle(
            img,
            (x1, y1 - text_h - baseline - 4),
            (x1 + text_w, y1),
            color,
            -1,
        )
        # Label text
        cv2.putText(
            img,
            text,
            (x1, y1 - baseline - 2),
            cv2.FONT_HERSHEY_SIMPLEX,
            font_scale,
            (255, 255, 255),
            thickness,
        )
    return img


def draw_fps(img: np.ndarray, fps: float) -> np.ndarray:
    """
    Overlay an FPS counter on the top-left corner of an image.

    Args:
        img: BGR image.
        fps: Frames per second value.

    Returns:
        Annotated image copy.
    """
    img = img.copy()
    cv2.putText(
        img,
        f"FPS: {fps:.1f}",
        (10, 30),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.0,
        (0, 255, 0),
        2,
    )
    return img


# ─── Timer ───────────────────────────────────────────────────────────────────

@contextmanager
def timer(name: str = "block") -> Generator[None, None, None]:
    """
    Context manager for timing code blocks.

    Args:
        name: Descriptive name for the timed block.

    Example:
        with timer("inference"):
            results = model(image)
    """
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed = time.perf_counter() - start
        logger.debug(f"[Timer] {name}: {elapsed * 1000:.2f} ms")


# ─── File Utilities ───────────────────────────────────────────────────────────

def list_images(directory: Union[str, Path], recursive: bool = True) -> List[Path]:
    """
    Return all image file paths in a directory.

    Args:
        directory: Root directory to search.
        recursive: If True, search subdirectories.

    Returns:
        Sorted list of :class:`Path` objects.
    """
    directory = Path(directory)
    extensions = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tiff"}
    pattern = "**/*" if recursive else "*"
    return sorted(
        p for p in directory.glob(pattern) if p.suffix.lower() in extensions
    )


def ensure_dir(path: Union[str, Path]) -> Path:
    """Create directory (and parents) if it does not exist."""
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    return path
