"""Offense episodes: cluster the phase-1 truth contacts into beat chains and tabulate their rhythm.

    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/offense_episodes.py
    uv run python .../offense_episodes.py r185 r187 r190
    uv run python .../offense_episodes.py --from 185 --to 215

Phase-1 only: paths are fixed to data/moveid/p1 (MOVEID_PHASE is not consulted). Reads
data/moveid/p1/live/rNNN/{contacts,result,args}.json + rec.txt + live/meta/<rec>.json and the phase-1
model/dufu1/movetable.json. Writes data/moveid/offense/online/episodes.{json,md}. Contacts closer than GAP_F frames
belong to one episode. Every episode gets a per-beat table (gap, offset, group, response, attached presses) and two
greedy "actionable" simulations: phase-1 defaults (parry 10 / dodge 5) and the move table's leads.

Splits are by round, never by episode: rounds sorted by number, 0-based even positions -> train, odd -> val.
The c11 main table is the general-episode set with a c11/c40 first beat; c11-only clustering is a cross-check.
Q3 uses pressLog intended presses (predicted contact within +/-4 f of the beat), not the backfilled contact presses.
The report answers: (1) is the c11 chain a fixed beat grid? (2) was the first c11 dodge ever covered? (3) did c11
beats 2/3 ever get an ok? The JSON is the complete table; the markdown is the readable report.
"""
from __future__ import annotations

import argparse
import collections
import math
import re
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import FRAME_MS, REPO, read_json, write_json  # noqa: E402

PHASE = 1
LIVE = REPO / "data" / "moveid" / "p1" / "live"
MODEL = HERE.parents[1] / "model" / "dufu1" / "movetable.json"
OUT_DIR = REPO / "data" / "moveid" / "offense" / "online"
OUT_JSON = OUT_DIR / "episodes.json"
OUT_MD = OUT_DIR / "episodes.md"

GAP_F = 30
INTENDED_F = 4
DEFAULT_FROM, DEFAULT_TO = 185, 219
DEFAULT_LEAD = {"parry": 10.0, "dodge": 5.0}
COOLDOWN_F = {"parry": 7.0, "dodge": 15.0}
LEAD_BUCKETS = ("<=0", "0-2", "2-4", "4-6", "6-10", ">=10")
TABLE = None


def load_table() -> dict:
    """The phase-1 move table, cached. Groups keep insertion order = the press log's gid."""
    global TABLE
    if TABLE is None:
        TABLE = read_json(MODEL, {}) or {}
        groups = TABLE.get("groups") or {}
        size = max([int(v.get("gid", i)) for i, (_, v) in enumerate(groups.items())] + [-1]) + 1
        names = [""] * size
        for i, (name, ent) in enumerate(groups.items()):
            gid = int(ent.get("gid", i))
            if 0 <= gid < size:
                names[gid] = name
        TABLE["names"] = names
    return TABLE


def round_number(name: str) -> int:
    m = re.search(r"(\d+)", str(name))
    return int(m.group(1)) if m else 0


def round_names(names: list[str] | None, from_: int | None = None, to: int | None = None) -> list[str]:
    """CLI rounds -> rNNN, sorted by number. No names = the inclusive [from_, to] default range."""
    if names:
        out = [str(n).strip() if str(n).strip().startswith("r") else f"r{str(n).strip()}" for n in names]
    else:
        a = DEFAULT_FROM if from_ is None else int(from_)
        b = DEFAULT_TO if to is None else int(to)
        out = [f"r{i}" for i in range(a, b + 1)]
    return sorted(set(out), key=round_number)


def split_rounds(names: list[str]) -> dict:
    """Round-level split: 0-based even position -> train, odd -> val; never split inside a round."""
    order = sorted(names, key=round_number)
    train = [n for i, n in enumerate(order) if i % 2 == 0]
    val = [n for i, n in enumerate(order) if i % 2 == 1]
    assert not (set(train) & set(val)), "a round is in both splits"
    assert set(train) | set(val) == set(order), "split does not cover all rounds"
    return {"rule": "rounds sorted by number; 0-based even position -> train, odd -> val",
            "train": train, "val": val, "order": order, "round_to_split": {n: "train" for n in train} |
            {n: "val" for n in val}}


def grp_of(contact: dict) -> str:
    return str((contact.get("dec") or {}).get("grp") or "")


def is_c11(grp: str) -> bool:
    s = str(grp or "")
    return "c11" in s or "c40" in s


def parse_k(grp: str) -> int:
    """k0..k12 from a group label; -1 when the label has no k prefix."""
    m = re.match(r"^k(\d+)", str(grp or ""))
    if not m:
        return -1
    k = int(m.group(1))
    return k if 0 <= k <= 12 else -1


def prefix_of(beats: list[dict]) -> str:
    return ">".join(f"k{b['k']}" if b["k"] >= 0 else "k?" for b in beats)


def cluster_contacts(contacts: list[dict], gap_f: int = GAP_F) -> list[list[dict]]:
    """Split frame-sorted truth contacts into episodes; a gap <= gap_f stays in the same episode."""
    out: list[list[dict]] = []
    for c in sorted(contacts, key=lambda t: float(t["frame"])):
        f = float(c["frame"])
        if out and f - float(out[-1][-1]["frame"]) <= gap_f:
            out[-1].append(c)
        else:
            out.append([c])
    return out


def _num(value, nd: int = 2):
    """JSON-friendly number: integral floats -> int, others rounded."""
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return value
    if not math.isfinite(v):
        return None
    return int(v) if v.is_integer() else round(v, nd)


def _beat(contact: dict, i: int, prev_frame: float | None, start: float) -> dict:
    dec = contact.get("dec") or {}
    presses = [{"key": p.get("key"), "lead": _num(p.get("lead"))} for p in (contact.get("presses") or [])]
    frame = float(contact["frame"])
    return {
        "i": i,
        "frame": _num(frame),
        "gap": None if prev_frame is None else _num(frame - prev_frame),
        "off": _num(frame - start),
        "grp": grp_of(contact),
        "k": parse_k(grp_of(contact)),
        "kind": contact.get("kind"),
        "colour": contact.get("colour"),
        "truth_resp": dec.get("truth_resp"),
        "dec_resp": dec.get("resp"),
        "med": _num(dec.get("med")),
        "tte_err": _num(dec.get("tte_err")),
        "armed": dec.get("armed"),
        "fatal": dec.get("fatal"),
        "presses": presses,
        "press_keys": [p["key"] for p in presses],
        "press_leads": [p["lead"] for p in presses],
    }


def _lead_for(beat: dict, mode: str, table: dict | None) -> float | None:
    resp = beat.get("truth_resp")
    if resp not in DEFAULT_LEAD:
        return None
    if mode == "default":
        return DEFAULT_LEAD[resp]
    ent = ((table or {}).get("groups") or {}).get(str(beat.get("grp") or ""))
    if ent:
        value = ent.get("parry_lead" if resp == "parry" else "dodge_lead")
        if isinstance(value, (int, float)):
            return float(value)
    return DEFAULT_LEAD[resp]


def simulate_actionable(beats: list[dict], mode: str = "default", table: dict | None = None) -> dict:
    """Greedy same-key cooldown check on ideal press frames p = contact - lead.

    A beat is schedulable when its response has a lead and p is at least the cooldown after the last schedulable
    press of the same key. Different keys are independent; no ordering constraint against the previous beat.
    """
    if mode == "table" and table is None:
        table = load_table()
    last: dict[str, float] = {}
    flags = []
    for b in beats:
        resp = b.get("truth_resp")
        lead = _lead_for(b, mode, table)
        ok = False
        if lead is not None:
            p = float(b["frame"]) - lead
            cd = COOLDOWN_F[resp]
            if resp not in last or p - last[resp] >= cd:
                last[resp] = p
                ok = True
        flags.append(ok)
    return {"covered": int(sum(flags)), "flags": flags, "total": len(beats)}


def intended_for_beat(frame: float, presses: list[dict], tol: int = INTENDED_F) -> list[dict]:
    """Press-log rows whose predicted contact (press_frame + remF) is within +/- tol frames of this beat."""
    out = []
    for p in presses or []:
        pred = p.get("pred")
        if pred is None and p.get("frame") is not None and p.get("remF") is not None:
            pred = float(p["frame"]) + float(p["remF"])
        if pred is None or p.get("frame") is None:
            continue
        if abs(float(pred) - float(frame)) > tol:
            continue
        out.append({"key": p.get("key") or p.get("kind"), "group": p.get("group", ""), "remF": _num(p.get("remF")),
                    "actual_lead": _num(float(frame) - float(p["frame"])), "configured_lead": _num(p.get("lead")),
                    "pred": _num(pred), "press_frame": _num(p.get("frame")), "src": p.get("src")})
    return sorted(out, key=lambda x: (x["press_frame"] is None, x["press_frame"] or 0))


def build_episodes(round_name: str, truth: list[dict], split: str, result: dict | None,
                   table: dict | None, video_end_f: float | None = None,
                   presses: list[dict] | None = None) -> list[dict]:
    """One round's truth contacts -> episode rows with per-beat data, intended presses and actionable simulations."""
    out = []
    for chunk in cluster_contacts(truth):
        start, end = float(chunk[0]["frame"]), float(chunk[-1]["frame"])
        beats = []
        prev = None
        for i, contact in enumerate(chunk):
            b = _beat(contact, i, prev, start)
            b["intended"] = intended_for_beat(float(contact["frame"]), presses or [])
            b["intended_keys"] = [p["key"] for p in b["intended"]]
            b["intended_leads"] = [p["actual_lead"] for p in b["intended"]]
            beats.append(b)
            prev = float(contact["frame"])
        ep = {"round": round_name, "split": split, "start": _num(start), "end": _num(end),
              "n": len(beats), "first_grp": beats[0]["grp"], "prefix": prefix_of(beats), "beats": beats}
        ep["actionable"] = {m: {k: v for k, v in simulate_actionable(beats, m, table).items() if k != "total"}
                            for m in ("default", "table")}
        out.append(ep)
    for i, ep in enumerate(out):
        ep["pre_gap_f"] = None if i == 0 else _num(float(ep["start"]) - float(out[i - 1]["end"]))
        if i + 1 < len(out):
            ep["post_gap_f"] = _num(float(out[i + 1]["start"]) - float(ep["end"]))
        else:
            ep["post_gap_f"] = None if video_end_f is None else _num(max(0.0, float(video_end_f) - float(ep["end"])))
    return out


def quantile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    s = sorted(float(v) for v in values)
    x = (len(s) - 1) * p
    lo = int(math.floor(x))
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (x - lo)


def describe(values: list[float], digits: int = 2) -> dict:
    """n / min / p25 / median / p75 / max for a list (empty -> n=0 and nulls)."""
    vals = [float(v) for v in values if v is not None]
    if not vals:
        return {"n": 0, "min": None, "p25": None, "median": None, "p75": None, "max": None}
    return {"n": len(vals), "min": _num(min(vals), digits), "p25": _num(quantile(vals, 0.25), digits),
            "median": _num(statistics.median(vals), digits), "p75": _num(quantile(vals, 0.75), digits),
            "max": _num(max(vals), digits)}


def hist_int(values: list[float]) -> dict:
    c = collections.Counter(int(round(float(v))) for v in values if v is not None)
    return {str(k): c[k] for k in sorted(c)}


def lead_bucket(value: float) -> str:
    v = float(value)
    if v <= 0:
        return "<=0"
    if v < 2:
        return "0-2"
    if v < 4:
        return "2-4"
    if v < 6:
        return "4-6"
    if v < 10:
        return "6-10"
    return ">=10"


def bucket_counts(values: list[float]) -> dict:
    c = collections.Counter(lead_bucket(float(v)) for v in values if v is not None)
    return {name: c[name] for name in LEAD_BUCKETS}


def _resp_counts(beats: list[dict], key: str) -> dict:
    c = collections.Counter()
    for b in beats:
        v = b.get(key)
        c["none" if v in (None, "", "none") else str(v)] += 1
    for k in ("parry", "dodge", "none"):
        c.setdefault(k, 0)
    return dict(sorted(c.items()))


def _kind_counts(beats: list[dict]) -> dict:
    c = collections.Counter(str(b.get("kind")) for b in beats)
    hit, ok = c.get("hit", 0), c.get("ok", 0)
    return {"hit": hit, "ok": ok, "ok_rate": round(ok / (hit + ok), 4) if hit + ok else None}


def _press_block(beats: list[dict]) -> dict:
    keys = collections.Counter(k for b in beats for k in b.get("press_keys") or [])
    leads = [x for b in beats for x in b.get("press_leads") or [] if x is not None]
    by_key = {}
    for key in sorted(keys):
        by_key[key] = describe([p["lead"] for b in beats for p in b.get("presses") or []
                                if p.get("key") == key and p.get("lead") is not None])
    return {"keys": dict(keys), "leads": describe(leads), "leads_by_key": by_key}


def _intended_block(beats: list[dict]) -> dict:
    """Intended press-log presses attached to these beats; actual_lead = beat frame - press frame."""
    items = [p for b in beats for p in b.get("intended") or []]
    keys = collections.Counter(str(p.get("key")) for p in items)
    leads = [p["actual_lead"] for p in items if p.get("actual_lead") is not None]
    rem = [p["remF"] for p in items if p.get("remF") is not None]
    cfg = [p["configured_lead"] for p in items if p.get("configured_lead") is not None]
    by_key = {}
    for key in sorted(keys):
        sub = [p for p in items if str(p.get("key")) == key]
        vals = [p["actual_lead"] for p in sub if p.get("actual_lead") is not None]
        by_key[key] = {"n": len(sub), "actual_leads": describe(vals), "actual_lead_buckets": bucket_counts(vals),
                       "remF": describe([p["remF"] for p in sub if p.get("remF") is not None]),
                       "configured_leads": describe([p["configured_lead"] for p in sub
                                                     if p.get("configured_lead") is not None])}
    return {"n": len(items), "keys": dict(keys), "actual_leads": describe(leads),
            "actual_lead_buckets": bucket_counts(leads), "remF": describe(rem),
            "configured_leads": describe(cfg), "by_key": by_key}


def _action_summary(episodes: list[dict], mode: str) -> dict:
    total = sum(ep["n"] for ep in episodes)
    covered = sum(ep["actionable"][mode]["covered"] for ep in episodes)
    dist = collections.Counter(ep["actionable"][mode]["covered"] for ep in episodes)
    whole = sum(ep["actionable"][mode]["covered"] == ep["n"] for ep in episodes)
    return {"covered": covered, "total": total, "rate": round(covered / total, 4) if total else None,
            "all_schedulable_episodes": whole,
            "episode_covered_hist": {str(k): dist[k] for k in sorted(dist)}}


def stats_for(episodes: list[dict]) -> dict:
    """Episode/beat table for one group or split: chain lengths, per-index gap/kind/response/press/actionable."""
    beats = [b for ep in episodes for b in ep["beats"]]
    max_i = max((ep["n"] for ep in episodes), default=0)
    per_index = []
    for i in range(max_i):
        xs = [b for b in beats if b["i"] == i]
        gaps = [b["gap"] for b in xs if b.get("gap") is not None]
        act = {}
        for mode in ("default", "table"):
            c = sum(1 for ep in episodes if i < ep["n"] and ep["actionable"][mode]["flags"][i])
            act[mode] = {"covered": c, "n": len(xs), "rate": round(c / len(xs), 4) if xs else None}
        per_index.append({"i": i, "n": len(xs), "gap": describe(gaps), "gap_hist": hist_int(gaps),
                          "kind": _kind_counts(xs), "truth_resp": _resp_counts(xs, "truth_resp"),
                          "dec_resp": _resp_counts(xs, "dec_resp"), "press": _press_block(xs),
                          "intended": _intended_block(xs), "actionable": act})
    chain = collections.Counter(ep["n"] for ep in episodes)
    all_gaps = [b["gap"] for b in beats if b.get("gap") is not None]
    return {"episodes": len(episodes), "beats": len(beats),
            "chain_len": {str(k): chain[k] for k in sorted(chain)},
            "gaps": describe(all_gaps), "gap_hist": hist_int(all_gaps),
            "kind": _kind_counts(beats),
            "truth_resp": _resp_counts(beats, "truth_resp"),
            "dec_resp": _resp_counts(beats, "dec_resp"),
            "per_index": per_index,
            "actionable": {m: _action_summary(episodes, m) for m in ("default", "table")}}


def grouped_stats(episodes: list[dict], key: str) -> dict:
    groups: dict[str, list[dict]] = collections.defaultdict(list)
    for ep in episodes:
        groups[str(ep.get(key) or "")].append(ep)
    return {name: stats_for(eps) for name, eps in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0]))}


def split_stats(episodes: list[dict]) -> dict:
    return {name: stats_for(episodes if name == "all" else [ep for ep in episodes if ep["split"] == name])
            for name in ("all", "train", "val")}


def table_set(episodes: list[dict], key: str) -> dict:
    """All groups in all three splits; a group absent from train/val gets an empty table instead of disappearing."""
    all_stats = grouped_stats(episodes, key)
    out = {"all": all_stats}
    for split in ("train", "val"):
        sub = grouped_stats([ep for ep in episodes if ep["split"] == split], key)
        out[split] = {name: sub.get(name, stats_for([])) for name in all_stats}
    return out


def _c11_view(ep: dict, source: str) -> dict:
    """A c11 report row: the general episode (or c11-only episode) plus explicit c11 fields."""
    return {"round": ep["round"], "split": ep["split"], "start": ep["start"], "end": ep["end"], "n": ep["n"],
            "first_grp": ep["first_grp"], "prefix": ep["prefix"], "beats": ep["beats"],
            "actionable": ep["actionable"], "pre_gap_f": ep.get("pre_gap_f"), "post_gap_f": ep.get("post_gap_f"),
            "source": source, "groups": [b["grp"] for b in ep["beats"]],
            "gaps": [b["gap"] for b in ep["beats"] if b["gap"] is not None],
            "offsets": [b["off"] for b in ep["beats"]], "kinds": [b["kind"] for b in ep["beats"]],
            "presses": [b["presses"] for b in ep["beats"]], "intended": [b["intended"] for b in ep["beats"]],
            "first_k": ep["beats"][0]["k"], "success": ep["beats"][0]["k"] > 0}


def load_round(name: str, split: str, table: dict) -> dict:
    """Read one round. Returns {skip} for missing contacts or empty truth (listed in the audit)."""
    d = LIVE / name
    contacts = read_json(d / "contacts.json")
    if not isinstance(contacts, dict):
        return {"round": name, "split": split, "skip": "contacts.json missing or unreadable"}
    truth = contacts.get("truth") or []
    if not truth:
        return {"round": name, "split": split, "skip": "truth is empty"}
    result = read_json(d / "result.json")
    res = (result or {}).get("value") or {}
    rec_file = d / "rec.txt"
    rid = rec_file.read_text(encoding="utf-8").strip() if rec_file.exists() else ""
    meta = read_json(LIVE / "meta" / f"{rid}.json") if rid else None
    offset_value = contacts.get("offset")
    offset = None if offset_value is None else float(offset_value)
    press_offset = 0.0 if offset is None else offset
    k0 = None
    if meta and res.get("start") is not None:
        k0 = (float(res["start"]) - float(meta["started"])) / FRAME_MS
    # fightMs is measured from result.t0 (after the prep phase), while pressLog times are start-relative.
    k0_fight, video_end_base = None, None
    if meta and res.get("start") is not None:
        base = res.get("t0") if res.get("t0") is not None else res["start"]
        k0_fight = (float(base) - float(meta["started"])) / FRAME_MS
        video_end_base = "t0" if res.get("t0") is not None else "start_fallback"
    video_end_f, post_gap_missing = None, None
    if k0 is None or k0_fight is None:
        post_gap_missing = "k0 missing"
    elif offset is None:
        post_gap_missing = "contacts.offset missing"
    elif res.get("fightMs") is None:
        post_gap_missing = "result.fightMs missing"
    else:
        video_end_f = k0_fight + float(res["fightMs"]) / FRAME_MS + offset
    presses = []
    for p in res.get("pressLog") or []:
        if not isinstance(p, (list, tuple)) or len(p) < 10:
            continue
        frame = None if k0 is None else k0 + float(p[0]) / FRAME_MS + press_offset
        gid = int(p[2]) if isinstance(p[2], (int, float)) else -1
        rem = p[7]
        pred = frame + float(rem) if frame is not None and rem is not None else None
        presses.append({"t": p[0], "kind": p[1], "gid": gid, "frame": _num(frame), "pred": _num(pred),
                        "remF": _num(rem), "lead": _num(p[8]), "src": p[9],
                        "group": table["names"][gid] if 0 <= gid < len(table["names"]) else ""})
    episodes = build_episodes(name, truth, split, res, table, video_end_f, presses)
    post_gap_clamped = bool(video_end_f is not None and episodes and video_end_f < float(episodes[-1]["end"]))
    c11_truth = [t for t in truth if is_c11(grp_of(t))]
    c11_eps = [_c11_view(ep, "general") for ep in episodes if is_c11(ep["first_grp"])]
    c11_any = [ep for ep in episodes if any(is_c11(b["grp"]) for b in ep["beats"])]
    c11_only = [_c11_view(ep, "c11_only") for ep in
                build_episodes(name, c11_truth, split, res, table, video_end_f, presses)] if c11_truth else []
    return {"round": name, "split": split, "rec": rid, "args": read_json(d / "args.json", {}) or {},
            "contacts": len(truth), "episodes": episodes, "c11_episodes": c11_eps,
            "c11_only_episodes": c11_only, "c11_any_episodes": len(c11_any),
            "c11_any_beats": sum(ep["n"] for ep in c11_any),
            "c11_contacts": len(c11_truth),
            "c11_truth": [{"frame": _num(t["frame"]), "kind": t.get("kind"), "grp": grp_of(t)} for t in c11_truth],
            "offset": _num(offset), "k0": _num(k0), "k0_fight": _num(k0_fight),
            "video_end_f": _num(video_end_f), "video_end_base": video_end_base,
            "post_gap_missing": post_gap_missing, "post_gap_clamped": post_gap_clamped,
            "last_post_gap_f": episodes[-1].get("post_gap_f") if episodes else None,
            "fight_f": _num(float(res["fightMs"]) / FRAME_MS) if res.get("fightMs") is not None else None,
            "presses": presses}


def audit_episodes(rounds: list[dict], splits: dict) -> dict:
    per_round, skipped, post_gap_missing = [], [], []
    for r in rounds:
        if r.get("skip"):
            skipped.append({"round": r["round"], "reason": r["skip"]})
            continue
        eps = r["episodes"]
        assigned = sum(ep["n"] for ep in eps)
        multi = [ep for ep in eps if ep["n"] > 1]
        if r.get("post_gap_missing"):
            post_gap_missing.append({"round": r["round"], "reason": r["post_gap_missing"]})
        per_round.append({"round": r["round"], "split": r["split"], "truth": r["contacts"], "assigned": assigned,
                          "episodes": len(eps), "multi_beat_episodes": len(multi),
                          "contacts_in_multi": sum(ep["n"] for ep in multi),
                          "c11_contacts": r["c11_contacts"], "c11_episodes": len(r["c11_episodes"]),
                          "c11_any_episodes": r["c11_any_episodes"], "c11_any_beats": r["c11_any_beats"],
                          "c11_only_episodes": len(r["c11_only_episodes"]),
                          "last_post_gap_f": r.get("last_post_gap_f"),
                          "post_gap_clamped": r.get("post_gap_clamped"),
                          "fight_s": round((r.get("fight_f") or 0) * FRAME_MS / 1000, 1)})
    total = sum(x["truth"] for x in per_round)
    assigned = sum(x["assigned"] for x in per_round)
    multi_contacts = sum(x["contacts_in_multi"] for x in per_round)
    multi_eps = sum(x["multi_beat_episodes"] for x in per_round)
    if assigned != total:
        raise AssertionError(f"contacts not fully assigned: {assigned}/{total}")
    return {"rounds_used": len(per_round), "rounds_total": len(rounds), "skipped": skipped,
            "contacts": total, "assigned": assigned, "assigned_rate": round(assigned / total, 4) if total else None,
            "multi_beat_episodes": multi_eps, "contacts_in_multi": multi_contacts,
            "contacts_in_multi_share": round(multi_contacts / total, 4) if total else None,
            "c11_contacts": sum(x["c11_contacts"] for x in per_round),
            "c11_episodes": sum(x["c11_episodes"] for x in per_round),
            "c11_any_episodes": sum(x["c11_any_episodes"] for x in per_round),
            "c11_any_beats": sum(x["c11_any_beats"] for x in per_round),
            "c11_only_episodes": sum(x["c11_only_episodes"] for x in per_round),
            "post_gap_missing": post_gap_missing,
            "post_gap_clamped": [{"round": x["round"]} for x in per_round if x["post_gap_clamped"]],
            "post_gap_null_last_episodes": sum(1 for x in per_round if x["last_post_gap_f"] is None),
            "split_overlap": bool(set(splits["train"]) & set(splits["val"])),
            "split_union_ok": set(splits["train"]) | set(splits["val"]) == set(splits["order"]),
            "split_rounds": {"train": len(splits["train"]), "val": len(splits["val"])},
            "per_round": per_round}


def _is_k0_c11(gid: int, table: dict) -> bool:
    names = table.get("names") or []
    if not (0 <= gid < len(names)):
        return False
    name = names[gid]
    return name.startswith("k0:") and ("c11" in name or "c40" in name)


def _close_dodges(round_row: dict, start: float, table: dict, window: int = 45) -> list[dict]:
    out = []
    for p in round_row.get("presses") or []:
        if p.get("kind") != "dodge" or p.get("src") not in ("gold", "resp") or p.get("frame") is None:
            continue
        if not _is_k0_c11(int(p.get("gid", -1)), table):
            continue
        delta = float(p["frame"]) - start
        if -window <= delta <= 0:
            out.append({"frame": p["frame"], "delta": _num(delta), "remF": p["remF"], "lead": p["lead"],
                        "src": p["src"], "group": p["group"], "within_30": delta >= -30})
    return sorted(out, key=lambda x: x["delta"])


def q2_episode_rows(episodes: list[dict], rounds_by_name: dict[str, dict], table: dict) -> tuple[list[dict], list[dict]]:
    """Episode-level success/failure; success = first beat is not k0 (k0 truth contact absent)."""
    success, failure = [], []
    for ep in episodes:
        r = rounds_by_name[ep["round"]]
        first = ep["beats"][0]
        first_dodge = [p["lead"] for p in first.get("presses") or [] if p.get("key") == "dodge"]
        dodges = _close_dodges(r, float(ep["start"]), table)
        chosen = next((d for d in reversed(dodges) if d["within_30"]), None)
        row = {"round": r["round"], "split": r["split"], "start": ep["start"], "n": ep["n"],
               "first_grp": ep["first_grp"], "first_k": ep["first_k"], "source": ep.get("source"),
               "first_dodge_leads": first_dodge, "dodges": dodges, "chosen": chosen}
        (success if ep["success"] else failure).append(row)
    return success, failure


def q2_press_level(rounds: list[dict], table: dict) -> dict:
    """Press-level k0:c11 dodge check: predicted contact = press frame + remF.

    real = a c11 truth contact 0-12 f after the prediction (then the nearest c11 truth is the actual k0);
    uncertain = no 0-12 contact but one 12-20 f after; everything else is a false positive.
    """
    events = []
    for r in rounds:
        if r.get("skip"):
            continue
        truth = r.get("c11_truth") or []
        for p in r.get("presses") or []:
            if p.get("kind") != "dodge" or not _is_k0_c11(int(p.get("gid", -1)), table):
                continue
            if p.get("frame") is None:
                continue
            pred = p.get("pred")
            if pred is None and p.get("remF") is not None:
                pred = float(p["frame"]) + float(p["remF"])
            if pred is None:
                continue
            pred = float(pred)
            real = [t for t in truth if 0 <= float(t["frame"]) - pred <= 12]
            unc = [t for t in truth if 12 < float(t["frame"]) - pred <= 20]
            match = min(truth, key=lambda t: abs(float(t["frame"]) - pred)) if truth else None
            if real:
                status = "real"
            elif unc:
                status = "uncertain"
            else:
                status = "false_positive"
            ev = {"round": r["round"], "split": r["split"], "press_frame": p["frame"], "pred_frame": _num(pred),
                  "remF": p["remF"], "lead": p["lead"], "src": p["src"], "group": p["group"], "status": status,
                  "truth_frame": _num(match["frame"]) if match else None,
                  "truth_grp": match["grp"] if match else None,
                  "truth_kind": match["kind"] if match else None,
                  "actual_lead": _num(float(match["frame"]) - float(p["frame"])) if match else None,
                  "pred_err": _num(float(match["frame"]) - pred) if match else None,
                  "no_c11_in_round": not truth}
            events.append(ev)
    real_events = [e for e in events if e["status"] == "real"]
    unc_events = [e for e in events if e["status"] == "uncertain"]
    fp = [e for e in events if e["status"] == "false_positive"]

    def side(rows: list[dict]) -> dict:
        actual = [e["actual_lead"] for e in rows if e["actual_lead"] is not None]
        rem = [e["remF"] for e in rows if e["remF"] is not None]
        cfg = [e["lead"] for e in rows if e["lead"] is not None]
        err = [e["pred_err"] for e in rows if e["pred_err"] is not None]
        return {"n": len(rows), "actual_lead": describe(actual), "actual_lead_buckets": bucket_counts(actual),
                "remF": describe(rem), "remF_buckets": bucket_counts(rem),
                "configured_lead": describe(cfg), "configured_lead_buckets": bucket_counts(cfg),
                "pred_err": describe(err),
                "kinds": dict(collections.Counter(str(e["truth_kind"]) for e in rows)),
                "groups": dict(collections.Counter(str(e["truth_grp"] or "").split(":")[0] for e in rows))}

    by_lead = {}
    for lead in sorted({str(e["lead"]) for e in real_events}):
        by_lead[lead] = side([e for e in real_events if str(e["lead"]) == lead])
    real_k0 = [e for e in real_events if str(e["truth_grp"] or "").startswith("k0:")]
    return {"n_presses": len(events), "real": len(real_events), "real_k0": len(real_k0),
            "uncertain": len(unc_events), "false_positive": len(fp),
            "false_positive_no_c11_round": sum(1 for e in fp if e["no_c11_in_round"]),
            "false_positive_c11_far": sum(1 for e in fp if not e["no_c11_in_round"]),
            "real_stats": side(real_events), "real_by_config_lead": by_lead,
            "real_events": real_events, "uncertain_events": unc_events,
            "rule": "real = c11 truth 0-12 f after press_frame+remF; uncertain = 12-20 f; else false positive"}


def _side_stats(rows: list[dict]) -> dict:
    first = [v for r in rows for v in r["first_dodge_leads"]]
    chosen = [r["chosen"] for r in rows if r["chosen"]]
    rem = [c["remF"] for c in chosen if c["remF"] is not None]
    lead = [c["lead"] for c in chosen if c["lead"] is not None]
    delta = [c["delta"] for c in chosen if c["delta"] is not None]
    return {"episodes": len(rows), "with_first_dodge": sum(1 for r in rows if r["first_dodge_leads"]),
            "first_dodge_leads": describe(first), "first_dodge_buckets": bucket_counts(first),
            "with_press_in_30": len(chosen), "press_remF": describe(rem), "press_remF_buckets": bucket_counts(rem),
            "press_lead": describe(lead), "press_lead_buckets": bucket_counts(lead),
            "press_delta": describe(delta), "press_delta_buckets": bucket_counts(delta),
            "sample_ok": len(rows) >= 5}


def _index_stats(episodes: list[dict], indices: tuple[int, ...]) -> dict:
    xs = [b for ep in episodes for b in ep["beats"] if b["i"] in indices]
    ok = [b for b in xs if b.get("kind") == "ok"]
    by_index = {}
    for i in indices:
        ys = [b for b in xs if b["i"] == i]
        by_index[str(i)] = {"n": len(ys), "kind": _kind_counts(ys), "truth_resp": _resp_counts(ys, "truth_resp"),
                            "dec_resp": _resp_counts(ys, "dec_resp"),
                            "intended": _intended_block(ys), "attached": _press_block(ys)}
    return {"n": len(xs), "kind": _kind_counts(xs),
            "intended": _intended_block(xs), "ok_intended": _intended_block(ok),
            "attached": _press_block(xs), "ok_attached": _press_block(ok),
            "by_index": by_index}


def _q1(c11_eps: list[dict]) -> dict:
    gaps = [b["gap"] for ep in c11_eps for b in ep["beats"] if b["gap"] is not None]
    offs = [b["off"] for ep in c11_eps for b in ep["beats"] if b["off"] is not None]
    per_round = []
    for rnd in sorted({ep["round"] for ep in c11_eps}, key=round_number):
        eps = [ep for ep in c11_eps if ep["round"] == rnd]
        gs = [g for ep in eps for g in ep["gaps"]]
        mode = None
        if gs:
            c = collections.Counter(int(round(g)) for g in gs)
            top = max(c.values())
            mode = min(k for k, v in c.items() if v == top)
        per_round.append({"round": rnd, "episodes": len(eps), "beats": sum(ep["n"] for ep in eps),
                          "gaps_n": len(gs), "median_gap": _num(statistics.median(gs)) if gs else None,
                          "mode_gap": mode, "min_gap": _num(min(gs)) if gs else None,
                          "max_gap": _num(max(gs)) if gs else None,
                          "distinct_gaps": sorted({int(round(g)) for g in gs}),
                          "mixed_4_6_9_13": any(4 <= g <= 6 for g in gs) and any(9 <= g <= 13 for g in gs)})
    bands = collections.Counter()
    for g in gaps:
        if 2 <= g <= 3:
            bands["2-3"] += 1
        elif 4 <= g <= 6:
            bands["4-6"] += 1
        elif 7 <= g <= 8:
            bands["7-8"] += 1
        elif 9 <= g <= 13:
            bands["9-13"] += 1
        else:
            bands[">=14"] += 1
    offsets = collections.Counter(int(round(x)) for x in offs)
    bins = collections.Counter(f"{int(x // 2) * 2}-{int(x // 2) * 2 + 1}" for x in offs)
    offset_by_index = {str(i): describe([b["off"] for ep in c11_eps for b in ep["beats"] if b["i"] == i])
                       for i in range(max((ep["n"] for ep in c11_eps), default=0))}
    patterns = collections.Counter(">".join(str(int(round(g))) for g in ep["gaps"]) for ep in c11_eps if ep["gaps"])
    return {"episodes": len(c11_eps), "beats": sum(ep["n"] for ep in c11_eps),
            "gap_hist": hist_int(gaps), "gap_quantiles": describe(gaps), "bands": {k: bands[k] for k in
                                                                                ("2-3", "4-6", "7-8", "9-13", ">=14")},
            "offset_hist": {str(k): offsets[k] for k in sorted(offsets)},
            "offset_bins": {k: bins[k] for k in sorted(bins, key=lambda s: int(s.split("-")[0]))},
            "offset_by_index": offset_by_index,
            "per_round": per_round, "patterns": dict(patterns),
            "rounds_with_gaps": sum(1 for r in per_round if r["gaps_n"]),
            "mixed_rounds": sum(1 for r in per_round if r["mixed_4_6_9_13"]),
            "mixed_episodes": sum(1 for ep in c11_eps
                                  if any(4 <= g <= 6 for g in ep["gaps"]) and any(9 <= g <= 13 for g in ep["gaps"])),
            "per_round_median_range": [min([r["median_gap"] for r in per_round if r["median_gap"] is not None], default=None),
                                       max([r["median_gap"] for r in per_round if r["median_gap"] is not None], default=None)]}


def _q2(c11_eps: list[dict], c11_only_eps: list[dict], rounds: list[dict], table: dict) -> dict:
    rounds_by_name = {r["round"]: r for r in rounds if not r.get("skip")}
    general_success, general_failure = q2_episode_rows(c11_eps, rounds_by_name, table)
    only_success, only_failure = q2_episode_rows(c11_only_eps, rounds_by_name, table)

    def level(success: list[dict], failure: list[dict]) -> dict:
        return {"success": _side_stats(success), "failure": _side_stats(failure),
                "success_rows": success, "failure_rows": failure,
                "success_near_window": [dict(d, round=r["round"]) for r in success
                                        for d in r.get("dodges") or [] if not d["within_30"]],
                "success_insufficient": len(success) < 5}

    return {"episode_level": {"general": level(general_success, general_failure),
                              "c11_only": level(only_success, only_failure)},
            "press_level": q2_press_level(rounds, table),
            "definition": "episode success = first beat is k1/k2 (k0 truth contact absent); "
                          "press-level real = c11 truth 0-12 f after press_frame+remF"}


def _q3(c11_eps: list[dict], all_eps: list[dict]) -> dict:
    return {"c11": _index_stats(c11_eps, (1, 2)), "all": _index_stats(all_eps, (1, 2)),
            "c11_by_split": {s: _index_stats([e for e in c11_eps if e["split"] == s], (1, 2))
                             for s in ("train", "val")},
            "all_by_split": {s: _index_stats([e for e in all_eps if e["split"] == s], (1, 2))
                             for s in ("train", "val")}}


def _c11_rows(c11_eps: list[dict]) -> list[dict]:
    rows = []
    for ep in sorted(c11_eps, key=lambda e: (round_number(e["round"]), float(e["start"]))):
        rows.append({"round": ep["round"], "split": ep["split"], "start": ep["start"], "n": ep["n"],
                     "source": ep.get("source", "general"), "groups": ep["groups"], "gaps": ep["gaps"],
                     "offsets": ep["offsets"], "kinds": ep["kinds"], "presses": ep["presses"],
                     "intended": ep["intended"], "actionable": ep["actionable"],
                     "first_k": ep["first_k"], "success": ep["success"]})
    return rows


def analyze(names: list[str] | None = None, from_: int | None = None, to: int | None = None) -> dict:
    table = load_table()
    names = round_names(names, from_, to)
    splits = split_rounds(names)
    rounds = [load_round(n, splits["round_to_split"][n], table) for n in names]
    used = [r for r in rounds if not r.get("skip")]
    episodes = [ep for r in used for ep in r["episodes"]]
    c11_eps = [ep for r in used for ep in r["c11_episodes"]]
    c11_only_eps = [ep for r in used for ep in r["c11_only_episodes"]]
    c11_any_eps = [ep for r in used for ep in r["episodes"] if any(is_c11(b["grp"]) for b in ep["beats"])]
    for ep in episodes:
        ep.setdefault("groups", [b["grp"] for b in ep["beats"]])
    audit = audit_episodes(rounds, splits)
    summary = split_stats(episodes)
    c11_summary = split_stats(c11_eps)
    c11_only_summary = split_stats(c11_only_eps)
    c11_any = {"episodes": len(c11_any_eps), "beats": sum(ep["n"] for ep in c11_any_eps),
               "by_split": {sp: {"episodes": sum(1 for ep in c11_any_eps if ep["split"] == sp),
                                 "beats": sum(ep["n"] for ep in c11_any_eps if ep["split"] == sp)}
                            for sp in ("train", "val")}}
    tables = {"by_first_grp": table_set(episodes, "first_grp"), "by_prefix": table_set(episodes, "prefix")}
    q1 = _q1(c11_eps)
    q1_only = _q1(c11_only_eps)
    q2 = _q2(c11_eps, c11_only_eps, used, table)
    q3 = _q3(c11_eps, episodes)
    q3_only = _q3(c11_only_eps, episodes)
    round_meta = []
    for r in rounds:
        if r.get("skip"):
            round_meta.append({"round": r["round"], "split": r["split"], "skip": r["skip"]})
            continue
        round_meta.append({"round": r["round"], "split": r["split"], "rec": r["rec"], "args": r["args"],
                           "contacts": r["contacts"], "episodes": len(r["episodes"]),
                           "c11_contacts": r["c11_contacts"], "c11_episodes": len(r["c11_episodes"]),
                           "c11_any_episodes": r["c11_any_episodes"], "c11_any_beats": r["c11_any_beats"],
                           "c11_only_episodes": len(r["c11_only_episodes"]),
                           "offset": r["offset"], "k0": r["k0"], "k0_fight": r.get("k0_fight"),
                           "video_end_f": r["video_end_f"], "video_end_base": r.get("video_end_base"),
                           "last_post_gap_f": r.get("last_post_gap_f"),
                           "post_gap_missing": r.get("post_gap_missing"), "fight_f": r["fight_f"]})
    out = {"meta": {"phase": PHASE, "live": str(LIVE.relative_to(REPO)).replace("\\", "/"),
                    "model": str(MODEL.relative_to(REPO)).replace("\\", "/"), "frame_ms": FRAME_MS,
                    "gap_f": GAP_F, "intended_f": INTENDED_F, "default_lead": DEFAULT_LEAD, "cooldown_f": COOLDOWN_F,
                    "press_lead_note": "contacts.json presses[].lead is contact frame - press frame (backfilled after "
                                       "the contact), not the actual press frame; intended[].actual_lead is beat frame "
                                       "- pressLog press frame",
                    "c11_main_rule": "general episodes whose first beat group contains c11/c40; all beats kept",
                    "split_rule": splits["rule"], "rounds": names},
           "splits": splits, "rounds": round_meta, "episodes": episodes,
           "c11_episodes": _c11_rows(c11_eps), "c11_only_episodes": _c11_rows(c11_only_eps),
           "summary": summary, "c11_summary": c11_summary, "c11_only_summary": c11_only_summary, "c11_any": c11_any,
           "tables": tables,
           "questions": {"q1_gap": q1, "q1_gap_c11_only": q1_only, "q2_first_dodge": q2,
                         "q3_second_third": q3, "q3_second_third_c11_only": q3_only},
           "audit": audit}
    return out


def _f(value, nd: int = 1) -> str:
    if value is None:
        return "—"
    return f"{float(value):.{nd}f}"


def _pct(value) -> str:
    return "—" if value is None else f"{100 * float(value):.1f}%"


def _hist(d: dict) -> str:
    return "{" + ", ".join(f"{k}:{v}" for k, v in d.items() if v) + "}"


def _q(d: dict) -> str:
    if not d or not d.get("n"):
        return "—"
    return f"{d['n']} / {_f(d['min'])} / {_f(d['p25'])} / {_f(d['median'])} / {_f(d['p75'])} / {_f(d['max'])}"


def _chain(d: dict) -> str:
    return "{" + ", ".join(f"{k}:{v}" for k, v in d.items()) + "}" if d else "{}"


def _presses(ps: list[dict]) -> str:
    return ", ".join(f"{p['key']}@{_f(p['lead'])}" for p in ps if p) or "—"


def _resp(d: dict) -> str:
    return "/".join(str(d.get(k, 0)) for k in ("parry", "dodge", "none"))


def _group_table(title: str, stats_all: dict, stats_train: dict, stats_val: dict,
                 detail_min: int = 5, max_detail: int = 60) -> list[str]:
    lines = [f"## {title}", "",
             "| 组 | episodes all/train/val | beats all/train/val | 链长 (all) | actionable default | 整链可排 |",
             "|---|---:|---:|---|---:|---:|"]
    for name, s in stats_all.items():
        tr, va = stats_train.get(name, {}), stats_val.get(name, {})
        lines.append(f"| `{name or '∅'}` | {s['episodes']}/{tr.get('episodes', 0)}/{va.get('episodes', 0)} | "
                     f"{s['beats']}/{tr.get('beats', 0)}/{va.get('beats', 0)} | {_chain(s['chain_len'])} | "
                     f"{s['actionable']['default']['covered']}/{s['actionable']['default']['total']} "
                     f"({_pct(s['actionable']['default']['rate'])}) | {s['actionable']['default']['all_schedulable_episodes']}/{s['episodes']} |")
    lines += ["", "> press keys/lead 统计的是按键条数（一拍可挂多条 press）；lead 是接触后回填值。", "",
              f"逐拍明细（all；episodes ≥ {detail_min} 的组，最多 {max_detail} 组；train/val 同结构见 JSON）：", ""]
    detail = [(n, s) for n, s in stats_all.items() if s["episodes"] >= detail_min][:max_detail]
    if not detail:
        lines += ["（没有达到明细阈值的组。）", ""]
    for name, s in detail:
        lines += [f"### `{name or '∅'}` — episodes {s['episodes']}，beats {s['beats']}，链长 {_chain(s['chain_len'])}", "",
                  "| i | n | gap n/min/p25/med/p75/max | gap 直方图 | hit/ok (ok%) | truth p/d/n | dec p/d/n | press keys | lead n/min/p25/med/p75/max | actionable a/b |",
                  "|---:|---:|---|---:|---:|---|---|---|---:|---:|"]
        for i, x in enumerate(s["per_index"]):
            a, b = x["actionable"]["default"], x["actionable"]["table"]
            lines.append(f"| {i} | {x['n']} | {_q(x['gap'])} | {_hist(x['gap_hist'])} | "
                         f"{x['kind']['hit']}/{x['kind']['ok']} ({_pct(x['kind']['ok_rate'])}) | {_resp(x['truth_resp'])} | "
                         f"{_resp(x['dec_resp'])} | {_hist(x['press']['keys'])} | {_q(x['press']['leads'])} | "
                         f"{a['covered']}/{a['n']} · {b['covered']}/{b['n']} |")
        lines.append("")
    return lines


def _intended_cell(ps: list[dict]) -> str:
    return ", ".join(f"{p.get('key')}@{_f(p.get('actual_lead'))}" for p in ps or []) or "—"


def _c11_md(data: dict) -> list[str]:
    q1 = data["questions"]["q1_gap"]
    q1o = data["questions"]["q1_gap_c11_only"]
    q2 = data["questions"]["q2_first_dodge"]
    q3 = data["questions"]["q3_second_third"]
    q3o = data["questions"]["q3_second_third_c11_only"]
    c11s, onlys, anyc = data["c11_summary"], data["c11_only_summary"], data["c11_any"]
    lines = ["## c11/c40 链表（主口径：全接触 episode）", "",
             f"主表口径：先按 `contacts.json['truth']` 全部接触、gap ≤ {GAP_F} 帧聚 episode，再筛"
             "**首拍 grp 含 c11/c40** 的 general episode；表内保留该 episode 的全部拍（含夹在中间的其它组），"
             f"共 **{c11s['all']['episodes']} 个 episode / {c11s['all']['beats']} 拍**。"
             f"任意一拍含 c11/c40 的 general episode 有 **{anyc['episodes']} 个 / {anyc['beats']} 拍**"
             f"（其中首拍 c11 {c11s['all']['episodes']} 个）。", "",
             "### episode 行（完整组名 / 逐拍）", "",
             "| # | round | split | source | start | n | groups | gaps | offsets | kinds | intended（按键级，逐拍） | attached（接触窗口回填） | a/b 可排 |",
             "|---:|---|---|---|---:|---:|---|---|---|---|---|---|---|"]
    for j, r in enumerate(data["c11_episodes"], 1):
        gs = " → ".join(r["groups"])
        it = " ; ".join(_intended_cell(x) for x in r["intended"])
        at = " ; ".join(_presses(x) for x in r["presses"])
        lines.append(f"| {j} | {r['round']} | {r['split']} | {r['source']} | {_f(r['start'])} | {r['n']} | {gs} | "
                     f"{str([int(x) for x in r['gaps']])} | {str([int(x) for x in r['offsets']])} | "
                     f"{''.join('H' if x == 'hit' else 'O' for x in r['kinds'])} | {it} | {at} | "
                     f"{r['actionable']['default']['covered']}/{r['n']} · {r['actionable']['table']['covered']}/{r['n']} |")
    lines += ["", "### gap / offset 分档", "",
              f"- 相邻 gap 直方图（帧→次数）：`{_hist(q1['gap_hist'])}`；n={q1['gap_quantiles']['n']}，"
              f"min/p25/med/p75/max = {_q(q1['gap_quantiles'])}",
              f"- 主要档位计数：`{q1['bands']}`",
              f"- 累计 offset 直方图（帧→次数）：`{_hist(q1['offset_hist'])}`",
              f"- 2 帧桶：`{q1['offset_bins']}`",
              "- 各拍 offset（n / min / p25 / med / p75 / max）：" + "；".join(
                  f"i{k} {_q(v)}" for k, v in q1["offset_by_index"].items()),
              f"- 每局中位/众数 gap：{len(q1['per_round'])} 局有 c11；有 gap 的局 {q1['rounds_with_gaps']}，"
              f"4–6 与 9–13 同局混档 {q1['mixed_rounds']} 局；单链内部混两档 {q1['mixed_episodes']}/{q1['episodes']} 条；"
              f"中位 gap 范围 {q1['per_round_median_range'][0]}–{q1['per_round_median_range'][1]} 帧", "",
              "| round | episodes | beats | gaps n | median | mode | min–max | distinct | 混档 4–6/9–13 |",
              "|---|---:|---:|---:|---:|---:|---|---:|---|"]
    for r in q1["per_round"]:
        lines.append(f"| {r['round']} | {r['episodes']} | {r['beats']} | {r['gaps_n']} | {_f(r['median_gap'])} | "
                     f"{r['mode_gap'] if r['mode_gap'] is not None else '—'} | {_f(r['min_gap'])}–{_f(r['max_gap'])} | "
                     f"{r['distinct_gaps']} | {'是' if r['mixed_4_6_9_13'] else '否'} |")
    lines += ["", "### 每拍 index（intended 为主）", "",
              f"intended 口径：pressLog 的预测接触帧 `press_frame + remF` 落在 `beat.frame ± {INTENDED_F}` 内；"
              "`actual_lead = beat.frame - press_frame`。attached 是 contacts.json 回填值（只作对照）。", "",
              "| i | n | gap n/min/p25/med/p75/max | gap 直方图 | kind hit/ok (ok%) | truth p/d/n | intended keys | intended actual lead n/min/p25/med/p75/max | attached keys（回填） | a/b 可排 |",
              "|---:|---:|---|---:|---:|---|---|---|---:|---:|"]
    s = c11s["all"]
    for i, x in enumerate(s["per_index"]):
        a, b = x["actionable"]["default"], x["actionable"]["table"]
        lines.append(f"| {i} | {x['n']} | {_q(x['gap'])} | {_hist(x['gap_hist'])} | "
                     f"{x['kind']['hit']}/{x['kind']['ok']} ({_pct(x['kind']['ok_rate'])}) | {_resp(x['truth_resp'])} | "
                     f"`{x['intended']['keys']}` | {_q(x['intended']['actual_leads'])} | "
                     f"`{x['press']['keys']}` | {a['covered']}/{a['n']} · {b['covered']}/{b['n']} |")
    lines += ["", f"主表可行动：**{s['actionable']['default']['covered']}/{s['actionable']['default']['total']} "
              f"({_pct(s['actionable']['default']['rate'])})**，整链全可排 **{s['actionable']['default']['all_schedulable_episodes']}/"
              f"{s['episodes']}**；表 lead 方案 {s['actionable']['table']['covered']}/{s['actionable']['table']['total']}，"
              f"整链 {s['actionable']['table']['all_schedulable_episodes']}/{s['episodes']}。"]
    for split in ("train", "val"):
        ss = c11s[split]
        lines += [f"- {split}：episodes {ss['episodes']}，beats {ss['beats']}，链长 {_chain(ss['chain_len'])}，"
                  f"可排 {ss['actionable']['default']['covered']}/{ss['actionable']['default']['total']}，"
                  f"整链 {ss['actionable']['default']['all_schedulable_episodes']}/{ss['episodes']}。"]
    lines += ["", "### c11-only 交叉核对", "",
              f"c11-only = 只取 c11/c40 接触后单独按 gap ≤ {GAP_F} 聚类（旧口径）。结果 {onlys['all']['episodes']} 个 episode / "
              f"{onlys['all']['beats']} 拍；与主表 {c11s['all']['episodes']}/{c11s['all']['beats']} 的差异来自"
              "“首拍不是 c11、但后面含 c11”的 general episode 被排除，以及 c11 之间夹了其它组。", "",
              f"- gap 直方图：`{_hist(q1o['gap_hist'])}`；bands `{q1o['bands']}`；offset 中位 "
              + "、".join(f"i{k}={_f(v['median'])}" for k, v in q1o["offset_by_index"].items()),
              f"- 链长 `{_chain(onlys['all']['chain_len'])}`；可排 {onlys['all']['actionable']['default']['covered']}/"
              f"{onlys['all']['actionable']['default']['total']}，整链 {onlys['all']['actionable']['default']['all_schedulable_episodes']}/"
              f"{onlys['all']['episodes']}；index 1/2 共 {q3o['c11']['n']} 拍，ok={q3o['c11']['kind']['ok']}。", "",
              "| i | n | kind hit/ok | intended keys | intended actual lead n/min/p25/med/p75/max | a/b 可排 |",
              "|---:|---:|---|---|---|---|"]
    for i, x in enumerate(onlys["all"]["per_index"]):
        a, b = x["actionable"]["default"], x["actionable"]["table"]
        lines.append(f"| {i} | {x['n']} | {x['kind']['hit']}/{x['kind']['ok']} | `{x['intended']['keys']}` | "
                     f"{_q(x['intended']['actual_leads'])} | {a['covered']}/{a['n']} · {b['covered']}/{b['n']} |")
    lines += ["", "### Q2 第一下 dodge（episode 级 + 按键级）", "",
              "**episode 级**：success = 首拍不是 k0；failure = 首拍 k0。", "",
              "| 口径 | episodes | success | failure | success 中 30f 内有 k0:c11 press | success 首拍 dodge lead |",
              "|---|---:|---:|---:|---:|---|"]
    for name, label in (("general", "main general"), ("c11_only", "c11-only")):
        x = q2["episode_level"][name]
        lines.append(f"| {label} | {x['success']['episodes'] + x['failure']['episodes']} | {x['success']['episodes']} | "
                     f"{x['failure']['episodes']} | {x['success']['with_press_in_30']} | "
                     f"{_q(x['success']['first_dodge_leads'])} |")
    lines += ["", "success 明细（c11-only 交叉核对，3 条都**没有**覆盖按键）："]
    for r in q2["episode_level"]["c11_only"]["success_rows"]:
        near = "；near " + ", ".join(f"{d['delta']:.1f}f/remF {_f(d['remF'])}" for d in r["dodges"]) if r["dodges"] else ""
        lines.append(f"- {r['round']} start {_f(r['start'])} n={r['n']}，首拍 dodge lead `{r['first_dodge_leads']}`，"
                     f"30f 内 chosen={'有' if r['chosen'] else '无'}{near}")
    qp = q2["press_level"]
    lines += ["", "**按键级**：pressLog 中 `kind=dodge` 且组名 `k0:*c11*` 的所有按键；"
              "pred = `press_frame + remF`。", "",
              f"- 总按键 **{qp['n_presses']}**：real **{qp['real']}**（其中 k0 真值 {qp['real_k0']}）、"
              f"uncertain **{qp['uncertain']}**、false positive **{qp['false_positive']}**"
              f"（该局无 c11 {qp['false_positive_no_c11_round']}、有 c11 但不在 20f 内 {qp['false_positive_c11_far']}）。"
              "real 的 actual lead 取离 pred 最近的 c11 真值（本数据 23 条全是 k0）；"
              "不是取 0–12f 窗口里的第一条。"]
    rs = qp["real_stats"]
    lines += [f"- real：actual lead n={rs['actual_lead']['n']}，min/p25/med/p75/max = {_q(rs['actual_lead'])}；"
              f"分桶 `{rs['actual_lead_buckets']}`；remF {_q(rs['remF'])}；配置 lead {_q(rs['configured_lead'])}。", "",
              "| real 子集 | n | actual lead n/med/p25/p75/min/max | remF n/med |",
              "|---|---:|---|---|"]
    for lead, x in qp["real_by_config_lead"].items():
        lines.append(f"| configured lead={lead} | {x['n']} | {_q(x['actual_lead'])} | {_q(x['remF'])} |")
    lines += [f"- uncertain：`{[(e['round'], e['actual_lead']) for e in qp['uncertain_events']]}`"
              f"（0–12f 无接触、12–20f 才有）。", "",
              "### Q3 链内第 2/3 拍（index 1/2）", "",
              f"主表 c11 index 1/2 共 **{q3['c11']['n']} 拍，ok={q3['c11']['kind']['ok']}（0%）**，全部 hit。", "",
              "| i | n | hit/ok | ok% | intended keys | intended actual lead n/min/p25/med/p75/max | attached keys / lead（回填） |",
              "|---:|---:|---:|---:|---|---|---|"]
    for i in ("1", "2"):
        x = q3["c11"]["by_index"][i]
        lines.append(f"| {i} | {x['n']} | {x['kind']['hit']}/{x['kind']['ok']} | {_pct(x['kind']['ok_rate'])} | "
                     f"`{x['intended']['keys']}` | {_q(x['intended']['actual_leads'])} | "
                     f"`{x['attached']['keys']}` / {_q(x['attached']['leads'])} |")
    lines += ["", "intended 分键（actual_lead）：", "",
              "| i | key | n | min/p25/med/p75/max |", "|---:|---|---:|---|"]
    for i in ("1", "2"):
        for key, x in q3["c11"]["by_index"][i]["intended"]["by_key"].items():
            lines.append(f"| {i} | {key} | {x['n']} | {_q(x['actual_leads'])} |")
    lines += ["", "| 对照 | n | ok | ok% | ok intended keys | ok intended lead | ok attached keys | ok attached lead |",
              "|---|---:|---:|---:|---|---|---|---|"]
    for i in ("1", "2"):
        a = q3["all"]["by_index"][i]
        lines.append(f"| all index {i} | {a['n']} | {a['kind']['ok']} | {_pct(a['kind']['ok_rate'])} | — | — | — | — |")
    lines += [f"| all index 1/2 | {q3['all']['n']} | {q3['all']['kind']['ok']} | {_pct(q3['all']['kind']['ok_rate'])} | "
              f"`{q3['all']['ok_intended']['keys']}` | {_q(q3['all']['ok_intended']['actual_leads'])} | "
              f"`{q3['all']['ok_attached']['keys']}` | {_q(q3['all']['ok_attached']['leads'])} |"]
    return lines

def render_md(data: dict) -> str:
    a = data["audit"]
    q1, q2, q3 = data["questions"]["q1_gap"], data["questions"]["q2_first_dodge"], data["questions"]["q3_second_third"]
    s = data["summary"]
    lines = ["# 独夫阶段一：真值接触 episode 与节拍表", "",
             f"- 数据：`{data['meta']['live']}/rNNN`（{a['rounds_used']} 局；默认窗口 r{DEFAULT_FROM}–r{DEFAULT_TO}）。",
             f"- 招式表：`{data['meta']['model']}`；帧率 30 fps（1 帧 = {FRAME_MS:.3f} ms），contact gap ≤ {GAP_F} 帧归同一 episode。",
             f"- 切分：{data['splits']['rule']}。train {len(data['splits']['train'])} 局，val {len(data['splits']['val'])} 局。",
             "- 分位数为线性插值；gap/offset 直方图按整数帧。末 episode 的视频结束帧 = "
             "`(result.t0 - meta.started)/FRAME_MS + fightMs/FRAME_MS + contacts.offset`"
             "（`fightMs` 是从 `result.t0` 起算的；缺 `t0` 才回退 `start`，缺 k0/offset 给 null）。"
             "`post_gap = max(0, 结束帧 - end)`。",
             f"- train：{', '.join(data['splits']['train'])}",
             f"- val：{', '.join(data['splits']['val'])}",
             f"- 复算：`uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/offense_episodes.py`。", ""]
    used = {r["round"] for r in a["per_round"]}
    if {"r185", "r219"} <= used:
        base = [r for r in a["per_round"] if round_number(r["round"]) <= 215]
        lines += [f"> 口径说明：任务背景写的是“31 局”，实际 `r185–r219` 是 **{len(used)} 局**；"
                  f"`r185–r215` 才正好 31 局，其 c11/c40 真值接触 **{sum(r['c11_contacts'] for r in base)}** 个"
                  f"（全量 {a['contacts']} 个接触中是 {sum(r['c11_contacts'] for r in a['per_round'])} 个）。"
                  f"要复算 31 局版本用 `--to 215`。", ""]
    if a["skipped"]:
        lines += ["**跳过（不静默）**：" + "；".join(f"`{x['round']}` {x['reason']}" for x in a["skipped"]), ""]
    lines += ["## 审计", "",
              f"- 真值接触 **{a['contacts']}**，分配 **{a['assigned']}/{a['contacts']} = {a['assigned_rate']:.3f}**（硬断言）。",
              f"- episode **{s['all']['episodes']}**，拍 **{s['all']['beats']}**；多拍 episode **{a['multi_beat_episodes']}**，"
              f"其中接触 **{a['contacts_in_multi']}**（占全部 **{_pct(a['contacts_in_multi_share'])}**）。",
              f"- split 无重叠：{not a['split_overlap']}；并集完整：{a['split_union_ok']}；"
              f"train/val = {a['split_rounds']['train']}/{a['split_rounds']['val']} 局。",
              f"- c11 主表：首拍 c11 的 general episode **{a['c11_episodes']}**；任意拍含 c11 **{a['c11_any_episodes']}**"
              f"（{a['c11_any_beats']} 拍）；c11-only 交叉核对 **{a['c11_only_episodes']}**。",
              f"- post_gap 缺失：**{len(a['post_gap_missing'])}** 局；末 episode 因结束帧早于最后一个接触而截 0 的："
              f"**{len(a['post_gap_clamped'])}** 局 {[x['round'] for x in a['post_gap_clamped']]}。", "",
              "| round | split | truth | assigned | episodes | multi | c11 contacts | c11 main eps | c11 any eps | c11-only eps | fight s |",
              "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for r in a["per_round"]:
        lines.append(f"| {r['round']} | {r['split']} | {r['truth']} | {r['assigned']} | {r['episodes']} | "
                     f"{r['multi_beat_episodes']} | {r['c11_contacts']} | {r['c11_episodes']} | {r['c11_any_episodes']} | "
                     f"{r['c11_only_episodes']} | {_f(r['fight_s'])} |")
    lines += ["", "## 三份总览（all / train / val）", "",
              "| set | episodes | beats | 链长 | kind hit/ok (ok%) | truth p/d/n | dec p/d/n | gap n/med | actionable a | actionable b | 整链可排 a/b |",
              "|---|---:|---:|---|---|---|---|---|---:|---:|---:|---:|"]
    for name in ("all", "train", "val"):
        x = s[name]
        lines.append(f"| {name} | {x['episodes']} | {x['beats']} | {_chain(x['chain_len'])} | "
                     f"{x['kind']['hit']}/{x['kind']['ok']} ({_pct(x['kind']['ok_rate'])}) | {_resp(x['truth_resp'])} | "
                     f"{_resp(x['dec_resp'])} | {x['gaps']['n']}/{_f(x['gaps']['median'])} | "
                     f"{x['actionable']['default']['covered']}/{x['actionable']['default']['total']} | "
                     f"{x['actionable']['table']['covered']}/{x['actionable']['table']['total']} | "
                     f"{x['actionable']['default']['all_schedulable_episodes']}/{x['episodes']} · "
                     f"{x['actionable']['table']['all_schedulable_episodes']}/{x['episodes']} |")
    lines += ["", "> press lead 是 contacts.json 回填的“接触 - 按键”帧数，不是实际按下时刻；实际按下时刻/remF 在 Q2。", ""]
    lines += _group_table("按 first_grp", data["tables"]["by_first_grp"]["all"],
                          data["tables"]["by_first_grp"]["train"], data["tables"]["by_first_grp"]["val"],
                          detail_min=10)
    lines += _group_table("按 prefix", data["tables"]["by_prefix"]["all"],
                          data["tables"]["by_prefix"]["train"], data["tables"]["by_prefix"]["val"],
                          detail_min=10, max_detail=25)
    lines += _c11_md(data)
    q2e = q2["episode_level"]
    qp = q2["press_level"]
    rs = qp["real_stats"]
    lines += ["", "## 结论", "",
              "### Q1 c11 链的 gap 是固定节拍还是随局变化？分几档？", "",
              f"按全接触 episode 主口径，c11/c40 首拍 episode 共 **{q1['episodes']} 个、{q1['beats']} 拍**。"
              f"相邻 gap 直方图 `{_hist(q1['gap_hist'])}`；两个主档是 **4–6 帧**（{q1['bands']['4-6']} 次）和 "
              f"**9–13 帧**（{q1['bands']['9-13']} 次），另有 7–8（{q1['bands']['7-8']}）、2–3（{q1['bands']['2-3']}）、"
              f"≥14（{q1['bands']['>=14']}）的尾巴。**不是单一固定 gap**：每局中位 gap 在 "
              f"{q1['per_round_median_range'][0]}–{q1['per_round_median_range'][1]} 帧之间；"
              f"{q1['rounds_with_gaps']} 个有 gap 的局里 {q1['mixed_rounds']} 个同局同时出现 4–6 与 9–13；"
              f"单条链内部混两档的有 {q1['mixed_episodes']}/{q1['episodes']} 条。"
              "但混档不是随机的：各拍累计 offset 中位数为 "
              f"i1={_f(q1['offset_by_index'].get('1', {}).get('median'))}、"
              f"i2={_f(q1['offset_by_index'].get('2', {}).get('median'))}、"
              f"i3={_f(q1['offset_by_index'].get('3', {}).get('median'))}、"
              f"i4={_f(q1['offset_by_index'].get('4', {}).get('median'))} 帧；"
              "3 拍链常呈 `9→6` / `10→5` / `11→4`（累计 15 帧左右），4 拍链第 4 拍常在 21–22 帧。"
              "所以固定的是链内累计节拍（约 9 / 15 / 21），不是每一段 gap；阶段 B 应按 index 查表。", "",
              "### Q2 第一下 dodge：success 与 failure 的 lead", "",
              f"- episode 级：**main general** {q2e['general']['success']['episodes'] + q2e['general']['failure']['episodes']} 个"
              f"（success {q2e['general']['success']['episodes']}、failure {q2e['general']['failure']['episodes']}），"
              f"success 中 30 帧内有 k0:c11 dodge 的 **{q2e['general']['success']['with_press_in_30']}** 条；"
              f"**c11-only** {q2e['c11_only']['success']['episodes'] + q2e['c11_only']['failure']['episodes']} 个"
              f"（success {q2e['c11_only']['success']['episodes']}、failure {q2e['c11_only']['failure']['episodes']}），"
              f"success 中 30 帧内有覆盖按键的 **{q2e['c11_only']['success']['with_press_in_30']}** 条。"
              f"这 3 个 k1 开头的 episode（r187 1040、r187 3247、r201 5696）都没有 k0:c11 cover，"
              "r201 只有一条 -33.0 帧的 near；它们更像 k0 没出/落空，不是闪避成功。**没有“k0 闪避成功”的证据。**",
              f"- 按键级：k0:c11 dodge press 共 **{qp['n_presses']}** 条 → real **{qp['real']}**、"
              f"uncertain **{qp['uncertain']}**、false positive **{qp['false_positive']}**"
              f"（该局无 c11 {qp['false_positive_no_c11_round']} 条、有 c11 但不在 20 帧内 {qp['false_positive_c11_far']} 条）。"
              f"real 的 actual lead（truth_frame - press_frame）n={rs['actual_lead']['n']}，"
              f"min/p25/med/p75/max = {_q(rs['actual_lead'])}，分桶 `{rs['actual_lead_buckets']}`；"
              f"remF n={rs['remF']['n']}，median={_f(rs['remF']['median'])}；配置 lead median={_f(rs['configured_lead']['median'])}。"
              "失败的第一下**不是没按**，而是按得太晚（默认 lead=5 子集 actual median "
              f"{_f(qp['real_by_config_lead'].get('5', {}).get('actual_lead', {}).get('median'))} 帧），"
              "或 c11Lead=14 太早（该子集 actual n/min/p25/med/p75/max = "
              f"{_q(qp['real_by_config_lead'].get('14', {}).get('actual_lead'))}）。", "",
              "### Q3 链内第 2/3 拍历史上有过 ok 吗？", "",
              f"- 全接触主口径 c11 index 1/2 共 **{q3['c11']['n']} 拍，ok={q3['c11']['kind']['ok']}（0%）**，全部 hit；"
              f"c11-only 交叉核对也是 **{data['questions']['q3_second_third_c11_only']['c11']['n']} 拍、0 ok**。"
              "intended 口径下："
              f"index 1 的 parry 尝试 n={q3['c11']['by_index']['1']['intended']['by_key'].get('parry', {}).get('n', 0)} "
              f"median={_f(q3['c11']['by_index']['1']['intended']['by_key'].get('parry', {}).get('actual_leads', {}).get('median'))} 帧，"
              f"index 2 的 dodge 尝试 n={q3['c11']['by_index']['2']['intended']['by_key'].get('dodge', {}).get('n', 0)} "
              f"median={_f(q3['c11']['by_index']['2']['intended']['by_key'].get('dodge', {}).get('actual_leads', {}).get('median'))} 帧；"
              "同 index 还混有另一键（i1 dodge 10 条、i2 parry 7 条）。"
              "所以不能笼统说“键就错了”：正确键的尝试存在，但中位只提前 0–0.4 帧，太晚；另一键有的偏早但键不对。",
              f"- 对照：全部 episode index 1 是 {q3['all']['by_index']['1']['kind']['ok']}/{q3['all']['by_index']['1']['n']} "
              f"ok = {_pct(q3['all']['by_index']['1']['kind']['ok_rate'])}，index 2 是 "
              f"{q3['all']['by_index']['2']['kind']['ok']}/{q3['all']['by_index']['2']['n']} ok = "
              f"{_pct(q3['all']['by_index']['2']['kind']['ok_rate'])}；ok 仍由 parry 支撑"
              f"（intended ok keys `{q3['all']['ok_intended']['keys']}`，intended actual lead median "
              f"{_f(q3['all']['ok_intended']['actual_leads']['median'])} 帧；attached 回填口径 median "
              f"{_f(q3['all']['ok_attached']['leads']['median'])} 帧）。", "",
              "> 统计口径：intended 是 pressLog 预测接触落在 beat ±4 帧内；actual_lead = beat.frame - press_frame。"
              "attached 是 contacts.json 的接触窗口回填值，二者不可混用。", ""]
    return "\n".join(lines)


def one_page(data: dict) -> str:
    a, s = data["audit"], data["summary"]["all"]
    q1, q2, q3 = data["questions"]["q1_gap"], data["questions"]["q2_first_dodge"], data["questions"]["q3_second_third"]
    c11 = data["c11_summary"]["all"]
    used = {r["round"] for r in a["per_round"]}
    note = ""
    if {"r185", "r219"} <= used:
        base = [r for r in a["per_round"] if round_number(r["round"]) <= 215]
        note = (f"note: r185-r219 is {len(used)} rounds; r185-r215 (31 rounds) has "
                f"{sum(r['c11_contacts'] for r in base)} c11 contacts (full range "
                f"{sum(r['c11_contacts'] for r in a['per_round'])}); use --to 215 for the 31-round view")
    lines = [
        f"rounds {a['rounds_used']} (train {a['split_rounds']['train']} / val {a['split_rounds']['val']}), "
        f"contacts {a['contacts']}, assigned {a['assigned']}/{a['contacts']} = {a['assigned_rate']:.3f}, "
        f"episodes {s['episodes']}, beats {s['beats']}, c11 main {c11['episodes']}/{c11['beats']} beats, "
        f"c11 any {a['c11_any_episodes']}/{a['c11_any_beats']}, c11-only {a['c11_only_episodes']}",
        note,
        f"multi-beat episodes {a['multi_beat_episodes']}, contacts in multi {a['contacts_in_multi']} "
        f"({_pct(a['contacts_in_multi_share'])}), skipped {len(a['skipped'])}",
        f"Q1 c11 gap hist {_hist(q1['gap_hist'])}; bands {q1['bands']}; per-round median "
        f"{'—' if q1['per_round_median_range'][0] is None else str(q1['per_round_median_range'][0]) + '–' + str(q1['per_round_median_range'][1])} f, "
        f"mixed {q1['mixed_rounds']}/{q1['rounds_with_gaps']} rounds, {q1['mixed_episodes']}/{q1['episodes']} chains",
        f"Q2 episode general success/failure {q2['episode_level']['general']['success']['episodes']}/"
        f"{q2['episode_level']['general']['failure']['episodes']} (success cover "
        f"{q2['episode_level']['general']['success']['with_press_in_30']}); c11-only "
        f"{q2['episode_level']['c11_only']['success']['episodes']}/"
        f"{q2['episode_level']['c11_only']['failure']['episodes']} (success cover "
        f"{q2['episode_level']['c11_only']['success']['with_press_in_30']})",
        f"Q2 press-level total {q2['press_level']['n_presses']}: real {q2['press_level']['real']}, "
        f"uncertain {q2['press_level']['uncertain']}, false-positive {q2['press_level']['false_positive']}; "
        f"real actual lead median {_f(q2['press_level']['real_stats']['actual_lead']['median'])} "
        f"(lead5 {_f(q2['press_level']['real_by_config_lead'].get('5', {}).get('actual_lead', {}).get('median'))}, "
        f"lead14 {_f(q2['press_level']['real_by_config_lead'].get('14', {}).get('actual_lead', {}).get('median'))})",
        f"Q3 c11 main index1/2 ok {q3['c11']['kind']['ok']}/{q3['c11']['n']} "
        f"(c11-only {data['questions']['q3_second_third_c11_only']['c11']['kind']['ok']}/"
        f"{data['questions']['q3_second_third_c11_only']['c11']['n']}); all index1 "
        f"{q3['all']['by_index']['1']['kind']['ok']}/{q3['all']['by_index']['1']['n']} "
        f"({_pct(q3['all']['by_index']['1']['kind']['ok_rate'])}), index2 "
        f"{q3['all']['by_index']['2']['kind']['ok']}/{q3['all']['by_index']['2']['n']} "
        f"({_pct(q3['all']['by_index']['2']['kind']['ok_rate'])}), intended ok lead median "
        f"{_f(q3['all']['ok_intended']['actual_leads']['median'])}",
        f"actionable default {s['actionable']['default']['covered']}/{s['actionable']['default']['total']} "
        f"({_pct(s['actionable']['default']['rate'])}), full chain {s['actionable']['default']['all_schedulable_episodes']}/"
        f"{s['episodes']}; table {s['actionable']['table']['covered']}/{s['actionable']['table']['total']}, "
        f"full chain {s['actionable']['table']['all_schedulable_episodes']}/{s['episodes']}",
        f"wrote {OUT_JSON.relative_to(REPO)} and {OUT_MD.relative_to(REPO)}",
    ]
    return "\n".join(x for x in lines if x)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("rounds", nargs="*", help="rNNN (default: r185-r219)")
    ap.add_argument("--from", dest="from_", type=int, help="first round number (inclusive)")
    ap.add_argument("--to", dest="to", type=int, help="last round number (inclusive)")
    a = ap.parse_args()
    if a.rounds and (a.from_ is not None or a.to is not None):
        ap.error("use positional rounds or --from/--to, not both")
    if a.from_ is not None and a.to is not None and a.from_ > a.to:
        ap.error("--from must be <= --to")
    data = analyze(a.rounds or None, a.from_, a.to)
    write_json(OUT_JSON, data)
    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    OUT_MD.write_text(render_md(data), encoding="utf-8")
    print(one_page(data))


if __name__ == "__main__":
    main()
