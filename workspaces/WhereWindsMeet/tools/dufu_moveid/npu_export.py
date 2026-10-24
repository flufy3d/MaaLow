"""Candidate ONNX models for the move-ID speed test (random weights: timing only), fp32 / fp16 / int8.

    uv run --with torch --with torchvision --with timm --index https://download.pytorch.org/whl/cu130 \
        --with onnx --with onnxruntime --with onnxconverter-common \
        python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_export.py [--out data/moveid/npu/models] [--only NAME,...]

Writes <out>/<name>_<prec>.onnx (opset 17, batch fixed) and <out>/manifest.json: per file its inputs (name, shape),
the size, MACs-free summary (params) and which stream it is a candidate for. The existing back9 / head_p2 are copied
as the baselines (fp32; their fp16 / int8 made the same way). int8: onnxruntime static QDQ quantization (U8 activations,
S8 per-channel weights), calibrated on 16 random inputs; --u8 adds <name>_u8 (U8 weights per tensor: onnxruntime's
NNAPI EP rejects int8 initializers). fp16: onnxconverter-common, float32 inputs / outputs kept.

Every model's inputs are float32 so the device benchmark (skills/npu_bench.js) can feed them as infer() `extra`
tensors (no screenshot work in the timing).
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[4]
MODEL_DIR = REPO / "workspaces/WhereWindsMeet/model/dufu"
OPSET = 17


def build(name: str):
    """(torch module, [input shapes], stream) for a candidate."""
    import timm
    import torch
    import torch.nn as nn
    import torchvision.models as tvm

    class Feat(nn.Module):
        """Backbone -> global average pool -> 192-d feature, like back9's output."""

        def __init__(self, body: nn.Module, ch: int, out: int = 192):
            super().__init__()
            self.body, self.pool, self.fc = body, nn.AdaptiveAvgPool2d(1), nn.Linear(ch, out)

        def forward(self, x):
            return self.fc(torch.flatten(self.pool(self.body(x)), 1))

    def mnv3(kind: str, width: float = 1.0, in_ch: int = 3):
        m = (tvm.mobilenet_v3_small if kind == "s" else tvm.mobilenet_v3_large)(width_mult=width)
        if in_ch != 3:
            c0 = m.features[0][0]
            m.features[0][0] = nn.Conv2d(in_ch, c0.out_channels, c0.kernel_size, c0.stride, c0.padding, bias=False)
        return Feat(m.features, m.features[-1].out_channels)

    def effl0():
        m = timm.create_model("efficientnet_lite0", pretrained=False, num_classes=0, global_pool="")
        return Feat(m, m.num_features)

    class Gru(nn.Module):
        def __init__(self, d_in: int, hidden: int, layers: int, out: int = 133):
            super().__init__()
            self.gru = nn.GRU(d_in, hidden, layers, batch_first=True)
            self.fc = nn.Linear(hidden, out)

        def forward(self, x):
            y, _ = self.gru(x)
            return self.fc(y[:, -1])

    class Tcn(nn.Module):
        """Causal dilated 1-D convs over the 30-step window: an NPU-friendly alternative to the GRU."""

        def __init__(self, d_in: int, ch: int = 192, out: int = 133):
            super().__init__()
            layers, c = [], d_in
            for d in (1, 2, 4, 8):
                layers += [nn.Conv1d(c, ch, 3, dilation=d, padding=2 * d), nn.ReLU()]
                c = ch
            self.net, self.fc = nn.Sequential(*layers), nn.Linear(ch, out)

        def forward(self, x):  # [1, 30, d]
            y = self.net(x.transpose(1, 2))
            return self.fc(y[:, :, x.shape[1] - 1])  # the last real step (the padding runs past the end)

    S, G = (192, 192), (240, 384)  # crop H×W, global H×W (384×240 landscape)
    table = {
        # crop stream: the boss crop resized to 192
        "crop_mnv3s": (lambda: mnv3("s"), [(1, 3, *S)], "crop"),
        "crop_mnv3l": (lambda: mnv3("l"), [(1, 3, *S)], "crop"),
        "crop_effl0": (effl0, [(1, 3, *S)], "crop"),
        "crop_mnv3s_b2": (lambda: mnv3("s"), [(2, 3, *S)], "crop x2 (batch)"),
        "crop_mnv3s_6ch": (lambda: mnv3("s", in_ch=6), [(1, 6, *S)], "crop x2 (6 channels)"),
        # global stream: the whole 1080×720 frame at 384×240
        "glob_mnv3s": (lambda: mnv3("s"), [(1, 3, *G)], "global"),
        "glob_mnv3s050": (lambda: mnv3("s", 0.5), [(1, 3, *G)], "global"),
        # temporal heads: 30 steps of global 192 + crop 192 (+ 15 aux)
        "head_gru128x2": (lambda: Gru(399, 128, 2), [(1, 30, 399)], "temporal"),
        "head_gru256x2": (lambda: Gru(399, 256, 2), [(1, 30, 399)], "temporal"),
        "head_tcn192": (lambda: Tcn(399), [(1, 30, 399)], "temporal"),
        # floor: what a call costs with almost no compute (same input size as the crop / global streams)
        "null_192": (lambda: nn.AdaptiveAvgPool2d(1), [(1, 3, *S)], "overhead"),
        "null_384": (lambda: nn.AdaptiveAvgPool2d(1), [(1, 3, *G)], "overhead"),
    }
    return table if name == "*" else table[name]


def export_torch(name: str, path: Path):
    import torch

    torch.manual_seed(0)
    make, shapes, stream = build(name)
    m = make().eval()
    xs = tuple(torch.randn(*s) for s in shapes)
    names = ["x"] if len(xs) == 1 else [f"x{i}" for i in range(len(xs))]
    with torch.no_grad():
        torch.onnx.export(m, xs if len(xs) > 1 else xs[0], str(path), opset_version=OPSET, input_names=names,
                          output_names=["y"], dynamo=False)
    return stream


def to_fp16(src: Path, dst: Path):
    import onnx
    from onnxconverter_common import float16

    m = float16.convert_float_to_float16(onnx.load(str(src)), keep_io_types=True)
    onnx.save(m, str(dst))


def to_int8(src: Path, dst: Path, u8: bool = False):
    import onnxruntime as ort
    from onnxruntime.quantization import CalibrationDataReader, QuantFormat, QuantType, quantize_static
    from onnxruntime.quantization.shape_inference import quant_pre_process

    ins = [(i.name, i.shape) for i in ort.InferenceSession(str(src), providers=["CPUExecutionProvider"]).get_inputs()]

    class Rand(CalibrationDataReader):
        def __init__(self):
            rng = np.random.default_rng(0)
            self.it = iter([{n: rng.standard_normal(s).astype(np.float32) for n, s in ins} for _ in range(16)])

        def get_next(self):
            return next(self.it, None)

    pre = dst.with_suffix(".pre.onnx")
    try:
        quant_pre_process(str(src), str(pre), skip_symbolic_shape=True)
    except Exception as e:  # noqa: BLE001 - pre-processing is optional
        print(f"  pre-process skipped: {e}")
        shutil.copy(src, pre)
    # u8: uint8 weights per tensor, the only QDQ form onnxruntime's NNAPI EP takes (it rejects int8 initializers)
    quantize_static(str(pre), str(dst), Rand(), quant_format=QuantFormat.QDQ, activation_type=QuantType.QUInt8,
                    weight_type=QuantType.QUInt8 if u8 else QuantType.QInt8, per_channel=not u8)
    pre.unlink(missing_ok=True)


def describe(path: Path) -> dict:
    import onnx
    import onnxruntime as ort

    s = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    m = onnx.load(str(path))
    ops = sorted({n.op_type for n in m.graph.node})
    feeds = {i.name: np.random.default_rng(0).standard_normal(i.shape).astype(np.float32) for i in s.get_inputs()}
    out = s.run(None, feeds)[0]
    return {
        "inputs": [{"name": i.name, "shape": i.shape, "type": i.type} for i in s.get_inputs()],
        "output": list(out.shape),
        "bytes": path.stat().st_size,
        "opset": next((o.version for o in m.opset_import if o.domain in ("", "ai.onnx")), None),
        "ops": ops,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=REPO / "data/moveid/npu/models")
    ap.add_argument("--only", help="comma-separated base names")
    ap.add_argument("--no-fp16", action="store_true")
    ap.add_argument("--no-int8", action="store_true")
    ap.add_argument("--u8", action="store_true", help="also <name>_u8.onnx: uint8 weights per tensor (for NNAPI)")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    only = set(a.only.split(",")) if a.only else None

    bases: dict[str, str] = {}  # base name -> stream
    for name, stream in (("back9", "baseline (current backbone, 96x96)"), ("head_p2", "baseline (current GRU head)")):
        if only and name not in only:
            continue
        shutil.copy(MODEL_DIR / f"unified_{name}.onnx", a.out / f"{name}_fp32.onnx")
        bases[name] = stream
    for name in build("*"):
        if only and name not in only:
            continue
        print(f"export {name}")
        bases[name] = export_torch(name, a.out / f"{name}_fp32.onnx")

    manifest_path = a.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    for name, stream in bases.items():
        src = a.out / f"{name}_fp32.onnx"
        files = {"fp32": src}
        if not a.no_fp16 and not name.startswith("null_"):
            try:
                to_fp16(src, a.out / f"{name}_fp16.onnx")
                files["fp16"] = a.out / f"{name}_fp16.onnx"
            except Exception as e:  # noqa: BLE001
                print(f"  {name} fp16 failed: {e}")
        if not a.no_int8 and not name.startswith("null_"):
            try:
                to_int8(src, a.out / f"{name}_int8.onnx")
                files["int8"] = a.out / f"{name}_int8.onnx"
            except Exception as e:  # noqa: BLE001
                print(f"  {name} int8 failed: {e}")
        if a.u8 and not name.startswith("null_"):
            try:
                to_int8(src, a.out / f"{name}_u8.onnx", u8=True)
                files["u8"] = a.out / f"{name}_u8.onnx"
            except Exception as e:  # noqa: BLE001
                print(f"  {name} u8 failed: {e}")
        for prec, f in files.items():
            d = describe(f)
            manifest[f.stem] = {"base": name, "prec": prec, "stream": stream, "file": f.name, **d}
            print(f"  {f.name}: {d['inputs'][0]['shape']} -> {d['output']}, {d['bytes'] / 1e6:.2f} MB")
    manifest_path.write_text(json.dumps(manifest, indent=1))
    print(f"{len(manifest)} models in {manifest_path}")


if __name__ == "__main__":
    main()
