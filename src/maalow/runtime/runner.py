from __future__ import annotations

from maalow.workspace import Workspace


class Runner:
    """Loads a workspace pipeline into MaaFramework and runs tasks locally."""

    def __init__(self, workspace: Workspace):
        self.workspace = workspace
        self._tasker = None

    def connect(self) -> None:
        try:
            from maa.toolkit import Toolkit  # noqa: F401
        except ImportError as e:
            raise RuntimeError("MaaFramework not installed; run: uv sync --extra maa") from e
        raise NotImplementedError("controller setup not implemented yet")

    def run(self, task: str) -> bool:
        if self._tasker is None:
            self.connect()
        raise NotImplementedError
