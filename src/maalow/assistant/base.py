from __future__ import annotations

from abc import ABC, abstractmethod

from maalow.teaching import TeachingSession


class Assistant(ABC):
    """Turns teaching sessions into Maa pipelines and diagnoses failures."""

    @abstractmethod
    def summarize(self, session: TeachingSession) -> dict:
        """Generate Maa Pipeline JSON from a teaching session."""

    @abstractmethod
    def diagnose(self, pipeline: dict, screenshot: str, error: str) -> str:
        """Analyze a failed run and suggest a fix."""
