"""Order 2 clustering report: data/moveid/moves/taxonomy.json (+ review.md, the hand-written sheet review) -> report.md.

All numbers come from taxonomy.json / slices.json, so the report can be regenerated after every run. review.md is
the only hand-written part (sheet-by-sheet judgement); it names the taxonomy `generated` stamp it was written for,
and the report warns when the stamps differ (class ids change when the clustering changes).
"""
from __future__ import annotations

import collections
import re

import numpy as np

from common import OUT, read_json

MOVES = OUT / "moves"


def pct(a, b):
    return f"{a / b * 100:.1f}%" if b else "-"


def fmt(v, nd=3):
    return "-" if v is None else (f"{v:.{nd}f}" if isinstance(v, float) else str(v))


def main() -> None:
    tax = read_json(MOVES / "taxonomy.json")
    cs = {c["chain_id"]: c for c in read_json(MOVES / "slices.json")["chains"]}
    rows = tax["classes"]
    cls = [r for r in rows if r["id"] >= 0]
    mv = [r for r in cls if r["kind"] == "move"]
    gr = [r for r in cls if r["kind"] == "grab"]
    unk = next((r for r in rows if r["id"] < 0), None)
    n_move = sum(1 for c in cs.values() if c["kind"] == "move")
    n_grab = len(cs) - n_move
    L = []
    w = lambda s: L.append(s)  # noqa: E731

    w("# 独夫招式：切片与聚类（顺序 2）")
    w("")
    w(f"生成：{tax['generated']}（seed {tax['seed']}），`s2c_all.py` 一条命令重跑。参数见 taxonomy.json `params` 和 log.txt。")
    w("")
    w("## 方法")
    w("")
    w("- 样本 = 一串（events_ext 的 chain，一次出招），锚点 = 首接触帧；切片 [首接触 −60, 末接触 +10] 帧的三路 DINOv3 CLS"
      "（s2c_slice.py → slices.npz）。")
    p = tax["params"]
    w(f"- 表示：各路嵌入减去本录像的平均嵌入，按窗口 {p['wins']}（相对首接触，帧）取平均、L2 归一；加节奏"
      f"（第 2–{p['rhythm_feat'][1] + 1} 个接触有无 + 相对首接触偏移 / 30，×{p['rhythm_feat'][0]}）和开场颜色"
      f"（one-hot ×{p['color_w']}）→ PCA {p['pca']} → UMAP（{p['umap'][0]} 邻居，{p['umap'][1]} 维）→ "
      f"HDBSCAN（最小簇 {p['mcs'][0]}；抓取串单独聚，{p['mcs'][1]}）。HDBSCAN 噪声 = 未知。")
    w("- 画面只用到首接触 −11 帧为止，接触后的变化靠节奏（后续接触何时落下，由 boss 决定）进入。原因：接触后的画面主要是"
      "玩家自己的结果（卸势火花 / 受击闪光 / 硬直），把它放进表示（哪怕权重 0.3），同一招会按「全卸住 / 全挨打」分成两类"
      "（试验记录见 README）；也顺带让关 1 的决策窗 [−10, −1] 不参与定义类别。")
    w(f"- 自动检查（log.txt 逐条记录）：颜色拆分（少数方 > {p['color_max']:.0%}）→ 小类（< {p['min_class']}）归未知 → "
      f"节奏拆分（串长 / 第 2 接触偏移，1 维 GMM k=1..4 按 BIC，组间距 ≥ 1.5 段 / 8 帧、≥ 2 倍标准差、每组 ≥ 15 串且 ≥ 15%）"
      f"→ 合并（同色、同众数串长、各接触偏移中位差 ≤ {p['merge'][0]} 帧，PCA 中心距 < "
      f"({p['merge'][1]} + {p['merge'][2]} ×（串长 − 1））× 平均半径）→ 小类归未知。")
    w("- 起手：类内用大框嵌入轨迹，类模板 m(t) = 类内各串在 t 帧的归一化嵌入均值；|m(t)| 从「各干各的」升到「大家同一个动作」"
      "的时刻 = 类起手；每串用它与（去掉自己的）模板的相似度找同样的上升点，给中位 / IQR。窗口内 |m(t)| 升幅 < 0.1 的类记"
      "「−60 帧时已一致」（起手早于窗口或前一招固定）。")
    w("")

    w("## 总览")
    w("")
    cov = sum(r["n"] for r in mv)
    w(f"- 串：{len(cs)}（出招 {n_move}，抓取 {n_grab}）。类：出招 {len(mv)} 类，抓取 {len(gr)} 类。")
    w(f"- **覆盖率**（非抓取串归入非未知类）：{cov}/{n_move} = **{pct(cov, n_move)}**。"
      f"未知 {unk['n'] if unk else 0} 串（含抓取未知 {sum(1 for m in (unk['members'] if unk else []) if cs[m]['kind'] == 'grab')}）。")
    pur = [r["color_purity"] for r in cls if r["color_purity"] is not None]
    worst = min(cls, key=lambda r: r["color_purity"] if r["color_purity"] is not None else 1)
    w(f"- **颜色纯度**（开场颜色，排除 unknown）：全部 {len(cls)} 类少数方 ≤ 3%：{'是' if min(pur) >= 0.97 else '否'}；"
      f"最差 c{worst['id']} {worst['color_purity']:.4f}；纯度 = 1 的类 {sum(x == 1 for x in pur)} 个。每类数字见下表。")
    ms = [r["length_mode_share"] for r in cls]
    wm = sum(r["length_mode_share"] * r["n"] for r in cls) / sum(r["n"] for r in cls)
    low = ", ".join(f"c{r['id']}" for r in cls if r["length_mode_share"] < 0.7)
    w(f"- **节奏一致**：串长众数占比（按串加权）{wm:.3f}；各类分布：≥ 0.9 的 {sum(x >= 0.9 for x in ms)} 类，"
      f"0.7–0.9 {sum(0.7 <= x < 0.9 for x in ms)} 类，< 0.7 {sum(x < 0.7 for x in ms)} 类"
      f"（{low}）。")
    iq = collections.defaultdict(list)
    for r in cls:
        for j, o in enumerate(r["rhythm"][1:], 1):
            iq[min(j, 4)].append(o["iqr"])
    w("  - 众数串长的串里，第 k 个接触相对首接触偏移的类内 IQR（帧，各类的中位 / 最大）："
      + "；".join(f"第 {k + 1}{'+' if k == 4 else ''} 个 {np.median(v):.1f} / {max(v):.1f}（{len(v)} 类）"
                 for k, v in sorted(iq.items())) + "。")
    st = tax.get("stability", {})
    if st:
        sh = st["split_half"]
        w(f"- **稳定性**：奇偶轮各自全流程聚类（尺寸阈值按样本量缩放），用一半的类中心（PCA 空间，最近中心）给另一半分类，"
          f"与另一半自己的聚类比 ARI（只算自己归了类的串）：" + "；".join(
              f"{k} 中心 {v['centroid']} / kNN10 {v['knn10']}（{v['classes_src']} → {v['classes_dst']} 类，n {v['n']}）"
              for k, v in sh.items()) + "。")
        w("  - 换种子（全量，与 seed 0 比）：" + "；".join(
            f"seed {k} ARI {v['all']}（未知算一类）/ {v['both_assigned']}（两边都归类的 {v['n_both']} 串）"
            for k, v in st["seeds"].items()) + "。")
    lk = tax.get("outcome_leak")
    if lk:
        w(f"- 结果泄漏自查：非金光出招串里，类别与「首接触卸住」的 NMI {lk['nmi_first_ok']}，首接触卸住率 < 10% 或 > 95% "
          f"的类占 {lk['extreme_share']:.1%}（它们是真的卸不了的招，见拼图结论）。")
    w("")

    total = tax["total_dmg"]
    fat = sorted([r for r in cls if r["fatal"]], key=lambda r: -r["dmg_total"])
    w("## 致命招")
    w("")
    w(f"总掉血 {total:.2f}（满血 = 1，所有串所有接触的 dmg 之和，抓取后续算在抓取类上）。按类总掉血排序，覆盖 80% 的最小集合："
      f"**{len(fat)} 类，{tax['fatal_dmg']:.2f} = {pct(tax['fatal_dmg'], total)}**"
      f"（未知占 {unk['dmg_total'] if unk else 0:.2f} = {pct(unk['dmg_total'] if unk else 0, total)}，不参与挑选）："
      + "、".join(f"c{r['id']}" for r in fat) + "。")
    w("")
    w("## 招式表")
    w("")
    w("颜色 = 开场颜色众数（纯度 = 排除 unknown 后的占比）。节奏 = 众数串长的串里第 2、3、4… 个接触相对首接触的帧偏移，"
      "中位(IQR)。起手 = 首接触前多少帧：类级 / 逐串中位(IQR)，「—」= −60 帧时已一致。卸住率 = ok/(ok+hit_pf)（events_ext type），"
      "被打率 = (pf+unk)/(ok+pf+unk)（index outcome，不含抓取后续）。致命 = ★。")
    w("")
    w("| 类 | 种类 | 串 | 颜色（纯度） | 串长众数（占比） | 节奏 | 起手 类级 / 中位(IQR) | 卸住率 | 被打率 | 平均掉血 | 总掉血（占比） | 轮数 |")
    w("|---|---|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        rh = ", ".join(f"{o['median']:.0f}({o['iqr']:.0f})" for o in r["rhythm"][1:6]) or "单段"
        if len(r["rhythm"]) > 6:
            rh += ", …"
        o = r.get("onset") or {}
        on = (f"{fmt(o.get('class'))} / {fmt(o.get('median'), 0)}({fmt(o.get('iqr'), 0)})" if o else "-")
        name = "未知" if r["id"] < 0 else f"c{r['id']}{' ★' if r['fatal'] else ''}"
        w(f"| {name} | {'抓取' if r['kind'] == 'grab' else ('出招' if r['kind'] == 'move' else '-')} | {r['n']} | "
          f"{r['color']}（{fmt(r['color_purity'])}） | {r['length_mode']}（{r['length_mode_share']:.2f}） | {rh} | {on} | "
          f"{fmt(r['ok_rate'])} | {fmt(r['hit_rate'])} | {r['dmg_mean']:.3f} | {r['dmg_total']:.2f}（{r['dmg_share']:.1%}） | "
          f"{r['rounds']} |")
    w("")
    rv = MOVES / "review.md"
    w("## 拼图逐类检查（人工）")
    w("")
    if rv.exists():
        txt = rv.read_text(encoding="utf-8").strip()
        m = re.search(r"generated:\s*([0-9: -]+)", txt)
        if m and m.group(1).strip() != tax["generated"]:
            w(f"> 注意：下面的检查写于 taxonomy {m.group(1).strip()}，当前是 {tax['generated']}，类号可能已变，需要重看拼图。")
            w("")
        w(txt)
    else:
        w("（还没有 review.md）")
    w("")
    w("## 产出")
    w("")
    w("`data/moveid/moves/`：taxonomy.json（招式表 + 每类成员 chain_id）、assign.json（chain_id → 类 / −1 + 置信度 = HDBSCAN"
      " 成员强度）、log.txt（每步检查做了什么）、sheets/c<id>.jpg + unknown.jpg、slices.npz / slices.json（切片）、review.md、本页。")
    (MOVES / "report.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    print("report.md", len(L), "lines")


if __name__ == "__main__":
    main()
