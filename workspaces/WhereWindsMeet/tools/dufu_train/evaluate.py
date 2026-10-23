"""Score head models on phase-2 rounds with onnxruntime (the exported files themselves, not the PyTorch port).

    uv run --with numpy --with onnxruntime python workspaces/WhereWindsMeet/tools/dufu_train/evaluate.py data/p2 \
        [--heads dufu/unified_head9s.onnx dufu/unified_head_p2.onnx] [--rounds r015 r016 ...] [--from r015]

Prints label counts and, per head, the trigger metrics (metrics.py) at TRIG_TH and the sweep thresholds. Rounds a
head was trained on are in its .json provenance (rounds_fit): use --from to score only rounds collected after it.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(Path(__file__).resolve().parent))
from labels import targets
from metrics import TRIG_TH, fmt, merge, round_stats

from data import MIN_RING, scan, windows

MODEL_DIR = Path(__file__).resolve().parents[2] / "model"
SWEEP = [0.3, 0.45, 0.6]


def s1_series(sess: ort.InferenceSession, r) -> np.ndarray:
    rows = np.arange(MIN_RING - 1, r.n)
    X = windows(r, rows)
    s = np.full(r.n, np.nan)
    for k, i in enumerate(rows):
        o = sess.run(None, {"seq": X[k:k + 1]})[0][0]
        f = o[22:33]
        p = np.exp(f - f.max())
        p /= p.sum()
        s[i] = p[1:6].sum()
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--heads", nargs="+", default=["dufu/unified_head9s.onnx", "dufu/unified_head_p2.onnx"])
    ap.add_argument("--rounds", nargs="*", default=None)
    ap.add_argument("--from", dest="from_", default=None, help="only rounds >= this name")
    a = ap.parse_args()
    rounds = [r for r in scan(a.root) if (not a.rounds or r.name in a.rounds) and (not a.from_ or r.name >= a.from_)]
    if not rounds:
        sys.exit("no rounds")
    tgs = [targets(r) for r in rounds]
    cs = [c for tg in tgs for c in tg.contacts]
    print(f"{len(rounds)} rounds {rounds[0].name}..{rounds[-1].name}: contacts {len(cs)} "
          f"(hit {sum(c.kind == 'hit' for c in cs)}, ok {sum(c.kind == 'ok' for c in cs)}, flare dodge {sum(c.dodge for c in cs)})")
    for h in a.heads:
        p = Path(h) if Path(h).exists() else MODEL_DIR / h
        if not p.exists():
            print(f"{h}: missing")
            continue
        fit = []
        if p.with_suffix(".json").exists():
            fit = json.loads(p.with_suffix(".json").read_text(encoding="utf-8")).get("provenance", {}).get("rounds_fit", [])
        seen = [r.name for r in rounds if r.name in fit]
        sess = ort.InferenceSession(str(p))
        s1s = [s1_series(sess, r) for r in rounds]
        print(f"{h}{f' (trained on {len(seen)} of these rounds: in-sample!)' if seen else ''}")
        for th in SWEEP:
            m = merge([round_stats(r.cap, s, tg.w, tg.contacts, th) for r, tg, s in zip(rounds, tgs, s1s)])
            print(f"  S1>={th}{' *' if th == TRIG_TH else '  '} {fmt(m)}")


if __name__ == "__main__":
    main()
