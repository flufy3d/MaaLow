"""Gate 0, step 2: a boss detector fine-tuned on the hand labels (gate0_labels.json), then boxes for every decision frame.

    PY="uv run --with torch --with torchvision --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match \
        --with ultralytics --with opencv-python-headless --with numpy python"
    $PY gate0_detector.py train            # -> data/moveid/gate0/yolo/run/weights/best.pt
    $PY gate0_detector.py detect           # -> data/moveid/boss_boxes/rNNN.json (also the _p frames)
    $PY gate0_detector.py check            # 60 held-out frames drawn into data/moveid/gate0/check/

Zero-shot detectors (Grounding DINO "warrior in golden armor", OWLv2) mix the boss up with our own character, who stands
in the middle of the screen in front of him, so a YOLO (ultralytics yolo11l, COCO weights) is fine-tuned on hand-drawn
boss boxes (box = the boss's visible body, not the long weapon, not effects; null = boss not visible: hidden by our
character, a fire / dragon effect, or off screen). A second class "player" (auto-labelled from COCO yolo11x person boxes
at the bottom middle, player_boxes()) teaches it what not to call the boss; only class 0 is used downstream.

boss_boxes/rNNN.json: {"<frame>": {"box": [x1, y1, x2, y2] | null, "conf": float, "n": number of boxes >= CONF}} for
every decision frame d and its tracking frame d - 3 (key "<d>_p"); box = the most confident box (conf >= CONF).
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
G0 = ROOT / "data/moveid/gate0"
FRAMES = G0 / "frames"
YOLO = G0 / "yolo"
BOXES = ROOT / "data/moveid/boss_boxes"
LABELS = HERE / "gate0_labels.json"
W, H = 1080, 720
CONF = 0.25
DRAGON = False  # third class "dragon" (dragon_boxes); tried as v5, no better on the dev set, off


def player_boxes(keys, lab):
    """Our own character (class 1), auto-labelled: the COCO yolo11x person box standing at the bottom middle of the
    screen that is not the hand-labelled boss. Cached in yolo/player_boxes.json."""
    cache = YOLO / "player_boxes.json"
    have = json.loads(cache.read_text(encoding="utf-8")) if cache.exists() else {}
    todo = [k for k in keys if k not in have]
    if todo:
        from ultralytics import YOLO as Y

        m = Y(str(YOLO / "yolo11x.pt"))
        for k in todo:
            r = m.predict(str(FRAMES / f"{k}.jpg"), imgsz=1088, conf=0.3, classes=[0], verbose=False)[0]
            best = None
            for b, c in zip(r.boxes.xyxy.tolist(), r.boxes.conf.tolist()):
                cx = (b[0] + b[2]) / 2
                if b[3] < 560 or not 300 <= cx <= 780:
                    continue
                if lab[k] and iou(b, lab[k]) > 0.4:
                    continue
                if best is None or c > best[1]:
                    best = (b, c)
            have[k] = [round(v, 1) for v in best[0]] if best else None
        cache.write_text(json.dumps(have), encoding="utf-8")
    return have


def dragon_boxes(keys, lab, th=0.5):
    """The boss's red dragon summon (class 2), auto-labelled: Grounding DINO "a red chinese dragon." boxes with score
    >= th that do not overlap the hand-labelled boss box (IoU < 0.3). The dragon was the main false positive of the
    one-class detector (it stands where the boss is and shares his colours). Cached in yolo/dragon_boxes.json."""
    cache = YOLO / "dragon_boxes.json"
    have = json.loads(cache.read_text(encoding="utf-8")) if cache.exists() else {}
    todo = [k for k in keys if k not in have]
    if todo:
        import cv2
        import torch
        from PIL import Image
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

        mid = "IDEA-Research/grounding-dino-base"
        proc = AutoProcessor.from_pretrained(mid)
        model = AutoModelForZeroShotObjectDetection.from_pretrained(mid).cuda().eval()
        for k in todo:
            im = Image.open(FRAMES / f"{k}.jpg").convert("RGB")
            inp = proc(images=im, text="a red chinese dragon.", return_tensors="pt").to("cuda")
            with torch.no_grad():
                out = model(**inp)
            r = proc.post_process_grounded_object_detection(out, inp.input_ids, threshold=th, text_threshold=th,
                                                            target_sizes=[im.size[::-1]])[0]
            bs = [[round(v, 1) for v in b] for b in r["boxes"].tolist()]
            have[k] = [b for b in bs if not lab[k] or iou(b, lab[k]) < 0.3]
        cache.write_text(json.dumps(have), encoding="utf-8")
    return have


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    i = ix * iy
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i
    return i / u if u > 0 else 0


def yolo_line(c, b):
    x1, y1, x2, y2 = (max(0, min(W, b[0])), max(0, min(H, b[1])), max(0, min(W, b[2])), max(0, min(H, b[3])))
    return f"{c} {(x1 + x2) / 2 / W:.6f} {(y1 + y2) / 2 / H:.6f} {(x2 - x1) / W:.6f} {(y2 - y1) / H:.6f}\n"


def build_dataset(seed=0, val_n=40):
    lab = {k: v for k, v in json.loads(LABELS.read_text(encoding="utf-8")).items() if not k.startswith("_")}
    pl = player_boxes(sorted(lab), lab)
    dr = dragon_boxes(sorted(lab), lab) if DRAGON else {}
    keys = sorted(lab)
    random.Random(seed).shuffle(keys)
    if YOLO.exists():
        shutil.rmtree(YOLO / "images", ignore_errors=True)
        shutil.rmtree(YOLO / "labels", ignore_errors=True)
    for split, ks in (("val", keys[:val_n]), ("train", keys[val_n:])):
        (YOLO / "images" / split).mkdir(parents=True, exist_ok=True)
        (YOLO / "labels" / split).mkdir(parents=True, exist_ok=True)
        for k in ks:
            name = k.replace("/", "_")
            shutil.copy(FRAMES / f"{k}.jpg", YOLO / "images" / split / f"{name}.jpg")
            txt = (yolo_line(0, lab[k]) if lab[k] else "") + (yolo_line(1, pl[k]) if pl.get(k) else "")
            txt += "".join(yolo_line(2, b) for b in dr.get(k, []))
            (YOLO / "labels" / split / f"{name}.txt").write_text(txt, encoding="utf-8")
    (YOLO / "data.yaml").write_text(f"path: {YOLO.as_posix()}\ntrain: images/train\nval: images/val\nnames:\n  0: boss\n  1: player\n"
                                    + ("  2: dragon\n" if DRAGON else ""),
                                    encoding="utf-8")


def train(model="yolo11l.pt", epochs=150, imgsz=640, name="run", batch=16):
    from ultralytics import YOLO as Y

    build_dataset()
    m = Y(model)
    m.train(data=str(YOLO / "data.yaml"), epochs=epochs, imgsz=imgsz, batch=batch, project=str(YOLO), name=name,
            exist_ok=True, workers=4, verbose=False, patience=0, plots=False)


def weights():
    return str(YOLO / "run/weights/best.pt")


RAW = G0 / "raw_boxes"  # per round: frame name -> top boxes [[x1, y1, x2, y2, conf], ...] (conf >= 0.03)
OFFS = (-6, -3, 0, 3, 6)  # frames around a decision frame d: <d>_o-6, <d>_p, <d>, <d>_o3, <d>_o6
DET = {"imgsz": 640, "augment": True}  # the predict settings picked on the dev set (gate0_check_labels.json)


def frame_name(d, o):
    return f"{d}" if o == 0 else f"{d}_p" if o == -3 else f"{d}_o{o}"


def detect_raw(rounds=None, w=None, out_dir=RAW, imgsz=None, augment=None):
    """Top-5 boss boxes (class 0, conf >= 0.03) on every cut frame."""
    from ultralytics import YOLO as Y

    m = Y(w or weights())
    imgsz = imgsz or DET["imgsz"]
    augment = DET["augment"] if augment is None else augment
    man = json.loads((FRAMES / "manifest.json").read_text(encoding="utf-8"))
    out_dir.mkdir(parents=True, exist_ok=True)
    for j in man:
        if rounds and j["round"] not in rounds:
            continue
        od = FRAMES / j["round"]
        names = sorted({p.stem for p in od.glob("*.jpg")})
        out = {}
        for s in range(0, len(names), 16):
            batch = names[s:s + 16]
            res = m.predict([str(od / f"{n}.jpg") for n in batch], imgsz=imgsz, conf=0.03, classes=[0, 2],
                            verbose=False, augment=augment)
            for n, r in zip(batch, res):
                bs = sorted(zip(r.boxes.conf.tolist(), r.boxes.xyxy.tolist(), r.boxes.cls.tolist()), reverse=True)
                boss = [x for x in bs if x[2] == 0][:5]
                drag = [x for x in bs if x[2] == 2][:3]
                out[n] = [[round(v, 1) for v in b] + [round(c, 3), int(k)] for c, b, k in boss + drag]
        (out_dir / f"{j['round']}.json").write_text(json.dumps(out), encoding="utf-8")
        print(j["round"], len(out), flush=True)


def boss_only(boxes, drag_iou=0.5):
    """Boss boxes (class 0) of one frame, minus those a more confident dragon box (class 2) covers (IoU >= drag_iou)."""
    boss = [b for b in boxes if len(b) < 6 or b[5] == 0]
    drag = [b for b in boxes if len(b) >= 6 and b[5] == 2]
    return [b for b in boss if not any(d[4] > b[4] and iou(b, d) >= drag_iou for d in drag)]


def fuse_one(raw, d, conf=CONF, low=0.05, support=0.3):
    """Boss box at decision frame d from the raw boxes of d and its neighbours (dragon-covered boxes dropped first).

    1. the best box at d with conf >= conf;
    2. else a box at d with conf >= low that overlaps (IoU >= support) a box with conf >= conf at a neighbour frame;
    3. else none (a neighbour-only position is not used: the boss may really be gone at d).
    -> (box | None, conf, source)"""
    raw = {k: boss_only(v) for k, v in raw.items()}
    cur = raw.get(frame_name(d, 0), [])
    if cur and cur[0][4] >= conf:
        return cur[0][:4], cur[0][4], "d"
    nb = [b for o in OFFS if o for b in raw.get(frame_name(d, o), []) if b[4] >= conf]
    best = None
    for b in cur:
        if b[4] < low:
            break
        sup = max((iou(b, n) for n in nb), default=0)
        if sup >= support and (best is None or b[4] > best[1]):
            best = (b[:4], b[4], "d+nb")
    return best or (None, cur[0][4] if cur else 0.0, "none")


def fuse_all(rounds=None, **kw):
    man = json.loads((FRAMES / "manifest.json").read_text(encoding="utf-8"))
    BOXES.mkdir(parents=True, exist_ok=True)
    for j in man:
        if rounds and j["round"] not in rounds:
            continue
        raw = json.loads((RAW / f"{j['round']}.json").read_text(encoding="utf-8"))
        out = {}
        for it in j["items"]:
            d = it["d"]
            for key, dd in ((str(d), d), (f"{d}_p", d - 3)):
                if key in out:
                    continue
                if key == str(d):
                    b, c, src = fuse_one(raw, d, **kw)
                else:  # the d-3 frame: its own boxes only (what a tracker would have had)
                    cur = boss_only(raw.get(f"{d}_p", []))
                    b, c, src = (cur[0][:4], cur[0][4], "d") if cur and cur[0][4] >= kw.get("conf", CONF) else                         (None, cur[0][4] if cur else 0.0, "none")
                out[key] = {"box": b, "conf": round(float(c), 3), "src": src}
        (BOXES / f"{j['round']}.json").write_text(json.dumps(out), encoding="utf-8")
    print("fused", len(man), "rounds ->", BOXES)


def dev_eval(raw_dir=RAW, **kw):
    """Dev-set score of the fused boxes (gate0_check_labels.json): right = IoU >= 0.4 with the hand box, or no box
    where the hand label says the boss is not visible."""
    gt = json.loads((HERE / "gate0_check_labels.json").read_text(encoding="utf-8"))["labels"]
    c = {"right": 0, "none_right": 0, "miss": 0, "false": 0, "off": 0}
    for k, g in gt.items():
        rnd, d = k.split("/")
        raw = json.loads((raw_dir / f"{rnd}.json").read_text(encoding="utf-8"))
        b, _, _ = fuse_one(raw, int(d), **kw)
        if g is None:
            c["none_right" if b is None else "false"] += 1
        elif b is None:
            c["miss"] += 1
        else:
            c["right" if iou(b, g) >= 0.4 else "off"] += 1
    return c, (c["right"] + c["none_right"]) / len(gt)


def check(name="check_eye", seed=11, n=60):
    """60 random decision frames never used for training or tuning (none within 15 frames of a hand-labelled or dev
    frame of the same round) with the final boss box drawn, 3x2 per sheet -> data/moveid/gate0/check/. Graded by eye."""
    import cv2
    import numpy as np

    sets = json.loads((G0 / "label_set.json").read_text(encoding="utf-8"))
    if name not in sets:
        used = [k.split("/") for k in json.loads(LABELS.read_text(encoding="utf-8"))]
        used += [k.split("/") for v in sets.values() for k in v]
        near = {(r, int(f) + o) for r, f in used for o in range(-15, 16)}
        man = json.loads((FRAMES / "manifest.json").read_text(encoding="utf-8"))
        pool = sorted({f"{j['round']}/{it['d']}" for j in man for it in j["items"]
                       if it["ok"] and (j["round"], it["d"]) not in near})
        sets[name] = random.Random(seed).sample(pool, n)
        (G0 / "label_set.json").write_text(json.dumps(sets, indent=0), encoding="utf-8")
    keys = sets[name]
    od = G0 / "check"
    od.mkdir(parents=True, exist_ok=True)
    for p in od.glob("*.jpg"):
        p.unlink()
    tiles = []
    for k in keys:
        rnd, f = k.split("/")
        bb = json.loads((BOXES / f"{rnd}.json").read_text(encoding="utf-8")).get(f)
        a = cv2.imread(str(FRAMES / f"{k}.jpg"))
        t = f"{k} none"
        if bb and bb["box"]:
            x1, y1, x2, y2 = map(int, bb["box"])
            cv2.rectangle(a, (x1, y1), (x2, y2), (0, 255, 0), 4)
            t = f"{k} {bb['conf']:.2f} {bb.get('src', '')}"
        a = cv2.resize(a, (540, 360))
        cv2.putText(a, f"{len(tiles)}: {t}", (6, 24), 0, 0.7, (0, 255, 255), 2)
        tiles.append(a)
    per = 6
    for s in range(0, len(tiles), per):
        t = tiles[s:s + per]
        while len(t) < per:
            t.append(np.zeros_like(tiles[0]))
        cv2.imwrite(str(od / f"{name}_{s:02d}.jpg"), np.vstack([np.hstack(t[i:i + 2]) for i in range(0, per, 2)]),
                    [cv2.IMWRITE_JPEG_QUALITY, 88])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["train", "detect", "fuse", "check"])
    ap.add_argument("--model", default="yolo11l.pt")
    ap.add_argument("--epochs", type=int, default=150)
    ap.add_argument("--rounds", nargs="*")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--name", default="run")
    a = ap.parse_args()
    if a.cmd == "train":
        train(a.model, a.epochs, a.imgsz, a.name, a.batch)
    elif a.cmd == "detect":
        detect_raw(a.rounds)
        fuse_all(a.rounds)
    elif a.cmd == "fuse":
        fuse_all(a.rounds)
    else:
        check()


if __name__ == "__main__":
    sys.exit(main())
