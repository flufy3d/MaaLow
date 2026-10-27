"""Gate 0, step 1: cut the decision-moment frames (contact - 10 f) out of the phase-2 recordings.

    uv run --with numpy --with opencv-python-headless python workspaces/WhereWindsMeet/tools/dufu_moveid/gate0_frames.py \
        data/p2 data/moveid/gate0/frames [--index data/moveid/index.json] [--jobs 8]

Decision frames: data/moveid/decisions.json when present (the data-pull step: contact frame - 10 on the index.json
clock, per-round offset fitted on the hp / qi steps; type ok / hit_pf / hit_unk / grab / flare). Otherwise (or with
--meta-clock) contacts from dufu_train/labels.py on the check_align.py clock:
(skill start + contact capture ms - recording `started`) / 33.3 ms (about 4 frames later than the fitted clock). Each decision frame d is saved as <d>.jpg plus the
frame d - LAG (<d>_p.jpg, the "previous box" for the tracking variant) and the frames d + o for o in NEIGHBOURS
(<d>_o<o>.jpg; temporal smoothing of the boss boxes, gate0_detector.py). Writes manifest.json next to the frames.
Recordings: data/moveid/video/<rec>.mp4 or workspaces/WhereWindsMeet/recordings/<rec>/video.mp4 (+ meta.json).
"""
from __future__ import annotations

import argparse
import json
import sys
from multiprocessing import Pool
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "dufu_train"))
from data import FRAME_MS, scan  # noqa: E402
from labels import contacts  # noqa: E402
from common import OUT  # noqa: E402

ROOT = HERE.parents[3]
REC_ROOT = HERE.parents[1] / "recordings"
DECISION_F = 10  # decision moment = contact - 10 frames
LAG = 3  # the "previous frame" for the tracking variant
NEIGHBOURS = (-6, 3, 6)  # more frames around d for temporal smoothing of the detector boxes


def video_of(rec: str) -> Path | None:
    for p in (OUT / "video" / f"{rec}.mp4", ROOT / "data/moveid/video" / f"{rec}.mp4", REC_ROOT / rec / "video.mp4"):
        if p.exists():
            return p
    return None


def load_index(path: Path | None) -> dict:
    """round name -> list of decision frames, from the data-pull agent's index.json (format tolerant)."""
    if not path or not path.exists():
        return {}
    idx = json.loads(path.read_text(encoding="utf-8"))
    rounds = idx.get("rounds", idx) if isinstance(idx, dict) else idx
    out = {}
    items = rounds.items() if isinstance(rounds, dict) else ((r.get("round") or r.get("name"), r) for r in rounds)
    for name, r in items:
        if isinstance(r, dict):
            out[name] = r
    return out


def plan_decisions(path: Path) -> list[dict]:
    """From the data-pull agent's decisions.json (index.json clock: per-round offset fitted on the hp / qi steps)."""
    ds = json.loads(path.read_text(encoding="utf-8"))
    by = {}
    for d in ds:
        name = d["round"].split("/")[-1]
        j = by.setdefault(name, {"round": name, "rec": d["rec"], "src": "decisions", "items": []})
        t = d["type"]
        j["items"].append({"d": int(d["frame"]), "contact_f": int(d["contact_frame"]), "event": d["event"],
                           "type": t, "kind": "ok" if t == "ok" else "hit", "flare": t == "flare"})
    jobs = []
    for name in sorted(by):
        j = by[name]
        vp = video_of(j["rec"])
        if vp is not None:
            j["video"] = str(vp)
            jobs.append(j)
    return jobs


def plan(root: str, index: dict) -> list[dict]:
    jobs = []
    for r in scan(root):
        if not r.rec:
            continue
        vp = video_of(r.rec)
        meta_p = REC_ROOT / r.rec / "meta.json"
        if vp is None:
            continue
        cs = contacts(r)
        ix = index.get(r.name)
        items = []
        if ix and ("offset_f" in ix or "offset" in ix) and meta_p.exists():
            # index offset: video frame = trace-clock frame + offset
            off = float(ix.get("offset_f", ix.get("offset")))
            meta = json.loads(meta_p.read_text(encoding="utf-8"))
            base = (r.start - meta["started"]) / FRAME_MS
            src = "index"
        elif meta_p.exists():
            meta = json.loads(meta_p.read_text(encoding="utf-8"))
            base, off, src = (r.start - meta["started"]) / FRAME_MS, 0.0, "meta"
        else:
            continue
        for c in cs:
            cf = round(base + c.t / FRAME_MS + off)
            items.append({"d": cf - DECISION_F, "contact_f": cf, "kind": c.kind, "flare": bool(c.dodge),
                          "outcome": c.outcome, "t": round(c.t, 1)})
        if ix and isinstance(ix.get("decisions"), list) and ix["decisions"] and len(ix["decisions"]) == len(items):
            for it, d in zip(items, ix["decisions"]):
                it["d"] = int(d if not isinstance(d, dict) else d.get("frame", d.get("d")))
            src = "index"
        jobs.append({"round": r.name, "rec": r.rec, "video": str(vp), "src": src, "items": items})
    return jobs


def cut(job: dict, out_root: str) -> dict:
    od = Path(out_root) / job["round"]
    od.mkdir(parents=True, exist_ok=True)
    want = {}
    for it in job["items"]:
        want.setdefault(it["d"], []).append(f"{it['d']}.jpg")
        want.setdefault(it["d"] - LAG, []).append(f"{it['d']}_p.jpg")
        for o in NEIGHBOURS:
            want.setdefault(it["d"] + o, []).append(f"{it['d']}_o{o}.jpg")
    todo = {f: names for f, names in want.items() if not all((od / n).exists() for n in names)}
    if todo:
        cap = cv2.VideoCapture(job["video"])
        last, i = max(todo), 0
        while i <= last and cap.grab():
            if i in todo:
                ok, im = cap.retrieve()
                if ok:
                    for n in todo[i]:
                        cv2.imwrite(str(od / n), im, [cv2.IMWRITE_JPEG_QUALITY, 92])
            i += 1
        job["frames_in_video"] = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    for it in job["items"]:
        it["ok"] = (od / f"{it['d']}.jpg").exists()
    return job


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("out")
    ap.add_argument("--index", default=str(OUT / "index.json"))
    ap.add_argument("--jobs", type=int, default=8)
    ap.add_argument("--meta-clock", action="store_true", help="ignore decisions.json, use the recording-meta clock")
    a = ap.parse_args()
    dec = OUT / "decisions.json"
    jobs = plan_decisions(dec) if dec.exists() and not a.meta_clock else plan(a.root, load_index(Path(a.index)))
    print(f"{len(jobs)} rounds, {sum(len(j['items']) for j in jobs)} decision moments", flush=True)
    res = []
    with Pool(a.jobs) as p:
        for j in p.imap_unordered(lambda_cut, [(j, a.out) for j in jobs]):
            res.append(j)
            print(j["round"], j["src"], len(j["items"]), sum(it["ok"] for it in j["items"]), flush=True)
    res.sort(key=lambda j: j["round"])
    Path(a.out, "manifest.json").write_text(json.dumps(res, ensure_ascii=False, indent=0), encoding="utf-8")


def lambda_cut(arg):
    return cut(*arg)


if __name__ == "__main__":
    main()
