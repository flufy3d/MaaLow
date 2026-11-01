"""Independent check for the c11 seqDefense 2v2: truth hits / hits per minute / c11 sequences and hits per round.

    MOVEID_PHASE=1 uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/c11_2v2_check.py r220 r221 r222 r223

Reads only live/<round>/contacts.json, args.json and result.json (no s5_ab / s5_analyze import). A round shorter than
MIN_S is marked invalid (the first 2v2 round died at the arena entrance) and excluded from the arm totals. The c11
sequence definition matches c11_chain.py: truth contacts whose dec.grp contains c11/c40, clustered by gap <= 30 f.
Fatal = dec.fatal on a hit; gold = colour "gold" on a hit (raw counts; the safety gate stays s5_ab / gate).
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import OUT  # noqa: E402

LIVE = OUT / "live"
MIN_S = 60.0
GAP_F = 30


def grp(t: dict) -> str:
    return str((t.get("dec") or {}).get("grp") or "")


def is_c11(t: dict) -> bool:
    g = grp(t)
    return "c11" in g or "c40" in g


def cluster(cs: list[dict]) -> list[list[dict]]:
    out: list[list[dict]] = []
    for c in sorted(cs, key=lambda x: float(x["frame"])):
        if out and float(c["frame"]) - float(out[-1][-1]["frame"]) <= GAP_F:
            out[-1].append(c)
        else:
            out.append([c])
    return out


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("rounds", nargs="+")
    a = ap.parse_args()
    rows = []
    for rn in a.rounds:
        d = LIVE / rn
        con = json.loads((d / "contacts.json").read_text(encoding="utf-8"))
        res = json.loads((d / "result.json").read_text(encoding="utf-8"))["value"]
        args = json.loads((d / "args.json").read_text(encoding="utf-8"))
        truth = con.get("truth") or []
        hits = [t for t in truth if t.get("kind") == "hit"]
        c11 = [t for t in truth if is_c11(t)]
        c11h = [t for t in c11 if t.get("kind") == "hit"]
        seqs = cluster(c11)
        seq_hits = [sum(1 for t in s if t.get("kind") == "hit") for s in seqs]
        fight_s = float(res.get("fightMs") or 0) / 1000
        row = {"round": rn, "arm": f"seqDefense={args.get('seqDefense')}", "reason": res.get("reason"),
               "fight_s": round(fight_s, 1), "valid": fight_s >= MIN_S,
               "truth": len(truth), "hits": len(hits), "hit_per_min": round(len(hits) / (fight_s / 60), 3) if fight_s else None,
               "fatal": sum(1 for t in hits if (t.get("dec") or {}).get("fatal")),
               "gold": sum(1 for t in hits if t.get("colour") == "gold"),
               "c11_contacts": len(c11), "c11_hits": len(c11h), "c11_seqs": len(seqs),
               "c11_seq_hits": sum(seq_hits), "c11_seq_hit_dist": dict(collections.Counter(seq_hits)),
               "seq_presses": (res.get("seq") or {}).get("presses", 0),
               "seq_plans": (res.get("seq") or {}).get("plans", 0)}
        rows.append(row)
    print("| round | arm | result | min | hits | hits/min | fatal | gold | c11 seq | c11 hits | seq presses | valid |")
    print("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|")
    for x in rows:
        print(f"| {x['round']} | {x['arm']} | {x['reason']} | {x['fight_s']/60:.2f} | {x['hits']} | {x['hit_per_min']} | "
              f"{x['fatal']} | {x['gold']} | {x['c11_seqs']} | {x['c11_hits']} | {x['seq_presses']} | {'yes' if x['valid'] else 'NO'} |")
    for arm in sorted({x["arm"] for x in rows}):
        v = [x for x in rows if x["arm"] == arm and x["valid"]]
        if not v:
            continue
        mins = sum(x["fight_s"] for x in v) / 60
        hits = sum(x["hits"] for x in v)
        c11h = sum(x["c11_hits"] for x in v)
        print(f"\n{arm}: valid rounds {len(v)}, {mins:.1f} min, hits {hits} = {hits / mins:.2f}/min, "
              f"c11 hits {c11h}, c11 seqs {sum(x['c11_seqs'] for x in v)}, seq presses {sum(x['seq_presses'] for x in v)}")


if __name__ == "__main__":
    main()
