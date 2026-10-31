"""Heuristic phase-1 tell-colour labels for the line-candidate crops (s2_feat / s2_crops).

    MOVEID_PHASE=1 uv run --no-project --with numpy python workspaces/WhereWindsMeet/tools/dufu_moveid/s2_auto_label.py

Labels every crop key from the candidate's hue counts in color/feat/<rec>.npz:
  C  collision / spark   white >= 150 and orange >= 600, or a bright orange burst without gold
  G  gold tell           gold >= 250 and gold > 1.5 * red
  R  red tell            red >= 100 and red >= 0.8 * gold
  N  other               green poison glow, blue/white lines, plain light
Writes tools/dufu_moveid/s2_labels_p1.json (the phase-1 label file used by s2_model.py). These are seed labels for
the classifier; the OOF report and a 60+60 gold/red spot check are the acceptance, and hand corrections can overwrite
individual keys.
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from s2_label import LABELS, all_crops  # noqa: E402


def label(row) -> str:
    red, org, gold, white = (float(x) for x in row)
    if white >= 150 and org >= 600:
        return "C"
    if gold >= 250 and gold > 1.5 * red:
        return "G"
    if red >= 100 and red >= 0.8 * gold:
        return "R"
    if org >= 500 and gold < 200 and red < 100:
        return "C"
    return "N"


def main() -> None:
    rows = all_crops()
    labels = {key: label(c[5:9]) for key, _rec, _idx, c in rows}
    import json
    LABELS.write_text(json.dumps(dict(sorted(labels.items())), indent=0), encoding="utf-8")
    print(len(labels), Counter(labels.values()))


if __name__ == "__main__":
    main()
