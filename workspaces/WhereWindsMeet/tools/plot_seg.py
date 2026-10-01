"""Draw a route run (route_seg.py out=...json) on the big map composite: plot_seg.py RUN.json OUT.png [x0 y0 x1 y1]."""
import json
import sys

import cv2
import numpy as np

run = json.load(open(sys.argv[1], encoding="utf8"))
out = sys.argv[2]
x0, y0, x1, y1 = [float(v) for v in sys.argv[3:7]] if len(sys.argv) >= 7 else (-120, 0, 0, 125)
S = 6  # px per big map px

comp = cv2.imdecode(np.fromfile("data/wwm/bigmap/composite.png", np.uint8), cv2.IMREAD_COLOR)
ox, oy = json.load(open("data/wwm/bigmap/composite.json"))["origin"]
crop = comp[int(oy + y0):int(oy + y1), int(ox + x0):int(ox + x1)]
img = cv2.resize(crop, None, fx=S, fy=S, interpolation=cv2.INTER_CUBIC)
P = lambda x, y: (int((x - x0) * S), int((y - y0) * S))

node = json.load(open("workspaces/WhereWindsMeet/pipeline/stronghold.json", encoding="utf8"))["CixinRoute"]
pts = node["custom_action_param"]["points"]
for k, p in enumerate(pts):
    x, y = p["at"]
    if x0 <= x <= x1 and y0 <= y <= y1:
        cv2.circle(img, P(x, y), 2 * S, (0, 0, 255), 2)  # reach 2
        cv2.circle(img, P(x, y), 6 * S, (0, 0, 160), 1)  # pass to the side
        cv2.putText(img, str(k), (P(x, y)[0] + 8, P(x, y)[1] - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 255), 2)
for a, b in zip(pts, pts[1:]):
    cv2.line(img, P(*a["at"]), P(*b["at"]), (0, 0, 200), 1)

legs = []
for line in run.get("logs", []):
    if line.startswith('{"ms"') and '"trace"' in line and '"fixes"' in line:
        legs.append(json.loads(line))
colors = [(255, 120, 0), (0, 160, 0), (200, 0, 200), (0, 200, 200)]
for n, leg in enumerate(legs):
    c = colors[n % len(colors)]
    tr = leg["trace"]
    for a, b in zip(tr, tr[1:]):
        cv2.line(img, P(a["x"], a["y"]), P(b["x"], b["y"]), c, 2)
    for p in tr:
        cv2.circle(img, P(p["x"], p["y"]), 3, c if p.get("sc") else (0, 0, 0), -1)
    for s in leg.get("stuck", []):
        cv2.drawMarker(img, P(s[2], s[3]), (0, 0, 0), cv2.MARKER_TILTED_CROSS, 24, 3)
        cv2.putText(img, f"stuck{s[1]} {s[0] // 1000}s", (P(s[2], s[3])[0] + 10, P(s[2], s[3])[1] + 20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)
    print(f"leg {n}: why {leg['why']} fixes {leg['fixes']} misses {leg['misses']} stuck {leg['stuck']}")
cv2.imencode(".png", img)[1].tofile(out)
