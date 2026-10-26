"""Putting a famous mix's tracks on Wanted (boards 22f, 22g): "Add N missing
to Wanted" and a row's "Want the Dub".

Wanted holds one track per row, keyed by a track id (``wishlist_tracks``,
``MusicDatabase.add_to_wishlist_detailed``), and the version is part of the
title it searches for: "Signal Fire (Dub)" is searched as that, and the
download matcher's version rules (``core/matching_engine``,
``core/text/title_match``) refuse the Original Mix for it. A tracklist line
has no catalogue id, so the row's id is made from the artist and title
(``sets_`` and a hash), the same pair always giving the same id: asking
twice updates the row instead of adding a second one.

Two sets can want the same track, so the row's ``source_info`` keeps the
names of the sets that asked (``set_names``, at most MAX_SET_NAMES; a set
past that isn't listed, so it can never take the row back). Taking a want
back drops that set's name, and the row goes only when no other set is left
on it. Like Wanted's own remove, this doesn't check whether a download of
the row is already under way.
"""

from __future__ import annotations

import hashlib
import json
from contextlib import closing
from typing import Any, Dict, List, Optional

from core.sets.tracklist import clean_text
from utils.logging_config import get_logger

logger = get_logger("sets.wanted")

ID_PREFIX = "sets_"
#: as many as a set has rows, so "Add N missing" never fails on a long mix
MAX_ITEMS = 500
#: the most set names one Wanted row remembers
MAX_SET_NAMES = 20


def wanted_id(artist: str, title: str) -> str:
    key = f"{len(artist)}:{artist.casefold()}{len(title)}:{title.casefold()}"
    return ID_PREFIX + hashlib.sha256(key.encode("utf-8", errors="replace")).hexdigest()[:16]


def track_data(artist: str, title: str, album: str = "") -> Dict[str, Any]:
    return {"id": wanted_id(artist, title), "name": title, "artists": [{"name": artist}],
            "album": {"name": album or title, "images": [], "album_type": "single", "artists": [{"name": artist}]},
            "source": "sets"}


def _sets_info(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """A Wanted row's ``source_info`` when a set added it, else None."""
    if not row or row.get("source_type") != "set":
        return None
    try:
        info = json.loads(row.get("source_info") or "{}")
    except ValueError:
        return None
    if not isinstance(info, dict) or info.get("added_via") != "sets":
        return None
    return info


def _set_names(info: Dict[str, Any]) -> List[str]:
    """The sets that asked for a row (rows from before the list keep their
    one ``set_name``)."""
    names = info.get("set_names")
    if not isinstance(names, list):
        names = [info.get("set_name")]
    return [n for n in dict.fromkeys(n for n in names if isinstance(n, str) and n)][:MAX_SET_NAMES]


def _info(names: List[str]) -> Dict[str, Any]:
    return {"set_name": names[0] if names else "", "set_names": names, "added_via": "sets"}


def add(database, profile_id: int, items: List[Dict[str, Any]], *, set_name: str = "") -> Dict[str, Any]:
    """Add each ``{artist, title, album?}`` to the profile's Wanted, this
    set's name joining the names of any other set that wants the same row.
    ``{"added", "already", "refused": [{artist, title, reason}]}``."""
    added = already = 0
    refused = []
    name = clean_text(set_name, 200)
    for item in items[:MAX_ITEMS]:
        artist = clean_text(item.get("artist"), 300)
        title = clean_text(item.get("title"), 300)
        if not artist or not title:
            continue
        info = _sets_info(database.get_wishlist_track(wanted_id(artist, title), profile_id=int(profile_id)))
        names = _set_names(info) if info is not None else []
        if name and name not in names and len(names) < MAX_SET_NAMES:
            names.append(name)
        outcome = database.add_to_wishlist_detailed(
            track_data(artist, title, clean_text(item.get("album"), 300)),
            failure_reason="Wanted for a set", source_type="set",
            source_info=_info(names), profile_id=int(profile_id),
            user_initiated=True)
        status = outcome.get("status")
        if status == "created":
            added += 1
        elif status in ("updated", "satisfied"):
            already += 1
        else:
            refused.append({"artist": artist, "title": title, "reason": outcome.get("reason") or status})
    return {"added": added, "already": already, "refused": refused}


def remove(database, profile_id: int, artist: Any, title: Any, *, set_name: str) -> bool:
    """Take back one set's "Want the Dub". The profile's Wanted row for this
    artist and title is touched only if a set added it (``source_type``
    "set") and this set is among the sets that asked: when it's the only one
    left the row goes, otherwise only its name does and the row stays for
    the others. True when this set's want was taken back. Like Wanted's own
    remove, a download already under way isn't checked for."""
    artist_text, title_text = clean_text(artist, 300), clean_text(title, 300)
    name = clean_text(set_name, 200)
    if not artist_text or not title_text or not name:
        return False
    track_id = wanted_id(artist_text, title_text)
    row = database.get_wishlist_track(track_id, profile_id=int(profile_id))
    info = _sets_info(row)
    if info is None:
        return False
    names = _set_names(info)
    if name not in names:
        return False
    left = [n for n in names if n != name]
    if not left:
        return bool(database.remove_from_wishlist(track_id, profile_id=int(profile_id)))
    # only if the row is still as it was read, so a want added meanwhile
    # isn't lost
    with closing(database._get_connection()) as conn:
        done = conn.execute(
            "UPDATE wishlist_tracks SET source_info = ? WHERE spotify_track_id = ? AND profile_id = ? "
            "AND source_type = 'set' AND source_info = ?",
            (json.dumps(_info(left)), track_id, int(profile_id), row.get("source_info"))).rowcount
        conn.commit()
    return done == 1


__all__ = ["ID_PREFIX", "MAX_ITEMS", "MAX_SET_NAMES", "add", "remove", "track_data", "wanted_id"]
