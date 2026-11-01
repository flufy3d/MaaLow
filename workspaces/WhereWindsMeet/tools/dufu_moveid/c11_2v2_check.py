"""Independent check for the c11 scriptDefense / seqDefense 2v2.

    MOVEID_PHASE=1 uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/c11_2v2_check.py r220 r221 r222 r223

Reads only live/<round>/contacts.json, args.json and result.json (no s5_ab / s5_analyze import). A round shorter than
MIN_S is marked invalid (the first 2v2 round died at the arena entrance) and excluded from the arm totals. The c11
sequence definition matches c11_chain.py: truth contacts whose dec.grp contains c11/c40, clustered by gap <= 30 f.

First follow-up: the plan-level `clean first dodge` is the decisive metric. A plan is clean when the k0 press went, the
opener did not hit and was not skipped, and a first-follow-up press went; any c11 truth contact in Tc0 + 20..67 f means
the first follow-up was not avoided, none means it was dodged. The sequence-level `ff` columns are the old hit-branch
view (a sequence that starts with a gold k0 hit has its k1/k2 in hitstun, so those contacts are not first-dodge
failures). The script columns come from result.script (args.scriptDefense); the old seq plan is result.seq. Fatal =
dec.fatal on a hit; gold = colour "gold" on a hit (raw counts; the safety gate stays s5_ab / gate).
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
FRAME_MS = 1000 / 30


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


def first_followup(seq: list[dict]) -> dict | None:
    """The first no-light follow-up: the contact after the gold opener, else the sequence's first contact."""
    if not seq:
        return None
    t = seq[0]
    if grp(t).startswith("k0:") and t.get("colour") == "gold":
        return seq[1] if len(seq) > 1 else None
    return t


def presses(contact: dict, key: str, lo: float, hi: float) -> list[dict]:
    return [p for p in contact.get("presses") or []
            if p.get("key") == key and p.get("lead") is not None and lo <= float(p["lead"]) <= hi]


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
        ff = [x for x in (first_followup(s) for s in seqs) if x is not None]
        ff_hits = sum(1 for t in ff if t.get("kind") == "hit")
        ff_dodge = sum(len(presses(t, "dodge", -1, 5)) for t in ff)
        ff_parry = sum(len(presses(t, "parry", 0, 15)) for t in ff)
        fight_s = float(res.get("fightMs") or 0) / 1000
        script = res.get("script") or {}
        log = script.get("log") or []
        first_presses = [r for r in log if r[1] == "press" and r[2] == 1]
        first_skips = [r for r in log if r[1] == "skip" and r[2] == 1]
        opener_hits = [r for r in log if r[1] == "hit"]
        fallbacks = [r for r in log if r[1] == "first-fallback"]
        # Plan-level first-dodge test: a clean plan has a k0 press, no opener hit/skip, and a first press. Any c11
        # truth contact in Tc0 +20..67 f means the first follow-up was not avoided; none means the first dodge worked.
        rec = (d / "rec.txt").read_text(encoding="utf-8").strip()
        meta = json.loads((LIVE / "meta" / f"{rec}.json").read_text(encoding="utf-8"))
        k0f = (float(res["start"]) - float(meta["started"])) / FRAME_MS if res.get("start") is not None else 0.0
        off = float(con.get("offset") or 0)

        def t_of(fr: float) -> float:
            return (float(fr) - off - k0f) * FRAME_MS

        plans = []
        cur = None
        for row in log:
            ev = row[1]
            if ev == "plan":
                cur = {"tc0": float(row[4]), "press0": False, "hit": False, "skip": False, "press1": None}
                plans.append(cur)
            elif cur is not None:
                if ev == "press" and row[2] == 0:
                    cur["press0"] = True
                elif ev == "press" and row[2] == 1:
                    cur["press1"] = float(row[4])
                elif ev == "hit" and row[2] == 0:
                    cur["hit"] = True
                elif ev == "skip" and row[2] == 0:
                    cur["skip"] = True
        clean_attempts = clean_dodged = clean_hit = 0
        k0_hit_plans = k0_skip_plans = 0
        for p in plans:
            if p["hit"]:
                k0_hit_plans += 1
            if p["skip"]:
                k0_skip_plans += 1
            if not (p["press0"] and not p["hit"] and not p["skip"] and p["press1"] is not None):
                continue
            clean_attempts += 1
            near = [t for t in c11 if p["tc0"] + 20 * FRAME_MS <= t_of(t["frame"]) <= p["tc0"] + 67 * FRAME_MS]
            if near:
                clean_hit += 1
            else:
                clean_dodged += 1
        seq = res.get("seq") or {}
        arm = next((f"{k}={args[k]}" for k in ("scriptDefense", "seqDefense", "c11Lead") if k in args), "default")
        row = {"round": rn, "arm": arm, "reason": res.get("reason"),
               "fight_s": round(fight_s, 1), "valid": fight_s >= MIN_S,
               "truth": len(truth), "hits": len(hits), "hit_per_min": round(len(hits) / (fight_s / 60), 3) if fight_s else None,
               "fatal": sum(1 for t in hits if (t.get("dec") or {}).get("fatal")),
               "gold": sum(1 for t in hits if t.get("colour") == "gold"),
               "c11_contacts": len(c11), "c11_hits": len(c11h), "c11_seqs": len(seqs),
               "c11_seq_hits": sum(seq_hits), "c11_seq_hit_dist": dict(collections.Counter(seq_hits)),
               "ff_contacts": len(ff), "ff_hits": ff_hits, "ff_dodge": ff_dodge, "ff_parry": ff_parry,
               "clean_attempts": clean_attempts, "clean_dodged": clean_dodged, "clean_hit": clean_hit,
               "k0_hit_plans": k0_hit_plans, "k0_skip_plans": k0_skip_plans,
               "script_plans": script.get("plans", 0), "script_presses": script.get("presses", 0),
               "script_first_presses": len(first_presses), "script_first_skips": len(first_skips),
               "script_opener_hits": len(opener_hits), "script_fallbacks": len(fallbacks),
               "script_cancels": script.get("cancels", 0),
               "seq_presses": seq.get("presses", 0), "seq_plans": seq.get("plans", 0)}
        rows.append(row)
    print("| round | arm | result | min | hits | hits/min | fatal | gold | c11 seq | c11 hits | clean first dodge | k0 hit/skip | script plans/press/first | valid |")
    print("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|")
    for x in rows:
        print(f"| {x['round']} | {x['arm']} | {x['reason']} | {x['fight_s']/60:.2f} | {x['hits']} | {x['hit_per_min']} | "
              f"{x['fatal']} | {x['gold']} | {x['c11_seqs']} | {x['c11_hits']} | "
              f"{x['clean_dodged']}/{x['clean_attempts']} | {x['k0_hit_plans']}/{x['k0_skip_plans']} | "
              f"{x['script_plans']}/{x['script_presses']}/{x['script_first_presses']} | "
              f"{'yes' if x['valid'] else 'NO'} |")
    for arm in sorted({x["arm"] for x in rows}):
        v = [x for x in rows if x["arm"] == arm and x["valid"]]
        if not v:
            continue
        mins = sum(x["fight_s"] for x in v) / 60
        hits = sum(x["hits"] for x in v)
        print(f"\n{arm}: valid rounds {len(v)}, {mins:.1f} min, hits {hits} = {hits / mins:.2f}/min, "
              f"c11 seqs {sum(x['c11_seqs'] for x in v)}, c11 hits {sum(x['c11_hits'] for x in v)}, "
              f"clean first dodge {sum(x['clean_dodged'] for x in v)}/{sum(x['clean_attempts'] for x in v)}, "
              f"k0 hit/skip {sum(x['k0_hit_plans'] for x in v)}/{sum(x['k0_skip_plans'] for x in v)}, "
              f"script plans/press/first {sum(x['script_plans'] for x in v)}/"
              f"{sum(x['script_presses'] for x in v)}/{sum(x['script_first_presses'] for x in v)}.")


if __name__ == "__main__":
    main()
