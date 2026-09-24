"""Command line entry point."""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

from maalow import __version__
from maalow import rec, sync
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
    p = ops.add_parser("skill", help="run a skill (skills/NAME.js) on the app")
    p.add_argument("name")
    p.add_argument("--args", type=json.loads, default={}, help="arguments as JSON, e.g. '{\"rounds\": 20}'")
    p.add_argument("--workspace", help="workspace on the app (default: the app's)")
    p.add_argument("--timeout", type=int, help="ms, instead of the skill's meta.timeout")
    p.add_argument("--no-wait", action="store_true", help="start it and return at once")
    ops.add_parser("skills", help="list the app's skills and their load errors").add_argument("--workspace")
    ops.add_parser("stop", help="stop the running task or skill")
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


def _add_rec_parser(sub) -> None:
    p_rec = sub.add_parser("rec", help="screen recordings on the companion app (replay teaching)")
    _add_server_args(p_rec)
    p_rec.add_argument("--workspace", help="workspace on the app (default: the app's)")
    ops = p_rec.add_subparsers(dest="op", required=True)
    p = ops.add_parser("start", help="start recording the tablet screen (at most 3 minutes)")
    p.add_argument("--name", help="recording name")
    p.add_argument("--note", help="a note on the recording")
    p.add_argument("--bitrate", type=int, help="bits per second (default: the app's, 3000000)")
    ops.add_parser("stop", help="stop recording and wait until it is saved")
    ops.add_parser("list", help="list recordings")
    ops.add_parser("status", help="recording state")
    p = ops.add_parser("pull", help="download a recording (meta, labels, video) into the local workspace")
    p.add_argument("id", help="recording id, a unique prefix of one, or 'latest'")
    p.add_argument("--no-video", action="store_true", help="only meta.json and labels.json")
    p = ops.add_parser("frame", help="exact frame N as an image, plus a copy with a coordinate grid")
    p.add_argument("id", help="recording id, a unique prefix of one, or 'latest'")
    p.add_argument("--n", type=int, required=True, help="frame number (frame N is at N / 30 s)")
    p.add_argument("--fmt", choices=("png", "jpg"), default="png")
    p = ops.add_parser("labels", help="what was marked on which frame, as JSON")
    p.add_argument("id", help="recording id, a unique prefix of one, or 'latest'")


def _rec(args, client: Client):
    if args.op == "status":
        return client.get("/record")
    if args.op == "stop":
        out = client.post("/record/stop", timeout=300)
        return out if "error" in out else rec.summary(out)
    ws = rec.workspace_of(client, args.workspace)
    if args.op == "start":
        body = {"workspace": ws} | {k: v for k, v in (("name", args.name), ("note", args.note), ("bitrate", args.bitrate)) if v}
        return client.post("/record/start", body)
    if args.op == "list":
        out = client.get(f"/recordings?workspace={ws}")
        return [rec.summary(r) for r in out] if isinstance(out, list) else out
    rid = rec.resolve(client, ws, args.id)
    if args.op == "pull":
        return rec.pull(client, args.root, ws, rid, video=not args.no_video)
    if args.op == "frame":
        return rec.frame(client, ws, rid, args.n, args.fmt)
    return rec.labels(client, ws, rid)


def _add_sync_parser(sub) -> None:
    p = sub.add_parser("sync", help="sync a local workspace (--root/NAME) with the app, moving only changed files")
    _add_server_args(p)
    p.add_argument("name")
    way = p.add_mutually_exclusive_group()
    way.add_argument("--push", dest="direction", action="store_const", const="push", help="only send local changes")
    way.add_argument("--pull", dest="direction", action="store_const", const="pull", help="only fetch app changes")
    way.add_argument("--watch", action="store_true",
                     help="keep pushing workspace.json, pipeline/, templates/ and skills/ whenever they change")
    p.set_defaults(direction="both")
    p.add_argument("--prefer", choices=("local", "remote"), help="settle conflicts (both sides changed a file) this way")
    p.add_argument("--dry-run", action="store_true", help="only print the plan")
    p.add_argument("--exclude", action="append", default=[], metavar="GLOB",
                   help="leave out matching paths (repeatable; ** spans directories), e.g. 'memory/**'")
    p.add_argument("--screenshots", action="store_true", help=f"include {sync.SCREENSHOTS} (left out by default)")
    p.add_argument("--videos", action="store_true",
                   help="include recording videos and thumbnails (left out by default; meta.json and labels.json always sync)")


def _sync(args, client: Client) -> int:
    exclude = args.exclude + ([] if args.screenshots else [sync.SCREENSHOTS]) + ([] if args.videos else list(sync.VIDEOS))
    if args.watch:
        def emit(out):
            print(json.dumps(out, ensure_ascii=False), flush=True)

        try:
            sync.watch(client, args.name, args.root, emit, args.prefer, exclude)
        except KeyboardInterrupt:
            pass
        return 0
    try:
        out = sync.sync(client, args.name, args.root, args.direction, args.prefer, exclude, dry_run=args.dry_run)
    except Exception as e:  # network or app errors, as JSON like everything else
        out = {"workspace": args.name, "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(out, ensure_ascii=False))
    return 1 if "error" in out else 0


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
    if op == "skill":
        body = {"name": args.name, "args": args.args, "wait": not args.no_wait}
        body |= {k: v for k, v in (("workspace", args.workspace), ("timeout", args.timeout)) if v}
        timeout = (args.timeout or 600_000) / 1000 + 60
        return client.post("/skill/run", body, timeout=timeout)
    if op == "skills":
        return client.get("/skills" + (f"?workspace={args.workspace}" if args.workspace else ""))
    if op == "stop":
        return client.post("/stop")
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
    _add_rec_parser(sub)
    _add_sync_parser(sub)

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
    elif args.command == "sync":
        return _sync(args, Client(args.server, args.token))
    elif args.command == "rec":
        client = Client(args.server, args.token)
        try:
            out = _rec(args, client)
        except Exception as e:  # network or app errors, as JSON like everything else
            out = {"error": f"{type(e).__name__}: {e}"}
        print(json.dumps(out, ensure_ascii=False))
        return 1 if isinstance(out, dict) and "error" in out else 0
    elif args.command in ("do", "ws"):
        client = Client(args.server, args.token)
        out = (_do if args.command == "do" else _ws)(args, client)
        print(json.dumps(out, ensure_ascii=False))
        return 1 if isinstance(out, dict) and ("error" in out or out.get("ok") is False) else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
