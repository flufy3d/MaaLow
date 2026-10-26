"""Order 5: push only dufu2's files to the app (skills/dufu2.js, skills/lib/dufu2-table.js; --model: model/dufu2/ and model/dufu2b/ too),
after checking the Pad is idle (no task / skill, not recording, no remote viewer). Other local changes stay local.

    uv run python workspaces/WhereWindsMeet/tools/dufu_moveid/s5_push.py [--model] [--dry]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from maalow import sync  # noqa: E402
from maalow.client import Client  # noqa: E402

from npu_bench import idle  # noqa: E402

WS = "WhereWindsMeet"
ROOT = REPO / "workspaces"
FILES = ["skills/dufu2.js", "skills/lib/dufu2-table.js"]
MODELS = ["model/dufu2", "model/dufu2b"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", action="store_true", help="also model/dufu2/")
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args()
    c = Client()
    ok, st = idle(c)
    if not ok:
        print(json.dumps({"error": "pad busy", "status": {k: st.get(k) for k in ("busy", "skills", "record", "remote")}}, ensure_ascii=False))
        return 1
    only = FILES + (MODELS if a.model else [])
    out = sync.sync(c, WS, ROOT, "push", only=only, dry_run=a.dry)
    print(json.dumps({k: out.get(k) for k in ("push", "delete_remote", "conflicts", "skipped", "error")}, ensure_ascii=False))
    return 0 if not out.get("error") else 1


if __name__ == "__main__":
    sys.exit(main())
