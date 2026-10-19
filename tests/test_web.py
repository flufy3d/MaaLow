"""Cheap checks for the no-build web UI: JavaScript syntax and the generated skill type declarations."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "android/app/src/main/assets/web"
SKILL = ROOT / "android/app/src/main/assets/skill"
WORKSPACE_SKILLS = ROOT / "workspaces/WhereWindsMeet/skills"


def test_web_javascript_syntax():
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    files = sorted(WEB.glob("*.js")) + [SKILL / "prelude.js"]
    for f in files:
        subprocess.run([node, "--check", str(f)], check=True, capture_output=True)


def test_skill_type_declarations_are_in_sync():
    """`maalow sync` writes the app's declaration into the workspace; both copies are tracked, so keep them equal."""
    assert (SKILL / "maalow.d.ts").read_bytes() == (WORKSPACE_SKILLS / "maalow.d.ts").read_bytes()
