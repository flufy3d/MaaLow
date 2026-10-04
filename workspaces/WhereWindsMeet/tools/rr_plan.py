"""rec_route.py, the planning side (规划): what the teacher did (stops, task counts), the walkable map and the way
through it (A*, simplified legs), the pictures for the teacher, the check on another stronghold, and the
stronghold's config (emit). Uses rr_map."""

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

from rr_map import *  # noqa: F401,F403,E402
from rr_map import _tpl  # noqa: F401,E402


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
    # the same action shown twice in a row a step apart is one: the row came up, the teacher stepped off it and came
    # back (龙虎寨's chest: 5950–5971 and 6042–6108, 2 px apart, opened at 6102); the later run is where it was done
    merged: list[dict] = []
    for st in stops:
        if merged and merged[-1]["do"] == st["do"] and math.dist(merged[-1]["at"], st["at"]) <= SAME_STOP:
            merged[-1] = st
        else:
            merged.append(st)
    stops = merged
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
    # the last kill: the stronghold's block leaves the tracker as the count reaches the total, so the last count is
    # often never read (龙虎寨: 6/7 at 5112, the next quest's line at 5118); it is where the block went
    for g in tasks.values():
        if done_at is not None and g["counts"] and g["counts"][-1][1] == g["of"] - 1 and g["counts"][-1][0] < done_at:
            n = near(done_at)
            g["counts"].append([done_at, g["of"]] + ([round(pos[n][0], 1), round(pos[n][1], 1)] if n is not None and abs(n - done_at) <= 60 else []))
    return {"stops": stops, "tasks": tasks, "done_at": done_at, "taken_at": taken_at(root)}


# ---- the walkable map and the way through it

GRID = 0.5  # big map px per cell
BODY = 1.5  # big map px around each place the character stood that counts as walkable
EDGE_W = 2.0  # A*: a step's cost is its length times 1 + EDGE_W / (clearance + 0.5): the middle of the way is cheaper
SIMPLIFY = 1.5  # big map px: a leg may leave the planned way by this much
MIN_CLEAR = 1.0  # big map px: every point of a leg this far inside what was walked
NARROW = 2.0  # big map px: the way this close to the edge of what was walked is narrow (a door): legs keep to its
CENTER_SLACK = 0.3  # middle there, this far off it at most
SAME_STOP = 3.0  # big map px: the same action again this close to the one before is that one (find_targets)
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
    narrow bit that was walked: its own clearance is all there is); where the way is narrow (under NARROW from the
    edge), within CENTER_SLACK of its middle. Indexes of the corners kept."""
    own = [walk.clearance(p) for p in path]

    def need(narrowest: float) -> float:
        # a narrow bit (a door walked through once): the leg keeps to its middle, within CENTER_SLACK of the way
        # planned there (A* keeps to the middle of what was walked); the teacher went through the middle of 酒肉山林's
        # small doors, legs a few tenths off it plus a little drift ran into the door's frame (2026-10-02)
        if narrowest <= MIN_CLEAR:
            return narrowest
        return max(MIN_CLEAR, narrowest - CENTER_SLACK) if narrowest < NARROW else MIN_CLEAR

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
        if far <= SIMPLIFY and walk.leg_ok(path[i], path[j], need(min(own[i : j + 1])))[0]:
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


# ---- the teacher's own way (the default plan): the recorded track, its circling cut out, points along it

WAY_SMOOTH = 5  # frames: the track's positions are a median over this many (jitter of a frame or two)
LOOP_R = 1.0  # px: back this close to a place it was at before (not in the last LOOP_WINDOW frames),
LOOP_WINDOW = 15
LOOP_EXTENT = 8.0  # px: with all of the way since within this of that place: circling in a fight, standing about: cut out
WAY_TOL = 0.5  # px: the route points keep to the teacher's way within this (thick where it turns, thin where straight)


def teacher_way(seq: list[tuple[int, float, float]], keep: list[int] = ()) -> list[tuple[int, float, float]]:
    """The way the teacher went, (frame, x, y) in order: smoothed (WAY_SMOOTH), then each loop cut out where it comes
    back to a place it was at (LOOP_R) with the loop all within LOOP_EXTENT of it, so a fight's circling or standing
    about is a point on the line; a way out and back (to the bonfire field and back) is far bigger and is kept. No
    loop is cut across a frame of `keep` (where an enemy fell): a side way into a corner where one stands (酒肉山林's 3rd
    破戒头陀, in front of a house: it does not come out unless one goes there, teacher 2026-10-02) is walked in and out."""
    if not seq:
        return []
    a = np.array([[x, y] for _, x, y in seq], float)
    h = WAY_SMOOTH // 2
    sm = np.array([np.median(a[max(0, i - h): i + h + 1], axis=0) for i in range(len(a))])
    out: list[tuple[int, float, float]] = []
    xy: list[np.ndarray] = []
    grid: dict[tuple[int, int], list[int]] = {}
    marks = sorted(keep)
    floor = 0  # loops start at or after this (the last `keep` frame's point)
    for (n, _, _), q in zip(seq, sm):
        if marks and n >= marks[0]:
            while marks and n >= marks[0]:
                marks.pop(0)
            out.append((n, float(q[0]), float(q[1])))
            xy.append(q)
            floor = len(out) - 1
            continue
        c = (int(q[0] // LOOP_R), int(q[1] // LOOP_R))
        cand = sorted({i for dx in (-1, 0, 1) for dy in (-1, 0, 1) for i in grid.get((c[0] + dx, c[1] + dy), ())
                       if floor <= i < len(out) - LOOP_WINDOW and np.hypot(*(xy[i] - q)) <= LOOP_R})
        cut = None
        for i in cand:
            if float(np.max(np.hypot(*(np.array(xy[i:]) - xy[i]).T))) <= LOOP_EXTENT:
                cut = i
                break
        if cut is not None:
            del out[cut + 1:], xy[cut + 1:]  # grid entries past the end are checked against xy anyway
            continue
        out.append((n, float(q[0]), float(q[1])))
        xy.append(q)
        grid.setdefault(c, []).append(len(out) - 1)
    return out


def rdp(line: list[tuple[float, float]], tol: float) -> list[int]:
    """Douglas-Peucker: indexes of the points kept (the ends always)."""
    if len(line) <= 2:
        return list(range(len(line)))
    p, q = np.array(line[0]), np.array(line[-1])
    d = q - p
    L = np.hypot(*d)
    v = np.array(line[1:-1]) - p
    e = np.abs(d[0] * v[:, 1] - d[1] * v[:, 0]) / L if L > 1e-9 else np.hypot(v[:, 0], v[:, 1])
    k = int(np.argmax(e)) + 1
    if e[k - 1] <= tol:
        return [0, len(line) - 1]
    left = rdp(line[: k + 1], tol)
    return left[:-1] + [k + i for i in rdp(line[k:], tol)]


def leg_info(walk: Walk, p, q) -> dict:
    """A leg's length, least clearance and share on cells only the shifts held (unsure), as plan() gives them."""
    _, cl = walk.leg_ok(p, q)
    n = max(2, int(math.hypot(q[0] - p[0], q[1] - p[1]) / (GRID / 2)))
    cells = [walk.cell((p[0] + (q[0] - p[0]) * t / n, p[1] + (q[1] - p[1]) * t / n)) for t in range(n + 1)]
    H, W = walk.walked.shape
    ok = [c for c in cells if 0 <= c[1] < H and 0 <= c[0] < W]
    unsure = float(np.mean([not walk.sure[c[1], c[0]] for c in ok])) if ok else 0.0
    return {"from": [round(p[0], 1), round(p[1], 1)], "to": [round(q[0], 1), round(q[1], 1)],
            "length": round(math.hypot(q[0] - p[0], q[1] - p[1]), 1), "clear": round(cl, 2), "unsure": round(unsure, 2)}


def plan_way(walk: Walk, pos: dict, start: dict, acts: list[dict], kills: list[dict] = ()) -> tuple[list[dict], list[dict]]:
    """Route points along the teacher's own way (teacher_way) from the landing to the last action (the chest), the
    actions (chest, flowers, elite: {at, name, cam, do, n}) put in where they happened, and where an enemy fell ({name,
    n}: the way's point at that frame, kept on the way), points between them where the way turns (WAY_TOL). Same
    output as plan()."""
    end = max(a["n"] for a in acts) if acts else max(pos)
    seq = [(n, v[0], v[1]) for n, v in sorted(pos.items()) if start["n"] <= n <= end]
    kills = [k_ for k_ in kills if start["n"] < k_["n"] < end]
    way = teacher_way(seq, [k_["n"] for k_ in kills])
    for k_ in kills:  # the way's point at the frame the enemy fell
        w = next((w for w in way if w[0] >= k_["n"]), way[-1])
        k_["at"] = [round(w[1], 1), round(w[2], 1)]
    pts: list[dict] = [{k: v for k, v in start.items() if k != "n"}]
    i0 = 0
    for a in sorted(list(acts) + kills, key=lambda a: a["n"]):
        i1 = next((i for i, w in enumerate(way) if w[0] >= a["n"]), len(way) - 1)
        line = [tuple(pts[-1]["at"])] + [(x, y) for _, x, y in way[i0 + 1: i1]] + [tuple(a["at"])]
        keep = rdp(line, WAY_TOL)
        for m in keep[1:-1]:
            pts.append({"at": [round(line[m][0], 1), round(line[m][1], 1)]})
        pts.append({k: v for k, v in a.items() if k in ("at", "name", "cam", "do") and v is not None})
        i0 = i1
    legs = [leg_info(walk, p["at"], q["at"]) for p, q in zip(pts, pts[1:])]
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


def cmd_plan(root: Path, stops_mode: bool = False) -> None:
    """<root>/targets.json (find_targets), <root>/plan.json (the route points from the teleport landing to the chest,
    the tracker words, the legs) and <root>/plan.png. The points follow the teacher's own way (plan_way: the recorded
    track, its circling cut out, points where it turns; the actions put in where they happened): it goes where the
    teacher went, through the middle of the doors as the teacher did (teacher, 2026-10-02: the kill places as stops and
    A* between them went past a small door's edge). stops_mode: the old plan, the actions and where each task count
    went up (VIA_NEAR apart) as stops, A* in what was walked between them."""
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
    walk = Walk(track)
    if stops_mode:
        for s_ in stops:
            s_.pop("n", None)
        pts, legs = plan(walk, stops)
    else:
        fell = [{"name": f"{w} {done}（录像第 {n} 帧）", "n": n} for n, done, _at, w in kills]
        pts, legs = plan_way(walk, pos, start | {"n": first}, acts, fell)
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
    """A stronghold's route points (its config; `node` as typed: Foye, FoyeRoute, foye)."""
    return sh.load(node)["points"]


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


# ---- the stronghold's config

CARD_ROI = (60, 170, 960, 70)  # the stronghold cards' titles on 据点挑战 (Teleport_Card)


def card_template(root: Path, title: str, name: str) -> tuple[str, list]:
    """templates/stronghold_card_<name>.png: the card's title cut from the 据点挑战 page in the recording (found by
    OCR, 112 x 34 like the others). Returns the file name and where it was."""
    from wwm_ocr import ocr

    scr = json.load(open(root / "screens.json"))
    pages = [r for r in scr if r["screen"] == "challenge"]
    if not pages:  # the page is told by 慈心山院's card coming first; it may open scrolled (龙虎寨's recording: 酒肉山林
        # first), then it is what came between the 江湖行 page and the card's map
        j = next((i for i, r in enumerate(scr) if r["screen"] == "jianghu"), None)
        m = next((i for i, r in enumerate(scr) if r["screen"] in ("card_map", "map") and j is not None and i > j), None)
        pages = [r for r in scr[j:m] if r["screen"] == "other"] if j is not None and m is not None else []
    for r in pages[::5]:
        img = frame(root, r["n"])
        for text, (x, y, w, h), _ in ocr(img, CARD_ROI):
            if title in text or text in title and len(text) >= len(title) - 1:
                cx, cy = x + w / 2, y + h / 2
                x0, y0 = int(round(cx - 56)), int(round(cy - 17))
                file = f"stronghold_card_{name.lower()}.png"
                ml.imwrite(T / file, img[y0 : y0 + 34, x0 : x0 + 112])
                print("card", file, "from frame", r["n"], (x0, y0))
                return file, [x0, y0, 112, 34]
    raise ValueError(f"{title}: not found on the 据点挑战 page")


SWITCH_CLEAR = 3.0  # big map px: a dry run's look before / after the zoom switch is at least this far out of it


def checks_of(root: Path, pts: list[dict], legs: list[dict]) -> list[int]:
    """The points a dry run looks at the big map at: both ends of the minimap's zoom switch, the ends of uncertain legs
    (part of them bridged over frames left out), and the last point. Not the rest: every look costs ~9 s, and a leg
    that loses its way says so itself (lost, astray, stuck).
    The switch's ends: the last zoomed-out frame of the recording before it and the first zoomed-in one after (the
    animation between has no place); the look before is the point before it at least SWITCH_CLEAR from the first, the
    one after the point after it at least that far from the second. A look right where it zooms does not settle: on
    酒肉山林's daytime dry run (2026-10-03) point 13 sat on the last zoomed-out place, the character shuffled 1–2 px
    around it with the minimap switching zoom, was taken for stuck 5 times and jumped (the unstick moves)."""
    out = {len(pts) - 1}
    pos = load_track(root)

    def seg(i, q):  # how far the leg from point i to i + 1 passes from q
        a_, b_ = np.array(pts[i]["at"], float), np.array(pts[i + 1]["at"], float)
        t = np.clip(np.dot(q - a_, b_ - a_) / max(np.dot(b_ - a_, b_ - a_), 1e-9), 0, 1)
        return float(np.hypot(*(a_ + t * (b_ - a_) - q)))

    far = lambda i, q: float(np.hypot(*(np.array(pts[i]["at"], float) - q))) >= SWITCH_CLEAR
    # every switch (龙虎寨: in at the gate, out past the last kill, back in), in the order walked: each one's legs are
    # looked for from the one before on (the way out and back passes the same place twice)
    ends, start = [], 0
    for n_far, _, _, _ in zoom_changes(pos):
        n_near = max(n for n in pos if n < n_far)  # the last frame before it (zoom_changes: the zoom it left)
        qa, qb = np.array(pos[n_near][:2]), np.array(pos[n_far][:2])
        i = min(range(start, len(pts) - 1), key=lambda j: seg(j, qa))
        j = min(range(i, len(pts) - 1), key=lambda m: seg(m, qb)) + 1
        ends.append((qa, qb))
        start = i
        while i > 1 and not far(i, qa):
            i -= 1
        while j < len(pts) - 1 and not far(j, qb):
            j += 1
        out |= {max(1, i), j}
    for i, lg in enumerate(legs, start=1):
        # a leg bridged over a switch itself is looked at from both sides of it (above), not at its ends
        across = any(min(seg(i - 1, qa), seg(i - 1, qb)) < SWITCH_CLEAR for qa, qb in ends)
        if lg.get("unsure", 0) > 0 and not across:
            out.add(i)
    return sorted(out)


def hand_points(root: Path, pts: list[dict], legs: list[dict]) -> tuple[list[dict], list[dict]]:
    """<root>/points_hand.json, optional: points put in by hand after walking the place on the device, each
    {after: [x, y], at: [x, y], name?, door?}: put in right after the route point nearest `after` (its leg split in two,
    both halves with the old leg's flags); with no `after`, the fields go onto the route point at `at` (within 0.5 px;
    e.g. door: true, see move.js DOOR_SLIDES). 怜花禅院 (2026-10-04): the gate's point marked a door, and one past it on
    the line through the doorway, so the turn after it does not start inside (the steering looks 3 px ahead)."""
    f = root / "points_hand.json"
    if not f.exists():
        return pts, legs
    pts, legs = list(pts), list(legs)
    for h in json.load(open(f, encoding="utf-8")):
        if "after" not in h:
            i = min(range(len(pts)), key=lambda j: math.hypot(pts[j]["at"][0] - h["at"][0], pts[j]["at"][1] - h["at"][1]))
            if math.hypot(pts[i]["at"][0] - h["at"][0], pts[i]["at"][1] - h["at"][1]) > 0.5:
                raise SystemExit(f"points_hand.json: no route point at {h['at']}")
            pts[i] = pts[i] | h
            continue
        i = min(range(len(pts)), key=lambda j: math.hypot(pts[j]["at"][0] - h["after"][0], pts[j]["at"][1] - h["after"][1]))
        pts.insert(i + 1, {k_: v for k_, v in h.items() if k_ != "after"})
        if i < len(legs):
            lg = legs[i]
            halves = [lg | {"to": h["at"]}, lg | {"from": h["at"]}]
            for hv in halves:
                if "from" in hv and "to" in hv:
                    hv["length"] = round(math.hypot(hv["to"][0] - hv["from"][0], hv["to"][1] - hv["from"][1]), 1)
            legs[i:i + 1] = halves
    return pts, legs


def cmd_emit(root: Path, name: str, title: str | None, rec: str | None) -> None:
    """The stronghold's config into pipeline/stronghold_<id>.json (tools/strongholds.py; its one-click node <Name>):
    title, the card's template (cut from the recording), the stone's step from the icon, k, the tracker words, the
    reference (locate/<id>_mosaic), the dry run's checks and plan.json's points. A label already in the config (the
    name above the icon on the big map: the teacher's, the recording cannot tell) is kept."""
    rec = rec or (json.load(open(root / "rec.json")).get("rec") if (root / "rec.json").exists() else None)
    if rec:
        json.dump({"rec": rec}, open(root / "rec.json", "w"))
    meta = json.load(open(WS / "recordings" / rec / "meta.json", encoding="utf-8")) if rec else {}
    title = title or meta.get("name")
    plan_ = json.load(open(root / "plan.json", encoding="utf-8"))
    info = json.load(open(root / "locate.json"))
    tg = json.load(open(root / "targets.json", encoding="utf-8"))
    card, _ = card_template(root, title, name)
    old = sh.load(name) if sh.path(name).exists() else {}
    k = info["k"]
    pts, legs = hand_points(root, plan_["points"], plan_["legs"])
    src = f"录像 {rec}（{title}）" if rec else title
    words = "、".join(f"{g['word']} {g['of']} 个" for g in tg["tasks"].values())
    stone = (info.get("stone_k") or {}).get("big") or stone_step(root)
    cfg = {"id": sh.sid(name), "title": title, "card": card, "stone": stone, "label": old.get("label"),
           "k": {z_: round(v, 4) for z_, v in k.items()},
           "zoom": old.get("zoom") or {"after_map": "kept", "note": "按录像判的：进院门切到院内档"},
           "tracker": {"foes": "破戒头陀", "flowers": "毒花"} | plan_["tracker"], "locate": [mosaic_ref(name)],
           "checks": checks_of(root, pts, legs), **({"recording": rec} if rec else {}), "points": pts}
    desc = (f"{title}一键跑完：从任意画面关弹窗 → 通用传送 StrongholdTeleport（填这个据点的卡片）到石碑 → 照老师录像里的顺序走到据点宝箱"
            f"（路上遇敌就打，宝箱点没清完就 StrongholdFight 清场），开据点宝箱（默认领取三份，老师同意）。卡片上写着「势力重新占据时间」"
            f"（还没刷新）就在石碑停下报错，不跑路线。参数就是这个据点的配置，tools/rec_route.py emit 从{src}全自动生成：路点途经录像里每次"
            f"任务计数涨时人在的地方（点名写着第几个、录像第几帧），在录像里人走到过的地方用 A* 规划，再简化成直线段（偏离规划 ≤ {SIMPLIFY} px、"
            f"每段离未走过的地方 ≥ {MIN_CLEAR} px）；连续定位用小地图拼图 {mosaic_ref(name)}；比例院外 1 小地图像素 = {k['out']:.3f} 大地图像素、"
            f"院内 {k['in']:.3f}；任务：{words}。技能 skills/stronghold.js、skills/route.js")
    print("wrote", sh.save(cfg, desc), f"({len(pts)} points, checks {cfg['checks']}, stone {stone})")


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
