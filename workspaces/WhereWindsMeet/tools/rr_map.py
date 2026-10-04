"""rec_route.py, the map side (建图): a recording's frames, what each shows, the big map shots, the stronghold icon
on the minimap, frame-to-frame registration, every world frame's position (solve, across the zoom switch), k,
the mosaics (the app's reference) and their evaluation. See rec_route.py for the steps and README for the why."""

from __future__ import annotations

import argparse
import heapq
import json
import math
import re
import sys
from pathlib import Path

import cv2
import numpy as np

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import strongholds as sh  # noqa: E402
import wwm_locate as wl  # noqa: E402  (puts scripts/ on sys.path too)
from wwm_locate import ml  # noqa: E402

WS = wl.WS
T = wl.TEMPLATES
REC = "rec"


def tpl(name: str) -> np.ndarray:
    return ml.imread(T / name)


def score(img: np.ndarray, t: np.ndarray, roi) -> tuple[float, tuple[int, int]]:
    x, y, w, h = roi
    r = cv2.matchTemplate(img[y : y + h, x : x + w], t, cv2.TM_CCOEFF_NORMED)
    _, s, _, (bx, by) = cv2.minMaxLoc(r)
    return float(s), (bx + x, by + y)


# ---- frames


def cmd_frames(root: Path, rec: str | None, video: Path | None) -> None:
    """<root>/rec/<n>.jpg and frames.jsonl ({seq, t}: frame number, ms), as scripts/grab_frames.py writes them."""
    video = video or WS / "recordings" / rec / "video.mp4"
    out = root / REC
    out.mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    n = 0
    with open(out / "frames.jsonl", "w", encoding="utf-8") as log:
        while True:
            ok, f = cap.read()
            if not ok:
                break
            if f.shape[:2] != (720, 1080):
                f = cv2.resize(f, (1080, 720), interpolation=cv2.INTER_AREA)
            cv2.imwrite(str(out / f"{n}.jpg"), f, [cv2.IMWRITE_JPEG_QUALITY, 95])
            log.write(json.dumps({"seq": n, "t": round(n * 1000 / fps)}) + "\n")
            n += 1
    print(n, "frames at", fps, "fps")


def frame(root: Path, n: int) -> np.ndarray:
    return ml.imread(root / REC / f"{n}.jpg")


# ---- what each frame shows

# (template, roi, threshold) per screen, first hit wins (world: the camera fan on the minimap, no big map header)
SCREENS = [
    ("card_map", "stronghold_panel_route.png", (790, 640, 140, 70), 0.8),  # the card's big map, its panel open (识途)
    ("stone", "teleport_button.png", (850, 640, 150, 70), 0.8),  # the stone's panel (传送)
    ("reward", "reward_confirm.png", (800, 640, 280, 80), 0.8),  # the chest's reward panel (确认领取)
    ("result", "result_continue.png", (900, 640, 180, 80), 0.8),  # the 攻占 result pages (继续)
    ("challenge", "stronghold_card_cixin.png", (60, 170, 960, 70), 0.8),  # 据点挑战: the first card is always 慈心山院
    ("jianghu", "jianghu_challenge.png", (60, 490, 150, 80), 0.8),
    ("menu", "menu_jianghu.png", (680, 440, 100, 80), 0.8),
]
LIST_ROI = (690, 360, 130, 220)  # the interaction list on the right (route.js)
INTERACT = {"chest": "interact_chest.png", "destroy": "interact_destroy.png"}


def classify(img: np.ndarray, root: Path) -> str:
    if score(img, _tpl("map_header.png"), (20, 0, 140, 70))[0] > 0.7:  # the big map's 单人 / 多人
        return "map"
    for name, t, roi, th in SCREENS:
        if score(img, _tpl(t), roi)[0] >= th:
            return name
    d = wl.disc(img)
    return "world" if disc_lit(d) and wl.heading(d) is not None else "other"


def disc_lit(d: np.ndarray) -> bool:
    """The minimap is up: its see-through disc is light (~200 gray) even at night; a loading screen behind where it
    would be is dark, and the fan test alone takes its shadows for a fan."""
    R, _ = ml.polar(d.shape[0])
    g = cv2.cvtColor(d, cv2.COLOR_BGR2GRAY)
    return float(np.median(g[(R > 12) & (R < 40)])) > 120


_TPL: dict[str, np.ndarray] = {}


def _tpl(name: str) -> np.ndarray:
    if name not in _TPL:
        _TPL[name] = tpl(name)
    return _TPL[name]


def cmd_cache(root: Path) -> None:
    """<root>/rec/frames.npz (wwm_locate's: seq, world, disc, cam) and <root>/screens.json: per frame its screen
    (map / card_map / stone / reward / result / challenge / jianghu / menu / world / other) and the interaction
    rows matched (chest, destroy)."""
    sd = root / REC
    fr = [json.loads(l)["seq"] for l in open(sd / "frames.jsonl", encoding="utf-8")]
    seqs, discs, world, cams, rows = [], [], [], [], []
    for n in fr:
        img = frame(root, n)
        s = classify(img, root)
        d = wl.disc(img).copy()
        c = wl.heading(d) if s == "world" else None
        hits = [k for k, t in INTERACT.items() if s == "world" and score(img, _tpl(t), LIST_ROI)[0] >= 0.8]
        seqs.append(n), discs.append(d), world.append(s == "world"), cams.append(np.nan if c is None else c)
        rows.append({"n": n, "screen": s, **({"list": hits} if hits else {})})
        if n % 500 == 0:
            print(n, s)
    np.savez(sd / "frames.npz", seq=np.array(seqs), world=np.array(world), disc=np.array(discs), cam=np.array(cams))
    json.dump(rows, open(root / "screens.json", "w"), indent=0)
    blocks = runs([r["screen"] for r in rows])
    for s, a, b in blocks:
        print(f"{a}-{b} {s}")


def runs(labels: list[str]) -> list[tuple[str, int, int]]:
    """(label, first, last) of each run of the same label."""
    out = []
    for i, s in enumerate(labels):
        if out and out[-1][0] == s:
            out[-1] = (s, out[-1][1], i)
        else:
            out.append((s, i, i))
    return out


# ---- the big map: where the character was, and a reference (wwm_locate's bigmap/)

PLAYER = (537, 362)  # the arrow on the big map opened from the minimap (stronghold.js)
LIVE_AT = (-1, -2)  # the live icon's middle from the taken one's (positions are in taken-icon terms)
MAP_ROI = (0, 60, 1080, 600)


def map_icon(img: np.ndarray, near=PLAYER) -> dict | None:
    """The stronghold icon on a big map screenshot nearest `near` (live or taken; stronghold.js nearestIcon): its
    middle in taken-icon terms (sub-px), score, which."""
    best = None
    for name, file, at in (("live", "map_stronghold.png", LIVE_AT), ("done", "map_stronghold_done.png", (0, 0))):
        t = _tpl(file)
        x0, y0, w, h = MAP_ROI
        r = cv2.matchTemplate(img[y0 : y0 + h, x0 : x0 + w], t, cv2.TM_CCOEFF_NORMED)
        ys, xs = np.nonzero(r >= 0.85)
        for x, y in zip(xs, ys):
            if r[y, x] < r[max(0, y - 2) : y + 3, max(0, x - 2) : x + 3].max():
                continue
            fx, fy = ml._sub(r, int(x), int(y))
            mx, my = x0 + fx + t.shape[1] / 2 - at[0], y0 + fy + t.shape[0] / 2 - at[1]
            d = math.hypot(mx - near[0], my - near[1])
            c = {"x": mx, "y": my, "score": float(r[y, x]), "icon": name, "d": d}
            if best is None or d < best["d"] - 6 or (abs(d - best["d"]) <= 6 and c["score"] > best["score"]):
                best = c
    return best


def cmd_bigmap(root: Path) -> None:
    """From the big map frames: <root>/anchors.json, the character's position on each look at the big map opened from
    the world screen (the arrow at PLAYER; positions from the icon, as where() reads them; the world frames just
    before and after, standing there, take it too), and <root>/bigmap/ (composite.png and the rest, wwm_locate's
    build_bigmap): the stable views (the card's map and those looks), the place names on them (OCR) left out."""
    from wwm_ocr import ocr

    scr = json.load(open(root / "screens.json"))
    labels = [r["screen"] for r in scr]
    shots, anchors = [], []
    for s, a, b in runs(labels):
        if s != "map":
            continue
        from_world = a > 0 and any(l == "world" for l in labels[max(0, a - 15) : a])
        # stable stretches of the view: the icon at the same place
        icons = [(n, map_icon(frame(root, n), PLAYER if from_world else (540, 360))) for n in range(a, b + 1, 3)]
        groups: list[list] = []
        for n, ic in icons:
            if ic is None:
                continue
            if groups and math.hypot(ic["x"] - groups[-1][-1][1]["x"], ic["y"] - groups[-1][-1][1]["y"]) < 1.0:
                groups[-1].append((n, ic))
            else:
                groups.append([(n, ic)])
        for g in groups:
            if len(g) < 5:
                continue
            n = g[len(g) // 2][0]
            x = float(np.median([ic["x"] for _, ic in g]))
            y = float(np.median([ic["y"] for _, ic in g]))
            img = frame(root, n)
            panel = score(img, _tpl("stronghold_panel_route.png"), (790, 640, 140, 70))[0] >= 0.8
            name = f"{n}.png"
            ml.imwrite(root / "bigmap" / name, img)
            texts = [(bx - x, by - y, bw, bh) for t, (bx, by, bw, bh), _ in ocr(img)]
            shots.append({"file": name, "icon": [round(x, 2), round(y, 2)], "panel": panel, "texts": texts,
                          "frames": [g[0][0], g[-1][0]], "from_world": from_world})
            if from_world:
                pos = (round(PLAYER[0] - x, 2), round(PLAYER[1] - y, 2))
                anchors.append({"n": n, "first": a, "last": b, "x": pos[0], "y": pos[1]})
            print("map", g[0][0], "-", g[-1][0], "icon", (round(x, 1), round(y, 1)), "panel" if panel else "", "anchor" if from_world else "")
    labs = []
    for s in shots:  # the place names, icon-relative (build_bigmap's labels), a little wider
        labs += [[int(tx - 3), int(ty - 3), int(tw + 6), int(th + 6)] for tx, ty, tw, th in s["texts"]]
    json.dump({"shots": shots, "labels": labs}, open(root / "bigmap" / "shots.json", "w"), indent=1)
    json.dump(anchors, open(root / "anchors.json", "w"), indent=1)
    wl.build_bigmap(root)
    print("anchors", anchors)


# ---- text: the tracker and the interaction list

TRACKER_ROI = (20, 130, 330, 90)  # stronghold.js
COUNT = r"(\d+)\s*[/／]\s*(\d+)"


def cmd_ocr(root: Path, every: int = 6) -> None:
    """<root>/text.json: every `every`-th world frame, the tracker's lines and the interaction list's rows (OCR)."""
    from wwm_ocr import lines, ocr

    scr = json.load(open(root / "screens.json"))
    out = []
    for r in scr:
        if r["screen"] != "world" or (r["n"] % every and not r.get("list")):
            continue
        img = frame(root, r["n"])
        out.append({"n": r["n"], "tracker": lines(ocr(img, TRACKER_ROI)), "list": lines(ocr(img, LIST_ROI))})
    json.dump(out, open(root / "text.json", "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    last = None
    for t in out:  # what changes
        k = (tuple(t["tracker"]), tuple(t["list"]))
        if k != last:
            print(t["n"], t["tracker"], t["list"])
        last = k


# ---- the stronghold icon on the minimap

# The live icon is a little tower ~3 x 7 px: dark cap, pink band, dark red body (OpenCV HSV H 165-10, S >= 85,
# V 40-150; the enemies' marks are brighter, V >= 150, and round). Taken, it turns gray with an hourglass.
ICON_RED = (((0, 85, 40), (10, 255, 150)), ((165, 85, 40), (180, 255, 150)))
MID = wl.MINIMAP.mid  # the character, in the disc


ICON_R = 47  # icons looked for within this (disc px from the character)
RIM_R = 51  # and out to this for the rim's (the courtyard's zoom holds a far icon out to r ~50: 酒肉山林's bonfire field)


def icon_blobs(d: np.ndarray, r: tuple[float, float] = (0, ICON_R)) -> list[dict]:
    """Dark red blobs in a minimap disc that could be the stronghold icon, r[0] < distance <= r[1]: middle (disc px,
    from the character), area, height / width."""
    R, _ = ml.polar(d.shape[0])
    hsv = cv2.cvtColor(d, cv2.COLOR_BGR2HSV)
    m = (ml.in_range(hsv, ICON_RED) & (R > r[0]) & (R <= r[1])).astype(np.uint8)
    n, lab, st, cen = cv2.connectedComponentsWithStats(m, connectivity=8)
    out = []
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if not 3 <= a <= 30 or w > 6 or h > 9:
            continue
        ys, xs = np.nonzero(lab == i)
        wt = 255.0 - hsv[ys, xs, 2]  # darker counts more: the body
        cx, cy = float((xs * wt).sum() / wt.sum()), float((ys * wt).sum() / wt.sum())
        out.append({"dx": round(cx - MID, 2), "dy": round(cy - MID, 2), "a": int(a), "hw": round(h / max(w, 1), 2)})
    return out


DONE_ICON = "minimap_stronghold_done.png"  # templates/: the taken icon on the minimap (gray, an hourglass above right;
# cut from 酒肉山林's recording, frame 4800; the same for every stronghold)
DONE_BODY = (7, 15, 0, 9)  # rows, cols of DONE_ICON: the gray tower without the hourglass. Once taken, the black chest
# icon can sit on the hourglass (龙虎寨, zoomed out north of it: the whole template 0.4–0.6, the body 0.8–0.94); the body
# alone also fits the live icon, so it is only a fallback (`body` in icons.json) and icon_track takes "done" only after
# the last red blob anyway
DONE_BODY_MIN = (0.75, 0.04)  # its score and margin (the chest icon right above keeps the margin low)


def done_icon(d: np.ndarray, t: np.ndarray) -> dict | None:
    """The taken icon in a disc (template match, sub-px): its middle from the character, score, margin."""
    r = cv2.matchTemplate(d, t, cv2.TM_CCOEFF_NORMED)
    _, s, _, (x, y) = cv2.minMaxLoc(r)
    r2 = r.copy()
    cv2.circle(r2, (x, y), 4, -1, -1)
    fx, fy = ml._sub(r, x, y)
    return {"dx": round(float(fx) + t.shape[1] / 2 - 0.5 - MID, 2), "dy": round(float(fy) + t.shape[0] / 2 - 0.5 - MID, 2),
            "s": round(float(s), 3), "m": round(float(s - r2.max()), 3)}


def cmd_icons(root: Path) -> None:
    """<root>/icons.json: per world frame, the dark red blobs that could be the live stronghold icon on the minimap
    (`live`, within ICON_R; `rim`, out to RIM_R) and the best match of the taken one (`done`,
    templates/minimap_stronghold_done.png)."""
    z = wl.frames_of(root / REC)
    t = ml.imread(T / DONE_ICON) if (T / DONE_ICON).exists() else None
    out = {}
    for i, n in enumerate(z["seq"]):
        if z["world"][i]:
            b = icon_blobs(z["disc"][i])
            g = done_icon(z["disc"][i], t) if t is not None else None
            if t is not None and not (g["s"] >= 0.6 and g["m"] >= 0.15):
                r0, r1, c0, c1 = DONE_BODY
                g = done_icon(z["disc"][i], t[r0:r1, c0:c1])
                # its middle in the whole template's terms
                g.update(dx=round(g["dx"] + (t.shape[1] - 1) / 2 - (c0 + c1 - 1) / 2, 2),
                         dy=round(g["dy"] + (t.shape[0] - 1) / 2 - (r0 + r1 - 1) / 2, 2), body=True)
                if not (g["s"] >= DONE_BODY_MIN[0] and g["m"] >= DONE_BODY_MIN[1]):
                    g = None
            rim = [q for q in icon_blobs(z["disc"][i], (ICON_R, RIM_R)) if math.hypot(q["dx"], q["dy"]) > ICON_R]
            out[int(n)] = {"live": b, **({"done": g} if g else {}),
                           **({"rim": rim} if rim else {})}
    json.dump(out, open(root / "icons.json", "w"))
    print(len(out), "world frames;", sum(1 for v in out.values() if v["live"]), "with red blobs;",
          sum(1 for v in out.values() if "done" in v), "with the taken icon")


PINNED = 38  # the icon is held on the disc's rim (r ~42-46) when it is farther: past this, its distance says nothing


def rim_icons(root: Path, track: dict) -> dict[int, tuple[str, float, float]]:
    """Icons that only tell the way to the stronghold (its distance says nothing): the track's pinned ones and the
    live icon out on the rim (icons.json `rim`, past ICON_R), the latter where only one is there and it agrees with
    its neighbours as in icon_track. {n: (live | done, dx, dy)}"""
    out = {n: (kind[: -len("_rim")], dx, dy) for n, (kind, dx, dy) in track.items() if kind.endswith("_rim")}
    raw = json.load(open(root / "icons.json"))
    obs = {int(n): (v["rim"][0]["dx"], v["rim"][0]["dy"]) for n, v in raw.items()
           if len(v.get("rim", [])) == 1 and not v["live"] and int(n) not in track}
    keys = sorted(obs)
    for j, n in enumerate(keys):
        near = [obs[m] for m in keys[max(0, j - 4) : j + 5] if abs(m - n) <= 8]
        if len(near) < 3:
            continue
        mx, my = np.median([o[0] for o in near]), np.median([o[1] for o in near])
        if math.hypot(obs[n][0] - mx, obs[n][1] - my) <= 1.5:
            out[n] = ("live", *obs[n])
    return out


def icon_track(root: Path) -> dict[int, tuple[str, float, float]]:
    """The stronghold icon per world frame: (live | done, dx, dy) in minimap px from the character, only where it is
    within PINNED and agrees with its neighbours (within 1.5 px of the median over ±4 frames: drops enemy marks and
    flickers); pinned ones (rim) as (live_rim | done_rim, ...)."""
    raw = json.load(open(root / "icons.json"))
    seq = sorted(int(n) for n in raw)
    obs: dict[int, tuple[str, float, float]] = {}
    live_last = max((n for n in seq if raw[str(n)]["live"]), default=-1)  # the icon turns gray once taken
    for n in seq:
        v = raw[str(n)]
        if "done" in v and n > live_last:
            obs[n] = ("done", v["done"]["dx"], v["done"]["dy"])
        elif len(v["live"]) == 1:
            b = v["live"][0]
            obs[n] = ("live", b["dx"], b["dy"])
    out = {}
    keys = sorted(obs)
    for k, n in enumerate(keys):
        kind, dx, dy = obs[n]
        near = [obs[m] for m in keys[max(0, k - 4) : k + 5] if abs(m - n) <= 8 and obs[m][0] == kind]
        if len(near) < 3:
            continue
        mx, my = np.median([o[1] for o in near]), np.median([o[2] for o in near])
        if math.hypot(dx - mx, dy - my) > 1.5:
            continue
        pinned = math.hypot(dx, dy) > PINNED
        out[n] = (kind + ("_rim" if pinned else ""), dx, dy)
    return out


def zoom_switches(track: dict[int, tuple[str, float, float]], within: int = 24, jump: float = 4.0) -> list[dict]:
    """Where the minimap zooms (in or out): the icon moving out or in along the same bearing by more than `jump` px
    within `within` frames, more than walking can do (sprinting moves the map ~3.5 px a second when zoomed out). The
    switch animates for about a second, so its frames are left out (from the last look before to the first after)."""
    keys = sorted(track)
    out = []
    for a, b in zip(keys, keys[1:]):
        if b - a > within or track[a][0].split("_")[0] != track[b][0].split("_")[0]:
            continue
        ra, rb = math.hypot(*track[a][1:]), math.hypot(*track[b][1:])
        da = math.degrees(math.atan2(track[a][1], -track[a][2]))
        db = math.degrees(math.atan2(track[b][1], -track[b][2]))
        if abs((da - db + 180) % 360 - 180) <= 12 and abs(rb - ra) > jump:
            if out and a - out[-1]["to"] <= within and out[-1]["way"] == ("in" if rb > ra else "out"):
                out[-1]["to"] = b  # the same switch, still animating
                continue
            out.append({"from": a, "to": b, "way": "in" if rb > ra else "out", "r": [round(ra, 1), round(rb, 1)]})
    return out


TRACK = wl.TRACK_PREP


def good_world(root: Path) -> np.ndarray:
    z = wl.frames_of(root / REC)
    return wl.good_frames(z["world"])


# ---- every world frame's position

LAGS = (7, 10, 30)  # frame pairs registered this many frames apart: shorter ones are unreliable (the recording repeats
# frames while the screen does not change, sub-px steps that small are lost), 7 and 10 coprime so every frame is linked
# big map px per minimap px: one constant for the game (2026-10-02, the anchors' where() against the minimap's taken
# icon, the same fit for all three strongholds: in 1.150 / 1.156 / 1.151 over 28–118 anchors each, out 2.315 / 2.332 /
# 2.314, pooled 1.1523 ± 0.0012 and 2.316 ± 0.024; data/tmp/kfit). stone_k() read 2.239 for 酒肉山林: the icon's middle
# is not the same point on the minimap and the big map, which takes 2–3% off a short step; it is kept as a check only
K = {"out": 2.31, "in": 1.152}
K0 = K
WALK = 0.6  # big map px per frame: the random walk that holds frames with nothing else on them
GAP = 30  # frames off the world screen that split a stretch
RIM_SIGMA = (0.5, 0.02)  # the rim icon's bearing: big map px off the line, at least, and per px of distance (~1°)
ANIM = (10, 30)  # frames left out before / after a zoom switch's first / last look (it animates ~1 s)


def segments(root: Path, track) -> list[dict]:
    """Stretches of good world frames at one zoom: split at the zoom switches (their animation left out); the first
    one is zoomed out (the character starts outside, at the teleport stone; a survey's survey.json says otherwise)."""
    z = wl.frames_of(root / REC)
    good = good_world(root)
    hand = zoom_conf(root).get("switches")
    if hand is not None:  # looked at by hand: the animation's own first and last frames, nothing added
        cuts = [(a, b, way) for a, b, way in hand]
    else:
        cuts = [(s["from"] - ANIM[0], s["to"] + ANIM[1], s["way"]) for s in zoom_switches(track)]
    zoom, out, cur = survey_conf(root).get("zoom0", "out"), [], []
    for i in np.nonzero(good)[0]:
        n = int(z["seq"][i])
        if cur and n - cur[-1] > GAP:  # menus, the big map, a teleport: a new stretch (maybe somewhere else)
            out.append({"zoom": zoom, "frames": cur})
            cur = []
        cut = next((c for c in cuts if c[0] <= n <= c[1]), None)
        if cut:
            if cur:
                out.append({"zoom": zoom, "frames": cur})
                cur = []
            zoom = cut[2]
            continue
        cur.append(n)
    if cur:
        out.append({"zoom": zoom, "frames": cur})
    t0 = landed(root)
    return [s for s in out if len(s["frames"]) >= 10 and s["frames"][0] >= t0]


def landed(root: Path) -> int:
    """The first world frame after the teleport: after the last long stretch off the world screen (the loading
    screen, >= 60 frames) before the first look at the big map. What comes before is somewhere else."""
    scr = [r["screen"] for r in json.load(open(root / "screens.json"))]
    first = json.load(open(root / "anchors.json"))[0]["first"]
    t0 = 0
    for s, a, b in runs(scr):
        if a < first and s != "world" and b - a + 1 >= 60 and s != "map":
            t0 = b + 1
    return t0


_PREP: dict[int, tuple[np.ndarray, np.ndarray]] = {}


def prepped(z: dict, i: int, c: ml.Config = TRACK) -> tuple[np.ndarray, np.ndarray]:
    if i not in _PREP:
        w = None if np.isnan(z["cam"][i]) else float(z["cam"][i])
        _PREP[i] = ml.prep(z["disc"][i], ml.crop_mask(z["disc"][i], c, w), c)
    return _PREP[i]


def register(pa, pb, r_t: int = 30, max_shift: int = 12) -> tuple[float, float, float]:
    """The map's shift from disc a to b (prepped), as map_locate.register, without its bias: a disc registered on
    itself comes out 0.1-0.2 px off there, which piles up along a chain of frames. Two causes: a's inner disc is
    filtered with its mask cut to r_t and b with the whole mask (here both are filtered whole, a cut afterwards), and
    the masked correlation peak is lopsided, so its sub-px refinement leans one way (here a to b and b to a,
    averaged)."""
    dx, dy, s1 = _register(pa, pb, r_t, max_shift)
    ex, ey, s2 = _register(pb, pa, r_t, max_shift)
    return (dx - ex) / 2, (dy - ey) / 2, min(s1, s2)


def _register(pa, pb, r_t: int, max_shift: int) -> tuple[float, float, float]:
    ta, ma = pa
    tb = pb[0]
    C = MID
    m = ma & (ml.polar(ta.shape[0])[0] <= r_t)
    s = C - r_t
    t, tm = ta[s : C + r_t + 1, s : C + r_t + 1], m[s : C + r_t + 1, s : C + r_t + 1]
    lo = max(0, s - max_shift)
    win = tb[lo : C + r_t + 1 + max_shift, lo : C + r_t + 1 + max_shift]
    r = cv2.matchTemplate(win, t, cv2.TM_CCOEFF_NORMED, mask=tm.astype(np.uint8))
    r[~np.isfinite(r)] = -1
    _, best, _, (bx, by) = cv2.minMaxLoc(r)
    dx, dy = float(lo + bx - s), float(lo + by - s)
    # sub-px: ECC from the integer peak (a parabola through the peak's neighbours leans to whole px, "pixel locking",
    # so a chain of small steps comes out 10-40% short)
    if best > 0.3:
        try:
            w = np.float32([[1, 0, dx], [0, 1, dy]])
            _, w = cv2.findTransformECCWithMask(ta, tb, m.astype(np.uint8), pb[1].astype(np.uint8), w, cv2.MOTION_TRANSLATION,
                                                (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 1e-4), 1)
            if abs(w[0, 2] - dx) <= 1.0 and abs(w[1, 2] - dy) <= 1.0:
                return float(w[0, 2]), float(w[1, 2]), float(best)
        except cv2.error:
            pass
    fx, fy = ml._sub(r, bx, by)
    return float(lo + fx - s), float(lo + fy - s), float(best)


def cmd_register(root: Path) -> None:
    """<root>/reg.json: map shifts (minimap px, ml.register) between frames LAGS apart within each segment."""
    z = wl.frames_of(root / REC)
    idx = z["idx"]
    out = []
    for s in segments(root, icon_track(root)):
        fr = s["frames"]
        step = float(np.median(np.diff(fr))) if len(fr) > 1 else 1.0  # 1 for a recording, ~4 for a survey
        lags = sorted({max(1, round(lag / step)) for lag in LAGS})
        for lag in lags:
            for a, b in zip(fr, fr[lag:]):
                if b - a > (3 * lag + 6) * step:  # a gap (menus, a flicker of the fan)
                    continue
                dx, dy, sc = register(prepped(z, idx[a]), prepped(z, idx[b]))
                out.append([int(a), int(b), round(float(dx), 3), round(float(dy), 3), round(float(sc), 3)])
        print(s["zoom"], fr[0], "-", fr[-1], len(fr), "frames")
    json.dump(out, open(root / "reg.json", "w"))
    print(len(out), "pairs")


CS = ("live_out", "live_in", "done_out", "done_in")  # the icon's offset, per kind and zoom (fitted)
C_TIE = 2.0  # px: how far one icon's offsets at the two zooms may differ (its middle's error times k out - k in)


def solve(root: Path, k: dict[str, float], fixes=(), iters: int = 4, only: str | None = None, quiet: bool = False,
          tie: float | None = C_TIE):
    """Positions of the segments' frames (only those at zoom `only`, when given) by least squares over: the map
    shifts between frames (reg.json: p_b - p_a = -k s), the stronghold icon on the minimap (p = c - k d; c per icon
    kind and zoom: the icon's middle on the minimap vs on the big map, which differ a few px), the looks at the big
    map (anchors.json: the frames just before it opens and after it closes, standing there), `fixes` (n, x, y,
    sigma: frames placed in a reference), and a weak random walk (WALK) that carries frames with none of these
    (fights) along. k (big map px per minimap px, per zoom) is given: shifts and the icon are both in minimap px, so
    they cannot tell it (cmd_locate measures it). Constraints far off after a solve are dropped and it is solved
    again. Returns (positions {n: (x, y, zoom)}, the icon offsets, residuals)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.linalg import lsqr

    track = icon_track(root)
    segs = [s for s in segments(root, track) if only is None or s["zoom"] == only]
    zoom_of = {n: s["zoom"] for s in segs for n in s["frames"]}
    frames = sorted(zoom_of)
    col = {n: i for i, n in enumerate(frames)}
    N = len(frames)
    P = {c: 2 * N + 2 * i for i, c in enumerate(CS)}
    nv = 2 * N + 2 * len(CS)
    regs = [r for r in json.load(open(root / "reg.json")) if r[4] >= 0.6 and r[0] in col and r[1] in col]
    fix = [f for f in fixes if f[0] in col]
    n_given = len(fix)
    for a in json.load(open(root / "anchors.json")):  # standing at the look's place: never dropped
        fix += [(n, a["x"], a["y"], 0.5) for n in frames if a["last"] < n <= a["last"] + 15 or a["first"] - 15 <= n < a["first"]]
    icons = [(n, kind, dx, dy) for n, (kind, dx, dy) in track.items() if n in col and not kind.endswith("_rim")]
    # the icon out on the rim: only its bearing, the frame on the line from the icon's place that way (n·(p - c) = 0)
    rims = [(n, kind, dx, dy) for n, (kind, dx, dy) in rim_icons(root, track).items() if n in col]
    keep_reg, keep_ic, keep_fix = np.ones(len(regs), bool), np.ones(len(icons), bool), np.ones(len(fix), bool)
    keep_rim = np.ones(len(rims), bool)
    far = np.array([1.3 * k[zoom_of[n]] * math.hypot(dx, dy) for n, _, dx, dy in rims])  # its distance, guessed
    # and at least as far as it is shown (held on the rim it is farther, never nearer): where a solve put it nearer,
    # the next one holds it there (a lower bound, active only where it was broken)
    near = np.zeros(len(rims), bool)
    for it in range(iters):
        rows, cols, vals, rhs = [], [], [], []

        def add(terms, b, sigma):
            e = len(rhs)
            for c_, v in terms:
                rows.append(e), cols.append(c_), vals.append(v / sigma)
            rhs.append(b / sigma)

        for m, (a, b, dx, dy, sc) in enumerate(regs):
            if keep_reg[m]:
                kz = k[zoom_of[a]]
                for ax, d in ((0, dx), (1, dy)):
                    add([(2 * col[b] + ax, 1.0), (2 * col[a] + ax, -1.0)], -kz * d, 0.25 / max(sc, 0.3) * kz)
        for m, (n, kind, dx, dy) in enumerate(icons):
            if keep_ic[m]:
                kz = k[zoom_of[n]]
                for ax, d in ((0, dx), (1, dy)):
                    add([(2 * col[n] + ax, 1.0), (P[f"{kind}_{zoom_of[n]}"] + ax, -1.0)], -kz * d, 0.5 * kz)
        for m, (n, kind, dx, dy) in enumerate(rims):
            if keep_rim[m]:
                r = math.hypot(dx, dy)
                nx, ny = -dy / r, dx / r
                c_ = P[f"{kind}_{zoom_of[n]}"]
                add([(2 * col[n], nx), (2 * col[n] + 1, ny), (c_, -nx), (c_ + 1, -ny)], 0.0, max(RIM_SIGMA[0], RIM_SIGMA[1] * far[m]))
                if near[m]:
                    ux, uy = dx / r, dy / r
                    add([(c_, ux), (c_ + 1, uy), (2 * col[n], -ux), (2 * col[n] + 1, -uy)], k[zoom_of[n]] * r, 0.5 * k[zoom_of[n]])
        for a, b in zip(frames, frames[1:]):
            if zoom_of[a] == zoom_of[b] and b - a <= GAP:
                for ax in (0, 1):
                    add([(2 * col[b] + ax, 1.0), (2 * col[a] + ax, -1.0)], 0.0, WALK * math.sqrt(b - a))
        for m, (n, x, y, sg) in enumerate(fix):
            if keep_fix[m]:
                add([(2 * col[n], 1.0)], x, sg)
                add([(2 * col[n] + 1, 1.0)], y, sg)
        for c in CS:  # an offset nothing tells: held at 0
            for ax in (0, 1):
                add([(P[c] + ax, 1.0)], 0.0, 100.0)
        if tie:  # an icon's offset differs between zooms only by its middle's few px times the k step
            for kind in ("live", "done"):
                for ax in (0, 1):
                    add([(P[f"{kind}_in"] + ax, 1.0), (P[f"{kind}_out"] + ax, -1.0)], 0.0, tie)
        A = coo_matrix((vals, (rows, cols)), shape=(len(rhs), nv)).tocsr()
        sol = lsqr(A, np.array(rhs), atol=1e-12, btol=1e-12, iter_lim=50000)[0]
        pos = sol[: 2 * N].reshape(N, 2)
        p = lambda n: pos[col[n]]
        cv = {c: sol[P[c] : P[c] + 2] for c in CS}
        res_reg = np.array([np.hypot(*(p(b) - p(a) + k[zoom_of[a]] * np.array([dx, dy]))) for a, b, dx, dy, _ in regs])
        res_ic = np.array([np.hypot(*(p(n) - cv[f"{kd}_{zoom_of[n]}"] + k[zoom_of[n]] * np.array([dx, dy]))) for n, kd, dx, dy in icons])
        res_fix = np.array([np.hypot(*(p(n) - np.array([x, y]))) for n, x, y, _ in fix]) if fix else np.zeros(0)
        res_rim = np.zeros(len(rims))
        for m, (n, kd, dx, dy) in enumerate(rims):
            v = cv[f"{kd}_{zoom_of[n]}"] - p(n)  # to the icon
            r = math.hypot(dx, dy)
            far[m] = max(float(np.hypot(*v)), k[zoom_of[n]] * r)
            res_rim[m] = abs(-dy / r * v[0] + dx / r * v[1]) if v @ np.array([dx, dy]) > 0 else far[m]  # behind: off
            near[m] = near[m] or (v @ np.array([dx, dy])) / r < k[zoom_of[n]] * r - 0.3
        if len(rims):
            keep_rim = res_rim <= np.maximum(RIM_SIGMA[0], RIM_SIGMA[1] * far) * 3
        if len(regs):
            keep_reg = res_reg <= max(1.0, 4 * np.median(res_reg[keep_reg]))
        if len(icons):
            keep_ic = res_ic <= max(1.0, 4 * np.median(res_ic[keep_ic]))
        if fix:
            keep_fix = res_fix <= np.array([max(2.0, 3 * f[3]) for f in fix])
            keep_fix[n_given:] = True
        if not quiet:
            print(f"  solve {it}: c " + " ".join(f"{c} {np.round(cv[c], 1)}" for c in CS) + "; shift resid med "
                  f"{np.median(res_reg):.2f} (out {int((~keep_reg).sum())}/{len(regs)}), icon {np.median(res_ic) if len(icons) else 0:.2f} "
                  f"(out {int((~keep_ic).sum())}/{len(icons)}), fixes {np.median(res_fix) if fix else 0:.2f} (out {int((~keep_fix).sum())}/{len(fix)}), "
                  f"rim {np.median(res_rim) if len(rims) else 0:.2f} (out {int((~keep_rim).sum())}/{len(rims)}, held off {int(near.sum())})")
    out = {n: (float(pos[col[n]][0]), float(pos[col[n]][1]), zoom_of[n]) for n in frames}
    return out, {c: [round(float(v), 2) for v in cv[c]] for c in CS}, {"reg": res_reg, "icon": res_ic, "fix": res_fix}


# ---- across the zoom switch: the stronghold's orange zone, the same shape at both zooms

ZONE_MAP_PX = 1.0  # zone map: px per big map px


def zone_mask(z: dict, i: int) -> tuple[np.ndarray, np.ndarray]:
    """The orange zone in a disc (opened, closed: 0 / 1) and where it can be told (within r 40, off the arrow and
    the camera fan, which whitens it)."""
    R, A = ml.polar(wl.MINIMAP.size)
    hsv = cv2.cvtColor(z["disc"][i], cv2.COLOR_BGR2HSV)
    m = ml.in_range(hsv, [wl.ZONE_FILL]).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    valid = (R <= 40) & (R > 10)
    cam = z["cam"][i]
    if np.isnan(cam):
        valid &= R > 36
    else:
        valid &= ~((np.abs(((A - cam) + 180) % 360 - 180) <= 40) & (R <= 36))
    return m.astype(np.float32), valid


def _to_map(x: float, y: float, k: float, box) -> np.ndarray:
    """Affine from disc px to the zone map, the disc's middle at (x, y) (big map px), k big map px per disc px."""
    X0, Y0 = box[0], box[1]
    s = ZONE_MAP_PX
    return np.float32([[k * s, 0, (x - k * MID - X0) * s], [0, k * s, (y - k * MID - Y0) * s]])


def zoom_changes(pos: dict) -> list[tuple[int, str, str, int]]:
    """Where the track's zoom changes: (first frame past it, zoom before, zoom after, first frame of the next change
    or past the end)."""
    seq = sorted(pos)
    at = [(b, pos[a][2], pos[b][2]) for a, b in zip(seq, seq[1:]) if pos[a][2] != pos[b][2]]
    return [(b, za, zb, at[i + 1][0] if i + 1 < len(at) else seq[-1] + 1) for i, (b, za, zb) in enumerate(at)]


def zone_fixes(root: Path, pos: dict, k: dict, before: int = 300, search: float = 16.0, change=None) -> list[tuple[int, float, float, float]]:
    """Where the frames just past a zoom switch are, from the zone: the frames before it drawn into a zone map (big
    map px; the zone only shrinks when an enemy falls, so only the last stretch before the switch is used), each frame
    after it (within `before` frames, up to the next switch) slid over it, the best place by correlation (it is a crisp
    outline, ~0.95 where it fits). The minimap's texture is no help here: it is drawn differently at the two zooms.
    `change`: one of zoom_changes(); by default the first zoom in (the gate)."""
    z = wl.frames_of(root / REC)
    if change is None:
        out_fr = [n for n, v in sorted(pos.items()) if v[2] == "out"]
        in_fr = [n for n, v in sorted(pos.items()) if v[2] == "in"]
        if not out_fr or not in_fr:
            return []
        change = (in_fr[0], "out", "in", 1 << 30)
    switch, z_near, z_far, upto = change
    near_fr = [n for n, v in sorted(pos.items()) if v[2] == z_near and switch - before <= n < switch]
    far_fr = [n for n, v in sorted(pos.items()) if v[2] == z_far and switch <= n < min(upto, switch + before)]
    last_out = near_fr[::2]
    if not last_out:  # zoomed in from the start (a survey begun inside)
        return []
    xs = [pos[n][0] for n in last_out]
    ys = [pos[n][1] for n in last_out]
    box = (min(xs) - 110, min(ys) - 110, int(max(xs) - min(xs) + 220), int(max(ys) - min(ys) + 220))
    W, H = int(box[2] * ZONE_MAP_PX), int(box[3] * ZONE_MAP_PX)
    acc = np.zeros((H, W), np.float32)
    cnt = np.zeros((H, W), np.float32)
    for n in last_out:
        m, v = zone_mask(z, z["idx"][n])
        M = _to_map(pos[n][0], pos[n][1], k[z_near], box)
        acc += cv2.warpAffine(m * v, M, (W, H), flags=cv2.INTER_LINEAR)
        cnt += cv2.warpAffine(v.astype(np.float32), M, (W, H), flags=cv2.INTER_LINEAR)
    known = cnt > 0.5
    Pm = np.where(known, acc / np.maximum(cnt, 1e-3), 0)
    if Pm[known].std() < 0.1:  # no zone in sight
        return []

    def corr(i, x, y):
        m, v = zone_mask(z, i)
        M = _to_map(x, y, k[z_far], box)
        mw = cv2.warpAffine(m, M, (W, H), flags=cv2.INTER_NEAREST)
        sel = (cv2.warpAffine(v.astype(np.uint8), M, (W, H), flags=cv2.INTER_NEAREST) > 0) & known
        if sel.sum() < 300:
            return -1.0
        a, b = mw[sel], Pm[sel]
        return float(((a - a.mean()) * (b - b.mean())).mean() / (a.std() * b.std() + 1e-6))

    fixes = []
    for n in far_fr[::4]:
        i = z["idx"][n]
        x0, y0, _ = pos[n]
        best = (-1.0, 0.0, 0.0)
        for step, span, coarse in ((2.0, search, True), (0.5, 2.0, False)):
            cx, cy = (0.0, 0.0) if coarse else (best[1], best[2])
            for dx in np.arange(cx - span, cx + span + 1e-6, step):
                for dy in np.arange(cy - span, cy + span + 1e-6, step):
                    s = corr(i, x0 + dx, y0 + dy)
                    if s > best[0]:
                        best = (s, float(dx), float(dy))
        if best[0] >= 0.85:
            fixes.append((n, x0 + best[1], y0 + best[2], 1.5))
    if fixes:
        off = np.median(np.array([(f[1] - pos[f[0]][0], f[2] - pos[f[0]][1]) for f in fixes]), axis=0)
        print(f"zone: {len(fixes)} frames past the switch at {switch} ({z_near} -> {z_far}) placed, moved by {np.round(off, 1)}")
    return fixes


# ---- mosaics

LOOK_MOSAIC = wl.look(zone="flat")  # the zone's pixels kept (filtered apart when matched)
MATCH = wl.app_config("mosaic")  # what the app matches a mosaic with (dog 1/4, marks and glare left out)


def build_mosaic(root: Path, pos: dict, zoom: str, k: float, skip=lambda n: False, extra=()) -> ml.Ref:
    """A mosaic of the frames at `zoom` (not skipped), and of `extra` [(survey dir, its positions)] too."""
    def samples():
        for src, ps, sk in [(root, pos, skip)] + [(d, q, lambda n: False) for d, q in extra]:
            z = wl.frames_of(src / REC)
            for n, (x, y, zm) in sorted(ps.items()):
                if zm == zoom and not sk(n):
                    i = z["idx"][n]
                    yield z["disc"][i], x, y, None if np.isnan(z["cam"][i]) else float(z["cam"][i])

    ref, spread, _ = ml.mosaic(samples(), wl.MINIMAP.size, LOOK_MOSAIC, k, 0.7)
    ref.name = f"mosaic-{zoom}"
    return ref


def rescaled(ref: ml.Ref, k: float) -> ml.Ref:
    """A reference drawn at k position units per px instead of ref.k."""
    f = ref.k / k
    img = cv2.resize(ref.img, None, fx=f, fy=f, interpolation=cv2.INTER_LINEAR)
    v = cv2.resize(ref.valid.astype(np.uint8), (img.shape[1], img.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
    return ml.Ref(img, v, (ref.origin[0] * f, ref.origin[1] * f), k, ref.name, ref.off)


def place(root: Path, pos: dict, ref: ml.Ref, zoom: str, radius: float = 15, every: int = 2, min_score: float = 0.5,
          min_margin: float = 0.15, frames=None) -> dict:
    """Frames at `zoom` located in `ref` near where they are put now: {n: (x, y, score)} of the trusted matches."""
    z = wl.frames_of(root / REC)
    out = {}
    for n, (x, y, zm) in sorted(pos.items())[::every]:
        if zm != zoom or (frames is not None and n not in frames):
            continue
        i = z["idx"][n]
        r = ml.locate(z["disc"][i], ref, MATCH, (x, y), radius, None if np.isnan(z["cam"][i]) else float(z["cam"][i]))
        if r and r["score"] >= min_score and r["score"] - r["second"] >= min_margin:
            out[n] = (r["x"], r["y"], r["score"])
    return out


def scan_k(root: Path, pos: dict, ref: ml.Ref, grid, frames) -> tuple[float, list]:
    """The k that makes `frames` (another zoom than ref's) match `ref` best: the median score per k, refined between
    grid steps. Their positions come from a solve at some k: a few px off is fine (radius 15)."""
    z = wl.frames_of(root / REC)
    rows = []
    for kz in grid:
        R = rescaled(ref, kz)
        sc = []
        for n in frames:
            x, y, _ = pos[n]
            i = z["idx"][n]
            r = ml.locate(z["disc"][i], R, MATCH, (x, y), 15, None if np.isnan(z["cam"][i]) else float(z["cam"][i]))
            if r:
                sc.append(r["score"])
        rows.append((float(kz), float(np.median(sc)) if sc else -1.0, len(sc)))
    s = [r[1] for r in rows]
    j = int(np.argmax(s))
    best = rows[j][0]
    if 0 < j < len(s) - 1:
        a, b, c = s[j - 1], s[j], s[j + 1]
        den = a - 2 * b + c
        if den < 0:
            best += max(-0.5, min(0.5, 0.5 * (a - c) / den)) * (grid[1] - grid[0])
    return float(best), rows


# ---- k zoomed out: the stronghold icon and the teleport stone, both on the minimap and on the big map

STONE = "minimap_stone.png"  # templates/: the teleport stone on the minimap (a cream pillar; cut from 酒肉山林's
# recording, frame 1420)


def stone_step(root: Path) -> list[float] | None:
    """The teleport stone's step from the stronghold icon on the recording's big map shots (big map px, median; the
    stone nearest the icon): a stronghold config's `stone`, which where() falls back on when the arrow hides the icon."""
    if not (root / "bigmap" / "shots.json").exists():
        return None
    bst = _tpl("map_teleport_stone.png")
    big = []
    for s in json.load(open(root / "bigmap" / "shots.json"))["shots"]:
        im = ml.imread(root / "bigmap" / s["file"])
        r = cv2.matchTemplate(im[60:660], bst, cv2.TM_CCOEFF_NORMED)
        ix, iy = s["icon"]
        best = None
        for y, x in zip(*np.nonzero(r > 0.7)):
            if r[y, x] < r[max(0, y - 2) : y + 3, max(0, x - 2) : x + 3].max():
                continue
            fx, fy = ml._sub(r, int(x), int(y))
            v = (float(fx) + bst.shape[1] / 2 - ix, float(fy) + 60 + bst.shape[0] / 2 - iy)
            if best is None or math.hypot(*v) < math.hypot(*best):
                best = v
        if best:
            big.append(best)
    return [round(float(v), 2) for v in np.median(np.array(big), axis=0)] if big else None


def stone_k(root: Path) -> dict | None:
    """k zoomed out, measured: the stone's step from the stronghold icon on the big map (stone_step) over the same
    step on the minimap (frames where both show, the stone away from the arrow: minimap px). The bearings of the two
    are compared too (the minimap is north-up)."""
    if not (T / STONE).exists():
        return None
    step = stone_step(root)
    if step is None:
        return None
    B = np.array(step)
    st = ml.imread(T / STONE)
    z = wl.frames_of(root / REC)
    vs = []
    for n, (kind, dx, dy) in icon_track(root).items():
        if kind != "live":
            continue
        d = z["disc"][z["idx"][n]]
        r = cv2.matchTemplate(d, st, cv2.TM_CCOEFF_NORMED)
        _, s, _, (x, y) = cv2.minMaxLoc(r)
        r2 = r.copy()
        cv2.circle(r2, (x, y), 3, -1, -1)
        if s < 0.8 or s - r2.max() < 0.2:
            continue
        fx, fy = ml._sub(r, x, y)
        sx, sy = float(fx) + st.shape[1] / 2 - 0.5 - MID, float(fy) + st.shape[0] / 2 - 0.5 - MID
        if math.hypot(sx, sy) >= 12:  # not under the arrow
            vs.append((sx - dx, sy - dy))
    if len(vs) < 10:
        return None
    M = np.median(np.array(vs), axis=0)
    bear = lambda v: math.degrees(math.atan2(v[0], -v[1]))
    return {"k": float(np.hypot(*B) / np.hypot(*M)), "big": [round(float(v), 2) for v in B], "mini": [round(float(v), 2) for v in M],
            "n": len(vs), "bearing_diff": round(bear(B) - bear(M), 2),
            "mad": [round(float(v), 2) for v in np.median(np.abs(np.array(vs) - M), axis=0)]}


ZOOM_RATIO = 2.0  # k zoomed out / zoomed in: 慈心山院 2.30 / 1.15, 佛爷寨 2.29 / 1.17 (here it cannot be told: the
# minimap's texture is drawn differently at the two zooms, and the stone leaves the disc as it zooms in)
ROUNDS = 3
SURE = 15  # track.json "sure": the icon or a mosaic placed a frame this close (frames)


def zone_check(root: Path, pos: dict, k: dict) -> list | None:
    """How far the zone outline says the first zoomed-in frames are from where they are put: [dx, dy], or None."""
    return zone_shift(pos, zone_fixes(root, pos, k))


def zone_shift(pos: dict, zf: list) -> list | None:
    if not zf:
        return None
    return [round(float(v), 2) for v in np.median(np.array([(f[1] - pos[f[0]][0], f[2] - pos[f[0]][1]) for f in zf]), axis=0)]


DEVICE_NEAR = 2.0  # px: recording frames this close to where locate() put the character on the device
DEVICE_SIGMA = 0.7


def device_fixes(root: Path) -> list[tuple[int, float, float, float]]:
    """<root>/device_anchors.json, optional: where() on the device against what locate() said there with the mosaic
    made from this track ([{locate: [x, y], where: [x, y], layer?: live | taken}], e.g. a dry run with check: true;
    layer: the reading was of that level, only frames of that kind are moved). The recording's frames
    that were at that place in the mosaic (within DEVICE_NEAR) are moved by the difference and held there. They are
    worked out once, against the track the mosaic came from, and kept in the file (`frames`), so a rerun is the same."""
    f = root / "device_anchors.json"
    if not f.exists():
        return []
    anchors = json.load(open(f))
    pos = load_track(root) if (root / "track.json").exists() else {}
    t = taken_at(root)
    changed = False
    for a in anchors:
        if "frames" not in a:
            L, W = np.array(a["locate"]), np.array(a["where"])
            # layer: a level of the reference (live / taken) the reading was matched in: only that level's frames
            lay = a.get("layer")
            keep = lambda n: lay is None or t is None or (n <= t) == (lay == "live")
            a["frames"] = [[n, round(float(x + W[0] - L[0]), 2), round(float(y + W[1] - L[1]), 2)]
                           for n, (x, y, _) in pos.items() if keep(n) and math.hypot(x - L[0], y - L[1]) <= DEVICE_NEAR]
            changed = True
    if changed:
        json.dump(anchors, open(f, "w"), indent=1)
    return [(n, x, y, DEVICE_SIGMA) for a in anchors for n, x, y in a["frames"]]


def locate_all(root: Path, k_out: float | None = None, k_in: float | None = None, skip=lambda n: False, quiet=False):
    """Every world frame's position: see cmd_locate. Frames `skip` says are left out of the mosaics and are not placed
    in them (an evaluation's held-out frames: their positions then come from the icon and the shifts alone)."""
    info = {}
    sk = stone_k(root)
    info["stone_k"] = sk  # a check only (see K)
    ko = k_out or K["out"]
    k = {"out": ko, "in": k_in or (K["in"] if not k_out else ko / ZOOM_RATIO)}
    if not quiet:
        print("k", {z_: round(v, 4) for z_, v in k.items()}, "stone", sk)
    dev = device_fixes(root)
    info["device_fixes"] = len(dev)
    pos, c, res = solve(root, k, dev, quiet=True)
    info["zone_before"] = zone_check(root, pos, k)
    # zoom_hand.json "zone_ties" (a recording that leaves the zone and comes back, 龙虎寨): the zone outline places the far
    # side of every zoom switch (zone_fixes, made again after each solve: they are worked out from the near side as it
    # is) and the icon's offsets at the two zooms are not tied. There the tie was what did not fit: with it the zone
    # said 4–7.5 px off at both switches and the track jumped 6 px coming back in while the character stood; without
    # it, 2.5 / 0.5 px and 0.4. Otherwise the zone is only a check (zone_check), as before
    zt = bool(zoom_conf(root).get("zone_ties"))
    tie = {} if not zt else {"tie": None}

    def zone_ties(pos):
        return [f for ch in zoom_changes(pos) for f in zone_fixes(root, pos, k, change=ch) if not skip(f[0])] if zt else []

    later = zone_ties(pos)
    for _ in range(2 if later else 0):
        pos, c, res = solve(root, k, list(dev) + later, quiet=True, **tie)
        later = zone_ties(pos)
    info["zone_ties"] = len(later)
    fixes = []
    for it in range(ROUNDS):
        zooms = [zm for zm in ("out", "in") if sum(1 for n, v in pos.items() if v[2] == zm and not skip(n)) >= 10]
        refs = {zm: build_mosaic(root, pos, zm, k[zm], skip=skip) for zm in zooms}
        later = zone_ties(pos) if later else []
        fixes = list(dev) + later
        for zm in zooms:
            fixes += [(n, x, y, 1.0) for n, (x, y, s) in place(root, pos, refs[zm], zm).items() if not skip(n)]
        if not quiet:
            print(f"round {it}: {len(fixes)} frames placed in the mosaics")
        pos, c, res = solve(root, k, fixes, quiet=quiet or it < ROUNDS - 1, **tie)
    info["zone_after"] = zone_check(root, pos, k)
    # the zone across the later switches (out of the zone and back), a check
    info["zone_later"] = [zone_shift(pos, zone_fixes(root, pos, k, change=ch)) for ch in zoom_changes(pos)[1:]]
    held = {f[0] for f in fixes} | {n for n, v in icon_track(root).items() if not v[0].endswith("_rim")}
    info["_held"] = held
    info.update({"k": k, "c": c, "fixes": len(fixes), "shift_resid_median": round(float(np.median(res["reg"])), 3),
                 "icon_resid_median": round(float(np.median(res["icon"])), 3),
                 "fix_resid_median": round(float(np.median(res["fix"])), 3) if len(res["fix"]) else None})
    return pos, info


def cmd_locate(root: Path, k_out: float | None = None, k_in: float | None = None) -> None:
    """<root>/track.json: each world frame's position and zoom, and <root>/locate.json: how they were got.
    1. k: the game's constant K (or --k-out / --k-in); stone_k() is worked out too, as a check.
    2. Everything solved (solve(): the look at the big map pins the zoomed-out frames, the icon both, its offsets
       at the two zooms tied).
    3. ROUNDS times: a mosaic per zoom from that, every other frame placed in it (fixes), solved again. This mends
       stretches the shifts lost hold of (a fight in the way: 酒肉山林's first zoomed-in frames drifted 7 px).
    4. Checked with the zone (zone_check: across the switch, the outline; should be within a px or two)."""
    pos, info = locate_all(root, k_out, k_in)
    held = np.array(sorted(info.pop("_held")))

    def sure(n):  # something besides the shifts says where it is, within half a second
        j = np.searchsorted(held, n)
        return any(0 <= m < len(held) and abs(int(held[m]) - n) <= SURE for m in (j - 1, j))

    rows = [{"seq": n, "x": round(x, 2), "y": round(y, 2), "zoom": zm, "sure": sure(n)} for n, (x, y, zm) in sorted(pos.items())]
    json.dump(rows, open(root / "track.json", "w"), indent=0)
    print(f"{sum(r['sure'] for r in rows)} of {len(rows)} frames held by the icon or a mosaic within {SURE} frames")
    json.dump(info, open(root / "locate.json", "w"), indent=1)
    print(info)


def load_track(root: Path, sure: bool = False) -> dict:
    """track.json as {n: (x, y, zoom)}; with sure, the "sure" flag too: {n: (x, y, zoom, sure)}."""
    return {r["seq"]: (r["x"], r["y"], r["zoom"]) + ((r.get("sure", True),) if sure else ()) for r in json.load(open(root / "track.json"))}


def track_png(root: Path, ref: ml.Ref, pos: dict, zoom: str, out: Path, scale: int = 3, label_every: int = 150) -> None:
    """The mosaic scaled up, where it is not known dark blue, the track at that zoom in red, frame numbers in green."""
    img = cv2.resize(ref.img, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
    bad = cv2.resize((~ref.valid).astype(np.uint8), (img.shape[1], img.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
    img[bad] = (60, 0, 0)

    def px(x, y):
        u, v = ref.to_px(x, y)
        return int(round(u * scale)), int(round(v * scale))

    pts = [(n, v) for n, v in sorted(pos.items()) if v[2] == zoom]
    for (n, a), (m, b) in zip(pts, pts[1:]):
        if m - n <= GAP:
            cv2.line(img, px(*a[:2]), px(*b[:2]), (0, 0, 255), 1)
    for n, a in pts[::label_every]:
        cv2.putText(img, str(n), px(*a[:2]), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 160, 0), 1)
    cv2.circle(img, px(0, 0), 4, (0, 255, 255), 1)  # the stronghold icon
    ml.imwrite(out, img)


def holdout(n: int, block: int = 300, every: int = 4) -> bool:
    """Frames left out for evaluation: every `every`-th block of `block` frames (10 s)."""
    return (n // block) % every == every - 1


TAKEN_RUN = 60  # frames: the gray (taken) icon seen this long without a break of more than TAKEN_GAP frames
TAKEN_GAP = 10


def taken_at(root: Path) -> int | None:
    """The frame the stronghold was taken at: the frame before the gray icon starts showing for good (the first run of
    taken-icon frames TAKEN_RUN long, gaps up to TAKEN_GAP, after the landing). Not the last red blob seen: enemies'
    red marks look like the live icon, and 酒肉山林's was put at 5256 though the icon was gray from 4422 on (the last
    頭陀 fell in the west yard), which left the teacher's way back to the chest out of the taken level."""
    if "taken_at" in zoom_conf(root):
        return zoom_conf(root)["taken_at"]
    raw = json.load(open(root / "icons.json"))
    live = [int(n) for n, v in raw.items() if v["live"]]
    done = sorted(int(n) for n, v in raw.items() if "done" in v and not v["done"].get("body"))  # the body fits live too
    if not live or not done:
        return None
    first_live = min(live)  # after the landing: the icon is red at first
    start = prev = None
    for n in done:
        if n <= first_live:
            continue
        if start is None or n - prev > TAKEN_GAP:
            start = n
        prev = n
        if prev - start >= TAKEN_RUN:
            return start - 1
    return max(live) if done[-1] > max(live) else None


def levels_of(root: Path, pos: dict, k: dict, skip=lambda n: False) -> list[tuple[str, str, ml.Ref]]:
    """The reference's levels: (zoom, tag, mosaic). Zoomed in, one from before the stronghold was taken (its orange
    zone over most of it) and one after (the bare map): a frame of either kind matches its own much better (bare
    frames in the zone mosaic: 61% trusted, the other way round 38%; 酒肉山林, 2026-10-02). Surveys (survey<N>/, made
    with the stronghold taken) go into the after level, or into the only one. Zoomed out is one level whatever the
    state: the way there was walked live, so a taken-state run would have nothing for it in an "after" level (龙虎寨:
    the teacher walked out of the zone after the last kill, zoomed out, and came back in), and the zone is at most
    an edge of the disc out there."""
    t = taken_at(root)
    sv = [(d, load_track(d)) for d in surveys_of(root)]  # surveyed on the device: the stronghold taken
    out = []
    for zm in ("out", "in"):
        n_zm = [n for n, v in pos.items() if v[2] == zm and not skip(n)]
        ex = [(d, q) for d, q in sv if any(v[2] == zm for v in q.values())]
        if zm == "out" or t is None or not n_zm or min(n_zm) > t or max(n_zm) < t:
            out.append((zm, zm, build_mosaic(root, pos, zm, k[zm], skip=skip, extra=ex)))
            continue
        before = [n for n in n_zm if n <= t]
        after = [n for n in n_zm if n > t + 20]
        if len(before) > 50:
            out.append((zm, f"{zm}_live", build_mosaic(root, pos, zm, k[zm], skip=lambda n: skip(n) or n > t)))
        if len(after) > 50 or ex:
            out.append((zm, f"{zm}_taken", build_mosaic(root, pos, zm, k[zm], skip=lambda n: skip(n) or n <= t + 20, extra=ex)))
    return out


def cmd_eval(root: Path) -> None:
    """Held-out frames (holdout()) located as the app would (every level, the best; dog 1/4; a prior 8 px off in
    varied directions, radius 30), against where they are when solved without them in any mosaic (locate_all with
    skip): <root>/eval.json and a summary per zoom and kind (before / after taken)."""
    pos, info = locate_all(root, skip=holdout, quiet=True)
    info.pop("_held", None)
    k = info["k"]
    t = taken_at(root)
    lv = levels_of(root, pos, k, skip=holdout)
    z = wl.frames_of(root / REC)
    rows = []
    test = [(n, v) for n, v in sorted(pos.items()) if holdout(n)][::2]
    for j, (n, (x, y, zm)) in enumerate(test):
        i = z["idx"][n]
        ang = j * 2.399
        prior = (x + 8 * math.cos(ang), y + 8 * math.sin(ang))
        cam = None if np.isnan(z["cam"][i]) else float(z["cam"][i])
        best = None
        covered = False
        for lz, tag, ref in lv:
            u, v = ref.to_px(x, y)
            if 0 <= int(v) < ref.valid.shape[0] and 0 <= int(u) < ref.valid.shape[1] and ref.valid[int(v), int(u)] and lz == zm:
                covered = True
            r = ml.locate(z["disc"][i], ref, MATCH, prior, 30, cam)
            if r and (best is None or r["score"] > best[0]["score"]):
                best = (r, tag)
        row = {"n": n, "zoom": zm, "kind": "taken" if t is not None and n > t else "live", "covered": covered}
        if best:
            r, tag = best
            row |= {"err": round(math.hypot(r["x"] - x, r["y"] - y), 2), "score": round(r["score"], 3),
                    "margin": round(r["score"] - r["second"], 3), "level": tag,
                    "trusted": r["score"] >= 0.4 and r["score"] - r["second"] >= 0.1}
        rows.append(row)
    json.dump({"info": info, "rows": rows}, open(root / "eval.json", "w"), indent=0)
    for zm in ("out", "in"):
        for kind in ("live", "taken"):
            g = [r for r in rows if r["zoom"] == zm and r["kind"] == kind and r["covered"]]
            if not g:
                continue
            tr = [r for r in g if r.get("trusted")]
            et = np.array([r["err"] for r in tr]) if tr else np.zeros(1)
            print(f"eval {zm} {kind}: {len(g)} held-out frames, trusted {len(tr) / len(g):.0%}, error median {np.median(et):.2f} px,"
                  f" p90 {np.percentile(et, 90):.2f}, trusted but > 4 px: {int((et > 4).sum())}")


def write_levels(name: str, levels: list[tuple[str, str, ml.Ref]], desc: str, templates: Path = T) -> Path:
    """The app's reference (map_locate.write_reference, but levels may share a zoom): templates/<name>.json and a
    PNG per level (alpha: where the mosaic is known). Levels from before / after the stronghold was taken get a
    `layer` (live / taken): the app's goto only tries the one that fits the minimap (orange zone in sight or not)."""
    out = []
    for zm, tag, ref in levels:
        png = f"{name}_{tag}.png"
        bgra = cv2.cvtColor(ref.img, cv2.COLOR_BGR2BGRA)
        bgra[:, :, 3] = np.where(ref.valid, 255, 0)
        ml.imwrite(templates / png, bgra)
        layer = tag.rsplit("_", 1)[1] if tag.endswith(("_live", "_taken")) else None
        out.append({"zoom": zm, **({"layer": layer} if layer else {}), "image": png, "k": round(ref.k, 4),
                    "origin": [round(float(v), 2) for v in ref.origin], "off": [round(float(v), 2) for v in ref.off]})
    path = templates / f"{name}.json"
    cfg = MATCH.json()
    json.dump({"desc": desc, "levels": out, **cfg}, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=4)
    print("wrote", path)
    return path


def mosaic_ref(name: str) -> str:
    """The app's reference for a stronghold: lower case (nodes are Jiurou…, files jiurou_…; the device's file system tells
    case apart, the PC's does not, so a JSON naming Jiurou_mosaic_out.png works here and not there)."""
    return f"locate/{name.lower()}_mosaic"


def cmd_mosaic(root: Path, name: str | None = None, rec: str | None = None) -> None:
    """<root>/mosaic/<tag>.png (save_ref) and track_<tag>.png from track.json; with --name, the app's reference
    templates/locate/<name>_mosaic.json and its PNGs."""
    pos = load_track(root)
    k = json.load(open(root / "locate.json"))["k"]
    lv = levels_of(root, pos, k)
    for zm, tag, ref in lv:
        ml.save_ref(root / "mosaic", tag, ref)
        track_png(root, ref, pos, zm, root / "mosaic" / f"track_{tag}.png")
    if name:
        write_levels(mosaic_ref(name), lv, f"{name.lower()}: minimap reference stitched from recording {rec or '?'} "
                     f"(levels: zoom out / in, before and after the stronghold was taken), made by tools/rec_route.py mosaic")


# ---- data layout of surveys (rr_device makes them)

SURVEY = "survey"  # <root>/survey<N>/: rec/ (grab_frames: <seq>.jpg, frames.jsonl), route.json, survey.json, and
# what cache / icons / register / locate write, as for the recording


def surveys_of(root: Path) -> list[Path]:
    return sorted((d for d in root.glob(f"{SURVEY}*") if (d / "track.json").exists()), key=lambda d: int(d.name[len(SURVEY):] or 0))


def zoom_conf(root: Path) -> dict:
    """<root>/zoom_hand.json, optional, written by hand after looking at the minimap frames, for where the icon cannot
    tell: {"switches": [[first, last, "in" | "out"], ...] (each zoom animation's frames, replacing zoom_switches()),
    "taken_at": n (replacing taken_at()'s guess), "note": ...}. 龙虎寨 (2026-10-04): the live icon was under the
    camera fan when it zoomed in, and once taken the chest icon sits on the gray one, so the icon saw neither the
    zoom in at the gate nor the one coming back in after the stretch outside; it called the icon turning gray a switch."""
    f = root / "zoom_hand.json"
    return json.load(open(f, encoding="utf-8")) if f.exists() else {}


def survey_conf(root: Path) -> dict:
    f = root / "survey.json"
    return json.load(open(f)) if f.exists() else {}
