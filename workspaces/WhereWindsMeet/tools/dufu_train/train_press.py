"""Train the 卸势 timing branch ("lead1f") and export unified_head_p2e.onnx = head p2 unchanged + the branch's columns.

    uv run --with torch --index https://download.pytorch.org/whl/cu130 --with onnx --with onnxruntime \
        python workspaces/WhereWindsMeet/tools/dufu_train/train_press.py data/p2 [--cv 5] [--no-export]

lead1f (46 logits, out[133:179]): the next contact's lead from a tap issued now, in frames - lead = contact capture
time - (row loop time + replay.DECIDE_MS) - over 0..44 (bin = floor(lead)) + none (>= 45 / no contact). The same
contacts as labels.py, Gaussian soft target (sigma 1 f), the row weights of labels.targets (dead / end-censored rows 0,
unsure rows 0.3), rows with a contact 0-20 f ahead weighted --pos-w.
Why a separate branch and not new columns of the shared GRU: the branch reads the seq with the policy-dependent aux
(since_parry, pressed, since_ok) replaced by constants, so its output does not depend on our own past taps or their
outcomes (in the replay a new policy's taps differ from the logged ones), and head p2's 133 outputs stay
byte-for-byte what they were. The branch is a copy of head p2's GRU (init from it, both layers trained) with a new
linear on the last step; one ONNX, one call, outputs appended after the 133 (dufu.js slices unchanged).
--cv K: K folds by round number % K; the out-of-fold lead1f of every round goes to data/tmp/p2policy/heads/<name>_oof/
(replay.py reads it as the policy input), then the export is trained on all rounds (median best epoch + 1).
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as Fn
from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parent))
from data import AI, FRAME_MS, MIN_RING, scan, steps, window_index  # noqa: E402
from labels import targets  # noqa: E402
from model import H, Head, export_onnx, load_onnx  # noqa: E402,F401

WS = Path(__file__).resolve().parents[2]
REPO = WS.parents[1]
BASE = WS / "model" / "dufu" / "unified_head_p2.onnx"
DECIDE_MS = 21.0  # replay.DECIDE_MS
NB = 46
MASK = {"since_parry": 10.0, "pressed": 0.0, "since_ok": 10.0}  # aux column -> constant fed to the branch
POS_LO, POS_HI = 0, 20


def round_no(name: str) -> int:
    return int("".join(ch for ch in name if ch.isdigit()) or 0)


class Branch(nn.Module):
    """GRU copy of head p2 on the masked seq + a 46-way linear."""

    def __init__(self, base: Head):
        super().__init__()
        self.gru = copy.deepcopy(base.gru)
        self.out = nn.Linear(H, NB)
        with torch.no_grad():  # start from head p2's fut1f (capture clock, ~1.5 f off: close enough)
            self.out.weight.copy_(base.h["fut1f"].weight)
            self.out.bias.copy_(base.h["fut1f"].bias)
        idx = torch.tensor([192 + AI[k] for k in MASK])
        val = torch.tensor(list(MASK.values()), dtype=torch.float32)
        keep = torch.ones(207)
        keep[idx] = 0
        add = torch.zeros(207)
        add[idx] = val
        self.register_buffer("keep", keep)
        self.register_buffer("add", add)

    def forward(self, seq):
        y, _ = self.gru(seq * self.keep + self.add)
        return self.out(y[:, -1])


class P2E(nn.Module):
    """head p2 (frozen, unchanged) -> out[:, :133]; Branch -> out[:, 133:179]."""

    def __init__(self, base: Head, branch: Branch):
        super().__init__()
        self.base = base
        self.branch = branch

    def forward(self, seq):
        return torch.cat([self.base(seq), self.branch(seq)], 1)


def lead_targets(r, tg):
    """(N, 46) soft target over the next contact's tap lead (0..44 f, none) and (N,) frames (inf none)."""
    ct = np.array([c.t for c in tg.contacts])
    tap = r.wall + DECIDE_MS
    tgt = np.zeros((r.n, NB), np.float32)
    lead = np.full(r.n, np.inf)
    grid = np.arange(45) + 0.5
    for i in range(r.n):
        L = (ct - tap[i]) / FRAME_MS
        L = L[L >= 0]
        if len(L) and L.min() < 45:
            lead[i] = L.min()
            g = np.exp(-0.5 * ((grid - lead[i]) / 1.0) ** 2)
            tgt[i, :45] = g / g.sum()
        else:
            tgt[i, 45] = 1.0
    return tgt, lead


class Split:
    def __init__(self, rounds, dev):
        st, win, tg, w, rid, rows = [], [], [], [], [], []
        off = 0
        self.rounds = rounds
        for k, r in enumerate(rounds):
            if r.name not in _TG:
                T = targets(r)
                _TG[r.name] = (T.w, *lead_targets(r, T))
            Tw, t, lead = _TG[r.name]
            rr = np.arange(MIN_RING - 1, r.n)
            st.append(steps(r))
            win.append(window_index(r.n)[rr] + off)
            tg.append(t[rr])
            ww = Tw[rr].copy()
            ww[(lead[rr] >= POS_LO) & (lead[rr] <= POS_HI)] *= POS_W[0]
            w.append(ww)
            rid.append(np.full(len(rr), k))
            rows.append(rr)
            off += r.n

        def t_(a, dt=torch.float32):
            return torch.as_tensor(np.concatenate(a), dtype=dt, device=dev)

        self.steps, self.win, self.tg, self.w = t_(st), t_(win, torch.long), t_(tg), t_(w)
        self.rid, self.rows = np.concatenate(rid), np.concatenate(rows)
        self.n = len(self.win)

    def x(self, idx):
        return self.steps[self.win[idx]]


POS_W = [4.0]
_TG: dict = {}


def loss_of(logits, S, idx):
    w = S.w[idx]
    ce = -(S.tg[idx] * torch.log_softmax(logits, 1)).sum(1)
    return (ce * w).sum() / w.sum().clamp_min(1.0)


@torch.no_grad()
def predict(m, S, bs=4096):
    m.eval()
    dev = S.steps.device
    return torch.cat([m(S.x(torch.arange(i, min(i + bs, S.n), device=dev))) for i in range(0, S.n, bs)])


def fit(cfg, base, Str, Sva, epochs, log=print):
    br = Branch(base).to(Str.steps.device)
    for n, p in br.named_parameters():
        p.requires_grad_(cfg.train == "all" or n.startswith("out") or n.endswith("_l1"))
    params = [p for p in br.parameters() if p.requires_grad]
    init = [p.detach().clone() for p in params]
    opt = torch.optim.AdamW(params, lr=cfg.lr, weight_decay=0.0)
    best, best_ep, bad, state = None, epochs - 1, 0, copy.deepcopy(br.state_dict())
    dev = Str.steps.device
    t0 = time.time()
    for ep in range(epochs):
        br.train()
        perm = torch.randperm(Str.n, device=dev)
        tot, nb = 0.0, 0
        for i in range(0, Str.n, cfg.bs):
            idx = perm[i:i + cfg.bs]
            loss = loss_of(br(Str.x(idx)), Str, idx)
            loss = loss + cfg.l2sp * sum(((p - q) ** 2).sum() for p, q in zip(params, init))
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            tot += float(loss.detach())
            nb += 1
        if Sva is None:
            continue
        o = predict(br, Sva)
        v = float(loss_of(o, Sva, torch.arange(Sva.n, device=dev)))
        log(f"  ep {ep:2d} train {tot / nb:.4f} val {v:.4f} ({time.time() - t0:.0f}s)")
        if best is None or v < best - 1e-4:
            best, best_ep, bad, state = v, ep, 0, copy.deepcopy(br.state_dict())
        else:
            bad += 1
            if bad >= cfg.patience:
                break
    if Sva is not None:
        br.load_state_dict(state)
    return br, best_ep, best


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--name", default="unified_head_p2e")
    ap.add_argument("--base", default=str(BASE))
    ap.add_argument("--cv", type=int, default=5)
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--patience", type=int, default=4)
    ap.add_argument("--bs", type=int, default=128)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--l2sp", type=float, default=1e-3)
    ap.add_argument("--pos-w", type=float, default=4.0)
    ap.add_argument("--train", choices=["gru2", "all"], default="all")
    ap.add_argument("--skip", default="r058-r067")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-export", action="store_true")
    ap.add_argument("--final-epochs", type=int, default=2, help="--cv 0: epochs of the export fit (the 5-fold run's median best + 1 was 2)")
    cfg = ap.parse_args()
    POS_W[0] = cfg.pos_w
    torch.manual_seed(cfg.seed)
    np.random.seed(cfg.seed)
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    skip = set()
    for part in filter(None, cfg.skip.split(",")):
        a, _, b = part.partition("-")
        skip.update(range(round_no(a), round_no(b or a) + 1))
    allr = scan(cfg.root)
    rounds = [r for r in allr if round_no(r.name) not in skip]
    print(f"device {dev}; {len(rounds)} rounds (skip {sorted(skip)[:1]}..), base {Path(cfg.base).name}")
    base = load_onnx(cfg.base).to(dev).eval()
    for p in base.parameters():
        p.requires_grad_(False)
    oof_dir = REPO / "data" / "tmp" / "p2policy" / "heads" / f"{cfg.name}_oof"
    oof_dir.mkdir(parents=True, exist_ok=True)
    best_eps, folds_out = [], []
    for f in range(cfg.cv):
        va = [r for r in allr if round_no(r.name) % cfg.cv == f]  # skipped rounds still get an OOF prediction
        tr = [r for r in rounds if round_no(r.name) % cfg.cv != f]
        print(f"fold {f}: train {len(tr)} val {len(va)}", flush=True)
        Str, Sva = Split(tr, dev), Split(va, dev)
        br, ep, v = fit(cfg, base, Str, Sva, cfg.epochs)
        best_eps.append(ep)
        folds_out.append({"fold": f, "best_epoch": ep, "val_loss": v})
        o = predict(br, Sva).cpu().numpy()
        for k, r in enumerate(Sva.rounds):
            m = Sva.rid == k
            a = np.full((r.n, NB), np.nan, np.float32)
            a[Sva.rows[m]] = o[m]
            np.save(oof_dir / f"{r.name}.npy", a)
        # the original fut1f on the same rows, same loss (the reference)
        print(f"fold {f} best epoch {ep} val {v:.4f}", flush=True)
    if cfg.cv > 1:
        (oof_dir / "folds.json").write_text(json.dumps({"cfg": vars(cfg), "folds": folds_out}, indent=1), encoding="utf-8")
    if cfg.no_export:
        return
    final_ep = int(np.median(best_eps)) + 1 if best_eps else cfg.final_epochs
    print(f"final: {len(rounds)} rounds, {final_ep} epochs")
    Sall = Split(rounds, dev)
    br, _, _ = fit(cfg, base, Sall, None, final_ep)
    full = P2E(base.cpu(), br.cpu()).eval()
    out_dir = WS / "model" / "dufu"
    onnx_p = out_dir / f"{cfg.name}.onnx"
    model = full.cpu().eval()
    x = torch.zeros(1, 30, 207)
    torch.onnx.export(model, (x,), str(onnx_p), input_names=["seq"], output_names=["out"], opset_version=17,
                      dynamo=False, do_constant_folding=True)
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_p))
    sb = ort.InferenceSession(str(cfg.base))
    pick = torch.linspace(0, Sall.n - 1, 64, device=dev).long()
    xs = Sall.x(pick).cpu().numpy()
    with torch.no_grad():
        ref = model(torch.from_numpy(xs)).numpy()
    got = np.concatenate([sess.run(None, {"seq": xs[i:i + 1]})[0] for i in range(len(xs))])
    old = np.concatenate([sb.run(None, {"seq": xs[i:i + 1]})[0] for i in range(len(xs))])
    diff = float(np.abs(ref - got).max())
    d133 = float(np.abs(got[:, :133] - old).max())
    print(f"exported {onnx_p} ({md5(onnx_p)}): onnxruntime vs torch {diff:.2e}; out[:133] vs head p2 {d133:.2e}")
    j = copy.deepcopy(json.loads(Path(cfg.base).with_suffix(".json").read_text(encoding="utf-8")))
    rel = f"dufu/{onnx_p.name}"
    j["model"] = ("head p2 (unified_head_p2.onnx, unchanged: out[0:133] identical) + a 卸势 timing branch appended as "
                  "out[133:179] 'lead1f': the next contact's lead from a tap issued now (frames, 0..44 + none), read "
                  "from the seq with since_parry / pressed / since_ok replaced by constants. Trainer: "
                  "tools/dufu_train/train_press.py; policy: tools/dufu_train/replay.py (README).")
    j["io"]["output"]["shape"] = [1, 179]
    j["io"]["output"]["note"] = ("head p2's 133 first (all slices unchanged), then lead1f (46). softmax per slice. lead1f "
                                 "bin b < 45: lead in [b, b+1) frames, lead = contact - (this row's loop time + 21 ms); "
                                 "b 45: none / >= 45 f.")
    j["slices"].append({"name": "lead1f", "start": 133, "len": NB,
                        "labels": [f"{b}f" for b in range(45)] + ["none"],
                        "note": "aux since_parry=10, pressed=0, since_ok=10 inside the branch (policy-independent input)"})
    for c in j.get("device_calls", []):
        if c.get("name") == "head":
            c["call"] = c["call"].replace("dufu/unified_head_p2.onnx", rel).replace("dufu/unified_head9s.onnx", rel)
            c["out"] = "out: 179-d (see slices; 0..132 = head p2 unchanged, 133..178 lead1f)"
    j["provenance"] = {
        "kind": "phase2-press-branch", "base": Path(cfg.base).name, "base_md5": md5(Path(cfg.base)),
        "head_md5": md5(onnx_p), "trained": time.strftime("%Y-%m-%d %H:%M"), "data": cfg.root,
        "rounds_fit": [r.name for r in rounds], "epochs": final_ep, "fold_best_epochs": best_eps, "folds": folds_out,
        "config": {k: v for k, v in vars(cfg).items() if k != "root"}, "onnx_vs_torch_maxdiff": diff,
        "out133_vs_base_maxdiff": d133,
    }
    onnx_p.with_suffix(".json").write_text(json.dumps(j, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {onnx_p.with_suffix('.json')}")


if __name__ == "__main__":
    main()
