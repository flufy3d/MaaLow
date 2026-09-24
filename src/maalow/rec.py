"""`maalow rec`: screen recordings on the companion app, for replay teaching.

The app keeps recordings in the workspace's recordings/<id>/ (video.mp4 at a fixed 30 fps, meta.json, labels.json,
thumbs/). Labels are keyed by frame number; frame n is shown at n / 30 s. This module fetches them for the AI:
exact frames by number (with a coordinate grid, like `maalow do screen`) and a digest of the labels.
"""

from __future__ import annotations

import urllib.error
import urllib.parse
from pathlib import Path

from maalow.client import HOME, Client, grid_png

NAMES = {"rect": "框选", "circle": "圈", "arrow": "箭头", "click": "点击点", "region": "区域"}


def workspace_of(client: Client, workspace: str | None) -> str:
    if workspace:
        return workspace
    ws = client.get("/status").get("workspace")
    if not ws:
        raise RuntimeError("the app has no workspace; pass --workspace")
    return ws


def base(workspace: str, rid: str) -> str:
    return f"/recordings/{urllib.parse.quote(workspace)}/{urllib.parse.quote(rid)}"


def local_dir(root: Path, workspace: str, rid: str) -> Path:
    """recordings/<id> in the local workspace when there is one, else in ~/.maalow/cache."""
    ws = root / workspace if (root / workspace / "workspace.json").is_file() else HOME / "cache" / workspace
    return ws / "recordings" / rid


def resolve(client: Client, workspace: str, rid: str) -> str:
    """A recording id, or "latest" / a unique prefix of one."""
    recs = client.get(f"/recordings?workspace={urllib.parse.quote(workspace)}")
    if isinstance(recs, dict):
        raise RuntimeError(recs.get("error", recs))
    ids = [r["id"] for r in recs]
    if rid == "latest":
        ready = [r["id"] for r in recs if r.get("state") == "ready"]
        if not ready:
            raise RuntimeError(f"no recordings in {workspace}")
        return ready[0]
    if rid in ids:
        return rid
    hits = [i for i in ids if i.startswith(rid)]
    if len(hits) == 1:
        return hits[0]
    raise RuntimeError(f"no recording {rid!r} in {workspace}" if not hits else f"{rid!r} is ambiguous: {hits}")


def summary(meta: dict) -> dict:
    keep = ("id", "name", "note", "state", "started_at", "frames", "duration_ms", "fps", "width", "height", "size",
            "stopped_by")
    return {k: meta[k] for k in keep if k in meta}


def pull(client: Client, root: Path, workspace: str, rid: str, video: bool = True) -> dict:
    """Download meta.json, labels.json and (unless video=False) video.mp4 into the local workspace."""
    dest = local_dir(root, workspace, rid)
    b = base(workspace, rid)
    meta = client.get(b)
    if "error" in meta:
        raise RuntimeError(meta["error"])
    # byte-exact copies through the file API, so `maalow sync` sees them as the same files afterwards
    files = {}
    raw = f"/files/{urllib.parse.quote(workspace)}/recordings/{urllib.parse.quote(rid)}"
    for name in ("meta.json", "labels.json") + (("video.mp4",) if video else ()):
        try:
            files[name] = client.download(f"{raw}/{name}", dest / name, timeout=900)
        except urllib.error.HTTPError as e:
            if not (e.code == 404 and name == "labels.json"):  # no labels yet
                raise
    return {"workspace": workspace, "recording": rid, "dir": str(dest.resolve()),
            "files": {k: str(v.resolve()) for k, v in files.items()}}


def frame(client: Client, workspace: str, rid: str, n: int, fmt: str = "png") -> dict:
    """Exact frame n (decoded by the app) plus a copy with a coordinate grid; returns local paths."""
    ext = "png" if fmt == "png" else "jpg"
    dest = HOME / "cache" / workspace / "recordings" / rid / f"frame-{n:06d}.{ext}"
    client.download(f"{base(workspace, rid)}/frame?n={n}&fmt={fmt}&q=95", dest)
    view = dest.with_name(dest.stem + ".grid.png")
    grid_png(dest, view)
    return {"workspace": workspace, "recording": rid, "frame": n, "time_ms": round(n * 1000 / 30),
            "image": str(dest.resolve()), "view": str(view.resolve())}


def describe(a: dict, i: int) -> str:
    c = a.get("coords", [])
    kind = a.get("kind", "")
    where = {
        "click": lambda: f"({c[0]}, {c[1]})",
        "arrow": lambda: f"({c[0]}, {c[1]}) → ({c[2]}, {c[3]})",
    }.get(kind, lambda: f"x={c[0]} y={c[1]} w={c[2]} h={c[3]}")()
    label = a.get("label") or ""
    return f"{i}号{NAMES.get(kind, kind)} {where}" + (f"：{label}" if label else "")


def labels(client: Client, workspace: str, rid: str) -> dict:
    """What was marked on which frame: frame, time, note, annotations (coords in the 1080x720 frame space)."""
    b = base(workspace, rid)
    meta = client.get(b)
    if "error" in meta:
        raise RuntimeError(meta["error"])
    data = client.get(f"{b}/labels")
    if "error" in data:
        raise RuntimeError(data["error"])
    fps = data.get("fps") or meta.get("fps") or 30
    frames = []
    for key, e in sorted(data.get("frames", {}).items(), key=lambda kv: int(kv[0])):
        n = int(key)
        marks = e.get("annotations", [])
        frames.append({
            "frame": n,
            "time_ms": round(n * 1000 / fps),
            "note": e.get("note", ""),
            "annotations": [{"n": i, "kind": a["kind"], "coords": a["coords"], "label": a.get("label", "")}
                            for i, a in enumerate(marks, 1)],
            "text": [describe(a, i) for i, a in enumerate(marks, 1)],
        })
    return {"workspace": workspace, "recording": summary(meta), "size": [meta.get("width"), meta.get("height")],
            "labeled_frames": len(frames), "frames": frames}
