"""Pull the recordings the rounds reference to data/moveid/video/<id>.mp4 and verify them.

    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/pull.py [--first 20] [--workers 3] [--procs 6] [--recheck]

Per recording (in round order, p2 first):
  1. meta: GET /recordings/<ws>/<id> -> data/moveid/meta/<id>.json (has `started`, `frames`, `size`).
  2. video: skip when data/moveid/video/<id>.mp4 already has the Pad's size. Else copy the workspace's local
     recordings/<id>/video.mp4 when its size matches (already synced earlier), else download with HTTP Range resume
     (<id>.mp4.part survives an interruption).
  3. verify: size == Pad size; 3 x 64 KiB byte samples (start / middle / end) equal to the Pad's (Range GET); every
     frame decoded with OpenCV (--procs processes) and counted, |decoded - meta frames| <= 2. The same pass keeps every
     frame's HP_ROI / QI_ROI crop and reads them with the dufu.js readers (reads.py) -> data/moveid/bars/<id>.npz
     {v, hp, qi, hp_crop, qi_crop} (used by build.py).
  4. data/moveid/pull_status.json: id -> {round, size, pad_size, frames, meta_frames, frame_diff, source, bytes_ok, ok}
     written after each recording. Re-running skips the ok ones with current bars (--recheck re-verifies them).
"""
from __future__ import annotations

import argparse
import os
import shutil
import time
import urllib.parse
import urllib.request
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np

from common import BARS, LOCAL_RECS, META, OUT, STATUS, VIDEO, WS, read_json, rounds, write_json

from maalow.client import API, Client

# several decoders at once: few ffmpeg threads each (the default, one per core, thrashes when processes run in parallel)
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "threads;2")
SAMPLE = 64 * 1024
MAX_FRAME_DIFF = 2


def _url(client: Client, rid: str, tail: str = "") -> str:
    return f"{client.server}{API}/recordings/{urllib.parse.quote(WS)}/{urllib.parse.quote(rid)}{tail}"


def _req(client: Client, url: str, rng: str | None = None) -> urllib.request.Request:
    h = {"Authorization": f"Bearer {client.token}", "X-MaaLow-Client": "cli"}
    if rng:
        h["Range"] = rng
    return urllib.request.Request(url, headers=h)


def pad_bytes(client: Client, rid: str, start: int, n: int) -> bytes:
    with urllib.request.urlopen(_req(client, _url(client, rid, "/video.mp4"), f"bytes={start}-{start + n - 1}"),
                                timeout=60) as r:
        if r.status != 206:
            raise RuntimeError(f"range not honoured: HTTP {r.status}")
        return r.read()


def download(client: Client, rid: str, size: int, dest: Path) -> None:
    part = dest.with_name(dest.name + ".part")
    for attempt in range(6):
        have = part.stat().st_size if part.exists() else 0
        if have > size:
            part.unlink()
            have = 0
        if have == size:
            break
        try:
            with urllib.request.urlopen(_req(client, _url(client, rid, "/video.mp4"), f"bytes={have}-"),
                                        timeout=120) as r, open(part, "ab" if have else "wb") as f:
                if have and r.status != 206:
                    raise RuntimeError(f"resume not honoured: HTTP {r.status}")
                shutil.copyfileobj(r, f, 1 << 20)
        except Exception as e:  # noqa: BLE001 - network hiccup: resume from what we have
            print(f"{rid}: download attempt {attempt + 1} failed ({e}), resuming", flush=True)
            time.sleep(3)
    if part.stat().st_size != size:
        raise RuntimeError(f"download incomplete: {part.stat().st_size} / {size}")
    part.replace(dest)


def fetch(client: Client, rid: str, size: int, dest: Path) -> str:
    if dest.exists() and dest.stat().st_size == size:
        return "present"
    local = LOCAL_RECS / rid / "video.mp4"
    if local.exists() and local.stat().st_size == size:
        part = dest.with_name(dest.name + ".part")
        shutil.copyfile(local, part)
        part.replace(dest)
        return "local-copy"
    download(client, rid, size, dest)
    return "download"


def bytes_ok(client: Client, rid: str, path: Path, size: int) -> bool:
    with open(path, "rb") as f:
        for off in (0, max(0, size // 2 - SAMPLE // 2), max(0, size - SAMPLE)):
            n = min(SAMPLE, size - off)
            f.seek(off)
            if f.read(n) != pad_bytes(client, rid, off, n):
                return False
    return True


BARS_V = 2


def decode(path: Path) -> tuple[int, int, dict]:
    """(decoded frames, container frame count, bars arrays): every frame's HP_ROI / QI_ROI crops and the dufu.js
    readers on them (reads.py)."""
    import cv2

    import reads

    cap = cv2.VideoCapture(str(path))
    prop = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    hc, qc = [], []
    while True:
        ok, img = cap.read()
        if not ok:
            break
        hc.append(reads.crop(img, reads.HP_ROI).copy())
        qc.append(reads.crop(img, reads.QI_ROI).copy())
    cap.release()
    hp = np.array([reads.health(c) for c in hc], np.float32)
    qi = np.array([reads.qi(c) for c in qc], np.int16)
    return len(hc), prop, {"v": np.int32(BARS_V), "hp": hp, "qi": qi, "hp_crop": np.array(hc, np.uint8),
                           "qi_crop": np.array(qc, np.uint8)}


def bars_ok(rid: str) -> bool:
    try:
        with np.load(BARS / f"{rid}.npz") as z:
            return int(z["v"]) == BARS_V
    except (FileNotFoundError, KeyError, OSError, ValueError):
        return False


def fetch_one(client: Client, rd: dict) -> dict:
    """Meta + video file; returns the status entry (not yet verified)."""
    rid = rd["rec"]
    entry = {"round": rd["key"], "ok": False}
    try:
        meta = client.get(f"/recordings/{urllib.parse.quote(WS)}/{urllib.parse.quote(rid)}")
        if "error" in meta:
            raise RuntimeError(meta["error"])
        write_json(META / f"{rid}.json", meta)
        entry.update(pad_size=int(meta["size"]), meta_frames=int(meta["frames"]))
        entry["source"] = fetch(client, rid, entry["pad_size"], VIDEO / f"{rid}.mp4")
        entry["size"] = (VIDEO / f"{rid}.mp4").stat().st_size
        entry["bytes_ok"] = bytes_ok(client, rid, VIDEO / f"{rid}.mp4", entry["pad_size"])
    except Exception as e:  # noqa: BLE001 - recorded; a re-run retries
        entry["error"] = f"{type(e).__name__}: {e}"
    return entry


def verify_one(rid: str, entry: dict) -> dict:
    """Decode (in a worker process), write bars, set ok."""
    t0 = time.time()
    entry = dict(entry)
    try:
        n, prop, bars = decode(VIDEO / f"{rid}.mp4")
        BARS.mkdir(parents=True, exist_ok=True)
        tmp = BARS / f"{rid}.tmp.npz"
        np.savez_compressed(tmp, **bars)
        tmp.replace(BARS / f"{rid}.npz")
        entry.update(frames=n, container_frames=prop, frame_diff=n - entry["meta_frames"])
        entry["ok"] = bool(entry["size"] == entry["pad_size"] and entry["bytes_ok"]
                           and abs(n - entry["meta_frames"]) <= MAX_FRAME_DIFF)
        entry.pop("error", None)
    except Exception as e:  # noqa: BLE001
        entry["error"] = f"{type(e).__name__}: {e}"
    entry["decode_secs"] = round(time.time() - t0, 1)
    return entry


def save(rid: str, entry: dict) -> None:
    allst = read_json(STATUS, {})
    allst[rid] = entry
    write_json(STATUS, allst)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--first", type=int, default=0, help="only the first N rounds")
    ap.add_argument("--workers", type=int, default=3, help="parallel downloads")
    ap.add_argument("--procs", type=int, default=6, help="parallel decode processes")
    ap.add_argument("--recheck", action="store_true")
    a = ap.parse_args()
    client = Client()
    rds = rounds()
    if a.first:
        rds = rds[:a.first]
    VIDEO.mkdir(parents=True, exist_ok=True)
    st0 = read_json(STATUS, {})
    gone = set((OUT / "deleted.txt").read_text(encoding="utf-8").split()) if (OUT / "deleted.txt").exists() else set()
    if gone & {rd["rec"] for rd in rds}:
        print(f"{len(gone & {rd['rec'] for rd in rds})} already deleted from the Pad (delete.py): kept as they are")
        rds = [rd for rd in rds if rd["rec"] not in gone]
    todo = [rd for rd in rds if a.recheck or not (st0.get(rd["rec"], {}).get("ok") and bars_ok(rd["rec"])
                                                  and (VIDEO / f"{rd['rec']}.mp4").exists())]
    print(f"{len(rds)} rounds, {len(rds) - len(todo)} already verified, {len(todo)} to do", flush=True)
    def done(fu, rd):
        e = fu.result()
        save(rd["rec"], e)
        print(f"{rd['key']} {rd['rec']} size {e.get('size')}/{e.get('pad_size')} frames {e.get('frames')}/"
              f"{e.get('meta_frames')} ok {e['ok']} {e.get('error', '')} {e['decode_secs']}s", flush=True)

    with ThreadPoolExecutor(a.workers) as tx, ProcessPoolExecutor(a.procs) as px:
        pend = {}
        for rd, entry in zip(todo, tx.map(lambda rd: fetch_one(client, rd), todo)):  # in order
            rid = rd["rec"]
            if "error" in entry:
                save(rid, entry)
                print(f"{rd['key']} {rid} fetch failed: {entry['error']}", flush=True)
                continue
            print(f"{rd['key']} {rid} fetched ({entry['source']}, bytes_ok {entry['bytes_ok']})", flush=True)
            pend[px.submit(verify_one, rid, entry)] = rd
            for fu in [f for f in pend if f.done()]:  # save finished ones as we go (a killed run keeps them)
                done(fu, pend.pop(fu))
        for fu in as_completed(pend):
            done(fu, pend[fu])
    st = read_json(STATUS, {})
    ids = [rd["rec"] for rd in rds]
    ok = [i for i in ids if st.get(i, {}).get("ok")]
    print(f"{len(ok)}/{len(ids)} verified, {sum(st[i]['size'] for i in ok) / 1e9:.2f} GB")


if __name__ == "__main__":
    main()
