"""Order 3 (teacher model, gate 1): shared labels, folds, equivalence groups and the frame plan.

Everything that defines *what is measured* lives here and in s3_gate1.py and was written before any training
(README "顺序 3"). Nothing here depends on model outputs.

Targets per video frame t (the next contact c after or at t, its chain = one boss move):
  class   0..42 = taxonomy class of c's chain (assign.json), 43 = unknown (HDBSCAN noise), 44 = idle;
          set on t in [c - 30, c] (MOVE_PRE); idle when the next contact is > IDLE_GAP frames away and the
          previous contact >= IDLE_AFTER frames back; otherwise masked (-100)
  color   opener colour of c's chain (events_ext chain_color): 0 gold, 1 red, 2 none; idle -> none; colour
          'unknown' -> masked. Same mask as class.
  tte     frames to the next contact d = c - t: bins 0..45, 46 = "none" (d > 45). After the last contact of a
          recording: none when > 45 frames remain, else masked (a contact could follow after the recording ends).
"""
from __future__ import annotations

import collections
import json
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
from common import OUT  # phase-aware (MOVEID_PHASE=1 -> data/moveid/p1)
TEACHER = OUT / "teacher"
CACHE = TEACHER / "cache"

T_HIST = 32                 # frames the temporal model sees: t-31 .. t
MOVE_PRE = 30               # class / colour labels on [c - 30, c]
TTE_MAX = 45                # > 45 frames = no contact
N_TTE = TTE_MAX + 2         # bins 0..45 + none
IDLE_GAP = 60               # idle frame: next contact > 60 frames away ...
IDLE_AFTER = 30             # ... and previous contact >= 30 frames back
IDLE_LEN = 16               # idle frames per long gap (centred in the eligible run)
def _taxonomy_count() -> int:
    """Number of real taxonomy classes (grab included); 43 is the phase-2 value and the fallback before clustering."""
    try:
        t = json.loads((OUT / "moves" / "taxonomy.json").read_text(encoding="utf-8"))
        n = sum(1 for c in t.get("classes", []) if c.get("id", -1) >= 0)
        return n or 43
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return 43


N_MOVE = _taxonomy_count()  # taxonomy classes 0..N_MOVE-1 (the last one is grab in the phase-2 taxonomy)
UNKNOWN, IDLE = N_MOVE, N_MOVE + 1
N_CLASS = N_MOVE + 2
COLORS = ("gold", "red", "none")
COLOR_IX = {c: i for i, c in enumerate(COLORS)}
EVAL_OFFS = tuple(range(-16, -3))      # decision curve, relative to the chain's first contact
DECISION = -10
STORE_OFFS = tuple(range(-30, 1))      # out-of-fold outputs kept for every contact at these offsets
N_FOLDS = 5
FOLD_SEED = 20261024
UNPARRYABLE_OK_RATE = 0.2              # taxonomy ok_rate < 0.2 -> cannot parry -> dodge
RHYTHM_TOL = 2.0                       # equivalence: every contact offset median within 2 frames


def read_json(path: Path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: Path, obj, indent: int | None = 1) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=indent), encoding="utf-8")
    tmp.replace(path)


def load() -> dict:
    """index / events_ext / taxonomy / assign, joined: contacts sorted by (rec, frame), each with chain class."""
    idx = read_json(OUT / "index.json")
    ev = read_json(OUT / "events_ext.json")["events"]
    tax = read_json(OUT / "moves" / "taxonomy.json")
    asg = read_json(OUT / "moves" / "assign.json")
    sp = OUT / "moves" / "special.json"
    special = read_json(sp) if sp.exists() else {}
    grab_cls = set(special.get("grab", []))
    curtain_cls = set(special.get("curtain", []))
    for e in ev:
        a = asg[str(e["chain_id"])]
        e["cls"] = a["class"] if a["class"] >= 0 else UNKNOWN
        e["special"] = "grab" if e["cls"] in grab_cls else "curtain" if e["cls"] in curtain_cls else None
    ev.sort(key=lambda e: (e["rec"], e["frame"]))
    recs = [{"rec": r["rec"], "round": r["round"], "frames": r["frames"]} for r in idx["rounds"]]
    classes = {c["id"]: c for c in tax["classes"] if c["id"] >= 0}
    return {"recs": recs, "events": ev, "classes": classes, "taxonomy": tax}


def folds(recs: list[dict], events: list[dict]) -> dict[str, int]:
    """rec -> fold 0..4, grouped by round (one recording = one round): seeded shuffle, then greedy by chain count
    so folds hold similar numbers of chains."""
    n = collections.Counter(e["rec"] for e in events if e["chain_pos"] == 0)
    order = [r["rec"] for r in recs]
    rng = np.random.default_rng(FOLD_SEED)
    rng.shuffle(order)
    order.sort(key=lambda r: -n.get(r, 0))          # stable: shuffled order breaks ties
    load_, out = [0] * N_FOLDS, {}
    for r in order:
        k = int(np.argmin(load_))
        out[r] = k
        load_[k] += n.get(r, 0)
    return out


def response(color: str, cls: int, classes: dict) -> str:
    """Response of a chain (gate (c)): gold -> dodge; class ok_rate < 0.2 (cannot parry) -> dodge; else parry."""
    if color == "gold":
        return "dodge"
    c = classes.get(cls)
    if c is not None and c.get("ok_rate") is not None and c["ok_rate"] < UNPARRYABLE_OK_RATE:
        return "dodge"
    return "parry"


def equivalence_groups(classes: dict, same_response: bool = False) -> dict[int, int]:
    """class id -> group id (= smallest class id in the group). Rule (spec, fixed before training): classes with the
    same opener colour, the same mode chain length, and every contact-offset median of the rhythm template within
    RHYTHM_TOL frames are linked; groups = connected components of the links. same_response=True additionally
    requires the same response() (the "corrected" variant: the spec rule alone links unparryable none-colour
    single hits such as c3 / c27 with parryable ones). Unknown / idle are never in a group with anything."""
    ids = sorted(classes)
    parent = {i: i for i in ids}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def linked(a, b):
        ca, cb = classes[a], classes[b]
        if ca["color"] != cb["color"] or ca["length_mode"] != cb["length_mode"]:
            return False
        ra = [r["median"] for r in ca["rhythm"]]
        rb = [r["median"] for r in cb["rhythm"]]
        if len(ra) != len(rb) or any(abs(x - y) > RHYTHM_TOL for x, y in zip(ra, rb)):
            return False
        if same_response and response(ca["color"], a, classes) != response(cb["color"], b, classes):
            return False
        return True

    for i, a in enumerate(ids):
        for b in ids[i + 1:]:
            if linked(a, b):
                ra, rb = find(a), find(b)
                if ra != rb:
                    parent[max(ra, rb)] = min(ra, rb)
    return {i: find(i) for i in ids}


def group_list(groups: dict[int, int]) -> list[list[int]]:
    by = collections.defaultdict(list)
    for c, g in groups.items():
        by[g].append(c)
    return sorted((sorted(v) for v in by.values()), key=lambda v: v[0])


def frame_labels(rec_frames: int, contacts: list[dict]) -> dict[str, np.ndarray]:
    """Per-frame targets for one recording (contacts sorted by frame; module docstring)."""
    n = rec_frames
    cls = np.full(n, -100, np.int16)
    col = np.full(n, -100, np.int16)
    tte = np.full(n, -100, np.int16)
    nxt = np.full(n, -1, np.int32)               # index into contacts of the next contact (or -1)
    t = np.arange(n)
    fr = np.array([c["frame"] for c in contacts], np.int64)
    j = np.searchsorted(fr, t, side="left")      # first contact with frame >= t
    has = j < len(fr)
    nxt[has] = j[has]
    d = np.where(has, fr[np.minimum(j, len(fr) - 1)] - t if len(fr) else 0, 10 ** 6)
    prev = np.where(j > 0, t - fr[np.maximum(j - 1, 0)] if len(fr) else 10 ** 6, 10 ** 6)
    tte[:] = np.where(d > TTE_MAX, TTE_MAX + 1, d)
    tail = (~has) & (n - 1 - t <= TTE_MAX)       # after the last contact, too close to the end to know
    tte[tail] = -100
    for i in np.nonzero(has & (d <= MOVE_PRE))[0]:
        c = contacts[j[i]]
        cls[i] = c["cls"]
        col[i] = COLOR_IX.get(c["chain_color"], -100)
    idle = (d > IDLE_GAP) & (prev >= IDLE_AFTER) & ~tail
    cls[idle] = IDLE
    col[idle] = COLOR_IX["none"]
    return {"cls": cls, "col": col, "tte": tte, "next": nxt, "idle": idle}


def frame_plan(rec_frames: int, contacts: list[dict]) -> np.ndarray:
    """Sorted video frame numbers to cache for one recording: [c - 30 - 31, c] for every contact c, plus for every
    run of idle-eligible frames IDLE_LEN frames in its middle with their 31-frame history."""
    m = np.zeros(rec_frames, bool)
    for c in contacts:
        m[max(0, c["frame"] - MOVE_PRE - (T_HIST - 1)):c["frame"] + 1] = True
    idle = frame_labels(rec_frames, contacts)["idle"]
    runs, start = [], None
    for i, v in enumerate(np.append(idle, False)):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append((start, i))
            start = None
    for a, b in runs:
        if b - a < IDLE_LEN // 2:
            continue
        mid = (a + b) // 2
        lo, hi = max(a, mid - IDLE_LEN // 2), min(b, mid + IDLE_LEN // 2)
        m[max(0, lo - (T_HIST - 1)):hi] = True
    return np.nonzero(m)[0].astype(np.int32)


def segments(frames: np.ndarray) -> list[tuple[int, int]]:
    """Runs of consecutive frame numbers in a sorted array -> [(row_start, row_end)) into that array."""
    if len(frames) == 0:
        return []
    cut = np.nonzero(np.diff(frames) != 1)[0] + 1
    st = np.concatenate([[0], cut])
    en = np.concatenate([cut, [len(frames)]])
    return list(zip(st.tolist(), en.tolist()))


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    d = load()
    for sr in (False, True):
        g = equivalence_groups(d["classes"], same_response=sr)
        print("same_response" if sr else "spec", [x for x in group_list(g) if len(x) > 1])
    f = folds(d["recs"], d["events"])
    print(collections.Counter(f.values()))
    byrec = collections.defaultdict(list)
    for e in d["events"]:
        byrec[e["rec"]].append(e)
    tot = sum(len(frame_plan(r["frames"], byrec.get(r["rec"], []))) for r in d["recs"])
    print("frames to cache", tot)
