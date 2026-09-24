from __future__ import annotations

from pathlib import Path

from maa.controller import CustomController


class ImageController(CustomController):
    """Offline controller: serves a fixed screenshot and records inputs, for verifying rules."""

    def __init__(self, image):
        """image: a BGR numpy array, or a path to an image file."""
        import numpy as np

        super().__init__()
        if isinstance(image, (str, Path)):
            from PIL import Image

            image = np.array(Image.open(image).convert("RGB"))[:, :, ::-1]
        self.image = np.ascontiguousarray(image)
        self.clicks: list[tuple[int, int]] = []

    def connect(self) -> bool:
        return True

    def request_uuid(self) -> str:
        return "image"

    def screencap(self):
        return self.image

    def click(self, x: int, y: int) -> bool:
        self.clicks.append((x, y))
        return True

    def start_app(self, intent: str) -> bool:
        return True

    def stop_app(self, intent: str) -> bool:
        return True

    def swipe(self, x1, y1, x2, y2, duration) -> bool:
        return True

    def touch_down(self, contact, x, y, pressure) -> bool:
        self.clicks.append((x, y))
        return True

    def touch_move(self, contact, x, y, pressure) -> bool:
        return True

    def touch_up(self, contact) -> bool:
        return True

    def click_key(self, keycode) -> bool:
        return True

    def input_text(self, text) -> bool:
        return True

    def key_down(self, keycode) -> bool:
        return True

    def key_up(self, keycode) -> bool:
        return True


class SequenceController(ImageController):
    """Offline controller that advances to the next screenshot on every tap, for replaying a whole flow."""

    def __init__(self, images: list):
        super().__init__(images[0])
        self.frames = [ImageController(i).image for i in images]
        self.index = 0

    def screencap(self):
        return self.frames[self.index]

    def touch_down(self, contact, x, y, pressure) -> bool:
        self.clicks.append((x, y))
        self.index = min(self.index + 1, len(self.frames) - 1)
        return True
