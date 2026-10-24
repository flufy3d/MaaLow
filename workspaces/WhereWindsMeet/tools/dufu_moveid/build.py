"""Align every round's trace clock to its recording and build the move-ID index.

    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/build.py

Needs pull.py first (data/moveid/meta/<id>.json, bars/<id>.npz with the per-frame hp bar / boss 真气 reads).

Alignment. Any trace time t (ms since the skill start; `cap` and `wall` share this clock) maps to the video frame
    frame(t) = (start + t - meta.started) / FRAME_MS + offset
where `offset` is one constant per round (recording start latency, a few frames). Per contact of labels.contacts():
the row that first saw the change has a "seen" time (midpoint of the previous and this row's capture, labels._seen);
the video step frame is the first frame whose hp bar (hit) / 真气 line (ok) reads lower than the frames before it.
d = step - frame0(seen) with frame0 = the formula without offset. offset = median(d) over the round's hits (the hp bar
is the reliable reader; ok steps are reported separately, ~30 % of them sit 6-12 f early, see dufu_train/README.md).
residual = d - offset. Steps are searched near frame0 + a coarse per-round offset (the peak of all hp-step
candidates within +-25 f of the hits), within +-MATCH_F frames; a contact without a step there has no residual.

Outputs (data/moveid/):
  index.json      {"rounds": [...], "events": [...], "fields": {...}}  (field docs inside, and in README.md)
  decisions.json  [{rec, round, event, frame}] contact frame - DECISION_F, for gate 0
  align.txt       per-round offset / residual table
"""
from __future__ import annotations

from collections import Counter

import numpy as np

from common import BARS, META, OUT, REPO, STATUS, VIDEO, read_json, rounds, write_json

from data import FRAME_MS, load_round
from labels import _seen, contacts

HP_TH, QI_TH = 0.02, 6
COARSE_F, MATCH_F = 25, 6
DECISION_F = 10
PRESS_LOOKBACK_F = 45  # our presses this far before a contact are listed with it


def ffill(x: np.ndarray, bad) -> np.ndarray:
    """Unreadable frames (bad mask) take the last readable value (the first ones the first readable)."""
    x = x.astype(np.float64).copy()
    ok = ~bad
    if not ok.any():
        return x
    idx = np.where(ok, np.arange(len(x)), 0)
    np.maximum.accumulate(idx, out=idx)
    first = int(np.argmax(ok))
    idx[:first] = first
    return x[idx]


def steps_fast(x: np.ndarray, th: float, base_n: int = 4) -> np.ndarray:
    """Frames f where the reading falls >= th below the median of the base_n frames before it and stays there (median
    of f..f+2 >= 0.75 th below), the first frame of each such run."""
    n = len(x)
    if n < base_n + 3:
        return np.array([], np.int64)
    x = x.astype(np.float64)
    win = np.lib.stride_tricks.sliding_window_view(x, base_n)  # win[k] = x[k:k+base_n]
    base = np.median(win, axis=1)[: n - base_n]  # base for f = k + base_n
    fwd = np.median(np.lib.stride_tricks.sliding_window_view(x, 3), axis=1)  # fwd[f] = median x[f:f+3]
    f = np.arange(base_n, n - 2)
    b = base[f - base_n]
    m = (b - x[f] >= th) & (b - fwd[f] >= th * 0.75)
    first = m & ~np.concatenate([[False], m[:-1]])
    return f[first]


def nearest(cands: np.ndarray, center: float, tol: float):
    if not len(cands):
        return None
    j = int(np.argmin(np.abs(cands - center)))
    return int(cands[j]) if abs(cands[j] - center) <= tol else None


def ires(x: float, lo: float, hi: float, signed: bool = False) -> float:
    """Distance of step frame x (offset removed) outside the window [lo, hi + 1]; + late, - early."""
    if x > hi + 1:
        return x - hi - 1
    if x < lo:
        return (x - lo) if signed else lo - x
    return 0.0


def align(r, meta: dict, bars) -> tuple[dict, list]:
    cs = contacts(r)
    hp = bars["hp"]
    hp_steps = steps_fast(ffill(hp, np.isnan(hp)), HP_TH)
    qi = ffill(bars["qi"], bars["qi"] < 0)
    qi_steps = steps_fast(qi, QI_TH)
    qi_steps = qi_steps[qi[np.maximum(qi_steps - 4, 0)] >= 4]
    k = (r.start - meta["started"]) / FRAME_MS
    f0 = [k + _seen(r, c.row) / FRAME_MS for c in cs]
    # coarse offset: the peak of hp-step candidates around the hits (smoothed over 3 frames)
    hist = Counter()
    for c, f in zip(cs, f0):
        if c.kind == "hit":
            for s in hp_steps[(hp_steps >= f - COARSE_F) & (hp_steps <= f + COARSE_F)]:
                hist[int(round(s - f))] += 1
    coarse = 0.0
    if hist:
        sm = {d: hist[d - 1] + 2 * hist[d] + hist[d + 1] for d in range(-COARSE_F, COARSE_F + 1)}
        coarse = float(max(sm, key=lambda d: (sm[d], -abs(d))))
    # per contact: the step frame s and the trace interval [lo, hi] (frames, no offset) in which the change happened:
    # between the previous row's capture and the capture of the row that first saw it
    per, m = [], []
    for c, f in zip(cs, f0):
        s = nearest(hp_steps if c.kind == "hit" else qi_steps, f + coarse, MATCH_F)
        lo = k + float(r.cap[max(c.row - 1, 0)]) / FRAME_MS
        hi = k + float(r.cap[c.row]) / FRAME_MS
        per.append(None if s is None else (s, f, lo, hi))
        if s is not None:
            m.append((c.kind, s, f, lo, hi))
    hits = [x for x in m if x[0] == "hit"] or m
    off_mid = float(np.median([x[1] - x[2] for x in hits])) if hits else coarse
    # interval fit: the first frame showing a change at t in (lo, hi] is in (lo, hi + 1]; offset = the middle of the
    # range minimising sum |distance to that window| over the hits
    if hits:
        grid = np.arange(coarse - MATCH_F - 2, coarse + MATCH_F + 2, 0.05)
        cost = np.array([sum(ires(x[1] - o, x[3], x[4]) for x in hits) for o in grid])
        best = grid[cost <= cost.min() + 1e-9]
        off = float(np.round((best.min() + best.max()) / 2, 2))
    else:
        off = coarse

    def stats(kind):
        xs = [x for x in m if kind is None or x[0] == kind]
        if not xs:
            return {"n": 0, "within1": None, "within2": None, "mid_within1": None, "mad_mid": None}
        rm = np.array([x[1] - x[2] - off_mid for x in xs])
        ri = np.array([ires(x[1] - off, x[3], x[4], signed=True) for x in xs])
        return {"n": len(xs), "within1": round(float(np.mean(np.abs(ri) <= 1)), 3),
                "within2": round(float(np.mean(np.abs(ri) <= 2)), 3),
                "mid_within1": round(float(np.mean(np.abs(rm) <= 1)), 3), "mad_mid": round(float(np.median(np.abs(rm))), 2)}

    src = "hits" if any(x[0] == "hit" for x in m) else "oks" if m else "none"
    info = {"offset": off, "offset_src": src, "offset_mid": round(off_mid, 2), "coarse": coarse, "k": round(float(k), 2),
            "hits": sum(c.kind == "hit" for c in cs), "oks": sum(c.kind == "ok" for c in cs),
            "hit_res": stats("hit"), "ok_res": stats("ok"), "all_res": stats(None)}
    per = [None if p is None else ires(p[0] - off, p[2], p[3], signed=True) for p in per]
    return info, list(zip(cs, per))


def presses(r) -> list[tuple[float, str]]:
    return [(float(e[1]), "parry" if str(e[3]).startswith("parry") else "dodge" if str(e[3]).startswith("dodge")
             else str(e[3]).split()[0]) for e in r.events if e[2] == "press"]


def main() -> None:
    status = read_json(STATUS, {})
    rows, events, decisions, lines = [], [], [], []
    for rd in rounds():
        rid = rd["rec"]
        st = status.get(rid) or {}
        meta = read_json(META / f"{rid}.json")
        bp = BARS / f"{rid}.npz"
        if not st.get("ok") or meta is None or not bp.exists():
            print(f"{rd['key']} {rid}: not pulled/verified, skipped")
            continue
        r = load_round(rd["dir"])
        if r is None:
            print(f"{rd['key']}: incomplete round, skipped")
            continue
        bars = np.load(bp)
        if "v" not in bars.files or int(bars["v"]) != 2:
            print(f"{rd['key']} {rid}: old bars (re-run pull.py), skipped")
            continue
        info, cps = align(r, meta, bars)
        k, off = (r.start - meta["started"]) / FRAME_MS, info["offset"]
        args = read_json(rd["dir"] / "args.json")
        lag = r.wall - r.cap
        pr = presses(r)
        n_ev0 = len(events)
        for j, (c, d) in enumerate(cps):
            cf = float(k + c.t / FRAME_MS + off)
            wall_t = float(c.t + lag[c.row])  # contact on the loop clock (labels._outcomes uses the same for press leads)
            before = [(t, kind) for t, kind in pr if 0 <= (wall_t - t) / FRAME_MS <= PRESS_LOOKBACK_F]
            last = {}
            for t, kind in before:
                last[kind] = t
            prev_c = float(cps[j - 1][0].t + lag[cps[j - 1][0].row]) if j else -1e18
            ev = {
                "id": len(events), "rec": rid, "round": rd["key"], "kind": c.kind, "outcome": c.outcome,
                "flare": bool(c.dodge),
                "type": "flare" if c.dodge else ("grab" if c.outcome == "grab" else c.kind if c.kind == "ok"
                                                 else "hit_pf" if c.outcome == "pf" else "hit_unk"),
                "row": int(c.row), "t_ms": round(float(c.t), 1), "frame": int(round(cf)), "frame_f": round(cf, 2),
                "step_res": None if d is None else round(float(d), 2),
                "parry_lead_f": None if "parry" not in last else round(float(wall_t - last["parry"]) / FRAME_MS, 2),
                "dodge_lead_f": None if "dodge" not in last else round(float(wall_t - last["dodge"]) / FRAME_MS, 2),
                "presses": [{"key": kind, "lead_f": round(float(wall_t - t) / FRAME_MS, 2),
                             "frame": int(round(k + t / FRAME_MS + off)), "since_prev_contact": bool(t > prev_c)}
                            for t, kind in before],
            }
            events.append(ev)
            decisions.append({"rec": rid, "round": rd["key"], "event": ev["id"], "type": ev["type"],
                              "frame": ev["frame"] - DECISION_F, "contact_frame": ev["frame"]})
        rows.append({
            "round": rd["key"], "rec": rid, "video": str((VIDEO / f"{rid}.mp4").relative_to(REPO)).replace("\\", "/"),
            "trace": str((rd["dir"] / "trace.json").relative_to(REPO)).replace("\\", "/"),
            "frames": st["frames"], "meta_frames": st["meta_frames"], "size": st["size"],
            "start": int(r.start), "rec_started": int(meta["started"]), "k": round(float(k), 3), "offset": off,
            "offset_mid": info["offset_mid"], "offset_src": info["offset_src"],
            "args": args, "reason": r.reason, "rows": int(r.n), "events": [n_ev0, len(events)],
            **{f: info[f] for f in ("coarse", "hits", "oks", "hit_res", "ok_res", "all_res")},
        })
        h, o = info["hit_res"], info["ok_res"]
        lines.append(f"{rd['key']} {rid} off {off:+6.2f} (coarse {info['coarse']:+.0f}) hits {h['n']}/{info['hits']} "
                     f"<=1f {h['within1']} oks {o['n']}/{info['oks']} <=1f {o['within1']}")
        print(lines[-1], flush=True)

    # rounds without a matched contact (no events to place): the median offset of the others
    med = float(np.median([x["offset"] for x in rows if x["offset_src"] != "none"]))
    for x in rows:
        if x["offset_src"] == "none":
            x["offset"], x["offset_src"] = round(med, 2), "median of rounds"
            print(f"{x['round']}: no matched contact, offset = median {med:.2f}")

    fields = {
        "rounds": {
            "round": "data/p2/rNNN (or p2b/rNNN for recordings only p2b has)", "rec": "recording id",
            "video": "mp4 path from the repo root", "trace": "trace.json path", "frames": "decoded frame count",
            "meta_frames": "frames in the Pad's meta", "start": "skill start, epoch ms (trace clock origin)",
            "rec_started": "recording meta `started`, epoch ms",
            "k": "(start - rec_started) / FRAME_MS", "offset": "per-round constant: frame(t) = k + t / FRAME_MS + offset",
            "offset_src": "hits | oks (no hit matched) | median of rounds (no contact matched)",
            "offset_mid": "median(step frame - frame of the seen midpoint) over the hits (dufu_train check_align style)",
            "args": "args.json of the round (null when absent)", "reason": "result.json value.reason (end cause)",
            "rows": "trace rows", "events": "[first, end) slice of `events` for this round",
            "hit_res / ok_res / all_res": "matched steps: n; within1 / within2 = share with |interval residual| <= 1 / 2 f "
                                          "(distance outside [lo, hi + 1]); mid_within1 / mad_mid = midpoint residual (step - "
                                          "seen midpoint - offset_mid) share <= 1 f / median |.|",
        },
        "events": {
            "id": "index into events", "kind": "hit | ok (labels.contacts)",
            "outcome": "ok | pf (hit despite a 卸势 4-15 f before) | unk (hit, no timely 卸势) | grab (grab-cutscene tick)",
            "flare": "a 金光 contact (flare onset 2-30 f before; labels: dodge wanted)",
            "type": "flare | grab | ok | hit_pf | hit_unk (flare first, then grab)",
            "row": "trace row that first showed it", "t_ms": "contact time, capture clock, ms since start (hit = seen - 5 f)",
            "frame": "contact video frame (rounded)", "frame_f": "unrounded",
            "step_res": "this contact's step residual vs the round offset (null: no step found within +-6 f)",
            "parry_lead_f / dodge_lead_f": "frames from our last 卸势 / 闪避 press to the contact (loop clock, as labels._outcomes)",
            "presses": f"our presses within {PRESS_LOOKBACK_F} f before the contact: key, lead_f, video frame, "
                       "since_prev_contact (after the previous contact)",
        },
        "decisions": f"contact frame - {DECISION_F}",
    }
    write_json(OUT / "index.json", {"fields": fields, "rounds": rows, "events": events}, indent=None)
    write_json(OUT / "decisions.json", decisions, indent=None)

    w1 = [x["hit_res"]["within1"] for x in rows if x["hit_res"]["n"]]
    good = sum(v >= 0.75 for v in w1)
    wm = [x["hit_res"]["mid_within1"] for x in rows if x["hit_res"]["n"]]
    goodm = sum(v >= 0.75 for v in wm)
    allres = []
    for e in events:
        if e["step_res"] is not None:
            allres.append((e["kind"], e["step_res"]))
    summ = [
        f"rounds {len(rows)}, events {len(events)}: " + ", ".join(f"{k} {v}" for k, v in Counter(e['type'] for e in events).most_common()),
        f"hit-step |res|<=1 share >= 0.75 in {good}/{len(w1)} rounds ({good / max(1, len(w1)):.1%}); "
        f"midpoint residual: {goodm}/{len(wm)} ({goodm / max(1, len(wm)):.1%})",
        f"matched: hits {sum(x['hit_res']['n'] for x in rows)}/{sum(x['hits'] for x in rows)}, "
        f"oks {sum(x['ok_res']['n'] for x in rows)}/{sum(x['oks'] for x in rows)}",
    ]
    for kind in ("hit", "ok"):
        rr = np.array([v for k_, v in allres if k_ == kind])
        if len(rr):
            summ.append(f"{kind}: matched {len(rr)}, |res|<=1 {np.mean(np.abs(rr) <= 1):.1%}, <=2 {np.mean(np.abs(rr) <= 2):.1%}, "
                        f"res quartiles {np.percentile(rr, [5, 25, 50, 75, 95]).round(2).tolist()}")
    offs = np.array([x["offset"] for x in rows if x["offset_src"] != "median of rounds"])
    if len(offs):
        summ.append(f"offset quartiles {np.percentile(offs, [0, 25, 50, 75, 100]).round(2).tolist()}")
    (OUT / "align.txt").write_text("\n".join(summ + [""] + lines) + "\n", encoding="utf-8")
    print("\n".join(summ))


if __name__ == "__main__":
    main()
