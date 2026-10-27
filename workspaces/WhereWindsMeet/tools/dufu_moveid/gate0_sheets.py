"""Gate 0 labelling helper: pick frames, propose boss candidates with Grounding DINO, draw numbered sheets to label by eye.

    PY="uv run --with torch --with torchvision --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match \
        --with transformers --with pillow --with opencv-python-headless --with numpy python"
    $PY gate0_sheets.py pick data/moveid/gate0/frames --n 300 --check 60      # -> data/moveid/gate0/label_set.json
    $PY gate0_sheets.py sheets data/moveid/gate0/frames --set train --from 0 --to 300

Sheets go to data/moveid/gate0/label_sheets/: 2x2 tiles at 2/3 scale with a 60 px grid (full-res coordinates on the
edges) and the candidate boxes numbered. Labels are written by hand into gate0_labels.json next to this script:
{"r050/1083": [x1, y1, x2, y2] | "c3" (candidate 3) | null (boss not visible)}.
Box = the boss's visible body (head to feet, arms; not the long weapon, not effects).
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
from common import OUT as DATA  # phase-aware data root
OUT = DATA / "gate0"
SET = OUT / "label_set.json"
CANDS = OUT / "label_cands.json"
COLORS = [(0, 0, 255), (0, 255, 0), (255, 0, 0), (0, 255, 255), (255, 0, 255), (255, 255, 0), (0, 128, 255), (255, 255, 255)]


def all_frames(frames: Path) -> list[str]:
    m = json.loads((frames / "manifest.json").read_text(encoding="utf-8"))
    alt = OUT / "manifest_metaclock.json"  # the first cut (recording-meta clock), whose frames the first sets used
    if alt.exists():
        m = json.loads(alt.read_text(encoding="utf-8"))
    return [f"{j['round']}/{it['d']}" for j in m for it in j["items"] if it["ok"]]


def pick_more(frames: Path, name: str, n: int, seed: int, hard: float = 0.0):
    """Another batch of frames to label, disjoint from every set picked so far and not within 15 frames of a check
    frame. hard > 0: only decision frames (final clock) where the current detector's best boss box is below that
    confidence (data/moveid/boss_boxes)."""
    sets = json.loads(SET.read_text(encoding="utf-8"))
    used = {k for v in sets.values() for k in v}
    near = {(r, int(f) + o) for k in sets.get("check_final", []) for r, f in [k.split("/")] for o in range(-15, 16)}
    if hard:
        man = json.loads((frames / "manifest.json").read_text(encoding="utf-8"))
        keys = []
        for j in man:
            bb = json.loads((DATA / "boss_boxes" / f"{j['round']}.json").read_text(encoding="utf-8"))
            keys += [f"{j['round']}/{it['d']}" for it in j["items"] if bb.get(str(it["d"]), {}).get("conf", 0) < hard]
    else:
        keys = all_frames(frames)
    keys = [k for k in sorted(set(keys)) if k not in used and tuple(k.split("/")[:1]) + (int(k.split("/")[1]),) not in near]
    sets[name] = random.Random(seed).sample(keys, n)
    SET.write_text(json.dumps(sets, indent=0), encoding="utf-8")


def pick(frames: Path, n: int, check: int, seed: int):
    keys = sorted(set(all_frames(frames)))
    rnd = random.Random(seed)
    chk = rnd.sample(keys, check)
    rest = [k for k in keys if k not in set(chk)]
    train = rnd.sample(rest, n)
    SET.write_text(json.dumps({"check": chk, "train": train}, indent=0), encoding="utf-8")
    print(len(keys), "frames;", len(chk), "check,", len(train), "train")


def gdino():
    import torch
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

    mid = "IDEA-Research/grounding-dino-base"
    proc = AutoProcessor.from_pretrained(mid)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(mid).cuda().eval()

    def run(img_bgr, text="a warrior in golden armor.", th=0.15):
        from PIL import Image

        im = Image.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB))
        inp = proc(images=im, text=text, return_tensors="pt").to("cuda")
        with torch.no_grad():
            out = model(**inp)
        r = proc.post_process_grounded_object_detection(out, inp.input_ids, threshold=th, text_threshold=th,
                                                        target_sizes=[im.size[::-1]])[0]
        return [(list(map(float, b)), float(s)) for b, s in zip(r["boxes"].tolist(), r["scores"].tolist())]

    return run


def nms(c, iou=0.7, top=6):
    out = []
    for b, s in sorted(c, key=lambda x: -x[1]):
        if all(box_iou(b, o[0]) < iou for o in out):
            out.append((b, s))
    return out[:top]


def box_iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    i = ix * iy
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i
    return i / u if u > 0 else 0


def grid_tile(img, boxes, title, scale=2 / 3, extra=None):
    a = img.copy()
    for x in range(0, 1080, 60):
        cv2.line(a, (x, 0), (x, 719), (90, 90, 90) if x % 180 else (200, 200, 200), 1)
    for y in range(0, 720, 60):
        cv2.line(a, (0, y), (1079, y), (90, 90, 90) if y % 180 else (200, 200, 200), 1)
    for k, (b, s) in enumerate(boxes):
        c = COLORS[k % len(COLORS)]
        x1, y1, x2, y2 = map(int, b)
        cv2.rectangle(a, (x1, y1), (x2, y2), c, 2)
        cv2.putText(a, f"c{k} {s:.2f}", (x1 + 3, y1 + 22 + 22 * (k % 3)), 0, 0.75, c, 2)
    for b, c, t in extra or []:
        x1, y1, x2, y2 = map(int, b)
        cv2.rectangle(a, (x1, y1), (x2, y2), c, 2)
        if t:
            cv2.putText(a, t, (x1 + 3, max(18, y1 - 6)), 0, 0.75, c, 2)
    a = cv2.resize(a, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    for x in range(0, 1080, 180):
        cv2.putText(a, str(x), (int(x * scale) + 2, a.shape[0] - 6), 0, 0.5, (255, 255, 255), 1)
    for y in range(180, 720, 180):
        cv2.putText(a, str(y), (2, int(y * scale) - 3), 0, 0.5, (255, 255, 255), 1)
    cv2.putText(a, title, (60, 22), 0, 0.8, (0, 255, 255), 2)
    return a


def sheets(frames: Path, which: str, lo: int, hi: int, per: int = 4):
    keys = json.loads(SET.read_text(encoding="utf-8"))[which][lo:hi]
    cands = json.loads(CANDS.read_text(encoding="utf-8")) if CANDS.exists() else {}
    run = None
    od = OUT / "label_sheets"
    od.mkdir(parents=True, exist_ok=True)
    for s in range(0, len(keys), per):
        tiles = []
        for k in keys[s:s + per]:
            img = cv2.imread(str(frames / f"{k}.jpg"))
            if k not in cands:
                run = run or gdino()
                cands[k] = nms(run(img))
            tiles.append(grid_tile(img, cands[k], k))
        while len(tiles) < per:
            tiles.append(np.zeros_like(tiles[0]))
        sheet = np.vstack([np.hstack(tiles[i:i + 2]) for i in range(0, per, 2)])
        cv2.imwrite(str(od / f"{which}_{lo + s:03d}.jpg"), sheet, [cv2.IMWRITE_JPEG_QUALITY, 88])
    CANDS.write_text(json.dumps(cands), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["pick", "more", "sheets"])
    ap.add_argument("frames")
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--check", type=int, default=60)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--hard", type=float, default=0.0)
    ap.add_argument("--set", default="train")
    ap.add_argument("--from", dest="lo", type=int, default=0)
    ap.add_argument("--to", dest="hi", type=int, default=10 ** 9)
    a = ap.parse_args()
    if a.cmd == "pick":
        pick(Path(a.frames), a.n, a.check, a.seed)
    elif a.cmd == "more":
        pick_more(Path(a.frames), a.set, a.n, a.seed, a.hard)
    else:
        sheets(Path(a.frames), a.set, a.lo, a.hi)


if __name__ == "__main__":
    main()
