"""顺序 2: self-check sheets for the tell colours (events_ext.json) and their grading.

  s2_check.py sheets [--seed 2] [--gold 60 --red 60 --flare 40 --none 40]
      -> data/moveid/color/check/{gold,red,flare,none}_NN.jpg + check/samples.json
  s2_check.py grade check/grades.json        (prints the accuracy tables)

A cell = 3 frames of one contact side by side, each a 560 x 372 crop (shown at half size) centred on the tell's line
(the strongest s2_feat candidate at the onset frame; frame centre 555, 320 when there is none). Frames: onset, +2, +5
for gold / red; for none: the frame of the window's highest tell probability and two more spread over the window.
Caption: cell number, event id, type, colour (conf), onset, aux flare.
Sets: `gold` / `red` = random contacts labelled so; `flare` = contacts where aux flare (index type flare) and the
colour disagree (flare but not gold, or gold but not flare); `none` = random none (recall check, not required).
grades.json: {"<set>": {"<cell>": "G" | "R" | "N" | "?"}} = what the cell really shows (G 金光, R 红光, N no tell).
"""
from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import OUT, VIDEO, read_json, write_json  # noqa: E402
from s2_feat import CAND_COLS, FEAT  # noqa: E402

CHECK = OUT / "color" / "check"
CW, CH = 560, 372
PER = 8  # cells per sheet (2 columns x 4 rows)
CI = {c: i for i, c in enumerate(CAND_COLS)}
SHORT = {"gold": "G", "red": "R", "none": "N", "unknown": "?"}


def pick(seed: int, n: dict) -> dict:
    ext = read_json(OUT / "events_ext.json")["events"]
    rnd = random.Random(seed)
    out = {}
    g = [e for e in ext if e["color"] == "gold"]
    r = [e for e in ext if e["color"] == "red"]
    fl = [e for e in ext if (e["type"] == "flare") != (e["color"] == "gold")]
    no = [e for e in ext if e["color"] == "none"]
    for name, s in [("gold", g), ("red", r), ("flare", fl), ("none", no)]:
        out[name] = [e["id"] for e in rnd.sample(s, min(n[name], len(s)))]
    return out


def frames_for(e: dict, col: dict, fp: np.ndarray | None) -> list[int]:
    c = e["frame"]
    if e["color_onset_frame"] is not None:
        o = e["color_onset_frame"]
        return [o, o + 2, o + 5]
    lo, hi = col.get("window", [-30, -2])
    lo, hi = c + lo, c + hi
    if hi < lo:
        return [c - 6, c - 3, c - 1]
    best = lo
    if fp is not None:
        seg = fp[lo:hi + 1, :2].max(1)
        if len(seg):
            best = lo + int(seg.argmax())
    rest = [f for f in np.linspace(lo, hi, 4).round().astype(int).tolist() if abs(f - best) > 2][:2]
    return sorted({best, *rest})[:3]


def cell(cap, cand, e: dict, frames: list[int], num: int, aux_flare: bool) -> np.ndarray:
    tiles = []
    for f in frames:
        cap.set(cv2.CAP_PROP_POS_FRAMES, f)
        ok, im = cap.read()
        if not ok:
            im = np.zeros((720, 1080, 3), np.uint8)
        cx, cy = 555, 320
        if e["color_onset_frame"] is not None:
            o = e["color_onset_frame"]
            k = int(np.argmax(cand[o, :, CI["run"]]))
            if cand[o, k, CI["run"]] > 0:
                cx, cy = cand[o, k, CI["xc"]], cand[o, k, CI["y"]]
        x0 = int(min(max(0, cx - CW / 2), 1080 - CW))
        y0 = int(min(max(0, cy - CH / 2), 720 - CH))
        t = cv2.resize(im[y0:y0 + CH, x0:x0 + CW], (CW // 2, CH // 2), interpolation=cv2.INTER_AREA)
        cv2.putText(t, f"{f - e['frame']:+d}", (4, CH // 2 - 6), 0, 0.5, (255, 255, 255), 1)
        tiles.append(t)
    while len(tiles) < 3:
        tiles.append(np.zeros_like(tiles[0]))
    body = np.hstack(tiles)
    cap_h = 22
    head = np.zeros((cap_h, body.shape[1], 3), np.uint8)
    txt = (f"#{num} ev{e['id']} {e['type']} -> {e['color']} ({e['color_conf']}) onset {e['color_onset']}"
           f" aux_flare={'Y' if aux_flare else 'n'}")
    cv2.putText(head, txt, (4, 16), 0, 0.5, (0, 255, 255), 1)
    out = np.vstack([head, body])
    cv2.rectangle(out, (0, 0), (out.shape[1] - 1, out.shape[0] - 1), (128, 128, 128), 1)
    return out


def sheets(seed: int, n: dict) -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from s2_color import frame_probs
    idx = read_json(OUT / "index.json")
    ext = {e["id"]: e for e in read_json(OUT / "events_ext.json")["events"]}
    col = read_json(OUT / "color" / "color.json")
    fps = frame_probs(read_json(OUT / "color" / "crop_probs.json"), idx["rounds"])
    samples = pick(seed, n)
    CHECK.mkdir(parents=True, exist_ok=True)
    write_json(CHECK / "samples.json", samples)
    for name, ids in samples.items():
        cells = []
        for j, i in enumerate(ids):
            e = ext[i]
            cap = cv2.VideoCapture(str(VIDEO / f"{e['rec']}.mp4"))
            cand = np.load(FEAT / f"{e['rec']}.npz")["cand"]
            fr = frames_for(e, col.get(str(i), {}), fps.get(e["rec"]))
            cells.append(cell(cap, cand, e, fr, j, idx["events"][i]["type"] == "flare"))
        for s in range(0, len(cells), PER):
            cs = cells[s:s + PER]
            while len(cs) % 2:
                cs.append(np.zeros_like(cs[0]))
            img = np.vstack([np.hstack(cs[k:k + 2]) for k in range(0, len(cs), 2)])
            cv2.imwrite(str(CHECK / f"{name}_{s // PER:02d}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        print(name, len(ids))


def grade(path: Path) -> None:
    samples = read_json(CHECK / "samples.json")
    grades = read_json(path)
    ext = {e["id"]: e for e in read_json(OUT / "events_ext.json")["events"]}
    for name, ids in samples.items():
        g = grades.get(name, {})
        if not isinstance(g, dict):
            continue
        rows = []
        for j, i in enumerate(ids):
            t = g.get(str(j))
            if t is None:
                continue
            rows.append((SHORT[ext[i]["color"]], t))
        if not rows:
            continue
        from collections import Counter
        cm = Counter(rows)
        sure = [(p, t) for p, t in rows if t != "?"]
        ok = sum(p == t for p, t in sure)
        print(f"{name}: graded {len(rows)}, unsure {len(rows) - len(sure)}, correct {ok}/{len(sure)} = {100 * ok / max(1, len(sure)):.1f}%")
        for (p, t), k in sorted(cm.items()):
            print(f"   label {p} truth {t}: {k}")


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a1 = sub.add_parser("sheets")
    a1.add_argument("--seed", type=int, default=2)
    for k, v in [("gold", 60), ("red", 60), ("flare", 40), ("none", 40)]:
        a1.add_argument(f"--{k}", type=int, default=v)
    a2 = sub.add_parser("grade")
    a2.add_argument("path")
    a = ap.parse_args()
    if a.cmd == "sheets":
        sheets(a.seed, {"gold": a.gold, "red": a.red, "flare": a.flare, "none": a.none})
    else:
        grade(Path(a.path))


if __name__ == "__main__":
    main()
