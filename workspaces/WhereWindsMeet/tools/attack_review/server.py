"""Loopback review server; no device, training or deployment endpoints."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import attack_audit as audit

ASSETS = Path(__file__).parent


class ReviewStore:
    def __init__(self, out):
        self.out = Path(out).resolve()
        self.samples = audit.read(self.out / "samples.json")
        self.lock = threading.Lock()

    def label(self, index):
        return audit.read(self.out / "labels.json")[self.samples[index]["sample_id"]]

    def check(self, index, stage):
        if index < 0 or index >= len(self.samples) or stage not in (1, 2, 3):
            raise ValueError("Invalid sample or stage")
        lab = self.label(index)
        if stage >= 2 and lab["stage1_original"] is None:
            raise ValueError("先保存阶段一判断；未来画面尚未解锁")
        if stage == 3 and lab["stage2_original"] is None:
            raise ValueError("先保存阶段二判断；模型、动作和结果尚未解锁")
        return lab

    def sample_view(self, index, stage):
        lab = self.check(index, stage)
        sample = self.samples[index]
        clip = sample["clip"]
        result = {"review_id": f"review-{index + 1:03d}", "stage": stage,
                  "range": [clip["from"], clip["pre_decision_to"] if stage == 1 else clip["to"]],
                  "extendable": [0, clip["pre_decision_to"] if stage == 1 else clip["extendable_to"]],
                  "fps": clip["fps"], "template": audit.label_template(stage),
                  "warning": "决策截断仅为日志代理时刻，真实推理输入帧未知；不能据此确认决策前可辨识。",
                  "saved": lab.get(f"stage{stage}_original" if stage < 3 else "stage3"),
                  "revisions": lab.get(f"stage{stage}_revisions", [])}
        # Do not expose stage-2 labels/metadata in stage 1, even on a reopened sample.
        if stage >= 2:
            result["stage1_original"] = lab["stage1_original"]
        if stage == 3:
            result["sample"] = sample
            result["evidence"] = audit.read(self.out / "evidence" / f"{sample['sample_id']}.json")
            result["stage2_original"] = lab["stage2_original"]
        return result

    def frame(self, index, stage, n):
        self.check(index, stage)
        sample = self.samples[index]
        limit = sample["clip"]["pre_decision_to"] if stage == 1 else sample["clip"]["extendable_to"]
        if n < 0 or n > limit:
            raise ValueError("Frame outside revealed range")
        return audit.read_frame(audit.ROOT / sample["clip"]["video"], n)

    def save(self, index, stage, value):
        self.check(index, stage)
        with self.lock:
            labels = audit.read(self.out / "labels.json")
            sid = self.samples[index]["sample_id"]
            labels[sid] = audit.save_stage(labels[sid], stage, value)
            audit.write(self.out / "labels.json", labels)
            audit.report(self.out)
        return {"saved": True, "stage": stage}


def handler_for(store):
    class Handler(BaseHTTPRequestHandler):
        def send(self, body, kind="application/json; charset=utf-8", status=200):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

        def allowed_host(self):
            return self.headers.get("Host") in (f"127.0.0.1:{self.server.server_port}",
                                                f"localhost:{self.server.server_port}")

        def do_GET(self):
            try:
                if not self.allowed_host():
                    raise ValueError("Loopback Host required")
                url = urlparse(self.path)
                if url.path in ("/", "/app.js", "/style.css"):
                    name = {"/": "index.html", "/app.js": "app.js", "/style.css": "style.css"}[url.path]
                    mime = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}[Path(name).suffix]
                    return self.send((ASSETS/name).read_bytes(), mime + "; charset=utf-8")
                if url.path == "/api/index":
                    return self.send({"count": len(store.samples), "ids": [s["sample_id"] for s in store.samples], "stages": [
                        3 if store.label(i)["stage2_original"] else 2 if store.label(i)["stage1_original"] else 1
                        for i in range(len(store.samples))]})
                if url.path == "/api/export":
                    return self.send(audit.read(store.out/"labels.json"))
                q = parse_qs(url.query)
                i, stage = int(q["i"][0]), int(q["stage"][0])
                if url.path == "/api/sample":
                    return self.send(store.sample_view(i, stage))
                if url.path == "/api/source":
                    store.check(i, 3)
                    name = q["name"][0]
                    if name not in ("seq", "run", "features", "source", "config", "meta"):
                        raise ValueError("Invalid source")
                    row = next(r for r in audit.read(store.out/"rounds.json") if r["round"] == store.samples[i]["round"])
                    path = (audit.ROOT / row["files"][name]["path"]).resolve()
                    if not path.is_relative_to(audit.ROOT):
                        raise ValueError("Invalid source path")
                    return self.send(path.read_bytes(), "text/plain; charset=utf-8")
                if url.path == "/api/video":
                    store.check(i, 3)
                    path = audit.ROOT / store.samples[i]["clip"]["video"]
                    size = path.stat().st_size
                    start, end = 0, size - 1
                    range_header = self.headers.get("Range", "")
                    if range_header:
                        import re
                        match = re.fullmatch(r"bytes=(\d+)-(\d*)", range_header)
                        if not match:
                            raise ValueError("Unsupported byte range")
                        start = int(match[1])
                        end = min(int(match[2]) if match[2] else size - 1, size - 1)
                        if start > end:
                            raise ValueError("Invalid byte range")
                    self.send_response(206 if range_header else 200)
                    self.send_header("Content-Type", "video/mp4")
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Content-Length", str(end-start+1))
                    if range_header:
                        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                    self.end_headers()
                    with path.open("rb") as f:
                        f.seek(start)
                        left = end-start+1
                        while left:
                            chunk = f.read(min(left, 1024*1024))
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            left -= len(chunk)
                    return
                if url.path == "/api/frame":
                    import cv2
                    frame = store.frame(i, stage, int(q["n"][0]))
                    ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 94])
                    if not ok:
                        raise ValueError("JPEG encoding failed")
                    return self.send(encoded.tobytes(), "image/jpeg")
                self.send({"error": "Not found"}, status=404)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (ValueError, KeyError, IndexError, OSError) as e:
                self.send({"error": str(e)}, status=400)

        def do_POST(self):
            try:
                if not self.allowed_host():
                    raise ValueError("Loopback Host required")
                expected = f"http://{self.headers['Host']}"
                if self.headers.get("Origin") not in (None, expected):
                    raise ValueError("Cross-origin writes forbidden")
                if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                    raise ValueError("JSON required")
                if self.path != "/api/save":
                    raise ValueError("Unknown endpoint")
                n = int(self.headers.get("Content-Length", 0))
                if not 0 < n <= 1024 * 1024:
                    raise ValueError("Invalid payload size")
                payload = json.loads(self.rfile.read(n))
                self.send(store.save(int(payload["i"]), int(payload["stage"]), payload["value"]))
            except (ValueError, KeyError, IndexError, OSError) as e:
                self.send({"error": str(e)}, status=400)

        def log_message(self, *_args):
            pass
    return Handler


def serve(out, port):
    store = ReviewStore(out)
    server = ThreadingHTTPServer(("127.0.0.1", port), handler_for(store))
    print(f"Offline review: http://127.0.0.1:{server.server_port}  labels: {store.out/'labels.json'}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
