"""Built-in skill stubs; implementations come later."""

from __future__ import annotations

from maalow.skills.base import Skill, SkillContext, registry

BUILTIN = ("ClosePopup", "ClickText", "ScrollList", "WaitLoading", "Interact", "FollowParty", "Fight", "SearchChest")


def _make(name: str) -> type[Skill]:
    def run(self, ctx: SkillContext) -> bool:
        raise NotImplementedError(f"skill {name} not implemented yet")

    return type(name, (Skill,), {"name": name, "run": run})


for _name in BUILTIN:
    registry.register(_make(_name))
