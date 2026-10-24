"""顺序 2: per-frame tell-line features for every frame of every recording (see README「顺序 2：光色与连段」).

The 金光 / 红光 tells are anamorphic lens flares on the boss: a bright star plus a thin horizontal line, gold or red.
Per frame (half resolution, rows Y0..Y1 of the full frame) we look for thin bright horizontal ridges in V
(V >= V_MIN and V - max(V[y-d], V[y+d]) >= RIDGE for d in D_OFFS: thin and thick/bloomed lines), keep the K best
rows (non-max suppressed), and describe each by its length and the hue of its halo. Plus a few global numbers.

Output data/moveid/color/feat/<rec>.npz: cand (F, K, NC) float32 (columns CAND_COLS), glob (F, NG) float32
(GLOB_COLS), v = FEAT_V; and data/moveid/color/crops/<rec>.npz (s2_crops.py format) from the same decode. Coordinates are full-resolution px.
"""
from __future__ import annotations

import argparse
import sys
import time
from multiprocessing import Pool
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import OUT, VIDEO, read_json  # noqa: E402

FEAT_V = 1
FEAT = OUT / "color" / "feat"
Y0, Y1 = 60, 600  # full-res rows scanned (HUD bars above / below)
S = 2  # downscale
V_MIN, RIDGE = 200, 40
D_OFFS = (4, 10)  # half-res: 8 / 20 full-res px
K, NMS = 3, 6
CAND_COLS = ["y", "n", "span", "run", "xc", "red", "orange", "gold", "white", "other", "n_thin", "n_thick"]
GLOB_COLS = ["vmean", "bright_red", "bright_gold", "bright_white", "motion"]
HALO = 3  # half-res rows above / below the line whose saturated px give its colour


def frame_feat(im: np.ndarray, prev_small):
    sm = cv2.resize(im[Y0:Y1], (im.shape[1] // S, (Y1 - Y0) // S), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(sm, cv2.COLOR_BGR2HSV)
    h = hsv[..., 0]
    s = hsv[..., 1]
    v = hsv[..., 2].astype(np.int16)
    H, W = v.shape
    bright = v >= V_MIN
    masks = []
    for d in D_OFFS:
        up = np.empty_like(v)
        dn = np.empty_like(v)
        up[d:] = v[:-d]
        up[:d] = 255
        dn[:-d] = v[d:]
        dn[-d:] = 255
        masks.append(bright & (v - np.maximum(up, dn) >= RIDGE))
    ridge = masks[0] | masks[1]
    rc = ridge.sum(1)
    rc3 = np.convolve(rc, np.ones(3, np.int64), "same")
    cand = np.zeros((K, len(CAND_COLS)), np.float32)
    order = np.argsort(-rc3)
    taken: list[int] = []
    sat = s >= 50
    for y in order:
        if len(taken) >= K or rc3[y] < 8:
            break
        if any(abs(int(y) - t) <= NMS for t in taken):
            continue
        taken.append(int(y))
        a, b = max(0, y - 1), min(H, y + 2)
        band = ridge[a:b].any(0)
        xs = np.flatnonzero(band)
        n = len(xs)
        span = int(xs[-1] - xs[0]) if n else 0
        run = best = 0
        if n:
            gaps = np.diff(xs)
            cur = 1
            for g in gaps:  # longest run allowing gaps <= 5 half-res px
                cur = cur + g if g <= 5 else 1
                best = max(best, cur)
            run = max(best, 1)
        ha, hb = max(0, y - HALO), min(H, y + HALO + 1)
        hh = h[ha:hb][:, band]
        hm = sat[ha:hb][:, band] & (v[ha:hb][:, band] >= 120)
        hu = hh[hm]
        red = int(((hu <= 8) | (hu >= 170)).sum())
        org = int(((hu >= 9) & (hu <= 17)).sum())
        gold = int(((hu >= 18) & (hu <= 35)).sum())
        oth = int(hm.sum()) - red - org - gold
        white = int(((s[a:b][:, band] < 50) & (v[a:b][:, band] >= 220)).sum())
        cand[len(taken) - 1] = [y * S + Y0 + S // 2, n * S, span * S, run * S, (xs.mean() * S if n else 0), red, org, gold,
                                white, oth, masks[0][a:b].any(0).sum() * S, masks[1][a:b].any(0).sum() * S]
    vs = hsv[..., 2]
    br = vs >= 200
    gl = np.array([
        float(vs.mean()),
        int((br & (s >= 100) & ((h <= 8) | (h >= 170))).sum()),
        int((br & (s >= 60) & (h >= 15) & (h <= 35)).sum()),
        int((br & (s < 40)).sum()),
        0.0,
    ], np.float32)
    small = cv2.cvtColor(cv2.resize(sm[:, W // 4: 3 * W // 4], (64, 48), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
    if prev_small is not None:
        gl[4] = float(np.abs(small - prev_small).mean())
    return cand, gl, small


def one(job) -> str:
    """Features of every frame; also writes the classifier crops (s2_crops.py) in the same decode pass."""
    rec, contacts = job
    cv2.setNumThreads(1)
    from s2_crops import CROPS, CROP_H, CROP_W, POST, PRE, RUN_MIN, box_for
    out = FEAT / f"{rec}.npz"
    cout = CROPS / f"{rec}.npz"
    if out.exists():  # crops of rounds whose features came first: s2_crops.py
        return f"{rec} skip"
    near = set()
    for c in contacts:
        near.update(range(max(0, c - PRE), c + POST + 1))
    cap = cv2.VideoCapture(str(VIDEO / f"{rec}.mp4"))
    cands, globs = [], []
    frames, ks, boxes, imgs = [], [], [], []
    prev = None
    t0 = time.time()
    f = 0
    while True:
        ok, im = cap.read()
        if not ok:
            break
        c, g, prev = frame_feat(im, prev)
        cands.append(c)
        globs.append(g)
        if f in near:
            for k in range(K):
                if c[k, 3] >= RUN_MIN:
                    b = box_for(c[k, 0], c[k, 4])
                    x0, y0, ww, hh = b
                    imgs.append(cv2.resize(im[y0:y0 + hh, x0:x0 + ww], (ww // 2, hh // 2), interpolation=cv2.INTER_AREA))
                    frames.append(f)
                    ks.append(k)
                    boxes.append(b)
        f += 1
    tmp = out.with_suffix(".tmp.npz")
    np.savez_compressed(tmp, cand=np.stack(cands), glob=np.stack(globs), v=FEAT_V)
    tmp.replace(out)
    CROPS.mkdir(parents=True, exist_ok=True)
    tmp = cout.with_suffix(".tmp.npz")
    np.savez_compressed(tmp, frame=np.array(frames, np.int32), k=np.array(ks, np.int8), box=np.array(boxes, np.int16).reshape(-1, 4),
                        img=np.array(imgs, np.uint8).reshape(-1, CROP_H // 2, CROP_W // 2, 3))
    tmp.replace(cout)
    return f"{rec} {len(cands)} frames {len(frames)} crops {len(cands) / (time.time() - t0):.0f} fps"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--procs", type=int, default=6)
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    idx = read_json(OUT / "index.json")
    by: dict[str, list[int]] = {}
    for e in idx["events"]:
        by.setdefault(e["rec"], []).append(e["frame"])
    recs = [(r["rec"], by.get(r["rec"], [])) for r in idx["rounds"]]
    if a.only:
        recs = [r for r in recs if r[0] in a.only.split(",")]
    FEAT.mkdir(parents=True, exist_ok=True)
    with Pool(a.procs) as p:
        for i, msg in enumerate(p.imap_unordered(one, recs)):
            print(f"[{i + 1}/{len(recs)}] {msg}", flush=True)


if __name__ == "__main__":
    main()
