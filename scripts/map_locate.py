"""Locating a screen region inside a reference image, offline: what the app's locate() does, checked on PC.

A crop of the screen (e.g. a north-up minimap) is matched inside a reference image drawn at the same scale: a map
screenshot scaled down, or a mosaic stitched from crops grabbed along a route (register / chain / mosaic here).
Positions are whatever units the reference's levels give (rel = (px - origin) * k + off).

What is game specific comes in a Config, the same fields as the reference JSON the app reads (skill/Locate.kt):
the crop (center on screen, size), its mask (circle, a wedge around a heading passed per call, HSV colors dropped,
saturated pixels), a see-through overlay of one color (regions: filtered apart or masked out) and the preprocessing.
A workspace's tool holds its values and the survey around them (e.g. workspaces/WhereWindsMeet/tools/wwm_locate.py),
imports this with scripts/ on sys.path, and writes the app's references with write_reference(). Needs the cv extra:
`uv sync --extra cv`.

The app's C++ (android/app/src/main/cpp/locate_core.cpp) is checked against this with Native, built for the PC:

    g++ -O2 -Wall -shared -static -std=c++20 -o data/build/locate.dll android/app/src/main/cpp/locate_core.cpp
"""

from __future__ import annotations

import ctypes
import json
import math
from dataclasses import dataclass, field, replace
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np

# an HSV range as OpenCV's (H 0-180, S and V 0-255), bounds included: ((h, s, v) lo, (h, s, v) hi)
Range = tuple[tuple[int, int, int], tuple[int, int, int]]
KINDS = {"raw": 0, "hp": 1, "dog": 2, "grad": 3, "canny": 4}
REGION_MODES = {"flat": 0, "mask": 1, "none": 2}


def imread(p: Path | str) -> np.ndarray:
    return cv2.imdecode(np.fromfile(str(p), np.uint8), cv2.IMREAD_COLOR)


def imwrite(p: Path | str, img: np.ndarray) -> None:
    Path(p).parent.mkdir(parents=True, exist_ok=True)
    ok, buf = cv2.imencode(Path(p).suffix, img)
    assert ok
    buf.tofile(str(p))


def in_range(hsv: np.ndarray, ranges) -> np.ndarray:
    m = np.zeros(hsv.shape[:2], np.uint8)
    for lo, hi in ranges:
        m |= cv2.inRange(hsv, np.array(lo), np.array(hi))
    return m > 0


def range_json(r: Range) -> dict:
    return {"h": [r[0][0], r[1][0]], "s": [r[0][1], r[1][1]], "v": [r[0][2], r[1][2]]}


def range_of(o: dict) -> Range:
    ch = [o.get(c, [0, 255]) for c in "hsv"]
    return (ch[0][0], ch[1][0], ch[2][0]), (ch[0][1], ch[1][1], ch[2][1])


# ---- configuration: the reference JSON's crop / mask / regions / prep


@dataclass(frozen=True)
class Prep:
    """How a crop (or a reference) is filtered into the image that gets matched."""

    kind: str = "dog"  # raw | hp (minus a blur) | dog (blur minus a wider blur) | grad | canny
    pre: float = 1.0  # dog: pre-blur (JPEG blocks and see-through noise)
    sigma: float = 4.0  # hp / dog: the blur taken away; grad: pre-blur

    def json(self) -> dict:
        return {"kind": self.kind, "pre": self.pre, "sigma": self.sigma}


@dataclass(frozen=True)
class Regions:
    """A see-through overlay of one color over the map (things drawn under it still show)."""

    color: Range
    mode: str = "flat"  # flat (its inside filtered apart from the rest, its edge left out) | mask (left out) | none
    gain: float = 1.0  # flat: its inside's contrast times this
    open: int = 0  # its area: opened with this kernel, dropped under min_px, closed with this one
    min_px: int = 0
    close: int = 0
    edge: int = 0  # flat: the band this wide around its border is left out

    def json(self) -> dict:
        return {**range_json(self.color), "mode": self.mode, "gain": self.gain, "open": self.open,
                "min_px": self.min_px, "close": self.close, "edge": self.edge}


@dataclass(frozen=True)
class Config:
    """What locate() needs besides the reference: a size x size crop around `center` on screen (the point located is
    its middle, (size - 1) // 2) and which of its pixels count. Mirrors the reference JSON (skill/Locate.kt)."""

    center: tuple[float, float]  # crop.center, screen px
    size: int  # crop.size
    circle: tuple[float, float] | None = None  # mask.circle: keep inner < r <= outer (None: the whole square)
    wedge: tuple[float, float] | None = None  # mask.wedge (r, half): left out r <= r within ±half of the heading
    drop: tuple[Range, ...] = ()  # mask.drop: colors left out, grown by `grow` px
    grow: int = 0
    sat_max: int = 0  # mask.sat_max: > 0 leave out pixels more saturated than this, the regions' color excepted
    regions: Regions | None = None
    prep: Prep = field(default_factory=Prep)

    @property
    def mid(self) -> int:
        return (self.size - 1) // 2

    @property
    def roi(self) -> tuple[int, int, int, int]:
        """The crop in the screenshot: x, y, w, h."""
        return round(self.center[0]) - self.mid, round(self.center[1]) - self.mid, self.size, self.size

    def crop(self, img: np.ndarray) -> np.ndarray:
        x, y, w, h = self.roi
        return img[y : y + h, x : x + w]

    def with_prep(self, **kw) -> Config:
        return replace(self, prep=replace(self.prep, **kw))

    def with_regions(self, **kw) -> Config:
        return replace(self, regions=replace(self.regions, **kw)) if self.regions else self

    def json(self) -> dict:
        """The reference JSON's crop / mask / regions / prep."""
        mask: dict = {}
        if self.circle:
            mask["circle"] = list(self.circle)
        if self.wedge:
            mask["wedge"] = {"r": self.wedge[0], "half": self.wedge[1]}
        if self.drop:
            mask["drop"] = [range_json(r) for r in self.drop]
        mask |= {"grow": self.grow, "sat_max": self.sat_max}
        out = {"crop": {"center": list(self.center), "size": self.size}, "mask": mask}
        if self.regions:
            out["regions"] = self.regions.json()
        return out | {"prep": self.prep.json()}

    @staticmethod
    def of(meta: dict) -> Config:
        """From a reference JSON (its crop / mask / regions / prep)."""
        crop, mask, reg, p = (meta.get(k) or {} for k in ("crop", "mask", "regions", "prep"))
        w = mask.get("wedge")
        regions = None
        if reg:
            regions = Regions(range_of(reg), reg.get("mode", "flat"), reg.get("gain", 1.0), reg.get("open", 0),
                              reg.get("min_px", 0), reg.get("close", 0), reg.get("edge", 0))
        return Config(tuple(crop["center"]), crop["size"], tuple(mask["circle"]) if "circle" in mask else None,
                      (w["r"], w["half"]) if w else None, tuple(range_of(r) for r in mask.get("drop", [])),
                      mask.get("grow", 0), mask.get("sat_max", 0), regions,
                      Prep(p.get("kind", "dog"), p.get("pre", 1.0), p.get("sigma", 4.0)))

    def key(self) -> str:
        return json.dumps(self.json(), sort_keys=True)


# ---- masks and preprocessing


@lru_cache(maxsize=8)
def polar(size: int) -> tuple[np.ndarray, np.ndarray]:
    """Distance from the crop's middle and compass bearing (degrees) of each crop pixel."""
    c = (size - 1) // 2
    yy, xx = np.mgrid[0:size, 0:size]
    return np.hypot(xx - c, yy - c), (np.degrees(np.arctan2(xx - c, c - yy)) + 360) % 360


def _kernel(k: int) -> np.ndarray | None:
    return np.ones((k, k), np.uint8) if k > 1 else None


_K3 = np.ones((3, 3), np.uint8)


def region(d: np.ndarray, c: Config) -> np.ndarray:
    """The regions' area in a crop (opened, holes closed), empty when there is none."""
    if not c.regions:
        return np.zeros(d.shape[:2], bool)
    g = c.regions
    z = in_range(cv2.cvtColor(d, cv2.COLOR_BGR2HSV), [g.color]).astype(np.uint8)
    if _kernel(g.open) is not None:
        z = cv2.morphologyEx(z, cv2.MORPH_OPEN, _kernel(g.open))
    if not z.any() or z.sum() < g.min_px:
        return np.zeros(z.shape, bool)
    if _kernel(g.close) is not None:
        z = cv2.morphologyEx(z, cv2.MORPH_CLOSE, _kernel(g.close))
    return z > 0


def crop_mask(d: np.ndarray, c: Config, wedge: float | None) -> np.ndarray:
    """Pixels of a crop that show the map: in the circle, not the wedge around `wedge` (None: the whole wedge),
    dropped colors, the regions' edge (or all of them)."""
    R, A = polar(c.size)
    m = (R <= c.circle[1]) & (R > c.circle[0]) if c.circle else np.ones(R.shape, bool)
    if c.wedge and c.wedge[0] > 0:
        r, half = c.wedge
        if wedge is not None:
            da = np.abs(((A - wedge) + 180) % 360 - 180)
            m &= ~((da <= half) & (R <= r))
        else:
            m &= R > r  # heading not known: leave out everything the wedge could cover
    hsv = cv2.cvtColor(d, cv2.COLOR_BGR2HSV)
    bad = in_range(hsv, c.drop)
    if c.sat_max:
        bad |= (hsv[:, :, 1] > c.sat_max) & ~(in_range(hsv, [c.regions.color]) if c.regions else False)
    if bad.any():
        k = _kernel(c.grow)
        m &= ~((cv2.dilate(bad.astype(np.uint8), k) > 0) if k is not None else bad)
    if c.regions and c.regions.mode != "none":
        z = region(d, c)
        if z.any():
            if c.regions.mode == "mask":
                m &= ~z
            elif _kernel(c.regions.edge) is not None:
                zu, k = z.astype(np.uint8), _kernel(c.regions.edge)
                m &= ~((cv2.dilate(zu, k) > 0) & ~(cv2.erode(zu, k) > 0))
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


def prep(bgr: np.ndarray, m: np.ndarray, c: Config) -> tuple[np.ndarray, np.ndarray]:
    """The image to match (float32) and its mask; masked-out pixels come out 0. With the regions flat, their inside
    and the rest are filtered apart, so their tint and their edge (left out by the mask) do not show."""
    g = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    z = region(bgr, c) if c.regions and c.regions.mode == "flat" else None
    if z is not None and (z & m).any():
        out = np.where(z, _filter(g, m & z, c.prep) * c.regions.gain, _filter(g, m & ~z, c.prep))
    else:
        out = _filter(g, m, c.prep)
    # pixels next to a masked one see its fill: leave them out too
    mm = cv2.erode(m.astype(np.uint8), _K3) > 0
    return np.where(mm, out, 0).astype(np.float32), mm


# ---- matching


@dataclass
class Ref:
    """A reference image at the crop's scale, and how its pixels map to positions: rel = (px - origin) * k + off."""

    img: np.ndarray  # BGR
    valid: np.ndarray  # bool: pixels with map on them
    origin: tuple[float, float]  # reference px of the position origin
    k: float = 1.0  # position units per reference px
    name: str = ""
    off: tuple[float, float] = (0.0, 0.0)  # added to the result
    _cache: dict | None = None

    def to_px(self, x: float, y: float) -> tuple[float, float]:
        return self.origin[0] + (x - self.off[0]) / self.k, self.origin[1] + (y - self.off[1]) / self.k

    def to_rel(self, u: float, v: float) -> tuple[float, float]:
        return (u - self.origin[0]) * self.k + self.off[0], (v - self.origin[1]) * self.k + self.off[1]

    def cut(self, x: float, y: float, w: float, h: float) -> Ref:
        """The part from (x, y) to (x + w, y + h) (position units)."""
        u0, v0 = (int(t) for t in self.to_px(x, y))
        u1, v1 = (int(t) for t in self.to_px(x + w, y + h))
        u0, v0 = max(u0, 0), max(v0, 0)
        return Ref(self.img[v0:v1, u0:u1], self.valid[v0:v1, u0:u1], (self.origin[0] - u0, self.origin[1] - v0),
                   self.k, self.name, self.off)

    def prepped(self, c: Config) -> np.ndarray:
        self._cache = self._cache or {}
        c = replace(c, sat_max=0)
        key = c.key()
        if key not in self._cache:
            out, _ = prep(self.img, self.valid, c)
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


def locate(d: np.ndarray, ref: Ref, c: Config, prior: tuple[float, float] | None = None, radius: float = 40,
           wedge: float | None = None) -> dict | None:
    """Where crop `d` (c.crop() of a screenshot) is in `ref`: {x, y, score, second, used} (position units), None if
    off the ref. `radius`: search within this many position units of `prior` (None: the whole reference). wedge:
    the heading for the mask's wedge (None: not known)."""
    C = c.mid
    m = crop_mask(d, c, wedge)
    t, tm = prep(d, m, c)
    R = ref.prepped(c)
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
    return {"x": x, "y": y, "score": float(best), "second": second, "wedge": wedge, "used": int(tm.sum())}


def register(a: np.ndarray, b: np.ndarray, c: Config, wedge_a=None, wedge_b=None, r_t: int = 30, max_shift: int = 12):
    """Shift of the map from crop a to b (crop px; where a's middle shows in b, minus the middle): a's inner r_t
    disc matched inside b. Returns (dx, dy, score)."""
    C = c.mid
    ma = crop_mask(a, c, wedge_a) & (polar(c.size)[0] <= r_t)
    mb = crop_mask(b, c, wedge_b)
    ta, tma = prep(a, ma, c)
    tb, _ = prep(b, mb, c)
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


def chain(D, wedges, fr, c: Config, k: float, start: np.ndarray, step_max=5.0, sc_min=0.6):
    """Positions of crops D[fr] (in order) from `start` at fr[0], chaining registrations through keyframes (a new
    one where the shift from the last got too large or unsure). wedges: per crop, the heading or NaN. k: position
    units per crop px."""
    wof = lambda i: None if np.isnan(wedges[i]) else float(wedges[i])
    key, kpos, pos, scores, prev = fr[0], start.copy(), [start.copy()], [], fr[0]
    for i in fr[1:]:
        dx, dy, sc = register(D[key], D[i], c, wof(key), wof(i))
        if sc < sc_min or abs(dx) > step_max or abs(dy) > step_max:
            key, kpos = prev, pos[-1].copy()
            dx, dy, sc = register(D[key], D[i], c, wof(key), wof(i))
        pos.append(kpos - k * np.array([dx, dy]))
        scores.append(sc)
        prev = i
    return np.array(pos), scores


# ---- the app's version (android/app/src/main/cpp/locate_core.cpp), built for the PC


class _LocRange(ctypes.Structure):
    _fields_ = [("lo", ctypes.c_int * 3), ("hi", ctypes.c_int * 3)]


LOC_MAX_DROP = 8


class _LocParams(ctypes.Structure):
    _fields_ = [("kind", ctypes.c_int), ("pre", ctypes.c_float), ("sigma", ctypes.c_float), ("size", ctypes.c_int),
                ("r_in", ctypes.c_float), ("r_out", ctypes.c_float), ("wedge_r", ctypes.c_float),
                ("wedge_half", ctypes.c_float), ("n_drop", ctypes.c_int), ("drop", _LocRange * LOC_MAX_DROP),
                ("grow", ctypes.c_int), ("sat_max", ctypes.c_int), ("region_mode", ctypes.c_int),
                ("region", _LocRange), ("region_gain", ctypes.c_float), ("region_open", ctypes.c_int),
                ("region_min", ctypes.c_int), ("region_close", ctypes.c_int), ("region_edge", ctypes.c_int)]


def _loc_range(r: Range | None) -> _LocRange:
    lo, hi = r if r else ((1, 1, 1), (0, 0, 0))  # lo > hi: matches nothing
    return _LocRange((ctypes.c_int * 3)(*lo), (ctypes.c_int * 3)(*hi))


def loc_params(c: Config) -> _LocParams:
    assert len(c.drop) <= LOC_MAX_DROP
    g = c.regions
    drop = (_LocRange * LOC_MAX_DROP)(*[_loc_range(r) for r in c.drop])
    return _LocParams(KINDS[c.prep.kind], c.prep.pre, c.prep.sigma, c.size, *(c.circle or (-1, -1)),
                      *(c.wedge or (-1, 0)), len(c.drop), drop, c.grow, c.sat_max,
                      REGION_MODES[g.mode] if g else 2, _loc_range(g.color if g else None), g.gain if g else 1.0,
                      g.open if g else 0, g.min_px if g else 0, g.close if g else 0, g.edge if g else 0)


class Native:
    def __init__(self, path: Path):
        self.lib = ctypes.CDLL(str(path))
        L = self.lib
        L.loc_ref_create.restype = ctypes.c_void_p
        L.loc_ref_create.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.POINTER(_LocParams)]
        L.loc_ref_destroy.argtypes = [ctypes.c_void_p]
        L.loc_run.restype = ctypes.c_int
        L.loc_run.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_float, ctypes.c_float,
                              ctypes.c_float, ctypes.c_float, ctypes.POINTER(_LocParams), ctypes.POINTER(ctypes.c_float * 5)]
        self._refs: dict = {}

    def ref(self, ref: Ref, c: Config):
        key = (id(ref), c.key())
        if key not in self._refs:
            img = np.ascontiguousarray(ref.img)
            valid = np.ascontiguousarray(ref.valid.astype(np.uint8))
            lp = loc_params(c)
            self._refs[key] = (self.lib.loc_ref_create(img.tobytes(), img.shape[1] * 3, valid.tobytes(), img.shape[1], img.shape[0], ctypes.byref(lp)), img, valid)
        return self._refs[key][0]

    def locate(self, d, ref: Ref, c: Config, prior=None, radius=40, wedge=None):
        h = self.ref(ref, c)
        d = np.ascontiguousarray(d)
        out = (ctypes.c_float * 5)()
        pu, pv = ref.to_px(*prior) if prior is not None else (0.0, 0.0)
        rr = radius / ref.k if prior is not None else -1.0
        lp = loc_params(c)
        if not self.lib.loc_run(h, d.tobytes(), c.size * 3, float("nan") if wedge is None else wedge, pu, pv, rr, ctypes.byref(lp), ctypes.byref(out)):
            return None
        x, y = ref.to_rel(out[0], out[1])
        return {"x": x, "y": y, "score": out[2], "second": out[3], "wedge": wedge, "used": int(out[4])}


NATIVE: Native | None = None  # set (e.g. by a tool's --native): locate() goes through the app's code


def best_of(d, refs: list[Ref], c: Config, prior=None, radius=40, wedge=None):
    """locate() in each reference (one per zoom), the best scoring one; with its ref."""
    out = None
    for ref in refs:
        if NATIVE:
            r = NATIVE.locate(d, ref, c, prior, radius, wedge)
        else:
            r = locate(d, ref, c, prior, radius, wedge)
        if r and (out is None or r["score"] > out[0]["score"]):
            out = (r, ref)
    return out


# ---- references: mosaics and the app's files


def mosaic(samples, size: int, c: Config, k: float, step: float = 0.7, min_n: int = 3):
    """A reference stitched from crops: samples are (crop, x, y, wedge) at positions x, y (position units, k per
    crop px). Each crop (its mask's pixels) is placed at its position, the median of what lands on each pixel (what
    is drawn over the map and see-through scenery differ from crop to crop; the map does not). A crop is only taken
    once it has moved `step` crop px from the last one taken, so standing still does not outvote the rest.
    Returns (ref, spread, n): spread is the median absolute deviation of the samples, a measure of how well the
    crops line up (smaller is better); n: per pixel, how many crops cover it (valid: at least min_n)."""
    samples = list(samples)
    C = c.mid
    xs, ys = [s[1] for s in samples], [s[2] for s in samples]
    pad = C + 4
    x0, y0 = min(xs) / k - pad, min(ys) / k - pad
    w, h = int(math.ceil(max(xs) / k - x0 + pad)), int(math.ceil(max(ys) / k - y0 + pad))
    stack, masks, last = [], [], None
    for d, x, y, wedge in samples:
        u, v = x / k - x0, y / k - y0
        if last is not None and math.hypot(u - last[0], v - last[1]) < step:
            continue
        last = (u, v)
        m = crop_mask(d, c, wedge)
        M = np.float32([[1, 0, u - C], [0, 1, v - C]])
        stack.append(cv2.warpAffine(d, M, (w, h), flags=cv2.INTER_LINEAR))
        masks.append(cv2.warpAffine(m.astype(np.uint8), M, (w, h), flags=cv2.INTER_NEAREST) > 0)
    S = np.array(stack).astype(np.float32)
    V = np.array(masks)
    S[~V] = np.nan
    with np.errstate(all="ignore"):
        med = np.nanmedian(S, axis=0)
        spread = float(np.nanmedian(np.abs(S - med[None]).mean(-1)[V]))
    n = V.sum(0)
    img = np.nan_to_num(med).astype(np.uint8)
    print("k", k, "crops", len(stack), "of", len(samples), "size", (w, h), "spread", round(spread, 2))
    return Ref(img, n >= min_n, (-x0, -y0), k), spread, n


def load_ref(d: Path, level: str, name: str = "") -> Ref:
    """A reference saved by save_ref: <d>/<level>.png, <level>_valid.png, <level>.json {origin, k}."""
    img = imread(d / f"{level}.png")
    meta = json.load(open(d / f"{level}.json"))
    valid = imread(d / f"{level}_valid.png")[:, :, 0] > 0
    return Ref(img, valid, tuple(meta["origin"]), meta["k"], name or f"{d.name}-{level}")


def save_ref(d: Path, level: str, ref: Ref, **meta) -> None:
    imwrite(d / f"{level}.png", ref.img)
    imwrite(d / f"{level}_valid.png", (ref.valid * 255).astype(np.uint8))
    json.dump({"origin": ref.origin, "k": ref.k, **meta}, open(d / f"{level}.json", "w"))


def write_reference(templates: Path, name: str, levels: dict[str, Ref], c: Config, desc: str) -> Path:
    """The app's reference: templates/<name>.json with a PNG per level (templates/<name>_<level>.png, alpha: where
    the reference is known). The json has what skills' locate() needs: per level the image, k (position units per
    px), origin (px of the position origin), off (added to the result), then c's crop, mask, regions and prep."""
    out = []
    for level, ref in levels.items():
        png = f"{name}_{level}.png"
        bgra = cv2.cvtColor(ref.img, cv2.COLOR_BGR2BGRA)
        bgra[:, :, 3] = np.where(ref.valid, 255, 0)
        imwrite(templates / png, bgra)
        out.append({"zoom": level, "image": png, "k": ref.k, "origin": [round(float(v), 2) for v in ref.origin],
                    "off": [round(float(v), 2) for v in ref.off]})
    path = templates / f"{name}.json"
    json.dump({"desc": desc, "levels": out, **c.json()}, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=4)
    print("wrote", path)
    return path


# ---- evaluation


def evaluate(items, sources: dict[str, list[Ref]], configs: dict[str, Config], wedge_of=lambda d: None,
             offset: float = 8, radius: float = 30, full: bool = True, out_path: Path | None = None):
    """Each item (name, crop, (x, y) truth, category, split) located in each source (all its levels, the best) with
    each config, near a prior `offset` off the truth (as dead reckoning would give it) and over the whole reference.
    wedge_of: the heading of a crop's wedge (None: not known). Rows: dicts; see summary()."""
    rows = []
    for n, (name, d, (tx, ty), cat, split) in enumerate(items):
        wedge = wedge_of(d)
        ang = n * 2.399  # prior offsets in varied directions
        prior = (tx + offset * math.cos(ang), ty + offset * math.sin(ang))
        for sn, refs in sources.items():
            for pn, c in configs.items():
                for search in (["near", "full"] if full else ["near"]):
                    r = best_of(d, refs, c, prior if search == "near" else None, radius, wedge)
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
