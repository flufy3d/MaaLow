"""Run a stronghold's route (route.js with its config; cixin unless stronghold=ID) over a part of it:
route_seg.py FROM TO [start_x start_y] [stronghold=ID] [key=json ...] [out=path.json]
(e.g. check=true nodo=true: stop at every point and read where(), leave the actions out)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import strongholds as sh  # noqa: E402

rest = sys.argv[3:]
name = next((kv.split("=", 1)[1] for kv in rest if kv.startswith(("stronghold=", "node="))), "cixin")
rest = [kv for kv in rest if not kv.startswith(("stronghold=", "node="))]
args = {"from": int(sys.argv[1]), "to": int(sys.argv[2])}
if len(rest) >= 2 and "=" not in rest[0]:
    args["start"] = [float(rest[0]), float(rest[1])]
    rest = rest[2:]
out = None
for kv in rest:
    k, v = kv.split("=", 1)
    if k == "out":
        out = v
    else:
        args[k] = json.loads(v)
r = sh.route(name, **args)
if out:
    json.dump(r, open(out, "w", encoding="utf8"), ensure_ascii=False)
logs = r.pop("logs", [])
print(json.dumps({k: v for k, v in r.items() if k != "value"}, ensure_ascii=False))
for line in logs:
    if not line.startswith("{") and not line.startswith("legs "):
        print(line[:300])
print(json.dumps(r.get("value"), ensure_ascii=False)[:3000])
