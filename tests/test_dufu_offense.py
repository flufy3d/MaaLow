"""进攻 v2: the engine's decision table, the old-vs-new offense-off touch parity, and loop.py's gate grouping."""

import importlib.util
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "workspaces" / "WhereWindsMeet" / "tools" / "dufu_moveid"


def run_node(script: str) -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    result = subprocess.run([node, str(Path(__file__).with_name(script))], capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=180)
    assert result.returncode == 0, result.stdout + result.stderr


def test_dufu_offense_decisions():
    run_node("dufu_offense.mjs")


def test_dufu_offense_policy_fixture():
    """The generated M1 policy must reproduce offense_online.py's scores (feature-order drift catches)."""
    run_node("dufu_offense_policy.mjs")


def test_dufu2_offense_off_touch_parity():
    """offense:"off" must reproduce the HEAD module's touches in every defense scenario (12)."""
    run_node("dufu2_off_parity.mjs")


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_loop_gate_grouping():
    """A legacy manifest keeps grouping by attack; one with offense keys groups by offense; --by overrides."""
    sys.path.insert(0, str(TOOLS))
    sys.path.insert(0, str(ROOT / "src"))
    loop = _load("dufu_loop", TOOLS / "loop.py")
    legacy = {"rounds": [{"args": {"attack": False}}, {"args": {"attack": True}}]}
    offense = {"rounds": [{"args": {"offense": "off"}}, {"args": {"offense": "v2"}}]}
    q = {"rounds": [{"args": {"offense": "v2", "offenseQ": {"light": 0.65}}},
                    {"args": {"offense": "v2", "offenseQ": {"light": 0.70}}}]}
    plain = {"rounds": [{"args": {"model": "dufu1b"}}]}
    assert loop.by_key(legacy) == "attack"
    assert loop.by_key(offense) == "offense"
    assert loop.by_key(q) == "offense,offenseQ"
    assert loop.by_key(plain) == "run"


def test_loop_fresh_reset_recovers_death_panel(monkeypatch):
    """A shadow that ends on the death panel is retried through dufu_enter, not aborted after three misses."""
    sys.path.insert(0, str(TOOLS))
    sys.path.insert(0, str(ROOT / "src"))
    loop = _load("dufu_loop", TOOLS / "loop.py")
    enters = []
    shadows = iter([
        {"value": {"reason": "time", "fightMs": 1000}},   # the first shadow died on screen but reported time
        {"value": {"reason": "dead", "fightMs": 2000}},   # after enter (again 再次训练) the shadow reports dead
    ])
    monkeypatch.setattr(loop, "pad_idle", lambda: (True, {"busy": None}))
    monkeypatch.setattr(loop, "enter", lambda: enters.append(1))
    monkeypatch.setattr(loop, "cli", lambda *a, **k: next(shadows))
    monkeypatch.setattr(loop.time, "sleep", lambda *_: None)
    loop.fresh_reset({"provider": "qnn", "model": "dufu1b"})
    assert len(enters) == 2


def test_s5_ab_offense_arms():
    """s5_ab --by offense: the two offense values are two arms (the statistic itself is unchanged)."""
    if not (ROOT / "data" / "moveid" / "teacher_prefix" / "prefix.json").exists():
        pytest.skip("no moveid data")
    sys.path.insert(0, str(TOOLS))
    ab = _load("s5_ab_offense", TOOLS / "s5_ab.py")
    off = ab.arm_key({"offense": "off"}, ["offense"])
    v2 = ab.arm_key({"offense": "v2"}, ["offense"])
    assert off != v2
    assert off == 'offense="off"' and v2 == 'offense="v2"'
    # q variants are separate arms when grouped on both keys
    q65 = ab.arm_key({"offense": "v2", "offenseQ": {"light": 0.65}}, ["offense", "offenseQ"])
    q70 = ab.arm_key({"offense": "v2", "offenseQ": {"light": 0.70}}, ["offense", "offenseQ"])
    assert q65 != q70
    # the legacy key still groups on its own
    assert ab.arm_key({"attack": False}, ["attack"]) != ab.arm_key({"attack": True}, ["attack"])
