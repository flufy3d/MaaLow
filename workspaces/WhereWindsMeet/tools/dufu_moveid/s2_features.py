"""Order 2 prerequisite: per-frame visual embeddings + motion energy of every recording (see README "顺序 2：逐帧特征").

    uv run --no-project --with torch --with timm --with av --with opencv-python-headless --with numpy \
        --index https://download.pytorch.org/whl/cu130 --index-strategy unsafe-best-match \
        python workspaces/WhereWindsMeet/tools/dufu_moveid/s2_features.py [--procs 2] [--only ID,ID] [--first N]

For each recording in data/moveid/index.json, every frame (no stride) -> s2_views.views() (glob 384x240, big 530->192,
small 260->192, INTER_AREA) ->
  glob / big / small         [frames, 384] float16: DINOv3 ViT-S+/16 (facebook/dinov3-vits16plus-pretrain-lvd1689m,
                             loaded through timm) CLS token after the final norm; input RGB, /255, ImageNet mean / std, views at their own
                             size (patch 16 divides 384x240 and 192 exactly; DINOv3 uses RoPE, no position resampling)
  mot_glob / mot_big / mot_small  [frames] float32: mean |gray(t) - gray(t-1)| of the view (0..255, uint8 gray from
                             cv2.cvtColor BGR2GRAY on the resized view); frame 0 = 0
  model, frames, boxes (json of s2_views.boxes())
-> data/moveid/emb/<id>.npz (written to a temp name, then renamed). Done recordings are skipped (status.json entry
ok and the npz present, same model); data/moveid/emb/status.json is rewritten after each recording.
Decoding: PyAV (FFmpeg h264, frame threads) on the CPU; NVDEC through PyAV's h264_cuvid was slower (~110 fps, one
frame at a time) than threaded CPU decoding. Crops, INTER_AREA and gray run on the GPU (s2_views.area_weights; cv2's
INTER_AREA at 2.8x took ~10 ms per frame per core and was the bottleneck); every recording re-checks 2 random frames
against s2_views.views() (status `view_maxdiff`, max |difference| in uint8 levels).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
REPO = HERE.parents[3]
OUT = REPO / "data" / "moveid"
EMB = OUT / "emb"
STATUS = EMB / "status.json"
MODEL = "timm/vit_small_plus_patch16_dinov3.lvd1689m"
# what is stored in the npz / status: the official DINOv3 ViT-S+/16; timm's copy gives the same CLS (cosine 1.0000 vs
# transformers AutoModel facebook/dinov3-vits16plus-pretrain-lvd1689m pooler_output, checked 2026-10-24)
MODEL_NAME = "facebook/dinov3-vits16plus-pretrain-lvd1689m (timm vit_small_plus_patch16_dinov3.lvd1689m), CLS"
BATCH = 64

def write_json(path: Path, obj) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


class _Graphed:
    """The model at one fixed input size (RoPE table cached, no CPU work per call) captured as a CUDA graph: per-call
    launch overhead dominated on this Windows / WDDM laptop GPU (batch 32 eager ~300 img/s, graph at 64 ~770)."""

    def __init__(self, hw: tuple[int, int], batch: int):
        import timm
        import torch
        m = timm.create_model(MODEL.split("/", 1)[1], pretrained=True, num_classes=0, global_pool="token",
                              img_size=hw, dynamic_img_size=False).cuda().eval().half()
        self.m, self.batch = m, batch
        self.x = torch.zeros(batch, 3, *hw, device="cuda", dtype=torch.half)
        with torch.inference_mode():
            st = torch.cuda.Stream()
            st.wait_stream(torch.cuda.current_stream())
            with torch.cuda.stream(st):
                for _ in range(3):
                    m(self.x)
            torch.cuda.current_stream().wait_stream(st)
            self.g = torch.cuda.CUDAGraph()
            with torch.cuda.graph(self.g):
                self.y = m(self.x)

    def __call__(self, x):  # [n <= batch, 3, h, w] half (normalised) -> [n, D] float16 numpy
        n = x.shape[0]
        self.x[:n].copy_(x)
        if n < self.batch:
            self.x[n:].zero_()
        self.g.replay()
        return self.y[:n].float().cpu().numpy().astype(np.float16)


_models: dict = {}


def _init(mem_frac: float) -> None:
    import torch
    from s2_views import CROP_OUT, GLOB_SIZE
    torch.cuda.set_per_process_memory_fraction(mem_frac)
    torch.backends.cuda.matmul.allow_tf32 = False
    _models["glob"] = _Graphed((GLOB_SIZE[1], GLOB_SIZE[0]), BATCH)
    _models["crop"] = _Graphed((CROP_OUT, CROP_OUT), 2 * BATCH)


def _decode_proc(path: str, shm_name: str, shape: tuple, free_q, full_q) -> None:
    """Decoder process (never imports torch: with torch loaded in the same process PyAV decodes ~10x slower on this
    Windows box): full BGR frames into shared-memory slots of BATCH frames; full_q gets (slot, n), then None."""
    import av
    from multiprocessing import shared_memory
    shm = shared_memory.SharedMemory(name=shm_name)
    try:
        ring = np.ndarray(shape, np.uint8, buffer=shm.buf)
        c = av.open(path)
        s = c.streams.video[0]
        s.thread_type = "AUTO"
        slot, k = free_q.get(), 0
        for f in c.decode(s):
            ring[slot, k] = f.to_ndarray(format="bgr24")
            k += 1
            if k == BATCH:
                full_q.put((slot, k))
                slot, k = free_q.get(), 0
        if k:
            full_q.put((slot, k))
        c.close()
        full_q.put(None)
    except BaseException as e:  # noqa: BLE001 - reported to the consumer
        full_q.put(("error", repr(e)))
    finally:
        del ring
        shm.close()


def _frames(path: str, slots: int = 4):
    """Yield [n, H, W, 3] uint8 numpy views of decoded batches (valid until the next one is requested)."""
    import multiprocessing as mp
    from multiprocessing import shared_memory
    import av
    with av.open(path) as c:
        cc = c.streams.video[0].codec_context
        w, h = cc.width, cc.height
    shape = (slots, BATCH, h, w, 3)
    shm = shared_memory.SharedMemory(create=True, size=int(np.prod(shape)))
    ctx = mp.get_context("spawn")
    free_q, full_q = ctx.Queue(), ctx.Queue()
    for i in range(slots):
        free_q.put(i)
    pr = ctx.Process(target=_decode_proc, args=(path, shm.name, shape, free_q, full_q), daemon=True)
    pr.start()
    ring = np.ndarray(shape, np.uint8, buffer=shm.buf)
    ptr = None
    try:  # page-lock the ring so host->GPU copies are DMA (pageable copies ran at ~1 GB/s)
        import torch
        ptr = ring.ctypes.data
        if torch.cuda.cudart().cudaHostRegister(ptr, ring.nbytes, 0) != 0:
            ptr = None
    except Exception:  # noqa: BLE001 - optional speed-up
        ptr = None
    try:
        while (item := full_q.get()) is not None:
            if item[0] == "error":
                raise RuntimeError(item[1])
            slot, n = item
            yield ring[slot, :n]
            free_q.put(slot)
        pr.join()
    finally:
        if pr.is_alive():
            pr.terminate()
        if ptr is not None:
            torch.cuda.cudart().cudaHostUnregister(ptr)
        del ring
        shm.close()
        shm.unlink()


class _Views:
    """s2_views on the GPU: crop + INTER_AREA as area_weights() matrices (float32, no TF32), rounded to uint8; gray as
    cv2 BGR2GRAY for uint8 ((4899 R + 9617 G + 1868 B + 8192) >> 14)."""

    def __init__(self, w: int, h: int):
        import torch
        from s2_views import CROP_OUT, GLOB_SIZE, area_weights, boxes
        self.bx = boxes(w, h)
        self.mats = {}
        for name, (x, y, bw, bh) in self.bx.items():
            ow, oh = GLOB_SIZE if name == "glob" else (CROP_OUT, CROP_OUT)
            self.mats[name] = (torch.tensor(area_weights(bh, oh), dtype=torch.float32, device="cuda"),
                               torch.tensor(area_weights(bw, ow).T, dtype=torch.float32, device="cuda"))

    def __call__(self, frames):  # [N, H, W, 3] uint8 cuda (BGR) -> {name: [N, 3, oh, ow] uint8 BGR}
        import torch
        out = {}
        for name, (x, y, bw, bh) in self.bx.items():
            wy, wx = self.mats[name]
            c = frames[:, y:y + bh, x:x + bw].permute(0, 3, 1, 2).float()
            out[name] = torch.round(wy @ c @ wx).clamp_(0, 255).to(torch.uint8)
        return out

    @staticmethod
    def gray(v):
        import torch
        v = v.to(torch.int32)
        return ((v[:, 2] * 4899 + v[:, 1] * 9617 + v[:, 0] * 1868 + 8192) >> 14).to(torch.int16)


def process(rec: str, video: str, expected: int) -> dict:
    import torch
    torch.backends.cuda.matmul.allow_tf32 = False
    t0 = time.time()
    mean = torch.tensor([0.485, 0.456, 0.406], device="cuda").view(1, 3, 1, 1) * 255
    std = torch.tensor([0.229, 0.224, 0.225], device="cuda").view(1, 3, 1, 1) * 255

    def embed(v, which):  # [N, 3, h, w] uint8 BGR -> [N, D] float16 numpy
        return _models[which](((v.flip(1).float() - mean) / std).half())

    from s2_views import views
    rng = np.random.default_rng(int(rec.replace("-", "")) % 2**32)
    check = set(rng.choice(max(expected, 1), min(2, expected), replace=False).tolist())
    vmax, base = 0, 0
    vw = None
    out = {"glob": [], "big": [], "small": []}
    mots, prev = [], {}
    gpu_s = 0.0
    with torch.inference_mode():
        for fr in _frames(str(REPO / video)):
            t1 = time.time()
            g = torch.from_numpy(fr).cuda()
            vw = vw or _Views(g.shape[2], g.shape[1])
            v = vw(g)
            del g
            for j in [i - base for i in check if base <= i < base + len(fr)]:
                ref = views(fr[j], vw.bx)          # check against the cv2 reference (s2_views.views)
                for k in ref:
                    got = v[k][j].permute(1, 2, 0).cpu().numpy().astype(int)
                    vmax = max(vmax, int(np.abs(got - ref[k].astype(int)).max()))
            base += len(fr)
            m = []
            for k in ("glob", "big", "small"):
                gk = vw.gray(v[k])                                   # [N, h, w]
                pk = torch.cat([prev.get(k, gk[:1]), gk[:-1]])
                m.append((gk - pk).abs().float().mean((1, 2)))
                prev[k] = gk[-1:]
            mots.append(torch.stack(m, 1).cpu().numpy())
            out["glob"].append(embed(v["glob"], "glob"))
            n = v["big"].shape[0]
            e = embed(torch.cat([v["big"], v["small"]]), "crop")
            out["big"].append(e[:n])
            out["small"].append(e[n:])
            gpu_s += time.time() - t1
    arr = {k: np.concatenate(v) for k, v in out.items()}
    mot = np.concatenate(mots).astype(np.float32)
    n = len(mot)
    tmp = EMB / f"{rec}.tmp.npz"
    np.savez(tmp, glob=arr["glob"], big=arr["big"], small=arr["small"],
             mot_glob=mot[:, 0], mot_big=mot[:, 1], mot_small=mot[:, 2],
             model=np.array(MODEL_NAME), frames=np.array(n), boxes=np.array(json.dumps(vw.bx)))
    os.replace(tmp, EMB / f"{rec}.npz")
    sec = time.time() - t0
    return {"rec": rec, "ok": n == expected, "frames": n, "expected": expected, "sec": round(sec, 1),
            "fps": round(n / sec, 1), "gpu_sec": round(gpu_s, 1), "dim": int(arr["glob"].shape[1]),
            "view_maxdiff": vmax, "bytes": (EMB / f"{rec}.npz").stat().st_size, "model": MODEL_NAME,
            "gpu_mem_gb": round(torch.cuda.max_memory_reserved() / 1e9, 2)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--procs", type=int, default=2)
    ap.add_argument("--mem", type=float, default=0.25, help="GPU memory fraction per process (16 GB card)")
    ap.add_argument("--only", default="")
    ap.add_argument("--first", type=int, default=0)
    a = ap.parse_args()
    EMB.mkdir(parents=True, exist_ok=True)
    idx = json.loads((OUT / "index.json").read_text(encoding="utf-8"))
    todo = [(r["rec"], r["video"], r["frames"]) for r in idx["rounds"]]
    if a.only:
        keep = set(a.only.split(","))
        todo = [t for t in todo if t[0] in keep]
    if a.first:
        todo = todo[:a.first]
    st = json.loads(STATUS.read_text(encoding="utf-8")) if STATUS.exists() else {}
    st["model"] = MODEL_NAME
    done = st.setdefault("recs", {})
    for rid in [r for r, d in done.items() if d.get("model") != MODEL_NAME]:
        del done[rid]
    todo = [t for t in todo if not (done.get(t[0], {}).get("ok") and (EMB / f"{t[0]}.npz").exists())]
    print(f"{len(todo)} recordings to do", flush=True)
    t0 = time.time()
    nf = 0
    with ProcessPoolExecutor(a.procs, initializer=_init, initargs=(a.mem,)) as ex:
        futs = {ex.submit(process, *t): t for t in todo}
        for i, fu in enumerate(as_completed(futs), 1):
            rec = futs[fu][0]
            try:
                r = fu.result()
            except Exception as e:  # noqa: BLE001
                r = {"rec": rec, "ok": False, "error": repr(e)}
            done[rec] = r
            nf += r.get("frames", 0)
            el = time.time() - t0
            st.update(updated=time.strftime("%Y-%m-%d %H:%M:%S"), last_run={
                "recs": i, "of": len(todo), "frames": nf, "sec": round(el, 1), "fps": round(nf / max(el, 1e-9), 1)})
            st["n_ok"] = sum(1 for d in done.values() if d.get("ok"))
            st["n_frames"] = sum(d.get("frames", 0) for d in done.values() if d.get("ok"))
            st["bytes"] = sum(d.get("bytes", 0) for d in done.values() if d.get("ok"))
            write_json(STATUS, st)
            print(f"[{i}/{len(todo)}] {rec} ok={r['ok']} frames={r.get('frames')} {r.get('fps')} fps "
                  f"total {nf / max(el, 1e-9):.0f} fps {r.get('error', '')}", flush=True)
    print(json.dumps(st.get("last_run"), ensure_ascii=False))


if __name__ == "__main__":
    main()
