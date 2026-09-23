"""Command line entry point."""

from __future__ import annotations

import argparse
from pathlib import Path

from maalow import __version__
from maalow.skills import registry
from maalow.workspace import Workspace


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="maalow", description="Teachable low-code automation on MaaFramework.")
    parser.add_argument("--version", action="version", version=f"maalow {__version__}")
    parser.add_argument("--root", type=Path, default=Path("workspaces"), help="workspaces root directory")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="create a new workspace")
    p_init.add_argument("name")

    sub.add_parser("list", help="list workspaces")
    sub.add_parser("skills", help="list registered skills")

    args = parser.parse_args(argv)

    if args.command == "init":
        ws = Workspace.create(args.root, args.name)
        print(f"created workspace: {ws.path}")
    elif args.command == "list":
        for name in Workspace.list(args.root):
            print(name)
    elif args.command == "skills":
        for name in registry.names():
            print(name)
    return 0
