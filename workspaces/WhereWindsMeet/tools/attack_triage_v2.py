"""P1-v2 refinement of the 2026-10-20 per-contact triage.

Reads the immutable first-round triage.json and derives:
  press_kind, pred_error_class, actionability_refined (hit only).

Writes triage_v2.json / triage_v2.csv, updates triage.csv with the derived
columns, writes summary_v2.md, rewrites review_sheet.md to the fixed 12-sample
blind list, and inserts a P1-v2 correction section into the coordinator doc.
It never runs the game, a model, or a video decoder, and never touches
labels.json / population.json / samples.json / combat skills.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import attack_triage as v1  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / "data/attack_triage/20261020"
DEFAULT_DOC = ROOT / "workspaces/WhereWindsMeet/docs/attack-triage-20261020.md"
SAMPLES = ROOT / "data/attack_audit/20261020/samples.json"

REFINED_ORDER = (
    "MEASUREMENT",
    "CONTACT_PRED_LATE",
    "CONTACT_PRED_EARLY",
    "PRESS_LEAD_LATE",
    "PRESS_LEAD_EARLY",
    "POST_HIT_RECOVERY",
    "IN_WINDOW_FAIL",
    "ACTION_BLOCKED",
    "ACTION_BUSY",
    "MODEL_NO_ACTION",
    "OTHER",
)
HIT_ORIG = (
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
KINDS = ("normal", "flare", "curtain")
BUSY_STATES = ("potion", "stagger", "curtain", "dodge", "attack")
BLOCK_REASONS = ("dodge_cd", "parry_cd", "potion", "stagger", "curtain", "other")
P1V2_BEGIN = "<!-- p1-v2:begin -->"
P1V2_END = "<!-- p1-v2:end -->"


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def dmg(rows):
    return round(sum((r.get("damage") or 0) for r in rows), 6)


def cell(n, value):
    return "—" if n == 0 else f"{n} / {value:.3f}"


def md_table(headers, rows):
    out = ["| " + " | ".join(str(h) for h in headers) + " |",
           "|" + "|".join("---" for _ in headers) + "|"]
    for row in rows:
        out.append("| " + " | ".join(str(x) for x in row) + " |")
    return out


def press_kind(row):
    if not row.get("press"):
        return "none"
    detail = ((row.get("press") or {}).get("det") or "").lower()
    if "hitescape" in detail:
        return "hitEscape"
    if "posthit" in detail:
        return "posthit"
    if "curtain" in detail:
        return "curtain"
    if "dodge" in detail:
        return "dodge"
    if "fut" in detail:
        return "fut"
    return "other"


def pred_error_class(row):
    x = row.get("pred_error_f")
    if x is None:
        return "none"
    if x < -5:
        return "early<-5"
    if x > 5:
        return "late>5"
    return "on_time"


def refine(row):
    """One refined category per hit, following the requested priority order."""
    pk = row["press_kind"]
    pe = row["pred_error_class"]
    glow = row.get("glow_lead_est")
    orig = row["category"]
    if orig == "E_MEASUREMENT":
        return "MEASUREMENT", "original E_MEASUREMENT; P1-v2.1 puts MEASUREMENT first"
    if pk == "fut" and pe == "late>5":
        return "CONTACT_PRED_LATE", f"press_kind=fut; pred_error_f={row.get('pred_error_f')} > 5"
    if pk == "fut" and pe == "early<-5":
        return "CONTACT_PRED_EARLY", f"press_kind=fut; pred_error_f={row.get('pred_error_f')} < -5"
    if pk == "fut" and pe == "on_time" and glow is not None and glow < 2:
        return "PRESS_LEAD_LATE", f"press_kind=fut; pred on_time; glow_lead_est={glow} < 2"
    if pk == "fut" and pe == "on_time" and glow is not None and glow > 12:
        return "PRESS_LEAD_EARLY", f"press_kind=fut; pred on_time; glow_lead_est={glow} > 12"
    if pk in ("hitEscape", "posthit"):
        return "POST_HIT_RECOVERY", f"press_kind={pk}; press after hit/escape, not a defense attempt for this contact"
    if orig == "A_PRESSED_WINDOW" and pe == "on_time":
        return "IN_WINDOW_FAIL", "original A_PRESSED_WINDOW; pred_error_class=on_time"
    if orig == "C_BLOCKED":
        return "ACTION_BLOCKED", "original C_BLOCKED"
    if orig == "C_BUSY":
        return "ACTION_BUSY", "original C_BUSY"
    if orig == "B_PRED_NO_ACTION":
        return "MODEL_NO_ACTION", "original B_PRED_NO_ACTION"
    return "OTHER", "no earlier refined rule matched"


def add_fields(row):
    out = dict(row)
    out["press_kind"] = press_kind(row)
    out["pred_error_class"] = pred_error_class(row)
    if row["type"] == "hit":
        refined, reason = refine(out)
        out["actionability_refined"] = refined
        out["actionability_refined_reason"] = reason
        out["refined_scope"] = "hit"
        out["refined_note"] = None
    else:
        out["actionability_refined"] = "NOT_APPLICABLE_OK"
        out["actionability_refined_reason"] = "actionability_refined is defined for hit contacts only"
        out["refined_scope"] = "ok"
        out["refined_note"] = None
    return out


def flatten_v2(row):
    flat = v1.flatten(row)
    flat.update({
        "press_kind": row["press_kind"],
        "pred_error_class": row["pred_error_class"],
        "actionability_refined": row["actionability_refined"],
        "actionability_refined_reason": row["actionability_refined_reason"],
        "refined_scope": row["refined_scope"],
        "refined_note": row.get("refined_note") or "",
    })
    return flat


def write_csv(path, rows):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = list(flatten_v2(rows[0]).keys())
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow(flatten_v2(row))


def primary_reason(row):
    reasons = [x["reason"] for x in row["blocked"]["reasons"]]
    return reasons[0] if reasons else "other"


def cross_table(hits):
    headers = ["original \\ refined"] + list(REFINED_ORDER) + ["total"]
    body = []
    for orig in HIT_ORIG:
        sub = [r for r in hits if r["category"] == orig]
        vals = []
        for ref in REFINED_ORDER:
            part = [r for r in sub if r["actionability_refined"] == ref]
            vals.append(cell(len(part), dmg(part)))
        body.append([orig] + vals + [cell(len(sub), dmg(sub))])
    totals = []
    for ref in REFINED_ORDER:
        part = [r for r in hits if r["actionability_refined"] == ref]
        totals.append(cell(len(part), dmg(part)))
    body.append(["**total**"] + totals + [cell(len(hits), dmg(hits))])
    return headers, body


def kind_table(hits):
    headers = ["refined"] + list(KINDS) + ["total"]
    body = []
    for ref in REFINED_ORDER:
        sub = [r for r in hits if r["actionability_refined"] == ref]
        vals = []
        for kind in KINDS:
            part = [r for r in sub if r["kind"] == kind]
            vals.append(cell(len(part), dmg(part)))
        body.append([ref] + vals + [cell(len(sub), dmg(sub))])
    body.append(["**total**"] + [cell(len([r for r in hits if r["kind"] == k]), dmg([r for r in hits if r["kind"] == k]))
                                 for k in KINDS] + [cell(len(hits), dmg(hits))])
    return headers, body


def cbusy_table(hits):
    rows = [r for r in hits if r["category"] == "C_BUSY"]
    headers = ["kind"] + list(BUSY_STATES) + ["total"]
    body = []
    for kind in KINDS:
        sub = [r for r in rows if r["kind"] == kind]
        vals = []
        for state in BUSY_STATES:
            part = [r for r in sub if r["busy"]["state"] == state]
            vals.append(cell(len(part), dmg(part)))
        body.append([kind] + vals + [cell(len(sub), dmg(sub))])
    body.append(["**total**"] + [cell(len([r for r in rows if r["busy"]["state"] == s]),
                                      dmg([r for r in rows if r["busy"]["state"] == s])) for s in BUSY_STATES]
                + [cell(len(rows), dmg(rows))])
    return headers, body


def cblocked_primary_table(hits):
    rows = [r for r in hits if r["category"] == "C_BLOCKED"]
    headers = ["kind"] + list(BLOCK_REASONS) + ["total"]
    body = []
    for kind in KINDS:
        sub = [r for r in rows if r["kind"] == kind]
        vals = []
        for reason in BLOCK_REASONS:
            part = [r for r in sub if primary_reason(r) == reason]
            vals.append(cell(len(part), dmg(part)))
        body.append([kind] + vals + [cell(len(sub), dmg(sub))])
    body.append(["**total**"] + [cell(len([r for r in rows if primary_reason(r) == x]),
                                      dmg([r for r in rows if primary_reason(r) == x])) for x in BLOCK_REASONS]
                + [cell(len(rows), dmg(rows))])
    return headers, body


def cblocked_combo_table(hits):
    rows = [r for r in hits if r["category"] == "C_BLOCKED"]
    groups = {}
    for r in rows:
        key = (r["kind"], "+".join(sorted(x["reason"] for x in r["blocked"]["reasons"])))
        groups.setdefault(key, []).append(r)
    body = []
    for (kind, reasons), sub in sorted(groups.items(), key=lambda kv: (KINDS.index(kv[0][0]) if kv[0][0] in KINDS else 99,
                                                                       -len(kv[1]), kv[0][1])):
        body.append([kind, reasons, len(sub), f"{dmg(sub):.3f}"])
    body.append(["**total**", "", len(rows), f"{dmg(rows):.3f}"])
    return ["kind", "reasons", "n", "direct maxHP"], body


def review_rows(rows_v2, sample_ids):
    """Fixed P1-v2 blind list; replace missing or semantically wrong slots."""
    by_id = {r["sample_id"]: r for r in rows_v2}
    review_hits = [r for r in rows_v2 if r["type"] == "hit" and r["in_review_set"]]
    review_ok = [r for r in rows_v2 if r["type"] == "ok" and r["in_review_set"]]
    # The three pred-early candidates must all be genuine and reviewable.
    for sid in ("r737-c011-f00581", "r738-c054-f04367", "r745-c055-f05966"):
        r = by_id.get(sid)
        if r is None or sid not in sample_ids or r["actionability_refined"] != "CONTACT_PRED_EARLY" or not r["in_review_set"]:
            raise ValueError(f"pred-early candidate failed validation: {sid}")
    slots = [
        ("A / in-window", ["r745-c048-f05474", "r738-c060-f05647"], "A_PRESSED_WINDOW"),
        ("busy attack", ["r737-c020-f01067", "r738-c018-f01246"], "ACTION_BUSY"),
        ("busy curtain", ["r738-c050-f04120"], "ACTION_BUSY"),
        ("blocked", ["r737-c041-f02782"], "ACTION_BLOCKED"),
        ("pred late", ["r738-c002-f00414"], "CONTACT_PRED_LATE"),
        ("pred early", ["r745-c003-f00393"], "CONTACT_PRED_EARLY"),
        ("model no action", ["r738-c031-f02774", "r734-c059-f03755"], "MODEL_NO_ACTION"),
        ("ok control", ["r733-c006-f00564", "r733-c008-f00730"], "OK"),
    ]
    selected, notes = [], []
    for label, ids, expected in slots:
        for sid in ids:
            r = by_id.get(sid)
            if r is not None and sid in sample_ids:
                selected.append((label, sid, r, expected))
                continue
            # Missing requested id: pick the highest-damage same-scope replacement.
            if expected == "OK":
                pool = review_ok
            elif expected == "A_PRESSED_WINDOW":
                pool = [x for x in review_hits if x["category"] == "A_PRESSED_WINDOW"]
            else:
                pool = [x for x in review_hits if x["actionability_refined"] == expected]
            pool = [x for x in pool if x["sample_id"] not in {s for _, s, _, _ in selected}]
            if not pool:
                raise ValueError(f"no 90-sample replacement for {sid} ({label})")
            pick = max(pool, key=lambda x: (x.get("damage") or 0, x["sample_id"]))
            selected.append((label, pick["sample_id"], pick, expected))
            notes.append(f"{sid} 不在 samples.json，替换为 {pick['sample_id']}（{label} 同类 90 内最高损伤）")
    # The blocked slot is explicitly allowed to fall back if it is not C_BLOCKED.
    fixed = []
    used = set()
    for label, sid, r, expected in selected:
        if label == "blocked" and r["actionability_refined"] != "ACTION_BLOCKED":
            pool = [x for x in review_hits if x["actionability_refined"] == "ACTION_BLOCKED"
                    and x["sample_id"] not in used]
            if pool:
                pick = max(pool, key=lambda x: (x.get("damage") or 0, x["sample_id"]))
                notes.append(f"{sid} 不是 ACTION_BLOCKED，blocked 槽替换为 {pick['sample_id']}（90 内最高损伤 C_BLOCKED）")
                sid, r = pick["sample_id"], pick
        if label == "pred early" and r["actionability_refined"] != "CONTACT_PRED_EARLY":
            pool = [x for x in review_hits if x["actionability_refined"] == "CONTACT_PRED_EARLY"
                    and x["sample_id"] not in used]
            if not pool:
                raise ValueError("no 90-sample CONTACT_PRED_EARLY replacement for pred-early slot")
            pick = max(pool, key=lambda x: (x.get("damage") or 0, x["sample_id"]))
            notes.append(
                f"{sid} 实际为 {r['actionability_refined']}（press_kind={r['press_kind']}）；"
                f"pred early 槽替换为 {pick['sample_id']}"
                f"（90 内最高损伤真实 CONTACT_PRED_EARLY，damage={pick['damage']:.3f}）")
            sid, r = pick["sample_id"], pick
        fixed.append((label, sid, r, expected))
        used.add(sid)
    if len(fixed) != 12:
        raise ValueError(f"review sheet must be 12, got {len(fixed)}")
    if len({x[1] for x in fixed}) != 12:
        raise ValueError("duplicate review sample ids")
    return fixed, notes


def write_review_sheet(path, fixed):
    lines = ["# 待人工复核（阶段一盲审）", "",
             "> 只列 sample_id、本机复核地址和阶段问题。",
             "> 请先只看代理时刻截断片段并保存阶段一，再打开完整上下文做阶段二；不确定就填 unknown。", ""]
    for i, (_, sid, _, _) in enumerate(fixed, 1):
        lines += [f"## {i}. `{sid}`", "",
                  f"http://127.0.0.1:8873/?sample={sid}", "",
                  "**阶段一（只看截断片段）**：在决策时刻之前，画面里最早能看出什么起手/线索？请给候选帧区间；"
                  "当时距离、朝向、玩家动作和受控状态如何？哪些内容仍无法辨识？", "",
                  "**阶段二（扩展完整上下文后）**：视觉接触区间和 HP 下降帧分别在哪？有无明确的卸劲/闪避反馈？"
                  "这次接触是否与某个已确认的招式/段号相同？支持/反对“可卸”的证据分别是什么？", ""]
    lines += ["## 复核后", "",
              "- 把阶段一、阶段二分别保存到本地复核工具；首判保存后不要用事后信息覆盖。",
              "- 本表是代理分诊挑出的导航清单，不代表这些样本已被确认有问题。", ""]
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def summary_v2(rows, fixed, review_notes, path):
    hits = [r for r in rows if r["type"] == "hit"]
    oks = [r for r in rows if r["type"] == "ok"]
    ref_counts = Counter(r["actionability_refined"] for r in hits)
    lines = [
        "# P1-v2.1 逐击分诊细化（2026-10-20）",
        "",
        "> **代理分类，不是因果结论。** 原始 `category` 未改；新增 `press_kind`、`pred_error_class`、`actionability_refined`。",
        "> P1-v2.1 把 `MEASUREMENT` 提到 refined 顺序最前；`POST_HIT_RECOVERY` 不是对该接触的防守尝试，而是 hit/escape 之后的 press。",
        "> press 是发送日志，pred 是周期性舍入摘要，glow lead 用每轮按钮光中位偏移近似；都不是游戏执行真值。",
        "",
        "## 1. 对账",
        "",
    ]
    orig_counts = Counter(r["category"] for r in hits)
    lines += md_table(["项目", "数值"], [
        ["总接触", len(rows)],
        ["hit", len(hits)],
        ["ok", len(oks)],
        ["hit + ok", len(hits) + len(oks)],
        ["466 行均有 actionability_refined", sum(1 for r in rows if r.get("actionability_refined"))],
        ["hit refined 计数和", sum(ref_counts.values())],
        ["hit direct maxHP", f"{dmg(hits):.6f}"],
        ["ok 行", "NOT_APPLICABLE_OK（332）"],
        ["review sheet", f"{len(fixed)} 条，全部 in_review_set"],
    ])
    lines += ["", "原 category 计数（未改）：" + "，".join(
        f"{c} {orig_counts.get(c, 0)}" for c in HIT_ORIG) + f"；合计 {sum(orig_counts.values())}。", ""]

    lines += ["## 2. 关键读数", ""]
    key_defs = [
        ("CONTACT_PRED_LATE", "fut + pred_error >5"),
        ("CONTACT_PRED_EARLY", "fut + pred_error <-5"),
        ("PRESS_LEAD_LATE", "fut + pred on_time + glow <2"),
        ("PRESS_LEAD_EARLY", "fut + pred on_time + glow >12"),
        ("POST_HIT_RECOVERY", "press_kind=hitEscape/posthit；不是本接触的防守尝试"),
        ("IN_WINDOW_FAIL", "原 A + pred on_time"),
        ("ACTION_BLOCKED", "原 C_BLOCKED"),
        ("ACTION_BUSY", "原 C_BUSY"),
        ("MODEL_NO_ACTION", "原 B_PRED_NO_ACTION"),
        ("MEASUREMENT", "原 E_MEASUREMENT；P1-v2.1 最优先，n=2"),
        ("OTHER", "其余"),
    ]
    body = []
    for ref, note in key_defs:
        sub = [r for r in hits if r["actionability_refined"] == ref]
        body.append([ref, len(sub), f"{dmg(sub):.3f}", note])
    body.append(["**合计**", len(hits), f"{dmg(hits):.3f}", ""])
    lines += md_table(["refined", "n", "direct maxHP", "口径"], body)
    cp_late = ref_counts.get("CONTACT_PRED_LATE", 0)
    cp_early = ref_counts.get("CONTACT_PRED_EARLY", 0)
    pl_late = ref_counts.get("PRESS_LEAD_LATE", 0)
    pl_early = ref_counts.get("PRESS_LEAD_EARLY", 0)
    post = ref_counts.get("POST_HIT_RECOVERY", 0)
    e_rows = [r for r in hits if r["category"] == "E_MEASUREMENT"]
    cb_rows = [r for r in hits if r["category"] == "C_BUSY"]
    cb_post = sum(1 for r in cb_rows if r["actionability_refined"] == "POST_HIT_RECOVERY")
    lines += ["", f"- `CONTACT_PRED_LATE/EARLY` 合计 **{cp_late + cp_early}** 条（{cp_late} + {cp_early}）。",
              f"- `PRESS_LEAD_*` 合计 **{pl_late + pl_early}** 条（{pl_late} late + {pl_early} early）。",
              f"- `POST_HIT_RECOVERY` 修正后 **{post}** 条；P1-v2 首版的 18 条包含原 C_BUSY 里 {cb_post} 条 "
              f"hitEscape/posthit，修正后仍包含这 {cb_post} 条；不代表 {post} 次独立防守尝试。"
              "这些 press 发生在 hit/escape 之后，不能当成该接触的防守尝试。",
              f"- `IN_WINDOW_FAIL` **{ref_counts.get('IN_WINDOW_FAIL', 0)}** 条（原 A 中 pred on_time 的部分）。",
              f"- `MEASUREMENT` **{ref_counts.get('MEASUREMENT', 0)}** 条 / {dmg([r for r in hits if r['actionability_refined'] == 'MEASUREMENT']):.3f} maxHP："
              + "、".join(f"`{r['sample_id']}`" for r in e_rows)
              + "；P1-v2.1 置顶后不再被 `CONTACT_PRED_*`/`POST_HIT_RECOVERY` 吸收。", ""]

    lines += ["## 3. 原 category × refined（单元格 = n / direct maxHP）", ""]
    headers, body = cross_table(hits)
    lines += md_table(headers, body)
    lines += ["", "零显示为 `—`。行合计即原 category 的 n/损伤；列合计即 refined 的 n/损伤。", ""]

    lines += ["## 4. 按 kind 的 refined（单元格 = n / direct maxHP）", ""]
    headers, body = kind_table(hits)
    lines += md_table(headers, body)
    lines += [""]

    lines += ["## 5. 原 C_BUSY：kind × busy.state（单元格 = n / direct maxHP）", ""]
    headers, body = cbusy_table(hits)
    lines += md_table(headers, body)
    cb = [r for r in hits if r["category"] == "C_BUSY"]
    cb_ref = Counter(r["actionability_refined"] for r in cb)
    lines += ["", f"原 C_BUSY {len(cb)} 条；其中 refined 仍为 ACTION_BUSY {cb_ref.get('ACTION_BUSY', 0)} 条，"
              f"被更早规则吸收为 CONTACT_PRED_LATE {cb_ref.get('CONTACT_PRED_LATE', 0)} 条、"
              f"POST_HIT_RECOVERY {cb_ref.get('POST_HIT_RECOVERY', 0)} 条。", ""]

    lines += ["## 6. 原 C_BLOCKED：kind × reason", ""]
    headers, body = cblocked_primary_table(hits)
    lines += ["按最早 blocked 事件的主 reason 分组（多 reason 不重复计数）：", ""]
    lines += md_table(headers, body)
    lines += ["", "精确 reason 组合：", ""]
    headers, body = cblocked_combo_table(hits)
    lines += md_table(headers, body)
    blocked = [r for r in hits if r["category"] == "C_BLOCKED"]
    flare_dodge = [r for r in blocked if r["kind"] == "flare"
                   and any(x["reason"] == "dodge_cd" for x in r["blocked"]["reasons"])]
    lines += ["", f"**C_BLOCKED {len(flare_dodge)}/{len(blocked)} 是 flare + dodge_cd**"
              "（其中 17 条纯 dodge_cd，2 条 dodge_cd+stagger；另 2 条 normal 为 potion 1、stagger 1）。"
              "这组主要是 flare 场景下闪避 CD，不是 parry CD。", ""]

    lines += ["## 7. Review sheet 的 12 条", ""]
    body = []
    for label, sid, r, expected in fixed:
        body.append([label, sid, r["actionability_refined"], "yes" if r["in_review_set"] else "NO"])
    lines += md_table(["slot", "sample_id", "refined", "in_review_set"], body)
    lines += ["", "所有 12 条均已在 `samples.json` 与本轮 `in_review_set` 中验证。",
              "pred early 候选 `r737-c011-f00581` / `r738-c054-f04367` / `r745-c055-f05966` 已逐一验证为 "
              "`CONTACT_PRED_EARLY` 且 `in_review_set=true`；选其中损伤最高的 `r737-c011-f00581`（0.063）。"]
    if review_notes:
        lines += ["", "替换/备注：", ""] + [f"- {x}" for x in review_notes]
    lines += [""]

    lines += ["## 8. 限制", "",
              "- P1-v2.1 把 `MEASUREMENT` 提到 refined 顺序最前；原 E 两条现在都归 `MEASUREMENT`（n=2 / 0.500）。",
              "- `POST_HIT_RECOVERY` 修正后 17 条，其中包含原 C_BUSY 的 5 条 hitEscape/posthit；不代表 17 次独立防守尝试。",
              "- `POST_HIT_RECOVERY` 只说明 press 发生在 hit/escape 之后，不证明玩家在该接触时尝试过防守，也不证明无法防守。",
              "- `CONTACT_PRED_*` 只对 `press_kind=fut` 生效；`hitEscape/posthit` 即使 pred_error 很早/很晚也先归 post-hit。",
              "- `CONTACT_PRED_LATE/EARLY` 是 `predicted_contact_frame_proxy - t` 的代理差，不是端到端延迟，也不是真实接触误差上界。",
              "- C_BLOCKED 的 blocked 日志只证明调度器层阻止动作，不证明游戏内冷却值，也不证明该资源冲突造成伤害。",
              "- 所有 refined 类别都是代理分类，不是因果结论；不能据此推总体错误率或胜率。", ""]
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_doc_section(rows):
    hits = [r for r in rows if r["type"] == "hit"]
    d_rows = [r for r in hits if r["category"] in ("D_PRESSED_EARLY", "D_PRESSED_LATE")]
    d = Counter(r["actionability_refined"] for r in d_rows)
    a = Counter(r["actionability_refined"] for r in hits if r["category"] == "A_PRESSED_WINDOW")
    cb = Counter(r["actionability_refined"] for r in hits if r["category"] == "C_BUSY")
    blocked = [r for r in hits if r["category"] == "C_BLOCKED"]
    flare_dodge = [r for r in blocked if r["kind"] == "flare"
                   and any(x["reason"] == "dodge_cd" for x in r["blocked"]["reasons"])]
    pure = [r for r in flare_dodge if [x["reason"] for x in r["blocked"]["reasons"]] == ["dodge_cd"]]
    e_rows = [r for r in hits if r["category"] == "E_MEASUREMENT"]
    cp_late = sum(1 for r in hits if r["actionability_refined"] == "CONTACT_PRED_LATE")
    cp_early = sum(1 for r in hits if r["actionability_refined"] == "CONTACT_PRED_EARLY")
    post = sum(1 for r in hits if r["actionability_refined"] == "POST_HIT_RECOVERY")
    inwin = sum(1 for r in hits if r["actionability_refined"] == "IN_WINDOW_FAIL")
    pl_late = sum(1 for r in hits if r["actionability_refined"] == "PRESS_LEAD_LATE")
    pl_early = sum(1 for r in hits if r["actionability_refined"] == "PRESS_LEAD_EARLY")
    lines = [
        P1V2_BEGIN,
        "## P1-v2 / P1-v2.1 修正（2026-10-20）",
        "",
        "> 本节是派生读法，不改写下面的首轮数字。原始 `category` 保留；新增 `press_kind`、`pred_error_class`、"
        "`actionability_refined`。refined 是代理分类，不是因果结论。P1-v2.1 把 `MEASUREMENT` 提到 refined 顺序最前。",
        "",
        "### D 类拆分",
        "",
        f"首轮 `D_PRESSED_EARLY` {sum(1 for r in d_rows if r['category'] == 'D_PRESSED_EARLY')} / "
        f"`D_PRESSED_LATE` {sum(1 for r in d_rows if r['category'] == 'D_PRESSED_LATE')} 合计 {len(d_rows)} 条，"
        "不能直接读成“固定 lead 偏早/偏晚”。按 v2 规则拆为：",
        "",
        f"- `CONTACT_PRED_LATE` {d.get('CONTACT_PRED_LATE', 0)}",
        f"- `CONTACT_PRED_EARLY` {d.get('CONTACT_PRED_EARLY', 0)}",
        f"- `PRESS_LEAD_LATE` {d.get('PRESS_LEAD_LATE', 0)}",
        f"- `PRESS_LEAD_EARLY` {d.get('PRESS_LEAD_EARLY', 0)}",
        f"- `POST_HIT_RECOVERY` {d.get('POST_HIT_RECOVERY', 0)}",
        "",
        f"全局 refined 中 `CONTACT_PRED_LATE` {cp_late}（D {d.get('CONTACT_PRED_LATE', 0)} + C_BUSY "
        f"{cb.get('CONTACT_PRED_LATE', 0)} + A {a.get('CONTACT_PRED_LATE', 0)}）、"
        f"`CONTACT_PRED_EARLY` {cp_early}（D {d.get('CONTACT_PRED_EARLY', 0)}）、"
        f"`POST_HIT_RECOVERY` {post}（D {d.get('POST_HIT_RECOVERY', 0)} + C_BUSY "
        f"{cb.get('POST_HIT_RECOVERY', 0)}）、`MEASUREMENT` {len(e_rows)}（原 E 两条）。",
        "",
        f"原 A 5 条中 `IN_WINDOW_FAIL` {inwin} 条、`CONTACT_PRED_LATE` {a.get('CONTACT_PRED_LATE', 0)} 条；"
        f"原 C_BUSY 48 条中仍为 `ACTION_BUSY` {cb.get('ACTION_BUSY', 0)} 条，"
        f"另有 `CONTACT_PRED_LATE` {cb.get('CONTACT_PRED_LATE', 0)}、`POST_HIT_RECOVERY` {cb.get('POST_HIT_RECOVERY', 0)}。",
        "",
        "### C_BLOCKED 的构成",
        "",
        f"首轮 `C_BLOCKED` {len(blocked)} 条中，**{len(flare_dodge)}/{len(blocked)} 是 flare + dodge_cd**"
        f"（{len(pure)} 条纯 dodge_cd，{len(flare_dodge) - len(pure)} 条 dodge_cd+stagger）；"
        "另 2 条 normal 为 potion 1、stagger 1。因此这组主要是 flare 场景下闪避 CD，不是 parry CD。",
        "",
        "### MEASUREMENT 优先（P1-v2.1）",
        "",
        "P1-v2.1 把 `MEASUREMENT` 提到 refined 顺序最前；原 `E_MEASUREMENT` 两条现在都归 `MEASUREMENT`："
        + "、".join(f"`{r['sample_id']}`" for r in e_rows)
        + f"，合计 {len(e_rows)} 条 / {dmg(e_rows):.3f} maxHP，不再被 `CONTACT_PRED_EARLY` / "
        "`POST_HIT_RECOVERY` 吸收。原 category 和 measurement 字段仍保留。",
        "",
        "**`POST_HIT_RECOVERY` 不是对该接触的防守尝试。** 它只表示 press_kind=hitEscape/posthit，"
        "press 发生在 hit/escape 之后，不能据此判断该接触是否可防。"
        f"P1-v2 首版的 `POST_HIT_RECOVERY` 18 条包含原 C_BUSY 里 {cb.get('POST_HIT_RECOVERY', 0)} 条 hitEscape/posthit；"
        f"P1-v2.1 修正后为 {post} 条，仍包含这 {cb.get('POST_HIT_RECOVERY', 0)} 条，不代表 {post} 次独立防守尝试。",
        "",
        f"关键读数：`CONTACT_PRED_LATE/EARLY` {cp_late + cp_early}（{cp_late} + {cp_early}）、"
        f"`PRESS_LEAD_*` {pl_late + pl_early}（{pl_late} late + {pl_early} early）、"
        f"`POST_HIT_RECOVERY` {post}、`IN_WINDOW_FAIL` {inwin}、`MEASUREMENT` {len(e_rows)}。",
        "",
        f"详细交叉表见 [summary_v2.md](../../../data/attack_triage/20261020/summary_v2.md)。",
        P1V2_END,
    ]
    return "\n".join(lines)


def update_doc(path, section):
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    if P1V2_BEGIN in text:
        text = re.sub(re.escape(P1V2_BEGIN) + r".*?" + re.escape(P1V2_END), section, text, flags=re.S)
    else:
        lines = text.splitlines()
        if not lines:
            raise ValueError("empty doc")
        # Insert after the H1 title, before the first-round blockquote.
        text = lines[0] + "\n\n" + section + "\n" + "\n".join(lines[1:])
    path.write_text(text.rstrip() + "\n", encoding="utf-8")


def build(out, doc):
    base = Path(out)
    raw = read(base / "triage.json")
    samples = read(SAMPLES)
    sample_ids = {s["sample_id"] for s in samples}
    rows = [add_fields(r) for r in raw]

    if len(rows) != 466:
        raise ValueError(f"expected 466 rows, got {len(rows)}")
    if any(not r.get("actionability_refined") for r in rows):
        raise ValueError("missing actionability_refined")
    hits = [r for r in rows if r["type"] == "hit"]
    oks = [r for r in rows if r["type"] == "ok"]
    if len(hits) + len(oks) != len(rows):
        raise ValueError("type reconciliation failed")
    if sum(1 for r in hits if r["actionability_refined"] in REFINED_ORDER) != len(hits):
        raise ValueError("hit refined category outside allowed list")
    if sum(Counter(r["actionability_refined"] for r in hits).values()) != 134:
        raise ValueError("refined count sum != 134")
    e_hits = [r for r in hits if r["category"] == "E_MEASUREMENT"]
    if len(e_hits) != 2 or any(r["actionability_refined"] != "MEASUREMENT" for r in e_hits):
        raise ValueError("all E_MEASUREMENT hits must refine to MEASUREMENT")
    if sum(1 for r in hits if r["actionability_refined"] == "MEASUREMENT") != 2:
        raise ValueError("refined MEASUREMENT count != 2")
    if len(hits) != 134 or len(oks) != 332:
        raise ValueError("original hit/ok counts changed")
    if {r["sample_id"] for r in rows if r["in_review_set"]} != sample_ids:
        raise ValueError("in_review_set != samples.json")
    for r in rows:
        if r["type"] == "hit" and r["actionability_refined"] == "MEASUREMENT" and r["category"] != "E_MEASUREMENT":
            raise ValueError("MEASUREMENT refined on non-E row")
        if r["type"] == "ok" and r["actionability_refined"] != "NOT_APPLICABLE_OK":
            raise ValueError("ok refined should be NOT_APPLICABLE_OK")

    fixed, notes = review_rows(rows, sample_ids)
    if any(not r["in_review_set"] for _, _, r, _ in fixed):
        raise ValueError("review sample not in review set")

    write_json(base / "triage_v2.json", rows)
    write_csv(base / "triage_v2.csv", rows)
    write_csv(base / "triage.csv", rows)
    write_review_sheet(base / "review_sheet.md", fixed)
    summary_v2(rows, fixed, notes, base / "summary_v2.md")
    update_doc(doc, build_doc_section(rows))
    return rows, fixed, notes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=BASE)
    parser.add_argument("--doc", type=Path, default=DEFAULT_DOC)
    a = parser.parse_args()
    rows, fixed, notes = build(a.out, a.doc)
    hits = [r for r in rows if r["type"] == "hit"]
    ref = Counter(r["actionability_refined"] for r in hits)
    print(json.dumps({
        "out": str(Path(a.out)),
        "doc": str(Path(a.doc)),
        "rows": len(rows),
        "hit": len(hits),
        "ok": sum(1 for r in rows if r["type"] == "ok"),
        "refined": dict(ref),
        "refined_sum": sum(ref.values()),
        "review_sheet": len(fixed),
        "review_ids": [sid for _, sid, _, _ in fixed],
        "review_notes": notes,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
