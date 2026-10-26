"""Order 5 (关 2 专攻): fine-tune the student on the live dufu2 rounds (recordings + truth contacts + colour), from its
own weights, nothing frozen. The original 197 rounds stay in the mix with their teacher soft labels (as s4_train).

    D=workspaces/WhereWindsMeet/tools/dufu_moveid
    TORCH="uv run --no-project --with torch --with timm --with numpy --with av --with opencv-python-headless \
        --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match"
    $TORCH python $D/s5_retrain.py cache  r003 ... r045                 # live views (s4_cache.process), student/views
    $TORCH python $D/s5_retrain.py train --base final --tag live1 --live r003 ... --val r040 ...
    $TORCH python $D/s5_retrain.py train --base fold2 --tag live1_fold2 --live ... --val ...   # + fold-2 OOF
    $TORCH python $D/s5_retrain.py eval --val r040 ... --models final,live1                       # held-out live rounds

Live rounds: data/moveid/live/rNNN with contacts.json (s5_analyze.py) and the recording (s5_pull.py).
Labels per video frame (same heads and rules as s4_common.labels / s3b_train):
  tte    s3_common.frame_labels on the truth contacts (video hp steps -> hit, 真气 steps after our 卸势 -> ok).
  group  on [c - 30, c]: the prefix group the device named at decision time (contacts.json dec.grp; the device
         student's own label, i.e. self-training: the live data has no taxonomy assignment); "unrecognised" -> masked.
         Soft target = the base model's own group output (KL), so the group head is held where it was.
  colour on [c - 30, c]: the truth colour of c (s5_color classifier on the recording); unknown -> masked.
  resp   on [c - 30, c]: dodge if the colour is gold, the group is unparryable in the move table, the group is a
         火球雨 (c7) group, or c is in a 金光火球 window (8..150 f after a k0:c11+c40 contact / dodge: the teacher's rule,
         only dodge); else parry. Grab-cutscene ticks: masked.
  idle   frames as frame_labels: group idle, colour none, resp none.
  masked a dodged blow and a run leave no contact, so "no contact" there is not known: every label is masked on
         [p - 45, p + 25] around each real dodge press with no truth contact in [p, p + 25], and on every run (+30 f).
  history s3b_train.history on the truth contact frames (the device's live detection is close to it, s5 README).
Frames cached = s3_common.frame_plan on the truth contacts (as the teacher / student caches).
Training: s4_train.Loader / run_epoch unchanged; base weights = student/<base>.pt; original rounds: soft fold k
(base fold<k>: its test fold left out entirely) or the 5-teacher mean (base final); live rounds: soft = grp only
(other heads 0: hard labels only). AdamW lr --lr (default 3e-4, heads x2), warm-up half an epoch + cosine,
--epochs (2). Best epoch by the live validation rounds' hard loss. Out: student/<tag>.pt, student/live_log.json.
eval: per model, on the --val rounds' cached frames (front-padded segments, fp32), at every non-grab truth contact c:
response at c - 10 (argmax) vs the label, "armed" (some frame in [c - 12, c - 3] with median tte <= 15 and
P(resp none) <= 0.6, dufu2's press condition), |tte median - truth| at c - 10; on idle frames the armed rate.
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from s3_common import (  # noqa: E402
    COLOR_IX,
    MOVE_PRE,
    N_FOLDS,
    OUT,
    folds,
    frame_labels,
    frame_plan,
    load,
    read_json,
    segments,
    write_json,
)
from s4_common import SOFT, STUDENT, VBYTES, VIEWS, heads, no_throttle, view_file  # noqa: E402

LIVE = OUT / "live"
TABLE = read_json(HERE.parents[1] / "model" / "dufu2" / "movetable.json")
GN = list(TABLE["groups"])
C11 = "k0:c11+c40"
RESP = {"dodge": 0, "parry": 1}
LOG = STUDENT / "live_log.json"


def live_info(rn: str) -> dict:
    d = LIVE / rn
    rid = (d / "rec.txt").read_text(encoding="utf-8").strip()
    st = read_json(LIVE / "pull_status.json")[rid]
    return {"round": rn, "rec": rid, "frames": int(st["frames"]), "video": str(LIVE / "video" / f"{rid}.mp4"),
            "contacts": read_json(d / "contacts.json"), "result": read_json(d / "result.json")["value"],
            "meta": read_json(LIVE / "meta" / f"{rid}.json")}


def live_labels(info: dict, G: int) -> tuple[np.ndarray, np.ndarray, list[dict]]:
    """-> y [n, 4] (grp, col, resp, tte), truth contact frames (sorted), the contacts used for frame_plan."""
    n = info["frames"]
    con = info["contacts"]
    truth = sorted(con["truth"], key=lambda t: t["frame"])
    res = info["result"]
    k0 = (res["start"] - info["meta"]["started"]) / (1000 / 30)
    vf = lambda t: k0 + t / (1000 / 30) + con["offset"]  # noqa: E731
    cs = [{"frame": int(t["frame"]), "cls": 0, "chain_color": t["colour"]} for t in truth]
    lab = frame_labels(n, cs)
    y = np.full((n, 4), -100, np.int64)
    y[:, 3] = lab["tte"]
    anchors = [t["frame"] for t in truth if (t.get("dec") or {}).get("grp") == C11]
    anchors += [vf(p[0]) + 5 for p in res["pressLog"] if p[1] == "dodge" and p[2] is not None and 0 <= p[2] < len(GN) and GN[p[2]] == C11]
    nxt = lab["next"]
    fr = np.array([c["frame"] for c in cs], np.int64)
    t_ = np.arange(n)
    dist = np.where(nxt >= 0, fr[np.maximum(nxt, 0)] - t_ if len(fr) else 0, 10 ** 6)
    for i in np.nonzero((nxt >= 0) & (dist <= MOVE_PRE))[0]:
        t = truth[nxt[i]]
        dec = t.get("dec") or {}
        g = dec.get("grp")
        gid = GN.index(g) if g in GN else -100
        y[i, 0] = gid
        y[i, 1] = COLOR_IX.get(t["colour"], -100)
        row = TABLE["groups"].get(g) if g in GN else None
        if t.get("grab"):
            y[i, 2] = -100
        elif t["colour"] == "gold" or (row and row["unparryable"]) or (g and g.split(":")[-1] == "c7") \
                or any(8 < t["frame"] - a <= 150 for a in anchors):
            y[i, 2] = RESP["dodge"]
        elif row is None:
            y[i, 2] = -100
        else:
            y[i, 2] = RESP["parry"]
    idle = lab["idle"]
    y[idle, 0], y[idle, 1], y[idle, 2] = G, COLOR_IX["none"], 2
    # masks: dodged blows and runs leave no contact
    tf = fr.astype(np.float64)
    m = np.zeros(n, bool)
    for p in res["pressLog"]:
        if p[1] != "dodge":
            continue
        f = vf(p[0])
        if not np.any((tf - f >= 0) & (tf - f <= 25)):
            m[max(0, int(f - 45)):int(f + 26)] = True
    for r in (res.get("run") or {}).get("runs") or []:
        f0 = vf(r[0])
        m[max(0, int(f0 - 10)):int(f0 + r[3] / (1000 / 30) + 31)] = True
    y[m] = -100
    return y, fr, cs


class LiveRec:
    """s4_train.Rec for a live round (same attributes)."""

    def __init__(self, info: dict, G: int):
        from s3b_train import history
        self.rec = info["rec"]
        self.round = info["round"]
        z = np.load(VIEWS / f"{self.rec}.npz")
        self.frames = f = z["frames"]
        y, fr, _ = live_labels(info, G)
        self.y = y[f]
        self.hist = history(info["frames"], fr)[f]
        self.path = view_file(self.rec)
        assert self.path.stat().st_size == len(f) * VBYTES, self.rec
        self.soft = None
        self.row_of = {int(x): i for i, x in enumerate(f)}
        from s4_train import CH, STRIDE
        self.chunks = []
        for a, b in segments(f):
            s = a
            while True:
                e = min(s + CH, b)
                self.chunks.append((s, e, s == a))
                if e >= b:
                    break
                s += STRIDE


def cmd_cache(a) -> None:
    from concurrent.futures import ProcessPoolExecutor, as_completed

    from s4_cache import process
    no_throttle()
    stp = VIEWS / "live_status.json"
    st = read_json(stp) if stp.exists() else {}
    todo = []
    for rn in a.rounds:
        info = live_info(rn)
        G = len(read_json(OUT / "teacher_prefix" / "prefix.json")["groups"])
        _, _, cs = live_labels(info, G)
        frames = frame_plan(info["frames"], cs)
        f = view_file(info["rec"])
        if st.get(info["rec"], {}).get("ok") and f.exists() and f.stat().st_size == len(frames) * VBYTES:
            continue
        todo.append((info, frames))
    print(f"{len(todo)} live recordings to cache, {sum(len(x) for _, x in todo)} frames", flush=True)
    with ProcessPoolExecutor(a.procs) as ex:
        futs = {ex.submit(process, i["rec"], i["video"], fr, i["frames"]): i for i, fr in todo}
        for fu in as_completed(futs):
            r = fu.result()
            r["round"] = futs[fu]["round"]
            st[r["rec"]] = r
            write_json(stp, st)
            print(r, flush=True)


def build_recs(G: int, live_rounds: list[str], base: str):
    """original recs (s4_train.Rec, soft per base) + live recs -> (recs, orig names, live names by round, test fold)."""
    from s3b_gate1 import PREFIX
    from s4_train import Rec
    d = load()
    prefix = read_json(PREFIX / "prefix.json")
    pe = prefix["events"]
    fold = folds(d["recs"], d["events"])
    byrec = collections.defaultdict(list)
    for e in d["events"]:
        byrec[e["rec"]].append(e)
    recs = {r["rec"]: Rec(r, byrec.get(r["rec"], []), pe, G) for r in d["recs"]}
    k = int(base[4:]) if base.startswith("fold") else None
    if k is None:
        zs = [np.load(SOFT / f"fold{j}.npz") for j in range(N_FOLDS)]
        for r in recs.values():
            r.soft = np.mean([z[r.rec].astype(np.float32) for z in zs], 0).astype(np.float16)
    else:
        z = np.load(SOFT / f"fold{k}.npz")
        for r in recs.values():
            r.soft = z[r.rec] if fold[r.rec] != k else None
    orig = sorted(r for r in recs if k is None or fold[r] != k)
    test = sorted(r for r in recs if k is not None and fold[r] == k)
    live = {}
    for rn in live_rounds:
        lr = LiveRec(live_info(rn), G)
        recs[lr.rec] = lr
        live[rn] = lr.rec
    return recs, orig, live, test, byrec


def live_soft(model, recs, names, G):
    """the model's own group output on the live frames; the other heads' soft targets are 0 (s4_train.run_epoch then
    adds KL 0 there: hard labels only; NaN would poison the loss, NaN * 0 = NaN)."""
    from s4_train import predict
    out = predict(model, recs, names, G)
    s1 = G + 1
    for r in names:
        p = np.nan_to_num(out[r])
        p[:, s1:] = 0
        recs[r].soft = p
    return out


def cmd_train(a) -> None:
    import math

    import torch

    from s3b_gate1 import PREFIX
    from s4_common import build
    from s4_train import Loader, oof_rows, predict, run_epoch, save_oof
    sys.stdout.reconfigure(encoding="utf-8")
    no_throttle()
    torch.backends.cudnn.benchmark = False
    torch.backends.cuda.matmul.allow_tf32 = True
    t0 = time.time()
    G = len(read_json(PREFIX / "prefix.json")["groups"])
    recs, orig, live, test, byrec = build_recs(G, sorted(set(a.live) | set(a.val)), a.base)
    model = build(G, pretrained=False).cuda().to(memory_format=torch.channels_last)
    model.load_state_dict(torch.load(STUDENT / f"{a.base}.pt"))
    live_soft(model, recs, list(live.values()), G)
    tr_live = [live[r] for r in a.live if r not in a.val]
    va_live = [live[r] for r in a.val]
    items = lambda rs: [(r, s, e, f) for r in rs for (s, e, f) in recs[r].chunks]  # noqa: E731
    train = orig + tr_live * a.live_rep
    tl = Loader(recs, items(train), a.batch, True, seed=a.seed)
    vl = Loader(recs, items(va_live), a.batch, False, seed=0)
    print(f"{len(orig)} original + {len(tr_live)} live (x{a.live_rep}) training recordings, {len(va_live)} live val; "
          f"{len(tl.batches())} batches/epoch, {time.time() - t0:.0f}s", flush=True)
    head_p = [p for n, p in model.named_parameters() if n.startswith("head.") or ".fc." in n or ".sp." in n]
    ids = {id(p) for p in head_p}
    body_p = [p for p in model.parameters() if id(p) not in ids]
    opt = torch.optim.AdamW([{"params": body_p, "lr": a.lr}, {"params": head_p, "lr": a.lr * 2}], weight_decay=0.02,
                            betas=(0.9, 0.99))
    nb = len(tl.batches())
    steps, warm = a.epochs * nb, max(1, nb // 2)
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt, lambda s: min(1.0, (s + 1) / warm) * 0.5 * (1 + math.cos(math.pi * min(s, steps) / steps)))
    log = read_json(LOG) if LOG.exists() else {}
    hist = []
    va0 = run_epoch(model, vl, G)
    print("val before", va0, flush=True)
    best = (va0["loss"], -1)
    dst = STUDENT / f"{a.tag}.pt"
    torch.save(model.state_dict(), dst)
    for ep in range(a.epochs):
        te = time.time()
        tr = run_epoch(model, tl, G, opt, sched, kd=a.kd)
        va = run_epoch(model, vl, G)
        hist.append({"epoch": ep, "train": tr, "val": va, "sec": round(time.time() - te, 1)})
        print(f"{a.tag} ep {ep} train {tr} val {va} {time.time() - te:.0f}s", flush=True)
        if va["loss"] < best[0]:
            best = (va["loss"], ep)
            torch.save(model.state_dict(), dst)
        log[a.tag] = {"args": vars(a), "val_before": va0, "history": hist, "best_epoch": best[1],
                      "train_live": a.live, "val_live": a.val}
        write_json(LOG, log)
    model.load_state_dict(torch.load(dst))
    if test:  # the base fold's original test rounds: OOF (s3b_gate1 format)
        outs = predict(model, recs, test, G)
        idsr, P = oof_rows(outs, recs, test, byrec)
        k = int(a.base[4:])
        save_oof(STUDENT / f"oof_{a.tag}.npz", idsr, P, G, k)
        print("oof ->", STUDENT / f"oof_{a.tag}.npz", flush=True)
    print(f"total {time.time() - t0:.0f}s")


def cmd_eval(a) -> None:
    import torch

    from s3b_gate1 import PREFIX
    from s4_common import build
    from s4_train import predict
    sys.stdout.reconfigure(encoding="utf-8")
    G = len(read_json(PREFIX / "prefix.json")["groups"])
    hs = {nm: (s, e) for nm, s, e in heads(G)}
    infos = {rn: live_info(rn) for rn in a.val}
    recs = {}
    for rn, info in infos.items():
        lr = LiveRec(info, G)
        recs[lr.rec] = lr
    out = {}
    for mname in a.models.split(","):
        model = build(G, pretrained=False).cuda().to(memory_format=torch.channels_last)
        model.load_state_dict(torch.load(STUDENT / f"{mname}.pt"))
        P = predict(model, recs, list(recs), G)
        c = collections.Counter()
        errs = []
        for rn, info in infos.items():
            rec = info["rec"]
            R = recs[rec]
            p = P[rec].astype(np.float32)
            y_full, _, _ = live_labels(info, G)
            tte = p[:, hs["tte"][0]:hs["tte"][1]]
            med = (np.cumsum(tte, 1) >= 0.5).argmax(1)
            rsp = p[:, hs["resp"][0]:hs["resp"][1]]
            armed = (med <= 15) & (rsp[:, 2] <= 0.6)
            for t in info["contacts"]["truth"]:
                if t.get("grab"):
                    continue
                f = int(t["frame"])
                i = R.row_of.get(f - 10)
                if i is None:
                    continue
                lab = y_full[f - 10, 2]
                c["n"] += 1
                c["hit"] += t["kind"] == "hit"
                rows = [R.row_of[x] for x in range(f - 12, f - 2) if x in R.row_of]
                arm = bool(armed[rows].any()) if rows else False
                c["armed"] += arm
                c["armed_hit"] += arm and t["kind"] == "hit"
                if lab >= 0:
                    c["resp_n"] += 1
                    c["resp_ok"] += int(rsp[i].argmax() == lab)
                    if lab == 0:
                        c["dodge_n"] += 1
                        c["dodge_ok"] += int(rsp[i].argmax() == 0)
                if med[i] <= 45:
                    errs.append(abs(int(med[i]) - 10))
            idle = R.y[:, 0] == G
            c["idle_rows"] += int(idle.sum())
            c["idle_armed"] += int((idle & armed).sum())
        out[mname] = {**c, "resp_rate": round(c["resp_ok"] / max(c["resp_n"], 1), 4),
                      "dodge_rate": round(c["dodge_ok"] / max(c["dodge_n"], 1), 4),
                      "armed_rate": round(c["armed"] / max(c["n"], 1), 4),
                      "armed_hit_rate": round(c["armed_hit"] / max(c["hit"], 1), 4),
                      "idle_armed_rate": round(c["idle_armed"] / max(c["idle_rows"], 1), 4),
                      "tte_abs_err_p50_p90": [float(np.percentile(errs, 50)), float(np.percentile(errs, 90))] if errs else None}
        print(mname, json.dumps(out[mname]), flush=True)
        del model
        torch.cuda.empty_cache()
    if a.out:
        write_json(Path(a.out), {"val": a.val, "models": out})


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cache")
    c.add_argument("rounds", nargs="+")
    c.add_argument("--procs", type=int, default=6)
    t = sub.add_parser("train")
    t.add_argument("--base", default="final")
    t.add_argument("--tag", required=True)
    t.add_argument("--live", nargs="+", required=True)
    t.add_argument("--val", nargs="+", required=True)
    t.add_argument("--epochs", type=int, default=2)
    t.add_argument("--lr", type=float, default=3e-4)
    t.add_argument("--kd", type=float, default=1.0)
    t.add_argument("--batch", type=int, default=4)
    t.add_argument("--live-rep", type=int, default=2, help="live training rounds repeated this many times per epoch")
    t.add_argument("--seed", type=int, default=0)
    e = sub.add_parser("eval")
    e.add_argument("--val", nargs="+", required=True)
    e.add_argument("--models", default="final")
    e.add_argument("--out", default="")
    a = ap.parse_args()
    {"cache": cmd_cache, "train": cmd_train, "eval": cmd_eval}[a.cmd](a)


if __name__ == "__main__":
    main()
