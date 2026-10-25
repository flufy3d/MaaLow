"""Order 4: gate-1 numbers (s3b_gate1.evaluate, the unchanged caliber and code) for out-of-fold prediction files,
optionally restricted to some folds (every model on exactly the same contacts: the events of the chosen folds' rounds).

    uv run --no-project --with numpy python workspaces/WhereWindsMeet/tools/dufu_moveid/s4_gate.py [--folds 0] \
        --pred teacher=data/moveid/teacher_prefix/oof.npz --pred student_fp32=data/moveid/student/oof.npz ...

Full 5-fold reports should use s3b_gate1.py itself (--out data/moveid/student/gate1); this is for the per-fold
comparisons (e.g. fp32 vs int8 on fold 0 before all folds exist). Prints (a) / (b) / dodge-as-parry / (c) per model and
writes --json if given.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s3_common import folds, load, read_json  # noqa: E402
from s3b_gate1 import DECISION, PREFIX, evaluate, new_adapter, pct  # noqa: E402


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--pred", action="append", required=True)
    ap.add_argument("--folds", default="")
    ap.add_argument("--json", default="")
    ap.add_argument("--agree", action="append", default=[],
                    help="NAME_A,NAME_B: per-head argmax agreement and max / mean |p diff| of two --pred files over "
                         "the rows both have (all offsets -30..0)")
    a = ap.parse_args()
    d = load()
    prefix = read_json(PREFIX / "prefix.json")
    if a.folds:
        keep = {int(x) for x in a.folds.split(",")}
        fold = folds(d["recs"], d["events"])
        d["events"] = [e for e in d["events"] if fold[e["rec"]] in keep]
    out = {}
    paths = dict(x.split("=", 1) for x in a.pred)
    for pair in a.agree:
        na, nb = pair.split(",")
        za, zb = np.load(paths[na]), np.load(paths[nb])
        ia = {int(i): k for k, i in enumerate(za["ids"])}
        rows = [(ia[int(i)], k) for k, i in enumerate(zb["ids"]) if int(i) in ia]
        ra, rb = np.array([r[0] for r in rows]), np.array([r[1] for r in rows])
        v = za["valid"][ra] & zb["valid"][rb]
        res = {}
        for h in ("p_grp", "p_col", "p_resp", "p_tte"):
            x, y = za[h][ra][v].astype(np.float32), zb[h][rb][v].astype(np.float32)
            res[h[2:]] = {"argmax_agree": round(float((x.argmax(-1) == y.argmax(-1)).mean()), 4),
                          "max_abs": round(float(np.abs(x - y).max()), 4), "mean_abs": round(float(np.abs(x - y).mean()), 5),
                          "rows": int(v.sum())}
        out[f"agree:{pair}"] = res
        print(pair, res, flush=True)
    for s in a.pred:
        name, path = s.split("=", 1)
        z = np.load(path)
        r = evaluate(new_adapter({k: z[k] for k in z.files}, prefix), d, prefix)
        x = r["offsets"][str(DECISION)]
        b = x["b"]["all"]
        c = r["c"]["all"]
        out[name] = {"a_gold_to_red": x["a"]["gold_to_red"], "b_correct": b["correct"], "dodge_as_parry": b["dodge_as_parry"],
                     "parry_as_dodge": b["parry_as_dodge"], "as_none": b["as_none"], "c": c, "c_fatal": r["c"]["fatal"],
                     "pass": r["gate"]["pass"],
                     "b_curve": {o: r["offsets"][o]["b"]["all"]["correct"]["rate"] for o in r["offsets"]}}
        print(f"{name:22s} (a) {pct(x['a']['gold_to_red'])}  (b) {pct(b['correct'])}  dodge->parry {pct(b['dodge_as_parry'])}  "
              f"parry->dodge {pct(b['parry_as_dodge'])}  none {pct(b['as_none'])}  (c) med/p75/p90 {c['median']:.0f}/{c['p75']:.0f}/"
              f"{c['p90']:.0f} within3 {pct(c['within3'])}  pass {r['gate']['pass']}", flush=True)
    if a.json:
        Path(a.json).write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
