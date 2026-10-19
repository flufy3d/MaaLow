"""Turn screenshots and recordings the app sends into local files and markdown-ish digests for the AI."""

from __future__ import annotations

import re
from pathlib import Path

from maalow import rec
from maalow.client import Client
from maalow.paths import local_base


def with_views(client: Client, root: Path, out):
    """Add local paths to every screenshot the app mentions, so the AI can look at it.

    A shot gets its image plus a copy with the coordinate grid and annotations; a recording gets its length, label
    digest and, when it has a focus, the local path of the focus frame.
    """
    if isinstance(out, list):
        return [with_views(client, root, m) for m in out]
    if not isinstance(out, dict) or "error" in out:
        return out
    ws = out.get("workspace")
    if out.get("attachments"):
        if not ws:
            return {**out, "error": "app response has attachments but no workspace"}
        out = {**out, "attachments": [expand(client, root, ws, a) for a in out["attachments"]]}
    elif out.get("screenshot"):
        if not ws:
            return {**out, "error": "app response has a screenshot but no workspace"}
        out = {**out, **client.fetch(ws, out["screenshot"], root)}
    return out


def expand(client: Client, root: Path, ws: str, a: dict) -> dict:
    try:
        if a.get("type") == "shot":
            got = client.fetch(ws, a["file"], root, annotations=a.get("annotations"))
            marks = [rec.describe(m, i) for i, m in enumerate(a.get("annotations") or [], 1)]
            return {**a, "image": got["image"], "view": got["view"], **({"marks": marks} if marks else {})}
        if a.get("type") == "recording":
            digest = rec.labels(client, ws, a["rec"])
            info = digest["recording"]
            out = {**a, "name": info.get("name", ""), "frames": info.get("frames"), "fps": info.get("fps", 30),
                   "labels": [{k: f[k] for k in ("frame", "time_ms", "note", "text")} for f in digest["frames"]]}
            if a.get("focus"):
                out["view"] = rec.frame(client, ws, a["rec"], a["focus"]["from"])["view"]
            return out
    except Exception as e:  # a deleted recording or screenshot: say so, keep the rest of the message
        return {**a, "error": f"{type(e).__name__}: {e}"}
    return a


def local_to_app(root: Path, ws: str | None, a: dict) -> dict:
    """A shot attachment may name a local copy (image or view from listen or shot): turn it into the app's path."""
    f = a.get("file", "")
    if a.get("type") != "shot" or not ws or not Path(f).is_absolute():
        return a
    try:
        rel = Path(f).resolve().relative_to(local_base(root, ws).resolve()).as_posix()
    except ValueError as e:
        raise ValueError(f"screenshot is outside workspace {ws}: {f} (use `maalow do shot` for an attachable one)") from e
    return {**a, "file": re.sub(r"\.(grid|marks)\.png$", ".png", rel)}
