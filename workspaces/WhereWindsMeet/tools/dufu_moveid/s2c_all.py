"""Order 2 slicing + clustering, unattended: s2c_slice -> s2c_cluster -> s2c_sheets -> s2c_report.

Each step runs in its own `uv run` with the packages it needs (no torch). Extra args go to s2c_cluster.py.
    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/s2c_all.py [--no-stability] [--seed N]
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE = ["uv", "run", "--no-project", "--with", "numpy"]
STEPS = [
    (["--with", "scikit-learn"], "s2c_slice.py", []),
    (["--with", "scikit-learn", "--with", "umap-learn"], "s2c_cluster.py", sys.argv[1:]),
    (["--with", "opencv-python-headless"], "s2c_sheets.py", []),
    ([], "s2c_report.py", []),
]


def main() -> None:
    for extra, script, args in STEPS:
        cmd = BASE + extra + ["python", "-W", "ignore", str(HERE / script)] + args
        print(">>", script, flush=True)
        subprocess.run(cmd, check=True, cwd=HERE.parents[3])


if __name__ == "__main__":
    main()
