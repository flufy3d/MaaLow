"""Order 2 self-check of the per-frame features (data/moveid/emb/, made by s2_features.py).

    uv run --no-project --with av --with opencv-python-headless --with numpy --with matplotlib \
        python workspaces/WhereWindsMeet/tools/dufu_moveid/s2_emb_check.py [--seed 0] [--rec ID]

- views: 2 random recordings x 3 random frames -> emb/check/<rec>_f<N>_{full,glob,big,small}.png (full = the frame
  with the big (yellow) and small (magenta) crop boxes drawn), cut by s2_views.views() from a fresh PyAV decode.
- one recording (--rec, default the first random one): cosine similarity of consecutive frames per view
  (percentiles), motion percentiles, mean motion around the contacts of index.json (-60..+20 frames, per type) and a
  40 s stretch of the motion curves with the contacts marked, plus mean mot_small around contacts by type over all
  finished recordings -> emb/check/stats_<rec>.json, emb/check/motion_<rec>.png.
- all recordings: frames in the npz vs index.json, array shapes, NaN / inf -> emb/check/integrity.json.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
REPO = HERE.parents[3]
OUT = REPO / "data" / "moveid"
EMB = OUT / "emb"
CHECK = EMB / "check"
KEYS = ("glob", "big", "small")


def dump_views(rec: str, video: str, frames: list[int]) -> None:
    import av
    import cv2
    from s2_views import boxes, views
    want = set(frames)
    c = av.open(str(REPO / video))
    s = c.streams.video[0]
    s.thread_type = "AUTO"
    for i, f in enumerate(c.decode(s)):
        if i not in want:
            continue
        a = f.to_ndarray(format="bgr24")
        full = a.copy()
        for name, col in (("big", (0, 255, 255)), ("small", (255, 0, 255))):
            x, y, w, h = boxes(a.shape[1], a.shape[0])[name]
            cv2.rectangle(full, (x, y), (x + w - 1, y + h - 1), col, 2)
        cv2.imwrite(str(CHECK / f"{rec}_f{i}_full.png"), full)
        for k, im in views(a).items():
            cv2.imwrite(str(CHECK / f"{rec}_f{i}_{k}.png"), im)
        want.discard(i)
        if not want:
            break
    c.close()


def cos_consec(e: np.ndarray) -> np.ndarray:
    e = e.astype(np.float32)
    e /= np.linalg.norm(e, axis=1, keepdims=True) + 1e-8
    return (e[1:] * e[:-1]).sum(1)


def stats(rec: str, rnd: dict, events: list[dict]) -> dict:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    z = np.load(EMB / f"{rec}.npz")
    n = int(z["frames"])
    out = {"rec": rec, "round": rnd["round"], "frames": n, "index_frames": rnd["frames"], "model": str(z["model"]),
           "boxes": json.loads(str(z["boxes"]))}
    pct = [1, 5, 25, 50, 75, 95, 99]
    for k in KEYS:
        cs = cos_consec(z[k])
        m = z[f"mot_{k}"][1:]
        out[f"cos_{k}"] = dict(zip([f"p{p}" for p in pct], np.round(np.percentile(cs, pct), 4).tolist()))
        out[f"mot_{k}"] = dict(zip([f"p{p}" for p in pct], np.round(np.percentile(m, pct), 2).tolist()))
        out[f"corr(1-cos, mot)_{k}"] = round(float(np.corrcoef(1 - cs, m)[0, 1]), 3)
    ev = [e for e in events if e["rec"] == rec]
    lo, hi = -60, 20
    rel = np.arange(lo, hi + 1)
    fig, ax = plt.subplots(3, 1, figsize=(11, 11))
    curves = {}
    for typ in sorted({e["type"] for e in ev}) + ["all"]:
        sel = [e["frame"] for e in ev if (typ == "all" or e["type"] == typ) and e["frame"] + lo >= 1
               and e["frame"] + hi < n]
        if not sel:
            continue
        cur = {}
        for k in KEYS:
            mm = np.stack([z[f"mot_{k}"][f + lo:f + hi + 1] for f in sel]).mean(0)
            cur[k] = {"-60..-31": round(float(mm[:30].mean()), 2), "-15..-1": round(float(mm[45:60].mean()), 2),
                      "0..+5": round(float(mm[60:66].mean()), 2), "argmax": int(rel[mm.argmax()])}
            if k == "glob":
                ax[0].plot(rel, mm, label=f"{typ} (n={len(sel)})", lw=2.5 if typ == "all" else 1)
        curves[typ] = {"n": len(sel), **cur}
    out["contact_motion_mean"] = curves
    ax[0].axvline(0, color="k", lw=0.8)
    ax[0].axvline(-10, color="gray", ls="--", lw=0.8)
    ax[0].set(title=f"{rec}: mean mot_glob around contacts (0 = contact, dashed -10 = decision)",
              xlabel="frame - contact", ylabel="mean |d gray|")
    ax[0].legend(fontsize=8)
    w = 1200
    s0 = max(range(0, max(1, n - w), 60), key=lambda s: sum(s <= e["frame"] < s + w for e in ev))
    t = np.arange(s0, min(n, s0 + w))
    for k, col in zip(KEYS, ("C0", "C1", "C2")):
        ax[1].plot(t, z[f"mot_{k}"][t], lw=0.7, color=col, label=k)
    cols = {"ok": "green", "hit_unk": "red", "hit_pf": "orange", "flare": "gold", "grab": "purple"}
    for e in ev:
        if s0 <= e["frame"] < s0 + w:
            ax[1].axvline(e["frame"], color=cols.get(e["type"], "k"), lw=1, alpha=0.8)
    ax[1].set(title="motion per view; lines = contacts (green ok, red hit_unk, orange hit_pf, gold flare, purple grab)",
              xlabel="frame", ylabel="|d gray|")
    ax[1].legend(fontsize=8)
    # every finished recording: mean mot_small around contacts per type
    agg: dict = {}
    for p in sorted(EMB.glob("*.npz")):
        if p.name.endswith(".tmp.npz"):
            continue
        mz = np.load(p)["mot_small"]
        for e in events:
            if e["rec"] == p.stem and e["frame"] + lo >= 1 and e["frame"] + hi < len(mz):
                agg.setdefault(e["type"], []).append(mz[e["frame"] + lo:e["frame"] + hi + 1])
    out["all_recs_mot_small"] = {}
    for typ, rows in sorted(agg.items()):
        mm = np.mean(rows, 0)
        ax[2].plot(rel, mm, label=f"{typ} (n={len(rows)})", color=cols.get(typ))
        out["all_recs_mot_small"][typ] = {"n": len(rows), "-60..-31": round(float(mm[:30].mean()), 2),
                                          "-15..-1": round(float(mm[45:60].mean()), 2),
                                          "0..+5": round(float(mm[60:66].mean()), 2), "argmax": int(rel[mm.argmax()])}
    ax[2].axvline(0, color="k", lw=0.8)
    ax[2].axvline(-10, color="gray", ls="--", lw=0.8)
    ax[2].set(title="all finished recordings: mean mot_small around contacts by type", xlabel="frame - contact",
              ylabel="mean |d gray|")
    ax[2].legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(CHECK / f"motion_{rec}.png", dpi=90)
    (CHECK / f"stats_{rec}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def integrity(rounds: list[dict]) -> dict:
    bad, n_ok, frames = [], 0, 0
    for r in rounds:
        p = EMB / f"{r['rec']}.npz"
        if not p.exists():
            bad.append({"rec": r["rec"], "why": "missing"})
            continue
        z = np.load(p)
        n = int(z["frames"])
        probs = []
        if n != r["frames"]:
            probs.append(f"frames {n} != index {r['frames']}")
        for k in KEYS:
            if z[k].shape[0] != n or z[f"mot_{k}"].shape[0] != n:
                probs.append(f"{k} rows")
            if not np.isfinite(z[k]).all() or not np.isfinite(z[f"mot_{k}"]).all():
                probs.append(f"{k} not finite")
        if probs:
            bad.append({"rec": r["rec"], "why": probs})
        else:
            n_ok += 1
            frames += n
    out = {"recordings": len(rounds), "ok": n_ok, "frames": frames, "bad": bad}
    (CHECK / "integrity.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--rec", default="")
    a = ap.parse_args()
    CHECK.mkdir(parents=True, exist_ok=True)
    idx = json.loads((OUT / "index.json").read_text(encoding="utf-8"))
    rounds = {r["rec"]: r for r in idx["rounds"] if (EMB / f"{r['rec']}.npz").exists()}
    rng = random.Random(a.seed)
    picks = rng.sample(sorted(rounds), 2)
    for rec in picks:
        fr = sorted(rng.sample(range(rounds[rec]["frames"]), 3))
        dump_views(rec, rounds[rec]["video"], fr)
        print("views", rec, fr)
    rec = a.rec or picks[0]
    print(json.dumps(stats(rec, rounds[rec], idx["events"]), ensure_ascii=False, indent=1))
    it = integrity(idx["rounds"])
    print(json.dumps({k: v for k, v in it.items() if k != "bad"}), "bad:", it["bad"][:10])


if __name__ == "__main__":
    main()
