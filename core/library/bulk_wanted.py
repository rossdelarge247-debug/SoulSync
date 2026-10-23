"""Add a selection of releases to Wanted at once (Library → Albums, 7c/7d).

``add_releases`` takes releases from the release index (``release_index``)
and, for each:

* **already have**: an album you have whole (owned, or owned below the
  quality target; upgrading is a different action) adds nothing;
* **already wanted**: a release already on this profile's Wanted adds nothing;
* otherwise its tracklist is fetched from the metadata service (the album's
  own source id where known, the same source-priority lookup the Artist
  page's Add to Wanted uses) and every track you don't already have on that
  album goes on Wanted, held to the quality asked for. A release that ends up
  with nothing new (all its tracks were on Wanted already) counts as already
  wanted.

Rows go through ``add_to_wishlist_detailed`` for the profile, so per-profile
Wanted, the ignore list, the blocklist and the request rules all apply as
they do for one album: a profile without download rights adds requests an
admin approves, and a request limit refuses what's past it.

Tracklists are fetched four at a time; the database writes happen on the
calling thread.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional

from core.library.release_index import norm_title
from utils.logging_config import get_logger

logger = get_logger("library.bulk_wanted")

FETCH_THREADS = 4


def _default_fetch(release: Dict[str, Any]) -> Dict[str, Any]:
    from core.metadata.album_tracks import get_artist_album_tracks

    candidates = list(release.get("_provider") or [])
    last: Dict[str, Any] = {"success": False, "error": "No source knows this album"}
    if not candidates:
        candidates = [(None, release.get("source_id") or "")]
    for source, album_id in candidates:
        try:
            result = get_artist_album_tracks(
                str(album_id or ""),
                artist_name=release.get("artist_name") or "",
                album_name=release.get("title") or "",
                source_override=source,
            )
        except Exception as exc:  # noqa: BLE001 - one album's lookup never stops the rest
            last = {"success": False, "error": str(exc)}
            continue
        if result.get("success") and result.get("tracks"):
            return result
        last = result
    return last


def _owned_titles(database, album_id) -> set:
    if album_id is None:
        return set()
    try:
        conn = database._get_connection()
        try:
            rows = conn.execute(
                "SELECT title FROM tracks WHERE album_id = ? AND file_path IS NOT NULL AND file_path != ''",
                (album_id,)).fetchall()
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        return set()
    return {norm_title(r["title"] if hasattr(r, "keys") else r[0]) for r in rows}


def add_releases(
    database,
    releases: List[Dict[str, Any]],
    *,
    profile_id: int,
    quality_profile_id: Optional[int] = None,
    fetch: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Returns ``{added, already_wanted, already_have, failed, refused,
    tracks_added, results}``. ``results`` holds one entry per release:
    ``{id, title, outcome, tracks_added, message}``."""
    fetch = fetch or _default_fetch
    results: List[Dict[str, Any]] = []
    counts = {"added": 0, "already_wanted": 0, "already_have": 0, "failed": 0, "refused": 0, "tracks_added": 0}

    def record(release, outcome, tracks=0, message=""):
        counts[outcome] += 1
        counts["tracks_added"] += tracks
        results.append({"id": release["id"], "title": release["title"], "artist_name": release["artist_name"],
                        "outcome": outcome, "tracks_added": tracks, "message": message})

    to_fetch: List[Dict[str, Any]] = []
    for release in releases:
        if release.get("wanted"):
            record(release, "already_wanted")
        elif release["kind"] == "library" and release["state"] != "partial":
            record(release, "already_have")
        else:
            to_fetch.append(release)

    fetched: Dict[str, Dict[str, Any]] = {}
    if to_fetch:
        workers = min(FETCH_THREADS, len(to_fetch))
        if workers <= 1:
            for release in to_fetch:
                fetched[release["id"]] = fetch(release)
        else:
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="bulk-wanted") as pool:
                for release, result in zip(to_fetch, pool.map(fetch, to_fetch), strict=True):
                    fetched[release["id"]] = result

    for release in to_fetch:
        result = fetched.get(release["id"]) or {}
        tracks = result.get("tracks") or []
        if not result.get("success") or not tracks:
            record(release, "failed", message=result.get("error") or "Couldn't find its tracks")
            continue
        album = result.get("album") or {}
        album_name = album.get("name") or release["title"]
        album_images = album.get("images") or ([{"url": album["image_url"]}] if album.get("image_url") else [])
        if not album_images and release.get("art_url"):
            album_images = [{"url": release["art_url"]}]
        album_artists = album.get("artists") or [{"name": release["artist_name"]}]
        album_type = release.get("album_type") or album.get("album_type") or "album"
        resolved_id = str(result.get("resolved_album_id") or album.get("id") or release.get("source_id") or "")
        source = result.get("source") or release.get("source") or "unknown"
        owned = _owned_titles(database, release.get("album_id")) if release["kind"] == "library" else set()
        created = 0
        covered = 0
        refused = False
        for track in tracks:
            name = track.get("name") or track.get("title") or ""
            track_id = track.get("id") or ""
            if not name or not track_id:
                continue
            if norm_title(name) in owned:
                covered += 1
                continue
            data = {
                "id": track_id,
                "name": name,
                "artists": track.get("artists") or album_artists,
                "album": {
                    "id": resolved_id,
                    "name": album_name,
                    "artists": album_artists,
                    "images": album_images,
                    "album_type": album_type,
                    "release_date": album.get("release_date") or (str(release["year"]) if release.get("year") else ""),
                    "total_tracks": len(tracks),
                },
                "duration_ms": track.get("duration_ms", 0),
                "explicit": track.get("explicit", False),
                "track_number": track.get("track_number", 0),
                "disc_number": track.get("disc_number", 1),
                "uri": track.get("uri", ""),
                "external_urls": track.get("external_urls", {}),
                "is_local": False,
                "_source": source,
            }
            try:
                outcome = database.add_to_wishlist_detailed(
                    spotify_track_data=data,
                    failure_reason="Added from your library",
                    source_type="album",
                    source_info={"artist_name": release["artist_name"], "album_name": album_name,
                                 "album_type": album_type, "source": source, "source_page": "Library"},
                    profile_id=profile_id,
                    user_initiated=True,
                    quality_profile_id=quality_profile_id,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("bulk wanted: %s / %s failed: %s", album_name, name, exc)
                continue
            status = (outcome or {}).get("status")
            if status == "created":
                created += 1
            elif status == "rejected" and (outcome or {}).get("reason") == "request_limit":
                refused = True
                break
            else:
                covered += 1
        if created:
            record(release, "added", created)
        elif refused:
            record(release, "refused", message="Past this profile's request limit")
        elif covered:
            record(release, "already_wanted")
        else:
            record(release, "failed", message="None of its tracks could be added")
    logger.info("bulk wanted for profile %s: %s", profile_id,
                {k: v for k, v in counts.items()})
    return {**counts, "results": results}


__all__ = ["FETCH_THREADS", "add_releases"]
