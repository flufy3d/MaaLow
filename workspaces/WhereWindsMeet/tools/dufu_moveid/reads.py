"""Python ports of skills/lib/dufu-reads.js `health()` and `readQi()` (what dufu.js reads on the Pad), for video frames.

MaaFramework's colour match (method 40 = HSV, connected: true, count: N) = connected components of the inRange mask
with >= N pixels; we take their bounding boxes the same way. Readers work on the stored ROI crops (pull.py keeps the
HP_ROI and QI_ROI pixels of every frame in bars/<id>.npz), so they can change without decoding the videos again.
"""
from __future__ import annotations

import cv2
import numpy as np

HP_ROI = (405, 681, 280, 5)
HP_LEFT, HP_FULL, HP_GAP, HP_RED_MAX = 415, 669, 12, 0.45
HP_GREY = [((0, 0, 140), (180, 45, 255))]
HP_RED = [((0, 100, 165), (6, 175, 255)), ((174, 100, 165), (180, 175, 255))]
QI_ROI = (347, 35, 386, 6)
QI_HSV = [((88, 30, 150), (108, 130, 255))]


def crop(img: np.ndarray, roi) -> np.ndarray:
    x, y, w, h = roi
    return img[y:y + h, x:x + w]


def _boxes(hsv: np.ndarray, ranges, count: int) -> list[tuple[int, int]]:
    """(x, w) of the connected components with >= count px, sorted by x (x relative to the crop)."""
    m = None
    for lo, hi in ranges:
        k = cv2.inRange(hsv, np.array(lo, np.uint8), np.array(hi, np.uint8))
        m = k if m is None else (m | k)
    n, _, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    out = [(int(stats[i, 0]), int(stats[i, 2])) for i in range(1, n) if stats[i, 4] >= count]
    return sorted(out)


def _run_right(boxes, gap: int) -> int:
    right = boxes[0][0] + boxes[0][1]
    for x, w in boxes[1:]:
        if x - right > gap:
            break
        right = max(right, x + w)
    return right


def health(hp_crop_bgr: np.ndarray) -> float:
    """Health 0..1, NaN when not readable (health() returning null)."""
    hsv = cv2.cvtColor(hp_crop_bgr, cv2.COLOR_BGR2HSV)
    x0 = HP_ROI[0]

    def read(ranges):
        b = _boxes(hsv, ranges, 5)
        if not b or b[0][0] + x0 > HP_LEFT + 8:
            return None
        right = _run_right(b, HP_GAP) + x0
        if right - HP_LEFT < 4:
            return None
        return max(0.0, min(1.0, (right - HP_LEFT) / (HP_FULL - HP_LEFT)))

    grey = read(HP_GREY)
    if grey is not None and grey > HP_RED_MAX:
        return grey
    red = read(HP_RED)
    if red is not None and red <= HP_RED_MAX:
        return red
    return np.nan if grey is None else grey


def qi(qi_crop_bgr: np.ndarray) -> int:
    """Boss 真气 px from the left end; -1 when not read (readQi)."""
    hsv = cv2.cvtColor(qi_crop_bgr, cv2.COLOR_BGR2HSV)
    b = _boxes(hsv, QI_HSV, 2)
    if not b or b[0][0] > 6:
        return -1
    return _run_right(b, 8)
