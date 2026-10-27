"""Order 3: cache frozen DINOv3 patch tokens of the frames the teacher trains / is evaluated on.

    uv run --no-project --with torch --with timm --with av --with opencv-python-headless --with numpy \
        --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match \
        python workspaces/WhereWindsMeet/tools/dufu_moveid/s3_cache.py [--procs 2] [--only ID,ID] [--first N]

Frames = s3_common.frame_plan() per recording (every contact's [c - 61, c] + idle stretches with history; ~447k of
737k frames). Each frame -> s2_views (glob 384x240, big 530->192, small 260->192; GPU area matrices exactly as
s2_features) -> DINOv3 ViT-S+/16 (timm vit_small_plus_patch16_dinov3.lvd1689m, the same weights as the order-2 CLS)
forward_features (after the final norm) at native view size, fp16. Kept tokens per frame (651, registers dropped):
  [glob CLS, big CLS, small CLS, glob patches 15x24 (row-major), big patches 12x12, small patches 12x12]
Stored int8 with one fp16 scale per token (absmax / 127):
  cache/<rec>.tok     raw int8 [n, 651, 384]   (n = len(frames))
  cache/<rec>.npz     frames [n] int32 (video frame numbers), scale [n, 651] float16, model, layout
  cache/status.json   per recording ok / n / seconds, plus totals
Done recordings (status ok, files present, same model) are skipped, so the script resumes.
"""
from __future__ import annotations

import argparse
import collections
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from s3_common import CACHE, OUT, REPO, frame_plan, load, read_json, write_json  # noqa: E402

MODEL = "vit_small_plus_patch16_dinov3.lvd1689m"
MODEL_NAME = "facebook/dinov3-vits16plus-pretrain-lvd1689m (timm vit_small_plus_patch16_dinov3.lvd1689m), forward_features"
LAYOUT = "glob_cls,big_cls,small_cls,glob_15x24,big_12x12,small_12x12"
N_TOK = 3 + 360 + 144 + 144
DIM = 384
BATCH = 64
STATUS = CACHE / "status.json"


class _Tokens:
    """forward_features at one fixed input size, eager fp16 (a CUDA graph of forward_features returned NaN here,
    and eager at batch 64 is as fast: ~680 img/s at 384x240, ~2600 img/s at 192x192)."""

    def __init__(self, hw, batch):
        import timm
        self.m = timm.create_model(MODEL, pretrained=True, num_classes=0, img_size=hw,
                                   dynamic_img_size=False).cuda().eval().half()
        self.npre = self.m.num_prefix_tokens

    def __call__(self, x):  # [n, 3, h, w] half -> [n, 1 + P, D] half (CLS + patches, registers dropped)
        import torch
        y = self.m.forward_features(x)
        return torch.cat([y[:, :1], y[:, self.npre:]], 1)


_models: dict = {}


def _init(mem_frac: float) -> None:
    import torch
    from s2_views import CROP_OUT, GLOB_SIZE
    torch.cuda.set_per_process_memory_fraction(mem_frac)
    torch.backends.cuda.matmul.allow_tf32 = False
    _models["glob"] = _Tokens((GLOB_SIZE[1], GLOB_SIZE[0]), BATCH)
    _models["crop"] = _Tokens((CROP_OUT, CROP_OUT), BATCH)


def process(rec: str, video: str, frames: np.ndarray) -> dict:
    import torch
    from s2_features import _frames, _Views
    torch.backends.cuda.matmul.allow_tf32 = False
    t0 = time.time()
    mean = torch.tensor([0.485, 0.456, 0.406], device="cuda").view(1, 3, 1, 1) * 255
    std = torch.tensor([0.229, 0.224, 0.225], device="cuda").view(1, 3, 1, 1) * 255
    want = np.zeros(int(frames.max()) + 1 if len(frames) else 0, bool)
    want[frames] = True
    tok_path = CACHE / f"{rec}.tok.tmp"
    scales, got = [], []
    vw, base = None, 0

    def norm(v):
        return ((v.flip(1).float() - mean) / std).half()

    with open(tok_path, "wb") as fo, torch.inference_mode():
        for fr in _frames(str(REPO / video)):
            sel = [i for i in range(len(fr)) if base + i < len(want) and want[base + i]]
            if sel:
                g = torch.from_numpy(fr[sel]).cuda()
                vw = vw or _Views(g.shape[2], g.shape[1])
                v = vw(g)
                del g
                tg = _models["glob"](norm(v["glob"]))
                tb = _models["crop"](norm(v["big"]))
                ts = _models["crop"](norm(v["small"]))
                t = torch.cat([tg[:, :1], tb[:, :1], ts[:, :1], tg[:, 1:], tb[:, 1:], ts[:, 1:]], 1).float()
                sc = t.abs().amax(2, keepdim=True).clamp_min(1e-6) / 127
                q = torch.round(t / sc).clamp_(-127, 127).to(torch.int8)
                fo.write(q.cpu().numpy().tobytes())
                scales.append(sc[..., 0].half().cpu().numpy())
                got.extend(base + i for i in sel)
            base += len(fr)
            if base >= len(want):
                break
    got = np.array(got, np.int32)
    ok = np.array_equal(got, frames)
    os.replace(tok_path, CACHE / f"{rec}.tok")
    np.savez(CACHE / f"{rec}.tmp.npz", frames=got, scale=np.concatenate(scales) if scales else np.zeros((0, N_TOK)),
             model=np.array(MODEL_NAME), layout=np.array(LAYOUT))
    os.replace(CACHE / f"{rec}.tmp.npz", CACHE / f"{rec}.npz")
    sec = time.time() - t0
    return {"rec": rec, "ok": bool(ok), "n": int(len(got)), "planned": int(len(frames)), "decoded": base,
            "sec": round(sec, 1), "bytes": (CACHE / f"{rec}.tok").stat().st_size, "model": MODEL_NAME}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--procs", type=int, default=2)
    ap.add_argument("--mem", type=float, default=0.3)
    ap.add_argument("--only", default="")
    ap.add_argument("--first", type=int, default=0)
    a = ap.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    d = load()
    idx = read_json(OUT / "index.json")
    video = {r["rec"]: r["video"] for r in idx["rounds"]}
    byrec = collections.defaultdict(list)
    for e in d["events"]:
        byrec[e["rec"]].append(e)
    todo = [(r["rec"], video[r["rec"]], frame_plan(r["frames"], byrec.get(r["rec"], []))) for r in d["recs"]]
    if a.only:
        keep = set(a.only.split(","))
        todo = [t for t in todo if t[0] in keep]
    if a.first:
        todo = todo[:a.first]
    st = read_json(STATUS) if STATUS.exists() else {}
    done = st.setdefault("recs", {})
    todo = [t for t in todo if not (done.get(t[0], {}).get("ok") and done[t[0]].get("model") == MODEL_NAME
                                    and (CACHE / f"{t[0]}.tok").exists() and (CACHE / f"{t[0]}.npz").exists())]
    print(f"{len(todo)} recordings, {sum(len(t[2]) for t in todo)} frames", flush=True)
    t0, nf = time.time(), 0
    with ProcessPoolExecutor(a.procs, initializer=_init, initargs=(a.mem,)) as ex:
        futs = {ex.submit(process, *t): t for t in todo}
        for i, fu in enumerate(as_completed(futs), 1):
            rec = futs[fu][0]
            try:
                r = fu.result()
            except Exception as e:  # noqa: BLE001
                r = {"rec": rec, "ok": False, "error": repr(e)}
            done[rec] = r
            nf += r.get("n", 0)
            el = time.time() - t0
            st.update(model=MODEL_NAME, layout=LAYOUT, updated=time.strftime("%Y-%m-%d %H:%M:%S"),
                      n_ok=sum(1 for x in done.values() if x.get("ok")),
                      n_frames=sum(x.get("n", 0) for x in done.values() if x.get("ok")),
                      bytes=sum(x.get("bytes", 0) for x in done.values() if x.get("ok")),
                      last_run={"recs": i, "of": len(todo), "frames": nf, "sec": round(el, 1)})
            write_json(STATUS, st)
            print(f"[{i}/{len(todo)}] {rec} ok={r['ok']} n={r.get('n')} {r.get('sec')}s "
                  f"total {nf / max(el, 1e-9):.0f} f/s {r.get('error', '')}", flush=True)


if __name__ == "__main__":
    main()
