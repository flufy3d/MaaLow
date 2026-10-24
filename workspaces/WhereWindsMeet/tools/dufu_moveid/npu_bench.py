"""infer() speed of the npu_export.py candidates on the Pad, through the App API only (no adb).

    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_bench.py run [--models crop_mnv3s_fp32,...]
    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_bench.py table data/moveid/npu/bench_*.json
    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_bench.py cleanup

run: checks the Pad is idle (/status: busy null, no skill, not recording, no remote viewer; waits out a guard patrol),
copies the models (data/moveid/npu/models, manifest.json) to the workspace's model/npu_bench/ and the benchmark skill
(npu_bench_skill.js) to skills/npu_bench.js, pushes only those paths (sync with `only`: other local changes stay
unpushed), then runs the skill once per model: per config (cpu threads 1 / 2 / 4, nnapi) a first call (session
open = load time) + warm-up + n timed calls. Results go to data/moveid/npu/bench_<time>.json as they come in (the
skill's result per model, the status before it). The idle check is repeated before every model; a viewer, a recording
or a task stops the run. Then the workspace copies are deleted and pushed again (the sync baseline turns a local
delete of a pushed file into a delete on the app), unless --keep.

The skill only calls infer() (extra tensors, no screenshot); see npu_bench_skill.js.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "src"))

from maalow import sync  # noqa: E402
from maalow.client import Client  # noqa: E402

WS = "WhereWindsMeet"
ROOT = REPO / "workspaces"
WS_DIR = ROOT / WS
MODELS = REPO / "data/moveid/npu/models"
OUT = REPO / "data/moveid/npu"
SKILL_SRC = Path(__file__).with_name("npu_bench_skill.js")
REMOTE_MODELS = "model/npu_bench"
REMOTE_SKILL = "skills/npu_bench.js"
CONFIGS = [{"provider": "cpu", "threads": 1}, {"provider": "cpu", "threads": 2}, {"provider": "cpu", "threads": 4},
           {"provider": "nnapi", "threads": 1}, {"provider": "qnn", "threads": 1}]  # qnn: the QNN plugin, else cpu


def idle(c: Client, wait_s: float = 60) -> tuple[bool, dict]:
    """Idle: no task / skill (a guard patrol is waited out), not recording, nobody watching or controlling."""
    end = time.monotonic() + wait_s
    while True:
        s = c.get("/status")
        busy = s.get("busy")
        rem = s.get("remote") or {}
        hard = s.get("skills") or (s.get("record") or {}).get("recording") or rem.get("viewers") or rem.get("controlled")
        if hard:
            return False, s
        if busy is None:
            return True, s
        if not str(busy).startswith("guard:") or time.monotonic() > end:
            return False, s
        time.sleep(1)


def push(c: Client) -> dict:
    return sync.sync(c, WS, ROOT, "push", only=[REMOTE_MODELS, REMOTE_SKILL])


def install(names: list[str]) -> None:
    dst = WS_DIR / REMOTE_MODELS
    dst.mkdir(parents=True, exist_ok=True)
    for n in names:
        shutil.copy(MODELS / f"{n}.onnx", dst / f"{n}.onnx")
    shutil.copy(SKILL_SRC, WS_DIR / REMOTE_SKILL)


def cleanup(c: Client) -> dict:
    shutil.rmtree(WS_DIR / REMOTE_MODELS, ignore_errors=True)
    (WS_DIR / REMOTE_SKILL).unlink(missing_ok=True)
    for attempt in range(5):  # the app's file listing fails while another client deletes files there; retry
        try:
            out = push(c)
            break
        except RuntimeError as e:
            if attempt == 4:
                raise
            print(f"cleanup push failed ({e}); retrying", flush=True)
            time.sleep(10)
    left = [e["path"] for e in c.get(f"/files/{WS}/") if e["path"].startswith((REMOTE_MODELS + "/", REMOTE_SKILL))]
    return {"push": out, "left_on_app": left}


def run(a) -> None:
    manifest = json.loads((MODELS / "manifest.json").read_text())
    names = a.models.split(",") if a.models else sorted(manifest, key=lambda k: (manifest[k]["base"], k))
    configs = [cf for cf in CONFIGS if not a.configs or f"{cf['provider']}{cf['threads']}" in a.configs.split(",")]
    c = Client()
    ok, st = idle(c)
    if not ok:
        print(json.dumps({"error": "pad not idle", "status": st}, ensure_ascii=False))
        return
    install(names)
    res_push = push(c)
    if res_push.get("error"):
        print(json.dumps({"error": "push failed", "push": res_push}))
        return
    path = OUT / f"bench_{time.strftime('%Y%m%d-%H%M%S')}.json"
    report = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "n": a.n, "warm": a.warm, "configs": configs,
              "status_before": st, "push": {k: res_push.get(k) for k in ("push", "delete_remote", "ms")}, "results": []}
    try:
        for name in names:
            ok, st = idle(c)
            if not ok:
                report["stopped"] = {"before": name, "status": st}
                print(f"stop: pad busy before {name}: busy={st.get('busy')} remote={st.get('remote')}")
                break
            m = manifest[name]
            args = {"models": [{"path": f"npu_bench/{name}.onnx", "inputs": [i["shape"] for i in m["inputs"]]}],
                    "configs": configs, "n": a.n, "warm": a.warm}
            t0 = time.monotonic()
            out = c.post("/skill/run", {"name": "npu_bench", "args": args, "workspace": WS, "timeout": 1_200_000},
                         timeout=1_300)
            rows = out.get("value") if isinstance(out, dict) and out.get("ok") else None
            entry = {"model": name, "base": m["base"], "prec": m["prec"], "stream": m["stream"],
                     "input": m["inputs"][0]["shape"], "bytes": m["bytes"], "secs": round(time.monotonic() - t0, 1),
                     "busy_before": st.get("busy")}
            if rows is None:
                entry["error"] = {k: out.get(k) for k in ("reason", "error", "logs")} if isinstance(out, dict) else out
            else:
                entry["rows"] = rows
            report["results"].append(entry)
            path.write_text(json.dumps(report, indent=1, ensure_ascii=False))
            for r in rows or []:
                print(fmt_row(entry, r), flush=True)
            if rows is None:
                print(f"{name}: {json.dumps(out, ensure_ascii=False)[:400]}", flush=True)
    finally:
        report["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
        if not a.keep:
            report["cleanup"] = cleanup(c)
        path.write_text(json.dumps(report, indent=1, ensure_ascii=False))
        print(f"-> {path}")


def fmt_row(e: dict, r: dict) -> str:
    cfg = f"{r['provider']}{r['threads'] if r['provider'] == 'cpu' else ''}"
    if r.get("error"):
        return f"{e['model']:24s} {cfg:6s} ERROR {r['error']}"
    used = r["first"].get("provider")
    if used and used != r["provider"]:  # qnn fell back to cpu (no plugin, or the NPU could not take the model)
        cfg += f"->{used}"
    first = r["first"]["ms"]["total"]
    return (f"{e['model']:24s} {cfg:6s} run p50 {r['run']['p50']:8.2f} p95 {r['run']['p95']:8.2f}  "
            f"total p50 {r['total']['p50']:8.2f}  first {first:8.1f} ms")


def table(files: list[Path]) -> None:
    print("| 模型 | 流 | 输入 | 精度 | provider | 线程 | run p50 | run p95 | total p50 | 首次调用 |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for f in files:
        rep = json.loads(Path(f).read_text())
        for e in rep["results"]:
            for r in e.get("rows") or []:
                shape = "×".join(str(x) for x in e["input"])
                th = r["threads"] if r["provider"] == "cpu" else "-"
                if r.get("error"):
                    print(f"| {e['base']} | {e['stream']} | {shape} | {e['prec']} | {r['provider']} | {th} | 失败 | | | |")
                    continue
                print(f"| {e['base']} | {e['stream']} | {shape} | {e['prec']} | {r['provider']} | {th} | "
                      f"{r['run']['p50']:.2f} | {r['run']['p95']:.2f} | {r['total']['p50']:.2f} | {r['first']['ms']['total']:.0f} |")


def check(files: list[Path]) -> None:
    """Device outputs (first 8 values of the first call, input all 0.5) against onnxruntime on the PC (needs numpy +
    onnxruntime: uv run --with numpy --with onnxruntime ...). max |diff| / max |ref|: ~0 = same math; large = wrong."""
    import numpy as np
    import onnxruntime as ort

    ort.set_default_logger_severity(3)

    refs: dict[str, np.ndarray] = {}
    for f in files:
        for e in json.loads(Path(f).read_text())["results"]:
            if e["model"] not in refs:
                s = ort.InferenceSession(str(MODELS / f"{e['model']}.onnx"), providers=["CPUExecutionProvider"])
                feeds = {i.name: np.full(i.shape, 0.5, np.float32) for i in s.get_inputs()}
                refs[e["model"]] = s.run(None, feeds)[0].ravel()[:8]
            ref = refs[e["model"]]
            for r in e.get("rows") or []:
                out = (r.get("first") or {}).get("out")
                if not out:
                    continue
                d = np.abs(np.array(out[: len(ref)]) - ref).max() / max(1e-6, np.abs(ref).max())
                cfg = f"{r['provider']}{r['threads'] if r['provider'] == 'cpu' else ''}"
                print(f"{e['model']:24s} {cfg:6s} rel diff {d:.4f}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="op", required=True)
    p = sub.add_parser("run")
    p.add_argument("--models", help="comma-separated manifest keys (default: all)")
    p.add_argument("--configs", help="comma-separated of cpu1,cpu2,cpu4,nnapi1,qnn1 (default: all)")
    p.add_argument("--n", type=int, default=200)
    p.add_argument("--warm", type=int, default=20)
    p.add_argument("--keep", action="store_true", help="leave the models and skill on the app")
    p = sub.add_parser("table")
    p.add_argument("files", nargs="+", type=Path)
    p = sub.add_parser("check")
    p.add_argument("files", nargs="+", type=Path)
    sub.add_parser("cleanup")
    a = ap.parse_args()
    if a.op == "run":
        run(a)
    elif a.op == "table":
        table(a.files)
    elif a.op == "check":
        check(a.files)
    else:
        print(json.dumps(cleanup(Client()), indent=1))


if __name__ == "__main__":
    main()
