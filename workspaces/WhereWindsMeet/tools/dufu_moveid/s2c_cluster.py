"""Order 2 clustering: chains (s2c_slice.py) -> boss moves, fully automatic, numbered not named.

Pipeline (one seed, one subset of chains):
  features   windows relative to the first contact (WINS), each the mean of the per-recording-centred CLS of
             glob / big / small, L2-normalised, plus the rhythm of contacts 2..RHY_J+1 (present 0/1, offset from the
             first / 30 frames; both x RHY_W) and the opener colour (one-hot gold / red / none x COLOR_W, unknown =
             1/3 each) -> PCA(PCA_DIM) fitted on the subset.
             The visual windows stop at -11: frames from the contact on show the player's own result (parry sparks vs
             hit flash, stagger), and with them (even at weight 0.3) the same move splits into an "all ok" and an
             "all hit" class (README). What happens after the first contact enters through the rhythm (when the
             follow-up contacts land), which the boss decides. The decision window [-10, -1] is left out too, so
             gate 1 (decision at -10) is not judged on the frames that defined the classes. --post adds the old
             post-contact windows ([0, 5], [6, 15], last contact + 1 .. + 10) for comparison.
  cluster    UMAP(UMAP_NN, UMAP_DIM, min_dist 0) -> HDBSCAN(min_cluster_size MCS); HDBSCAN noise = unknown
  checks     1 colour split   opener colour (unknown excluded) minority > COLOR_MAX -> one class per colour
             (classes < MIN_CLASS after the colour split -> unknown)
             2 rhythm split   chain length (1-D GMM, k = 1..RHY_KMAX by BIC) or else the 2nd-contact offset (same),
                              only into groups that are clearly apart (RHY_*, see gmm_split); 1-contact chains go to
                              the nearer PCA centroid; children are re-checked (RHY_DEPTH rounds)
             3 merge          same majority colour, same modal length, median offsets of every contact (chains of
                              the modal length, < LEN_CAP) within MERGE_OFF frames, PCA centroid distance <
                              (MERGE_DIST + MERGE_STEP x (modal length - 1)) x mean member radius -> one class
                              (closest pair first, repeated). Every matching follow-up contact is independent
                              evidence, so a longer shared rhythm allows a looser visual match (the same 4-hit gold
                              move at the phase-2 start, boss far away, vs mid-fight is 1.3 x radius apart).
                              Pairs that match except the distance (< 2 x the limit) are logged as "not merged"
             4 small          classes < MIN_CLASS chains -> unknown
  grabs      grab chains (chain_kind grab) are clustered on their own with the same features (MCS_GRAB) and the
             same checks; their classes are flagged kind = grab.
Every check logs what it did. main() runs the full set (seed 0), the stability runs (odd / even rounds, seeds
1-3), onset estimation, the move table and the report; see README "顺序 2：切片与聚类".
"""
from __future__ import annotations

import argparse
import collections
import json
import time

from pathlib import Path

import numpy as np
from sklearn.cluster import HDBSCAN
from sklearn.decomposition import PCA
from sklearn.metrics import adjusted_rand_score, normalized_mutual_info_score
from sklearn.mixture import GaussianMixture
from sklearn.neighbors import KNeighborsClassifier

from common import OUT, read_json, write_json

MOVES = OUT / "moves"
WINS = [(-60, -41), (-40, -21), (-20, -11)]
POST_WINS = [(-10, -1), (0, 5), (6, 15)]   # only with --post
POST_LAST = False
PCA_DIM = 64
RHY_W, RHY_J = 1.5, 3
COLOR_W = 2.0
UMAP_NN, UMAP_DIM = 30, 10
MCS, MCS_GRAB = 20, 15
COLOR_MAX = 0.03
RHY_MIN_W, RHY_MIN_N, RHY_BIC = 0.15, 15, 10.0
RHY_LEN_GAP, RHY_OFF_GAP, RHY_SEP = 1.5, 8.0, 2.0
RHY_KMAX, RHY_DEPTH = 4, 3
MERGE_OFF, MERGE_DIST, MERGE_STEP = 4.0, 0.6, 0.4
MIN_CLASS = 15
LEN_CAP = 8
COLORS = ("gold", "red", "none")


class Log:
    def __init__(self, quiet: bool = False):
        self.lines, self.quiet = [], quiet

    def __call__(self, msg: str) -> None:
        self.lines.append(msg)
        if not self.quiet:
            print(msg, flush=True)


# ---------------------------------------------------------------- data + features

def load():
    z = np.load(MOVES / "slices.npz")
    s = read_json(MOVES / "slices.json")
    return z, s


def features(z, cs: list[dict], pre: int) -> np.ndarray:
    seq, start, length, rm, ri = z["seq"], z["start"], z["length"], z["rec_mean"], z["rec_idx"]
    nv = (len(WINS) + POST_LAST) * 3 * 384
    out = np.zeros((len(cs), nv + 2 * RHY_J + 3), np.float32)
    for i, c in enumerate(cs):
        s = seq[start[i]:start[i] + length[i]].astype(np.float32) - rm[ri[i]]
        last = c["offsets"][-1]
        f = []
        for a, b in WINS:
            b2 = min(b, last + 10)
            a2 = min(a, b2)
            f.append(s[pre + a2:pre + b2 + 1].mean(0))
        if POST_LAST:
            f.append(s[pre + last + 1:].mean(0))
        f = np.stack(f)
        f /= np.linalg.norm(f, axis=-1, keepdims=True) + 1e-6
        out[i, :nv] = f.reshape(-1)
        for j in range(1, RHY_J + 1):
            if j < len(c["offsets"]):
                out[i, nv + 2 * (j - 1)] = RHY_W
                out[i, nv + 2 * (j - 1) + 1] = RHY_W * c["offsets"][j] / 30
        col = c["color"]
        out[i, -3:] = COLOR_W * (np.array([col == "gold", col == "red", col == "none"], np.float32)
                                 if col in COLORS else np.full(3, 1 / 3, np.float32))
    return out


# ---------------------------------------------------------------- clustering + checks

def embed_cluster(P: np.ndarray, seed: int, mcs: int):
    import umap
    nn = min(UMAP_NN, len(P) - 1)
    U = umap.UMAP(n_neighbors=nn, n_components=UMAP_DIM, min_dist=0.0, random_state=seed).fit_transform(P)
    h = HDBSCAN(min_cluster_size=mcs).fit(U)
    return h.labels_.copy(), h.probabilities_.copy()


def gmm_split(x: np.ndarray, reg: float, min_gap: float, scale: float = 1.0):
    """1-D rhythm values -> group index per value (0 = lowest) when they form >= 2 clearly separate groups, else None.

    GMM with k = 1..RHY_KMAX (reg_covar = reg), best k by BIC; needs BIC(1) - BIC(best) > RHY_BIC. Then adjacent
    components are merged (the worst pair first) while two neighbours are closer than min_gap or than RHY_SEP pooled
    standard deviations, or a group has < RHY_MIN_N chains or < RHY_MIN_W of the class (means / spreads recomputed
    from the members, sd floored at sqrt(reg))."""
    min_n = max(3, int(round(RHY_MIN_N * scale)))
    if len(x) < 2 * min_n or np.unique(x).size < 2:
        return None, "too few / constant"
    x2 = x.reshape(-1, 1).astype(float)
    fits = [GaussianMixture(k, reg_covar=reg, random_state=0, n_init=3).fit(x2)
            for k in range(1, min(RHY_KMAX, np.unique(x).size) + 1)]
    bics = [g.bic(x2) for g in fits]
    best = int(np.argmin(bics))
    d_bic = bics[0] - bics[best]
    if best == 0 or d_bic <= RHY_BIC:
        return None, f"best k {best + 1}, dBIC {d_bic:.1f}"
    g = fits[best]
    order = np.argsort(g.means_.ravel())
    rank = np.empty_like(order)
    rank[order] = np.arange(len(order))
    grp = rank[g.predict(x2)]
    groups = [[i] for i in range(len(order))]

    def stats(gs):
        m = np.isin(grp, gs)
        return x[m].mean() if m.any() else 0.0, max(x[m].std() if m.sum() > 1 else 0.0, np.sqrt(reg)), int(m.sum())

    while len(groups) > 1:
        st = [stats(gs) for gs in groups]
        bad = []
        for i in range(len(groups) - 1):
            (m0, s0, n0), (m1, s1, n1) = st[i], st[i + 1]
            sep = (m1 - m0) / np.sqrt((s0 ** 2 + s1 ** 2) / 2)
            small = min(n0, n1) < min_n or min(n0, n1) / len(x) < RHY_MIN_W
            if m1 - m0 < min_gap or sep < RHY_SEP or small:
                bad.append((0 if small else 1, sep, i))
        if not bad:
            break
        _, _, i = min(bad)
        groups[i:i + 2] = [groups[i] + groups[i + 1]]
    if len(groups) < 2:
        return None, f"best k {best + 1}, dBIC {d_bic:.1f}, merged back to one group"
    out = np.zeros(len(x), int)
    for gi, gs in enumerate(groups):
        out[np.isin(grp, gs)] = gi
    st = [stats(gs) for gs in groups]
    why = f"k {best + 1}, dBIC {d_bic:.1f}, groups " + " / ".join(f"{m:.1f}±{sd:.1f} n{n}" for m, sd, n in st)
    return out, why


def centroids(P, lab):
    ks = sorted(set(lab.tolist()) - {-1})
    return ks, (np.stack([P[lab == k].mean(0) for k in ks]) if ks else np.zeros((0, P.shape[1])))


def nearest(P, ks, C, rows):
    if not len(ks):
        return np.full(len(rows), -1)
    d = ((P[rows, None, :] - C[None]) ** 2).sum(-1)
    return np.array(ks)[d.argmin(1)]


def checks(P, lab, cs: list[dict], log: Log, tag: str, scale: float = 1.0):
    """Colour split -> rhythm split -> merge -> small. lab: HDBSCAN labels (-1 noise), modified copy returned."""
    lab = lab.copy()
    col = np.array([c["color"] for c in cs])
    L = np.array([min(len(c["offsets"]), LEN_CAP) for c in cs])
    off2 = np.array([c["offsets"][1] if len(c["offsets"]) > 1 else -1 for c in cs])
    nxt = [lab.max() + 1]

    def new():
        nxt[0] += 1
        return nxt[0] - 1

    # 1 colour
    for k in sorted(set(lab.tolist()) - {-1}):
        m = lab == k
        cc = collections.Counter(col[m & (col != "unknown")].tolist())
        n = sum(cc.values())
        if not n:
            continue
        maj, nm = cc.most_common(1)[0]
        if 1 - nm / n <= COLOR_MAX:
            continue
        parts = {}
        for cname in cc:
            if cname == maj:
                parts[cname] = k
            else:
                parts[cname] = new()
                lab[m & (col == cname)] = parts[cname]
        unk = np.where(m & (col == "unknown"))[0]
        if len(unk):
            ks = list(parts.values())
            C = np.stack([P[lab == q].mean(0) for q in ks])
            lab[unk] = nearest(P, ks, C, unk)
        log(f"[{tag}] colour split c{k}: {dict(cc)} minority {1 - nm / n:.3f} > {COLOR_MAX} -> "
            + ", ".join(f"{cn}:c{q}({(lab == q).sum()})" for cn, q in parts.items()))

    minc = max(3, int(round(MIN_CLASS * scale)))
    small(lab, log, tag, minc)

    # 2 rhythm (children are checked again, RHY_DEPTH rounds)
    todo = sorted(set(lab.tolist()) - {-1})
    for depth in range(RHY_DEPTH):
        nxt_todo = []
        for k in todo:
            m = np.where(lab == k)[0]
            gl, why = gmm_split(L[m], 0.25, RHY_LEN_GAP, scale)
            if gl is not None:
                ids = [k] + [new() for _ in range(gl.max())]
                for gi, q in enumerate(ids):
                    lab[m[gl == gi]] = q
                log(f"[{tag}] rhythm split c{k} by chain length ({why}) -> "
                    + ", ".join(f"c{q} len~{np.median(L[m[gl == gi]]):.0f} ({(gl == gi).sum()})"
                                for gi, q in enumerate(ids)))
                nxt_todo += ids
                continue
            m2 = m[off2[m] >= 0]
            gl, why2 = gmm_split(off2[m2], 4.0, RHY_OFF_GAP, scale)
            if gl is not None:
                ids = [k] + [new() for _ in range(gl.max())]
                for gi, q in enumerate(ids):
                    lab[m2[gl == gi]] = q
                ones = m[off2[m] < 0]
                if len(ones):
                    C = np.stack([P[m2[gl == gi]].mean(0) for gi in range(len(ids))])
                    lab[ones] = nearest(P, ids, C, ones)
                log(f"[{tag}] rhythm split c{k} by 2nd-contact offset ({why2}) -> "
                    + ", ".join(f"c{q} ({(lab == q).sum()})" for q in ids) + "; 1-contact chains by nearer centroid")
                nxt_todo += ids
        todo = nxt_todo
        if not todo:
            break

    # 3 merge
    offs = [c["offsets"] for c in cs]
    near = {}
    while True:
        ks = sorted(set(lab.tolist()) - {-1})
        info = {}
        for k in ks:
            m = lab == k
            cc = collections.Counter(col[m & (col != "unknown")].tolist())
            c0 = P[m].mean(0)
            mode = collections.Counter(L[m].tolist()).most_common(1)[0][0]
            mm = [offs[i] for i in np.where(m & (L == mode))[0]]
            info[k] = dict(color=cc.most_common(1)[0][0] if cc else "unknown", mode=mode,
                           tmpl=np.median(np.array([o[:mode] for o in mm]), 0) if mode < LEN_CAP else None,
                           c=c0, r=float(np.sqrt(((P[m] - c0) ** 2).sum(1)).mean()))
        best = None
        for i, a in enumerate(ks):
            for b in ks[i + 1:]:
                A, B = info[a], info[b]
                if A["color"] != B["color"] or A["mode"] != B["mode"] or A["tmpl"] is None or B["tmpl"] is None:
                    continue
                if np.abs(A["tmpl"] - B["tmpl"]).max() > MERGE_OFF:
                    continue
                d = float(np.sqrt(((A["c"] - B["c"]) ** 2).sum()))
                ratio = d / max((A["r"] + B["r"]) / 2, 1e-6)
                lim = MERGE_DIST + MERGE_STEP * (A["mode"] - 1)
                if ratio < lim:
                    if best is None or ratio < best[0]:
                        best = (ratio, a, b)
                elif ratio < 2 * lim:
                    near[(a, b)] = (ratio, lim)
        if best is None:
            break
        ratio, a, b = best
        log(f"[{tag}] merge c{b} ({(lab == b).sum()}) into c{a} ({(lab == a).sum()}): colour {info[a]['color']}, "
            f"rhythm {info[a]['tmpl'].tolist()} / {info[b]['tmpl'].tolist()}, centroid distance {ratio:.2f} x radius "
            f"< {MERGE_DIST + MERGE_STEP * (info[a]['mode'] - 1):.1f}")
        lab[lab == b] = a
    alive = set(lab.tolist())
    for (a, b), (ratio, lim) in sorted(near.items()):
        if a in alive and b in alive:
            log(f"[{tag}] not merged c{a} / c{b}: same colour and rhythm, but centroid distance {ratio:.2f} x radius "
                f">= {lim:.1f}")

    # 4 small
    small(lab, log, tag, minc)
    return lab


def small(lab, log, tag, minc):
    for k in sorted(set(lab.tolist()) - {-1}):
        n = int((lab == k).sum())
        if n < minc:
            lab[lab == k] = -1
            log(f"[{tag}] small c{k} ({n} < {minc}) -> unknown")


def renumber(lab: np.ndarray, start: int = 0):
    """Classes by size (desc), ids from `start`; -1 stays. -> (new labels, {old id: new id})."""
    ks = sorted(set(lab.tolist()) - {-1}, key=lambda k: (-(lab == k).sum(), k))
    mp = {k: start + i for i, k in enumerate(ks)}
    return np.array([mp.get(k, -1) for k in lab.tolist()]), mp


def pipeline(X: np.ndarray, cs: list[dict], seed: int, mcs: int, log: Log, tag: str, scale: float = 1.0,
             start: int = 0):
    """-> (labels, probabilities, PCA-projected X, fitted PCA). scale < 1 (half the data) scales the size thresholds
    (min_cluster_size, MIN_CLASS, RHY_MIN_N) so a half is clustered at the same granularity as the full set."""
    pca = PCA(min(PCA_DIM, len(X) - 1), random_state=0).fit(X)
    P = pca.transform(X)
    lab, prob = embed_cluster(P, seed, max(5, int(round(mcs * scale))))
    log(f"[{tag}] HDBSCAN: {len(set(lab.tolist()) - {-1})} clusters, noise {np.mean(lab == -1):.3f} "
        f"({len(X)} chains, seed {seed})")
    lab = checks(P, lab, cs, log, tag, scale)
    prob[lab == -1] = 0.0
    lab, mp = renumber(lab, start)
    log(f"[{tag}] final ids (working id -> class id; ids in the lines above are working ids): "
        + ", ".join(f"c{a}->{b}" for a, b in sorted(mp.items())))
    log(f"[{tag}] after checks: {len(set(lab.tolist()) - {-1})} classes, unknown {np.mean(lab == -1):.3f}")
    return lab, prob, P, pca


# ---------------------------------------------------------------- stability

def ari_pair(a, b):
    a, b = np.asarray(a), np.asarray(b)
    m = (a >= 0) & (b >= 0)
    return {"all": round(float(adjusted_rand_score(a, b)), 3),
            "both_assigned": round(float(adjusted_rand_score(a[m], b[m])), 3), "n_both": int(m.sum())}


def split_half(X, cs, seed, log):
    rnum = np.array([int(c["round"].split("/r")[-1]) for c in cs])
    halves = {"odd": np.where(rnum % 2 == 1)[0], "even": np.where(rnum % 2 == 0)[0]}
    res = {}
    for h, idx in halves.items():
        lab, _, _, pca = pipeline(X[idx], [cs[i] for i in idx], seed, MCS, log, f"half-{h}", len(idx) / len(X))
        res[h] = (idx, lab, pca)
    out = {}
    for src, dst in (("odd", "even"), ("even", "odd")):
        si, sl, spca = res[src]
        di, dl, _ = res[dst]
        Ps, Pd = spca.transform(X[si]), spca.transform(X[di])
        ks, C = centroids(Ps, sl)
        pred = nearest(Pd, ks, C, np.arange(len(di)))
        knn = KNeighborsClassifier(10).fit(Ps[sl >= 0], sl[sl >= 0]).predict(Pd)
        m = dl >= 0
        out[f"{src}->{dst}"] = {
            "centroid": round(float(adjusted_rand_score(dl[m], pred[m])), 3),
            "knn10": round(float(adjusted_rand_score(dl[m], knn[m])), 3),
            "n": int(m.sum()), "classes_src": len(ks), "classes_dst": len(set(dl.tolist()) - {-1})}
    return out


# ---------------------------------------------------------------- onset

ONSET_RISE = 0.1


def last_run(s: np.ndarray, th: float, end: int) -> int:
    """Index where the run of s >= th (gaps <= 2 frames) that contains `end` starts, walking backwards."""
    t, gap = end, 0
    for u in range(end, -1, -1):
        if s[u] >= th:
            t, gap = u, 0
        else:
            gap += 1
            if gap > 2:
                break
    return t


def onsets(z, cs, lab, pre: int):
    """起手 (move start) relative to the first contact, per class, from the big-view embedding trajectory.

    Template m(t), t in [-pre, 0] = mean of the L2-normalised, per-recording-centred big-view CLS of the class's
    chains; |m(t)| (the class consistency curve) is low while the boss is still doing unrelated things and rises
    when every chain shows the same animation. Class onset: last run of |m(t)| (3-frame smoothed) above
    base + (peak - base) / 2 that ends at the peak, base = median over [-pre, -pre + 15], peak = max over [-15, 0];
    rise = peak - base < ONSET_RISE -> no visible start inside the window (onset None).
    Per chain: s(t) = cos(x(t), m(t)) with the chain left out of m, same rule with the chain's own base / peak;
    chains whose own rise < ONSET_RISE are skipped. -> {class: {class_onset, rise, chains: [...], n_flat}}, curves."""
    seq, start, rm, ri = z["seq"], z["start"], z["rec_mean"], z["rec_idx"]
    out, curves = {}, {}
    sm = lambda v: np.convolve(np.pad(v, 1, mode="edge"), np.ones(3) / 3, "valid")  # noqa: E731
    for k in sorted(set(lab.tolist()) - {-1}):
        idx = np.where(lab == k)[0]
        A = np.stack([seq[start[i]:start[i] + pre + 1, 1].astype(np.float32) - rm[ri[i], 1] for i in idx])
        A /= np.linalg.norm(A, axis=-1, keepdims=True) + 1e-6
        S = A.sum(0)
        c = sm(np.linalg.norm(S / len(idx), axis=-1))
        curves[k] = c
        base, pk = float(np.median(c[:16])), int(pre - 15 + np.argmax(c[-16:]))
        rise = float(c[pk] - base)
        cls_on = pre - last_run(c, base + rise / 2, pk) if rise >= ONSET_RISE else None
        res, flat = [], 0
        for j in range(len(idx)):
            m = (S - A[j]) / max(len(idx) - 1, 1)
            m /= np.linalg.norm(m, axis=-1, keepdims=True) + 1e-6
            v = sm((A[j] * m).sum(-1))
            b0, p0 = float(np.median(v[:16])), int(pre - 15 + np.argmax(v[-16:]))
            if v[p0] - b0 < ONSET_RISE:
                flat += 1
                continue
            res.append(pre - last_run(v, (b0 + v[p0]) / 2, p0))
        out[k] = {"class_onset": cls_on, "rise": round(rise, 3), "chains": res, "n_flat": flat}
    return out, curves


# ---------------------------------------------------------------- table

def q(a, p):
    return round(float(np.percentile(a, p)), 1) if len(a) else None


def table(cs, lab, prob, kinds, ons):
    rows = []
    total_dmg = sum(sum(d or 0 for d in c["dmg"]) for c in cs)
    for k in sorted(set(lab.tolist())):
        idx = np.where(lab == k)[0]
        mem = [cs[i] for i in idx]
        cc = collections.Counter(c["color"] for c in mem)
        known = {x: cc[x] for x in COLORS if cc[x]}
        nk = sum(known.values())
        maj = max(known, key=known.get) if known else "unknown"
        lens = collections.Counter(len(c["offsets"]) for c in mem)
        mode = lens.most_common(1)[0][0]
        mm = [c for c in mem if len(c["offsets"]) == mode]
        offs = []
        for j in range(mode):
            v = np.array([c["offsets"][j] for c in mm])
            offs.append({"median": q(v, 50), "iqr": round(q(v, 75) - q(v, 25), 1)})
        ty = collections.Counter(t for c in mem for t in c["types"])
        oc = collections.Counter(o for c in mem for o in c["outcomes"])
        dm = [sum(d or 0 for d in c["dmg"]) for c in mem]
        oo = ons.get(k, {})
        on = oo.get("chains", [])
        rows.append({
            "id": int(k), "kind": kinds.get(k, "unknown"), "n": len(idx),
            "color": maj, "color_counts": dict(cc), "color_purity": round(known[maj] / nk, 4) if nk else None,
            "length_counts": {int(a): b for a, b in sorted(lens.items())}, "length_mode": mode,
            "length_mode_share": round(lens[mode] / len(idx), 3),
            "rhythm": offs,
            "onset": {"class": oo.get("class_onset"), "rise": oo.get("rise"), "median": q(on, 50),
                      "q25": q(on, 25), "q75": q(on, 75), "iqr": round(q(on, 75) - q(on, 25), 1) if on else None,
                      "n": len(on), "n_flat": oo.get("n_flat")} if oo else None,
            "rounds": len({cs[i]["round"] for i in idx}),
            "top_round_share": round(collections.Counter(cs[i]["round"] for i in idx).most_common(1)[0][1]
                                     / len(idx), 3),
            "types": dict(ty), "outcomes": dict(oc),
            "ok_rate": round(ty["ok"] / (ty["ok"] + ty["hit_pf"]), 3) if ty["ok"] + ty["hit_pf"] else None,
            "ok_rate_outcome": round(oc["ok"] / (oc["ok"] + oc["pf"]), 3) if oc["ok"] + oc["pf"] else None,
            "hit_rate": round((oc["pf"] + oc["unk"]) / (oc["ok"] + oc["pf"] + oc["unk"]), 3)
            if oc["ok"] + oc["pf"] + oc["unk"] else None,
            "dmg_total": round(sum(dm), 3), "dmg_mean": round(float(np.mean(dm)), 4),
            "dmg_share": round(sum(dm) / total_dmg, 4),
            "members": [int(cs[i]["chain_id"]) for i in idx],
        })
    # 致命招: smallest set of classes (unknown excluded) covering 80 % of all damage
    cl = sorted([r for r in rows if r["id"] >= 0], key=lambda r: -r["dmg_total"])
    acc = 0.0
    for r in cl:
        r["fatal"] = acc < 0.8 * total_dmg
        if r["fatal"]:
            acc += r["dmg_total"]
    for r in rows:
        r.setdefault("fatal", False)
    return rows, total_dmg, acc


def outcome_leak(cs, lab, i_mv):
    """How much the classes follow the player's own result instead of the move: on non-gold move chains in a class,
    NMI(class, first contact ok) and the share of chains in classes (>= 10 such chains) whose first-contact ok rate
    is < 10 % or > 95 %. Some of it is real (moves that cannot be parried); a class pair that differs only in this
    is the symptom (README)."""
    idx = [i for i in i_mv if lab[i] >= 0 and cs[i]["color"] in ("none", "red")]
    lb = np.array([lab[i] for i in idx])
    ok = np.array([cs[i]["outcomes"][0] == "ok" for i in idx])
    ext = 0
    for k in set(lb.tolist()):
        m = lb == k
        if m.sum() >= 10 and (ok[m].mean() < 0.1 or ok[m].mean() > 0.95):
            ext += int(m.sum())
    return {"nmi_first_ok": round(float(normalized_mutual_info_score(lb, ok)), 4),
            "extreme_share": round(ext / len(idx), 3), "n": len(idx)}


# ---------------------------------------------------------------- main

def run_all(X, cs, seed, log, quiet_tag=""):
    mv = np.array([c["kind"] == "move" for c in cs])
    lab = np.full(len(cs), -1)
    prob = np.zeros(len(cs))
    kinds = {}
    i_mv, i_gr = np.where(mv)[0], np.where(~mv)[0]
    l1, p1, P1, _ = pipeline(X[i_mv], [cs[i] for i in i_mv], seed, MCS, log, quiet_tag + "move")
    lab[i_mv], prob[i_mv] = l1, p1
    n1 = l1.max() + 1
    for k in range(n1):
        kinds[k] = "move"
    if len(i_gr) < 3:
        # phase 1 has only a couple of grab ticks; UMAP/PCA need at least 2 points and a candidate plane
        log(f"[{quiet_tag}grab] {len(i_gr)} grab chains: too few to cluster, left unknown")
        lab[i_gr], prob[i_gr] = -1, 0.0
    else:
        l2, p2, _, _ = pipeline(X[i_gr], [cs[i] for i in i_gr], seed, MCS_GRAB, log, quiet_tag + "grab", start=n1)
        lab[i_gr], prob[i_gr] = l2, p2
        for k in set(l2.tolist()) - {-1}:
            kinds[k] = "grab"
    return lab, prob, kinds, P1, i_mv


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-stability", action="store_true")
    ap.add_argument("--post", action="store_true", help="add the post-contact windows (comparison only)")
    ap.add_argument("--out", default=str(MOVES), help="output directory (slices are always read from moves/)")
    a = ap.parse_args()
    global WINS, POST_LAST
    if a.post:
        WINS, POST_LAST = WINS + POST_WINS, True
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    log = Log()
    log(f"s2c_cluster {time.strftime('%Y-%m-%d %H:%M:%S')} params: WINS {WINS} POST_LAST {POST_LAST} RHY_W/J {RHY_W}/{RHY_J} COLOR_W {COLOR_W} PCA {PCA_DIM} UMAP {UMAP_NN}/{UMAP_DIM} "
        f"MCS {MCS}/{MCS_GRAB} COLOR_MAX {COLOR_MAX} RHY w{RHY_MIN_W} n{RHY_MIN_N} bic{RHY_BIC} lengap{RHY_LEN_GAP} "
        f"offgap{RHY_OFF_GAP} sep{RHY_SEP} MERGE off{MERGE_OFF} dist{MERGE_DIST}+{MERGE_STEP}/contact MIN_CLASS {MIN_CLASS}")
    z, S = load()
    cs, pre = S["chains"], S["pre"]
    X = features(z, cs, pre)
    log(f"features {X.shape} ({time.time() - t0:.0f}s)")
    lab, prob, kinds, P1, i_mv = run_all(X, cs, a.seed, log)

    stab = {}
    if not a.no_stability:
        Xm, cm = X[i_mv], [cs[i] for i in i_mv]
        stab["split_half"] = split_half(Xm, cm, a.seed, log)
        stab["seeds"] = {}
        for s in (1, 2, 3):
            ls, _, _, _ = pipeline(Xm, cm, a.seed + s, MCS, log, f"seed{a.seed + s}")
            stab["seeds"][str(a.seed + s)] = ari_pair(lab[i_mv], ls)
        log("stability " + json.dumps(stab))

    ons, curves = onsets(z, cs, lab, pre)
    rows, total, fatal_dmg = table(cs, lab, prob, kinds, ons)
    for r in rows:
        if r["id"] in curves:
            r["consistency_curve"] = [round(float(v), 3) for v in curves[r["id"]][::5]]
    mvrows = [r for r in rows if r["kind"] == "move"]
    cover = sum(r["n"] for r in mvrows) / len(i_mv)
    leak = outcome_leak(cs, lab, i_mv)
    log(f"classes: move {len(mvrows)}, grab {sum(r['kind'] == 'grab' for r in rows)}; move coverage {cover:.3f}; "
        f"outcome leak {leak}")
    write_json(out / "taxonomy.json", {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"), "seed": a.seed,
        "params": {"wins": WINS, "post_last": POST_LAST, "rhythm_feat": [RHY_W, RHY_J], "color_w": COLOR_W, "pca": PCA_DIM, "umap": [UMAP_NN, UMAP_DIM], "mcs": [MCS, MCS_GRAB],
                   "color_max": COLOR_MAX, "rhythm": [RHY_MIN_W, RHY_MIN_N, RHY_BIC, RHY_LEN_GAP, RHY_OFF_GAP,
                                                      RHY_SEP], "merge": [MERGE_OFF, MERGE_DIST, MERGE_STEP],
                   "min_class": MIN_CLASS},
        "notes": {"id": "-1 = unknown (HDBSCAN noise or a class < min_class)",
                  "ok_rate": "contacts by events_ext type: ok / (ok + hit_pf)",
                  "ok_rate_outcome": "by index outcome (flare-type contacts included): ok / (ok + pf)",
                  "hit_rate": "(pf + unk) / (ok + pf + unk) by index outcome, grab ticks excluded",
                  "dmg": "sum of contact dmg over the chain (grab chains include the grab ticks); null = 0",
                  "rhythm": "offsets (frames) of each contact from the first, chains of the modal length",
                  "onset": "frames before the first contact where the move starts (see onsets())",
                  "fatal": "smallest set of classes by total damage covering 80 % of all damage"},
        "total_dmg": round(total, 3), "fatal_dmg": round(fatal_dmg, 3),
        "move_coverage": round(cover, 4), "outcome_leak": leak, "stability": stab, "classes": rows})
    assign = {}
    for i, c in enumerate(cs):
        assign[str(c["chain_id"])] = {"class": int(lab[i]), "conf": round(float(prob[i]), 3), "kind": c["kind"],
                                      "rec": c["rec"], "round": c["round"], "frame0": c["frame0"]}
    write_json(out / "assign.json", assign, indent=None)
    log(f"done {time.time() - t0:.0f}s")
    (out / "log.txt").write_text("\n".join(log.lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
