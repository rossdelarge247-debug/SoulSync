"""Decision logic for the SoulSync standalone Deep Scan's untracked → Staging move.

The standalone deep scan (``_run_soulsync_deep_scan`` in web_server) walks the
Transfer folder, diffs it against the ``soulsync`` rows in the DB, and relocates
every file it can't find a DB record for into Staging for auto-import. That's fine
when Transfer is a scratch/landing area — files arrive, get moved, imported, and
recorded, so a later scan only ever sees a few genuinely-new arrivals.

It is a DATA-LOSS trap when the DB is empty or out of sync with disk (a volume
swap, a DB reset, external tag edits) while Transfer holds the user's real library:
a path-only diff then flags the *entire* library as "untracked" and the scan
relocates all of it (issue #904). The same failure mode the orphan detector and the
media-server deep scan already guard against (``core.library.stale_guard``) — this
path just never used the guard.

This module is the pure, testable decision: given the Transfer file set, the DB's
known paths, and the user's "Transfer is my permanent library" preference, decide
WHICH files are untracked and WHETHER it's safe to relocate them. The web layer does
only the I/O (walk/move/delete) based on the returned plan.

Guards, in the order they are checked:

* ``transfer_permanent`` (hard) — the user marked Transfer as their permanent
  library ("import.transfer_is_permanent", on by default). Only the setting
  lifts it.
* ``desync`` (hard) — more than half of a >20-file folder is untracked: the
  DB↔disk mapping is broken, not a batch of new arrivals. Never overridable.
* ``empty_database`` (confirm) — the DB holds no SoulSync tracks at all, so
  every file looks untracked. #904's exact starting point; below the desync
  floor it still needs an explicit confirmation.
* ``large_move`` (confirm) — the move would relocate more than
  ``max_move_fraction`` (default 25%) of the folder in one run.

A "confirm" guard is lifted only by ``allow_large_move=True``, which the web
layer passes solely for a user who confirmed a preview that showed the warning.
"""

from __future__ import annotations

import logging
import os
import shutil
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

from core.library.stale_guard import (
    DEFAULT_MAX_ORPHAN_FRACTION,
    DEFAULT_MIN_ORPHANS,
    is_implausible_orphan_flood,
)

logger = logging.getLogger(__name__)

# The action-plan tool name for a confirmed untracked → Staging move.
DEEP_SCAN_TOOL = "deep_scan"

AUDIO_EXTENSIONS = {'.mp3', '.flac', '.ogg', '.opus', '.m4a', '.aac', '.wav', '.wma', '.aiff', '.aif', '.ape'}

# Block reason codes (web layer turns these into a user-facing warning).
BLOCK_NONE = ""
BLOCK_TRANSFER_PERMANENT = "transfer_permanent"
BLOCK_DESYNC = "desync"
BLOCK_EMPTY_DB = "empty_database"
BLOCK_LARGE_MOVE = "large_move"

# Hard blocks never move; confirmable ones move only with allow_large_move.
HARD_BLOCKS = frozenset({BLOCK_TRANSFER_PERMANENT, BLOCK_DESYNC})
CONFIRMABLE_BLOCKS = frozenset({BLOCK_EMPTY_DB, BLOCK_LARGE_MOVE})

# Ratio guard: refuse to relocate more than this share of the folder in one
# run without explicit confirmation. Below the absolute floor a handful of new
# files in a small folder is never second-guessed.
DEFAULT_MAX_MOVE_FRACTION = 0.25
DEFAULT_MIN_RATIO_GUARD = 10


def _norm(path: str) -> str:
    """Normalize a path for cross-platform comparison (Windows vs Unix separators)."""
    return str(path).replace("\\", "/")


def diff_untracked(transfer_files: Iterable[str], db_paths: Iterable[str]) -> Set[str]:
    """Files present in ``transfer_files`` but with no matching ``db_paths`` record.

    Comparison is separator-normalized, so a DB path stored with one separator style
    still matches the on-disk path. Pure — no I/O. Returns the original (un-normalized)
    transfer paths so the caller can act on the real filesystem entries.
    """
    db_norm = {_norm(p) for p in db_paths if p}
    return {f for f in transfer_files if _norm(f) not in db_norm}


def plan_standalone_deep_scan(
    transfer_files: Iterable[str],
    db_paths: Iterable[str],
    *,
    never_move: bool = False,
    min_untracked: int = DEFAULT_MIN_ORPHANS,
    max_fraction: float = DEFAULT_MAX_ORPHAN_FRACTION,
    max_move_fraction: float = DEFAULT_MAX_MOVE_FRACTION,
    min_ratio_guard: int = DEFAULT_MIN_RATIO_GUARD,
    allow_large_move: bool = False,
) -> dict:
    """Plan the untracked → Staging move for a standalone deep scan. Pure — no I/O.

    Returns a dict:
      * ``untracked`` (set[str]) — Transfer files with no DB record.
      * ``move_blocked`` (bool) — True when the untracked files must NOT be relocated.
      * ``block_reason`` (str) — one of the ``BLOCK_*`` codes, or "".
      * ``needs_confirmation`` (bool) — the block is a confirmable one
        (empty DB / large move): a confirmed preview with ``allow_large_move``
        would lift it. False for hard blocks and for unblocked plans.
      * ``total`` / ``db_count`` / ``untracked_fraction`` — the numbers behind it.

    ``move_blocked`` is only ever True when there ARE untracked files; an empty scan
    or a clean library returns ``move_blocked=False`` with no reason.
    """
    transfer_set = set(transfer_files)  # concrete (handles generators) + dedups
    db_list = [p for p in db_paths if p]
    untracked = diff_untracked(transfer_set, db_list)
    total = len(transfer_set)
    n_untracked = len(untracked)
    fraction = (n_untracked / total) if total else 0.0

    def _result(blocked: bool, reason: str) -> dict:
        return {
            "untracked": untracked,
            "move_blocked": blocked,
            "block_reason": reason,
            "needs_confirmation": blocked and reason in CONFIRMABLE_BLOCKS,
            "total": total,
            "db_count": len(db_list),
            "untracked_fraction": fraction,
        }

    if n_untracked == 0:
        return _result(False, BLOCK_NONE)

    if never_move:
        return _result(True, BLOCK_TRANSFER_PERMANENT)

    if is_implausible_orphan_flood(
        n_untracked, total, min_orphans=min_untracked, max_fraction=max_fraction
    ):
        return _result(True, BLOCK_DESYNC)

    if not db_list and not allow_large_move:
        return _result(True, BLOCK_EMPTY_DB)

    if (not allow_large_move and n_untracked > min_ratio_guard
            and n_untracked > total * max_move_fraction):
        return _result(True, BLOCK_LARGE_MOVE)

    return _result(False, BLOCK_NONE)


# ── I/O helpers for the web layer (kept here so they are testable) ──────────


def collect_transfer_audio(transfer_path: str, staging_path: Optional[str] = None) -> Set[str]:
    """Every audio file under ``transfer_path``, skipping SoulSync's own folders
    (the recycle bin and the atomic-publish staging tree) and the import
    Staging folder when it is nested inside Transfer. Without that skip the
    recycle bin's contents look "untracked" and a deep scan would carry
    deleted files back into Staging for re-import."""
    from core.repair_jobs.base import skip_deleted_quarantine

    staging_norm = os.path.normpath(os.path.abspath(staging_path)) if staging_path else None
    found: Set[str] = set()
    for root, dirs, files in os.walk(transfer_path):
        skip_deleted_quarantine(root, dirs, transfer_path)
        if staging_norm:
            dirs[:] = [d for d in dirs
                       if os.path.normpath(os.path.abspath(os.path.join(root, d))) != staging_norm]
        for filename in files:
            if os.path.splitext(filename)[1].lower() in AUDIO_EXTENSIONS:
                found.add(os.path.join(root, filename))
    return found


def staging_destination(file_path: str, transfer_path: str, staging_path: str) -> str:
    """Where a Transfer file lands in Staging (relative folder structure kept)."""
    return os.path.join(staging_path, os.path.relpath(file_path, transfer_path))


def build_move_items(untracked: Iterable[str], transfer_path: str, staging_path: str) -> List[Dict[str, Any]]:
    """One plan item per file the move would relocate, sorted by path."""
    items: List[Dict[str, Any]] = []
    for path in sorted(untracked):
        try:
            size = os.path.getsize(path)
        except OSError:
            size = 0
        items.append({
            "path": path,
            "dest": staging_destination(path, transfer_path, staging_path),
            "action": "move_to_staging",
            "reason": "no database record for this file",
            "size": size,
        })
    return items


def move_files_to_staging(paths: Iterable[str], transfer_path: str, staging_path: str) -> Tuple[int, List[Dict[str, str]]]:
    """Move each file into Staging, never overwriting a file already there.
    Returns ``(moved, errors)``."""
    moved = 0
    errors: List[Dict[str, str]] = []
    for file_path in paths:
        try:
            dest_path = staging_destination(file_path, transfer_path, staging_path)
            if os.path.exists(dest_path):
                errors.append({"path": file_path, "error": f"a file already exists at {dest_path}"})
                continue
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            shutil.move(file_path, dest_path)
            moved += 1
        except Exception as e:  # noqa: BLE001 - one bad file must not stop the rest
            logger.error("[SoulSync Deep Scan] Could not move %s: %s", os.path.basename(file_path), e)
            errors.append({"path": file_path, "error": str(e)})
    return moved, errors


def block_message(plan: Dict[str, Any]) -> str:
    """User-facing copy for a blocked move (activity feed / preview banner)."""
    n = len(plan.get("untracked") or ())
    total = plan.get("total") or 0
    pct = round(100 * n / max(1, total))
    reason = plan.get("block_reason")
    if reason == BLOCK_TRANSFER_PERMANENT:
        return (f"Deep scan: {n} file(s) in your Music Library aren't in the database, "
                f"but it's marked your permanent library — nothing was moved.")
    if reason == BLOCK_DESYNC:
        return (f"Deep scan STOPPED to protect your library: {n} of {total} files in your Music "
                f"Library ({pct}%) aren't in the database. That usually means the database is out "
                f"of sync with disk, not that you have {n} new files — so NOTHING was moved. "
                f"Re-sync/import before scanning, or enable 'Music Library is my permanent library'.")
    if reason == BLOCK_EMPTY_DB:
        return (f"Deep scan: the database has no tracks, so all {n} file(s) in your Music Library look "
                f"untracked. Nothing was moved. Preview the move and confirm it explicitly if these "
                f"really are new files.")
    if reason == BLOCK_LARGE_MOVE:
        return (f"Deep scan: moving {n} of {total} files ({pct}%) to Staging is more than this tool "
                f"moves in one run without confirmation. Nothing was moved. Preview the move and "
                f"confirm the large move explicitly.")
    return ""



__all__ = [
    "diff_untracked",
    "plan_standalone_deep_scan",
    "BLOCK_NONE",
    "BLOCK_TRANSFER_PERMANENT",
    "BLOCK_DESYNC",
    "BLOCK_EMPTY_DB",
    "BLOCK_LARGE_MOVE",
    "HARD_BLOCKS",
    "CONFIRMABLE_BLOCKS",
    "DEFAULT_MAX_MOVE_FRACTION",
    "DEFAULT_MIN_RATIO_GUARD",
    "DEEP_SCAN_TOOL",
    "collect_transfer_audio",
    "staging_destination",
    "build_move_items",
    "move_files_to_staging",
    "block_message",
]
