"""Order 5: game-screen parity of the dufu2 pipeline on the Pad (pair frames of a dufu2 run with args.pair).

    uv run --no-project --with numpy --with onnxruntime --with opencv-python-headless \
        python workspaces/WhereWindsMeet/tools/dufu_moveid/s5_pair.py data/moveid/live/r001 [...]

Per dufu2_pair event (events.json; screenshot in rNNN/png/, s5_pull.py downloads it):
  views     the device's preprocessed views (infer input: true, HWC uint8) vs s2_views.views() of the same PNG on the
            PC (the training preprocessing): max |diff|, share of pixels that differ
  features  glob / crop ONNX on the PC views vs the device's newest ring entry (cpu -> <name>.onnx; qnn ->
            <name>.qnn.onnx run in fp32 here, fp16 on the HTP)
  head      the head on the device's 30 ring entries (+ its contact history) vs the device logits (head numerics);
            and with the newest entry replaced by the PC features (whole pipeline); per head argmax agreement
-> <round>/pair.json (per frame) and a printed summary; several rounds -> data/moveid/live/pair_summary.json.
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import OUT, REPO, read_json, write_json  # noqa: E402
from s2_views import boxes, views  # noqa: E402

MODEL = REPO / "workspaces" / "WhereWindsMeet" / "model" / "dufu2"
HEADS = [("grp", 0, 88), ("col", 88, 91), ("resp", 91, 94), ("tte", 94, 141)]
G, C, RING = 128, 96, 30


def f32(s: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(s), "<f4")


def sm(y: np.ndarray, a: int, b: int) -> np.ndarray:
    z = np.exp(y[a:b] - y[a:b].max())
    return z / z.sum()


def one_round(d: Path) -> list[dict]:
    args = read_json(d / "args.json", {}) or {}
    res = read_json(d / "result.json", {}) or {}
    ran = ((res.get("value") or {}).get("ran") or {})
    prov = ran.get("glob") or args.get("provider", "qnn")
    suf = ".qnn.onnx" if prov == "qnn" else ".onnx"
    mdir = MODEL.parent / args.get("model", "dufu2")   # dufu2.js args.model (default dufu2)
    S = {n: ort.InferenceSession(str(mdir / f"{n}{suf}"), providers=["CPUExecutionProvider"]) for n in ("glob", "crop", "head")}
    out = []
    for e in read_json(d / "events.json", []) or []:
        if e.get("name") != "dufu2_pair":
            continue
        p = e["data"]
        png = d / "png" / Path(p["png"]).name
        img = cv2.imread(str(png), cv2.IMREAD_COLOR)
        if img is None:
            continue
        v = views(img, boxes(img.shape[1], img.shape[0]))
        ring = f32(p["ring"]).reshape(-1, G + 2 * C)
        hist = np.array(p["hist"], np.float32)
        r = {"n": p["n"], "png": png.name, "provider": prov, "ring_len": int(len(ring)), "views": {}, "feat": {}}
        pcf = {}
        for i, nm in enumerate(("glob", "big", "small")):
            pc = v[nm]
            if p.get("views"):
                dev = np.frombuffer(base64.b64decode(p["views"][i]), np.uint8).reshape(pc.shape)
                df = np.abs(dev.astype(int) - pc.astype(int))
                r["views"][nm] = {"max": int(df.max()), "share": round(float((df > 0).mean()), 6)}
            x = (pc.transpose(2, 0, 1)[None].astype(np.float32) * np.float32(1 / 255))
            pcf[nm] = S["glob" if nm == "glob" else "crop"].run(None, {"image": x})[0][0]
            a, b = {"glob": (0, G), "big": (G, G + C), "small": (G + C, G + 2 * C)}[nm]
            r["feat"][nm] = {"max_abs": round(float(np.abs(ring[-1, a:b] - pcf[nm]).max()), 5),
                             "ref": round(float(np.abs(pcf[nm]).max()), 3)}

        def head(rg: np.ndarray) -> np.ndarray:
            z = np.zeros((len(rg), 1), np.float32)
            feeds = {"glob": np.concatenate([rg[:, :G], hist], 1)[None], "big": np.concatenate([rg[:, G:G + C], z], 1)[None],
                     "small": np.concatenate([rg[:, G + C:], z], 1)[None]}
            return S["head"].run(None, {k: v_.astype(np.float32) for k, v_ in feeds.items()})[0][0]

        y_dev = f32(p["logits"])
        y_h = head(ring)
        rg2 = ring.copy()
        rg2[-1] = np.concatenate([pcf["glob"], pcf["big"], pcf["small"]])
        y_pc = head(rg2)
        for key, y in (("head_on_device_ring", y_h), ("pipeline_pc_newest", y_pc)):
            r[key] = {"logit_max_abs": round(float(np.abs(y - y_dev).max()), 5),
                      **{nm: {"argmax": bool(np.argmax(y[a:b]) == np.argmax(y_dev[a:b])),
                              "prob_max_abs": round(float(np.abs(sm(y, a, b) - sm(y_dev, a, b)).max()), 5)} for nm, a, b in HEADS}}
        out.append(r)
    write_json(d / "pair.json", out)
    return out


def summary(rows: list[dict]) -> dict:
    if not rows:
        return {"n": 0}
    s = {"n": len(rows), "providers": sorted({r["provider"] for r in rows})}
    for nm in ("glob", "big", "small"):
        vv = [r["views"][nm] for r in rows if nm in r["views"]]
        if vv:
            s[f"views_{nm}"] = {"max": max(x["max"] for x in vv), "frames_identical": sum(x["max"] == 0 for x in vv),
                                "share_max": max(x["share"] for x in vv)}
        s[f"feat_{nm}_max_abs"] = max(r["feat"][nm]["max_abs"] for r in rows)
    for key in ("head_on_device_ring", "pipeline_pc_newest"):
        s[key] = {"logit_max_abs": max(r[key]["logit_max_abs"] for r in rows),
                  **{nm: f"{sum(r[key][nm]['argmax'] for r in rows)}/{len(rows)} argmax, prob max {max(r[key][nm]['prob_max_abs'] for r in rows)}"
                     for nm, _, _ in HEADS}}
    return s


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    allrows = {}
    for d in map(Path, sys.argv[1:]):
        rows = one_round(d)
        allrows[d.name] = summary(rows)
        print(d.name, json.dumps(allrows[d.name], ensure_ascii=False), flush=True)
    prev = read_json(OUT / "live" / "pair_summary.json", {}) or {}
    prev.update(allrows)
    write_json(OUT / "live" / "pair_summary.json", prev)


if __name__ == "__main__":
    main()
