"""Locating the character from the WhereWindsMeet minimap, offline: the survey behind the app's locate() references.

The minimap (top left, north-up) is matched inside a reference image drawn at the same scale: either the big map
(fully zoomed in) scaled down, or a mosaic stitched from minimap frames grabbed along a route. Positions are big map
px (fully zoomed in) from the stronghold icon, x east / y south, as stronghold.js where() reads them. The matching
itself is scripts/map_locate.py (the app's locate(), generic); this holds the game's side: the minimap's mask and
colors (MINIMAP), the camera fan's heading, the big map, the survey runs.

    uv run --extra cv python workspaces/WhereWindsMeet/tools/wwm_locate.py cache data/wwm      # minimap discs of the grabbed frames
    uv run --extra cv python workspaces/WhereWindsMeet/tools/wwm_locate.py bigmap data/wwm     # source 1 reference
    uv run --extra cv python workspaces/WhereWindsMeet/tools/wwm_locate.py track data/wwm      # frame positions from the anchors
    uv run --extra cv python workspaces/WhereWindsMeet/tools/wwm_locate.py stitch data/wwm --runs s1      # source 2 reference
    uv run --extra cv python workspaces/WhereWindsMeet/tools/wwm_locate.py eval data/wwm       # errors per image, source and preprocessing
    uv run --extra cv python workspaces/WhereWindsMeet/tools/wwm_locate.py export data/wwm --runs s1,s2   # the app's references

Data layout (data/wwm): survey<N>/ per scripts/grab_frames.py run (<seq>.jpg, frames.jsonl; anchors.json [{run, n,
seq, x, y, cam}] from route.js `anchors`, their screenshots in the workspace's teaching/survey/<run>/; frames.npz and
track.json made by cache / track --survey survey<N>), bigmap/*.png +
bigmap/shots.json (big map screenshots and where the icon is), map_header.png (the big map's 单人 / 多人 header).

What the survey showed: the minimap zooms in about 2x in the courtyard (1 minimap px = 1.15 big map px there, 2.3
outside), and closing the big map resets it to zoomed out for a second or two; so every look is tried at both zooms.
The map shows through the see-through disc with the scenery behind it (sky, branches, leaves): a band-pass (blur
minus a wider blur) keeps the walls and buildings. The stronghold zone's orange is filtered apart from the rest of
the disc, which takes out its tint and its edge while the buildings under it still count.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import replace
from pathlib import Path

import cv2
import numpy as np

REPO = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO / "scripts"))  # the generic part: scripts/map_locate.py

import map_locate as ml
from map_locate import Config, Ref, Regions, imread, imwrite

WS = REPO / "workspaces" / "WhereWindsMeet"
TEMPLATES = WS / "templates"

# OpenCV HSV (H 0-180), from skills/lib/minimap.js
RED = (((0, 45, 150), (8, 255, 255)), ((170, 45, 150), (180, 255, 255)))
# The zone is a see-through orange over the map (S ~50-60 against ~5 for the bare map); the buildings under it still
# show. lib/minimap.js ZONE (S >= 55) only catches its darker half, which is enough to find it but not to erase it.
ZONE_FILL = ((10, 25, 100), (24, 85, 235))

# The minimap in the 1080x720 screenshot: a 110 px square around (144, 70), the character in its middle (54, 54).
# Used: within r 44 (the rim is shaded), not the arrow (r 9), not the camera fan (to r 34, heading ± 38°), not the
# red marks; the stronghold zone flat (filtered apart from the rest, its rim left out).
MINIMAP = Config(center=(144, 70), size=110, circle=(9, 44), wedge=(34, 38), drop=RED, grow=5, sat_max=0,
                 regions=Regions(ZONE_FILL, mode="flat", gain=1.0, open=3, min_px=60, close=5, edge=5))


def disc(img: np.ndarray) -> np.ndarray:
    return MINIMAP.crop(img)


def zone_region(d: np.ndarray) -> np.ndarray:
    """The zone's area in a minimap disc (holes filled), empty when there is none."""
    return ml.region(d, MINIMAP)


def look(kind: str = "dog", pre: float = 1.0, sigma: float = 3.0, zone: str = "flat", sat_max: int = 0) -> Config:
    """MINIMAP with this preprocessing, zone mode and sat_max."""
    return replace(MINIMAP.with_prep(kind=kind, pre=pre, sigma=sigma), sat_max=sat_max).with_regions(mode=zone)


# ---- camera fan (port of lib/minimap.js cameraHeading: wedge templates every 10°, green masked)

_FANS: dict[int, tuple[np.ndarray, np.ndarray]] = {}


def _fan(d: int):
    if d not in _FANS:
        t = cv2.imread(str(TEMPLATES / "minimap_fan" / f"{d:03d}.png"))
        mask = ~((t[:, :, 0] == 0) & (t[:, :, 1] == 255) & (t[:, :, 2] == 0))
        _FANS[d] = (cv2.cvtColor(t, cv2.COLOR_BGR2GRAY).astype(np.float32), mask.astype(np.uint8))
    return _FANS[d]


def heading(d: np.ndarray) -> float | None:
    """Camera heading from the fan in a minimap disc (compass degrees), None if not found."""
    g = cv2.cvtColor(d[33 : 33 + 43, 33 : 33 + 43], cv2.COLOR_BGR2GRAY).astype(np.float32)
    scores = {}
    for deg in range(0, 360, 10):
        t, m = _fan(deg)
        r = cv2.matchTemplate(g, t, cv2.TM_CCOEFF_NORMED, mask=m)
        r[~np.isfinite(r)] = -1
        scores[deg] = float(r.max())
    best = max(scores, key=scores.get)
    if scores[best] < 0.4:
        return None
    a, b, c = scores[(best - 10) % 360], scores[best], scores[(best + 10) % 360]
    den = a - 2 * b + c
    off = max(-5.0, min(5.0, 5 * (a - c) / den)) if den < 0 else 0.0
    return (best + off) % 360


# ---- references

ZOOMS = {"out": 2.30, "in": 1.15}  # big map px per minimap px: outdoors / in the courtyard (it zooms in there)
# where() minus the match position, per zoom (arrow center on the big map vs the minimap's; calibrated on anchors)
OFFSETS = {"out": (-2.8, 4.0), "in": (-2.4, 1.3)}


def bigmap_ref(root: Path, zoom: str) -> Ref:
    """Source 1: the big map composite (`bigmap`), scaled to the minimap."""
    comp = imread(root / "bigmap" / "composite.png")
    ok = imread(root / "bigmap" / "composite_valid.png")[:, :, 0] > 0
    org = json.load(open(root / "bigmap" / "composite.json"))["origin"]
    k = ZOOMS[zoom]
    img = cv2.resize(comp, None, fx=1 / k, fy=1 / k, interpolation=cv2.INTER_AREA)
    v = cv2.resize(ok.astype(np.uint8), (img.shape[1], img.shape[0]), interpolation=cv2.INTER_AREA) > 0
    return Ref(img, v, (org[0] / k, org[1] / k), k, f"bigmap-{zoom}", OFFSETS[zoom])


def mosaic_ref(root: Path, zoom: str, name: str = "mosaic") -> Ref:
    return ml.load_ref(root / name, zoom, f"{name}-{zoom}")


# ---- data


def load_frames(sd: Path):
    fr = [json.loads(l) for l in open(sd / "frames.jsonl", encoding="utf-8")]
    return [(f["seq"], sd / f"{f['seq']}.jpg") for f in fr]


def surveys(root: Path) -> list[Path]:
    """The survey directories (a grab_frames.py run each: frame numbers restart when the app restarts)."""
    return sorted(d for d in root.glob("survey*") if (d / "anchors.json").exists())


_NPZ: dict[Path, dict] = {}


def frames_of(sd: Path) -> dict:
    """A survey's frames.npz (`cache`), with idx: frame number -> row."""
    if sd not in _NPZ:
        z = dict(np.load(sd / "frames.npz"))
        z["idx"] = {int(s): i for i, s in enumerate(z["seq"])}
        _NPZ[sd] = z
    return _NPZ[sd]


def tracks(root: Path) -> list[dict]:
    """Tracked frames of every survey (`track`), each with its survey's directory name."""
    return [t | {"survey": sd.name} for sd in surveys(root) if (sd / "track.json").exists() for t in json.load(open(sd / "track.json"))]


_HEADER = None


def in_world(img: np.ndarray, root: Path) -> bool:
    """The world screen: not the big map (its 单人 / 多人 header, root/map_header.png), and the camera fan shows (the
    top right icons are no test: over a bright sky they drop out)."""
    global _HEADER
    if _HEADER is None:
        _HEADER = imread(root / "map_header.png")
    if cv2.matchTemplate(img[0:70, 20:160], _HEADER, cv2.TM_CCOEFF_NORMED).max() > 0.7:
        return False
    return heading(disc(img)) is not None


def cache_frames(root: Path, sd: Path) -> None:
    """<survey>/frames.npz: every grabbed frame's minimap disc, whether it is the world screen, the camera heading."""
    seqs, discs, world, cams = [], [], [], []
    for seq, p in load_frames(sd):
        img = imread(p)
        if img is None:
            continue
        d = disc(img).copy()
        w = in_world(img, root)
        c = heading(d) if w else None
        seqs.append(seq), discs.append(d), world.append(w), cams.append(np.nan if c is None else c)
    np.savez(sd / "frames.npz", seq=np.array(seqs), world=np.array(world), disc=np.array(discs), cam=np.array(cams))


def good_frames(world: np.ndarray) -> np.ndarray:
    """World frames away from the big map opening / closing (a few frames there still show a fan-like wedge)."""
    good = world.copy()
    n = len(good)
    i = 0
    while i < n:  # short world runs inside a map block are its animation
        if good[i]:
            j = i
            while j < n and good[j]:
                j += 1
            if j - i <= 4 and i > 0 and j < n:
                good[i:j] = False
            i = j
        else:
            i += 1
    return ~(np.convolve((~good).astype(int), np.ones(5, int), "same") > 0)


MAX_DRIFT = 4.0  # a chain that missed its end anchor by more than this is not trusted (big map px)


def track(root: Path, sd: Path, p: Config, relocate: list[tuple[list[Ref], Config]] | None = None) -> list[dict]:
    """Positions of the grabbed frames between anchors (route.js `anchors`, where() before each look at the map).
    Each stretch between two looks starts zoomed out (closing the map resets the minimap) and, in the courtyard,
    zooms in after a second or two. Frames are told apart by which zoom of the big map they match better (only the
    zoom is taken from it); the zoomed-out part is chained forward from the anchor it starts at, the zoomed-in part
    backward from the anchor it ends at; a stretch that stays zoomed out is chained forward and its drift at the end
    spread along the way. Long runs across the courtyard can wobble off by 20 px and more: with `relocate`
    (references and their configs, tried in turn), the frames of a stretch that drifted more than MAX_DRIFT are
    placed by locate() instead (near where the anchors put them; only trusted matches, the rest left out)."""
    z = frames_of(sd)
    seq, D, cam = z["seq"], z["disc"], z["cam"]
    good = good_frames(z["world"])
    anchors = json.load(open(sd / "anchors.json"))
    refs = [bigmap_ref(root, "out"), bigmap_ref(root, "in")]
    out, fits = [], []
    for a0, a1 in zip(anchors, anchors[1:]):
        if a1["run"] != a0["run"] or a1["n"] != a0["n"] + 1:
            continue
        j = next(i for i in range(len(seq)) if seq[i] > a0["seq"] and not good[i])
        fr = [i for i in range(j, len(seq)) if seq[i] <= a1["seq"] + 3 and good[i]]
        if len(fr) < 3:
            continue
        A, B = np.array([a0["x"], a0["y"]], float), np.array([a1["x"], a1["y"]], float)
        lab = []
        for t, i in enumerate(fr):
            prior = A + (B - A) * t / (len(fr) - 1)
            r = ml.best_of(D[i], refs, p, tuple(prior), 45, None if np.isnan(cam[i]) else float(cam[i]))
            lab.append(r[1].k < 2)
        lab = np.array(lab)
        sm = np.array([np.median(lab[max(0, t - 2) : t + 3]) > 0.5 for t in range(len(lab))])
        n_out = int(np.argmax(sm)) if sm.any() else len(sm)  # zoomed out up to here
        n_in = len(sm) - int(np.argmax(~sm[::-1])) if (~sm).any() else 0  # zoomed in from here
        n_in = max(n_in, n_out)
        seg = f"{a0['run']}:{a0['n']}"
        rows = []
        if n_out == len(fr) or n_in == 0:
            zm = "out" if n_out == len(fr) else "in"
            raw, _ = ml.chain(D, cam, fr, p, 1.0, np.zeros(2))  # minimap px, to fit the zoom with
            pos = A + ZOOMS[zm] * raw
            steps = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pos, axis=0), axis=1))]
            drift = B - pos[-1]
            pos = pos + np.outer(steps / max(steps[-1], 1e-6), drift)
            if relocate and np.linalg.norm(drift) > MAX_DRIFT:
                n0 = len(rows)
                for t, i in enumerate(fr):
                    prior = tuple(A + (B - A) * t / max(1, len(fr) - 1))
                    c = None if np.isnan(cam[i]) else float(cam[i])
                    for refs, q in relocate:
                        r = ml.best_of(D[i], refs, q, prior, 45, c)
                        if r and r[0]["score"] >= 0.4 and r[0]["score"] - r[0]["second"] >= 0.1:
                            rows.append((i, np.array([r[0]["x"], r[0]["y"]]), zm, "locate"))
                            break
                print(seg, "relocated", len(rows) - n0, "of", len(fr))
            else:
                rows += [(fr[t], pos[t], zm, "spread") for t in range(len(fr))]
            fits.append((zm, raw[-1], B - A, steps[-1]))
            print(seg, zm, len(fr), "drift", np.round(drift, 1), "path", round(float(steps[-1]), 1))
        else:
            if n_out > 2:
                pos, _ = ml.chain(D, cam, fr[: n_out - 2], p, ZOOMS["out"], A)
                rows += [(fr[t], pos[t], "out", "fwd") for t in range(n_out - 2)]
            if len(fr) - n_in > 2:
                back = fr[n_in + 2 :][::-1]
                pos, _ = ml.chain(D, cam, back, p, ZOOMS["in"], B)
                rows += [(back[t], pos[t], "in", "bwd") for t in range(len(back))]
            print(seg, "out", n_out, "in", len(fr) - n_in, "of", len(fr))
        for i, q, zm, how in sorted(rows, key=lambda r: r[0]):
            out.append({"seq": int(seq[i]), "x": round(float(q[0]), 2), "y": round(float(q[1]), 2), "zoom": zm,
                        "how": how, "seg": seg, "run": a0["run"][:2],
                        **({"drift": round(float(np.linalg.norm(drift)), 1)} if how == "spread" else {})})
    for zm in ZOOMS:  # the zoom that fits the chains best (stretches that moved, that did not go astray)
        f = [(c, d) for z_, c, d, path in fits if z_ == zm and np.linalg.norm(d) > 8 and path < 2 * np.linalg.norm(d) + 10]
        if f:
            c, d = np.array([x[0] for x in f]), np.array([x[1] for x in f])
            k = (c * d).sum() / (c * c).sum()
            print(zm, "zoom fit", round(float(k), 3), "from", len(f), "stretches; residuals", np.round(np.linalg.norm(d - k * c, axis=1), 1))
    json.dump(out, open(sd / "track.json", "w"), indent=0)
    return out


def build_bigmap(root: Path) -> None:
    """Source 1: the big map screenshots (bigmap/shots.json) lined up on the stronghold icon, the arrow, panels,
    gold marks and labels (not on the minimap) left out, the median where several cover a spot."""
    cfg = json.load(open(root / "bigmap" / "shots.json"))
    x0, y0, w, h = -560, -340, 1120, 800  # canvas, in big map px from the icon
    stack, valid = [], []
    for s in cfg["shots"]:
        im = imread(root / "bigmap" / s["file"])
        ix, iy = s["icon"]
        m = np.ones(im.shape[:2], bool)
        m[:62] = False  # header
        m[:, 925 if s.get("panel") else 1080 :] = False
        m[488:, :285] = False  # bottom left panels
        m[90:385, 930:] = False  # right buttons
        m[660:] = False
        hsv = cv2.cvtColor(im, cv2.COLOR_BGR2HSV)
        gold = (hsv[:, :, 1] > 70) & (hsv[:, :, 2] > 120) & (hsv[:, :, 0] < 35)  # the arrow, selection marks
        m &= ~(cv2.dilate(gold.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0)
        M = np.float32([[1, 0, -x0 - ix], [0, 1, -y0 - iy]])
        stack.append(cv2.warpAffine(im, M, (w, h)).astype(np.float32))
        valid.append(cv2.warpAffine(m.astype(np.uint8), M, (w, h), flags=cv2.INTER_NEAREST) > 0)
    S, V = np.array(stack), np.array(valid)
    S[~V] = np.nan
    with np.errstate(all="ignore"):
        comp = np.nan_to_num(np.nanmedian(S, axis=0)).astype(np.uint8)
    ok = V.any(0)
    for x, y, bw, bh in cfg["labels"]:
        ok[y - y0 : y - y0 + bh, x - x0 : x - x0 + bw] = False
    imwrite(root / "bigmap" / "composite.png", comp)
    imwrite(root / "bigmap" / "composite_valid.png", (ok * 255).astype(np.uint8))
    json.dump({"origin": [-x0, -y0]}, open(root / "bigmap" / "composite.json", "w"))


def stitch(root: Path, zoom: str, runs=("s1",), k: float | None = None, max_drift: float = 4.0, step: float = 0.7):
    """Source 2: a mosaic (map_locate.mosaic) of the minimap discs of tracked frames (track.json) at one zoom, from
    the given runs, the zone left out. Stretches whose chain drifted more than `max_drift` (track's report) are left
    out. Returns (ref, spread, n)."""
    k = k or ZOOMS[zoom]
    tr = [t for t in tracks(root) if t["run"] in {r[:2] for r in runs} and t["zoom"] == zoom]
    bad = set(json.load(open(root / "track_drift.json")).get("bad", [])) if (root / "track_drift.json").exists() else set()
    tr = [t for t in tr if t["seg"] not in bad and t.get("drift", 0) <= max_drift]

    def samples():
        for t in tr:
            z = frames_of(root / t["survey"])
            i = z["idx"][t["seq"]]
            yield z["disc"][i], t["x"], t["y"], None if np.isnan(z["cam"][i]) else float(z["cam"][i])

    print(zoom, end=" ")
    return ml.mosaic(samples(), MINIMAP.size, look(zone="mask"), k, step)


def save_mosaic(root: Path, zoom: str, runs, k: float, name: str = "mosaic") -> None:
    ref, spread, _ = stitch(root, zoom, runs, k)
    ml.save_ref(root / name, zoom, ref, runs=list(runs), spread=spread)
    overlay(root, zoom, name)


def overlay(root: Path, zoom: str, name: str = "mosaic") -> None:
    """<name>/overlay_<zoom>.png: the mosaic scaled up onto the big map composite, half and half, its edges in red,
    to see that the two line up."""
    comp = imread(root / "bigmap" / "composite.png")
    org = json.load(open(root / "bigmap" / "composite.json"))["origin"]
    r = mosaic_ref(root, zoom, name)
    up = cv2.resize(r.img, None, fx=r.k, fy=r.k, interpolation=cv2.INTER_LINEAR)
    vm = cv2.resize(r.valid.astype(np.uint8), (up.shape[1], up.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
    x0, y0 = int(round(org[0] - r.origin[0] * r.k)), int(round(org[1] - r.origin[1] * r.k))
    ov = comp.astype(np.float32)
    h, w = up.shape[:2]
    reg = ov[y0 : y0 + h, x0 : x0 + w]
    reg[vm] = 0.5 * reg[vm] + 0.5 * up[vm]
    edges = cv2.Canny(cv2.cvtColor(up, cv2.COLOR_BGR2GRAY), 30, 80) > 0
    reg[edges & vm] = (0, 0, 255)
    crop = ov[org[1] - 160 : org[1] + 180, org[0] - 200 : org[0] + 140].astype(np.uint8)
    imwrite(root / name / f"overlay_{zoom}.png", cv2.resize(crop, None, fx=2, fy=2))


# ---- evaluation

# teaching screenshots at known places (route points recorded there; a few px off)
KNOWN = {
    "0014": (-108, 115), "0026": (-108, 115), "0035": (-108, 115),  # the teleport stone
    "0077": (-42, 54), "0099": (-42, 54), "0107": (-42, 54),  # the gate (the zone's edge in sight)
    "0109": (-36, 16), "0112": (2, -24), "0115": (58, -2),  # flowers 1-3, in the zone
    "0117": (-8, 50),  # flower 4, the zone gone
}

PREPS = {
    "raw": look(kind="raw"),
    "hp3": look(kind="hp", sigma=3),
    "hp6": look(kind="hp", sigma=6),
    "dog1-4": look(kind="dog", pre=1, sigma=4),
    "dog1.5-5": look(kind="dog", pre=1.5, sigma=5),
    "dog2-8": look(kind="dog", pre=2, sigma=8),
    "grad1.5": look(kind="grad", sigma=1.5),
    "grad2.5": look(kind="grad", sigma=2.5),
    "canny": look(kind="canny"),
    "dog1.5-5-zmask": look(kind="dog", pre=1.5, sigma=5, zone="mask"),
    "dog1.5-5-znone": look(kind="dog", pre=1.5, sigma=5, zone="none"),
    "dog1.5-5-s60": look(kind="dog", pre=1.5, sigma=5, sat_max=60),
}


def eval_items(root: Path, holdout=("s2", "s4"), every: int = 2):
    """(name, disc, truth, category, split) to test on: the anchor screenshots, the known teaching screenshots, and
    every `every`-th tracked frame. split: train (its run went into the mosaic) / test."""
    items = []
    inside = lambda x, y: y < 52 and x > -48  # past the gate
    for a in (a for sd in surveys(root) for a in json.load(open(sd / "anchors.json"))):
        d = disc(imread(WS / "teaching" / "survey" / a["run"] / f"{a['n']:03d}.png")).copy()
        split = "test" if a["run"][:2] in holdout else "train"
        items.append((f"anchor {a['run']}/{a['n']}", d, (a["x"], a["y"]), "in" if inside(a["x"], a["y"]) else "out", split))
    known = root / "explore_backup"  # a copy: the app's explore draft reuses those file names once cleared
    for f, xy in KNOWN.items():
        d = disc(imread((known if known.is_dir() else WS / "teaching" / "explore") / f"{f}.png")).copy()
        cat = ("in-zone" if zone_region(d).any() else "in") if inside(*xy) else ("out-zone" if zone_region(d).any() else "out")
        items.append((f"known {f}", d, xy, cat, "test"))
    bad = set(json.load(open(root / "track_drift.json")).get("bad", []))
    tr = [t for t in tracks(root) if t["seg"] not in bad and t.get("drift", 0) <= MAX_DRIFT]
    for t in tr[::every]:
        split = "test" if t["run"] in holdout else "train"
        z = frames_of(root / t["survey"])
        items.append((f"frame {t['survey']}/{t['seq']}", z["disc"][z["idx"][t["seq"]]], (t["x"], t["y"]),
                      "in" if inside(t["x"], t["y"]) else "out", split))
    return items


# What each source is matched with in the app (the best of eval: margin over the second peak, share within 6 px)
APP_PREPS = {"mosaic": "dog1-4", "bigmap": "canny"}


def export(root: Path, name: str, runs, crop=(-320, -260, 640, 580), templates: Path = TEMPLATES) -> None:
    """Write the app's references to the workspace: templates/locate/<name>_<source>.json with a PNG per zoom
    (map_locate.write_reference; positions: big map px from the stronghold icon, off: where() frame), MINIMAP's
    mask and the source's preprocessing."""
    mosaic_dir = f"mosaic_{'_'.join(runs)}"
    for zoom in ZOOMS:
        save_mosaic(root, zoom, runs, ZOOMS[zoom], mosaic_dir)
    for source in ("mosaic", "bigmap"):
        levels = {}
        for zoom in ZOOMS:
            if source == "mosaic":
                levels[zoom] = mosaic_ref(root, zoom, mosaic_dir)
            else:
                # only around the stronghold (the whole composite is large at the courtyard's zoom)
                levels[zoom] = bigmap_ref(root, zoom).cut(*crop)
        what = "stitched from survey runs " + ", ".join(runs) if source == "mosaic" else "the big map, scaled"
        ml.write_reference(templates, f"locate/{name}_{source}", levels, PREPS[APP_PREPS[source]],
                           f"{name}: minimap reference ({what}), made by tools/wwm_locate.py export")


TRACK_PREP = look(kind="dog", pre=1.5, sigma=5)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["cache", "bigmap", "track", "stitch", "eval", "export"])
    ap.add_argument("root", type=Path)
    ap.add_argument("--survey", default="survey1", help="cache / track: the survey directory")
    ap.add_argument("--relocate", default="", help="track: a mosaic directory (e.g. mosaic_s1_s2) to place drifted stretches with")
    ap.add_argument("--runs", default="s1", help="stitch: the survey runs that make the mosaic (the rest test it)")
    ap.add_argument("--preps", default="", help="eval: preprocessings to try (PREPS keys), default all")
    ap.add_argument("--every", type=int, default=2, help="eval: every n-th tracked frame")
    ap.add_argument("--near-only", action="store_true", help="eval: skip the whole-reference search")
    ap.add_argument("--name", default="cixin", help="export: the references' name (templates/locate/<name>_*)")
    ap.add_argument("--templates", type=Path, default=TEMPLATES, help="export: where to (default the workspace's templates/)")
    ap.add_argument("--native", type=Path, help="eval: locate with the app's code built for the PC (locate.dll)")
    a = ap.parse_args()
    if a.native:
        ml.NATIVE = ml.Native(a.native)
    sd = a.root / a.survey
    if a.cmd == "cache":
        cache_frames(a.root, sd)
    elif a.cmd == "bigmap":
        build_bigmap(a.root)
    elif a.cmd == "track":
        rel = None
        if a.relocate:  # the references made so far: the mosaic, then the big map
            rel = [([mosaic_ref(a.root, z, a.relocate) for z in ZOOMS], PREPS[APP_PREPS["mosaic"]]),
                   ([bigmap_ref(a.root, z) for z in ZOOMS], PREPS[APP_PREPS["bigmap"]])]
        track(a.root, sd, TRACK_PREP, rel)
    elif a.cmd == "stitch":
        for zoom in ZOOMS:
            save_mosaic(a.root, zoom, a.runs.split(","), ZOOMS[zoom])
    elif a.cmd == "export":
        export(a.root, a.name, a.runs.split(","), templates=a.templates)
    elif a.cmd == "eval":
        sources = {"bigmap": [bigmap_ref(a.root, z) for z in ZOOMS], "mosaic": [mosaic_ref(a.root, z) for z in ZOOMS]}
        preps = {k: PREPS[k] for k in a.preps.split(",")} if a.preps else PREPS
        used = set(json.load(open(a.root / "mosaic" / "in.json"))["runs"])  # the rest tests the mosaic
        runs = {x["run"][:2] for sd in surveys(a.root) for x in json.load(open(sd / "anchors.json"))}
        items = eval_items(a.root, holdout=tuple(sorted(runs - used)), every=a.every)
        rows = ml.evaluate(items, sources, preps, heading, full=not a.near_only,
                           out_path=a.root / ("eval_native.jsonl" if a.native else "eval.jsonl"))
        ml.print_summary(ml.summary([r for r in rows if r["split"] == "test" or r["source"] == "bigmap"]))


if __name__ == "__main__":
    main()
