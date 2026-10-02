"""A stronghold's one-click run (node <Name>: close popups, teleport, stop if not refreshed, then the route) as two
skill calls (stronghold.js with route: false, then route.js with the config), so the route's whole log comes back; the app's live frames are grabbed all along
(scripts/grab_frames.py, ~8/s) to line up with the goto traces (their `seq`).

    uv run python workspaces/WhereWindsMeet/tools/live_run.py Jiurou data/wwm_live/jiurou1

<out>/teleport.json and <out>/route.json are the skills' results (logs included), <out>/frames/ the frames, and a
summary is printed: per leg why it ended, matches and misses, ways out of being stuck; fights (rounds, potions, 处决);
the times it was found again; the chest.
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import strongholds as sh  # noqa: E402
from rec_route import Grabber  # noqa: E402


def summary(route: dict) -> dict:
    logs = route.get("logs", [])
    v = route.get("value") or {}
    legs = [g for g in v.get("legs", []) if "fixes" in g]
    goto = [json.loads(line) for line in logs if line.startswith('{"ms"')]
    return {
        "ok": route.get("ok"),
        "error": (route.get("error") or {}).get("message"),
        "ms": v.get("ms"),
        "legs": len(legs),
        "why": {w: sum(1 for g in legs if g["why"] == w) for w in sorted({g["why"] for g in legs})},
        "fixes": sum(g["fixes"] for g in legs),
        "misses": sum(g["misses"] for g in legs),
        "max_miss_run": max([g["maxMissRun"] for g in legs] or [0]),
        "stuck": sum(g["stuck"] for g in legs),
        "fights": v.get("fights"),
        "relocs": v.get("relocs"),
        "layers": [g.get("layers") for g in goto if g.get("layers")],
        "fight_logs": [line for line in logs if line.startswith("fight") or "处决" in line],
        "found_again": [line for line in logs if "found again" in line or "finding it again" in line],
        "points": [line for line in logs if re.match(r"point \d+ ", line)],
        "chest": [line for line in logs if not line.startswith("{") and ("reward panel" in line or "taken (" in line or "chest" in line)],
    }


def main() -> None:
    name, out = sys.argv[1], Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    g = Grabber(out / "frames")
    try:
        t = sh.teleport(name)
        json.dump(t, open(out / "teleport.json", "w", encoding="utf-8"), ensure_ascii=False)
        if not t.get("ok"):
            print(json.dumps({"teleport": (t.get("error") or {}).get("message")}, ensure_ascii=False))
            return
        r = sh.route(name)
        json.dump(r, open(out / "route.json", "w", encoding="utf-8"), ensure_ascii=False)
    finally:
        frames = g.stop()
    s = summary(r) | {"frames": frames}
    json.dump(s, open(out / "summary.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(s, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
