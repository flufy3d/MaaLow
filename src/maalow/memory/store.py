from __future__ import annotations

import json
from typing import Any

from maalow.workspace import Workspace


class MemoryStore:
    """Simple JSON key-value store in <workspace>/memory/memory.json."""

    def __init__(self, workspace: Workspace):
        self.path = workspace.dir("memory") / "memory.json"
        self._data: dict[str, Any] = (
            json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {}
        )

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self._data[key] = value
        self.path.write_text(json.dumps(self._data, ensure_ascii=False, indent=2), encoding="utf-8")
