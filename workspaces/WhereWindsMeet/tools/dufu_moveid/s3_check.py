"""Order 3: gate-1 check sheets from out-of-fold predictions -> data/moveid/teacher/check/.

    uv run --no-project --with av --with opencv-python-headless --with numpy \
        python workspaces/WhereWindsMeet/tools/dufu_moveid/s3_check.py [--pred data/moveid/teacher/oof.npz]

  a_gold_red_NN.jpg   every opener-gold chain whose colour head says red at -10 (at most 30, random if more)
  b_<true>_<pred>_NN.jpg   the 3 most frequent fatal-class confusions at -10 that are errors under the spec groups,
                      4 random chains each
One row per chain: the whole screen at -10 (thumbnail) + the big view (s2_views) at -16 -12 -10 -8 -4 0; each tile
is labelled with the colour head (argmax and p) and the class head argmax at that frame; the row title has round,
chain, truth (colour, class, chain length, results) and the -10 prediction. index.json lists every row.
Frames are decoded sequentially with PyAV (exact frame numbers, same as the caches).
"""
from __future__ import annotations

import argparse
import collections
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s2_views import views  # noqa: E402
from s3_common import COLORS, DECISION, IDLE, N_MOVE, OUT, TEACHER, UNKNOWN, equivalence_groups, load, write_json  # noqa: E402

SHOW = (-16, -12, -10, -8, -4, 0)
COLS = {"gold": (0, 215, 255), "red": (60, 60, 255), "none": (230, 230, 230)}


def cname(c: int) -> str:
    return "unk" if c == UNKNOWN else "idle" if c == IDLE else f"c{c}"


def decode(rec: str, want: set[int]) -> dict[int, np.ndarray]:
    import av
    out = {}
    hi = max(want)
    with av.open(str(OUT / "video" / f"{rec}.mp4")) as c:
        s = c.streams.video[0]
        s.thread_type = "AUTO"
        for i, f in enumerate(c.decode(s)):
            if i in want:
                out[i] = f.to_ndarray(format="bgr24")
            if i >= hi:
                break
    return out


def text(im, s, xy, col, scale=0.5):
    cv2.putText(im, s, xy, 0, scale, (0, 0, 0), 3)
    cv2.putText(im, s, xy, 0, scale, col, 1)


def row(e: dict, chain: list[dict], P: dict, k: int, frames: dict) -> np.ndarray:
    offs = list(P["offs"])
    blank = np.zeros((720, 1080, 3), np.uint8)
    f0 = e["frame"]
    th = cv2.resize(views(frames.get(f0 + DECISION, blank))["glob"], (288, 180), interpolation=cv2.INTER_AREA)
    th = cv2.copyMakeBorder(th, 6, 6, 0, 0, cv2.BORDER_CONSTANT)
    text(th, "full @-10", (4, 186), (255, 255, 255), 0.45)
    tiles = [th]
    for o in SHOW:
        b = views(frames.get(f0 + o, blank))["big"].copy()
        j = offs.index(o)
        pc = P["p_col"][k, j]
        ci = int(pc.argmax())
        cl = int(P["p_cls"][k, j].argmax())
        text(b, f"{o:+d}", (4, 18), (255, 255, 255))
        text(b, f"{COLORS[ci]} {pc[ci]:.2f}", (4, 170), COLS[COLORS[ci]])
        text(b, cname(cl), (4, 188), (255, 255, 255))
        tiles.append(b)
    body = np.hstack(tiles)
    head = np.zeros((24, body.shape[1], 3), np.uint8)
    j = offs.index(DECISION)
    pc = P["p_col"][k, j]
    res = " ".join(x["type"] for x in chain[:6])
    s = (f"{e['round']} ch{e['chain_id']} f{f0} | truth {e['chain_color']} {cname(e['cls'])} len {len(chain)} "
         f"onset {e.get('color_onset')} | {res} | @-10 pred {COLORS[int(pc.argmax())]} "
         f"(g {pc[0]:.2f} r {pc[1]:.2f} n {pc[2]:.2f}) {cname(int(P['p_cls'][k, j].argmax()))}")
    text(head, s, (4, 17), COLS.get(e["chain_color"], (255, 255, 255)), 0.45)
    return np.vstack([head, body])


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--pred", default=str(TEACHER / "oof.npz"))
    ap.add_argument("--out", default=str(TEACHER / "check"))
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    d = load()
    z = np.load(a.pred)
    P = {k: z[k] for k in z.files}
    row_of = {int(i): k for k, i in enumerate(P["ids"])}
    j = list(P["offs"]).index(DECISION)
    groups = equivalence_groups(d["classes"])
    fatal = {c for c, v in d["classes"].items() if v.get("fatal")}
    chains = collections.defaultdict(list)
    for e in d["events"]:
        chains[e["chain_id"]].append(e)
    openers = [e for e in d["events"] if e["chain_pos"] == 0 and e["id"] in row_of]
    rng = np.random.default_rng(a.seed)
    jobs = []
    gr = [e for e in openers if e["chain_color"] == "gold" and int(P["p_col"][row_of[e["id"]], j].argmax()) == 1]
    if len(gr) > 30:
        gr = [gr[i] for i in sorted(rng.choice(len(gr), 30, replace=False))]
    jobs += [("a_gold_red", e) for e in gr]
    pairs = collections.Counter()
    by_pair = collections.defaultdict(list)
    for e in openers:
        tc = e["cls"]
        if tc not in fatal:
            continue
        pc = int(P["p_cls"][row_of[e["id"]], j].argmax())
        if pc == tc or (pc < N_MOVE and groups.get(pc) == groups.get(tc)):
            continue
        pairs[(tc, pc)] += 1
        by_pair[(tc, pc)].append(e)
    top = pairs.most_common(3)
    for (tc, pc), n in top:
        es = by_pair[(tc, pc)]
        pick = [es[i] for i in sorted(rng.choice(len(es), min(4, len(es)), replace=False))]
        jobs += [(f"b_{cname(tc)}_{cname(pc)}", e) for e in pick]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    by_rec = collections.defaultdict(list)
    for tag, e in jobs:
        by_rec[e["rec"]].append((tag, e))
    rows = collections.defaultdict(list)
    for rec, js in by_rec.items():
        want = {e["frame"] + o for _, e in js for o in SHOW} | {e["frame"] + DECISION for _, e in js}
        fr = decode(rec, {w for w in want if w >= 0})
        for tag, e in js:
            rows[tag].append((e["chain_id"], row(e, chains[e["chain_id"]], P, row_of[e["id"]], fr), e))
    index = {"pred": a.pred, "top_fatal_confusions": [[cname(t), cname(p), n] for (t, p), n in top], "sheets": {}}
    for tag, rs in rows.items():
        rs.sort(key=lambda x: x[0])
        per = 6
        for s in range(0, len(rs), per):
            name = f"{tag}_{s // per:02d}.jpg"
            cv2.imwrite(str(out / name), np.vstack([r[1] for r in rs[s:s + per]]), [cv2.IMWRITE_JPEG_QUALITY, 88])
            index["sheets"][name] = [{"chain_id": e["chain_id"], "round": e["round"], "rec": e["rec"], "frame0": e["frame"],
                                      "color": e["chain_color"], "class": cname(e["cls"]),
                                      "color_onset": e.get("color_onset")} for _, _, e in rs[s:s + per]]
    write_json(out / "index.json", index)
    print(f"{len(jobs)} rows -> {out}; gold->red {len(gr)}; top pairs {index['top_fatal_confusions']}")


if __name__ == "__main__":
    main()
