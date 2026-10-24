"""Order 3: gate 1 evaluation (written before training; README "顺序 3"). Reads out-of-fold predictions, writes
data/moveid/teacher/gate1.json (every number with numerator / denominator) and gate1.md.

    uv run --no-project --with numpy python workspaces/WhereWindsMeet/tools/dufu_moveid/s3_gate1.py \
        [--pred teacher=data/moveid/teacher/oof.npz --pred base_linear=... --pred base_ncc=...]

Prediction file (npz), one row per contact (events_ext), outputs at STORE_OFFS = -30..0 frames from that contact:
  ids [n] event ids, offs [31], p_cls [n, 31, 45] (43 classes, 43 unknown, 44 idle), p_col [n, 31, 3] (gold, red,
  none), p_tte [n, 31, 47] (0..45 frames, 46 = none; optional), valid [n, 31] bool, fold [n].

Definitions (fixed before training, not changed after seeing results):
  chain          = events_ext chain; evaluated at its first contact c0; decision moment = c0 - 10, curve c0 - 16 .. c0 - 4
  (a)            opener colour gold chains whose colour argmax at the decision moment is red / gold chains
                 (denominator = gold chains, grab chains included; move-only also reported); also gold->none,
                 red->gold, none->gold, red->none, full 3x3 (opener colour 'unknown': 3 chains, excluded)
  (b)            fatal classes (taxonomy fatal = true): top-1 of the class head at the decision moment correct, where
                 a prediction in the same response-equivalence group counts as correct. Groups (s3_common):
                 'spec' = same opener colour + same mode chain length + every rhythm offset median within 2 frames
                 (connected components); 'same_response' = spec AND the same response (corrected variant: the spec
                 rule groups unparryable none-colour single hits c3 / c27 with parryable ones). Strict top-1 also.
  (c)            next-contact time: point estimate = median of the tte distribution (bin 46 = none, counted as 46);
                 |error| median / p90 over chains (true = -offset), and over all contacts.
                 Fatal response: truth = response(opener colour, true class) (gold -> dodge; class ok_rate < 0.2 ->
                 dodge; else parry); prediction = response(argmax colour, argmax class) (unknown / idle class ->
                 colour only); also colour-only prediction (dodge iff gold).
  gate 1 passes  = (a) <= 3% and (b, spec groups) >= 90%, both at -10; also reported at -8 and -6.
"""
from __future__ import annotations

import argparse
import collections
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s3_common import (COLORS, DECISION, EVAL_OFFS, IDLE, N_MOVE, STORE_OFFS, TEACHER, TTE_MAX, UNKNOWN,  # noqa: E402
                       equivalence_groups, group_list, load, response, write_json)

A_MAX, B_MIN = 0.03, 0.90
GATE_OFFS = (-10, -8, -6)


def frac(num, den) -> dict:
    return {"num": int(num), "den": int(den), "rate": (round(num / den, 4) if den else None)}


def cname(c: int) -> str:
    return "unknown" if c == UNKNOWN else "idle" if c == IDLE else f"c{c}"


def tte_point(p: np.ndarray) -> np.ndarray:
    """median bin of each distribution [..., 47] -> [...] int (46 = none)."""
    return (np.cumsum(p, -1) >= 0.5).argmax(-1)


def evaluate(pred: dict, d: dict) -> dict:
    classes = d["classes"]
    ev = {e["id"]: e for e in d["events"]}
    row = {int(i): k for k, i in enumerate(pred["ids"])}
    offs = list(pred["offs"])
    groups = {"spec": equivalence_groups(classes), "same_response": equivalence_groups(classes, True)}
    fatal = sorted(c for c, v in classes.items() if v.get("fatal"))
    openers = [e for e in d["events"] if e["chain_pos"] == 0]
    has_tte = pred.get("p_tte") is not None
    out = {"n_chains": len(openers), "offsets": {}}
    missing = [e["chain_id"] for e in openers if e["id"] not in row]
    out["missing_chains"] = len(missing)

    def at(e, o):
        k = row.get(e["id"])
        j = offs.index(o)
        if k is None or not pred["valid"][k, j]:
            return None
        return k, j

    for o in EVAL_OFFS:
        r = {}
        # (a) colour
        conf = np.zeros((3, 3), int)
        conf_move = np.zeros((3, 3), int)
        no_pred = 0
        for e in openers:
            if e["chain_color"] not in COLORS:
                continue
            kj = at(e, o)
            if kj is None:
                no_pred += 1
                continue
            p = int(pred["p_col"][kj].argmax())
            t = COLORS.index(e["chain_color"])
            conf[t, p] += 1
            if e["chain_kind"] == "move":
                conf_move[t, p] += 1
        g, rd, nn = 0, 1, 2
        r["a"] = {
            "gold_to_red": frac(conf[g, rd], conf[g].sum()),
            "gold_to_none": frac(conf[g, nn], conf[g].sum()),
            "red_to_gold": frac(conf[rd, g], conf[rd].sum()),
            "none_to_gold": frac(conf[nn, g], conf[nn].sum()),
            "red_to_none": frac(conf[rd, nn], conf[rd].sum()),
            "gold_correct": frac(conf[g, g], conf[g].sum()),
            "move_only_gold_to_red": frac(conf_move[g, rd], conf_move[g].sum()),
            "confusion": conf.tolist(), "confusion_move_only": conf_move.tolist(),
            "rows_true_cols_pred": list(COLORS), "chains_without_prediction": no_pred,
        }
        # (b) fatal classes
        bt = {"strict": [0, 0], "spec": [0, 0], "same_response": [0, 0]}
        per_class = {c: collections.Counter() for c in fatal}
        per_group = {gn: collections.defaultdict(collections.Counter) for gn in groups}
        pairs = collections.Counter()
        all_strict = [0, 0]
        for e in openers:
            kj = at(e, o)
            if kj is None:
                continue
            pc = int(pred["p_cls"][kj].argmax())
            tc = e["cls"]
            all_strict[1] += 1
            all_strict[0] += pc == tc
            if tc not in fatal:
                continue
            ok = {"strict": pc == tc}
            for gn, gm in groups.items():
                ok[gn] = pc == tc or (pc < N_MOVE and gm.get(pc) == gm.get(tc))
                per_group[gn][gm[tc]]["n"] += 1
                per_group[gn][gm[tc]]["ok"] += ok[gn]
            for k in bt:
                bt[k][0] += ok[k]
                bt[k][1] += 1
            per_class[tc]["n"] += 1
            for k in ok:
                per_class[tc][k] += ok[k]
            if pc != tc:
                pairs[(tc, pc)] += 1
        r["b"] = {k: frac(*v) for k, v in bt.items()}
        r["b"]["all_chains_strict"] = frac(*all_strict)
        r["b"]["per_class"] = {cname(c): {"n": v["n"], "strict": v["strict"], "spec": v["spec"],
                                          "same_response": v["same_response"]} for c, v in per_class.items()}
        r["b"]["per_group"] = {gn: {"+".join(cname(c) for c in sorted(x for x, gg in groups[gn].items() if gg == gid)):
                                    {"n": v["n"], "ok": v["ok"]} for gid, v in sorted(pg.items())}
                               for gn, pg in per_group.items()}
        r["b"]["top_confusions"] = [
            {"true": cname(t), "pred": cname(p), "n": n,
             "same_group_spec": bool(p < N_MOVE and groups["spec"].get(p) == groups["spec"].get(t)),
             "same_group_same_response": bool(p < N_MOVE and groups["same_response"].get(p) == groups["same_response"].get(t))}
            for (t, p), n in pairs.most_common(20)]
        # (c) next contact time
        if has_tte:
            errs, nones = [], 0
            for e in openers:
                kj = at(e, o)
                if kj is None:
                    continue
                k = int(tte_point(pred["p_tte"][kj].astype(np.float64)))
                nones += k == TTE_MAX + 1
                errs.append(abs(k - (-o)))
            errs_all, nones_all = [], 0
            for e in d["events"]:
                kj = at(e, o)
                if kj is None:
                    continue
                k = int(tte_point(pred["p_tte"][kj].astype(np.float64)))
                nones_all += k == TTE_MAX + 1
                errs_all.append(abs(k - (-o)))
            r["c_tte"] = {
                "chains": {"n": len(errs), "median": float(np.median(errs)), "p90": float(np.percentile(errs, 90)),
                           "within2": frac(sum(x <= 2 for x in errs), len(errs)), "pred_none": frac(nones, len(errs))},
                "all_contacts": {"n": len(errs_all), "median": float(np.median(errs_all)),
                                 "p90": float(np.percentile(errs_all, 90)),
                                 "within2": frac(sum(x <= 2 for x in errs_all), len(errs_all)),
                                 "pred_none": frac(nones_all, len(errs_all))}}
        # (c) fatal response
        act = {"model": [0, 0], "colour_only": [0, 0], "dodge_as_parry": [0, 0], "parry_as_dodge": [0, 0]}
        for e in openers:
            if e["cls"] not in fatal or e["chain_color"] not in COLORS:
                continue
            kj = at(e, o)
            if kj is None:
                continue
            truth = response(e["chain_color"], e["cls"], classes)
            pcol = COLORS[int(pred["p_col"][kj].argmax())]
            pc = int(pred["p_cls"][kj].argmax())
            pm = response(pcol, pc if pc < N_MOVE else -1, classes)
            pco = "dodge" if pcol == "gold" else "parry"
            act["model"][0] += pm == truth
            act["model"][1] += 1
            act["colour_only"][0] += pco == truth
            act["colour_only"][1] += 1
            if truth == "dodge":
                act["dodge_as_parry"][1] += 1
                act["dodge_as_parry"][0] += pm == "parry"
            else:
                act["parry_as_dodge"][1] += 1
                act["parry_as_dodge"][0] += pm == "dodge"
        r["c_response"] = {k: frac(*v) for k, v in act.items()}
        out["offsets"][str(o)] = r
    gate = {}
    for o in GATE_OFFS:
        r = out["offsets"][str(o)]
        a = r["a"]["gold_to_red"]["rate"]
        gate[str(o)] = {gn: {"a": a, "b": r["b"][gn]["rate"],
                             "pass": bool(a is not None and a <= A_MAX and r["b"][gn]["rate"] >= B_MIN)}
                        for gn in ("spec", "same_response")}
    out["gate"] = gate
    out["pass"] = gate[str(DECISION)]["spec"]["pass"]
    return out


def load_pred(path: Path) -> dict:
    z = np.load(path, allow_pickle=False)
    p = {k: z[k] for k in z.files}
    p.setdefault("p_tte", None)
    if p["p_tte"] is not None and p["p_tte"].size == 0:
        p["p_tte"] = None
    return p


def pct(x) -> str:
    return "–" if x is None or x.get("rate") is None else f"{x['num']}/{x['den']} = {100 * x['rate']:.1f}%"


def report(res: dict, d: dict) -> str:
    classes = d["classes"]
    L = ["# 关 1：老师模型离线判定（顺序 3）", "",
         "数字全部来自 out-of-fold 预测（按轮次 5 折）；口径见 `s3_gate1.py` 文档字符串（训练前写定）。分子 / 分母全在 gate1.json。", ""]
    L += ["## 应对等价组（训练前自动定）", ""]
    for gn, title in (("spec", "原口径：开场颜色相同 + 串长众数相同 + 各接触偏移中位差 ≤2 帧（连通分量）"),
                      ("same_response", "修正口径：原口径再要求应对相同（金 / 卸住率 <20% → 闪，否则卸）")):
        gl = [x for x in group_list(equivalence_groups(classes, gn == "same_response")) if len(x) > 1]
        L.append(f"- {title}：" + "；".join("{" + ", ".join(cname(c) for c in x) + "}" for x in gl) + "；其余各类自成一组。")
    fatal = sorted(c for c, v in classes.items() if v.get("fatal"))
    L += [f"- 致命类（taxonomy fatal）{len(fatal)} 个：" + ", ".join(cname(c) for c in fatal), ""]
    L += ["## 判定（−10 帧；另报 −8、−6）", "",
          "| 模型 | 帧 | (a) 金→红 | (b) 致命类 原口径 | (b) 修正口径 | (b) 严格 top-1 | 过关（原 / 修正） |", "|---|---|---|---|---|---|---|"]
    for name, r in res.items():
        for o in GATE_OFFS:
            x = r["offsets"][str(o)]
            gt = r["gate"][str(o)]
            L.append(f"| {name} | {o} | {pct(x['a']['gold_to_red'])} | {pct(x['b']['spec'])} | {pct(x['b']['same_response'])} | "
                     f"{pct(x['b']['strict'])} | {'过' if gt['spec']['pass'] else '不过'} / {'过' if gt['same_response']['pass'] else '不过'} |")
    L.append("")
    for name, r in res.items():
        L += [f"## {name}", "", "### 曲线（−16 … −4）", "",
              "| 帧 | 金→红 | 金→没光 | 红→金 | 没光→金 | 红→没光 | 致命 原口径 | 致命 修正 | 严格 top-1（全部串） | 接触时间绝对误差 中位 / p90（串） | 判成「无」 | 致命应对 模型 | 致命应对 只看颜色 |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for o in EVAL_OFFS:
            x = r["offsets"][str(o)]
            a = x["a"]
            tte = x.get("c_tte")
            tt = f"{tte['chains']['median']:.0f} / {tte['chains']['p90']:.0f}" if tte else "–"
            tn = pct(tte["chains"]["pred_none"]) if tte else "–"
            L.append(f"| {o} | {pct(a['gold_to_red'])} | {pct(a['gold_to_none'])} | {pct(a['red_to_gold'])} | {pct(a['none_to_gold'])} | "
                     f"{pct(a['red_to_none'])} | {pct(x['b']['spec'])} | {pct(x['b']['same_response'])} | {pct(x['b']['all_chains_strict'])} | "
                     f"{tt} | {tn} | {pct(x['c_response']['model'])} | {pct(x['c_response']['colour_only'])} |")
        x = r["offsets"][str(DECISION)]
        a = x["a"]
        L += ["", "### 颜色混淆（−10，行 = 真值，列 = 预测）", "", "| 真 \\ 预测 | gold | red | none |", "|---|---|---|---|"]
        for i, c in enumerate(COLORS):
            L.append(f"| {c} | " + " | ".join(str(v) for v in a["confusion"][i]) + " |")
        L += ["", f"只算出招串（不含抓取）：金→红 {pct(a['move_only_gold_to_red'])}。", ""]
        if x.get("c_tte"):
            t = x["c_tte"]
            L += [f"接触时间（−10）：串 n={t['chains']['n']} 中位 {t['chains']['median']:.1f} p90 {t['chains']['p90']:.1f}，±2 帧内 {pct(t['chains']['within2'])}；"
                  f"全部接触 n={t['all_contacts']['n']} 中位 {t['all_contacts']['median']:.1f} p90 {t['all_contacts']['p90']:.1f}，±2 帧内 {pct(t['all_contacts']['within2'])}。", ""]
        cr = x["c_response"]
        L += [f"致命串应对（−10）：模型 {pct(cr['model'])}；只看颜色 {pct(cr['colour_only'])}；该闪判成卸 {pct(cr['dodge_as_parry'])}；该卸判成闪 {pct(cr['parry_as_dodge'])}。", ""]
        L += ["### 致命类逐类（−10）", "", "| 类 | 串 | 严格 | 原口径 | 修正口径 |", "|---|---|---|---|---|"]
        for c, v in x["b"]["per_class"].items():
            n = v["n"] or 1
            L.append(f"| {c} | {v['n']} | {v['strict']} ({100 * v['strict'] / n:.0f}%) | {v['spec']} ({100 * v['spec'] / n:.0f}%) | "
                     f"{v['same_response']} ({100 * v['same_response'] / n:.0f}%) |")
        L += ["", "### 按等价组（−10，只含致命串；组名列出组内全部类）", ""]
        for gn in ("spec", "same_response"):
            L.append(f"- {gn}：" + "；".join(f"{k} {v['ok']}/{v['n']}" for k, v in x["b"]["per_group"][gn].items()))
        L += ["", "### 致命类混淆前 20 对（−10，严格不等；标出是否同组）", "", "| 真 | 预测 | 串 | 同组（原） | 同组（修正） |", "|---|---|---|---|---|"]
        for p in x["b"]["top_confusions"]:
            L.append(f"| {p['true']} | {p['pred']} | {p['n']} | {'是' if p['same_group_spec'] else ''} | {'是' if p['same_group_same_response'] else ''} |")
        L.append("")
    return "\n".join(L)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--pred", action="append", default=[], help="name=path.npz (repeatable)")
    ap.add_argument("--out", default=str(TEACHER))
    ap.add_argument("--extra-md", action="append", default=[], help="markdown file(s) appended to gate1.md")
    a = ap.parse_args()
    preds = a.pred or [f"teacher={TEACHER / 'oof.npz'}", f"base_linear={TEACHER / 'baseline' / 'oof_linear.npz'}",
                       f"base_ncc={TEACHER / 'baseline' / 'oof_ncc.npz'}"]
    d = load()
    res = {}
    for s in preds:
        name, path = s.split("=", 1)
        if not Path(path).exists():
            print("missing", path)
            continue
        res[name] = evaluate(load_pred(Path(path)), d)
    out = Path(a.out)
    groups = {gn: [[cname(c) for c in x] for x in group_list(equivalence_groups(d["classes"], gn == "same_response"))]
              for gn in ("spec", "same_response")}
    write_json(out / "gate1.json", {"definitions": __doc__, "thresholds": {"a_max": A_MAX, "b_min": B_MIN},
                                    "groups": groups, "models": res})
    md = report(res, d)
    for x in a.extra_md:
        if Path(x).exists():
            md += "\n" + Path(x).read_text(encoding="utf-8")
    (out / "gate1.md").write_text(md, encoding="utf-8")
    for name, r in res.items():
        x = r["offsets"][str(DECISION)]
        print(name, "a", pct(x["a"]["gold_to_red"]), "b", pct(x["b"]["spec"]), "b_corr", pct(x["b"]["same_response"]),
              "pass", r["pass"])


if __name__ == "__main__":
    main()
