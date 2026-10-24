"""Spot check: export raw frames around random hit contacts.

    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/check.py [--n 3] [--seed 1] [--kind hit]

For each picked event: frames contact-10 .. contact+AFTER (--after, default 8) of the recording as PNG into
data/moveid/check/<round>_<rec>_ev<id>/f<frame>_<rel>.png (rel = frame - contact frame), plus info.json: the event, and
the hp bar on each exported frame read from bars/ (hp) and again from the exported image (hp_live; equal = the frame
numbering matches). With the hit definition (contact = bar step - 5 f) the hp bar should drop at about rel +5..+6.
"""
from __future__ import annotations

import argparse
import random

import cv2
import numpy as np

import reads

from common import BARS, OUT, REPO, read_json, write_json

BEFORE = 10


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=3)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--kind", default="hit")
    ap.add_argument("--after", type=int, default=8, help="frames after the contact (hit: the bar shows the drop at ~+5..+6)")
    a = ap.parse_args()
    idx = read_json(OUT / "index.json")
    evs = [e for e in idx["events"] if e["kind"] == a.kind]
    rounds = {r["rec"]: r for r in idx["rounds"]}
    picks = random.Random(a.seed).sample(evs, a.n)
    for e in picks:
        rd = rounds[e["rec"]]
        d = OUT / "check" / f"{e['round'].replace('/', '_')}_{e['rec']}_ev{e['id']}"
        d.mkdir(parents=True, exist_ok=True)
        cap = cv2.VideoCapture(str(REPO / rd["video"]))
        f0 = e["frame"] - BEFORE
        pos = 0  # read from the start: exact frame numbers (seeking can land off by a few)
        hp = np.load(BARS / f"{e['rec']}.npz")["hp"]
        files = []
        while pos <= e["frame"] + a.after:
            ok, img = cap.read()
            if not ok:
                break
            if pos >= f0:
                live = reads.health(reads.crop(img, reads.HP_ROI))
                rel = pos - e["frame"]
                p = d / f"f{pos:06d}_{rel:+d}.png"
                cv2.imwrite(str(p), img)
                files.append({"frame": pos, "rel": rel, "hp": None if np.isnan(hp[pos]) else round(float(hp[pos]), 3),
                              "hp_live": None if np.isnan(live) else round(float(live), 3),
                              "file": p.name})
            pos += 1
        write_json(d / "info.json", {"event": e, "frames": files})
        print(d, " ".join(f"{x['rel']:+d}:{x['hp']}" for x in files))


if __name__ == "__main__":
    main()
