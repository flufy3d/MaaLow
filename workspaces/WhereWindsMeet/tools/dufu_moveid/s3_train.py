"""Order 3: teacher model for gate 1 -- frozen DINOv3 patch tokens (s3_cache.py) + trainable attention pooling +
causal temporal transformer; 5-fold (by round) training and out-of-fold prediction.

    uv run --no-project --with torch --with numpy --index https://download.pytorch.org/whl/cu130 \
        --index-strategy unsafe-best-match python workspaces/WhereWindsMeet/tools/dufu_moveid/s3_train.py \
        [--folds 0,1,2,3,4] [--epochs 16] [--tag teacher]

Model (per frame, then over time):
  tokens   651 x 384 per frame (3 CLS + glob 15x24 + big 12x12 + small 12x12, int8 -> float), LayerNorm,
           Linear 384 -> 256, + learned position / view embedding (one per token slot)
  pool     24 learned latents cross-attend all 651 tokens (8 heads) + MLP, then one self-attention block over the
           latents; flatten 24 x 256 -> LayerNorm -> Linear -> 512; + Linear(motion of the 3 views, dup flag)
  time     4 pre-norm transformer layers, d 512, 8 heads, causal sliding window of T_HIST = 32 frames (t-31 .. t)
           with a learned per-head relative-position bias; dropout 0.1
  heads    class 45 (43 taxonomy classes, unknown, idle), colour 3, next-contact 47 bins (0..45, none)
Training: chunks of up to 128 consecutive cached frames (stride 97 = 128 - 31); loss on chunk positions >= 31 (full
history) with a label (s3_common.frame_labels); CE class + CE colour + 0.5 CE tte. AdamW lr 3e-4 wd 0.05, 1 epoch
warm-up + cosine, bf16 autocast, batch 16 chunks. Augmentation: 10% of frames replaced by the previous frame's
embedding with zero motion (the recorder's duplicate frames). Inner validation = 10% of the training rounds; the
epoch with the lowest inner-validation loss is kept and predicts the test fold (out-of-fold).
Out: data/moveid/teacher/<tag>/fold<k>.pt, log.json, oof_fold<k>.npz; merged -> data/moveid/teacher/oof.npz (tag
'teacher') in s3_gate1.py's format.
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
from s3_common import (CACHE, IDLE, N_CLASS, N_FOLDS, N_TTE, OUT, STORE_OFFS, T_HIST, TEACHER, folds,  # noqa: E402
                       frame_labels, load, segments, write_json)

N_TOK, DIM = 651, 384
CH = 128
STRIDE = CH - (T_HIST - 1)
DUP_MOT = 0.3


# ---------------------------------------------------------------- data

class Rec:
    def __init__(self, r: dict, contacts: list[dict]):
        self.rec = r["rec"]
        z = np.load(CACHE / f"{self.rec}.npz")
        self.frames = z["frames"]
        self.scale = z["scale"]
        self.path = CACHE / f"{self.rec}.tok"
        lab = frame_labels(r["frames"], contacts)
        f = self.frames
        self.y = np.stack([lab["cls"][f], lab["col"][f], lab["tte"][f]], 1).astype(np.int64)
        e = np.load(OUT / "emb" / f"{self.rec}.npz")
        mot = np.stack([e["mot_glob"][f], e["mot_big"][f], e["mot_small"][f]], 1).astype(np.float32)
        dup = (mot[:, 0] < DUP_MOT).astype(np.float32)
        self.aux = np.concatenate([np.log1p(mot) / 3.0, dup[:, None]], 1)
        self.row_of = {int(x): i for i, x in enumerate(f)}
        self.chunks = []           # (start_row, end_row, first_chunk_of_segment)
        for a, b in segments(f):
            s = a
            while True:
                e_ = min(s + CH, b)
                self.chunks.append((s, e_, s == a))
                if e_ >= b:
                    break
                s += STRIDE


class Loader:
    """Batches of chunks: int8 tokens read with plain file reads in a thread pool into pinned buffers."""

    def __init__(self, recs: dict, items: list, batch: int, shuffle: bool, seed: int, threads: int = 8,
                 infer: bool = False):
        self.recs, self.items, self.batch, self.shuffle, self.infer = recs, items, batch, shuffle, infer
        self.rng = np.random.default_rng(seed)
        self.pool = ThreadPoolExecutor(threads)

    def batches(self):
        items = list(self.items)
        if self.shuffle:
            self.rng.shuffle(items)
            # bucket by length inside windows of 32 batches (less padding), then shuffle batch order
            w = self.batch * 32
            items = [x for i in range(0, len(items), w) for x in sorted(items[i:i + w], key=lambda t: t[2] - t[1])]
        bl = [items[i:i + self.batch] for i in range(0, len(items), self.batch)]
        if self.shuffle:
            self.rng.shuffle(bl)
        return bl

    def _read(self, it, buf, off):
        rec, a, b, _ = it
        r = self.recs[rec]
        n = (b - a) * N_TOK * DIM
        with open(r.path, "rb", buffering=0) as f:
            f.seek(a * N_TOK * DIM)
            mv = memoryview(buf.numpy()).cast("B")[off * N_TOK * DIM:off * N_TOK * DIM + n]
            got = f.readinto(mv)
            assert got == n, (rec, a, b, got, n)

    def __iter__(self):
        import torch
        bl = self.batches()
        q: queue.Queue = queue.Queue(maxsize=1)   # 3 buffers: filling / queued / in use
        nbuf = 3
        bufs = [torch.empty((self.batch * CH, N_TOK, DIM), dtype=torch.int8).pin_memory() for _ in range(nbuf)]

        def produce():
            for i, b in enumerate(bl):
                buf = bufs[i % nbuf]
                L = max(it[2] - it[1] for it in b)
                offs = [j * L for j in range(len(b))]
                futs = [self.pool.submit(self._read, it, buf, o) for it, o in zip(b, offs)]
                sc = np.zeros((len(b), L, N_TOK), np.float16)
                aux = np.zeros((len(b), L, 4), np.float32)
                y = np.full((len(b), L, 3), -100, np.int64)
                lm = np.zeros((len(b), L), bool)         # loss / output positions
                for j, (rec, a, e, first) in enumerate(b):
                    r = self.recs[rec]
                    n = e - a
                    sc[j, :n] = r.scale[a:e]
                    aux[j, :n] = r.aux[a:e]
                    y[j, :n] = r.y[a:e]
                    lm[j, T_HIST - 1:n] = True
                    if first and self.infer:
                        lm[j, :n] = True                 # inference: segment start has only what exists
                for f in futs:
                    f.result()
                q.put((buf, len(b), L, sc, aux, y, lm, b))
            q.put(None)

        th = threading.Thread(target=produce, daemon=True)
        th.start()
        while (item := q.get()) is not None:
            buf, nb, L, sc, aux, y, lm, b = item
            tok = buf[:nb * L].to("cuda").view(nb, L, N_TOK, DIM)
            yield tok, torch.from_numpy(sc).cuda(), torch.from_numpy(aux).cuda(), torch.from_numpy(y).cuda(), \
                torch.from_numpy(lm).cuda(), b
        th.join()


# ---------------------------------------------------------------- model

def build_model():
    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    class MLP(nn.Module):
        def __init__(self, d, h, p):
            super().__init__()
            self.f = nn.Sequential(nn.LayerNorm(d), nn.Linear(d, h), nn.GELU(), nn.Dropout(p), nn.Linear(h, d))

        def forward(self, x):
            return x + self.f(x)

    class Attn(nn.Module):
        """Multi-head attention; q from x, k / v from kv; optional additive mask [1 or B, H, Lq, Lk]."""

        def __init__(self, d, h, p=0.0):
            super().__init__()
            self.h, self.p = h, p
            self.q, self.kv, self.o = nn.Linear(d, d), nn.Linear(d, 2 * d), nn.Linear(d, d)

        def forward(self, x, kv, mask=None):
            B, Lq, D = x.shape
            Lk = kv.shape[1]
            q = self.q(x).view(B, Lq, self.h, -1).transpose(1, 2)
            k, v = self.kv(kv).view(B, Lk, 2, self.h, -1).permute(2, 0, 3, 1, 4)
            o = F.scaled_dot_product_attention(q, k, v, attn_mask=mask, dropout_p=self.p if self.training else 0.0)
            return self.o(o.transpose(1, 2).reshape(B, Lq, D))

    class FrameEnc(nn.Module):
        def __init__(self, d=256, n_lat=24, heads=8, dout=512, p=0.1):
            super().__init__()
            self.ln_in = nn.LayerNorm(DIM)
            self.proj = nn.Linear(DIM, d)
            self.pos = nn.Parameter(torch.randn(N_TOK, d) * 0.02)
            self.lat = nn.Parameter(torch.randn(n_lat, d) * 0.02)
            self.ln_q, self.ln_kv = nn.LayerNorm(d), nn.LayerNorm(d)
            self.xattn = Attn(d, heads)
            self.mlp1 = MLP(d, 4 * d, p)
            self.ln_s = nn.LayerNorm(d)
            self.sattn = Attn(d, heads)
            self.mlp2 = MLP(d, 4 * d, p)
            self.out = nn.Sequential(nn.LayerNorm(n_lat * d), nn.Dropout(p), nn.Linear(n_lat * d, dout))
            self.aux = nn.Linear(4, dout)

        def forward(self, tok, aux):  # tok [N, 651, 384] float, aux [N, 4]
            x = self.proj(self.ln_in(tok)) + self.pos
            q = self.lat.expand(x.shape[0], -1, -1)
            q = q + self.xattn(self.ln_q(q), self.ln_kv(x))
            q = self.mlp1(q)
            s = self.ln_s(q)
            q = q + self.sattn(s, s)
            q = self.mlp2(q)
            return self.out(q.flatten(1)) + self.aux(aux)

    class TBlock(nn.Module):
        def __init__(self, d, h, p):
            super().__init__()
            self.ln = nn.LayerNorm(d)
            self.attn = Attn(d, h, p)
            self.mlp = MLP(d, 4 * d, p)
            self.drop = nn.Dropout(p)

        def forward(self, x, mask):
            s = self.ln(x)
            x = x + self.drop(self.attn(s, s, mask))
            return self.mlp(x)

    class Teacher(nn.Module):
        def __init__(self, d=512, heads=8, layers=4, p=0.1):
            super().__init__()
            self.enc = FrameEnc(dout=d, p=p)
            self.heads = heads
            self.rel = nn.Parameter(torch.zeros(layers, heads, T_HIST))
            self.blocks = nn.ModuleList([TBlock(d, heads, p) for _ in range(layers)])
            self.ln = nn.LayerNorm(d)
            self.h_cls, self.h_col, self.h_tte = nn.Linear(d, N_CLASS), nn.Linear(d, 3), nn.Linear(d, N_TTE)

        def masks(self, L, device):
            i = torch.arange(L, device=device)
            rel = i[:, None] - i[None, :]                       # query - key
            ok = (rel >= 0) & (rel < T_HIST)
            idx = rel.clamp(0, T_HIST - 1)
            out = []
            for li in range(len(self.blocks)):
                m = self.rel[li][:, idx]                        # [H, L, L]
                out.append(m.masked_fill(~ok, float("-inf"))[None])
            return out

        def forward(self, tok, sc, aux, dup_mask=None, micro=1024):
            B, L = tok.shape[:2]
            if dup_mask is not None:            # augmentation: frame t repeats frame t-1, motion 0, dup flag 1
                src = torch.arange(L, device=tok.device).expand(B, L) - dup_mask.long()
                bi = torch.arange(B, device=tok.device)[:, None]
                tok, sc = tok[bi, src], sc[bi, src]
                aux = torch.where(dup_mask[..., None], torch.tensor([0., 0., 0., 1.], device=aux.device), aux)
            x = tok.reshape(B * L, N_TOK, DIM).to(torch.bfloat16) * sc.reshape(B * L, N_TOK, 1).to(torch.bfloat16)
            a = aux.reshape(B * L, 4)
            embs = []
            for s in range(0, B * L, micro):
                embs.append(self.enc(x[s:s + micro], a[s:s + micro]))
            e = torch.cat(embs).view(B, L, -1)
            ms = self.masks(L, tok.device)
            for blk, m in zip(self.blocks, ms):
                e = blk(e, m.to(e.dtype))
            e = self.ln(e)
            return self.h_cls(e), self.h_col(e), self.h_tte(e)

    return Teacher()


# ---------------------------------------------------------------- train / predict

def run_epoch(model, loader, opt=None, sched=None, dup_p=0.0):
    import torch
    import torch.nn.functional as F
    train = opt is not None
    model.train(train)
    tot = collections.Counter()
    t0 = time.time()
    for step, (tok, sc, aux, y, lm, _) in enumerate(loader):
        if step % 100 == 0 and step:
            print(f"  step {step} {time.time() - t0:.0f}s mem {torch.cuda.max_memory_allocated() / 1e9:.1f} GB", flush=True)
        dm = None
        if train and dup_p > 0:
            dm = torch.rand(lm.shape, device=lm.device) < dup_p
            dm[:, 0] = False
        with torch.autocast("cuda", dtype=torch.bfloat16), torch.set_grad_enabled(train):
            lc, lo, lt = model(tok, sc, aux, dm)
        yy = torch.where(lm[..., None], y, torch.full_like(y, -100))
        l1 = F.cross_entropy(lc.float().flatten(0, 1), yy[..., 0].flatten(), ignore_index=-100, reduction="sum")
        l2 = F.cross_entropy(lo.float().flatten(0, 1), yy[..., 1].flatten(), ignore_index=-100, reduction="sum")
        l3 = F.cross_entropy(lt.float().flatten(0, 1), yy[..., 2].flatten(), ignore_index=-100, reduction="sum")
        n1 = (yy[..., 0] >= 0).sum().clamp_min(1)
        n2 = (yy[..., 1] >= 0).sum().clamp_min(1)
        n3 = (yy[..., 2] >= 0).sum().clamp_min(1)
        loss = l1 / n1 + l2 / n2 + 0.5 * l3 / n3
        if train:
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
        with torch.no_grad():
            tot["l_cls"] += l1.item()
            tot["n_cls"] += n1.item()
            tot["l_col"] += l2.item()
            tot["n_col"] += n2.item()
            tot["l_tte"] += l3.item()
            tot["n_tte"] += n3.item()
            m = yy[..., 0] >= 0
            tot["acc_cls"] += (lc.argmax(-1)[m] == yy[..., 0][m]).sum().item()
            m = yy[..., 1] >= 0
            tot["acc_col"] += (lo.argmax(-1)[m] == yy[..., 1][m]).sum().item()
    r = {k: tot[f"l_{k}"] / max(tot[f"n_{k}"], 1) for k in ("cls", "col", "tte")}
    r["loss"] = r["cls"] + r["col"] + 0.5 * r["tte"]
    r["acc_cls"] = tot["acc_cls"] / max(tot["n_cls"], 1)
    r["acc_col"] = tot["acc_col"] / max(tot["n_col"], 1)
    return {k: round(v, 4) for k, v in r.items()}


def predict(model, loader, recs):
    """-> {rec: array [n_cached, 45 + 3 + 47] float16 of softmax outputs, NaN where not produced}."""
    import torch
    model.eval()
    out = {r: np.full((len(recs[r].frames), N_CLASS + 3 + N_TTE), np.nan, np.float16) for r in
           {it[0] for it in loader.items}}
    with torch.no_grad():
        for tok, sc, aux, y, lm, b in loader:
            with torch.autocast("cuda", dtype=torch.bfloat16):
                lc, lo, lt = model(tok, sc, aux)
            p = torch.cat([lc.float().softmax(-1), lo.float().softmax(-1), lt.float().softmax(-1)], -1).cpu().numpy()
            lmn = lm.cpu().numpy()
            for j, (rec, a, e, _) in enumerate(b):
                n = e - a
                m = lmn[j, :n]
                out[rec][a:e][m] = p[j, :n][m]
    return out


def main() -> None:
    import torch
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--folds", default=",".join(str(k) for k in range(N_FOLDS)))
    ap.add_argument("--epochs", type=int, default=16)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--tag", default="teacher")
    ap.add_argument("--limit", type=int, default=0, help="debug: only the first N recordings")
    a = ap.parse_args()
    torch.backends.cuda.matmul.allow_tf32 = True
    t0 = time.time()
    d = load()
    fold = folds(d["recs"], d["events"])
    byrec = collections.defaultdict(list)
    for e in d["events"]:
        byrec[e["rec"]].append(e)
    rlist = d["recs"][:a.limit] if a.limit else d["recs"]
    recs = {r["rec"]: Rec(r, byrec.get(r["rec"], [])) for r in rlist}
    print(f"loaded {len(recs)} recordings, {sum(len(r.frames) for r in recs.values())} frames, "
          f"{sum(len(r.chunks) for r in recs.values())} chunks, {time.time() - t0:.0f}s", flush=True)
    odir = TEACHER / a.tag
    odir.mkdir(parents=True, exist_ok=True)
    logp = odir / "log.json"
    log = json.loads(logp.read_text(encoding="utf-8")) if logp.exists() else {}
    log["args"] = vars(a)
    for k in [int(x) for x in a.folds.split(",")]:
        test = [r for r in recs if fold[r] == k]
        trainval = sorted(r for r in recs if fold[r] != k)
        rng = np.random.default_rng(100 + k)
        val = set(rng.choice(trainval, max(1, len(trainval) // 10), replace=False).tolist())
        train = [r for r in trainval if r not in val]
        items = lambda rs: [(r, s, e, f) for r in rs for (s, e, f) in recs[r].chunks]  # noqa: E731
        tl = Loader(recs, items(train), a.batch, True, seed=k)
        vl = Loader(recs, items(sorted(val)), a.batch, False, seed=0)
        torch.manual_seed(k)
        model = build_model().cuda()
        nparam = sum(p.numel() for p in model.parameters())
        opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.05, betas=(0.9, 0.95))
        steps = a.epochs * len(tl.batches())
        warm = len(tl.batches())
        sched = torch.optim.lr_scheduler.LambdaLR(
            opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(s, steps) / steps)))
        best, hist = None, []
        for ep in range(a.epochs):
            te = time.time()
            tr = run_epoch(model, tl, opt, sched, dup_p=0.1)
            va = run_epoch(model, vl)
            hist.append({"epoch": ep, "train": tr, "val": va, "sec": round(time.time() - te, 1)})
            print(f"fold {k} ep {ep} train {tr} val {va} {time.time() - te:.0f}s", flush=True)
            if best is None or va["loss"] < best[0]:
                best = (va["loss"], ep)
                torch.save(model.state_dict(), odir / f"fold{k}.pt")
        model.load_state_dict(torch.load(odir / f"fold{k}.pt"))
        pl = Loader(recs, items(test), a.batch, False, seed=0, infer=True)
        outs = predict(model, pl, recs)
        # gather per contact at STORE_OFFS
        ids, P, V = [], [], []
        for r in test:
            R = recs[r]
            for e in byrec.get(r, []):
                ids.append(e["id"])
                rows = [R.row_of.get(e["frame"] + o, -1) for o in STORE_OFFS]
                p = np.full((len(STORE_OFFS), N_CLASS + 3 + N_TTE), np.nan, np.float16)
                for j, rw in enumerate(rows):
                    if rw >= 0:
                        p[j] = outs[r][rw]
                P.append(p)
                V.append(~np.isnan(p[:, 0]))
        P = np.stack(P)
        np.savez_compressed(odir / f"oof_fold{k}.npz", ids=np.array(ids), offs=np.array(STORE_OFFS),
                            p_cls=np.nan_to_num(P[..., :N_CLASS]), p_col=np.nan_to_num(P[..., N_CLASS:N_CLASS + 3]),
                            p_tte=np.nan_to_num(P[..., N_CLASS + 3:]), valid=np.stack(V),
                            fold=np.full(len(ids), k))
        log[str(k)] = {"best_epoch": best[1], "best_val_loss": best[0], "train_recs": len(train), "val_recs": len(val),
                       "test_recs": len(test), "params": nparam, "history": hist,
                       "sec": round(sum(h["sec"] for h in hist), 1)}
        write_json(logp, log)
        print(f"fold {k} done: best epoch {best[1]} val {best[0]:.4f}; {len(ids)} contacts", flush=True)
        del model, opt
        torch.cuda.empty_cache()
    # merge if all folds exist
    parts = [odir / f"oof_fold{k}.npz" for k in range(N_FOLDS)]
    if all(p.exists() for p in parts) and not a.limit:
        zs = [np.load(p) for p in parts]
        merged = {key: np.concatenate([z[key] for z in zs]) for key in ("ids", "p_cls", "p_col", "p_tte", "valid", "fold")}
        merged["offs"] = zs[0]["offs"]
        dst = TEACHER / ("oof.npz" if a.tag == "teacher" else f"oof_{a.tag}.npz")
        np.savez_compressed(dst, **merged)
        print("merged ->", dst)
    print(f"total {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
