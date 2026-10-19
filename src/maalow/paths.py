"""Where things live on the PC: the app cache, local workspaces, and their config file."""

from __future__ import annotations

from pathlib import Path

HOME = Path.home() / ".maalow"
CONFIG_FILE = "workspace.json"


def workspace_dir(root: Path | None, name: str) -> Path:
    return Path(root) / name if root is not None else HOME / "cache" / name


def is_workspace(path: Path) -> bool:
    return (Path(path) / CONFIG_FILE).is_file()


def local_base(root: Path | None, workspace: str) -> Path:
    """Where the app's workspace files land on the PC: the local workspace when there is one, else the cache."""
    local = workspace_dir(root, workspace)
    return local if is_workspace(local) else HOME / "cache" / workspace
