"""Try a route's continuous mode (route.js `locate`) several rounds with each reference, from the teleport stone.

    uv run python scripts/route_bench.py data/wwm/bench --refs locate/cixin_mosaic,locate/cixin_bigmap --rounds 5

Each round: the teleport node (CixinTeleport), then route.js through points 1..TO of CixinRoute with check: true
(stops at every point and reads where() there: the arrival error) and nodo: true. A walk that ends stuck, astray or
lost is counted against the point it was heading for, and the round starts over from the stone; a point that failed
3 times in a row is left out of the round from then on. Rounds are appended to <out>/rounds.jsonl.
"""

import argparse
import json
import re
import time
from pathlib import Path

from maalow.client import Client

REPO = Path(__file__).resolve().parents[1]
PIPELINE = REPO / "workspaces" / "WhereWindsMeet" / "pipeline" / "stronghold.json"


def teleport(c: Client) -> bool:
    for _ in range(2):
        r = c.post("/run", {"node": "CixinTeleport", "once": False, "record": False}, timeout=600)
        if r.get("hit"):
            return True
        time.sleep(3)
    return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", type=Path)
    ap.add_argument("--refs", default="locate/cixin_mosaic,locate/cixin_bigmap")
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--to", type=int, default=9)
    ap.add_argument("--attempts", type=int, default=6, help="walks per round at most")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    route = json.load(open(PIPELINE, encoding="utf-8"))["CixinRoute"]["custom_action_param"]["points"]
    points = [{"at": p["at"], "name": p["name"], **({"cam": p["cam"]} if "cam" in p else {})} for p in route[: a.to + 1]]
    c = Client()
    for ref in a.refs.split(","):
        for rnd in range(1, a.rounds + 1):
            skip: set[int] = set()
            fails: dict[int, int] = {}
            walks = []
            t0 = time.time()
            ok = False
            for _ in range(a.attempts):
                if not teleport(c):
                    walks.append({"error": "teleport failed"})
                    break
                keep = [i for i in range(len(points)) if i == 0 or i not in skip]
                args = {"points": [points[i] for i in keep], "from": 1, "to": len(keep) - 1, "locate": ref,
                        "check": True, "nodo": True}
                w0 = time.time()
                r = c.post("/skill/run", {"name": "route", "args": args, "timeout": 900_000}, timeout=960)
                logs = r.get("logs", [])
                legs = next((json.loads(l[5:]) for l in logs if l.startswith("legs ")), None)
                if r.get("ok"):
                    legs = r["value"]["legs"]
                for leg in legs or []:  # back to CixinRoute's numbering
                    leg["i"], leg["j"] = keep[leg["i"]], keep[leg["j"]]
                walk = {"ok": bool(r.get("ok")), "s": round(time.time() - w0, 1), "keep": keep, "legs": legs,
                        "error": (r.get("error") or {}).get("message")}
                walks.append(walk)
                print(ref, rnd, "walk", len(walks), "ok" if walk["ok"] else walk["error"], flush=True)
                if walk["ok"]:
                    ok = True
                    break
                m = re.search(r"points \d+–(\d+)", walk["error"] or "")
                if not m:
                    break
                j = keep[int(m.group(1))]
                fails[j] = fails.get(j, 0) + 1
                if fails[j] >= 3:
                    skip.add(j)
            row = {"ref": ref, "round": rnd, "ok": ok, "s": round(time.time() - t0, 1), "skipped": sorted(skip),
                   "fails": fails, "walks": walks}
            with open(a.out / "rounds.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
