"""Qualcomm AI Hub: compile the npu_export.py candidates for the Hexagon NPU and profile them on a real device.

    uv run --with qai-hub python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_aihub.py --dry-run
    uv run --with qai-hub python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_aihub.py --devices
    uv run --with qai-hub python workspaces/WhereWindsMeet/tools/dufu_moveid/npu_aihub.py \
        [--chipset qualcomm-snapdragon-8gen3] [--device "Samsung Galaxy S24 (Family)"] [--models a_fp32,b_int8] \
        [--runtime qnn_dlc|precompiled_qnn_onnx|onnx|tflite]

Uploads ONLY the ONNX files listed in data/moveid/npu/models/manifest.json (random weights; never recordings or
screenshots), compiles each for the target runtime (default qnn_dlc: the QNN model a future QNN
plugin would load), profiles it on the device (NPU), and prints per model: p50 / min of the device's inference times,
first / warm load, and how many layers ran on NPU / GPU / CPU (all on NPU = the whole graph is accelerated).
Results (with the job ids / URLs) go to data/moveid/npu/aihub_<time>.json. The token is qai-hub's own config
(~/.qai_hub/client.ini); nothing here reads or prints it.

--dry-run: no network; lists what would be uploaded (file, size, sha256, input shapes) and the job options.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
MODELS = REPO / "data/moveid/npu/models"
OUT = REPO / "data/moveid/npu"
# Speed-relevant set: the baselines, every candidate base in fp32 and int8 (fp16 is what the NPU runs fp32 as).
DEFAULT_PRECS = ("fp32", "int8")


def selected(manifest: dict, names: str | None) -> list[str]:
    if names:
        return names.split(",")
    return sorted(k for k, v in manifest.items() if v["prec"] in DEFAULT_PRECS and not v["base"].startswith("null_"))


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:16]


def pick_device(hub, name: str | None, chipset: str | None):
    if name:
        return hub.Device(name)
    devs = [d for d in hub.get_devices(attributes=f"chipset:{chipset}") if "os:android" in d.attributes]
    if not devs:
        raise SystemExit(f"no AI Hub device with chipset:{chipset}")
    family = [d for d in devs if "(Family)" in d.name]
    return (family or devs)[0]


def summarize(profile: dict) -> dict:
    s = profile.get("execution_summary", {})
    times = [t / 1000 for t in s.get("all_inference_times", [])]  # us -> ms
    units: dict[str, int] = {}
    for layer in profile.get("execution_detail", []):
        u = layer.get("compute_unit", "?")
        units[u] = units.get(u, 0) + 1
    return {
        "p50_ms": round(statistics.median(times), 3) if times else None,
        "min_ms": round(min(times), 3) if times else None,
        "estimated_ms": round(s["estimated_inference_time"] / 1000, 3) if "estimated_inference_time" in s else None,
        "runs": len(times),
        "first_load_ms": round(s["first_load_time"] / 1000, 1) if "first_load_time" in s else None,
        "warm_load_ms": round(s["warm_load_time"] / 1000, 1) if "warm_load_time" in s else None,
        "peak_mem_mb": round(s.get("estimated_inference_peak_memory", 0) / 2**20, 1),
        "layers": units,
        "all_npu": bool(units) and set(units) == {"NPU"},
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--models", help="comma-separated manifest keys (default: every candidate's fp32 and int8)")
    ap.add_argument("--chipset", default="qualcomm-snapdragon-8gen3", help="AI Hub chipset attribute")
    ap.add_argument("--device", help="exact AI Hub device name (instead of --chipset)")
    ap.add_argument("--runtime", default="qnn_dlc")
    ap.add_argument("--profile-options", default="", help='e.g. "--compute_unit npu" (onnx runtime)')
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--devices", action="store_true", help="list the Android devices and chipsets, then exit")
    a = ap.parse_args()

    manifest = json.loads((MODELS / "manifest.json").read_text())
    names = selected(manifest, a.models)
    compile_opts = f"--target_runtime {a.runtime}"
    profile_opts = a.profile_options

    if a.dry_run:
        total = 0
        for n in names:
            f = MODELS / f"{n}.onnx"
            total += f.stat().st_size
            ins = ", ".join(f"{i['name']}{i['shape']}" for i in manifest[n]["inputs"])
            print(f"upload {f.relative_to(REPO)}  {f.stat().st_size / 1e6:6.2f} MB  sha256 {sha(f)}  {ins}")
        print(f"{len(names)} ONNX files, {total / 1e6:.1f} MB; only these files are uploaded")
        print(f"compile: {compile_opts}; profile: {profile_opts}; device: {a.device or 'chipset:' + a.chipset}")
        return

    import qai_hub as hub

    if a.devices:
        for d in hub.get_devices():
            if "os:android" in d.attributes:
                print(d.name, d.os, [x for x in d.attributes if x.startswith("chipset:")])
        return

    device = pick_device(hub, a.device, a.chipset)
    print(f"device: {device.name} (Android {device.os}) {[x for x in device.attributes if x.startswith('chipset:')]}")
    path = OUT / f"aihub_{time.strftime('%Y%m%d-%H%M%S')}.json"
    report = {"device": device.name, "os": device.os, "attributes": list(device.attributes), "runtime": a.runtime,
              "compile_options": compile_opts, "profile_options": profile_opts, "results": []}

    # submit everything first (AI Hub runs jobs in parallel), then collect
    jobs, profiles = [], {}
    for n in names:
        f = MODELS / f"{n}.onnx"
        entry = {"model": n, **{k: manifest[n][k] for k in ("base", "prec", "stream", "inputs", "bytes")}, "sha256": sha(f)}
        try:
            cj = hub.submit_compile_job(model=str(f), device=device, name=f"maalow-npu-{n}", options=compile_opts)
            entry["compile_job"] = cj.job_id
            jobs.append((entry, cj))
        except Exception as e:  # noqa: BLE001
            entry["error"] = f"compile submit: {e}"
        report["results"].append(entry)
    for entry, cj in jobs:
        st = cj.wait()
        if not st.success:
            entry["error"] = f"compile: {st.message}"
            print(f"{entry['model']:24s} compile failed: {st.message}")
            continue
        try:
            pj = hub.submit_profile_job(model=cj.get_target_model(), device=device, name=f"maalow-npu-{entry['model']}",
                                        options=profile_opts)
            entry["profile_job"] = pj.job_id
            profiles[entry["model"]] = pj
        except Exception as e:  # noqa: BLE001
            entry["error"] = f"profile submit: {e}"
    for entry in report["results"]:
        pj = profiles.get(entry["model"])
        if pj is None:
            continue
        st = pj.wait()
        if not st.success:
            entry["error"] = f"profile: {st.message}"
            print(f"{entry['model']:24s} profile failed: {st.message}")
            continue
        entry["profile"] = summarize(pj.download_profile())
        p = entry["profile"]
        print(f"{entry['model']:24s} p50 {p['p50_ms']} ms  min {p['min_ms']}  first load {p['first_load_ms']} ms  "
              f"layers {p['layers']}  all NPU: {p['all_npu']}", flush=True)
        path.write_text(json.dumps(report, indent=1))
    path.write_text(json.dumps(report, indent=1))
    print(f"-> {path}")


if __name__ == "__main__":
    main()
