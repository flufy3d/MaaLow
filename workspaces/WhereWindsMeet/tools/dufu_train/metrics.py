"""Trigger metrics in the scheduler's terms (dufu.js targetOf): S1 = fut1 mass of bins 1-5 (4-19 f), act at >= TRIG_TH.

coverage: share of contacts with S1 >= TRIG_TH on some head row 19..3 frames before the contact (capture clock).
false triggers: head rows (alive, not end-censored) with S1 >= TRIG_TH and no contact within the next FALSE_F frames,
per minute of those rows; `fte` counts runs of such rows (one run ~ one wasted press) per minute.
"""
from __future__ import annotations

import numpy as np

from data import FRAME_MS, MIN_RING

TRIG_TH = 0.45
COVER_LO_F, COVER_HI_F = 3, 19
FALSE_F = 25


def s1_of(fut1_probs: np.ndarray) -> np.ndarray:
    return fut1_probs[:, 1:6].sum(1)


def round_stats(cap: np.ndarray, s1: np.ndarray, w: np.ndarray, contacts, th: float = TRIG_TH) -> dict:
    """s1: (N,) with nan on rows the head did not run. w: label weights (0 = masked rows)."""
    n = len(cap)
    trig = np.nan_to_num(s1, nan=0.0) >= th
    ran = np.arange(n) >= MIN_RING - 1
    cov = {"hit": [0, 0], "ok": [0, 0], "dodge": [0, 0], "all": [0, 0]}
    for c in contacts:
        lead = (c.t - cap) / FRAME_MS
        m = ran & (lead >= COVER_LO_F) & (lead <= COVER_HI_F)
        if not m.any():
            continue  # too early in the round for the head
        hit = bool(trig[m].any())
        for k in (c.kind, "all") + (("dodge",) if c.dodge else ()):
            cov[k][0] += hit
            cov[k][1] += 1
    ct = np.array([c.t for c in contacts]) if contacts else np.zeros(0)
    live = ran & (w > 0)
    near = np.zeros(n, bool)
    for t in ct:
        lead = (t - cap) / FRAME_MS
        near |= (lead > 0) & (lead <= FALSE_F)
    false = live & trig & ~near
    runs = int(np.sum(false[1:] & ~false[:-1]) + (false[0] if n else 0))
    gaps = np.diff(cap, prepend=cap[0])
    minutes = float(np.sum(np.clip(gaps, 0, 200)[live])) / 60000
    return {"cov": cov, "false_rows": int(false.sum()), "false_runs": runs, "minutes": minutes}


def merge(stats: list[dict]) -> dict:
    cov = {k: [sum(s["cov"][k][0] for s in stats), sum(s["cov"][k][1] for s in stats)] for k in ("hit", "ok", "dodge", "all")}
    mins = sum(s["minutes"] for s in stats)
    out = {f"cov_{k}": (v[0] / v[1] if v[1] else None) for k, v in cov.items()}
    out.update({f"n_{k}": v[1] for k, v in cov.items()})
    out["false_rows_per_min"] = sum(s["false_rows"] for s in stats) / mins if mins else None
    out["false_runs_per_min"] = sum(s["false_runs"] for s in stats) / mins if mins else None
    out["minutes"] = mins
    return out


def fmt(m: dict) -> str:
    def p(x):
        return "-" if x is None else f"{100 * x:.1f}%"
    return (f"cov all {p(m['cov_all'])} (n {m['n_all']}) hit {p(m['cov_hit'])} ({m['n_hit']}) ok {p(m['cov_ok'])} ({m['n_ok']}) "
            f"dodge {p(m['cov_dodge'])} ({m['n_dodge']}) | false rows/min {m['false_rows_per_min'] or 0:.1f} "
            f"runs/min {m['false_runs_per_min'] or 0:.1f} | {m['minutes']:.1f} min")
