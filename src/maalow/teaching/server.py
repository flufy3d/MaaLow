"""Teaching server: keeps a device connection open and records every step.

The human teacher uses the web UI at / to see the screen, draw annotations and talk.
The AI engineer listens for teacher messages and drives the device:

    GET  /                          teaching web UI
    GET  /state                     current task, step count, last screenshot
    GET  /messages?since=N          chat log after message id N
    GET  /listen?timeout=S          block until new teacher messages arrive
    GET  /file/<path>               workspace teaching image
    GET  /live                      current screen as JPEG, not recorded (X-Frame header = frame id)
    POST /teach {text, annotations, image, frame}   teacher message drawn on a live frame
    POST /say   {text}              AI reply shown in the UI
    POST /shot                      take a fresh screenshot
    POST /act   {action, say}       execute an action, record it, return the new screenshot
    POST /task  {name}              save the current session and start a new one
    POST /run   {node, once}        run a learned pipeline node on the device (once=false: the whole task)

Guard nodes (workspace config "guards") are checked offline on every captured frame and
run on the device when they match, so learned popups and idle screens clear themselves.
"""

from __future__ import annotations

import base64
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from maalow.device import Device
from maalow.device.device import KEY_BACK, KEY_HOME
from maalow.recorder import Recorder
from maalow.teaching.models import Annotation, AnnotationKind, TeachingSession, TeachingStep
from maalow.workspace import Workspace

GRID = 100
GUARD_IDLE = 10  # seconds without a frame before the guard takes its own screenshot
UI = Path(__file__).with_name("ui.html")


def save_png(image, path: Path, grid: bool = False) -> None:
    from PIL import Image, ImageDraw

    img = Image.fromarray(image[:, :, ::-1])  # BGR -> RGB
    if grid:
        draw = ImageDraw.Draw(img)
        w, h = img.size
        for x in range(0, w, GRID):
            draw.line([(x, 0), (x, h)], fill=(255, 0, 255), width=1)
            draw.text((x + 2, 2), str(x), fill=(255, 255, 0))
        for y in range(0, h, GRID):
            draw.line([(0, y), (w, y)], fill=(255, 0, 255), width=1)
            draw.text((2, y + 2), str(y), fill=(255, 255, 0))
    img.save(path)


class TeachingServer:
    def __init__(self, workspace: Workspace, device: Device, task: str):
        self.ws = workspace
        self.device = device
        self.recorder = Recorder(workspace)
        self.lock = threading.Lock()
        self.chat = threading.Condition()
        self.messages: list[dict] = []
        self.delivered = 0  # last teacher message id handed to the AI
        self.pending: dict | None = None  # teacher message whose annotations go on the next step
        self.listeners = 0  # AI clients currently waiting in /listen
        self.last = ""
        self.frames: dict[int, object] = {}  # recent live frames (BGR), recorded only if the teacher draws on one
        self.frame_id = 0
        self.frame_time = 0.0
        self.guard_busy = threading.Lock()
        self.checker = None
        self.checker_stamp = 0.0
        self._start(task)

    def _start(self, task: str) -> None:
        existing = self.ws.dir("teaching") / f"{task}.json"
        self.session = self.recorder.load(task) if existing.exists() else TeachingSession(task=task)
        self.shots = self.ws.dir("teaching") / task
        self.shots.mkdir(parents=True, exist_ok=True)
        self.counter = max([int(p.stem) for p in self.shots.glob("*.png") if p.stem.isdigit()], default=0)
        log = self.ws.dir("teaching") / f"{task}.chat.jsonl"
        lines = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
        with self.chat:
            self.messages = [json.loads(line) for line in lines if line.strip()]
            self.delivered = len(self.messages)  # history was already handled

    def _shot(self, image=None) -> dict:
        self.counter += 1
        name = f"{self.counter:04d}"
        if image is None:
            image = self._capture()
        raw, grid = self.shots / f"{name}.png", self.shots / f"{name}.grid.png"
        save_png(image, raw)
        save_png(image, grid, grid=True)
        self.last = raw.relative_to(self.ws.path).as_posix()
        h, w = image.shape[:2]
        return {"screenshot": self.last, "view": str(grid.resolve()), "size": [w, h]}

    def _capture(self):
        image = self.device.screenshot()
        self.frame_time = time.time()
        threading.Thread(target=self._guard, args=(image,), daemon=True).start()
        return image

    def _guard(self, image) -> None:
        """Check guard nodes on a frame; run the first match on the device."""
        from maalow.runtime import Runner

        if not self.guard_busy.acquire(blocking=False):
            return  # a check is already running; the next frame will be checked
        try:
            guards = Workspace.open(self.ws.path).config.guards  # re-read so new guards apply live
            checker = self._checker() if guards else None
            for node in guards:
                if checker.check(node, image):
                    with self.lock:
                        hit = Runner(self.ws, self.device.ctrl, checker.resource).run(node, once=True)
                    if hit:
                        self.say(f"[自动] 规则 {node} 已触发", auto=True)
                        with self.lock:
                            self._shot()
                    break
        except Exception as e:
            self.say(f"[自动] 规则检查出错：{type(e).__name__}: {e}", auto=True)
        finally:
            self.guard_busy.release()

    def _checker(self):
        """An offline Runner with fresh resources, reloaded when pipeline or templates change."""
        import numpy as np

        from maalow.device.replay import ImageController
        from maalow.runtime import Runner

        dirs = (self.ws.dir("pipeline"), self.ws.dir("templates"))
        stamp = max((p.stat().st_mtime for d in dirs for p in d.iterdir()), default=0)
        if self.checker is None or self.checker_stamp != stamp:
            self.checker = Runner(self.ws, ImageController(np.zeros((1, 1, 3), np.uint8)))
            self.checker_stamp = stamp
        return self.checker

    def watch(self) -> None:
        """Keep guards alive when nobody is looking at the live view."""
        while True:
            time.sleep(GUARD_IDLE / 2)
            if time.time() - self.frame_time > GUARD_IDLE and Workspace.open(self.ws.path).config.guards:
                try:
                    self.live()
                except Exception:
                    pass

    def _do(self, a: dict) -> None:
        t = a["type"]
        d = self.device
        package = a.get("package") or self.ws.config.package
        if t == "click":
            d.click(a["x"], a["y"])
        elif t == "swipe":
            d.swipe(a["x1"], a["y1"], a["x2"], a["y2"], a.get("duration", 300))
        elif t == "key":
            d.key(a["code"])
        elif t == "back":
            d.key(KEY_BACK)
        elif t == "home":
            d.key(KEY_HOME)
        elif t == "text":
            d.text(a["text"])
        elif t == "start_app":
            d.start_app(package)
        elif t == "stop_app":
            d.stop_app(package)
        elif t == "wait":
            pass
        else:
            raise ValueError(f"unknown action type: {t}")

    def state(self) -> dict:
        with self.chat:
            talk = [m for m in self.messages if not m.get("auto")]
            waiting = bool(talk) and talk[-1]["role"] == "teacher"  # teacher spoke, AI has not replied yet
            listening = self.listeners > 0
        return {
            "task": self.session.task,
            "steps": len(self.session.steps),
            "screenshot": self.last,
            "waiting": waiting,
            "ai": "listening" if listening else "busy" if waiting else "away",
        }

    def shot(self) -> dict:
        with self.lock:
            return self._shot()

    def act(self, action: dict, say: str = "", wait_ms: int = 1500) -> dict:
        with self.lock:
            before = self.last or self._shot()["screenshot"]
            self._do(action)
            time.sleep((action.get("ms", wait_ms) if action["type"] == "wait" else wait_ms) / 1000)
            after = self._shot()
            note, self.pending = self.pending, None
            annotations = [
                Annotation(AnnotationKind(a["kind"]), [round(c) for c in a["coords"]], a.get("label", ""))
                for a in (note or {}).get("annotations", [])
            ]
            instruction = say or (note or {}).get("text", "")
            self.session.add(TeachingStep(before, instruction, annotations, action, after=after["screenshot"]))
            self.recorder.save(self.session)
            return {"step": len(self.session.steps), **after}

    def live(self) -> tuple[int, bytes]:
        import io

        from PIL import Image

        with self.lock:
            image = self._capture()
            self.frame_id += 1
            frame_id = self.frame_id
            self.frames[frame_id] = image
            self.frames.pop(frame_id - 5, None)
        buf = io.BytesIO()
        Image.fromarray(image[:, :, ::-1]).save(buf, "JPEG", quality=85)
        return frame_id, buf.getvalue()

    def run(self, node: str, once: bool = True) -> dict:
        from maalow.runtime import Runner

        with self.lock:
            ok = Runner(self.ws, self.device.ctrl).run(node, once=once)  # reload so fresh rules apply
            return {"node": node, "hit": ok, **self._shot()}

    def task(self, name: str) -> dict:
        with self.lock:
            if self.session.steps:
                self.recorder.save(self.session)
            self._start(name)
            return self.state()

    # --- chat between the human teacher and the AI ---

    def _post(self, msg: dict) -> dict:
        with self.chat:
            msg = {"id": len(self.messages) + 1, "time": time.strftime("%H:%M:%S"), **msg}
            self.messages.append(msg)
            with open(self.ws.dir("teaching") / f"{self.session.task}.chat.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps(msg, ensure_ascii=False) + "\n")
            self.chat.notify_all()
            return msg

    def teach(self, text: str, annotations: list[dict], image: str = "", frame: int = 0) -> dict:
        with self.lock:
            seen = self.frames.pop(frame, None)
            if seen is not None:
                self._shot(seen)  # record the exact frame the teacher saw
        note = view = ""
        if image.startswith("data:image/png;base64,"):
            path = self.shots / f"note-{len(list(self.shots.glob('note-*.png'))) + 1:04d}.png"
            path.write_bytes(base64.b64decode(image.split(",", 1)[1]))
            note, view = path.relative_to(self.ws.path).as_posix(), str(path.resolve())
        msg = {"role": "teacher", "text": text, "annotations": annotations, "screenshot": self.last}
        return self._post({**msg, "note": note, "view": view})

    def say(self, text: str, auto: bool = False) -> dict:
        """AI reply; auto marks guard notices, which do not count as answering the teacher."""
        return self._post({"role": "ai", "text": text, **({"auto": True} if auto else {})})

    def since(self, n: int) -> list[dict]:
        with self.chat:
            return self.messages[n:]

    def listen(self, timeout: float) -> list[dict]:
        """Wait for teacher messages not yet delivered to the AI."""
        end = time.time() + timeout
        with self.chat:
            self.listeners += 1
            try:
                while True:
                    new = [m for m in self.messages[self.delivered :] if m["role"] == "teacher"]
                    if new:
                        self.delivered = len(self.messages)
                        self.pending = new[-1] if new[-1]["annotations"] else self.pending
                        return new
                    left = end - time.time()
                    if left <= 0:
                        return []
                    self.chat.wait(left)
            finally:
                self.listeners -= 1

    def serve(self, hosts: tuple[str, ...] = ("127.0.0.1",), port: int = 8765) -> None:
        server = self

        class Handler(BaseHTTPRequestHandler):
            def _send(self, code: int, data: bytes, ctype: str) -> None:
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)

            def _reply(self, code: int, body) -> None:
                self._send(code, json.dumps(body, ensure_ascii=False).encode(), "application/json; charset=utf-8")

            def do_GET(self):
                url = urlparse(self.path)
                q = {k: v[0] for k, v in parse_qs(url.query).items()}
                if url.path == "/":
                    return self._send(200, UI.read_bytes(), "text/html; charset=utf-8")
                if url.path == "/state":
                    return self._reply(200, server.state())
                if url.path == "/messages":
                    return self._reply(200, server.since(int(q.get("since", 0))))
                if url.path == "/live":
                    try:
                        frame_id, data = server.live()
                    except Exception as e:
                        return self._reply(500, {"error": f"{type(e).__name__}: {e}"})
                    self.send_response(200)
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Content-Length", str(len(data)))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("X-Frame", str(frame_id))
                    self.end_headers()
                    return self.wfile.write(data)
                if url.path == "/listen":
                    return self._reply(200, server.listen(float(q.get("timeout", 600))))
                if url.path.startswith("/file/"):
                    root = server.ws.dir("teaching").resolve()
                    path = (server.ws.path / url.path[len("/file/") :]).resolve()
                    if root in path.parents and path.suffix == ".png" and path.is_file():
                        return self._send(200, path.read_bytes(), "image/png")
                self._reply(404, {"error": "not found"})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                try:
                    if self.path == "/teach":
                        return self._reply(
                            200, server.teach(
                                body.get("text", ""), body.get("annotations", []), body.get("image", ""), body.get("frame", 0)
                            )
                        )
                    if self.path == "/say":
                        return self._reply(200, server.say(body["text"]))
                    if self.path == "/shot":
                        return self._reply(200, server.shot())
                    if self.path == "/act":
                        return self._reply(200, server.act(body["action"], body.get("say", ""), body.get("wait", 1500)))
                    if self.path == "/run":
                        return self._reply(200, server.run(body["node"], body.get("once", True)))
                    if self.path == "/task":
                        return self._reply(200, server.task(body["name"]))
                    self._reply(404, {"error": "not found"})
                except Exception as e:  # report device errors to the teacher instead of crashing
                    self._reply(500, {"error": f"{type(e).__name__}: {e}"})

            def log_message(self, fmt, *args):
                pass

        threading.Thread(target=self.watch, daemon=True).start()
        servers = [ThreadingHTTPServer((host, port), Handler) for host in hosts]
        for httpd in servers[1:]:
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
        for host in hosts:
            print(f"teaching server on http://{host}:{port} (task: {self.session.task})", flush=True)
        servers[0].serve_forever()
