"""Order 4: out-of-fold outputs of the exported student ONNX (fp32 / int8) through onnxruntime on the CPU, the way the
Pad runs them (batch 1, the three backbones per frame, the head on a 30-step ring), and fp32 vs int8 output diffs.

    uv run --no-project --with numpy --with onnxruntime python workspaces/WhereWindsMeet/tools/dufu_moveid/s4_eval.py \
        [--folds 0,1,2,3,4] [--prec fp32,int8] [--procs 8]
    then: uv run --no-project --with numpy python workspaces/WhereWindsMeet/tools/dufu_moveid/s3b_gate1.py \
        --out data/moveid/student/gate1 --pred teacher=data/moveid/teacher_prefix/oof.npz \
        --pred student_fp32=data/moveid/student/oof.npz --pred student_onnx_int8=data/moveid/student/oof_onnx_int8.npz

Fold k uses student/onnx/fold<k>/ (s4_export.py --tag fold<k>: int8 calibrated on fold k's training rounds only) on
fold k's test rounds. Every cached frame of a test round: device_input(view) -> glob / crop (big, small) -> features;
the head at a frame gets the ring of the last 30 frames of its segment of consecutive cached frames, front-padded with
the segment's first frame (the device ring after a reset); the contact history aux = s3b_train.history at that frame.
Outputs at every contact's offsets -30..0 -> student/oof_onnx_<prec>_fold<k>.npz (s3b_gate1 format) and, when all five
folds are there, oof_onnx_<prec>.npz. diff_fold<k>.json: per head, int8 vs fp32 max |p diff| / argmax agreement over
those rows, and ONNX fp32 vs the torch OOF (student/oof_fold<k>.npz).
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s3_common import CACHE, N_FOLDS, STORE_OFFS, folds, load, read_json, segments  # noqa: E402
from s3b_gate1 import PREFIX  # noqa: E402
from s4_common import RING, STUDENT, device_input, heads, n_out, no_throttle, open_views, split_views  # noqa: E402

FILES = {"fp32": "{n}_fp32.onnx", "int8": "{n}.onnx"}


def _sess(path: Path):
    import onnxruntime as ort
    o = ort.SessionOptions()
    o.intra_op_num_threads = 1
    o.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), o, providers=["CPUExecutionProvider"])


def features(rec: str, d: str, prec: str) -> dict:
    """All cached frames of one recording through glob / crop: {glob [n, G+4 later], big, small}."""
    no_throttle()
    sg = _sess(Path(d) / FILES[prec].format(n="glob"))
    sc = _sess(Path(d) / FILES[prec].format(n="crop"))
    fr = np.load(CACHE / f"{rec}.npz")["frames"]
    mm = open_views(rec, len(fr))
    out = {"glob": [], "big": [], "small": []}
    for i0 in range(0, len(fr), 256):
        g, b, s = split_views(np.asarray(mm[i0:i0 + 256]))
        for j in range(len(g)):
            out["glob"].append(sg.run(None, {"image": device_input(g[j].transpose(2, 0, 1)[None])})[0][0])
            out["big"].append(sc.run(None, {"image": device_input(b[j].transpose(2, 0, 1)[None])})[0][0])
            out["small"].append(sc.run(None, {"image": device_input(s[j].transpose(2, 0, 1)[None])})[0][0])
    return {k: np.stack(v).astype(np.float32) for k, v in out.items()}


def ring(x: np.ndarray, seg_start: int, i: int) -> np.ndarray:
    """[RING, D] = rows i-29..i of x, not before seg_start; front-padded with x[seg_start] (the oldest entry)."""
    lo = max(seg_start, i - RING + 1)
    r = x[lo:i + 1]
    if len(r) < RING:
        r = np.concatenate([np.repeat(r[:1], RING - len(r), 0), r])
    return r


def main() -> None:
    from s3b_train import history
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--folds", default="0,1,2,3,4")
    ap.add_argument("--prec", default="fp32,int8")
    ap.add_argument("--procs", type=int, default=8)
    ap.add_argument("--src", default="", help="onnx dir per fold, {k} = fold (default student/onnx/fold{k})")
    ap.add_argument("--tag", default="", help="suffix of the output names (oof_onnx<tag>_<prec>_fold<k>.npz)")
    a = ap.parse_args()
    no_throttle()
    d = load()
    prefix = read_json(PREFIX / "prefix.json")
    G = len(prefix["groups"])
    hs = heads(G)
    fold = folds(d["recs"], d["events"])
    nfr = {r["rec"]: r["frames"] for r in d["recs"]}
    byrec = collections.defaultdict(list)
    for e in d["events"]:
        byrec[e["rec"]].append(e)
    precs = a.prec.split(",")
    for k in [int(x) for x in a.folds.split(",")]:
        odir = Path(a.src.format(k=k)) if a.src else STUDENT / "onnx" / f"fold{k}"
        test = sorted(r for r in fold if fold[r] == k)
        P = {}
        for prec in precs:
            t0 = time.time()
            with ProcessPoolExecutor(a.procs) as ex:
                feats = dict(zip(test, ex.map(features, test, [str(odir)] * len(test), [prec] * len(test))))
            tf = time.time() - t0
            sh = _sess(odir / FILES[prec].format(n="head"))
            ids, rows = [], []
            for r in test:
                fr = np.load(CACHE / f"{r}.npz")["frames"]
                row_of = {int(x): i for i, x in enumerate(fr)}
                seg_of = np.zeros(len(fr), np.int64)
                for s0, e0 in segments(fr):
                    seg_of[s0:e0] = s0
                cf = np.array([e["frame"] for e in byrec[r]], np.int64)
                hist = history(nfr[r], cf)[fr]
                F = feats[r]
                g = np.concatenate([F["glob"], hist], 1).astype(np.float32)
                z = np.zeros((len(fr), 1), np.float32)
                b = np.concatenate([F["big"], z], 1)
                s = np.concatenate([F["small"], z], 1)
                cache = {}
                for e in byrec[r]:
                    p = np.full((len(STORE_OFFS), n_out(G)), np.nan, np.float32)
                    for j, o in enumerate(STORE_OFFS):
                        i = row_of.get(e["frame"] + o, -1)
                        if i < 0:
                            continue
                        if i not in cache:
                            st = int(seg_of[i])
                            y = sh.run(None, {"glob": ring(g, st, i)[None], "big": ring(b, st, i)[None],
                                              "small": ring(s, st, i)[None]})[0][0]
                            cache[i] = np.concatenate([np.exp(y[a_:e_] - y[a_:e_].max()) / np.exp(y[a_:e_] - y[a_:e_].max()).sum()
                                                       for _, a_, e_ in hs])
                        p[j] = cache[i]
                    ids.append(e["id"])
                    rows.append(p)
            Pk = np.stack(rows)
            P[prec] = Pk
            from s4_train import save_oof
            save_oof(STUDENT / f"oof_onnx{a.tag}_{prec}_fold{k}.npz", ids, Pk.astype(np.float16), G, k)
            print(f"fold {k} {prec}: {len(test)} rounds, features {tf:.0f}s, total {time.time() - t0:.0f}s", flush=True)
        # diffs
        rep = {}
        V = ~np.isnan(next(iter(P.values()))[..., 0])
        torch_p = STUDENT / f"oof_fold{k}.npz" if not a.tag else Path("-")
        cmp = {}
        if "fp32" in P and "int8" in P:
            cmp["int8_vs_fp32"] = (P["int8"], P["fp32"])
        if "fp32" in P and torch_p.exists():
            z = np.load(torch_p)
            T = np.concatenate([z["p_grp"], z["p_col"], z["p_resp"], z["p_tte"]], -1).astype(np.float32)
            cmp["onnx_fp32_vs_torch"] = (P["fp32"], T)
        for name, (A, B) in cmp.items():
            r_ = {}
            for nm, a_, e_ in hs:
                x, y = A[V][:, a_:e_], B[V][:, a_:e_]
                r_[nm] = {"max_abs": round(float(np.abs(x - y).max()), 5), "mean_abs": round(float(np.abs(x - y).mean()), 6),
                          "argmax_agree": round(float((x.argmax(-1) == y.argmax(-1)).mean()), 5), "rows": int(V.sum())}
            rep[name] = r_
        (STUDENT / f"diff{a.tag}_fold{k}.json").write_text(json.dumps(rep, indent=1), encoding="utf-8")
        print(json.dumps(rep), flush=True)
    from s4_train import merge_oof
    for prec in precs:
        if all((STUDENT / f"oof_onnx{a.tag}_{prec}_fold{k}.npz").exists() for k in range(N_FOLDS)):
            merge_oof(str(STUDENT / ("oof_onnx" + a.tag + "_" + prec + "_fold{k}.npz")), STUDENT / f"oof_onnx{a.tag}_{prec}.npz")
            print("merged", prec)


if __name__ == "__main__":
    main()
