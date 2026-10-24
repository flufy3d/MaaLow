"""顺序 2: crops of the line candidates near contacts, for the tell classifier (s2_color.py).

For every contact, frames [c - PRE, c + POST] whose s2_feat candidate line has run >= RUN_MIN px: a CROP_H x CROP_W
full-res window centred on the line (clamped to the frame), resized by 1/2. One crop per (frame, candidate).
Output data/moveid/color/crops/<rec>.npz: frame (N,), k (N,), box (N, 4) x0 y0 w h, img (N, CROP_H/2, CROP_W/2, 3) BGR.
"""
from __future__ import annotations

import argparse
import sys
from multiprocessing import Pool
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import OUT, VIDEO, read_json  # noqa: E402
from s2_feat import CAND_COLS, FEAT  # noqa: E402

CROPS = OUT / "color" / "crops"
PRE, POST = 36, 2
RUN_MIN = 150
CROP_H, CROP_W = 240, 480
CI = {c: i for i, c in enumerate(CAND_COLS)}


def box_for(y: float, xc: float) -> tuple[int, int, int, int]:
    x0 = int(min(max(0, xc - CROP_W / 2), 1080 - CROP_W))
    y0 = int(min(max(0, y - CROP_H / 2), 720 - CROP_H))
    return x0, y0, CROP_W, CROP_H


def wanted(rec: str, contacts: list[int]) -> list[tuple[int, int]]:
    cand = np.load(FEAT / f"{rec}.npz")["cand"]
    fr = set()
    for c in contacts:
        fr.update(range(max(0, c - PRE), min(len(cand), c + POST + 1)))
    out = []
    for f in sorted(fr):
        for k in range(cand.shape[1]):
            if cand[f, k, CI["run"]] >= RUN_MIN:
                out.append((f, k))
    return out


def one(job) -> str:
    rec, contacts = job
    cv2.setNumThreads(1)
    out = CROPS / f"{rec}.npz"
    if out.exists():
        return f"{rec} skip"
    cand = np.load(FEAT / f"{rec}.npz")["cand"]
    w = wanted(rec, contacts)
    need = {}
    for f, k in w:
        need.setdefault(f, []).append(k)
    cap = cv2.VideoCapture(str(VIDEO / f"{rec}.mp4"))
    frames, ks, boxes, imgs = [], [], [], []
    f = 0
    last = max(need) if need else -1
    while f <= last:
        if f in need:
            ok, im = cap.read()
            if not ok:
                break
            for k in need[f]:
                b = box_for(cand[f, k, CI["y"]], cand[f, k, CI["xc"]])
                x0, y0, ww, hh = b
                imgs.append(cv2.resize(im[y0:y0 + hh, x0:x0 + ww], (ww // 2, hh // 2), interpolation=cv2.INTER_AREA))
                frames.append(f)
                ks.append(k)
                boxes.append(b)
        else:
            if not cap.grab():
                break
        f += 1
    tmp = out.with_suffix(".tmp.npz")
    np.savez_compressed(tmp, frame=np.array(frames, np.int32), k=np.array(ks, np.int8), box=np.array(boxes, np.int16).reshape(-1, 4),
                        img=np.array(imgs, np.uint8).reshape(-1, CROP_H // 2, CROP_W // 2, 3))
    tmp.replace(out)
    return f"{rec} {len(frames)} crops"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--procs", type=int, default=6)
    a = ap.parse_args()
    idx = read_json(OUT / "index.json")
    by = {}
    for e in idx["events"]:
        by.setdefault(e["rec"], []).append(e["frame"])
    CROPS.mkdir(parents=True, exist_ok=True)
    jobs = [(r["rec"], by.get(r["rec"], [])) for r in idx["rounds"] if (FEAT / f"{r['rec']}.npz").exists()]
    with Pool(a.procs) as p:
        for i, msg in enumerate(p.imap_unordered(one, jobs)):
            print(f"[{i + 1}/{len(jobs)}] {msg}", flush=True)


if __name__ == "__main__":
    main()
