"""顺序 6: the closed loop around dufu2's live rounds (run -> pull/verify/delete -> analyze -> gate).

    MOVEID_PHASE=1 uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/loop.py run --n 16 --tag gate3 \
        --args '{"mode":"defend","provider":"qnn","model":"dufu1b"}'
    # phase 1 now defaults to the finalized config: parryLead 10, curtainGap false, curtain2 true (chain11 removed).
    MOVEID_PHASE=1 uv run python .../loop.py ab --n 12 --tag ab_attack --alt '[{"attack":false},{"attack":true}]'
    MOVEID_PHASE=1 uv run python .../loop.py ab --n 16 --tag ab_offense --ms 600000 \
        --alt '[{"mode":"defend","offense":"off"},{"mode":"defend","offense":"v2"}]'
    MOVEID_PHASE=1 uv run python .../loop.py ingest --tag gate3
    MOVEID_PHASE=1 uv run python .../loop.py gate --tag gate3

`run`: every round is fresh: when the last defend round ended alive (reason time), a shadow run (no recording, no round
dir) lets the boss kill the character first; then one dufu_rounds round (record -> defend -> stop -> trace). The guards are
switched off for the test and restored (the original off list) in the finally. The manifest is live/loop_<tag>.json.
`ab`: the same, with the args' list alternated per round (dufu_rounds --alt).
`ingest`: s5_pull --delete (verify + bars) -> s5_color -> s5_analyze on the manifest's rounds.
`gate`: s5_ab grouped by the manifest's own switch (offense when any round sets it, else the legacy attack; `--by`
overrides) + the per-round table (hits/min, fatal rate, gold), writes live/loop_<tag>_gate.json.
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

from common import OUT, PHASE, WS, read_json  # noqa: E402

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


def wait_idle(timeout_s: float = 60) -> None:
    """Wait out a transient guard / recording tail; abort if something else is still running."""
    end = time.time() + timeout_s
    while True:
        ok, why = pad_idle()
        if ok:
            return
        if time.time() >= end:
            raise SystemExit(f"pad busy: {why}")
        print(f"pad busy ({why}); waiting", flush=True)
        time.sleep(2)


def fresh_reset(args: dict, tries: int = 3) -> None:
    """No recording / round dir: a shadow run until the boss kills the character (the next dufu_enter is fresh).

    Stage 1 stopped after r203 because the first shadow reached the death panel, then the next try could not start
    dufu2 from that panel. Call dufu_enter before every try: on the arena it is a no-op, on the death panel it taps
    再次训练 and gives the next shadow a fresh fight. A shadow that returns time after actually dying is therefore
    retried from the arena instead of aborting the whole batch.
    """
    a = {"mode": "shadow", "provider": args.get("provider", "qnn"), "phase": PHASE, "ms": 180_000}
    if args.get("model"):
        a["model"] = args["model"]
    last = None
    for i in range(tries):
        try:
            wait_idle(30)  # a transient guard / recording tail is not a failed reset
        except SystemExit:
            print(f"  shadow reset {i + 1}: pad stayed busy", flush=True)
            continue
        try:
            enter()  # death panel -> 再次训练; in the arena this is just the normal no-op entry
        except SystemExit as e:
            print(f"  shadow reset {i + 1}: enter failed: {str(e)[:300]}", flush=True)
            time.sleep(2)
            continue
        r = cli("do", "skill", "dufu2", "--args", json.dumps(a), "--timeout", "240000", timeout=280)
        v = r.get("value") or {}
        last = v.get("reason") or r.get("error") or "no reason"
        print(f"  shadow reset {i + 1}: {v.get('reason')} {round(v.get('fightMs', 0) / 1000, 1)} s", flush=True)
        if v.get("reason") == "dead":
            return
        time.sleep(2)
    raise SystemExit(f"could not reset the fight (shadow did not die: {last})")


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
    before = guards_off()
    try:
        wait_idle()
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


def gate(tag: str, by: str | None = None) -> None:
    m = load_manifest(tag)
    rounds = [x["round"] for x in m["rounds"]]
    if not rounds:
        raise SystemExit("no rounds in the manifest")
    key = by or by_key(m)
    out = LIVE / f"loop_{tag}_gate.json"
    print(f"gate {tag}: s5_ab --by {key}", flush=True)
    if py(D / "s5_ab.py", *rounds, "--by", key, "--out", str(out)) != 0:
        raise SystemExit("s5_ab failed")
    g = json.loads(out.read_text(encoding="utf-8"))
    print(json.dumps({k: {kk: v[kk] for kk in ("fatal_without_unverified", "fatal_with_unverified", "gold_parried",
                                               "why_fatal", "hits_per_min", "by_round_counts") if kk in v}
                      for k, v in g.items()}, ensure_ascii=False, indent=1))


def by_key(m: dict) -> str:
    """The switch the manifest's A/B grouped on: `offense,offenseQ` when any round overrides q (so qB/qC are separate
    arms), `offense,c11Lead` for a c11-lead defense A/B, `offense,seqDefense` for the S-plan A/B (stage C: the seq arm
    must be separated from the old defense arm), else `offense` (v2, 2026-11-01), else the legacy `attack`
    (old manifests), else `run`."""
    args = [x.get("args") or {} for x in m.get("rounds", [])]
    if any("offenseQ" in a for a in args):
        return "offense,offenseQ"
    if any("c11Lead" in a for a in args):
        return "offense,c11Lead"
    if any("scriptDefense" in a for a in args):
        return "offense,scriptDefense"
    if any("seqDefense" in a for a in args):
        return "offense,seqDefense"
    if any("offense" in a for a in args):
        return "offense"
    if any("attack" in a for a in args):
        return "attack"
    return "run"


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


def offense_cycle(tag: str, export: bool = False, bossfill: bool = False) -> None:
    """The batch cycle's offline half: the tag's rounds -> opportunity rows -> audit -> train (all r185+) -> optional
    export; the eval summary is copied next to the manifest. Live A/B and promotion stay manual (`ab` + `gate`)."""
    m = load_manifest(tag)
    rounds = [x["round"] for x in m["rounds"]]
    if not rounds:
        raise SystemExit("no rounds in the manifest")
    print(f"offense cycle {tag}: build/audit {len(rounds)} rounds", flush=True)
    if py(D / "offense_online.py", "build", *rounds) != 0:
        raise SystemExit("offense_online build failed")
    if py(D / "offense_online.py", "audit", *rounds) != 0:
        raise SystemExit("offense_online audit failed")
    if bossfill:
        p = subprocess.run(["uv", "run", "--no-project", "--with", "opencv-python-headless", "--with", "numpy",
                            "python", str(D / "offense_boss_fill.py"), *rounds], cwd=ROOT, env=ENV)
        if p.returncode != 0:
            raise SystemExit("offense_boss_fill failed")
    print("offense cycle: train all rounds", flush=True)
    if py(D / "offense_online.py", "train") != 0:
        raise SystemExit("offense_online train failed")
    if export:
        if py(D / "offense_online.py", "export") != 0:
            raise SystemExit("offense_online export failed")
    ev = read_json(ROOT / "data" / "moveid" / "offense" / "online" / "eval.json", {}) or {}
    out = LIVE / f"loop_{tag}_offense.json"
    out.write_text(json.dumps({"tag": tag, "rounds": rounds, "eval": ev,
                               "at": time.strftime("%Y-%m-%d %H:%M:%S")}, ensure_ascii=False, indent=1), encoding="utf-8")
    # the policy registry (M3): every trained candidate is recorded; promotion is manual and needs the live gate.
    regp = ROOT / "data" / "moveid" / "offense" / "online" / "registry.json"
    reg = read_json(regp, {"policies": []}) or {"policies": []}
    val = ev.get("value") or {}
    reg["policies"].append({"tag": tag, "at": time.strftime("%Y-%m-%d %H:%M:%S"), "rounds": rounds,
                            "value_auc": val.get("auc"), "safety_auc": (ev.get("models") or {}).get("61", {}).get("auc"),
                            "value_threshold": val.get("threshold"), "total_dmg_kept": val.get("total_dmg_kept_oof"),
                            "promoted": False, "rollback_reason": None})
    regp.parent.mkdir(parents=True, exist_ok=True)
    regp.write_text(json.dumps(reg, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"offense cycle -> {out}", flush=True)


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
    g.add_argument("--by", default=None, help="s5_ab grouping key (default: the manifest's own switch: offense / attack / run)")
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
    of = sub.add_parser("offense")
    of.add_argument("--tag", required=True)
    of.add_argument("--export", action="store_true", help="also regenerate skills/lib/dufu-offense-policy.js")
    of.add_argument("--bossfill", action="store_true", help="also replay the videos for the real per-press damage")
    o = ap.parse_args()
    if o.cmd == "run":
        do_run(o.tag, o.n, o.ms, json.loads(o.args), None, o.batch)
    elif o.cmd == "ab":
        do_run(o.tag, o.n, o.ms, None, json.loads(o.alt), o.batch)
    elif o.cmd == "ingest":
        ingest(load_manifest(o.tag))
    elif o.cmd == "gate":
        gate(o.tag, o.by)
    elif o.cmd == "train":
        print(train(o.tag, o.live, o.val, o.base, o.epochs, o.lr, o.live_rep))
    elif o.cmd == "report":
        report(o.tag)
    elif o.cmd == "offense":
        offense_cycle(o.tag, o.export, o.bossfill)


if __name__ == "__main__":
    main()
