from __future__ import annotations

import os
import shutil
from pathlib import Path

KEY_BACK = 4
KEY_HOME = 3


def find_adb() -> str:
    """Resolve adb from $MAALOW_ADB, PATH, or ~/tools/platform-tools."""
    candidates = [os.environ.get("MAALOW_ADB"), shutil.which("adb")]
    candidates.append(str(Path.home() / "tools" / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")))
    for c in candidates:
        if c and Path(c).is_file():
            return c
    raise FileNotFoundError("adb not found; set MAALOW_ADB or put adb on PATH")


class Device:
    """An adb device driven by MaaFramework. Coordinates use the scaled screenshot space."""

    def __init__(self, address: str, adb_path: str | None = None, short_side: int = 720):
        from maa.controller import AdbController

        self.address = address
        self.ctrl = AdbController(adb_path or find_adb(), address)
        self.ctrl.set_screenshot_target_short_side(short_side)

    def connect(self) -> None:
        if not self.ctrl.post_connection().wait().succeeded:
            raise ConnectionError(f"failed to connect {self.address}")

    def screenshot(self):
        """Return the current screen as a BGR numpy array."""
        job = self.ctrl.post_screencap().wait()
        if not job.succeeded:
            raise RuntimeError("screencap failed")
        return job.get()

    def _ok(self, job, what: str) -> None:
        if not job.wait().succeeded:
            raise RuntimeError(f"{what} failed")

    def click(self, x: int, y: int) -> None:
        self._ok(self.ctrl.post_click(x, y), "click")

    def swipe(self, x1: int, y1: int, x2: int, y2: int, duration: int = 300) -> None:
        self._ok(self.ctrl.post_swipe(x1, y1, x2, y2, duration), "swipe")

    def key(self, code: int) -> None:
        self._ok(self.ctrl.post_click_key(code), "key")

    def text(self, text: str) -> None:
        self._ok(self.ctrl.post_input_text(text), "input_text")

    def start_app(self, package: str) -> None:
        self._ok(self.ctrl.post_start_app(package), "start_app")

    def stop_app(self, package: str) -> None:
        self._ok(self.ctrl.post_stop_app(package), "stop_app")

    def shell(self, cmd: str, timeout: int = 20000) -> str:
        job = self.ctrl.post_shell(cmd, timeout).wait()
        if not job.succeeded:
            raise RuntimeError(f"shell failed: {cmd}")
        return job.get()
