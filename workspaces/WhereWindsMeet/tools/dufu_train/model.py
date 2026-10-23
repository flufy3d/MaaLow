"""PyTorch port of the dufu head (unified_head9s.onnx): 2-layer GRU (hidden 128) over seq [B, 30, 207], heads on the
last step. Weights load straight from the ONNX initializers; export writes the same graph IO (seq -> out, opset 17).

ONNX GRU gate order is (z, r, h), torch's is (r, z, n); B = [Wb | Rb] per layer, linear_before_reset = 1 as in torch.
land = MLP over [h_last | seq[:, -1, 192:]] (the current step's 15 aux).
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from torch import nn

H = 128
# (name, out) in output order; combo is Linear(128,256)-ReLU-Linear(256,16), land Linear(143,64)-ReLU-Linear(64,2)
SLICES = [("combo", 16), ("stage", 6), ("fut1", 11), ("fut2", 11), ("fut3", 11), ("def1", 5), ("def2", 5), ("def3", 5),
          ("tell", 7), ("fut1f", 46), ("ours", 6), ("cont", 2), ("land", 2)]
OFF = {}
_o = 0
for _n, _k in SLICES:
    OFF[_n] = (_o, _o + _k)
    _o += _k
OUT = _o  # 133


class Head(nn.Module):
    def __init__(self, din: int = 207, hidden: int = H):
        super().__init__()
        self.gru = nn.GRU(din, hidden, num_layers=2, batch_first=True)
        self.h = nn.ModuleDict()
        for name, k in SLICES:
            if name == "combo":
                self.h[name] = nn.Sequential(nn.Linear(hidden, 256), nn.ReLU(), nn.Linear(256, k))
            elif name == "land":
                self.h[name] = nn.Sequential(nn.Linear(hidden + 15, 64), nn.ReLU(), nn.Linear(64, k))
            else:
                self.h[name] = nn.Linear(hidden, k)

    def forward(self, seq: torch.Tensor) -> torch.Tensor:
        y, _ = self.gru(seq)
        last = y[:, -1]
        outs = []
        for name, _ in SLICES:
            x = torch.cat([last, seq[:, -1, 192:]], 1) if name == "land" else last
            outs.append(self.h[name](x))
        return torch.cat(outs, 1)


def _zrh_to_rzn(w: np.ndarray) -> np.ndarray:
    z, r, h = np.split(w, 3, axis=0)
    return np.concatenate([r, z, h], axis=0)


def load_onnx(path: str | Path) -> Head:
    import onnx
    from onnx import numpy_helper

    m = onnx.load(str(path))
    init = {t.name: numpy_helper.to_array(t) for t in m.graph.initializer}
    grus = [n for n in m.graph.node if n.op_type == "GRU"]
    assert len(grus) == 2, "expected a 2-layer GRU"
    model = Head()
    sd = {}
    for layer, node in enumerate(grus):
        W, R, B = (init[node.input[i]] for i in (1, 2, 3))
        sd[f"gru.weight_ih_l{layer}"] = _zrh_to_rzn(W[0])
        sd[f"gru.weight_hh_l{layer}"] = _zrh_to_rzn(R[0])
        sd[f"gru.bias_ih_l{layer}"] = _zrh_to_rzn(B[0][: 3 * H])
        sd[f"gru.bias_hh_l{layer}"] = _zrh_to_rzn(B[0][3 * H:])
    for k, v in init.items():
        if k.startswith("h."):
            sd[k] = v  # h.combo.0.weight ... same names as the ModuleDict
    sd = {k: torch.from_numpy(np.ascontiguousarray(v)).float() for k, v in sd.items()}
    missing = model.load_state_dict(sd, strict=True)
    assert not missing.missing_keys and not missing.unexpected_keys
    return model


def export_onnx(model: Head, path: str | Path) -> None:
    """seq [1,30,207] float32 -> out [1,133], opset 17, the TorchScript exporter (the same op set as head9s: GRU,
    Gemm, Concat ...)."""
    model = model.cpu().eval()
    x = torch.zeros(1, 30, 207)
    torch.onnx.export(model, (x,), str(path), input_names=["seq"], output_names=["out"], opset_version=17,
                      dynamo=False, do_constant_folding=True)
