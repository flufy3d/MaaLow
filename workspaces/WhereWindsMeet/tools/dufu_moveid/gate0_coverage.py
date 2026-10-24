"""Gate 0, step 3: does the boss fall inside the crops at the decision moments, big enough?

    uv run --with numpy --with opencv-python-headless python workspaces/WhereWindsMeet/tools/dufu_moveid/gate0_coverage.py \
        [--fails 20] [--json data/moveid/gate0/coverage.json] [--gt]

Inputs: data/moveid/gate0/frames/manifest.json (decision frames = contact - 10, contact types) + boss boxes from
data/moveid/boss_boxes/rNNN.json (detector), or with --gt the hand labels (gate0_labels.json) of the uniformly random
label sets (label_set.json "train" + "train2" + "check_final" (gate0_check_labels.json); the "hard" and "dragon" sets
were picked by the detector / a dragon detector and are left out).

Crops are squares clamped inside the 1080x720 screen, each resized to 192:
  in(c)  = share of the boss box area inside crop c (>= 0.9 counts as in; 0.7 reported too)
  px(c)  = height of the boss box part inside c * 192 / side
  ok     = some crop c with in(c) and px(c) >= 40 ("在框里且大小够用"); a box taller / wider than the crop never fits
Variants (crops per frame):
  fixed     large 530 + small 260 on one fixed centre: the median boss-box centre, the screen centre (540, 360) and the
            best centre on a 10 px grid (in-sample, an upper bound for any fixed centre)
  track     the same two crops centred on the boss box of frame d - 3 (what a tracker / learned locator could know at
            run time; no box at d - 3 -> the median centre)
  oracle    the two crops centred on the box of frame d itself (upper bound of any locator with these two sizes)
  adaptive  one crop centred on the box of frame d - 3, side = clamp(1.5 * max(w, h), 192, 720), or on the box of
            d itself (oracle), side = clamp(1.15 * max(w, h), 192, 720): a locator that also gives the scale
  full      the whole screen at 384x240: px = box height * 240 / 720, ok = px >= 40
Frames without a boss box (boss off screen / hidden / detector miss) are counted apart: rates are given over the
frames with a box and over all decision frames (where they count as failures).
Failure reasons: big (box larger than every crop of the variant), small (inside but < 40 px), cut (0.7 <= in < 0.9),
out (less than 70 % inside any crop).
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
G0 = ROOT / "data/moveid/gate0"
FRAMES = G0 / "frames"
BOXES = ROOT / "data/moveid/boss_boxes"
LABELS = HERE / "gate0_labels.json"
W, H = 1080, 720
LARGE, SMALL, OUT = 530, 260, 192
MIN_PX = 40
FULL_H = 240
ADAPT_K, ADAPT_K_TRACK, ADAPT_MIN, ADAPT_MAX = 1.15, 1.5, 192, 720
DIST_BINS = [(0, 100, "h<100"), (100, 200, "100-200"), (200, 350, "200-350"), (350, 10_000, "h>=350")]


def crop_rect(cx, cy, side):
    x1 = min(max(cx - side / 2, 0), W - side)
    y1 = min(max(cy - side / 2, 0), H - side)
    return x1, y1, x1 + side, y1 + side


def inside(b, r):
    """(share of box b's area inside rect r, height of the part inside)."""
    ix = max(0.0, min(b[2], r[2]) - max(b[0], r[0]))
    iy = max(0.0, min(b[3], r[3]) - max(b[1], r[1]))
    a = max(1e-6, (b[2] - b[0]) * (b[3] - b[1]))
    return ix * iy / a, iy


def judge(b, crops, th=0.9):
    """crops: [(cx, cy, side)], smallest first. -> per-crop fractions, the crop holding the box, px there, ok, reason."""
    fr, pxs = [], []
    for cx, cy, side in crops:
        f, h = inside(b, crop_rect(cx, cy, side))
        fr.append(f)
        pxs.append(h * OUT / side)
    hold = next((i for i, f in enumerate(fr) if f >= th), None)  # smallest crop that holds it
    ok = any(f >= th and p >= MIN_PX for f, p in zip(fr, pxs))
    if ok:
        reason = ""
    elif max(b[2] - b[0], b[3] - b[1]) > max(s for _, _, s in crops):
        reason = "big"
    elif hold is not None:
        reason = "small"
    elif max(fr) >= 0.7:
        reason = "cut"
    else:
        reason = "out"
    return {"fr": fr, "hold": hold, "px": None if hold is None else pxs[hold], "ok": ok, "reason": reason}


def load_det():
    man = json.loads((FRAMES / "manifest.json").read_text(encoding="utf-8"))
    rows = []
    for j in man:
        p = BOXES / f"{j['round']}.json"
        if not p.exists():
            continue
        bb = json.loads(p.read_text(encoding="utf-8"))
        for it in j["items"]:
            if not it["ok"]:
                continue
            cur, prev = bb.get(str(it["d"])), bb.get(f"{it['d']}_p")
            kind = "flare" if it["flare"] else it["kind"]
            rows.append({"round": j["round"], "d": it["d"], "kind": kind, "type": it.get("type", kind),
                         "box": cur and cur["box"], "conf": cur and cur["conf"], "prev": prev and prev["box"]})
    return rows


def load_gt():
    """Hand-labelled frames of the random sets; d-3 boxes from the detector (the tracking variants need them)."""
    lab = json.loads(LABELS.read_text(encoding="utf-8"))
    lab.update(json.loads((HERE / "gate0_check_labels.json").read_text(encoding="utf-8"))["labels"])
    sets = json.loads((G0 / "label_set.json").read_text(encoding="utf-8"))
    keys = [k for s in ("train", "train2", "check_final") for k in sets.get(s, []) if k in lab]
    det = {(r["round"], r["d"]): r for r in load_det()}
    # the first two sets were cut on the recording-meta clock (manifest_metaclock.json); their contact types from there
    meta = {}
    mp = G0 / "manifest_metaclock.json"
    if mp.exists():
        for j in json.loads(mp.read_text(encoding="utf-8")):
            for it in j["items"]:
                meta[(j["round"], it["d"])] = it
    rows = []
    for k in keys:
        rnd, d = k.split("/")
        d = int(d)
        it = det.get((rnd, d))
        if it is not None:
            kind, typ, prev = it["kind"], it["type"], it["prev"]
        else:
            m = meta.get((rnd, d))
            if m is None:
                continue
            kind = "flare" if m["flare"] else m["kind"]
            typ = {"ok": "ok", "grab": "grab"}.get(m.get("outcome"), "hit_" + m.get("outcome", "")) if kind == "hit" else kind
            prev = None
        rows.append({"round": rnd, "d": d, "kind": kind, "type": typ, "box": lab[k], "conf": 1.0, "prev": prev})
    return rows


def dist_bin(b):
    h = b[3] - b[1]
    return next(n for lo, hi, n in DIST_BINS if lo <= h < hi)


def centre_of(b):
    return (b[0] + b[2]) / 2, (b[1] + b[3]) / 2


def adaptive_side(b, k=ADAPT_K):
    return float(np.clip(k * max(b[2] - b[0], b[3] - b[1]), ADAPT_MIN, ADAPT_MAX))


def evaluate(rows, crops_fn, th=0.9):
    """crops_fn(row) -> [(cx, cy, side)]. Returns per-row judgements for rows with a box."""
    return [(r, judge(r["box"], crops_fn(r), th)) for r in rows if r["box"] is not None]


def pct(a, b):
    return f"{a}/{b} = {100 * a / b:.1f}%" if b else f"{a}/0"


def summarise(res, n_all, names):
    n = len(res)
    s = {"n_box": n, "n_all": n_all, "ok": sum(j["ok"] for _, j in res),
         "in_any": sum(j["hold"] is not None for _, j in res),
         "in": {nm: sum(j["fr"][i] >= th for _, j in res) for i, (nm, th) in enumerate(names)},
         "reasons": dict(sorted(defaultdict(int, {k: sum(j["reason"] == k for _, j in res)
                                                  for k in ("big", "small", "cut", "out")}).items()))}
    px = np.array([j["px"] for _, j in res if j["px"] is not None])
    if len(px):
        s["px_q"] = [round(float(v), 1) for v in np.percentile(px, [5, 25, 50, 75, 95])]
        s["px_lt40"] = int((px < MIN_PX).sum())
    for key in ("kind", "type", "dist"):
        g = defaultdict(lambda: [0, 0])
        for r, j in res:
            g[dist_bin(r["box"]) if key == "dist" else r[key]][0] += j["ok"]
            g[dist_bin(r["box"]) if key == "dist" else r[key]][1] += 1
        s["by_" + key] = dict(sorted(g.items()))
    return s


def fmt(name, s):
    n, na = s["n_box"], s["n_all"]
    lines = [f"## {name}",
             "  " + "  ".join(f"in {k} {pct(v, n)}" for k, v in s["in"].items()) + f"  in any {pct(s['in_any'], n)}",
             f"  in + big enough: {pct(s['ok'], n)} of frames with a box; {pct(s['ok'], na)} of all decision frames",
             f"  px in the holding crop (5/25/50/75/95%): {s.get('px_q')}  (<40: {s.get('px_lt40')})",
             "  failures: " + "  ".join(f"{k} {v}" for k, v in s["reasons"].items()),
             "  by kind: " + "  ".join(f"{k} {pct(*v)}" for k, v in s["by_kind"].items()),
             "  by type: " + "  ".join(f"{k} {pct(*v)}" for k, v in s["by_type"].items()),
             "  by boss height: " + "  ".join(f"{k} {pct(*v)}" for k, v in s["by_dist"].items())]
    return "\n".join(lines)


def full_screen(rows, n_all):
    res = [r for r in rows if r["box"] is not None]
    px = np.array([(r["box"][3] - r["box"][1]) * FULL_H / H for r in res])
    s = {"n_box": len(res), "n_all": n_all, "ok": int((px >= MIN_PX).sum()),
         "px_q": [round(float(v), 1) for v in np.percentile(px, [5, 25, 50, 75, 95])] if len(px) else None}
    for key in ("kind", "type", "dist"):
        g = defaultdict(lambda: [0, 0])
        for r, p in zip(res, px):
            k = dist_bin(r["box"]) if key == "dist" else r[key]
            g[k][0] += int(p >= MIN_PX)
            g[k][1] += 1
        s["by_" + key] = dict(sorted(g.items()))
    return s


def best_grid(rows):
    best = None
    for cx in range(420, 661, 10):
        for cy in range(220, 461, 10):
            ok = sum(j["ok"] for _, j in evaluate(rows, lambda r: [(cx, cy, SMALL), (cx, cy, LARGE)]))
            if best is None or ok > best[0]:
                best = (ok, cx, cy)
    return best


def draw_fails(res, crops_fn, n, od: Path, tag):
    import cv2

    od.mkdir(parents=True, exist_ok=True)
    for p in od.glob(f"{tag}_*.jpg"):
        p.unlink()
    groups = defaultdict(list)
    for r, j in res:
        if not j["ok"]:
            groups[j["reason"]].append((r, j))
    tot = sum(len(v) for v in groups.values())
    rng = np.random.default_rng(0)
    pick = []
    for k, v in sorted(groups.items()):
        m = max(1, round(n * len(v) / tot))
        pick += [(k, v[i]) for i in rng.choice(len(v), size=min(m, len(v)), replace=False)]
    for k, (r, j) in pick[:n]:
        a = cv2.imread(str(FRAMES / r["round"] / f"{r['d']}.jpg"))
        for (cx, cy, side), col in zip(crops_fn(r), ((0, 200, 255), (255, 128, 0))):
            x1, y1, x2, y2 = map(int, crop_rect(cx, cy, side))
            cv2.rectangle(a, (x1, y1), (x2, y2), col, 3)
        b = list(map(int, r["box"]))
        cv2.rectangle(a, (b[0], b[1]), (b[2], b[3]), (0, 0, 255), 3)
        fr = " ".join(f"{f:.2f}" for f in j["fr"])
        cv2.putText(a, f"{r['round']}/{r['d']} {r['type']} {k} in {fr} px {j['px'] or 0:.0f} h {b[3] - b[1]}",
                    (10, 30), 0, 0.8, (0, 255, 255), 2)
        cv2.imwrite(str(od / f"{tag}_{k}_{r['round']}_{r['d']}.jpg"), a, [cv2.IMWRITE_JPEG_QUALITY, 88])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fails", type=int, default=20)
    ap.add_argument("--json", default=None)
    ap.add_argument("--gt", action="store_true", help="hand-labelled random frames instead of the detector boxes")
    a = ap.parse_args()
    rows = load_gt() if a.gt else load_det()
    det = [r for r in rows if r["box"] is not None]
    n_all = len(rows)
    rounds = sorted({r["round"] for r in rows})
    nob = defaultdict(lambda: [0, 0])
    for r in rows:
        nob[r["type"]][0] += r["box"] is None
        nob[r["type"]][1] += 1
    print(f"{'hand labels' if a.gt else 'detector'}: {len(rounds)} rounds, {n_all} decision frames, with a boss box "
          f"{pct(len(det), n_all)}; no box by type: " + "  ".join(f"{k} {pct(*v)}" for k, v in sorted(nob.items())))
    cs = np.array([centre_of(r["box"]) for r in det])
    med = tuple(float(v) for v in np.median(cs, axis=0))
    print(f"boss centre: median ({med[0]:.0f}, {med[1]:.0f}), IQR x {np.percentile(cs[:, 0], [25, 75]).round()}, "
          f"y {np.percentile(cs[:, 1], [25, 75]).round()}")
    hs = np.array([r["box"][3] - r["box"][1] for r in det])
    print(f"boss box height (5/25/50/75/95%): {np.percentile(hs, [5, 25, 50, 75, 95]).round()}")
    g = best_grid(rows)
    two = lambda c: [(c[0], c[1], SMALL), (c[0], c[1], LARGE)]  # noqa: E731
    prev_c = lambda r: centre_of(r["prev"]) if r["prev"] else med  # noqa: E731
    variants = {
        f"fixed, median centre ({med[0]:.0f}, {med[1]:.0f})": lambda r: two(med),
        "fixed, screen centre (540, 360)": lambda r: two((540, 360)),
        f"fixed, best grid centre ({g[1]}, {g[2]}) [in-sample]": lambda r: two((g[1], g[2])),
        "track: both crops on the box of frame d-3 (no box: median)": lambda r: two(prev_c(r)),
        "oracle: both crops on the box of frame d": lambda r: two(centre_of(r["box"])),
        "adaptive track: one crop, centre + size (1.5x) from the box of d-3 (no box: median, 530)":
            lambda r: [(*prev_c(r), adaptive_side(r["prev"], ADAPT_K_TRACK) if r["prev"] else LARGE)],
        "adaptive oracle: one crop, centre + size from the box of d":
            lambda r: [(*centre_of(r["box"]), adaptive_side(r["box"]))],
    }
    report = {"source": "gt" if a.gt else "detector", "rounds": len(rounds), "n_all": n_all, "n_box": len(det),
              "median_centre": med, "best_grid": g[1:], "no_box_by_type": dict(nob), "variants": {}}
    for name, fn in variants.items():
        names = [("small", None), ("large", None)] if not name.startswith("adaptive") else [("crop", None)]
        for th in (0.9, 0.7):
            s = summarise(evaluate(rows, fn, th), n_all, [(nm, th) for nm, _ in names])
            report["variants"][f"{name} @{th}"] = s
            print(fmt(f"{name}  [in >= {th:.0%}]", s))
    fs = full_screen(rows, n_all)
    report["full_384x240"] = fs
    print(f"## full screen 384x240: boss height px (5/25/50/75/95%) {fs['px_q']}; >= 40 px: "
          f"{pct(fs['ok'], fs['n_box'])} of frames with a box, {pct(fs['ok'], n_all)} of all")
    for key in ("kind", "type", "dist"):
        print(f"  by {key}: " + "  ".join(f"{k} {pct(*v)}" for k, v in fs["by_" + key].items()))
    out = a.json or str(G0 / ("coverage_gt.json" if a.gt else "coverage.json"))
    Path(out).write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    if a.fails and a.gt:
        fixed = variants[f"fixed, median centre ({med[0]:.0f}, {med[1]:.0f})"]
        draw_fails(evaluate(rows, fixed), fixed, a.fails, G0 / "fail", "gt_fixed")
    if a.fails and not a.gt:
        fixed = variants[f"fixed, median centre ({med[0]:.0f}, {med[1]:.0f})"]
        draw_fails(evaluate(rows, fixed), fixed, a.fails, G0 / "fail", "fixed")
        tr = variants["adaptive track: one crop, centre + size (1.5x) from the box of d-3 (no box: median, 530)"]
        draw_fails(evaluate(rows, tr), tr, 8, G0 / "fail", "adaptive")


if __name__ == "__main__":
    main()
