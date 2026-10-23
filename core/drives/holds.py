"""What waits while music is copied to another drive, or while a drive is away.

While a move copies (and until its switch is done), and while the library's
or downloads' drive isn't connected, the things that write to the music
folders wait: new downloads, Wanted's searches, auto-import, the
automations whose action moves or deletes files, Maintenance's jobs and
fixes, the reorganize queue, and tag writes and reorganizes asked for from
the library pages (:func:`refuse_during_move` answers those routes). Each
asks here.

The hold lives in memory: a restart mid-copy marks the move stopped (its
"SYNCHRO.S restarted mid-copy" failure) and everything starts again, which is
what "Your music is untouched" needs.
"""

from __future__ import annotations

import functools
import threading
from typing import Any, Callable, Dict, List, Optional

_LOCK = threading.Lock()
_HOLD: Dict[str, object] = {"move_id": None, "drive": ""}

#: automation actions that download, import, move, retag or delete library files
MOVES_FILES = frozenset({
    "process_wishlist", "search_and_download", "complete_incomplete_albums", "apply_quality_upgrades",
    "duplicate_cleaner", "library_cleanup", "run_repair", "deep_scan_library", "clean_completed_downloads",
    "download_cleanup", "sync_playlist", "refresh_mirrored", "playlist_pipeline", "personalized_pipeline",
    "discover_playlist", "sync_downloaded_playlists", "scan_watchlist", "scan_watchlist_labels",
    "start_database_update", "start_database_update_hourly", "scan_library", "seeding_sweep",
})

HOLD_WORDS = "your music is being copied to another drive"
MOVE_REFUSAL = ("Your music is being copied to another drive, so its files can't change right now. "
                "Try again once the move is done.")
AWAY_WORDS = "your library's drive isn't connected"


def hold(move_id: int, drive: str = "") -> None:
    with _LOCK:
        _HOLD["move_id"] = int(move_id)
        _HOLD["drive"] = drive or ""


def release(move_id: Optional[int] = None) -> None:
    with _LOCK:
        if move_id is None or _HOLD["move_id"] == move_id:
            _HOLD["move_id"] = None
            _HOLD["drive"] = ""


def held_by() -> Optional[int]:
    with _LOCK:
        value = _HOLD["move_id"]
    return int(value) if value is not None else None


def _away() -> List[str]:
    try:
        from core.drives.markers import away_roles
        return [r for r in away_roles() if r in ("library", "downloads")]
    except Exception:  # noqa: BLE001
        return []


def writes_held() -> Optional[str]:
    """Why writes to the music folders wait right now, or None."""
    if held_by() is not None:
        return HOLD_WORDS
    away = _away()
    if "library" in away:
        return AWAY_WORDS
    if "downloads" in away:
        return "your downloads drive isn't connected"
    return None


def download_refusal() -> Optional[str]:
    """The sentence a refused download carries, or None."""
    why = writes_held()
    if why is None:
        return None
    return f"Download waits: {why}. It starts again by itself."


def move_in_progress() -> Optional[str]:
    """The sentence for a change to the music's files asked for while a move
    copies or switches, or None."""
    return MOVE_REFUSAL if held_by() is not None else None


def refuse_during_move(fn: Callable[..., Any]) -> Callable[..., Any]:
    """A Flask route that changes files in the library answers 409 (with
    ``code: drive_move``) while a move copies or switches."""

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        why = move_in_progress()
        if why is not None:
            from flask import jsonify
            return jsonify({"success": False, "error": why, "code": "drive_move"}), 409
        return fn(*args, **kwargs)

    return wrapper


def automation_hold_reason(action_type: Optional[str]) -> Optional[str]:
    """Why an automation with this action waits, or None."""
    if not action_type or action_type not in MOVES_FILES:
        return None
    return writes_held()


__all__ = ["AWAY_WORDS", "HOLD_WORDS", "MOVES_FILES", "MOVE_REFUSAL", "automation_hold_reason", "download_refusal",
           "held_by", "hold", "move_in_progress", "refuse_during_move", "release", "writes_held"]
