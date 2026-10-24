"""顺序 2: the tell colour of every contact from the crop classifier (s2_model.py -> crop_probs.json).

Per video frame: pR / pG / pC = the max over its line candidates (no candidate = 0). Tell frames: max(pR, pG) >= P_ON;
an episode = tell frames with gaps <= GAP_MAX; its colour = the larger of sum(pR) / sum(pG) over the episode. A contact
c owns an episode whose onset lies in [c - LEAD_MAX, c - LEAD_MIN] and after the previous contact (a tell belongs to
the first contact after it; the tell of a chain's opener is not copied to the follow-ups here, see s2_events.py
`chain_color`). With several, the latest onset wins (others listed in `episodes`).

color: gold / red / none / unknown. unknown = the owned episode's colour is mixed (minor share > MIX_MAX) or its peak
is weak (< P_STRONG), or the window [max(prev + 1, c - LEAD_MAX), c - LEAD_MIN] is shorter than WIN_MIN frames and has
no tell (a follow-up right after the previous contact: nothing to see). color_onset = onset frame - contact frame (< 0), color_onset_frame = video frame. color_conf: gold / red = peak x (1 - minor
share); none = 1 - max(pR, pG) over the window (x 0.5 for short windows).

  s2_color.py [--lead-max 30]     -> data/moveid/color/color.json {id: {...}}
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import OUT, read_json, write_json  # noqa: E402

P_ON, P_STRONG, MIX_MAX = 0.5, 0.8, 0.25
GAP_MAX = 2
LEAD_MIN, LEAD_MAX = 2, 30
WIN_MIN = 4
COLOR = OUT / "color" / "color.json"


def frame_probs(probs: dict, rounds) -> dict:
    """rec -> (F, 3) array of per-frame max pR, pG, pC."""
    out = {r["rec"]: np.zeros((r["frames"] + 1, 3), np.float32) for r in rounds}
    for key, v in probs.items():
        rec, f, _ = key.split(":")
        a = out.get(rec)
        if a is None or int(f) >= len(a):
            continue
        p = v["p"]
        a[int(f)] = np.maximum(a[int(f)], [p[0], p[1], p[2]])
    return out


def episodes(fp: np.ndarray, a: int, b: int) -> list[dict]:
    """Tell episodes with onset in [a, b] (the episode may run past b; it is scanned up to b + 12)."""
    a = max(0, a)
    eps = []
    cur = None
    last = -99
    for f in range(a, min(len(fp), b + 13)):
        on = max(fp[f, 0], fp[f, 1]) >= P_ON
        if on and cur is not None and f - last <= GAP_MAX + 1:
            cur["frames"].append(f)
            last = f
        elif on:
            if f > b:
                break
            cur = {"frames": [f]}
            eps.append(cur)
            last = f
    for e in eps:
        fr = e["frames"]
        sr, sg = float(fp[fr, 0].sum()), float(fp[fr, 1].sum())
        e.update(onset=fr[0], end=fr[-1], n=len(fr), pr=round(sr, 3), pg=round(sg, 3),
                 color="red" if sr > sg else "gold", minor=round(min(sr, sg) / max(sr + sg, 1e-6), 3),
                 peak=round(float(max(fp[fr, 0].max(), fp[fr, 1].max())), 3))
        del e["frames"]
    return eps


def label(ev: dict, prev_frame: int | None, fp: np.ndarray, lead_max: int) -> dict:
    c = ev["frame"]
    lo = c - lead_max if prev_frame is None else max(c - lead_max, prev_frame + 1)
    hi = c - LEAD_MIN
    eps = episodes(fp, lo, hi) if hi >= lo else []
    out = {"window": [lo - c, hi - c], "episodes": [{**e, "onset": e["onset"] - c, "end": e["end"] - c} for e in eps]}
    if eps:
        e = eps[-1]
        weak = e["peak"] < P_STRONG or e["minor"] > MIX_MAX
        out.update(color="unknown" if weak else e["color"], color_guess=e["color"],
                   color_conf=round(e["peak"] * (1 - e["minor"]), 3), color_onset=int(e["onset"]) - c,
                   color_onset_frame=int(e["onset"]))
        return out
    seg = fp[max(0, lo):hi + 1, :2] if hi >= lo else np.zeros((0, 2))
    mx = float(seg.max()) if len(seg) else 0.0
    short = hi - lo + 1 < WIN_MIN
    out.update(color="unknown" if short and len(seg) < 2 else "none", color_guess="none",
               color_conf=round((1 - mx) * (0.5 if short else 1.0), 3), color_onset=None, color_onset_frame=None)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--lead-max", type=int, default=LEAD_MAX)
    a = ap.parse_args()
    idx = read_json(OUT / "index.json")
    probs = read_json(OUT / "color" / "crop_probs.json")
    fps = frame_probs(probs, idx["rounds"])
    from s2_feat import FEAT
    have = {p.stem for p in FEAT.glob("*.npz") if not p.name.endswith(".tmp.npz")}  # no crops = no line candidate
    res = {}
    prev = {}
    for ev in idx["events"]:
        rec = ev["rec"]
        if rec not in have:
            continue
        res[ev["id"]] = label(ev, prev.get(rec), fps[rec], a.lead_max)
        prev[rec] = ev["frame"]
    write_json(COLOR, res)
    from collections import Counter
    print(len(res), Counter(v["color"] for v in res.values()))
    for t in ["flare", "ok", "hit_pf", "hit_unk", "grab"]:
        print(t, Counter(v["color"] for i, v in res.items() if idx["events"][int(i)]["type"] == t))


if __name__ == "__main__":
    main()
