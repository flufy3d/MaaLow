"""Order 4: cache the student's input views (uint8) for the frames the teacher was trained / evaluated on.

    uv run --no-project --with av --with opencv-python-headless --with numpy \
        python workspaces/WhereWindsMeet/tools/dufu_moveid/s4_cache.py [--procs 8] [--only ID,ID] [--first N] [--check 3]

Frames = exactly the teacher cache's frames (teacher/cache/<rec>.npz `frames` = s3_common.frame_plan, ~447k of 737k).
Each frame: PyAV decode (bgr24, as s2_features / s3_cache) -> s2_views.views() (cv2 INTER_AREA on the CPU: the
reference function itself, not the GPU matrices) -> glob 240x384x3 | big 192x192x3 | small 192x192x3, HWC BGR uint8,
concatenated (s4_common.VBYTES = 497,664 bytes per frame):
  student/views/<rec>.u8     raw [n, VBYTES] uint8 (n = len(frames))
  student/views/<rec>.npz    frames [n] int32 (video frame numbers), decoded (frame count of the video)
  student/views/status.json  per recording ok / n / decoded / expected / sec
Done recordings (status ok, file of the right size) are skipped, so the script resumes. ~222 GB in all.
--check K: after caching, K random recordings x 4 random cached frames are decoded again with cv2.VideoCapture and
compared through views() (max |diff| per view; PyAV vs OpenCV's own decode, reported, not required to be 0).
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from s3_common import CACHE, OUT, read_json, write_json  # noqa: E402
from s4_common import VBYTES, VIEWS, no_throttle, view_file  # noqa: E402

STATUS = VIEWS / "status.json"


def process(rec: str, video: str, frames: np.ndarray, expected: int) -> dict:
    import av
    import cv2
    from s2_views import views
    from s4_common import no_throttle
    no_throttle()
    cv2.setNumThreads(1)
    t0 = time.time()
    n = len(frames)
    path = view_file(rec)
    tmp = path.with_suffix(".part")
    want = set(int(f) for f in frames)   # sorted ascending: rows are written in order, a plain sequential file
    k, written = 0, 0
    with av.open(video) as c, open(tmp, "wb", buffering=8 << 20) as fh:
        s = c.streams.video[0]
        s.thread_type = "AUTO"
        s.codec_context.thread_count = 2
        for k, fr in enumerate(c.decode(s)):
            if k not in want:
                continue
            v = views(fr.to_ndarray(format="bgr24"))
            for nm in ("glob", "big", "small"):
                fh.write(np.ascontiguousarray(v[nm]).data)
            written += 1
        decoded = k + 1
    assert np.all(np.diff(frames) > 0)
    if decoded <= int(frames.max()) or written != n:
        tmp.unlink(missing_ok=True)
        return {"rec": rec, "ok": False, "error": f"decoded {decoded} frames, need {int(frames.max()) + 1}"}
    os.replace(tmp, path)
    np.savez(VIEWS / f"{rec}.npz", frames=frames.astype(np.int32), decoded=decoded)
    return {"rec": rec, "ok": True, "n": n, "decoded": decoded, "expected": expected,
            "sec": round(time.time() - t0, 1)}


def check(recs: list[dict], k: int, seed: int = 0) -> list[dict]:
    import cv2
    from s2_views import views
    from s4_common import open_views, split_views
    rng = np.random.default_rng(seed)
    out = []
    for r in rng.choice(recs, k, replace=False):
        fr = np.load(VIEWS / f"{r['rec']}.npz")["frames"]
        mm = open_views(r["rec"], len(fr))
        for i in sorted(rng.choice(len(fr), 4, replace=False)):
            cap = cv2.VideoCapture(r["video"])
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(fr[i]))
            ok, img = cap.read()
            cap.release()
            if not ok:
                out.append({"rec": r["rec"], "frame": int(fr[i]), "error": "read failed"})
                continue
            v = views(img)
            g, b, s = split_views(np.asarray(mm[i]))
            d = {nm: int(np.abs(v[nm].astype(int) - x.astype(int)).max()) for nm, x in (("glob", g), ("big", b), ("small", s))}
            mean = {nm: round(float(np.abs(v[nm].astype(int) - x.astype(int)).mean()), 3) for nm, x in (("glob", g), ("big", b), ("small", s))}
            out.append({"rec": r["rec"], "frame": int(fr[i]), "max": d, "mean": mean})
            print(out[-1], flush=True)
    return out


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--procs", type=int, default=8)
    ap.add_argument("--only", default="")
    ap.add_argument("--first", type=int, default=0)
    ap.add_argument("--check", type=int, default=0)
    a = ap.parse_args()
    no_throttle()
    VIEWS.mkdir(parents=True, exist_ok=True)
    idx = read_json(OUT / "index.json")
    recs = [{"rec": r["rec"], "frames": r["frames"], "video": str(OUT / "video" / f"{r['rec']}.mp4")} for r in idx["rounds"]]
    if a.only:
        keep = set(a.only.split(","))
        recs = [r for r in recs if r["rec"] in keep]
    if a.first:
        recs = recs[:a.first]
    st = read_json(STATUS) if STATUS.exists() else {"recs": {}}
    todo = []
    for r in recs:
        fr = np.load(CACHE / f"{r['rec']}.npz")["frames"]
        s = st["recs"].get(r["rec"])
        f = view_file(r["rec"])
        if s and s.get("ok") and f.exists() and f.stat().st_size == len(fr) * VBYTES:
            continue
        todo.append((r, fr))
    print(f"{len(todo)} recordings to cache ({sum(len(fr) for _, fr in todo)} frames, "
          f"{sum(len(fr) for _, fr in todo) * VBYTES / 1e9:.1f} GB)", flush=True)
    t0 = time.time()
    done = 0
    with ProcessPoolExecutor(a.procs) as ex:
        futs = [ex.submit(process, r["rec"], r["video"], fr, r["frames"]) for r, fr in todo]
        for f in as_completed(futs):
            res = f.result()
            st["recs"][res["rec"]] = res
            done += res.get("n", 0)
            write_json(STATUS, st)
            el = time.time() - t0
            print(f"{res['rec']} {res.get('ok')} {res.get('n')} {res.get('sec')}s  total {done} frames "
                  f"{done / max(el, 1e-9):.0f} f/s {el:.0f}s {res.get('error', '')}", flush=True)
    ok = [s for s in st["recs"].values() if s.get("ok")]
    st["n_ok"], st["n_frames"] = len(ok), sum(s["n"] for s in ok)
    st["bytes"] = st["n_frames"] * VBYTES
    st["last_run"] = time.strftime("%Y-%m-%d %H:%M:%S")
    if a.check:
        st["check"] = check([r for r in recs if st["recs"].get(r["rec"], {}).get("ok")], a.check)
    write_json(STATUS, st)
    print(f"ok {st['n_ok']} recordings, {st['n_frames']} frames, {st['bytes'] / 1e9:.1f} GB")


if __name__ == "__main__":
    main()
