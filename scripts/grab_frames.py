"""Grab the app's live frames to disk as fast as the API serves them (~8/s as JPEG), for offline checks.

    uv run python scripts/grab_frames.py data/wwm/survey1 --seconds 600

Each frame is <out>/<seq>.jpg (seq: the capture stream's frame number, the same as a skill's Image.seq); frames.jsonl
lists {seq, t} (t: PC epoch ms when it arrived). Stops after --seconds or when <out>/stop exists.
"""

import argparse
import json
import time
from pathlib import Path

from maalow.client import Client


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", type=Path)
    ap.add_argument("--seconds", type=float, default=600)
    ap.add_argument("--interval", type=float, default=0.0, help="least time between frames")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    c = Client()
    stop = a.out / "stop"
    stop.unlink(missing_ok=True)
    end = time.time() + a.seconds
    last = None
    n = 0
    with open(a.out / "frames.jsonl", "a", encoding="utf-8") as log:
        while time.time() < end and not stop.exists():
            t0 = time.time()
            try:
                with c._open("GET", "/screen", timeout=10) as r:
                    data = r.read()
                    seq = int(r.headers["X-Frame"])
            except OSError as e:
                print("error:", e)
                time.sleep(1)
                continue
            if seq != last:
                (a.out / f"{seq}.jpg").write_bytes(data)
                log.write(json.dumps({"seq": seq, "t": round(time.time() * 1000)}) + "\n")
                log.flush()
                last = seq
                n += 1
            left = a.interval - (time.time() - t0)
            if left > 0:
                time.sleep(left)
    print(f"{n} frames")


if __name__ == "__main__":
    main()
