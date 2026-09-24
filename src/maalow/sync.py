"""`maalow sync`: bring a local workspace and its copy on the companion app in line, moving only changed files.

Files are compared by sha256 against a baseline, the state both sides agreed on after the last sync, kept outside
the workspace in ~/.maalow/sync/<server>/<ws>.json. Per path, with L / R / B the local, remote and baseline hashes
(None: no such file):

    L == R            nothing to do
    L == B            only the app changed it: pull (or delete locally)
    R == B            only the PC changed it: push (or delete on the app)
    otherwise         both changed it: a conflict, left alone unless --prefer local|remote

A delete is only ever planned for a path that is in the baseline, so a first sync never deletes anything. push and
pull apply one side of that plan and leave the rest (and its baseline) for later.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import time
import urllib.parse
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from maalow.client import HOME, Client

SYNC_HOME = HOME / "sync"
CONFIG_FILE = "workspace.json"
BATCH = ".batch.json"  # manifest entry of a batch upload (the app never lists dot files)
SCREENSHOTS = "teaching/**/*.png"
WATCH = ("workspace.json", "pipeline", "templates", "skills")
STORED = (".png", ".jpg", ".jpeg", ".zip")  # already compressed


def glob_re(pattern: str) -> re.Pattern:
    """A path glob: ** spans directories, * and ? stay within one; a bare name matches at any depth."""
    pattern = pattern.strip("/")
    if "/" not in pattern:
        pattern = "**/" + pattern
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif pattern[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(out + "(?:/.*)?")  # a directory pattern covers everything under it


class Filter:
    """Which workspace paths take part in a sync."""

    def __init__(self, exclude: list[str] = (), only: list[str] | None = None):
        self.exclude = [glob_re(p) for p in exclude]
        self.only = [p.strip("/") for p in only] if only else None

    def __call__(self, path: str) -> bool:
        parts = path.split("/")
        if any(p.startswith(".") or p == "__pycache__" for p in parts):
            return False
        if path.endswith((".grid.png", ".part")):  # grids are drawn locally, .part are unfinished downloads
            return False
        if self.only is not None and not any(path == p or path.startswith(p + "/") for p in self.only):
            return False
        return not any(r.fullmatch(path) for r in self.exclude)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def local_tree(root: Path, keep: Filter, cache: dict | None = None) -> dict[str, dict]:
    """{path: {size, mtime (ms), sha256}}; cache {path: [size, mtime, sha256]} skips rehashing untouched files."""
    cache = {} if cache is None else cache
    out = {}
    if not root.is_dir():
        return out
    for f in root.rglob("*"):
        rel = f.relative_to(root).as_posix()
        if not keep(rel) or not f.is_file():
            continue
        st = f.stat()
        size, mtime = st.st_size, st.st_mtime_ns // 1_000_000
        hit = cache.get(rel)
        digest = hit[2] if hit and hit[0] == size and hit[1] == mtime else sha256(f)
        cache[rel] = [size, mtime, digest]
        out[rel] = {"size": size, "mtime": mtime, "sha256": digest}
    for rel in [k for k in cache if k not in out]:
        del cache[rel]
    return out


@dataclass
class Plan:
    push: list[str] = field(default_factory=list)
    pull: list[str] = field(default_factory=list)
    delete_remote: list[str] = field(default_factory=list)
    delete_local: list[str] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # changes in the other direction, left for a later sync
    unchanged: int = 0
    settled: dict[str, str | None] = field(default_factory=dict)  # baseline after the plan is carried out

    def actions(self) -> int:
        return len(self.push) + len(self.pull) + len(self.delete_remote) + len(self.delete_local)


def _change(now: str | None, base: str | None) -> str:
    return "added" if base is None else "deleted" if now is None else "modified"


def plan(local: dict, remote: dict, base: dict[str, str], direction: str = "both", prefer: str | None = None,
         keep: Filter | None = None) -> Plan:
    """Decide what to do per path. local / remote: trees ({path: {"sha256": ...}}); base: {path: sha256}."""
    keep = keep or Filter()
    p = Plan()
    for path in sorted({*local, *remote, *base}):
        if not keep(path):
            continue
        lo, re_, b = (local.get(path) or {}).get("sha256"), (remote.get(path) or {}).get("sha256"), base.get(path)
        if lo == re_:
            p.unchanged += lo is not None
            p.settled[path] = lo
            continue
        if lo == b:
            side = "remote"
        elif re_ == b:
            side = "local"
        elif prefer:
            side = prefer
        else:
            p.conflicts.append({"path": path, "local": _change(lo, b), "remote": _change(re_, b)})
            continue
        if (side == "local" and direction == "pull") or (side == "remote" and direction == "push"):
            p.skipped.append(path)
            continue
        if side == "local":
            (p.push if lo is not None else p.delete_remote).append(path)
            p.settled[path] = lo
        else:
            (p.pull if re_ is not None else p.delete_local).append(path)
            p.settled[path] = re_
    return p


# ---- baseline


def state_file(server: str, workspace: str) -> Path:
    host = urllib.parse.urlsplit(server).netloc or server
    return SYNC_HOME / re.sub(r"[^A-Za-z0-9_.-]", "_", host) / f"{workspace}.json"


def load_state(path: Path) -> dict:
    if not path.is_file():
        return {"files": {}, "cache": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {"files": data.get("files", {}), "cache": data.get("cache", {})}


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


# ---- transfer


def push(client: Client, workspace: str, root: Path, paths: list[str], deletes: list[str], local: dict) -> dict:
    """One batch request: files (workspace.json first, so a new workspace can be created) + mtimes + deletes."""
    ordered = sorted(paths, key=lambda p: p != CONFIG_FILE)
    with tempfile.TemporaryDirectory() as tmp:
        zpath = Path(tmp) / "batch.zip"
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr(BATCH, json.dumps({"mtime": {p: local[p]["mtime"] for p in ordered}, "delete": deletes}))
            for rel in ordered:
                z.write(root / rel, rel, zipfile.ZIP_STORED if rel.lower().endswith(STORED) else zipfile.ZIP_DEFLATED)
        out = client.upload("POST", f"/files/{urllib.parse.quote(workspace)}", zpath, "application/zip")
    if "error" in out:
        return out
    bad = [e["path"] for e in out.get("files", []) if e["sha256"] != local[e["path"]]["sha256"]]
    return {"error": f"app wrote different content: {bad}"} if bad else out


def pull(client: Client, workspace: str, root: Path, paths: list[str], remote: dict) -> set[str]:
    """Fetch files as one zip and give them the app's mtimes; returns the paths received."""
    body = json.dumps({"paths": paths}).encode()
    with tempfile.TemporaryDirectory() as tmp:
        zpath = Path(tmp) / "pull.zip"
        with client._open("POST", f"/workspaces/{urllib.parse.quote(workspace)}/export.zip", body) as r, \
                open(zpath, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        with zipfile.ZipFile(zpath) as z:
            got = {rel for rel in z.namelist() if rel in remote}
            for rel in got:
                dest = root / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                part = dest.with_name(dest.name + ".part")
                with z.open(rel) as src, open(part, "wb") as f:
                    shutil.copyfileobj(src, f)
                part.replace(dest)
                mtime = remote[rel]["mtime"] / 1000
                os.utime(dest, (mtime, mtime))
    return got


def remote_tree(client: Client, workspace: str, keep: Filter) -> dict | None:
    """The app's file tree, or None when it has no such workspace."""
    out = client.get(f"/files/{urllib.parse.quote(workspace)}/")
    if isinstance(out, dict):
        if "no workspace" in out.get("error", ""):
            return None
        raise RuntimeError(out.get("error", out))
    return {e["path"]: e for e in out if keep(e["path"])}


def sync(client: Client, workspace: str, root: Path, direction: str = "both", prefer: str | None = None,
         exclude: list[str] = (), only: list[str] | None = None, dry_run: bool = False) -> dict:
    t0 = time.monotonic()
    base_dir = root / workspace
    keep = Filter(exclude, only)
    sfile = state_file(client.server, workspace)
    state = load_state(sfile)
    remote = remote_tree(client, workspace, keep)
    has_local = (base_dir / CONFIG_FILE).is_file()
    if remote is None and not has_local:
        return {"error": f"no workspace {workspace} here ({base_dir}) or on the app"}
    if remote is None and direction == "pull":
        return {"error": f"no workspace {workspace} on the app"}
    if not has_local and direction == "push":
        return {"error": f"no local workspace: {base_dir}"}
    local = local_tree(base_dir, keep, state["cache"])
    p = plan(local, remote or {}, state["files"], direction, prefer, keep)

    out = {
        "workspace": workspace,
        "direction": direction,
        "push": p.push,
        "pull": p.pull,
        "delete_remote": p.delete_remote,
        "delete_local": p.delete_local,
        "conflicts": p.conflicts,
        "skipped": p.skipped,
        "unchanged": p.unchanged,
        "bytes_up": sum(local[x]["size"] for x in p.push),
        "bytes_down": sum(remote[x]["size"] for x in p.pull),
    }
    if dry_run:
        out["dry_run"] = True
    else:
        if p.push or p.delete_remote:
            res = push(client, workspace, base_dir, p.push, p.delete_remote, local)
            if "error" in res:
                return {**out, "error": f"push failed: {res['error']}"}
        if p.pull:
            got = pull(client, workspace, base_dir, p.pull, remote)
            for rel in set(p.pull) - got:  # gone from the app meanwhile: keep the old baseline, decide next time
                del p.settled[rel]
        for rel in p.delete_local:
            (base_dir / rel).unlink(missing_ok=True)
        files = state["files"]
        for path, digest in p.settled.items():
            if digest is None:
                files.pop(path, None)
            else:
                files[path] = digest
        save_state(sfile, state)
    if p.conflicts:
        out["error"] = f"{len(p.conflicts)} conflict(s) left alone; rerun with --prefer local|remote"
    out["ms"] = round((time.monotonic() - t0) * 1000)
    return out


# ---- watch


def _snapshot(root: Path, paths: tuple[str, ...], keep: Filter) -> dict[str, tuple[int, int]]:
    snap = {}
    for p in paths:
        for f in [root / p, *(root / p).rglob("*")]:
            rel = f.relative_to(root).as_posix()
            if keep(rel) and f.is_file():
                st = f.stat()
                snap[rel] = (st.st_size, st.st_mtime_ns)
    return snap


def watch(client: Client, workspace: str, root: Path, emit, prefer: str | None = None, exclude: list[str] = (),
          paths: tuple[str, ...] = WATCH, interval: float = 0.25, settle: float = 0.15) -> None:
    """Push the watched files and directories now and after every change, until interrupted. emit(result) per push."""
    keep = Filter(exclude)
    emit(sync(client, workspace, root, "push", prefer, exclude, list(paths)))
    last = _snapshot(root / workspace, paths, keep)
    while True:
        time.sleep(interval)
        snap = _snapshot(root / workspace, paths, keep)
        if snap == last:
            continue
        while True:  # let an editor finish writing (save = truncate + write, or several files at once)
            time.sleep(settle)
            again = _snapshot(root / workspace, paths, keep)
            if again == snap:
                break
            snap = again
        last = snap
        try:
            emit(sync(client, workspace, root, "push", prefer, exclude, list(paths)))
        except Exception as e:  # the app restarting or the network dropping must not end the watch
            emit({"workspace": workspace, "error": f"{type(e).__name__}: {e}"})
