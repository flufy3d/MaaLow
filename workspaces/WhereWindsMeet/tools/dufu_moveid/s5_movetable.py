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

--keep-live: take the live entries from the current movetable.json instead of analysis.json (analysis.json holds
whatever rounds s5_analyze.py ran last; the "live1" table was made from r007-r023).

--beats r007 ... (order 5, 关 2): a beat per group from the live rounds' traces, for groups whose contact time the tte
head misses. Onset = the first of two consecutive trace rows naming the group (>= 60 f after its previous onset);
lag = the next truth contact (contacts.json, <= 60 f) - onset. A group gets beat_f = the median lag when it has
>= BEAT_MIN onsets with a contact, lag IQR <= BEAT_IQR f, <= BEAT_FALSE of its onsets have no contact, and >=
BEAT_UNARMED of its hits had no armed prediction (median tte <= 15 and P(none) <= 0.6) 3-12 f before them.
dufu2.js (args.beats) presses the group's response at onset + beat_f - lead unless the model already pressed for it.

--live-shift r007 ... (order 5, 关 2: the closed loop's timing): the live rounds' own 卸势 presses and outcomes. Per
truth contact (not gold, not a grab tick, no hit <= 20 f before it, no dodge pressed for it) with a 卸势 in [c - 25, c + 1]:
its actual lead L = c - the last such press (contacts.json presses, video frames). The ok rate per actual lead, pooled
over all groups and 3-frame smoothed, is the curve; the group's own counts shrunk to it (M) its curve; for a group with >= SHIFT_MIN such contacts parry_lead_live (dufu2.js
args.liveLeads; parry_lead stays) = the table lead moved by the shift d in [SHIFT_LO, SHIFT_HI] that maximises mean(curve(L + d)) over its contacts (the press clock moves
by d, the model's error stays), when that gains >= SHIFT_GAIN over d = 0 and the group's observed ok rate is below the predicted one by
SHIFT_GAIN (a group that already parries its contacts at short leads, e.g. k3:c14+c30 30 / 31, keeps its lead). Groups the live table marks unparryable keep
their lead (they are dodged).

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
BEAT_MIN, BEAT_IQR, BEAT_FALSE, BEAT_UNARMED, BEAT_HITS = 15, 4.0, 0.35, 0.3, 5
FRAME_MS = 1000 / 30
SHIFT_MIN, SHIFT_LO, SHIFT_HI, SHIFT_GAIN = 30, -3, 5, 0.01


def live_shift(rounds: list[str]) -> tuple[dict, dict]:
    """-> ({group: {"n", "shift", "gain", "rate0", "rate"}}, the pooled curve {lead: [ok, n, smoothed]})."""
    live = OUT / "live"
    per = collections.defaultdict(list)
    for rn in rounds:
        f = live / rn / "contacts.json"
        if not f.exists():
            continue
        T = read_json(f)["truth"]
        hits = [t["frame"] for t in T if t["kind"] == "hit"]
        for t in T:
            if t["colour"] == "gold" or t.get("grab") or any(0 < t["frame"] - h <= 20 for h in hits):
                continue
            if any(p["key"] == "dodge" for p in t["presses"]):
                continue
            ps = [p["lead"] for p in t["presses"] if p["key"] == "parry"]
            if not ps:
                continue
            per[(t.get("dec") or {}).get("grp", "?")].append((min(ps), t["kind"] == "ok"))
    NL = 31
    ok, n = np.zeros(NL), np.zeros(NL)
    for v in per.values():
        for L, k in v:
            i = int(round(L))
            if 0 <= i < NL:
                ok[i] += k
                n[i] += 1
    curve = smooth(ok / np.maximum(n, 1e-9), n)
    out = {}
    for g, v in per.items():
        if len(v) < SHIFT_MIN:
            continue
        og, ng = np.zeros(NL), np.zeros(NL)
        for L, k in v:
            i = int(round(L))
            if 0 <= i < NL:
                og[i] += k
                ng[i] += 1
        cg = smooth((og + M * curve) / (ng + M), ng + M)   # the group's own curve, shrunk to the pooled one
        cv = lambda L, cg=cg: cg[int(np.clip(round(L), 0, NL - 1))] if L >= 0 else 0.0  # noqa: E731
        rate = {d: float(np.mean([cv(L + d) for L, _ in v])) for d in range(SHIFT_LO, SHIFT_HI + 1)}
        best = max(rate, key=lambda d: (rate[d], -abs(d)))
        gain = rate[best] - rate[0]
        obs = float(np.mean([k for _, k in v]))
        use = gain >= SHIFT_GAIN and obs < rate[best] - SHIFT_GAIN   # nothing to fix when it already does that well
        out[g] = {"n": len(v), "shift": best if use else 0, "gain": round(gain, 4),
                  "rate0": round(rate[0], 4), "rate": round(rate[best], 4),
                  "observed_ok": round(float(np.mean([k for _, k in v])), 4)}
    return out, {str(L): [int(ok[L]), int(n[L]), round(float(curve[L]), 3)] for L in range(NL) if n[L]}


def beats(rounds: list[str], names: list[str]) -> dict:
    """{group name: {beat_f, n, iqr, false, unarmed_hits, hits, used}} (module doc)."""
    live = OUT / "live"
    st = collections.defaultdict(list)
    for rn in rounds:
        d = live / rn
        res = (read_json(d / "result.json") or {}).get("value")
        tr = read_json(d / "trace.json", [])
        if not res or not tr or not (d / "contacts.json").exists():
            continue
        tr = sorted(tr, key=lambda c: c["chunk"])
        C = {c: i for i, c in enumerate(tr[0]["cols"])}
        R = np.array([r for c in tr for r in c["rows"]], np.float64)
        rid = (d / "rec.txt").read_text(encoding="utf-8").strip()
        meta = read_json(live / "meta" / f"{rid}.json")
        con = read_json(d / "contacts.json")
        cf = (res["start"] - meta["started"]) / FRAME_MS + R[:, C["cap"]] / FRAME_MS + con["offset"]
        g = R[:, C["grp"]].astype(int)
        tf = np.array([t["frame"] for t in con["truth"]])
        kind = [t["kind"] for t in con["truth"]]
        last: dict[int, float] = {}
        for i in range(1, len(R)):
            gi = g[i]
            if gi >= len(names) or gi < 0 or gi != g[i - 1]:
                continue
            prev = last.get(gi, -1e9)
            last[gi] = cf[i - 1]
            if cf[i - 1] - prev < 60:
                continue
            on = cf[i - 1]
            nx = tf[(tf > on) & (tf <= on + 60)] if len(tf) else tf
            if not len(nx):
                st[gi].append(None)
                continue
            c = nx[0]
            w = (cf >= c - 12) & (cf <= c - 3)
            armed = bool(((R[w, C["med"]] <= 15) & (R[w, C["rnone"]] <= 0.6)).any())
            st[gi].append((float(c - on), kind[int(np.nonzero(tf == c)[0][0])], armed))
    out = {}
    for gi, v in st.items():
        lags = np.array([x[0] for x in v if x])
        if len(lags) < BEAT_MIN:
            continue
        q1, q2, q3 = np.percentile(lags, [25, 50, 75])
        hits = [x for x in v if x and x[1] == "hit"]
        unarmed = sum(not x[2] for x in hits)
        false = 1 - len(lags) / len(v)
        ok = bool(q3 - q1 <= BEAT_IQR and false <= BEAT_FALSE and len(hits) >= BEAT_HITS and unarmed / len(hits) >= BEAT_UNARMED)
        out[names[gi]] = {"beat_f": round(float(q2), 1), "n": len(lags), "onsets": len(v), "iqr": round(float(q3 - q1), 1),
                          "false": round(false, 2), "hits": len(hits), "unarmed_hits": unarmed, "used": ok}
    return out


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
    ap.add_argument("--keep-live", action="store_true")
    ap.add_argument("--beats", nargs="*", default=None)
    ap.add_argument("--live-shift", nargs="*", default=None)
    a = ap.parse_args()
    live = {}
    if a.keep_live:
        live = {k: v["live"] for k, v in read_json(DST)["groups"].items() if v.get("live")}
        a.live = True
    elif a.live:
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
    bt = beats(a.beats, [g["name"] for g in sorted(groups, key=lambda g: g["gid"])]) if a.beats else {}
    sh, sh_curve = live_shift(a.live_shift) if a.live_shift else ({}, {})
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
        unp = bool(par.get("unparryable")) or live_bad
        s_ = sh.get(g["name"])
        lead2 = int(np.clip(lead + s_["shift"], 1, 20)) if s_ and s_["shift"] and not unp else lead
        table[g["name"]] = {
            "gid": gid, "k": g["k"], "n": g["n"], "response": g["response"], "unparryable": bool(par.get("unparryable")) or live_bad,
            "unparryable_src": "live" if live_bad else ("data" if par.get("unparryable") else None),
            "live": lv,
            "parry_rate": par.get("rate"), "fatal": (g.get("fatal_contacts", 0) / max(g["n"], 1)) >= FATAL_SHARE,
            "fatal_share": round(g.get("fatal_contacts", 0) / max(g["n"], 1), 3),
            "colour": max(g["colour"], key=g["colour"].get) if g.get("colour") else None,
            "parry_lead": lead, "parry_lead_src": src, "parry_n": int(n.sum()), "parry_rate_at": rate_at,
            "dodge_lead": DODGE_LEAD,
            "beat_f": bt[g["name"]]["beat_f"] if bt.get(g["name"], {}).get("used") else None,
            "parry_lead_live": lead2,
            "beat": bt.get(g["name"]),
            "live_shift": s_,
        }
    out = {
        "doc": __doc__.strip().splitlines()[0],
        "version": 1,
        "lead_clock": "frames from the press (Date.now()) to the contact (capture clock); press when the predicted contact is this far",
        "defaults": {"parry_lead": glob_lead, "dodge_lead": DODGE_LEAD},
        "params": {"MIN_LEAD": MIN_LEAD, "LO": LO, "HI": HI, "PLATEAU": PLATEAU, "MIN_GROUP": MIN_GROUP, "M": M, "GAIN": GAIN,
                   "FATAL_SHARE": FATAL_SHARE, "live": a.live, "LIVE_MIN": LIVE_MIN, "LIVE_MAX": LIVE_MAX,
                   "beats": a.beats, "live_shift": a.live_shift, "SHIFT": [SHIFT_MIN, SHIFT_LO, SHIFT_HI, SHIFT_GAIN], "BEAT_MIN": BEAT_MIN, "BEAT_IQR": BEAT_IQR, "BEAT_FALSE": BEAT_FALSE, "BEAT_UNARMED": BEAT_UNARMED},
        "evidence": {
            "parry_effective_contacts": n_eff,
            "parry_ok_rate_by_lead": {str(L): [int(g_ok[L]), int(g_n[L]), round(float(g_rate[L]), 3), round(float(g_s[L]), 3)]
                                      for L in range(NL) if g_n[L]},
            "parry_plateau": good,
            "dodge_failed_gold_by_lead": {str(k): v for k, v in sorted(dodge_fail.items())},
            "live_parry_ok_by_actual_lead": sh_curve,
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
          "/** @type {Record<string, {gid: number, k: number, response: string, unparryable: boolean, fatal: boolean, parry_lead: number, dodge_lead: number, parry_lead_live: number, beat_f: number | null}>} */\n"
          "export const GROUPS = {\n" +
          "".join(f"    {json.dumps(k, ensure_ascii=False)}: {json.dumps({x: v[x] for x in ('gid', 'k', 'response', 'unparryable', 'fatal', 'parry_lead', 'dodge_lead', 'parry_lead_live', 'beat_f')})},\n"
                  for k, v in table.items()) + "};\n")
    JS.write_text(js, encoding="utf-8")
    src = collections.Counter(v["parry_lead_src"] for v in table.values())
    print(f"global parry lead {glob_lead} (plateau {good}), effective contacts {n_eff}; groups {len(table)} ({dict(src)});"
          f" group leads {sorted(collections.Counter(v['parry_lead'] for v in table.values()).items())}")
    print("ok rate by lead:", {L: round(float(g_s[L]), 3) for L in range(1, 16)})
    print("fatal groups:", sum(v["fatal"] for v in table.values()), "unparryable:", [k for k, v in table.items() if v["unparryable"]])
    print("dodge failed (gold) by lead:", dict(sorted(dodge_fail.items())))
    if sh:
        print("live shifts:", {k: (v["shift"], v["n"], v["rate0"], v["rate"]) for k, v in sh.items() if v["shift"]})
    if bt:
        print("beats:", {k: v for k, v in bt.items() if v["used"]})
        print("not used:", {k: (v["beat_f"], v["iqr"], v["false"], v["unarmed_hits"], v["hits"]) for k, v in bt.items() if not v["used"]})


if __name__ == "__main__":
    main()
