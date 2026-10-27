"""Order 4: distil the prefix teacher (s3b_train) into the student (s4_common.build), 5 folds by round + a final model.

    uv run --no-project --with torch --with timm --with numpy --index https://download.pytorch.org/whl/cu130 \
        --index-strategy unsafe-best-match python workspaces/WhereWindsMeet/tools/dufu_moveid/s4_train.py \
        [--folds 0,1,2,3,4] [--final] [--epochs 10]

Data: student/views (s4_cache.py, the teacher's cached frames, s2_views uint8), labels exactly as s3b_train (group,
own colour, response, tte; s4_common.labels), contact history s3b_train.history (6-frame delay), soft labels
student/soft/fold<k>.npz (s4_soft.py: teacher k on every frame; the final model: mean of the five teachers).
Folds = s3_common.folds (the teacher's); inner validation = the same 10% of the training rounds the teacher held out
(rng 100 + k); the epoch with the lowest validation hard-label loss is kept; the test fold only produces OOF outputs.

Training: chunks of <= 128 consecutive cached frames (stride 128 - (RF - 1)), each frame through both backbones
(glob; big + small through the shared crop net), the head's valid TCN gives outputs at chunk positions >= RF - 1 = 28
(full 29-frame receptive field, as on the device ring); loss on those. Per head (weights 1, 1, 1, 0.5 as the teacher):
CE with the hard label + KL(teacher || student) on the same frames (group / colour / response where the hard label
exists, tte where the tte label exists). 10% of frames are replaced by the previous frame's features (the recordings'
repeated frames; the contact history stays). AdamW (lr, heads x2), half an epoch warm-up + cosine, bf16, channels_last;
batches are always batch x CH frames (cuDNN re-plans every new shape, ~30-60 s each on this box).

Prediction (test rounds): every segment of consecutive cached frames, chunked the same way; the first chunk of a
segment is front-padded with its first frame (the device ring's padding) so every frame gets an output.
Out: student/fold<k>.pt, log.json, oof_fold<k>.npz -> student/oof.npz (s3b_gate1 format); --final: student/final.pt.
"""
from __future__ import annotations

import argparse
import collections
import json
import math
import queue
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from s3_common import CACHE, N_FOLDS, STORE_OFFS, folds, load, read_json, segments, write_json  # noqa: E402
from s3b_gate1 import PREFIX  # noqa: E402
from s3b_train import history  # noqa: E402
from s4_common import (RF, SOFT, STUDENT, VBYTES, build, heads, labels, n_out, no_throttle, view_file)  # noqa: E402

CH = 128
STRIDE = CH - (RF - 1)
W = (1.0, 1.0, 1.0, 0.5)
NAMES = ("grp", "col", "resp", "tte")
DUP_P = 0.1


class Rec:
    def __init__(self, r: dict, contacts: list[dict], pe: dict, G: int):
        self.rec = r["rec"]
        self.frames = f = np.load(CACHE / f"{self.rec}.npz")["frames"]
        n = r["frames"]
        fr = np.array([c["frame"] for c in contacts], np.int64)
        self.y = labels(n, contacts, pe, G)[f]
        self.hist = history(n, fr)[f]
        self.path = view_file(self.rec)
        assert self.path.stat().st_size == len(f) * VBYTES, self.rec
        self.soft = None
        self.row_of = {int(x): i for i, x in enumerate(f)}
        self.chunks = []
        for a, b in segments(f):
            s = a
            while True:
                e = min(s + CH, b)
                self.chunks.append((s, e, s == a))
                if e >= b:
                    break
                s += STRIDE


class Loader:
    """Chunks -> GPU batches: views uint8 [B, L, VBYTES] (pinned, read by a thread pool), history, labels, soft."""

    def __init__(self, recs, items, batch, shuffle, seed, threads=8):
        self.recs, self.items, self.batch, self.shuffle = recs, items, batch, shuffle
        self.rng = np.random.default_rng(seed)
        self.pool = ThreadPoolExecutor(threads)

    def batches(self):
        items = list(self.items)
        if self.shuffle:
            self.rng.shuffle(items)
        return [items[i:i + self.batch] for i in range(0, len(items), self.batch)]

    def _read(self, it, buf, off):
        rec, a, b, _ = it
        n = (b - a) * VBYTES
        with open(self.recs[rec].path, "rb", buffering=0) as fh:
            fh.seek(a * VBYTES)
            mv = memoryview(buf.numpy()).cast("B")[off * VBYTES:off * VBYTES + n]
            got = fh.readinto(mv)
            assert got == n, (rec, a, b, got, n)

    def __iter__(self):
        import torch
        bl = self.batches()
        q: queue.Queue = queue.Queue(maxsize=2)
        nbuf = 4
        bufs = [torch.empty((self.batch * CH, VBYTES), dtype=torch.uint8).pin_memory() for _ in range(nbuf)]

        def produce():
            for i, b in enumerate(bl):
                buf = bufs[i % nbuf]
                # fixed shapes (batch x CH, short chunks / last batch padded, padding has no labels): every new
                # input shape costs cuDNN ~30-60 s of plan building on this box
                L, nbat = CH, self.batch
                futs = [self.pool.submit(self._read, it, buf, j * L) for j, it in enumerate(b)]
                hist = np.zeros((nbat, L, 4), np.float32)
                y = np.full((nbat, L, 4), -100, np.int64)
                soft = None
                for j, (rec, a, e, first) in enumerate(b):
                    r = self.recs[rec]
                    hist[j, :e - a] = r.hist[a:e]
                    y[j, :e - a] = r.y[a:e]
                    if r.soft is not None:
                        if soft is None:
                            soft = np.zeros((nbat, L, r.soft.shape[1]), np.float16)
                        soft[j, :e - a] = r.soft[a:e]
                for f in futs:
                    f.result()
                q.put((buf, nbat, L, hist, y, soft, b))
            q.put(None)

        th = threading.Thread(target=produce, daemon=True)
        th.start()
        while (item := q.get()) is not None:
            buf, nb, L, hist, y, soft, b = item
            v = buf[:nb * L].to("cuda", non_blocking=True)
            yield (v, nb, L, torch.from_numpy(hist).cuda(), torch.from_numpy(y).cuda(),
                   None if soft is None else torch.from_numpy(soft).cuda(), b)
        th.join()


def split(v):
    """[N, VBYTES] uint8 cuda -> glob [N, 3, 240, 384], big, small [N, 3, 192, 192] (channels_last views)."""
    from s4_common import CROP_B, CS, GH, GLOB_B, GW
    g = v[:, :GLOB_B].view(-1, GH, GW, 3).permute(0, 3, 1, 2)
    b = v[:, GLOB_B:GLOB_B + CROP_B].view(-1, CS, CS, 3).permute(0, 3, 1, 2)
    s = v[:, GLOB_B + CROP_B:].view(-1, CS, CS, 3).permute(0, 3, 1, 2)
    return g, b, s


def forward(model, v, nb, L, hist, dup_p=0.0, pad_first=None):
    """-> logits [nb, L', W] for chunk positions (RF - 1 .. L - 1), or all L positions where pad_first[j]."""
    import torch
    g, b, s = split(v)
    fg, fb, fs = model.features(g, b, s)
    fg, fb, fs = (x.view(nb, L, -1) for x in (fg, fb, fs))
    if dup_p > 0:
        dm = torch.rand(nb, L, device=v.device) < dup_p
        dm[:, 0] = False
        src = torch.arange(L, device=v.device).expand(nb, L) - dm.long()
        bi = torch.arange(nb, device=v.device)[:, None]
        fg, fb, fs = fg[bi, src], fb[bi, src], fs[bi, src]
    if pad_first is None:
        return model.seq(fg, fb, fs, hist)
    from s4_common import front_pad
    p = RF - 1
    return model.seq(front_pad(fg, p), front_pad(fb, p), front_pad(fs, p), front_pad(hist, p))


def run_epoch(model, loader, G, opt=None, sched=None, kd=1.0):
    import torch
    import torch.nn.functional as F
    train = opt is not None
    model.train(train)
    tot = collections.Counter()
    hs = heads(G)
    t0 = time.time()
    nfr = 0
    for step, (v, nb, L, hist, y, soft, _) in enumerate(loader):
        if step % 200 == 0 and step:
            print(f"  step {step} {time.time() - t0:.0f}s {nfr / (time.time() - t0):.0f} f/s "
                  f"mem {torch.cuda.max_memory_allocated() / 1e9:.1f} GB", flush=True)
        nfr += nb * L
        with torch.autocast("cuda", dtype=torch.bfloat16), torch.set_grad_enabled(train):
            out = forward(model, v, nb, L, hist, DUP_P if train else 0.0).float()
        yy = y[:, RF - 1:]
        ss = soft[:, RF - 1:].float() if soft is not None else None
        loss = 0.0
        for i, ((nm, a, e), w) in enumerate(zip(hs, W)):
            o = out[..., a:e].flatten(0, 1)
            t = yy[..., i].flatten()
            m = t >= 0
            ni = m.sum().clamp_min(1)
            li = F.cross_entropy(o, t, ignore_index=-100, reduction="sum") / ni
            loss = loss + w * li
            with torch.no_grad():
                tot["l_" + nm] += li.item() * ni.item()
                tot["n_" + nm] += ni.item()
                tot["acc_" + nm] += (o.argmax(-1)[m] == t[m]).sum().item()
            if ss is not None and kd > 0:
                p = ss[..., a:e].flatten(0, 1)
                p = p / p.sum(-1, keepdim=True).clamp_min(1e-6)
                ok = m & ~torch.isnan(p[:, 0])
                kl = (p * (torch.log(p.clamp_min(1e-8)) - F.log_softmax(o, -1))).sum(-1)
                kl = (kl * ok).sum() / ok.sum().clamp_min(1)
                loss = loss + w * kd * kl
                with torch.no_grad():
                    tot["kl_" + nm] += kl.item() * ok.sum().item()
                    tot["nk_" + nm] += ok.sum().item()
        if train:
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
            opt.step()
            sched.step()
    r = {nm: tot["l_" + nm] / max(tot["n_" + nm], 1) for nm in NAMES}
    r["loss"] = sum(w * r[nm] for w, nm in zip(W, NAMES))
    for nm in NAMES:
        r["acc_" + nm] = tot["acc_" + nm] / max(tot["n_" + nm], 1)
        if tot["nk_" + nm]:
            r["kl_" + nm] = tot["kl_" + nm] / tot["nk_" + nm]
    r["fps"] = nfr / (time.time() - t0)
    return {k: round(v, 4) for k, v in r.items()}


def predict(model, recs, names, G, batch=4):
    """rec -> [n, W] float16 softmax probabilities per head (every cached frame)."""
    import torch
    model.eval()
    width = n_out(G)
    hs = heads(G)
    out = {r: np.full((len(recs[r].frames), width), np.nan, np.float16) for r in names}
    items = [(r, s, e, f) for r in names for (s, e, f) in recs[r].chunks]
    ld = Loader(recs, items, batch, False, 0)
    with torch.no_grad():
        for v, nb, L, hist, y, soft, b in ld:
            o = forward(model, v, nb, L, hist, pad_first=True).float()     # fp32 (as the exported fp32 ONNX)
            p = torch.cat([o[..., a:e].softmax(-1) for _, a, e in hs], -1).cpu().numpy()
            for j, (rec, a, e, first) in enumerate(b):
                n = e - a
                lo = 0 if first else RF - 1
                out[rec][a + lo:e] = p[j, lo:n]
    return out


def oof_rows(outs, recs, names, byrec):
    ids, P = [], []
    for r in names:
        R = recs[r]
        for e in byrec.get(r, []):
            ids.append(e["id"])
            p = np.full((len(STORE_OFFS), outs[r].shape[1]), np.nan, np.float16)
            for j, o in enumerate(STORE_OFFS):
                rw = R.row_of.get(e["frame"] + o, -1)
                if rw >= 0:
                    p[j] = outs[r][rw]
            P.append(p)
    return ids, np.stack(P)


def save_oof(path, ids, P, G, k):
    V = ~np.isnan(P[..., 0])
    P = np.nan_to_num(P)
    s1, s2, s3 = G + 1, G + 4, G + 7
    np.savez_compressed(path, ids=np.array(ids), offs=np.array(STORE_OFFS), p_grp=P[..., :s1], p_col=P[..., s1:s2],
                        p_resp=P[..., s2:s3], p_tte=P[..., s3:], valid=V, fold=np.full(len(ids), k))


def merge_oof(src_fmt: str, dst: Path) -> None:
    zs = [np.load(src_fmt.format(k=k)) for k in range(N_FOLDS)]
    merged = {key: np.concatenate([z[key] for z in zs]) for key in ("ids", "p_grp", "p_col", "p_resp", "p_tte", "valid", "fold")}
    merged["offs"] = zs[0]["offs"]
    np.savez_compressed(dst, **merged)


def train_one(recs, train, val, G, a, tag, log, logp):
    import torch
    torch.manual_seed(a.seed)
    model = build(G, backbone=a.backbone).cuda().to(memory_format=torch.channels_last)
    if a.init:
        ip = Path(a.init)
        if not ip.exists():
            ip = STUDENT / f"{a.init}.pt"
        sd = torch.load(ip, map_location="cpu")
        msd, used, skipped = model.state_dict(), [], []
        for k, v in sd.items():
            if k in msd and msd[k].shape == v.shape:
                msd[k] = v
                used.append(k)
            else:
                skipped.append(k)
        model.load_state_dict(msd)
        print(f"init {ip}: {len(used)} tensors loaded, {len(skipped)} skipped (new / shape-mismatched heads)", flush=True)
    items = lambda rs: [(r, s, e, f) for r in rs for (s, e, f) in recs[r].chunks]  # noqa: E731
    tl = Loader(recs, items(train), a.batch, True, seed=a.seed)
    vl = Loader(recs, items(sorted(val)), a.batch, False, seed=0) if val else None
    head_p = [p for n, p in model.named_parameters() if n.startswith("head.") or ".fc." in n or ".sp." in n]
    ids = {id(p) for p in head_p}
    body_p = [p for p in model.parameters() if id(p) not in ids]
    opt = torch.optim.AdamW([{"params": body_p, "lr": a.lr}, {"params": head_p, "lr": a.lr * 2}],
                            weight_decay=0.02, betas=(0.9, 0.99))
    nb = len(tl.batches())
    steps, warm = a.epochs * nb, nb // 2
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(s, steps) / steps)))
    best, hist = None, []
    dst = STUDENT / f"{tag}.pt"
    for ep in range(a.epochs):
        te = time.time()
        tr = run_epoch(model, tl, G, opt, sched, kd=a.kd)
        va = run_epoch(model, vl, G, kd=a.kd) if vl else None
        hist.append({"epoch": ep, "train": tr, "val": va, "sec": round(time.time() - te, 1)})
        print(f"{tag} ep {ep} train {tr} val {va} {time.time() - te:.0f}s", flush=True)
        if va is None or best is None or va["loss"] < best[0]:
            best = (va["loss"] if va else None, ep)
            torch.save(model.state_dict(), dst)
        log[tag] = {"best_epoch": best[1], "best_val_loss": best[0], "train_recs": len(train), "val_recs": len(val),
                    "history": hist, "sec": round(sum(h["sec"] for h in hist), 1),
                    "params": sum(p.numel() for p in model.parameters())}
        write_json(logp, log)
    model.load_state_dict(torch.load(dst))
    return model


def main() -> None:
    import torch
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--folds", default=",".join(str(k) for k in range(N_FOLDS)))
    ap.add_argument("--final", action="store_true", help="also train on every round (soft = mean of the 5 teachers)")
    ap.add_argument("--final-only", action="store_true")
    ap.add_argument("--epochs", type=int, default=10)
    ap.add_argument("--final-epochs", type=int, default=0, help="default: --epochs")
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--kd", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--backbone", default=None, help="timm name (default s4_common.BACKBONE)")
    ap.add_argument("--init", default="", help="checkpoint under data/moveid/student (e.g. live_a) or a .pt path; compatible tensors are loaded, the rest start fresh")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    no_throttle()
    torch.backends.cudnn.benchmark = False
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    t0 = time.time()
    d = load()
    prefix = read_json(PREFIX / "prefix.json")
    pe, G = prefix["events"], len(prefix["groups"])
    fold = folds(d["recs"], d["events"])
    byrec = collections.defaultdict(list)
    for e in d["events"]:
        byrec[e["rec"]].append(e)
    rlist = d["recs"]
    if a.limit:   # debug: the first N recordings whose views are cached
        rlist = [r for r in rlist if view_file(r["rec"]).exists() and view_file(r["rec"]).stat().st_size
                 == len(np.load(CACHE / f"{r['rec']}.npz")["frames"]) * VBYTES][:a.limit]
    recs = {r["rec"]: Rec(r, byrec.get(r["rec"], []), pe, G) for r in rlist}
    print(f"loaded {len(recs)} recordings, {sum(len(r.frames) for r in recs.values())} frames, "
          f"{sum(len(r.chunks) for r in recs.values())} chunks, G={G}, {time.time() - t0:.0f}s", flush=True)
    STUDENT.mkdir(parents=True, exist_ok=True)
    logp = STUDENT / ("log.json" if not a.limit else "log_debug.json")
    log = json.loads(logp.read_text(encoding="utf-8")) if logp.exists() else {}
    log["args"] = vars(a)
    for k in ([] if a.final_only else [int(x) for x in a.folds.split(",")]):
        tk = time.time()
        z = np.load(SOFT / f"fold{k}.npz")
        for r in recs.values():
            r.soft = z[r.rec] if fold[r.rec] != k else None
        test = [r for r in recs if fold[r] == k]
        trainval = sorted(r for r in recs if fold[r] != k)
        rng = np.random.default_rng(100 + k)
        val = set(rng.choice(trainval, max(1, len(trainval) // 10), replace=False).tolist())
        train = [r for r in trainval if r not in val]
        model = train_one(recs, train, val, G, a, f"fold{k}", log, logp)
        outs = predict(model, recs, test, G)
        ids, P = oof_rows(outs, recs, test, byrec)
        save_oof(STUDENT / f"oof_fold{k}.npz", ids, P, G, k)
        log[f"fold{k}"]["total_sec"] = round(time.time() - tk, 1)
        write_json(logp, log)
        print(f"fold {k} done: {len(ids)} contacts, {time.time() - tk:.0f}s", flush=True)
        del model
        torch.cuda.empty_cache()
    parts = [STUDENT / f"oof_fold{k}.npz" for k in range(N_FOLDS)]
    if all(p.exists() for p in parts) and not a.limit:
        merge_oof(str(STUDENT / "oof_fold{k}.npz"), STUDENT / "oof.npz")
        print("merged ->", STUDENT / "oof.npz")
    if a.final or a.final_only:
        tk = time.time()
        zs = [np.load(SOFT / f"fold{k}.npz") for k in range(N_FOLDS)]
        for r in recs.values():
            r.soft = np.mean([z[r.rec].astype(np.float32) for z in zs], 0).astype(np.float16)
        if a.final_epochs:
            a.epochs = a.final_epochs
        train_one(recs, sorted(recs), [], G, a, "final", log, logp)
        log["final"]["total_sec"] = round(time.time() - tk, 1)
        write_json(logp, log)
    print(f"total {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
