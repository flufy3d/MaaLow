"""Order 3b: check sheets -> data/moveid/teacher_prefix/check/.

    uv run --no-project --with av --with opencv-python-headless --with numpy \
        python workspaces/WhereWindsMeet/tools/dufu_moveid/s3b_check.py [--seed 0]

  b_dodge_as_parry_NN.jpg  gate (b) contacts (fatal chain, not a grab tick) whose label is dodge and whose response
                           head says parry at -10 (at most 30, random if more)
  c_tte_worst_NN.jpg       the 10 contacts with the largest contact-time error at -10 (gate1.json c.worst)
One row per contact: whole screen at -10 (thumbnail) + the big view at -16 -12 -10 -8 -4 0; each tile: response
head argmax + p, colour head argmax, predicted contact time; row title: round, chain, position k, true group,
label, own colour, type, -10 prediction (response, colour, group). index.json lists every row.
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
from s3_check import decode, text  # noqa: E402
from s3_common import COLORS, load, read_json, write_json  # noqa: E402
from s3b_gate1 import DECISION, PREFIX, RESP, tte_point  # noqa: E402

SHOW = (-16, -12, -10, -8, -4, 0)
COLS = {"gold": (0, 215, 255), "red": (60, 60, 255), "none": (230, 230, 230), "unknown": (160, 160, 160)}
RCOL = {"dodge": (0, 215, 255), "parry": (120, 255, 120), "none": (180, 180, 180)}


def row(e: dict, P: dict, k: int, frames: dict, prefix: dict, gname: list, cf: list) -> np.ndarray:
    """cf: contact frames of the recording (true contact time = frames to the next one)."""
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
        pr = P["p_resp"][k, j]
        ri = int(pr.argmax())
        ci = int(P["p_col"][k, j].argmax())
        tt = int(tte_point(P["p_tte"][k, j].astype(np.float64)))
        text(b, f"{o:+d}", (4, 18), (255, 255, 255))
        text(b, f"{RESP[ri]} {pr[ri]:.2f}", (4, 152), RCOL[RESP[ri]])
        text(b, f"{COLORS[ci]} tte {tt if tt <= 45 else '-'}", (4, 170), COLS[COLORS[ci]])
        text(b, f"true tte {min(x for x in cf if x >= f0 + o) - (f0 + o)}", (4, 188), (255, 255, 255))
        tiles.append(b)
    body = np.hstack(tiles)
    head = np.zeros((24, body.shape[1], 3), np.uint8)
    j = offs.index(DECISION)
    pe = prefix["events"][str(e["id"])]
    G = len(gname)
    pg = int(P["p_grp"][k, j].argmax())
    pr = P["p_resp"][k, j]
    s = (f"{e['round']} ch{e['chain_id']} k{e['chain_pos']} f{f0} gap {e['gap_prev']} | truth {pe['response']} "
         f"{gname[pe['gid']]} col {e['color']} {e['type']} | @-10 {RESP[int(pr.argmax())]} "
         f"(d {pr[0]:.2f} p {pr[1]:.2f} n {pr[2]:.2f}) {COLORS[int(P['p_col'][k, j].argmax())]} "
         f"{'idle' if pg == G else gname[pg]}")
    text(head, s[:200], (4, 17), COLS.get(e["color"], (255, 255, 255)), 0.42)
    return np.vstack([head, body])


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--pred", default=str(PREFIX / "oof.npz"))
    ap.add_argument("--out", default=str(PREFIX / "check"))
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--max", type=int, default=30)
    a = ap.parse_args()
    d = load()
    prefix = read_json(PREFIX / "prefix.json")
    gname = [g["name"] for g in prefix["groups"]]
    gate = read_json(PREFIX / "gate1.json")
    z = np.load(a.pred)
    P = {k: z[k] for k in z.files}
    row_of = {int(i): k for k, i in enumerate(P["ids"])}
    j = list(P["offs"]).index(DECISION)
    fatal = {c for c, v in d["classes"].items() if v.get("fatal")}
    evid = {e["id"]: e for e in d["events"]}
    cfr = collections.defaultdict(list)
    for e in d["events"]:
        cfr[e["rec"]].append(e["frame"])
    rng = np.random.default_rng(a.seed)
    bad = [e for e in d["events"] if e["cls"] in fatal and prefix["events"][str(e["id"])]["response"] == "dodge"
           and e["id"] in row_of and P["valid"][row_of[e["id"]], j]
           and RESP[int(P["p_resp"][row_of[e["id"]], j].argmax())] == "parry"]
    n_bad = len(bad)
    if len(bad) > a.max:
        bad = [bad[i] for i in sorted(rng.choice(len(bad), a.max, replace=False))]
    jobs = [("b_dodge_as_parry", e) for e in bad]
    worst = gate["models"]["prefix_teacher"]["c"]["worst"]
    jobs += [("c_tte_worst", evid[w["id"]]) for w in worst]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    by_rec = collections.defaultdict(list)
    for tag, e in jobs:
        by_rec[e["rec"]].append((tag, e))
    rows = collections.defaultdict(list)
    for rec, js in by_rec.items():
        want = {e["frame"] + o for _, e in js for o in SHOW}
        fr = decode(rec, {w for w in want if w >= 0})
        for tag, e in js:
            rows[tag].append((e["id"], row(e, P, row_of[e["id"]], fr, prefix, gname, cfr[rec]), e))
    index = {"pred": a.pred, "dodge_as_parry_total": n_bad, "sheets": {}}
    for tag, rs in rows.items():
        rs.sort(key=lambda x: x[0])
        per = 6
        for s in range(0, len(rs), per):
            name = f"{tag}_{s // per:02d}.jpg"
            cv2.imwrite(str(out / name), np.vstack([r[1] for r in rs[s:s + per]]), [cv2.IMWRITE_JPEG_QUALITY, 88])
            index["sheets"][name] = [{"id": e["id"], "chain_id": e["chain_id"], "k": e["chain_pos"], "round": e["round"],
                                      "rec": e["rec"], "frame": e["frame"], "color": e["color"], "class": e["cls"],
                                      "group": gname[prefix["events"][str(e["id"])]["gid"]], "type": e["type"],
                                      "gap_prev": e["gap_prev"]} for _, _, e in rs[s:s + per]]
    write_json(out / "index.json", index)
    print(f"{len(jobs)} rows -> {out}; dodge_as_parry total {n_bad}")


if __name__ == "__main__":
    main()
