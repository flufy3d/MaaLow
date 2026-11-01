"""Offline replay of the c11 branch script against the phase-1 live rounds.

    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/c11_replay.py
    uv run python .../c11_replay.py --rounds r185 r201 r221 r223
    uv run python .../c11_replay.py --script workspaces/WhereWindsMeet/move_scripts/c11.json

Reads only data/moveid/p1/live/rNNN/{contacts,trace,result,args}.json + live/meta/<rec>.json and the move table
(model/dufu1/movetable.json); it does not import s5_ab / s5_analyze. The script is move_scripts/c11.json.

Two scopes are reported:
  core29      r185-r219, all truth contacts clustered by gap <= 30 f, episodes whose first contact is c11/c40
              (the old offense_episodes.py main table: 29 episodes / 98 beats).
  extended38  r185-r223, only c11/c40 truth contacts clustered by gap <= 30 f (38 episodes / 113 beats; includes
              the 3 k0-dodged episodes and the 6 seqDefense episodes from r221/r223).

For every episode the replay reports:
  observed    what the recorded policy did: gold opener hit/ok/dodged, follow-up hits, parry press leads.
  script      the branch script's plan: dodge the gold opener at t0 - 3 f (the observed 2-5 f i-frame window),
              do not press in the hitstun branch, dodge the first no-light follow-up after a gold dodge
              (user rule 2026-11-01: dodge-only, not parry), and schedule one punish action in the first
              contact-free window after the chain (offline only; runtime offense stays off).
The first follow-up dodge is a counterfactual: the old policy used parry there (135 presses, 0 ok); the
replay evaluates whether a clean second dodge at f0 - 4 is possible, not whether it has already landed.
The acceptance is k1/k2 hits == 0 after the script; if the later hits remain unknown, the summary says so
instead of calling the chain a fixed cost.
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import FRAME_MS, REPO, read_json, write_json  # noqa: E402

LIVE = REPO / "data" / "moveid" / "p1" / "live"
MOVETABLE = REPO / "workspaces" / "WhereWindsMeet" / "model" / "dufu1" / "movetable.json"
OUT_DIR = REPO / "data" / "moveid" / "offense" / "online"
DEFAULT_SCRIPT = REPO / "workspaces" / "WhereWindsMeet" / "move_scripts" / "c11.json"
GAP_F = 30
HITSTUN_F = 12
DODGE_IFRAME = (1, 5)
DODGE_LOCK_F = 12
PARRY_LOCK_F = 10
PARRY_CD_F = 7
PUNISH_MIN_GAP = 20
PUNISH_DELAY = 13
PUNISH_ACTIONS = {"execute": 45, "light": 42, "follow": 61}


def grp_of(t: dict) -> str:
    return str((t.get("dec") or {}).get("grp") or "")


def is_c11_name(name: str) -> bool:
    return "c11" in str(name) or "c40" in str(name)


def is_c11(t: dict) -> bool:
    return is_c11_name(grp_of(t))


def k_of(t: dict) -> int:
    g = grp_of(t)
    if g.startswith("k") and len(g) > 1 and g[1].isdigit():
        return int(g[1])
    return -1


def cluster(contacts: list[dict], gap_f: int = GAP_F) -> list[list[dict]]:
    out: list[list[dict]] = []
    for t in sorted(contacts, key=lambda x: float(x["frame"])):
        if out and float(t["frame"]) - float(out[-1][-1]["frame"]) <= gap_f:
            out[-1].append(t)
        else:
            out.append([t])
    return out


def q(vals: list[float], p: float) -> float | None:
    if not vals:
        return None
    s = sorted(float(v) for v in vals)
    x = (len(s) - 1) * p
    lo = int(math.floor(x))
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (x - lo)


def describe(vals: list[float]) -> dict:
    v = [float(x) for x in vals if x is not None]
    if not v:
        return {"n": 0, "min": None, "p25": None, "median": None, "p75": None, "max": None}
    return {"n": len(v), "min": round(min(v), 2), "p25": round(q(v, 0.25), 2),
            "median": round(statistics.median(v), 2), "p75": round(q(v, 0.75), 2),
            "max": round(max(v), 2)}


def configure(script: dict) -> None:
    """Read the frame/state constants from move_scripts/c11.json (the defaults above mirror it)."""
    global HITSTUN_F, DODGE_IFRAME, DODGE_LOCK_F, PARRY_LOCK_F, PARRY_CD_F, PUNISH_MIN_GAP, PUNISH_DELAY, PUNISH_ACTIONS
    st = script.get("state") or {}
    HITSTUN_F = int(st.get("hitstun_f", HITSTUN_F))
    DODGE_IFRAME = tuple(st.get("dodge_iframe_f", DODGE_IFRAME))
    DODGE_LOCK_F = int(st.get("dodge_lock_f", DODGE_LOCK_F))
    PARRY_LOCK_F = int(st.get("parry_lock_f", PARRY_LOCK_F))
    PARRY_CD_F = int(st.get("parry_cd_f", PARRY_CD_F))
    pun = (script.get("punish") or [{}])[0]
    PUNISH_MIN_GAP = int(pun.get("min_gap_f", PUNISH_MIN_GAP))
    PUNISH_DELAY = int(pun.get("press_delay_f", PUNISH_DELAY))
    acts = {a.get("name"): int(a.get("min_gap_f", 0)) for a in pun.get("actions") or [] if a.get("name")}
    if acts:
        PUNISH_ACTIONS = acts


def load_names() -> dict[int, str]:
    table = read_json(MOVETABLE, {}) or {}
    out = {}
    for name, ent in (table.get("groups") or {}).items():
        out[int(ent.get("gid", len(out)))] = str(name)
    return out


def load_round(rn: str, names: dict[int, str]) -> dict | None:
    d = LIVE / rn
    if not (d / "contacts.json").exists():
        return None
    con = read_json(d / "contacts.json", {}) or {}
    truth = sorted(con.get("truth") or [], key=lambda t: float(t["frame"]))
    if not truth:
        return {"round": rn, "truth": [], "skip": "empty truth"}
    res = (read_json(d / "result.json", {}) or {}).get("value") or {}
    args = read_json(d / "args.json", {}) or {}
    rec = (d / "rec.txt").read_text(encoding="utf-8").strip() if (d / "rec.txt").exists() else ""
    meta = read_json(LIVE / "meta" / f"{rec}.json", {}) or {}
    if res.get("start") is None or meta.get("started") is None:
        return {"round": rn, "truth": truth, "skip": "no start/meta"}
    offset = float(con.get("offset") or 0)
    k0_frame = (float(res["start"]) - float(meta["started"])) / FRAME_MS
    base = res.get("t0") if res.get("t0") is not None else res["start"]
    k0_fight = (float(base) - float(meta["started"])) / FRAME_MS
    video_end = k0_fight + float(res.get("fightMs") or 0) / FRAME_MS + offset
    tr = read_json(d / "trace.json", []) or []
    trace = []
    if tr:
        cols = tr[0].get("cols") or []
        ix = {c: i for i, c in enumerate(cols)}
        rows = [r for chunk in tr for r in chunk.get("rows") or []]
        for r in rows:
            try:
                gid = int(r[ix["grp"]])
                trace.append({
                    "f": k0_frame + float(r[ix["cap"]]) / FRAME_MS + offset,
                    "grp": names.get(gid, ""),
                    "p": float(r[ix["grpP"]]) if "grpP" in ix else 0.0,
                    "gold": float(r[ix["gold"]]) if "gold" in ix else 0.0,
                    "med": float(r[ix["med"]]) if "med" in ix else 0.0,
                    "qi": float(r[ix["qi"]]) if "qi" in ix else None,
                    "hp": float(r[ix["hp"]]) if "hp" in ix else None,
                })
            except (KeyError, TypeError, ValueError):
                continue
        trace.sort(key=lambda x: x["f"])
    presses = []
    for p in res.get("pressLog") or []:
        if not isinstance(p, (list, tuple)) or len(p) < 10:
            continue
        try:
            f = k0_frame + float(p[0]) / FRAME_MS + offset
            gid = int(p[2])
        except (TypeError, ValueError):
            continue
        presses.append({
            "f": f, "kind": str(p[1]), "gid": gid, "grp": names.get(gid, ""),
            "pgold": float(p[3]), "pdodge": float(p[4]), "pparry": float(p[5]),
            "med": float(p[6]), "remF": float(p[7]) if p[7] is not None else None,
            "lead": float(p[8]) if p[8] is not None else None, "src": str(p[9]),
        })
    presses.sort(key=lambda x: x["f"])
    return {"round": rn, "truth": truth, "res": res, "args": args, "offset": offset,
            "video_end": video_end, "trace": trace, "presses": presses, "skip": None}


def find_tell(trace: list[dict], opener_f: float, window_f: float = 90) -> dict | None:
    lo, hi = opener_f - window_f, opener_f + 2
    cand = [r for r in trace if lo <= r["f"] <= hi and r["grp"].startswith("k0:") and is_c11_name(r["grp"])]
    if not cand:
        return None
    best = None
    for i in range(len(cand) - 1):
        if (cand[i]["grp"] == cand[i + 1]["grp"] and cand[i]["p"] >= 0.5 and cand[i + 1]["p"] >= 0.5
                and abs(cand[i + 1]["f"] - cand[i]["f"]) <= 2.0):
            best = cand[i]
            break
    if best is None:
        solid = [r for r in cand if r["p"] >= 0.5]
        best = solid[0] if solid else cand[0]
    return {"f": round(best["f"], 2), "grp": best["grp"], "p": round(best["p"], 3)}


def state_intervals(contacts: list[dict], presses: list[dict]) -> list[tuple[float, float, str, str]]:
    """(from, to, state, src) intervals; priority is decided in state_at."""
    out = []
    for t in contacts:
        if t.get("kind") == "hit":
            f = float(t["frame"])
            out.append((f, f + HITSTUN_F, "hitstun", f"hit@{f:g}"))
    for p in presses:
        f = float(p["f"])
        if p["kind"] == "dodge":
            out.append((f + DODGE_IFRAME[0], f + DODGE_IFRAME[1], "dodge_iframe", f"dodge@{f:.1f}"))
            out.append((f, f + DODGE_LOCK_F, "dodge_lock", f"dodge@{f:.1f}"))
        elif p["kind"] == "parry":
            out.append((f, f + PARRY_LOCK_F, "parry_lock", f"parry@{f:.1f}"))
            out.append((f, f + PARRY_CD_F, "parry_cd", f"parry@{f:.1f}"))
    return out


PRIORITY = {"hitstun": 0, "dodge_iframe": 1, "parry_lock": 2, "dodge_lock": 3, "parry_cd": 4, "idle": 5}


def state_at(f: float, intervals: list[tuple[float, float, str, str]]) -> tuple[str, str | None]:
    best = ("idle", None)
    for a, b, s, src in intervals:
        if a <= f <= b and PRIORITY[s] < PRIORITY[best[0]]:
            best = (s, src)
    return best


def press_window(contact_f: float, presses: list[dict], key: str, lo: float = 0, hi: float = 45) -> list[dict]:
    out = []
    for p in presses:
        if p["kind"] != key:
            continue
        lead = contact_f - p["f"]
        if lo <= lead <= hi:
            out.append({"f": round(p["f"], 2), "lead": round(lead, 2), "src": p["src"],
                        "remF": round(p["remF"], 2) if p["remF"] is not None else None,
                        "grp": p["grp"]})
    return sorted(out, key=lambda x: x["lead"])


def classify_episode(ep: list[dict], all_truth: list[dict], presses: list[dict], trace: list[dict],
                     video_end: float, scope: str, round_name: str, args: dict,
                     allow_gold_parry: bool = False) -> dict:
    ep = sorted(ep, key=lambda t: float(t["frame"]))
    c11 = [t for t in ep if is_c11(t)]
    gold = next((t for t in c11 if str(t.get("colour")) == "gold"), None)
    first = ep[0]
    first_f = float(first["frame"])
    # a dodge press for the gold opener: the 33 k0-dodged episodes have one at 1.5-5 f predicted lead
    k0_press = None
    for p in presses:
        if p["kind"] != "dodge" or not p["grp"].startswith("k0:") or not is_c11_name(p["grp"]):
            continue
        if p["remF"] is None or not (1 <= p["remF"] <= 8):
            continue
        if first_f - 90 <= p["f"] <= first_f + 2:
            k0_press = p
    opener_f = float(gold["frame"]) if gold else (k0_press["f"] + float(k0_press["remF"]) if k0_press else first_f)
    tell = find_tell(trace, opener_f)
    intervals = state_intervals(all_truth, presses)
    # The script replaces the recorded policy's own opener dodge: an early / late dodge for this opener must not
    # block the script's planned press at t0 - 3 f (otherwise the c11Lead=14 rounds would look "locked" by the
    # very press the script is replacing).
    script_presses = [p for p in presses
                      if not (p["kind"] == "dodge" and p["grp"].startswith("k0:") and is_c11_name(p["grp"])
                              and opener_f - 20 <= float(p["f"]) <= opener_f + 2)]
    script_intervals = state_intervals(all_truth, script_presses)
    gold_kind = str(gold.get("kind")) if gold else None
    observed = "hit" if gold_kind == "hit" else ("ok" if gold_kind == "ok" else ("dodge" if k0_press else "absent"))
    # the script: dodge the gold opener at t0 - 3 f; if the opener was already absent, keep the dodge branch.
    script_press_f = None
    script_press_state = None
    if gold is not None:
        script_press_f = opener_f - 3.0
        script_press_state, script_press_src = state_at(script_press_f, script_intervals)
        blocked = script_press_state in ("hitstun", "parry_lock", "dodge_lock")
        if gold_kind == "ok":
            script = "ok" if allow_gold_parry else "dodge"
        elif blocked:
            script = "hit"
        else:
            script = "dodge"
    else:
        script = "dodge"
        script_press_state = "idle"
    # follow-ups: every contact after the gold opener (or all contacts when the opener was dodged)
    start_i = 0
    if gold is not None:
        start_i = ep.index(gold) + 1
    followups = ep[start_i:]
    last_hit = float(gold["frame"]) if gold is not None and gold_kind == "hit" else None
    rows = []
    k1_hits = k2_hits = k0_hits = follow_hits = oks = 0
    hitstun_hits = 0
    parry_k1 = parry_k2 = 0
    parry_ok_k1 = parry_ok_k2 = 0
    parry_leads_k1, parry_leads_k2 = [], []
    wasted = 0
    first_dodge = None
    for idx, t in enumerate(followups):
        f = float(t["frame"])
        k = k_of(t)
        kind = str(t.get("kind"))
        age = None if last_hit is None else f - last_hit
        st, src = state_at(f - 0.01, intervals)  # the state just before the contact (a hit starts its own stun)
        pp = press_window(f, presses, "parry", lo=0, hi=30)  # a real pre-contact attempt, not a 40 f leftover
        dp = press_window(f, presses, "dodge", lo=0, hi=30)
        script_response = "parry" if script == "ok" else "none"
        if idx == 0 and script == "dodge" and gold is None:
            # User rule: the first no-light follow-up is dodge-only. The script skips the old policy's
            # parry/dodge presses in the gap, so evaluate the clean second dodge at f0 - 4.
            df = f - 4.0
            gap_presses = [p for p in presses
                           if not (p["kind"] in ("parry", "dodge") and opener_f + 5 <= p["f"] <= f - 1)]
            dodge_intervals = state_intervals(all_truth, gap_presses)
            dst, dsrc = state_at(df, dodge_intervals)
            clean = dst in ("idle", "parry_cd")
            script_response = "dodge" if clean else "none"
            first_dodge = {"f": round(df, 2), "lead": 4.0, "state": dst, "state_src": dsrc,
                           "clean": clean, "response": script_response, "contact_k": k, "contact_kind": kind}
        if kind == "hit":
            follow_hits += 1
            if k == 0:
                k0_hits += 1
            elif k == 1:
                k1_hits += 1
            elif k == 2:
                k2_hits += 1
            if age is not None and age <= HITSTUN_F:
                hitstun_hits += 1
        elif kind == "ok":
            oks += 1
        if k == 1:
            parry_k1 += len(pp)
            parry_leads_k1 += [x["lead"] for x in pp]
            if kind == "ok":
                parry_ok_k1 += 1
        elif k == 2:
            parry_k2 += len(pp)
            parry_leads_k2 += [x["lead"] for x in pp]
            if kind == "ok":
                parry_ok_k2 += 1
        wasted += len(pp)
        rows.append({
            "i": ep.index(t), "f": round(f, 2), "gap": round(f - float(ep[ep.index(t) - 1]["frame"]), 2) if ep.index(t) else None,
            "k": k, "grp": grp_of(t), "colour": t.get("colour"), "kind": kind,
            "truth_resp": (t.get("dec") or {}).get("truth_resp"), "dec_resp": (t.get("dec") or {}).get("resp"),
            "hitstun_age_f": round(age, 2) if age is not None else None,
            "state_at_contact": st, "state_src": src,
            "parry_presses": pp, "dodge_presses": dp,
            "script_response": script_response,
            "first_dodge": first_dodge if idx == 0 else None,
            "script_ok": (kind == "ok") if script == "ok" else None,
        })
        if kind == "hit":
            last_hit = f
    first = rows[0] if rows else None
    first_followup_hits = 1 if first and first["kind"] == "hit" else 0
    first_followup_oks = 1 if first and first["kind"] == "ok" else 0
    first_dodge_applicable = gold is None  # the observed gold opener was not hit, so the after-dodge branch is real
    first_dodge_clean = (bool(first and first.get("first_dodge") and first["first_dodge"]["clean"])
                         if first_dodge_applicable else None)
    first_followup_avoided_script = first_dodge_clean
    last_end = float(ep[-1]["frame"])
    nxt = [float(t["frame"]) for t in all_truth if float(t["frame"]) > last_end]
    post_gap = max(0.0, (min(nxt) - last_end) if nxt else (video_end - last_end))
    punish_ready = last_end + HITSTUN_F
    punish_window = max(0.0, post_gap - PUNISH_DELAY)  # the script's first press is at end + 13
    qi = None
    for r in trace:
        if r["f"] >= last_end + PUNISH_DELAY:
            qi = r["qi"]
            break
    available = []
    for name, need in PUNISH_ACTIONS.items():
        if punish_window >= need and (name != "execute" or (qi is not None and qi <= 25)):
            available.append(name)
    action = None
    reason = ""
    for name in ("execute", "light", "follow"):
        if name in available:
            action = name
            reason = f"post_gap {post_gap:.0f} f, window {punish_window:.0f} f, qi {qi if qi is None else round(qi)}"
            break
    if action is None:
        reason = f"post_gap {post_gap:.0f} f, window {punish_window:.0f} f < min action window"
    return {
        "round": round_name, "scope": scope, "seqDefense": args.get("seqDefense"),
        "start": round(float(ep[0]["frame"]), 2), "end": round(last_end, 2), "n": len(ep),
        "groups": [grp_of(t) for t in ep], "colours": [t.get("colour") for t in ep],
        "kinds": [str(t.get("kind")) for t in ep],
        "gold": None if gold is None else {"f": round(float(gold["frame"]), 2), "kind": gold_kind,
                                           "colour": gold.get("colour")},
        "opener_f": round(opener_f, 2),
        "tell": tell, "tell_lead_f": None if tell is None else round(opener_f - tell["f"], 2),
        "k0_press": None if k0_press is None else {k: (round(v, 2) if isinstance(v, float) else v)
                                                   for k, v in k0_press.items()},
        "observed_branch": observed, "script_branch": script,
        "script_press_f": None if script_press_f is None else round(script_press_f, 2),
        "script_press_lead_f": None if script_press_f is None else 3.0,
        "script_press_state": script_press_state,
        "k0_avoided_observed": gold_kind != "hit",
        "k0_dodged_proven": gold is None and k0_press is not None,
        "k0_avoided_script": script == "dodge",
        "first_dodge": first.get("first_dodge") if first else None,
        "first_dodge_applicable": first_dodge_applicable,
        "first_dodge_clean": first_dodge_clean,
        "first_followup_hits": first_followup_hits,
        "first_followup_oks": first_followup_oks,
        "first_followup_avoided_script": first_followup_avoided_script,
        "followups": rows, "k0_hits": k0_hits, "k1_hits": k1_hits, "k2_hits": k2_hits,
        "followup_hits": follow_hits, "oks": oks, "hitstun_hits": hitstun_hits,
        "parry_k1": parry_k1, "parry_ok_k1": parry_ok_k1, "parry_leads_k1": sorted(parry_leads_k1),
        "parry_k2": parry_k2, "parry_ok_k2": parry_ok_k2, "parry_leads_k2": sorted(parry_leads_k2),
        "wasted_parry": wasted,
        "post_gap_f": round(post_gap, 2), "punish_ready_f": round(punish_ready, 2),
        "punish_window_f": round(punish_window, 2), "punish_available": available,
        "punish_action": action, "punish_reason": reason,
        "boss_qi_at_punish": qi,
    }


def summarize(rows: list[dict]) -> dict:
    if not rows:
        return {"episodes": 0, "beats": 0}
    k1 = [r["parry_leads_k1"] for r in rows]
    k2 = [r["parry_leads_k2"] for r in rows]
    leads1 = [x for v in k1 for x in v]
    leads2 = [x for v in k2 for x in v]
    post = [r["post_gap_f"] for r in rows]
    actions = collections.Counter(r["punish_action"] or "none" for r in rows)
    branches = collections.Counter(r["script_branch"] for r in rows)
    return {
        "episodes": len(rows), "beats": sum(r["n"] for r in rows),
        "gold_hits": sum(1 for r in rows if r["gold"] and r["gold"]["kind"] == "hit"),
        "gold_oks": sum(1 for r in rows if r["gold"] and r["gold"]["kind"] == "ok"),
        "k0_avoided_observed": sum(1 for r in rows if r["k0_avoided_observed"]),
        "k0_dodged_proven": sum(1 for r in rows if r["k0_dodged_proven"]),
        "k0_avoided_script": sum(1 for r in rows if r["k0_avoided_script"]),
        "k0_avoid_rate_observed": round(sum(1 for r in rows if r["k0_avoided_observed"]) / len(rows), 4),
        "k0_avoid_rate_script": round(sum(1 for r in rows if r["k0_avoided_script"]) / len(rows), 4),
        "first_dodge_applicable": sum(1 for r in rows if r["first_dodge_applicable"]),
        "first_dodge_clean": sum(1 for r in rows if r["first_dodge_clean"]),
        "first_dodge_blocked": sum(1 for r in rows if r["first_dodge_clean"] is False),
        "first_dodge_rate": round(sum(1 for r in rows if r["first_dodge_clean"])
                                  / max(1, sum(1 for r in rows if r["first_dodge_applicable"])), 4),
        "first_followup_hits": sum(r["first_followup_hits"] for r in rows),
        "first_followup_oks": sum(r["first_followup_oks"] for r in rows),
        "first_followup_avoided_script": sum(1 for r in rows if r["first_followup_avoided_script"]),
        "k0_hits": sum(r["k0_hits"] for r in rows),
        "k1_hits": sum(r["k1_hits"] for r in rows), "k2_hits": sum(r["k2_hits"] for r in rows),
        "k1_k2_hits": sum(r["k1_hits"] + r["k2_hits"] for r in rows),
        "followup_hits": sum(r["followup_hits"] for r in rows),
        "oks": sum(r["oks"] for r in rows),
        "hitstun_hits": sum(r["hitstun_hits"] for r in rows),
        "unactionable_hits": sum(r["followup_hits"] - r["hitstun_hits"] for r in rows),
        "parry_k1": sum(r["parry_k1"] for r in rows), "parry_ok_k1": sum(r["parry_ok_k1"] for r in rows),
        "parry_k2": sum(r["parry_k2"] for r in rows), "parry_ok_k2": sum(r["parry_ok_k2"] for r in rows),
        "parry_leads_k1": describe(leads1), "parry_leads_k2": describe(leads2),
        "parry_leads_k1_ge15": sum(1 for x in leads1 if x >= 15),
        "parry_leads_k1_ge17": sum(1 for x in leads1 if x >= 17),
        "wasted_parry": sum(r["wasted_parry"] for r in rows),
        "post_gap": describe(post),
        "post_gap_ge20": sum(1 for x in post if x >= 20),
        "post_gap_ge42": sum(1 for x in post if x >= 42),
        "post_gap_ge61": sum(1 for x in post if x >= 61),
        "punish_actions": dict(actions),
        "punish_available": dict(collections.Counter(x for r in rows for x in r.get("punish_available") or [])),
        "branches": dict(branches),
        "observed_branches": dict(collections.Counter(r["observed_branch"] for r in rows)),
        "tell": describe([r["tell_lead_f"] for r in rows if r["tell_lead_f"] is not None]),
    }


def verdict(core: dict, ext: dict, live: dict) -> dict:
    k1k2 = ext.get("k1_k2_hits", 0)
    first_clean = live.get("first_dodge_clean", 0)
    n = live.get("first_dodge_applicable", 0)
    reasons = [
        "User rule 2026-11-01: the first no-light follow-up after the gold opener is dodge-only; the old policy "
        "answered it with parry (135 k1 parry presses, 0 ok), so the 0 ok was the wrong response, not proof that "
        "the follow-up is unparryable.",
        f"{n} proven k0-dodged first-contact episodes (full live); the k0 dodge cooldown (gap 20-49 f) is over; "
        f"{first_clean}/{n} can schedule a clean second dodge at f0-4; the other {n - first_clean} are already in "
        "hitstun from a prior hit.",
        "The old policy pressed dodge on the first follow-up only 9 times: 7 were swallowed by an intervening "
        "parry, 2 were too late (0.5/2.4 f); it never gave the first follow-up a clean 2-5 f dodge.",
        "Later k1/k2: the user does not know; the offline counts still show their truth hits, and they must not "
        "be assumed parryable or dodgeable.",
    ]
    rec = ("PASS: k1/k2 are avoidable; only now consider runtime args.scriptDefense." if k1k2 == 0 else
           f"NOT fixed cost: the first follow-up is dodge-only; the script can schedule a clean second dodge in "
           f"{first_clean}/{n} proven k0-dodged episodes (counterfactual). The old 135 k1 parry 0 ok was the "
           "wrong response. Ask the user before a 2v2; do not write runtime yet; later k1/k2 are unknown.")
    return {
        "pass": k1k2 == 0,
        "k1_k2_hits": k1k2,
        "k1_k2_hits_core29": core.get("k1_k2_hits", 0),
        "first_dodge_clean": first_clean,
        "first_dodge_applicable": n,
        "first_dodge_rate": round(first_clean / max(1, n), 4),
        "mechanical_reasons": reasons,
        "recommendation": rec,
    }


def full_live_stats(names: dict[int, str]) -> dict:
    """All live rounds r001-r223: the k1 evidence used in the report (not only the 38/29 episodes)."""
    rounds = []
    for d in LIVE.glob("r[0-9]*"):
        try:
            n = int(d.name[1:])
        except ValueError:
            continue
        if n <= 223:
            rounds.append((n, d))
    rounds.sort()
    by_k = collections.Counter()
    leads1: list[float] = []
    parry1 = parry1_ok = 0
    k1_start = k1_start_hits = k0_proven = 0
    first_dodge_applicable = first_dodge_clean = 0
    gold_hits = gold_oks = 0
    used = 0
    for _, d in rounds:
        data = load_round(d.name, names)
        if data is None or data.get("skip"):
            continue
        used += 1
        truth = data["truth"]
        for t in truth:
            if not is_c11(t):
                continue
            k = k_of(t)
            by_k[(k, str(t.get("kind")))] += 1
            if k == 1:
                # use the contacts.json attached presses (up to 45 f before the contact), the same source as the
                # earlier 135-press count; the replay's per-episode rows use pressLog frames instead.
                for p in t.get("presses") or []:
                    if p.get("key") != "parry" or p.get("lead") is None:
                        continue
                    parry1 += 1
                    leads1.append(float(p["lead"]))
                    if t.get("kind") == "ok":
                        parry1_ok += 1
            if k == 0 and t.get("colour") == "gold":
                if t.get("kind") == "hit":
                    gold_hits += 1
                elif t.get("kind") == "ok":
                    gold_oks += 1
        for ep in cluster([t for t in truth if is_c11(t)], GAP_F):
            if not is_c11(ep[0]) or not grp_of(ep[0]).startswith("k1"):
                continue
            k1_start += 1
            if any(t.get("kind") == "hit" for t in ep):
                k1_start_hits += 1
            f0 = float(ep[0]["frame"])
            k0p = [p for p in data["presses"]
                   if p["kind"] == "dodge" and p["grp"].startswith("k0:") and is_c11_name(p["grp"])
                   and p["remF"] is not None and 1 <= p["remF"] <= 8 and f0 - 90 <= p["f"] <= f0 - 15]
            if k0p:
                k0_proven += 1
                first_dodge_applicable += 1
                prior_hit = any(t.get("kind") == "hit" and float(t["frame"]) < f0
                                and f0 - 4 - float(t["frame"]) <= HITSTUN_F for t in truth)
                if (f0 - max(p["f"] for p in k0p)) >= 15 and not prior_hit:
                    first_dodge_clean += 1
    return {"rounds": used, "c11_contacts_by_k_kind": {f"k{k}:{kind}": v for (k, kind), v in sorted(by_k.items())},
            "k1_parry_presses": parry1, "k1_parry_ok": parry1_ok, "k1_parry_leads": describe(leads1),
            "k1_parry_leads_ge15": sum(1 for x in leads1 if x >= 15),
            "k1_parry_leads_ge17": sum(1 for x in leads1 if x >= 17),
            "k1_start_episodes": k1_start, "k1_start_with_hit": k1_start_hits,
            "k0_dodge_proven": k0_proven, "k0_gold_hits": gold_hits, "k0_gold_oks": gold_oks,
            "first_dodge_applicable": first_dodge_applicable, "first_dodge_clean": first_dodge_clean}


def render_md(core: dict, ext: dict, rows: list[dict], ver: dict, live: dict) -> str:
    lines = ["# c11 branch-script offline replay", "",
             "Script: `workspaces/WhereWindsMeet/move_scripts/c11.json`. Data: `data/moveid/p1/live` "
             "r185-r223; 30 fps; no `s5_ab` / `s5_analyze` import.", "",
             f"- core29: **{core.get('episodes', 0)} episodes / {core.get('beats', 0)} beats** "
             f"(r185-r219, general episodes with a c11/c40 first contact).",
             f"- extended38: **{ext.get('episodes', 0)} episodes / {ext.get('beats', 0)} beats** "
             f"(r185-r223, c11-only clusters).", ""]
    for name, s in (("core29", core), ("extended38", ext)):
        lines += [f"## {name}", "",
                  "| metric | value |", "|---|---:|",
                  f"| episodes / beats | {s.get('episodes', 0)} / {s.get('beats', 0)} |",
                  f"| gold opener hit / ok | {s.get('gold_hits', 0)} / {s.get('gold_oks', 0)} |",
                  f"| k0 avoided observed / proven dodge / script | {s.get('k0_avoided_observed', 0)}/"
                  f"{s.get('episodes', 0)} ({100 * s.get('k0_avoid_rate_observed', 0):.1f}%) / "
                  f"{s.get('k0_dodged_proven', 0)} / {s.get('k0_avoided_script', 0)}/"
                  f"{s.get('episodes', 0)} ({100 * s.get('k0_avoid_rate_script', 0):.1f}%) |",
                  f"| k0 hits | {s.get('k0_hits', 0)} |",
                  f"| first follow-up dodge clean / applicable | {s.get('first_dodge_clean', 0)}/"
                  f"{s.get('first_dodge_applicable', 0)} ({100 * s.get('first_dodge_rate', 0):.1f}%) |",
                  f"| first follow-up hits / oks | {s.get('first_followup_hits', 0)} / {s.get('first_followup_oks', 0)} |",
                  f"| first follow-up avoided by script (counterfactual) | {s.get('first_followup_avoided_script', 0)} |",
                  f"| k1 hits / k2 hits | {s.get('k1_hits', 0)} / {s.get('k2_hits', 0)} |",
                  f"| k1+k2 hits | **{s.get('k1_k2_hits', 0)}** |",
                  f"| follow-up hits / oks | {s.get('followup_hits', 0)} / {s.get('oks', 0)} |",
                  f"| follow-up hits inside hitstun | {s.get('hitstun_hits', 0)} |",
                  f"| k1 parry presses / ok | {s.get('parry_k1', 0)} / {s.get('parry_ok_k1', 0)} |",
                  f"| k1 parry lead n/min/p25/med/p75/max | {s.get('parry_leads_k1', {}).get('n', 0)} / "
                  f"{s.get('parry_leads_k1', {}).get('min')} / {s.get('parry_leads_k1', {}).get('p25')} / "
                  f"{s.get('parry_leads_k1', {}).get('median')} / {s.get('parry_leads_k1', {}).get('p75')} / "
                  f"{s.get('parry_leads_k1', {}).get('max')} |",
                  f"| k1 leads >=15 / >=17 | {s.get('parry_leads_k1_ge15', 0)} / {s.get('parry_leads_k1_ge17', 0)} |",
                  f"| post-gap n/min/p25/med/p75/max | {s.get('post_gap', {}).get('n', 0)} / "
                  f"{s.get('post_gap', {}).get('min')} / {s.get('post_gap', {}).get('p25')} / "
                  f"{s.get('post_gap', {}).get('median')} / {s.get('post_gap', {}).get('p75')} / "
                  f"{s.get('post_gap', {}).get('max')} |",
                  f"| post-gap >=20 / >=42 / >=61 | {s.get('post_gap_ge20', 0)} / {s.get('post_gap_ge42', 0)} / "
                  f"{s.get('post_gap_ge61', 0)} |",
                  f"| punish actions (execute/light/follow/none) | {s.get('punish_actions', {})} |",
                  f"| punish available (execute/light/follow) | {s.get('punish_available', {})} |",
                  f"| observed branches (hit/dodge/ok/absent) | {s.get('observed_branches', {})} |",
                  f"| script branches (hit/dodge/ok/absent) | {s.get('branches', {})} |",
                  f"| tell lead n/min/p25/med/p75/max | {s.get('tell', {}).get('n', 0)} / "
                  f"{s.get('tell', {}).get('min')} / {s.get('tell', {}).get('p25')} / "
                  f"{s.get('tell', {}).get('median')} / {s.get('tell', {}).get('p75')} / "
                  f"{s.get('tell', {}).get('max')} |", ""]
    lines += ["## Full live set (r001-r223, branch evidence)", "",
              f"- rounds used: {live.get('rounds', 0)}; c11 contacts by k/kind: `{live.get('c11_contacts_by_k_kind', {})}`.",
              f"- k0 gold hits / oks: {live.get('k0_gold_hits', 0)} / {live.get('k0_gold_oks', 0)}.",
              f"- k1 parry presses / ok: {live.get('k1_parry_presses', 0)} / {live.get('k1_parry_ok', 0)}; "
              f"leads n/min/p25/med/p75/max = {live.get('k1_parry_leads', {}).get('n', 0)} / "
              f"{live.get('k1_parry_leads', {}).get('min')} / {live.get('k1_parry_leads', {}).get('p25')} / "
              f"{live.get('k1_parry_leads', {}).get('median')} / {live.get('k1_parry_leads', {}).get('p75')} / "
              f"{live.get('k1_parry_leads', {}).get('max')}; >=15 f: {live.get('k1_parry_leads_ge15', 0)}; "
              f">=17 f: {live.get('k1_parry_leads_ge17', 0)}.",
              f"- k1-start episodes: {live.get('k1_start_episodes', 0)}, with a hit: "
              f"{live.get('k1_start_with_hit', 0)}; separate k0:c11 dodge press at 1-8 f predicted lead: "
              f"{live.get('k0_dodge_proven', 0)}.",
              f"- first follow-up clean second dodge (f0-4, no prior hitstun): "
              f"{live.get('first_dodge_clean', 0)}/{live.get('first_dodge_applicable', 0)}.", ""]
    lines += ["## Verdict", "", f"- pass: **{ver['pass']}**; k1+k2 hits = **{ver['k1_k2_hits']}** "
              f"(core29 {ver['k1_k2_hits_core29']}).", f"- {ver['recommendation']}", ""]
    lines += ["Mechanical reasons:", ""] + [f"- {x}" for x in ver["mechanical_reasons"]] + [""]
    lines += ["## Per-episode rows (extended38)", "",
              "| round | start | n | gold observed | observed | script | script k0 dodge | first dodge clean | k1 | k2 | parry k1 | post gap | punish |",
              "|---|---:|---:|---|---|---|---|---|---:|---:|---:|---:|---|"]
    for r in rows:
        if r["scope"] != "extended":
            continue
        g = "-" if not r["gold"] else f"{r['gold']['kind']}@{r['gold']['f']:.0f}"
        fd = r.get("first_dodge") or {}
        fdc = "n/a" if not r.get("first_dodge_applicable") else ("yes" if fd.get("clean") else "no")
        lines.append(f"| {r['round']} | {r['start']:.0f} | {r['n']} | {g} | {r['observed_branch']} | "
                     f"{r['script_branch']} | {'yes' if r['k0_avoided_script'] else 'no'} | "
                     f"{fdc} | {r['k1_hits']} | "
                     f"{r['k2_hits']} | {r['parry_k1']} | {r['post_gap_f']:.0f} | {r['punish_action'] or '-'} |")
    lines += [""]
    return "\n".join(lines)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", nargs="*", default=None)
    ap.add_argument("--script", type=Path, default=DEFAULT_SCRIPT)
    ap.add_argument("--out-dir", type=Path, default=OUT_DIR)
    ap.add_argument("--allow-gold-parry", action="store_true",
                    help="diagnostic only: treat a gold contact as the after-parry branch; the teacher rule forbids it")
    a = ap.parse_args()
    script = read_json(a.script)
    if not script:
        raise SystemExit(f"script not found: {a.script}")
    configure(script)
    names = load_names()
    if a.rounds:
        rns = [x if str(x).startswith("r") else f"r{int(x):03d}" for x in a.rounds]
    else:
        rns = [f"r{i}" for i in range(185, 224)]
    rows: list[dict] = []
    used = []
    for rn in rns:
        data = load_round(rn, names)
        if data is None or data.get("skip"):
            continue
        used.append(rn)
        truth = data["truth"]
        general = cluster(truth, GAP_F)
        c11_general = [ep for ep in general if is_c11(ep[0])]
        c11_only = cluster([t for t in truth if is_c11(t)], GAP_F)
        n = int(rn[1:])
        if 185 <= n <= 219:
            for ep in c11_general:
                rows.append(classify_episode(ep, truth, data["presses"], data["trace"], data["video_end"],
                                             "core29", rn, data["args"], a.allow_gold_parry))
        for ep in c11_only:
            rows.append(classify_episode(ep, truth, data["presses"], data["trace"], data["video_end"],
                                         "extended", rn, data["args"], a.allow_gold_parry))
    core_rows = [r for r in rows if r["scope"] == "core29"]
    ext_rows = [r for r in rows if r["scope"] == "extended"]
    core = summarize(core_rows)
    ext = summarize(ext_rows)
    live = full_live_stats(names)
    ver = verdict(core, ext, live)
    out = {
        "meta": {"script": str(a.script), "rounds": used, "gap_f": GAP_F, "hitstun_f": HITSTUN_F,
                 "dodge_iframe": DODGE_IFRAME, "allow_gold_parry": a.allow_gold_parry,
                 "note": "offline replay only; runtime offense stays off"},
        "core29": core, "extended38": ext, "full_live": live, "verdict": ver,
        "episodes": rows,
    }
    a.out_dir.mkdir(parents=True, exist_ok=True)
    write_json(a.out_dir / "c11_replay.json", out)
    (a.out_dir / "c11_replay.md").write_text(render_md(core, ext, rows, ver, live), encoding="utf-8")
    print(f"rounds {len(used)}; core29 {core.get('episodes')} eps / {core.get('beats')} beats; "
          f"extended38 {ext.get('episodes')} eps / {ext.get('beats')} beats; "
          f"k0 avoided observed {ext.get('k0_avoided_observed')}/{ext.get('episodes')}, "
          f"script {ext.get('k0_avoided_script')}/{ext.get('episodes')}; "
          f"k1+k2 hits {ext.get('k1_k2_hits')} (core29 {core.get('k1_k2_hits')}); "
          f"first-followup dodge clean ext {ext.get('first_dodge_clean')}/{ext.get('first_dodge_applicable')}, "
          f"full-live {live.get('first_dodge_clean')}/{live.get('first_dodge_applicable')}; "
          f"k1 parry {ext.get('parry_k1')} / ok {ext.get('parry_ok_k1')}; "
          f"full-live k1 parry {live.get('k1_parry_presses')} / ok {live.get('k1_parry_ok')}; "
          f"punish {ext.get('punish_actions')}; pass {ver['pass']}")
    print(ver["recommendation"])


if __name__ == "__main__":
    main()
