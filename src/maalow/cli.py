"""Command line entry point."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

from maalow import __version__
from maalow.skills import registry
from maalow.workspace import Workspace

DEFAULT_SERVER = "http://127.0.0.1:8765"


def _request(server: str, path: str, body: dict | None = None, timeout: float = 120):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(server + path, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


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


def _add_do_parser(sub) -> None:
    p_do = sub.add_parser("do", help="send a teaching action to a running teach server")
    p_do.add_argument("--server", default=DEFAULT_SERVER)
    ops = p_do.add_subparsers(dest="op", required=True)

    def op(name: str, help: str):
        p = ops.add_parser(name, help=help)
        p.add_argument("--say", default="", help="the teacher's instruction for this step")
        p.add_argument("--wait", type=int, default=1500, help="ms to wait before the after-screenshot")
        return p

    ops.add_parser("shot", help="take a screenshot")
    ops.add_parser("state", help="show server state")
    ops.add_parser("task", help="start a new teaching task").add_argument("name")
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="maalow", description="Teachable low-code automation on MaaFramework.")
    parser.add_argument("--version", action="version", version=f"maalow {__version__}")
    parser.add_argument("--root", type=Path, default=Path("workspaces"), help="workspaces root directory")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="create a new workspace")
    p_init.add_argument("name")
    p_init.add_argument("--target", default="", help="adb address")
    p_init.add_argument("--package", default="", help="android package")

    sub.add_parser("list", help="list workspaces")
    sub.add_parser("skills", help="list registered skills")

    p_teach = sub.add_parser("teach", help="connect the device and run the teaching server")
    p_teach.add_argument("workspace")
    p_teach.add_argument("--task", default="explore")
    p_teach.add_argument("--target", help="override and save the adb address")
    p_teach.add_argument("--adb", help="adb executable path")
    p_teach.add_argument("--host", action="append", help="address to listen on; repeatable (default 127.0.0.1)")
    p_teach.add_argument("--port", type=int, default=8765)

    _add_do_parser(sub)

    args = parser.parse_args(argv)

    if args.command == "init":
        ws = Workspace.create(args.root, args.name)
        ws.config.target, ws.config.package = args.target, args.package
        ws.save()
        print(f"created workspace: {ws.path}")
    elif args.command == "list":
        for name in Workspace.list(args.root):
            print(name)
    elif args.command == "skills":
        for name in registry.names():
            print(name)
    elif args.command == "teach":
        from maalow.device import Device
        from maalow.teaching.server import TeachingServer

        ws = Workspace.open(args.root / args.workspace)
        if args.target:
            ws.config.target = args.target
            ws.save()
        device = Device(ws.config.target, args.adb)
        print(f"connecting {ws.config.target} ...", flush=True)
        device.connect()
        TeachingServer(ws, device, args.task).serve(tuple(args.host or ["127.0.0.1"]), args.port)
    elif args.command == "do":
        if args.op == "state":
            out = _request(args.server, "/state")
        elif args.op == "shot":
            out = _request(args.server, "/shot", {})
        elif args.op == "say":
            out = _request(args.server, "/say", {"text": args.text})
        elif args.op == "listen":
            out = _request(args.server, f"/listen?timeout={args.timeout}", timeout=args.timeout + 30)
        elif args.op == "run":
            out = _request(args.server, "/run", {"node": args.node, "once": not args.full}, timeout=900)
        elif args.op == "task":
            out = _request(args.server, "/task", {"name": args.name})
        else:
            out = _request(args.server, "/act", {"action": _action(args), "say": args.say, "wait": args.wait})
        print(json.dumps(out, ensure_ascii=False))
        return 1 if isinstance(out, dict) and "error" in out else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
