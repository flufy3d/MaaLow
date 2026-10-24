"""顺序 2: chains (连段) + damage, merged with the colours into data/moveid/events_ext.json, plus a stats page.

Chains: per recording, contacts in time order. A contact continues the previous chain when the gap (contact frames)
is <= CHAIN_GAP (the valley of the gap histogram, found here between VALLEY_LO and VALLEY_HI on a smoothed 1-frame
histogram) and it does not open a new tell (its own colour is gold / red: a fresh 金光 / 红光 starts a new move).
Grab cutscenes (labels.py: the hit before the first `grab` tick plus its ticks) are their own chain (chain_kind grab)
and never merge with neighbours. chain_pos 0 = opener; gap_prev = frames since the previous contact in the recording
(null for the first). chain_color = the opener's colour (gold / red / none / unknown).

Damage: hp from bars/<rec>.npz (reads.py, the dufu.js health() port). The bar shows a hit's step at contact +5/+6, so
before = median hp over [c - 2, c + 3] (not before prev + 7), after = median over [c + 7, c + 12] (not past next + 4);
dmg = before - after (fraction of the full bar; null when either side unreadable). Reported for every contact (ok
should be ~0).

  s2_events.py   -> data/moveid/events_ext.json, data/moveid/color/stats.md
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import BARS, OUT, read_json, write_json  # noqa: E402

VALLEY_LO, VALLEY_HI = 45, 95
COLORS = ["gold", "red", "none", "unknown"]
TYPES = ["flare", "ok", "hit_pf", "hit_unk", "grab"]


def gap_valley(gaps: list[int]) -> tuple[int, np.ndarray]:
    h = np.bincount(np.clip(gaps, 0, 200), minlength=201).astype(float)
    sm = np.convolve(h, np.ones(9) / 9, "same")
    v = VALLEY_LO + int(np.argmin(sm[VALLEY_LO:VALLEY_HI + 1]))
    return v, sm


def med(a: np.ndarray) -> float | None:
    a = a[~np.isnan(a)]
    return float(np.median(a)) if len(a) else None


def damage(hp: np.ndarray, c: int, prev: int | None, nxt: int | None) -> float | None:
    b = c + 3
    a = min(max(c - 2, (prev + 7) if prev is not None else 0), b)
    e1 = c + 12 if nxt is None else min(c + 12, nxt + 4)
    e1 = max(e1, c + 7)
    before = med(hp[a:b + 1])
    after = med(hp[c + 7:e1 + 1])
    if before is None or after is None:
        return None
    return round(before - after, 4)


def grab_groups(es: list[dict]) -> list[int | None]:
    """Group number per contact: a grab cutscene = the contact right before the first `grab` tick + the ticks."""
    gid: list[int | None] = [None] * len(es)
    g = 0
    for i, e in enumerate(es):
        if e["outcome"] != "grab":
            continue
        if i > 0 and gid[i - 1] is not None:
            gid[i] = gid[i - 1]
            continue
        g += 1
        gid[i] = g
        if i > 0 and es[i - 1]["outcome"] != "grab":
            gid[i - 1] = g
    return gid


def build() -> tuple[list[dict], int, np.ndarray]:
    idx = read_json(OUT / "index.json")
    col = read_json(OUT / "color" / "color.json")
    by: dict[str, list[dict]] = {}
    for e in idx["events"]:
        by.setdefault(e["rec"], []).append(e)
    gaps = [b["frame"] - a["frame"] for es in by.values() for a, b in zip(es, es[1:])]
    chain_gap, sm = gap_valley(gaps)
    out = []
    cid = 0
    for rec, es in by.items():
        hp = np.load(BARS / f"{rec}.npz")["hp"].astype(np.float64)
        gid = grab_groups(es)
        pos = 0
        opener = None
        for i, e in enumerate(es):
            c = col.get(str(e["id"]), {})
            color = c.get("color", "unknown")
            prev = es[i - 1] if i else None
            gap = e["frame"] - prev["frame"] if prev else None
            if gid[i] is not None:
                same = prev is not None and gid[i - 1] == gid[i]
            else:
                same = prev is not None and gid[i - 1] is None and gap <= chain_gap and color not in ("gold", "red")
            if same:
                pos += 1
            else:
                cid += 1
                pos = 0
                opener = color
            out.append({
                "id": e["id"], "rec": rec, "round": e["round"], "frame": e["frame"], "type": e["type"],
                "color": color, "color_conf": c.get("color_conf"), "color_onset": c.get("color_onset"),
                "color_onset_frame": c.get("color_onset_frame"), "color_guess": c.get("color_guess"),
                "chain_id": cid, "chain_pos": pos, "chain_kind": "grab" if gid[i] is not None else "move",
                "chain_color": opener, "gap_prev": gap,
                "dmg": damage(hp, e["frame"], prev["frame"] if prev else None,
                              es[i + 1]["frame"] if i + 1 < len(es) else None),
            })
    clen = Counter(o["chain_id"] for o in out)
    for o in out:
        o["chain_len"] = clen[o["chain_id"]]
    return out, chain_gap, sm


def main() -> None:
    out, chain_gap, sm = build()
    write_json(OUT / "events_ext.json", {
        "fields": {
            "id": "index.json events[id]", "color": "gold | red | none | unknown (s2_color.py)",
            "color_conf": "0-1", "color_onset": "tell onset - contact frame (< 0), null when none",
            "color_onset_frame": "tell onset video frame", "color_guess": "colour before the unknown rule",
            "chain_id": "global chain number", "chain_pos": "0 = opener", "chain_len": "contacts in the chain",
            "chain_kind": "move | grab", "chain_color": "the opener's colour",
            "gap_prev": "frames since the previous contact (same recording), null for the first",
            "dmg": "hp fraction lost (before - after, reads.py health); null = unreadable",
        },
        "chain_gap": chain_gap, "events": out})
    stats(out, chain_gap, sm)


def pct(a, b) -> str:
    return f"{a}/{b} = {100 * a / b:.1f}%" if b else "-"


def stats(out: list[dict], chain_gap: int, sm: np.ndarray) -> None:
    L = []
    n = len(out)
    L.append(f"# 顺序 2 统计（{n} 个接触，s2_events.py 生成）\n")
    L.append("## 颜色分布\n\n| 颜色 | 数 | 占比 |\n|---|---|---|")
    cc = Counter(o["color"] for o in out)
    for c in COLORS:
        L.append(f"| {c} | {cc[c]} | {100 * cc[c] / n:.1f}% |")
    L.append("\n## 接触类型 × 颜色\n")
    L.append("| 类型 | " + " | ".join(COLORS) + " | 合计 |")
    L.append("|---" * (len(COLORS) + 2) + "|")
    for t in TYPES:
        s = [o for o in out if o["type"] == t]
        k = Counter(o["color"] for o in s)
        L.append(f"| {t} | " + " | ".join(f"{k[c]} ({100 * k[c] / max(1, len(s)):.0f}%)" for c in COLORS) + f" | {len(s)} |")
    L.append("\n按颜色看卸势结果（不含抓取）：\n")
    for c in COLORS:
        s = [o for o in out if o["color"] == c and o["type"] != "grab"]
        L.append(f"- {c}：ok {pct(sum(o['type'] == 'ok' for o in s), len(s))}，hit_pf {sum(o['type'] == 'hit_pf' for o in s)}，"
                 f"hit_unk {sum(o['type'] == 'hit_unk' for o in s)}，flare {sum(o['type'] == 'flare' for o in s)}")
    oks = [o for o in out if o["type"] == "ok"]
    L.append(f"- ok 的接触里被标成 gold：{pct(sum(o['color'] == 'gold' for o in oks), len(oks))}；red：{pct(sum(o['color'] == 'red' for o in oks), len(oks))}")
    L.append("\n光起点到接触（帧，5/25/50/75/95%）：\n")
    for c in ["gold", "red"]:
        v = [-o["color_onset"] for o in out if o["color"] == c]
        if v:
            L.append(f"- {c}：{np.percentile(v, [5, 25, 50, 75, 95]).round(1).tolist()}")
    L.append(f"\n## 连段\n\n串阈值 CHAIN_GAP = {chain_gap} 帧（相邻接触间隔直方图，9 帧平滑，{VALLEY_LO}–{VALLEY_HI} 帧之间的最低点）；"
             "另外自己带金 / 红光的接触总是新开一串，抓取过场单独成串。\n")
    L.append("间隔直方图（平滑后每 6 帧一档的均值，每个 # = 4）：\n\n```")
    for a in range(0, 150, 6):
        v = sm[a:a + 6].mean()
        L.append(f"{a:3d}-{a + 5:3d} {v:6.1f} " + "#" * int(v / 4))
    L.append("```")
    chains: dict[int, list[dict]] = {}
    for o in out:
        chains.setdefault(o["chain_id"], []).append(o)
    lens = Counter(len(v) for v in chains.values())
    L.append("\n串长度分布：\n\n| 长度 | 串数 | 其中抓取 |\n|---|---|---|")
    for k in sorted(lens):
        gk = sum(1 for v in chains.values() if len(v) == k and v[0]["chain_kind"] == "grab")
        L.append(f"| {k} | {lens[k]} | {gk} |")
    L.append("\n按开场颜色（不含抓取串）：\n")
    for c in COLORS:
        v = [len(x) for x in chains.values() if x[0]["color"] == c and x[0]["chain_kind"] == "move"]
        if v:
            L.append(f"- {c}：{len(v)} 串，平均 {np.mean(v):.2f} 段，≥2 段 {pct(sum(x >= 2 for x in v), len(v))}")
    g = [o["gap_prev"] for o in out if o["chain_pos"] > 0 and o["chain_kind"] == "move"]
    if g:
        L.append(f"- 串内段间隔（帧）5/25/50/75/95%：{np.percentile(g, [5, 25, 50, 75, 95]).round(1).tolist()}")
    L.append("\n## 伤害（掉血，满血 = 1）\n")
    L.append("| 类型 | n | 读到 | 5% | 25% | 50% | 75% | 95% | max |\n|---|---|---|---|---|---|---|---|---|")
    for t in ["flare", "hit_pf", "hit_unk", "grab", "ok"]:
        s = [o for o in out if o["type"] == t]
        d = np.array([o["dmg"] for o in s if o["dmg"] is not None])
        if len(d):
            q = np.percentile(d, [5, 25, 50, 75, 95]).round(3).tolist()
            L.append(f"| {t} | {len(s)} | {len(d)} | " + " | ".join(str(x) for x in q) + f" | {d.max():.3f} |")
    L.append("\n按颜色（hit = flare / hit_pf / hit_unk / grab）：\n")
    L.append("| 颜色 | n | 中位 | 75% | 95% | ≥10% 的比例 |\n|---|---|---|---|---|---|")
    for c in COLORS:
        d = np.array([o["dmg"] for o in out if o["color"] == c and o["type"] != "ok" and o["dmg"] is not None])
        if len(d):
            L.append(f"| {c} | {len(d)} | {np.median(d):.3f} | {np.percentile(d, 75):.3f} | {np.percentile(d, 95):.3f} | {100 * np.mean(d >= 0.10):.1f}% |")
    d = np.array([o["dmg"] for o in out if o["type"] != "ok" and o["dmg"] is not None])
    L.append("\n全部 hit 的掉血直方图（每档 2%）：\n\n```")
    for a in np.arange(-0.02, 0.30, 0.02):
        L.append(f"{a:5.2f}-{a + 0.02:5.2f} {int(((d >= a) & (d < a + 0.02)).sum()):5d}")
    L.append(f">=0.30       {int((d >= 0.30).sum()):5d}\n```")
    (OUT / "color" / "stats.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    print("\n".join(L))


if __name__ == "__main__":
    main()
