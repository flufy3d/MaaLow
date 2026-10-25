"""Order 5: pull the live dufu2 rounds' recordings (and pair screenshots) to the PC, verify, then delete them on the Pad.

    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/s5_pull.py [--delete] [--procs 4]

Rounds: data/moveid/live/rNNN (tools/dufu_rounds.py --skill dufu2 output: result.json, trace.json, args.json, rec.txt,
events.json). Per round whose recording is not verified yet:
  1. meta (GET /recordings/<ws>/<id>) -> live/meta/<id>.json; video -> live/video/<id>.mp4 (Range resume)
  2. verify like pull.py: size == the Pad's, 3 x 64 KiB byte samples equal, every frame decoded and counted
     (|decoded - meta frames| <= 2); the same decode keeps the per-frame hp / 真气 reads -> live/bars/<id>.npz
  3. pair screenshots named in events.json (dufu2_pair events) -> rNNN/png/, then DELETE on the app
  live/pull_status.json: id -> {round, size, pad_size, frames, meta_frames, bytes_ok, ok, pngs}
--delete: DELETE on the Pad the recordings of these rounds that are verified (only those: nothing else is touched),
each re-checked (size + byte samples) right before; labels.json saved first. Log: live/deleted.json.
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from common import OUT, WS, read_json, write_json
from pull import _req, _url, bytes_ok, decode, download

from maalow.client import Client

LIVE = OUT / "live"
VID, META, BARS = LIVE / "video", LIVE / "meta", LIVE / "bars"
STATUS = LIVE / "pull_status.json"
MAX_FRAME_DIFF = 2


def live_rounds() -> list[dict]:
    out = []
    for p in sorted(LIVE.glob("r[0-9][0-9][0-9]")):
        f = p / "rec.txt"
        rid = f.read_text(encoding="utf-8").strip() if f.exists() else ""
        if rid:
            out.append({"key": p.name, "dir": p, "rec": rid})
    return out


def verify(rid: str) -> dict:
    import numpy as np
    n, prop, bars = decode(VID / f"{rid}.mp4")
    BARS.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(BARS / f"{rid}.npz", **bars)
    return {"frames": n, "container_frames": prop}


def pngs(c: Client, rd: dict) -> int:
    ev = read_json(rd["dir"] / "events.json", []) or []
    dst = rd["dir"] / "png"
    k = 0
    for e in ev:
        if e.get("name") != "dufu2_pair":
            continue
        rel = e["data"]["png"]
        out = dst / Path(rel).name
        if not out.exists():
            dst.mkdir(exist_ok=True)
            c.download(f"/files/{WS}/{rel}", out)
        try:
            c.request("DELETE", f"/files/{WS}/{rel}")
        except Exception:  # noqa: BLE001 - already gone
            pass
        k += 1
    return k


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--delete", action="store_true")
    ap.add_argument("--procs", type=int, default=4)
    a = ap.parse_args()
    c = Client()
    st = read_json(STATUS, {}) or {}
    rds = live_rounds()
    VID.mkdir(parents=True, exist_ok=True)
    META.mkdir(parents=True, exist_ok=True)
    todo = []
    for rd in rds:
        rid = rd["rec"]
        e = st.get(rid, {})
        e["round"] = rd["key"]
        e["pngs"] = pngs(c, rd)
        if not e.get("ok"):
            meta = c.get(f"/recordings/{urllib.parse.quote(WS)}/{urllib.parse.quote(rid)}")
            if "error" in meta:
                e["error"] = meta["error"]
                st[rid] = e
                print(rd["key"], rid, "meta error", meta["error"], flush=True)
                continue
            write_json(META / f"{rid}.json", meta)
            e.update(pad_size=int(meta["size"]), meta_frames=int(meta["frames"]))
            f = VID / f"{rid}.mp4"
            if not (f.exists() and f.stat().st_size == e["pad_size"]):
                download(c, rid, e["pad_size"], f)
            e["size"] = f.stat().st_size
            e["bytes_ok"] = bytes_ok(c, rid, f, e["pad_size"])
            todo.append(rid)
        st[rid] = e
    write_json(STATUS, st)
    with ProcessPoolExecutor(a.procs) as px:
        for rid, v in zip(todo, px.map(verify, todo)):
            e = st[rid]
            e.update(v, frame_diff=v["frames"] - e["meta_frames"])
            e["ok"] = bool(e["size"] == e["pad_size"] and e["bytes_ok"] and abs(e["frame_diff"]) <= MAX_FRAME_DIFF)
            e.pop("error", None)
            write_json(STATUS, st)
            print(e["round"], rid, f"frames {v['frames']}/{e['meta_frames']} bytes_ok {e['bytes_ok']} ok {e['ok']}", flush=True)
    if not a.delete:
        return
    log = read_json(LIVE / "deleted.json", {}) or {}
    for rd in rds:
        rid = rd["rec"]
        e = st.get(rid, {})
        if not e.get("ok") or log.get(rid, {}).get("deleted"):
            continue
        meta = c.get(f"/recordings/{urllib.parse.quote(WS)}/{urllib.parse.quote(rid)}")
        f = VID / f"{rid}.mp4"
        if "error" in meta or int(meta.get("size", -1)) != f.stat().st_size or not bytes_ok(c, rid, f, f.stat().st_size):
            log[rid] = {"deleted": False, "why": "re-check failed"}
            print(rid, "re-check failed, kept", flush=True)
            continue

        try:
            with urllib.request.urlopen(_req(c, _url(c, rid, "/labels")), timeout=60) as r:
                (META / f"{rid}.labels.json").write_bytes(r.read())
        except urllib.error.HTTPError:
            pass
        req = _req(c, _url(c, rid))
        req.method = "DELETE"
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode("utf-8", "replace")
        time.sleep(0.3)
        gone = "error" in c.get(f"/recordings/{urllib.parse.quote(WS)}/{urllib.parse.quote(rid)}")
        log[rid] = {"deleted": gone, "round": rd["key"], "response": body[:200], "at": time.strftime("%Y-%m-%d %H:%M:%S")}
        write_json(LIVE / "deleted.json", log)
        print(rd["key"], rid, "deleted" if gone else "DELETE did not take", flush=True)


if __name__ == "__main__":
    main()
