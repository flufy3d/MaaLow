"""Order 3b: per-contact response labels and gate 1, new caliber (plan "决定 2026-10-24"). Written before the order-3b
teacher was trained; not changed after seeing its results. Reads out-of-fold predictions, writes
data/moveid/teacher_prefix/gate1.json (every number with numerator / denominator) and gate1.md.

    uv run --no-project --with numpy python workspaces/WhereWindsMeet/tools/dufu_moveid/s3b_gate1.py \
        [--pred prefix=data/moveid/teacher_prefix/oof.npz] [--old data/moveid/teacher/oof.npz]

Response label of one contact (response_labels(); used for training and for (b)):
  grab tick (index outcome 'grab' = a hit inside the grab cut-scene)   -> None: no action is possible there; not
                                                                          trained, not in (b) (count reported)
  this contact's own colour (events_ext color) is gold                 -> dodge
  else, its prefix group (s3b_prefix.py; a group lives at one chain position k, so (group, k) = group) has parry rate
        ok / (ok + pf) < 0.2 with ok + pf >= 10                         -> dodge ("unparryable")
  else                                                                  -> parry
  ok / pf = index.json `outcome` (ok = parried, pf = hit although 卸势 was pressed 4-15 f before) counted over the
  group's contacts that are not gold and not grab ticks (gold contacts are dodge anyway and would drag the rate of
  the rest down). `outcome` rather than `type` because `type` is 'flare' (aux 金光) first and hides the outcome of
  649 contacts; the type-based ok / (ok + hit_pf) list is reported next to it. Gold-chain follow-ups (own colour
  none) go through the same rule, nothing is assumed.

Prediction file (npz), one row per contact (events_ext id), outputs at offsets -30..0 from that contact:
  ids [n], offs [31], p_grp [n, 31, G + 1] (prefix groups, G = idle), p_col [n, 31, 3] (this contact's colour: gold,
  red, none), p_resp [n, 31, 3] (dodge, parry, none = no contact coming), p_tte [n, 31, 47] (0..45, 46 = none),
  valid [n, 31], fold [n]. The order-3 teacher file (p_cls 45 / p_col = opener colour / p_tte) is evaluated through
  old_adapter() for comparison (response derived: idle class -> none; colour gold -> dodge; class ok_rate < 0.2 ->
  dodge; else parry).

Gate (decision moment = the contact's own frame - 10; curve -16 .. -4):
  (a)  opener-gold chains whose colour argmax at c0 - 10 is red / opener-gold chains (<= 3%); grab chains included
       (move-only also reported). Per-contact version: every gold contact at its own -10.
  (b)  every contact of a fatal chain (taxonomy fatal) except grab ticks, at its own -10: the response head argmax
       (dodge / parry / none) equals the label; 'none' (no contact / idle) and a missing prediction count as wrong.
       >= 90%. Reported: dodge_as_parry (truth dodge, said parry: the dangerous one) / truth-dodge count,
       parry_as_dodge / truth-parry count, as_none; by position k; by group; the subset whose previous contact is
       still ahead at that frame (gap_prev <= 10: the frame's "next contact" is the previous one) and the rest.
       Also the derived response (colour head gold -> dodge, else the argmax group's response, idle -> none).
  (c)  contact time at the contact's own -10: point = median of p_tte (46 = none counted as 46); truth = frames from
       that frame to the next contact (= 10 unless the previous contact is still ahead). |error| median / p75 / p90,
       within +-3; overall, by position k, by group; clean subset (truth = 10). Sources of the p90 tail: share of
       contacts with |error| >= p90 by group, boss box height at the decision frame (boss_boxes, detector;
       none = boss not found = hidden / off screen), position, previous-contact-ahead.
  pass = (a) <= 3% and (b) >= 90% at -10.
"""
from __future__ import annotations

import argparse
import collections
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s3_common import COLORS, IDLE, N_MOVE, OUT, TTE_MAX, load, read_json, write_json  # noqa: E402

PREFIX = OUT / "teacher_prefix"
A_MAX, B_MIN = 0.03, 0.90
DECISION = -10
EVAL_OFFS = tuple(range(-16, -3))
UNPARRYABLE_RATE = 0.2
UNPARRYABLE_MIN_N = 10
RESP = ("dodge", "parry", "none")
NEAR = 3                                  # (c) "within +-3 frames"


# ---------------------------------------------------------------- labels (used by s3b_prefix.py)

def response_labels(events: list[dict], gid: dict[int, int], outcome: dict[int, str]) -> tuple[dict, dict]:
    """events (events_ext rows), gid: event id -> prefix group, outcome: event id -> index outcome.
    -> (resp: event id -> 'dodge' | 'parry' | None, stats: group -> {ok, pf, rate, unparryable, ok_t, pf_t, rate_t})."""
    st = collections.defaultdict(collections.Counter)
    for e in events:
        o = outcome[e["id"]]
        if o == "grab" or e["color"] == "gold":
            continue
        g = gid[e["id"]]
        st[g]["ok"] += o == "ok"
        st[g]["pf"] += o == "pf"
        st[g]["ok_t"] += e["type"] == "ok"           # type-based variant (reported only)
        st[g]["pf_t"] += e["type"] == "hit_pf"
    stats = {}
    for g, c in st.items():
        den, den_t = c["ok"] + c["pf"], c["ok_t"] + c["pf_t"]
        rate = c["ok"] / den if den else None
        rate_t = c["ok_t"] / den_t if den_t else None
        stats[g] = {"ok": c["ok"], "pf": c["pf"], "rate": None if rate is None else round(rate, 4),
                    "unparryable": bool(den >= UNPARRYABLE_MIN_N and rate < UNPARRYABLE_RATE),
                    "ok_t": c["ok_t"], "pf_t": c["pf_t"], "rate_t": None if rate_t is None else round(rate_t, 4),
                    "unparryable_t": bool(den_t >= UNPARRYABLE_MIN_N and rate_t < UNPARRYABLE_RATE)}
    resp = {}
    for e in events:
        if outcome[e["id"]] == "grab":
            resp[e["id"]] = None
        elif e["color"] == "gold":
            resp[e["id"]] = "dodge"
        elif stats.get(gid[e["id"]], {}).get("unparryable"):
            resp[e["id"]] = "dodge"
        else:
            resp[e["id"]] = "parry"
    return resp, stats


# ---------------------------------------------------------------- evaluation

def frac(num, den) -> dict:
    return {"num": int(num), "den": int(den), "rate": (round(num / den, 4) if den else None)}


def pct(x) -> str:
    return "–" if x is None or x.get("rate") is None else f"{x['num']}/{x['den']} = {100 * x['rate']:.1f}%"


def tte_point(p: np.ndarray) -> np.ndarray:
    return (np.cumsum(p, -1) >= 0.5).argmax(-1)


def new_adapter(z: dict, prefix: dict) -> dict:
    """-> per contact row, per offset: col (0..2), resp (0..2), resp_derived, grp (-1 idle), tte point."""
    G = len(prefix["groups"])
    gresp = np.array([{"dodge": 0, "parry": 1}.get(g["response"], 1) for g in prefix["groups"]] + [2])
    col = z["p_col"].argmax(-1)
    grp = z["p_grp"].argmax(-1)
    der = np.where(grp == G, 2, np.where(col == 0, 0, gresp[grp]))
    return {"ids": z["ids"], "offs": list(z["offs"]), "valid": z["valid"], "col": col, "resp": z["p_resp"].argmax(-1),
            "resp_derived": der, "grp": np.where(grp == G, -1, grp),
            "tte": tte_point(z["p_tte"].astype(np.float64))}


def old_adapter(z: dict, classes: dict) -> dict:
    """order-3 teacher: colour head = opener colour, class head = chain class (45), response derived."""
    col = z["p_col"].argmax(-1)
    cls = z["p_cls"].argmax(-1)
    unp = np.zeros(45, bool)
    for c, v in classes.items():
        if v.get("ok_rate") is not None and v["ok_rate"] < UNPARRYABLE_RATE:
            unp[c] = True
    der = np.where(cls == IDLE, 2, np.where((col == 0) | unp[cls], 0, 1))
    return {"ids": z["ids"], "offs": list(z["offs"]), "valid": z["valid"], "col": col, "resp": der,
            "resp_derived": der, "grp": None, "tte": tte_point(z["p_tte"].astype(np.float64))}


def boss_height(rnd: str, frame: int, cache: dict):
    """detector box height at the decision frame (boss_boxes/rNNN.json key str(frame)); None = no box."""
    r = rnd.split("/")[-1]
    if r not in cache:
        p = OUT / "boss_boxes" / f"{r}.json"
        cache[r] = read_json(p) if p.exists() else {}
    v = cache[r].get(str(frame))
    if not v or not v.get("box"):
        return None
    b = v["box"]
    return b[3] - b[1]


def hbin(h) -> str:
    if h is None:
        return "no box"
    return "<100" if h < 100 else "100-200" if h < 200 else "200-350" if h < 350 else ">=350"


def evaluate(P: dict, d: dict, prefix: dict) -> dict:
    classes = d["classes"]
    pe = prefix["events"]
    gname = [g["name"] for g in prefix["groups"]]
    row = {int(i): k for k, i in enumerate(P["ids"])}
    offs = P["offs"]
    fatal = {c for c, v in classes.items() if v.get("fatal")}
    ev = d["events"]
    by_rec = collections.defaultdict(list)
    for e in ev:
        by_rec[e["rec"]].append(e["frame"])
    openers = [e for e in ev if e["chain_pos"] == 0]

    def at(e, o):
        k = row.get(e["id"])
        if k is None:
            return None
        j = offs.index(o)
        return (k, j) if P["valid"][k, j] else None

    out = {"offsets": {}}
    for o in EVAL_OFFS:
        r = {}
        # (a)
        conf = np.zeros((3, 3), int)
        conf_mv = np.zeros((3, 3), int)
        for e in openers:
            if e["chain_color"] not in COLORS or (kj := at(e, o)) is None:
                continue
            t, p = COLORS.index(e["chain_color"]), int(P["col"][kj])
            conf[t, p] += 1
            if e["chain_kind"] == "move":
                conf_mv[t, p] += 1
        cc = np.zeros((3, 3), int)
        for e in ev:
            if e["color"] not in COLORS or (kj := at(e, o)) is None:
                continue
            cc[COLORS.index(e["color"]), int(P["col"][kj])] += 1
        r["a"] = {"gold_to_red": frac(conf[0, 1], conf[0].sum()), "gold_to_none": frac(conf[0, 2], conf[0].sum()),
                  "red_to_gold": frac(conf[1, 0], conf[1].sum()), "none_to_gold": frac(conf[2, 0], conf[2].sum()),
                  "move_only_gold_to_red": frac(conf_mv[0, 1], conf_mv[0].sum()), "confusion_chains": conf.tolist(),
                  "per_contact_gold_to_red": frac(cc[0, 1], cc[0].sum()),
                  "per_contact_gold_to_none": frac(cc[0, 2], cc[0].sum()),
                  "per_contact_confusion": cc.tolist(), "rows_true_cols_pred": list(COLORS)}
        # (b)
        B = collections.defaultdict(collections.Counter)
        grab_ticks = 0
        for e in ev:
            if e["cls"] not in fatal:
                continue
            truth = pe[str(e["id"])]["response"]
            if truth is None:
                grab_ticks += 1
                continue
            kj = at(e, o)
            pr = RESP[int(P["resp"][kj])] if kj is not None else "missing"
            pd_ = RESP[int(P["resp_derived"][kj])] if kj is not None else "missing"
            ahead = e["gap_prev"] is not None and e["gap_prev"] <= -DECISION
            keys = ["all", f"k{e['chain_pos']}", "g:" + gname[pe[str(e["id"])]["gid"]],
                    "ahead" if ahead else "clean", f"c{e['cls']}"]
            for key in keys:
                x = B[key]
                x["n"] += 1
                x["ok"] += pr == truth
                x["ok_derived"] += pd_ == truth
                x["n_" + truth] += 1
                if truth == "dodge":
                    x["dodge_as_parry"] += pr == "parry"
                    x["dodge_as_parry_derived"] += pd_ == "parry"
                else:
                    x["parry_as_dodge"] += pr == "dodge"
                    x["parry_as_dodge_derived"] += pd_ == "dodge"
                x["as_none"] += pr in ("none", "missing")
                x["as_none_derived"] += pd_ in ("none", "missing")

        def bsum(x):
            return {"correct": frac(x["ok"], x["n"]), "dodge_as_parry": frac(x["dodge_as_parry"], x["n_dodge"]),
                    "parry_as_dodge": frac(x["parry_as_dodge"], x["n_parry"]), "as_none": frac(x["as_none"], x["n"]),
                    "derived_correct": frac(x["ok_derived"], x["n"]),
                    "derived_dodge_as_parry": frac(x["dodge_as_parry_derived"], x["n_dodge"]),
                    "derived_parry_as_dodge": frac(x["parry_as_dodge_derived"], x["n_parry"]),
                    "derived_as_none": frac(x["as_none_derived"], x["n"])}
        r["b"] = {k: bsum(v) for k, v in sorted(B.items(), key=lambda kv: kv[0])}
        r["b"]["grab_ticks_excluded"] = grab_ticks
        out["offsets"][str(o)] = r
    # (c) at -10 only
    o = DECISION
    errs, info = [], []
    hcache: dict = {}
    for e in ev:
        if (kj := at(e, o)) is None:
            continue
        f = e["frame"] + o
        fr = by_rec[e["rec"]]
        nxt = min(x for x in fr if x >= f)
        truth = nxt - f
        pt = int(P["tte"][kj])
        err = abs(pt - truth)
        errs.append(err)
        info.append({"id": e["id"], "k": e["chain_pos"], "g": gname[pe[str(e["id"])]["gid"]], "truth": truth,
                     "pred": pt, "err": err, "ahead": truth != -o, "h": hbin(boss_height(e["round"], f, hcache)),
                     "type": e["type"], "fatal": e["cls"] in fatal})
    errs = np.array(errs)

    def tsum(sel):
        x = errs[sel]
        if len(x) == 0:
            return {"n": 0}
        return {"n": int(len(x)), "median": float(np.median(x)), "p75": float(np.percentile(x, 75)),
                "p90": float(np.percentile(x, 90)), "within3": frac((x <= NEAR).sum(), len(x)),
                "pred_none": frac(sum(1 for i, s in zip(info, sel) if s and i["pred"] == TTE_MAX + 1), len(x))}
    allm = np.ones(len(errs), bool)
    clean = np.array([not i["ahead"] for i in info])
    c = {"all": tsum(allm), "clean": tsum(clean), "ahead": tsum(~clean),
         "fatal": tsum(np.array([i["fatal"] for i in info]))}
    c["by_k"] = {f"k{k}": tsum(np.array([i["k"] == k for i in info])) for k in sorted({i["k"] for i in info})}
    c["by_group"] = {g: tsum(np.array([i["g"] == g for i in info])) for g in sorted({i["g"] for i in info})}
    p90 = float(np.percentile(errs, 90))
    tail = errs >= p90
    src = {}
    for key in ("g", "h", "k", "ahead", "type"):
        cnt = collections.Counter(str(i[key]) for i in info)
        tl = collections.Counter(str(i[key]) for i, t in zip(info, tail) if t)
        src[key] = sorted(({"value": v, "n": n, "tail": tl[v], "tail_rate": round(tl[v] / n, 4),
                            "share_of_tail": round(tl[v] / max(tail.sum(), 1), 4)} for v, n in cnt.items()),
                          key=lambda x: -x["tail"])
    c["p90_threshold"] = p90
    c["tail_n"] = int(tail.sum())
    c["tail_sources"] = src
    c["worst"] = sorted(info, key=lambda i: -i["err"])[:10]
    out["c"] = c
    x = out["offsets"][str(DECISION)]
    a, b = x["a"]["gold_to_red"]["rate"], x["b"]["all"]["correct"]["rate"]
    out["gate"] = {"a": a, "b": b, "a_max": A_MAX, "b_min": B_MIN,
                   "pass": bool(a is not None and b is not None and a <= A_MAX and b >= B_MIN)}
    return out


# ---------------------------------------------------------------- report

def report(res: dict, prefix: dict) -> str:
    L = ["# 关 1（新口径）：前缀招式老师离线判定（顺序 3b）", "",
         "数字全部是 out-of-fold（按轮次 5 折）；口径见 `s3b_gate1.py` 文档字符串（训练前写定）；分子 / 分母全在 gate1.json。", "",
         "## 判定（−10）", "",
         "| 模型 | (a) 金招→红（串） | (a) 每一下 金→红 | (b) 致命招每一下应对判对 | 该闪判成卸 | 该卸判成闪 | 判成「没有接触」 | (b) 由组 + 颜色推出 | 过关 |",
         "|---|---|---|---|---|---|---|---|---|"]
    for name, r in res.items():
        x = r["offsets"][str(DECISION)]
        b = x["b"]["all"]
        L.append(f"| {name} | {pct(x['a']['gold_to_red'])} | {pct(x['a']['per_contact_gold_to_red'])} | {pct(b['correct'])} | "
                 f"{pct(b['dodge_as_parry'])} | {pct(b['parry_as_dodge'])} | {pct(b['as_none'])} | {pct(b['derived_correct'])} | "
                 f"{'过' if r['gate']['pass'] else '不过'} |")
    L.append("")
    for name, r in res.items():
        L += [f"## {name}", "", "### 曲线（−16 … −4）", "",
              "| 帧 | (a) 金招→红 | (a) 每一下 金→红 | 金→没光（串） | (b) 应对判对 | 该闪判成卸 | 该卸判成闪 | 判成没有接触 | (b) 推出 |",
              "|---|---|---|---|---|---|---|---|---|"]
        for o in EVAL_OFFS:
            x = r["offsets"][str(o)]
            b = x["b"]["all"]
            L.append(f"| {o} | {pct(x['a']['gold_to_red'])} | {pct(x['a']['per_contact_gold_to_red'])} | {pct(x['a']['gold_to_none'])} | "
                     f"{pct(b['correct'])} | {pct(b['dodge_as_parry'])} | {pct(b['parry_as_dodge'])} | {pct(b['as_none'])} | "
                     f"{pct(b['derived_correct'])} |")
        x = r["offsets"][str(DECISION)]
        L += ["", "### 颜色混淆（−10，开场接触 / 每一下；行 = 真值，列 = 预测 gold / red / none）", ""]
        for t, m in (("开场", x["a"]["confusion_chains"]), ("每一下", x["a"]["per_contact_confusion"])):
            L.append(f"- {t}：" + "；".join(f"{COLORS[i]} → {m[i]}" for i in range(3)))
        bb = x["b"]
        L += ["", f"### (b) 分项（−10；抓取过场里的接触不计 {bb['grab_ticks_excluded']} 个）", "",
              "| 分项 | 判对 | 该闪判成卸 | 该卸判成闪 | 没有接触 | 推出：判对 | 推出：该闪判成卸 |", "|---|---|---|---|---|---|---|"]
        keys = ["all", "clean", "ahead"] + sorted((k for k in bb if k.startswith("k") and k[1:].isdigit()), key=lambda s: int(s[1:])) \
            + sorted(k for k in bb if k.startswith("g:")) + sorted((k for k in bb if k.startswith("c") and k[1:].isdigit()), key=lambda s: int(s[1:]))
        for k in keys:
            v = bb[k]
            L.append(f"| {k} | {pct(v['correct'])} | {pct(v['dodge_as_parry'])} | {pct(v['parry_as_dodge'])} | {pct(v['as_none'])} | "
                     f"{pct(v['derived_correct'])} | {pct(v['derived_dodge_as_parry'])} |")
        c = r["c"]
        L += ["", "### (c) 接触时间（−10）", "",
              "| 分项 | n | 中位 | 75% | 90% | ±3 帧内 | 判「无」 |", "|---|---|---|---|---|---|---|"]

        def trow(name_, v):
            if not v.get("n"):
                return f"| {name_} | 0 | | | | | |"
            return f"| {name_} | {v['n']} | {v['median']:.0f} | {v['p75']:.0f} | {v['p90']:.0f} | {pct(v['within3'])} | {pct(v['pred_none'])} |"
        for k in ("all", "clean", "ahead", "fatal"):
            L.append(trow(k, c[k]))
        for k, v in c["by_k"].items():
            L.append(trow(k, v))
        for k, v in c["by_group"].items():
            L.append(trow(k, v))
        L += ["", f"90 分位误差 = {c['p90_threshold']:.0f} 帧，尾部（≥ 该值）{c['tail_n']} 个。来源（tail_rate = 该类里落在尾部的比例，share = 占尾部）：", ""]
        for key, title in (("h", "boss 框高（检测器，决策帧；no box = 没找到 boss）"), ("ahead", "前一下还没到"), ("k", "位置"),
                           ("type", "接触类型"), ("g", "组（前 12）")):
            items = c["tail_sources"][key][:12]
            L.append(f"- {title}：" + "；".join(f"{s['value']} {s['tail']}/{s['n']} ({100 * s['tail_rate']:.0f}%, share {100 * s['share_of_tail']:.0f}%)" for s in items))
        L.append("")
    return "\n".join(L)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--pred", action="append", default=[])
    ap.add_argument("--old", default=str(OUT / "teacher" / "oof.npz"))
    ap.add_argument("--out", default=str(PREFIX))
    ap.add_argument("--extra-md", action="append", default=[])
    a = ap.parse_args()
    d = load()
    prefix = read_json(PREFIX / "prefix.json")
    preds = a.pred or [f"prefix_teacher={PREFIX / 'oof.npz'}"]
    res = {}
    for s in preds:
        name, path = s.split("=", 1)
        if not Path(path).exists():
            print("missing", path)
            continue
        z = np.load(path)
        res[name] = evaluate(new_adapter({k: z[k] for k in z.files}, prefix), d, prefix)
    if a.old and Path(a.old).exists():
        z = np.load(a.old)
        res["old_teacher"] = evaluate(old_adapter({k: z[k] for k in z.files}, d["classes"]), d, prefix)
    out = Path(a.out)
    write_json(out / "gate1.json", {"definitions": __doc__, "thresholds": {"a_max": A_MAX, "b_min": B_MIN},
                                    "prefix_params": prefix["params"], "models": res})
    md = report(res, prefix)
    for x in a.extra_md:
        if Path(x).exists():
            md += "\n" + Path(x).read_text(encoding="utf-8")
    (out / "gate1.md").write_text(md, encoding="utf-8")
    for name, r in res.items():
        x = r["offsets"][str(DECISION)]
        print(name, "a", pct(x["a"]["gold_to_red"]), "b", pct(x["b"]["all"]["correct"]),
              "dodge_as_parry", pct(x["b"]["all"]["dodge_as_parry"]), "pass", r["gate"]["pass"])


if __name__ == "__main__":
    main()
