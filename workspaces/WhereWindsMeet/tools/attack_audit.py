"""Offline attack evidence audit. Never calls the device or runs a model.

See ../docs/attack-evidence-audit.md. Commands: build, validate, serve, report.
Python stdlib for extraction; OpenCV/numpy (existing cv extra) for video review.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import random
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUT = ROOT / "data/attack_audit/20261020"
ROUNDS = (737, 738, 745, 733, 734)
UNI = "data/tmp/dufu_ml/unified"
OLD = "data/tmp/dufu_breakthrough/review30"
FPS = 30
SEED = 20261020


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def digest(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def fingerprint(path):
    p = ROOT / path
    return {"path": str(path).replace("\\", "/"), "exists": p.exists(),
            "sha256": digest(p) if p.exists() else None,
            "bytes": p.stat().st_size if p.exists() else None}


def quantile(xs, q):
    if not xs:
        return None
    xs = sorted(xs)
    x = (len(xs) - 1) * q
    a = int(x)
    return xs[a] + (xs[min(a + 1, len(xs) - 1)] - xs[a]) * (x - a)


def hp_drops(features):
    """Same detector as round_stats.hits_of, retaining constituent drop frames.

    Trailing median of 3; strict 0.025 < drop < 0.35. Merge if within 3
    frames of the FIRST drop of the group, not transitively.
    """
    out, last = [], None
    for i in range(len(features)):
        vals = [r["hp"] for r in features[max(0, i - 2):i + 1] if r["hp"] is not None]
        if not vals:
            continue
        h = statistics.median(vals)
        if last is not None and .025 < last - h < .35:
            d = {"frame": i, "maxHP": last - h}
            if out and i - out[-1]["frame"] <= 3:
                out[-1]["maxHP"] += last - h
                out[-1]["parts"].append(d)
            else:
                out.append({"frame": i, "maxHP": last - h, "parts": [d]})
        if last is None or abs(h - last) > .025:
            last = h
    return out


def map_events(events, seff):
    out = []
    for i, e in enumerate(events):
        f = (e[0] - seff) * FPS / 1000
        m = re.search(r"c\+(-?\d+)f", e[3] or "")
        out.append({"event_index": i, "epoch_ms": e[0], "elapsed_ms": e[1],
                    "kind": e[2], "detail": e[3], "estimated_video_frame": f,
                    "predicted_contact_frame_proxy": f + int(m[1]) if m else None,
                    "actual_input_frame": None, "device_ack_ms": None, "game_execution_frame": None})
    return out


def alignment(events, drops, seff, started, glow_path):
    # Nearest event matching is diagnostic, not independent physical clock calibration.
    pairs = []
    for e in events:
        if e["kind"] != "hit" or not drops:
            continue
        f = e["estimated_video_frame"]
        d = min(drops, key=lambda x: abs(x["frame"] - f))
        pairs.append({"event_index": e["event_index"], "hp_frame": d["frame"],
                      "event_frame_estimate": f, "residual_frames": d["frame"] - f})
    abs_res = [abs(p["residual_frames"]) for p in pairs]
    grid = []
    for offset in range(-20, 21):
        base = started + offset * 1000 / FPS
        ds = [min(abs(d["frame"] - round((e["epoch_ms"] - base) * FPS / 1000)) for d in drops)
              for e in events if e["kind"] == "hit"] if drops else []
        grid.append({"started_offset_frames": offset, "median_abs_frames": quantile(ds, .5),
                     "p90_abs_frames": quantile(ds, .9)})
    glow = {"status": "missing"}
    if glow_path.exists():
        import numpy as np
        g = np.load(glow_path)
        threshold = max(110, float(np.median(g)) + 50)
        onsets = np.where((g[1:] >= threshold) & (g[:-1] < threshold))[0] + 1
        offsets = []
        for e in events:
            if e["kind"] == "press" and e["detail"].startswith("parry"):
                f = e["estimated_video_frame"]
                possible = [float(o - f) for o in onsets if -15 <= o - f <= 25]
                if possible:
                    offsets.append(min(possible, key=abs))
        if offsets:
            mode = Counter(round(x) for x in offsets).most_common(1)[0][0]
            near = [x for x in offsets if abs(x - mode) <= 4]
            glow = {"status": "estimated_nearest_button_glow", "threshold": threshold,
                    "n_candidates": len(offsets), "n_mode_inliers": len(near),
                    "offset_median_frames": statistics.median(near),
                    "offset_p10_p90_frames": [quantile(near, .1), quantile(near, .9)],
                    "all_offsets_frames": offsets,
                    "warning": "Not execution feedback; do not add to command timestamps."}
    return {"method": "existing seff; nearest logged-hit to offline HP drop cross-check",
            "seff_epoch_ms": seff, "started_epoch_ms": started,
            "seff_minus_started_frames": (seff - started) * FPS / 1000,
            "pairs": pairs, "median_abs_residual_frames": quantile(abs_res, .5),
            "p90_abs_residual_frames": quantile(abs_res, .9),
            "max_abs_residual_frames": max(abs_res, default=None),
            "offset_grid": grid, "button_glow": glow,
            "absolute_clock_error_bound_frames": None,
            "contact_latency_error_bound_frames": None,
            "warning": "Residuals include detector/polling latency and ambiguous nearest matches; not a confidence interval."}


def kind(c):
    return "flare" if c["flare"] else "curtain" if c["curtain"] or c["fw"] else "normal"


def decision_proxy(c, events, align):
    t = c["t"]
    ps = [e for e in events if t - 60 <= e["estimated_video_frame"] <= t
          and e["kind"] == "press" and e["detail"].startswith(("parry", "dodge"))]
    press = ps[-1] if ps else None
    anchor = press
    if press:
        slot = re.search(r"\bk(-?\d+)", press["detail"])
        plans = [e for e in events if t - 90 <= e["estimated_video_frame"] <= press["estimated_video_frame"]
                 and e["kind"] == "plan" and e["detail"].startswith("+ ")
                 and slot and re.search(rf"\bk{slot[1]}\b", e["detail"])]
        if plans:
            anchor = plans[-1]
    if anchor is None:
        anchors = [e for e in events if t - 60 <= e["estimated_video_frame"] < t and e["kind"] == "pred"]
        anchor = anchors[-1] if anchors else None
    margin = math.ceil(align["p90_abs_residual_frames"] or 0) + 1
    cutoff = max(0, min(t - 1, math.floor(anchor["estimated_video_frame"]) - margin)) if anchor else max(0, t - 30)
    return {"actual_decision_time": None, "actual_inference_input_frames": None,
            "anchor_event_index": anchor["event_index"] if anchor else None,
            "anchor_kind": anchor["kind"] if anchor else "no_event_fallback",
            "anchor_estimated_video_frame": anchor["estimated_video_frame"] if anchor else None,
            "nearby_press_event_index": press["event_index"] if press else None,
            "cutoff_frame": cutoff, "margin_frames": margin,
            "status": "proxy_only_not_verified_decision_cutoff",
            "reason": "Nearest prior slot plan/press or pred; slot IDs reused. Input timestamps absent. Margin is empirical, not guaranteed."}


def load_round(k):
    reg = read(ROOT / "data/tmp/dufu_yolo/rounds.json")[str(k)]
    paths = {"seq": f"{UNI}/seq/round_{k}.json", "run": reg["run"],
             "features": f"data/tmp/dufu/r{k}.json", "source": f"{OLD}/r{k}.source.js",
             "config": f"{OLD}/r{k}.meta.json", "old_attribution": f"{OLD}/r726/attrib_{k}.json",
             "meta": f"workspaces/WhereWindsMeet/recordings/{reg['rec']}/meta.json",
             "video": f"workspaces/WhereWindsMeet/recordings/{reg['rec']}/video.mp4"}
    seq, run, feat, config, meta = [read(ROOT / paths[x]) for x in ("seq", "run", "features", "config", "meta")]
    run = run.get("value", run)
    assert seq["rec"] == reg["rec"] == meta["id"]
    assert len(feat) == seq["n_frames"] == meta["frames"]
    assert meta["fps"] == FPS
    events = map_events(run["events"], reg["seff"])
    drops = hp_drops(feat)
    align = alignment(events, drops, reg["seff"], meta["started"],
                      ROOT / f"data/tmp/dufu_yolo/glow_{reg['rec']}.npy")
    manifest = {name: fingerprint(path) for name, path in paths.items()}
    assert manifest["source"]["sha256"] == config["sha256"], f"source hash mismatch r{k}"
    versions = {"round": k, "rec": reg["rec"], "files": manifest,
                "skill_sha256": config["sha256"], "skill_snapshot_matches": True,
                "config_args": config["args"], "app_build": "unknown", "dependencies_at_run": "unknown",
                "model_at_run_sha256": "unknown", "model_names": [config["args"]["model"], config["args"]["backModel"]],
                "current_model_files_not_historical_proof": [fingerprint("workspaces/WhereWindsMeet/model/" + config["args"][name])
                                                            for name in ("model", "backModel")],
                "seff_note": reg["align"], "result_from_log": run["reason"],
                "seq_contacts": len(seq["contacts"]), "seq_hits": sum(c["type"] == "hit" for c in seq["contacts"]),
                "seq_ok": sum(c["type"] == "ok" for c in seq["contacts"]),
                "runtime_hits": run["hits"], "runtime_ok": run["oks"],
                "runtime_blocked_counts": run["blocked"], "alive_frames": seq["alive"],
                "alive_minutes": (seq["alive"][1] - seq["alive"][0]) / FPS / 60,
                "pred_event_count": sum(e["kind"] == "pred" for e in events),
                "inference_calls": run.get("headCalls"), "full_per_inference_predictions_available": False}
    population, root_id = [], None
    for i, c in enumerate(seq["contacts"]):
        sid = f"r{k}-c{i:03d}-f{c['t']:05d}"
        follow = c["type"] == "hit" and c.get("prev_type") == "hit" and (c.get("prev_gap") or 99) <= 23
        if c["type"] == "hit" and not follow:
            root_id = sid
        if c["type"] != "hit":
            root_id = None
        phase = min(2, max(0, int(3 * (c["t"] - seq["alive"][0]) / max(1, seq["alive"][1] - seq["alive"][0]))))
        drop = next((d for d in drops if d["frame"] == c["t"] + 5), None) if c["type"] == "hit" else None
        population.append({"sample_id": sid, "round": k, "rec": reg["rec"], "contact_index": i,
                           "seq_contact": c, "seq_kind": kind(c), "root_id": root_id, "is_root": c["type"] == "hit" and not follow,
                           "elapsed_phase": ("early", "middle", "late")[phase], "game_phase": "unknown",
                           "hp_drop": drop, "feature_at_anchor": feat[c["t"]],
                           "decision_proxy": decision_proxy(c, events, align)})
    return {"manifest": versions, "alignment": align, "population": population, "events": events, "features": feat,
            "tells": seq["tells"], "gaps": seq["gaps"]}


def choose_samples(population, seed=SEED):
    """A=60 stratified SRS on detected contacts; B=15 normal roots + 15 proxy controls."""
    rng = random.Random(seed)
    groups = defaultdict(list)
    for c in population:
        groups[(c["round"], c["elapsed_phase"])].append(c)
    chosen, strata = [], []
    for k in ROUNDS:
        for phase in ("early", "middle", "late"):
            group = sorted(groups[k, phase], key=lambda c: c["sample_id"])
            take = rng.sample(group, min(4, len(group)))
            strata.append({"round": k, "elapsed_phase": phase, "N": len(group), "n": len(take)})
            for c in take:
                chosen.append({**c, "source_group": "A", "selection_reason": "stratified_SRS",
                               "inclusion_probability": len(take) / len(group), "weight": len(group) / len(take)})
    used = {c["sample_id"] for c in chosen}
    targets = [c for c in population if c["round"] in (737, 738, 745) and c["is_root"]
               and c["seq_kind"] == "normal" and c["sample_id"] not in used]
    # Round-robin priority, descending direct root loss within round.
    buckets = {k: sorted([c for c in targets if c["round"] == k],
                        key=lambda c: (-c["seq_contact"]["hp_loss"], c["sample_id"])) for k in ROUNDS[:3]}
    supplement = []
    while len(supplement) < 15 and any(buckets.values()):
        for k in ROUNDS[:3]:
            if buckets[k] and len(supplement) < 15:
                c = buckets[k].pop(0)
                supplement.append({**c, "source_group": "B", "selection_reason": "normal_high_direct_root_damage",
                                   "inclusion_probability": None, "weight": None})
                used.add(c["sample_id"])
    # Fill the fixed diagnostic budget if high-damage roots are exhausted.
    rest = sorted((c for c in population if c["sample_id"] not in used and c["is_root"]),
                  key=lambda c: (-c["seq_contact"]["hp_loss"], c["sample_id"]))
    while len(supplement) < 15 and rest:
        c = rest.pop(0)
        supplement.append({**c, "source_group": "B", "selection_reason": "other_uncertain_root",
                           "inclusion_probability": None, "weight": None})
        used.add(c["sample_id"])
    controls = []
    for target in supplement:
        candidates = [c for c in population if c["sample_id"] not in used and c["seq_contact"]["type"] == "ok"]
        def score(c):
            a, b = target["feature_at_anchor"], c["feature_at_anchor"]
            # Matching is only a navigation aid; never declares identical attacks.
            return (c["seq_kind"] != target["seq_kind"],
                    c["elapsed_phase"] != target["elapsed_phase"],
                    c["round"] not in (733, 734),
                    abs((a["hp"] or 0) - (b["hp"] or 0)),
                    abs((target["seq_contact"]["prev_gap"] or 0) - (c["seq_contact"]["prev_gap"] or 0)),
                    c["sample_id"])
        if candidates:
            c = min(candidates, key=score)
            target["candidate_pair"] = c["sample_id"]
            controls.append({**c, "source_group": "B", "selection_reason": "proxy_context_ok_control",
                             "candidate_pair": target["sample_id"], "pair_identity_confirmed": False,
                             "inclusion_probability": None, "weight": None})
            used.add(c["sample_id"])
    return chosen + supplement + controls, strata


def blank_label(sample_id):
    return {"sample_id": sample_id, "source": "agent_candidate", "reviewer": "",
            "stage1_original": None, "stage1_revisions": [], "stage2_original": None,
            "stage2_revisions": [], "stage3": None, "history": [],
            "status": "pending", "human_confirmed": False}


def label_template(stage):
    base = {"source": "agent_candidate", "reviewer": "", "notes": ""}
    if stage == 1:
        return {**base, "attack_id": "unknown", "combo_segment": "unknown", "phase": "unknown",
                "mechanisms": [], "recognizable_before_decision": "unknown",
                "earliest_cue_frame_range": None, "observable_context": {
                    "distance": "unknown", "facing": "unknown", "player_action": "unknown", "controlled_state": "unknown"}}
    if stage == 2:
        return {**base, "attack_id": "unknown", "combo_segment": "unknown", "phase": "unknown",
                "mechanisms": [], "visual_contact_frame_range": None,
                "hp_drop_frames": [], "parry_feedback": [], "dodge_feedback": [],
                "parryability": "unknown", "defense_evidence": [],
                "other_supported_defenses": [], "same_attack_sample_ids": [],
                "observable_context": {"distance": "unknown", "facing": "unknown",
                                       "player_action": "unknown", "controlled_state": "unknown"}}
    return {**base, "factors": [], "defense_mismatch": "unknown", "timing_or_execution_problem": "unknown",
            "resource_conflict": "unknown", "resource_state_evidence": [],
            "model_action_evidence": [], "evidence": [], "missing_evidence": [],
            "damage_links": [], "notes": ""}


def validate_label_payload(stage, value):
    if not isinstance(value, dict) or not set(label_template(stage)).issubset(value):
        raise ValueError("Missing label fields")
    if value["source"] not in ("agent_candidate", "human_confirmed", "other_reliable_evidence"):
        raise ValueError("Invalid label source")
    if value["source"] == "human_confirmed" and not value.get("reviewer", "").strip():
        raise ValueError("Human confirmation requires a named reviewer")
    for key, template_value in label_template(stage).items():
        if isinstance(template_value, list) and not isinstance(value[key], list):
            raise ValueError(f"{key} must be an array")
        if isinstance(template_value, dict) and not isinstance(value[key], dict):
            raise ValueError(f"{key} must be an object")
    range_key = "earliest_cue_frame_range" if stage == 1 else "visual_contact_frame_range" if stage == 2 else None
    if range_key and value[range_key] is not None:
        bounds = value[range_key]
        if not (isinstance(bounds, list) and len(bounds) == 2 and all(type(x) is int for x in bounds)
                and 0 <= bounds[0] <= bounds[1]):
            raise ValueError("Frame ranges must be [first, last], or null for unknown")
    if stage == 2:
        if value["parryability"] not in ("confirmed_parryable", "confirmed_unparryable", "conditional", "unknown"):
            raise ValueError("Invalid parryability")
        if value["parryability"] != "unknown":
            ev = value["defense_evidence"]
            if not evidence_complete(ev):
                raise ValueError("Defense claims require source, conditions, frames, confidence and observation")
    if stage == 3:
        for field in ("defense_mismatch", "timing_or_execution_problem", "resource_conflict"):
            if value[field] not in ("confirmed", "suspected", "unknown", "not_supported"):
                raise ValueError("Invalid causal status")
            if value[field] == "confirmed" and not evidence_complete(value["evidence"]):
                raise ValueError("Confirmed factors require evidence; a failed button press is insufficient")


def evidence_complete(evidence):
    return isinstance(evidence, list) and bool(evidence) and all(
        isinstance(e, dict) and all(e.get(key) for key in ("source", "conditions", "frames", "confidence", "observation"))
        for e in evidence)


def save_stage(label, stage, value):
    """Immutable first impressions; later edits are explicit revisions."""
    from datetime import datetime, timezone
    validate_label_payload(stage, value)
    label = copy.deepcopy(label)
    if stage > 1 and not label["stage1_original"]:
        raise ValueError("Save stage 1 before revealing context")
    if stage == 3 and not label["stage2_original"]:
        raise ValueError("Save stage 2 before revealing logs")
    stamp = datetime.now(timezone.utc).isoformat()
    if stage < 3:
        key = f"stage{stage}_original"
        if label[key] is None:
            label[key] = copy.deepcopy(value)
        else:
            label[f"stage{stage}_revisions"].append({"at": stamp, "value": copy.deepcopy(value),
                                                    "after_reveal": True})
    else:
        label["stage3"] = copy.deepcopy(value)
    label["history"].append({"at": stamp, "stage": stage, "value": copy.deepcopy(value)})
    label["status"] = f"stage{stage}_saved"
    label["human_confirmed"] = all((label.get(f"stage{i}_original" if i < 3 else "stage3") or {}).get("source") == "human_confirmed"
                                   for i in (1, 2, 3))
    return label


def build(out, count, seed, pilot=None):
    out = Path(out).resolve()
    if (out / "samples.json").exists():
        raise ValueError("Use a new output directory; existing review labels must not be overwritten")
    rounds = {k: load_round(k) for k in ROUNDS}
    population = [c for k in ROUNDS for c in rounds[k]["population"]]
    selected, strata = choose_samples(population, seed)
    assert len(selected) == 90
    if count == 20:
        # Four per round; includes both A and B, with available controls.
        pilot_samples = []
        for k in ROUNDS:
            a = [c for c in selected if c["round"] == k and c["source_group"] == "A"]
            b = [c for c in selected if c["round"] == k and c["source_group"] == "B"]
            pilot_samples += [next(c for c in a if c["elapsed_phase"] == ph) for ph in ("early", "middle", "late")]
            pilot_samples += (b or [c for c in a if c not in pilot_samples])[:1]
        selected = pilot_samples
    elif count == 90:
        if pilot is None:
            raise ValueError("First build/validate a 20-sample pilot, then pass --pilot")
        check = read(Path(pilot) / "validation.json")
        old = read(Path(pilot) / "rounds.json")
        if not check["passed"] or check["samples"] != 20 or check["media_frames_checked"] < 60:
            raise ValueError("Pilot requires passing extraction, alignment and video frame checks")
        if old != [rounds[k]["manifest"] for k in ROUNDS]:
            raise ValueError("Sources changed since pilot")
    else:
        raise ValueError("Supported counts are 20 and 90")
    out.mkdir(parents=True, exist_ok=True)
    write(out / "rounds.json", [rounds[k]["manifest"] for k in ROUNDS])
    write(out / "population.json", population)
    write(out / "alignment.json", {str(k): rounds[k]["alignment"] for k in ROUNDS})
    write(out / "sampling.json", {
        "seed": seed, "algorithm": "Python Random.sample; 4 per round x elapsed-time-third, A=60. B=15 roots + 15 ok controls.",
        "python_random_reproducibility": "Persisted selected IDs authoritative; validation recomputes selection.",
        "strata": strata, "population_n": len(population), "requested_count": count,
        "denominator": "All existing seq detector contacts in five rounds; NOT all attacks / visual contacts.",
        "coverage": "Missed/whiffed/dodged attacks and damage under thresholds may be absent. No complete visual census exists.",
        "game_phase": "unknown; elapsed thirds are sampling strata only",
        "pilot": str(pilot) if pilot else None, "pilot_ids": [c["sample_id"] for c in read(Path(pilot)/"samples.json")] if pilot else None,
        "B_excluded_from_population_rates": True, "selected_ids": [c["sample_id"] for c in selected]})
    labels = {}
    for c in selected:
        r = rounds[c["round"]]
        t = c["seq_contact"]["t"]
        previous = c["seq_contact"]["prev_gap"]
        start = max(0, min(t - 120, t - (previous or 0) - 30, c["decision_proxy"]["cutoff_frame"] - 90))
        end = min(len(r["features"]) - 1, t + 120)
        c["clip"] = {"from": start, "to": end, "fps": FPS, "anchor": t,
                     "pre_decision_to": c["decision_proxy"]["cutoff_frame"],
                     "extendable_from": 0, "extendable_to": len(r["features"]) - 1,
                     "video": r["manifest"]["files"]["video"]["path"],
                     "time_seconds": t / FPS, "visual_contact_interval": None}
        c["source_ref"] = f"{r['manifest']['files']['seq']['path']}#/contacts/{c['contact_index']}"
        c["missing"] = ["No human confirmation", "Unknown visual attack identity, mechanism, defense conditions and contact interval",
                        "No per-inference input timestamps or complete probability vectors",
                        "No device-receive / game-execution acknowledgement",
                        "No measured absolute alignment or contact-delay bound",
                        "No complete attack census; proxy controls not confirmed same move"]
        ev = [e for e in r["events"] if start - 30 <= e["estimated_video_frame"] <= end + 30]
        write(out / "evidence" / f"{c['sample_id']}.json", {
            "sample_id": c["sample_id"], "events": ev, "features": r["features"][start:end + 1],
            "nearby_contacts": [p for p in r["population"] if start <= p["seq_contact"]["t"] <= end],
            "tells": [v for v in r["tells"] if start <= v["t"] <= end],
            "gaps": [v for v in r["gaps"] if start <= v["b"] and v["a"] <= end],
            "alignment": r["alignment"],
            "prediction_warning": "pred events are periodic rounded summaries, not per-frame model truth",
            "action_warning": "press is logged after dispatch code (dodge after >=50 ms sleep); not game execution"})
        labels[c["sample_id"]] = blank_label(c["sample_id"])
    write(out / "samples.json", selected)
    write(out / "labels.json", labels)
    write(out / "label_templates.json", {str(i): label_template(i) for i in (1, 2, 3)})
    write(out / "provenance.json", {
        "tool": fingerprint(Path(__file__).relative_to(ROOT)),
        "definition_sources": [fingerprint(p) for p in (
            f"{UNI}/common.py", f"{UNI}/seq.py", f"{UNI}/align_check.py",
            "data/tmp/dufu_yolo/round_stats.py", "data/tmp/dufu_moves/anchors.py",
            f"{OLD}/r726/attrib.py",
            "android/app/src/main/kotlin/io/github/flufy3d/maalow/record/Recorder.kt")],
        "note": "Current definition-source hashes are audit-time provenance, not proof of historical extraction version."})
    report(out)
    print(json.dumps({"out": str(out), "samples": len(selected), "population": len(population)}))


def read_frame(video, n):
    import cv2
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise ValueError(f"Cannot open video: {video}")
    try:
        cap.set(cv2.CAP_PROP_POS_FRAMES, n)
        ok, frame = cap.read()
        pos = cap.get(cv2.CAP_PROP_POS_FRAMES)
        if not ok or round(pos) != n + 1:
            raise ValueError(f"Cannot decode exact frame {n}; decoder position {pos}")
        return frame
    finally:
        cap.release()


def sheets(out):
    """Portable overview cards; exact full-resolution frames remain available in serve."""
    from PIL import Image, ImageDraw
    out = Path(out)
    samples = read(out/"samples.json")
    cards = []
    for s in samples:
        clip = s["clip"]
        a, cut, t, b = clip["from"], clip["pre_decision_to"], clip["anchor"], clip["to"]
        for stage, frames in (
            ("pre", sorted({round(a + (cut-a)*i/5) for i in range(6)})),
            ("context", sorted({a, max(a,t-45), max(a,t-15), max(a,t-5), t, min(b,t+5), min(b,t+15), min(b,t+45), b})),
        ):
            canvas = Image.new("RGB", (1080, math.ceil(len(frames)/3)*262), "#14202b")
            draw = ImageDraw.Draw(canvas)
            for j,n in enumerate(frames):
                image = Image.fromarray(read_frame(ROOT/clip["video"], n)[:, :, ::-1]).resize((360,240))
                x,y=(j%3)*360,(j//3)*262
                canvas.paste(image,(x,y))
                draw.text((x+4,y+242),f"f{n}   {n/30:.3f}s",fill="white")
            path=out/"cards"/f"{s['sample_id']}.{stage}.jpg"
            path.parent.mkdir(parents=True,exist_ok=True)
            canvas.save(path,quality=91)
            cards.append({"sample_id":s["sample_id"],"stage":stage,"frames":frames,"file":str(path.relative_to(out))})
    write(out/"cards.json",cards)
    print(json.dumps({"cards":len(cards)}))


def validate(out, media=False):
    out = Path(out)
    samples, population = read(out/"samples.json"), read(out/"population.json")
    errors, checks = [], []
    ids = [s["sample_id"] for s in samples]
    if len(ids) != len(set(ids)):
        errors.append("duplicate IDs")
    all_selected, _ = choose_samples(population, read(out/"sampling.json")["seed"])
    if not set(ids).issubset({c["sample_id"] for c in all_selected}):
        errors.append("sampling not reproducible")
    for s in samples:
        ev = read(out/"evidence"/f"{s['sample_id']}.json")
        if not s["clip"]["from"] <= s["clip"]["pre_decision_to"] < s["clip"]["anchor"] <= s["clip"]["to"]:
            errors.append(f"clip ordering {s['sample_id']}")
        for e in ev["events"]:
            expected = (e["epoch_ms"] - ev["alignment"]["seff_epoch_ms"]) * .03
            if abs(e["estimated_video_frame"] - expected) > 1e-6:
                errors.append(f"mapping {s['sample_id']}")
        if s["seq_contact"]["type"] == "hit":
            if not s["hp_drop"] or abs(round(s["hp_drop"]["maxHP"], 3) - s["seq_contact"]["hp_loss"]) > 1e-6:
                errors.append(f"HP detector mismatch {s['sample_id']}")
        if media:
            import cv2
            import numpy as np
            for n in (s["clip"]["from"], s["clip"]["pre_decision_to"], s["clip"]["anchor"]):
                frame = read_frame(ROOT/s["clip"]["video"], n)
                # Independent sequential decode from 0 is checked once per round below.
                checks.append({"sample_id": s["sample_id"], "frame": n, "shape": list(frame.shape),
                               "decoded_pixels_sha256": hashlib.sha256(frame.tobytes()).hexdigest()})
    if media:
        import cv2
        import numpy as np
        for k in ROUNDS:
            s = next(c for c in samples if c["round"] == k)
            n = s["clip"]["pre_decision_to"]
            cap = cv2.VideoCapture(str(ROOT/s["clip"]["video"]))
            for _ in range(n + 1):
                ok, frame = cap.read()
                if not ok:
                    raise ValueError("Sequential decode failed")
            cap.release()
            if not np.array_equal(frame, read_frame(ROOT/s["clip"]["video"], n)):
                errors.append(f"seek mismatch r{k} f{n}")
    result = {"passed": not errors, "samples": len(samples), "errors": errors,
              "media_frames_checked": len(checks), "frame_checks": checks,
              "sequential_seek_crosschecks": len(ROUNDS) if media else 0,
              "alignment_status": "mapping arithmetic checked; residuals in alignment.json; physical clock remains unverified",
              "not_human_review": True}
    write(out/"validation.json", result)
    print(json.dumps({k:v for k,v in result.items() if k != "frame_checks"}))
    if errors:
        raise ValueError(errors)


def report(out):
    out = Path(out)
    samples, population, rounds, labels = [read(out/f"{name}.json") for name in ("samples","population","rounds","labels")]
    minutes = sum(r["alive_minutes"] for r in rounds)
    def total(rows):
        return round(sum(c["seq_contact"].get("hp_loss") or 0 for c in rows), 6)
    summary = {"units": "maxHP from offline HP-bar detector; no absolute HP calibration",
               "minutes": minutes, "population_contacts": len(population), "sample_contacts": len(samples),
               "population_loss_maxHP": total(population), "sample_loss_maxHP": total(samples),
               "groups": {}, "confirmed_defense_mismatch": [], "confirmed_parryable_timing": [],
               "unknown_sample_damage_maxHP": 0.0, "direct_resource_blocks": []}
    for group in ("A","B"):
        rows = [c for c in samples if c["source_group"] == group]
        summary["groups"][group] = {"n": len(rows), "hit_candidates": sum(c["seq_contact"]["type"]=="hit" for c in rows),
                                     "ok_candidates": sum(c["seq_contact"]["type"]=="ok" for c in rows),
                                     "damage_maxHP": total(rows), "population_estimate": None}
    for s in samples:
        lab = labels[s["sample_id"]]
        st3 = lab.get("stage3") or {}
        st2 = (lab.get("stage2_revisions") or [{}])[-1].get("value") or lab.get("stage2_original") or {}
        reliable = st3.get("source") in ("human_confirmed","other_reliable_evidence") and evidence_complete(st3.get("evidence"))
        if reliable and st3.get("defense_mismatch") == "confirmed":
            summary["confirmed_defense_mismatch"].append(s["sample_id"])
        if reliable and st3.get("timing_or_execution_problem") == "confirmed" and st2.get("parryability") == "confirmed_parryable":
            summary["confirmed_parryable_timing"].append(s["sample_id"])
        if not (reliable and any(st3.get(key) == "confirmed" for key in
                                ("defense_mismatch","timing_or_execution_problem","resource_conflict"))):
            summary["unknown_sample_damage_maxHP"] += s["seq_contact"].get("hp_loss") or 0
        ev = read(out/"evidence"/f"{s['sample_id']}.json")
        near = [e for e in ev["events"] if e["kind"] == "blocked"
                and s["seq_contact"]["t"] - 30 <= e["estimated_video_frame"] <= s["seq_contact"]["t"]]
        for e in near:
            summary["direct_resource_blocks"].append({"sample_id": s["sample_id"], **e,
                                                      "scope": "scheduler blocked; damage causal link unknown"})
    confirmed = [s for s in samples if s["sample_id"] in summary["confirmed_defense_mismatch"]]
    # Only directly labelled contacts. Never automatically attach subsequent chain losses.
    summary["confirmed_mismatch_damage_maxHP"] = total(confirmed)
    summary["confirmed_mismatch_roots"] = sorted({s["root_id"] for s in confirmed if s["root_id"]})
    unique_blocks = {(e["sample_id"].split("-")[0], e["event_index"]):e for e in summary["direct_resource_blocks"]}
    summary["unique_nearby_block_events"] = len(unique_blocks)
    summary["samples_with_nearby_block"] = len({e["sample_id"] for e in summary["direct_resource_blocks"]})
    summary["human_confirmed_sample_count"] = sum(bool(l["human_confirmed"]) for l in labels.values())
    flagged = [c for c in population if c["seq_contact"]["type"] == "hit"
               and c.get("feature_at_anchor", {}).get("grey", 0) >= .85]
    summary["screen_state_quality_flags"] = [
        {"sample_id": c["sample_id"], "raw_loss_maxHP": c["seq_contact"]["hp_loss"],
         "grey": c["feature_at_anchor"]["grey"], "frame": c["seq_contact"]["t"],
         "source": "agent_candidate", "status": "suspect_HP_measurement_on_grey_screen_not_automatically_removed"}
        for c in flagged]
    summary["screen_state_suspect_maxHP"] = total(flagged)
    summary["sensitivity_excluding_screen_flags_maxHP"] = round(total(population)-total(flagged),6)
    summary["theoretical_sample_upper_bound_maxHP"] = total(confirmed)
    summary["theoretical_sample_upper_bound_maxHP_per_recorded_minute"] = total(confirmed)/minutes
    summary["unknown_sample_damage_maxHP"] = round(summary["unknown_sample_damage_maxHP"], 6)
    summary["unknown_sample_damage_fraction"] = (summary["unknown_sample_damage_maxHP"]/total(samples)) if total(samples) else None
    summary["interpretation"] = "Confirmed set only; zero confirmed is NOT zero actual mismatch. No win-rate inference."
    write(out/"analysis.json", summary)
    lines = ["# 离线攻击证据审计：生成数据摘要", "",
             f"此报告是复核数据的可复算摘要；人工确认样本 {summary['human_confirmed_sample_count']}。阅读仓库 docs/attack-evidence-audit.md 的定义与限制。",
             "", f"完整现有 seq 清单 {len(population)} 个候选接触；抽取 {len(samples)} 个。"
             "未建立全部视觉攻击分母，不能计算全部攻击失败率。A/B 分开；不输出总体错误率。",
             "", "|轮次|日志结果|录像时长分母 min（alive）|seq hit/ok|运行时 hit/ok|根 direct maxHP|全 hit maxHP|maxHP/min|",
             "|---|---|---:|---:|---:|---:|---:|---:|"]
    for r in rounds:
        p = [c for c in population if c["round"]==r["round"]]
        lines.append(f"|{r['round']}|{r['result_from_log']}|{r['alive_minutes']:.4f}|{r['seq_hits']}/{r['seq_ok']}|"
                     f"{r['runtime_hits']}/{r['runtime_ok']}|{total([c for c in p if c['is_root']]):.3f}|"
                     f"{total(p):.3f}|{total(p)/r['alive_minutes']:.3f}|")
    lines += ["", "|来源|样本数|hit 候选|ok 候选|样本损伤 maxHP|", "|---|---:|---:|---:|---:|"]
    for g,x in summary["groups"].items():
        lines.append(f"|{g}|{x['n']}|{x['hit_candidates']}|{x['ok_candidates']}|{x['damage_maxHP']:.3f}|")
    lines += ["", f"已确认防法不匹配 {len(confirmed)} 个样本，{len(summary['confirmed_mismatch_roots'])} 根；"
              f"已确认集合损伤 {total(confirmed):.3f} maxHP。全部消除该已确认集合的样本内理论上限 "
              f"{total(confirmed):.3f} maxHP / {total(confirmed)/minutes:.6f} maxHP/记录分钟（{minutes:.4f} min）。"
              "这是已确认集合的核算值，不是所有未知防法错误的上界，更不是预计实战收益。",
              f"已证实可卸且时序/执行有问题：{len(summary['confirmed_parryable_timing'])} 个确认样本。",
              f"未获可靠因果确认的样本损伤：{summary['unknown_sample_damage_maxHP']:.3f} maxHP "
              f"（{100*(summary['unknown_sample_damage_fraction'] or 0):.1f}%）。",
              f"灰屏读条质量标记 {len(flagged)} 个候选，共 {total(flagged):.3f} maxHP；未自动删除。"
              f"全清单原始读条损伤 {total(population):.3f} maxHP，排除质量标记的敏感性值 "
              f"{summary['sensitivity_excluding_screen_flags_maxHP']:.3f} maxHP。二者均不是人工核实的真实受伤总量。",
              "normal 是规则残余类别，真实招式/段号/条件仍未知。资源 blocked 日志只直接证明调度器阻止了命令。",
              f"样本接触代理时刻前 30f 内，{summary['samples_with_nearby_block']} 个样本附近有 "
              f"{summary['unique_nearby_block_events']} 条去重 blocked 日志；并非这些接触由资源冲突造成的计数。",
              "", "样本索引（阶段一界面隐藏来源、结果、日志；此表仅用于审计导航）：",
              "", "|sample_id|A/B|轮次 / 帧 / 秒|seq 类型 / 类别|直接损伤 maxHP|候选对照|",
              "|---|---|---|---|---:|---|"]
    for s in samples:
        c=s["seq_contact"]
        lines.append(f"|{s['sample_id']}|{s['source_group']}|{s['round']} / {c['t']} / {c['t']/30:.3f}|"
                     f"{c['type']} / {s['seq_kind']}|{c.get('hp_loss') or 0:.3f}|{s.get('candidate_pair','')}|")
    (out/"REPORT.md").write_text("\n".join(lines)+"\n",encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("build", "validate", "report", "serve", "sheets"):
        p = sub.add_parser(name)
        p.add_argument("--out", type=Path, default=DEFAULT_OUT)
        if name == "build":
            p.add_argument("--count", type=int, choices=(20,90), default=20)
            p.add_argument("--seed", type=int, default=SEED)
            p.add_argument("--pilot", type=Path)
        if name == "validate":
            p.add_argument("--media", action="store_true")
        if name == "serve":
            p.add_argument("--port", type=int, default=8873)
    a=parser.parse_args()
    if a.command == "build":
        build(a.out, a.count, a.seed, a.pilot)
    elif a.command == "validate":
        validate(a.out, a.media)
    elif a.command == "report":
        report(a.out)
    elif a.command == "sheets":
        sheets(a.out)
    else:
        from attack_review.server import serve
        serve(a.out, a.port)


if __name__ == "__main__":
    main()
