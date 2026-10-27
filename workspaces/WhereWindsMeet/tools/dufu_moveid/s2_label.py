"""顺序 2: hand labels for the tell classifier (s2_color.py), via numbered crop sheets.

  s2_label.py sheet --n 24 [--mode strat|uncertain] [--seed S]   -> data/moveid/color/label_sheets/sNNN.jpg + .json
  s2_label.py set sNNN "RRGN C..."                                -> s2_labels.json (one letter per tile, spaces ignored)

Letters: R = 红光 tell (red star + line on the boss), G = 金光 tell (gold star + line), C = clash / impact burst (radial
rays at a contact), N = anything else (slash trails, arcs, ground lines, explosions), ? = cannot tell (not stored).
Keys are "<rec>:<frame>:<k>" (crop of s2_feat candidate k in that video frame).
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import OUT, PHASE, read_json, write_json  # noqa: E402
from s2_crops import CROPS  # noqa: E402
from s2_feat import CAND_COLS, FEAT  # noqa: E402

LABELS = Path(__file__).resolve().parent / ("s2_labels.json" if PHASE == 2 else f"s2_labels_p{PHASE}.json")
SHEETS = OUT / "color" / "label_sheets"
CI = {c: i for i, c in enumerate(CAND_COLS)}
COLS = 4


def all_crops():
    """[(key, rec, idx in crops file, cand row)]"""
    out = []
    for p in sorted(CROPS.glob("*.npz")):
        if p.name.endswith(".tmp.npz"):
            continue
        rec = p.stem
        z = np.load(p)
        cand = np.load(FEAT / f"{rec}.npz")["cand"]
        for i, (f, k) in enumerate(zip(z["frame"], z["k"])):
            out.append((f"{rec}:{int(f)}:{int(k)}", rec, i, cand[f, k]))
    return out


def hue_class(c) -> str:
    tot = c[CI["red"]] + c[CI["orange"]] + c[CI["gold"]] + c[CI["other"]] + 1e-6
    r, o, g = c[CI["red"]] / tot, c[CI["orange"]] / tot, c[CI["gold"]] / tot
    return "r" if r >= 0.6 else "g" if g >= 0.4 else "o" if o >= 0.4 else "m"


def sheet(n: int, seed: int, mode: str) -> None:
    labels = read_json(LABELS, {})
    rows = [r for r in all_crops() if r[0] not in labels]
    rnd = random.Random(seed)
    if mode == "uncertain":
        pr = read_json(OUT / "color" / "crop_probs.json", {})
        rows = [r for r in rows if r[0] in pr]
        rows.sort(key=lambda r: -pr[r[0]]["unc"])
        pick = rows[: n * 3]
        rnd.shuffle(pick)
        pick = pick[:n]
    elif mode.startswith("pred"):  # pred:R / pred:G = crops the current model calls R / G (finds its false positives)
        pr = read_json(OUT / "color" / "crop_probs.json", {})
        ci = "RGCN".index(mode.split(":")[1])
        rows = [r for r in rows if r[0] in pr and pr[r[0]]["p"][ci] >= 0.5]
        pick = rnd.sample(rows, min(n, len(rows)))
    elif mode == "red":  # red-dominant halos only (red tells are rare among all line candidates)
        rows = [r for r in rows if hue_class(r[3]) == "r"]
        pick = rnd.sample(rows, min(n, len(rows)))
    else:
        by = {}
        for r in rows:
            by.setdefault(hue_class(r[3]), []).append(r)
        pick = []
        while len(pick) < n and any(by.values()):
            for k in sorted(by):
                if by[k] and len(pick) < n:
                    pick.append(by[k].pop(rnd.randrange(len(by[k]))))
    SHEETS.mkdir(parents=True, exist_ok=True)
    num = len(list(SHEETS.glob("s*.json"))) + 1
    name = f"s{num:03d}"
    cache = {}
    tiles = []
    for j, (key, rec, i, c) in enumerate(pick):
        if rec not in cache:
            cache[rec] = np.load(CROPS / f"{rec}.npz")["img"]
        t = cache[rec][i].copy()
        t = cv2.resize(t, (t.shape[1] * 3 // 2, t.shape[0] * 3 // 2))
        cv2.putText(t, str(j), (4, 22), 0, 0.7, (0, 0, 0), 4)
        cv2.putText(t, str(j), (4, 22), 0, 0.7, (255, 255, 255), 2)
        cv2.rectangle(t, (0, 0), (t.shape[1] - 1, t.shape[0] - 1), (90, 90, 90), 1)
        tiles.append(t)
    while len(tiles) % COLS:
        tiles.append(np.zeros_like(tiles[0]))
    img = np.vstack([np.hstack(tiles[j:j + COLS]) for j in range(0, len(tiles), COLS)])
    cv2.imwrite(str(SHEETS / f"{name}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 88])
    write_json(SHEETS / f"{name}.json", [p[0] for p in pick])
    print(name, len(pick), SHEETS / f"{name}.jpg")


def set_labels(name: str, letters: str) -> None:
    keys = read_json(SHEETS / f"{name}.json")
    s = [ch for ch in letters.upper() if not ch.isspace()]
    assert len(s) == len(keys), (len(s), len(keys))
    labels = read_json(LABELS, {})
    for k, ch in zip(keys, s):
        assert ch in "RGCN?", ch
        if ch != "?":
            labels[k] = ch
    write_json(LABELS, dict(sorted(labels.items())), indent=0)
    from collections import Counter
    print(len(labels), Counter(labels.values()))


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a1 = sub.add_parser("sheet")
    a1.add_argument("--n", type=int, default=24)
    a1.add_argument("--seed", type=int, default=0)
    a1.add_argument("--mode", default="strat")
    a2 = sub.add_parser("set")
    a2.add_argument("name")
    a2.add_argument("letters")
    a = ap.parse_args()
    if a.cmd == "sheet":
        sheet(a.n, a.seed, a.mode)
    else:
        set_labels(a.name, a.letters)


if __name__ == "__main__":
    main()
