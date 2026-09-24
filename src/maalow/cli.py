"""Command line entry point."""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

from maalow import __version__
from maalow.client import HOME, Client, grid_png
from maalow.skills import registry
from maalow.workspace import Workspace


def _action(args: argparse.Namespace) -> dict:
    op = args.op
    if op == "click":
        return {"type": "click", "x": args.x, "y": args.y}
    if op == "swipe":
        return {"type": "swipe", "x1": args.x1, "y1": args.y1, "x2": args.x2, "y2": args.y2, "duration": args.duration}
    if op == "key":
        return {"type": "key", "code": args.code}
    if op == "text":
        return {"type": "text", "text": args.text}
    if op == "wait":
        return {"type": "wait", "ms": args.ms}
    return {"type": op}  # back, home, start_app, stop_app


def _add_server_args(p) -> None:
    p.add_argument("--server", help="app address, e.g. http://100.123.41.110:8765 (default: $MAALOW_SERVER or ~/.maalow/config.toml)")
    p.add_argument("--token", help="API token (default: $MAALOW_TOKEN or ~/.maalow/config.toml)")


def _add_do_parser(sub) -> None:
    p_do = sub.add_parser("do", help="teaching actions on the companion app")
    _add_server_args(p_do)
    ops = p_do.add_subparsers(dest="op", required=True)

    def op(name: str, help: str):
        p = ops.add_parser(name, help=help)
        p.add_argument("--say", default="", help="the teacher's instruction for this step")
        p.add_argument("--wait", type=int, default=1500, help="ms to wait before the after-screenshot")
        return p

    ops.add_parser("shot", help="take a screenshot")
    ops.add_parser("screen", help="look at the current screen without recording it")
    ops.add_parser("state", help="show server state")
    ops.add_parser("status", help="show device, engine and automation status")
    p = ops.add_parser("task", help="start a new teaching task")
    p.add_argument("name")
    p.add_argument("--workspace", help="switch the session to another workspace")
    p = ops.add_parser("run", help="run a learned pipeline node")
    p.add_argument("node")
    p.add_argument("--full", action="store_true", help="run the whole task instead of checking the current screen once")
    ops.add_parser("say", help="reply to the teacher in the web UI").add_argument("text")
    ops.add_parser("listen", help="wait for teacher messages").add_argument("--timeout", type=int, default=1800)
    p = op("click", "tap a point")
    p.add_argument("x", type=int)
    p.add_argument("y", type=int)
    p = op("swipe", "swipe between two points")
    for a in ("x1", "y1", "x2", "y2"):
        p.add_argument(a, type=int)
    p.add_argument("--duration", type=int, default=300)
    op("key", "press an android keycode").add_argument("code", type=int)
    op("text", "input text").add_argument("text")
    op("wait", "just wait, then screenshot").add_argument("ms", type=int)
    for name in ("back", "home", "start_app", "stop_app"):
        op(name, name.replace("_", " "))


def _add_ws_parser(sub) -> None:
    p_ws = sub.add_parser("ws", help="workspaces on the companion app")
    _add_server_args(p_ws)
    ops = p_ws.add_subparsers(dest="op", required=True)
    ops.add_parser("list", help="list workspaces on the app")
    p = ops.add_parser("import", help="copy a local workspace (--root/NAME) into the app")
    p.add_argument("name")
    p.add_argument("--mode", choices=("merge", "replace"), default="merge",
                   help="merge: add and overwrite files; replace: the app copy becomes exactly the local one")
    p.add_argument("--no-teaching", action="store_true", help="leave out teaching records and screenshots")
    p = ops.add_parser("export", help="download a workspace from the app as a zip")
    p.add_argument("name")
    p.add_argument("-o", "--out", type=Path, help="zip path (default: NAME.zip)")
    p.add_argument("--extract", type=Path, help="also unpack into this directory (e.g. workspaces/NAME)")


def _with_views(client: Client, root: Path, out):
    """Fetch screenshots the app mentions and add local paths (view: grid image) for the AI to look at."""
    if isinstance(out, list):
        return [_with_views(client, root, m) for m in out]
    if not isinstance(out, dict) or "error" in out:
        return out
    ws = out.get("workspace")
    if ws is None and (out.get("screenshot") or out.get("note")):
        ws = client.get("/state").get("workspace")
    if out.get("note"):
        out = {**out, "view": client.fetch(ws, out["note"], root, grid=False)["image"]}
    elif out.get("screenshot"):
        out = {**out, **client.fetch(ws, out["screenshot"], root)}
    return out


def _do(args, client: Client):
    op = args.op
    if op == "state":
        return client.get("/state")
    if op == "status":
        return client.get("/status")
    if op == "screen":
        dest = client.download("/screen?fmt=png", HOME / "cache" / "screen.png")
        grid_png(dest, dest.with_suffix(".grid.png"))
        return {"image": str(dest), "view": str(dest.with_suffix(".grid.png"))}
    if op == "shot":
        return _with_views(client, args.root, client.post("/shot"))
    if op == "say":
        return client.post("/say", {"text": args.text})
    if op == "listen":
        return _with_views(client, args.root, client.get(f"/listen?timeout={args.timeout}", timeout=args.timeout + 30))
    if op == "run":
        return _with_views(client, args.root, client.post("/run", {"node": args.node, "once": not args.full}, timeout=900))
    if op == "task":
        return client.post("/task", {"name": args.name, **({"workspace": args.workspace} if args.workspace else {})})
    body = {"action": _action(args), "say": args.say, "wait": args.wait}
    return _with_views(client, args.root, client.post("/act", body))


def _ws(args, client: Client):
    if args.op == "list":
        return client.get("/workspaces")
    if args.op == "import":
        src = args.root / args.name
        if not (src / "workspace.json").is_file():
            return {"error": f"no local workspace: {src}"}
        return client.import_dir(args.name, src, args.mode, teaching=not args.no_teaching)
    out = args.out or Path(f"{args.name}.zip")
    client.export_zip(args.name, out)
    result = {"zip": str(out.resolve())}
    if args.extract:
        with zipfile.ZipFile(out) as z:
            z.extractall(args.extract)
            result |= {"extracted": str(args.extract.resolve()), "files": len(z.namelist())}
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="maalow", description="Teachable low-code automation on MaaFramework.")
    parser.add_argument("--version", action="version", version=f"maalow {__version__}")
    parser.add_argument("--root", type=Path, default=Path("workspaces"), help="workspaces root directory")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="create a new workspace")
    p_init.add_argument("name")
    p_init.add_argument("--package", default="", help="android package")

    sub.add_parser("list", help="list workspaces")
    sub.add_parser("skills", help="list registered skills")

    _add_do_parser(sub)
    _add_ws_parser(sub)

    args = parser.parse_args(argv)

    if args.command == "init":
        ws = Workspace.create(args.root, args.name)
        ws.config.package = args.package
        ws.save()
        print(f"created workspace: {ws.path}")
    elif args.command == "list":
        for name in Workspace.list(args.root):
            print(name)
    elif args.command == "skills":
        for name in registry.names():
            print(name)
    elif args.command in ("do", "ws"):
        client = Client(args.server, args.token)
        out = (_do if args.command == "do" else _ws)(args, client)
        print(json.dumps(out, ensure_ascii=False))
        return 1 if isinstance(out, dict) and "error" in out else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
