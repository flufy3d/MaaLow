"""c11/c40 chain report: group the truth contacts into sequences and show what the defense did on each beat.

    MOVEID_PHASE=1 uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/c11_chain.py r216 r217 r218 r219

Reads only `live/<round>/contacts.json` (s5_analyze output) and `args.json`; groups contacts of a round whose gap is
<= GAP_F into one sequence (the c11+c15+c23 chain beats are 2-30 frames apart). Per arm (args.c11Lead / offense):

  sequences / contacts / hits, hits per sequence, first-beat press lead (min lead of a press in [start-25, start+1]),
  beats after the first and their hits, and the group names.

No writes. This is the A/B's independent c11 recompute; the safety gate itself stays s5_ab.
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import OUT, read_json  # noqa: E402

LIVE = OUT / "live"
GAP_F = 30


def c11_contacts(round_dir: Path) -> list[dict]:
    c = read_json(round_dir / "contacts.json", {}) or {}
    out = []
    for t in c.get("truth") or []:
        g = str((t.get("dec") or {}).get("grp", ""))
        if "c11" in g or "c40" in g:
            out.append({"frame": float(t["frame"]), "kind": t.get("kind"), "grp": g,
                        "presses": t.get("presses") or [], "colour": t.get("colour")})
    return sorted(out, key=lambda x: x["frame"])


def sequences(cs: list[dict]) -> list[list[dict]]:
    out: list[list[dict]] = []
    for c in cs:
        if out and c["frame"] - out[-1][-1]["frame"] <= GAP_F:
            out[-1].append(c)
        else:
            out.append([c])
    return out


def arm_of(args: dict) -> str:
    """The A/B arm: c11Lead / offense, plus seqDefense only when the round set it (the S plan, stage C). Rounds without
    the key keep the old label, so the previous reports stay comparable (`seqDefense=None` is not spelled out)."""
    arm = f"c11Lead={args.get('c11Lead')}"
    if "seqDefense" in args:
        arm += f",seqDefense={args['seqDefense']}"
    return f"{arm},offense={args.get('offense', 'off')}"


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("rounds", nargs="+")
    a = ap.parse_args()
    arms: dict[str, list[dict]] = collections.defaultdict(list)
    for n in a.rounds:
        d = LIVE / n
        args = read_json(d / "args.json", {}) or {}
        seqs = sequences(c11_contacts(d))
        row = {"round": n, "arm": arm_of(args), "seqs": len(seqs), "contacts": sum(len(s) for s in seqs),
               "hits": sum(1 for s in seqs for c in s if c["kind"] == "hit"),
               "first_leads": [p["lead"] for s in seqs for p in s[0]["presses"]
                               if p["key"] == "dodge" and -25 <= p["lead"] <= 1],
               "chain": [(len(s), sum(1 for c in s if c["kind"] == "hit")) for s in seqs]}
        arms[row["arm"]].append(row)
        print(f"{n} {row['arm']} seqs {row['seqs']} contacts {row['contacts']} hits {row['hits']} "
              f"first dodge leads {['%.1f' % x for x in row['first_leads']]} chain {row['chain']}", flush=True)
    print()
    for arm, rows in sorted(arms.items()):
        seqs = sum(r["seqs"] for r in rows)
        con = sum(r["contacts"] for r in rows)
        hit = sum(r["hits"] for r in rows)
        leads = [x for r in rows for x in r["first_leads"]]
        print(f"{arm}: rounds {len(rows)} seqs {seqs} contacts {con} hits {hit} "
              f"hits/seq {hit / seqs if seqs else 0:.2f} first-dodge-lead median "
              f"{sorted(leads)[len(leads) // 2] if leads else None} n {len(leads)}")


if __name__ == "__main__":
    main()
