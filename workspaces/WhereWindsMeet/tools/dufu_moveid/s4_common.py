"""Order 4 (student): shared paths, the view cache layout, labels and the student network.

Runtime shape (what infer() on the Pad can run today, README "顺序 4"):
  per frame   glob.onnx   whole screen -> 384x240 (s2_views glob)  -> feature G_DIM, appended to ring "g" with the
                          contact history (4, s3b_train.history) as the ring entry's aux
              crop.onnx   big  crop 530 -> 192 (s2_views big)      -> feature C_DIM, ring "b" (aux: one 0)
              crop.onnx   small crop 260 -> 192 (s2_views small)   -> feature C_DIM, ring "s" (aux: one 0)
              (one crop model, two calls: the weights are shared, the head knows which ring is which)
  head.onnx   no image; the three rings as [1, 30, step] extras -> one vector of logits:
              [prefix group G+1 | colour 3 | response 3 | tte 47]  (s3b_train's heads, same order)
Image inputs (exported) are float32 NCHW BGR holding v / 255 (infer(..., color: "bgr") with the default mean 0 /
std 1; device_input()); the exported graph multiplies by 255 and normalises inside. Training feeds uint8 0..255.
The head is a TCN of valid (unpadded) dilated causal convs with a receptive field of RF = 29 <= 30 frames, so its
output at the ring's last step equals the training-time output at a chunk position with >= RF - 1 frames before it.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from common import PHASE  # noqa: E402
from s3_common import (COLOR_IX, MOVE_PRE, N_TTE, OUT, frame_labels, read_json, write_json)  # noqa: E402,F401

STUDENT = OUT / "student"
VIEWS = STUDENT / "views"
SOFT = STUDENT / "soft"
REPO = HERE.parents[3]
MODEL_OUT = REPO / "workspaces" / "WhereWindsMeet" / "model" / ("dufu2" if PHASE == 2 else f"dufu{PHASE}")

GH, GW = 240, 384
CS = 192
GLOB_B = GH * GW * 3
CROP_B = CS * CS * 3
VBYTES = GLOB_B + 2 * CROP_B          # one cached frame: glob, big, small (HWC uint8 BGR each, s2_views order)

G_DIM, C_DIM = 128, 96                # per-frame features in the rings
N_HIST = 4                            # contact history (s3b_train.history)
RING = 30
DILATIONS = (1, 2, 4, 7)              # kernel 3: RF = 1 + 2 * sum = 29
RF = 1 + 2 * sum(DILATIONS)
TCN_CH = 192
RESP_IX = {"dodge": 0, "parry": 1}
WIDTH = None                          # G + 1 + 3 + 3 + N_TTE, set by n_out()
BACKBONE = "mobilenetv4_conv_small_050.e3000_r224_in1k"   # quantises well (MobileNetV3-S int8 PTQ broke, README)
MEAN = (0.485, 0.456, 0.406)          # ImageNet, RGB
STD = (0.229, 0.224, 0.225)


def no_throttle() -> None:
    """Windows: this process at normal priority and without EcoQoS power throttling (started from a background shell
    the workers got below-normal priority + EcoQoS and were parked on the efficiency cores at ~1/8 speed)."""
    if sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes

    class PPT(ctypes.Structure):
        _fields_ = [("Version", wintypes.ULONG), ("ControlMask", wintypes.ULONG), ("StateMask", wintypes.ULONG)]

    k = ctypes.windll.kernel32
    h = k.GetCurrentProcess()
    k.SetPriorityClass(h, 0x20)                      # NORMAL_PRIORITY_CLASS
    s = PPT(1, 0x1, 0x0)                             # EXECUTION_SPEED controlled, state off = not throttled
    k.SetProcessInformation(h, 4, ctypes.byref(s), ctypes.sizeof(s))   # ProcessPowerThrottling


def n_out(G: int) -> int:
    return G + 1 + 3 + 3 + N_TTE


def heads(G: int) -> list[tuple[str, int, int]]:
    """(name, start, end) of each head in the output vector."""
    s1, s2, s3 = G + 1, G + 4, G + 7
    return [("grp", 0, s1), ("col", s1, s2), ("resp", s2, s3), ("tte", s3, s3 + N_TTE)]


def device_input(x: np.ndarray) -> np.ndarray:
    """uint8 image (any shape) -> what infer() feeds a float32 image input with mean 0 / std 1: v * (1 / 255f)
    (nn_jni.cpp image_input: scale = 1.f / (255.f * std), bias = -mean / std)."""
    return x.astype(np.float32) * np.float32(1.0 / 255.0) + np.float32(-0.0)


def view_file(rec: str) -> Path:
    return VIEWS / f"{rec}.u8"


def open_views(rec: str, n: int) -> np.memmap:
    return np.memmap(view_file(rec), np.uint8, "r", shape=(n, VBYTES))


def split_views(buf: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """[..., VBYTES] -> glob [..., 240, 384, 3], big / small [..., 192, 192, 3] (views, no copy)."""
    lead = buf.shape[:-1]
    g = buf[..., :GLOB_B].reshape(*lead, GH, GW, 3)
    b = buf[..., GLOB_B:GLOB_B + CROP_B].reshape(*lead, CS, CS, 3)
    s = buf[..., GLOB_B + CROP_B:].reshape(*lead, CS, CS, 3)
    return g, b, s


def labels(n: int, contacts: list[dict], pe: dict, G: int) -> np.ndarray:
    """[n, 4] int64 per video frame: group, own colour, response, tte (s3b_train.Rec, the same rules)."""
    lab = frame_labels(n, contacts)
    grp = np.full(n, -100, np.int64)
    col = np.full(n, -100, np.int64)
    rsp = np.full(n, -100, np.int64)
    nxt = lab["next"]
    fr = np.array([c["frame"] for c in contacts], np.int64)
    t = np.arange(n)
    d = np.where(nxt >= 0, fr[np.maximum(nxt, 0)] - t if len(fr) else 0, 10 ** 6)
    for i in np.nonzero((nxt >= 0) & (d <= MOVE_PRE))[0]:
        c = contacts[nxt[i]]
        p = pe[str(c["id"])]
        grp[i] = p["gid"]
        col[i] = COLOR_IX.get(c["color"], -100)
        rsp[i] = RESP_IX.get(p["response"], -100)
    idle = lab["idle"]
    grp[idle], col[idle], rsp[idle] = G, COLOR_IX["none"], 2
    return np.stack([grp, col, rsp, lab["tte"].astype(np.int64)], 1)


# ---------------------------------------------------------------- network (torch imported lazily)

def build(G: int, pretrained: bool = True, backbone: str | None = None):
    """-> the Student module: .glob (Backbone 384x240 -> G_DIM), .crop (Backbone 192 -> C_DIM, used for big and small),
    .head (TCN over the three rings)."""
    import timm
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    class Backbone(nn.Module):
        """BGR NCHW 0..255 -> feature. timm BACKBONE (ImageNet init; MobileNetV4-conv-S 0.5), stem conv re-ordered to
        take BGR; stem + blocks -> the last feature map (stride 32) -> global average + a 1x1 conv to 16 channels kept
        spatially (where things are) -> Linear."""

        def __init__(self, hw: tuple[int, int], out: int):
            super().__init__()
            self.body = timm.create_model(backbone or BACKBONE, pretrained=pretrained, num_classes=0, global_pool="")
            if hasattr(self.body, "bn2"):                   # MobileNetV2 (EfficientNet class): its 1x1 -> 1280 head is unused
                self.body.conv_head = self.body.bn2 = None
            with torch.no_grad():
                w = self.body.conv_stem.weight
                w.copy_(w[:, [2, 1, 0]])
            with torch.no_grad():
                ch = self.trunk(torch.zeros(1, 3, *hw)).shape[1]
            fh, fw = (hw[0] + 31) // 32, (hw[1] + 31) // 32
            self.sp = nn.Sequential(nn.Conv2d(ch, 16, 1), nn.ReLU())
            self.fc = nn.Linear(ch + 16 * fh * fw, out)
            mean = torch.tensor(MEAN[::-1]).view(1, 3, 1, 1) * 255
            std = torch.tensor(STD[::-1]).view(1, 3, 1, 1) * 255
            self.register_buffer("scale", 1.0 / std, persistent=False)
            self.register_buffer("shift", -mean / std, persistent=False)

        def trunk(self, x):    # stem + blocks (MobileNetV3's forward_features; MobileNetV2 without its conv_head)
            b = self.body
            return b.blocks(b.bn1(b.conv_stem(x)))

        def forward(self, x):  # [B, 3, H, W] uint8 or float 0..255
            if x.dtype != torch.float32:           # training: uint8; export: float (no Cast in the graph)
                x = x.float()
            x = x * self.scale + self.shift
            f = self.trunk(x)
            g = f.mean((2, 3))
            s = self.sp(f).flatten(1)
            return self.fc(torch.cat([g, s], 1))

    class Block(nn.Module):
        def __init__(self, ch: int, d: int):
            super().__init__()
            self.d = d
            self.c1 = nn.Conv1d(ch, ch, 3, dilation=d)
            self.c2 = nn.Conv1d(ch, ch, 1)

        def forward(self, x):  # valid conv: length L -> L - 2d
            y = self.c2(F.relu(self.c1(x)))
            return F.relu(x[:, :, 2 * self.d:] + y)

    class Head(nn.Module):
        """rings g [B, T, G_DIM + 4], b / s [B, T, C_DIM + 1] -> logits at every position with RF - 1 frames before
        it: [B, T - RF + 1, n_out]. Export uses last=True: [B, n_out] at the last step only."""

        def __init__(self):
            super().__init__()
            self.inp = nn.Conv1d(G_DIM + N_HIST + 2 * C_DIM, TCN_CH, 1)
            self.blocks = nn.ModuleList([Block(TCN_CH, d) for d in DILATIONS])
            self.out = nn.Conv1d(TCN_CH, n_out(G), 1)

        def forward(self, g, b, s, last: bool = False):
            x = torch.cat([g, b[..., :C_DIM], s[..., :C_DIM]], -1).transpose(1, 2)
            if last:
                x = x[:, :, x.shape[2] - RF:]
            x = F.relu(self.inp(x))
            for blk in self.blocks:
                x = blk(x)
            y = self.out(x)
            return y[:, :, -1] if last else y.transpose(1, 2)

    class Student(nn.Module):
        def __init__(self):
            super().__init__()
            self.glob = Backbone((GH, GW), G_DIM)
            self.crop = Backbone((CS, CS), C_DIM)
            self.head = Head()

        def features(self, g, b, s):
            """[N, 3, ...] uint8 each -> fg [N, G_DIM], fb [N, C_DIM], fs [N, C_DIM]."""
            fg = self.glob(g)
            fc = self.crop(torch.cat([b, s], 0))
            return fg, fc[:len(b)], fc[len(b):]

        def seq(self, fg, fb, fs, hist):
            """[B, L, ...] features + history -> logits [B, L - RF + 1, n_out] (positions RF-1 .. L-1)."""
            z = torch.zeros(*fb.shape[:2], 1, device=fb.device, dtype=fb.dtype)
            return self.head(torch.cat([fg, hist.to(fg.dtype)], -1), torch.cat([fb, z], -1), torch.cat([fs, z], -1))

    st = Student()
    return st


def front_pad(x, n: int):
    """[B, L, D] -> [B, n + L, D] with the first step repeated n times (the device ring's front padding)."""
    import torch
    return torch.cat([x[:, :1].expand(-1, n, -1), x], 1)
