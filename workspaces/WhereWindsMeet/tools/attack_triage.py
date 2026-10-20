"""Offline per-contact triage for the 2026-10-20 attack evidence audit.

This is a *proxy* triage over the existing 466 detector contacts. It never
runs the game, a model, or a video decoder, and it never writes labels.json.
See ../docs/attack-triage-20261020.md and ../docs/attack-evidence-audit.md.

Usage (from the repository root):
    uv run python workspaces/WhereWindsMeet/tools/attack_triage.py
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import statistics
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import attack_audit as audit  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
AUDIT_OUT = ROOT / "data/attack_audit/20261020"
DEFAULT_OUT = ROOT / "data/attack_triage/20261020"
DEFAULT_DOC = ROOT / "workspaces/WhereWindsMeet/docs/attack-triage-20261020.md"
FPS = 30

HIT_CATEGORIES = (
    "E_MEASUREMENT",
    "A_PRESSED_WINDOW",
    "D_PRESSED_EARLY",
    "D_PRESSED_LATE",
    "C_BLOCKED",
    "C_BUSY",
    "B_NO_PRED",
    "B_PRED_NO_ACTION",
    "U_UNKNOWN",
)
OK_CATEGORIES = ("OK_CLEAN", "OK_CONFOUNDED", "OK_UNKNOWN")
ROUND_ORDER = (737, 738, 745, 733, 734)
PHASES = ("early", "middle", "late")


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def rnd(x, n=2):
    return None if x is None else round(float(x), n)


def event_ref(e):
    return {
        "event_index": e["event_index"],
        "frame": rnd(e["estimated_video_frame"]),
        "kind": e["kind"],
        "detail": e["detail"],
    }


def in_window(e, lo, hi):
    return lo <= e["estimated_video_frame"] <= hi


def parse_pred(detail):
    """Parse the compact periodic pred summary, retaining unknown fields as None."""
    if not detail:
        return {}
    out = {}
    m = re.search(r"S1\s+([0-9]+(?:\.[0-9]+)?)", detail)
    out["s1"] = float(m.group(1)) if m else None
    m = re.search(r"bin\s+(\d+)\(([^)]*)\)", detail)
    out["bin"] = int(m.group(1)) if m else None
    out["bin_range"] = m.group(2) if m else None
    m = re.search(r"c(-?\d+)\s+\+(-?\d+)f", detail)
    out["c"] = int(m.group(1)) if m else None
    out["lead_f"] = int(m.group(2)) if m else None
    m = re.search(r"def1\s+(\S+)", detail)
    out["def1"] = m.group(1) if m else None
    m = re.search(r"tell\s+(\S+)", detail)
    out["tell"] = m.group(1) if m else None
    return out


HIT_RE = re.compile(r"(\d+)%->(\d+)% \((\d+)/(\d+) dropped, (\d+) kept\)")
BOSS_PX_RE = re.compile(r"boss\s+\d+\s*->\s*\d+\s*\((-?\d+)\s*px\)")


def parse_hit(detail):
    m = HIT_RE.search(detail or "")
    if not m:
        return None
    return {
        "before": int(m.group(1)),
        "after": int(m.group(2)),
        "dropped": int(m.group(3)),
        "total": int(m.group(4)),
        "kept": int(m.group(5)),
        "dropped_text": f"{m.group(3)}/{m.group(4)}",
    }


def normalize_blocked(detail):
    d = (detail or "").lower()
    if "dodge cd" in d:
        return "dodge_cd"
    if "parry cd" in d:
        return "parry_cd"
    if "potion" in d:
        return "potion"
    if "stagger" in d:
        return "stagger"
    if "curtain" in d:
        return "curtain"
    if "weak" in d:
        return "weak"
    return detail or "unknown"


def busy_class(e):
    k, d = e["kind"], (e["detail"] or "")
    if k == "potion":
        return "potion"
    if k == "stagger":
        return "stagger"
    if k == "curtain":
        return "curtain"
    if k == "dodge" or (k == "press" and d.startswith("dodge")):
        return "dodge"
    if k in ("attack", "charge"):
        return "attack"
    if k == "off" and (d.startswith("act ") or d.startswith("release ")
                       or "charge deferred" in d or "coldCharge" in d):
        return "attack"
    if k == "weak" or "weak" in d.lower():
        return "weak"
    return None


BUSY_PRIORITY = ("potion", "stagger", "curtain", "dodge", "attack")


def busy_state(events, t):
    found = {}
    for e in events:
        if not in_window(e, t - 60, t):
            continue
        c = busy_class(e)
        if c:
            found[c] = e  # later wins within the same class
    state = next((c for c in BUSY_PRIORITY if c in found), "none")
    return {
        "state": state,
        "evidence": event_ref(found[state]) if state != "none" else None,
        "classes": {c: event_ref(e) for c, e in found.items()},
        "window": [t - 60, t],
    }


def output_evidence(e):
    """Player-output / charge evidence used only for ok confounding."""
    k, d = e["kind"], (e["detail"] or "")
    if k in ("attack", "charge"):
        return "attack_event"
    if k == "off":
        if d.startswith("act "):
            return "off_act"
        if d.startswith("release "):
            return "off_release"
        if "charge deferred" in d or "coldCharge" in d:
            return "charge"
        if d.startswith("result "):
            m = BOSS_PX_RE.search(d)
            if "hit within 1 s" in d or (m and int(m.group(1)) > 0):
                return "off_result_hit"
    return None


def find_press(c, events):
    """Locate the seq press in the event log and verify its lead."""
    p = c["seq_contact"].get("press")
    if not p:
        return None
    t = c["seq_contact"]["t"]
    action = (p.get("det") or "").split()[0]
    expected = t - p["lead"]
    candidates = [e for e in events if e["kind"] == "press" and (e["detail"] or "").startswith(action)]
    exact = [e for e in candidates if e["detail"] == p["det"]]
    pool = exact or candidates
    ev = min(pool, key=lambda e: abs(e["estimated_video_frame"] - expected)) if pool else None
    if ev is None:
        return {"seq": p, "event": None, "lead_event": None, "delta_f": None, "verified": False}
    lead_event = t - ev["estimated_video_frame"]
    return {"seq": p, "event": ev, "lead_event": rnd(lead_event), "delta_f": rnd(lead_event - p["lead"]),
            "verified": abs(lead_event - p["lead"]) <= 2.0, "exact_detail": ev["detail"] == p["det"]}


def pred_error(c, press, events, decision_proxy):
    """predicted_contact_frame_proxy - t, only for parry presses with c+Nf.

    When seq has no press, there is no "that press" to compare; we return null
    rather than borrowing an unrelated nearby press from decision_proxy.
    """
    t = c["seq_contact"]["t"]
    if not c["seq_contact"].get("press"):
        return None, "null_no_seq_press", None
    if press and press.get("event") is not None:
        ev = press["event"]
        if (ev["detail"] or "").startswith("parry") and ev.get("predicted_contact_frame_proxy") is not None:
            return rnd(ev["predicted_contact_frame_proxy"] - t, 2), "press_event", ev
    by_index = {e["event_index"]: e for e in events}
    for label, idx in (("decision_proxy_nearby_press", decision_proxy.get("nearby_press_event_index")),
                       ("decision_proxy_anchor", decision_proxy.get("anchor_event_index"))):
        ev = by_index.get(idx)
        if ev is not None and ev["kind"] == "press" and (ev["detail"] or "").startswith("parry") \
                and ev.get("predicted_contact_frame_proxy") is not None:
            return rnd(ev["predicted_contact_frame_proxy"] - t, 2), label, ev
    return None, "null_no_parry_press_proxy", None


def blocked_state(c, events):
    t = c["seq_contact"]["t"]
    raw = [e for e in events if e["kind"] == "blocked" and in_window(e, t - 30, t + 5)]
    by_reason = {}
    for e in sorted(raw, key=lambda x: x["estimated_video_frame"]):
        reason = normalize_blocked(e["detail"])
        if reason not in by_reason:
            by_reason[reason] = {
                "reason": reason,
                "event_index": e["event_index"],
                "frame": rnd(e["estimated_video_frame"]),
                "detail": e["detail"],
                "count": 0,
            }
        by_reason[reason]["count"] += 1
    n_before = sum(1 for e in raw if e["estimated_video_frame"] <= t)
    n_after = len(raw) - n_before
    return {
        "present": bool(raw),
        "n_raw": len(raw),
        "n_before_contact": n_before,
        "n_after_contact": n_after,
        "only_after_contact": bool(raw) and n_before == 0,
        "n_reasons": len(by_reason),
        "reasons": list(by_reason.values()),
        "events": [event_ref(e) for e in raw],
        "window": [t - 30, t + 5],
    }


def event_slot(detail):
    m = re.search(r"\bk(-?\d+)\b", detail or "")
    return m.group(1) if m else None


def press_blocked_state(press, blocked):
    """Only call a press blocked when a same-slot block sits at/just before it.

    A blocked event a few frames *after* a logged press is normally a retry of
    the next slot, not evidence that this press was blocked. Requiring the same
    k-slot avoids counting those retries (common on ok contacts) as C_BLOCKED.
    """
    if not press or press.get("event") is None or not blocked["present"]:
        return False, None
    ev = press["event"]
    action = (ev["detail"] or "").split()[0]
    slot = event_slot(ev["detail"])
    matches = [b for b in blocked["events"]
               if (b["detail"] or "").startswith(action)
               and (slot is None or event_slot(b["detail"]) in (None, slot))
               and -5 <= b["frame"] - ev["estimated_video_frame"] <= 1]
    return bool(matches), matches[0] if matches else None


def pred_state(c, events):
    t = c["seq_contact"]["t"]
    preds = [e for e in events if e["kind"] == "pred" and in_window(e, t - 30, t)]
    if not preds:
        return {"found": False, "n": 0, "window": [t - 30, t]}
    parsed = [(e, parse_pred(e["detail"])) for e in preds]
    # Highest S1 wins; latest pred breaks ties. The latest pred is also kept
    # so a high earlier S1 cannot hide the most recent rounded summary.
    chosen, chosen_p = max(parsed, key=lambda x: ((x[1].get("s1") if x[1].get("s1") is not None else -1),
                                                   x[0]["estimated_video_frame"]))
    latest, latest_p = max(parsed, key=lambda x: x[0]["estimated_video_frame"])
    return {
        "found": True,
        "n": len(preds),
        "window": [t - 30, t],
        "selection": "highest_S1_then_latest",
        "event_index": chosen["event_index"],
        "frame": rnd(chosen["estimated_video_frame"]),
        "gap_to_t_f": rnd(t - chosen["estimated_video_frame"]),
        "s1": chosen_p.get("s1"),
        "bin": chosen_p.get("bin"),
        "bin_range": chosen_p.get("bin_range"),
        "c": chosen_p.get("c"),
        "lead_f": chosen_p.get("lead_f"),
        "def1": chosen_p.get("def1"),
        "tell": chosen_p.get("tell"),
        "detail": chosen["detail"],
        "latest_event_index": latest["event_index"],
        "latest_frame": rnd(latest["estimated_video_frame"]),
        "latest_s1": latest_p.get("s1"),
        "latest_bin": latest_p.get("bin"),
        "latest_lead_f": latest_p.get("lead_f"),
    }


def runtime_hit_state(c, all_hits, parsed_hits):
    t = c["seq_contact"]["t"]
    near = [e for e in all_hits if in_window(e, t - 10, t + 10)]
    groups = []
    for e in near:
        p = parse_hit(e["detail"])
        if not p:
            continue
        key = (p["before"], p["after"])
        grouped = []
        for other, op in parsed_hits:
            if (op["before"], op["after"]) == key and abs(other["estimated_video_frame"] - e["estimated_video_frame"]) <= 60:
                grouped.append(other["event_index"])
        groups.append({
            "event_index": e["event_index"],
            "frame": rnd(e["estimated_video_frame"]),
            "before": p["before"],
            "after": p["after"],
            "dropped_text": p["dropped_text"],
            "kept": p["kept"],
            "detail": e["detail"],
            "same_before_after_60f_count": len(grouped),
            "same_before_after_60f_events": grouped,
        })
    repeats = max((g["same_before_after_60f_count"] for g in groups), default=0)
    return {
        "window": [t - 10, t + 10],
        "near_count": len(near),
        "repeats": repeats,
        "groups": groups,
        "dropped_texts": [g["dropped_text"] for g in groups],
        "note": "Runtime hit frames are feedback events, not contact frames; offline hit t = hp_drop.frame - 5.",
    }


def measurement_state(c, analysis_flags, runtime_hits):
    grey = c.get("feature_at_anchor", {}).get("grey")
    grey_flag = grey is not None and grey >= 0.85
    sample_flag = c["sample_id"] in analysis_flags
    repeat_flag = runtime_hits["repeats"] >= 3
    basis = []
    if grey_flag:
        basis.append("grey>=0.85")
    if sample_flag:
        basis.append("analysis.screen_state_quality_flags")
    if repeat_flag:
        basis.append("runtime_hit_repeat>=3")
    return {
        "flag": bool(basis),
        "grey": grey,
        "grey_flag": grey_flag,
        "sample_quality_flag": sample_flag,
        "runtime_repeat_flag": repeat_flag,
        "basis": basis,
        "note": "grey and quality flags are measurement warnings, not confirmed bad HP.",
    }


def press_usable_state(press, press_blocked, blocked, busy):
    if not press or press.get("event") is None:
        return False, "no_press_event"
    if press_blocked:
        return False, "press_blocked"
    if blocked["present"]:
        return False, "blocked_present"
    if busy["state"] != "none":
        return False, f"busy_{busy['state']}"
    return True, "usable"


def classify_hit(measurement, press, glow, press_blocked, blocked, busy, pred, press_usable):
    if measurement["flag"]:
        return "E_MEASUREMENT", "measurement: " + ", ".join(measurement["basis"])
    if press and glow is not None and 2 <= glow <= 12 and not blocked["present"] and busy["state"] == "none":
        return "A_PRESSED_WINDOW", f"press glow lead {glow:.2f}f in 2..12; no blocked; busy none"
    if press and glow is not None and glow > 12 and not press_blocked:
        return "D_PRESSED_EARLY", f"press glow lead {glow:.2f}f > 12"
    if press and glow is not None and glow < 2 and not press_blocked:
        return "D_PRESSED_LATE", f"press glow lead {glow:.2f}f < 2"
    if press_blocked:
        return "C_BLOCKED", "press matched a blocked " + str(blocked["reasons"][0]["reason"] if blocked["reasons"] else "event")
    if blocked["present"] and not press:
        return "C_BLOCKED", "blocked with no press: " + ",".join(r["reason"] for r in blocked["reasons"])
    if not press_usable and busy["state"] != "none":
        prefix = "press unusable" if press else "no press"
        return "C_BUSY", f"{prefix}; busy={busy['state']}"
    if not press and not pred["found"]:
        return "B_NO_PRED", "no press and no pred in [t-30,t]"
    if not press and pred["found"]:
        return "B_PRED_NO_ACTION", f"no press; pred S1={pred.get('s1')} at f{pred.get('frame')}"
    if press and glow is None:
        return "U_UNKNOWN", "press present but glow lead is null (button offset missing)"
    return "U_UNKNOWN", "no classification rule matched"


def classify_ok(c, events, press):
    t = c["seq_contact"]["t"]
    lo, hi = t - 60, t + 15
    evidence = []
    for e in events:
        if in_window(e, lo, hi):
            kind = output_evidence(e)
            if kind:
                evidence.append({**event_ref(e), "output_kind": kind})
    ok_near = [event_ref(e) for e in events if e["kind"] == "ok" and in_window(e, t - 10, t + 15)]
    if evidence:
        return "OK_CONFOUNDED", f"player output/charge in [{lo},{hi}] (n={len(evidence)})", {
            "window": [lo, hi], "output_events": evidence, "ok_events": ok_near}
    if press or ok_near:
        return "OK_CLEAN", "no player output/charge evidence in proxy window", {
            "window": [lo, hi], "output_events": [], "ok_events": ok_near}
    return "OK_UNKNOWN", "no press, no nearby ok event, no output evidence", {
        "window": [lo, hi], "output_events": [], "ok_events": ok_near}


def build_contact(c, round_data, outcome, sample_meta, analysis_flags):
    t = c["seq_contact"]["t"]
    events = round_data["events"]
    align = round_data["alignment"]
    press = find_press(c, events)
    press_ev = press["event"] if press else None
    blocked = blocked_state(c, events)
    busy = busy_state(events, t)
    pred = pred_state(c, events)
    press_blocked, press_blocked_ev = press_blocked_state(press, blocked)
    press_usable, press_usable_reason = press_usable_state(press, press_blocked, blocked, busy)
    parsed_hits = [(e, parse_hit(e["detail"])) for e in events if e["kind"] == "hit" and parse_hit(e["detail"])]
    runtime_hits = runtime_hit_state(c, [e for e in events if e["kind"] == "hit"], parsed_hits)
    measurement = measurement_state(c, analysis_flags, runtime_hits)
    perr, perr_source, perr_ev = pred_error(c, press, events, c["decision_proxy"])

    p = c["seq_contact"].get("press")
    press_lead = p["lead"] if p else None
    offset = align.get("button_glow", {}).get("offset_median_frames")
    if p and offset is not None:
        glow = rnd(press_lead - offset, 2)
        glow_status = "approximate_round_median_offset"
    else:
        glow = None
        glow_status = "null_missing_press_or_button_offset"

    press_dict = None
    if p:
        press_dict = {
            "det": p.get("det"),
            "lead_seq": press_lead,
            "event_index": press_ev["event_index"] if press_ev else None,
            "event_frame": rnd(press_ev["estimated_video_frame"]) if press_ev else None,
            "lead_event": press["lead_event"] if press else None,
            "lead_delta_f": press["delta_f"] if press else None,
            "verified_within_2f": press["verified"] if press else False,
            "exact_detail_match": press.get("exact_detail") if press else False,
            "blocked": press_blocked,
            "blocked_event": press_blocked_ev,
            "usable": press_usable,
            "usable_reason": press_usable_reason,
        }

    if c["seq_contact"]["type"] == "hit":
        category, reason = classify_hit(measurement, p, glow, press_blocked, blocked, busy, pred, press_usable)
        category_basis = "hit"
    else:
        category, reason, ok_ev = classify_ok(c, events, press_ev)
        category_basis = "ok"

    ambiguities = []
    if p and press_ev is None:
        ambiguities.append("press event not found in log")
    if p and glow is None:
        ambiguities.append("glow_lead_est null (press or per-round button offset missing)")
    if p and press and press["delta_f"] is not None and abs(press["delta_f"]) > 2:
        ambiguities.append(f"press lead mismatch {press['delta_f']}f")
    if not pred["found"]:
        ambiguities.append("no pred in [t-30,t]")
    if any(r["reason"] == "unknown" for r in blocked["reasons"]):
        ambiguities.append("unclassified blocked reason")
    if measurement["sample_quality_flag"] and not measurement["grey_flag"]:
        ambiguities.append("sample in quality flags but grey<0.85 at anchor")

    row = {
        "sample_id": c["sample_id"],
        "round": c["round"],
        "outcome": outcome,
        "phase": c["elapsed_phase"],
        "game_phase": c.get("game_phase", "unknown"),
        "t": t,
        "type": c["seq_contact"]["type"],
        "kind": c["seq_kind"],
        "damage": c["seq_contact"].get("hp_loss"),
        "hp_drop_frame": c["hp_drop"]["frame"] if c.get("hp_drop") else None,
        "press_lead": press_lead,
        "glow_lead_est": glow,
        "glow_status": glow_status,
        "button_glow_offset_median_frames": rnd(offset),
        "pred_error_f": perr,
        "pred_error_source": perr_source,
        "pred_error_event_index": perr_ev["event_index"] if perr_ev else None,
        "category": category,
        "category_reason": reason,
        "category_basis": category_basis,
        "blocked": blocked,
        "busy": busy,
        "press": press_dict,
        "pred": pred,
        "pred_s1": pred.get("s1"),
        "pred_bin": pred.get("bin"),
        "pred_lead_f": pred.get("lead_f"),
        "pred_def1": pred.get("def1"),
        "pred_tell": pred.get("tell"),
        "pred_found": pred["found"],
        "pred_status": "pred" if pred["found"] else "no_pred",
        "runtime_hit_feedback": runtime_hits,
        "runtime_hit_repeats": runtime_hits["repeats"],
        "measurement": measurement,
        "in_review_set": c["sample_id"] in sample_meta,
        "source_group": sample_meta.get(c["sample_id"], {}).get("source_group"),
        "selection_reason": sample_meta.get(c["sample_id"], {}).get("selection_reason"),
        "root_id": c.get("root_id"),
        "is_root": c.get("is_root"),
        "contact_index": c.get("contact_index"),
        "rec": c.get("rec"),
        "evidence": {
            "press_event": event_ref(press_ev) if press_ev else None,
            "pred_event": {
                "event_index": pred.get("event_index"),
                "frame": pred.get("frame"),
                "detail": pred.get("detail"),
            } if pred["found"] else None,
            "blocked_events": blocked["events"],
            "busy_event": busy["evidence"],
            "runtime_hit_events": runtime_hits["groups"],
            "hp_drop": c.get("hp_drop"),
            "feature_at_anchor": c.get("feature_at_anchor"),
        },
        "ambiguities": ambiguities,
    }
    if c["seq_contact"]["type"] == "ok":
        row["ok_evidence"] = ok_ev
    return row


def flatten(row):
    blocked = row["blocked"]
    busy = row["busy"]
    pred = row["pred"]
    runtime = row["runtime_hit_feedback"]
    measurement = row["measurement"]
    press = row.get("press") or {}
    return {
        "sample_id": row["sample_id"],
        "round": row["round"],
        "outcome": row["outcome"],
        "phase": row["phase"],
        "t": row["t"],
        "type": row["type"],
        "kind": row["kind"],
        "damage": row["damage"],
        "press_lead": row["press_lead"],
        "glow_lead_est": row["glow_lead_est"],
        "glow_status": row["glow_status"],
        "pred_error_f": row["pred_error_f"],
        "pred_error_source": row["pred_error_source"],
        "category": row["category"],
        "blocked_present": blocked["present"],
        "blocked_n_raw": blocked["n_raw"],
        "blocked_only_after_contact": blocked.get("only_after_contact"),
        "blocked_reasons": ";".join(r["reason"] for r in blocked["reasons"]),
        "blocked_frames": ";".join(str(r["frame"]) for r in blocked["reasons"]),
        "busy_state": busy["state"],
        "busy_event_index": (busy["evidence"] or {}).get("event_index"),
        "busy_frame": (busy["evidence"] or {}).get("frame"),
        "press_event_index": press.get("event_index"),
        "press_verified": press.get("verified_within_2f"),
        "press_blocked": press.get("blocked"),
        "pred_found": pred["found"],
        "pred_status": row["pred_status"],
        "pred_s1": pred.get("s1"),
        "pred_bin": pred.get("bin"),
        "pred_lead_f": pred.get("lead_f"),
        "pred_def1": pred.get("def1"),
        "pred_tell": pred.get("tell"),
        "runtime_hit_near": runtime["near_count"],
        "runtime_hit_repeats": runtime["repeats"],
        "runtime_hit_dropped": ";".join(runtime["dropped_texts"]),
        "measurement_flag": measurement["flag"],
        "measurement_basis": ";".join(measurement["basis"]),
        "in_review_set": row["in_review_set"],
        "source_group": row["source_group"],
        "ambiguities": ";".join(row["ambiguities"]),
    }


def write_csv(path, rows):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = list(flatten(rows[0]).keys())
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for row in rows:
            w.writerow(flatten(row))


def total_damage(rows):
    return round(sum((r["damage"] or 0) for r in rows), 6)


def median_damage(rows):
    xs = [r["damage"] for r in rows if r["damage"] is not None]
    return statistics.median(xs) if xs else 0.0


def category_counts(rows):
    return Counter(r["category"] for r in rows)


def md_table(headers, rows):
    out = ["| " + " | ".join(str(h) for h in headers) + " |",
           "|" + "|".join("---" for _ in headers) + "|"]
    for row in rows:
        out.append("| " + " | ".join(str(x) for x in row) + " |")
    return out


def matrix_rows(rows, cats, outcome):
    chosen_rounds = [k for k in ROUND_ORDER if any(r["round"] == k and r["outcome"] == outcome for r in rows)]
    cols = [(k, p) for k in chosen_rounds for p in PHASES]
    headers = ["category"] + [f"{k}/{p[:1]}" for k, p in cols] + ["total"]
    body = []
    for cat in cats:
        vals = [sum(1 for r in rows if r["category"] == cat and r["round"] == k and r["outcome"] == outcome
                    and r["phase"] == p) for k, p in cols]
        body.append([cat] + vals + [sum(vals)])
    totals = [sum(1 for r in rows if r["category"] in cats and r["outcome"] == outcome
                  and r["round"] == k and r["phase"] == p)
              for k, p in cols]
    body.append(["**total**"] + totals + [sum(totals)])
    return headers, body


def explain_row(r):
    cat = r["category"]
    if cat == "E_MEASUREMENT":
        return "灰屏/质量标记，HP 读数可疑，损伤不能当作真实招式伤害。"
    if cat == "A_PRESSED_WINDOW":
        return (f"按钮光窗口内已按（glow {r['glow_lead_est']}f）仍被命中；按了仍中，优先核查动作类型、"
                f"接触预测误差（{r['pred_error_f']}f）与 press 是否真正执行。")
    if cat == "D_PRESSED_EARLY":
        return f"按下偏早（glow {r['glow_lead_est']}f >12），可能提前触发/空放后被命中。"
    if cat == "D_PRESSED_LATE":
        return f"按下偏晚（glow {r['glow_lead_est']}f <2），可能已过窗口。"
    if cat == "C_BLOCKED":
        reasons = ",".join(x["reason"] for x in r["blocked"]["reasons"]) or "blocked"
        if r["blocked"].get("only_after_contact"):
            return (f"blocked（{reasons}）全部发生在接触后（+{r['blocked']['events'][0]['frame'] - r['t']:.2f}f 起），"
                    "不能解释本次命中；类别按任务窗口保留，需人工复核。")
        if r.get("press"):
            return f"该 contact 的 press 被同槽位 blocked 挡住（{reasons}），命令没有生效。"
        return f"接触前调度器记录 blocked（{reasons}），且没有 press；防守命令未发出或被资源/CD 挡住。"
    if cat == "C_BUSY":
        prefix = "press 存在但处于忙碌态，无法作为可用防守" if r.get("press") else "无 press，接触前处于忙碌态"
        return f"{prefix}（busy={r['busy']['state']}）；需区分喝药/硬直/幕布/闪避/出招。"
    if cat == "B_NO_PRED":
        return "无 press，且接触前 30f 无 pred；模型未报或未覆盖此接触。"
    if cat == "B_PRED_NO_ACTION":
        return f"无 press，但接触前有 pred（S1 {r['pred_s1']}，bin {r['pred_bin']}）；模型报了没动作。"
    if cat == "OK_CLEAN":
        return "未发现玩家输出/蓄力证据的成功候选；仍不能据此确认是明确卸劲。"
    if cat == "OK_CONFOUNDED":
        return "接触附近有玩家输出/蓄力，Boss 真气下降不能单独归因卸劲。"
    if cat == "OK_UNKNOWN":
        return "缺少 press、nearby ok 或输出证据，成功属性未知。"
    return "证据不足，未能归入上述代理类别。"


def review_selection(rows, target=14):
    """Choose 12-15 review-set rows; categories never appear in the sheet."""
    review_hits = [r for r in rows if r["type"] == "hit" and r["in_review_set"]]
    review_ok = [r for r in rows if r["type"] == "ok" and r["in_review_set"]]
    selected = []

    def take(pool, n):
        for r in sorted(pool, key=lambda x: (-(x["damage"] or 0), x["sample_id"])):
            if len(selected) >= target:
                return
            if n <= 0:
                return
            if r["sample_id"] in {x["sample_id"] for x in selected}:
                continue
            selected.append(r)
            n -= 1

    a_rows = [r for r in review_hits if r["category"] == "A_PRESSED_WINDOW"]
    take(a_rows, min(6, len(a_rows)))
    b_rows = [r for r in review_hits if r["category"] in ("B_NO_PRED", "B_PRED_NO_ACTION")]
    take(b_rows, 2)
    # Cover both C sub-mechanisms when the review set allows it.
    take([r for r in review_hits if r["category"] == "C_BLOCKED"], 1)
    take([r for r in review_hits if r["category"] == "C_BUSY"], 1)
    take([r for r in review_hits if r["category"] in ("C_BLOCKED", "C_BUSY")], 2 - sum(
        1 for r in selected if r["category"] in ("C_BLOCKED", "C_BUSY")))
    clean = [r for r in review_ok if r["category"] == "OK_CLEAN"]
    conf = [r for r in review_ok if r["category"] == "OK_CONFOUNDED"]
    take(clean, 1)
    take(conf, 1)
    # Fill with the highest-damage remaining pressed-window misses, then other hits.
    take([r for r in review_hits if r["category"] in ("D_PRESSED_EARLY", "D_PRESSED_LATE")],
         target - len(selected))
    take([r for r in review_hits if r["category"] != "E_MEASUREMENT"], target - len(selected))
    take(review_ok, target - len(selected))
    return selected[:target]


def write_summary(path, rows, meta):
    hits = [r for r in rows if r["type"] == "hit"]
    oks = [r for r in rows if r["type"] == "ok"]
    hc, oc = category_counts(hits), category_counts(oks)
    lines = [
        "# 466 候选接触逐击代理分诊",
        "",
        "> **这是代理分诊（proxy triage），不是人工确认，也不是因果结论。**",
        "> 分类只使用现有的 seq 接触、运行时事件、逐帧 HUD 特征与每轮按钮光中位偏移；",
        "> press 是调度器发送日志，不是游戏执行确认；pred 是周期性舍入摘要，不是逐帧模型真值；",
        "> glow_lead_est 用每轮 offset_median 折算，标为 approximate，不是逐事件真值。",
        "",
        f"- 生成工具：`workspaces/WhereWindsMeet/tools/attack_triage.py`",
        f"- 数据源：`data/attack_audit/20261020/{{population,samples,rounds,alignment,analysis}}.json` 与 `attack_audit.load_round()`",
        f"- 单位：maxHP 条比例（离线 HP 检测器读数）；`damage` 取 `seq_contact.hp_loss`。",
        "",
        "## 1. 对账",
        "",
    ]
    lines += md_table(["项目", "数值"], [
        ["population 候选接触", len(rows)],
        ["hit", len(hits)],
        ["ok", len(oks)],
        ["hit + ok", len(hits) + len(oks)],
        ["hit 分类计数和", sum(hc.values())],
        ["ok 分类计数和", sum(oc.values())],
        ["hit direct maxHP", f"{total_damage(hits):.6f}"],
        ["90 样本 in_review_set", sum(1 for r in rows if r["in_review_set"])],
        ["90 样本中 hit / ok", f"{sum(1 for r in hits if r['in_review_set'])} / {sum(1 for r in oks if r['in_review_set'])}"],
    ])
    lines += ["", "对账断言：`hit + ok == 466`，`sum(hit categories) == hit`，"
              "`in_review_set` 的 sample_id 集合与 `samples.json` 完全一致。", ""]

    lines += ["## 2. hit 分类计数", ""]
    lines += md_table(["category", "n", "direct maxHP", "占 hit 损伤", "中位 damage"],
                      [[c, hc.get(c, 0), f"{total_damage([r for r in hits if r['category'] == c]):.6f}",
                        f"{100 * total_damage([r for r in hits if r['category'] == c]) / total_damage(hits):.1f}%",
                        f"{median_damage([r for r in hits if r['category'] == c]):.3f}"]
                       for c in HIT_CATEGORIES] + [["**total**", len(hits), f"{total_damage(hits):.6f}", "100.0%", ""]])
    lines += ["", "口径：E 先于 A/D/C；A 要求 press、glow 2–12f、无 blocked、busy=none；"
              "D 只看 press 的 glow 偏离（blocked press 优先归 C_BLOCKED）；"
              "C_BLOCKED 是 press 被挡或无 press 且有 blocked；C_BUSY 是无可用 press 且 busy≠none；"
              "B 只在完全无 press 时使用。U 为其余。", "",
              "press 存在时，只有同 k-slot 且 blocked 紧邻在 press 前 5f 到后 1f 才算 C_BLOCKED；"
              "本轮 hit 没有满足该条件的 press。两条跨槽位 blocked 的 press 按 glow 归入 D_PRESSED_LATE，"
              "属于需要人工确认的边界。", ""]
    c_busy_rows = [r for r in hits if r["category"] == "C_BUSY"]
    c_blocked_rows = [r for r in hits if r["category"] == "C_BLOCKED"]
    lines += md_table(["子口径", "n", "说明"], [
        ["C_BUSY：完全无 press", sum(1 for r in c_busy_rows if not r.get("press")), "接触前 60f 处于 busy 状态"],
        ["C_BUSY：press 存在但 busy", sum(1 for r in c_busy_rows if r.get("press")), "命令存在，但同窗口 busy≠none，按“无可用 press”处理"],
        ["C_BLOCKED：无 press 且有 blocked", sum(1 for r in c_blocked_rows if not r.get("press")), "blocked 直接挡在接触前窗口"],
        ["C_BLOCKED：同槽位 press 被 blocked", sum(1 for r in c_blocked_rows if r.get("press")), "要求同 k-slot 且 blocked 在 press 前 5f 到后 1f"],
    ])
    lines.append("")

    lines += ["## 3. category × round × outcome × phase", "",
              "列名 `轮次/阶段首字母`（e=early, m=middle, l=late）。", ""]
    for outcome, label in (("dead", "dead 轮（737/738/745）"), ("cleared", "cleared 轮（733/734）")):
        headers, body = matrix_rows(rows, HIT_CATEGORIES, outcome)
        lines += [f"### {label}：hit", ""]
        lines += md_table(headers, body)
        lines.append("")
    headers, body = matrix_rows(rows, OK_CATEGORIES, "dead")
    lines += ["### dead 轮：ok", ""] + md_table(headers, body) + [""]
    headers, body = matrix_rows(rows, OK_CATEGORIES, "cleared")
    lines += ["### cleared 轮：ok", ""] + md_table(headers, body) + [""]

    lines += ["## 4. ok 分类", ""]
    lines += md_table(["category", "n", "占比", "说明"], [
        ["OK_CLEAN", oc.get("OK_CLEAN", 0), f"{100 * oc.get('OK_CLEAN', 0) / len(oks):.1f}%",
         "接触附近无玩家输出/蓄力证据（窗口 t−60..t+15）"],
        ["OK_CONFOUNDED", oc.get("OK_CONFOUNDED", 0), f"{100 * oc.get('OK_CONFOUNDED', 0) / len(oks):.1f}%",
         "窗口内有 off act/release/charge 或 result hit；Boss 真气下降不能单独归因卸劲"],
        ["OK_UNKNOWN", oc.get("OK_UNKNOWN", 0), f"{100 * oc.get('OK_UNKNOWN', 0) / len(oks):.1f}%",
         "无 press、无 nearby ok、无输出证据"],
    ])
    lines += ["", "ok 不是明确卸劲反馈：现有定义只要求真气阶跃 + 前 0–20f 卸势命令；"
              "玩家进攻也会降低 Boss 真气。OK_CLEAN 只是“附近未发现输出证据”，不是确认成功卸劲。", ""]

    lines += ["## 5. 90 个在审样本", ""]
    review = [r for r in rows if r["in_review_set"]]
    rc = category_counts(review)
    lines += md_table(["category", "n"], [[c, rc.get(c, 0)] for c in HIT_CATEGORIES + OK_CATEGORIES] +
                      [["**total**", len(review)]])
    lines += ["", f"- 在审样本按来源：A {sum(1 for r in review if r['source_group'] == 'A')}，"
              f"B {sum(1 for r in review if r['source_group'] == 'B')}。",
              f"- 在审 hit {sum(1 for r in review if r['type'] == 'hit')} 条，"
              f"ok {sum(1 for r in review if r['type'] == 'ok')} 条。",
              f"- 在审样本中 A_PRESSED_WINDOW {rc.get('A_PRESSED_WINDOW', 0)} 条；"
              "这是最值得先人工看的“按了仍在窗口内”的候选。", ""]

    lines += ["## 6. unknown / 歧义 / 限制", ""]
    amb = Counter()
    for r in rows:
        for a in r["ambiguities"]:
            amb[a] += 1
    lines += md_table(["项目", "条数"], [
        ["无 press 的 hit", sum(1 for r in hits if r.get("press") is None)],
        ["press 但 glow_lead_est 为 null", sum(1 for r in hits if r.get("press") and r["glow_lead_est"] is None)],
        ["press 事件未在日志找到", sum(1 for r in rows if r.get("press") and r["press"].get("event_index") is None)],
        ["press lead 与事件帧差 >2f", sum(1 for r in rows if r.get("press") and r["press"].get("lead_delta_f") is not None and abs(r["press"]["lead_delta_f"]) > 2)],
        ["pred 在 [t−30,t] 缺失（hit）", sum(1 for r in hits if not r["pred_found"])],
        ["blocked reason 未归类", sum(1 for r in rows if any(x["reason"] == "unknown" for x in r["blocked"]["reasons"]))],
        ["runtime hit 重复 ≥3（[t−10,t+10]）", sum(1 for r in hits if r["measurement"]["runtime_repeat_flag"])],
        ["U_UNKNOWN（hit）", hc.get("U_UNKNOWN", 0)],
        ["C_BLOCKED 但 blocked 全在接触后", sum(1 for r in hits if r["category"] == "C_BLOCKED" and r["blocked"].get("only_after_contact"))],
    ])
    if amb:
        lines += ["", "逐条 `ambiguities` 已写入 `triage.json`/`triage.csv`，主要有：", ""]
        lines += md_table(["ambiguity", "条数"], amb.most_common(12))
    lines += ["",
              "- 按钮光偏移是每轮中位数（737 3.35f、738 1.25f、745 2.10f、733 2.21f、734 1.68f），"
              "只用于折算 approximate glow lead，不是逐事件真值。",
              "- 737 的 alignment p90 29.53f 主要受重复 hit 影响；本分诊仍使用现有 `offset_median`，"
              "没有把 737 的 glow 结果当成精确时间。",
              "- blocked 只证明调度器层阻止了动作，不证明游戏内冷却值，也不证明该资源冲突造成了这次伤害。",
              f"- C_BLOCKED 中有 {sum(1 for r in hits if r['category'] == 'C_BLOCKED' and r['blocked'].get('only_after_contact'))} 条"
              "的 blocked 全部出现在接触后（窗口 t−30..t+5），不能解释该次命中；已在逐条 evidence 标 `only_after_contact`。",
              "- busy 窗口固定为 [t−60,t]，按 potion > stagger > curtain > dodge > attack/charge 归类；"
              "窗口较粗，可能把接触前的普通攻击误当忙碌。日志没有独立 kind=dodge/weak/attack/charge，"
              "dodge 由 press detail 以 dodge 开头代理，attack/charge 由 off act/release 代理，weak 用 detail 含 weak 代理。",
              "- pred S1 取 [t−30,t] 内最高 S1（同分取最近），并在 JSON 里另存 `latest_s1`；"
              "Top15 的 S1 不一定是接触前最后一条 pred 的值。",
              "- 没有视觉接触真值；hit 的 t 固定取 `hp_drop.frame − 5`，runtime hit 事件帧没有当接触。",
              "- P0a 另指出 737/f5990 是 HP 检测器碎片；它不在本任务 E 口径（grey≥0.85 或 analysis quality flags）内，"
              "因此 r737-c069 仍按 D_PRESSED_LATE 保留，E 计数不包含该碎片。",
              "- runtime hit 重复 ≥3 只出现在 r737-c068（ok，f5970 的 21%->17% 簇），没有 hit 因此进入 E；"
              "这与 737 的运行时重复上报问题一致。",
              "- 全部 466 条均有代理类别；类别分布不是人工确认的防法错误率，也不能推总体胜率。",
              ""]
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_top15(path, rows):
    hits = [r for r in rows if r["type"] == "hit"]
    e_rows = sorted([r for r in hits if r["category"] == "E_MEASUREMENT"],
                    key=lambda r: (-(r["damage"] or 0), r["sample_id"]))
    ranked = sorted([r for r in hits if r["category"] != "E_MEASUREMENT"],
                    key=lambda r: (-(r["damage"] or 0), r["sample_id"]))[:15]
    lines = ["# Top 15 hit：按 direct damage 排序（排除 E_MEASUREMENT）", "",
             "> 代理分诊，不是人工确认。damage 为 `seq_contact.hp_loss`（maxHP 比例）。"
             "`pred_error_f = predicted_contact_frame_proxy − t`，正数表示预测接触晚于离线接触；null 表示没有可用的 parry c+Nf。"
             "`glow_lead_est` 用每轮按钮光中位偏移折算，approximate。", ""]
    for i, r in enumerate(ranked, 1):
        lines += [f"## {i}. {r['sample_id']}" + ("（90 样本内）" if r["in_review_set"] else ""), "",
                  f"- 轮次/接触：r{r['round']} / t={r['t']}（{r['t']/FPS:.3f}s），{r['outcome']}，phase={r['phase']}，kind={r['kind']}",
                  f"- category：**{r['category']}**；damage：**{r['damage']:.3f}** maxHP",
                  f"- press_lead：{r['press_lead']}；glow_lead_est：{r['glow_lead_est']}（{r['glow_status']}）；pred_error：{r['pred_error_f']}（{r['pred_error_source']}）",
                  f"- blocked：{('是：' + ','.join(x['reason'] for x in r['blocked']['reasons'])) if r['blocked']['present'] else '无'}；"
                  f"busy：{r['busy']['state']}",
                  f"- pred S1：{r['pred_s1']} / bin {r['pred_bin']} / +{r['pred_lead_f']}f / def1 {r['pred_def1']} / tell {r['pred_tell']}；"
                  f"latest S1 {r['pred'].get('latest_s1')} / bin {r['pred'].get('latest_bin')}；"
                  f"runtime hit repeats：{r['runtime_hit_repeats']}",
                  f"- 解释：{explain_row(r)}", ""]
    lines += ["## E_MEASUREMENT（单列，不参与 Top 15 排名）", ""]
    if not e_rows:
        lines.append("无。")
    for r in e_rows:
        lines += [f"- **{r['sample_id']}**：damage {r['damage']:.3f} maxHP，grey={r['measurement']['grey']}，"
                  f"basis={','.join(r['measurement']['basis'])}；{explain_row(r)}"]
    lines += ["", "说明：Top 15 中若同一根（root）有多个接触，仍按每个 contact 的直接损伤单列，不把后续组损伤并入。"
              "灰屏两条的 HP 读数可疑，不能直接解释为真实招式伤害。", ""]
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_review_sheet(path, selected):
    lines = ["# 待人工复核（阶段一盲审）", "",
             "> 只列 sample_id 和本机复核地址。此处不写任何结果、损伤、分类或定位信息。",
             "> 请先只看代理时刻截断片段并保存阶段一，再打开完整上下文做阶段二；不确定就填 unknown。", ""]
    for i, r in enumerate(selected, 1):
        lines += [f"## {i}. `{r['sample_id']}`", "",
                  f"http://127.0.0.1:8873/?sample={r['sample_id']}", "",
                  "**阶段一（只看截断片段）**：在决策时刻之前，画面里最早能看出什么起手/线索？请给候选帧区间；"
                  "当时距离、朝向、玩家动作和受控状态如何？哪些内容仍无法辨识？", "",
                  "**阶段二（扩展完整上下文后）**：视觉接触区间和 HP 下降帧分别在哪？有无明确的卸劲/闪避反馈？"
                  "这次接触是否与某个已确认的招式/段号相同？支持/反对“可卸”的证据分别是什么？", ""]
    lines += ["## 复核后", "",
              "- 把阶段一、阶段二分别保存到本地复核工具；首判保存后不要用事后信息覆盖。",
              "- 本表是代理分诊挑出的导航清单，不代表这些样本已被确认有问题。", ""]
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_doc(path, rows, review_selected):
    hits = [r for r in rows if r["type"] == "hit"]
    oks = [r for r in rows if r["type"] == "ok"]
    hc, oc = category_counts(hits), category_counts(oks)
    ranked = sorted([r for r in hits if r["category"] != "E_MEASUREMENT"],
                    key=lambda r: (-(r["damage"] or 0), r["sample_id"]))
    lines = ["# 攻击逐击分诊（2026-10-20）：给协调者的结论", "",
             "> 代理分诊，不是人工确认。所有类别来自离线 seq/事件/逐帧读数；press 是发送日志，pred 是周期舍入摘要，"
             "glow lead 用每轮按钮光中位偏移近似。没有视觉接触真值，也没有把代理观察写进 `labels.json`。", "",
             "## 1. 分类计数（A/B/C/D/E/U，按代理口径）", ""]
    lines += md_table(["组", "category", "n", "direct maxHP", "读法"], [
        ["A", "A_PRESSED_WINDOW", hc.get("A_PRESSED_WINDOW", 0), f"{total_damage([r for r in hits if r['category'] == 'A_PRESSED_WINDOW']):.3f}",
         "按钮光窗口内已按仍中；优先查动作类型/接触预测/执行"],
        ["D", "D_PRESSED_EARLY", hc.get("D_PRESSED_EARLY", 0), f"{total_damage([r for r in hits if r['category'] == 'D_PRESSED_EARLY']):.3f}",
         "按早（glow >12f）"],
        ["D", "D_PRESSED_LATE", hc.get("D_PRESSED_LATE", 0), f"{total_damage([r for r in hits if r['category'] == 'D_PRESSED_LATE']):.3f}",
         "按晚（glow <2f）"],
        ["C", "C_BLOCKED", hc.get("C_BLOCKED", 0), f"{total_damage([r for r in hits if r['category'] == 'C_BLOCKED']):.3f}",
         "press 被 blocked 或无 press 且有 blocked"],
        ["C", "C_BUSY", hc.get("C_BUSY", 0), f"{total_damage([r for r in hits if r['category'] == 'C_BUSY']):.3f}",
         "无可用 press 且喝药/硬直/幕布/闪避/出招"],
        ["B", "B_NO_PRED", hc.get("B_NO_PRED", 0), f"{total_damage([r for r in hits if r['category'] == 'B_NO_PRED']):.3f}",
         "无 press 且无 pred"],
        ["B", "B_PRED_NO_ACTION", hc.get("B_PRED_NO_ACTION", 0), f"{total_damage([r for r in hits if r['category'] == 'B_PRED_NO_ACTION']):.3f}",
         "无 press 但有 pred"],
        ["E", "E_MEASUREMENT", hc.get("E_MEASUREMENT", 0), f"{total_damage([r for r in hits if r['category'] == 'E_MEASUREMENT']):.3f}",
         "灰屏/质量标记"],
        ["U", "U_UNKNOWN", hc.get("U_UNKNOWN", 0), f"{total_damage([r for r in hits if r['category'] == 'U_UNKNOWN']):.3f}",
         "其余"],
        ["**合计**", "", len(hits), f"{total_damage(hits):.3f}", ""],
    ])
    lines += ["", f"ok：OK_CLEAN {oc.get('OK_CLEAN', 0)}，OK_CONFOUNDED {oc.get('OK_CONFOUNDED', 0)}，"
              f"OK_UNKNOWN {oc.get('OK_UNKNOWN', 0)}；合计 {len(oks)}。"
              "OK_CONFOUNDED 表示接触前 60f 到后 15f 有玩家输出/蓄力证据，真气下降不能单独归因卸劲。", ""]

    lines += ["## 2. Top 15（按 direct damage，排除 E_MEASUREMENT）", ""]
    lines += md_table(["#", "sample_id", "round/t", "category", "damage", "press/glow", "pred_err", "blocked/busy", "pred S1"],
                      [[i, r["sample_id"], f"{r['round']}/{r['t']}", r["category"], f"{r['damage']:.3f}",
                        f"{r['press_lead']}/{r['glow_lead_est']}", r["pred_error_f"],
                        ("B:" + ",".join(x["reason"] for x in r["blocked"]["reasons"])) if r["blocked"]["present"] else ("busy:" + r["busy"]["state"] if r["busy"]["state"] != "none" else "none"),
                        r["pred_s1"]] for i, r in enumerate(ranked[:15], 1)])
    lines += ["", "E_MEASUREMENT 单列：" + ("；".join(
        f"{r['sample_id']}（{r['damage']:.3f}，grey={r['measurement']['grey']}）" for r in hits if r["category"] == "E_MEASUREMENT") or "无") + "。", ""]

    lines += ["## 3. 哪些结论稳，哪些不稳", "",
              "**相对稳（描述性、可复核）**", "",
              f"- 466 条候选接触全部有代理类别，hit {len(hits)} + ok {len(oks)} = 466；hit 分类和 = {sum(hc.values())}。",
              f"- 全部 hit 中，D（按早/按晚）共 {hc.get('D_PRESSED_EARLY', 0) + hc.get('D_PRESSED_LATE', 0)} 条，"
              f"C（blocked/busy）共 {hc.get('C_BLOCKED', 0) + hc.get('C_BUSY', 0)} 条；A 只有 {hc.get('A_PRESSED_WINDOW', 0)} 条。",
              f"- 90 样本中 hit {sum(1 for r in hits if r['in_review_set'])} 条、ok {sum(1 for r in oks if r['in_review_set'])} 条；"
              "A_PRESSED_WINDOW 的样本极少，不能据此估计总体“按了仍中”的比例。",
              "- 灰屏 E 只有 2 条（737/f7264、745/f7438），其中 745 的 0.449 占全清单损伤很大；这是测量质量事实，"
              "不是真实招式伤害。",
              "- blocked 日志确实存在（本分诊 93 个接触在 [t−30,t+5] 有 blocked；审计报告 90 样本中 10 样本/40 条 [t−30,t] 去重日志），"
              "但只证明调度器阻止动作，不证明资源冲突导致该次伤害。"
              f"C_BLOCKED 中有 {sum(1 for r in hits if r['category'] == 'C_BLOCKED' and r['blocked'].get('only_after_contact'))} 条"
              "的 blocked 全部在接触后，不能解释该次命中，优先人工看这些条目。", "",
              "**不稳 / 不能外推**", "",
              "- `glow_lead_est` 是每轮中位数折算；737 的 offset/p90 受重复 hit 影响，A/D 边界可能随真实逐事件偏移变化。",
              "- press 是发送日志（parry 在 tap 后、dodge 在 down/up 后记），不等于游戏执行；A 类仍需确认动作是否真的生效。",
              "- pred 每 500ms 左右一条、数值舍入；`pred_error_f` 是代理接触帧差，不是端到端延迟。",
              "- busy 窗口 [t−60,t] 很粗；C_BUSY 可能把普通攻击/前一个动作误判为“无法防守”，需要人工看画面。"
              "日志没有独立 kind=dodge/weak/attack/charge，dodge 用 press detail、attack/charge 用 off act/release 代理。",
              "- pred S1 取窗口内最高 S1（同分取最近），不是接触前最后一条 pred；JSON 另存 latest_s1。",
              "- press 被 blocked 的子类只计同 k-slot 且紧邻的 blocked；本轮 hit 为 0，两个跨槽位 blocked 的 press 归 D_LATE，"
              "是否应算 C_BLOCKED 需人工确认。",
              "- OK_CLEAN 只是附近未发现玩家输出，不等于确认成功卸劲；OK_CONFOUNDED 也不证明输出就是真气下降的唯一原因。",
              "- P0a 指出的 737/f5990 检测器碎片不在本任务 E 口径内（r737-c069 仍按 D_LATE），E 计数不是全部测量伪影。",
              "- 没有视觉接触区间、没有逐推理输入帧、没有设备/游戏执行确认；类别不是因果结论，也不是总体错误率。", ""]

    lines += ["## 4. 建议先审的 10 条", "",
              "从 `review_sheet.md` 的盲审清单里优先取：A 全部、B 高损伤、C 高损伤、2 条 ok 对照（clean/confounded）。"
              "先保存阶段一，再看完整上下文。", ""]
    a_rows = sorted([r for r in review_selected if r["category"] == "A_PRESSED_WINDOW"],
                    key=lambda r: (-(r["damage"] or 0), r["sample_id"]))
    b_rows = sorted([r for r in review_selected if r["category"] in ("B_NO_PRED", "B_PRED_NO_ACTION")],
                    key=lambda r: (-(r["damage"] or 0), r["sample_id"]))
    c_rows = sorted([r for r in review_selected if r["category"] in ("C_BLOCKED", "C_BUSY")],
                    key=lambda r: (-(r["damage"] or 0), r["sample_id"]))
    d_rows = sorted([r for r in review_selected if r["category"] in ("D_PRESSED_EARLY", "D_PRESSED_LATE")],
                    key=lambda r: (-(r["damage"] or 0), r["sample_id"]))
    ok_rows = [r for r in review_selected if r["type"] == "ok"]
    ok_clean = [r for r in ok_rows if r["category"] == "OK_CLEAN"]
    ok_conf = [r for r in ok_rows if r["category"] == "OK_CONFOUNDED"]
    picks = []
    for pool in (a_rows, b_rows, c_rows, ok_clean[:1], ok_conf[:1], d_rows):
        for r in pool:
            if len(picks) < 10 and r["sample_id"] not in {x["sample_id"] for x in picks}:
                picks.append(r)
                break
    for r in a_rows + b_rows + c_rows + d_rows + ok_rows:
        if len(picks) >= 10:
            break
        if r["sample_id"] not in {x["sample_id"] for x in picks}:
            picks.append(r)
    lines += md_table(["#", "sample_id", "代理类别", "damage", "先看什么"],
                      [[i, r["sample_id"], r["category"], f"{r['damage']:.3f}" if r["damage"] is not None else "—",
                        explain_row(r)] for i, r in enumerate(picks, 1)])
    lines += ["", "这 10 条只用于导航；若阶段一显示线索在截断前不可见，应记录为 unknown，不能反推“决策前不可辨识”。", ""]
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def build(out, doc):
    population = read(AUDIT_OUT / "population.json")
    samples = read(AUDIT_OUT / "samples.json")
    rounds_json = read(AUDIT_OUT / "rounds.json")
    analysis = read(AUDIT_OUT / "analysis.json")
    sample_meta = {s["sample_id"]: s for s in samples}
    analysis_flags = {x["sample_id"] for x in analysis.get("screen_state_quality_flags", [])}
    outcomes = {r["round"]: r["result_from_log"] for r in rounds_json}
    round_data = {k: audit.load_round(k) for k in ROUND_ORDER}

    rows = []
    for c in population:
        if c["round"] not in round_data:
            raise ValueError(f"round {c['round']} missing")
        if c["seq_contact"]["type"] == "hit" and c.get("hp_drop"):
            if c["seq_contact"]["t"] != c["hp_drop"]["frame"] - 5:
                raise ValueError(f"hit t != hp_drop.frame - 5: {c['sample_id']}")
        rows.append(build_contact(c, round_data[c["round"]], outcomes[c["round"]], sample_meta, analysis_flags))

    # Reconciliation checks: fail loudly rather than emit a silently inconsistent file.
    ids = [r["sample_id"] for r in rows]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate sample_id in triage")
    if len(rows) != len(population):
        raise ValueError("triage row count != population")
    hits = [r for r in rows if r["type"] == "hit"]
    oks = [r for r in rows if r["type"] == "ok"]
    if len(hits) + len(oks) != len(rows):
        raise ValueError("type reconciliation failed")
    if sum(category_counts(hits).values()) != len(hits):
        raise ValueError("hit category sum != hit count")
    if sum(category_counts(oks).values()) != len(oks):
        raise ValueError("ok category sum != ok count")
    if {r["sample_id"] for r in rows if r["in_review_set"]} != set(sample_meta):
        raise ValueError("in_review_set != samples.json")
    if any(r["category"] is None for r in rows):
        raise ValueError("missing category")

    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    write_json(out / "triage.json", rows)
    write_csv(out / "triage.csv", rows)
    write_summary(out / "summary.md", rows, sample_meta)
    write_top15(out / "top15.md", rows)
    selected = review_selection(rows)
    write_review_sheet(out / "review_sheet.md", selected)
    write_doc(doc, rows, selected)
    return rows, selected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--doc", type=Path, default=DEFAULT_DOC)
    a = parser.parse_args()
    rows, selected = build(a.out, a.doc)
    hits = [r for r in rows if r["type"] == "hit"]
    oks = [r for r in rows if r["type"] == "ok"]
    print(json.dumps({
        "out": str(Path(a.out)),
        "doc": str(Path(a.doc)),
        "contacts": len(rows),
        "hit": len(hits),
        "ok": len(oks),
        "hit_categories": dict(category_counts(hits)),
        "ok_categories": dict(category_counts(oks)),
        "review_set": sum(1 for r in rows if r["in_review_set"]),
        "review_sheet": len(selected),
        "hit_damage_maxHP": total_damage(hits),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
