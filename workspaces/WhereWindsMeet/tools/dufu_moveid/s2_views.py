"""Order 2 preprocessing: one screen frame -> the three views every 独夫 move-ID model sees (training and the Pad alike).

Views (gate 0 decision, docs/dufu-moveid-plan.md):
  glob   the whole screen resized to 384x240 (w x h)
  big    square crop, side 530, centred on (555, 320), resized to 192x192
  small  square crop, side 260, same centre, resized to 192x192

Rules (in 1080x720 screen coordinates; other screen sizes are scaled by height / 720 and the result rounded):
  - crop x0 = round(cx - side / 2), y0 = round(cy - side / 2); a crop that would leave the screen is shifted back
    inside (same size), never shrunk; with the default centre both crops already fit: big [290, 55, 530, 530],
    small [425, 190, 260, 260] as [x, y, w, h].
  - resizing is cv2.INTER_AREA, the same as the App's infer() default (`resize: "area"`, Nn.kt), so on the Pad the
    same views are infer(roi = [x, y, w, h], size = ..., resize = "area"). views() is the reference; batch code may
    use area_weights() (the same box filter as matrices) instead.
  - pixels stay uint8 in the input channel order (BGR from OpenCV / MaaFramework); colour conversion and
    normalisation belong to the model.
"""
from __future__ import annotations

import cv2
import numpy as np

SCREEN_W, SCREEN_H = 1080, 720
CENTER = (555, 320)
GLOB_SIZE = (384, 240)          # (w, h)
CROPS = {"big": 530, "small": 260}
CROP_OUT = 192
INTERP = cv2.INTER_AREA
NAMES = ("glob", "big", "small")


def crop_box(side: float, w: int = SCREEN_W, h: int = SCREEN_H, center=CENTER) -> tuple[int, int, int, int]:
    """[x, y, w, h] of a square crop of `side` (1080x720 units) around `center`, scaled to a w x h screen, inside it."""
    s = h / SCREEN_H
    side_px = min(int(round(side * s)), w, h)
    x0 = int(round(center[0] * s - side_px / 2))
    y0 = int(round(center[1] * s - side_px / 2))
    x0 = min(max(x0, 0), w - side_px)
    y0 = min(max(y0, 0), h - side_px)
    return x0, y0, side_px, side_px


def boxes(w: int = SCREEN_W, h: int = SCREEN_H) -> dict[str, tuple[int, int, int, int]]:
    """Source rectangle [x, y, w, h] of each view on a w x h screen."""
    out = {"glob": (0, 0, w, h)}
    out.update({k: crop_box(v, w, h) for k, v in CROPS.items()})
    return out


def views(frame: np.ndarray, bx: dict | None = None) -> dict[str, np.ndarray]:
    """frame (H, W, C) uint8 -> {glob: (240, 384, C), big: (192, 192, C), small: (192, 192, C)}, INTER_AREA."""
    h, w = frame.shape[:2]
    bx = bx or boxes(w, h)
    out = {}
    for name, (x, y, bw, bh) in bx.items():
        size = GLOB_SIZE if name == "glob" else (CROP_OUT, CROP_OUT)
        out[name] = cv2.resize(frame[y:y + bh, x:x + bw], size, interpolation=INTERP)
    return out


def area_weights(n: int, o: int) -> np.ndarray:
    """[o, n] matrix M with M @ x = INTER_AREA resize of a length-n line to o (box filter: each output pixel is the
    overlap-weighted mean of the input pixels it covers). INTER_AREA is separable, so for batches (GPU)
    view = round(Wy @ crop @ Wx.T) per channel, computed in float32; checked against cv2.resize on recordings:
    identical except ~1e-5 of the pixels off by 1 (rounding at .5), see README "顺序 2"."""
    s = n / o
    m = np.zeros((o, n), np.float64)
    for j in range(o):
        a, b = j * s, (j + 1) * s
        for i in range(int(np.floor(a)), min(n, int(np.ceil(b - 1e-9)))):
            m[j, i] = (min(b, i + 1) - max(a, i)) / s
    return m


if __name__ == "__main__":
    print(boxes())
