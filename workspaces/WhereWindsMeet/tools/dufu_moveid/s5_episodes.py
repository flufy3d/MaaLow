"""Order 5 (关 2 专攻): the 火球雨 (c7) episodes and the 金光火球 (c11) windows of live defend rounds, from the trace and
the recording, so a run / goldSeq change can be judged per episode (gate 2 counts contacts only; a fireball that a
run made miss leaves none).

    uv run --no-project --with numpy --with opencv-python-headless python $D/s5_episodes.py r024 r025 ... [--json out]

Needs s5_analyze.py run on the rounds (contacts.json) and live/video. MOVEID_PHASE=1 (阶段一) reads
data/moveid/p1/live and model/dufu1/movetable.json; the c11 window there is the group starting with k0:c11
(k0:c11+c15+c23, 阶段二: k0:c11+c40).

c7 episode: the first trace row of >= 2 consecutive rows whose grp is a 火球雨 volley group (k0..k4:c7, unparryable
  in the move table), >= EP_GAP_F after the previous episode's start; the window is [start, start + EP_WIN_F] video
  frames (the volley lands ~35 f after the start and lasts ~35 f, data/tmp: r024 / r027 sheets).
  hits = truth hits (hp steps) in the window; drop = their summed hp drop; clean = no hit.
  Video check (did a volley come at all): `blast` = the most frames in the window, over any 8-frame run, where the
  screen's fireball glow (pixels with R >= 200, G <= 150, B <= 120 and R - G >= 90 in the play area) covers >= 1.5 %.
  A volley seen = blast >= 3 frames. A clean episode with a volley seen = the run (or whatever) made it miss.
c11 window: a truth contact or a real dodge press whose head group at decision time is k0:c11+c40 opens a window
  (anchor = the contact, or the dodge + 5 f); hits = truth hits in (anchor + 8, anchor + 150].
Per round and totals; with run rows, the run's direction (trace col `run`: sign x (1 + index of side / diag / back)).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import OUT, PHASE, read_json  # noqa: E402

LIVE = OUT / "live"
FRAME_MS = 1000 / 30
TABLE = read_json(HERE.parents[1] / "model" / f"dufu{PHASE}" / "movetable.json")
GN = list(TABLE["groups"])
C7 = {i for i, n in enumerate(GN) if n.split(":")[1] == "c7" and TABLE["groups"][n]["unparryable"]}
C11 = next((i for i, n in enumerate(GN) if n.startswith("k0:c11")), None)   # 阶段二 k0:c11+c40, 阶段一 k0:c11+c15+c23
EP_GAP_F, EP_WIN_F = 150, 130
SEQ_MIN_F, SEQ_F = 8, 150
DIRS = ["side", "diag", "back"]
PLAY = (0, 60, 1080, 560)   # x, y, w, h: the play area without the HUD rows


def glow(video: Path, frames: list[int]) -> dict[int, float]:
    import cv2
    out = {}
    if not frames:
        return out
    cap = cv2.VideoCapture(str(video))
    want = sorted(set(frames))
    cap.set(cv2.CAP_PROP_POS_FRAMES, want[0])
    f = want[0]
    S = set(want)
    while f <= want[-1]:
        ok, im = cap.read()
        if not ok:
            break
        if f in S:
            x, y, w, h = PLAY
            a = im[y:y + h, x:x + w].astype(np.int16)
            b, g, r = a[..., 0], a[..., 1], a[..., 2]
            m = (r >= 200) & (g <= 150) & (b <= 120) & (r - g >= 90)
            out[f] = float(m.mean())
        f += 1
    return out


def blast(gl: dict[int, float], a: int, b: int, th: float = 0.015) -> int:
    v = [gl.get(f, 0.0) >= th for f in range(a, b + 1)]
    best = 0
    for i in range(len(v)):
        best = max(best, sum(v[i:i + 8]))
    return best


def round_eps(name: str, check_video: bool) -> dict:
    d = LIVE / name
    res = read_json(d / "result.json")["value"]
    tr = sorted(read_json(d / "trace.json"), key=lambda c: c["chunk"])
    cols = tr[0]["cols"]
    R = np.array([r for c in tr for r in c["rows"]], np.float64)
    C = {c: i for i, c in enumerate(cols)}
    rid = (d / "rec.txt").read_text().strip()
    meta = read_json(LIVE / "meta" / f"{rid}.json")
    con = read_json(d / "contacts.json")
    k0 = (res["start"] - meta["started"]) / FRAME_MS
    vf = lambda t: k0 + np.asarray(t, np.float64) / FRAME_MS + con["offset"]  # noqa: E731
    capf = vf(R[:, C["cap"]])
    grp = R[:, C["grp"]].astype(int)
    truth = con["truth"]
    hits = [t for t in truth if t["kind"] == "hit"]
    isc7 = np.array([g in C7 for g in grp])
    starts = []
    for i in range(1, len(R)):
        if isc7[i] and isc7[i - 1] and (not starts or capf[i - 1] - starts[-1][1] >= EP_GAP_F):
            starts.append((i - 1, float(capf[i - 1])))
    runcol = C.get("run")
    eps = []
    for i, s in starts:
        a, b = int(s), int(s + EP_WIN_F)
        hs = [t for t in hits if a <= t["frame"] <= b]
        run = 0
        if runcol is not None:
            w = R[(capf >= s - 5) & (capf <= b), runcol]
            nz = w[w != 0]
            run = int(nz[0]) if len(nz) else 0
        eps.append({"start": round(s, 1), "hits": len(hs), "drop": round(sum(t["drop"] for t in hs), 3),
                    "run": (("+" if run > 0 else "-") + DIRS[abs(run) - 1]) if run else None,
                    "contacts": len([t for t in truth if a <= t["frame"] <= b])})
    # c11 windows
    anchors = [t["frame"] for t in truth if (t.get("dec") or {}).get("grp", "").startswith("k0:c11")]
    for p in res["pressLog"]:
        if p[1] == "dodge" and p[2] == C11:
            anchors.append(float(vf(p[0])) + 5)
    anchors.sort()
    wins = []
    for x in anchors:
        if wins and x - wins[-1]["anchor"] <= SEQ_F:
            continue
        hs = [t for t in hits if x + SEQ_MIN_F < t["frame"] <= x + SEQ_F]
        wins.append({"anchor": round(x, 1), "hits": len(hs), "drop": round(sum(t["drop"] for t in hs), 3)})
    if check_video and eps:
        frames = [f for e in eps for f in range(int(e["start"]), int(e["start"]) + EP_WIN_F + 1)]
        gl = glow(LIVE / "video" / f"{rid}.mp4", frames)
        for e in eps:
            e["blast"] = blast(gl, int(e["start"]), int(e["start"]) + EP_WIN_F)
            e["volley_seen"] = e["blast"] >= 3
    return {"round": name, "args": read_json(d / "args.json"), "fight_s": round(res["fightMs"] / 1000, 1),
            "c7": eps, "c11": wins, "runs": (res.get("run") or {}).get("runs"), "goldSeq": res.get("goldSeq")}


def summary(rs: list[dict]) -> dict:
    E = [e for r in rs for e in r["c7"]]
    W = [w for r in rs for w in r["c11"]]
    by = {}
    for e in E:
        k = (e["run"] or "none").lstrip("+-")
        x = by.setdefault(k, {"n": 0, "clean": 0, "hits": 0, "drop": 0.0, "volley_seen": 0, "clean_seen": 0})
        x["n"] += 1
        x["clean"] += e["hits"] == 0
        x["hits"] += e["hits"]
        x["drop"] = round(x["drop"] + e["drop"], 3)
        x["volley_seen"] += bool(e.get("volley_seen"))
        x["clean_seen"] += bool(e.get("volley_seen")) and e["hits"] == 0
    fm = sum(r["fight_s"] for r in rs) / 60
    return {"rounds": len(rs), "fight_min": round(fm, 1), "c7_episodes": len(E), "c7_hits": sum(e["hits"] for e in E),
            "c7_by_run": by, "c11_windows": len(W), "c11_hits": sum(w["hits"] for w in W),
            "c11_clean": sum(w["hits"] == 0 for w in W)}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("rounds", nargs="+")
    ap.add_argument("--no-video", action="store_true")
    ap.add_argument("--json", type=Path)
    ap.add_argument("-v", action="store_true")
    a = ap.parse_args()
    rs = [round_eps(n, not a.no_video) for n in a.rounds]
    if a.v:
        for r in rs:
            print(r["round"], "c7", r["c7"], "c11", r["c11"])
    s = summary(rs)
    print(json.dumps(s, ensure_ascii=False))
    if a.json:
        a.json.write_text(json.dumps({"summary": s, "rounds": rs}, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
