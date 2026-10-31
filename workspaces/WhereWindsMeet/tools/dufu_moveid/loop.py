"""顺序 6: the closed loop around dufu2's live rounds (run -> pull/verify/delete -> analyze -> gate).

    MOVEID_PHASE=1 uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/loop.py run --n 16 --tag gate3 \
        --args '{"mode":"defend","provider":"qnn","model":"dufu1b"}'
    # phase 1 now defaults to the finalized config: parryLead 10, curtainGap false, curtain2 true (chain11 removed).
    MOVEID_PHASE=1 uv run python .../loop.py ab --n 12 --tag ab_attack --alt '[{"attack":false},{"attack":true}]'
    MOVEID_PHASE=1 uv run python .../loop.py ingest --tag gate3
    MOVEID_PHASE=1 uv run python .../loop.py gate --tag gate3

`run`: every round is fresh: when the last defend round ended alive (reason time), a shadow run (no recording, no round
dir) lets the boss kill the character first; then one dufu_rounds round (record -> defend -> stop -> trace). The guards are
switched off for the test and restored (the original off list) in the finally. The manifest is live/loop_<tag>.json.
`ab`: the same, with the args' list alternated per round (dufu_rounds --alt).
`ingest`: s5_pull --delete (verify + bars) -> s5_color -> s5_analyze on the manifest's rounds.
`gate`: s5_ab by attack + the per-round table (hits/min, fatal rate, gold), writes live/loop_<tag>_gate.json.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
D = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(D))

from maalow.client import Client  # noqa: E402

from common import OUT, PHASE, WS  # noqa: E402

LIVE = OUT / "live"

ROUNDS = ROOT / "workspaces" / "WhereWindsMeet" / "tools" / "dufu_rounds.py"
ENV = {**os.environ, "MOVEID_PHASE": str(PHASE), "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
GUARDS = ["AutoPickup", "DismissIdleSlideshow", "CloseItemTip"]


def cli(*args: str, timeout: float = 1200) -> dict:
    p = subprocess.run(["uv", "run", "maalow", *args], cwd=ROOT, env=ENV, capture_output=True, timeout=timeout)
    out = (p.stdout or b"").decode("utf-8", "replace")
    err = (p.stderr or b"").decode("utf-8", "replace")
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return {"error": (out + err)[-1200:]}


def py(script: Path, *args: str, timeout: float = 3600) -> int:
    p = subprocess.run(["uv", "run", "python", str(script), *args], cwd=ROOT, env=ENV)
    return p.returncode


TORCH = ["uv", "run", "--no-project", "--with", "torch", "--with", "torchvision", "--with", "timm", "--with", "numpy", "--with", "av",
         "--with", "opencv-python-headless", "--index", "https://download.pytorch.org/whl/cu130",
         "--index-strategy", "unsafe-best-match", "python"]


def py_torch(script: Path, *args: str, onnx: bool = False) -> int:
    cmd = list(TORCH)
    if onnx:
        cmd += ["--with", "onnx", "--with", "onnxruntime"]
    cmd += [str(script), *args]
    return subprocess.run(cmd, cwd=ROOT, env=ENV).returncode


def push_model(name: str) -> None:
    from maalow import sync as msync
    c = Client()
    out = msync.sync(c, WS, ROOT / "workspaces", "push", only=[f"model/{name}"])
    print(json.dumps({k: out.get(k) for k in ("push", "delete_remote", "conflicts", "error")}, ensure_ascii=False), flush=True)
    if out.get("error"):
        raise SystemExit(f"push {name} failed")


def manifest_path(tag: str) -> Path:
    return LIVE / f"loop_{tag}.json"


def load_manifest(tag: str) -> dict:
    try:
        return json.loads(manifest_path(tag).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"tag": tag, "rounds": []}


def save_manifest(m: dict) -> None:
    manifest_path(m["tag"]).write_text(json.dumps(m, ensure_ascii=False, indent=1), encoding="utf-8")


def pad_idle() -> tuple[bool, dict]:
    st = cli("do", "status", timeout=60)
    busy = st.get("busy")
    rec = (st.get("record") or {}).get("recording")
    viewers = (st.get("remote") or {}).get("viewers", 0)
    return (not busy and not rec and viewers == 0), {"busy": busy, "recording": rec, "viewers": viewers}


def guards_off() -> list[str]:
    c = Client()
    g = c.get(f"/guards?workspace={WS}")
    before = list(g.get("off") or [])
    c.request("PUT", "/guards", {"workspace": WS, "off": sorted(set(before) | set(GUARDS))})
    print(f"guards off: {before} -> {sorted(set(before) | set(GUARDS))}", flush=True)
    return before


def guards_restore(before: list[str]) -> None:
    Client().request("PUT", "/guards", {"workspace": WS, "off": before})
    print(f"guards restored: off={before}", flush=True)


def enter() -> None:
    r = cli("do", "skill", "dufu_enter", "--args", json.dumps({"phase": PHASE}), timeout=400)
    if not r.get("ok") or r.get("value") != "arena":
        raise SystemExit(f"enter failed: {json.dumps(r, ensure_ascii=False)[:600]}")


def last_round() -> tuple[str, str]:
    rs = sorted(p for p in LIVE.glob("r[0-9][0-9][0-9]") if (p / "result.json").exists())
    if not rs:
        return "", ""
    try:
        v = json.loads((rs[-1] / "result.json").read_text(encoding="utf-8")).get("value") or {}
    except json.JSONDecodeError:
        v = {}
    return rs[-1].name, str(v.get("reason") or "")


def fresh_reset(args: dict, tries: int = 3) -> None:
    """No recording / round dir: a shadow run until the boss kills the character (the next dufu_enter is fresh)."""
    a = {"mode": "shadow", "provider": args.get("provider", "qnn"), "phase": PHASE, "ms": 180_000}
    if args.get("model"):
        a["model"] = args["model"]
    for i in range(tries):
        if pad_idle()[0]:
            r = cli("do", "skill", "dufu2", "--args", json.dumps(a), "--timeout", "240000", timeout=280)
            v = r.get("value") or {}
            print(f"  shadow reset {i + 1}: {v.get('reason')} {round(v.get('fightMs', 0) / 1000, 1)} s", flush=True)
            if v.get("reason") == "dead":
                return
        time.sleep(2)
    raise SystemExit("could not reset the fight (shadow did not die)")


def run_round(args: dict, ms: int) -> None:
    cmd = ["uv", "run", "python", str(ROUNDS), str(LIVE), "--n", "1", "--phase", str(PHASE), "--skill", "dufu2",
           "--ms", str(ms), "--skill-args", json.dumps(args)]
    p = subprocess.run(cmd, cwd=ROOT, env=ENV, capture_output=True, timeout=ms / 1000 + 240)
    out = ((p.stdout or b"") + (p.stderr or b"")).decode("utf-8", "replace").strip()
    print(out[-800:], flush=True)
    if p.returncode != 0:
        raise SystemExit(f"round failed (exit {p.returncode})")


def do_run(tag: str, n: int, ms: int, args: dict | None, alt: list[dict] | None, batch: int) -> None:
    m = load_manifest(tag)
    if not pad_idle()[0]:
        raise SystemExit(f"pad busy: {pad_idle()[1]}")
    before = guards_off()
    try:
        enter()
        prev = last_round()[1]
        start = len(m["rounds"])
        for i in range(n):
            cur = alt[(start + i) % len(alt)] if alt else (args or {})
            if prev != "dead":
                fresh_reset(cur)
            t0 = time.time()
            run_round(cur, ms)
            rn, reason = last_round()
            m["rounds"].append({"round": rn, "reason": reason, "args": cur, "ms": ms, "at": time.strftime("%Y-%m-%d %H:%M:%S")})
            save_manifest(m)
            print(f"[{tag}] {len(m['rounds'])} rounds (+{i + 1}/{n}) {rn} {reason} {time.time() - t0:.0f}s {json.dumps(cur, ensure_ascii=False)}", flush=True)
            prev = reason
            if batch and len(m["rounds"]) % batch == 0:
                ingest(m)
    finally:
        guards_restore(before)


def ingest(m: dict) -> None:
    rounds = [x["round"] for x in m["rounds"]]
    if not rounds:
        return
    print(f"ingest {len(rounds)} rounds: pull/verify/delete", flush=True)
    if py(D / "s5_pull.py", "--delete", "--procs", "4") != 0:
        raise SystemExit("s5_pull failed")
    print("ingest: color", flush=True)
    if py_torch(D / "s5_color.py") != 0:
        raise SystemExit("s5_color failed")
    print("ingest: analyze", flush=True)
    if py(D / "s5_analyze.py", *rounds) != 0:
        raise SystemExit("s5_analyze failed")


def gate(tag: str) -> None:
    m = load_manifest(tag)
    rounds = [x["round"] for x in m["rounds"]]
    if not rounds:
        raise SystemExit("no rounds in the manifest")
    out = LIVE / f"loop_{tag}_gate.json"
    if py(D / "s5_ab.py", *rounds, "--by", "attack", "--out", str(out)) != 0:
        raise SystemExit("s5_ab failed")
    g = json.loads(out.read_text(encoding="utf-8"))
    print(json.dumps({k: {kk: v[kk] for kk in ("fatal_without_unverified", "fatal_with_unverified", "gold_parried",
                                               "why_fatal", "hits_per_min", "by_round_counts") if kk in v}
                      for k, v in g.items()}, ensure_ascii=False, indent=1))


def train(tag: str, live: list[str], val: list[str], base: str = "final", epochs: int = 2, lr: float = 3e-4,
          live_rep: int = 2) -> str:
    """One closed-loop retrain step: cache the live views -> fine-tune -> held-out eval -> int8/QNN export -> push.

    The model dir is model/dufu<PHASE>_<tag> (phase 1: dufu1_<tag>), so the running champion is never overwritten until
    the arena passes it. Returns the model dir name."""
    model = f"dufu{PHASE}_{tag}"
    if py_torch(D / "s5_retrain.py", "cache", *live, *val, "--procs", "6") != 0:
        raise SystemExit("s5_retrain cache failed")
    if py_torch(D / "s5_retrain.py", "train", "--base", base, "--tag", tag, "--live", *live, "--val", *val,
                "--epochs", str(epochs), "--lr", str(lr), "--live-rep", str(live_rep)) != 0:
        raise SystemExit("s5_retrain train failed")
    if py_torch(D / "s5_retrain.py", "eval", "--val", *val, "--models", f"{base},{tag}",
                "--out", str(LIVE / f"loop_{tag}_eval.json")) != 0:
        raise SystemExit("s5_retrain eval failed")
    if py_torch(D / "s4_export.py", "--tag", tag, "--out", str(ROOT / "workspaces" / WS / "model" / model), onnx=True) != 0:
        raise SystemExit("s4_export failed")
    push_model(model)
    return model


def report(tag: str) -> None:
    """The loop's daily report: per-round hits/min and gate 2 from the analysis, plus the manifest and the gate arms."""
    m = load_manifest(tag)
    rounds = [x["round"] for x in m["rounds"]]
    gp = LIVE / f"loop_{tag}_gate.json"
    g = json.loads(gp.read_text(encoding="utf-8")) if gp.exists() else {}
    lines = [f"# 闭环 {tag}", "", f"轮次 {len(rounds)}：{' '.join(rounds)}", "", "| 局 | 结果 | 分钟 | 挨打/分 | 致命 | 金被卸 |", "|---|---|---|---|---|---|"]
    per = {}
    for arm, row in g.items():
        if arm.startswith("main:") or "by_round_counts" not in row:
            continue
        per.update({k: (arm, v) for k, v in row["by_round_counts"].items()})
    a = None
    try:
        if py(D / "s5_analyze.py", *rounds) == 0:
            a = json.loads((LIVE / "analysis.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    ar = {r["round"]: r for r in (a or {}).get("rounds", [])}
    for x in m["rounds"]:
        rn = x["round"]
        r = ar.get(rn, {})
        arm, cnt = per.get(rn, ("", [0, 0]))
        fatal = f"{cnt[0]}/{cnt[1]} = {cnt[0] / cnt[1] * 100:.1f}%" if cnt[1] else "-"
        lines.append(f"| {rn} | {x.get('reason')} | {r.get('fight_s', 0) / 60:.1f} | {r.get('truth', {}).get('hit', 0) / max(r.get('fight_s', 1) / 60, 0.01):.2f} | {fatal} | {arm} |")
    lines += ["", "```json", json.dumps(g, ensure_ascii=False, indent=1)[:4000], "```"]
    out = LIVE / f"loop_{tag}_report.md"
    out.write_text("\n".join(lines), encoding="utf-8")
    print(f"report -> {out}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--n", type=int, default=16)
    r.add_argument("--ms", type=int, default=360_000)
    r.add_argument("--tag", required=True)
    r.add_argument("--args", default="{}")
    r.add_argument("--batch", type=int, default=0, help="ingest every N rounds (0: only at ingest)")
    a = sub.add_parser("ab")
    a.add_argument("--n", type=int, default=12)
    a.add_argument("--ms", type=int, default=360_000)
    a.add_argument("--tag", required=True)
    a.add_argument("--alt", required=True)
    a.add_argument("--batch", type=int, default=0)
    i = sub.add_parser("ingest")
    i.add_argument("--tag", required=True)
    g = sub.add_parser("gate")
    g.add_argument("--tag", required=True)
    t = sub.add_parser("train")
    t.add_argument("--tag", required=True)
    t.add_argument("--live", nargs="+", required=True)
    t.add_argument("--val", nargs="+", required=True)
    t.add_argument("--base", default="final")
    t.add_argument("--epochs", type=int, default=2)
    t.add_argument("--lr", type=float, default=3e-4)
    t.add_argument("--live-rep", type=int, default=2)
    p = sub.add_parser("report")
    p.add_argument("--tag", required=True)
    o = ap.parse_args()
    if o.cmd == "run":
        do_run(o.tag, o.n, o.ms, json.loads(o.args), None, o.batch)
    elif o.cmd == "ab":
        do_run(o.tag, o.n, o.ms, None, json.loads(o.alt), o.batch)
    elif o.cmd == "ingest":
        ingest(load_manifest(o.tag))
    elif o.cmd == "gate":
        gate(o.tag)
    elif o.cmd == "train":
        print(train(o.tag, o.live, o.val, o.base, o.epochs, o.lr, o.live_rep))
    elif o.cmd == "report":
        report(o.tag)


if __name__ == "__main__":
    main()
