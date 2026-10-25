"""Order 4: the teacher's soft labels on every cached frame, per fold (distillation targets for the student).

    uv run --no-project --with torch --with numpy --index https://download.pytorch.org/whl/cu130 \
        --index-strategy unsafe-best-match python workspaces/WhereWindsMeet/tools/dufu_moveid/s4_soft.py [--folds 0,1,2,3,4]

Teacher fold k (teacher_prefix/teacher/fold<k>.pt, trained without fold k's rounds) is run over ALL recordings' cached
frames (s3b_train.Loader / predict, unchanged: chunks of 128, every frame gets the output with the longest history
available). The student of fold k is distilled from teacher k only, on its training rounds (in-sample for teacher k),
so no teacher that saw fold k's rounds touches student k: its out-of-fold numbers stay out-of-fold. The final student
(all rounds) uses the mean of the five teachers.

Out: student/soft/fold<k>.npz: one array per recording (key = rec id), [n cached frames, G + 1 + 3 + 3 + 47] float16
probabilities in s3b_train's head order (group, colour, response, tte), rows = teacher/cache/<rec>.npz frames.
"""
from __future__ import annotations

import argparse
import collections
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s3_common import load, read_json  # noqa: E402
from s3b_gate1 import PREFIX  # noqa: E402
from s4_common import SOFT  # noqa: E402


def main() -> None:
    import torch
    from s3b_train import Loader, Rec, build_model, predict
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--folds", default="0,1,2,3,4")
    ap.add_argument("--batch", type=int, default=16)
    a = ap.parse_args()
    t0 = time.time()
    d = load()
    prefix = read_json(PREFIX / "prefix.json")
    G = len(prefix["groups"])
    byrec = collections.defaultdict(list)
    for e in d["events"]:
        byrec[e["rec"]].append(e)
    recs = {r["rec"]: Rec(r, byrec.get(r["rec"], []), prefix["events"], G) for r in d["recs"]}
    items = [(r, s, e, f) for r in recs for (s, e, f) in recs[r].chunks]
    print(f"{len(recs)} recordings, {sum(len(r.frames) for r in recs.values())} frames, {len(items)} chunks", flush=True)
    SOFT.mkdir(parents=True, exist_ok=True)
    for k in [int(x) for x in a.folds.split(",")]:
        tk = time.time()
        model = build_model(G).cuda()
        model.load_state_dict(torch.load(PREFIX / "teacher" / f"fold{k}.pt"))
        out = predict(model, Loader(recs, items, a.batch, False, seed=0, infer=True), recs, G)
        bad = {r: int(np.isnan(v[:, 0]).sum()) for r, v in out.items() if np.isnan(v[:, 0]).any()}
        np.savez(SOFT / f"fold{k}.npz", **out)
        print(f"fold {k}: {time.time() - tk:.0f}s, recordings with missing rows: {bad or 'none'}", flush=True)
        del model
        torch.cuda.empty_cache()
    print(f"total {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
