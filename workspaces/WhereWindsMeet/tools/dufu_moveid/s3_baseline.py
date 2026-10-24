"""Order 3 baseline for gate 1: the stored order-2 CLS embeddings (emb/<rec>.npz) with a linear classifier and with
nearest class centres, the same 5 folds and output format as the teacher (s3_gate1.py).

    uv run --no-project --with torch --with numpy --index https://download.pytorch.org/whl/cu130 \
        --index-strategy unsafe-best-match python workspaces/WhereWindsMeet/tools/dufu_moveid/s3_baseline.py

Feature at frame t (causal; the clustering representation, but ending at t instead of at first contact - 11):
  per view (glob / big / small) the mean CLS over [t-49, t-30], [t-29, t-10], [t-9, t] (frames < 0 clamped to 0)
  minus the mean CLS of the recording's frames 0..t (causal stand-in for the clustering's per-recording mean),
  each L2-normalised -> 3 x 3 x 384 = 3456 dims.
Training positions: every 2nd labelled frame of the teacher's training set (s3_common.frame_plan, full 32-frame
history, class / colour / tte labels from s3_common.frame_labels).
  linear: one linear layer, three softmax heads (45 classes, 3 colours, 47 tte bins), AdamW lr 1e-3 wd 1e-4,
          20 epochs, batch 4096 (fixed, not tuned on the test folds).
  ncc:    class = nearest class centre (cosine, centres = mean training feature per class incl. unknown / idle);
          colour = nearest colour centre; no tte head.
Out: data/moveid/teacher/baseline/oof_linear.npz, oof_ncc.npz.
"""
from __future__ import annotations

import collections
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s3_common import (N_CLASS, N_FOLDS, N_TTE, OUT, STORE_OFFS, T_HIST, TEACHER, folds, frame_labels,  # noqa: E402
                       frame_plan, load, write_json)

WINS = ((-49, -30), (-29, -10), (-9, 0))
VIEWS = ("glob", "big", "small")
BASE = TEACHER / "baseline"


def rec_features(rec: str):
    """-> function(frames array) -> [len, 3456] float16 features."""
    z = np.load(OUT / "emb" / f"{rec}.npz")
    E = np.stack([z[v].astype(np.float32) for v in VIEWS], 1)          # [n, 3, 384]
    cs = np.concatenate([np.zeros((1, 3, E.shape[2]), np.float32), np.cumsum(E, 0)])   # cs[i] = sum E[:i]
    n = len(E)

    def feat(t: np.ndarray) -> np.ndarray:
        t = np.asarray(t)
        mean_run = cs[t + 1] / (t + 1)[:, None, None]
        parts = []
        for a, b in WINS:
            lo = np.clip(t + a, 0, n - 1)
            hi = np.clip(t + b, 0, n - 1)
            w = (cs[hi + 1] - cs[lo]) / (hi - lo + 1)[:, None, None] - mean_run
            w /= np.linalg.norm(w, axis=2, keepdims=True) + 1e-6
            parts.append(w)
        return np.concatenate(parts, 1).reshape(len(t), -1).astype(np.float16)
    return feat


def main() -> None:
    import torch
    t0 = time.time()
    d = load()
    fold = folds(d["recs"], d["events"])
    byrec = collections.defaultdict(list)
    for e in d["events"]:
        byrec[e["rec"]].append(e)
    X, Y, F = [], [], []
    QX, qid = [], []
    for r in d["recs"]:
        cs = byrec.get(r["rec"], [])
        feat = rec_features(r["rec"])
        lab = frame_labels(r["frames"], cs)
        fr = frame_plan(r["frames"], cs)
        # training positions: planned frames whose 31 predecessors are also planned (full history), every 2nd
        ok = np.zeros(r["frames"], bool)
        ok[fr] = True
        hist = np.convolve(ok.astype(int), np.ones(T_HIST, int))[:r["frames"]] == T_HIST
        pos = np.nonzero(hist & ((lab["cls"] >= 0) | (lab["tte"] >= 0)))[0][::2]
        X.append(feat(pos))
        Y.append(np.stack([lab["cls"][pos], lab["col"][pos], lab["tte"][pos]], 1).astype(np.int64))
        F.append(np.full(len(pos), fold[r["rec"]]))
        for e in cs:
            t = np.clip(e["frame"] + np.array(STORE_OFFS), 0, r["frames"] - 1)
            QX.append(feat(t))
            qid.append(e["id"])
    X, Y, F = np.concatenate(X), np.concatenate(Y), np.concatenate(F)
    QX = np.stack(QX)                                        # [n_contacts, 31, D]
    qid = np.array(qid)
    rec_of = {e["id"]: e["rec"] for e in d["events"]}
    qfold = np.array([fold[rec_of[i]] for i in qid])
    print(f"features: train {X.shape}, query {QX.shape}, {time.time() - t0:.0f}s", flush=True)
    dev = "cuda"
    D = X.shape[1]
    n, no = len(qid), len(STORE_OFFS)
    lin = {"p_cls": np.zeros((n, no, N_CLASS), np.float16), "p_col": np.zeros((n, no, 3), np.float16),
           "p_tte": np.zeros((n, no, N_TTE), np.float16)}
    ncc = {"p_cls": np.zeros((n, no, N_CLASS), np.float16), "p_col": np.zeros((n, no, 3), np.float16)}
    log = {}
    for k in range(N_FOLDS):
        tr = F != k
        xt = torch.tensor(X[tr], device=dev).float()
        yt = torch.tensor(Y[tr], device=dev)
        torch.manual_seed(k)
        model = torch.nn.Linear(D, N_CLASS + 3 + N_TTE).to(dev)
        opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
        ce = torch.nn.CrossEntropyLoss(ignore_index=-100)
        for ep in range(20):
            perm = torch.randperm(len(xt), device=dev)
            tot = 0.0
            for i in range(0, len(perm), 4096):
                b = perm[i:i + 4096]
                o = model(xt[b])
                loss = (ce(o[:, :N_CLASS], yt[b, 0]) + ce(o[:, N_CLASS:N_CLASS + 3], yt[b, 1])
                        + 0.5 * ce(o[:, N_CLASS + 3:], yt[b, 2]))
                opt.zero_grad()
                loss.backward()
                opt.step()
                tot += loss.item() * len(b)
        te = qfold == k
        q = torch.tensor(QX[te].reshape(-1, D), device=dev).float()
        with torch.no_grad():
            o = model(q)
            lin["p_cls"][te] = torch.softmax(o[:, :N_CLASS], 1).reshape(-1, no, N_CLASS).cpu().numpy()
            lin["p_col"][te] = torch.softmax(o[:, N_CLASS:N_CLASS + 3], 1).reshape(-1, no, 3).cpu().numpy()
            lin["p_tte"][te] = torch.softmax(o[:, N_CLASS + 3:], 1).reshape(-1, no, N_TTE).cpu().numpy()
            xn = torch.nn.functional.normalize(xt, dim=1)
            qn = torch.nn.functional.normalize(q, dim=1)
            for key, col, nk in (("p_cls", 0, N_CLASS), ("p_col", 1, 3)):
                cen = torch.zeros(nk, D, device=dev)
                m = yt[:, col] >= 0
                cen.index_add_(0, yt[m, col], xn[m])
                cen = torch.nn.functional.normalize(cen, dim=1)
                present = torch.zeros(nk, dtype=torch.bool, device=dev)
                present[yt[m, col].unique()] = True
                sim = qn @ cen.T
                sim[:, ~present] = -9
                ncc[key][te] = torch.nn.functional.one_hot(sim.argmax(1), nk).reshape(-1, no, nk).cpu().numpy()
        log[k] = {"train": int(tr.sum()), "final_loss": round(tot / len(perm), 4), "test_contacts": int(te.sum())}
        print(k, log[k], flush=True)
        del xt, yt
    BASE.mkdir(parents=True, exist_ok=True)
    common = {"ids": qid, "offs": np.array(STORE_OFFS), "valid": np.ones((n, no), bool), "fold": qfold}
    np.savez_compressed(BASE / "oof_linear.npz", **common, **lin)
    np.savez_compressed(BASE / "oof_ncc.npz", **common, **ncc)
    write_json(BASE / "log.json", {"folds": log, "sec": round(time.time() - t0, 1), "train_positions": int(len(X))})
    print(f"done {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
