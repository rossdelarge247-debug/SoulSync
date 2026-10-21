"""The four targets on Home, in a fixed order: Wanted, Mirrored playlists,
Followed artists, Quality (``GET /api/targets/summary``).

Every number comes from tables that already exist; each target splits its
``items`` into ``have`` + ``in_progress`` + ``not_found_yet``:

wanted
    Tracks on the profile's Wanted list (wishlist_tracks) plus tracks found
    from it in the last ``FOUND_WINDOW_DAYS`` (wishlist_removals: a row is
    removed, and audited, when its download lands or the track turns out to be
    owned). ``in_progress``: still on the every-cycle or short retry cadence;
    ``not_found_yet``: tried enough to reach the slowest retry cadence of the
    active retry profile (4+ tries with the standard one).
mirrored
    Tracks across the profile's mirrored playlists, from the same per-playlist
    counts the Auto-Sync page uses: ``have`` in the library, ``in_progress`` on
    Wanted, ``not_found_yet`` neither (not matched, or not queued).
followed
    New-release tracks from followed artists: ``in_progress`` and
    ``not_found_yet`` are Wanted rows the watchlist scan added (split as for
    Wanted); ``have`` is downloads credited to one of the profile's followed
    artists in the last ``FOUND_WINDOW_DAYS``.
quality
    Library tracks in the profile's library scope checked against the default
    quality profile's bar (core/quality/presets.py: extension + stored bitrate,
    no file reads). ``in_progress``: quality upgrades queued on Wanted;
    ``not_found_yet``: the rest of the tracks below the bar.

``any_set_up`` ignores quality, which always has a target. ``next_search_at``
is the soonest ``next_run`` of an enabled automation (one the profile can
see) that serves the target. ``status`` is ``cant_search`` when the cached
download-source check (the one /status keeps, never a new probe) last found
it unreachable within ``SOURCE_CHECK_MAX_AGE`` seconds.

Numbers are cached for ``CACHE_TTL_SECONDS`` per database, profile and
library scope; the status is worked out on every call.
"""

from __future__ import annotations

import threading
import time
from contextlib import closing
from typing import Any, Callable, Dict, Optional

from core.activity.common import automations_paused, next_scheduled, utc_text, visible_automations
from core.quality import presets as quality_presets
from utils.logging_config import get_logger

logger = get_logger("targets.summary")

ORDER = ("wanted", "mirrored", "followed", "quality")
FOUND_WINDOW_DAYS = 30
CACHE_TTL_SECONDS = 30
SOURCE_CHECK_MAX_AGE = 30 * 60

_ACTIONS = {
    "wanted": {"action_types": ("process_wishlist",)},
    "mirrored": {"action_types": ("playlist_pipeline", "refresh_mirrored", "sync_playlist")},
    "followed": {"action_types": ("scan_watchlist",)},
    "quality": {"action_types": ("apply_quality_upgrades", "start_quality_scan"),
                "job_ids": ("quality_upgrade", "quality_upgrade_scanner")},
}

_cache: Dict[tuple, tuple] = {}
_cache_lock = threading.Lock()


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def slow_retry_threshold(database) -> int:
    """Tries after which a Wanted track sits on the slowest retry cadence."""
    try:
        from core.wishlist.retry_backoff import get_active_retry_profile
        ladder = get_active_retry_profile(database).get("ladder") or {}
        return max(int(k) for k in ladder) + 1 if ladder else 2
    except Exception:  # noqa: BLE001 - the standard ladder's answer
        return 4


def _wanted(conn, pid: int, slow: int, found_since: str) -> Dict[str, Any]:
    row = conn.execute(
        "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN COALESCE(retry_count, 0) >= ? THEN 1 ELSE 0 END), 0) AS slow "
        "FROM wishlist_tracks WHERE profile_id = ?", (slow, pid)).fetchone()
    found = conn.execute(
        "SELECT COUNT(DISTINCT spotify_track_id) FROM wishlist_removals WHERE removed_at >= ? "
        "AND (profile_ids IS NULL OR EXISTS (SELECT 1 FROM json_each(profile_ids) WHERE value = ?))",
        (found_since, pid)).fetchone()[0]
    outstanding, stuck = int(row["n"]), int(row["slow"])
    return {"items": outstanding + found, "have": found, "in_progress": outstanding - stuck,
            "not_found_yet": stuck, "set_up": bool(outstanding or found), "unit": "tracks",
            "found_window_days": FOUND_WINDOW_DAYS}


def _mirrored(database, pid: int) -> Dict[str, Any]:
    per = database.get_all_mirrored_playlist_status_counts(profile_id=pid) or {}
    total = sum(int(c.get("total") or 0) for c in per.values())
    have = sum(int(c.get("in_library") or 0) for c in per.values())
    wanted = sum(int(c.get("wishlisted") or 0) for c in per.values())
    wanted = min(wanted, max(0, total - have))
    return {"items": total, "have": have, "in_progress": wanted,
            "not_found_yet": max(0, total - have - wanted), "set_up": bool(per),
            "playlists": len(per), "unit": "tracks"}


def _followed(conn, pid: int, slow: int, found_since: str) -> Dict[str, Any]:
    artists = conn.execute("SELECT COUNT(*) FROM watchlist_artists WHERE profile_id = ?", (pid,)).fetchone()[0]
    row = conn.execute(
        "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN COALESCE(retry_count, 0) >= ? THEN 1 ELSE 0 END), 0) AS slow "
        "FROM wishlist_tracks WHERE profile_id = ? AND source_type = 'watchlist'", (slow, pid)).fetchone()
    found = conn.execute(
        "SELECT COUNT(*) FROM library_history WHERE origin = 'watchlist' AND created_at >= ? "
        "AND event_type = 'download' "
        "AND origin_context IN (SELECT artist_name FROM watchlist_artists WHERE profile_id = ?)",
        (found_since, pid)).fetchone()[0]
    outstanding, stuck = int(row["n"]), int(row["slow"])
    return {"items": outstanding + found, "have": found, "in_progress": outstanding - stuck,
            "not_found_yet": stuck, "set_up": bool(artists), "artists": int(artists), "unit": "tracks",
            "found_window_days": FOUND_WINDOW_DAYS}


def _quality(database, conn, pid: int) -> Dict[str, Any]:
    target = quality_presets.current_target(database)
    bar = target["targets"]
    groups = quality_presets.library_quality_groups(database)
    meeting, checked = quality_presets.count(groups, lambda aq: quality_presets.meets_targets(aq, bar))
    upgrading = conn.execute(
        "SELECT COUNT(*) FROM wishlist_tracks WHERE profile_id = ? AND source_type = 'repair' "
        "AND json_valid(source_info) AND json_extract(source_info, '$.job') = 'quality_upgrade'",
        (pid,)).fetchone()[0]
    below = max(0, checked - meeting)
    upgrading = min(int(upgrading), below)
    return {"items": checked, "have": meeting, "in_progress": upgrading, "not_found_yet": below - upgrading,
            "set_up": bool(bar), "unit": "tracks", "name": target["name"], "preset": target["preset"],
            "quality_profile_id": target["quality_profile_id"],
            "quality_profile_name": target["quality_profile_name"],
            "tracks_checked": checked, "meeting_target": meeting}


def _numbers(database, pid: int, now: float) -> Dict[str, Dict[str, Any]]:
    try:
        from core.library_scope import current_library_scope
        scope = current_library_scope()
    except Exception:  # noqa: BLE001 - scope only keys the cache
        scope = None
    key = (str(getattr(database, "database_path", "")), int(pid), str(scope))
    mono = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and mono - hit[0] < CACHE_TTL_SECONDS:
            return hit[1]
    slow = slow_retry_threshold(database)
    found_since = utc_text(now - FOUND_WINDOW_DAYS * 86400)
    with closing(database._get_connection()) as conn:
        numbers = {
            "wanted": _wanted(conn, pid, slow, found_since),
            "mirrored": _mirrored(database, pid),
            "followed": _followed(conn, pid, slow, found_since),
            "quality": _quality(database, conn, pid),
        }
    with _cache_lock:
        _cache[key] = (mono, numbers)
    return numbers


def _source_label(mode: Optional[str]) -> str:
    if mode in (None, "", "soulseek", "hybrid"):
        return "Soulseek (slskd)"
    if mode in ("torrent", "usenet"):
        return "Your download client"
    return "Your download source"


def source_problem(source: Optional[Dict[str, Any]], now: float) -> Optional[Dict[str, Any]]:
    """The cached download-source check, when it says searching can't work."""
    if not source or source.get("connected") is not False:
        return None
    checked = source.get("checked_at")
    if not checked or now - float(checked) > SOURCE_CHECK_MAX_AGE:
        return None
    minutes = max(1, int((now - float(checked)) // 60))
    return {
        "reason_code": "download_source_unreachable",
        "reason": (f"{_source_label(source.get('source'))} didn't answer when SoulSync last checked, "
                   f"{minutes} minute{'s' if minutes != 1 else ''} ago, so searches can't run."),
        "checked_at": int(float(checked)),
    }


def build_summary(database, profile_id: int, *, now: Optional[float] = None,
                  download_source: Optional[Callable[[], Optional[Dict[str, Any]]]] = None) -> Dict[str, Any]:
    now = time.time() if now is None else float(now)
    pid = int(profile_id)
    numbers = _numbers(database, pid, now)
    with closing(database._get_connection()) as conn:
        automations = visible_automations(conn, pid)
        paused = automations_paused(conn)
    try:
        source = download_source() if download_source else None
    except Exception as exc:  # noqa: BLE001 - an unknown source state is not a problem state
        logger.debug("download source state unavailable: %s", exc)
        source = None
    problem = source_problem(source, now)

    targets = []
    for key in ORDER:
        target = {"key": key, **numbers[key]}
        nxt = None if paused else next_scheduled(automations, **_ACTIONS[key])
        target["next_search_at"] = nxt["at"] if nxt else None
        target["next_search_automation"] = (
            {"id": nxt["automation_id"], "name": nxt["automation_name"]} if nxt else None)
        target["schedule_paused"] = paused
        if not target["set_up"]:
            target["status"] = "not_set_up"
        elif problem:
            target["status"] = "cant_search"
            target.update(problem)
        elif target["in_progress"] > 0:
            target["status"] = "searching"
        else:
            target["status"] = "ok"
        target.setdefault("reason", None)
        targets.append(target)

    return {
        "targets": targets,
        # quality always has a target (a default profile ships), so it doesn't
        # count: with none of the other three, Home shows its one setup panel
        "any_set_up": any(t["set_up"] for t in targets if t["key"] != "quality"),
        "download_source": {
            "reachable": None if not source or source.get("connected") is None else bool(source.get("connected")),
            "checked_at": int(float(source["checked_at"])) if source and source.get("checked_at") else None,
        },
        "generated_at": int(now),
    }


__all__ = ["ORDER", "FOUND_WINDOW_DAYS", "CACHE_TTL_SECONDS", "SOURCE_CHECK_MAX_AGE", "build_summary",
           "clear_cache", "slow_retry_threshold", "source_problem"]
