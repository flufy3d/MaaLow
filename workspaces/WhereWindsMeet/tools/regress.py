"""Regression check for tools/rec_route.py (and the modules it is split into) on data already made, no device:

    uv run --extra cv python workspaces/WhereWindsMeet/tools/regress.py save    # before a change: the baseline
    uv run --extra cv python workspaces/WhereWindsMeet/tools/regress.py check   # after it: the same or better?

What is compared (data/regress/<what>.json; the data dirs are not in the repo, so this runs where they are):
* jiurou_plan: rec_route plan on data/wwm_jiurou (targets, the route points, the legs' clearance): must be the same
* jiurou_eval: rec_route eval (held-out frames located as the app would, per zoom and kind): trusted share and the
  error median / p90 must not get worse (0.5% / 0.05 px slack)
* foye_check: rec_route check on 佛爷寨's surveys (survey2, survey4) for the point pairs of the README (0-2, 7-9): the
  planned corners and how far they stray must be the same
Each run's own outputs go to data/regress/run/ (plan.png and the like), the data dirs keep theirs.
"""

import contextlib
import io
import json
import shutil
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import rec_route as rr  # noqa: E402

OUT = Path("data/regress")
JIUROU = Path("data/wwm_jiurou")
FOYE = Path("data/wwm_foye")
KEEP = ["plan.json", "targets.json", "plan.png", "eval.json"]  # outputs in the data dir, put back after


def jiurou_plan() -> dict:
    rr.cmd_plan(JIUROU)
    p = json.load(open(JIUROU / "plan.json", encoding="utf-8"))
    t = json.load(open(JIUROU / "targets.json", encoding="utf-8"))
    return {"points": p["points"], "legs": p["legs"], "tracker": p["tracker"], "stops": t["stops"]}


def jiurou_eval() -> dict:
    with contextlib.redirect_stdout(io.StringIO()):
        rr.cmd_eval(JIUROU)
    rows = json.load(open(JIUROU / "eval.json"))["rows"]
    out = {}
    for zm in ("out", "in"):
        for kind in ("live", "taken"):
            g = [r for r in rows if r["zoom"] == zm and r["kind"] == kind and r["covered"]]
            if not g:
                continue
            tr = [r["err"] for r in g if r.get("trusted")]
            out[f"{zm}_{kind}"] = {"n": len(g), "trusted": round(len(tr) / len(g), 4),
                                   "median": round(float(np.median(tr)), 3) if tr else None,
                                   "p90": round(float(np.percentile(tr, 90)), 3) if tr else None,
                                   "over4": int(sum(e > 4 for e in tr))}
    return out


def foye_check() -> list[str]:
    d = OUT / "run" / "foye_check"
    d.mkdir(parents=True, exist_ok=True)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rr.cmd_check(d, [FOYE / "survey2" / "track.json", FOYE / "survey4" / "track.json"], "Foye", [(0, 2), (7, 9)])
    return [line for line in buf.getvalue().splitlines() if line.strip()]


def run() -> dict:
    keep = OUT / "run" / "kept"
    keep.mkdir(parents=True, exist_ok=True)
    for f in KEEP:
        if (JIUROU / f).exists():
            shutil.copy2(JIUROU / f, keep / f)
    try:
        return {"jiurou_plan": jiurou_plan(), "jiurou_eval": jiurou_eval(), "foye_check": foye_check()}
    finally:
        for f in KEEP:
            if (JIUROU / f).exists():
                shutil.copy2(JIUROU / f, OUT / "run" / f)
            if (keep / f).exists():
                shutil.copy2(keep / f, JIUROU / f)


def main() -> None:
    what = sys.argv[1] if len(sys.argv) > 1 else "check"
    OUT.mkdir(parents=True, exist_ok=True)
    now = run()
    if what == "save":
        json.dump(now, open(OUT / "baseline.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("baseline saved:", json.dumps(now["jiurou_eval"]), *now["foye_check"], sep="\n")
        return
    base = json.load(open(OUT / "baseline.json", encoding="utf-8"))
    bad = []
    if now["jiurou_plan"] != base["jiurou_plan"]:
        bad.append("jiurou plan changed")
    for k, b in base["jiurou_eval"].items():
        n = now["jiurou_eval"].get(k)
        if n is None or n["trusted"] < b["trusted"] - 0.005 or (b["median"] is not None and n["median"] > b["median"] + 0.05) \
                or (b["p90"] is not None and n["p90"] > b["p90"] + 0.05):
            bad.append(f"jiurou eval {k}: {b} -> {n}")
    if now["foye_check"] != base["foye_check"]:
        bad.append("foye check changed:\n  " + "\n  ".join(now["foye_check"]))
    print(json.dumps(now["jiurou_eval"], ensure_ascii=False))
    print("\n".join(bad) if bad else "regression: same or better on all")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
