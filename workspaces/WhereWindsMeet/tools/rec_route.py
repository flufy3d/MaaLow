"""A stronghold (据点) route made from one recording: the teacher plays it through once (menu → 江湖行 → the stronghold's
card → stone → teleport → run there → fight → chest), marking nothing; this makes the teleport nodes, the minimap
references (outside / inside zoom), the route node and the one-click entry from it.

The route is not the recorded track played back: every place the character was seen on (fights included, where it got
pushed about) is ground that can be walked. On that map, the way between the stops found in the recording (actions on
the interaction list, a task count going up) is planned (A*, kept off the edges), then cut down to straight legs.

    uv run --extra cv python workspaces/WhereWindsMeet/tools/rec_route.py all data/wwm_jiurou --rec 20261002-025629
    uv run --extra cv python workspaces/WhereWindsMeet/tools/rec_route.py emit data/wwm_jiurou --name jiurou --rec 20261002-025629

`all` runs the steps in turn (each can be run alone, the same way):
    frames     <root>/rec/<n>.jpg from the recording (pull it first: maalow rec pull <id>)
    cache      rec/frames.npz (minimap discs, camera) and screens.json (what each frame shows)
    ocr        text.json: the tracker and the interaction list (PaddleOCR, wwm_ocr.py)
    icons      icons.json: the stronghold icon on the minimap (live: dark red blobs; taken: a template)
    bigmap     anchors.json (each look at the big map from the world screen), bigmap/ (a weak reference, not exported)
    register   reg.json: map shifts between frames 7, 10 and 30 apart
    locate     track.json, locate.json: every frame's place and zoom (k measured, see cmd_locate)
    eval       eval.json: held-out frames located in mosaics made without them
    mosaic     mosaic/ (and with --name, templates/locate/<name>_mosaic*)
    plan       targets.json, plan.json, plan.png: the stops, the walkable map, the route
    view       plan_view.png: the route over the mosaics, for the teacher
    emit       the pipeline nodes (pipeline/stronghold.json) and the card's template
    check      the walkable map and the planner tried on another survey (e.g. 佛爷寨's) against the teacher's route
    anchors    a dry run's where() readings (route_seg.py ... check=true out=RUN.json) into device_anchors.json

On the device (the stronghold taken; tell the teacher first, these open the big map a lot):
    dryrun     the route with check: true; how far it got (each point's where() within CHECK_OFF)
    survey     walk points a-b the old way (big map, step, look again) grabbing frames: survey<N>/, placed by its looks
    auto       dry run → survey from where it went wrong → mosaic, plan, view, emit, push → again, until it passes

After a dry run with check: true, `anchors --run RUN.json` puts its where() readings into <root>/device_anchors.json
(device_fixes); then locate / mosaic / plan / emit again.

Positions are big map px (fully zoomed in) from the stronghold icon, x east / y south, as stronghold.js where() reads
them. Data (not committed): <root>/rec/<n>.jpg (the recording's frames, n = frame number, 30 fps) and what the steps
write next to it. The minimap matching is scripts/map_locate.py, the game's minimap tools/wwm_locate.py.
"""

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


def icon_blobs(d: np.ndarray) -> list[dict]:
    """Dark red blobs in a minimap disc that could be the stronghold icon: middle (disc px, from the character),
    area, height / width."""
    R, _ = ml.polar(d.shape[0])
    hsv = cv2.cvtColor(d, cv2.COLOR_BGR2HSV)
    m = (ml.in_range(hsv, ICON_RED) & (R <= 47)).astype(np.uint8)
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
    (`live`) and the best match of the taken one (`done`, templates/minimap_stronghold_done.png)."""
    z = wl.frames_of(root / REC)
    t = ml.imread(T / DONE_ICON) if (T / DONE_ICON).exists() else None
    out = {}
    for i, n in enumerate(z["seq"]):
        if z["world"][i]:
            b = icon_blobs(z["disc"][i])
            g = done_icon(z["disc"][i], t) if t is not None else None
            out[int(n)] = {"live": b, **({"done": g} if g and g["s"] >= 0.6 and g["m"] >= 0.15 else {})}
    json.dump(out, open(root / "icons.json", "w"))
    print(len(out), "world frames;", sum(1 for v in out.values() if v["live"]), "with red blobs;",
          sum(1 for v in out.values() if "done" in v), "with the taken icon")


PINNED = 38  # the icon is held on the disc's rim (r ~42-46) when it is farther: past this, its distance says nothing


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
K0 = {"out": 2.29, "in": 1.16}  # big map px per minimap px to start from (佛爷寨, 慈心山院); fitted here
WALK = 0.6  # big map px per frame: the random walk that holds frames with nothing else on them
GAP = 30  # frames off the world screen that split a stretch
ANIM = (10, 30)  # frames left out before / after a zoom switch's first / last look (it animates ~1 s)


def segments(root: Path, track) -> list[dict]:
    """Stretches of good world frames at one zoom: split at the zoom switches (their animation left out); the first
    one is zoomed out (the character starts outside, at the teleport stone; a survey's survey.json says otherwise)."""
    z = wl.frames_of(root / REC)
    good = good_world(root)
    sw = zoom_switches(track)
    cuts = [(s["from"] - ANIM[0], s["to"] + ANIM[1], s["way"]) for s in sw]
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
    keep_reg, keep_ic, keep_fix = np.ones(len(regs), bool), np.ones(len(icons), bool), np.ones(len(fix), bool)
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
                  f"(out {int((~keep_ic).sum())}/{len(icons)}), fixes {np.median(res_fix) if fix else 0:.2f} (out {int((~keep_fix).sum())}/{len(fix)})")
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


def zone_fixes(root: Path, pos: dict, k: dict, before: int = 300, search: float = 16.0) -> list[tuple[int, float, float, float]]:
    """Where the first zoomed-in frames are, from the zone: the zoomed-out frames' zone masks drawn into a map (big
    map px; the zone only shrinks when an enemy falls, so only the last zoomed-out stretch is used), each zoomed-in
    frame's mask (within `before` frames of the switch) slid over it, the best place by correlation (it is a crisp
    outline, ~0.95 where it fits). The minimap's texture is no help here: it is drawn differently at the two zooms."""
    z = wl.frames_of(root / REC)
    out_fr = [n for n, v in sorted(pos.items()) if v[2] == "out"]
    in_fr = [n for n, v in sorted(pos.items()) if v[2] == "in"]
    if not out_fr or not in_fr:
        return []
    switch = in_fr[0]
    last_out = [n for n in out_fr if switch - before <= n < switch][::2]
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
        M = _to_map(pos[n][0], pos[n][1], k["out"], box)
        acc += cv2.warpAffine(m * v, M, (W, H), flags=cv2.INTER_LINEAR)
        cnt += cv2.warpAffine(v.astype(np.float32), M, (W, H), flags=cv2.INTER_LINEAR)
    known = cnt > 0.5
    Pm = np.where(known, acc / np.maximum(cnt, 1e-3), 0)
    if Pm[known].std() < 0.1:  # no zone in sight
        return []

    def corr(i, x, y):
        m, v = zone_mask(z, i)
        M = _to_map(x, y, k["in"], box)
        mw = cv2.warpAffine(m, M, (W, H), flags=cv2.INTER_NEAREST)
        sel = (cv2.warpAffine(v.astype(np.uint8), M, (W, H), flags=cv2.INTER_NEAREST) > 0) & known
        if sel.sum() < 300:
            return -1.0
        a, b = mw[sel], Pm[sel]
        return float(((a - a.mean()) * (b - b.mean())).mean() / (a.std() * b.std() + 1e-6))

    fixes = []
    for n in [n for n in in_fr if n < switch + before][::4]:
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
        print(f"zone: {len(fixes)} zoomed-in frames placed, moved by {np.round(off, 1)}")
    return fixes


# ---- mosaics

LOOK_MOSAIC = wl.look(zone="flat")  # the zone's pixels kept (filtered apart when matched)
MATCH = wl.PREPS[wl.APP_PREPS["mosaic"]]  # what the app matches a mosaic with (dog 1/4)


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


def stone_k(root: Path) -> dict | None:
    """k zoomed out, measured: the stone's step from the stronghold icon on the big map (its shots: big map px) over
    the same step on the minimap (frames where both show, the stone away from the arrow: minimap px). The bearings
    of the two are compared too (the minimap is north-up)."""
    if not (T / STONE).exists() or not (root / "bigmap" / "shots.json").exists():
        return None
    st = ml.imread(T / STONE)
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
    if not big:
        return None
    B = np.median(np.array(big), axis=0)
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
    zf = zone_fixes(root, pos, k)
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
    sk = None if k_out else stone_k(root)
    info["stone_k"] = sk
    ko = k_out or (sk["k"] if sk else K0["out"])
    k = {"out": ko, "in": k_in or ko / ZOOM_RATIO}
    if not quiet:
        print("k", {z_: round(v, 4) for z_, v in k.items()}, "stone", sk)
    dev = device_fixes(root)
    info["device_fixes"] = len(dev)
    pos, c, res = solve(root, k, dev, quiet=True)
    info["zone_before"] = zone_check(root, pos, k)
    fixes = []
    for it in range(ROUNDS):
        zooms = [zm for zm in ("out", "in") if sum(1 for n, v in pos.items() if v[2] == zm and not skip(n)) >= 10]
        refs = {zm: build_mosaic(root, pos, zm, k[zm], skip=skip) for zm in zooms}
        fixes = list(dev)
        for zm in zooms:
            fixes += [(n, x, y, 1.0) for n, (x, y, s) in place(root, pos, refs[zm], zm).items() if not skip(n)]
        if not quiet:
            print(f"round {it}: {len(fixes)} frames placed in the mosaics")
        pos, c, res = solve(root, k, fixes, quiet=quiet or it < ROUNDS - 1)
    info["zone_after"] = zone_check(root, pos, k)
    held = {f[0] for f in fixes} | {n for n, v in icon_track(root).items() if not v[0].endswith("_rim")}
    info["_held"] = held
    info.update({"k": k, "c": c, "fixes": len(fixes), "shift_resid_median": round(float(np.median(res["reg"])), 3),
                 "icon_resid_median": round(float(np.median(res["icon"])), 3),
                 "fix_resid_median": round(float(np.median(res["fix"])), 3) if len(res["fix"]) else None})
    return pos, info


def cmd_locate(root: Path, k_out: float | None = None, k_in: float | None = None) -> None:
    """<root>/track.json: each world frame's position and zoom, and <root>/locate.json: how they were got.
    1. k zoomed out: stone_k() (or --k-out), else K0; zoomed in: that over ZOOM_RATIO (or --k-in).
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


def taken_at(root: Path) -> int | None:
    """The frame the stronghold was taken at: the last live icon seen (it turns gray), when a taken one shows after."""
    raw = json.load(open(root / "icons.json"))
    live = [int(n) for n, v in raw.items() if v["live"]]
    done = [int(n) for n, v in raw.items() if "done" in v and live and int(n) > max(live)]
    return max(live) if live and done else None


def levels_of(root: Path, pos: dict, k: dict, skip=lambda n: False) -> list[tuple[str, str, ml.Ref]]:
    """The reference's levels: (zoom, tag, mosaic). Zoomed in, one from before the stronghold was taken (its orange
    zone over most of it) and one after (the bare map): a frame of either kind matches its own much better (bare
    frames in the zone mosaic: 61% trusted, the other way round 38%; 酒肉山林, 2026-10-02). Surveys (survey<N>/, made
    with the stronghold taken) go into the after level, or into the only one."""
    t = taken_at(root)
    sv = [(d, load_track(d)) for d in surveys_of(root)]  # surveyed on the device: the stronghold taken
    out = []
    for zm in ("out", "in"):
        n_zm = [n for n, v in pos.items() if v[2] == zm and not skip(n)]
        ex = [(d, q) for d, q in sv if any(v[2] == zm for v in q.values())]
        if t is None or not n_zm or min(n_zm) > t or max(n_zm) < t:
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
    cfg = wl.look(kind=MATCH.prep.kind, pre=MATCH.prep.pre, sigma=MATCH.prep.sigma).json()
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


# ---- what the teacher did: stops and tasks from the recording

ACTIONS = {"据点宝箱": "chest", "销毁": "flower"}  # interaction rows that are a route's stops (route.js `do`)


def task_lines(tracker: list[str]) -> list[tuple[str, int, int]]:
    """The stronghold's task lines on the tracker: (text before the count, done, of)."""
    out = []
    for l in tracker:
        m = re.search(COUNT, l)
        if m:
            out.append((l[: m.start()].lstrip("xX×✕").strip(), int(m[1]), int(m[2])))
    return out


def find_targets(root: Path, pos: dict) -> dict:
    """From text.json and the track: the stops (each run of frames an action row shows on the interaction list: where
    the character was, its camera), the tasks (a word of each task line for route.js `tracker`, its counts as they
    went up and where the character was then: the kills) and the frame the stronghold was done (its block left the
    tracker)."""
    text = json.load(open(root / "text.json", encoding="utf-8"))
    z = wl.frames_of(root / REC)
    near = lambda n: min(pos, key=lambda m: abs(m - n)) if pos else None
    stops = []
    for word, act in ACTIONS.items():
        runs_ = []
        for t in text:
            if any(word in l for l in t["list"]):
                if runs_ and t["n"] - runs_[-1][-1] <= 30:
                    runs_[-1].append(t["n"])
                else:
                    runs_.append([t["n"]])
        for r in runs_:
            fr = [n for n in pos if r[0] <= n <= r[-1]]
            if not fr:
                continue
            xs, ys = [pos[n][0] for n in fr], [pos[n][1] for n in fr]
            cams = [z["cam"][z["idx"][n]] for n in fr if not np.isnan(z["cam"][z["idx"][n]])]
            stops.append({"do": act, "frames": [r[0], r[-1]], "at": [round(float(np.median(xs)), 1), round(float(np.median(ys)), 1)],
                          "cam": int(round(float(np.median(cams)))) if cams else None, "zoom": pos[fr[len(fr) // 2]][2]})
    stops.sort(key=lambda s: s["frames"][0])
    tasks: dict[str, dict] = {}  # by kind and count: OCR misreads a character now and then (破或头陀), the count holds
    for t in text:
        for name, done, of in task_lines(t["tracker"]):
            word = re.sub(r"^(剿灭所有|剿灭|击败|销毁|消灭)", "", name)[-4:] or name
            k = "flowers" if ("毒花" in name or "销毁" in name) else "foes"
            g = tasks.setdefault(f"{k}/{of}", {"key": k, "of": of, "counts": [], "words": {}})
            g["words"][word] = g["words"].get(word, 0) + 1
            if done <= of and (not g["counts"] or done > g["counts"][-1][1]):
                n = near(t["n"])
                g["counts"].append([t["n"], done] + ([round(pos[n][0], 1), round(pos[n][1], 1)] if n is not None and abs(n - t["n"]) <= 60 else []))
    for g in tasks.values():
        g["word"] = max(g["words"], key=g["words"].get)
    inside = [t["n"] for t in text if task_lines(t["tracker"])]
    done_at = None
    if inside:
        after = [t["n"] for t in text if t["n"] > inside[-1]]
        done_at = after[0] if after else None
    return {"stops": stops, "tasks": tasks, "done_at": done_at, "taken_at": taken_at(root)}


# ---- the walkable map and the way through it

GRID = 0.5  # big map px per cell
BODY = 1.5  # big map px around each place the character stood that counts as walkable
EDGE_W = 2.0  # A*: a step's cost is its length times 1 + EDGE_W / (clearance + 0.5): the middle of the way is cheaper
SIMPLIFY = 1.5  # big map px: a leg may leave the planned way by this much
MIN_CLEAR = 1.0  # big map px: every point of a leg this far inside what was walked
VIA_NEAR = 12.0  # big map px: a task count going up this close to the stop before is the same place
BRIDGE = (60, 15)  # frames, big map px: a step over frames left out that is still walked (straight)


class Walk:
    """Cells the character was seen on (the track's consecutive places joined, BODY wide), their clearance (distance to
    the nearest cell never walked, big map px) and how much of it rests on frames the icon or a mosaic held (sure)."""

    def __init__(self, track: dict, pad: float = 20):
        xs = [v[0] for v in track.values()]
        ys = [v[1] for v in track.values()]
        self.x0, self.y0 = min(xs) - pad, min(ys) - pad
        W, H = int((max(xs) - self.x0 + pad) / GRID) + 1, int((max(ys) - self.y0 + pad) / GRID) + 1
        walked = np.zeros((H, W), np.uint8)
        sure = np.zeros((H, W), np.uint8)
        pts = sorted(track.items())
        r = max(1, int(round(BODY / GRID)))
        for (n, a), (m, b) in zip(pts, pts[1:]):
            d = math.hypot(b[0] - a[0], b[1] - a[1])
            # frames left out between (a zoom switch's animation, a flicker) are bridged when the step is a walk's
            # (or any time apart, standing at one place: a look at the big map)
            if not ((m - n <= GAP and d <= 4) or (m - n <= BRIDGE[0] and d <= BRIDGE[1]) or d <= 2 * BODY):
                cv2.circle(walked, self.cell(a), r, 1, -1)
                continue
            cv2.line(walked, self.cell(a), self.cell(b), 1, 2 * r + 1)
            if m - n > GAP:
                continue  # bridged: not sure
            if len(a) > 3 and a[3] and b[3]:
                cv2.line(sure, self.cell(a), self.cell(b), 1, 2 * r + 1)
        self.walked = walked > 0
        self.sure = sure > 0
        self.clear = cv2.distanceTransform(walked, cv2.DIST_L2, 5) * GRID

    def cell(self, p) -> tuple[int, int]:
        return int(round((p[0] - self.x0) / GRID)), int(round((p[1] - self.y0) / GRID))

    def at(self, c) -> tuple[float, float]:
        return self.x0 + c[0] * GRID, self.y0 + c[1] * GRID

    def clearance(self, p) -> float:
        u, v = self.cell(p)
        if 0 <= v < self.clear.shape[0] and 0 <= u < self.clear.shape[1]:
            return float(self.clear[v, u])
        return 0.0

    def snap(self, p) -> tuple[int, int]:
        """The walked cell nearest p (a stop can be a step off what was walked)."""
        u, v = self.cell(p)
        ys, xs = np.nonzero(self.walked)
        j = int(np.argmin((xs - u) ** 2 + (ys - v) ** 2))
        return int(xs[j]), int(ys[j])

    def astar(self, a, b) -> list[tuple[int, int]]:
        """Cells from a to b over walked cells, by A* (8-neighbour), each step's cost raised near the edges."""
        H, W = self.walked.shape
        start, goal = self.snap(a), self.snap(b)
        cost = 1.0 + EDGE_W / (self.clear + 0.5)
        dist = {start: 0.0}
        prev = {}
        heap = [(0.0, start)]
        steps = [(dx, dy, math.hypot(dx, dy)) for dx in (-1, 0, 1) for dy in (-1, 0, 1) if dx or dy]
        while heap:
            _, c = heapq.heappop(heap)
            if c == goal:
                break
            d0 = dist[c]
            for dx, dy, l in steps:
                q = (c[0] + dx, c[1] + dy)
                if not (0 <= q[0] < W and 0 <= q[1] < H) or not self.walked[q[1], q[0]]:
                    continue
                nd = d0 + l * 0.5 * (cost[c[1], c[0]] + cost[q[1], q[0]])
                if nd < dist.get(q, 1e18):
                    dist[q] = nd
                    prev[q] = c
                    heapq.heappush(heap, (nd + math.hypot(goal[0] - q[0], goal[1] - q[1]), q))
        if goal not in dist:
            raise ValueError(f"no walked way from {a} to {b}")
        path = [goal]
        while path[-1] != start:
            path.append(prev[path[-1]])
        return path[::-1]

    def leg_ok(self, p, q, need: float = MIN_CLEAR) -> tuple[bool, float]:
        """A straight leg p-q: all of it at least `need` inside what was walked; and its least clearance."""
        n = max(2, int(math.hypot(q[0] - p[0], q[1] - p[1]) / (GRID / 2)))
        cl = min(self.clearance((p[0] + (q[0] - p[0]) * t / n, p[1] + (q[1] - p[1]) * t / n)) for t in range(n + 1))
        return cl >= need - 1e-6, cl


def simplify(walk: Walk, path: list[tuple[float, float]]) -> list[int]:
    """Douglas-Peucker on the planned way (SIMPLIFY), each leg also kept inside what was walked (else split at its
    farthest point): at least MIN_CLEAR from the edge, or as far as the way it stands for gets where that is closer (a
    narrow bit that was walked: its own clearance is all there is). Indexes of the corners kept."""
    own = [walk.clearance(p) for p in path]

    def rec(i, j):
        if j <= i + 1:
            return [i, j]
        p, q = np.array(path[i]), np.array(path[j])
        d = q - p
        L = np.hypot(*d)
        far, k = -1.0, i + 1
        for m in range(i + 1, j):
            v = np.array(path[m]) - p
            e = abs(d[0] * v[1] - d[1] * v[0]) / L if L > 1e-9 else np.hypot(*v)
            if e > far:
                far, k = e, m
        if far <= SIMPLIFY and walk.leg_ok(path[i], path[j], min(MIN_CLEAR, min(own[i : j + 1])))[0]:
            return [i, j]
        return rec(i, k)[:-1] + rec(k, j)

    return rec(0, len(path) - 1)


def plan(walk: Walk, stops: list[dict]) -> tuple[list[dict], list[dict]]:
    """Route points through the stops in order (A* between each two, cut down to legs): [{at, name?, cam?, do?}] and
    per leg {from, to, length, clear (the least clearance on it), unsure (its share on cells only the shifts held)}."""
    pts: list[dict] = [{"at": stops[0]["at"], "name": stops[0].get("name", "")} | ({"cam": stops[0]["cam"]} if stops[0].get("cam") is not None else {})]
    legs = []
    for s0, s1 in zip(stops, stops[1:]):
        cells = walk.astar(s0["at"], s1["at"])
        path = [walk.at(c) for c in cells]
        path[0], path[-1] = tuple(s0["at"]), tuple(s1["at"])
        keep = simplify(walk, path)
        for a, b in zip(keep, keep[1:]):
            p, q = path[a], path[b]
            ok, cl = walk.leg_ok(p, q)
            cs = cells[a : b + 1]
            unsure = float(np.mean([not walk.sure[c[1], c[0]] for c in cs])) if cs else 0.0
            legs.append({"from": [round(p[0], 1), round(p[1], 1)], "to": [round(q[0], 1), round(q[1], 1)],
                         "length": round(math.hypot(q[0] - p[0], q[1] - p[1]), 1), "clear": round(cl, 2), "unsure": round(unsure, 2)})
        for m in keep[1:-1]:
            pts.append({"at": [round(path[m][0], 1), round(path[m][1], 1)]})
        last = {"at": s1["at"]}
        for key in ("name", "cam", "do"):
            if s1.get(key) is not None:
                last[key] = s1[key]
        pts.append(last)
    return pts, legs


def plan_png(walk: Walk, pts: list[dict], legs: list[dict], out: Path, kills=(), scale: int = 4, bg=None) -> None:
    """The walked cells (gray, lighter = farther from the edge; cells only the shifts held tinted blue), the track's
    kills (red x), the route (green legs, orange where a leg is unsure or tight), its points numbered."""
    c = np.clip(walk.clear / 6.0, 0, 1)
    img = np.zeros(walk.walked.shape + (3,), np.uint8)
    g = (60 + 150 * c).astype(np.uint8)
    img[walk.walked] = np.stack([g, g, g], -1)[walk.walked]
    un = walk.walked & ~walk.sure
    img[un] = (img[un] * np.array([1.0, 0.75, 0.6])).astype(np.uint8)
    img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
    if bg is not None:
        img = cv2.addWeighted(img, 0.7, bg, 0.3, 0)
    P = lambda p: (int(round((p[0] - walk.x0) / GRID * scale)), int(round((p[1] - walk.y0) / GRID * scale)))
    for k in kills:
        x, y = P(k)
        cv2.drawMarker(img, (x, y), (0, 0, 255), cv2.MARKER_TILTED_CROSS, 10, 2)
    for leg in legs:
        bad = leg["unsure"] > 0.3 or leg["clear"] < 1.5
        cv2.line(img, P(leg["from"]), P(leg["to"]), (0, 140, 255) if bad else (0, 200, 0), 2)
    for i, p in enumerate(pts):
        cv2.circle(img, P(p["at"]), 3, (0, 255, 255) if p.get("do") else (255, 255, 255), -1)
        cv2.putText(img, str(i), (P(p["at"])[0] + 4, P(p["at"])[1] - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 0), 1)
    cv2.drawMarker(img, P((0, 0)), (0, 255, 255), cv2.MARKER_DIAMOND, 12, 1)  # the stronghold icon
    ml.imwrite(out, img)


def cmd_plan(root: Path) -> None:
    """<root>/targets.json (find_targets), <root>/plan.json (the route points from the teleport landing through the
    stops, the tracker words, the legs) and <root>/plan.png. The stops follow the teacher's way: the actions (chest,
    flowers, elite) and, in between, where each task count went up in the recording (VIA_NEAR apart), in order."""
    track = load_track(root, sure=True)
    pos = {n: v[:3] for n, v in track.items()}
    tg = find_targets(root, pos)
    json.dump(tg, open(root / "targets.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    first = min(pos)
    start = {"at": [round(pos[first][0], 1), round(pos[first][1], 1)], "name": "传送石碑（落地）",
             "cam": int(round(float(wl.frames_of(root / REC)["cam"][wl.frames_of(root / REC)["idx"][first]])))}
    names = {"chest": "据点宝箱", "flower": "毒花", "fight": "精英怪"}
    acts = [s | {"name": names.get(s["do"], s["do"]), "n": s["frames"][0]} for s in tg["stops"] if s["do"] in ("chest", "flower", "fight")]
    # the teacher's way: where each task count went up (a foe fell, a flower went) is passed on the way, in the order
    # of the recording; one within VIA_NEAR of the stop before it is the same place
    # (not the first count read: that is where the tracker came up, i.e. where the stronghold's area begins, and
    # the task may have been under way before; 酒肉山林's 1/7 showed at its gate, where the minimap zooms)
    kills = sorted((c[0], c[1], c[2:], g["word"]) for g in tg["tasks"].values() for c in g["counts"][1:] if len(c) == 4)
    stops = [start | {"n": first}]
    for ev in sorted([(s["n"], "act", s) for s in acts] + [(n, "kill", (done, at, w)) for n, done, at, w in kills], key=lambda e: e[0]):
        if ev[1] == "act":
            stops.append(ev[2])
            continue
        done, at, w = ev[2]
        if math.hypot(at[0] - stops[-1]["at"][0], at[1] - stops[-1]["at"][1]) <= VIA_NEAR:
            continue
        if any(s.get("do") == "chest" for s in stops):
            continue  # nothing after the chest
        stops.append({"at": at, "name": f"{w} {done}（录像第 {ev[0]} 帧）", "n": ev[0]})
    for s_ in stops:
        s_.pop("n", None)
    walk = Walk(track)
    pts, legs = plan(walk, stops)
    tracker = {g["key"]: g["word"] for g in tg["tasks"].values()}
    kills = [c[2:] for g in tg["tasks"].values() for c in g["counts"] if len(c) == 4]
    json.dump({"points": pts, "legs": legs, "tracker": tracker, "kills": kills}, open(root / "plan.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    plan_png(walk, pts, legs, root / "plan.png", kills)
    print("stops", [(s["do"], s["at"], s["frames"]) for s in tg["stops"]], "tasks", {g["word"]: g["counts"] for g in tg["tasks"].values()}, "tracker", tracker)
    for i, p in enumerate(pts):
        print(i, p)
    for l in legs:
        print("leg", l)


def node_points(node: str) -> list[dict]:
    """A route node's points (pipeline/*.json custom_action_param.points)."""
    for f in sorted((WS / "pipeline").glob("*.json")):
        d = json.load(open(f, encoding="utf-8"))
        if node in d:
            return d[node]["custom_action_param"]["points"]
    raise KeyError(node)


def polyline_dist(p, line) -> float:
    """Distance from p to a polyline."""
    best = 1e9
    for a, b in zip(line, line[1:]):
        a, b, q = np.array(a, float), np.array(b, float), np.array(p, float)
        d = b - a
        t = np.clip(np.dot(q - a, d) / max(np.dot(d, d), 1e-9), 0, 1)
        best = min(best, float(np.hypot(*(a + t * d - q))))
    return best


def cmd_check(root: Path, tracks: list[Path], node: str, pairs: list[tuple[int, int]]) -> None:
    """The walkable map and the planner tried on another stronghold's survey (tracks: wwm_locate track.json files)
    against the route the teacher walked there (`node`): for each pair i-j of its points, the way planned from i to j
    with the points between left out, how far it strays from the teacher's i..j (max) and from the straight i-j (a
    detour the teacher made is one the plan should make too). <root>/check_<i>_<j>.png."""
    track = {}
    for f in tracks:
        for r in json.load(open(f)):
            track[(f.parent.name, r["seq"])] = (r["x"], r["y"], r.get("zoom", "out"), True)
    # the Walk joins consecutive frames by seq: keep each survey's frames apart (offset their numbers)
    flat, base = {}, 0
    for sv in sorted({k[0] for k in track}):
        ks = sorted(n for s, n in track if s == sv)
        for n in ks:
            flat[base + n - ks[0]] = track[(sv, n)]
        base += ks[-1] - ks[0] + 10_000
    walk = Walk(flat)
    P = node_points(node)
    for i, j in pairs:
        stops = [{"at": P[i]["at"], "name": str(i)}, {"at": P[j]["at"], "name": str(j)}]
        pts, legs = plan(walk, stops)
        teacher = [p["at"] for p in P[i : j + 1]]
        cells = walk.astar(P[i]["at"], P[j]["at"])
        way = [walk.at(c) for c in cells]
        stray = max(polyline_dist(p, teacher) for p in way)
        straight = max(polyline_dist(p, [P[i]["at"], P[j]["at"]]) for p in way)
        teacher_off = max(polyline_dist(p["at"], [P[i]["at"], P[j]["at"]]) for p in P[i + 1 : j]) if j > i + 1 else 0
        print(f"{i}-{j}: planned {len(pts) - 2} corners, strays from the teacher's way by {stray:.1f} px at most; "
              f"off the straight line by {straight:.1f} (the teacher's points between: {teacher_off:.1f}); legs "
              + "; ".join(f"{l['from']}->{l['to']} clear {l['clear']}" for l in legs))
        plan_png(walk, [{"at": t} for t in teacher], [{"from": a, "to": b, "clear": 9, "unsure": 0} for a, b in zip(teacher, teacher[1:])],
                 root / f"check_{i}_{j}_teacher.png")
        plan_png(walk, pts, legs, root / f"check_{i}_{j}.png")


# ---- the pipeline nodes

PIPELINE = WS / "pipeline" / "stronghold.json"
CARD_ROI = (60, 170, 960, 70)  # the stronghold cards' titles on 据点挑战 (Foye_Card)


def card_template(root: Path, title: str, name: str) -> tuple[str, list]:
    """templates/stronghold_card_<name>.png: the card's title cut from the 据点挑战 page in the recording (found by
    OCR, 112 x 34 like the others). Returns the file name and where it was."""
    from wwm_ocr import ocr

    scr = json.load(open(root / "screens.json"))
    for r in [r for r in scr if r["screen"] == "challenge"][::5]:
        img = frame(root, r["n"])
        for text, (x, y, w, h), _ in ocr(img, CARD_ROI):
            if title in text or text in title and len(text) >= len(title) - 1:
                cx, cy = x + w / 2, y + h / 2
                x0, y0 = int(round(cx - 56)), int(round(cy - 17))
                file = f"stronghold_card_{name}.png"
                ml.imwrite(T / file, img[y0 : y0 + 34, x0 : x0 + 112])
                print("card", file, "from frame", r["n"], (x0, y0))
                return file, [x0, y0, 112, 34]
    raise ValueError(f"{title}: not found on the 据点挑战 page")


def cmd_emit(root: Path, name: str, title: str | None, rec: str | None) -> None:
    """The stronghold's nodes into pipeline/stronghold.json (replacing ones of the same names): <Name> (one click:
    stronghold {teleport}), <Name>Teleport and its <Name>_ menu → 江湖行 → 挑战 → card nodes (copies of 佛爷寨's, next
    to this card; the panel, stone, teleport and landing nodes are shared), <Name>Route (route.js follow mode:
    plan.json's points, the tracker word, locate/<name>_mosaic); the card's template."""
    rec = rec or (json.load(open(root / "rec.json")).get("rec") if (root / "rec.json").exists() else None)
    if rec:
        json.dump({"rec": rec}, open(root / "rec.json", "w"))
    meta = json.load(open(WS / "recordings" / rec / "meta.json", encoding="utf-8")) if rec else {}
    title = title or meta.get("name")
    plan_ = json.load(open(root / "plan.json", encoding="utf-8"))
    info = json.load(open(root / "locate.json"))
    tg = json.load(open(root / "targets.json", encoding="utf-8"))
    card, box = card_template(root, title, name)
    N = name[0].upper() + name[1:]
    doc = json.load(open(PIPELINE, encoding="utf-8"))
    src = f"录像 {rec}（{title}）" if rec else title
    nodes = {}
    for part in ("OpenMenu", "Jianghu", "Challenge", "Card", "LeaveMap"):
        n = json.loads(json.dumps(doc[f"Foye_{part}"], ensure_ascii=False).replace("Foye_", f"{N}_"))
        n["desc"] = n["desc"].replace("佛爷寨", title)
        if part == "Card":
            n["template"] = card
            n["desc"] = f"据点挑战页的「{title}」卡片（认卡片标题，点标题下方卡片中间；模板从{src}的据点挑战页裁的）"
        nodes[f"{N}_{part}"] = n
    tele = json.loads(json.dumps(doc["FoyeTeleport"], ensure_ascii=False).replace("Foye_", f"{N}_"))
    tele["desc"] = (f"传送到{title}的传送石碑：菜单 → 江湖行 → 挑战 → 据点挑战「{title}」卡片 → 大地图上找离据点图标最近的石碑 → 传送 → "
                    f"回到大世界；从中间哪一页开始都能接着走，开着别处的大地图就先退出来。tools/rec_route.py emit 照 FoyeTeleport 生成"
                    f"（{src}），菜单到卡片这几步是 {N}_ 开头的节点，后面的说明面板、石碑、传送、落地和别的据点共用。路线 {N}Route 从这里开始")
    nodes[f"{N}Teleport"] = tele
    k = info["k"]
    pts = plan_["points"]
    tracker = {"foes": "破戒头陀", "flowers": "毒花"} | plan_["tracker"]
    words = "、".join(f"{g['word']} {g['of']} 个" for g in tg["tasks"].values())
    route = {
        "desc": (f"{title}：从传送石碑照老师录像里的顺序走到据点宝箱，途经录像里每次任务计数涨时人在的地方（点名写着第几个、录像第几帧）。"
                 f"路点由 tools/rec_route.py 从{src}全自动生成：录像里人走到过的地方（打架被推开的也算）"
                 f"是可走区域，在上面用 A* 规划（离边缘越远越好），再简化成直线段（偏离规划 ≤ {SIMPLIFY} px、每段离未走过的地方 ≥ {MIN_CLEAR} px，原本就窄的地方不比原路窄）。"
                 f"连续定位：每帧在小地图拼图 {mosaic_ref(name)} 里找位置（院外 / 院内两档，院内分攻占前（有橙色区域）和攻占后各一张），"
                 f"中间航位推算，不开大地图。比例：院外 1 小地图像素 = {k['out']:.3f} 大地图像素（小地图上石碑和据点图标的距离对大地图上的量出来的），"
                 f"院内 {k['in']:.3f}（院外的一半）。任务：{words}；任务栏按 tracker 读。路上遇敌交给 combat，到宝箱点没有宝箱、头陀没清完就跑 "
                 f"StrongholdFight 清场再回宝箱；宝箱默认领取三份（老师同意）。技能 skills/route.js"),
        "recognition": "DirectHit",
        "action": "Custom",
        "custom_action": "route",
        "custom_action_param": {"locate": [mosaic_ref(name)], "tracker": tracker, "points": pts},
    }
    nodes[f"{N}Route"] = route
    nodes[N] = {
        "desc": (f"{title}一键跑完：从任意画面关弹窗 → {N}Teleport 传送到石碑 → {N}Route 走到宝箱（路上遇敌就打，宝箱点没清完就清场），"
                 f"开据点宝箱。卡片上写着「势力重新占据时间」（还没刷新）就在石碑停下报错，不跑路线。tools/rec_route.py emit 生成，技能 skills/stronghold.js 的 teleport 模式"),
        "recognition": "DirectHit",
        "action": "Custom",
        "custom_action": "stronghold",
        "custom_action_param": {"teleport": f"{N}Teleport"},
        "next": [f"{N}Route"],
    }
    for n_ in nodes:
        doc.pop(n_, None)
    order = [N, f"{N}Route", f"{N}Teleport"] + [f"{N}_{p}" for p in ("OpenMenu", "Jianghu", "Challenge", "Card", "LeaveMap")]
    for n_ in order:
        doc[n_] = nodes[n_]
    json.dump(doc, open(PIPELINE, "w", encoding="utf-8"), ensure_ascii=False, indent=4)
    open(PIPELINE, "a", encoding="utf-8").write("\n")
    print("wrote", ", ".join(order), "into", PIPELINE)


def mosaic_bg(root: Path, walk: Walk, scale: int) -> np.ndarray:
    """The mosaics drawn into the walk's grid (big map px; the zoomed-in ones over the zoomed-out one), for plan_png."""
    H, W = walk.walked.shape
    out = np.zeros((H * scale, W * scale, 3), np.uint8)
    f = scale / GRID  # canvas px per big map px
    for tag in ("out", "in_live", "in_taken", "in"):
        if not (root / "mosaic" / f"{tag}.json").exists():
            continue
        ref = ml.load_ref(root / "mosaic", tag)
        s = ref.k * f  # canvas px per mosaic px
        tx = (0 - ref.origin[0] * ref.k + ref.off[0] - walk.x0) * f
        ty = (0 - ref.origin[1] * ref.k + ref.off[1] - walk.y0) * f
        M = np.float32([[s, 0, tx], [0, s, ty]])
        img = cv2.warpAffine(ref.img, M, (W * scale, H * scale), flags=cv2.INTER_LINEAR)
        v = cv2.warpAffine(ref.valid.astype(np.uint8), M, (W * scale, H * scale), flags=cv2.INTER_NEAREST) > 0
        out[v] = img[v]
    return out


def cmd_view(root: Path) -> None:
    """<root>/plan_view.png: plan.json's route over the mosaics, the walked area's edge, the kills, and each leg with
    the recording frames that walked it (the unsure / tight ones in orange, to show the teacher)."""
    track = load_track(root, sure=True)
    walk = Walk(track)
    p = json.load(open(root / "plan.json", encoding="utf-8"))
    scale = 6
    bg = mosaic_bg(root, walk, scale)
    edge = cv2.resize(walk.walked.astype(np.uint8), (bg.shape[1], bg.shape[0]), interpolation=cv2.INTER_NEAREST)
    cnt, _ = cv2.findContours(edge, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    img = bg.copy()
    cv2.drawContours(img, cnt, -1, (200, 200, 0), 1)
    P = lambda q: (int(round((q[0] - walk.x0) / GRID * scale)), int(round((q[1] - walk.y0) / GRID * scale)))
    for k_ in p.get("kills", []):
        cv2.drawMarker(img, P(k_), (0, 0, 255), cv2.MARKER_TILTED_CROSS, 14, 2)
    for i, leg in enumerate(p["legs"]):
        bad = leg["unsure"] > 0.1 or leg["clear"] < 1.3
        cv2.line(img, P(leg["from"]), P(leg["to"]), (0, 140, 255) if bad else (0, 200, 0), 3)
        a, b = np.array(leg["from"]), np.array(leg["to"])
        near = [n for n, v in track.items() if polyline_dist(v[:2], [a, b]) <= 2]
        mid = P((a + b) / 2)
        if near:
            cv2.putText(img, f"{min(near)}-{max(near)}", (mid[0] + 6, mid[1] + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2)
            cv2.putText(img, f"{min(near)}-{max(near)}", (mid[0] + 6, mid[1] + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)
    for i, q in enumerate(p["points"]):
        cv2.circle(img, P(q["at"]), 5, (0, 255, 255) if q.get("do") else (255, 255, 255), -1)
        cv2.putText(img, str(i), (P(q["at"])[0] + 6, P(q["at"])[1] - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 3)
        cv2.putText(img, str(i), (P(q["at"])[0] + 6, P(q["at"])[1] - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
    cv2.drawMarker(img, P((0, 0)), (0, 255, 255), cv2.MARKER_DIAMOND, 16, 2)
    # crop to the route and what was walked around it
    ys, xs = np.nonzero(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) > 0)
    img = img[max(0, ys.min() - 10) : ys.max() + 10, max(0, xs.min() - 10) : xs.max() + 10]
    ml.imwrite(root / "plan_view.png", img)
    print("wrote", root / "plan_view.png", img.shape)


def cmd_anchors(root: Path, runs: list[Path]) -> None:
    """Add a dry run's check readings to <root>/device_anchors.json: route_seg.py ... check=true out=RUN.json saves
    each stop's place by locate() (`at`) and by where() (`where`). Only runs made with the reference exported from the
    current track.json: a reading's locate() is in that reference's terms, and its frames are worked out against the
    current track (device_fixes); after locate is run again with them, older runs no longer fit. Readings already in
    the file (same run file and point) are kept as they are."""
    f = root / "device_anchors.json"
    anchors = json.load(open(f)) if f.exists() else []
    have = {a.get("what") for a in anchors}
    for run in runs:
        r = json.load(open(run, encoding="utf-8"))
        for leg in (r.get("value") or {}).get("legs", []):
            if "where" not in leg or not leg.get("at"):
                continue
            what = f"{run.name} point {leg['j']}"
            if what in have:
                continue
            anchors.append({"locate": leg["at"], "where": leg["where"], "what": what})
            have.add(what)
            print(what, "locate", leg["at"], "where()", leg["where"], f"{leg.get('off')} px apart")
    json.dump(anchors, open(f, "w"), indent=1)
    print(len(device_fixes(root)), "frames held by", len(anchors), "device readings")


# ---- surveys: frames grabbed on the device where the recording left the reference weak

SURVEY = "survey"  # <root>/survey<N>/: rec/ (grab_frames: <seq>.jpg, frames.jsonl), route.json, survey.json, and
# what cache / icons / register / locate write, as for the recording
CHECK_OFF = 3.0  # px: a dry run's where() farther than this from the point (or from where locate put it) is a miss
SURVEY_REACH = 3.0  # px: the stepping walk's reach at each point
SURVEY_STEP = 4.0  # px: points put in between for the stepping walk (densify)


def surveys_of(root: Path) -> list[Path]:
    return sorted((d for d in root.glob(f"{SURVEY}*") if (d / "track.json").exists()), key=lambda d: int(d.name[len(SURVEY):] or 0))


def survey_conf(root: Path) -> dict:
    f = root / "survey.json"
    return json.load(open(f)) if f.exists() else {}


def survey_anchors(sd: Path) -> list[dict]:
    """<sd>/anchors.json from the stepping walk's anchors (route.js `anchors`: a screenshot just before each look at
    the big map, its frame number and where() there): the look is the run of map frames after it (screens.json)."""
    route = json.load(open(sd / "route.json", encoding="utf-8"))
    scr = json.load(open(sd / "screens.json"))
    seqs = [r["n"] for r in scr]
    labels = [r["screen"] for r in scr]
    got = (route.get("value") or {}).get("anchors") or [json.loads(l[len("anchor "):]) for l in route.get("logs", []) if l.startswith("anchor {")]
    out = []
    for a in got:
        j = next((i for i, n in enumerate(seqs) if n > a["seq"] and labels[i] == "map"), None)
        if j is None:
            continue
        k = j
        while k + 1 < len(seqs) and labels[k + 1] != "world":
            k += 1
        out.append({"n": a["n"], "first": seqs[j], "last": seqs[k], "x": a["x"], "y": a["y"]})
    json.dump(out, open(sd / "anchors.json", "w"), indent=1)
    return out


class Grabber:
    """scripts/grab_frames.py in a thread: the app's live frames to <out>/<seq>.jpg and frames.jsonl until stop()."""

    def __init__(self, out: Path):
        import threading
        from maalow.client import Client

        self.out, self.c, self.n = out, Client(), 0
        out.mkdir(parents=True, exist_ok=True)
        self._stop = threading.Event()
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()

    def _run(self):
        import time

        last = None
        with open(self.out / "frames.jsonl", "a", encoding="utf-8") as log:
            while not self._stop.is_set():
                try:
                    with self.c._open("GET", "/screen", timeout=10) as r:
                        data, seq = r.read(), int(r.headers["X-Frame"])
                except OSError:
                    time.sleep(0.5)
                    continue
                if seq != last:
                    (self.out / f"{seq}.jpg").write_bytes(data)
                    log.write(json.dumps({"seq": seq, "t": round(time.time() * 1000)}) + "\n")
                    log.flush()
                    last, self.n = seq, self.n + 1

    def stop(self) -> int:
        self._stop.set()
        self.t.join(15)
        return self.n


def route_node(name: str) -> dict:
    N = name[0].upper() + name[1:]
    return dict(json.load(open(PIPELINE, encoding="utf-8"))[f"{N}Route"]["custom_action_param"])


def run_skill(name: str, args: dict, ms: int = 1_800_000) -> dict:
    from maalow.client import Client

    return Client().post("/skill/run", {"name": name, "args": args, "timeout": ms}, timeout=ms / 1000 + 100)


def cmd_dryrun(root: Path, name: str, start: int = 1) -> dict:
    """The route in follow mode with check: true from point `start` to the end (the stronghold taken: no chest is
    fine). Returns {ok, reached: the last point reached and checked within CHECK_OFF, missed: [points checked farther
    off], error}; <root>/dryrun<N>.json is the whole result (for `anchors`)."""
    args = route_node(name)
    P = args["points"]
    args |= {"from": start, "to": len(P) - 1, "check": True}
    r = run_skill("route", args)
    n = len(list(root.glob("dryrun*.json"))) + 1
    json.dump(r, open(root / f"dryrun{n}.json", "w", encoding="utf-8"), ensure_ascii=False)
    reached, missed = start - 1, []
    for line in r.get("logs", []):
        m = re.match(r"point (\d+) ", line)
        if not m or "reached at" not in line:
            continue
        j = int(m[1])
        off = re.search(r"where\(\) [-\d.]+,[-\d.]+, ([\d.]+) px off", line)
        if off and float(off[1]) > CHECK_OFF:
            missed.append(j)
        elif not missed:
            reached = j
    err = (r.get("error") or {}).get("message") if not r.get("ok") else None
    out = {"ok": bool(r.get("ok")) and not missed, "reached": reached, "missed": missed, "error": err, "file": f"dryrun{n}.json"}
    print(json.dumps(out, ensure_ascii=False))
    return out


def densify(P: list[dict], a: int, b: int, step: float = SURVEY_STEP) -> tuple[list[dict], int, int]:
    """Points a-1..b with points put in between every `step` px, for walking the old way: it runs straight from
    wherever it is to the next point, so on a long leg it can drift off the planned line into a wall (酒肉山林: 4.5 px
    off a 29 px leg, then stuck at a gate's wall). Returns the points and the new indexes of a and b."""
    out = [P[a - 1]]
    for i in range(a, b + 1):
        A, B = np.array(out[-1]["at"], float), np.array(P[i]["at"], float)
        n = int(np.hypot(*(B - A)) // step)
        for t in range(1, n + 1):
            q = A + (B - A) * t / (n + 1)
            out.append({"at": [round(float(q[0]), 1), round(float(q[1]), 1)]})
        out.append(P[i])
    return out, 1, len(out) - 1


def cmd_survey(root: Path, name: str, a: int, b: int, at: tuple[float, float] | None = None) -> Path:
    """Walk points a..b of the route the old way (open the big map, where(), run toward the next point, again: no
    reference needed), grabbing frames all along; each look is an anchor. Then the frames are placed (cache, icons,
    anchors, register, locate with the recording's k) into <root>/survey<N>/track.json, which `mosaic` adds to the
    stronghold-taken level. The points' actions are left out (only walking); points are put in every SURVEY_STEP px
    (densify). `at`: where the character is (where()), to go on from the nearest of those points (after a survey
    that stopped half way)."""
    args = route_node(name)
    P0 = [{kk: v for kk, v in p.items() if kk != "do"} for p in args["points"]]
    P, a, b = densify(P0, a, b)
    if at is not None:
        a = 1 + min(range(a - 1, b + 1), key=lambda i: math.hypot(P[i]["at"][0] - at[0], P[i]["at"][1] - at[1]))
        a = min(a, b)
    n = 1 + max([int(d.name[len(SURVEY):]) for d in root.glob(f"{SURVEY}*") if d.is_dir() and d.name[len(SURVEY):].isdigit()], default=0)
    sd = root / f"{SURVEY}{n}"
    g = Grabber(sd / REC)
    try:
        r = run_skill("route", {"points": P, "from": a, "to": b, "reach": SURVEY_REACH, "anchors": f"teaching/survey/{name}_{n}"})
    finally:
        frames = g.stop()
    json.dump(r, open(sd / "route.json", "w", encoding="utf-8"), ensure_ascii=False)
    print(f"survey {sd.name}: points {a}-{b}, {frames} frames, ok {r.get('ok')}", (r.get("error") or {}).get("message", ""))
    survey_build(root, sd)
    return sd


def survey_build(root: Path, sd: Path) -> None:
    """Place a survey's frames: cache, icons, anchors from its looks, register, locate (k and the starting zoom from the
    recording's track)."""
    k = json.load(open(root / "locate.json"))["k"]
    cmd_cache(sd)
    cmd_icons(sd)
    an = survey_anchors(sd)
    if not an:
        print(sd.name, "no anchors: not placed")
        return
    main = load_track(root)
    keys = np.array(sorted(main))
    P = np.array([main[q][:2] for q in keys])
    zoom0 = main[int(keys[int(np.argmin(np.hypot(*(P - [an[0]["x"], an[0]["y"]]).T)))])][2]
    json.dump({"zoom0": zoom0, "k": k}, open(sd / "survey.json", "w"))
    cmd_register(sd)
    cmd_locate(sd, k["out"], k["in"])


def cmd_auto(root: Path, name: str, rounds: int = 4, survey_ahead: int = 0) -> None:
    """Dry run, and where it went wrong, survey and rebuild, until the whole route passes (or `rounds`): each round
    teleports to the stone, runs the route with check from where the last round got to (from the start once it was
    rebuilt), surveys from the last good point to the end, rebuilds the reference and the route (mosaic, plan, emit),
    pushes. Tell the teacher first: the survey opens the big map at every few px."""
    import subprocess

    N = name[0].upper() + name[1:]
    for rnd in range(1, rounds + 1):
        print(f"== round {rnd}: teleport, dry run")
        from maalow.client import Client

        Client().post("/run", {"node": f"{N}Teleport", "once": True}, timeout=400)
        d = cmd_dryrun(root, name)
        if d["ok"]:
            print("the whole route passed")
            return
        if d["error"] and "stopped by teacher" in d["error"]:
            print("stopped by the teacher")
            return
        last = len(route_node(name)["points"]) - 1
        a = max(1, d["reached"] + 1)
        b = last if not survey_ahead else min(last, a + survey_ahead)
        print(f"== round {rnd}: survey points {a}-{b}")
        cmd_survey(root, name, a, b)
        cmd_mosaic(root, name, None)
        cmd_plan(root)
        cmd_view(root)
        cmd_emit(root, name, None, None)
        subprocess.run(["uv", "run", "maalow", "sync", "WhereWindsMeet", "--push", "--exclude", "recordings/**"], check=False)
    print("rounds used up")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd")
    ap.add_argument("root", type=Path)
    ap.add_argument("--rec", help="frames: the recording id (workspaces/WhereWindsMeet/recordings/<id>/video.mp4)")
    ap.add_argument("--video", type=Path)
    ap.add_argument("--start", type=int, default=1, help="dryrun: the first point")
    ap.add_argument("--points", help="survey: the route points to walk, e.g. 10-31")
    ap.add_argument("--at", help="survey: where the character is (x,y from where()), to go on from the nearest point")
    ap.add_argument("--rounds", type=int, default=4, help="auto: dry run / survey rounds at most")
    ap.add_argument("--run", help="anchors: route_seg.py out= files of dry runs with check=true, comma separated")
    ap.add_argument("--title", help="emit: the stronghold's name on its card (default: the recording's name)")
    ap.add_argument("--tracks", help="check: track.json files of another stronghold's survey, comma separated")
    ap.add_argument("--node", help="check: its route node (e.g. FoyeRoute)")
    ap.add_argument("--pairs", default="0-2,7-9", help="check: point pairs i-j to plan between")
    ap.add_argument("--name", help="mosaic / emit: the stronghold's name in templates and nodes (e.g. jiurou)")
    ap.add_argument("--k-out", type=float, help="locate: big map px per minimap px zoomed out (default: measured)")
    ap.add_argument("--k-in", type=float, help="locate: the same zoomed in (default: k out / ZOOM_RATIO)")
    a = ap.parse_args()
    if a.cmd == "frames":
        cmd_frames(a.root, a.rec, a.video)
    elif a.cmd == "all":
        if not (a.root / REC / "frames.jsonl").exists():
            cmd_frames(a.root, a.rec, a.video)
        for f in (cmd_cache, cmd_ocr, cmd_icons, cmd_bigmap, cmd_register):
            print("==", f.__name__)
            f(a.root)
        print("== cmd_locate")
        cmd_locate(a.root, a.k_out, a.k_in)
        print("== cmd_eval")
        cmd_eval(a.root)
        print("== cmd_mosaic")
        cmd_mosaic(a.root, a.name, a.rec)
        print("== cmd_plan")
        cmd_plan(a.root)
        cmd_view(a.root)
    elif a.cmd == "cache":
        cmd_cache(a.root)
    elif a.cmd == "bigmap":
        cmd_bigmap(a.root)
    elif a.cmd == "ocr":
        cmd_ocr(a.root)
    elif a.cmd == "register":
        cmd_register(a.root)
    elif a.cmd == "locate":
        cmd_locate(a.root, a.k_out, a.k_in)
    elif a.cmd == "mosaic":
        cmd_mosaic(a.root, a.name, a.rec)
    elif a.cmd == "eval":
        cmd_eval(a.root)
    elif a.cmd == "plan":
        cmd_plan(a.root)
    elif a.cmd == "check":
        cmd_check(a.root, [Path(t) for t in a.tracks.split(",")], a.node, [tuple(int(v) for v in p.split("-")) for p in a.pairs.split(",")])
    elif a.cmd == "emit":
        cmd_emit(a.root, a.name, a.title, a.rec)
    elif a.cmd == "view":
        cmd_view(a.root)
    elif a.cmd == "dryrun":
        cmd_dryrun(a.root, a.name, a.start)
    elif a.cmd == "survey":
        a_, b_ = (int(v) for v in a.points.split("-"))
        cmd_survey(a.root, a.name, a_, b_, tuple(float(v) for v in a.at.split(",")) if a.at else None)
    elif a.cmd == "survey-build":
        for d in sorted(a.root.glob(f"{SURVEY}*")):
            if d.is_dir() and (d / "route.json").exists():
                survey_build(a.root, d)
    elif a.cmd == "auto":
        cmd_auto(a.root, a.name, a.rounds)
    elif a.cmd == "anchors":
        cmd_anchors(a.root, [Path(r) for r in a.run.split(",")])
    elif a.cmd == "icons":
        cmd_icons(a.root)


if __name__ == "__main__":
    main()
