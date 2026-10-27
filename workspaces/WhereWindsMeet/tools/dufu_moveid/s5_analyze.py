"""Order 5: the live dufu2 rounds against their recordings: contact detection, the model at decision time, idle false
alarms, timing (shadow) and gate 2 (defend).

    uv run --no-project --with numpy python workspaces/WhereWindsMeet/tools/dufu_moveid/s5_analyze.py [r003 r004 ...]

Needs s5_pull.py (live/video, live/bars, live/meta) and s5_color.py (live/color). Rounds: data/moveid/live/rNNN.
Out: data/moveid/live/analysis.json (per round + totals) and analysis.md; per round <round>/contacts.json.
MOVEID_PHASE=1 (独夫 阶段一): the same files under data/moveid/p1/ and model/dufu1/movetable.json (the rules are
unchanged; with no 红光 a truth dodge is a 金招 or a group the table marks unparryable, as written below).

Clock. The trace / result times are ms since the skill start (Date.now(); `cap` = the screenshot's capture time).
Video frame vf(t) = (start + t - meta.started) / FRAME_MS + offset, offset one constant per round: the median of
(hp step frame in the video - vf0(the device's "seen" time of its hit)) over the device hits (build.py's idea; a
coarse peak within +-25 f first, then the steps within +-3 f of it).

Truth contacts (video only, labels.contacts definitions, build.py readers):
  hit  an hp step (>= 2 % below the median of the 4 frames before, held) at frame s -> contact s - 5
  ok   a boss 真气 step (>= 6 px, >= 4 before, > 0 after) with one of our real 卸势 presses <= 24 f before -> contact s;
       an ok within 6 f of a hit is the hit
  colour  s2_color.label on the per-frame crop-classifier output (gold / red / none / unknown)
Detection: a device contact matches a truth contact of its kind within +-MATCH_F frames. Latency = the frame the device
saw it (its "seen" midpoint) - the truth contact; the history has it from max(seen tick, contact + 6) on.
Decision time = the trace row whose capture is closest to contact - 10 f (|diff| <= 1.5 f). Truth response there =
dodge if the truth colour is gold or the move table marks the recognised group unparryable, else parry.
Recognised group = the grp argmax at decision time (idle: the first non-idle in -10..0, else "unrecognised").
Idle rows: no truth contact within [-30, +45] f of the row. "Contact predicted" = what dufu2.decide needs to be armed:
median tte <= 15 and P(resp none) <= 0.6.

Gate 2 (defend rounds, rule fixed before the defend runs):
  attacks  every truth contact (ok = success, hit = failure) except grab-cutscene ticks (as gate 1), plus every real dodge press with no truth contact in
           [press, press + 25 f] (a dodged blow leaves no contact): "verified" when a gold tell (pG >= 0.5) starts in
           [press - 30, press + 12] f, else "unverified". Reported with the unverified ones counted in (as successes)
           and not counted.
  fatal    the recognised group at decision time (dodges: the group at the press) is fatal in the move table
           (>= half of its training contacts are taxonomy-fatal). Unrecognised attacks are reported apart (and in
           the "all attacks" line).
  (1) fatal success rate = successes / fatal attacks >= 90 %
  (2) gold parried = truth-gold contacts with one of our 卸势 presses in [c - 15, c] and no dodge in [c - 20, c]
      / (truth-gold contacts + verified gold dodges) <= 3 %
  failure causes of a hit, first that applies: 不可行动 (a truth hit <= 20 f before it, or our potion tap <= 700 ms
  before) / 没认出 (no press in [c - 25, c + 1]) / 认错应对 (the last press is not the truth response) / 时机偏 (lead
  outside [2, 12] f for 卸势, [6, 22] f for a dodge) / 认对按对仍挨打.
"""
from __future__ import annotations

import collections
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build import ffill, steps_fast  # noqa: E402
from common import OUT, PHASE, REPO, read_json, write_json  # noqa: E402
from s2_color import label as colour_label  # noqa: E402

FRAME_MS = 1000 / 30
LIVE = OUT / "live"
TABLE = read_json(REPO / "workspaces" / "WhereWindsMeet" / "model" / f"dufu{PHASE}" / "movetable.json")
GNAMES = list(TABLE["groups"].keys())
IDLE = len(GNAMES)               # the grp head's idle label (87 in 阶段二, 97 in 阶段一)
HIT_TH, QI_TH, HIT_LAG = 0.02, 6, 5
MATCH_F = 3
DEC_F = 10
COLS_RESP = ["dodge", "parry", "none"]
COLS_COL = ["gold", "red", "none"]


def rows_of(trace: list[dict]) -> tuple[list[str], np.ndarray]:
    trace = sorted(trace, key=lambda c: c["chunk"])
    cols = trace[0]["cols"]
    return cols, np.array([r for c in trace for r in c["rows"]], np.float64)


def group_of(gi: int) -> dict | None:
    return TABLE["groups"][GNAMES[gi]] if 0 <= gi < len(GNAMES) else None


def analyze(d: Path) -> dict | None:
    res = (read_json(d / "result.json", {}) or {}).get("value")
    trace = read_json(d / "trace.json", [])
    args = read_json(d / "args.json", {}) or {}
    rid = (d / "rec.txt").read_text(encoding="utf-8").strip()
    if not res or not trace or not (LIVE / "bars" / f"{rid}.npz").exists():
        return None
    meta = read_json(LIVE / "meta" / f"{rid}.json")
    bars = np.load(LIVE / "bars" / f"{rid}.npz")
    cfile = LIVE / "color" / f"{rid}.npz"
    fp = np.load(cfile)["fp"] if cfile.exists() else None
    start = res["start"]
    cols, R = rows_of(trace)
    C = {c: i for i, c in enumerate(cols)}
    k0 = (start - meta["started"]) / FRAME_MS
    vf0 = lambda t: k0 + np.asarray(t, np.float64) / FRAME_MS  # noqa: E731

    hp = bars["hp"]
    hp_steps = steps_fast(ffill(hp, np.isnan(hp)), HIT_TH)
    qi = ffill(bars["qi"], bars["qi"] < 0)
    qs = steps_fast(qi, QI_TH)
    qs = qs[(qi[np.maximum(qs - 4, 0)] >= 4) & (qi[np.minimum(qs + 2, len(qi) - 1)] > 0)]

    # device contacts: [t contact (ms since start), tick frame, kind, seen tick frame]
    tick0 = res["t0"] - start
    dev = [{"t": c[0], "kind": c[2], "seen_t": tick0 + c[3] * FRAME_MS} for c in res["contacts"]]
    # offset
    diffs = [s - vf0(c["seen_t"]) for c in dev if c["kind"] == "hit" for s in hp_steps if abs(s - vf0(c["seen_t"])) <= 25]
    if diffs:
        h = collections.Counter(int(round(x)) for x in diffs)
        coarse = max(range(-25, 26), key=lambda o: (h[o - 1] + 2 * h[o] + h[o + 1], -abs(o)))
        near = [x for x in diffs if abs(x - coarse) <= 3]
        off = float(np.median(near))
    else:
        off, near = -3.67, []  # the order-1 median
    vf = lambda t: vf0(t) + off  # noqa: E731

    # truth contacts
    real_parry = [p[0] for p in res["pressLog"] if p[1] == "parry"]
    real_dodge = [p for p in res["pressLog"] if p[1] == "dodge"]
    pv = np.array([vf(t) for t in real_parry])
    truth = [{"frame": int(s - HIT_LAG), "kind": "hit", "step": int(s),
              "drop": round(float(np.nanmedian(hp[max(0, s - 4):s]) - np.nanmedian(hp[s:s + 3])), 3)} for s in hp_steps]
    for s in qs:
        if len(pv) and np.any((s - pv >= 0) & (s - pv <= 24)) and not any(abs(t["frame"] - s) <= 6 for t in truth if t["kind"] == "hit"):
            truth.append({"frame": int(s), "kind": "ok", "step": int(s), "drop": 0.0})
    truth.sort(key=lambda t: t["frame"])
    # grab-cutscene ticks (labels._outcomes: a hit chain with gaps <= 1600 ms, first gap 1250-1550, next two 600-850):
    # the hits after the first are "grab" (gate 1 left them out: nothing answers them)
    hits_ = [t for t in truth if t["kind"] == "hit"]
    chain: list = []
    for t in hits_ + [None]:
        if t is not None and chain and (t["frame"] - chain[-1]["frame"]) * FRAME_MS <= 1600:
            chain.append(t)
            continue
        g = [(b["frame"] - a["frame"]) * FRAME_MS for a, b in zip(chain, chain[1:])]
        if len(chain) >= 3 and 1250 <= g[0] <= 1550 and all(600 <= v <= 850 for v in g[1:3]):
            for x in chain[1:]:
                x["grab"] = True
        chain = [t] if t is not None else []
    prev = None
    for t in truth:
        t["colour"] = colour_label({"frame": t["frame"]}, prev, fp, 30)["color"] if fp is not None else "n/a"
        prev = t["frame"]

    # detection
    used = set()
    lat, miss, matched = [], [], 0
    for t in truth:
        best = None
        for j, c in enumerate(dev):
            if j in used or c["kind"] != t["kind"]:
                continue
            dfr = vf(c["t"]) - t["frame"]
            if abs(dfr) <= MATCH_F and (best is None or abs(dfr) < abs(best[1])):
                best = (j, dfr)
        if best:
            used.add(best[0])
            c = dev[best[0]]
            t["dev"] = {"err_f": round(best[1], 2), "seen_lat_f": round(float(vf(c["seen_t"]) - t["frame"]), 2)}
            lat.append(t["dev"]["seen_lat_f"])
            matched += 1
        else:
            miss.append(t)
    false = [c for j, c in enumerate(dev) if j not in used]

    # decision time
    capv = vf(R[:, C["cap"]])
    def row_at(f):
        i = int(np.argmin(np.abs(capv - f)))
        return i if abs(capv[i] - f) <= 1.5 else None
    for t in truth:
        i = row_at(t["frame"] - DEC_F)
        if i is None:
            t["dec"] = None
            continue
        r = R[i]
        g = int(r[C["grp"]])
        if g == IDLE or g < 0:
            for j in range(i, len(R)):
                if capv[j] > t["frame"]:
                    break
                if 0 <= R[j, C["grp"]] < IDLE:
                    g = int(R[j, C["grp"]])
                    break
        gr = group_of(g) if 0 <= g < IDLE else None
        resp = int(np.argmax(r[[C["dodge"], C["parry"], C["rnone"]]]))
        col = int(np.argmax(r[[C["gold"], C["red"], C["none"]]]))
        truth_resp = "dodge" if t["colour"] == "gold" or (gr and gr["unparryable"]) else "parry"
        med = r[C["med"]]
        t["dec"] = {"row": i, "grp": GNAMES[g] if 0 <= g < IDLE else "unrecognised", "fatal": bool(gr and gr["fatal"]),
                    "resp": COLS_RESP[resp], "pgold": r[C["gold"]], "col": COLS_COL[col], "truth_resp": truth_resp,
                    "med": med, "tte_err": None if med >= 46 else round(float(med - (t["frame"] - capv[i])), 2),
                    "armed": bool(med <= 15 and r[C["rnone"]] <= 0.6)}
        if PHASE == 1 and str(t["dec"]["grp"]).endswith(":grab"):
            t["grab"] = True  # phase-1 gold-grab close-up (the phase-2 timing rule does not catch it)

    # presses (real or shadow) vs truth: the last press in [c - 25, c + 1]
    allp = [(vf(p[0]), p[1].replace("would-", ""), p) for p in res["pressLog"]]
    for t in truth:
        ps = [(f, k) for f, k, _ in allp if t["frame"] - 25 <= f <= t["frame"] + 1]
        t["presses"] = [{"key": k, "lead": round(t["frame"] - f, 1)} for f, k in ps]

    # idle rows
    tf = np.array([t["frame"] for t in truth]) if truth else np.zeros(0)
    idle = np.ones(len(R), bool)
    for f in tf:
        idle &= ~((capv >= f - 45) & (capv <= f + 30))
    armed = (R[:, C["med"]] <= 15) & (R[:, C["rnone"]] <= 0.6)
    walking = R[:, C["boss"]] <= 50
    idle_press = [p for f, k, p in allp if not np.any((tf - f >= -1) & (tf - f <= 25))]

    out = {"round": d.name, "rec": rid, "mode": args.get("mode"), "provider": (res.get("ran") or {}).get("glob"),
           "reason": res["reason"], "fight_s": round(res["fightMs"] / 1000, 1), "offset": round(off, 2), "offset_n": len(near),
           "ms": {k: res["ms"][k] for k in ("pipe", "prep", "run", "shot", "reads", "loop", "inferWall")},
           "fills": res["fills"], "skipped": res["skipped"], "dups": res["dups"], "ticks": res["ticks"],
           "truth": {"hit": sum(t["kind"] == "hit" for t in truth), "ok": sum(t["kind"] == "ok" for t in truth),
                     "colour": dict(collections.Counter(t["colour"] for t in truth))},
           "device": {"hit": sum(c["kind"] == "hit" for c in dev), "ok": sum(c["kind"] == "ok" for c in dev)},
           "detect": {"matched": matched, "missed": len(miss), "false": len(false),
                      "missed_drops": [t["drop"] for t in miss], "seen_latency_f": lat,
                      "false_at_f": [round(float(vf(c["t"])), 1) for c in false]},
           "idle": {"rows": int(idle.sum()), "armed_rows": int((idle & armed).sum()),
                    "walk_rows": int((idle & walking).sum()), "walk_armed": int((idle & walking & armed).sum()),
                    "presses_without_contact": len(idle_press)},
           "presses": res["presses"], "would": res["would"],
           "boss_s": next((m[0] / 1000 for m in res["marks"] if m[1] == "boss"), None)}
    write_json(d / "contacts.json", json.loads(json.dumps({"offset": off, "truth": truth, "false": false},
                                                          default=lambda x: x.item() if hasattr(x, "item") else str(x))))
    out["truth_list"] = truth
    out["dodges"] = []
    if args.get("mode") == "defend":
        for f, k, p in allp:
            if k != "dodge" or p[1] != "dodge":
                continue
            if np.any((tf - f >= 0) & (tf - f <= 25)):
                continue
            ver = False
            if fp is not None:
                a, b = int(max(0, f - 30)), int(min(len(fp) - 1, f + 12))
                ver = bool(np.any(fp[a:b + 1, 1] >= 0.5))
            gi = int(p[2]) if p[2] is not None else -1
            gr = group_of(gi) if 0 <= gi < IDLE else None
            out["dodges"].append({"frame": round(f, 1), "verified_gold": ver, "grp": GNAMES[gi] if gr else "unrecognised",
                                  "fatal": bool(gr and gr["fatal"])})
        potions = [vf(m[0]) for m in res["marks"] if m[1] == "potion" and str(m[2]).startswith("tap")]
        hit_frames = [t["frame"] for t in truth if t["kind"] == "hit"]
        for t in truth:
            if t["kind"] != "hit":
                continue
            c = t["frame"]
            real = [x for x in t["presses"]]
            tr = (t.get("dec") or {}).get("truth_resp", "gold" if t["colour"] == "gold" else "parry")
            if any(0 < c - h <= 20 for h in hit_frames) or any(0 <= c - pf <= 21 for pf in potions):
                why = "不可行动"
            elif not real:
                why = "没认出"
            elif real[-1]["key"] != tr:
                why = "认错应对"
            elif not ((2 <= real[-1]["lead"] <= 12) if tr == "parry" else (6 <= real[-1]["lead"] <= 22)):
                why = "时机偏"
            else:
                why = "认对按对仍挨打"
            t["why"] = why
    return out


def gate2(rounds: list[dict]) -> dict:
    """Gate 2 over the defend rounds (rule in the module docstring)."""
    att = []
    for r in rounds:
        for t in r["truth_list"]:
            dec = t.get("dec") or {}
            if t.get("grab"):
                continue  # grab-cutscene ticks: not answerable, left out as in gate 1 (counted in grab_ticks)
            att.append({"round": r["round"], "kind": "contact", "ok": t["kind"] == "ok", "fatal": dec.get("fatal", False),
                        "grp": dec.get("grp", "unrecognised"), "colour": t["colour"], "why": t.get("why"),
                        "gold_parried": t["colour"] == "gold" and any(p["key"] == "parry" and 0 <= p["lead"] <= 15 for p in t["presses"])
                        and not any(p["key"] == "dodge" and 0 <= p["lead"] <= 20 for p in t["presses"])})
        for x in r["dodges"]:
            att.append({"round": r["round"], "kind": "dodge_verified" if x["verified_gold"] else "dodge_unverified", "ok": True,
                        "fatal": x["fatal"], "grp": x["grp"], "colour": "gold" if x["verified_gold"] else "?", "why": None,
                        "gold_parried": False})

    def rate(sel):
        n = len(sel)
        k = sum(a["ok"] for a in sel)
        return {"ok": k, "n": n, "rate": round(k / n, 4) if n else None}
    out = {}
    for name, keep in (("with_unverified", lambda a: True), ("without_unverified", lambda a: a["kind"] != "dodge_unverified")):
        A = [a for a in att if keep(a)]
        out[name] = {"fatal": rate([a for a in A if a["fatal"]]), "all": rate(A),
                     "unrecognised": rate([a for a in A if a["grp"] == "unrecognised"]),
                     "by_round": {r["round"]: rate([a for a in A if a["round"] == r["round"] and a["fatal"]]) for r in rounds}}
    gold = [a for a in att if a["colour"] == "gold"]
    gp = sum(a["gold_parried"] for a in gold)
    out["gold_parried"] = {"n": gp, "of": len(gold), "rate": round(gp / len(gold), 4) if gold else None,
                           "gold_contacts": sum(a["kind"] == "contact" for a in gold),
                           "verified_gold_dodges": sum(a["kind"] == "dodge_verified" for a in gold)}
    out["grab_ticks"] = sum(bool(t.get("grab")) for r in rounds for t in r["truth_list"])
    out["why"] = dict(collections.Counter(a["why"] for a in att if a["why"]))
    out["why_fatal"] = dict(collections.Counter(a["why"] for a in att if a["why"] and a["fatal"]))
    bg = collections.defaultdict(lambda: [0, 0])
    for a in att:
        bg[a["grp"]][0] += a["ok"]
        bg[a["grp"]][1] += 1
    out["by_group"] = {g: {"ok": v[0], "n": v[1], "rate": round(v[0] / v[1], 3)} for g, v in sorted(bg.items(), key=lambda kv: -kv[1][1])}
    out["pass"] = {"fatal_ge_90": (out["without_unverified"]["fatal"]["rate"] or 0) >= 0.9,
                   "fatal_ge_90_with_unverified": (out["with_unverified"]["fatal"]["rate"] or 0) >= 0.9,
                   "gold_parried_le_3": (out["gold_parried"]["rate"] or 0) <= 0.03}
    return out


def decision_summary(rounds: list[dict]) -> dict:
    T = [t for r in rounds for t in r["truth_list"] if t.get("dec")]
    resp_ok = sum(t["dec"]["resp"] == t["dec"]["truth_resp"] for t in T)
    fat = [t for t in T if t["dec"]["fatal"]]
    gold = [t for t in T if t["colour"] == "gold"]
    errs = [abs(t["dec"]["tte_err"]) for t in T if t["dec"]["tte_err"] is not None]
    return {"contacts_with_row": len(T), "resp_ok": resp_ok, "resp_ok_rate": round(resp_ok / len(T), 3) if T else None,
            "fatal_resp_ok": f"{sum(t['dec']['resp'] == t['dec']['truth_resp'] for t in fat)}/{len(fat)}",
            "resp_none_at_dec": sum(t["dec"]["resp"] == "none" for t in T),
            "armed_at_dec": sum(t["dec"]["armed"] for t in T),
            "gold_contacts": len(gold), "gold_as_parry": sum(t["dec"]["resp"] == "parry" and t["dec"]["pgold"] < 0.15 for t in gold),
            "gold_col_as_red": sum(t["dec"]["col"] == "red" for t in gold),
            "tte_abs_err_p50_p90": [round(float(np.percentile(errs, 50)), 1), round(float(np.percentile(errs, 90)), 1)] if errs else None,
            "resp_confusion": dict(collections.Counter(f"{t['dec']['truth_resp']}->{t['dec']['resp']}" for t in T)),
            "colour_confusion": dict(collections.Counter(f"{t['colour']}->{t['dec']['col']}" for t in T))}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    names = sys.argv[1:] or [p.name for p in sorted(LIVE.glob("r[0-9][0-9][0-9]"))]
    rounds = [r for r in (analyze(LIVE / n) for n in names) if r]
    sh = [r for r in rounds if r["mode"] == "shadow"]
    de = [r for r in rounds if r["mode"] == "defend"]
    tot = {}
    for name, rs in (("shadow", sh), ("defend", de)):
        if not rs:
            continue
        lat = [x for r in rs for x in r["detect"]["seen_latency_f"]]
        fm = sum(max(0.0, r["fight_s"] - (r["boss_s"] or 0)) for r in rs) / 60
        tot[name] = {
            "rounds": len(rs),
            "detect": {"truth": sum(r["truth"]["hit"] + r["truth"]["ok"] for r in rs), "matched": sum(r["detect"]["matched"] for r in rs),
                       "missed": sum(r["detect"]["missed"] for r in rs), "false": sum(r["detect"]["false"] for r in rs),
                       "seen_latency_f_p10_p50_p90": [round(float(np.percentile(lat, q)), 2) for q in (10, 50, 90)] if lat else None},
            "decision": decision_summary(rs),
            "idle": {k: sum(r["idle"][k] for r in rs) for k in rs[0]["idle"]},
            "fight_min": round(fm, 2),
            "truth_hits_per_min": round(sum(r["truth"]["hit"] for r in rs) / fm, 2) if fm else None,
            "survival_s": [r["fight_s"] for r in rs],
        }
        if name == "defend":
            tot[name]["gate2"] = gate2(rs)
            tot[name]["presses_per_min"] = round(sum(r["presses"]["parry"] + r["presses"]["dodge"] for r in rs) / fm, 1) if fm else None
    for r in rounds:
        r.pop("truth_list")
    plain = lambda o: json.loads(json.dumps(o, default=lambda x: x.item() if hasattr(x, "item") else str(x)))  # noqa: E731
    write_json(LIVE / "analysis.json", plain({"rounds": rounds, "totals": tot}))
    print(json.dumps(plain(tot), ensure_ascii=False, indent=1))
    for r in rounds:
        print(r["round"], r["mode"], r["provider"], r["reason"], r["fight_s"], "off", r["offset"], r["offset_n"], "truth", r["truth"],
              "detect", {k: r["detect"][k] for k in ("matched", "missed", "false")}, "idle", r["idle"])


if __name__ == "__main__":
    main()
