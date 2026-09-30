"""Locating the character from the WhereWindsMeet minimap, offline: what the app's locate() does, checked on PC.

The minimap (top left, north-up) is matched inside a reference image drawn at the same scale: either the big map
(fully zoomed in) scaled down, or a mosaic stitched from minimap frames grabbed along a route. Positions are big map
px (fully zoomed in) from the stronghold icon, x east / y south, as stronghold.js where() reads them.

    uv run --extra cv python scripts/minimap_locate.py cache data/wwm      # minimap discs of the grabbed frames
    uv run --extra cv python scripts/minimap_locate.py bigmap data/wwm     # source 1 reference
    uv run --extra cv python scripts/minimap_locate.py track data/wwm      # frame positions from the anchors
    uv run --extra cv python scripts/minimap_locate.py stitch data/wwm --runs s1      # source 2 reference
    uv run --extra cv python scripts/minimap_locate.py eval data/wwm       # errors per image, source and preprocessing
    uv run --extra cv python scripts/minimap_locate.py export data/wwm --runs s1,s2   # the app's references

Data layout (data/wwm): survey1/ (grab_frames.py output: <seq>.jpg, frames.jsonl), anchors.json ([{run, n, seq,
x, y, cam}], from route.js `anchors`; their screenshots in the workspace's teaching/survey/<run>/), bigmap/*.png +
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
import math
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

REPO = Path(__file__).resolve().parents[1]
WS = REPO / "workspaces" / "WhereWindsMeet"
TEMPLATES = WS / "templates"

ROI = (90, 16, 110, 110)  # the minimap disc in the 1080x720 screenshot
C = 54  # its center within ROI: (144, 70)
K = 2.3  # big map px per minimap px outside (see ZOOMS)

# OpenCV HSV (H 0-180), from skills/lib/minimap.js
RED = [((0, 45, 150), (8, 255, 255)), ((170, 45, 150), (180, 255, 255))]
ZONE = [((12, 55, 110), (23, 110, 225))]


def imread(p: Path | str) -> np.ndarray:
    return cv2.imdecode(np.fromfile(str(p), np.uint8), cv2.IMREAD_COLOR)


def imwrite(p: Path | str, img: np.ndarray) -> None:
    Path(p).parent.mkdir(parents=True, exist_ok=True)
    ok, buf = cv2.imencode(Path(p).suffix, img)
    assert ok
    buf.tofile(str(p))


def disc(img: np.ndarray) -> np.ndarray:
    x, y, w, h = ROI
    return img[y : y + h, x : x + w]


_yy, _xx = np.mgrid[0 : ROI[3], 0 : ROI[2]]
R_MAP = np.hypot(_xx - C, _yy - C)
A_MAP = (np.degrees(np.arctan2(_xx - C, C - _yy)) + 360) % 360  # compass bearing of each disc pixel


def in_range(hsv: np.ndarray, ranges) -> np.ndarray:
    m = np.zeros(hsv.shape[:2], np.uint8)
    for lo, hi in ranges:
        m |= cv2.inRange(hsv, np.array(lo), np.array(hi))
    return m > 0


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


# ---- masks and preprocessing


@dataclass
class Prep:
    """How a minimap disc (or a reference) is turned into the image that gets matched."""

    kind: str = "hp"  # raw | hp (minus a blur) | dog | grad | canny
    sigma: float = 3.0  # hp / dog: the blur taken away; grad: pre-blur
    pre: float = 1.0  # dog: pre-blur (JPEG blocks and see-through noise)
    r_use: int = 44  # disc pixels used: within this radius (the rim is shaded)
    r_arrow: int = 9
    fan_r: int = 34  # the camera fan is masked out to this radius, heading ± fan_half
    fan_half: float = 38
    sat_max: int = 0  # > 0: mask pixels more saturated than this (see-through leaves, sky)
    zone: str = "flat"  # the stronghold zone's orange: flat (filtered apart from the rest, its rim left out) | mask | none
    zone_gain: float = 1.0  # flat: the zone's contrast is this much lower
    red: bool = True

    def name(self) -> str:
        s = f"{self.kind}{self.sigma:g}" if self.kind in ("hp", "grad") else self.kind
        if self.kind == "dog":
            s = f"dog{self.pre:g}-{self.sigma:g}"
        if self.sat_max:
            s += f"-s{self.sat_max}"
        if self.zone != "flat":
            s += f"-z{self.zone}"
        elif self.zone_gain != 1:
            s += f"-g{self.zone_gain:g}"
        return s


# The zone is a see-through orange over the map (S ~50-60 against ~5 for the bare map); the buildings under it still
# show. lib/minimap.js ZONE (S >= 55) only catches its darker half, which is enough to find it but not to erase it.
ZONE_FILL = [((10, 25, 100), (24, 85, 235))]
_K3 = np.ones((3, 3), np.uint8)
_K5 = np.ones((5, 5), np.uint8)


def zone_region(d: np.ndarray) -> np.ndarray:
    """The zone's area in a minimap disc (holes filled), empty when there is none."""
    z = in_range(cv2.cvtColor(d, cv2.COLOR_BGR2HSV), ZONE_FILL).astype(np.uint8)
    z = cv2.morphologyEx(z, cv2.MORPH_OPEN, _K3)
    if z.sum() < 60:
        return np.zeros(z.shape, bool)
    return cv2.morphologyEx(z, cv2.MORPH_CLOSE, _K5) > 0


def disc_mask(d: np.ndarray, p: Prep, cam: float | None) -> np.ndarray:
    """Pixels of a minimap disc that show the map: not the arrow, fan, marks, rim, the zone's edge (or all of it)."""
    m = (R_MAP <= p.r_use) & (R_MAP > p.r_arrow)
    if cam is not None:
        da = np.abs(((A_MAP - cam) + 180) % 360 - 180)
        m &= ~((da <= p.fan_half) & (R_MAP <= p.fan_r))
    else:
        m &= R_MAP > p.fan_r  # fan not found: leave out everything it could cover
    hsv = cv2.cvtColor(d, cv2.COLOR_BGR2HSV)
    bad = np.zeros(m.shape, bool)
    if p.red:
        bad |= in_range(hsv, RED)
    if p.sat_max:
        bad |= (hsv[:, :, 1] > p.sat_max) & ~in_range(hsv, ZONE_FILL)
    if bad.any():
        m &= ~(cv2.dilate(bad.astype(np.uint8), _K5) > 0)
    if p.zone != "none":
        z = zone_region(d)
        if z.any():
            zu = z.astype(np.uint8)
            m &= ~(z if p.zone == "mask" else (cv2.dilate(zu, _K5) > 0) & ~(cv2.erode(zu, _K5) > 0))
    return m


def _nblur(x: np.ndarray, m: np.ndarray, s: float) -> np.ndarray:
    """Gaussian blur over the masked-in pixels only (normalized convolution)."""
    mf = m.astype(np.float32)
    num = cv2.GaussianBlur(x * mf, (0, 0), s)
    den = cv2.GaussianBlur(mf, (0, 0), s)
    return num / np.maximum(den, 1e-3)


def _filter(g: np.ndarray, m: np.ndarray, p: Prep) -> np.ndarray:
    if p.kind == "raw":
        return g
    if p.kind == "hp":
        return g - _nblur(g, m, p.sigma)
    if p.kind == "dog":
        return _nblur(g, m, p.pre) - _nblur(g, m, p.sigma)
    if p.kind == "grad":
        b = _nblur(g, m, p.sigma)
        return np.hypot(cv2.Sobel(b, cv2.CV_32F, 1, 0), cv2.Sobel(b, cv2.CV_32F, 0, 1))
    if p.kind == "canny":
        b = np.clip(_nblur(g, m, 1.0), 0, 255).astype(np.uint8)
        return cv2.GaussianBlur(cv2.Canny(b, 20, 50).astype(np.float32), (0, 0), 1.0)
    raise ValueError(p.kind)


def prep(bgr: np.ndarray, m: np.ndarray, p: Prep) -> np.ndarray:
    """The image to match (float32) and its mask; masked-out pixels come out 0. With the zone flattened, its inside
    and the rest are filtered apart, so its tint and its edge (left out by the mask) do not show."""
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    z = zone_region(bgr) if p.zone == "flat" else None
    if z is not None and (z & m).any():
        out = np.where(z, _filter(g, m & z, p) * p.zone_gain, _filter(g, m & ~z, p))
    else:
        out = _filter(g, m, p)
    # pixels next to a masked one see its fill: leave them out too
    mm = cv2.erode(m.astype(np.uint8), _K3) > 0
    return np.where(mm, out, 0).astype(np.float32), mm


# ---- matching


@dataclass
class Ref:
    """A reference image at minimap scale, and how its pixels map to positions: rel = (px - origin) * k."""

    img: np.ndarray  # BGR
    valid: np.ndarray  # bool: pixels with map on them
    origin: tuple[float, float]  # reference px of the stronghold icon
    k: float = K
    name: str = ""
    off: tuple[float, float] = (0.0, 0.0)  # where() minus what the match says (calibrated per zoom)
    _cache: dict | None = None

    def to_px(self, x: float, y: float) -> tuple[float, float]:
        return self.origin[0] + (x - self.off[0]) / self.k, self.origin[1] + (y - self.off[1]) / self.k

    def to_rel(self, u: float, v: float) -> tuple[float, float]:
        return (u - self.origin[0]) * self.k + self.off[0], (v - self.origin[1]) * self.k + self.off[1]

    def prepped(self, p: Prep) -> np.ndarray:
        self._cache = self._cache or {}
        key = p.name()
        if key not in self._cache:
            q = Prep(**{**p.__dict__, "sat_max": 0})
            out, _ = prep(self.img, self.valid, q)
            self._cache[key] = out
        return self._cache[key]


def _sub(r: np.ndarray, x: int, y: int) -> tuple[float, float]:
    """Parabola peak refinement."""
    dx = dy = 0.0
    if 0 < x < r.shape[1] - 1:
        a, b, c = r[y, x - 1], r[y, x], r[y, x + 1]
        den = a - 2 * b + c
        dx = 0.5 * (a - c) / den if den < 0 else 0.0
    if 0 < y < r.shape[0] - 1:
        a, b, c = r[y - 1, x], r[y, x], r[y + 1, x]
        den = a - 2 * b + c
        dy = 0.5 * (a - c) / den if den < 0 else 0.0
    return x + max(-0.5, min(0.5, dx)), y + max(-0.5, min(0.5, dy))


def locate(d: np.ndarray, ref: Ref, p: Prep, prior: tuple[float, float] | None = None, radius: float = 40,
           cam: float | None = None, cam_known: bool = False) -> dict | None:
    """Where minimap disc `d` (disc() of a screenshot) is in `ref`: {x, y, score, second} (rel coords), None if off
    the ref. `radius`: search within this many big map px of `prior` (None: the whole reference)."""
    if not cam_known:
        cam = heading(d)
    m = disc_mask(d, p, cam)
    t, tm = prep(d, m, p)
    R = ref.prepped(p)
    h, w = t.shape
    if prior is None:
        u0, v0, u1, v1 = 0, 0, R.shape[1] - w, R.shape[0] - h
    else:
        pu, pv = ref.to_px(*prior)
        rr = radius / ref.k
        u0, v0 = max(0, int(math.floor(pu - rr - C))), max(0, int(math.floor(pv - rr - C)))
        u1, v1 = min(R.shape[1] - w, int(math.ceil(pu + rr - C))), min(R.shape[0] - h, int(math.ceil(pv + rr - C)))
    if u1 < u0 or v1 < v0:
        return None
    win = R[v0 : v1 + h, u0 : u1 + w]
    r = cv2.matchTemplate(win, t, cv2.TM_CCOEFF_NORMED, mask=tm.astype(np.uint8))
    r[~np.isfinite(r)] = -1
    _, best, _, (bx, by) = cv2.minMaxLoc(r)
    fx, fy = _sub(r, bx, by)
    # second peak: best outside 4 px of the first
    r2 = r.copy()
    cv2.circle(r2, (bx, by), 4, -1, -1)
    second = float(r2.max()) if r2.size else -1
    x, y = ref.to_rel(u0 + fx + C, v0 + fy + C)
    return {"x": x, "y": y, "score": float(best), "second": second, "cam": cam, "used": int(tm.sum())}


def register(a: np.ndarray, b: np.ndarray, p: Prep, cam_a=None, cam_b=None, r_t: int = 30, max_shift: int = 12):
    """Shift of the map from minimap disc a to b (minimap px; where a's center shows in b, minus the center):
    a's inner r_t disc matched inside b. Returns (dx, dy, score)."""
    ma = disc_mask(a, p, cam_a) & (R_MAP <= r_t)
    mb = disc_mask(b, p, cam_b)
    ta, tma = prep(a, ma, p)
    tb, _ = prep(b, mb, p)
    s = C - r_t
    t = ta[s : C + r_t + 1, s : C + r_t + 1]
    tm = tma[s : C + r_t + 1, s : C + r_t + 1]
    lo = max(0, s - max_shift)
    win = tb[lo : C + r_t + 1 + max_shift, lo : C + r_t + 1 + max_shift]
    r = cv2.matchTemplate(win, t, cv2.TM_CCOEFF_NORMED, mask=tm.astype(np.uint8))
    r[~np.isfinite(r)] = -1
    _, best, _, (bx, by) = cv2.minMaxLoc(r)
    fx, fy = _sub(r, bx, by)
    return lo + fx - s, lo + fy - s, float(best)


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


# ---- the app's version (android/app/src/main/cpp/locate_core.cpp), built for the PC:
#   g++ -O2 -shared -static -std=c++20 -o data/build/locate.dll android/app/src/main/cpp/locate_core.cpp

import ctypes


class _LocPrep(ctypes.Structure):
    _fields_ = [("kind", ctypes.c_int), ("pre", ctypes.c_float), ("sigma", ctypes.c_float), ("r_use", ctypes.c_int),
                ("r_arrow", ctypes.c_int), ("fan_r", ctypes.c_int), ("fan_half", ctypes.c_float),
                ("sat_max", ctypes.c_int), ("zone", ctypes.c_int), ("zone_gain", ctypes.c_float)]


KINDS = {"raw": 0, "hp": 1, "dog": 2, "grad": 3, "canny": 4}
ZONE_MODES = {"flat": 0, "mask": 1, "none": 2}


def loc_prep(p: Prep) -> _LocPrep:
    return _LocPrep(KINDS[p.kind], p.pre, p.sigma, p.r_use, p.r_arrow, p.fan_r, p.fan_half, p.sat_max,
                    ZONE_MODES[p.zone], p.zone_gain)


class Native:
    def __init__(self, path: Path):
        self.lib = ctypes.CDLL(str(path))
        L = self.lib
        L.loc_ref_create.restype = ctypes.c_void_p
        L.loc_ref_create.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.POINTER(_LocPrep)]
        L.loc_ref_destroy.argtypes = [ctypes.c_void_p]
        L.loc_run.restype = ctypes.c_int
        L.loc_run.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_float, ctypes.c_float,
                              ctypes.c_float, ctypes.c_float, ctypes.POINTER(_LocPrep), ctypes.POINTER(ctypes.c_float * 5)]
        self._refs: dict = {}

    def ref(self, ref: Ref, p: Prep):
        key = (id(ref), p.name())
        if key not in self._refs:
            img = np.ascontiguousarray(ref.img)
            valid = np.ascontiguousarray(ref.valid.astype(np.uint8))
            lp = loc_prep(p)
            self._refs[key] = (self.lib.loc_ref_create(img.tobytes(), img.shape[1] * 3, valid.tobytes(), img.shape[1], img.shape[0], ctypes.byref(lp)), img, valid)
        return self._refs[key][0]

    def locate(self, d, ref: Ref, p: Prep, prior=None, radius=40, cam=None):
        h = self.ref(ref, p)
        d = np.ascontiguousarray(d)
        out = (ctypes.c_float * 5)()
        pu, pv = ref.to_px(*prior) if prior is not None else (0.0, 0.0)
        rr = radius / ref.k if prior is not None else -1.0
        lp = loc_prep(p)
        if not self.lib.loc_run(h, d.tobytes(), 110 * 3, float("nan") if cam is None else cam, pu, pv, rr, ctypes.byref(lp), ctypes.byref(out)):
            return None
        x, y = ref.to_rel(out[0], out[1])
        return {"x": x, "y": y, "score": out[2], "second": out[3], "cam": cam, "used": int(out[4])}


NATIVE: Native | None = None  # set by --native: locate() goes through the app's code


def best_of(d, refs: list[Ref], p: Prep, prior=None, radius=40, cam=None):
    """locate() in each reference (one per zoom), the best scoring one; with its ref."""
    out = None
    for ref in refs:
        if NATIVE:
            r = NATIVE.locate(d, ref, p, prior, radius, cam)
        else:
            r = locate(d, ref, p, prior, radius, cam=cam, cam_known=True)
        if r and (out is None or r["score"] > out[0]["score"]):
            out = (r, ref)
    return out


# ---- data


def load_frames(root: Path):
    fr = [json.loads(l) for l in open(root / "survey1" / "frames.jsonl", encoding="utf-8")]
    return [(f["seq"], root / "survey1" / f"{f['seq']}.jpg") for f in fr]


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


def cache_frames(root: Path) -> None:
    """frames.npz: every grabbed frame's minimap disc, whether it is the world screen, the camera heading."""
    seqs, discs, world, cams = [], [], [], []
    for seq, p in load_frames(root):
        img = imread(p)
        if img is None:
            continue
        d = disc(img).copy()
        w = in_world(img, root)
        c = heading(d) if w else None
        seqs.append(seq), discs.append(d), world.append(w), cams.append(np.nan if c is None else c)
    np.savez(root / "frames.npz", seq=np.array(seqs), world=np.array(world), disc=np.array(discs), cam=np.array(cams))


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


def _chain(D, cam, fr, p: Prep, k: float, start: np.ndarray, step_max=5.0, sc_min=0.6):
    """Positions of frames fr (in order) from `start` at fr[0], chaining minimap registrations through keyframes."""
    camof = lambda i: None if np.isnan(cam[i]) else float(cam[i])
    key, kpos, pos, scores, prev = fr[0], start.copy(), [start.copy()], [], fr[0]
    for i in fr[1:]:
        dx, dy, sc = register(D[key], D[i], p, camof(key), camof(i))
        if sc < sc_min or abs(dx) > step_max or abs(dy) > step_max:
            key, kpos = prev, pos[-1].copy()
            dx, dy, sc = register(D[key], D[i], p, camof(key), camof(i))
        pos.append(kpos - k * np.array([dx, dy]))
        scores.append(sc)
        prev = i
    return np.array(pos), scores


def track(root: Path, p: Prep) -> list[dict]:
    """Positions of the grabbed frames between anchors (route.js `anchors`, where() before each look at the map).
    Each stretch between two looks starts zoomed out (closing the map resets the minimap) and, in the courtyard,
    zooms in after a second or two. Frames are told apart by which zoom of the big map they match better (only the
    zoom is taken from it); the zoomed-out part is chained forward from the anchor it starts at, the zoomed-in part
    backward from the anchor it ends at; a stretch that stays zoomed out is chained forward and its drift at the end
    spread along the way."""
    z = np.load(root / "frames.npz")
    seq, D, cam = z["seq"], z["disc"], z["cam"]
    good = good_frames(z["world"])
    anchors = json.load(open(root / "anchors.json"))
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
            r = best_of(D[i], refs, p, tuple(prior), 45, None if np.isnan(cam[i]) else float(cam[i]))
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
            raw, _ = _chain(D, cam, fr, p, 1.0, np.zeros(2))  # minimap px, to fit the zoom with
            pos = A + ZOOMS[zm] * raw
            steps = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pos, axis=0), axis=1))]
            drift = B - pos[-1]
            pos = pos + np.outer(steps / max(steps[-1], 1e-6), drift)
            rows += [(fr[t], pos[t], zm, "spread") for t in range(len(fr))]
            fits.append((zm, raw[-1], B - A, steps[-1]))
            print(seg, zm, len(fr), "drift", np.round(drift, 1), "path", round(float(steps[-1]), 1))
        else:
            if n_out > 2:
                pos, _ = _chain(D, cam, fr[: n_out - 2], p, ZOOMS["out"], A)
                rows += [(fr[t], pos[t], "out", "fwd") for t in range(n_out - 2)]
            if len(fr) - n_in > 2:
                back = fr[n_in + 2 :][::-1]
                pos, _ = _chain(D, cam, back, p, ZOOMS["in"], B)
                rows += [(back[t], pos[t], "in", "bwd") for t in range(len(back))]
            print(seg, "out", n_out, "in", len(fr) - n_in, "of", len(fr))
        for i, q, zm, how in sorted(rows, key=lambda r: r[0]):
            out.append({"seq": int(seq[i]), "x": round(float(q[0]), 2), "y": round(float(q[1]), 2), "zoom": zm,
                        "how": how, "seg": seg, "run": a0["run"][:2]})
    for zm in ZOOMS:  # the zoom that fits the chains best (stretches that moved, that did not go astray)
        f = [(c, d) for z_, c, d, path in fits if z_ == zm and np.linalg.norm(d) > 8 and path < 2 * np.linalg.norm(d) + 10]
        if f:
            c, d = np.array([x[0] for x in f]), np.array([x[1] for x in f])
            k = (c * d).sum() / (c * c).sum()
            print(zm, "zoom fit", round(float(k), 3), "from", len(f), "stretches; residuals", np.round(np.linalg.norm(d - k * c, axis=1), 1))
    json.dump(out, open(root / "track.json", "w"), indent=0)
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
    """Source 2: a mosaic of the minimap discs of tracked frames (track.json) at one zoom, from the given runs: each
    disc (arrow, fan, marks, rim left out) placed at its position, the median of what lands on each pixel (the fan,
    see-through scenery and marks differ from frame to frame; the map does not). A frame is only taken once it has
    moved `step` minimap px from the last one taken, so standing still does not outvote the rest. Stretches whose
    chain drifted more than `max_drift` (track's report) are left out.
    Returns (image, valid, origin, spread): spread is the median absolute deviation of the samples, a measure of how
    well the frames line up (smaller is better; used to fit k)."""
    k = k or ZOOMS[zoom]
    tr = [t for t in json.load(open(root / "track.json")) if t["run"] in {r[:2] for r in runs} and t["zoom"] == zoom]
    bad = set(json.load(open(root / "track_drift.json")).get("bad", [])) if (root / "track_drift.json").exists() else set()
    tr = [t for t in tr if t["seg"] not in bad]
    z = np.load(root / "frames.npz")
    idx = {int(s): i for i, s in enumerate(z["seq"])}
    D, cam = z["disc"], z["cam"]
    xs, ys = [t["x"] for t in tr], [t["y"] for t in tr]
    pad = C + 4
    x0, y0 = min(xs) / k - pad, min(ys) / k - pad
    w, h = int(math.ceil(max(xs) / k - x0 + pad)), int(math.ceil(max(ys) / k - y0 + pad))
    p = Prep()
    stack, masks, last = [], [], None
    for t in tr:
        u, v = t["x"] / k - x0, t["y"] / k - y0
        if last is not None and math.hypot(u - last[0], v - last[1]) < step:
            continue
        last = (u, v)
        i = idx[t["seq"]]
        c = None if np.isnan(cam[i]) else float(cam[i])
        m = disc_mask(D[i], Prep(zone="mask", sat_max=0), c)
        M = np.float32([[1, 0, u - C], [0, 1, v - C]])
        stack.append(cv2.warpAffine(D[i], M, (w, h), flags=cv2.INTER_LINEAR))
        masks.append(cv2.warpAffine(m.astype(np.uint8), M, (w, h), flags=cv2.INTER_NEAREST) > 0)
    S = np.array(stack).astype(np.float32)
    V = np.array(masks)
    S[~V] = np.nan
    with np.errstate(all="ignore"):
        med = np.nanmedian(S, axis=0)
        spread = float(np.nanmedian(np.abs(S - med[None]).mean(-1)[V]))
    n = V.sum(0)
    valid = n >= 3
    img = np.nan_to_num(med).astype(np.uint8)
    print(zoom, "k", k, "frames", len(stack), "of", len(tr), "size", (w, h), "spread", round(spread, 2))
    return img, valid, (-x0, -y0), spread, n


def mosaic_ref(root: Path, zoom: str, name: str = "mosaic") -> Ref:
    img = imread(root / name / f"{zoom}.png")
    meta = json.load(open(root / name / f"{zoom}.json"))
    valid = imread(root / name / f"{zoom}_valid.png")[:, :, 0] > 0
    return Ref(img, valid, tuple(meta["origin"]), meta["k"], f"{name}-{zoom}")


def save_mosaic(root: Path, zoom: str, runs, k: float, name: str = "mosaic") -> None:
    img, valid, origin, spread, n = stitch(root, zoom, runs, k)
    imwrite(root / name / f"{zoom}.png", img)
    imwrite(root / name / f"{zoom}_valid.png", (valid * 255).astype(np.uint8))
    json.dump({"origin": origin, "k": k, "runs": list(runs), "spread": spread}, open(root / name / f"{zoom}.json", "w"))
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
    "raw": Prep(kind="raw"),
    "hp3": Prep(kind="hp", sigma=3),
    "hp6": Prep(kind="hp", sigma=6),
    "dog1-4": Prep(kind="dog", pre=1, sigma=4),
    "dog1.5-5": Prep(kind="dog", pre=1.5, sigma=5),
    "dog2-8": Prep(kind="dog", pre=2, sigma=8),
    "grad1.5": Prep(kind="grad", sigma=1.5),
    "grad2.5": Prep(kind="grad", sigma=2.5),
    "canny": Prep(kind="canny"),
    "dog1.5-5-zmask": Prep(kind="dog", pre=1.5, sigma=5, zone="mask"),
    "dog1.5-5-znone": Prep(kind="dog", pre=1.5, sigma=5, zone="none"),
    "dog1.5-5-s60": Prep(kind="dog", pre=1.5, sigma=5, sat_max=60),
}


def eval_items(root: Path, holdout=("s2",), every: int = 2):
    """(name, disc, truth, category, split) to test on: the anchor screenshots, the known teaching screenshots, and
    every `every`-th tracked frame. split: train (its run went into the mosaic) / test."""
    items = []
    inside = lambda x, y: y < 52 and x > -48  # past the gate
    for a in json.load(open(root / "anchors.json")):
        d = disc(imread(WS / "teaching" / "survey" / a["run"] / f"{a['n']:03d}.png")).copy()
        split = "test" if a["run"][:2] in holdout else "train"
        items.append((f"anchor {a['run']}/{a['n']}", d, (a["x"], a["y"]), "in" if inside(a["x"], a["y"]) else "out", split))
    known = root / "explore_backup"  # a copy: the app's explore draft reuses those file names once cleared
    for f, xy in KNOWN.items():
        d = disc(imread((known if known.is_dir() else WS / "teaching" / "explore") / f"{f}.png")).copy()
        cat = ("in-zone" if zone_region(d).any() else "in") if inside(*xy) else ("out-zone" if zone_region(d).any() else "out")
        items.append((f"known {f}", d, xy, cat, "test"))
    z = np.load(root / "frames.npz")
    idx = {int(s): i for i, s in enumerate(z["seq"])}
    bad = set(json.load(open(root / "track_drift.json")).get("bad", []))
    tr = [t for t in json.load(open(root / "track.json")) if t["seg"] not in bad]
    for t in tr[::every]:
        split = "test" if t["run"] in holdout else "train"
        items.append((f"frame {t['seq']}", z["disc"][idx[t["seq"]]], (t["x"], t["y"]),
                      "in" if inside(t["x"], t["y"]) else "out", split))
    return items


def evaluate(root: Path, sources: dict[str, list[Ref]], preps: dict[str, Prep], items, offset: float = 8,
             radius: float = 30, full: bool = True, out_path: Path | None = None):
    """Each item located in each source (all its zooms, the best) with each preprocessing, near a prior `offset` px
    off the truth (as the dead reckoning would give it) and over the whole reference. Rows: dicts; see summary()."""
    rows = []
    for n, (name, d, (tx, ty), cat, split) in enumerate(items):
        cam = heading(d)
        ang = n * 2.399  # prior offsets in varied directions
        prior = (tx + offset * math.cos(ang), ty + offset * math.sin(ang))
        for sn, refs in sources.items():
            for pn, p in preps.items():
                for search in (["near", "full"] if full else ["near"]):
                    r = best_of(d, refs, p, prior if search == "near" else None, radius, cam)
                    if r is None:
                        rows.append({"item": name, "cat": cat, "split": split, "source": sn, "prep": pn, "search": search, "err": None})
                        continue
                    o, ref = r
                    rows.append({"item": name, "cat": cat, "split": split, "source": sn, "prep": pn, "search": search,
                                 "err": round(float(math.hypot(o["x"] - tx, o["y"] - ty)), 2), "dx": round(float(o["x"] - tx), 2),
                                 "dy": round(float(o["y"] - ty), 2), "score": round(o["score"], 3), "second": round(o["second"], 3),
                                 "zoom": ref.name.split("-")[-1]})
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    return rows


def summary(rows, tol: float = 6.0, by=("source", "prep", "search", "cat")):
    """Per group: n, share within `tol`, median / p90 error, median score and margin over the second peak."""
    groups: dict[tuple, list] = {}
    for r in rows:
        groups.setdefault(tuple(r[k] for k in by), []).append(r)
    lines = []
    for key in sorted(groups):
        g = groups[key]
        e = np.array([r["err"] if r["err"] is not None else 1e9 for r in g])
        sc = np.array([r.get("score", -1) for r in g])
        mg = np.array([r.get("score", -1) - r.get("second", -1) for r in g])
        lines.append((key, len(g), float((e <= tol).mean()), float(np.median(e)), float(np.percentile(e, 90)),
                      float(np.median(sc)), float(np.median(mg))))
    return lines


def print_summary(lines, by=("source", "prep", "search", "cat")):
    print(" | ".join(by) + " | n | <=6px | median | p90 | score | margin")
    for key, n, ok, med, p90, sc, mg in lines:
        print(" | ".join(map(str, key)) + f" | {n} | {ok:.0%} | {med:.1f} | {p90:.1f} | {sc:.2f} | {mg:.2f}")


# What each source is matched with in the app (the best of eval: margin over the second peak, share within 6 px)
APP_PREPS = {"mosaic": "dog1-4", "bigmap": "canny"}


def export(root: Path, name: str, runs, crop=(-320, -260, 640, 580)) -> None:
    """Write the app's references to the workspace: templates/locate/<name>_<source>.json with a PNG per zoom (alpha:
    where the reference is known). The json has what skills/locate() needs: per zoom level the image, k (big map px
    per px), origin (px of the stronghold icon), off (added to the result: where() frame), and the preprocessing."""
    out_dir = TEMPLATES / "locate"
    mosaic_dir = f"mosaic_{'_'.join(runs)}"
    for zoom in ZOOMS:
        save_mosaic(root, zoom, runs, ZOOMS[zoom], mosaic_dir)
    for source in ("mosaic", "bigmap"):
        levels = []
        for zoom in ZOOMS:
            if source == "mosaic":
                ref = mosaic_ref(root, zoom, mosaic_dir)
            else:
                ref = bigmap_ref(root, zoom)
                # only around the stronghold (the whole composite is large at the courtyard's zoom)
                x, y, w, h = crop
                u0, v0 = int(ref.to_px(x, y)[0]), int(ref.to_px(x, y)[1])
                u1, v1 = int(ref.to_px(x + w, y + h)[0]), int(ref.to_px(x + w, y + h)[1])
                u0, v0 = max(u0, 0), max(v0, 0)
                ref = Ref(ref.img[v0:v1, u0:u1], ref.valid[v0:v1, u0:u1], (ref.origin[0] - u0, ref.origin[1] - v0), ref.k, ref.name, ref.off)
            png = f"locate/{name}_{source}_{zoom}.png"
            bgra = cv2.cvtColor(ref.img, cv2.COLOR_BGR2BGRA)
            bgra[:, :, 3] = np.where(ref.valid, 255, 0)
            imwrite(TEMPLATES / png, bgra)
            levels.append({"zoom": zoom, "image": png, "k": ref.k, "origin": [round(float(v), 2) for v in ref.origin],
                           "off": [round(float(v), 2) for v in ref.off]})
        p = PREPS[APP_PREPS[source]]
        meta = {
            "desc": f"{name}: minimap reference ({'stitched from survey runs ' + ', '.join(runs) if source == 'mosaic' else 'the big map, scaled'}), "
                    "made by scripts/minimap_locate.py export",
            "levels": levels,
            "prep": {"kind": p.kind, "pre": p.pre, "sigma": p.sigma},
        }
        json.dump(meta, open(out_dir / f"{name}_{source}.json", "w", encoding="utf-8"), ensure_ascii=False, indent=4)
        print("wrote", out_dir / f"{name}_{source}.json")


TRACK_PREP = Prep(kind="dog", pre=1.5, sigma=5)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["cache", "bigmap", "track", "stitch", "eval", "export"])
    ap.add_argument("root", type=Path)
    ap.add_argument("--runs", default="s1", help="stitch: the survey runs that make the mosaic (the rest test it)")
    ap.add_argument("--preps", default="", help="eval: preprocessings to try (PREPS keys), default all")
    ap.add_argument("--every", type=int, default=2, help="eval: every n-th tracked frame")
    ap.add_argument("--near-only", action="store_true", help="eval: skip the whole-reference search")
    ap.add_argument("--name", default="cixin", help="export: the references' name (templates/locate/<name>_*)")
    ap.add_argument("--native", type=Path, help="eval: locate with the app's code built for the PC (locate.dll)")
    a = ap.parse_args()
    if a.native:
        global NATIVE
        NATIVE = Native(a.native)
    if a.cmd == "cache":
        cache_frames(a.root)
    elif a.cmd == "bigmap":
        build_bigmap(a.root)
    elif a.cmd == "track":
        track(a.root, TRACK_PREP)
    elif a.cmd == "stitch":
        for zoom in ZOOMS:
            save_mosaic(a.root, zoom, a.runs.split(","), ZOOMS[zoom])
    elif a.cmd == "export":
        export(a.root, a.name, a.runs.split(","))
    elif a.cmd == "eval":
        sources = {"bigmap": [bigmap_ref(a.root, z) for z in ZOOMS], "mosaic": [mosaic_ref(a.root, z) for z in ZOOMS]}
        preps = {k: PREPS[k] for k in a.preps.split(",")} if a.preps else PREPS
        items = eval_items(a.root, every=a.every)
        rows = evaluate(a.root, sources, preps, items, full=not a.near_only,
                        out_path=a.root / ("eval_native.jsonl" if a.native else "eval.jsonl"))
        print_summary(summary([r for r in rows if r["split"] == "test" or r["source"] == "bigmap"]))


if __name__ == "__main__":
    main()
