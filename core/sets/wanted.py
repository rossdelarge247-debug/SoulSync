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
from typing import Any, Dict, List

from utils.logging_config import get_logger

logger = get_logger("sets.wanted")

ID_PREFIX = "sets_"
MAX_ITEMS = 200


def wanted_id(artist: str, title: str) -> str:
    key = f"{len(artist)}:{artist.casefold()}{len(title)}:{title.casefold()}"
    return ID_PREFIX + hashlib.sha1(key.encode("utf-8", errors="replace")).hexdigest()[:16]


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
        artist = " ".join(str(item.get("artist") or "").split())[:300]
        title = " ".join(str(item.get("title") or "").split())[:300]
        if not artist or not title:
            continue
        outcome = database.add_to_wishlist_detailed(
            track_data(artist, title, " ".join(str(item.get("album") or "").split())[:300]),
            failure_reason="Wanted for a set", source_type="set",
            source_info={"set_name": set_name[:200], "added_via": "sets"}, profile_id=int(profile_id),
            user_initiated=True)
        status = outcome.get("status")
        if status == "created":
            added += 1
        elif status in ("updated", "satisfied"):
            already += 1
        else:
            refused.append({"artist": artist, "title": title, "reason": outcome.get("reason") or status})
    return {"added": added, "already": already, "refused": refused}


__all__ = ["ID_PREFIX", "MAX_ITEMS", "add", "track_data", "wanted_id"]
