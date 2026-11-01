"""c11/c40 金光连段逐拍帧表：真值接触 -> 帧级 beat / tell / 状态时间线 / 收招窗口。

    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/c11_frames.py
    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/c11_frames.py --from 185 --to 223
    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/c11_frames.py r185 r186

只读 data/moveid/p1/live/rNNN/{contacts,result,trace}.json、rec.txt 与 live/meta/<rec>.json，
写 data/moveid/offense/online/c11_frames.{json,md,csv}（csv 可选）。不改原始数据。

两个口径：
- core29   ：全部 truth 接触按 gap <= 30 帧聚 episode，再筛首拍 dec.grp 含 c11/c40（r185–r219，29 条）。
- extended38：只取 c11/c40 truth 接触按 gap <= 30 帧聚 episode（r185–r223，38 条）。

帧映射（与 offense_episodes.py 一致）：
    k0      = (result.value.start - meta.started) / (1000/30)
    frame   = k0 + trace.cap / (1000/30) + contacts.offset
    press_f = k0 + pressLog[i][0] / (1000/30) + contacts.offset

每个 episode 给出 gold opener、tell（k0:c11 组连续高置信行）、逐拍按键/状态估计、逐帧状态时间线，
以及收招后的 post_gap / punish 窗口。所有状态窗口都是估计，常数见 PARAMS（est=true）。
"""
from __future__ import annotations

import argparse
import bisect
import collections
import csv
import math
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import FRAME_MS, REPO, read_json, write_json  # noqa: E402

LIVE = REPO / "data" / "moveid" / "p1" / "live"
META = LIVE / "meta"
MODEL = HERE.parents[1] / "model" / "dufu1" / "movetable.json"
OUT_DIR = REPO / "data" / "moveid" / "offense" / "online"
OUT_JSON = OUT_DIR / "c11_frames.json"
OUT_MD = OUT_DIR / "c11_frames.md"
OUT_CSV = OUT_DIR / "c11_frames.csv"

GAP_F = 30
DEFAULT_FROM, DEFAULT_TO = 185, 223
CORE_TO = 219
K1_SCAN_TO = 223

HITSTUN_F = 12
DODGE_IFRAME = (1, 5)
DODGE_LOCK_F = 12
PARRY_LOCK_F = 10
PARRY_CD_F = 7
STATE_PRIORITY = ("hitstun", "dodge_iframe", "parry_lock", "dodge_lock", "parry_cd", "idle")

GOLD_SEARCH_F = 90
TELL_LOOKBACK_F = 90
TELL_AHEAD_F = 2
TELL_GRPP = 0.5
TELL_RUN = 2
PUNISH_READY_F = 12
PUNISH_THRESHOLDS = (20, 42, 61)

PARAMS = {
    "fps": 30,
    "frame_ms": FRAME_MS,
    "gap_f": GAP_F,
    "c11_rule": "truth contact dec.grp contains c11 or c40",
    "cluster_core29": "all truth contacts sorted by frame, gap <= 30 f -> episode, keep episodes whose first beat is c11/c40",
    "cluster_extended38": "only c11/c40 truth contacts, gap <= 30 f -> episode",
    "frame_map": "k0=(result.start-meta.started)/FRAME_MS; frame=k0+trace.cap/FRAME_MS+contacts.offset; "
                 "press_f=k0+pressLog[i][0]/FRAME_MS+contacts.offset",
    "state_est": True,
    "hitstun_f": HITSTUN_F,
    "dodge_iframe_f": list(DODGE_IFRAME),
    "dodge_lock_f": DODGE_LOCK_F,
    "parry_lock_f": PARRY_LOCK_F,
    "parry_cd_f": PARRY_CD_F,
    "state_priority": list(STATE_PRIORITY),
    "gold_search_f": GOLD_SEARCH_F,
    "tell_window_f": [-TELL_LOOKBACK_F, TELL_AHEAD_F],
    "tell_grpp_min": TELL_GRPP,
    "tell_run_min": TELL_RUN,
    "tell_pick": "earliest qualifying run in the window (first telegraph onset); all runs and the last run are listed",
    "punish_ready_f": PUNISH_READY_F,
    "punish_thresholds_f": list(PUNISH_THRESHOLDS),
    "press_match_tol_f": 1.0,
    "note_state": "windows are fixed-frame estimates; parry_cd is a subset of parry_lock and never wins the priority",
}


# ---------------------------------------------------------------- helpers

def _num(value, nd: int = 2):
    """JSON-friendly number: integral floats -> int, others rounded; None stays None."""
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return value
    if not math.isfinite(v):
        return None
    return int(v) if v.is_integer() else round(v, nd)


def describe(values, nd: int = 2) -> dict:
    vals = sorted(float(v) for v in values if v is not None)
    if not vals:
        return {"n": 0, "min": None, "p25": None, "median": None, "p75": None, "max": None}
    return {"n": len(vals), "min": _num(vals[0], nd), "p25": _num(quantile(vals, 0.25), nd),
            "median": _num(statistics.median(vals), nd), "p75": _num(quantile(vals, 0.75), nd),
            "max": _num(vals[-1], nd)}


def quantile(values, p: float):
    s = sorted(float(v) for v in values if v is not None)
    if not s:
        return None
    x = (len(s) - 1) * p
    lo = int(math.floor(x))
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (x - lo)


def round_number(name: str) -> int:
    digits = "".join(ch for ch in str(name) if ch.isdigit())
    return int(digits) if digits else 0


def round_names(names, from_: int | None, to: int | None) -> list[str]:
    if names:
        out = [str(n).strip() if str(n).strip().startswith("r") else f"r{str(n).strip()}" for n in names]
    else:
        a = DEFAULT_FROM if from_ is None else int(from_)
        b = DEFAULT_TO if to is None else int(to)
        out = [f"r{i}" for i in range(a, b + 1)]
    return sorted(set(out), key=round_number)


def grp_of(contact: dict) -> str:
    return str((contact.get("dec") or {}).get("grp") or "")


def is_c11(grp: str) -> bool:
    s = str(grp or "")
    return "c11" in s or "c40" in s


def is_k0_c11(grp: str) -> bool:
    return str(grp or "").startswith("k0:") and is_c11(grp)


def parse_k(grp: str) -> int:
    m = grp[1:].split(":", 1)[0] if grp.startswith("k") else ""
    if not m.isdigit():
        return -1
    k = int(m)
    return k if 0 <= k <= 12 else -1


def cluster(contacts: list[dict], gap_f: int = GAP_F) -> list[list[dict]]:
    out: list[list[dict]] = []
    for c in sorted(contacts, key=lambda t: float(t["frame"])):
        f = float(c["frame"])
        if out and f - float(out[-1][-1]["frame"]) <= gap_f:
            out[-1].append(c)
        else:
            out.append([c])
    return out


def load_names() -> list[str]:
    table = read_json(MODEL, {}) or {}
    groups = table.get("groups") or {}
    size = max([int(v.get("gid", i)) for i, (_, v) in enumerate(groups.items())] + [-1]) + 1
    names = [""] * size
    for i, (name, ent) in enumerate(groups.items()):
        gid = int(ent.get("gid", i))
        if 0 <= gid < size:
            names[gid] = name
    return names


def _last_le(items: list[dict], t: float):
    lo, hi = 0, len(items)
    while lo < hi:
        mid = (lo + hi) // 2
        if items[mid]["frame"] <= t:
            lo = mid + 1
        else:
            hi = mid
    return items[lo - 1] if lo else None


# ---------------------------------------------------------------- round loading

def load_round(name: str, names: list[str], need_trace: bool = True) -> dict:
    d = LIVE / name
    contacts = read_json(d / "contacts.json")
    result = read_json(d / "result.json")
    if not isinstance(contacts, dict):
        return {"round": name, "skip": "contacts.json missing or unreadable"}
    if not isinstance(result, dict) or not isinstance(result.get("value"), dict):
        return {"round": name, "skip": "result.json missing or unreadable"}
    res = result["value"]
    rec_file = d / "rec.txt"
    rid = rec_file.read_text(encoding="utf-8").strip() if rec_file.exists() else ""
    meta = read_json(META / f"{rid}.json") if rid else None
    if not isinstance(meta, dict) or meta.get("started") is None or res.get("start") is None:
        return {"round": name, "skip": "meta/start missing"}
    k0 = (float(res["start"]) - float(meta["started"])) / FRAME_MS
    offset_value = contacts.get("offset")
    offset = 0.0 if offset_value is None else float(offset_value)
    k0_fight = None if res.get("t0") is None else (float(res["t0"]) - float(meta["started"])) / FRAME_MS
    video_end_f = None
    if k0_fight is not None and res.get("fightMs") is not None:
        video_end_f = k0_fight + float(res["fightMs"]) / FRAME_MS + offset

    presses = []
    for i, p in enumerate(res.get("pressLog") or []):
        if not isinstance(p, (list, tuple)) or len(p) < 10:
            continue
        gid = int(p[2]) if isinstance(p[2], (int, float)) else -1
        frame = k0 + float(p[0]) / FRAME_MS + offset
        rem = p[7]
        presses.append({"i": i, "t": p[0], "kind": str(p[1]), "gid": gid,
                        "group": names[gid] if 0 <= gid < len(names) else "",
                        "frame": frame, "remF": None if rem is None else float(rem),
                        "lead": None if p[8] is None else float(p[8]), "src": p[9],
                        "pred": None if rem is None else frame + float(rem)})
    presses.sort(key=lambda x: x["frame"])
    by_kind: dict[str, list[dict]] = collections.defaultdict(list)
    for p in presses:
        by_kind[p["kind"]].append(p)

    truth = contacts.get("truth") or []
    hits = sorted(({"frame": float(t["frame"]), "grp": grp_of(t)} for t in truth if t.get("kind") == "hit"),
                  key=lambda x: x["frame"])

    trace_rows: list[dict] = []
    if need_trace:
        trace = read_json(d / "trace.json")
        if not isinstance(trace, list) or not trace:
            return {"round": name, "skip": "trace.json missing or unreadable"}
        chunks = sorted(trace, key=lambda c: c.get("chunk", 0))
        cols = chunks[0].get("cols") or []
        if not cols:
            return {"round": name, "skip": "trace cols missing"}
        C = {c: i for i, c in enumerate(cols)}
        raw = [r for ch in chunks for r in (ch.get("rows") or [])]
        raw.sort(key=lambda r: float(r[C["cap"]]))
        trace_rows = [{"frame": k0 + float(r[C["cap"]]) / FRAME_MS + offset,
                       "grp": names[int(r[C["grp"]])] if 0 <= int(r[C["grp"]]) < len(names) else "",
                       "grpP": float(r[C["grpP"]]), "gid": int(r[C["grp"]]),
                       "hp": r[C["hp"]] if "hp" in C else None, "qi": r[C["qi"]] if "qi" in C else None,
                       "boss": r[C["boss"]] if "boss" in C else None, "med": r[C["med"]] if "med" in C else None}
                      for r in raw]

    return {"round": name, "skip": None, "rec": rid, "args": read_json(d / "args.json", {}) or {},
            "contacts": contacts, "truth": truth, "hits": hits, "presses": presses, "by_kind": by_kind,
            "k0": k0, "k0_fight": k0_fight, "offset": offset, "offset_missing": offset_value is None,
            "video_end_f": video_end_f, "video_end_base": "t0" if res.get("t0") is not None else "start_fallback",
            "fight_f": None if res.get("fightMs") is None else float(res["fightMs"]) / FRAME_MS,
            "trace": trace_rows, "trace_frames": [r["frame"] for r in trace_rows]}


# ---------------------------------------------------------------- state machine

def state_at(t: float, hits: list[dict], by_kind: dict[str, list[dict]]) -> tuple[str, dict | None]:
    """Fixed-window state estimate at time t; priority hitstun > dodge_iframe > parry_lock > dodge_lock > parry_cd."""
    h = _last_le(hits, t)
    hit_hit = h is not None and t <= h["frame"] + HITSTUN_F
    d = _last_le(by_kind.get("dodge") or [], t)
    d_iframe = d is not None and d["frame"] + DODGE_IFRAME[0] <= t <= d["frame"] + DODGE_IFRAME[1]
    d_lock = d is not None and d["frame"] <= t <= d["frame"] + DODGE_LOCK_F
    p = _last_le(by_kind.get("parry") or [], t)
    p_lock = p is not None and p["frame"] <= t <= p["frame"] + PARRY_LOCK_F
    p_cd = p is not None and p["frame"] <= t <= p["frame"] + PARRY_CD_F
    if hit_hit:
        return "hitstun", {"type": "hit", "frame": _num(h["frame"]), "grp": h["grp"]}
    if d_iframe:
        return "dodge_iframe", _press_src(d)
    if p_lock:
        return "parry_lock", _press_src(p)
    if d_lock:
        return "dodge_lock", _press_src(d)
    if p_cd:
        return "parry_cd", _press_src(p)
    return "idle", None


def _press_src(p: dict) -> dict:
    return {"type": "press", "key": p["kind"], "frame": _num(p["frame"]), "src": p["src"], "group": p["group"]}


def _src_key(src: dict | None) -> tuple:
    if not src:
        return ()
    return tuple(sorted((k, str(v)) for k, v in src.items()))


def build_timeline(rd: dict, opener_f: float, end: float, tell_f: float | None) -> dict:
    start = min(tell_f, opener_f - 10) if tell_f is not None else opener_f - 10
    f0, f1 = int(math.floor(start)), int(math.ceil(end + 30))
    segments: list[dict] = []
    counts = collections.Counter()
    for t in range(f0, f1 + 1):
        st, src = state_at(float(t), rd["hits"], rd["by_kind"])
        counts[st] += 1
        if segments and segments[-1]["state"] == st and _src_key(segments[-1].get("src")) == _src_key(src):
            segments[-1]["to"] = t
        else:
            segments.append({"from": t, "to": t, "state": st, "src": src})
    return {"from": f0, "to": f1, "segments": segments, "frames_by_state": dict(counts)}


# ---------------------------------------------------------------- gold / tell

def find_gold_press(rd: dict, anchor: float) -> dict | None:
    best = None
    for p in rd["presses"]:
        if p["kind"] != "dodge" or not is_k0_c11(p["group"]):
            continue
        delta = float(p["frame"]) - float(anchor)
        if abs(delta) > GOLD_SEARCH_F:
            continue
        if best is None or abs(delta) < abs(best["delta"]):
            best = {"frame": p["frame"], "delta": delta, "remF": p["remF"], "lead": p["lead"],
                    "src": p["src"], "group": p["group"], "pred": p["pred"] if p["pred"] is not None else p["frame"]}
    return best


def _runs(frames: list[float], lo: int, hi: int, pred) -> list[list[int]]:
    runs: list[list[int]] = []
    cur: list[int] = []
    for i in range(lo, hi):
        if pred(i):
            if cur and i == cur[-1] + 1:
                cur.append(i)
            else:
                if cur:
                    runs.append(cur)
                cur = [i]
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) >= TELL_RUN]


def _run_row(rd: dict, run: list[int]) -> dict:
    rows = [rd["trace"][i] for i in run]
    return {"from": _num(rows[0]["frame"]), "to": _num(rows[-1]["frame"]), "rows": len(rows),
            "grp": rows[0]["grp"], "p": _num(max(r["grpP"] for r in rows))}


def find_tell(rd: dict, opener_f: float) -> dict:
    frames = rd["trace_frames"]
    lo = bisect.bisect_left(frames, opener_f - TELL_LOOKBACK_F)
    hi = bisect.bisect_right(frames, opener_f + TELL_AHEAD_F)

    def ok_k0(i: int) -> bool:
        r = rd["trace"][i]
        return is_k0_c11(r["grp"]) and r["grpP"] >= TELL_GRPP

    runs = _runs(frames, lo, hi, ok_k0)
    kind = "k0_grpp"
    if not runs:
        # fallback: any >=2 consecutive rows with the same c11 group name, regardless of prefix / grpP
        def ok_same(i: int) -> bool:
            r, prev = rd["trace"][i], rd["trace"][i - 1]
            return is_c11(r["grp"]) and r["grp"] == prev["grp"]

        runs = _runs(frames, lo, hi, ok_same)
        kind = "any_same_group" if runs else None
    if not runs:
        return {"found": False, "kind": None, "f": None, "grp": None, "p": None, "lead_f": None,
                "rows": 0, "n_runs": 0, "runs": [], "last_run": None, "last_lead_f": None,
                "window": [_num(opener_f - TELL_LOOKBACK_F), _num(opener_f + TELL_AHEAD_F)]}
    row = _run_row(rd, min(runs, key=lambda r: r[0]))
    last = _run_row(rd, runs[-1])
    return {"found": True, "kind": kind, "f": row["from"], "grp": row["grp"], "p": row["p"],
            "lead_f": _num(opener_f - row["from"]), "rows": row["rows"], "n_runs": len(runs),
            "runs": [_run_row(rd, r) for r in runs], "last_run": last,
            "last_lead_f": _num(opener_f - last["from"]),
            "window": [_num(opener_f - TELL_LOOKBACK_F), _num(opener_f + TELL_AHEAD_F)]}


# ---------------------------------------------------------------- episodes

def build_beat(rd: dict, contact: dict, i: int, prev: float | None, start: float) -> dict:
    frame = float(contact["frame"])
    dec = contact.get("dec") or {}
    grp = str(dec.get("grp") or "")
    presses = []
    for pr in contact.get("presses") or []:
        key, lead = pr.get("key"), pr.get("lead")
        pf = None if lead is None else frame - float(lead)
        match = None
        if pf is not None and key:
            cand = [p for p in rd["by_kind"].get(str(key)) or [] if abs(p["frame"] - pf) <= 1.0]
            if cand:
                match = min(cand, key=lambda p: abs(p["frame"] - pf))
        st, src = state_at(pf, rd["hits"], rd["by_kind"]) if pf is not None else (None, None)
        presses.append({"key": key, "lead": _num(lead), "source": match["src"] if match else None,
                        "frame": _num(pf), "remF": _num(match["remF"]) if match else None,
                        "group": match["group"] if match else None,
                        "state": st, "state_src": src})
    prev_hits = [h["frame"] for h in rd["hits"] if h["frame"] < frame - 0.01]
    age = None if not prev_hits else frame - max(prev_hits)
    st, src = state_at(frame, rd["hits"], rd["by_kind"])
    return {"i": i, "frame": _num(frame), "gap": None if prev is None else _num(frame - prev),
            "off": _num(frame - start), "grp": grp, "k": parse_k(grp), "kind": contact.get("kind"),
            "colour": contact.get("colour"), "truth_resp": dec.get("truth_resp"), "dec_resp": dec.get("resp"),
            "dec_grp": grp, "med": _num(dec.get("med")), "hitstun_age_f": _num(age),
            "in_hitstun": age is not None and age <= HITSTUN_F, "state": st, "state_src": src,
            "presses": presses, "press_keys": [p["key"] for p in presses if p["key"]]}


def build_episode(rd: dict, chunk: list[dict], source: str, idx: int) -> dict:
    start, end = float(chunk[0]["frame"]), float(chunk[-1]["frame"])
    beats, prev = [], None
    for i, contact in enumerate(chunk):
        b = build_beat(rd, contact, i, prev, start)
        beats.append(b)
        prev = float(contact["frame"])

    c11_beats = [b for b in beats if is_c11(b["grp"])]
    gold_beat = next((b for b in c11_beats if b["colour"] == "gold"), None)
    if gold_beat is not None:
        opener_f, opener_src = float(gold_beat["frame"]), "gold_contact"
        gold = {"found": True, "frame": gold_beat["frame"], "kind": gold_beat["kind"],
                "colour": gold_beat["colour"], "beat_i": gold_beat["i"], "press": None}
    else:
        press = find_gold_press(rd, start)
        opener_f = float(press["pred"]) if press else start
        opener_src = "press_pred" if press else "episode_start"
        gold = {"found": False, "frame": None, "kind": None, "colour": None, "beat_i": None,
                "press": None if press is None else {"frame": _num(press["frame"]), "delta": _num(press["delta"]),
                                                      "remF": _num(press["remF"]), "lead": _num(press["lead"]),
                                                      "src": press["src"], "group": press["group"],
                                                      "pred": _num(press["pred"])}}
    gold["opener_f"] = _num(opener_f)
    gold["opener_source"] = opener_src

    tell = find_tell(rd, opener_f)
    timeline = build_timeline(rd, opener_f, end, tell["f"] if tell["found"] else None)

    next_contact = next((t for t in rd["truth"] if float(t["frame"]) > end), None)
    post_gap, base, clamped = None, None, False
    if next_contact is not None:
        post_gap = float(next_contact["frame"]) - end
        base = "next_contact"
    elif rd["video_end_f"] is not None:
        post_gap = max(0.0, float(rd["video_end_f"]) - end)
        base = "video_end"
        clamped = float(rd["video_end_f"]) < end
    punish = {"post_gap_f": _num(post_gap), "punish_window_f": _num(post_gap),
              "punish_ready_f": _num(end + PUNISH_READY_F), "base": base, "clamped": clamped,
              "next_contact": None if next_contact is None else {
                  "frame": _num(float(next_contact["frame"])), "grp": grp_of(next_contact),
                  "kind": next_contact.get("kind")},
              "ge20": None if post_gap is None else post_gap >= 20,
              "ge42": None if post_gap is None else post_gap >= 42,
              "ge61": None if post_gap is None else post_gap >= 61}

    return {"id": f"{source}#{idx:02d}", "source": "general" if source == "core29" else "c11_only",
            "round": rd["round"], "start": _num(start), "end": _num(end), "n": len(beats),
            "groups": [b["grp"] for b in beats], "gaps": [b["gap"] for b in beats if b["gap"] is not None],
            "offsets": [b["off"] for b in beats], "colours": [b["colour"] for b in beats],
            "kinds": [b["kind"] for b in beats], "truth_resp": [b["truth_resp"] for b in beats],
            "dec_resp": [b["dec_resp"] for b in beats],
            "first_k": beats[0]["k"], "k0_avoided": beats[0]["k"] > 0,
            "c11_beats": [b["i"] for b in c11_beats],
            "gold": gold, "tell": tell, "timeline": timeline, "punish": punish, "beats": beats}


def build_scope(rd: dict, source: str) -> list[dict]:
    contacts = rd["truth"] if source == "core29" else [t for t in rd["truth"] if is_c11(grp_of(t))]
    out = []
    for j, chunk in enumerate(cluster(contacts), 1):
        if source == "core29" and not is_c11(grp_of(chunk[0])):
            continue
        out.append(build_episode(rd, chunk, source, j))
    return out


# ---------------------------------------------------------------- stats

def _press_stats(beats: list[dict]) -> dict:
    items = [p for b in beats for p in b["presses"]]
    keys = collections.Counter(str(p["key"]) for p in items if p["key"])
    leads = [p["lead"] for p in items if p["lead"] is not None]
    by_key = {}
    for key in sorted(keys):
        sub = [p for p in items if str(p["key"]) == key]
        by_key[key] = {"n": len(sub), "keys": keys[key],
                       "leads": describe([p["lead"] for p in sub if p["lead"] is not None]),
                       "sources": dict(collections.Counter(str(p["source"]) for p in sub))}
    return {"n": len(items), "keys": dict(keys), "leads": describe(leads), "by_key": by_key}


def scope_stats(episodes: list[dict]) -> dict:
    beats = [b for ep in episodes for b in ep["beats"]]
    by_k = {}
    ks = sorted({b["k"] for b in beats})
    for k in ks:
        xs = [b for b in beats if b["k"] == k]
        hit = sum(1 for b in xs if b["kind"] == "hit")
        ok = sum(1 for b in xs if b["kind"] == "ok")
        by_k[str(k)] = {"n": len(xs), "hit": hit, "ok": ok,
                        "ok_rate": round(ok / (hit + ok), 4) if hit + ok else None,
                        "groups": dict(collections.Counter(b["grp"] for b in xs)),
                        "press": _press_stats(xs),
                        "hitstun_followups": sum(1 for b in xs if b["in_hitstun"]),
                        "state_at_press": dict(collections.Counter(
                            str(p["state"]) for b in xs for p in b["presses"]))}
    for k in ("0", "1", "2"):
        by_k.setdefault(k, {"n": 0, "hit": 0, "ok": 0, "ok_rate": None, "groups": {}, "press": _press_stats([]),
                            "hitstun_followups": 0, "state_at_press": {}})

    gold = collections.Counter()
    for ep in episodes:
        g = ep["gold"]
        gold["missing" if not g["found"] else "found"] += 1
        if g["found"]:
            gold[str(g["kind"])] += 1
        elif g["press"]:
            gold["fallback_press"] += 1
    gold_out = {"hit": gold["hit"], "ok": gold["ok"], "other": sum(v for k, v in gold.items()
                                                                  if k not in ("hit", "ok", "found", "missing",
                                                                               "fallback_press")),
                "missing": gold["missing"], "found": gold["found"], "fallback_press": gold["fallback_press"]}

    tells = [ep["tell"] for ep in episodes]
    post = [ep["punish"]["post_gap_f"] for ep in episodes if ep["punish"]["post_gap_f"] is not None]
    follow = [b for b in beats if b["in_hitstun"]]
    return {"episodes": len(episodes), "beats": len(beats),
            "chain_len": dict(collections.Counter(ep["n"] for ep in episodes)),
            "gold": gold_out,
            "k0_avoided": sum(1 for ep in episodes if ep["k0_avoided"]),
            "k0_avoided_ids": [ep["id"] for ep in episodes if ep["k0_avoided"]],
            "first_k": dict(collections.Counter(ep["first_k"] for ep in episodes)),
            "by_k": by_k,
            "kinds": dict(collections.Counter(str(b["kind"]) for b in beats)),
            "colours": dict(collections.Counter(str(b["colour"]) for b in beats)),
            "truth_resp": dict(collections.Counter(str(b["truth_resp"]) for b in beats)),
            "dec_resp": dict(collections.Counter(str(b["dec_resp"]) for b in beats)),
            "hitstun_followups": len(follow), "hitstun_followup_share": round(len(follow) / len(beats), 4) if beats else None,
            "hitstun_age": describe([b["hitstun_age_f"] for b in beats if b["hitstun_age_f"] is not None]),
            "post_gap": describe(post),
            "post_gap_ge20": sum(1 for v in post if v >= 20), "post_gap_ge42": sum(1 for v in post if v >= 42),
            "post_gap_ge61": sum(1 for v in post if v >= 61), "post_gap_missing": len(episodes) - len(post),
            "tell": {"found": sum(1 for t in tells if t["found"]), "missing": sum(1 for t in tells if not t["found"]),
                     "kinds": dict(collections.Counter(str(t["kind"]) for t in tells if t["found"])),
                     "lead": describe([t["lead_f"] for t in tells if t["lead_f"] is not None]),
                     "last_lead": describe([t["last_lead_f"] for t in tells if t.get("last_lead_f") is not None]),
                     "n_runs": dict(collections.Counter(t["n_runs"] for t in tells if t["found"]))},
            "press_total": _press_stats(beats)}


def k1_parry_stats(to: int = K1_SCAN_TO) -> dict:
    """Parry presses whose pressLog group is k1 (and the k1:c11 subset), across live r001–rNNN."""
    rows, skipped, unmatched = [], [], 0
    names = load_names()
    rounds_scanned = 0
    for i in range(1, to + 1):
        d = LIVE / f"r{i}"
        if not (d / "contacts.json").exists():
            skipped.append(f"r{i}: no contacts.json")
            continue
        rd = load_round(f"r{i}", names, need_trace=False)
        if rd.get("skip"):
            skipped.append(f"r{i}: {rd['skip']}")
            continue
        rounds_scanned += 1
        seen = set()
        for t in rd["truth"]:
            frame = float(t["frame"])
            for pr in t.get("presses") or []:
                if pr.get("key") != "parry" or pr.get("lead") is None:
                    continue
                target = frame - float(pr["lead"])
                cand = [p for p in rd["by_kind"].get("parry") or [] if abs(p["frame"] - target) <= 1.0]
                if not cand:
                    unmatched += 1
                    continue
                pod = min(cand, key=lambda p: abs(p["frame"] - target))
                if pod["i"] in seen:
                    continue
                seen.add(pod["i"])
                if not pod["group"].startswith("k1:"):
                    continue
                rows.append({"round": rd["round"], "press_f": _num(pod["frame"]), "group": pod["group"],
                             "lead": _num(pod["lead"]), "remF": _num(pod["remF"]), "src": pod["src"],
                             "truth_f": _num(frame), "actual_lead": _num(frame - pod["frame"]),
                             "kind": t.get("kind"), "truth_resp": (t.get("dec") or {}).get("truth_resp"),
                             "dec_resp": (t.get("dec") or {}).get("resp"),
                             "truth_grp": grp_of(t)})

    def block(xs: list[dict]) -> dict:
        ok = sum(1 for x in xs if x["kind"] == "ok")
        return {"n": len(xs), "ok": ok, "ok_rate": round(ok / len(xs), 4) if xs else None,
                "hit": sum(1 for x in xs if x["kind"] == "hit"),
                "lead": describe([x["lead"] for x in xs]),
                "actual_lead": describe([x["actual_lead"] for x in xs]),
                "remF": describe([x["remF"] for x in xs]),
                "groups": dict(collections.Counter(x["group"] for x in xs)),
                "rounds": len({x["round"] for x in xs})}

    c11 = [x for x in rows if is_c11(x["group"])]
    return {"rounds_scanned": rounds_scanned, "rounds_skipped": skipped, "unmatched_press_rows": unmatched,
            "rule": "truth contact press key=parry matched (<=1 f) to pressLog; group name starts with k1:",
            "k1_c11": block(c11), "k1_all": block(rows), "samples": rows[:12]}


# ---------------------------------------------------------------- markdown

def _f(v) -> str:
    return "—" if v is None else f"{float(v):.1f}"


def _q(d: dict) -> str:
    if not d or not d.get("n"):
        return "—"
    return f"{d['n']} / {_f(d['min'])} / {_f(d['p25'])} / {_f(d['median'])} / {_f(d['p75'])} / {_f(d['max'])}"


def _flags(post: float | None) -> str:
    if post is None:
        return "—"
    out = [str(t) for t in PUNISH_THRESHOLDS if post >= t]
    return ("≥" + "/".join(out)) if out else "<20"


def _gold_cell(ep: dict) -> str:
    g = ep["gold"]
    if g["found"]:
        return f"{g['kind']}@{g['beat_i']}"
    p = g["press"]
    return "无" if p is None else f"无；pred {_f(g['opener_f'])}"


def render_md(data: dict) -> str:
    core, ext, summary, k1 = data["core29"], data["extended38"], data["summary"], data["summary"]["k1_parry"]
    c, e = summary["core29"], summary["extended38"]
    core_eps = [ep for ep in data["episodes"] if ep["source"] == "general"]
    ext_eps = [ep for ep in data["episodes"] if ep["source"] == "c11_only"]
    lines = ["# 独夫阶段一 c11/c40 金光连段逐拍帧表", "",
             f"- 数据：`{data['meta']['live']}`（载入 {data['meta']['rounds_loaded']} 局，"
             f"r{DEFAULT_FROM}–r{DEFAULT_TO} 默认窗口）；meta 在 `live/meta/<rec>.json`；"
             f"招式表 `{data['meta']['model']}`。",
             f"- 帧率 30 fps（1 帧 = {FRAME_MS:.3f} ms）。`k0 = (result.start - meta.started)/FRAME_MS`；"
             "`frame = k0 + trace.cap/FRAME_MS + contacts.offset`；"
             "`press_f = k0 + pressLog[i][0]/FRAME_MS + contacts.offset`（与 offense_episodes.py 同式）。",
             f"- 口径：**core29** = 全部 truth 接触 gap ≤ {GAP_F} 聚 episode 后取首拍 c11/c40（r{DEFAULT_FROM}–r{CORE_TO}）；"
             f"**extended38** = 只取 c11/c40 接触 gap ≤ {GAP_F} 聚 episode（r{DEFAULT_FROM}–r{DEFAULT_TO}）。",
             f"- 状态窗口（全部 est=true）：hitstun [{0},+{HITSTUN_F}]、dodge_iframe [+{DODGE_IFRAME[0]},+{DODGE_IFRAME[1]}]、"
             f"dodge_lock [0,+{DODGE_LOCK_F}]、parry_lock [0,+{PARRY_LOCK_F}]、parry_cd [0,+{PARRY_CD_F}]；"
             f"优先级 {' > '.join(STATE_PRIORITY)}。parry_cd 是 parry_lock 的子集，实际不会胜出。",
             f"- tell：`[opener_f-{TELL_LOOKBACK_F}, opener_f+{TELL_AHEAD_F}]` 内 k0:c11/c40 连续 ≥{TELL_RUN} 行且 grpP≥{TELL_GRPP}；"
             "取窗口内**最早**的一段（first telegraph onset）；JSON 同时给出全部 run 与 last_run（last confirmation lead 只作对照，不覆盖 earliest）。",
             f"- 收招：`post_gap = 下一条 truth 接触 - end`，没有下一条则 `video_end - end`（video_end 用 result.t0，缺 t0 回退 start）。",
             f"- 复算：`uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/c11_frames.py`。", ""]

    if data["meta"]["skipped"]:
        lines += ["**跳过（不静默）**：" + "；".join(f"`{s}`" for s in data["meta"]["skipped"]), ""]

    lines += ["## 1 汇总", "",
              "| 口径 | episodes | beats | gold hit / ok / 缺失 | k0 避开 | tell 找到 | tell lead n/med/p25/p75 | post_gap n/med | ≥20 | ≥42 | ≥61 |",
              "|---|---:|---:|---|---:|---:|---|---:|---:|---:|---:|"]
    for label, s in (("core29", c), ("extended38", e)):
        g = s["gold"]
        lines.append(f"| {label} | {s['episodes']} | {s['beats']} | {g['hit']} / {g['ok']} / {g['missing']} | "
                     f"{s['k0_avoided']}/{s['episodes']} | {s['tell']['found']}/{s['episodes']} | "
                     f"{_q(s['tell']['lead'])} | {_f(s['post_gap']['median'])} | {s['post_gap_ge20']} | "
                     f"{s['post_gap_ge42']} | {s['post_gap_ge61']} |")
    lines += ["",
              "链长：" + "；".join(f"{label} `{s['chain_len']}`" for label, s in (("core29", c), ("extended38", e)))
              + "。首拍 k：" + "；".join(f"{label} `{s['first_k']}`" for label, s in (("core29", c), ("extended38", e))) + "。",
              "", "## 2 core29 逐 episode", "",
              "| # | round | start | n | groups | colours | kinds | k0 避开 | tell lead | gold | post gap |",
              "|---:|---|---:|---:|---|---|---|---:|---:|---|---|"]
    for j, ep in enumerate(core_eps, 1):
        lead = ep["tell"]["lead_f"]
        lines.append(f"| {j} | {ep['round']} | {_f(ep['start'])} | {ep['n']} | {' → '.join(ep['groups'])} | "
                     f"{''.join(str(x)[0].upper() for x in ep['colours'])} | "
                     f"{''.join('H' if x == 'hit' else 'O' for x in ep['kinds'])} | "
                     f"{'是' if ep['k0_avoided'] else '否'} | {_f(lead)} | {_gold_cell(ep)} | "
                     f"{_f(ep['punish']['post_gap_f'])} ({_flags(ep['punish']['post_gap_f'])}) |")
    lines += ["", "colours: G=gold, N=none, U=unknown；kinds: H=hit, O=ok。", "",
              "## 3 extended38 逐 episode", "",
              "| # | round | start | n | groups | colours | kinds | k0 避开 | tell lead | gold | post gap |",
              "|---:|---|---:|---:|---|---|---|---:|---:|---|---|"]
    for j, ep in enumerate(ext_eps, 1):
        lead = ep["tell"]["lead_f"]
        lines.append(f"| {j} | {ep['round']} | {_f(ep['start'])} | {ep['n']} | {' → '.join(ep['groups'])} | "
                     f"{''.join(str(x)[0].upper() for x in ep['colours'])} | "
                     f"{''.join('H' if x == 'hit' else 'O' for x in ep['kinds'])} | "
                     f"{'是' if ep['k0_avoided'] else '否'} | {_f(lead)} | {_gold_cell(ep)} | "
                     f"{_f(ep['punish']['post_gap_f'])} ({_flags(ep['punish']['post_gap_f'])}) |")

    lines += ["", "## 4 按 k 的接触与按键", "",
              "| 口径 | k | n | hit | ok | ok% | press keys | lead n/min/p25/med/p75/max | 按键时状态 |",
              "|---|---:|---:|---:|---:|---:|---|---|---|"]
    for label, s in (("core29", c), ("extended38", e)):
        for k, x in s["by_k"].items():
            keys = ", ".join(f"{a}:{b}" for a, b in x["press"]["keys"].items()) or "—"
            rate = "—" if x["ok_rate"] is None else f"{100 * x['ok_rate']:.0f}%"
            lines.append(f"| {label} | {k} | {x['n']} | {x['hit']} | {x['ok']} | {rate} | "
                         f"{keys} | {_q(x['press']['leads'])} | "
                         f"{', '.join(f'{a}:{b}' for a, b in x['state_at_press'].items()) or '—'} |")

    lines += ["", "## 5 gold opener 与 tell", ""]
    for label, s in (("core29", c), ("extended38", e)):
        g, t = s["gold"], s["tell"]
        lines.append(f"- {label}：gold 接触 {g['hit']} 个 hit、{g['ok']} 个 ok，缺失 {g['missing']} 条"
                     f"（其中 {g['fallback_press']} 条用 k0:c11 dodge press 的 pred 作为 expected opener）；"
                     f"tell 找到 {t['found']}/{s['episodes']}，类型 `{t['kinds']}`，earliest lead n/min/p25/med/p75/max = "
                     f"{_q(t['lead'])}；last confirmation lead = {_q(t.get('last_lead'))}。")
    tell_lead = {ep["id"]: ep["tell"]["lead_f"] for ep in core_eps + ext_eps}
    missing = [(ep["id"], ep["round"], ep["gold"]) for eps in (core_eps, ext_eps)
               for ep in eps if not ep["gold"]["found"]]
    if missing:
        lines += ["", "| episode | round | opener 来源 | press_f | remF | lead | src | pred | tell lead |",
                  "|---|---|---|---:|---:|---:|---|---:|---:|"]
        for eid, rnd, g in missing:
            p = g["press"] or {}
            lines.append(f"| {eid} | {rnd} | {g['opener_source']} | {_f(p.get('frame'))} | {_f(p.get('remF'))} | "
                         f"{_f(p.get('lead'))} | {p.get('src') or '—'} | {_f(g['opener_f'])} | "
                         f"{_f(tell_lead.get(eid))} |")

    lines += ["", "## 6 收招 / 惩罚窗口", "",
              "| 口径 | post_gap n/min/p25/med/p75/max | ≥20 | ≥42 | ≥61 | punish_ready = end+12 |",
              "|---|---|---:|---:|---:|---|"]
    for label, s in (("core29", c), ("extended38", e)):
        lines.append(f"| {label} | {_q(s['post_gap'])} | {s['post_gap_ge20']}/{s['episodes']} | "
                     f"{s['post_gap_ge42']}/{s['episodes']} | {s['post_gap_ge61']}/{s['episodes']} | "
                     f"每条 episode 单独记录 |")
    lines += ["", "post_gap 来源：" + "；".join(
        f"{label} `" + str(dict(collections.Counter(ep['punish']['base'] for ep in eps))) + "`"
        for label, eps in (("core29", core_eps), ("extended38", ext_eps))) + "。", ""]

    lines += ["## 7 k1 能否 parry（全 live 按键级）", "",
              f"- 扫描 r001–r{K1_SCAN_TO}：{k1['rounds_scanned']} 局可用（跳过 {len(k1['rounds_skipped'])}），"
              f"未匹配到 pressLog 的 parry press 行 {k1['unmatched_press_rows']}。",
              f"- **k1:c11**：press {k1['k1_c11']['n']} 条，ok **{k1['k1_c11']['ok']}**"
              f"（{k1['k1_c11']['ok_rate']}），hit {k1['k1_c11']['hit']}；配置 lead {_q(k1['k1_c11']['lead'])}；"
              f"actual lead {_q(k1['k1_c11']['actual_lead'])}。",
              f"- k1 全部组：press {k1['k1_all']['n']} 条，ok {k1['k1_all']['ok']}（{k1['k1_all']['ok_rate']}）；"
              f"配置 lead {_q(k1['k1_all']['lead'])}。",
              "", "| 子集 | n | ok | ok% | hit | lead n/min/p25/med/p75/max | actual lead | 组 |",
              "|---|---:|---:|---:|---:|---|---|---|"]
    for label, x in (("k1:c11", k1["k1_c11"]), ("k1 全部", k1["k1_all"])):
        lines.append(f"| {label} | {x['n']} | {x['ok']} | {x['ok_rate']} | {x['hit']} | {_q(x['lead'])} | "
                     f"{_q(x['actual_lead'])} | " + ", ".join(f"{a}:{b}" for a, b in x["groups"].items()) + " |")

    lines += ["", "## 8 异常 / 注意", ""]
    for a in data["summary"]["anomalies"]:
        lines.append(f"- {a}")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------- csv

def write_csv(path: Path, episodes: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cols = ["scope", "episode", "round", "i", "frame", "gap", "off", "grp", "k", "colour", "kind",
            "truth_resp", "dec_resp", "press_keys", "press_leads", "press_sources", "hitstun_age_f"]
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for ep in episodes:
            for b in ep["beats"]:
                w.writerow([ep["source"], ep["id"], ep["round"], b["i"], b["frame"], b["gap"], b["off"],
                            b["grp"], b["k"], b["colour"], b["kind"], b["truth_resp"], b["dec_resp"],
                            "|".join(str(p["key"]) for p in b["presses"] if p["key"]),
                            "|".join(str(p["lead"]) for p in b["presses"] if p["lead"] is not None),
                            "|".join(str(p["source"]) for p in b["presses"] if p["source"]),
                            b["hitstun_age_f"]])


# ---------------------------------------------------------------- main

def analyze(names, from_: int | None = None, to: int | None = None, core_to: int = CORE_TO) -> dict:
    mnames = load_names()
    rounds = round_names(names, from_, to)
    core_rows, ext_rows, skipped, warnings = [], [], [], []
    loaded = []
    for name in rounds:
        rd = load_round(name, mnames)
        if rd.get("skip"):
            skipped.append(f"{name}: {rd['skip']}")
            continue
        loaded.append(rd)
    for rd in loaded:
        num = round_number(rd["round"])
        if num <= core_to:
            core_rows += build_scope(rd, "core29")
        ext_rows += build_scope(rd, "extended38")

    core_eps, ext_eps = core_rows, ext_rows
    c, e = scope_stats(core_eps), scope_stats(ext_eps)

    null_dec = [(rd["round"], float(t["frame"])) for rd in loaded for t in rd["truth"] if t.get("dec") is None]
    if null_dec:
        rounds_with = len({r for r, _ in null_dec})
        warnings.append(f"dec=null 的 truth contact 共 {len(null_dec)} 条（{rounds_with} 局），无组名、不参与 c11 判定；"
                        f"对应 beat 的 grp 为空、k=-1，未从数据中删除")
    for eps, label in ((core_eps, "core29"), (ext_eps, "extended38")):
        for ep in eps:
            if not ep["gold"]["found"] and ep["gold"]["press"] is None:
                warnings.append(f"{label} {ep['id']}（{ep['round']} start {_f(ep['start'])}）：无 gold 接触、90 帧内也没有 k0:c11 dodge press，opener 用 episode start")
            if not ep["tell"]["found"]:
                warnings.append(f"{label} {ep['id']}（{ep['round']} start {_f(ep['start'])}）：tell 窗口内没有符合条件的 k0:c11 行")
            if ep["punish"]["post_gap_f"] is None:
                warnings.append(f"{label} {ep['id']}（{ep['round']}）：没有下一条 truth，且 video_end 不可用，post_gap=null")
            if ep["punish"]["clamped"]:
                warnings.append(f"{label} {ep['id']}（{ep['round']}）：video_end 早于 episode end，post_gap 截 0")
    for rd in loaded:
        if rd["offset_missing"]:
            warnings.append(f"{rd['round']}：contacts.offset 缺失，按 0 处理")
        if rd["video_end_f"] is None:
            warnings.append(f"{rd['round']}：video_end 不可用（缺 t0 或 fightMs）")

    k1 = k1_parry_stats()
    if skipped:
        warnings.insert(0, "载入跳过：" + "；".join(skipped))

    core_ids = [ep["id"] for ep in core_eps]
    ext_ids = [ep["id"] for ep in ext_eps]
    data = {
        "meta": {"live": str(LIVE.relative_to(REPO)).replace("\\", "/"),
                 "model": str(MODEL.relative_to(REPO)).replace("\\", "/"),
                 "frame_ms": FRAME_MS, "rounds": rounds, "rounds_loaded": len(loaded),
                 "skipped": skipped, "core_to": core_to,
                 "files": {"json": str(OUT_JSON.relative_to(REPO)).replace("\\", "/"),
                           "md": str(OUT_MD.relative_to(REPO)).replace("\\", "/"),
                           "csv": str(OUT_CSV.relative_to(REPO)).replace("\\", "/")}},
        "params": PARAMS,
        "episodes": core_eps + ext_eps,
        "summary": {"core29": c, "extended38": e, "k1_parry": k1,
                    "definitions": {
                        "core29": "all truth contacts, gap<=30, keep first-beat c11/c40 (r185-r219)",
                        "extended38": "only c11/c40 truth contacts, gap<=30 (r185-r223)"},
                    "anomalies": warnings},
        "core29": {"definition": "general episodes (all truth, gap<=30) whose first beat grp contains c11/c40, "
                                 f"rounds <= r{core_to}",
                   "episodes": len(core_eps), "beats": sum(ep["n"] for ep in core_eps), "episode_ids": core_ids},
        "extended38": {"definition": "c11/c40-only contacts, gap<=30", "episodes": len(ext_eps),
                       "beats": sum(ep["n"] for ep in ext_eps), "episode_ids": ext_ids},
    }
    return data


def one_page(data: dict) -> str:
    c, e = data["summary"]["core29"], data["summary"]["extended38"]
    k1 = data["summary"]["k1_parry"]
    return "\n".join([
        f"core29 episodes {c['episodes']} beats {c['beats']}, extended38 episodes {e['episodes']} beats {e['beats']}",
        f"core29 gold hit/ok/missing {c['gold']['hit']}/{c['gold']['ok']}/{c['gold']['missing']}, "
        f"k0 avoided {c['k0_avoided']}/{c['episodes']}, tell {c['tell']['found']} med {_f(c['tell']['lead']['median'])}, "
        f"post_gap med {_f(c['post_gap']['median'])} (>=20 {c['post_gap_ge20']}, >=42 {c['post_gap_ge42']}, "
        f">=61 {c['post_gap_ge61']})",
        f"extended38 gold hit/ok/missing {e['gold']['hit']}/{e['gold']['ok']}/{e['gold']['missing']}, "
        f"k0 avoided {e['k0_avoided']}/{e['episodes']}, tell {e['tell']['found']} med "
        f"{_f(e['tell']['lead']['median'])}, post_gap med {_f(e['post_gap']['median'])}",
        f"k0/k1/k2 core29 hit/ok " + " ".join(f"k{k} {c['by_k'][k]['hit']}/{c['by_k'][k]['ok']}"
                                              for k in ("0", "1", "2")),
        f"k1 parry r001-r{K1_SCAN_TO}: k1:c11 n {k1['k1_c11']['n']} ok {k1['k1_c11']['ok']} "
        f"(rate {k1['k1_c11']['ok_rate']}), lead med {_f(k1['k1_c11']['lead']['median'])}; "
        f"all k1 n {k1['k1_all']['n']} ok {k1['k1_all']['ok']}",
        f"anomalies {len(data['summary']['anomalies'])}",
        f"wrote {data['meta']['files']['json']}, {data['meta']['files']['md']}, {data['meta']['files']['csv']}",
    ])


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("rounds", nargs="*", help="rNNN (default: r185-r223)")
    ap.add_argument("--from", dest="from_", type=int, help="first round number (inclusive)")
    ap.add_argument("--to", dest="to", type=int, help="last round number (inclusive)")
    ap.add_argument("--core-to", dest="core_to", type=int, default=CORE_TO,
                    help=f"core29 upper round bound (default r{CORE_TO})")
    a = ap.parse_args()
    if a.rounds and (a.from_ is not None or a.to is not None):
        ap.error("use positional rounds or --from/--to, not both")
    if a.from_ is not None and a.to is not None and a.from_ > a.to:
        ap.error("--from must be <= --to")
    data = analyze(a.rounds or None, a.from_, a.to, a.core_to)
    write_json(OUT_JSON, data)
    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    OUT_MD.write_text(render_md(data), encoding="utf-8")
    write_csv(OUT_CSV, data["episodes"])
    print(one_page(data))


if __name__ == "__main__":
    main()
