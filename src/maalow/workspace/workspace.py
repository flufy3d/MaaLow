from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

CONFIG_FILE = "workspace.json"
SUBDIRS = ("tasks", "templates", "pipeline", "skills", "teaching", "memory")


@dataclass
class WorkspaceConfig:
    name: str
    controller: str = "adb"  # adb | win32
    target: str = ""  # adb serial or window title
    extra: dict = field(default_factory=dict)


class Workspace:
    """A directory holding tasks, templates, pipelines, skills, teaching records and config."""

    def __init__(self, path: Path, config: WorkspaceConfig):
        self.path = path
        self.config = config

    @classmethod
    def create(cls, root: Path, name: str) -> Workspace:
        path = Path(root) / name
        if (path / CONFIG_FILE).exists():
            raise FileExistsError(f"workspace already exists: {path}")
        for sub in SUBDIRS:
            (path / sub).mkdir(parents=True, exist_ok=True)
        ws = cls(path, WorkspaceConfig(name=name))
        ws.save()
        return ws

    @classmethod
    def open(cls, path: Path) -> Workspace:
        path = Path(path)
        data = json.loads((path / CONFIG_FILE).read_text(encoding="utf-8"))
        return cls(path, WorkspaceConfig(**data))

    @staticmethod
    def list(root: Path) -> list[str]:
        root = Path(root)
        if not root.is_dir():
            return []
        return sorted(p.name for p in root.iterdir() if (p / CONFIG_FILE).is_file())

    def save(self) -> None:
        (self.path / CONFIG_FILE).write_text(
            json.dumps(asdict(self.config), ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def dir(self, name: str) -> Path:
        if name not in SUBDIRS:
            raise KeyError(name)
        return self.path / name
