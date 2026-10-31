"""Override crop labels inside the aux-gold flare windows with G, then retrain the tell classifier.

    MOVEID_PHASE=1 uv run --no-project --with numpy python .../s2_gold_labels.py

The aux flare (`index.json` event flare) is the old dufu.js image rule and is reliable for gold; the crop classifier
otherwise confuses gold lines with gold-coloured collision sparks. Labels: G for every crop in [contact-30, contact-2]
of a gold contact, the existing seed label elsewhere.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import OUT, read_json  # noqa: E402

LAB = Path(__file__).resolve().parent / "s2_labels_p1.json"
idx = read_json(OUT / "index.json")
labels = json.loads(LAB.read_text(encoding="utf-8"))
by: dict[str, list[dict]] = {}
for e in idx["events"]:
    by.setdefault(e["rec"], []).append(e)
for rec in by:
    by[rec].sort(key=lambda e: e["frame"])
n = 0
for key in labels:
    rec, fr, _k = key.split(":")
    fr = int(fr)
    for e in by.get(rec, []):
        d = e["frame"] - fr
        if d < -30:
            continue
        if d > -2:
            break
        if e.get("flare"):
            labels[key] = "G"
            n += 1
            break
LAB.write_text(json.dumps(dict(sorted(labels.items())), indent=0), encoding="utf-8")
print("gold overrides", n, Counter(labels.values()))
