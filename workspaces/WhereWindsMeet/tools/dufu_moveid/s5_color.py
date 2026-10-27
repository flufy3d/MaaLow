"""Order 5: tell colour (金光 / 红光) of every frame of the live recordings, with the order-2 crop classifier.

    uv run --no-project --with torch --with torchvision --with opencv-python-headless --with numpy \
        --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match \
        python workspaces/WhereWindsMeet/tools/dufu_moveid/s5_color.py [REC ...]
    ... s5_color.py --remap          # MOVEID_PHASE=1: re-remap the existing <rec>.npz in place (no classifier run)

Same pipeline as order 2 (s2_feat.frame_feat line candidates -> s2_crops crops -> color/tell_resnet18.pt), but on
EVERY frame of the video (not only near contacts): a dodged blow leaves no contact, its 金光 is still on screen.
Out: data/moveid/live/color/<rec>.npz: fp [frames, 3] = per frame max pR / pG / pC over its line candidates (no
candidate: 0), as s2_color.frame_probs. s2_color.label / episodes read it.

MOVEID_PHASE=1 (独夫 阶段一) has no 红光 (2026-10-27, the teacher): the classifier's R on 碰撞 sparks / 金光 is a
misread, remapped like s2_color.py's PHASE==1 remap (red -> gold for a 金光, -> none for a spark): the red column is
always 0 and the red mass is moved to gold unless the crop's clash score C is >= its gold score G (a spark: no tell).
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
import torch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import OUT, PHASE  # noqa: E402
from s2_crops import RUN_MIN, box_for  # noqa: E402
from s2_feat import K, frame_feat  # noqa: E402
from s2_model import MODEL, net, predict  # noqa: E402

LIVE = OUT / "live"
DST = LIVE / "color"
P_ON = 0.5   # s2_color.P_ON


def remap_p1(fp: np.ndarray) -> tuple[np.ndarray, int, int]:
    """阶段一没有红光（s2_color.py 的 PHASE==1 remap 的帧级版本，module doc）: red -> gold / none, red column 0.
    -> (fp, frames that went to gold, frames that were a spark = no tell)"""
    r, g, c = fp[:, 0].copy(), fp[:, 1].copy(), fp[:, 2]
    red = r >= P_ON
    spark = red & (c >= g)
    fp[:, 0] = 0
    fp[:, 1] = np.maximum(g, np.where(red & ~spark, r, 0))
    return fp, int((red & ~spark).sum()), int(spark.sum())


def one(rec: str, m, dev) -> str:
    out = DST / f"{rec}.npz"
    if out.exists():
        return f"{rec} skip"
    cap = cv2.VideoCapture(str(LIVE / "video" / f"{rec}.mp4"))
    prev = None
    frames, imgs = [], []
    n = 0
    while True:
        ok, im = cap.read()
        if not ok:
            break
        c, _, prev = frame_feat(im, prev)
        for k in range(K):
            if c[k, 3] >= RUN_MIN:
                x0, y0, ww, hh = box_for(c[k, 0], c[k, 4])
                imgs.append(cv2.resize(im[y0:y0 + hh, x0:x0 + ww], (ww // 2, hh // 2), interpolation=cv2.INTER_AREA))
                frames.append(n)
        n += 1
    fp = np.zeros((n + 1, 3), np.float32)
    if imgs:
        p = predict(m, np.stack(imgs), dev)
        for f, pp in zip(frames, p):
            fp[f] = np.maximum(fp[f], pp[:3])
    remap = ""
    if PHASE == 1:
        fp, ng, ns = remap_p1(fp)
        remap = f"; remap p1: gold {ng} spark {ns}"
    DST.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, fp=fp, frames=np.int32(n))
    return f"{rec} {n} frames {len(imgs)} crops; gold frames {(fp[:, 1] >= 0.5).sum()} red frames {(fp[:, 0] >= 0.5).sum()}{remap}"


def remap_only() -> None:
    """MOVEID_PHASE=1: apply remap_p1 to the existing <rec>.npz (the classifier output), no video decode."""
    for p in sorted(DST.glob("*.npz")):
        z = np.load(p)
        fp, ng, ns = remap_p1(z["fp"])
        np.savez_compressed(p, fp=fp, frames=z["frames"])
        print(f"{p.stem}: gold {ng} spark {ns}", flush=True)


def main() -> None:
    if "--remap" in sys.argv[1:]:
        if PHASE != 1:
            raise SystemExit("--remap is the MOVEID_PHASE=1 (阶段一, no 红光) remap")
        remap_only()
        return
    recs = sys.argv[1:] or sorted(p.stem for p in (LIVE / "video").glob("*.mp4"))
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    m = net(dev)
    m.load_state_dict(torch.load(MODEL, map_location=dev))
    for r in recs:
        print(one(r, m, dev), flush=True)


if __name__ == "__main__":
    main()
