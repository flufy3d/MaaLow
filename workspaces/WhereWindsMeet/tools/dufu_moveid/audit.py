"""Independent audit of one phase's pulled rounds (used by the lead for acceptance).

    MOVEID_PHASE=1 uv run --no-project --with numpy python workspaces/WhereWindsMeet/tools/dufu_moveid/audit.py

Reads only the pulled artifacts (trace.json / result.json / rec.txt / meta / bars / index.json), not pull.py's
verdict, and recomputes:
  - round count, trace phase, end reasons, fight durations, video sizes / frame counts;
  - contacts and their types, hits / oks per round;
  - the hp step for hits and the 真气 step for oks at contact +5/+6 vs the frames before (independent of build.py's
    fitted offset; build's own step_res is reported too);
  - prep / curtain / flare event counts in the trace.
Writes OUT/audit.json.
"""
from __future__ import annotations

import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import BARS, META, OUT, STATUS, VIDEO, read_json, rounds, write_json  # noqa: E402
from data import load_round  # noqa: E402


def median(a):
    a = a[~np.isnan(a)]
    return float(np.median(a)) if len(a) else None


def step_at(x: np.ndarray, f: int) -> bool:
    """Did the reading fall in the contact's impact window (frames +4..+8) versus +(-4)..-1?"""
    n = len(x)
    if f < 5 or f + 8 >= n:
        return False
    before = median(x[max(0, f - 4):f])
    win = x[f + 4:f + 9]
    after = float(np.nanmin(win)) if np.isfinite(win).any() else None
    return before is not None and after is not None and before - after >= 0.02


def main() -> None:
    idx = read_json(OUT / "index.json", {})
    events = idx.get("events", [])
    status = read_json(STATUS, {}) or {}
    by_rec = defaultdict(list)
    for e in events:
        by_rec[e["rec"]].append(e)
    rows = []
    for rd in rounds():
        r = load_round(rd["dir"])
        if r is None or not status.get(rd["rec"], {}).get("ok"):
            continue
        rid = rd["rec"]
        meta = read_json(META / f"{rid}.json", {}) or {}
        bars = np.load(BARS / f"{rid}.npz") if (BARS / f"{rid}.npz").exists() else None
        es = by_rec.get(rid, [])
        hit_ok = sum(step_at(bars["hp"], e["frame"]) for e in es if e["kind"] == "hit") if bars is not None else 0
        ok_ok = 0
        if bars is not None:
            qi = bars["qi"].astype(np.float64)
            qi[qi < 0] = np.nan
            for e in es:
                if e["kind"] != "ok" or e["frame"] < 5 or e["frame"] + 8 >= len(qi):
                    continue
                b = median(qi[e["frame"] - 4:e["frame"]])
                win = qi[e["frame"] + 4:e["frame"] + 9]
                a = float(np.nanmin(win)) if np.isfinite(win).any() else None
                ok_ok += b is not None and a is not None and b - a >= 4
        kinds = Counter(e["kind"] for e in es)
        typ = Counter(e["type"] for e in es)
        ev = Counter(str(e[2]) for e in r.events)
        rows.append({
            "round": rd["key"], "rec": rid, "phase": r.phase, "reason": r.reason,
            "sec": round(float(r.wall[-1] - r.wall[0]) / 1000, 1) if r.n else None,
            "video_mb": round((VIDEO / f"{rid}.mp4").stat().st_size / 1e6, 1) if (VIDEO / f"{rid}.mp4").exists() else None,
            "meta_frames": meta.get("frames"), "contacts": len(es), "kinds": dict(kinds), "types": dict(typ),
            "hit_step_at_impact": hit_ok, "hit_n": kinds.get("hit", 0),
            "ok_qi_step_at_impact": ok_ok, "ok_n": kinds.get("ok", 0),
            "prep": ev.get("prep", 0), "curtain": ev.get("curtain", 0), "flare_events": ev.get("flare", 0),
        })
    n = len(rows)
    total_hit = sum(x["hit_n"] for x in rows)
    total_ok = sum(x["ok_n"] for x in rows)
    out = {
        "rounds": n,
        "phases": dict(Counter(x["phase"] for x in rows)),
        "reasons": dict(Counter(x["reason"] for x in rows)),
        "sec": [min((x["sec"] for x in rows), default=None), round(float(np.median([x["sec"] for x in rows])), 1) if rows else None,
                max((x["sec"] for x in rows), default=None)],
        "video_gb": round(sum(x["video_mb"] or 0 for x in rows) / 1000, 2),
        "contacts": sum(x["contacts"] for x in rows),
        "contacts_per_round": round(sum(x["contacts"] for x in rows) / n, 1) if n else None,
        "types": dict(Counter(k for x in rows for k, v in x["types"].items() for _ in range(v))),
        "hit_step_at_impact": f"{sum(x['hit_step_at_impact'] for x in rows)}/{total_hit}",
        "ok_qi_step_at_impact": f"{sum(x['ok_qi_step_at_impact'] for x in rows)}/{total_ok}",
        "prep_rounds": sum(1 for x in rows if x["prep"]),
        "curtain_rounds": sum(1 for x in rows if x["curtain"]),
        "rounds_detail": rows,
    }
    write_json(OUT / "audit.json", out, indent=1)
    print(json.dumps({k: v for k, v in out.items() if k != "rounds_detail"}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
