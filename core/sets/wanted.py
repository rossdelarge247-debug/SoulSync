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
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List

from core.sets.tracklist import clean_text
from utils.logging_config import get_logger

logger = get_logger("sets.wanted")

ID_PREFIX = "sets_"
#: as many as a set has rows, so "Add N missing" never fails on a long mix
MAX_ITEMS = 500


def wanted_id(artist: str, title: str) -> str:
    key = f"{len(artist)}:{artist.casefold()}{len(title)}:{title.casefold()}"
    return ID_PREFIX + hashlib.sha256(key.encode("utf-8", errors="replace")).hexdigest()[:16]


def track_data(artist: str, title: str, album: str = "") -> Dict[str, Any]:
    return {"id": wanted_id(artist, title), "name": title, "artists": [{"name": artist}],
            "album": {"name": album or title, "images": [], "album_type": "single", "artists": [{"name": artist}]},
            "source": "sets"}


def add(database, profile_id: int, items: List[Dict[str, Any]], *, set_name: str = "") -> Dict[str, Any]:
    """Add each ``{artist, title, album?}`` to the profile's Wanted.
    ``{"added", "already", "refused": [{artist, title, reason}]}``."""
    added = already = 0
    refused = []
    for item in items[:MAX_ITEMS]:
        artist = clean_text(item.get("artist"), 300)
        title = clean_text(item.get("title"), 300)
        if not artist or not title:
            continue
        outcome = database.add_to_wishlist_detailed(
            track_data(artist, title, clean_text(item.get("album"), 300)),
            failure_reason="Wanted for a set", source_type="set",
            source_info={"set_name": clean_text(set_name, 200), "added_via": "sets"}, profile_id=int(profile_id),
            user_initiated=True)
        status = outcome.get("status")
        if status == "created":
            added += 1
        elif status in ("updated", "satisfied"):
            already += 1
        else:
            refused.append({"artist": artist, "title": title, "reason": outcome.get("reason") or status})
    return {"added": added, "already": already, "refused": refused}


def remove(database, profile_id: int, artist: Any, title: Any, *, set_name: str = "") -> bool:
    """Take back a "Want the Dub": the profile's Wanted row for this artist
    and title goes, only if a set added it (``source_type`` "set") for this
    set's name, and it's still on Wanted (a download takes it off). True
    when a row went."""
    artist_text, title_text = clean_text(artist, 300), clean_text(title, 300)
    if not artist_text or not title_text:
        return False
    track_id = wanted_id(artist_text, title_text)
    row = database.get_wishlist_track(track_id, profile_id=int(profile_id))
    if not row or row.get("source_type") != "set":
        return False
    try:
        info = json.loads(row.get("source_info") or "{}")
    except ValueError:
        info = {}
    if not isinstance(info, dict) or info.get("added_via") != "sets":
        return False
    if set_name and info.get("set_name") and info.get("set_name") != clean_text(set_name, 200):
        return False
    return bool(database.remove_from_wishlist(track_id, profile_id=int(profile_id)))


__all__ = ["ID_PREFIX", "MAX_ITEMS", "add", "remove", "track_data", "wanted_id"]
