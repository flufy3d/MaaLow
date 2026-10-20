"""Behavioral regression tests for the combat scheduler's emitted inputs."""

import shutil
import subprocess
from pathlib import Path

import pytest


def test_dufu_scheduler_inputs():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    script = Path(__file__).with_name("dufu_scheduler.mjs")
    result = subprocess.run([node, str(script)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
