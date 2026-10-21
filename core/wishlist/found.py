"""What Wanted found recently: the "Found this week" filter on the Wanted page.

A wishlist row is deleted when its download lands, so a found item can't be
read back from ``wishlist_tracks``. Two tables already keep what is needed:

* ``wishlist_removals`` (#1289) has one row per removal, with its reason, the
  published path, the profiles whose library holds that path and the time;
* ``library_history`` has the title, artist, album, quality and art for the
  same path, written when the download was imported.

Joined on the path they answer "what did Wanted find this week" without a new
table. Only the two download reasons count as found: a track the library
already owned, or one matched by hand, didn't turn up from a search.

Scope: a removal names the profiles whose library holds the published file
(``profile_ids``; NULL for the historical all-profiles sweep). A profile sees a
find when its library is one of them. With one shared library that is every
profile, which is also everyone who can see the file; with libraries of their
own, a profile sees only what landed in its library. Which profile's request a
download cleared isn't recorded, so on a shared library this lists the finds
for everyone who shares it.

Read-only: one SELECT, no writes.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

from core.metadata import normalize_image_url
from core.metadata.artwork import is_internal_image_host
from core.wishlist.removal_guard import REASON_ATOMIC_PUBLISHED, REASON_DOWNLOAD_COMPLETE
from utils.logging_config import get_logger

logger = get_logger("wishlist.found")

FOUND_REASONS = (REASON_DOWNLOAD_COMPLETE, REASON_ATOMIC_PUBLISHED)
DEFAULT_DAYS = 7
MAX_DAYS = 30
MAX_ITEMS = 500


def clamp_days(raw: Any) -> int:
    """The window in days, 1 to MAX_DAYS; anything unreadable is the default."""
    try:
        days = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_DAYS
    return max(1, min(MAX_DAYS, days))


def _profile_sees(profile_ids_json: Optional[str], profile_id: int) -> bool:
    """A NULL list is the all-profiles sweep; otherwise the profile must be in it."""
    if not profile_ids_json:
        return True
    try:
        ids = json.loads(profile_ids_json)
    except (TypeError, ValueError):
        return False
    if not isinstance(ids, list):
        return False
    return any(str(pid) == str(profile_id) for pid in ids)


def _renderable_image(url: Optional[str]) -> str:
    """Library art is often a media-server relative path; make it render."""
    if not url or not isinstance(url, str):
        return ""
    needs_fix = (url.startswith("/") and not url.startswith("//")) or (
        url.startswith(("http://", "https://")) and is_internal_image_host(url)
    )
    if not needs_fix:
        return url
    try:
        return normalize_image_url(url) or ""
    except Exception:  # noqa: BLE001 - art is cosmetic
        return ""


def _title_from_path(path: Optional[str]) -> str:
    if not path:
        return ""
    stem, _ext = os.path.splitext(os.path.basename(str(path)))
    return stem


def _utc_iso(value: Any) -> Optional[str]:
    """SQLite CURRENT_TIMESTAMP is UTC without a zone; say so."""
    if not value:
        return None
    text = str(value).strip().replace(" ", "T")
    if text.endswith("Z") or "+" in text[10:]:
        return text
    return f"{text}Z"


def recently_found(database: Any, profile_id: int, *, days: int = DEFAULT_DAYS,
                   limit: int = MAX_ITEMS) -> List[Dict[str, Any]]:
    """Tracks Wanted found in the last ``days`` days that this profile can see,
    newest first. Each track appears once, at its latest find."""
    days = clamp_days(days)
    conn = database._get_connection()
    try:
        rows = conn.execute(
            f"""
            SELECT r.spotify_track_id, r.profile_ids, r.reason, r.final_path, r.removed_at,
                   lh.title, lh.artist_name, lh.album_name, lh.quality, lh.thumb_url
            FROM wishlist_removals r
            LEFT JOIN library_history lh ON lh.id = (
                SELECT h.id FROM library_history h
                WHERE h.file_path = r.final_path
                ORDER BY h.id DESC LIMIT 1
            )
            WHERE r.reason IN ({','.join('?' * len(FOUND_REASONS))})
              AND r.rows_removed > 0
              AND r.removed_at >= datetime('now', ?)
            ORDER BY r.removed_at DESC, r.id DESC
            """,
            (*FOUND_REASONS, f"-{days} days"),
        ).fetchall()
    finally:
        conn.close()

    items: List[Dict[str, Any]] = []
    seen: set = set()
    for row in rows:
        track_id = row[0]
        if track_id in seen or not _profile_sees(row[1], profile_id):
            continue
        title = row[5] or _title_from_path(row[3])
        if not title:
            continue
        seen.add(track_id)
        items.append({
            "id": str(track_id),
            "title": title,
            "artist": row[6] or "",
            "album": row[7] or "",
            "quality": row[8] or "",
            "image": _renderable_image(row[9]),
            "found_at": _utc_iso(row[4]),
            "reason": row[2],
        })
        if len(items) >= limit:
            break
    return items


__all__ = ["FOUND_REASONS", "DEFAULT_DAYS", "MAX_DAYS", "clamp_days", "recently_found"]
