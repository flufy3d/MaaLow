"""独夫 rounds for training data: enter the arena, record, fight with the trace on, stop, keep everything.

    uv run python workspaces/WhereWindsMeet/tools/dufu_rounds.py data/p2 --n 20 --phase 2

Per round <out>/rNNN/: result.json (the dufu run), trace.json (the dufu_trace events, chunk order), rec.txt (the
recording id; `--pull` downloads it into the workspace's recordings/). Stops on the first failed entry, on a teacher
stop (an error from the skill) or after --n rounds. The next round number continues from what is in <out>.

--skill NAME runs another fight skill with the same round frame (default dufu; e.g. dufu2): its args are
{"phase", "ms"} + --skill-args (JSON; --trace / --heads / --alt keep working for dufu only, --alt for any), its trace
event is "<NAME>_trace"; every other event of the run whose name starts with "<NAME>_" goes to events.json (e.g.
dufu2_pair).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from maalow.client import Client


def _text(b: bytes) -> str:
    """The CLI's stdout is UTF-8 normally, but the Windows console can make Python encode JSON logs as GBK."""
    for enc in ("utf-8", "gbk"):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            pass
    return b.decode("utf-8", "replace")


def cli(*args: str, timeout: float = 1200) -> dict:
    p = subprocess.run(["uv", "run", "maalow", *args], capture_output=True, timeout=timeout)
    out, err = _text(p.stdout), _text(p.stderr)
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return {"error": (out + err)[-2000:]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", type=Path)
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--phase", type=int, default=2)
    ap.add_argument("--ms", type=int, default=900_000)
    ap.add_argument("--trace", default="feat")
    ap.add_argument("--pull", action="store_true")
    ap.add_argument("--alt", default="[]", help='JSON list of extra dufu args, alternated per round, e.g. [{"flare2":true},{"flare2":false}]')
    ap.add_argument("--heads", default="", help="comma list of head models, alternated per round (default: dufu.js's)")
    ap.add_argument("--skill", default="dufu", help="the fight skill (default dufu)")
    ap.add_argument("--skill-args", default="{}", help="JSON args for --skill other than dufu (merged over phase / ms)")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    done = sorted(int(p.name[1:]) for p in a.out.glob("r[0-9][0-9][0-9]"))
    first = (done[-1] + 1) if done else 1
    c = Client()
    for i in range(first, first + a.n):
        d = a.out / f"r{i:03d}"
        enter = cli("do", "skill", "dufu_enter", "--args", json.dumps({"phase": a.phase}), timeout=400)
        if not enter.get("ok") or enter.get("value") != "arena":
            print(f"r{i:03d} enter failed: {json.dumps(enter, ensure_ascii=False)[:500]}", flush=True)
            return 1
        last = 0
        for k in range(5):  # the app's HTTP drops a connection now and then
            try:
                last = max((e.get("id", 0) for e in c.get("/events?since=0&type=skill_event")), default=0)
                break
            except (OSError, AttributeError):  # AttributeError: an {"error"} (out of memory: run event_pad first)
                time.sleep(5)
        else:
            return 1
        rec = cli("rec", "start")
        if a.skill == "dufu":
            args = {"phase": a.phase, "ms": a.ms, "trace": a.trace if a.trace != "true" else True}
        else:
            args = {"phase": a.phase, "ms": a.ms, **json.loads(a.skill_args)}
        heads = [h for h in a.heads.split(",") if h] if a.skill == "dufu" else []
        if heads:
            args["head"] = heads[(i - first) % len(heads)]
        alts = json.loads(a.alt)
        if alts:
            args.update(alts[(i - first) % len(alts)])
        res = cli("do", "skill", a.skill, "--args", json.dumps(args), "--timeout", str(a.ms + 60_000), timeout=a.ms / 1000 + 180)
        stop = cli("rec", "stop")
        allev = c.get(f"/events?since={last}&type=skill_event")
        ev = [e for e in allev if e.get("name") == f"{a.skill}_trace"]
        ev.sort(key=lambda e: e["data"]["chunk"])
        d.mkdir()
        if a.skill != "dufu":
            other = [e for e in allev if str(e.get("name", "")).startswith(f"{a.skill}_") and e.get("name") != f"{a.skill}_trace"]
            (d / "events.json").write_text(json.dumps(other, ensure_ascii=False), encoding="utf-8")
        (d / "result.json").write_text(json.dumps(res, ensure_ascii=False), encoding="utf-8")
        (d / "trace.json").write_text(json.dumps([e["data"] for e in ev]), encoding="utf-8")
        (d / "args.json").write_text(json.dumps(args), encoding="utf-8")
        (d / "rec.txt").write_text(str(stop.get("id") or rec.get("id") or ""), encoding="utf-8")
        cli("do", "skill", "event_pad", timeout=200)  # the trace events out of the app's memory (skills/event_pad.js)
        if a.pull and stop.get("id"):
            cli("rec", "pull", stop["id"], timeout=600)
        v = res.get("value") or {}
        rows = sum(len(e["data"]["rows"]) for e in ev)
        print(f"r{i:03d} {json.dumps({k: x for k, x in args.items() if k not in ('phase', 'ms', 'trace')})} {v.get('reason')} hits {v.get('hits')} oks {v.get('oks')} rows {rows} rec {stop.get('id')}"
              f" boss {(v.get('off') or {}).get('act', {}).get('dropPx')}", flush=True)
        if not res.get("ok"):
            print(f"r{i:03d} skill error: {json.dumps(res, ensure_ascii=False)[:500]}", flush=True)
            return 1
        time.sleep(2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
