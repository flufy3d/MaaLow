"""rec_route.py, the device side (设备流程): dry runs (checks, the systematic offset of where()), device anchors,
surveys (the stepping walk, frames grabbed), building them, and auto. Uses rr_map and rr_plan."""

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
from rr_plan import *  # noqa: F401,F403,E402


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

CHECK_OFF = 3.0  # px: a dry run's where() farther than this from the point (or from where locate put it) is a miss
SURVEY_REACH = 3.0  # px: the stepping walk's reach at each point
SURVEY_STEP = 4.0  # px: points put in between for the stepping walk (densify)


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


run_skill = sh.run_skill


def cmd_dryrun(root: Path, name: str, start: int = 1, every: bool = False) -> dict:
    """The route in follow mode from point `start` to the end, the points' actions left out, stopping to read where()
    only at the config's checks (zoom switch, uncertain or narrow legs, the end; `every`: at every point). Returns {ok,
    reached: the last point checked within CHECK_OFF, missed: [points checked farther off], error, file, offset: the
    readings' systematic offset (systematic())}; <root>/dryrun<N>.json is the whole result (for `anchors`)."""
    cfg = sh.load(name)
    P = cfg["points"]
    r = run_skill("route", {"stronghold": cfg, "from": start, "to": len(P) - 1, "nodo": True,
                            "check": True if every else cfg.get("checks") or True})
    n = len(list(root.glob("dryrun*.json"))) + 1
    f = root / f"dryrun{n}.json"
    json.dump(r, open(f, "w", encoding="utf-8"), ensure_ascii=False)
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
    out = {"ok": bool(r.get("ok")) and not missed, "reached": reached, "missed": missed, "error": err, "file": f.name,
           "offset": systematic(f)}
    print(json.dumps(out, ensure_ascii=False))
    return out


SYS_MIN = 1.0  # px: a mean offset of where() from locate() this large, over SYS_N readings or more,
SYS_N = 3
SYS_SPREAD = 0.8  # with the readings this close around it (per axis, MAD), is the reference's coordinates off


def systematic(run: Path) -> list[float] | None:
    """The mean offset where() − locate() of a dry run's checks when it is systematic (SYS_MIN, SYS_N, SYS_SPREAD:
    酒肉山林's first dry run was ~2 px off all along), else None. Then `anchors` with this run puts it right."""
    r = json.load(open(run, encoding="utf-8"))
    d = np.array([[lg["where"][0] - lg["at"][0], lg["where"][1] - lg["at"][1]]
                  for lg in (r.get("value") or {}).get("legs", []) if lg.get("where") and lg.get("at")])
    if len(d) < SYS_N:
        return None
    m = np.median(d, axis=0)
    spread = np.median(np.abs(d - m), axis=0)
    return [round(float(v), 2) for v in m] if np.hypot(*m) >= SYS_MIN and (spread <= SYS_SPREAD).all() else None


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
    cfg = sh.load(name)
    P0 = [{kk: v for kk, v in p.items() if kk != "do"} for p in cfg["points"]]
    P, a, b = densify(P0, a, b)
    if at is not None:
        a = 1 + min(range(a - 1, b + 1), key=lambda i: math.hypot(P[i]["at"][0] - at[0], P[i]["at"][1] - at[1]))
        a = min(a, b)
    n = 1 + max([int(d.name[len(SURVEY):]) for d in root.glob(f"{SURVEY}*") if d.is_dir() and d.name[len(SURVEY):].isdigit()], default=0)
    sd = root / f"{SURVEY}{n}"
    g = Grabber(sd / REC)
    try:
        # locate: None: the big map way (route.js without a reference); the config for where()'s label and stone
        r = run_skill("route", {"stronghold": cfg, "locate": None, "points": P, "from": a, "to": b, "reach": SURVEY_REACH,
                                "anchors": f"teaching/survey/{name}_{n}"})
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


def rebuild(root: Path, name: str, relocate: bool = False) -> None:
    """After a survey or device anchors: (locate,) mosaic, plan, view, emit, push."""
    import subprocess

    if relocate:
        cmd_locate(root)
    cmd_mosaic(root, name, None)
    cmd_plan(root)
    cmd_view(root)
    cmd_emit(root, name, None, None)
    subprocess.run(["uv", "run", "maalow", "sync", "WhereWindsMeet", "--push", "--exclude", "recordings/**"], check=False)


def cmd_auto(root: Path, name: str, rounds: int = 4, survey_ahead: int = 0) -> None:
    """Dry run, and where it went wrong, survey and rebuild, until the whole route passes (or `rounds`): each round
    teleports to the stone, runs the route checking at the config's checks, and when where() reads systematically off
    from locate() (systematic()) adds that run's readings as device anchors and rebuilds first; else surveys from the
    last good point to the end and rebuilds (mosaic, plan, emit), pushes. Tell the teacher first: the survey opens the
    big map at every few px."""
    for rnd in range(1, rounds + 1):
        print(f"== round {rnd}: teleport, dry run")
        sh.teleport(name)
        d = cmd_dryrun(root, name)
        if d["error"] and "stopped by teacher" in d["error"]:
            print("stopped by the teacher")
            return
        if d["offset"]:
            print(f"== round {rnd}: where() reads {d['offset']} px off locate() all along: device anchors from {d['file']}, rebuild")
            cmd_anchors(root, [root / d["file"]])
            rebuild(root, name, relocate=True)
            continue
        if d["ok"]:
            print("the whole route passed")
            return
        last = len(sh.load(name)["points"]) - 1
        a = max(1, d["reached"] + 1)
        b = last if not survey_ahead else min(last, a + survey_ahead)
        print(f"== round {rnd}: survey points {a}-{b}")
        cmd_survey(root, name, a, b)
        rebuild(root, name)
    print("rounds used up")
