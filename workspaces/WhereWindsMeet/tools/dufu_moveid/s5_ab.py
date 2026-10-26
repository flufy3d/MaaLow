"""Order 5 (关 2 专攻): A/B over live defend rounds, grouped by their args (one arm per distinct value of the --by keys),
gate 2 per arm with s5_analyze's rule unchanged, the failure causes, and the 火球雨 episode caliber.

    uv run --no-project --with numpy python $D/s5_ab.py r036 ... r051 --by run,goldSeq [--out live/ab_<name>.json]

Needs s5_analyze.py run on the rounds first (contacts.json); does not write analysis.json.

Two calibers (the run makes fireballs miss, and a fireball that misses leaves no contact, so gate 2's contact count
cannot see what the run avoided):
  gate2      s5_analyze.gate2 unchanged (with / without the unverified dodges).
  c7volley   every 火球雨 episode (s5_episodes: the first of >= 2 consecutive trace rows naming a k0..k4:c7 group,
             >= 150 f apart; run or not, the same rule in every arm) counts as K attacks, K = VOLLEY_K, the median number
             of fireball contacts of a volley nobody ran from (r020-r031, D config: 5); failures = the truth hits
             (video hp steps) in [start, start + EP_WIN_F], at most K. The gate-2 attacks inside those windows are
             replaced by these K. Reported for every arm, so the arms stay comparable.
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import s5_analyze as A  # noqa: E402
import s5_episodes as E  # noqa: E402
from common import write_json  # noqa: E402

VOLLEY_K = 5
EP_WIN_F = 130


def arm_key(args: dict, by: list[str]) -> str:
    return ",".join(f"{k}={json.dumps(args.get(k))}" for k in by)


def c7volley(rounds: list[dict], eps: dict[str, dict]) -> dict:
    """gate-2 fatal rate with the c7 episodes counted as K attacks each (module doc)."""
    att_ok = att_n = 0
    epi_n = epi_hits = 0
    for r in rounds:
        win = [(e["start"], e["start"] + EP_WIN_F) for e in eps[r["round"]]["c7"]]
        inwin = lambda f, win=win: any(a <= f <= b for a, b in win)  # noqa: E731
        for t in r["truth_list"]:
            dec = t.get("dec") or {}
            if t.get("grab") or not dec.get("fatal") or inwin(t["frame"]):
                continue
            att_n += 1
            att_ok += t["kind"] == "ok"
        for x in r["dodges"]:
            if x["fatal"] and x["verified_gold"] and not inwin(x["frame"]):
                att_n += 1
                att_ok += 1
        for a, b in win:
            h = sum(1 for t in r["truth_list"] if t["kind"] == "hit" and a <= t["frame"] <= b)
            epi_n += 1
            epi_hits += min(h, VOLLEY_K)
            att_n += VOLLEY_K
            att_ok += VOLLEY_K - min(h, VOLLEY_K)
    return {"fatal_ok": att_ok, "fatal_n": att_n, "rate": round(att_ok / att_n, 4) if att_n else None,
            "episodes": epi_n, "episode_hits": epi_hits,
            "volley_success": round(1 - epi_hits / (VOLLEY_K * epi_n), 4) if epi_n else None}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("rounds", nargs="+")
    ap.add_argument("--by", default="run")
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()
    by = a.by.split(",")
    rs = [A.analyze(A.LIVE / n) for n in a.rounds]
    rs = [r for r in rs if r and r["mode"] == "defend"]
    eps = {r["round"]: E.round_eps(r["round"], False) for r in rs}
    arms = collections.defaultdict(list)
    for r in rs:
        arms[arm_key(A.read_json(A.LIVE / r["round"] / "args.json"), by)].append(r)
    for k in by:  # main effects: pooled over the other keys
        for v in sorted({arm_key(A.read_json(A.LIVE / r["round"] / "args.json"), [k]) for r in rs}):
            arms["main:" + v] = [r for r in rs if arm_key(A.read_json(A.LIVE / r["round"] / "args.json"), [k]) == v]
    out = {}
    for name, sel in sorted(arms.items()):
        g = A.gate2(sel)
        fm = sum(max(0.0, r["fight_s"] - (r["boss_s"] or 0)) for r in sel) / 60
        es = E.summary([eps[r["round"]] for r in sel])
        out[name] = {
            "rounds": [r["round"] for r in sel],
            "fatal_without_unverified": g["without_unverified"]["fatal"],
            "fatal_with_unverified": g["with_unverified"]["fatal"],
            "by_round": {k: v["rate"] for k, v in g["without_unverified"]["by_round"].items()},
            "gold_parried": g["gold_parried"],
            "why_fatal": g["why_fatal"],
            "c7volley": c7volley(sel, eps),
            "hits_per_min": round(sum(r["truth"]["hit"] for r in sel) / fm, 2) if fm else None,
            "survival_s": sorted(r["fight_s"] for r in sel),
            "c7_episodes": {k: es[k] for k in ("c7_episodes", "c7_hits", "c7_by_run")},
            "c11": {k: es[k] for k in ("c11_windows", "c11_hits", "c11_clean")},
        }
        o = out[name]
        print(f"{name} [{len(sel)}] fatal {o['fatal_without_unverified']['ok']}/{o['fatal_without_unverified']['n']} = "
              f"{o['fatal_without_unverified']['rate']} (with unverified {o['fatal_with_unverified']['rate']}); "
              f"c7volley {o['c7volley']['rate']} (episodes {o['c7volley']['episodes']}, hits {o['c7volley']['episode_hits']}); "
              f"gold parried {o['gold_parried']['n']}/{o['gold_parried']['of']}; hits/min {o['hits_per_min']}; "
              f"c11 windows {o['c11']['c11_windows']} hits {o['c11']['c11_hits']}; why {o['why_fatal']}")
    if a.out:
        write_json(a.out, json.loads(json.dumps(out, default=lambda x: x.item() if hasattr(x, "item") else str(x))))


if __name__ == "__main__":
    main()
