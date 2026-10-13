"""
metrics.py
----------
Evaluation metric utilities for object detection:
  - IoU computation
  - Precision / Recall / F1 per class
  - mAP@50 and mAP@50:95
  - Precision-Recall curve computation

These are low-level helpers consumed by evaluate_model.py.
"""

from typing import Dict, List, Optional, Tuple

import numpy as np


# ─── IoU ─────────────────────────────────────────────────────────────────────

def compute_iou_matrix(
    pred_boxes: np.ndarray,
    gt_boxes: np.ndarray,
) -> np.ndarray:
    """
    Compute pairwise IoU between two sets of bounding boxes.

    Args:
        pred_boxes: ``(N, 4)`` array in ``[x1, y1, x2, y2]`` format.
        gt_boxes:   ``(M, 4)`` array in ``[x1, y1, x2, y2]`` format.

    Returns:
        ``(N, M)`` IoU matrix.
    """
    if pred_boxes.size == 0 or gt_boxes.size == 0:
        return np.zeros((len(pred_boxes), len(gt_boxes)))

    # Broadcast: (N, 1, 4) vs (1, M, 4)
    pb = pred_boxes[:, None, :]   # (N, 1, 4)
    gb = gt_boxes[None, :, :]     # (1, M, 4)

    xi1 = np.maximum(pb[..., 0], gb[..., 0])
    yi1 = np.maximum(pb[..., 1], gb[..., 1])
    xi2 = np.minimum(pb[..., 2], gb[..., 2])
    yi2 = np.minimum(pb[..., 3], gb[..., 3])

    inter = np.maximum(xi2 - xi1, 0) * np.maximum(yi2 - yi1, 0)

    area_pred = (pred_boxes[:, 2] - pred_boxes[:, 0]) * (pred_boxes[:, 3] - pred_boxes[:, 1])
    area_gt   = (gt_boxes[:,  2] - gt_boxes[:,  0]) * (gt_boxes[:,  3] - gt_boxes[:,  1])

    union = area_pred[:, None] + area_gt[None, :] - inter
    return inter / (union + 1e-6)


# ─── AP Computation ──────────────────────────────────────────────────────────

def compute_ap(
    recalls: np.ndarray,
    precisions: np.ndarray,
    method: str = "interp",
) -> float:
    """
    Compute Average Precision from recall and precision arrays.

    Args:
        recalls:    Array of recall values in ``[0, 1]``.
        precisions: Array of precision values in ``[0, 1]``.
        method:     ``"interp"`` (COCO 101-point interpolation) or
                    ``"continuous"`` (area under PR curve).

    Returns:
        AP value in ``[0.0, 1.0]``.
    """
    # Append sentinel values
    mrec = np.concatenate([[0.0], recalls, [1.0]])
    mpre = np.concatenate([[1.0], precisions, [0.0]])

    # Make precision monotonically decreasing
    for i in range(len(mpre) - 2, -1, -1):
        mpre[i] = max(mpre[i], mpre[i + 1])

    if method == "interp":
        # COCO 101-point interpolation
        recall_thresholds = np.linspace(0, 1, 101)
        ap = np.mean([
            np.max(mpre[mrec >= t]) if np.any(mrec >= t) else 0.0
            for t in recall_thresholds
        ])
    else:
        # Area under curve (VOC style)
        indices = np.where(mrec[1:] != mrec[:-1])[0]
        ap = float(np.sum((mrec[indices + 1] - mrec[indices]) * mpre[indices + 1]))

    return float(ap)


# ─── Per-class Detection Matching ────────────────────────────────────────────

def match_detections_to_gt(
    pred_boxes: np.ndarray,
    pred_confs: np.ndarray,
    gt_boxes: np.ndarray,
    iou_threshold: float = 0.5,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Match predicted boxes to ground-truth boxes using IoU.

    Args:
        pred_boxes:    ``(N, 4)`` predictions ``[x1, y1, x2, y2]``.
        pred_confs:    ``(N,)`` confidence scores.
        gt_boxes:      ``(M, 4)`` ground-truth boxes.
        iou_threshold: Minimum IoU for a match.

    Returns:
        Tuple of ``(tp, fp)`` boolean arrays of length N (sorted by conf desc).
    """
    n_pred = len(pred_boxes)
    n_gt   = len(gt_boxes)

    tp = np.zeros(n_pred, dtype=bool)
    fp = np.zeros(n_pred, dtype=bool)

    if n_gt == 0:
        fp[:] = True
        return tp, fp

    if n_pred == 0:
        return tp, fp

    # Sort predictions by confidence (descending)
    sort_idx = np.argsort(-pred_confs)
    sorted_boxes = pred_boxes[sort_idx]

    matched_gt = set()
    iou_mat = compute_iou_matrix(sorted_boxes, gt_boxes)

    for pred_i in range(n_pred):
        ious = iou_mat[pred_i]
        best_gt = int(np.argmax(ious))
        best_iou = ious[best_gt]

        if best_iou >= iou_threshold and best_gt not in matched_gt:
            tp[pred_i] = True
            matched_gt.add(best_gt)
        else:
            fp[pred_i] = True

    # Restore original order
    unsort_idx = np.argsort(sort_idx)
    return tp[unsort_idx], fp[unsort_idx]


# ─── mAP ─────────────────────────────────────────────────────────────────────

def compute_map(
    all_detections: Dict[int, List[Tuple[np.ndarray, float]]],
    all_ground_truths: Dict[int, List[np.ndarray]],
    iou_thresholds: Optional[List[float]] = None,
    class_names: Optional[List[str]] = None,
) -> Dict[str, float]:
    """
    Compute mAP@50 and mAP@50:95 from detection and ground-truth dicts.

    Args:
        all_detections:   ``{class_id: [(box_4, conf), ...]}``.
        all_ground_truths:``{class_id: [box_4, ...]}``.
        iou_thresholds:   List of IoU thresholds; defaults to 50:95 range.
        class_names:      Optional list of class name strings.

    Returns:
        Dictionary with keys: ``mAP50``, ``mAP50_95``, and per-class APs.
    """
    if iou_thresholds is None:
        iou_thresholds = np.arange(0.5, 1.0, 0.05).tolist()

    class_ids = sorted(set(list(all_detections.keys()) + list(all_ground_truths.keys())))

    ap_per_class_50: Dict[int, float] = {}
    ap_per_class_5095: Dict[int, float] = {}

    for cls_id in class_ids:
        dets = all_detections.get(cls_id, [])
        gts  = all_ground_truths.get(cls_id, [])

        if not gts:
            ap_per_class_50[cls_id] = 0.0
            ap_per_class_5095[cls_id] = 0.0
            continue

        gt_arr = np.array(gts)  # (M, 4)

        if not dets:
            ap_per_class_50[cls_id] = 0.0
            ap_per_class_5095[cls_id] = 0.0
            continue

        pred_boxes = np.array([d[0] for d in dets])
        pred_confs = np.array([d[1] for d in dets])

        # Sort by confidence
        sort_idx = np.argsort(-pred_confs)
        pred_boxes = pred_boxes[sort_idx]
        pred_confs = pred_confs[sort_idx]

        # AP @ 0.50
        tp50, fp50 = match_detections_to_gt(pred_boxes, pred_confs, gt_arr, 0.5)
        cum_tp = np.cumsum(tp50)
        cum_fp = np.cumsum(fp50)
        recall50    = cum_tp / (len(gts) + 1e-6)
        precision50 = cum_tp / (cum_tp + cum_fp + 1e-6)
        ap_per_class_50[cls_id] = compute_ap(recall50, precision50)

        # AP @ 50:95
        ap_values = []
        for iou_t in iou_thresholds:
            tp, fp = match_detections_to_gt(pred_boxes, pred_confs, gt_arr, iou_t)
            c_tp = np.cumsum(tp)
            c_fp = np.cumsum(fp)
            rec  = c_tp / (len(gts) + 1e-6)
            prec = c_tp / (c_tp + c_fp + 1e-6)
            ap_values.append(compute_ap(rec, prec))
        ap_per_class_5095[cls_id] = float(np.mean(ap_values))

    map50    = float(np.mean(list(ap_per_class_50.values()))) if ap_per_class_50 else 0.0
    map5095  = float(np.mean(list(ap_per_class_5095.values()))) if ap_per_class_5095 else 0.0

    results: Dict[str, float] = {"mAP50": map50, "mAP50_95": map5095}

    for cls_id in class_ids:
        name = (class_names[cls_id] if class_names and cls_id < len(class_names)
                else str(cls_id))
        results[f"AP50/{name}"]   = ap_per_class_50.get(cls_id, 0.0)
        results[f"AP5095/{name}"] = ap_per_class_5095.get(cls_id, 0.0)

    return results


# ─── Precision / Recall / F1 ─────────────────────────────────────────────────

def compute_precision_recall_f1(
    tp: int, fp: int, fn: int
) -> Tuple[float, float, float]:
    """
    Compute precision, recall, and F1 from raw counts.

    Args:
        tp: True positives.
        fp: False positives.
        fn: False negatives.

    Returns:
        ``(precision, recall, f1)`` tuple.
    """
    precision = tp / (tp + fp + 1e-6)
    recall    = tp / (tp + fn + 1e-6)
    f1        = 2 * precision * recall / (precision + recall + 1e-6)
    return float(precision), float(recall), float(f1)
