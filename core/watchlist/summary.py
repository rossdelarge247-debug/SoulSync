"""Per-artist numbers for the Followed artists tab of the Wanted page.

The watchlist list route returns each followed artist's settings and nothing
about how much of them you have or whether anything new turned up. All three
answers are already stored, so this reads them in one pass:

* **In your library**: albums (singles and EPs included) the library has
  under the artist's name, on the active media server when one is set. The
  same case-insensitive name match the dashboard's "owned" badge uses.
* **Latest release**: the newest ``recent_releases`` row for the artist, the
  per-artist release cache the artist detail panel reads.
* **Last found**: the newest release a followed-artist check found for the
  artist, from the scan history ledger (``watchlist_scan_runs.track_events``,
  #831): its album, when the check ran, and whether it went to Wanted (a
  "follow only" artist, or a track already on Wanted, is found but not added).
  Ledger events name the track's first artist, matched to the followed artist
  by name.
* **New release**: something was found in the last ``NEW_RELEASE_DAYS`` days.

What isn't stored is the artist's whole discography, so there is no "releases
in total" and no complete or incomplete verdict; that would need provider
calls per artist on every page load.

Read-only. Scoped to one profile: its followed artists, its scan history.
The library is shared, so its counts are the same for every profile.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional

from utils.logging_config import get_logger

logger = get_logger("watchlist.summary")

NEW_RELEASE_DAYS = 7
_IN_CHUNK = 500


def _norm(name: Any) -> str:
    return str(name or "").strip().lower()


def _chunks(values: List[Any], size: int = _IN_CHUNK) -> Iterable[List[Any]]:
    for start in range(0, len(values), size):
        yield values[start:start + size]


def _parse_local(value: Any) -> Optional[datetime]:
    """Scan timestamps are the server's local time without a zone
    (``datetime.now().isoformat()``). Aware values are converted to local."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone().replace(tzinfo=None)
    return parsed


def _utc_iso(local: datetime) -> str:
    """A local naive time as an explicit UTC instant, so the browser can say
    "3 days ago" without knowing the server's zone."""
    return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _library_release_counts(conn, names: List[str], active_server: Optional[str]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    if not names:
        return counts
    server_clause = ""
    if active_server:
        columns = {row[1] for row in conn.execute("PRAGMA table_info(albums)").fetchall()}
        if "server_source" in columns:
            server_clause = " AND al.server_source = ?"
    for chunk in _chunks(names):
        placeholders = ",".join("?" * len(chunk))
        params: List[Any] = list(chunk)
        if server_clause:
            params.append(active_server)
        rows = conn.execute(
            f"""
            SELECT LOWER(TRIM(ar.name)) AS artist_key, COUNT(DISTINCT al.id)
            FROM albums al
            JOIN artists ar ON al.artist_id = ar.id
            WHERE LOWER(TRIM(ar.name)) IN ({placeholders}){server_clause}
            GROUP BY artist_key
            """,
            params,
        ).fetchall()
        for key, count in rows:
            counts[key] = counts.get(key, 0) + int(count or 0)
    return counts


def _latest_releases(conn, artist_ids: List[int]) -> Dict[int, Dict[str, Any]]:
    latest: Dict[int, Dict[str, Any]] = {}
    if not artist_ids:
        return latest
    for chunk in _chunks(artist_ids):
        placeholders = ",".join("?" * len(chunk))
        rows = conn.execute(
            f"""
            SELECT watchlist_artist_id, album_name, release_date
            FROM recent_releases
            WHERE watchlist_artist_id IN ({placeholders})
            ORDER BY release_date DESC, added_date DESC
            """,
            chunk,
        ).fetchall()
        for artist_id, album_name, release_date in rows:
            if artist_id not in latest and album_name:
                latest[artist_id] = {"album_name": album_name, "release_date": release_date}
    return latest


def _last_found(conn, profile_id: int, wanted_keys: set) -> Dict[str, Dict[str, Any]]:
    """Newest found release per artist key, from the scan ledger (newest run
    first; within a run the first event for the artist names the album)."""
    found: Dict[str, Dict[str, Any]] = {}
    if not wanted_keys:
        return found
    rows = conn.execute(
        """
        SELECT completed_at, track_events FROM watchlist_scan_runs
        WHERE profile_id = ? AND track_events IS NOT NULL AND track_events != '[]'
        ORDER BY completed_at DESC, id DESC
        """,
        (profile_id,),
    ).fetchall()
    for completed_at, raw_events in rows:
        when = _parse_local(completed_at)
        if when is None:
            continue
        try:
            events = json.loads(raw_events)
        except (TypeError, ValueError):
            continue
        if not isinstance(events, list):
            continue
        in_this_run: Dict[str, Dict[str, Any]] = {}
        for event in events:
            if not isinstance(event, dict):
                continue
            key = _norm(event.get("artist_name"))
            if key not in wanted_keys or key in found:
                continue
            entry = in_this_run.get(key)
            if entry is None:
                entry = in_this_run[key] = {
                    "album_name": event.get("album_name") or "",
                    "found": when,
                    "added_to_wanted": False,
                }
            if event.get("status") == "added":
                entry["added_to_wanted"] = True
        found.update(in_this_run)
        if len(found) >= len(wanted_keys):
            break
    return found


def followed_artist_summary(database: Any, profile_id: int, *,
                            active_server: Optional[str] = None,
                            now: Optional[datetime] = None,
                            new_release_days: int = NEW_RELEASE_DAYS) -> List[Dict[str, Any]]:
    """One entry per artist the profile follows, keyed by its watchlist row id."""
    now = now or datetime.now()
    cutoff = now - timedelta(days=new_release_days)
    conn = database._get_connection()
    try:
        artists = conn.execute(
            "SELECT id, artist_name FROM watchlist_artists WHERE profile_id = ?",
            (profile_id,),
        ).fetchall()
        if not artists:
            return []
        keys = sorted({_norm(name) for _id, name in artists if _norm(name)})
        library = _library_release_counts(conn, keys, active_server)
        latest = _latest_releases(conn, [int(artist_id) for artist_id, _name in artists])
        found = _last_found(conn, profile_id, set(keys))
    finally:
        conn.close()

    summary: List[Dict[str, Any]] = []
    for artist_id, name in artists:
        key = _norm(name)
        last = found.get(key)
        last_found = None
        new_release = False
        if last:
            last_found = {
                "album_name": last["album_name"],
                "found_at": _utc_iso(last["found"]),
                "added_to_wanted": last["added_to_wanted"],
            }
            new_release = last["found"] >= cutoff
        summary.append({
            "id": int(artist_id),
            "library_releases": library.get(key, 0),
            "latest_release": latest.get(int(artist_id)),
            "last_found": last_found,
            "new_release": new_release,
        })
    return summary


__all__ = ["NEW_RELEASE_DAYS", "followed_artist_summary"]
