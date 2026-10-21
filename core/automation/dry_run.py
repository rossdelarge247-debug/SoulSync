"""Preview a run: what an automation would do right now, without doing it.

``POST /api/automations/<id>/preview`` (and ``/api/automations/preview`` for
an automation that isn't saved yet) answer from here. Only actions whose
outcome can be worked out from what SoulSync already stores get a preview:
the simulators below read the same rows and call the same selection helpers
the real handler uses, and stop before anything that searches, downloads,
moves, deletes or contacts another service. Everything else says plainly
that a preview isn't available for it, and why.

An automation is one action (the DO block) followed by its follow-up steps
(``then_actions``: notifications, signals, scripts). A preview never runs a
follow-up step; each one is listed with a sentence saying so.

The result is plain data (see ``preview_steps``); recording it in the run
history is ``record_preview``.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)

#: Status of a recorded preview in ``automation_run_history``.
PREVIEW_STATUS = "preview"
#: Previews kept per automation, so they never push real runs out of the
#: history's 100-row cap.
MAX_PREVIEWS_KEPT = 20
#: Rows in a preview's sample.
SAMPLE_SIZE = 5

#: Actions that move or delete files: they run through the preview-then-confirm
#: flow, never straight from a preview. Same set as the engine's.
FILE_ACTIONS = frozenset({
    "run_duplicate_cleaner", "clear_quarantine", "library_cleanup",
    "full_cleanup", "video_full_cleanup", "deep_scan_library",
})

_NOTHING_CHANGED = "Nothing was searched, downloaded, moved or changed."


@dataclass
class DryRunContext:
    """What a simulator may read. Nothing here can write."""

    database: Any
    config_manager: Any = None
    docker_resolve_path: Callable[[str], str] = field(default=lambda p: p)
    #: The profile the run acts as (the automation's owner).
    profile_id: int = 1
    #: Whether the metadata source the followed-artist check needs is ready
    #: (the Spotify client, which falls back to iTunes or Deezer when it isn't
    #: signed in; the check stops only when there's no client at all).
    spotify_ready: Optional[Callable[[], bool]] = None
    now: Optional[datetime] = None

    def utcnow(self) -> datetime:
        return self.now or datetime.now(timezone.utc)

    def config(self, key: str, default: Any = None) -> Any:
        if self.config_manager is None:
            return default
        try:
            return self.config_manager.get(key, default)
        except Exception:  # noqa: BLE001 - unreadable config reads as the default
            return default


class PreviewUnavailable(Exception):
    """A simulator found it can't say what a run would do (a sentence why)."""


# ── shared helpers ────────────────────────────────────────────────────────────

def _plural(n: int, one: str, many: Optional[str] = None) -> str:
    return f"{n:,} {one if n == 1 else (many or one + 's')}"


def _count(key: str, label: str, value: int, unit: Optional[str] = None) -> Dict[str, Any]:
    out: Dict[str, Any] = {"key": key, "label": label, "value": int(value)}
    if unit:
        out["unit"] = unit
    return out


def _bytes_words(n: int) -> str:
    value = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if value < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" or value >= 100 else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


def _flag(config: Dict[str, Any], key: str, default: bool = True) -> bool:
    """A checkbox from an action config; absent means the block's default."""
    value = config.get(key)
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() not in ("0", "false", "no", "off", "")
    return bool(value)


def _result(summary: str, counts: List[Dict[str, Any]], sample: List[Dict[str, str]],
            sample_total: int, sample_noun: str) -> Dict[str, Any]:
    return {
        "available": True,
        "summary": summary,
        "counts": counts[:3],
        "sample": sample[:SAMPLE_SIZE],
        "sample_total": int(sample_total),
        "sample_noun": sample_noun,
    }


# ── process_wishlist: "Search for what's due on Wanted" ───────────────────────

def _wishlist_rows(ctx: DryRunContext) -> List[Dict[str, Any]]:
    """Every profile's Wanted tracks the scheduler may download, as the
    processor reads them (a profile without download rights only contributes
    the rows an admin approved). Read only."""
    from core.permissions import profile_can_download
    from core.wishlist.service import get_wishlist_service

    service = get_wishlist_service()
    rows: List[Dict[str, Any]] = []
    for profile in ctx.database.get_all_profiles():
        if profile_can_download(profile):
            tracks = service.get_wishlist_tracks_for_download(profile_id=profile["id"])
        else:
            tracks = service.get_wishlist_tracks_for_download(profile_id=profile["id"], approved_only=True)
        for track in tracks:
            track["profile_id"] = profile["id"]
            rows.append(track)
    return rows


def _wishlist_cycle(ctx: DryRunContext) -> str:
    from core.wishlist.state import get_wishlist_cycle
    return get_wishlist_cycle(lambda: ctx.database)


def _track_line(track: Dict[str, Any]) -> Dict[str, str]:
    artists = track.get("artists") or []
    artist = track.get("artist_name") or (artists[0] if artists and isinstance(artists[0], str) else "")
    album = track.get("album_name")
    if not album and isinstance(track.get("album"), dict):
        album = track["album"].get("name")
    tries = int(track.get("retry_count") or 0)
    detail = [part for part in (artist, album) if part]
    detail.append("not tried yet" if tries == 0 else _plural(tries, "try", "tries"))
    return {"title": str(track.get("track_name") or track.get("name") or "Unknown track"),
            "detail": " · ".join(detail)}


def preview_process_wishlist(ctx: DryRunContext, config: Dict[str, Any]) -> Dict[str, Any]:
    """The tracks the next Wanted search would pick, by the processor's own
    rules: released tracks, due for another try under the retry profile, in
    this run's turn (albums and singles take turns)."""
    from core.metadata.release_dates import split_released_unreleased
    from core.wishlist.retry_backoff import get_active_retry_profile, split_due_for_retry
    from core.wishlist.selection import filter_wishlist_tracks_by_category, sanitize_and_dedupe_wishlist_tracks

    tracks, _dupes = sanitize_and_dedupe_wishlist_tracks(_wishlist_rows(ctx))
    if not tracks:
        return _result("Wanted is empty, so a run now would stop straight away. " + _NOTHING_CHANGED,
                       [_count("would_search", "Would search", 0)], [], 0, "track")
    released, unreleased = split_released_unreleased(tracks)
    profile = get_active_retry_profile(ctx.database)
    due, cooling = split_due_for_retry(released, ctx.utcnow().replace(tzinfo=None), profile=profile)
    cycle = _wishlist_cycle(ctx)
    picked, _ = filter_wishlist_tracks_by_category(due, cycle)
    other = "singles" if cycle == "albums" else "albums"
    if not picked:
        others, _ = filter_wishlist_tracks_by_category(due, other)
        summary = (f"It's the turn of {cycle}, and none are due, so a run now would hand the next turn to "
                   f"{other} ({_plural(len(others), 'track')} due) and stop. ")
    else:
        summary = f"A run now would search for {_plural(len(picked), 'track')} on Wanted (this turn is {cycle}). "
    waiting = []
    if cooling:
        waiting.append(f"{_plural(len(cooling), 'track')} wait for their next try")
    if unreleased:
        waiting.append(f"{_plural(len(unreleased), 'track')} aren't out yet" if len(unreleased) != 1
                       else "1 track isn't out yet")
    if waiting:
        joined = " and ".join(waiting)
        summary += joined[:1].upper() + joined[1:] + ". "
    summary += _NOTHING_CHANGED
    counts = [_count("would_search", "Would search", len(picked)),
              _count("waiting", "Waiting to retry", len(cooling)),
              _count("unreleased", "Not out yet", len(unreleased))]
    return _result(summary, counts, [_track_line(t) for t in picked[:SAMPLE_SIZE]], len(picked), "track")


# ── scan_watchlist: "Check followed artists for new releases" ────────────────

def _followed_artists(ctx: DryRunContext) -> List[Any]:
    artists: List[Any] = []
    for profile in ctx.database.get_all_profiles():
        artists.extend(ctx.database.get_watchlist_artists(profile_id=profile["id"]))
    return artists


def _attr(obj: Any, key: str) -> Any:
    return obj.get(key) if isinstance(obj, dict) else getattr(obj, key, None)


def _checked_words(value: Any, now: datetime) -> str:
    if not value:
        return "never checked"
    try:
        stamp = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return "checked before"
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    days = int((now - stamp).total_seconds() // 86400)
    if days <= 0:
        return "checked today"
    return "checked yesterday" if days == 1 else f"checked {days} days ago"


def preview_scan_watchlist(ctx: DryRunContext, config: Dict[str, Any]) -> Dict[str, Any]:
    """Who a scheduled check would look at: every followed artist on every
    profile. It can't say what's new without asking the metadata source."""
    artists = _followed_artists(ctx)
    now = ctx.utcnow()
    if ctx.spotify_ready is not None and artists:
        try:
            ready = bool(ctx.spotify_ready())
        except Exception:  # noqa: BLE001 - unknown reads as ready; the run will say
            ready = True
        if not ready:
            raise PreviewUnavailable(
                "SoulSync's metadata source isn't ready, and the followed-artist check needs it, so a run "
                "now would stop before checking anyone. Check Settings → Connections.")
    never = sum(1 for a in artists if not _attr(a, "last_scan_timestamp"))
    summary = (f"A run now would check {_plural(len(artists), 'followed artist')} for new releases and add what "
               f"it finds to Wanted. What's new is only known by asking the metadata source, so nothing was "
               f"asked. " + _NOTHING_CHANGED) if artists else (
               "You don't follow any artists yet, so a run now would stop straight away. " + _NOTHING_CHANGED)
    sample = [{"title": str(_attr(a, "artist_name") or "Unknown artist"),
               "detail": _checked_words(_attr(a, "last_scan_timestamp"), now)} for a in artists[:SAMPLE_SIZE]]
    counts = [_count("would_check", "Would check", len(artists)),
              _count("never_checked", "Never checked", never)]
    return _result(summary, counts, sample, len(artists), "artist")


# ── mirrored playlists: which playlists a run would work on ──────────────────

_PLAYLIST_VERBS = {
    "refresh_mirrored": ("refresh", "from their source"),
    "sync_playlist": ("sync", "to your media server"),
    "discover_playlist": ("identify the tracks in", ""),
    "playlist_pipeline": ("refresh, identify, sync and download what's missing for", ""),
}


def _mirrored_targets(ctx: DryRunContext, action_type: str, config: Dict[str, Any]) -> List[Dict[str, Any]]:
    from core.playlists.user_playlists import has_upstream, pipeline_runs

    if _flag(config, "all", default=False):
        playlists = list(ctx.database.get_mirrored_playlists(int(ctx.profile_id)) or [])
    elif config.get("playlist_id") not in (None, ""):
        try:
            playlist = ctx.database.get_mirrored_playlist(int(config["playlist_id"]))
        except (TypeError, ValueError):
            playlist = None
        playlists = [playlist] if playlist else []
    else:
        raise PreviewUnavailable("This step has no playlist chosen, so a run now would stop with an error.")
    if action_type == "refresh_mirrored":
        playlists = [p for p in playlists if has_upstream(p)]
    elif action_type == "playlist_pipeline":
        playlists = [p for p in playlists if pipeline_runs(p)]
    return playlists


def preview_mirrored(ctx: DryRunContext, config: Dict[str, Any], action_type: str) -> Dict[str, Any]:
    playlists = _mirrored_targets(ctx, action_type, config)
    verb, where = _PLAYLIST_VERBS[action_type]
    tracks = sum(int(p.get("track_count") or 0) for p in playlists)
    if playlists:
        summary = (f"A run now would {verb} {_plural(len(playlists), 'mirrored playlist')}"
                   f"{' ' + where if where else ''} ({_plural(tracks, 'track')} today). What changed at the "
                   f"source is only known by fetching it, so nothing was fetched. " + _NOTHING_CHANGED)
    else:
        summary = "There's no mirrored playlist for this step to work on, so a run now would do nothing. " \
                  + _NOTHING_CHANGED
    sample = [{"title": str(p.get("name") or "Untitled playlist"),
               "detail": " · ".join(part for part in (
                   str(p.get("source") or "").replace("_", " ").title(),
                   _plural(int(p.get("track_count") or 0), "track")) if part)}
              for p in playlists[:SAMPLE_SIZE]]
    counts = [_count("playlists", "Playlists", len(playlists)), _count("tracks", "Tracks", tracks)]
    return _result(summary, counts, sample, len(playlists), "playlist")


# ── file steps: what they would delete, without deleting ─────────────────────

def _cleanup_paths(ctx: DryRunContext) -> tuple:
    download = ctx.docker_resolve_path(ctx.config("soulseek.download_path", "./downloads"))
    transfer = ctx.docker_resolve_path(ctx.config("soulseek.transfer_path", "./Transfer"))
    try:
        keep_days = float(ctx.config("library.deleted_keep_days", 0) or 0)
    except (TypeError, ValueError):
        keep_days = 0.0
    return download, transfer, keep_days


def _file_line(item: Dict[str, Any]) -> Dict[str, str]:
    import os
    path = str(item.get("path") or item.get("name") or "")
    name = os.path.basename(path.rstrip("/\\")) or path or "Unknown file"
    detail = [part for part in (str(item.get("reason") or ""), _bytes_words(int(item.get("size") or 0))
                                if item.get("size") else "") if part]
    return {"title": name, "detail": " · ".join(detail)}


def preview_file_cleanup(ctx: DryRunContext, config: Dict[str, Any], *, quarantine: bool,
                         recycle_bin: bool) -> Dict[str, Any]:
    from core.library.cleanup import preview_library_cleanup

    download, transfer, keep_days = _cleanup_paths(ctx)
    plan = preview_library_cleanup(download_path=download, transfer_folder=transfer, keep_days=keep_days,
                                   clear_quarantine=quarantine, empty_recycle_bin=recycle_bin)
    q = [i for i in plan["quarantine"] if i.get("kind") != "info"]
    r = list(plan["recycle_bin"])
    items = q + r
    size = sum(int(i.get("size") or 0) for i in items)
    parts = []
    if quarantine:
        parts.append(f"{_plural(len(q), 'quarantined file')}")
    if recycle_bin:
        parts.append(f"{_plural(len(r), 'file')} from the recycle bin")
    if items:
        summary = (f"A run would delete {' and '.join(parts)} for good ({_bytes_words(size)}). When you run it, "
                   f"you'll see this list again and confirm before anything is deleted. " + _NOTHING_CHANGED)
    else:
        summary = "There's nothing for this step to delete right now. " + _NOTHING_CHANGED
    counts = []
    if quarantine:
        counts.append(_count("quarantine", "Quarantined files", len(q)))
    if recycle_bin:
        counts.append(_count("recycle_bin", "Recycle bin files", len(r)))
    counts.append(_count("size", "Size", size, unit="bytes"))
    return _result(summary, counts, [_file_line(i) for i in items[:SAMPLE_SIZE]], len(items), "file")


# ── the registry ──────────────────────────────────────────────────────────────

Simulator = Callable[[DryRunContext, Dict[str, Any]], Dict[str, Any]]

SIMULATORS: Dict[str, Simulator] = {
    "process_wishlist": preview_process_wishlist,
    "scan_watchlist": preview_scan_watchlist,
    "refresh_mirrored": lambda ctx, cfg: preview_mirrored(ctx, cfg, "refresh_mirrored"),
    "sync_playlist": lambda ctx, cfg: preview_mirrored(ctx, cfg, "sync_playlist"),
    "discover_playlist": lambda ctx, cfg: preview_mirrored(ctx, cfg, "discover_playlist"),
    "playlist_pipeline": lambda ctx, cfg: preview_mirrored(ctx, cfg, "playlist_pipeline"),
    "clear_quarantine": lambda ctx, cfg: preview_file_cleanup(ctx, cfg, quarantine=True, recycle_bin=False),
    "library_cleanup": lambda ctx, cfg: preview_file_cleanup(
        ctx, cfg, quarantine=_flag(cfg, "quarantine"), recycle_bin=_flag(cfg, "recycle_bin")),
}

#: Why a step can't be previewed, where there's something specific to say.
UNAVAILABLE_REASONS: Dict[str, str] = {
    "notify_only": "This automation only runs its follow-up steps, and a preview never sends anything.",
    "scan_library": "It asks your media server to rescan, which can't be tried without doing it.",
    "start_database_update": "It reads your media server's library, which can't be tried without doing it.",
    "start_database_update_hourly": "It reads your media server's library, which can't be tried without doing it.",
    "deep_scan_library": ("Deep Scan reads your whole library to find what it would move. Run now shows that "
                          "list before anything moves."),
    "run_duplicate_cleaner": ("The duplicate cleaner's preview is a full scan of your files. Run now starts it "
                              "on Maintenance, where you confirm before anything moves."),
    "full_cleanup": ("Most of Full Cleanup works on the live download queue and folders, which can't be tried "
                     "without doing it. Its quarantine step is previewed when you run it."),
    "run_script": "A script can do anything, so SoulSync can't tell what it would do without running it.",
    "search_and_download": "It searches your download source, which can't be tried without doing it.",
    "backup_database": "It writes a backup file, which can't be tried without doing it.",
    "scan_watchlist_podcasts": "It asks each podcast's feed for new episodes, which can't be tried without doing it.",
    "personalized_pipeline": "It regenerates and syncs playlists, which can't be tried without doing it.",
}

_GENERIC_UNAVAILABLE = ("SoulSync can't work out what this step would do without doing it, so it can't be "
                        "previewed.")

_THEN_NOTES = {
    "fire_signal": "A preview doesn't fire signals, so automations listening for it don't wake.",
    "run_script": "A preview doesn't run scripts.",
}
_THEN_NOTE_DEFAULT = "A preview doesn't send notifications."


def is_previewable(action_type: Optional[str]) -> bool:
    return (action_type or "") in SIMULATORS


def unavailable_reason(action_type: Optional[str]) -> str:
    return UNAVAILABLE_REASONS.get(action_type or "", _GENERIC_UNAVAILABLE)


def _then_steps(then_actions: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    steps = []
    for index, item in enumerate(then_actions or []):
        kind = str((item or {}).get("type") or "")
        steps.append({"position": index + 2, "kind": "then", "type": kind, "previewed": False,
                      "note": _THEN_NOTES.get(kind, _THEN_NOTE_DEFAULT)})
    return steps


def preview_steps(ctx: DryRunContext, *, action_type: str, action_config: Optional[Dict[str, Any]] = None,
                  then_actions: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """What a run would do right now.

    Returns ``{"available", "action_type", "files", "summary", "counts",
    "sample", "sample_total", "sample_noun", "reason", "steps"}``. With
    ``available`` false, ``reason`` says why and the counts are empty. Never
    raises for a simulator failure; that comes back as ``error``.
    """
    action_type = str(action_type or "")
    config = dict(action_config or {})
    out: Dict[str, Any] = {
        "action_type": action_type,
        "files": action_type in FILE_ACTIONS,
        "steps": [{"position": 1, "kind": "action", "type": action_type,
                   "previewed": is_previewable(action_type), "note": None}] + _then_steps(then_actions or []),
    }
    simulator = SIMULATORS.get(action_type)
    if simulator is None:
        out.update(available=False, reason=unavailable_reason(action_type))
        out["steps"][0]["note"] = out["reason"]
        return out
    try:
        out.update(simulator(ctx, config))
    except PreviewUnavailable as exc:
        out.update(available=False, reason=str(exc))
        out["steps"][0].update(previewed=False, note=str(exc))
    return out


# ── recording ─────────────────────────────────────────────────────────────────

def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def preview_run_summary(result: Dict[str, Any]) -> str:
    """The one line a recorded preview shows in the run history:
    "Would search 41 · nothing changed"."""
    counts = [c for c in result.get("counts") or [] if c.get("unit") != "bytes"]
    if counts:
        first = counts[0]
        return f"{first['label']} {int(first['value']):,} · nothing changed"
    return "Nothing to do · nothing changed"


def record_preview(database, automation_id: int, result: Dict[str, Any], *, started_at: float,
                   finished_at: float) -> Optional[int]:
    """Store a preview as a run tagged Preview, and keep at most
    ``MAX_PREVIEWS_KEPT`` of them for the automation. Returns the run id."""
    kept = {k: result.get(k) for k in ("counts", "sample_total", "sample_noun", "action_type")}
    kept["status"] = PREVIEW_STATUS
    log = [{"type": "info", "text": result.get("summary") or ""}]
    log += [{"type": "skip", "text": step["note"]} for step in result.get("steps") or []
            if step.get("kind") == "then" and step.get("note")]
    ok = database.insert_automation_run_history(
        automation_id=automation_id, started_at=_iso(started_at), finished_at=_iso(finished_at),
        duration_seconds=round(max(0.0, finished_at - started_at), 3), status=PREVIEW_STATUS,
        summary=preview_run_summary(result), result_json=json.dumps(kept), log_lines=json.dumps(log))
    if not ok:
        return None
    run_id = None
    try:
        with database._get_connection() as conn:
            cursor = conn.cursor()
            row = cursor.execute(
                "SELECT id FROM automation_run_history WHERE automation_id = ? AND status = ? "
                "ORDER BY id DESC LIMIT 1", (automation_id, PREVIEW_STATUS)).fetchone()
            run_id = int(row[0]) if row else None
            cursor.execute(
                "DELETE FROM automation_run_history WHERE automation_id = ? AND status = ? AND id NOT IN ("
                "SELECT id FROM automation_run_history WHERE automation_id = ? AND status = ? "
                "ORDER BY id DESC LIMIT ?)",
                (automation_id, PREVIEW_STATUS, automation_id, PREVIEW_STATUS, MAX_PREVIEWS_KEPT))
            conn.commit()
    except Exception as exc:  # noqa: BLE001 - the preview itself was recorded
        logger.debug("preview retention for automation %s: %s", automation_id, exc)
    return run_id


def timed_preview(ctx: DryRunContext, **kwargs) -> tuple:
    """preview_steps plus when it ran: ``(result, started_at, finished_at)``."""
    started = time.time()
    result = preview_steps(ctx, **kwargs)
    return result, started, time.time()
