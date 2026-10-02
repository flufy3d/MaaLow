"""OCR on the PC with the workspace's PaddleOCR v4 models (model/ocr: det.onnx, rec.onnx, keys.txt), the ones the app
reads the tracker, cards and panels with; for the offline tools (rec_route.py). Needs onnxruntime (the cv extra).

    from wwm_ocr import ocr
    for text, box, score in ocr(img, roi=(20, 130, 330, 90)): ...

Boxes are x, y, w, h in the image. Lines are what the detector finds; lines() groups them into rows like
skills/stronghold.js lines().
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

MODEL = Path(__file__).resolve().parents[1] / "model" / "ocr"


@lru_cache(maxsize=1)
def _models():
    import onnxruntime as ort

    opt = ort.SessionOptions()
    opt.log_severity_level = 3
    det = ort.InferenceSession(str(MODEL / "det.onnx"), opt, providers=["CPUExecutionProvider"])
    rec = ort.InferenceSession(str(MODEL / "rec.onnx"), opt, providers=["CPUExecutionProvider"])
    keys = ["<blank>"] + (MODEL / "keys.txt").read_text(encoding="utf-8").splitlines() + [" "]
    return det, rec, keys


def _detect(img: np.ndarray, thresh: float = 0.3, box_thresh: float = 0.5, unclip: float = 1.6):
    det, _, _ = _models()
    h, w = img.shape[:2]
    s = min(1.0, 960 / max(h, w))
    nh, nw = max(32, int(round(h * s / 32)) * 32), max(32, int(round(w * s / 32)) * 32)
    x = cv2.resize(img, (nw, nh)).astype(np.float32) / 255.0
    x = (x - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
    prob = det.run(None, {"x": x.transpose(2, 0, 1)[None]})[0][0, 0]
    n, lab, stats, _ = cv2.connectedComponentsWithStats((prob > thresh).astype(np.uint8), connectivity=4)
    boxes = []
    for i in range(1, n):
        bx, by, bw, bh, area = stats[i]
        if area < 6 or prob[lab == i].mean() < box_thresh:
            continue
        # unclip: DB shrinks the text region; grow it back by area * unclip / perimeter
        d = area * unclip / (2 * (bw + bh))
        x0, y0, x1, y1 = bx - d, by - d, bx + bw + d, by + bh + d
        boxes.append((max(0, int(x0 * w / nw)), max(0, int(y0 * h / nh)), min(w, int(np.ceil(x1 * w / nw))), min(h, int(np.ceil(y1 * h / nh)))))
    return boxes


def _recognize(crop: np.ndarray) -> tuple[str, float]:
    _, rec, keys = _models()
    h, w = crop.shape[:2]
    nw = max(16, int(np.ceil(48 * w / h)))
    x = cv2.resize(crop, (nw, 48)).astype(np.float32) / 255.0
    x = (x - 0.5) / 0.5
    out = rec.run(None, {"x": x.transpose(2, 0, 1)[None]})[0][0]
    idx, conf = out.argmax(1), out.max(1)
    text, scores, last = [], [], 0
    for i, c in zip(idx, conf):
        if i != last and i != 0:
            text.append(keys[i] if i < len(keys) else "")
            scores.append(c)
        last = i
    return "".join(text), float(np.mean(scores)) if scores else 0.0


def ocr(img: np.ndarray, roi: tuple[int, int, int, int] | None = None, min_score: float = 0.5):
    """[(text, (x, y, w, h), score)] of the text lines in img (within roi)."""
    ox, oy = 0, 0
    if roi:
        ox, oy, rw, rh = roi
        img = img[oy : oy + rh, ox : ox + rw]
    out = []
    for x0, y0, x1, y1 in _detect(img):
        if x1 - x0 < 4 or y1 - y0 < 4:
            continue
        text, score = _recognize(img[y0:y1, x0:x1])
        if text and score >= min_score:
            out.append((text, (x0 + ox, y0 + oy, x1 - x0, y1 - y0), score))
    return out


def lines(results) -> list[str]:
    """Results grouped into rows by their middles (within 10 px), left to right, joined (stronghold.js lines())."""
    rows: list[tuple[float, list]] = []
    for r in results:
        y = r[1][1] + r[1][3] / 2
        for row in rows:
            if abs(row[0] - y) <= 10:
                row[1].append(r)
                break
        else:
            rows.append((y, [r]))
    return ["".join(t for t, _, _ in sorted(p, key=lambda r: r[1][0])) for _, p in sorted(rows, key=lambda r: r[0])]
