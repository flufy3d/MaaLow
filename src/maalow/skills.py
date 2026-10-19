"""Names shown by `maalow skills`.

Real, runnable skills live in the workspace as `skills/<name>.js` and are executed by the app; this list is the
legacy Python-side registry kept only for that command.
"""

from __future__ import annotations

NAMES = ("ClosePopup", "ClickText", "ScrollList", "WaitLoading", "Interact", "FollowParty", "Fight", "SearchChest")


def names() -> list[str]:
    return list(NAMES)
