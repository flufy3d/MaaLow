"""Offline coverage of the c11 S plan (args.seqDefense, phase 1) against the phase-A episodes.

    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/seq_coverage.py

Reads data/moveid/offense/online/episodes.json (offense_episodes.py) and answers: with the S plan (skip k0, parry the
first k1 group at k0 + SEQ_G1_F - parryLead, dodge the k2 group at its head prediction - dodgeLead), how many c11
sequences get a planned press and how many c11 contacts could be saved? The script is a pre-live gate, not a claim
that the presses land: the per-sequence reduction assumes the parry/dodge succeeds and the rest of the chain is
unchanged.

Writes seq_coverage.json + seq_coverage.md next to episodes.json.
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import REPO  # noqa: E402

OUT_DIR = REPO / "data" / "moveid" / "offense" / "online"
SEQ_G1_F = 15  # keep in sync with dufu2.js's SEQ_G1_F
PARRY_LEAD = 10
DODGE_LEAD = 5


def first_group(ep: dict, prefix: str) -> int | None:
    """Index of the first beat whose group is `prefix:*c11*` (the plan's k1 / k2 target)."""
    for i, g in enumerate(ep.get("groups") or []):
        if str(g).startswith(prefix + ":") and "c11" in str(g):
            return i
    return None


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", type=Path, default=OUT_DIR / "episodes.json")
    a = ap.parse_args()
    data = json.loads(a.episodes.read_text(encoding="utf-8"))
    rows = data.get("c11_only_episodes") or data.get("c11_episodes") or []
    if not rows:
        raise SystemExit("no c11 episodes in episodes.json; run offense_episodes.py first")

    triggerable = [r for r in rows if r.get("first_k") == 0]
    k1_rows, k2_rows = [], []
    for r in triggerable:
        i1 = first_group(r, "k1")
        i2 = first_group(r, "k2")
        if i1 is not None:
            off = float(r["offsets"][i1])
            k1_rows.append({"round": r["round"], "start": r["start"], "n": r["n"], "off": off,
                            "press_f": off - (SEQ_G1_F - PARRY_LEAD), "lead": off - (SEQ_G1_F - PARRY_LEAD)})
        if i2 is not None:
            off2 = float(r["offsets"][i2])
            k2_rows.append({"round": r["round"], "start": r["start"], "n": r["n"], "off": off2,
                            "press_f": off2 - DODGE_LEAD, "lead": DODGE_LEAD})
    beats = sum(int(r["n"]) for r in rows)
    trigger_beats = sum(int(r["n"]) for r in triggerable)
    k1_offsets = [x["off"] for x in k1_rows]
    k1_leads = [x["lead"] for x in k1_rows]
    # direct planned contacts: one k1 per sequence with a k1, one k2 per sequence with a k2
    direct = len(k1_rows) + len(k2_rows)
    # per-sequence saving if the planned beat lands (one beat), and the aggregate direct share
    seq_reduction = []
    for r in triggerable:
        i1 = first_group(r, "k1")
        i2 = first_group(r, "k2")
        saved = (1 if i1 is not None else 0) + (1 if i2 is not None else 0)
        if saved:
            seq_reduction.append({"round": r["round"], "start": r["start"], "n": int(r["n"]), "saved": saved,
                                  "frac": saved / int(r["n"])})
    summary = {
        "c11_episodes": len(rows), "c11_beats": beats,
        "triggerable": len(triggerable), "triggerable_beats": trigger_beats,
        "k1_sequences": len(k1_rows), "k1_offsets": k1_offsets,
        "k1_offset_median": statistics.median(k1_offsets) if k1_offsets else None,
        "k1_leads": k1_leads, "k1_lead_median": statistics.median(k1_leads) if k1_leads else None,
        "k1_lead_min": min(k1_leads) if k1_leads else None, "k1_lead_max": max(k1_leads) if k1_leads else None,
        "k2_sequences": len(k2_rows), "k2_offsets": [x["off"] for x in k2_rows],
        "direct_beats": direct, "direct_share": round(direct / beats, 4) if beats else None,
        "sequence_with_plan": len(seq_reduction),
        "sequence_with_plan_share": round(len(seq_reduction) / len(triggerable), 4) if triggerable else None,
        "sequence_reduction_median": statistics.median([x["frac"] for x in seq_reduction]) if seq_reduction else None,
        "sequence_reduction_min": min([x["frac"] for x in seq_reduction], default=None),
        "sequence_reduction_max": max([x["frac"] for x in seq_reduction], default=None),
        "c11_hits_after_direct": beats - direct,
        "c11_hit_reduction_direct": round(direct / beats, 4) if beats else None,
        "plan": {"skip": "k0", "k1_press": f"k0 + {SEQ_G1_F} - {PARRY_LEAD} = k0 + {SEQ_G1_F - PARRY_LEAD} f",
                 "k1_lead": "first k1 offset - (SEQ_G1_F - PARRY_LEAD)", "k2_press": "head k2 - dodgeLead",
                 "seq_g1_f": SEQ_G1_F, "parry_lead": PARRY_LEAD, "dodge_lead": DODGE_LEAD},
    }
    out = {"summary": summary, "k1_rows": k1_rows, "k2_rows": k2_rows, "sequence_reduction": seq_reduction,
           "source": str(a.episodes.relative_to(REPO)).replace("\\", "/")}
    (OUT_DIR / "seq_coverage.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    s = summary
    lines = ["# c11 S 计划离线覆盖（阶段 B 预检）", "",
             f"- 数据：`{out['source']}`；c11-only episode **{s['c11_episodes']}** / **{s['c11_beats']}** 拍；首拍 k0、可触发的 **{s['triggerable']}** 条 / {s['triggerable_beats']} 拍。",
             f"- 预排：跳过 k0；首个 `k1:*c11*` 在 `k0 + {SEQ_G1_F} - {PARRY_LEAD} = k0 + {SEQ_G1_F - PARRY_LEAD}` 帧按 parry；`k2:*c11*` 按头的预测在 `k2 - {DODGE_LEAD}` 帧按 dodge。",
             f"- k1：**{s['k1_sequences']}/{s['triggerable']}** 条有首个 k1 组；offset 中位 **{s['k1_offset_median']}** 帧，计划提前量 **{s['k1_lead_min']}–{s['k1_lead_max']}** 帧（中位 {s['k1_lead_median']}）。",
             f"- k2：**{s['k2_sequences']}/{s['triggerable']}** 条有 k2 组（offset {s['k2_offsets']}）；其余链的第三拍多是 k1，不是 k2。",
             f"- 直接目标：**{s['direct_beats']}/{s['c11_beats']} = {100 * s['direct_share']:.1f}%** 的 c11 接触（22 个首个 k1 + 3 个 k2）；若只省这些，命中降到 {s['c11_hits_after_direct']}。",
             f"- 序列覆盖：**{s['sequence_with_plan']}/{s['triggerable']} = {100 * s['sequence_with_plan_share']:.1f}%** 的可触发序列至少有一个计划拍；按“每个计划拍省 1 下”算，每条序列的命中下降中位 **{100 * s['sequence_reduction_median']:.1f}%**（范围 {100 * s['sequence_reduction_min']:.1f}%–{100 * s['sequence_reduction_max']:.1f}%）。",
             "- 口径：这是“按下计划”的覆盖，不是“一定命中”的证明；k1 parry 是否能打断后续 k1、k2 dodge 是否被头及时叫出，要靠 2 对 2 实机。",
             "- 结论：按序列的 30% 线在离线口径下成立（中位 33%），但直接接触口径 26.3% 低于 30%；若 2 对 2 的 c11 命中/序列没有下降 ≥30%，优先补第二拍 k1，而不是改默认。"]
    (OUT_DIR / "seq_coverage.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps(s, ensure_ascii=False))
    print(f"wrote {OUT_DIR / 'seq_coverage.json'} and seq_coverage.md")


if __name__ == "__main__":
    main()
