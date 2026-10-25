"""Order 4: stage the exported student (model/dufu2) for Qualcomm AI Hub: copies of the ONNX files + manifest.json in
the format npu_aihub.py reads, then compile + profile with npu_aihub.py --dir (only these ONNX files are uploaded).

    uv run --no-project --with onnx --with onnxruntime --with numpy python workspaces/WhereWindsMeet/tools/dufu_moveid/s4_aihub.py
    uv run --with qai-hub python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_aihub.py --dir data/moveid/student/aihub \
        --chipset qualcomm-snapdragon-8-elite [--dry-run]
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s4_common import MODEL_OUT, STUDENT  # noqa: E402

DST = STUDENT / "aihub"


def main() -> None:
    import argparse
    import onnx
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, default=MODEL_OUT)
    ap.add_argument("--dst", type=Path, default=DST)
    a = ap.parse_args()
    src_dir, dst = a.src, a.dst
    dst.mkdir(parents=True, exist_ok=True)
    man = {}
    for name in ("glob", "crop", "head"):
        for prec, fn in (("fp32", f"{name}_fp32.onnx"), ("int8", f"{name}.onnx")):
            src = src_dir / fn
            key = f"dufu2_{name}_{prec}"
            shutil.copy(src, dst / f"{key}.onnx")
            m = onnx.load(str(src))
            ins = [{"name": i.name, "shape": [d.dim_value for d in i.type.tensor_type.shape.dim], "type": "float32"}
                   for i in m.graph.input]
            man[key] = {"base": f"dufu2_{name}", "prec": prec, "stream": {"glob": "global", "crop": "crop", "head": "temporal"}[name],
                        "file": f"{key}.onnx", "inputs": ins, "bytes": src.stat().st_size, "source": str(src)}
    (dst / "manifest.json").write_text(json.dumps(man, indent=1), encoding="utf-8")
    print(json.dumps({k: (v["inputs"], v["bytes"]) for k, v in man.items()}, indent=1))


if __name__ == "__main__":
    main()
