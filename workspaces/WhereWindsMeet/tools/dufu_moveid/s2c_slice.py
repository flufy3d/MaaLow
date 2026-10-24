"""Order 2 slicing: one sample = one chain (one boss move), anchored on its first contact.

Reads data/moveid/events_ext.json + emb/<rec>.npz and writes data/moveid/moves/slices.npz:
  seq          [sum T, 3, 384] float16   glob / big / small CLS of frames [first - PRE, last + POST] of every chain
  dup          [sum T] bool               frame repeats the previous one (mot_glob < DUP_MOT), not real stillness
  start, length [n]                        row range of each chain in seq; seq row 0 of a chain = first contact - PRE
  rec_mean     [n_rec, 3, 384] float32     per-recording mean embedding (all frames), rec_idx [n] points into it
and slices.json: per chain {chain_id, rec, round, kind, frame0, offsets, colors, types, outcomes, dmg, ...}.
Frames before 0 / after the end of a recording are clamped (edge frame repeated, flagged in `clamped`).
"""
from __future__ import annotations

import argparse
import collections
import time

import numpy as np

from common import OUT, read_json, write_json

PRE, POST = 60, 10
DUP_MOT = 0.3
VIEWS = ("glob", "big", "small")
MOVES = OUT / "moves"


def chains() -> list[dict]:
    ev = read_json(OUT / "events_ext.json")["events"]
    ix = read_json(OUT / "index.json")["events"]
    by = collections.defaultdict(list)
    for e in ev:
        by[e["chain_id"]].append(e)
    out = []
    for cid in sorted(by):
        c = sorted(by[cid], key=lambda e: e["frame"])
        f0 = c[0]["frame"]
        out.append({
            "chain_id": cid, "rec": c[0]["rec"], "round": c[0]["round"], "kind": c[0]["chain_kind"],
            "frame0": f0, "offsets": [e["frame"] - f0 for e in c],
            "colors": [e["color"] for e in c], "color": c[0]["chain_color"],
            "types": [e["type"] for e in c], "outcomes": [ix[e["id"]]["outcome"] for e in c],
            "dmg": [e["dmg"] for e in c], "event_ids": [e["id"] for e in c],
            "gap_prev": c[0]["gap_prev"], "color_onset": c[0]["color_onset"],
        })
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.parse_args()
    t0 = time.time()
    cs = chains()
    by_rec = collections.defaultdict(list)
    for i, c in enumerate(cs):
        by_rec[c["rec"]].append(i)
    recs = sorted(by_rec)
    lengths = np.array([PRE + c["offsets"][-1] + POST + 1 for c in cs])
    start = np.concatenate([[0], np.cumsum(lengths)[:-1]])
    seq = np.zeros((lengths.sum(), 3, 384), np.float16)
    dup = np.zeros(lengths.sum(), bool)
    rec_mean = np.zeros((len(recs), 3, 384), np.float32)
    rec_idx = np.zeros(len(cs), np.int32)
    for ri, rec in enumerate(recs):
        z = np.load(OUT / "emb" / f"{rec}.npz")
        e = np.stack([z[v] for v in VIEWS], 1)  # [F, 3, 384]
        d = z["mot_glob"] < DUP_MOT
        d[0] = False
        rec_mean[ri] = e.astype(np.float32).mean(0)
        nf = len(e)
        for i in by_rec[rec]:
            c = cs[i]
            fr = np.arange(c["frame0"] - PRE, c["frame0"] + c["offsets"][-1] + POST + 1)
            cl = np.clip(fr, 0, nf - 1)
            c["clamped"] = int((cl != fr).sum())
            seq[start[i]:start[i] + lengths[i]] = e[cl]
            dup[start[i]:start[i] + lengths[i]] = d[cl]
            rec_idx[i] = ri
    MOVES.mkdir(parents=True, exist_ok=True)
    np.savez(MOVES / "slices.npz", seq=seq, dup=dup, start=start, length=lengths, rec_mean=rec_mean,
             rec_idx=rec_idx, recs=np.array(recs), pre=PRE, post=POST)
    write_json(MOVES / "slices.json", {"pre": PRE, "post": POST, "dup_mot": DUP_MOT, "chains": cs}, indent=None)
    print(f"{len(cs)} chains, {lengths.sum()} frames, {len(recs)} recordings, "
          f"clamped chains {sum(c['clamped'] > 0 for c in cs)}, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
