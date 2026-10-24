"""Order 3b: prefix moves. Each contact k (chain_pos, 0 = opener) gets the label "prefix group of its chain's class at
position k": classes that cannot be told apart from what has happened up to that contact are merged. Fully automatic,
deterministic; writes data/moveid/teacher_prefix/prefix.json (group table + per-contact labels + merge log).

    uv run --no-project --with numpy --with scikit-learn python workspaces/WhereWindsMeet/tools/dufu_moveid/s3b_prefix.py

"Cannot be told apart" (data driven, per position k):
  sample    every non-grab-tick contact at chain position k whose chain has a taxonomy class with >= MIN_N such
            contacts at k ("eligible"); other classes at k -> group "k<k>:rare"; HDBSCAN-unknown chains -> "k<k>:unk";
            grab ticks (index outcome 'grab', the hits inside the grab cut-scene) -> "k<k>:grab" (handled apart).
  features  what is known at that contact: the order-3 teacher's out-of-fold output AT THE CONTACT FRAME (offset 0,
            not -10, so the decision difficulty does not define the classes): log class probabilities (45) + log
            opener-colour probabilities (3); plus the rhythm so far: gaps between contacts 0..k-1 of the chain
            (k - 1 values, /30). The order-3 teacher sees 32 frames, the gaps carry the earlier contacts.
  separability  multinomial logistic regression (standardised, class_weight balanced, C 1), out-of-fold with the same
            5 folds by round (s3_common.folds) -> confusion C[a -> b] = share of a's contacts predicted b.
  merge     agglomerative: repeatedly merge the pair of groups with the largest max(C[A -> B], C[B -> A]) while that
            is >= TAU (0.2: a fifth of one group's contacts look like the other); group confusion is recomputed from
            the per-contact predictions after every merge (no retraining). Positions with one eligible class: that
            class is its own group.
Per group: members, contacts, this contact's colour counts, response = majority of its contacts' labels
(s3b_gate1.response_labels decides per contact; the group value is only used for the derived response), parry ok / pf and
rate, damage (mean, median, share of contacts with dmg >= 0.02), next contact in the chain (share, gap quantiles).
"""
from __future__ import annotations

import collections
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s3_common import N_FOLDS, OUT, TEACHER, UNKNOWN, folds, load, read_json, write_json  # noqa: E402
from s3b_gate1 import PREFIX, UNPARRYABLE_MIN_N, UNPARRYABLE_RATE, response_labels  # noqa: E402

MIN_N = 10
TAU = 0.2
GAP_SCALE = 30.0
C_REG = 1.0


def features(rows: list[dict], k: int, P: dict, prow: dict, chains: dict) -> np.ndarray:
    j0 = list(P["offs"]).index(0)
    X = []
    for e in rows:
        r = prow[e["id"]]
        f = [np.log(P["p_cls"][r, j0].astype(np.float64) + 1e-4), np.log(P["p_col"][r, j0].astype(np.float64) + 1e-4)]
        ch = chains[e["chain_id"]]
        gaps = [(ch[i]["frame"] - ch[i - 1]["frame"]) / GAP_SCALE for i in range(1, k)]
        f.append(np.array(gaps, np.float64))
        X.append(np.concatenate(f))
    return np.array(X)


def oof_predict(X: np.ndarray, y: np.ndarray, fold: np.ndarray) -> np.ndarray:
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    pred = np.empty(len(y), y.dtype)
    for f in range(N_FOLDS):
        te = fold == f
        if not te.any():
            continue
        tr = ~te
        m = make_pipeline(StandardScaler(), LogisticRegression(C=C_REG, class_weight="balanced", max_iter=5000))
        m.fit(X[tr], y[tr])
        pred[te] = m.predict(X[te])
    return pred


def merge(y: np.ndarray, pred: np.ndarray, classes: list[int]) -> tuple[list[list[int]], list[dict]]:
    groups = [[c] for c in classes]
    log = []
    while len(groups) > 1:
        gi = {c: i for i, g in enumerate(groups) for c in g}
        yt = np.array([gi[c] for c in y])
        yp = np.array([gi[c] for c in pred])
        n = len(groups)
        M = np.zeros((n, n))
        np.add.at(M, (yt, yp), 1)
        C = M / M.sum(1, keepdims=True)
        best, pair = -1.0, None
        for a in range(n):
            for b in range(a + 1, n):
                s = max(C[a, b], C[b, a])
                if s > best:
                    best, pair = s, (a, b)
        if best < TAU:
            log.append({"stop": True, "max_pair_confusion": round(best, 4),
                        "pair": [groups[pair[0]], groups[pair[1]]] if pair else None})
            break
        a, b = pair
        log.append({"merge": [groups[a], groups[b]], "a_to_b": round(C[a, b], 4), "b_to_a": round(C[b, a], 4)})
        groups[a] = sorted(groups[a] + groups[b])
        del groups[b]
    return sorted(groups, key=lambda g: g[0]), log


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    d = load()
    ev = d["events"]
    idx = read_json(OUT / "index.json")["events"]
    outcome = {e["id"]: e["outcome"] for e in idx}
    fold_of = folds(d["recs"], ev)
    z = np.load(TEACHER / "oof.npz")
    P = {k: z[k] for k in z.files}
    prow = {int(i): r for r, i in enumerate(P["ids"])}
    chains = collections.defaultdict(list)
    for e in ev:
        chains[e["chain_id"]].append(e)
    for v in chains.values():
        v.sort(key=lambda e: e["chain_pos"])
    bypos = collections.defaultdict(list)
    for e in ev:
        bypos[e["chain_pos"]].append(e)

    groups, gid, poslog = [], {}, {}
    for k in sorted(bypos):
        rows = bypos[k]
        tick = [e for e in rows if outcome[e["id"]] == "grab"]
        rest = [e for e in rows if outcome[e["id"]] != "grab"]
        unk = [e for e in rest if e["cls"] == UNKNOWN]
        known = [e for e in rest if e["cls"] != UNKNOWN]
        n_c = collections.Counter(e["cls"] for e in known)
        elig = sorted(c for c, n in n_c.items() if n >= MIN_N)
        rare = [e for e in known if e["cls"] not in elig]
        el = [e for e in known if e["cls"] in elig]
        info = {"contacts": len(rows), "eligible_classes": {f"c{c}": n_c[c] for c in elig},
                "rare_classes": {f"c{c}": n for c, n in sorted(n_c.items()) if c not in elig},
                "unknown": len(unk), "grab_ticks": len(tick)}
        if len(elig) >= 2:
            X = features(el, k, P, prow, chains)
            y = np.array([e["cls"] for e in el])
            fo = np.array([fold_of[e["rec"]] for e in el])
            pred = oof_predict(X, y, fo)
            parts, mlog = merge(y, pred, elig)
            gi = {c: i for i, g in enumerate(parts) for c in g}
            info["oof_class_acc"] = round(float((pred == y).mean()), 4)
            info["oof_group_acc"] = round(float(np.mean([gi[a] == gi[b] for a, b in zip(y, pred)])), 4)
            info["merge_log"] = mlog
            info["confusion_classes"] = elig
            cm = np.zeros((len(elig), len(elig)), int)
            ix = {c: i for i, c in enumerate(elig)}
            for a, b in zip(y, pred):
                cm[ix[a], ix[b]] += 1
            info["confusion"] = cm.tolist()
        else:
            parts = [[c] for c in elig]
        poslog[str(k)] = info
        members = [(f"k{k}:" + "+".join(f"c{c}" for c in g), g, [e for e in el if e["cls"] in g]) for g in parts]
        if rare:
            members.append((f"k{k}:rare", sorted({e["cls"] for e in rare}), rare))
        if unk:
            members.append((f"k{k}:unk", [], unk))
        if tick:
            members.append((f"k{k}:grab", sorted({e["cls"] for e in tick}), tick))
        for name, mem, es in members:
            g = len(groups)
            groups.append({"gid": g, "name": name, "k": k, "members": [int(c) for c in mem],
                           "kind": name.split(":")[1] if name.split(":")[1] in ("rare", "unk", "grab") else "classes"})
            for e in es:
                gid[e["id"]] = g

    resp, gst = response_labels(ev, gid, outcome)
    nxt = {}
    for ch in chains.values():
        for a, b in zip(ch, ch[1:]):
            nxt[a["id"]] = b["frame"] - a["frame"]
    for g in groups:
        es = [e for e in ev if gid[e["id"]] == g["gid"]]
        g["n"] = len(es)
        g["chains"] = len({e["chain_id"] for e in es})
        g["colour"] = dict(collections.Counter(e["color"] for e in es))
        rs = collections.Counter(resp[e["id"]] for e in es)
        g["response_counts"] = {str(k): v for k, v in rs.items()}
        lab = [r for r in (resp[e["id"]] for e in es) if r is not None]
        g["response"] = "none" if not lab else ("dodge" if lab.count("dodge") > len(lab) / 2 else "parry")
        g["parry"] = gst.get(g["gid"], {"ok": 0, "pf": 0, "rate": None, "unparryable": False})
        g["outcomes"] = dict(collections.Counter(outcome[e["id"]] for e in es))
        dm = [e["dmg"] for e in es if e.get("dmg") is not None]
        g["dmg"] = {"n": len(dm), "mean": round(float(np.mean(dm)), 4) if dm else None,
                    "median": round(float(np.median(dm)), 4) if dm else None,
                    "share_ge_2pct": round(float(np.mean(np.array(dm) >= 0.02)), 4) if dm else None}
        gaps = [nxt[e["id"]] for e in es if e["id"] in nxt]
        g["next"] = {"share": round(len(gaps) / max(len(es), 1), 4),
                     "gap_q": [float(x) for x in np.percentile(gaps, [10, 25, 50, 75, 90])] if gaps else None}
        g["fatal_contacts"] = sum(1 for e in es if d["classes"].get(e["cls"], {}).get("fatal"))
    unp = [{"group": g["name"], "n": g["n"], "ok": g["parry"]["ok"], "pf": g["parry"]["pf"], "rate": g["parry"]["rate"],
            "colour": g["colour"], "fatal_contacts": g["fatal_contacts"]}
           for g in groups if g["parry"].get("unparryable")]
    unp_t = [{"group": g["name"], "ok_t": g["parry"]["ok_t"], "pf_t": g["parry"]["pf_t"], "rate_t": g["parry"]["rate_t"]}
             for g in groups if g["parry"].get("unparryable_t")]
    gold_follow = [{"group": g["name"], "n": g["n"], "parry": g["parry"], "colour": g["colour"]}
                   for g in groups if g["k"] > 0 and g["kind"] != "grab"
                   and any(d["classes"].get(c, {}).get("color") == "gold" for c in g["members"])]
    events = {str(e["id"]): {"gid": gid[e["id"]], "k": e["chain_pos"], "response": resp[e["id"]], "colour": e["color"]}
              for e in ev}
    out = {"params": {"MIN_N": MIN_N, "TAU": TAU, "GAP_SCALE": GAP_SCALE, "C": C_REG,
                      "UNPARRYABLE_RATE": UNPARRYABLE_RATE, "UNPARRYABLE_MIN_N": UNPARRYABLE_MIN_N,
                      "source": "teacher/oof.npz offset 0"},
           "doc": __doc__, "n_groups": len(groups),
           "groups_per_k": dict(collections.Counter(str(g["k"]) for g in groups)),
           "groups": groups, "unparryable": unp, "unparryable_type_based": unp_t, "gold_chain_followups": gold_follow,
           "positions": poslog, "events": events,
           "response_totals": {str(k): v for k, v in collections.Counter(resp.values()).items()}}
    write_json(PREFIX / "prefix.json", out)
    print("groups", len(groups), out["groups_per_k"])
    for k, inf in poslog.items():
        if "oof_class_acc" in inf:
            print(f"k{k}: classes {len(inf['eligible_classes'])} acc {inf['oof_class_acc']} -> groups "
                  f"{sum(1 for g in groups if g['k'] == int(k) and g['kind'] == 'classes')} acc {inf['oof_group_acc']}")
    for g in groups:
        if g["kind"] == "classes" and len(g["members"]) > 1:
            print(" ", g["name"], g["n"], g["response"], g["parry"]["rate"])
    print("unparryable:")
    for u in unp:
        print(" ", u)
    print("type-based unparryable:", [u["group"] for u in unp_t])
    print("responses", out["response_totals"])


if __name__ == "__main__":
    main()
