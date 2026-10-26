"""The working set (the Mix tab, 29a): the one mix set a profile is building,
kept on the server so it's the same in every browser, until the profile
picks another. The table is made by ``MusicDatabase._add_dj_working_sets_table``.

Every read and write takes the caller's profile id and filters on it,
admins included. A working set must be one of the caller's own sets
(``core.sets.store``'s rule): choosing another profile's set is refused
exactly like choosing one that doesn't exist, and a set removed since reads
as no working set.
"""

from __future__ import annotations

import time
from contextlib import closing
from typing import Any, Dict, Optional

from core.sets import store as sets_store
from utils.logging_config import get_logger

logger = get_logger("sets.working")


def get(database, profile_id: int) -> Optional[Dict[str, Any]]:
    """The caller's working set (``{id, name, kind, revision, updated_at}``),
    or None: none chosen, or the one chosen is no longer theirs."""
    with closing(database._get_connection()) as conn:
        row = conn.execute(
            "SELECT s.id, s.name, s.kind, s.revision, s.updated_at FROM dj_working_sets w "
            "JOIN dj_sets s ON s.id = w.set_id AND s.profile_id = w.profile_id WHERE w.profile_id = ?",
            (int(profile_id),)).fetchone()
    if row is None:
        return None
    return {"id": int(row["id"]), "name": row["name"], "kind": row["kind"],
            "revision": int(row["revision"] or 0), "updated_at": row["updated_at"]}


def choose(database, profile_id: int, set_id: Any) -> Optional[Dict[str, Any]]:
    """Make one of the caller's sets the working set. None (nothing changed)
    when it isn't theirs."""
    with closing(database._get_connection()) as conn:
        own = sets_store._own(conn, profile_id, set_id)
        if own is None:
            return None
        conn.execute(
            "INSERT INTO dj_working_sets (profile_id, set_id, chosen_at) VALUES (?, ?, ?) "
            "ON CONFLICT(profile_id) DO UPDATE SET set_id = excluded.set_id, chosen_at = excluded.chosen_at",
            (int(profile_id), int(own["id"]), time.time()))
        conn.commit()
    return get(database, profile_id)


def clear(database, profile_id: int) -> None:
    """No working set for the caller."""
    with closing(database._get_connection()) as conn:
        conn.execute("DELETE FROM dj_working_sets WHERE profile_id = ?", (int(profile_id),))
        conn.commit()


def start(database, profile_id: int, name: Any, track_ids) -> int:
    """A new mix set holding ``track_ids`` (library tracks with their file;
    the rest are left out), made the working set; its id. Raises
    ``sets_store.SetError`` when none of them can go in."""
    from core.dj import traktor

    clean_name = sets_store.clean_name(name)
    found = {t["id"]: t for t in traktor.tracks_by_ids(database, list(dict.fromkeys(track_ids)))}
    rows = [{"track_id": tid, "artist": found[tid].get("artist_name"), "title": found[tid].get("title"),
             "state": "owned"} for tid in dict.fromkeys(track_ids) if tid in found]
    if not rows:
        raise sets_store.SetError("Only tracks in your library with their file can start a set")
    set_id = sets_store.create_set(database, profile_id, {"name": clean_name, "kind": "hand", "tracks": rows})
    saved = sets_store.get_set(database, profile_id, set_id)
    sets_store.make_playlist(database, profile_id, set_id, saved["name"], saved["rows"])
    choose(database, profile_id, set_id)
    return set_id


__all__ = ["choose", "clear", "get", "start"]
