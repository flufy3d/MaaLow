"""Shared paths and helpers for the 独夫 move-ID data base (see README.md).

Rounds: data/p2/rNNN is primary; data/p2b/rNNN only adds rounds whose recording id is not already in data/p2.
Phase 1 (MOVEID_PHASE=1, 2026-10-26) lives under data/moveid/p1 and reads data/p1/rNNN, so phase 2 is untouched.
Trace reading and contact labels come from ../dufu_train (data.py / labels.py), unchanged.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
sys.path.insert(0, str(HERE.parent / "dufu_train"))

WS = "WhereWindsMeet"
DATA = REPO / "data"
PHASE = int(os.environ.get("MOVEID_PHASE", "2"))
OUT = DATA / "moveid" / ("" if PHASE == 2 else f"p{PHASE}")
VIDEO = OUT / "video"
META = OUT / "meta"
BARS = OUT / "bars"
STATUS = OUT / "pull_status.json"
LOCAL_RECS = REPO / "workspaces" / WS / "recordings"
ROUND_ROOTS = [DATA / f"p{PHASE}"] if PHASE != 2 else [DATA / "p2", DATA / "p2b"]
FRAME_MS = 1000 / 30


def rounds() -> list[dict]:
    """[{key, dir, rec}] in pull order (p2 by round number, then p2b extras), one per recording id."""
    out, seen = [], set()
    for root in ROUND_ROOTS:
        for p in sorted(root.glob("r[0-9]*")):
            f = p / "rec.txt"
            if not p.is_dir() or not f.exists():
                continue
            rid = f.read_text(encoding="utf-8").strip()
            if not rid or rid in seen:
                continue
            seen.add(rid)
            out.append({"key": f"{root.name}/{p.name}", "dir": p, "rec": rid})
    return out


def read_json(path: Path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, obj, indent: int | None = 1) -> None:
    """Atomic write (temp file + replace), so readers never see half a file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=indent)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
