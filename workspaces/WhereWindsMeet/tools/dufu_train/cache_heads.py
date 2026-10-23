"""Run a head (PyTorch port, GPU if any) over every row of every round and cache its logits for replay.py.

    uv run --with torch --index https://download.pytorch.org/whl/cu130 --with onnx --with onnxruntime \
        python workspaces/WhereWindsMeet/tools/dufu_train/cache_heads.py data/p2 [unified_head_p2]

-> data/tmp/p2policy/heads/<head>/rNNN.npy, (N, 133) float32, nan before MIN_RING (same windows as the device; the
port matches onnxruntime to ~5e-3 on the logits). Only heads with the head9s architecture (not p2e: its lead1f comes
from train_press.py's out-of-fold run).
"""
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from data import MIN_RING, scan, steps, window_index  # noqa: E402
from model import load_onnx  # noqa: E402

WS = Path(__file__).resolve().parents[2]
REPO = WS.parents[1]


def main():
    root = sys.argv[1]
    head = sys.argv[2] if len(sys.argv) > 2 else "unified_head_p2"
    out = REPO / "data" / "tmp" / "p2policy" / "heads" / head
    out.mkdir(parents=True, exist_ok=True)
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    m = load_onnx(WS / "model" / "dufu" / f"{head}.onnx").to(dev).eval()
    t0 = time.time()
    for r in scan(root):
        st = torch.as_tensor(steps(r), device=dev)
        w = torch.as_tensor(window_index(r.n), device=dev)
        o = np.full((r.n, 133), np.nan, np.float32)
        with torch.no_grad():
            for i in range(MIN_RING - 1, r.n, 4096):
                j = min(i + 4096, r.n)
                o[i:j] = m(st[w[i:j]]).cpu().numpy()
        np.save(out / f"{r.name}.npy", o)
        print(r.name, r.n, f"{time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
