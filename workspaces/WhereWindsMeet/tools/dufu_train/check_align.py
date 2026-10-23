"""Check the trace clock against the recording: for each hp-drop / qi-step contact of a round, read the hp bar / boss
真气 line in the video frame by frame and report where the step really is relative to the trace row's capture time.

    uv run --with numpy --with opencv-python-headless python workspaces/WhereWindsMeet/tools/dufu_train/check_align.py data/p2 [r002 ...]

Output per contact: video frame of the step - video frame of the trace row's `cap` (negative = the step is on an
earlier video frame than the row that first saw it; expected -1..0 at ~40 ms rows). Needs the recording under
workspaces/WhereWindsMeet/recordings/<rec.txt>/ (meta.json `started` + video.mp4).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from labels import contacts

from data import FRAME_MS, scan

REC_ROOT = Path(__file__).resolve().parents[2] / "recordings"
HP_ROI, HP_LEFT, HP_FULL = (405, 681, 280, 5), 415, 669
QI_ROI = (347, 35, 386, 6)


def bar_px(img, roi, lo, hi, gap=12):
    x, y, w, h = roi
    hsv = cv2.cvtColor(img[y:y + h, x:x + w], cv2.COLOR_BGR2HSV)
    m = cv2.inRange(hsv, np.array(lo), np.array(hi)).any(axis=0)
    xs = np.where(m)[0]
    if not len(xs):
        return 0
    right = xs[0]
    for v in xs[1:]:
        if v - right > gap:
            break
        right = v
    return int(right + 1)


def hp_of(img):
    return (bar_px(img, HP_ROI, (0, 0, 140), (180, 45, 255)) + HP_ROI[0] - HP_LEFT) / (HP_FULL - HP_LEFT)


def qi_of(img):
    return bar_px(img, QI_ROI, (88, 30, 150), (108, 130, 255), gap=2)


def main(root, names):
    for r in scan(root):
        if names and r.name not in names:
            continue
        rd = REC_ROOT / (r.rec or "")
        if not (rd / "video.mp4").exists():
            print(r.name, "no recording", r.rec)
            continue
        meta = json.loads((rd / "meta.json").read_text(encoding="utf-8"))
        cs = contacts(r)
        vfs = [round((r.start + r.cap[c.row] - meta["started"]) / FRAME_MS) for c in cs]
        need = {i for vf in vfs for i in range(vf - 15, vf + 8)}
        # one sequential decode pass (seeking per frame is ~100x slower); only the needed frames are read out
        frames = {}
        cap = cv2.VideoCapture(str(rd / "video.mp4"))
        last = max(need) if need else -1
        i = 0
        while i <= last and cap.grab():
            if i in need:
                frames[i] = cap.retrieve()[1]
            i += 1

        out = []
        for c, vf in zip(cs, vfs):
            rng = range(vf - 15, vf + 8)
            if c.kind == "hit":
                vals = [hp_of(frames[i]) if frames.get(i) is not None else np.nan for i in rng]
                base, th = np.nanmedian(vals[:6]), 0.02
            else:
                vals = [qi_of(frames[i]) if frames.get(i) is not None else np.nan for i in rng]
                base, th = np.nanmedian(vals[:6]), 6
            step = next((i for i, v in zip(rng, vals) if v < base - th), None)
            d = None if step is None else step - vf
            out.append(d)
            print(f"{r.name} {c.kind:3s} row {c.row:5d} wall {r.wall[c.row]:8.0f} vf {vf:5d} step {d}")
        ds = [d for d in out if d is not None]
        if ds:
            print(f"{r.name}: step - row frame: median {np.median(ds):+.1f}, range {min(ds)}..{max(ds)}, n {len(ds)}/{len(out)}")


if __name__ == "__main__":
    main(sys.argv[1], set(sys.argv[2:]))
