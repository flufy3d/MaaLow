"""Offline replay of 卸势 press policies on phase-2 traces (data/p2/rNNN).

A policy is replayed frame by frame over a round's trace rows: at row i it sees the head output of that row (the
device's 30-row window, data.py) and its own press / feedback history, and decides whether to tap 卸势 now. The tap
goes out at the row's loop time + DECIDE_MS (head + plan after the aux stamp, measured on the trace: press marks are
18-26 ms after their row's wall). Constraints, all from dufu.js or the timing study (data/tmp/p2timing):
  - script cooldown PARRY_CD_MS between taps;
  - the game lock: a 卸势 within LOCK_MS of the last *executed* one is swallowed, unless an ok came in between;
  - no tap during the hit stagger (STAGGER_BY_DROP, from the hit's detection) or POTION_HOLD_MS after a logged drink;
  - the logged dodges / drinks stay where they were (this replays the 卸势 only).
Outcome model (per contact, labels.py contacts): the effective press is the last executed 卸势 with lead in
[EFF_LO_F, gap to the previous contact - 1] (lead = contact capture time - tap time, frames; the latency to the screen is
inside it). P(ok) = the empirical ok-vs-lead curve of that press (fit_curve: fresh contacts, 1-f bins) times the
contact category's scale (other categories have the same shape, lower level); no effective press -> the category's
no-press ok rate. 金光 (flare) and grab-tick contacts keep their logged outcome (the 卸势 policy does not decide them).
Sampled outcomes drive the dynamics (ok lifts the lock, hit -> stagger); the score uses the expectation (sum of
1 - P(ok)) averaged over seeds.

Validity limits (open loop): the head input is the logged trace, i.e. it still contains the logged presses (aux
since_parry / pressed / since_ok, and our parry pose in the frames), and the boss's later moves follow the logged
outcomes, not the replayed ones. `validate` measures how far this is from reality.

    uv run --with numpy python workspaces/WhereWindsMeet/tools/dufu_train/replay.py validate data/p2
    uv run --with numpy python workspaces/WhereWindsMeet/tools/dufu_train/replay.py tune data/p2 [--press-head p2e]
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from data import FRAME_MS, MIN_RING, Round, scan  # noqa: E402
from labels import contacts as label_contacts  # noqa: E402

REPO = Path(__file__).resolve().parents[4]
CACHE = REPO / "data" / "tmp" / "p2policy" / "heads"
DECIDE_MS = 21.0
PARRY_CD_MS, LOCK_MS = 220.0, 330.0
STAGGER_BY_DROP = [(0.04, 100.0), (0.065, 300.0), (1.0, 500.0)]
POTION_HOLD_MS, DODGE_BUSY_MS = 2000.0, 60.0
HIT_SHOW_F = 5.0  # a hit shows on the bar this long after the contact
EFF_LO_F = 2.0
CATS = ["fresh", "postHit", "quick", "chainHeavy", "gold", "grab"]
FIXED = {"gold", "grab"}  # outcome kept from the log
FUT_CENTER = np.array([2, 5, 8, 11, 14, 17.5, 22, 27.5, 35.5, 50.5])
CURVE_HI = 24  # leads >= this share one bin
# sensitivity: P(ok) multiplier when >= 3 executed taps fell in the 2 s before the effective one (logged: 0.82 vs 0.88,
# confounded with long wind-ups; 1 = no penalty). --spam sets it.
SPAM = [1.0]


def softmax(x, axis=-1):
    e = np.exp(x - np.nanmax(x, axis=axis, keepdims=True))
    return e / e.sum(axis=axis, keepdims=True)


@dataclass
class C:
    t: float  # contact, capture clock ms since start
    kind: str  # hit | ok (logged)
    cat: str
    det: float  # when the script learns about it (loop clock)
    drop: float  # hp fraction of a logged hit (median for an ok)
    killing: bool
    gap_prev: float  # frames to the previous contact


@dataclass
class RD:
    """One round prepared for replay."""
    name: str
    r: Round
    cs: list
    presses: np.ndarray  # logged 卸势 taps, loop ms
    press_src: list
    dodges: np.ndarray
    potions: np.ndarray
    out: np.ndarray | None = None  # (N, 133) head p2 logits (nan before MIN_RING)
    extra: dict = field(default_factory=dict)  # other per-row signals (e.g. a press head)
    end: float = 0.0  # replay stops here (the killing blow / trace end)
    minutes: float = 0.0


def _drops(r: Round) -> dict:
    out = {}
    for e in r.events:
        if e[2] == "hit":
            m = re.match(r"(\d+)%->(\d+)%", str(e[3]))
            out[float(e[1])] = (int(m.group(1)) - int(m.group(2))) / 100 if m else 0.06
    return out


def prepare(r: Round, head: str = "unified_head_p2") -> RD:
    cs0 = label_contacts(r)
    drops = _drops(r)
    hm = np.array(sorted(drops))
    lag = r.wall - r.cap
    out: list[C] = []
    last_hit = None
    for j, c in enumerate(cs0):
        gap = (c.t - cs0[j - 1].t) / FRAME_MS if j else 1e9
        prev = out[-1] if out else None
        drop = 0.06
        if c.kind == "hit" and len(hm):
            k = int(np.argmin(np.abs(hm - (c.t + lag[c.row] + HIT_LAG_MS))))
            drop = drops[float(hm[k])]
        if c.dodge:
            cat = "gold"
        elif c.outcome == "grab":
            cat = "grab"
        elif prev is not None and gap < 14:
            cat = "quick"
        elif prev is not None and prev.kind == "hit" and prev.drop >= 0.07 and 18 <= gap < 34:
            cat = "chainHeavy"
        elif prev is not None and prev.kind == "hit" and gap < 60:
            cat = "postHit"
        else:
            cat = "fresh"
        det = float(r.wall[c.row])
        out.append(C(t=c.t, kind=c.kind, cat=cat, det=det, drop=drop, killing=False, gap_prev=gap))
        if c.kind == "hit":
            last_hit = out[-1]
    end = float(r.wall[-1])
    if r.reason == "dead" and last_hit is not None:
        last_hit.killing = True
        end = last_hit.t
    pr, src, dg, po = [], [], [], []
    for e in r.events:
        d = str(e[3])
        if e[2] == "press" and d.startswith("parry"):
            pr.append(float(e[1]))
            src.append(d.split()[2] if d.split()[1].startswith("k") else d.split()[1])
        elif e[2] == "press" and d.startswith("dodge"):
            dg.append(float(e[1]))
        elif e[2] == "potion" and d.startswith("tap"):
            po.append(float(e[1]))
    rd = RD(name=r.name, r=r, cs=out, presses=np.array(pr), press_src=src, dodges=np.array(dg), potions=np.array(po), end=end)
    p = CACHE / head / f"{r.name}.npy"
    if p.exists():
        rd.out = np.load(p)
    live = (r.wall <= end) & (np.arange(r.n) >= MIN_RING - 1)
    rd.minutes = float(np.clip(np.diff(r.wall, prepend=r.wall[0]), 0, 200)[live].sum()) / 60000
    return rd


HIT_LAG_MS = 5 * FRAME_MS


# ---------------------------------------------------------------------------------------------------- outcome model
def executed(times: np.ndarray, oks: np.ndarray) -> np.ndarray:
    """Which taps the game executes: >= LOCK_MS after the last executed one, or an ok since it."""
    ex = np.zeros(len(times), bool)
    last = -1e12
    for k, t in enumerate(times):
        if t - last >= LOCK_MS or np.any((oks > last) & (oks <= t)):
            ex[k] = True
            last = t
    return ex


def eff_lead(c: C, times: np.ndarray, ex: np.ndarray) -> float | None:
    """Lead (frames) of the contact's effective press: the last executed tap with lead in [EFF_LO_F, gap_prev - 1]."""
    lead = (c.t - times) / FRAME_MS
    m = ex & (lead >= EFF_LO_F) & (lead <= c.gap_prev - 1)
    if not m.any():
        return None
    return float(lead[m].min())


@dataclass
class Curve:
    p: np.ndarray  # fresh ok rate per lead bin: index floor(lead) for EFF_LO_F..CURVE_HI-1, last = >= CURVE_HI
    n: np.ndarray
    scale: dict  # category -> multiplier of p
    none: dict  # category -> ok rate with no effective press

    def __call__(self, lead: float | None, cat: str) -> float:
        if lead is None:
            return self.none.get(cat, 0.0)
        b = min(int(lead), CURVE_HI) - int(EFF_LO_F)
        return float(min(1.0, self.p[b] * self.scale.get(cat, 1.0)))

    def shape(self, lead: np.ndarray) -> np.ndarray:
        """Vectorised fresh curve (lead < EFF_LO_F -> 0)."""
        b = np.clip(np.floor(lead).astype(int), int(EFF_LO_F), CURVE_HI) - int(EFF_LO_F)
        return np.where(lead >= EFF_LO_F, self.p[b], 0.0)

    def to_json(self) -> dict:
        return {"lead_from": EFF_LO_F, "p": [round(float(x), 3) for x in self.p], "n": self.n.tolist(),
                "scale": {k: round(v, 3) for k, v in self.scale.items()}, "none": {k: round(v, 3) for k, v in self.none.items()}}


def fit_curve(rds: list[RD]) -> Curve:
    """From the logged taps: P(ok | effective-press lead) for fresh contacts (light smoothing), per-category scales."""
    nb = CURVE_HI - int(EFF_LO_F) + 1
    k, n = np.zeros(nb), np.zeros(nb)
    per = {c: [] for c in CATS}
    for rd in rds:
        oks = np.array([c.t for c in rd.cs if c.kind == "ok"])
        ex = executed(rd.presses, oks)
        for c in rd.cs:
            if c.killing:
                continue
            L = eff_lead(c, rd.presses, ex)
            per[c.cat].append((L, c.kind == "ok"))
            if c.cat == "fresh" and L is not None:
                b = min(int(L), CURVE_HI) - int(EFF_LO_F)
                k[b] += c.kind == "ok"
                n[b] += 1
    # bins with few contacts borrow from their neighbours (half weight); well-filled bins stay raw
    p = np.zeros(nb)
    for b in range(nb):
        if n[b] >= 40:
            p[b] = k[b] / n[b]
            continue
        lo, hi = max(0, b - 1), min(nb, b + 2)
        w = np.array([0.5 if j != b else 1.0 for j in range(lo, hi)])
        p[b] = (w * k[lo:hi]).sum() / max(1e-9, (w * n[lo:hi]).sum())
    curve = Curve(p=p, n=n.astype(int), scale={}, none={})
    for cat, xs in per.items():
        withp = [(L, y) for L, y in xs if L is not None]
        exp = sum(curve(L, "fresh") for L, _ in withp)
        obs = sum(y for _, y in withp)
        curve.scale[cat] = obs / exp if exp > 0 else 0.0
        nop = [y for L, y in xs if L is None]
        curve.none[cat] = float(np.mean(nop)) if nop else 0.0
    curve.scale["fresh"] = 1.0
    return curve


# ---------------------------------------------------------------------------------------------------------- simulator
class State:
    def __init__(self):
        self.last_tap = -1e12  # issued (script CD)
        self.last_exe = -1e12
        self.last_ok = -1e12  # game time of the last ok (lifts the lock)
        self.ok_seen = -1e12  # script detection times
        self.hit_seen = -1e12
        self.stagger_until = -1e12
        self.taps: list[float] = []
        self.exe: list[bool] = []

    def lock_end(self) -> float:
        """When a tap would execute again (as the script can know it: an ok it has seen lifts the lock)."""
        if self.ok_seen > self.last_exe:
            return -1e12
        return self.last_exe + LOCK_MS


class Policy:
    name = "policy"

    def prepare(self, rd: RD, curve: Curve) -> None:
        pass

    def candidates(self, rd: RD) -> np.ndarray | None:
        """Rows worth calling step() on (None = all); rows in between only see on_hit / on_ok."""
        return None

    def step(self, i: int, t: float, st: State) -> bool:
        return False

    def on_hit(self, t: float, st: State) -> None:
        pass

    def on_ok(self, t: float, st: State) -> None:
        pass


def blocked(rd: RD, t: float, st: State) -> bool:
    if t - st.last_tap < PARRY_CD_MS or t < st.stagger_until:
        return True
    if len(rd.potions) and np.any((rd.potions <= t) & (t - rd.potions < POTION_HOLD_MS)):
        return True
    if len(rd.dodges) and np.any(np.abs(rd.dodges - t) < DODGE_BUSY_MS):
        return True
    return False


def stagger_ms(drop: float) -> float:
    for d, ms in STAGGER_BY_DROP:
        if drop <= d + 1e-9:
            return ms
    return STAGGER_BY_DROP[-1][1]


@dataclass
class Score:
    exp_hits: dict  # category -> expected hits
    n: dict  # category -> contacts
    taps: int
    exe: int
    swallowed: int
    wasted: int  # executed taps with no contact 2..16 f after
    minutes: float
    leads: list  # effective-press lead per scored parryable contact (None = none)


def simulate(rd: RD, pol: Policy, curve: Curve, seed: int = 0, replay_logged: bool = False) -> Score:
    rng = np.random.default_rng(seed)
    st = State()
    r = rd.r
    cs = [c for c in rd.cs if c.t <= rd.end + 1]
    ci = 0
    pend: list = []  # (det time, kind, drop) feedback to deliver
    exp_hits = {c: 0.0 for c in CATS}
    ncat = {c: 0 for c in CATS}
    leads = []
    if replay_logged:
        times = [(t, "tap") for t in rd.presses]
    else:
        rows = pol.candidates(rd)
        rows = np.arange(MIN_RING - 1, r.n) if rows is None else rows
        times = [(float(r.wall[i]) + DECIDE_MS, i) for i in rows if r.wall[i] <= rd.end]
    times.sort(key=lambda x: x[0])

    def resolve(c: C):
        nonlocal ci
        if c.cat in FIXED:
            ok = c.kind == "ok"
            p = 1.0 if ok else 0.0
            L = None
        else:
            ta = np.array(st.taps)
            exa = np.array(st.exe, bool)
            L = eff_lead(c, ta, exa) if len(ta) else None
            p = curve(L, c.cat)
            if SPAM[0] < 1 and L is not None:
                te = c.t - L * FRAME_MS
                if np.sum(exa & (ta < te - 1) & (ta >= te - 2000)) >= 3:
                    p *= SPAM[0]
            ok = rng.random() < p
        if not c.killing:
            exp_hits[c.cat] += 1 - p
            ncat[c.cat] += 1
            if c.cat not in FIXED:
                leads.append(L)
        if ok:
            st.last_ok = c.t
            pend.append((c.det if c.kind == "ok" else c.t + float(np.median(r.wall - r.cap)), "ok", 0.0))
        else:
            det = c.det if c.kind == "hit" else c.t + HIT_LAG_MS + float(np.median(r.wall - r.cap))
            pend.append((det, "hit", c.drop))

    def deliver(t: float):
        pend.sort(key=lambda x: x[0])
        while pend and pend[0][0] <= t:
            d, kind, drop = pend.pop(0)
            if kind == "ok":
                st.ok_seen = d
                pol.on_ok(d, st)
            else:
                st.hit_seen = d
                st.stagger_until = max(st.stagger_until, d + stagger_ms(drop))
                pol.on_hit(d, st)

    for t, i in times:
        while ci < len(cs) and cs[ci].t <= t:
            resolve(cs[ci])
            ci += 1
        deliver(t)
        if replay_logged:
            go = True
        else:
            go = pol.step(i, t, st) and not blocked(rd, t, st)
        if go:
            ex = t - st.last_exe >= LOCK_MS or st.last_ok > st.last_exe
            st.taps.append(t)
            st.exe.append(ex)
            st.last_tap = t
            if ex:
                st.last_exe = t
    while ci < len(cs):
        resolve(cs[ci])
        ci += 1
    ta = np.array(st.taps)
    ex = np.array(st.exe, bool)
    ct = np.array([c.t for c in cs])
    wasted = 0
    for t in ta[ex] if len(ta) else []:
        L = (ct - t) / FRAME_MS
        wasted += not np.any((L >= 2) & (L <= 16))
    return Score(exp_hits=exp_hits, n=ncat, taps=len(ta), exe=int(ex.sum()), swallowed=int((~ex).sum()),
                 wasted=int(wasted), minutes=rd.minutes, leads=leads)


def run(rds: list[RD], pol: Policy, curve: Curve, seeds: int = 4, replay_logged: bool = False) -> list[dict]:
    """Per round: mean over seeds of the score fields."""
    out = []
    for rd in rds:
        pol.prepare(rd, curve)
        ss = [simulate(rd, pol, curve, s, replay_logged) for s in range(1 if replay_logged else seeds)]
        m = {"name": rd.name, "minutes": rd.minutes}
        for cat in CATS:
            m[f"h_{cat}"] = float(np.mean([s.exp_hits[cat] for s in ss]))
            m[f"n_{cat}"] = ss[0].n[cat]
        for k in ("taps", "exe", "swallowed", "wasted"):
            m[k] = float(np.mean([getattr(s, k) for s in ss]))
        m["leads"] = [L for s in ss for L in s.leads]
        out.append(m)
    return out


PARRYABLE = ["fresh", "postHit", "quick", "chainHeavy"]


def summary(res: list[dict], boot: int = 2000, seed: int = 0) -> dict:
    mins = sum(x["minutes"] for x in res)
    hp = np.array([sum(x[f"h_{c}"] for c in PARRYABLE) for x in res])
    mm = np.array([x["minutes"] for x in res])
    rng = np.random.default_rng(seed)
    bs = []
    for _ in range(boot):
        k = rng.integers(0, len(res), len(res))
        bs.append(hp[k].sum() / mm[k].sum())
    out = {"rounds": len(res), "minutes": mins, "hits_parryable_per_min": hp.sum() / mins,
           "ci95": [float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))]}
    for c in CATS:
        out[f"{c}_per_min"] = sum(x[f"h_{c}"] for x in res) / mins
    out["hits_all_per_min"] = sum(sum(x[f"h_{c}"] for c in CATS) for x in res) / mins
    for k in ("taps", "exe", "swallowed", "wasted"):
        out[f"{k}_per_min"] = sum(x[k] for x in res) / mins
    L = [x for r in res for x in r["leads"]]
    Ls = np.array([x for x in L if x is not None])
    out["no_eff_press"] = sum(x is None for x in L) / max(1, len(L))
    out["eff_lead_q"] = [float(v) for v in np.percentile(Ls, [25, 50, 75])] if len(Ls) else None
    out["eff_in_3_9"] = float(np.mean((Ls >= 3) & (Ls < 10))) * len(Ls) / max(1, len(L)) if len(Ls) else 0.0
    return out


def paired(a: list[dict], b: list[dict], boot: int = 2000, seed: int = 0) -> tuple[float, list]:
    """Parryable hits/min difference b - a, round-bootstrap CI."""
    ha = np.array([sum(x[f"h_{c}"] for c in PARRYABLE) for x in a])
    hb = np.array([sum(x[f"h_{c}"] for c in PARRYABLE) for x in b])
    mm = np.array([x["minutes"] for x in a])
    rng = np.random.default_rng(seed)
    d = []
    for _ in range(boot):
        k = rng.integers(0, len(a), len(a))
        d.append((hb[k].sum() - ha[k].sum()) / mm[k].sum())
    return float((hb.sum() - ha.sum()) / mm.sum()), [float(np.percentile(d, 2.5)), float(np.percentile(d, 97.5))]


def fmt(s: dict) -> str:
    q = s["eff_lead_q"]
    return (f"parryable hits/min {s['hits_parryable_per_min']:.2f} [{s['ci95'][0]:.2f},{s['ci95'][1]:.2f}] "
            f"(fresh {s['fresh_per_min']:.2f} postHit {s['postHit_per_min']:.2f} quick {s['quick_per_min']:.2f} "
            f"chainHeavy {s['chainHeavy_per_min']:.2f}) all {s['hits_all_per_min']:.2f} | taps/min {s['taps_per_min']:.1f} "
            f"exe {s['exe_per_min']:.1f} swallowed {s['swallowed_per_min']:.1f} wasted {s['wasted_per_min']:.1f} | "
            f"eff lead q {'-' if q is None else '/'.join(f'{v:.1f}' for v in q)} none {100 * s['no_eff_press']:.0f}% "
            f"in3-9 {100 * s['eff_in_3_9']:.0f}% | {s['rounds']} rounds {s['minutes']:.0f} min")


# -------------------------------------------------------------------------------------------------------- policies
class Current(Policy):
    """Approximation of dufu.js (phase 2, defaults) fut 卸势 scheduling: syncK / targetOf / executePlan / expire /
    relock / hitEsc + insurance, for k = 0..2. Not modelled: tell / flare dodges (logged), potion planning (logged),
    offense, curtain (off in phase 2)."""
    name = "current"
    LEAD_MS = 14 * FRAME_MS
    TRIG_TH = 0.45

    def __init__(self, lead_f: float = 14, second_tap_f: float = 0, jitter: tuple | None = None):
        self.LEAD_MS = lead_f * FRAME_MS
        self.second = second_tap_f
        self.jitter = jitter
        self.rng = np.random.default_rng(0)

    def _jit(self):
        if not self.jitter:
            return 0.0
        return float(self.rng.integers(self.jitter[0], self.jitter[1] + 1)) * FRAME_MS

    def prepare(self, rd, curve):
        o = rd.out
        self.fut = [softmax(o[:, 22 + 11 * k:33 + 11 * k]) for k in range(3)]
        dd = softmax(o[:, 0:16])
        self.combo = (dd.argmax(1) >= 2) & (dd.argmax(1) <= 7) & (dd.max(1) >= 0.4)
        self.items = []  # dicts
        self.esc = None
        self.last_parry_c = 0.0
        self.pressed_since_hit = False
        self.last_item_parry = -1e12

    def _stats(self, p):
        s = p[:10].sum()
        exp = (p[:10] * FUT_CENTER).sum() / s if s > 0 else np.inf
        order = np.argsort(-p[:10])
        return dict(none=p[10], sum=s, exp=exp, i1=order[0], p1=p[order[0]], i2=order[1], p2=p[order[1]])

    def _target(self, i, now, k):
        p = self.fut[k][i]
        stt = self._stats(p)
        if stt["none"] >= 0.65 or stt["sum"] <= 0.01:
            return None
        if stt["exp"] > 60:
            return "far"
        s1 = p[1:6].sum()
        trig = s1 >= self.TRIG_TH if k == 0 else (self.combo[i] or s1 >= self.TRIG_TH * 0.6)
        if not trig:
            return None
        if stt["exp"] < 2:
            return "late"
        bim = stt["p1"] >= 0.2 and stt["p2"] >= 0.2 and abs(stt["i1"] - stt["i2"]) >= 5
        c = now + stt["exp"] * FRAME_MS
        if bim:
            c = now + FUT_CENTER[min(stt["i1"], stt["i2"])] * FRAME_MS
        return c

    def _rearm(self, it, c):
        it["rearms"] += 1
        it["re"] = True
        it["pressed"] = 0.0
        it["c"] = c
        it["at"] = c - self.LEAD_MS - it["jit"]
        it["until"] = c + 250
        it["held"] = False

    def step(self, i, t, st):
        now = t
        if not np.isfinite(self.fut[0][i][0]):
            return False
        # syncK
        for k in range(3):
            main = next((x for x in self.items if x["k"] == k), None)
            p = self.fut[k][i]
            if main and main["pressed"] and self.second and not main["re"] and now - main["pressed"] >= self.second * FRAME_MS \
                    and st.hit_seen < main["pressed"] and st.ok_seen < main["pressed"]:
                s2 = self._stats(p)
                if s2["none"] < 0.65 and s2["sum"] > 0.05:
                    self._rearm(main, now + self.LEAD_MS + main["jit"])
                    continue
            if main and main["pressed"] and not main["re"] and now - main["pressed"] >= 18 * FRAME_MS \
                    and now > main["c"] + 3 * FRAME_MS and st.hit_seen < main["pressed"] - FRAME_MS and st.ok_seen < main["pressed"] - FRAME_MS:
                s2 = self._stats(p)
                if s2["none"] < 0.65 and s2["sum"] > 0.01 and 2 <= s2["exp"] <= 45:
                    self._rearm(main, now + s2["exp"] * FRAME_MS)
                    continue
                if s2["sum"] > 0.05:
                    self._rearm(main, now + 12 * FRAME_MS + 14 * FRAME_MS)
                    continue
            tg = self._target(i, now, k)
            if tg is None:
                if main and not main["pressed"] and main["at"] - now > 90:
                    self.items.remove(main)
                continue
            if tg in ("far", "late"):
                continue
            if main is None:
                j = self._jit()
                self.items.append(dict(k=k, c=tg, at=tg - self.LEAD_MS - j, until=tg + 250, pressed=0.0, rearms=0, re=False, held=False, jit=j))
            elif not main["pressed"] and main["at"] - now > 90:
                main["c"], main["at"], main["until"] = tg, tg - self.LEAD_MS - main["jit"], tg + 250
            elif main["pressed"] and main["rearms"] < 2 and tg - main["c"] > 100 and tg - main["pressed"] >= 18 * FRAME_MS \
                    and tg - now >= 2 * FRAME_MS and now - main["pressed"] >= PARRY_CD_MS:
                self._rearm(main, tg)
        # executePlan (one tap per loop at most)
        go = False
        for it in sorted(self.items, key=lambda x: x["at"]):
            if it["pressed"] or now < it["at"] or go:
                continue
            if now < st.stagger_until:
                if it["c"] - now >= 4 * FRAME_MS:
                    it["held"] = True
                    continue
                self.items.remove(it)
                continue
            # relock
            if st.last_exe > -1e11 and now < st.last_tap + LOCK_MS and st.ok_seen < st.last_tap and st.hit_seen < st.last_tap \
                    and (it["re"] or abs(it["c"] - self.last_parry_c) <= 8 * FRAME_MS):
                end = st.last_tap + LOCK_MS
                if (it["c"] - end) / FRAME_MS - 5 < 2:
                    self.items.remove(it)
                continue
            if now - st.last_tap < PARRY_CD_MS:
                self.items.remove(it)
                continue
            if it["held"] and it["c"] - now < 4 * FRAME_MS:
                self.items.remove(it)
                continue
            it["pressed"] = now
            self.last_parry_c = it["c"]
            self.pressed_since_hit = True
            self.last_item_parry = now
            go = True
        # hitEsc / insurance at the stagger end
        if not go and self.esc is not None and now >= self.esc:
            pend = any(not x["pressed"] and x["at"] <= now + 3 * FRAME_MS for x in self.items)
            if pend or self.pressed_since_hit:
                self.esc = None
            elif now > self.esc + 30 * FRAME_MS:
                self.esc = None
            elif now >= st.stagger_until and now - st.last_tap >= PARRY_CD_MS and not (
                    now < st.last_tap + LOCK_MS and st.ok_seen < st.last_tap and st.hit_seen < st.last_tap):
                self.esc = None
                self.last_parry_c = now + 14 * FRAME_MS
                go = True
        # expire
        for it in list(self.items):
            if not it["pressed"] and now > it["until"]:
                self.items.remove(it)
            elif it["pressed"] and now > it["until"]:
                p = self.fut[it["k"]][i]
                s2 = self._stats(p)
                if it["rearms"] < 2 and s2["none"] < 0.65 and s2["sum"] > 0.01 and 2 <= s2["exp"] <= 25:
                    self._rearm(it, now + s2["exp"] * FRAME_MS)
                else:
                    self.items.remove(it)
        return go

    def on_hit(self, t, st):
        self.items = [x for x in self.items if not x["pressed"] and x["c"] > t + 2 * FRAME_MS]
        self.pressed_since_hit = False
        self.esc = st.stagger_until

    def on_ok(self, t, st):
        best = None
        for x in self.items:
            if x["pressed"] and t - x["pressed"] <= 1500 and (best is None or x["pressed"] > best["pressed"]):
                best = x
        if best is not None:
            self.items.remove(best)


def ev_matrix(dist: np.ndarray, lag_f: np.ndarray, curve: Curve, shifts: np.ndarray) -> np.ndarray:
    """dist (N, 45): P(next contact d = 1..45 f after the row's capture). lag_f (N,): tap time - capture, frames.
    Returns (N, len(shifts)) expected fresh-curve ok of a tap at (now + shift frames)."""
    d = np.arange(1, 46)[None, :, None]
    lead = d - lag_f[:, None, None] - shifts[None, None, :]
    return (dist[:, :, None] * curve.shape(lead)).sum(1)


class EV(Policy):
    """Tap when the expected ok of a tap now (next-contact distribution x ok-vs-lead curve) is >= th, it beats the
    current effective tap by >= gain (the last executed tap aged by now) and no tap in the next `wait` frames is
    expected to be better by more than `margin`."""
    name = "ev"

    def __init__(self, th=0.5, gain=0.25, wait=4, margin=0.0, src="fut1f", temp=1.0):
        self.th, self.gain, self.wait, self.margin, self.src, self.temp = th, gain, wait, margin, src, temp

    def dist(self, rd: RD) -> np.ndarray:
        if self.src == "fut1f":
            p = softmax(rd.out[:, 77:123] / self.temp)
            return p[:, :45]
        return rd.extra[self.src]

    def prepare(self, rd, curve):
        r = rd.r
        lag = (r.wall + DECIDE_MS - r.cap) / FRAME_MS
        D = np.nan_to_num(self.dist(rd))
        self.shifts = np.arange(0, self.wait + 1)
        self.q = ev_matrix(D, lag, curve, self.shifts.astype(float))
        # value of the press made `age` frames ago: q at shift -age, computed on demand
        self.D, self.lag, self.curve = D, lag, curve

    def candidates(self, rd):
        return np.where(self.q[:, 0] >= self.th)[0]

    def step(self, i, t, st):
        q0 = self.q[i, 0]
        if q0 < self.th:
            return False
        if self.wait and self.q[i, 1:].max() > q0 + self.margin:
            return False
        if t < st.lock_end():
            return False
        if st.last_exe > -1e11 and st.ok_seen < st.last_exe and st.hit_seen < st.last_exe:
            age = (t - st.last_exe) / FRAME_MS
            d = np.arange(1, 46)
            qprev = float((self.D[i] * self.curve.shape(d - self.lag[i] + age)).sum())
            if q0 - qprev < self.gain:
                return False
        return True


def window_mass(dist: np.ndarray, lag_f: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """P(next contact lead in [lo, hi] frames from a tap now), lead = d - lag."""
    d = np.arange(1, 46)[None, :]
    lead = d - lag_f[:, None]
    return (dist * ((lead >= lo) & (lead <= hi))).sum(1)


def gate_mass(rd: RD, src: str, lo: float, hi: float) -> np.ndarray:
    """(N,) P(next contact lead in [lo, hi] frames from a tap issued at this row). src "fut1f": head p2's 1-frame
    distribution (capture clock, shifted by the row's tap lag); "lead1f": the p2e branch (tap clock already; bin b =
    lead [b, b+1)), from rd.extra (load_extra)."""
    if src == "lead1f":
        p = rd.extra["lead1f"]
        b = np.arange(46)
        return np.nan_to_num((p * ((b >= np.floor(lo)) & (b <= hi) & (b < 45))[None, :]).sum(1))
    r = rd.r
    lag = (r.wall + DECIDE_MS - r.cap) / FRAME_MS
    D = np.nan_to_num(softmax(rd.out[:, 77:123])[:, :45])
    return window_mass(D, lag, lo, hi)


class Metro(Policy):
    """Tap as soon as the game lock is over (and the script CD) while a contact is likely soon: P(next contact lead in
    [2, hi] f) >= g. Every executed tap covers leads ~[2, 12) of the contacts after it, so back-to-back taps 330 ms apart
    leave no gap; the gate only stops tapping when nothing is coming."""
    name = "metro"

    def __init__(self, g=0.5, hi=20, src="fut1f", lock_pad_ms=10.0):
        self.g, self.hi, self.src, self.pad = g, hi, src, lock_pad_ms

    def prepare(self, rd, curve):
        self.m = gate_mass(rd, self.src, EFF_LO_F, self.hi)

    def candidates(self, rd):
        return np.where(self.m >= self.g)[0]

    def step(self, i, t, st):
        return self.m[i] >= self.g and t >= st.lock_end() + self.pad


def load_extra(rds: list[RD], name: str = "unified_head_p2e_oof") -> list[RD]:
    """Attach the p2e branch's out-of-fold lead1f (softmax) to each round; rounds without it are dropped."""
    out = []
    for rd in rds:
        p = CACHE / name / f"{rd.name}.npy"
        if p.exists():
            rd.extra["lead1f"] = softmax(np.load(p).astype(np.float64))
            out.append(rd)
    return out


class Oracle(Policy):
    """Reference ceiling: knows the true contact times and taps once per contact at lead in [lo, hi] (lock / stagger
    still apply)."""
    name = "oracle"

    def __init__(self, lo=4.0, hi=7.0):
        self.lo, self.hi = lo, hi

    def prepare(self, rd, curve):
        tap = rd.r.wall + DECIDE_MS
        ct = np.array([c.t for c in rd.cs])
        self.ok = np.zeros(rd.r.n, bool)
        for i in range(rd.r.n):
            L = (ct - tap[i]) / FRAME_MS
            self.ok[i] = np.any((L >= self.lo) & (L <= self.hi))

    def candidates(self, rd):
        return np.where(self.ok)[0]

    def step(self, i, t, st):
        return t >= st.lock_end()


class Logged(Policy):
    name = "logged"


# ------------------------------------------------------------------------------------------------------------- CLI
def load(root: str, names=None, head="unified_head_p2", lo=None) -> list[RD]:
    out = []
    for r in scan(root):
        if names and r.name not in names:
            continue
        if lo and r.name < lo:
            continue
        out.append(prepare(r, head))
    return out


def args_of(rd: RD) -> dict:
    p = rd.r.path / "args.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def baseline_rounds(rds: list[RD]) -> list[RD]:
    """Rounds run with head p2 and the default press logic (flare2 A/B included: it changes dodges only)."""
    out = []
    for rd in rds:
        a = args_of(rd)
        if a.get("head") == "dufu/unified_head_p2.onnx" and not any(k in a for k in ("parryJitter", "leadF", "secondTapF", "defDodgeP")):
            out.append(rd)
    return out


def real_counts(rds: list[RD]) -> dict:
    mins = sum(rd.minutes for rd in rds)
    out = {}
    for cat in CATS:
        cs = [c for rd in rds for c in rd.cs if c.cat == cat and not c.killing]
        out[cat] = (sum(c.kind == "hit" for c in cs) / mins, len(cs))
    hp = sum(sum(c.kind == "hit" for c in rd.cs if c.cat in PARRYABLE and not c.killing) for rd in rds)
    out["parryable"] = hp / mins
    out["taps_per_min"] = sum(len(rd.presses) for rd in rds) / mins
    return out


def cmd_validate(a):
    rds = load(a.root, lo="r043")
    base = baseline_rounds(rds)
    curve = fit_curve(base)
    print("curve (fit on the baseline rounds):", json.dumps(curve.to_json()))
    real = real_counts(base)
    print(f"baseline rounds {len(base)} ({sum(rd.minutes for rd in base):.0f} min): real parryable hits/min {real['parryable']:.2f}; "
          + " ".join(f"{c} {real[c][0]:.2f} (n {real[c][1]})" for c in CATS) + f"; taps/min {real['taps_per_min']:.1f}")
    lg = run(base, Logged(), curve, replay_logged=True)
    print("logged taps, outcome model:", fmt(summary(lg)))
    real_r = np.array([sum(c.kind == "hit" for c in rd.cs if c.cat in PARRYABLE and not c.killing) for rd in base])
    pred_r = np.array([sum(x[f"h_{c}"] for c in PARRYABLE) for x in lg])
    print(f"  per round real vs modelled parryable hits: r = {np.corrcoef(real_r, pred_r)[0, 1]:.3f}, "
          f"sum {real_r.sum()} vs {pred_r.sum():.1f}")
    cur = run(base, Current(), curve, seeds=a.seeds)
    print("simulated current scheduler:", fmt(summary(cur)))
    pred_c = np.array([sum(x[f"h_{c}"] for c in PARRYABLE) for x in cur])
    print(f"  per round real vs simulated: r = {np.corrcoef(real_r, pred_c)[0, 1]:.3f}")
    d, ci = paired(lg, cur)
    print(f"  simulated - logged: {d:+.2f}/min [{ci[0]:+.2f},{ci[1]:+.2f}]")


def cv_select(grid: dict, cur: list[dict], names: list[str], k: int = 5, budget: float | None = None):
    """Round-wise K-fold (round number % k) choice of a grid config: on the other folds the config with the fewest
    parryable hits/min (taps/min <= budget if given), scored on the held-out fold. Returns (chosen per fold, OOF rows)."""
    def no(n):
        return int("".join(ch for ch in n if ch.isdigit()))

    def rate(rows, key):
        return sum(x[key] if key in x else sum(x[f"h_{c}"] for c in PARRYABLE) for x in rows) / sum(x["minutes"] for x in rows)

    chosen, oof = [], []
    for f in range(k):
        tr = [i for i, n in enumerate(names) if no(n) % k != f]
        va = [i for i, n in enumerate(names) if no(n) % k == f]
        best = None
        for cfg, res in grid.items():
            rows = [res[i] for i in tr]
            if budget is not None and rate(rows, "taps") > budget:
                continue
            h = rate(rows, "hits")
            if best is None or h < best[0]:
                best = (h, cfg)
        if best is None:
            return None, None
        chosen.append(best[1])
        oof += [grid[best[1]][i] for i in va]
    order = {n: i for i, n in enumerate(names)}
    oof.sort(key=lambda x: order[x["name"]])
    return chosen, oof


def cmd_tune(a):
    rds = load(a.root, lo=a.lo)
    curve = fit_curve(baseline_rounds(rds))
    srcs = ["fut1f"]
    if a.extra:
        rds = load_extra(rds, a.extra)
        srcs.append("lead1f")
    names = [rd.name for rd in rds]
    print(f"{len(rds)} rounds {sum(rd.minutes for rd in rds):.0f} min; outcome curve from the baseline rounds")
    cur = run(rds, Current(), curve, seeds=a.seeds)
    print("current (simulated):", fmt(summary(cur)), flush=True)
    import pickle

    cache = REPO / "data" / "tmp" / "p2policy" / "tune_grid.pkl"
    grid = pickle.loads(cache.read_bytes()) if a.cached and cache.exists() else {}
    for src in srcs:
        for hi in a.his:
            for g in a.gates:
                key = (src, hi, g)
                if key not in grid:
                    grid[key] = run(rds, Metro(g=g, hi=hi, src=src), curve, seeds=a.seeds)
                    cache.parent.mkdir(parents=True, exist_ok=True)
                    cache.write_bytes(pickle.dumps(grid))
                res = grid[key]
                d, ci = paired(cur, res)
                print(f"metro {src} hi{hi} g{g}: d {d:+.2f} [{ci[0]:+.2f},{ci[1]:+.2f}] {fmt(summary(res))}", flush=True)
    budgets = [None, summary(cur)["taps_per_min"]] + a.budgets
    for src in srcs:
        sub = {k: v for k, v in grid.items() if k[0] == src}
        for b in budgets:
            chosen, oof = cv_select(sub, cur, names, budget=b)
            if chosen is None:
                print(f"CV {src} taps<={round(b)}: no config within the budget")
                continue
            d, ci = paired(cur, oof)
            print(f"CV {src} taps<={'-' if b is None else round(b)}: chosen {chosen} -> d {d:+.2f} [{ci[0]:+.2f},{ci[1]:+.2f}] {fmt(summary(oof))}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate")
    v.add_argument("root")
    v.add_argument("--seeds", type=int, default=4)
    t = sub.add_parser("tune", help="Metro gate grid vs the simulated current scheduler + round-wise CV choice")
    t.add_argument("root")
    t.add_argument("--lo", default="r043", help="first round (head p2 was fit on r001-r042)")
    t.add_argument("--extra", default=None, help="p2e out-of-fold dir under data/tmp/p2policy/heads (adds src lead1f)")
    t.add_argument("--gates", type=float, nargs="+", default=[0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5])
    t.add_argument("--his", type=float, nargs="+", default=[16, 24])
    t.add_argument("--budgets", type=float, nargs="*", default=[60])
    t.add_argument("--seeds", type=int, default=2)
    t.add_argument("--spam", type=float, default=1.0)
    t.add_argument("--cached", action="store_true", help="reuse data/tmp/p2policy/tune_grid.pkl (same rounds / seeds / spam!)")
    a = ap.parse_args()
    if getattr(a, "spam", 1.0) != 1.0:
        SPAM[0] = a.spam
    {"validate": cmd_validate, "tune": cmd_tune}[a.cmd](a)


if __name__ == "__main__":
    main()
