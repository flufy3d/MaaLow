"""Order 4: the student on the Pad (App API only): per-frame parity with the PC and per-frame timing. Read-only on the
device: the temporary skill (s4_pad_skill.js) calls only screenshot / saveImage / infer.

    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/s4_pad.py run [--src workspaces/WhereWindsMeet/model/dufu2]
        [--runs 12 --k 20] [--providers cpu,qnn] [--time-n 300]
    uv run --no-project --with numpy --with onnxruntime --with opencv-python-headless \
        python workspaces/WhereWindsMeet/tools/dufu_moveid/s4_pad.py compare data/moveid/student/pad/<stamp>
    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/s4_pad.py cleanup     # after an interrupted run

run: checks the Pad is idle (npu_bench.idle: busy null, no skill, not recording, no remote viewer / control) before
every skill call; copies the model files of --src (*.onnx, *.qnn.onnx, *_fp32.onnx) to model/dufu2_pair/ and the skill
to skills/dufu2_pair.js, pushes only those two paths; then
  pair  per provider: `runs` skill runs of `k` frames (each run starts with fresh rings: the PC replays the same
        front padding); every frame's screenshot is saved on the app (captures/dufu2_pair/), downloaded to
        <out>/png/ and deleted on the app; the device's preprocessed views (base64), features and head logits ->
        <out>/pair_<provider>.json
  time  per (provider, threads) in TIME_CONFIGS: `warm` + n frames, no saving -> <out>/time_<provider><threads>.json
and finally deletes the temporary files locally and pushes again (their deletion reaches the app).
compare: PC side of every pair frame: PNG -> s2_views.views() vs the device views (pixel diffs); onnxruntime on the PC
views (device_input) -> features vs the device's; the head on the PC rings (same front padding) vs the device logits
(max |diff|, per-head argmax agreement), and the head on the device's own features (head numerics alone). Model used on
the PC = the file the device ran: cpu -> <name>.onnx, qnn -> <name>.qnn.onnx (fp16 on the HTP vs fp32 here).
-> <out>/compare.json + printed summary; timing summary -> <out>/timing.json.
"""
from __future__ import annotations

import argparse
import base64
import json
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(HERE))

WS = "WhereWindsMeet"
ROOT = REPO / "workspaces"
WS_DIR = ROOT / WS
REMOTE_MODELS = "model/dufu2_pair"
REMOTE_SKILL = "skills/dufu2_pair.js"
SKILL = "dufu2_pair"
CAPTURES = "captures/dufu2_pair"
OUT = REPO / "data/moveid/student/pad"
TIME_CONFIGS = [("cpu", 1), ("cpu", 2), ("qnn", 1)]
MODELS = {"glob": "dufu2_pair/glob.onnx", "crop": "dufu2_pair/crop.onnx", "head": "dufu2_pair/head.onnx"}


def client():
    from maalow.client import Client
    return Client()


def push(c) -> dict:
    from maalow import sync
    return sync.sync(c, WS, ROOT, "push", only=[REMOTE_MODELS, REMOTE_SKILL])


def install(src: Path) -> list[str]:
    dst = WS_DIR / REMOTE_MODELS
    dst.mkdir(parents=True, exist_ok=True)
    names = []
    for p in sorted(src.glob("*.onnx")):
        shutil.copy(p, dst / p.name)
        names.append(p.name)
    shutil.copy(HERE / "s4_pad_skill.js", WS_DIR / REMOTE_SKILL)
    return names


def cleanup(c) -> dict:
    shutil.rmtree(WS_DIR / REMOTE_MODELS, ignore_errors=True)
    (WS_DIR / REMOTE_SKILL).unlink(missing_ok=True)
    out = None
    for attempt in range(5):
        try:
            out = push(c)
            break
        except RuntimeError as e:
            if attempt == 4:
                raise
            print(f"cleanup push failed ({e}); retrying", flush=True)
            time.sleep(10)
    left = [e["path"] for e in c.get(f"/files/{WS}/")
            if e["path"].startswith((REMOTE_MODELS + "/", REMOTE_SKILL, CAPTURES + "/"))]
    for p in [x for x in left if x.startswith(CAPTURES + "/")]:
        c.request("DELETE", f"/files/{WS}/{p}")
    left = [e["path"] for e in c.get(f"/files/{WS}/")
            if e["path"].startswith((REMOTE_MODELS + "/", REMOTE_SKILL, CAPTURES + "/"))]
    return {"push": {k: out.get(k) for k in ("push", "delete_remote")} if isinstance(out, dict) else out,
            "left_on_app": left}


def skill(c, args: dict) -> dict:
    from npu_bench import idle
    ok, st = idle(c)
    if not ok:
        raise SystemExit(json.dumps({"error": "pad not idle", "busy": st.get("busy"), "remote": st.get("remote"),
                                     "record": st.get("record"), "skills": st.get("skills")}, ensure_ascii=False))
    out = c.post("/skill/run", {"name": SKILL, "args": args, "workspace": WS, "timeout": 1_200_000}, timeout=1_300)
    if not (isinstance(out, dict) and out.get("ok")):
        raise RuntimeError(json.dumps(out, ensure_ascii=False)[:2000])
    return out["value"]


def run(a) -> None:
    from npu_bench import idle
    c = client()
    ok, st = idle(c)
    if not ok:
        print(json.dumps({"error": "pad not idle", "busy": st.get("busy"), "remote": st.get("remote")}, ensure_ascii=False))
        return
    out = OUT / time.strftime("%Y%m%d-%H%M%S")
    (out / "png").mkdir(parents=True, exist_ok=True)
    meta = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "src": str(a.src), "status_before": st}
    meta["installed"] = install(Path(a.src))
    meta["push"] = {k: v for k, v in push(c).items() if k in ("push", "delete_remote", "ms")}
    try:
        for prov in a.providers.split(","):
            if a.runs <= 0:
                break
            frames = []
            for r in range(a.runs):
                v = skill(c, {"mode": "pair", "n": a.k, "run": f"{prov}{r:02d}", "models": MODELS, "provider": prov,
                              "threads": 1})
                for f in v["frames"]:
                    f["run"] = r
                    rel = f["png"]
                    c.download(f"/files/{WS}/{rel}", out / "png" / Path(rel).name)
                    c.request("DELETE", f"/files/{WS}/{rel}")
                    f["png_local"] = Path(rel).name
                frames += v["frames"]
                print(f"pair {prov} run {r}: {len(v['frames'])} frames, providers {v['frames'][0]['provider']}", flush=True)
            (out / f"pair_{prov}.json").write_text(json.dumps({"provider": prov, "k": a.k, "frames": frames}), encoding="utf-8")
        for prov, th in TIME_CONFIGS:
            if a.time_n <= 0 or prov not in a.providers.split(","):
                continue
            v = skill(c, {"mode": "time", "n": a.time_n, "warm": a.warm, "models": MODELS, "provider": prov, "threads": th})
            (out / f"time_{prov}{th}.json").write_text(json.dumps(v), encoding="utf-8")
            print(f"time {prov}{th}: {summary(v['frames'])}", flush=True)
    finally:
        meta["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
        meta["cleanup"] = cleanup(c)
        meta["status_after"] = c.get("/status")
        (out / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"-> {out}; cleanup {meta['cleanup']}")


def pct(v, p):
    import statistics
    s = sorted(v)
    return round(s[min(len(s) - 1, int(p * len(s)))], 3) if s else None


def summary(frames: list[dict]) -> dict:
    calls = ("glob", "big", "small", "head")
    pipe = [sum(f["ms"][k]["total"] for k in calls) for f in frames]
    prep = [sum(f["ms"][k]["prep"] for k in calls) for f in frames]
    runm = [sum(f["ms"][k].get("run", 0) for k in calls) for f in frames]
    wall = [f["wall"] for f in frames]
    shot = [f["shot_wall"] for f in frames]
    r = {"n": len(frames), "pipeline_p50": pct(pipe, .5), "pipeline_p95": pct(pipe, .95), "prep_p50": pct(prep, .5),
         "run_p50": pct(runm, .5), "wall_incl_screenshot_p50": pct(wall, .5), "wall_incl_screenshot_p95": pct(wall, .95),
         "screenshot_p50": pct(shot, .5), "screenshot_p95": pct(shot, .95),
         "providers": sorted({",".join(str(x) for x in f["provider"]) for f in frames})}
    for k in calls:
        r[f"{k}_total_p50"] = pct([f["ms"][k]["total"] for f in frames], .5)
        r[f"{k}_run_p50"] = pct([f["ms"][k].get("run", 0) for f in frames], .5)
    return r


def compare(d: Path) -> None:
    import cv2
    import numpy as np
    import onnxruntime as ort
    from s2_views import boxes, views
    from s4_common import C_DIM, G_DIM, RING, device_input, heads, n_out
    from s3_common import read_json
    from s3b_gate1 import PREFIX
    G = len(read_json(PREFIX / "prefix.json")["groups"])
    hs = heads(G)
    meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
    src = Path(meta["src"])
    res = {}
    for pf in sorted(d.glob("pair_*.json")):
        prov = pf.stem.split("_", 1)[1]
        P = json.loads(pf.read_text(encoding="utf-8"))
        suf = ".qnn.onnx" if prov == "qnn" else ".onnx"
        S = {n: ort.InferenceSession(str(src / f"{n}{suf}"), providers=["CPUExecutionProvider"]) for n in ("glob", "crop", "head")}
        px = {"glob": [], "big": [], "small": []}
        feat = {"glob": [], "big": [], "small": []}
        rows = []
        by_run: dict[int, list] = {}
        for f in P["frames"]:
            img = cv2.imread(str(d / "png" / f["png_local"]), cv2.IMREAD_COLOR)
            assert img.shape[:2] == (f["h"], f["w"]), (img.shape, f["w"], f["h"])
            v = views(img, boxes(img.shape[1], img.shape[0]))
            pcf = {}
            for nm in ("glob", "big", "small"):
                dev = np.frombuffer(base64.b64decode(f["input"][nm]), np.uint8).reshape(v[nm].shape)
                diff = np.abs(dev.astype(int) - v[nm].astype(int))
                px[nm].append((int(diff.max()), float((diff > 0).mean()), float(diff.mean())))
                x = device_input(v[nm].transpose(2, 0, 1)[None])
                pcf[nm] = S["glob" if nm == "glob" else "crop"].run(None, {"image": x})[0][0]
                devf = np.array(f["feat"][nm], np.float32)
                feat[nm].append((float(np.abs(devf - pcf[nm]).max()), float(np.abs(pcf[nm]).max())))
            by_run.setdefault(f["run"], []).append((f, pcf))
        hist = np.array([2, 2, 2, 0], np.float32)
        for r, items in by_run.items():
            pcr = {"glob": [], "big": [], "small": []}
            devr = {"glob": [], "big": [], "small": []}
            for f, pcf in items:
                for nm in pcr:
                    pcr[nm].append(pcf[nm])
                    devr[nm].append(np.array(f["feat"][nm], np.float32))

                def ringify(lst, aux):
                    x = np.stack(lst[-RING:])
                    if len(x) < RING:
                        x = np.concatenate([np.repeat(x[:1], RING - len(x), 0), x])
                    return np.concatenate([x, np.repeat(aux[None], RING, 0)], 1)[None].astype(np.float32)
                z = np.zeros(1, np.float32)
                feeds_pc = {"glob": ringify(pcr["glob"], hist), "big": ringify(pcr["big"], z), "small": ringify(pcr["small"], z)}
                feeds_dev = {"glob": ringify(devr["glob"], hist), "big": ringify(devr["big"], z), "small": ringify(devr["small"], z)}
                y_pc = S["head"].run(None, feeds_pc)[0][0]
                y_devfeat = S["head"].run(None, feeds_dev)[0][0]
                y_dev = np.array(f["logits"], np.float32)
                ring_sum = float(sum(float(np.float32(x)) for k in ("glob",) for x in feeds_dev[k].ravel()))
                rows.append({"run": r, "i": f["i"], "y_pc": y_pc, "y_devfeat": y_devfeat, "y_dev": y_dev,
                             "ring_len": (f.get("ring") or {}).get("len"), "ring_sum_dev": (f.get("ring") or {}).get("sum"),
                             "ring_sum_pc_from_dev_feats": ring_sum})

        def sm(y, a_, e_):
            z_ = y[a_:e_] - y[a_:e_].max()
            return np.exp(z_) / np.exp(z_).sum()
        out = {"frames": len(P["frames"]), "runs": len(by_run), "model_suffix": suf,
               "providers_used": sorted({",".join(str(x) for x in f["provider"]) for f in P["frames"]}),
               "fallbacks": sorted({json.dumps(f.get("fallback")) for f in P["frames"]})}
        for nm in px:
            a_ = np.array(px[nm])
            out[f"pixels_{nm}"] = {"max_abs": int(a_[:, 0].max()), "frac_pixels_differ_mean": round(float(a_[:, 1].mean()), 6),
                                   "frac_pixels_differ_max": round(float(a_[:, 1].max()), 6), "mean_abs": round(float(a_[:, 2].mean()), 6),
                                   "frames_identical": int((a_[:, 0] == 0).sum())}
            fa = np.array(feat[nm])
            out[f"feat_{nm}"] = {"max_abs": round(float(fa[:, 0].max()), 5), "p50_abs": round(float(np.median(fa[:, 0])), 5),
                                 "ref_absmax_p50": round(float(np.median(fa[:, 1])), 3)}
        for key, ref in (("device_vs_pc", "y_pc"), ("device_vs_pc_head_on_device_features", "y_devfeat")):
            dd = {"logit_max_abs": round(float(max(np.abs(x["y_dev"] - x[ref]).max() for x in rows)), 5)}
            for nm, a_, e_ in hs:
                ag = [int(np.argmax(x["y_dev"][a_:e_]) == np.argmax(x[ref][a_:e_])) for x in rows]
                pd = [float(np.abs(sm(x["y_dev"], a_, e_) - sm(x[ref], a_, e_)).max()) for x in rows]
                dd[nm] = {"argmax_agree": f"{sum(ag)}/{len(ag)}", "prob_max_abs": round(max(pd), 5),
                          "prob_p50_abs": round(float(np.median(pd)), 6)}
            out[key] = dd
        out["ring_len_ok"] = sum(1 for x in rows if x["ring_len"] == min(RING, x["i"] + 1))
        out["ring_sum_max_abs"] = max(abs(x["ring_sum_dev"] - x["ring_sum_pc_from_dev_feats"]) for x in rows if x["ring_sum_dev"] is not None)
        res[prov] = out
        print(prov, json.dumps(out, ensure_ascii=False), flush=True)
    timing = {}
    for tf in sorted(d.glob("time_*.json")):
        v = json.loads(tf.read_text(encoding="utf-8"))
        timing[tf.stem[5:]] = summary(v["frames"])
        print(tf.stem, timing[tf.stem[5:]])
    for pf in sorted(d.glob("pair_*.json")):   # pair frames carry timings too (with input: true + saveImage)
        timing["pair_" + pf.stem[5:] + "_with_input_and_png"] = summary(json.loads(pf.read_text(encoding="utf-8"))["frames"])
    (d / "compare.json").write_text(json.dumps(res, indent=1, ensure_ascii=False), encoding="utf-8")
    (d / "timing.json").write_text(json.dumps(timing, indent=1, ensure_ascii=False), encoding="utf-8")


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="op", required=True)
    p = sub.add_parser("run")
    p.add_argument("--src", default=str(WS_DIR / "model" / "dufu2"))
    p.add_argument("--runs", type=int, default=12)
    p.add_argument("--k", type=int, default=20)
    p.add_argument("--providers", default="cpu,qnn")
    p.add_argument("--time-n", type=int, default=300)
    p.add_argument("--warm", type=int, default=30)
    p = sub.add_parser("compare")
    p.add_argument("dir", type=Path)
    sub.add_parser("cleanup")
    a = ap.parse_args()
    if a.op == "run":
        run(a)
    elif a.op == "compare":
        compare(a.dir)
    else:
        print(json.dumps(cleanup(client()), indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
