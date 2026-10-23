"""Keep a Settings page that was open before a drive move from undoing it.

The legacy Settings page posts every field it holds, the three folder paths
included, two seconds after any change. A page loaded before the move's
switch still holds the old paths; saving anything on it would point
SYNCHRO.S back at the old copies. So a posted folder path that is the one a
move switched away from (while the setting is still where the move put it)
is dropped, and while a move is copying or switching the three paths don't
change at all.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from utils.logging_config import get_logger

logger = get_logger("drives.settings_guard")

#: (section, key) in the settings POST, and the role
FOLDER_FIELDS = (("soulseek", "download_path", "downloads"), ("soulseek", "transfer_path", "library"),
                 ("import", "staging_path", "staging"))


def _resolve(value: Any, default: str) -> str:
    from core.imports.paths import config_root_path
    return config_root_path(value, default)


def filter_folder_settings(new_settings: Dict[str, Any], config, move: Optional[Dict[str, Any]]) -> List[str]:
    """Drop folder paths from a settings POST that would undo or race a move.
    Returns the roles dropped (and logs why)."""
    if not move or not isinstance(new_settings, dict):
        return []
    dropped: List[str] = []
    status = move.get("status")
    switched = ((move.get("result") or {}).get("switched_paths") or {})
    old, new = switched.get("old") or {}, switched.get("new") or {}
    defaults = {"downloads": "./downloads", "library": "./Transfer", "staging": "./Staging"}
    for section, key, role in FOLDER_FIELDS:
        block = new_settings.get(section)
        if not isinstance(block, dict) or key not in block:
            continue
        posted = _resolve(block.get(key), defaults[role])
        current = _resolve(config.get(f"{section}.{key}", defaults[role]), defaults[role])
        if posted == current:
            continue
        if status in ("copying", "verifying", "switching"):
            block.pop(key, None)
            dropped.append(role)
            continue
        if status == "switched" and role in old and posted == old[role] and current == new.get(role):
            block.pop(key, None)
            dropped.append(role)
    if dropped:
        logger.info("[Drives] Kept the folder settings the drive move set (%s); the page's copy was older",
                    ", ".join(dropped))
    return dropped


__all__ = ["filter_folder_settings"]
