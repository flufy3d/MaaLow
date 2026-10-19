"""Draw the coordinate grid and the teacher's annotations on screenshots for the AI to read."""

from __future__ import annotations

import math
from pathlib import Path

GRID = 100
COLORS = {"rect": (255, 77, 79), "circle": (64, 169, 255), "arrow": (82, 196, 26), "click": (250, 173, 20),
          "region": (179, 127, 235)}  # as in the web UI
NAMES = {"rect": "框选", "circle": "圈", "arrow": "箭头", "click": "点击点", "region": "区域"}


def draw_grid(img) -> None:
    """Draw a labeled coordinate grid on a PIL image, so the AI can read positions off a screenshot."""
    from PIL import ImageDraw

    draw = ImageDraw.Draw(img)
    w, h = img.size
    for x in range(0, w, GRID):
        draw.line([(x, 0), (x, h)], fill=(255, 0, 255), width=1)
        draw.text((x + 2, 2), str(x), fill=(255, 255, 0))
    for y in range(0, h, GRID):
        draw.line([(0, y), (w, y)], fill=(255, 0, 255), width=1)
        draw.text((2, y + 2), str(y), fill=(255, 255, 0))


def draw_marks(img, annotations: list) -> None:
    """Draw the web UI's annotations (coords in the 1080x720 frame), numbered from 1 as the teacher saw them."""
    from PIL import ImageDraw

    draw = ImageDraw.Draw(img)
    for n, a in enumerate(annotations, 1):
        kind, c = a.get("kind"), [int(v) for v in a.get("coords", [])]
        color = COLORS.get(kind, (255, 255, 255))
        lx, ly = (c + [0, 0])[:2]
        if kind == "rect" and len(c) == 4:
            draw.rectangle([c[0], c[1], c[0] + c[2], c[1] + c[3]], outline=color, width=3)
        elif kind == "region" and len(c) == 4:  # dashed, like the web UI
            x0, y0, x1, y1 = c[0], c[1], c[0] + c[2], c[1] + c[3]
            for i in range(x0, x1, 14):
                draw.line([(i, y0), (min(i + 8, x1), y0)], fill=color, width=3)
                draw.line([(i, y1), (min(i + 8, x1), y1)], fill=color, width=3)
            for i in range(y0, y1, 14):
                draw.line([(x0, i), (x0, min(i + 8, y1))], fill=color, width=3)
                draw.line([(x1, i), (x1, min(i + 8, y1))], fill=color, width=3)
        elif kind == "circle" and len(c) == 4:
            draw.ellipse([c[0], c[1], c[0] + c[2], c[1] + c[3]], outline=color, width=3)
        elif kind == "arrow" and len(c) == 4:
            draw.line([(c[0], c[1]), (c[2], c[3])], fill=color, width=3)
            ang = math.atan2(c[3] - c[1], c[2] - c[0])
            head = [(c[2] - 16 * math.cos(ang + d), c[3] - 16 * math.sin(ang + d)) for d in (-0.4, 0.4)]
            draw.polygon([(c[2], c[3]), *head], fill=color)
        elif kind == "click" and len(c) == 2:
            x, y = c
            draw.ellipse([x - 10, y - 10, x + 10, y + 10], outline=color, width=3)
            draw.line([(x - 16, y), (x + 16, y)], fill=color, width=3)
            draw.line([(x, y - 16), (x, y + 16)], fill=color, width=3)
            lx, ly = x + 12, y - 12
        ly = max(ly, 20)
        draw.rectangle([lx, ly - 20, lx + 8 + 9 * len(str(n)), ly], fill=color)
        draw.text((lx + 4, ly - 16), str(n), fill=(0, 0, 0))


def grid_png(src: Path, dst: Path, annotations: list | None = None) -> None:
    from PIL import Image

    img = Image.open(src).convert("RGB")
    draw_grid(img)
    if annotations:
        draw_marks(img, annotations)
    img.save(dst)
