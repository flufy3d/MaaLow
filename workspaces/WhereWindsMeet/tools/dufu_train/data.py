"""Load the phase-2 rounds (data/p2/rNNN: trace.json + result.json + rec.txt) and build head windows.

One trace row = one backbone frame = one ring entry in dufu.js (the ring starts empty at the skill's start, so trace row
i is ring entry i). The head at row i sees rows max(0, i-29)..i, front-padded with the oldest kept row (dufu.js seqData
/ maalow.d.ts `extra.ring`), and runs only once MIN_RING rows are in the ring.
"""
from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

T, F, A = 30, 192, 15
D = F + A
MIN_RING = 12
FRAME_MS = 1000 / 30
AUX = ["dt", "since_parry", "since_dodge", "since_potion", "since_walk", "pressed", "since_ok", "hp", "qi", "boss",
       "lit", "mean", "dark3", "flare", "boss_up"]
AI = {k: i for i, k in enumerate(AUX)}


@dataclass
class Round:
    name: str
    path: Path
    start: int  # skill start, epoch ms
    phase: int
    wall: np.ndarray  # (N,) ms since start, the frame's loop time
    cap: np.ndarray  # (N,) capture ms since start (-1 unknown -> filled from wall)
    seq: np.ndarray  # (N,) stream seq
    aux: np.ndarray  # (N, 15) float32
    feat: np.ndarray  # (N, 192) float32
    events: list = field(default_factory=list)  # [wallMs, msSinceStart, kind, detail]
    reason: str | None = None
    rec: str | None = None

    @property
    def n(self) -> int:
        return len(self.wall)


def load_round(path: str | Path) -> Round | None:
    """None when the round is incomplete (no trace / result yet, or no feature column)."""
    path = Path(path)
    tp, rp = path / "trace.json", path / "result.json"
    if not tp.exists() or not rp.exists():
        return None
    try:
        chunks = json.loads(tp.read_text(encoding="utf-8"))
        res = json.loads(rp.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None  # still being written
    if not chunks:
        return None
    chunks = sorted(chunks, key=lambda c: c["chunk"])
    cols = chunks[0]["cols"]
    if "feat_f16_b64" not in cols:
        return None
    ci = {c: i for i, c in enumerate(cols)}
    rows = [r for c in chunks for r in c["rows"]]
    wall = np.array([r[ci["wall"]] for r in rows], np.float64)
    cap = np.array([r[ci["cap"]] for r in rows], np.float64)
    seq = np.array([r[ci["seq"]] for r in rows], np.int64)
    aux = np.array([[r[ci[k]] for k in AUX] for r in rows], np.float32)
    raw = b"".join(base64.b64decode(r[ci["feat_f16_b64"]]) for r in rows)
    feat = np.frombuffer(raw, "<f2").reshape(len(rows), F).astype(np.float32)
    # the capture clock is the better contact clock; an unknown one (-1) falls back to the loop time less the median lag
    ok = cap >= 0
    lag = float(np.median(wall[ok] - cap[ok])) if ok.any() else 0.0
    cap = np.where(ok, cap, wall - lag)
    v = res.get("value") or {}
    rec = (path / "rec.txt").read_text(encoding="utf-8").strip() if (path / "rec.txt").exists() else None
    return Round(name=path.name, path=path, start=int(chunks[0]["start"]), phase=int(chunks[0].get("phase", 0)),
                 wall=wall, cap=cap, seq=seq, aux=aux, feat=feat, events=v.get("events", []), reason=v.get("reason"),
                 rec=rec)


def scan(root: str | Path) -> list[Round]:
    """Every complete round under root (rNNN dirs), sorted by name."""
    out = []
    for p in sorted(Path(root).glob("r[0-9]*")):
        if p.is_dir():
            r = load_round(p)
            if r is not None and r.n > MIN_RING:
                out.append(r)
    return out


def window_index(n: int) -> np.ndarray:
    """(n, T) row indices of each row's head window, front-padded with the oldest kept row."""
    i = np.arange(n)[:, None]
    j = np.arange(T)[None, :] - (T - 1) + i  # i-29 .. i
    lo = np.maximum(i - (T - 1), 0)
    return np.maximum(j, lo)


def steps(r: Round) -> np.ndarray:
    """(N, 207) float32 per-row steps [feat | aux]."""
    return np.concatenate([r.feat, r.aux], axis=1).astype(np.float32)


def windows(r: Round, rows: np.ndarray | None = None) -> np.ndarray:
    """(len(rows), T, 207) head inputs (rows default: all rows the head ran on, i >= MIN_RING - 1)."""
    if rows is None:
        rows = np.arange(MIN_RING - 1, r.n)
    return steps(r)[window_index(r.n)[rows]]
