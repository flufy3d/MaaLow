"""进攻在线学习：机会级数据 -> 离线审计 -> 学习型安全门控（M1）-> JS 策略导出。

    MOVEID_PHASE=1 uv run --no-project --with numpy python workspaces/WhereWindsMeet/tools/dufu_moveid/offense_online.py build
    MOVEID_PHASE=1 uv run --no-project --with numpy python .../offense_online.py audit
    MOVEID_PHASE=1 uv run --no-project --with numpy python .../offense_online.py train
    MOVEID_PHASE=1 uv run --no-project --with numpy python .../offense_online.py export

数据：data/moveid/p1/live/rNNN（trace.json / result.json / contacts.json / rec.txt）与 live/meta/<rec>.json。
标签来自 contacts.json 的真值（视频帧），不用设备 hits。行 = 有 boss 的每个决策 tick（机会级，no-op 也算）。

设计见 workspaces/WhereWindsMeet/docs/dufu-offense-online.md（§3 schema、§5 M1）。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import OUT, PHASE, read_json, write_json  # noqa: E402

LIVE = OUT / "live"
ONLINE = OUT.parent / "offense" / "online"
FRAME_MS = 1000 / 30
H61, H70 = 61, 70
POLICY_JS = HERE.parents[1] / "skills" / "lib" / "dufu-offense-policy.js"

# Feature order is the contract with dufu-offense-policy.js (the generated vector() must use the same order).
FEATURES = [
    "hp", "qi", "bossFrac", "grpP", "p10", "med", "medKnown", "gold", "red", "dodge", "parry", "rnone", "p7",
    "nextShare", "shareMissing", "chainPos", "chainLen", "weaponHeng", "weaponModao", "near", "lock",
    "hitAge", "okAge", "lastKind", "hitsLast90", "c11Active", "lowHp", "lowBoss",
]


def rounds(names: list[str] | None = None) -> list[Path]:
    if names:
        out = [LIVE / n for n in names]
    else:
        out = sorted(p for p in LIVE.glob("r[0-9][0-9][0-9]") if int(p.name[1:]) >= 185)
    return [p for p in out if (p / "trace.json").exists() and (p / "contacts.json").exists()
            and (p / "result.json").exists() and (p / "rec.txt").exists()]


def trace_of(d: Path) -> tuple[list[str], np.ndarray]:
    trace = read_json(d / "trace.json", [])
    trace = sorted(trace, key=lambda c: c["chunk"])
    cols = trace[0]["cols"]
    return cols, np.array([r for c in trace for r in c["rows"]], np.float64)


def _ffill(a: np.ndarray, missing: float) -> np.ndarray:
    out = a.astype(np.float64).copy()
    out[out == missing] = np.nan
    good = ~np.isnan(out)
    if not good.any():
        return np.zeros_like(out)
    idx = np.where(good, np.arange(len(out)), -1)
    np.maximum.accumulate(idx, out=idx)
    filled = out[np.maximum(idx, 0)]
    filled[idx < 0] = 0.0
    return filled


def pressed_actions(res: dict) -> list[tuple[int, str]]:
    """(wall ms, action) of the offense presses. A press happens ~30 ms after its tick's trace row (tA), so the row is
    the last one with wall <= t, not the nearest one."""
    off = (res.get("offense") or {}) if isinstance(res, dict) else {}
    return [(int(e["t"]), str(e.get("a") or "")) for e in (off.get("log") or [])
            if e.get("ev") == "press" and e.get("a") in ("execute", "qishu", "light", "follow", "charge")]


def lands(res: dict) -> list[dict]:
    off = (res.get("offense") or {}) if isinstance(res, dict) else {}
    return [e for e in (off.get("log") or []) if e.get("ev") == "land"]


def build_round(d: Path) -> dict | None:
    res = (read_json(d / "result.json", {}) or {}).get("value")
    contacts = read_json(d / "contacts.json")
    cols, R = trace_of(d)
    if not res or not contacts or not R.size:
        return None
    rid = (d / "rec.txt").read_text(encoding="utf-8").strip()
    meta = read_json(LIVE / "meta" / f"{rid}.json")
    if not meta:
        return None
    C = {c: i for i, c in enumerate(cols)}
    n = len(R)
    k0 = (res["start"] - meta["started"]) / FRAME_MS
    frame = k0 + R[:, C["cap"]] / FRAME_MS + float(contacts.get("offset") or 0)

    hp = _ffill(R[:, C["hp"]], -1)
    qi = _ffill(R[:, C["qi"]], -1)
    boss = np.maximum(0, R[:, C["bossPx"] if "bossPx" in C else C["boss"]])
    keep = boss > 50
    if keep.sum() < 100:
        return None

    truth = contacts.get("truth") or []
    hit_f = np.array(sorted(float(t["frame"]) for t in truth if t.get("kind") == "hit"))
    ok_f = np.array(sorted(float(t["frame"]) for t in truth if t.get("kind") == "ok"))
    all_f = np.array(sorted(float(t["frame"]) for t in truth))
    all_kind = {float(t["frame"]): (1 if t.get("kind") == "ok" else -1) for t in truth}
    c11_f = np.array(sorted(float(t["frame"]) for t in truth
                            if "c11" in str((t.get("dec") or {}).get("grp", "")) or "c40" in str((t.get("dec") or {}).get("grp", ""))))

    def last_age(frames: np.ndarray, lim: int = 300) -> np.ndarray:
        if not len(frames):
            return np.full(n, -1.0)
        j = np.searchsorted(frames, frame, side="right") - 1
        age = np.where(j >= 0, frame - frames[np.maximum(j, 0)], lim)
        return np.clip(age, 0, lim)

    hit_age = last_age(hit_f)
    ok_age = last_age(ok_f)
    j = np.searchsorted(all_f, frame, side="right") - 1
    last_kind = np.array([all_kind.get(float(all_f[x]), 0) if x >= 0 else 0 for x in j], np.float64)
    hits90 = np.array([((hit_f > f - 90) & (hit_f <= f)).sum() for f in frame], np.float64)
    c11_age = last_age(c11_f, 75)
    c11_active = ((c11_age < 75) & (np.searchsorted(c11_f, frame, side="right") > 0)).astype(np.float64)

    share = R[:, C["nextShare"]] if "nextShare" in C else np.full(n, -1.0)
    share_missing = (share < -0.5).astype(np.float64)
    share = np.where(share < -0.5, 0.0, share)

    X = np.column_stack([
        np.clip(hp, 0, 1), np.clip(qi, 0, 386) / 386, boss / 386,
        R[:, C["grpP"]], R[:, C["p10"]],
        np.where(R[:, C["med"]] < 0, 0, np.clip(R[:, C["med"]], 0, 46)) / 46,
        (R[:, C["med"]] >= 0).astype(np.float64),
        R[:, C["gold"]], R[:, C["red"]], R[:, C["dodge"]], R[:, C["parry"]], R[:, C["rnone"]],
        R[:, C["c7P"]], share, share_missing,
        np.clip(R[:, C["chainPos"]], -1, 3) / 3, np.clip(R[:, C["chainLen"]], 0, 4) / 4,
        (R[:, C["weapon"]] == 2).astype(np.float64), (R[:, C["weapon"]] == 1).astype(np.float64),
        R[:, C["range"]], R[:, C["lock"]],
        np.clip(hit_age, 0, 300) / 300, np.clip(ok_age, 0, 300) / 300, last_kind,
        np.clip(hits90, 0, 3) / 3, c11_active,
        (hp < 0.3).astype(np.float64), (boss < 96).astype(np.float64),
    ])[keep]
    frame = frame[keep]
    wall = R[:, C["wall"]][keep]
    tier = R[:, C["atkTier"]][keep]
    reason = R[:, C["atkReason"]][keep]
    cand = R[:, C["cand"]][keep] if "cand" in C else np.where(tier > 0, tier, np.where(reason == 29, 1, 0))
    gate = R[:, C["gate"]][keep] if "gate" in C else np.zeros(len(frame))
    act = R[:, C["act"]][keep]

    presses = pressed_actions(res)
    action = np.full(len(frame), "", dtype=object)
    press_t = np.zeros(len(frame))
    for t, a in presses:
        i = int(np.searchsorted(wall, t, side="right")) - 1
        if 0 <= i < len(action):
            action[i] = a
            press_t[i] = t

    def next_hit(h: int) -> np.ndarray:
        if not len(hit_f):
            return np.zeros(len(frame))
        j = np.searchsorted(hit_f, frame, side="right")
        return np.array([1.0 if jj < len(hit_f) and hit_f[jj] <= f + h else 0.0 for jj, f in zip(j, frame)])

    y61, y70 = next_hit(H61), next_hit(H70)
    y120, y180 = next_hit(120), next_hit(180)
    c11_next = np.zeros(len(frame))
    if len(c11_f):
        jj = np.searchsorted(c11_f, frame, side="right")
        c11_next = np.array([1.0 if x < len(c11_f) and c11_f[x] <= f + H61 else 0.0 for x, f in zip(jj, frame)])

    return {"round": d.name, "arm": (read_json(d / "args.json", {}) or {}).get("offense", "off"),
            "X": X.astype(np.float32), "y61": y61, "y70": y70, "y120": y120, "y180": y180, "frame": frame, "wall": wall,
            "tier": tier, "reason": reason, "cand": cand, "gate": gate, "act": act, "action": action,
            "c11Next": c11_next, "n": int(len(frame)), "rec": rid, "hitF": hit_f, "okF": ok_f,
            "pressT": press_t,
            "nC11": int(len(c11_f)), "nC11Hit": int(sum(1 for t in truth if t.get("kind") == "hit" and
                                                         ("c11" in str((t.get("dec") or {}).get("grp", "")) or
                                                          "c40" in str((t.get("dec") or {}).get("grp", "")))))}


def load_all(names: list[str] | None = None) -> list[dict]:
    out = []
    for d in rounds(names):
        r = build_round(d)
        if r:
            out.append(r)
            print(f"build {d.name} {r['arm']:3s} rows {r['n']:5d} presses {int((r['action'] != '').sum()):3d} "
                  f"hits61 {int(r['y61'].sum()):4d}", flush=True)
    return out


def _auc(y: np.ndarray, s: np.ndarray) -> float | None:
    pos, neg = int(y.sum()), int((1 - y).sum())
    if not pos or not neg:
        return None
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s), np.float64)
    ranks[order] = np.arange(1, len(s) + 1)
    # average ranks for ties
    _, inv, cnt = np.unique(s, return_inverse=True, return_counts=True)
    for k in np.where(cnt > 1)[0]:
        m = inv == k
        ranks[m] = ranks[m].mean()
    return float((ranks[y == 1].sum() - pos * (pos + 1) / 2) / (pos * neg))


def _fit_logistic(X: np.ndarray, y: np.ndarray, l2: float = 1.0, iters: int = 30) -> tuple[np.ndarray, float]:
    """IRLS with an L2 penalty on the weights (not the intercept)."""
    n, f = X.shape
    A = np.column_stack([np.ones(n), X])
    w = np.zeros(f + 1)
    w[0] = math.log(max(1e-3, y.mean()) / max(1e-3, 1 - y.mean()))
    R = np.eye(f + 1) * l2
    R[0, 0] = 0
    for _ in range(iters):
        z = A @ w
        p = 1 / (1 + np.exp(-np.clip(z, -30, 30)))
        W = np.maximum(p * (1 - p), 1e-6)
        H = A.T @ (A * W[:, None]) + R
        g = A.T @ (y - p) - R @ w
        try:
            step = np.linalg.solve(H, g)
        except np.linalg.LinAlgError:
            break
        w += step
        if np.max(np.abs(step)) < 1e-7:
            break
    return w[1:], float(w[0])


def _oof(data: list[dict], key: str, k: int = 5) -> np.ndarray:
    idx = np.arange(len(data))
    preds = np.full(sum(len(d["y61"]) for d in data), np.nan)
    off = 0
    for d in data:
        d["_off"] = off
        off += len(d["y61"])
    for fold in range(k):
        val = [i for i in idx if i % k == fold]
        tr = [i for i in idx if i % k != fold]
        X = np.vstack([data[i]["X"] for i in tr])
        y = np.concatenate([data[i][key] for i in tr])
        mu, sd = X.mean(0), X.std(0)
        sd[sd < 1e-6] = 1
        w, b = _fit_logistic((X - mu) / sd, y)
        for i in val:
            p = 1 / (1 + np.exp(-(((data[i]["X"] - mu) / sd) @ w + b)))
            preds[data[i]["_off"]:data[i]["_off"] + len(p)] = p
    return preds


def _load_dmg() -> dict:
    """(round, press t) -> the bossFill 2 s damage (offense_boss_fill.py)."""
    out = {}
    try:
        bf = read_json(ONLINE / "bossfill.json", {}) or {}
        for r in bf.get("rounds", []):
            for x in r.get("presses", []):
                if x.get("dmg2") is not None:
                    out[(r["round"], int(x["t"]))] = float(x["dmg2"])
    except (TypeError, ValueError):
        pass
    return out


VAL_BASE = ["hp", "qi", "bossFrac", "grpP", "p10", "nextShare", "chainLen", "chainPos", "near", "weaponHeng",
            "hitAge", "c11Active"]


def value_rows(data: list[dict]) -> list[dict]:
    dmg = _load_dmg()
    idx = [FEATURES.index(k) for k in VAL_BASE]
    rows = []
    for d in data:
        if d["arm"] != "v2":
            continue
        for i in np.where(d["action"] != "")[0]:
            a = str(d["action"][i])
            if a == "execute":
                continue
            v = dmg.get((d["round"], int(d["pressT"][i])))
            if v is None:
                continue
            rows.append({"round": d["round"], "a": a, "x": list(d["X"][i][idx]) + [a == "light", a == "follow", a == "qishu"],
                         "y": 1.0 if v >= 2 else 0.0, "dmg": v})
    return rows


def value_oof(rows: list[dict]) -> np.ndarray:
    X = np.array([r["x"] for r in rows], np.float64)
    y = np.array([r["y"] for r in rows])
    folds = sorted({r["round"] for r in rows})
    p = np.full(len(rows), np.nan)
    for f in folds:
        tr = np.array([r["round"] != f for r in rows])
        mu, sd = X[tr].mean(0), X[tr].std(0)
        sd[sd < 1e-6] = 1
        w, b = _fit_logistic((X[tr] - mu) / sd, y[tr], l2=5.0)
        p[~tr] = 1 / (1 + np.exp(-(((X[~tr] - mu) / sd) @ w + b)))
    return p


def value_eval(data: list[dict]) -> dict:
    """M1b: can a press's zero-damage outcome be predicted? Trained on the v2 presses with a bossFill label."""
    rows = value_rows(data)
    if len(rows) < 30:
        return {"n": len(rows), "useful": False, "why": "too few labelled presses"}
    y = np.array([r["y"] for r in rows])
    p = value_oof(rows)
    auc = _auc(y, p)
    total = sum(r["dmg"] for r in rows)
    all_dmg = sum(x.get("total", 0) for x in _load_bossfill_rounds().values()) or total
    sweep = []
    for thr in (0.05, 0.07, 0.1, 0.12, 0.15, 0.2, 0.3, 0.5):
        veto = [r for r, pp in zip(rows, p) if pp < thr]
        keep = [r for r, pp in zip(rows, p) if pp >= thr]
        lost = sum(r["dmg"] for r in veto)
        sweep.append({"thr": thr, "veto_n": len(veto), "veto_rate": round(len(veto) / len(rows), 3),
                      "veto_dmg": round(lost, 1), "keep_dmg": round(sum(r["dmg"] for r in keep), 1),
                      "dmg_kept": round(sum(r["dmg"] for r in keep) / total, 3) if total else None,
                      "total_dmg_kept": round((all_dmg - lost) / all_dmg, 3) if all_dmg else None})
    return {"n": len(rows), "pos": int(y.sum()), "auc": round(auc, 3) if auc else None,
            "useful": bool(auc and auc >= 0.6), "sweep": sweep, "dmg_total": round(total, 1), "all_dmg": round(all_dmg, 1)}


def _load_bossfill_rounds() -> dict:
    out = {}
    try:
        bf = read_json(ONLINE / "bossfill.json", {}) or {}
        for r in bf.get("rounds", []):
            out[r["round"]] = r
    except (TypeError, ValueError):
        pass
    return out


def train(names: list[str] | None = None, k: int = 5) -> dict:
    data = load_all(names)
    if len(data) < 4:
        raise SystemExit("need >= 4 rounds")
    ONLINE.mkdir(parents=True, exist_ok=True)
    out = {"rounds": [d["round"] for d in data], "features": FEATURES, "k": k, "models": {}}
    for key, h in (("y61", H61), ("y70", H70)):
        p = _oof(data, key, k)
        y = np.concatenate([d[key] for d in data])
        out["models"][str(h)] = {"auc": _auc(y, p), "base": float(y.mean()), "n": int(len(y))}
        # calibration, 10 bins
        bins = np.clip((p * 10).astype(int), 0, 9)
        out["models"][str(h)]["calib"] = [
            {"bin": b, "n": int((bins == b).sum()), "pred": float(p[bins == b].mean()) if (bins == b).any() else None,
             "obs": float(y[bins == b].mean()) if (bins == b).any() else None} for b in range(10)]
        for d in data:
            sl = slice(d["_off"], d["_off"] + len(d["y61"]))
            d[f"p{h}"] = p[sl]
    # per-round AUC
    per = {}
    for d in data:
        row = {"arm": d["arm"], "n": d["n"]}
        for h in (H61, H70):
            row[f"auc{h}"] = _auc(d[f"y{h}"], d[f"p{h}"])
            row[f"base{h}"] = float(d[f"y{h}"].mean())
        per[d["round"]] = row
    out["per_round"] = per

    # gate thresholds on the OOF pressed rows (v2 arm only: the gate ships with offense v3)
    pressed = []
    for d in data:
        if d["arm"] != "v2":
            continue
        for i in np.where(d["action"] != "")[0]:
            a = d["action"][i]
            h = H70 if a == "qishu" else H61
            pressed.append({"round": d["round"], "a": a, "t": int(d["pressT"][i]), "p": float(d[f"p{h}"][i]),
                            "y": float(d[f"y{h}"][i])})
    dmg = _load_dmg()
    for x in pressed:
        x["dmg"] = dmg.get((x["round"], x["t"]))
    out["pressed"] = {"n": len(pressed), "hits": int(sum(x["y"] for x in pressed)),
                      "auc": _auc(np.array([x["y"] for x in pressed]), np.array([x["p"] for x in pressed])) if pressed else None,
                      "dmg_known": sum(x["dmg"] is not None for x in pressed),
                      "dmg_total": round(sum(x["dmg"] for x in pressed if x["dmg"] is not None), 1)}
    sweep = []
    for thr in np.arange(0.05, 1.0, 0.05):
        veto = [x for x in pressed if x["p"] >= thr]
        keep = [x for x in pressed if x["p"] < thr]
        vh = float(np.mean([x["y"] for x in veto])) if veto else 0.0
        kh = float(np.mean([x["y"] for x in keep])) if keep else 0.0
        dv = sum(x["dmg"] for x in veto if x["dmg"] is not None)
        dk = sum(x["dmg"] for x in keep if x["dmg"] is not None)
        sweep.append({"thr": round(float(thr), 2), "veto_n": len(veto), "veto_rate": round(len(veto) / max(1, len(pressed)), 3),
                      "veto_hit": round(vh, 3), "keep_hit": round(kh, 3),
                      "lift": round(vh / kh, 2) if kh else None,
                      "veto_dmg": round(dv, 1), "keep_dmg": round(dk, 1),
                      "veto_dmg_per_press": round(dv / len(veto), 2) if veto else None})
    out["sweep"] = sweep
    out["value"] = value_eval(data)
    write_json(ONLINE / "eval.json", out)
    print(json.dumps({h: {kk: out["models"][h][kk] for kk in ("auc", "base", "n")} for h in out["models"]}, ensure_ascii=False))
    print(json.dumps(out["pressed"], ensure_ascii=False))
    print(json.dumps(out["value"], ensure_ascii=False))
    for s in sweep:
        print(s)
    return out


def export(names: list[str] | None = None, k: int = 5, thr_light: float = 0.5, thr_qishu: float = 0.5) -> dict:
    """Fit on all rounds, write the JS policy (standardisation + weights + thresholds) and a small fixture."""
    data = load_all(names)
    models = {}
    for key, h in (("y61", H61), ("y70", H70)):
        X = np.vstack([d["X"] for d in data])
        y = np.concatenate([d[key] for d in data])
        mu, sd = X.mean(0), X.std(0)
        sd[sd < 1e-6] = 1
        w, b = _fit_logistic((X - mu) / sd, y)
        models[str(h)] = {"mean": mu.tolist(), "scale": sd.tolist(), "w": w.tolist(), "b": b}
    policy = {"version": "m1-" + "-".join(d["round"] for d in data[-1:]), "features": FEATURES,
              "models": models, "threshold": {"light": 0.0, "follow": 0.0, "qishu": 0.0, "execute": 0.0},
              "rounds": [d["round"] for d in data]}
    rows = value_rows(data)
    val = None
    if len(rows) >= 30:
        X = np.array([r["x"] for r in rows], np.float64)
        y = np.array([r["y"] for r in rows])
        mu, sd = X.mean(0), X.std(0)
        sd[sd < 1e-6] = 1
        w, b = _fit_logistic((X - mu) / sd, y, l2=5.0)
        p = value_oof(rows)
        auc = _auc(y, p)
        total = sum(r["dmg"] for r in rows)
        all_dmg = sum(x.get("total", 0) for x in _load_bossfill_rounds().values()) or total
        best, best_rate, best_kept = 0.0, 0.0, 1.0
        if auc and auc >= 0.6:
            for t in np.arange(0.05, 0.31, 0.01):
                lost = sum(r["dmg"] for r, pp in zip(rows, p) if pp < t)
                rate = sum(1 for pp in p if pp < t) / len(rows)
                kept = (all_dmg - lost) / all_dmg if all_dmg else 1.0
                if kept >= 0.95 and rate >= 0.15:
                    best, best_rate, best_kept = float(t), rate, kept
        val = {"features": VAL_BASE + ["actLight", "actFollow", "actQishu"],
               "mean": mu.tolist(), "scale": sd.tolist(), "w": w.tolist(), "b": b,
               "auc": round(auc, 3) if auc else None, "n": len(rows), "pos": int(y.sum()),
               "threshold": {a: round(best, 3) for a in ("light", "follow", "qishu")},
               "veto_rate_oof": round(best_rate, 3), "total_dmg_kept_oof": round(best_kept, 3),
               "useful": best > 0}
        policy["value"] = val
    ONLINE.mkdir(parents=True, exist_ok=True)
    write_json(ONLINE / "policy.json", policy)

    js = policy_js(policy)
    POLICY_JS.write_text(js, encoding="utf-8")
    # a committed fixture: 8 rows (4 arms) with the Python scores, so the JS vector cannot drift silently
    rows = []
    for d in data:
        idx = np.linspace(0, d["n"] - 1, 2).astype(int)
        for i in idx:
            r = {"x": d["X"][i].tolist()}
            for h in (H61, H70):
                m = policy["models"][str(h)]
                z = (d["X"][i] - np.array(m["mean"])) / np.array(m["scale"])
                r[f"p{h}"] = float(1 / (1 + np.exp(-(z @ np.array(m["w"]) + m["b"]))))
            rows.append(r)
    fx = {"features": FEATURES, "rows": rows}
    if val:
        iv = [FEATURES.index(k) for k in VAL_BASE]
        vr = []
        for d in data:
            ii = np.where(d["action"] != "")[0][:2]
            for i in ii:
                a = str(d["action"][i])
                x = [float(v) for v in list(d["X"][i][iv])] + [1.0 if a == "light" else 0.0,
                                                                1.0 if a == "follow" else 0.0,
                                                                1.0 if a == "qishu" else 0.0]
                z = (np.array(x) - np.array(val["mean"])) / np.array(val["scale"])
                vr.append({"a": a, "x": x, "p": float(1 / (1 + np.exp(-(z @ np.array(val["w"]) + val["b"]))))})
        fx["value_features"] = val["features"]
        fx["value_rows"] = vr
    write_json(HERE.parents[1] / "skills" / "lib" / "dufu-offense-policy-fixture.json", fx)
    print(f"policy -> {POLICY_JS} ({len(js)} bytes), fixture rows {len(rows)}, value rows {len(fx.get('value_rows', []))}")
    return policy


def policy_js(p: dict) -> str:
    f = p["features"]
    js = ["// GENERATED by tools/dufu_moveid/offense_online.py -- do not edit by hand.",
          "// M1 learned gate: logistic models on the tick state. `allow()` is the deployable v3 gate: execute is never",
          "// vetoed; every other action needs P(damage >= 2 px) >= its threshold (M1b value gate). The safety model",
          "// (H61/H70) stays exported for diagnostics; the 2026-11-01 audit showed it has no lift on pressed rows.",
          f"export const VERSION = {json.dumps(p['version'])};",
          f"export const FEATURES = {json.dumps(f)};",
          "export const HORIZONS = [61, 70];",
          f"export const THRESHOLD = {json.dumps(p['threshold'])};",
          "const M = {"]
    for h, m in p["models"].items():
        js.append(f"  {h}: {{ mean: {json.dumps([round(v, 6) for v in m['mean']])},")
        js.append(f"       scale: {json.dumps([round(v, 6) for v in m['scale']])},")
        js.append(f"       w: {json.dumps([round(v, 6) for v in m['w']])}, b: {round(m['b'], 6)} }},")
    js.append("};")
    v = p.get("value")
    if v:
        js.append(f"export const VALUE_FEATURES = {json.dumps(v['features'])};")
        js.append(f"export const VALUE_THRESHOLD = {json.dumps(v['threshold'])};")
        js.append(f"export const VALUE_AUC = {v.get('auc')};")
        js.append(f"const V = {{ mean: {json.dumps([round(x, 6) for x in v['mean']])},")
        js.append(f"     scale: {json.dumps([round(x, 6) for x in v['scale']])},")
        js.append(f"     w: {json.dumps([round(x, 6) for x in v['w']])}, b: {round(v['b'], 6)} }};")
    js.append("""
/** The state vector (order = FEATURES). s: the tick's raw numbers; missing reads are already normalised by dufu2.js. */
export function vector(s) {
    return [
        clamp01(s.hp), clamp01((s.qi ?? 0) / 386), clamp01((s.bossPx ?? 0) / 386), clamp01(s.grpP ?? 0), clamp01(s.p10 ?? 0),
        s.med == null || s.med < 0 ? 0 : Math.min(s.med, 46) / 46, s.med == null || s.med < 0 ? 0 : 1,
        clamp01(s.gold ?? 0), clamp01(s.red ?? 0), clamp01(s.dodge ?? 0), clamp01(s.parry ?? 0), clamp01(s.rnone ?? 0),
        clamp01(s.c7P ?? 0), clamp01(s.nextShare ?? 0), s.nextShare == null || s.nextShare < -0.5 ? 1 : 0,
        Math.min(Math.max(s.chainPos ?? -1, -1), 3) / 3, Math.min(Math.max(s.chainLen ?? 0, 0), 4) / 4,
        s.weapon === "hengdao" ? 1 : 0, s.weapon === "modao" ? 1 : 0, s.near ? 1 : 0, s.lock ? 1 : 0,
        clamp01((s.hitAgeF ?? 300) / 300), clamp01((s.okAgeF ?? 300) / 300), s.lastKind ?? 0,
        Math.min(Math.max(s.hitsLast90 ?? 0, 0), 3) / 3, s.c11Active ? 1 : 0, s.hp != null && s.hp < 0.3 ? 1 : 0,
        (s.bossPx ?? 0) < 96 ? 1 : 0,
    ];
}
const clamp01 = (v) => (!isFinite(v) || v < 0 ? 0 : v > 1 ? 1 : v);
/** P(hit within h frames) for the state s (diagnostics; the deployed gate is the value model below). */
export function risk(h, s) {
    const m = M[h], x = vector(s);
    let z = m.b;
    for (let i = 0; i < x.length; i++) z += ((x[i] - m.mean[i]) / m.scale[i]) * m.w[i];
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}
/** P(an action press deals >= 2 px), M1b. The action dummies are last (light / follow / qishu). */
export function value(action, s) {
    const x = [
        clamp01(s.hp), clamp01((s.qi ?? 0) / 386), clamp01((s.bossPx ?? 0) / 386), clamp01(s.grpP ?? 0), clamp01(s.p10 ?? 0),
        clamp01(s.nextShare ?? 0), Math.min(Math.max(s.chainLen ?? 0, 0), 4) / 4,
        Math.min(Math.max(s.chainPos ?? -1, -1), 3) / 3, s.near ? 1 : 0, s.weapon === "hengdao" ? 1 : 0,
        clamp01((s.hitAgeF ?? 300) / 300), s.c11Active ? 1 : 0,
        action === "light" ? 1 : 0, action === "follow" ? 1 : 0, action === "qishu" ? 1 : 0,
    ];
    let z = V.b;
    for (let i = 0; i < x.length; i++) z += ((x[i] - V.mean[i]) / V.scale[i]) * V.w[i];
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}
/** The v3 gate: true = let the engine's action through. Execute is never vetoed; unknown actions are not gated. */
export function allow(action, s) {
    if (action === "execute") return true;
    const t = VALUE_THRESHOLD[action];
    if (t == null) return true;
    return value(action, s) >= t;
}
""")
    return "\n".join(js)


def audit(names: list[str] | None = None) -> dict:
    data = load_all(names)
    out = {"rounds": [], "totals": {}}
    for d in data:
        logs = lands(read_json(LIVE / d["round"] / "result.json", {}).get("value") or {})
        by_action: dict[str, list[float]] = {}
        for i in np.where(d["action"] != "")[0]:
            by_action.setdefault(str(d["action"][i]), []).append(float(d["y61"][i]))
        c11 = int(d["c11Next"].sum())
        out["rounds"].append({"round": d["round"], "arm": d["arm"], "rows": d["n"],
                              "opps": int(((d["tier"] > 0) | (d["reason"] == 29)).sum()),
                              "presses": int((d["action"] != "").sum()),
                              "pressed_hit61": int(sum(d["y61"][np.where(d["action"] != "")[0]])),
                              "pressed_by_action": {a: {"n": len(v), "hit61": int(sum(v))} for a, v in sorted(by_action.items())},
                              "land_dmg": {a: [x.get("dmg") for x in logs if x.get("a") == a and x.get("dmg") is not None]
                                           for a in ("execute", "qishu", "light", "follow")},
                              "c11_windows": c11, "c11_contacts": d["nC11"], "c11_hits": d["nC11Hit"]})
    out["totals"] = {
        "rows": sum(r["rows"] for r in out["rounds"]), "opps": sum(r["opps"] for r in out["rounds"]),
        "presses": sum(r["presses"] for r in out["rounds"]),
        "c11_windows": sum(r["c11_windows"] for r in out["rounds"]),
        "c11_contacts": sum(r["c11_contacts"] for r in out["rounds"]),
        "c11_hits": sum(r["c11_hits"] for r in out["rounds"]),
        "pressed_by_action": {a: {"n": sum(r["pressed_by_action"].get(a, {}).get("n", 0) for r in out["rounds"]),
                                  "hit61": sum(r["pressed_by_action"].get(a, {}).get("hit61", 0) for r in out["rounds"])}
                              for a in ("execute", "qishu", "light", "follow")},
        "land_dmg": {a: [v for r in out["rounds"] for v in r["land_dmg"].get(a, [])]
                     for a in ("execute", "qishu", "light", "follow")},
    }
    ONLINE.mkdir(parents=True, exist_ok=True)
    write_json(ONLINE / "audit.json", out)
    lines = ["# 进攻机会级数据审计（阶段一）", "",
             f"局数 {len(out['rounds'])}，行 {out['totals']['rows']}，机会 {out['totals']['opps']}，按键 {out['totals']['presses']}", "",
             "| 局 | arm | 行 | 机会 | 按键 | 按键窗内受击 | c11 接触/命中 |", "|---|---|---:|---:|---:|---:|---:|"]
    for r in out["rounds"]:
        lines.append(f"| {r['round']} | {r['arm']} | {r['rows']} | {r['opps']} | {r['presses']} | {r['pressed_hit61']} | {r['c11_contacts']}/{r['c11_hits']} |")
    lines += ["", "## 按键与窗内受击", "", "| 动作 | n | 窗内受击 |", "|---|---:|---:|"]
    for a, v in out["totals"]["pressed_by_action"].items():
        lines.append(f"| {a} | {v['n']} | {v['hit61']} |")
    lines += ["", "## 落点伤害（旧 ROI，只作参考；以 boss_roi.md 为准）", "", "| 动作 | n | 中位 | 合计 |", "|---|---:|---:|---:|"]
    for a, v in out["totals"]["land_dmg"].items():
        vv = [x for x in v if x is not None]
        lines.append(f"| {a} | {len(vv)} | {float(np.median(vv)) if vv else 0:.1f} | {sum(vv):.0f} |")
    (ONLINE / "audit.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[:12]))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("build", "audit", "train", "export"):
        p = sub.add_parser(name)
        p.add_argument("rounds", nargs="*")
    e = sub.choices["export"]
    e.add_argument("--thr-light", type=float, default=0.5)
    e.add_argument("--thr-qishu", type=float, default=0.5)
    a = ap.parse_args()
    if a.cmd == "build":
        data = load_all(a.rounds or None)
        ONLINE.mkdir(parents=True, exist_ok=True)
        for d in data:
            np.savez_compressed(ONLINE / f"opp_{d['round']}.npz", X=d["X"], y61=d["y61"], y70=d["y70"],
                                y120=d["y120"], y180=d["y180"],
                                frame=d["frame"], wall=d["wall"], tier=d["tier"], reason=d["reason"], cand=d["cand"],
                                gate=d["gate"], act=d["act"], action=d["action"], c11Next=d["c11Next"])
        write_json(ONLINE / "manifest.json", {"rounds": [{"round": d["round"], "arm": d["arm"], "n": d["n"], "rec": d["rec"]}
                                              for d in data], "features": FEATURES})
        print(f"{len(data)} rounds -> {ONLINE}")
    elif a.cmd == "audit":
        audit(a.rounds or None)
    elif a.cmd == "train":
        train(a.rounds or None)
    else:
        export(a.rounds or None, thr_light=a.thr_light, thr_qishu=a.thr_qishu)


if __name__ == "__main__":
    main()
