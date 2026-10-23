"""Fine-tune the dufu head (unified_head9s) on phase-2 traces; the backbone stays frozen (its features are in the trace).

    uv run --with torch --index https://download.pytorch.org/whl/cu130 --with onnx --with onnxruntime \
        python workspaces/WhereWindsMeet/tools/dufu_train/train.py data/p2 [--cv 5] [--no-export]

Re-scans data/p2/r*/ every run (incomplete rounds are skipped). Splits are by round (round number % K):
  --cv K (default 5): K folds, each trained with early stopping on its held-out rounds; the reported val metrics are
      out-of-fold (every round scored by a model that never saw it). The exported model is then trained on all rounds
      for the median best epoch count (+1).
  --cv 0 --val-every K: one split (round number % K == 0 -> val), the early-stopped model is exported.
Supervised: fut1-3 / fut1f / def1-3 from labels.py (contacts = hp drops + 卸势 oks). Distilled toward the original head
(same windows): combo, stage, ours, cont, land, and tell with its curtain (and, unless the row is dark, dark) mass moved
to "none" (phase two has no curtain). A light KD on fut1 and an L2-SP pull toward the original weights keep it close.
--def-from-outcome: def1-3 of non-flare contacts from what our presses got (labels.py: ok -> 卸势, a hit despite a
timely 卸势 -> dodge, other hits weight 0); the val report adds the def1 P(dodge) separation of ok vs parry-fail contacts.
--skip r058-r067: leave rounds out (their aux `flare` was the per-frame image rule).
Exports model/dufu/<name>.onnx + .json; run artifacts (checkpoint, history) in data/tmp/dufu_train/<name>/.
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from labels import DEF_DODGE, targets
from metrics import TRIG_TH, fmt, merge, round_stats, s1_of
from model import OFF, export_onnx, load_onnx

from data import AI, FRAME_MS, MIN_RING, scan, steps, window_index

WS = Path(__file__).resolve().parents[2]
REPO = WS.parents[1]
BASE = WS / "model" / "dufu" / "unified_head9s.onnx"
KD_SLICES = ["combo", "stage", "ours", "cont", "land"]
TELL_NONE, TELL_CURTAIN, TELL_DARK = 0, 5, 6
SWEEP = [0.3, 0.45, 0.6]  # S1 thresholds reported besides TRIG_TH
PLAN_LO_F, PLAN_HI_F = 10, 19  # def1 read for a contact: head rows this many frames before it


def round_no(name: str) -> int:
    return int("".join(ch for ch in name if ch.isdigit()) or 0)


def sl(o, name):
    a, b = OFF[name]
    return o[:, a:b]


class Split:
    """All head rows of a set of rounds, on one device: windows index into one steps tensor."""

    def __init__(self, rounds, dev, teacher, outcome=False):
        st, win, rid, rows = [], [], [], []
        fut, defs, fine, w, dark, wdef = [], [], [], [], [], []
        self.rounds, self.tg = rounds, []
        off = 0
        for k, r in enumerate(rounds):
            tg = targets(r, outcome)
            self.tg.append(tg)
            rr = np.arange(MIN_RING - 1, r.n)
            st.append(steps(r))
            win.append(window_index(r.n)[rr] + off)
            rid.append(np.full(len(rr), k))
            rows.append(rr)
            fut.append(tg.fut[rr])
            defs.append(tg.defs[rr])
            fine.append(tg.fine[rr])
            w.append(tg.w[rr])
            wdef.append(tg.wdef[rr])
            dark.append(r.aux[rr, AI["dark3"]])
            off += r.n

        def t(a, dt=torch.float32):
            return torch.as_tensor(np.concatenate(a), dtype=dt, device=dev)

        self.steps = t(st)
        self.win = t(win, torch.long)
        self.rid = np.concatenate(rid)
        self.rows = np.concatenate(rows)
        self.fut = t(fut, torch.long)
        self.defs = t(defs, torch.long)
        self.fine = t(fine)
        self.w = t(w)
        self.wdef = t(wdef)
        self.n = len(self.win)
        self.teacher = predict(teacher, self)
        tell = torch.softmax(sl(self.teacher, "tell"), 1).clone()
        tell[:, TELL_NONE] += tell[:, TELL_CURTAIN]
        tell[:, TELL_CURTAIN] = 0
        light = t(dark) < 0.5
        tell[light, TELL_NONE] += tell[light, TELL_DARK]
        tell[light, TELL_DARK] = 0
        self.tell = tell

    def x(self, idx):
        return self.steps[self.win[idx]]


def kl(student_logits, target_p):
    return (target_p * (torch.log(target_p.clamp_min(1e-8)) - torch.log_softmax(student_logits, 1))).sum(1)


def losses(o, S: Split, idx, cfg):
    w = S.w[idx]
    pos = (S.fut[idx, 0] >= 1) & (S.fut[idx, 0] <= 5)  # a contact 4-19 f ahead: the rows S1 should fire on
    w = torch.where(pos, w * cfg.pos_w, w)
    wn = w.sum().clamp_min(1.0)

    def ce(name, y):
        return Fn.cross_entropy(sl(o, name), y, reduction="none")

    fut = (ce("fut1", S.fut[idx, 0]) + 0.5 * ce("fut2", S.fut[idx, 1]) + 0.5 * ce("fut3", S.fut[idx, 2])) * w
    fine = -(S.fine[idx] * torch.log_softmax(sl(o, "fut1f"), 1)).sum(1) * w
    wd = S.wdef[idx]
    dfs = (ce("def1", S.defs[idx, 0]) * wd[:, 0] + 0.5 * ce("def2", S.defs[idx, 1]) * wd[:, 1]
           + 0.5 * ce("def3", S.defs[idx, 2]) * wd[:, 2]) * w
    tl = S.teacher[idx]
    kd = sum(kl(sl(o, n), torch.softmax(sl(tl, n), 1)) for n in KD_SLICES)
    parts = {
        "fut": fut.sum() / wn, "fine": fine.sum() / wn, "def": dfs.sum() / wn, "kd": kd.mean(),
        "tell": kl(sl(o, "tell"), S.tell[idx]).mean(),
        "kdfut": kl(sl(o, "fut1"), torch.softmax(sl(tl, "fut1"), 1)).mean(),
    }
    total = (parts["fut"] + cfg.w_fine * parts["fine"] + cfg.w_def * parts["def"] + cfg.w_kd * parts["kd"]
             + cfg.w_tell * parts["tell"] + cfg.kd_fut * parts["kdfut"])
    return total, parts


@torch.no_grad()
def predict(model, S: Split, bs=4096):
    model.eval()
    dev = S.steps.device
    return torch.cat([model(S.x(torch.arange(i, min(i + bs, S.n), device=dev))) for i in range(0, S.n, bs)])


def s1_rounds(o, S: Split) -> list[np.ndarray]:
    """Per round (N,) S1 with nan where the head did not run."""
    s1 = s1_of(torch.softmax(sl(o, "fut1"), 1).cpu().numpy())
    out = []
    for k, r in enumerate(S.rounds):
        m = S.rid == k
        s = np.full(r.n, np.nan)
        s[S.rows[m]] = s1[m]
        out.append(s)
    return out


def pdodge_rounds(o, S: Split) -> list[np.ndarray]:
    """Per round (N,) def1 P(dodge) (the raw softmax mass, as dufu.js reads it) with nan where the head did not run."""
    pd = torch.softmax(sl(o, "def1"), 1)[:, DEF_DODGE].cpu().numpy()
    out = []
    for k, r in enumerate(S.rounds):
        m = S.rid == k
        s = np.full(r.n, np.nan)
        s[S.rows[m]] = pd[m]
        out.append(s)
    return out


def auc(pos, neg) -> float | None:
    if not len(pos) or not len(neg):
        return None
    a = np.concatenate([pos, neg])
    rk = a.argsort().argsort() + 1.0
    return float((rk[:len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def def_separation(rounds, tgs, pds) -> dict:
    """Per contact the mean def1 P(dodge) over the head rows PLAN_LO_F..PLAN_HI_F frames before it (where dufu.js plans
    and presses); ok vs parry-fail ("pf") contacts, non-flare (and flare as ok_fl / pf_fl). Flagged = P(dodge) >= th."""
    vals = {"ok": [], "pf": [], "unk": [], "grab": [], "ok_fl": [], "pf_fl": [], "unk_fl": []}
    for r, tg, pd in zip(rounds, tgs, pds):
        for c in tg.contacts:
            lead = (c.t - r.cap) / FRAME_MS
            m = (lead >= PLAN_LO_F) & (lead <= PLAN_HI_F) & ~np.isnan(pd) & (tg.w > 0)
            if not m.any():
                continue
            key = c.outcome + ("_fl" if c.dodge and c.outcome != "grab" else "")
            vals[key].append(float(pd[m].mean()))
    v = {k: np.array(x) for k, x in vals.items()}
    out = {"n": {k: len(x) for k, x in v.items()}, "auc_ok_vs_pf": auc(v["pf"], v["ok"]),
           "auc_ok_vs_pf_incl_flare": auc(np.concatenate([v["pf"], v["pf_fl"]]), np.concatenate([v["ok"], v["ok_fl"]]))}
    for th in (0.3, 0.5, 0.6, 0.7):
        out[str(th)] = {k: (float(np.mean(x >= th)) if len(x) else None) for k, x in v.items()}
    return out


def sep_s(d) -> str:
    def p(x):
        return "-" if x is None else f"{100 * x:.0f}%"
    a = d["auc_ok_vs_pf"]
    head = f"def1 P(dodge) ok vs parry-fail (non-flare n {d['n']['ok']}/{d['n']['pf']}): AUC {'-' if a is None else round(a, 3)}"
    return head + "".join(f"\n    th {th}: pf {p(d[th]['pf'])} ok {p(d[th]['ok'])} unk {p(d[th]['unk'])} grab {p(d[th]['grab'])} "
                          f"| flare ok {p(d[th]['ok_fl'])} pf {p(d[th]['pf_fl'])} unk {p(d[th]['unk_fl'])}"
                          for th in ("0.3", "0.5", "0.6", "0.7"))


def summarize(rounds, tgs, s1s) -> dict:
    out = merge([round_stats(r.cap, s, tg.w, tg.contacts) for r, tg, s in zip(rounds, tgs, s1s)])
    out["sweep"] = {}
    for th in SWEEP:
        mm = merge([round_stats(r.cap, s, tg.w, tg.contacts, th) for r, tg, s in zip(rounds, tgs, s1s)])
        out["sweep"][str(th)] = {k: mm[k] for k in ("cov_all", "cov_hit", "cov_ok", "false_runs_per_min")}
    return out


@torch.no_grad()
def evaluate(model, S: Split, cfg) -> tuple[dict, list[np.ndarray]]:
    o = predict(model, S)
    _, parts = losses(o, S, torch.arange(S.n, device=o.device), cfg)
    s1s = s1_rounds(o, S)
    out = summarize(S.rounds, S.tg, s1s)
    out.update({f"loss_{k}": float(v) for k, v in parts.items()})
    near = (S.fut[:, 0] <= 5) & (S.w > 0) & (S.wdef[:, 0] > 0)  # next contact within 19 f, its def known
    if near.any():
        out["def1_acc_near"] = float((sl(o, "def1")[near].argmax(1) == S.defs[near, 0]).float().mean())
    return out, s1s


def fit(cfg, teacher, Str: Split, Sva: Split | None, epochs: int, log=print):
    """Fine-tune a copy of teacher; with Sva early-stop on its fut/fine/def loss, else run all epochs."""
    model = copy.deepcopy(teacher)
    for n, p in model.named_parameters():
        p.requires_grad_(cfg.train == "all" or n.startswith("h.") or (cfg.train == "gru2" and n.endswith("_l1")))
    params = [p for p in model.parameters() if p.requires_grad]
    init = [p.detach().clone() for p in params]
    opt = torch.optim.AdamW(params, lr=cfg.lr, weight_decay=0.0)
    best, best_ep, bad, hist = None, epochs - 1, 0, []
    best_state = copy.deepcopy(model.state_dict())
    dev = Str.steps.device
    t0 = time.time()
    for ep in range(epochs):
        model.train()
        perm = torch.randperm(Str.n, device=dev)
        tot, nb = 0.0, 0
        for i in range(0, Str.n, cfg.bs):
            idx = perm[i:i + cfg.bs]
            loss, _ = losses(model(Str.x(idx)), Str, idx, cfg)
            if cfg.l2sp:
                loss = loss + cfg.l2sp * sum(((p - q) ** 2).sum() for p, q in zip(params, init))
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            tot += float(loss.detach())
            nb += 1
        if Sva is None:
            hist.append({"epoch": ep, "train_loss": tot / max(nb, 1)})
            continue
        ev, _ = evaluate(model, Sva, cfg)
        key = ev["loss_fut"] + cfg.w_fine * ev["loss_fine"] + cfg.w_def * ev["loss_def"]
        hist.append({"epoch": ep, "train_loss": tot / max(nb, 1), "val_key": key, **ev})
        log(f"  ep {ep:2d} train {tot / max(nb, 1):.4f} val key {key:.4f} | {fmt(ev)}  ({time.time() - t0:.0f}s)")
        if best is None or key < best - 1e-4:
            best, best_ep, bad = key, ep, 0
            best_state = copy.deepcopy(model.state_dict())
        else:
            bad += 1
            if bad >= cfg.patience:
                break
    if Sva is not None:
        model.load_state_dict(best_state)
    return model, best_ep, hist


def label_stats(rounds, outcome=False) -> dict:
    n = {"rounds": len(rounds), "rows": 0, "minutes": 0.0, "contacts": 0, "hit": 0, "ok": 0, "flare_dodge": 0,
         "masked_rows": 0, "unsure_rows": 0}
    for r in rounds:
        tg = targets(r, outcome)
        for c in tg.contacts:
            key = f"outcome_{c.outcome}" + ("_flare" if c.dodge else "")
            n[key] = n.get(key, 0) + 1
        n["rows"] += r.n
        n["minutes"] = round(n["minutes"] + float(r.cap[-1] - r.cap[0]) / 60000, 2)
        n["contacts"] += len(tg.contacts)
        n["hit"] += sum(c.kind == "hit" for c in tg.contacts)
        n["ok"] += sum(c.kind == "ok" for c in tg.contacts)
        n["flare_dodge"] += sum(c.dodge for c in tg.contacts)
        n["masked_rows"] += int((tg.w == 0).sum())
        n["unsure_rows"] += int(((tg.w > 0) & (tg.w < 1)).sum())
    return n


def sweep_s(m):
    return " ".join(f"{th}: {100 * (v['cov_all'] or 0):.0f}/{100 * (v['cov_hit'] or 0):.0f}% {v['false_runs_per_min'] or 0:.1f}"
                    for th, v in m["sweep"].items())


def md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root", help="data/p2 (rNNN dirs)")
    ap.add_argument("--name", default="unified_head_p2")
    ap.add_argument("--base", default=str(BASE))
    ap.add_argument("--cv", type=int, default=5, help="K-fold by round number %% K (0: single split, --val-every)")
    ap.add_argument("--val-every", type=int, default=5, help="--cv 0: round number %% this == 0 -> val")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--patience", type=int, default=5)
    ap.add_argument("--bs", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--w-fine", type=float, default=0.5)
    ap.add_argument("--w-def", type=float, default=0.5)
    ap.add_argument("--w-kd", type=float, default=1.0)
    ap.add_argument("--w-tell", type=float, default=1.0)
    ap.add_argument("--kd-fut", type=float, default=0.05)
    ap.add_argument("--l2sp", type=float, default=1e-3)
    ap.add_argument("--pos-w", type=float, default=6.0, help="fut/def weight of rows with a contact 4-19 f ahead")
    ap.add_argument("--train", choices=["heads", "gru2", "all"], default="gru2",
                    help="what moves: the output layers, + the 2nd GRU layer, or everything")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-export", action="store_true")
    ap.add_argument("--def-from-outcome", action="store_true",
                    help="def of non-flare contacts from our presses' outcome: ok -> 卸势, hit despite a timely 卸势 -> dodge, other hits unknown")
    ap.add_argument("--skip", default="", help="rounds to leave out, e.g. r058-r067,r070")
    ap.add_argument("--out", default=None, help="model dir (default workspaces/WhereWindsMeet/model/dufu)")
    cfg = ap.parse_args()
    torch.manual_seed(cfg.seed)
    np.random.seed(cfg.seed)
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    rounds = scan(cfg.root)
    skip = set()
    for part in filter(None, cfg.skip.split(",")):
        a, _, b = part.partition("-")
        skip.update(range(round_no(a), round_no(b or a) + 1))
    rounds = [r for r in rounds if round_no(r.name) not in skip]
    if not rounds:
        sys.exit(f"no complete rounds under {cfg.root}")
    print(f"device {dev}; {len(rounds)} rounds {rounds[0].name}..{rounds[-1].name}; train {cfg.train}")
    oc = cfg.def_from_outcome
    stats_all = label_stats(rounds, oc)
    print("labels", stats_all)

    teacher = load_onnx(cfg.base).to(dev).eval()
    for p in teacher.parameters():
        p.requires_grad_(False)

    folds = []  # (train rounds, val rounds)
    if cfg.cv > 1:
        for f in range(cfg.cv):
            va = [r for r in rounds if round_no(r.name) % cfg.cv == f]
            tr = [r for r in rounds if round_no(r.name) % cfg.cv != f]
            if va and tr:
                folds.append((tr, va))
    else:
        va = [r for r in rounds if cfg.val_every > 0 and round_no(r.name) % cfg.val_every == 0]
        tr = [r for r in rounds if r not in va]
        folds.append((tr, va))

    oof = {"rounds": [], "tg": [], "orig": [], "new": [], "pd_orig": [], "pd_new": []}
    best_eps, hist_all = [], []
    model = None
    for fi, (tr, va) in enumerate(folds):
        print(f"fold {fi}: train {len(tr)} rounds, val {[r.name for r in va]}")
        Str = Split(tr, dev, teacher, oc)
        Sva = Split(va, dev, teacher, oc) if va else None
        model, best_ep, hist = fit(cfg, teacher, Str, Sva, cfg.epochs)
        best_eps.append(best_ep)
        hist_all.append({"fold": fi, "val": [r.name for r in va], "best_epoch": best_ep, "hist": hist})
        if Sva is not None:
            oof["rounds"] += Sva.rounds
            oof["tg"] += Sva.tg
            oof["orig"] += s1_rounds(Sva.teacher, Sva)
            oof["new"] += evaluate(model, Sva, cfg)[1]
            oof["pd_orig"] += pdodge_rounds(Sva.teacher, Sva)
            oof["pd_new"] += pdodge_rounds(predict(model, Sva), Sva)
            print(f"fold {fi} best epoch {best_ep}")
    val_orig = summarize(oof["rounds"], oof["tg"], oof["orig"]) if oof["rounds"] else None
    val_new = summarize(oof["rounds"], oof["tg"], oof["new"]) if oof["rounds"] else None
    # the separation is always scored against outcome labels (the flare rule alone has no parry-fail class)
    tg_oc = [targets(r, True) for r in oof["rounds"]]
    sep_orig = def_separation(oof["rounds"], tg_oc, oof["pd_orig"]) if oof["rounds"] else None
    sep_new = def_separation(oof["rounds"], tg_oc, oof["pd_new"]) if oof["rounds"] else None

    final_ep = best_eps[0] + 1
    if cfg.cv > 1:
        final_ep = int(np.median(best_eps)) + 1
        print(f"final: all {len(rounds)} rounds, {final_ep} epochs (fold best epochs {best_eps})")
        Sall = Split(rounds, dev, teacher, oc)
        model, _, hist = fit(cfg, teacher, Sall, None, final_ep)
        hist_all.append({"fold": "final", "epochs": final_ep, "hist": hist})
        fit_rounds = rounds
    else:
        Sall = Split(folds[0][0], dev, teacher, oc)
        fit_rounds = folds[0][0]
    tr_orig = summarize(Sall.rounds, Sall.tg, s1_rounds(Sall.teacher, Sall))
    tr_new = summarize(Sall.rounds, Sall.tg, s1_rounds(predict(model, Sall), Sall))

    print(f"S1 >= {TRIG_TH} (cov = contacts with a trigger 19..3 f before; false = no contact within 25 f)")
    print("in-sample original:", fmt(tr_orig))
    print("in-sample new:     ", fmt(tr_new))
    if val_orig:
        print("val original:      ", fmt(val_orig))
        print("val new:           ", fmt(val_new))
        print("val sweep th: cov all/hit, false runs/min | original", sweep_s(val_orig), "| new", sweep_s(val_new))
        print("val original:", sep_s(sep_orig))
        print("val new:     ", sep_s(sep_new))

    run_dir = REPO / "data" / "tmp" / "dufu_train" / cfg.name
    run_dir.mkdir(parents=True, exist_ok=True)
    torch.save({"state": model.state_dict(), "cfg": vars(cfg), "epochs": final_ep}, run_dir / "final.pt")
    if oof["rounds"]:
        np.savez_compressed(run_dir / "oof.npz", **{f"{r.name}_{k}": a for k in ("new", "pd_new") for r, a in zip(oof["rounds"], oof[k])})
        (run_dir / "val.json").write_text(json.dumps({"val_original": val_orig, "val_new": val_new, "def_sep_original": sep_orig,
                                                      "def_sep_new": sep_new}, indent=1, default=float), encoding="utf-8")
    (run_dir / "history.json").write_text(json.dumps(hist_all, indent=1, default=float), encoding="utf-8")
    if cfg.no_export:
        return
    out_dir = Path(cfg.out) if cfg.out else WS / "model" / "dufu"
    onnx_p = out_dir / f"{cfg.name}.onnx"
    export_onnx(model, onnx_p)
    import onnxruntime as ort

    sess = ort.InferenceSession(str(onnx_p))
    pick = torch.linspace(0, Sall.n - 1, 64, device=dev).long()
    xs = Sall.x(pick).cpu().numpy()
    with torch.no_grad():
        ref = model.cpu().eval()(torch.from_numpy(xs)).numpy()
    got = np.concatenate([sess.run(None, {"seq": xs[i:i + 1]})[0] for i in range(len(xs))])
    diff = float(np.abs(ref - got).max())
    print(f"exported {onnx_p} ({md5(onnx_p)}), onnxruntime vs torch max |d| {diff:.2e}")
    j = copy.deepcopy(json.loads(Path(cfg.base).with_suffix(".json").read_text(encoding="utf-8")))
    rel = f"dufu/{onnx_p.name}"
    j["model"] = ("phase-2 fine-tune of unified_head9s.onnx (same architecture / IO / 133-d slices; the backbone "
                  "unified_back9.onnx is unchanged and was frozen - the head trained on its features from the trace). "
                  "Supervised fut1-3 / fut1f / def1-3 from phase-2 contacts (hp drop - 5 f, 卸势 ok at the 真气 step; "
                  + ("def dodge under a 金光 flare or where a timely 卸势 still got hit (--def-from-outcome; hits "
                     "without a timely 卸势 unlabeled); " if oc else "def dodge only under a 金光 flare); ")
                  + "combo / stage / ours / cont / land distilled from head9s; tell "
                  "distilled with curtain (and non-dark 'dark') moved to none (phase two has no curtain). Use with "
                  f"args {{\"phase\":2,\"head\":\"{rel}\"}}. Trainer: tools/dufu_train/train.py.")
    for c in j["device_calls"]:
        if c.get("name") == "head":
            c["call"] = c["call"].replace("dufu/unified_head9s.onnx", rel)
    j["provenance"] = {
        "kind": "phase2-finetune",
        "base": Path(cfg.base).name,
        "base_md5": md5(Path(cfg.base)),
        "head_md5": md5(onnx_p),
        "trained": time.strftime("%Y-%m-%d %H:%M"),
        "data": str(cfg.root),
        "rounds_fit": [r.name for r in fit_rounds],
        "validation": (f"{cfg.cv}-fold by round number % {cfg.cv}, out-of-fold" if cfg.cv > 1
                       else f"rounds {[r.name for r in folds[0][1]]}"),
        "labels": stats_all,
        "epochs": final_ep,
        "fold_best_epochs": best_eps,
        "config": {k: v for k, v in vars(cfg).items() if k != "root"},
        "metrics_note": f"cov = share of contacts with S1 (fut1 bins 4-19 f) >= {TRIG_TH} on a head row 19..3 f before "
                        "it; false = alive head rows with S1 >= th and no contact within 25 f, per minute (runs: "
                        "consecutive such rows count once); sweep = the same at other thresholds",
        "val_original": val_orig, "val_new": val_new, "def_sep_original": sep_orig, "def_sep_new": sep_new,
        "in_sample_original": tr_orig, "in_sample_new": tr_new,
        "onnx_vs_torch_maxdiff": diff,
    }
    j["reexport"] = {"kind": "none", "note": "exported directly from the fine-tuned PyTorch port (model.py), opset 17"}
    onnx_p.with_suffix(".json").write_text(json.dumps(j, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"wrote {onnx_p.with_suffix('.json')}")


if __name__ == "__main__":
    main()
