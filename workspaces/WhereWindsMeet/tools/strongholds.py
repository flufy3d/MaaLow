"""Stronghold configs: pipeline/stronghold_<id>.json, each one node (the one-click run, named like the id with a
capital: Cixin, Foye, Jiurou) whose param {stronghold: <config>} is all the stronghold's own data (see
skills/stronghold.js): id, title, card, stone, label, k, zoom, tracker, locate, checks, points. The PC tools read them
here and pass them to the app's skills; adding a stronghold is adding one of these files (rec_route.py emit writes it).

    uv run python workspaces/WhereWindsMeet/tools/strongholds.py list | show <id> | teleport <id>
"""

import json
from pathlib import Path

WS = Path(__file__).resolve().parents[1]
PIPE = WS / "pipeline"


def sid(name: str) -> str:
    """The stronghold id from a name as typed: Jiurou, jiurou, JiurouRoute -> jiurou."""
    n = name[:-5] if name.endswith("Route") else name[:-8] if name.endswith("Teleport") else name
    return n.lower()


def path(name: str) -> Path:
    return PIPE / f"stronghold_{sid(name)}.json"


def node_name(name: str) -> str:
    s = sid(name)
    return s[0].upper() + s[1:]


def load(name: str) -> dict:
    """The stronghold's config."""
    doc = json.load(open(path(name), encoding="utf-8"))
    return doc[node_name(name)]["custom_action_param"]["stronghold"]


def save(cfg: dict, desc: str) -> Path:
    """The config as its one-click node, pipeline/stronghold_<id>.json (replacing the file)."""
    p = path(cfg["id"])
    node = {"desc": desc, "recognition": "DirectHit", "action": "Custom", "custom_action": "stronghold",
            "custom_action_param": {"stronghold": cfg}}
    json.dump({node_name(cfg["id"]): node}, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=4)
    open(p, "a", encoding="utf-8").write("\n")
    return p


def all_ids() -> list[str]:
    return sorted(p.stem[len("stronghold_"):] for p in PIPE.glob("stronghold_*.json"))


def run_skill(name: str, args: dict, ms: int = 1_800_000) -> dict:
    from maalow.client import Client

    return Client().post("/skill/run", {"name": name, "args": args, "timeout": ms}, timeout=ms / 1000 + 100)


def teleport(name: str) -> dict:
    """To the stronghold's stone (the one-click run's teleport part, no route)."""
    return run_skill("stronghold", {"stronghold": load(name), "route": False}, 300_000)


def route(name: str, **args) -> dict:
    """route.js with the stronghold's config, and args over it (from, to, check, nodo, skip, start, points…)."""
    return run_skill("route", {"stronghold": load(name), **args})


if __name__ == "__main__":
    import sys

    # strongholds.py list | teleport <id> | show <id>
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    if cmd == "list":
        for i in all_ids():
            c = load(i)
            print(i, c["title"], f"{len(c['points'])} points, checks {c.get('checks')}, k {c.get('k')}")
    elif cmd == "teleport":
        r = teleport(sys.argv[2])
        print(json.dumps({"ok": r.get("ok"), "value": r.get("value"), "error": (r.get("error") or {}).get("message")}, ensure_ascii=False))
    elif cmd == "show":
        print(json.dumps({k: v for k, v in load(sys.argv[2]).items() if k != "points"}, ensure_ascii=False, indent=1))
