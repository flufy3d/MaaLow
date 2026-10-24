"""Order 2 clustering sample sheets: one image per class, data/moveid/moves/sheets/c<id>.jpg.

Each row = one random chain of the class: the whole screen (glob view) at the first contact, then the big view
(s2_views.py) at first contact -30, -20, -10, 0, +5 frames. Row caption: round, chain id, opener colour, chain length,
contact results, damage. unknown.jpg = UNKNOWN_ROWS random chains of the unknown set (move chains). Fixed seed.
"""
from __future__ import annotations

import argparse
import random

import cv2
import numpy as np

from common import OUT, VIDEO, read_json
from s2_views import views

MOVES = OUT / "moves"
OFFS = (-30, -20, -10, 0, 5)
ROWS, UNKNOWN_ROWS = 6, 12
CAP_H = 22
SHORT = {"ok": "ok", "hit_pf": "pf", "hit_unk": "hit", "flare": "fl", "grab": "gr"}


def frames(rec: str, f0: int) -> dict[int, np.ndarray]:
    cap = cv2.VideoCapture(str(VIDEO / f"{rec}.mp4"))
    lo = f0 + OFFS[0]
    cap.set(cv2.CAP_PROP_POS_FRAMES, max(lo, 0))
    out = {}
    for f in range(max(lo, 0), f0 + OFFS[-1] + 1):
        ok, im = cap.read()
        if not ok:
            break
        out[f] = im
    cap.release()
    return out


def row(c: dict, conf: float) -> np.ndarray:
    fr = frames(c["rec"], c["frame0"])
    blank = np.zeros((720, 1080, 3), np.uint8)
    f0 = c["frame0"]
    g = views(fr.get(f0, blank))["glob"]
    g = cv2.resize(g, (307, 192), interpolation=cv2.INTER_AREA)
    tiles = [g]
    for o in OFFS:
        b = views(fr.get(f0 + o, blank))["big"].copy()
        cv2.putText(b, f"{o:+d}", (4, 186), 0, 0.55, (255, 255, 255), 2)
        cv2.putText(b, f"{o:+d}", (4, 186), 0, 0.55, (0, 0, 0), 1)
        tiles.append(b)
    body = np.hstack(tiles)
    head = np.zeros((CAP_H, body.shape[1], 3), np.uint8)
    res = " ".join(SHORT.get(t, t) for t in c["types"][:8]) + (" ..." if len(c["types"]) > 8 else "")
    dmg = sum(d or 0 for d in c["dmg"])
    txt = (f"{c['round']} ch{c['chain_id']} f{f0} | {c['color']} | len {len(c['offsets'])} "
           f"off {','.join(str(o) for o in c['offsets'][1:5])} | {res} | dmg {dmg:.3f} | conf {conf:.2f}")
    col = {"gold": (0, 215, 255), "red": (60, 60, 255)}.get(c["color"], (230, 230, 230))
    cv2.putText(head, txt, (4, 16), 0, 0.5, col, 1)
    return np.vstack([head, body])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--only", default="", help="comma-separated class ids (-1 = unknown)")
    a = ap.parse_args()
    tax = read_json(MOVES / "taxonomy.json")
    assign = read_json(MOVES / "assign.json")
    cs = {c["chain_id"]: c for c in read_json(MOVES / "slices.json")["chains"]}
    out = MOVES / "sheets"
    out.mkdir(parents=True, exist_ok=True)
    only = {int(x) for x in a.only.split(",") if x.strip()}
    if not only:  # class ids change between runs: drop the old sheets
        for f in list(out.glob("c*.jpg")) + list(out.glob("unknown.jpg")):
            f.unlink()
    for r in tax["classes"]:
        k = r["id"]
        if only and k not in only:
            continue
        mem = [m for m in r["members"] if k >= 0 or cs[m]["kind"] == "move"]
        rng = random.Random(a.seed * 1000 + k)
        pick = sorted(rng.sample(mem, min(len(mem), UNKNOWN_ROWS if k < 0 else ROWS)))
        rows = [row(cs[m], assign[str(m)]["conf"]) for m in pick]
        title = np.zeros((28, rows[0].shape[1], 3), np.uint8)
        tt = (f"{'unknown' if k < 0 else f'c{k}'} [{r['kind']}] n={r['n']} colour {r['color']} "
              f"({r['color_purity']}) len mode {r['length_mode']} ({r['length_mode_share']}) "
              f"ok {r['ok_rate']} hit {r['hit_rate']} dmg {r['dmg_total']}{' FATAL' if r['fatal'] else ''}")
        cv2.putText(title, tt, (4, 20), 0, 0.6, (0, 255, 255), 1)
        img = np.vstack([title] + rows)
        name = "unknown.jpg" if k < 0 else f"c{k:02d}.jpg"
        cv2.imwrite(str(out / name), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        print(name, len(pick), flush=True)


if __name__ == "__main__":
    main()
