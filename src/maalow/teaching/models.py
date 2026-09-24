from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class AnnotationKind(str, Enum):
    RECT = "rect"
    CIRCLE = "circle"
    ARROW = "arrow"
    CLICK = "click"
    REGION = "region"


@dataclass
class Annotation:
    kind: AnnotationKind
    # rect/region/circle: [x, y, w, h]; arrow: [x1, y1, x2, y2]; click: [x, y]
    coords: list[int]
    label: str = ""


@dataclass
class TeachingStep:
    screenshot: str  # path relative to workspace
    instruction: str  # natural-language guidance
    annotations: list[Annotation] = field(default_factory=list)
    action: dict | None = None  # executed action
    result: str = ""  # observed outcome
    after: str = ""  # screenshot taken after the action, relative to workspace


@dataclass
class TeachingSession:
    task: str
    steps: list[TeachingStep] = field(default_factory=list)

    def add(self, step: TeachingStep) -> None:
        self.steps.append(step)
