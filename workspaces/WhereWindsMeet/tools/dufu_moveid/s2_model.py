"""顺序 2: the tell classifier on line-candidate crops (s2_crops / s2_feat) trained from s2_labels.json.

Classes R (红光 tell), G (金光 tell), C (clash / impact), N (other). ResNet-18 (ImageNet weights) on the 120 x 240
crop, horizontal flips + small brightness / contrast jitter (no hue jitter: colour is the label). Out-of-fold
probabilities (K folds grouped by recording) for the labelled crops, then a model on all labels predicts every crop.

  s2_model.py [--folds 5] [--epochs 12]
Output data/moveid/color/crop_probs.json: key -> {p: [R, G, C, N], unc}, and crop_oof.json (labelled crops' OOF p).
GPU memory stays well under 1 GB (batch 64 of 120 x 240).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torchvision

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import OUT, read_json, write_json  # noqa: E402
from s2_crops import CROPS  # noqa: E402

LABELS = Path(__file__).resolve().parent / "s2_labels.json"
CLS = "RGCN"
MEAN = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1)
STD = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1)
MODEL = OUT / "color" / "tell_resnet18.pt"


def load_all():
    keys, imgs = [], []
    for p in sorted(CROPS.glob("*.npz")):
        if p.name.endswith(".tmp.npz"):
            continue
        z = np.load(p)
        for f, k, im in zip(z["frame"], z["k"], z["img"]):
            keys.append(f"{p.stem}:{int(f)}:{int(k)}")
            imgs.append(im)
    return keys, np.stack(imgs) if imgs else np.zeros((0, 120, 240, 3), np.uint8)


def to_t(x: np.ndarray, dev) -> torch.Tensor:
    t = torch.from_numpy(x[..., ::-1].copy()).to(dev).permute(0, 3, 1, 2).float() / 255  # BGR -> RGB
    return (t - MEAN.to(dev)) / STD.to(dev)


def net(dev):
    m = torchvision.models.resnet18(weights=torchvision.models.ResNet18_Weights.IMAGENET1K_V1)
    m.fc = nn.Linear(512, len(CLS))
    return m.to(dev)


def train(x: np.ndarray, y: np.ndarray, epochs: int, dev, seed: int = 0):
    torch.manual_seed(seed)
    rng = np.random.default_rng(seed)
    m = net(dev)
    opt = torch.optim.AdamW(m.parameters(), lr=3e-4, weight_decay=1e-4)
    n = len(x)
    steps = epochs * max(1, (n + 31) // 32)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, 1e-3, total_steps=steps)
    w = torch.tensor([1.0 / max(1, int((y == c).sum())) for c in range(len(CLS))], device=dev, dtype=torch.float32)
    lossf = nn.CrossEntropyLoss(weight=w / w.sum() * len(CLS))
    m.train()
    for _ in range(epochs):
        order = rng.permutation(n)
        for i in range(0, n, 32):
            b = order[i:i + 32]
            xb = x[b].copy()
            flip = rng.random(len(b)) < 0.5
            xb[flip] = xb[flip, :, ::-1]
            t = to_t(xb, dev)
            t = t * torch.empty(len(b), 1, 1, 1, device=dev).uniform_(0.8, 1.2) + torch.empty(len(b), 1, 1, 1, device=dev).uniform_(-0.2, 0.2)
            loss = lossf(m(t), torch.from_numpy(y[b]).to(dev))
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
    return m


@torch.no_grad()
def predict(m, x: np.ndarray, dev) -> np.ndarray:
    m.eval()
    out = []
    for i in range(0, len(x), 128):
        xb = x[i:i + 128]
        p = torch.softmax(m(to_t(xb, dev)), 1) + torch.softmax(m(to_t(xb[:, :, ::-1].copy(), dev)), 1)
        out.append((p / 2).cpu().numpy())
    return np.concatenate(out) if out else np.zeros((0, len(CLS)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--no-oof", action="store_true")
    a = ap.parse_args()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    labels = read_json(LABELS, {})
    keys, imgs = load_all()
    ki = {k: i for i, k in enumerate(keys)}
    lk = [k for k in labels if k in ki]
    x = imgs[[ki[k] for k in lk]]
    y = np.array([CLS.index(labels[k]) for k in lk])
    recs = np.array([k.split(":")[0] for k in lk])
    print(f"{len(keys)} crops, {len(lk)} labelled", {c: int((y == i).sum()) for i, c in enumerate(CLS)}, dev, flush=True)
    if not a.no_oof:
        ur = np.unique(recs)
        rng = np.random.default_rng(0)
        fold_of = dict(zip(rng.permutation(ur), np.arange(len(ur)) % a.folds))
        fo = np.array([fold_of[r] for r in recs])
        oof = np.zeros((len(lk), len(CLS)))
        for f in range(a.folds):
            tr, te = fo != f, fo == f
            m = train(x[tr], y[tr], a.epochs, dev)
            oof[te] = predict(m, x[te], dev)
            del m
        pred = oof.argmax(1)
        cm = np.zeros((len(CLS), len(CLS)), int)
        for t, p in zip(y, pred):
            cm[t, p] += 1
        print("OOF confusion (rows true R G C N, cols pred):")
        for i, c in enumerate(CLS):
            print(" ", c, cm[i].tolist())
        print(f"OOF acc {np.mean(pred == y):.3f}")
        write_json(OUT / "color" / "crop_oof.json", {k: {"y": labels[k], "p": [round(float(v), 4) for v in p]} for k, p in zip(lk, oof)})
    m = train(x, y, a.epochs, dev)
    torch.save(m.state_dict(), MODEL)
    p = predict(m, imgs, dev)
    srt = np.sort(p, 1)
    unc = 1 - (srt[:, -1] - srt[:, -2])
    write_json(OUT / "color" / "crop_probs.json", {k: {"p": [round(float(v), 4) for v in pp], "unc": round(float(u), 4)} for k, pp, u in zip(keys, p, unc)}, indent=None)
    print("predicted", len(keys), "max mem MB", torch.cuda.max_memory_allocated() // 2**20 if dev == "cuda" else 0)


if __name__ == "__main__":
    main()
