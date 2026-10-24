"""Order 3: post-hoc diagnostics of gate 1 (written AFTER seeing fold-0 results; they do not change the gate, which
is s3_gate1.py). Appended to gate1.md as "事后诊断".

    uv run --no-project --with numpy python workspaces/WhereWindsMeet/tools/dufu_moveid/s3_diag.py \
        [--pred teacher=data/moveid/teacher/oof.npz --pred base_linear=...] [--out data/moveid/teacher/diag.md]

  1. (b) with the class argmax restricted to the 43 taxonomy classes (idle / unknown outputs ignored), since the
     tte head already says a contact is coming at -10.
  2. (b) by the chain's HDBSCAN membership strength (assign.json conf): label noise vs model.
  3. (b) if classes that differ only after the first contact were one group ("first-contact groups": same opener
     colour + same response, any chain length / rhythm). NOT the gate definition -- shows how much of the miss is
     about how many hits follow.
  4. the most frequent fatal confusions with both classes' colour / mode length / rhythm / ok_rate.
All numbers at -10 unless noted, numerator / denominator.
"""
from __future__ import annotations

import argparse
import collections
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s3_common import DECISION, N_MOVE, OUT, TEACHER, equivalence_groups, load, read_json, response  # noqa: E402
from s3_gate1 import cname, load_pred  # noqa: E402


def fmt(n, d):
    return f"{n}/{d} = {100 * n / d:.1f}%" if d else "–"


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--pred", action="append", default=[])
    ap.add_argument("--out", default=str(TEACHER / "diag.md"))
    a = ap.parse_args()
    preds = a.pred or [f"teacher={TEACHER / 'oof.npz'}", f"base_linear={TEACHER / 'baseline' / 'oof_linear.npz'}"]
    d = load()
    classes = d["classes"]
    asg = read_json(OUT / "moves" / "assign.json")
    spec = equivalence_groups(classes)
    fatal = sorted(c for c, v in classes.items() if v.get("fatal"))
    first = {c: (v["color"], response(v["color"], c, classes)) for c, v in classes.items()}
    openers = [e for e in d["events"] if e["chain_pos"] == 0 and e["cls"] in fatal]
    L = ["## 事后诊断（看过 fold 0 结果后加的，不改关 1 口径；`s3_diag.py`）", ""]
    for s in preds:
        name, path = s.split("=", 1)
        if not Path(path).exists():
            continue
        P = load_pred(Path(path))
        row = {int(i): k for k, i in enumerate(P["ids"])}
        offs = list(P["offs"])
        L += [f"### {name}", ""]
        curve = []
        for o in (-16, -12, -10, -8, -6, -4, 0):
            j = offs.index(o)
            n = ok_all = ok_mv = ok_first = 0
            for e in openers:
                k = row.get(e["id"])
                if k is None or not P["valid"][k, j]:
                    continue
                p = P["p_cls"][k, j].astype(np.float64)
                pa = int(p.argmax())
                pm = int(p[:N_MOVE].argmax())
                tc = e["cls"]
                n += 1
                ok_all += pa == tc or (pa < N_MOVE and spec[pa] == spec[tc])
                ok_mv += pm == tc or spec[pm] == spec[tc]
                ok_first += pm < N_MOVE and first[pm] == first[tc]
            curve.append((o, n, ok_all, ok_mv, ok_first))
        L += ["| 帧 | (b) 原口径（关 1 用的） | 只在 43 类里取 argmax | 首接触等价（同色 + 同应对，不看后续段） |", "|---|---|---|---|"]
        for o, n, x, y, z in curve:
            L.append(f"| {o} | {fmt(x, n)} | {fmt(y, n)} | {fmt(z, n)} |")
        j = offs.index(DECISION)
        # same chains, class head at -10 before the k-th contact (k = 1 is the opener): does seeing the earlier
        # hits of the chain help? (fatal chains with >= 3 contacts, so the three columns are the same chains)
        allc = collections.defaultdict(dict)
        for e in d["events"]:
            allc[e["chain_id"]][e["chain_pos"]] = e
        acc_k = collections.Counter()
        for e in openers:
            ch = allc[e["chain_id"]]
            if len(ch) < 3:
                continue
            for pos in (0, 1, 2):
                k = row.get(ch[pos]["id"])
                if k is None or not P["valid"][k, j]:
                    continue
                pa = int(P["p_cls"][k, j].argmax())
                acc_k[(pos, "n")] += 1
                acc_k[(pos, "ok")] += pa == e["cls"] or (pa < N_MOVE and spec[pa] == spec[e["cls"]])
        L += ["", "同一批致命串（≥3 段），在第 1 / 2 / 3 个接触前 10 帧看分类（原口径）：" + "；".join(
            f"第 {p + 1} 个 {fmt(acc_k[(p, 'ok')], acc_k[(p, 'n')])}" for p in (0, 1, 2)), ""]
        bins = [(0, 0.5), (0.5, 0.8), (0.8, 0.99), (0.99, 1.01)]
        cnt = collections.Counter()
        for e in openers:
            k = row.get(e["id"])
            if k is None:
                continue
            cf = asg[str(e["chain_id"])]["conf"]
            b = next(i for i, (lo, hi) in enumerate(bins) if lo <= cf < hi)
            pa = int(P["p_cls"][k, j].argmax())
            cnt[(b, "n")] += 1
            cnt[(b, "ok")] += pa == e["cls"] or (pa < N_MOVE and spec[pa] == spec[e["cls"]])
        L += ["", "按聚类成员强度（assign conf）分（−10，原口径）：" + "；".join(
            f"[{lo}, {min(hi, 1)}) {fmt(cnt[(i, 'ok')], cnt[(i, 'n')])}" for i, (lo, hi) in enumerate(bins)), ""]
        pairs = collections.Counter()
        for e in openers:
            k = row.get(e["id"])
            if k is None:
                continue
            pa = int(P["p_cls"][k, j].argmax())
            if pa != e["cls"] and not (pa < N_MOVE and spec[pa] == spec[e["cls"]]):
                pairs[(e["cls"], pa)] += 1
        L += ["错得最多的 10 对（−10，原口径下算错的）：", "", "| 真 | 预测 | 串 | 真：颜色 / 串长众数 / 节奏 / 卸住率 | 预测：同左 |", "|---|---|---|---|---|"]

        def desc(c):
            if c >= N_MOVE:
                return "–"
            v = classes[c]
            rh = ",".join(f"{r['median']:.0f}" for r in v["rhythm"][1:5]) or "单段"
            return f"{v['color']} / {v['length_mode']} / {rh} / {v['ok_rate']:.2f}"
        for (t, p), n in pairs.most_common(10):
            L.append(f"| {cname(t)} | {cname(p)} | {n} | {desc(t)} | {desc(p)} |")
        L.append("")
    Path(a.out).write_text("\n".join(L) + "\n", encoding="utf-8")
    print("\n".join(L))


if __name__ == "__main__":
    main()
