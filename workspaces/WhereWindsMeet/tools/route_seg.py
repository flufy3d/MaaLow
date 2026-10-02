"""Run a route node's route skill (CixinRoute unless node=NAME) over a part of the route:
route_seg.py FROM TO [start_x start_y] [node=NAME] [key=json ...] [out=path.json]."""
import json
import sys

from maalow.client import Client

rest = sys.argv[3:]
name = next((kv.split("=", 1)[1] for kv in rest if kv.startswith("node=")), "CixinRoute")
rest = [kv for kv in rest if not kv.startswith("node=")]
node = json.load(open("workspaces/WhereWindsMeet/pipeline/stronghold.json", encoding="utf8"))[name]
args = dict(node["custom_action_param"])
args["from"], args["to"] = int(sys.argv[1]), int(sys.argv[2])
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
r = Client().post("/skill/run", {"name": "route", "args": args, "timeout": 1_800_000}, timeout=1900)
if out:
    json.dump(r, open(out, "w", encoding="utf8"), ensure_ascii=False)
logs = r.pop("logs", [])
print(json.dumps({k: v for k, v in r.items() if k != "value"}, ensure_ascii=False))
for line in logs:
    if not line.startswith("{") and not line.startswith("legs "):
        print(line[:300])
print(json.dumps(r.get("value"), ensure_ascii=False)[:3000])
