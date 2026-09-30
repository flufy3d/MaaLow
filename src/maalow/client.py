"""Client for the MaaLow companion app's HTTP API (/api/v1).

Server and token come from, in order: arguments, $MAALOW_SERVER / $MAALOW_TOKEN, ~/.maalow/config.toml:

    server = "http://100.123.41.110:8765"
    token = "..."

Screenshots the app saves are fetched into the local copy of the workspace (--root/<ws>/..., when it exists) or
~/.maalow/cache/<ws>/..., next to a .grid.png with a coordinate grid for the AI to read positions from.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

HOME = Path.home() / ".maalow"
CONFIG = HOME / "config.toml"
DEFAULT_SERVER = "http://127.0.0.1:8765"
API = "/api/v1"


def load_config(path: Path | None = None) -> dict:
    path = path or CONFIG
    if not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8")
    try:
        import tomllib
    except ImportError:  # Python 3.10: flat `key = "value"` lines are all we need
        out = {}
        for line in text.splitlines():
            key, sep, value = line.partition("=")
            if sep and not line.lstrip().startswith("#"):
                out[key.strip()] = value.strip().strip('"').strip("'")
        return out
    return tomllib.loads(text)


class Client:
    def __init__(self, server: str | None = None, token: str | None = None):
        cfg = load_config()
        self.server = (server or os.environ.get("MAALOW_SERVER") or cfg.get("server") or DEFAULT_SERVER).rstrip("/")
        self.token = token or os.environ.get("MAALOW_TOKEN") or cfg.get("token", "")

    def _open(self, method: str, path: str, data=None, ctype: str = "application/json", timeout: float = 120,
              length: int | None = None):
        headers = {"Content-Type": ctype, "X-MaaLow-Client": "cli"}  # the app tells the teacher when the AI last did something
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if length is not None:
            headers["Content-Length"] = str(length)
        req = urllib.request.Request(self.server + API + path, data=data, method=method, headers=headers)
        return urllib.request.urlopen(req, timeout=timeout)

    def request(self, method: str, path: str, body=None, timeout: float = 120):
        """JSON in, JSON out; HTTP errors come back as the server's {"error": ...} body."""
        data = None if body is None else json.dumps(body).encode()
        try:
            with self._open(method, path, data, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return json.loads(raw)
            except ValueError:
                return {"error": f"HTTP {e.code}: {raw[:200].decode(errors='replace')}"}

    def get(self, path: str, timeout: float = 120):
        return self.request("GET", path, timeout=timeout)

    def post(self, path: str, body: dict | None = None, timeout: float = 120):
        return self.request("POST", path, body or {}, timeout=timeout)

    def put(self, path: str, body: dict, timeout: float = 120):
        return self.request("PUT", path, body, timeout=timeout)

    def download(self, path: str, dest: Path, timeout: float = 300) -> Path:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".part")
        with self._open("GET", path, timeout=timeout) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        tmp.replace(dest)
        return dest

    def upload(self, method: str, path: str, file: Path, ctype: str = "application/octet-stream", timeout: float = 600):
        try:
            with open(file, "rb") as f, self._open(method, path, f, ctype, timeout, file.stat().st_size) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            return json.loads(e.read())

    # ---- workspace files

    def fetch(self, workspace: str, rel: str, root: Path | None = None, grid: bool = True,
              annotations: list | None = None) -> dict:
        """Download a workspace file (a screenshot); returns {"image", "view"} local paths. view: with a coordinate
        grid, and the annotations drawn on it when there are any."""
        local = self.download(f"/files/{urllib.parse.quote(workspace)}/{urllib.parse.quote(rel)}", local_base(root, workspace) / rel)
        out = {"image": str(local.resolve())}
        if grid:
            view = local.with_suffix(".marks.png" if annotations else ".grid.png")
            grid_png(local, view, annotations)
            out["view"] = str(view.resolve())
        return out

    def export_zip(self, workspace: str, dest: Path) -> Path:
        return self.download(f"/workspaces/{urllib.parse.quote(workspace)}/export.zip", dest)

    def import_dir(self, workspace: str, src: Path, mode: str = "merge", teaching: bool = True) -> dict:
        """Zip a local workspace directory and import it into the app."""
        with tempfile.TemporaryDirectory() as tmp:
            zpath = Path(tmp) / f"{workspace}.zip"
            with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
                for f in sorted(src.rglob("*")):
                    rel = f.relative_to(src).as_posix()
                    if not f.is_file() or any(p.startswith(".") or p == "__pycache__" for p in rel.split("/")):
                        continue
                    if rel.endswith(".grid.png") or (not teaching and rel.startswith("teaching/")):
                        continue  # grids are regenerated locally from the raw screenshots
                    z.write(f, rel)
            return self.upload("POST", f"/workspaces/{urllib.parse.quote(workspace)}/import?mode={mode}", zpath, "application/zip")


def local_base(root: Path | None, workspace: str) -> Path:
    """Where the app's workspace files land on the PC: the local workspace when there is one, else the cache."""
    return root / workspace if root is not None and (root / workspace / "workspace.json").is_file() else HOME / "cache" / workspace


GRID = 100
COLORS = {"rect": (255, 77, 79), "circle": (64, 169, 255), "arrow": (82, 196, 26), "click": (250, 173, 20),
          "region": (179, 127, 235)}  # as in the web UI


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
    """Draw the web UI's annotations (coords as in maalow.teaching.Annotation), numbered from 1 as the teacher saw them."""
    import math

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
