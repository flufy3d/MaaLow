"""Order 4: export a trained student (s4_train.py) to ONNX: fp32, int8 (static QDQ, calibrated on real cached frames),
and the QNN version, with the same inputs / outputs everywhere.

    uv run --no-project --with torch --with timm --with numpy --with onnx --with onnxruntime         --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match         python workspaces/WhereWindsMeet/tools/dufu_moveid/s4_export.py --tag final      # -> model/dufu2/
    ... s4_export.py --tag fold0                                                         # -> student/onnx/fold0/

Image inputs are float32 [1, 3, H, W] NCHW BGR holding v / 255 (what infer() feeds with its default mean 0 / std 1:
v * (1 / 255f), s4_common.device_input); the graph multiplies by 255 and normalises (ImageNet) inside. No uint8 / Cast
so the QNN version (README "NPU：QNN 插件": model/<name>.qnn.onnx, the same inputs / outputs as <name>.onnx) is the
same graph. Files (<out>/):
  {glob,crop,head}_fp32.onnx   fp32, opset 17
  {glob,crop,head}.onnx        int8: onnxruntime quantize_static QDQ, S8 per-channel weights, U8 activations; calibrated
                               on CALIB real frames of the training rounds (backbones) and CALIB real 30-step rings
                               built from the fp32 backbones on real consecutive frames + their contact history (head).
                               The CPU version (infer provider "cpu").
  {glob,crop,head}.qnn.onnx    the QNN version (provider "qnn"): --qnn fp32 (default; HTP runs it as fp16) or int8
                               (a copy of the QDQ file). Operators are checked against QNN_OK (no Erf / GELU etc.).
  dufu2.json                   inputs / outputs / preprocessing / labels / version / export checks
--tag foldK calibrates on fold K's training rounds only (the out-of-fold int8 evaluation, s4_eval.py).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s3_common import CACHE, folds, load, read_json, segments  # noqa: E402
from s3b_gate1 import PREFIX  # noqa: E402
from s4_common import (BACKBONE, C_DIM, CS, DILATIONS, G_DIM, GH, GW, MEAN, MODEL_OUT, N_HIST, RF, RING, STD,  # noqa: E402
                       STUDENT, TCN_CH, build, device_input, heads, n_out, open_views, split_views)

OPSET = 17
CALIB = 256
RING_NAMES = ("glob", "big", "small")
# ops seen in AI Hub-compiled graphs of this family (order-1 test: MobileNetV3 + TCN, all on the NPU)
QNN_OK = {"Conv", "Add", "Mul", "Sub", "Div", "Relu", "HardSwish", "HardSigmoid", "GlobalAveragePool", "ReduceMean",
          "Flatten", "Reshape", "Concat", "Gemm", "MatMul", "Transpose", "Slice", "Gather", "Squeeze", "Unsqueeze",
          "QuantizeLinear", "DequantizeLinear", "Identity", "Constant", "Clip", "Sigmoid"}


def load_student(tag: str, G: int, backbone: str | None = None):
    import torch
    m = build(G, pretrained=False, backbone=backbone)
    m.load_state_dict(torch.load(STUDENT / f"{tag}.pt", map_location="cpu"))
    return m.eval()


def export_all(model, out: Path) -> dict[str, Path]:
    """-> {glob, crop, head: <out>/<name>_fp32.onnx}."""
    import torch
    import torch.nn as nn
    out.mkdir(parents=True, exist_ok=True)

    class Img(nn.Module):
        def __init__(s, net):
            super().__init__()
            s.net = net

        def forward(s, x):             # v / 255 -> v (the backbone takes 0..255)
            return s.net(x * 255.0)

    class Head(nn.Module):
        def __init__(s):
            super().__init__()
            s.h = model.head

        def forward(s, g, b, sm):
            return s.h(g, b, sm, last=True)

    files = {}
    with torch.no_grad():
        for name, net, hw in (("glob", model.glob, (GH, GW)), ("crop", model.crop, (CS, CS))):
            x = torch.rand(1, 3, *hw)
            p = out / f"{name}_fp32.onnx"
            torch.onnx.export(Img(net).eval(), x, str(p), opset_version=OPSET, input_names=["image"],
                              output_names=["feat"], dynamo=False)
            files[name] = p
        g = torch.randn(1, RING, G_DIM + N_HIST)
        b = torch.randn(1, RING, C_DIM + 1)
        s = torch.randn(1, RING, C_DIM + 1)
        p = out / "head_fp32.onnx"
        torch.onnx.export(Head().eval(), (g, b, s), str(p), opset_version=OPSET, input_names=list(RING_NAMES),
                          output_names=["logits"], dynamo=False)
        files["head"] = p
    return files


def quantize(src: Path, dst: Path, feeds: list[dict], method: str = "minmax", pct: float = 99.999) -> None:
    from onnxruntime.quantization import (CalibrationDataReader, CalibrationMethod, QuantFormat, QuantType,
                                          quantize_static)
    from onnxruntime.quantization.shape_inference import quant_pre_process

    class R(CalibrationDataReader):
        def __init__(self):
            self.it = iter(feeds)

        def get_next(self):
            return next(self.it, None)

    pre = dst.with_suffix(".pre.onnx")
    quant_pre_process(str(src), str(pre), skip_symbolic_shape=True)
    kw = {} if method == "minmax" else {"calibrate_method": CalibrationMethod.Percentile,
                                        "extra_options": {"CalibPercentile": pct}}
    quantize_static(str(pre), str(dst), R(), quant_format=QuantFormat.QDQ, activation_type=QuantType.QUInt8,
                    weight_type=QuantType.QInt8, per_channel=True, **kw)
    pre.unlink(missing_ok=True)


def calib_data(model, recs: list[dict], seed: int = 0, n: int = CALIB) -> dict[str, list]:
    """CALIB random real frames (views) + CALIB real rings: 30 consecutive cached frames through the fp32 backbones,
    contact history from s3b_train.history at those frames."""
    import torch
    from s3b_train import history
    rng = np.random.default_rng(seed)
    d = load()
    by = {}
    for e in d["events"]:
        by.setdefault(e["rec"], []).append(e["frame"])
    nfr = {r["rec"]: r["frames"] for r in d["recs"]}
    imgs = {"glob": [], "big": [], "small": []}
    rings = []
    picks = rng.choice(len(recs), n, replace=True)
    for i in picks:
        rec = recs[i]
        fr = np.load(CACHE / f"{rec}.npz")["frames"]
        segs = [(a, b) for a, b in segments(fr) if b - a >= RING]
        a, b = segs[rng.integers(len(segs))]
        st = int(rng.integers(a, b - RING + 1))
        mm = open_views(rec, len(fr))
        v = np.asarray(mm[st:st + RING])
        g, bb, s = split_views(v)
        j = int(rng.integers(RING))
        imgs["glob"].append(g[j].transpose(2, 0, 1)[None].copy())
        imgs["big"].append(bb[j].transpose(2, 0, 1)[None].copy())
        imgs["small"].append(s[j].transpose(2, 0, 1)[None].copy())
        h = history(nfr[rec], np.array(sorted(by.get(rec, [])), np.int64))[fr[st:st + RING]]
        with torch.no_grad():
            fg = model.glob(torch.from_numpy(g.transpose(0, 3, 1, 2).copy())).numpy()
            fb = model.crop(torch.from_numpy(bb.transpose(0, 3, 1, 2).copy())).numpy()
            fs = model.crop(torch.from_numpy(s.transpose(0, 3, 1, 2).copy())).numpy()
        z = np.zeros((RING, 1), np.float32)
        rings.append({"glob": np.concatenate([fg, h], 1)[None].astype(np.float32),
                      "big": np.concatenate([fb, z], 1)[None].astype(np.float32),
                      "small": np.concatenate([fs, z], 1)[None].astype(np.float32)})
    return {"imgs": imgs, "rings": rings}


VAL_N, VAL_L = 40, 60


def val_windows(recs: list[str], seed: int = 999) -> list[dict]:
    """VAL_N runs of VAL_L consecutive cached frames of the training rounds (another seed than the calibration
    picks): views + contact history, for comparing the int8 pipeline with fp32 (no labels involved)."""
    from s3b_train import history
    rng = np.random.default_rng(seed)
    d = load()
    by, nfr = {}, {r["rec"]: r["frames"] for r in d["recs"]}
    for e in d["events"]:
        by.setdefault(e["rec"], []).append(e["frame"])
    out = []
    while len(out) < VAL_N:
        rec = recs[int(rng.integers(len(recs)))]
        fr = np.load(CACHE / f"{rec}.npz")["frames"]
        segs = [(a, b) for a, b in segments(fr) if b - a >= VAL_L]
        if not segs:
            continue
        a, b = segs[int(rng.integers(len(segs)))]
        st = int(rng.integers(a, b - VAL_L + 1))
        g, bb, s = split_views(np.asarray(open_views(rec, len(fr))[st:st + VAL_L]))
        h = history(nfr[rec], np.array(sorted(by.get(rec, [])), np.int64))[fr[st:st + VAL_L]]
        out.append({"g": g, "b": bb, "s": s, "h": h})
    return out


def fidelity(fp: dict, q: dict, val: list[dict], G: int) -> dict:
    """int8 vs fp32 through the whole pipeline (backbones per frame, head on the last 30 at each of the last 31
    positions): argmax agreement per head and mean |p diff| of the response head."""
    import onnxruntime as ort

    def sess(p):
        return ort.InferenceSession(str(p), providers=["CPUExecutionProvider"])

    def run(S, w):
        f = {k: np.stack([S["glob" if k == "g" else "crop"].run(None, {"image": device_input(x.transpose(2, 0, 1)[None])})[0][0]
                          for x in w[k]]) for k in ("g", "b", "s")}
        z = np.zeros((VAL_L, 1), np.float32)
        g = np.concatenate([f["g"], w["h"]], 1).astype(np.float32)
        b, s_ = np.concatenate([f["b"], z], 1), np.concatenate([f["s"], z], 1)
        return np.stack([S["head"].run(None, {"glob": g[i - RING + 1:i + 1][None], "big": b[i - RING + 1:i + 1][None],
                                              "small": s_[i - RING + 1:i + 1][None]})[0][0] for i in range(RING - 1, VAL_L)])
    SF, SQ = {n: sess(p) for n, p in fp.items()}, {n: sess(p) for n, p in q.items()}
    A = np.concatenate([run(SF, w) for w in val])
    B = np.concatenate([run(SQ, w) for w in val])
    r = {}
    for nm, a_, e_ in heads(G):
        r[f"{nm}_agree"] = round(float((A[:, a_:e_].argmax(1) == B[:, a_:e_].argmax(1)).mean()), 4)
    pa = np.exp(A[:, heads(G)[2][1]:heads(G)[2][2]]); pa /= pa.sum(1, keepdims=True)
    pb = np.exp(B[:, heads(G)[2][1]:heads(G)[2][2]]); pb /= pb.sum(1, keepdims=True)
    r["resp_mean_abs"] = round(float(np.abs(pa - pb).mean()), 5)
    r["n"] = int(len(A))
    return r


def ops(path: Path) -> list[str]:
    import onnx
    return sorted({n.op_type for n in onnx.load(str(path)).graph.node})


def check(files: dict, model, calib: dict) -> dict:
    """onnxruntime vs torch (fp32) on 16 calibration samples: max |diff| / max |ref| per model."""
    import onnxruntime as ort
    import torch
    res = {}
    for name, p in files.items():
        s = ort.InferenceSession(str(p), providers=["CPUExecutionProvider"])
        diffs = []
        for i in range(16):
            if name == "head":
                feed = calib["rings"][i]
                with torch.no_grad():
                    ref = model.head(*(torch.from_numpy(feed[k]) for k in RING_NAMES), last=True).numpy()
            else:
                x = calib["imgs"]["glob" if name == "glob" else ("big" if i % 2 == 0 else "small")][i]
                feed = {"image": device_input(x)}
                net = model.glob if name == "glob" else model.crop
                with torch.no_grad():
                    ref = net(torch.from_numpy(x)).numpy()
            y = s.run(None, feed)[0]
            diffs.append(float(np.abs(y - ref).max() / max(1e-6, np.abs(ref).max())))
        res[name] = round(max(diffs), 6)
    return res


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()[:16]


def describe(out: Path, G: int, tag: str, prefix: dict, extra: dict) -> dict:
    from s2_views import boxes
    bx = boxes()
    hs = heads(G)
    files = {}
    for p in sorted(out.glob("*.onnx")):
        files[str(p.relative_to(out)).replace("\\", "/")] = {"bytes": p.stat().st_size, "sha256": sha(p), "ops": ops(p)}
    return {
        "name": "dufu2 student (独夫 阶段二 招式识别)",
        "version": time.strftime("%Y%m%d-%H%M"),
        "tag": tag,
        "opset": OPSET,
        "files": files,
        "pipeline": "per frame: glob(screen) -> ring glob; crop(big) -> ring big; crop(small) -> ring small; then head(no image, 3 ring extras)",
        "inputs": {
            "glob": {"model": "glob.onnx", "input": "image float32 [1, 3, 240, 384] NCHW BGR, v / 255", "infer": {
                "roi": list(bx["glob"]), "size": [GW, GH], "color": "bgr", "resize": "area", "mean": 0, "std": 1,
                "history": [{"name": "glob", "aux": "contact history (4)"}]}, "output": f"feat float32 [1, {G_DIM}]"},
            "big": {"model": "crop.onnx", "input": "image float32 [1, 3, 192, 192] NCHW BGR, v / 255", "infer": {
                "roi": list(bx["big"]), "size": [CS, CS], "color": "bgr", "resize": "area", "mean": 0, "std": 1,
                "history": [{"name": "big", "aux": [0]}]}, "output": f"feat float32 [1, {C_DIM}]"},
            "small": {"model": "crop.onnx", "input": "image float32 [1, 3, 192, 192] NCHW BGR, v / 255", "infer": {
                "roi": list(bx["small"]), "size": [CS, CS], "color": "bgr", "resize": "area", "mean": 0, "std": 1,
                "history": [{"name": "small", "aux": [0]}]}, "output": f"feat float32 [1, {C_DIM}]"},
            "head": {"model": "head.onnx", "inputs": {
                "glob": f"float32 [1, {RING}, {G_DIM + N_HIST}] = ring 'glob' (feature + contact history)",
                "big": f"float32 [1, {RING}, {C_DIM + 1}] = ring 'big' (feature + one unused 0)",
                "small": f"float32 [1, {RING}, {C_DIM + 1}] = ring 'small' (feature + one unused 0)"},
                "infer": {"extra": [{"name": n, "dim": [1, RING, (G_DIM + N_HIST) if n == "glob" else C_DIM + 1], "ring": True}
                                    for n in RING_NAMES], "post": "none"},
                "output": f"logits float32 [1, {n_out(G)}]"},
        },
        "screen": "1080x720 capture space; other sizes: s2_views.boxes(w, h)",
        "preprocessing": "s2_views.views(): INTER_AREA (infer resize 'area'), BGR as captured, fed as v / 255 (infer's "
                         "default mean 0 / std 1: v * (1 / 255f)); x 255 and the ImageNet mean / std (on RGB, here "
                         "reversed for BGR) are inside the backbones",
        "frame_rate": "the rings hold one entry per 30 fps frame (the training recordings); the head's receptive "
                      f"field is {RF} frames (TCN, valid dilated convs {DILATIONS}, kernel 3, {TCN_CH} channels)",
        "contact_history": "4 values per frame (s3b_train.history): frames since the last contact known 6 frames "
                           "after it /73 (cap 2; 2 = none), the two gaps before it /73 (cap 2; 2 = none), contacts in a "
                           "row ending at it (gaps <= 73) /4 (cap 2; 0 if the last one is > 73 frames back). No contact "
                           "yet: [2, 2, 2, 0]",
        "outputs": {nm: {"slice": [a, e], "labels": (
            [g["name"] for g in prefix["groups"]] + ["idle"] if nm == "grp" else
            ["gold", "red", "none"] if nm == "col" else ["dodge", "parry", "none"] if nm == "resp" else
            [str(i) for i in range(46)] + ["none (> 45 frames)"])} for nm, a, e in hs},
        "outputs_note": "softmax each slice; grp = prefix group of the next contact (teacher_prefix/prefix.json "
                        "groups) or idle; col = this contact's own light colour; resp = response for the next contact "
                        "(dodge / parry / none = no contact coming); tte = frames to the next contact (point = median)",
        "backbone": f"timm {extra.get('backbone') or BACKBONE} (ImageNet init), stem re-ordered for BGR; stem + blocks -> "
                    "GAP + 1x1->16 spatial -> Linear",
        "mean_rgb": MEAN, "std_rgb": STD,
        "precisions": {"<name>_fp32.onnx": "fp32 reference",
                       "<name>.onnx": "CPU version: int8, onnxruntime quantize_static QDQ, S8 per-channel weights, U8 "
                                      "activations, calibrated on real frames / real rings (see calibration)",
                       "<name>.qnn.onnx": "QNN version (provider qnn), same inputs / outputs"},
        **extra,
    }


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="final")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--no-qnn", action="store_true")
    ap.add_argument("--backbone", default=None, help="timm name (default s4_common.BACKBONE)")
    ap.add_argument("--calib", choices=("minmax", "percentile"), default="minmax")
    ap.add_argument("--pct", type=float, default=99.999)
    ap.add_argument("--calib-n", type=int, default=CALIB)
    ap.add_argument("--select", type=int, default=4, help="candidate calibrations (seeds) to choose from")
    ap.add_argument("--qnn", choices=("fp32", "int8"), default="fp32", help="what <name>.qnn.onnx is")
    a = ap.parse_args()
    out = a.out or (MODEL_OUT if a.tag == "final" else STUDENT / "onnx" / a.tag)
    prefix = read_json(PREFIX / "prefix.json")
    G = len(prefix["groups"])
    model = load_student(a.tag, G, a.backbone)
    d = load()
    fold = folds(d["recs"], d["events"])
    if Path(a.tag).name.startswith("fold"):
        k = int(Path(a.tag).name[4:])
        train = sorted(r for r in fold if fold[r] != k)
    else:
        train = sorted(fold)
    t0 = time.time()
    files = export_all(model, out)
    val = val_windows(train)
    report, best = {}, None
    for seed in range(a.select):          # candidate calibrations (different random real frames); keep the one whose
        calib = calib_data(model, train, seed=seed, n=a.calib_n)   # int8 pipeline agrees best with fp32 on val
        if seed == 0:
            report["fp32_vs_torch"] = check(files, model, calib)
        tmp = out / f"_cand{seed}"
        tmp.mkdir(exist_ok=True)
        for name, p in files.items():
            if name == "head":
                feeds = calib["rings"]
            else:
                xs = calib["imgs"]["glob"] if name == "glob" else calib["imgs"]["big"][::2] + calib["imgs"]["small"][::2]
                feeds = [{"image": device_input(x)} for x in xs]
            quantize(p, tmp / f"{name}.onnx", feeds, a.calib, a.pct)
        sc = fidelity(files, {n: tmp / f"{n}.onnx" for n in files}, val, G)
        report.setdefault("calibration_candidates", {})[seed] = sc
        print(f"calibration seed {seed}: {sc} ({time.time() - t0:.0f}s)", flush=True)
        if best is None or (sc["resp_agree"], -sc["resp_mean_abs"]) > (best[1]["resp_agree"], -best[1]["resp_mean_abs"]):
            best = (seed, sc, calib)
    seed, sc, calib = best
    report["calibration_chosen"] = seed
    q = {}
    for name, p in files.items():
        q[name] = out / f"{name}.onnx"
        shutil.copy(out / f"_cand{seed}" / f"{name}.onnx", q[name])
        if not a.no_qnn:
            shutil.copy(p if a.qnn == "fp32" else q[name], out / f"{name}.qnn.onnx")
    for c in out.glob("_cand*"):
        shutil.rmtree(c)
    report["int8_vs_torch"] = check(q, model, calib)
    bad = {p.name: sorted(set(ops(p)) - QNN_OK) for p in sorted(out.glob("*.onnx"))}
    report["ops_outside_qnn_list"] = {k: v for k, v in bad.items() if v}
    report["qnn_version"] = None if a.no_qnn else a.qnn
    print(report, flush=True)
    info = describe(out, G, a.tag, prefix, {"export_check": report, "train_rounds": len(train),
                                                 "calibration": {"method": a.calib, "percentile": a.pct, "n": a.calib_n,
                                                                 "candidates": a.select, "chosen_seed": seed,
                                                                 "val_windows": VAL_N, "val_len": VAL_L},
                                                 "backbone": a.backbone or BACKBONE})
    (out / "dufu2.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"-> {out} ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
