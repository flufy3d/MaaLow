from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class SkillContext:
    controller: Any = None  # maalow.runtime controller
    params: dict = field(default_factory=dict)


class Skill(ABC):
    name: str = ""

    @abstractmethod
    def run(self, ctx: SkillContext) -> bool:
        """Execute the skill; return True on success."""


class SkillRegistry:
    def __init__(self) -> None:
        self._skills: dict[str, type[Skill]] = {}

    def register(self, cls: type[Skill]) -> type[Skill]:
        if not cls.name:
            raise ValueError(f"{cls.__name__} has no name")
        self._skills[cls.name] = cls
        return cls

    def get(self, name: str) -> type[Skill]:
        return self._skills[name]

    def names(self) -> list[str]:
        return list(self._skills)


registry = SkillRegistry()
