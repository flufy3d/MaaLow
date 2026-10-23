"""Contacts and per-row targets for the phase-2 head, in the head's own units (frames at 30 fps).

Contacts (one boss blow reaching us):
  hit: an hp drop. The scheduler's own `hit` mark (hpBase logic: >= 2.5 % at once, grey-bar overreads ignored) is at
       the loop of the first row that read the lower bar. The bar dropped between the previous row's capture and this
       one (midpoint taken, rows are ~40 ms apart); contact = that - HIT_LAG_F frames (the hit lands ~5 f before the
       bar shows the drop; phase-1 definition, old docs/dufu-models.md; check_align.py / video sheets agree).
  ok:  a 卸势 ok = a boss 真气 step (8..80 px, read >= 4 before) while our last 卸势 press is <= OK_PARRY_MAX_F frames old
       (our own offence also takes 真气; those steps come without a fresh 卸势). contact = the step (same midpoint)
       - OK_LAG_F (the bar shows the step with the clash).
  A hit and an ok within MERGE_F frames are one contact (the hit wins).
Dodge: a contact with a 金光 flare (the image rule, aux `flare`) whose episode began FLARE_MIN_F..FLARE_MAX_F frames
before it wants a dodge (def 2); every other contact a 卸势 (def 1). Phase 2 has no curtain (def 3 never).
outcome=True (train.py --def-from-outcome): the def of a non-flare contact comes from what our presses got.
  ok -> 卸势. A hit with one of our 卸势 presses PF_LO_F..PF_HI_F frames before the contact (wall clock; 96 % of the
  ok contacts have one there, the ok presses peak at 6-12 f) is "parry fails" -> dodge. Any other hit (no timely
  press) is unknown: def weight 0 for the rows whose k-th contact it is (fut targets unchanged). A hit that is a tick
  of a grab cutscene (a hit chain, gaps <= CHAIN_MS, first gap GRAB_GAP0, next two GRAB_GAPN: we are held, nothing
  answers it) is unknown too, presses or not.

Rows: t_i = the row's capture time. fut_k = frames from t_i to the k-th contact after it (> 0), binned like the head
(FUT_BINS, > 60 -> none). fut1f = Gaussian (sigma 1 f) over 1..45 f, else none. def_k = the k-th contact's defense, or
none (0) when fut_k is none. Weights: rows after the killing blow (dead rounds) and rows whose 60-f horizon runs past a
non-dead trace end get 0; rows with a dodge press or an unanswered flare episode ahead (a dodged blow is invisible, so
"no contact" there is unsure) get W_UNSURE.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from data import AI, FRAME_MS, Round

HIT_LAG_F = 5.0
OK_LAG_F = 0.0
OK_PARRY_MAX_F = 24.0
QI_STEP, QI_JUMP = 8, 80
MERGE_F = 6.0
FLARE_GAP_MS = 600  # flare rows closer than this: one episode
FLARE_MIN_F, FLARE_MAX_F = 2.0, 30.0
W_UNSURE = 0.3
PF_LO_F, PF_HI_F = 4.0, 15.0
CHAIN_MS, GRAB_GAP0, GRAB_GAPN = 1600, (1250, 1550), (600, 850)
HORIZON_F = 60
# fut bins (frames, inclusive upper ends), the 11th = none
FUT_HI = [3, 6, 9, 12, 15, 19, 24, 30, 40, 60]
NONE_BIN = 10
DEF_NONE, DEF_PARRY, DEF_DODGE = 0, 1, 2


@dataclass
class Contact:
    row: int  # the row that first showed it
    t: float  # contact time, capture clock (ms since start)
    kind: str  # "hit" | "ok"
    dodge: bool = False  # a 金光 flare contact
    outcome: str = ""  # "ok" | "pf" (hit despite a timely 卸势) | "unk" (hit, no timely 卸势) | "grab" (grab tick)


def _row_at(r: Round, ms: float) -> int:
    """The first row whose loop time is >= ms (marks are stamped just before the row's aux is built)."""
    i = int(np.searchsorted(r.wall, ms - 3, side="left"))
    return min(i, r.n - 1)


def _seen(r: Round, i: int) -> float:
    """When a change first shown by row i happened: between the previous row's capture and this one (midpoint)."""
    return float(r.cap[i]) if i == 0 else float(r.cap[i - 1] + r.cap[i]) / 2


def flare_onsets(r: Round) -> list[float]:
    rows = np.where(r.aux[:, AI["flare"]] > 0.5)[0]
    out, last = [], -1e9
    for i in rows:
        if r.wall[i] - last > FLARE_GAP_MS:
            out.append(float(r.cap[i]))
        last = r.wall[i]
    return out


def contacts(r: Round) -> list[Contact]:
    cs: list[Contact] = []
    for e in r.events:
        if e[2] == "hit":
            i = _row_at(r, e[1])
            cs.append(Contact(i, _seen(r, i) - HIT_LAG_F * FRAME_MS, "hit"))
    qi = r.aux[:, AI["qi"]] * 385
    sp = r.aux[:, AI["since_parry"]] * 3  # frames since our last 卸势 press (cap 30)
    for i in range(1, r.n):
        d = qi[i - 1] - qi[i]
        if qi[i - 1] >= 4 and QI_STEP <= d <= QI_JUMP and qi[i] > 0 and sp[i] <= OK_PARRY_MAX_F:
            t = _seen(r, i) - OK_LAG_F * FRAME_MS
            if not any(c.kind == "hit" and abs(c.t - t) <= MERGE_F * FRAME_MS for c in cs):
                cs.append(Contact(i, t, "ok"))
    cs.sort(key=lambda c: c.t)
    fl = flare_onsets(r)
    for c in cs:
        c.dodge = any(FLARE_MIN_F * FRAME_MS <= c.t - f <= FLARE_MAX_F * FRAME_MS for f in fl)
    _outcomes(r, cs)
    return cs


def _outcomes(r: Round, cs: list[Contact]) -> None:
    lag = r.wall - r.cap
    pp = np.array([e[1] for e in r.events if e[2] == "press" and str(e[3]).startswith("parry")], np.float64)
    hits = [c for c in cs if c.kind == "hit"]
    grab = set()
    chain: list[Contact] = []
    for c in hits + [None]:
        if c is not None and chain and c.t - chain[-1].t <= CHAIN_MS:
            chain.append(c)
            continue
        g = [b.t - a.t for a, b in zip(chain, chain[1:])]
        if len(chain) >= 3 and GRAB_GAP0[0] <= g[0] <= GRAB_GAP0[1] and all(GRAB_GAPN[0] <= v <= GRAB_GAPN[1] for v in g[1:3]):
            grab.update(id(x) for x in chain[1:])
        chain = [c] if c is not None else []
    for c in cs:
        if c.kind == "ok":
            c.outcome = "ok"
        elif id(c) in grab:
            c.outcome = "grab"
        else:
            d = (c.t + lag[c.row] - pp) / FRAME_MS
            c.outcome = "pf" if np.any((d >= PF_LO_F) & (d <= PF_HI_F)) else "unk"


def fut_bin(d: float) -> int:
    if d > HORIZON_F:
        return NONE_BIN
    d = max(1, round(d))
    for b, hi in enumerate(FUT_HI):
        if d <= hi:
            return b
    return NONE_BIN


@dataclass
class Targets:
    fut: np.ndarray  # (N, 3) int bins
    dist: np.ndarray  # (N,) frames to the next contact (inf none)
    fine: np.ndarray  # (N, 46) soft fut1f target
    defs: np.ndarray  # (N, 3) int
    w: np.ndarray  # (N,) fut/def weight (0 = masked)
    contacts: list
    wdef: np.ndarray | None = None  # (N, 3) extra def_k weight (outcome labels: 0 where the k-th contact is unknown)


def contact_def(c: Contact, outcome: bool) -> tuple[int, float]:
    """(def class, def weight) of a contact."""
    if c.dodge:
        return DEF_DODGE, 1.0
    if not outcome or c.outcome == "ok":
        return DEF_PARRY, 1.0
    if c.outcome == "pf":
        return DEF_DODGE, 1.0
    return DEF_PARRY, 0.0


def targets(r: Round, outcome: bool = False) -> Targets:
    cs = contacts(r)
    ct = np.array([c.t for c in cs])
    cdw = [contact_def(c, outcome) for c in cs]
    cd = np.array([d for d, _ in cdw], np.int64)
    cw = np.array([w for _, w in cdw], np.float32)
    n = r.n
    fut = np.full((n, 3), NONE_BIN, np.int64)
    defs = np.full((n, 3), DEF_NONE, np.int64)
    wdef = np.ones((n, 3), np.float32)
    dist = np.full(n, np.inf)
    fine = np.zeros((n, 46), np.float32)
    grid = np.arange(1, 46, dtype=np.float64)
    for i in range(n):
        ahead = np.where(ct > r.cap[i])[0][:3]
        for k, j in enumerate(ahead):
            d = (ct[j] - r.cap[i]) / FRAME_MS
            if k == 0:
                dist[i] = d
            b = fut_bin(d)
            fut[i, k] = b
            if b != NONE_BIN:
                defs[i, k] = cd[j]
                wdef[i, k] = cw[j]
        d0 = dist[i]
        if d0 <= 45.5:
            g = np.exp(-0.5 * ((grid - max(d0, 1.0)) / 1.0) ** 2)
            fine[i, :45] = g / g.sum()
        else:
            fine[i, 45] = 1.0
    w = np.ones(n, np.float32)
    end = r.cap[-1]
    if r.reason == "dead" and cs and any(c.kind == "hit" for c in cs):
        last_hit = max(c.t for c in cs if c.kind == "hit")
        w[r.cap >= last_hit] = 0  # the killing blow onward: death animation / grey screen
        dead_mark = [e[1] for e in r.events if e[2] == "dead"]
        if dead_mark:
            w[r.wall >= dead_mark[0] - 3000] = 0
    else:
        w[r.cap + HORIZON_F * FRAME_MS > end] = 0
    # unsure "no contact": a dodge press ahead (a dodged blow leaves no trace) or a flare episode nobody answered
    sd = r.aux[:, AI["since_dodge"]] * 3
    dodge_t = [r.cap[i] for i in range(1, n) if sd[i] < 1.5 and sd[i - 1] >= 1.5]
    fl = flare_onsets(r)
    unanswered = [f for f in fl if not any(0 < c - f <= FLARE_MAX_F * FRAME_MS for c in ct)]
    for t0 in dodge_t + [f + 15 * FRAME_MS for f in unanswered]:
        m = (r.cap < t0) & (r.cap >= t0 - HORIZON_F * FRAME_MS) & (w > 0)
        w[m] = np.minimum(w[m], W_UNSURE)
    return Targets(fut=fut, dist=dist, fine=fine, defs=defs, w=w, contacts=cs, wdef=wdef)
