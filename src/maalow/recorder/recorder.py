from __future__ import annotations

import json
from dataclasses import asdict

from maalow.teaching import Annotation, AnnotationKind, TeachingSession, TeachingStep
from maalow.workspace import Workspace


class Recorder:
    def __init__(self, workspace: Workspace):
        self.dir = workspace.dir("teaching")

    def save(self, session: TeachingSession) -> None:
        path = self.dir / f"{session.task}.json"
        path.write_text(json.dumps(asdict(session), ensure_ascii=False, indent=2), encoding="utf-8")

    def load(self, task: str) -> TeachingSession:
        data = json.loads((self.dir / f"{task}.json").read_text(encoding="utf-8"))
        steps = []
        for s in data.get("steps", []):
            annotations = [
                Annotation(kind=AnnotationKind(a["kind"]), coords=a["coords"], label=a.get("label", ""))
                for a in s.get("annotations", [])
            ]
            steps.append(TeachingStep(**{**s, "annotations": annotations}))
        return TeachingSession(task=data["task"], steps=steps)
