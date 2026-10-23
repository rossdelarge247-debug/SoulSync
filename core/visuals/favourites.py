"""Favourite visuals per profile (board 10a's star; HANDOFF "Visuals, what's
remembered where": favourites are taste, so they follow the profile, while
Recent and the rest stay per browser).

One small table: ``visual_favourites(profile_id, family, preset_key,
created_at)``. Only MilkDrop has stars today.
"""

from __future__ import annotations

import time
from typing import Any, List

from core.visuals.presets import BUNDLED_KEY_RE, FAMILIES, OWN_KEY_RE

# far more than anyone stars, small enough that one profile can't grow the table forever
MAX_PER_FAMILY = 2000


def ensure_schema(cursor) -> None:
    """MusicDatabase migration step."""
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS visual_favourites (
            profile_id INTEGER NOT NULL,
            family TEXT NOT NULL,
            preset_key TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (profile_id, family, preset_key)
        )
        """
    )


class FavouriteError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def valid_family(family: Any) -> bool:
    return isinstance(family, str) and family in FAMILIES


def valid_key(key: Any) -> bool:
    return isinstance(key, str) and bool(BUNDLED_KEY_RE.match(key) or OWN_KEY_RE.match(key))


def _check(family: Any, key: Any = None, *, need_key: bool = False) -> None:
    if not valid_family(family):
        raise FavouriteError("bad_family", "Only MilkDrop presets can be favourites.")
    if need_key and not valid_key(key):
        raise FavouriteError("bad_key", "That isn't a preset SYNCHRO.S knows.")


def list_keys(conn, profile_id: int, family: str) -> List[str]:
    _check(family)
    rows = conn.execute(
        "SELECT preset_key FROM visual_favourites WHERE profile_id = ? AND family = ? "
        "ORDER BY created_at DESC, preset_key",
        (int(profile_id), family),
    ).fetchall()
    return [r[0] for r in rows]


def add(conn, profile_id: int, family: str, key: str, *, now: float | None = None) -> bool:
    """Star a preset. True when it's starred afterwards (already was, or now is)."""
    _check(family, key, need_key=True)
    exists = conn.execute(
        "SELECT 1 FROM visual_favourites WHERE profile_id = ? AND family = ? AND preset_key = ?",
        (int(profile_id), family, key),
    ).fetchone()
    if exists:
        return True
    count = conn.execute(
        "SELECT COUNT(*) FROM visual_favourites WHERE profile_id = ? AND family = ?",
        (int(profile_id), family),
    ).fetchone()[0]
    if count >= MAX_PER_FAMILY:
        raise FavouriteError("too_many", f"You have {MAX_PER_FAMILY} favourites already. Unstar one first.")
    conn.execute(
        "INSERT INTO visual_favourites (profile_id, family, preset_key, created_at) VALUES (?, ?, ?, ?)",
        (int(profile_id), family, key, int(time.time() if now is None else now)),
    )
    conn.commit()
    return True


def remove(conn, profile_id: int, family: str, key: str) -> bool:
    """Unstar. Always False afterwards (it isn't a favourite now)."""
    _check(family, key, need_key=True)
    conn.execute(
        "DELETE FROM visual_favourites WHERE profile_id = ? AND family = ? AND preset_key = ?",
        (int(profile_id), family, key),
    )
    conn.commit()
    return False


__all__ = ["MAX_PER_FAMILY", "FavouriteError", "add", "ensure_schema", "list_keys", "remove",
           "valid_family", "valid_key"]
