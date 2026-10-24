"""Order 3b: prefix-move teacher. Same data path and network as s3_train.py (frozen DINOv3 patch-token cache, 24-latent
attention pooling per frame, 4-layer causal transformer over t-31..t), new targets and one extra input:

  heads    prefix group of the next contact (s3b_prefix.py groups, G of them, + idle), this contact's own colour (gold /
           red / none), response for this contact (dodge / parry / none = no contact coming), frames to the next
           contact (0..45, none). Response has its own head (not derived from group + colour) because it is the
           decision itself: it is trained on exactly the gate-1 label, and a contact can be in an ambiguous group yet
           have a clear response (e.g. colour); the derived version is reported next to it.
  input    + contact history (4 values per frame, from contacts already known at t with a 6-frame detection delay,
           i.e. contact c is known from c + 6 on; the HP step shows at +5/+6): frames since the last known contact,
           the two gaps before it (each /73, capped at 2; 2 = none), and how many known contacts in a row (gaps <= 73)
           end at the last one (0 if it is > 73 frames back; /4, capped at 2). This is the "contacts that already
           happened" part of the prefix, which the 32-frame window alone often does not see.
  labels   on [c - 30, c] of the next contact c: group, colour (unknown masked), response (grab ticks masked);
           idle frames (next contact > 60 away, previous >= 30 back): group idle, colour none, response none;
           tte everywhere as s3_common.frame_labels.
  loss     CE group + CE colour + CE response + 0.5 CE tte.
Training schedule, folds, augmentation, inner validation and chunking: unchanged from s3_train.py.

    uv run --no-project --with torch --with numpy --index https://download.pytorch.org/whl/cu130 \
        --index-strategy unsafe-best-match python workspaces/WhereWindsMeet/tools/dufu_moveid/s3b_train.py [--folds 0,1,2,3,4]

Out: data/moveid/teacher_prefix/teacher/fold<k>.pt, log.json, oof_fold<k>.npz -> teacher_prefix/oof.npz
(s3b_gate1.py format).
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
from s3_common import (CACHE, COLOR_IX, MOVE_PRE, N_FOLDS, N_TTE, OUT, STORE_OFFS, T_HIST, folds,  # noqa: E402
                       frame_labels, load, read_json, segments, write_json)
from s3b_gate1 import PREFIX  # noqa: E402

N_TOK, DIM = 651, 384
CH = 128
STRIDE = CH - (T_HIST - 1)
DUP_MOT = 0.3
DELAY = 6
GAP = 73.0
NY, NAUX = 4, 8
RESP_IX = {"dodge": 0, "parry": 1}


def history(n: int, fr: np.ndarray) -> np.ndarray:
    """[n, 4] contact-history features for every frame of a recording (contacts at frames fr, sorted)."""
    t = np.arange(n)
    h = np.full((n, 4), 2.0, np.float32)
    h[:, 3] = 0.0
    if len(fr) == 0:
        return h
    run = np.ones(len(fr), np.int64)
    for i in range(1, len(fr)):
        if fr[i] - fr[i - 1] <= GAP:
            run[i] = run[i - 1] + 1
    i = np.searchsorted(fr, t - DELAY, side="right") - 1
    ok = i >= 0
    ii = np.maximum(i, 0)
    h[ok, 0] = np.minimum((t - fr[ii])[ok] / GAP, 2.0)
    m1 = ok & (i >= 1)
    h[m1, 1] = np.minimum((fr[ii] - fr[np.maximum(ii - 1, 0)])[m1] / GAP, 2.0)
    m2 = ok & (i >= 2)
    h[m2, 2] = np.minimum((fr[np.maximum(ii - 1, 0)] - fr[np.maximum(ii - 2, 0)])[m2] / GAP, 2.0)
    recent = ok & ((t - fr[ii]) <= GAP)
    h[recent, 3] = np.minimum(run[ii][recent] / 4.0, 2.0)
    return h


class Rec:
    def __init__(self, r: dict, contacts: list[dict], pe: dict, G: int):
        self.rec = r["rec"]
        z = np.load(CACHE / f"{self.rec}.npz")
        self.frames = f = z["frames"]
        self.scale = z["scale"]
        self.path = CACHE / f"{self.rec}.tok"
        n = r["frames"]
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
        self.y = np.stack([grp[f], col[f], rsp[f], lab["tte"][f].astype(np.int64)], 1)
        e = np.load(OUT / "emb" / f"{self.rec}.npz")
        mot = np.stack([e["mot_glob"][f], e["mot_big"][f], e["mot_small"][f]], 1).astype(np.float32)
        dup = (mot[:, 0] < DUP_MOT).astype(np.float32)
        self.aux = np.concatenate([np.log1p(mot) / 3.0, dup[:, None], history(n, fr)[f]], 1).astype(np.float32)
        self.row_of = {int(x): i for i, x in enumerate(f)}
        self.chunks = []
        for a, b in segments(f):
            s = a
            while True:
                e_ = min(s + CH, b)
                self.chunks.append((s, e_, s == a))
                if e_ >= b:
                    break
                s += STRIDE


class Loader:
    """as s3_train.Loader, with NY targets and NAUX aux values per frame."""

    def __init__(self, recs, items, batch, shuffle, seed, threads=8, infer=False):
        self.recs, self.items, self.batch, self.shuffle, self.infer = recs, items, batch, shuffle, infer
        self.rng = np.random.default_rng(seed)
        self.pool = ThreadPoolExecutor(threads)

    def batches(self):
        items = list(self.items)
        if self.shuffle:
            self.rng.shuffle(items)
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
        with open(r.path, "rb", buffering=0) as fh:
            fh.seek(a * N_TOK * DIM)
            mv = memoryview(buf.numpy()).cast("B")[off * N_TOK * DIM:off * N_TOK * DIM + n]
            got = fh.readinto(mv)
            assert got == n, (rec, a, b, got, n)

    def __iter__(self):
        import torch
        bl = self.batches()
        q: queue.Queue = queue.Queue(maxsize=1)
        nbuf = 3
        bufs = [torch.empty((self.batch * CH, N_TOK, DIM), dtype=torch.int8).pin_memory() for _ in range(nbuf)]

        def produce():
            for i, b in enumerate(bl):
                buf = bufs[i % nbuf]
                L = max(it[2] - it[1] for it in b)
                offs = [j * L for j in range(len(b))]
                futs = [self.pool.submit(self._read, it, buf, o) for it, o in zip(b, offs)]
                sc = np.zeros((len(b), L, N_TOK), np.float16)
                aux = np.zeros((len(b), L, NAUX), np.float32)
                y = np.full((len(b), L, NY), -100, np.int64)
                lm = np.zeros((len(b), L), bool)
                for j, (rec, a, e, first) in enumerate(b):
                    r = self.recs[rec]
                    n = e - a
                    sc[j, :n] = r.scale[a:e]
                    aux[j, :n] = r.aux[a:e]
                    y[j, :n] = r.y[a:e]
                    lm[j, T_HIST - 1:n] = True
                    if first and self.infer:
                        lm[j, :n] = True
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


def build_model(G: int):
    """s3_train's Teacher with the aux input widened to NAUX and the heads replaced."""
    import torch
    import torch.nn as nn
    from s3_train import build_model as base_model

    class PrefixTeacher(nn.Module):
        def __init__(self):
            super().__init__()
            b = base_model()
            d = b.ln.normalized_shape[0]
            b.enc.aux = nn.Linear(NAUX, d)
            self.b = b
            self.h_grp, self.h_col, self.h_resp, self.h_tte = (nn.Linear(d, G + 1), nn.Linear(d, 3), nn.Linear(d, 3),
                                                               nn.Linear(d, N_TTE))
            del b.h_cls, b.h_col, b.h_tte

        def forward(self, tok, sc, aux, dup_mask=None, micro=1024):
            b = self.b
            B, L = tok.shape[:2]
            if dup_mask is not None:     # frame t repeats t-1 (tokens, scale), motion 0, dup 1; history stays
                src = torch.arange(L, device=tok.device).expand(B, L) - dup_mask.long()
                bi = torch.arange(B, device=tok.device)[:, None]
                tok, sc = tok[bi, src], sc[bi, src]
                rep = torch.cat([torch.tensor([0., 0., 0., 1.], device=aux.device).expand(B, L, 4), aux[..., 4:]], -1)
                aux = torch.where(dup_mask[..., None], rep, aux)
            x = tok.reshape(B * L, N_TOK, DIM).to(torch.bfloat16) * sc.reshape(B * L, N_TOK, 1).to(torch.bfloat16)
            a = aux.reshape(B * L, NAUX)
            e = torch.cat([b.enc(x[s:s + micro], a[s:s + micro]) for s in range(0, B * L, micro)]).view(B, L, -1)
            for blk, m in zip(b.blocks, b.masks(L, tok.device)):
                e = blk(e, m.to(e.dtype))
            e = b.ln(e)
            return self.h_grp(e), self.h_col(e), self.h_resp(e), self.h_tte(e)

    return PrefixTeacher()


W = (1.0, 1.0, 1.0, 0.5)
NAMES = ("grp", "col", "resp", "tte")


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
            outs = model(tok, sc, aux, dm)
        yy = torch.where(lm[..., None], y, torch.full_like(y, -100))
        loss = 0.0
        for i, (o, w, nm) in enumerate(zip(outs, W, NAMES)):
            t = yy[..., i]
            li = F.cross_entropy(o.float().flatten(0, 1), t.flatten(), ignore_index=-100, reduction="sum")
            ni = (t >= 0).sum().clamp_min(1)
            loss = loss + w * li / ni
            with torch.no_grad():
                tot["l_" + nm] += li.item()
                tot["n_" + nm] += ni.item()
                m = t >= 0
                tot["acc_" + nm] += (o.argmax(-1)[m] == t[m]).sum().item()
        if train:
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
    r = {nm: tot["l_" + nm] / max(tot["n_" + nm], 1) for nm in NAMES}
    r["loss"] = sum(w * r[nm] for w, nm in zip(W, NAMES))
    for nm in NAMES[:3]:
        r["acc_" + nm] = tot["acc_" + nm] / max(tot["n_" + nm], 1)
    return {k: round(v, 4) for k, v in r.items()}


def predict(model, loader, recs, G):
    import torch
    model.eval()
    width = G + 1 + 3 + 3 + N_TTE
    out = {r: np.full((len(recs[r].frames), width), np.nan, np.float16) for r in {it[0] for it in loader.items}}
    with torch.no_grad():
        for tok, sc, aux, y, lm, b in loader:
            with torch.autocast("cuda", dtype=torch.bfloat16):
                outs = model(tok, sc, aux)
            p = torch.cat([o.float().softmax(-1) for o in outs], -1).cpu().numpy()
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
    prefix = read_json(PREFIX / "prefix.json")
    pe = prefix["events"]
    G = len(prefix["groups"])
    fold = folds(d["recs"], d["events"])
    byrec = collections.defaultdict(list)
    for e in d["events"]:
        byrec[e["rec"]].append(e)
    rlist = d["recs"][:a.limit] if a.limit else d["recs"]
    recs = {r["rec"]: Rec(r, byrec.get(r["rec"], []), pe, G) for r in rlist}
    print(f"loaded {len(recs)} recordings, {sum(len(r.frames) for r in recs.values())} frames, "
          f"{sum(len(r.chunks) for r in recs.values())} chunks, G={G}, {time.time() - t0:.0f}s", flush=True)
    odir = PREFIX / a.tag
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
        model = build_model(G).cuda()
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
        outs = predict(model, pl, recs, G)
        ids, P = [], []
        for r in test:
            R = recs[r]
            for e in byrec.get(r, []):
                ids.append(e["id"])
                p = np.full((len(STORE_OFFS), outs[r].shape[1]), np.nan, np.float16)
                for j, o in enumerate(STORE_OFFS):
                    rw = R.row_of.get(e["frame"] + o, -1)
                    if rw >= 0:
                        p[j] = outs[r][rw]
                P.append(p)
        P = np.stack(P)
        V = ~np.isnan(P[..., 0])
        P = np.nan_to_num(P)
        s1, s2, s3 = G + 1, G + 4, G + 7
        np.savez_compressed(odir / f"oof_fold{k}.npz", ids=np.array(ids), offs=np.array(STORE_OFFS),
                            p_grp=P[..., :s1], p_col=P[..., s1:s2], p_resp=P[..., s2:s3], p_tte=P[..., s3:],
                            valid=V, fold=np.full(len(ids), k))
        log[str(k)] = {"best_epoch": best[1], "best_val_loss": best[0], "train_recs": len(train), "val_recs": len(val),
                       "test_recs": len(test), "params": nparam, "history": hist,
                       "sec": round(sum(h["sec"] for h in hist), 1)}
        write_json(logp, log)
        print(f"fold {k} done: best epoch {best[1]} val {best[0]:.4f}; {len(ids)} contacts", flush=True)
        del model, opt
        torch.cuda.empty_cache()
    parts = [odir / f"oof_fold{k}.npz" for k in range(N_FOLDS)]
    if all(p.exists() for p in parts) and not a.limit:
        zs = [np.load(p) for p in parts]
        merged = {key: np.concatenate([z[key] for z in zs])
                  for key in ("ids", "p_grp", "p_col", "p_resp", "p_tte", "valid", "fold")}
        merged["offs"] = zs[0]["offs"]
        dst = PREFIX / ("oof.npz" if a.tag == "teacher" else f"oof_{a.tag}.npz")
        np.savez_compressed(dst, **merged)
        print("merged ->", dst)
    print(f"total {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
