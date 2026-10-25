"""Order 5: dufu2.js's move table (press lead per prefix group and response) from the recorded rounds.

    uv run --no-project --with numpy python workspaces/WhereWindsMeet/tools/dufu_moveid/s5_movetable.py

In: data/moveid/index.json (contacts, outcome, our presses within 45 f before each), events_ext.json (colour),
teacher_prefix/prefix.json (prefix group of every contact, group table, fatal contacts per group).
Out: workspaces/WhereWindsMeet/model/dufu2/movetable.json and the same table as a JS module,
workspaces/WhereWindsMeet/skills/lib/dufu2-table.js (skills cannot read JSON files; generated, do not edit).

Lead = frames from the press (loop clock, Date.now()) to the contact (capture clock), the index's lead_f: the
press -> screen latency is inside it, so dufu2.js presses when the predicted contact (frame capture time + the tte
head's median) is `lead` frames away from now.

Parry. A contact's effective 卸势 = our last executed 卸势 press (not inside the 330 ms lock of an earlier executed one,
an ok unlocks) after the previous contact with lead >= MIN_LEAD (the replay model of tools/dufu_train/README.md). Contacts: not gold, not a grab tick, outcome ok / pf (a hit with no timely
卸势 says nothing about the lead). ok rate per integer lead -> the global curve; the global lead = the centre of the
leads whose (3-frame smoothed) ok rate is within PLATEAU of the best, in [LO, HI]. Per group with >= MIN_GROUP
effective presses: rate_g(L) = (ok_g(L) + M * global(L)) / (n_g(L) + M) (shrunk to the global curve), smoothed, and
its best lead in [LO, HI] when it beats the global lead's rate_g by >= GAIN; else the global lead.

Dodge. A dodged blow leaves no contact, so only failed dodges are in the data (gold contacts that still hit, with a
dodge before them). Their lead histogram is written out as evidence; the lead is one global value DODGE_LEAD: past
the failed mass (75 % of the failed dodges were pressed <= 10 f before the contact; 11-20 f has 6 %), the old
dufu.js flare anchor (14 f for flare_other).

--live (closed loop, order 5): groups that the live defend rounds (data/moveid/live/analysis.json, gate-2 attacks by
recognised group) answered with success rate < LIVE_MAX over >= LIVE_MIN attacks and whose response is parry are marked
unparryable (src "live"): dufu2.js dodges a group the table marks unparryable.

Per group also: response (prefix.json majority), unparryable (prefix.json), parry rate, fatal share
(fatal_contacts / n; fatal = taxonomy class in the 80 %-of-damage set), n.
"""
from __future__ import annotations

import collections
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import OUT, REPO, read_json, write_json  # noqa: E402

WS_DIR = REPO / "workspaces" / "WhereWindsMeet"
DST = WS_DIR / "model" / "dufu2" / "movetable.json"
JS = WS_DIR / "skills" / "lib" / "dufu2-table.js"
MIN_LEAD = 1.5
LOCK_F = 330 / (1000 / 30)  # the game's 卸势 lock (dufu_train/README replay constraints)
LO, HI = 3, 11
PLATEAU = 0.02
MIN_GROUP, M, GAIN = 40, 20, 0.03
DODGE_LEAD = 14
FATAL_SHARE = 0.5
LIVE_MIN, LIVE_MAX = 10, 0.2


def smooth(r: np.ndarray, n: np.ndarray) -> np.ndarray:
    """3-frame pooled ok rate (ok and n summed over L-1..L+1)."""
    ok = r * n
    k = np.array([1, 1, 1], float)
    return np.convolve(ok, k, "same") / np.maximum(np.convolve(n, k, "same"), 1e-9)


def executed(presses: list[dict], prev_ok: bool) -> list[dict]:
    """The 卸势 presses the game executed: >= LOCK_F after the last executed one, or the first after the previous
    contact when that was an ok (an ok ends the lock). Presses are oldest first (45 f window)."""
    out, last = [], None
    for p in presses:
        if p["key"] != "parry":
            continue
        unlock = prev_ok and p["since_prev_contact"] and (last is None or not last["since_prev_contact"])
        if last is None or last["lead_f"] - p["lead_f"] >= LOCK_F or unlock:
            out.append(p)
            last = p
    return out


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true")
    a = ap.parse_args()
    live = {}
    if a.live:
        live = read_json(OUT / "live" / "analysis.json")["totals"]["defend"]["gate2"]["by_group"]
    idx = read_json(OUT / "index.json")
    ext = {e["id"]: e for e in read_json(OUT / "events_ext.json")["events"]}
    pre = read_json(OUT / "teacher_prefix" / "prefix.json")
    groups = pre["groups"]
    pe = pre["events"]
    NL = 31
    g_ok = np.zeros(NL)
    g_n = np.zeros(NL)
    per = collections.defaultdict(lambda: [np.zeros(NL), np.zeros(NL)])
    dodge_fail = collections.Counter()
    n_eff = 0
    prev_ok = {}
    for e in idx["events"]:
        po = prev_ok.get(e["rec"], False)
        prev_ok[e["rec"]] = e["outcome"] == "ok"
        x = ext[e["id"]]
        if x["color"] == "gold" and e["outcome"] != "grab":
            ds = [p["lead_f"] for p in e["presses"] if p["key"] == "dodge" and p["since_prev_contact"]]
            if ds:
                dodge_fail[min(int(round(ds[-1])), 45)] += 1
        if x["color"] == "gold" or e["outcome"] not in ("ok", "pf"):
            continue
        ps = [p["lead_f"] for p in executed(e["presses"], po) if p["since_prev_contact"] and p["lead_f"] >= MIN_LEAD]
        if not ps:
            continue
        L = min(int(round(min(ps))), NL - 1)  # presses are oldest first; the last one = the smallest lead
        ok = e["outcome"] == "ok"
        g_ok[L] += ok
        g_n[L] += 1
        gid = pe[str(e["id"])]["gid"]
        per[gid][0][L] += ok
        per[gid][1][L] += 1
        n_eff += 1
    g_rate = g_ok / np.maximum(g_n, 1e-9)
    g_s = smooth(g_rate, g_n)
    band = g_s[LO:HI + 1]
    good = [LO + i for i, v in enumerate(band) if v >= band.max() - PLATEAU]
    glob_lead = int(round((min(good) + max(good)) / 2))
    table = {}
    for g in groups:
        gid = g["gid"]
        ok, n = per[gid]
        lead, src, rate_at = glob_lead, "global", None
        if n.sum() >= MIN_GROUP:
            r = (ok + M * g_s) / (n + M)
            rs = smooth(r, n + M)
            best = LO + int(np.argmax(rs[LO:HI + 1]))
            rate_at = {"best": round(float(rs[best]), 3), "global_lead": round(float(rs[glob_lead]), 3)}
            if rs[best] - rs[glob_lead] >= GAIN:
                lead, src = best, "group"
        par = g.get("parry") or {}
        lv = live.get(g["name"])
        live_bad = bool(lv and lv["n"] >= LIVE_MIN and lv["rate"] < LIVE_MAX and g["response"] == "parry")
        table[g["name"]] = {
            "gid": gid, "k": g["k"], "n": g["n"], "response": g["response"], "unparryable": bool(par.get("unparryable")) or live_bad,
            "unparryable_src": "live" if live_bad else ("data" if par.get("unparryable") else None),
            "live": lv,
            "parry_rate": par.get("rate"), "fatal": (g.get("fatal_contacts", 0) / max(g["n"], 1)) >= FATAL_SHARE,
            "fatal_share": round(g.get("fatal_contacts", 0) / max(g["n"], 1), 3),
            "colour": max(g["colour"], key=g["colour"].get) if g.get("colour") else None,
            "parry_lead": lead, "parry_lead_src": src, "parry_n": int(n.sum()), "parry_rate_at": rate_at,
            "dodge_lead": DODGE_LEAD,
        }
    out = {
        "doc": __doc__.strip().splitlines()[0],
        "version": 1,
        "lead_clock": "frames from the press (Date.now()) to the contact (capture clock); press when the predicted contact is this far",
        "defaults": {"parry_lead": glob_lead, "dodge_lead": DODGE_LEAD},
        "params": {"MIN_LEAD": MIN_LEAD, "LO": LO, "HI": HI, "PLATEAU": PLATEAU, "MIN_GROUP": MIN_GROUP, "M": M, "GAIN": GAIN,
                   "FATAL_SHARE": FATAL_SHARE, "live": a.live, "LIVE_MIN": LIVE_MIN, "LIVE_MAX": LIVE_MAX},
        "evidence": {
            "parry_effective_contacts": n_eff,
            "parry_ok_rate_by_lead": {str(L): [int(g_ok[L]), int(g_n[L]), round(float(g_rate[L]), 3), round(float(g_s[L]), 3)]
                                      for L in range(NL) if g_n[L]},
            "parry_plateau": good,
            "dodge_failed_gold_by_lead": {str(k): v for k, v in sorted(dodge_fail.items())},
            "dodge_failed_share_le10": round(sum(v for k, v in dodge_fail.items() if k <= 10) / max(sum(dodge_fail.values()), 1), 3),
            "dodge_failed_share_11_20": round(sum(v for k, v in dodge_fail.items() if 11 <= k <= 20) / max(sum(dodge_fail.values()), 1), 3),
        },
        "groups": table,
    }
    write_json(DST, out)
    js = ("// GENERATED by tools/dufu_moveid/s5_movetable.py from data/moveid (same as model/dufu2/movetable.json): do not edit.\n"
          "// dufu2.js's move table: per prefix group (the head's grp labels) the press leads (frames before the contact,\n"
          "// press clock -> contact capture clock), response, unparryable, fatal.\n"
          f"export const DEFAULTS = {json.dumps(out['defaults'])};\n"
          "/** @type {Record<string, {gid: number, k: number, response: string, unparryable: boolean, fatal: boolean, parry_lead: number, dodge_lead: number}>} */\n"
          "export const GROUPS = {\n" +
          "".join(f"    {json.dumps(k, ensure_ascii=False)}: {json.dumps({x: v[x] for x in ('gid', 'k', 'response', 'unparryable', 'fatal', 'parry_lead', 'dodge_lead')})},\n"
                  for k, v in table.items()) + "};\n")
    JS.write_text(js, encoding="utf-8")
    src = collections.Counter(v["parry_lead_src"] for v in table.values())
    print(f"global parry lead {glob_lead} (plateau {good}), effective contacts {n_eff}; groups {len(table)} ({dict(src)});"
          f" group leads {sorted(collections.Counter(v['parry_lead'] for v in table.values()).items())}")
    print("ok rate by lead:", {L: round(float(g_s[L]), 3) for L in range(1, 16)})
    print("fatal groups:", sum(v["fatal"] for v in table.values()), "unparryable:", [k for k, v in table.items() if v["unparryable"]])
    print("dodge failed (gold) by lead:", dict(sorted(dodge_fail.items())))


if __name__ == "__main__":
    main()
