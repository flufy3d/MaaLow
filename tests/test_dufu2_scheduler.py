"""Behavioral regression tests for dufu2.js (phases 1 and 2) against a fake world."""

import shutil
import subprocess
from pathlib import Path

import pytest


def test_dufu2_scheduler_inputs():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    script = Path(__file__).with_name("dufu2_scheduler.mjs")
    result = subprocess.run([node, str(script)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
