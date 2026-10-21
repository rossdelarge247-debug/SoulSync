"""Duplicate cleaner — finds same-folder, same-name files in several formats
and moves the lower-quality copies into the recycle bin.

Safe by default (#1210, "the duplicate cleaner deleted the only copy"):

* A plain run is a PREVIEW. It scans, records a plan (``core.library
  .action_plans``) listing every file it would move and which copy it keeps,
  and moves nothing. The plan id lands in the shared state for the UI.
* Files only move for a run started with that plan id (the user confirmed the
  preview) or with ``confirm=True`` (an automation the user explicitly set to
  act). A confirmed plan moves exactly the previewed files, never a re-scan.
* Before any copy moves, the copy being kept must exist, be non-empty and
  readable, and must not be the very same file. Otherwise that group is
  refused, reported, and left alone.
* Moved files go to the recycle bin (``<transfer>/.deleted``) with a manifest
  entry, so the Recycle Bin tab can restore them. Nothing here unlinks audio.

Module-level state and helpers are injected via init() because the duplicate
cleaner state dict, lock, automation engine, and docker_resolve_path helper
all live in web_server.py.
"""
from __future__ import annotations

import logging
import os
import shutil
from collections import defaultdict
from typing import Any, Callable, Dict, List, Optional

from core.settings import config_manager
from core.runtime_state import add_activity_item
from core.library.action_plans import PlanError, plan_store
from core.library.duplicate_keep import keeper_problem
from core.library.duplicate_rules import is_lossy_companion_pair, lossy_companion_exts
from core.repair_jobs.base import skip_deleted_quarantine
from database.music_database import get_database

logger = logging.getLogger(__name__)

TOOL = "duplicate_cleaner"

AUDIO_EXTENSIONS = {'.flac', '.mp3', '.m4a', '.aac', '.opus', '.ogg', '.wav', '.ape', '.wma',
                    '.alac', '.aiff', '.aif', '.dsf', '.dff'}

# Quality priority: FLAC > OPUS/OGG > M4A/AAC > MP3/WMA (lower wins)
FORMAT_PRIORITY = {
    '.flac': 1, '.ape': 1, '.wav': 1, '.alac': 1, '.aiff': 1, '.aif': 1, '.dsf': 1, '.dff': 1,  # Lossless
    '.opus': 2, '.ogg': 2,  # High quality lossy
    '.m4a': 3, '.aac': 3,   # Standard lossy
    '.mp3': 4, '.wma': 4    # Lower quality lossy
}

# Injected at runtime via init().
duplicate_cleaner_state = None
duplicate_cleaner_lock = None
docker_resolve_path = None
automation_engine = None


def init(state, lock, resolve_path_fn, engine):
    """Bind shared state/helpers from web_server."""
    global duplicate_cleaner_state, duplicate_cleaner_lock
    global docker_resolve_path, automation_engine
    duplicate_cleaner_state = state
    duplicate_cleaner_lock = lock
    docker_resolve_path = resolve_path_fn
    automation_engine = engine


# ── pure-ish halves: scan (no writes) and apply (moves) ─────────────────────


def _sort_key(version: Dict[str, Any]):
    return (FORMAT_PRIORITY.get(version['extension'], 999), -version['size'])


def scan_duplicates(transfer_folder: str, companion_exts, *,
                    on_progress: Optional[Callable[[int, int, str], None]] = None) -> Dict[str, Any]:
    """Walk ``transfer_folder`` and decide what a cleanup WOULD move. Reads only.

    Returns ``{'files_scanned', 'total_files', 'items'}``; each item is
    ``{'path', 'action': 'recycle', 'reason', 'keep', 'size', 'extension',
    'keep_extension', 'keep_size'}``.
    """
    total_files = 0
    for root, dirs, files in os.walk(transfer_folder):
        # SoulSync's own folders: the `deleted` quarantine and the
        # atomic-publish staging tree. Staging holds a half-downloaded
        # album whose tracks are ALSO about to exist in the library — the
        # textbook false duplicate, and this job moves files.
        skip_deleted_quarantine(root, dirs, transfer_folder)
        total_files += len(files)

    files_by_dir_and_name = defaultdict(lambda: defaultdict(list))
    files_scanned = 0
    for root, dirs, files in os.walk(transfer_folder):
        skip_deleted_quarantine(root, dirs, transfer_folder)
        for name in files:
            files_scanned += 1
            if on_progress:
                on_progress(files_scanned, total_files, name)
            stem, ext = os.path.splitext(name)
            ext = ext.lower()
            if ext not in AUDIO_EXTENSIONS:
                continue
            full_path = os.path.join(root, name)
            try:
                size = os.path.getsize(full_path)
            except OSError:
                continue
            files_by_dir_and_name[root][stem].append({'full_path': full_path, 'extension': ext, 'size': size})

    items: List[Dict[str, Any]] = []
    for _directory, by_name in files_by_dir_and_name.items():
        for _stem, versions in by_name.items():
            if len(versions) <= 1:
                continue
            ordered = sorted(versions, key=_sort_key)
            keep = ordered[0]
            # Configured lossy companions of the lossless winner are
            # intentional (the lossy-copy feature writes them); only the
            # remaining versions are actionable duplicates.
            for version in ordered[1:]:
                if is_lossy_companion_pair(keep['full_path'], version['full_path'], companion_exts):
                    continue
                items.append({
                    'path': version['full_path'],
                    'action': 'recycle',
                    'reason': (f"lower-quality duplicate of {os.path.basename(keep['full_path'])} "
                               f"({version['extension'].lstrip('.')} vs {keep['extension'].lstrip('.')})"
                               if version['extension'] != keep['extension'] else
                               f"duplicate of {os.path.basename(keep['full_path'])} (smaller file)"),
                    'keep': keep['full_path'],
                    'size': version['size'],
                    'extension': version['extension'],
                    'keep_extension': keep['extension'],
                    'keep_size': keep['size'],
                })
    return {'files_scanned': files_scanned, 'total_files': total_files, 'items': items}


def _same_file(a: str, b: str) -> bool:
    try:
        return os.path.samefile(a, b)
    except OSError:
        return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def _recycle_dest(deleted_folder: str, transfer_folder: str, path: str) -> str:
    try:
        rel = os.path.relpath(path, transfer_folder)
    except ValueError:
        rel = os.path.basename(path)
    if rel.startswith('..') or os.path.isabs(rel):
        rel = os.path.basename(path)
    dest = os.path.join(deleted_folder, rel)
    base, ext = os.path.splitext(dest)
    n = 1
    while os.path.exists(dest):   # never clobber an earlier deletion
        dest = f"{base}_{n}{ext}"
        n += 1
    return dest


def apply_duplicate_items(items: List[Dict[str, Any]], transfer_folder: str, deleted_folder: str, *,
                          on_moved: Optional[Callable[[int, int], None]] = None,
                          should_stop: Optional[Callable[[], bool]] = None) -> Dict[str, Any]:
    """Move the planned duplicates into the recycle bin, re-checking each one.

    Never removes the last copy: an item is refused when its keeper is gone,
    empty or unreadable, or when it IS the keeper. An item whose file vanished
    or changed size since the preview is skipped (what the user confirmed is
    no longer what is on disk).
    """
    from core.library.deleted_quarantine import record_deleted_entry

    moved = 0
    space_freed = 0
    refused: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    keeper_verdicts: Dict[str, Optional[str]] = {}

    for item in items:
        if should_stop and should_stop():
            break
        path = item.get('path')
        keep = item.get('keep')
        if not path or not keep:
            refused.append({'path': path, 'keep': keep, 'reason': 'no copy to keep was recorded'})
            continue
        if keep not in keeper_verdicts:
            keeper_verdicts[keep] = keeper_problem(keep)
        problem = keeper_verdicts[keep]
        if problem:
            refused.append({'path': path, 'keep': keep, 'reason': problem})
            logger.warning("[Duplicate Cleaner] Refusing to remove %s: %s (%s)", path, problem, keep)
            continue
        if not os.path.isfile(path):
            skipped.append({'path': path, 'reason': 'already gone'})
            continue
        if _same_file(path, keep):
            refused.append({'path': path, 'keep': keep, 'reason': 'it is the same file as the copy being kept'})
            continue
        try:
            size = os.path.getsize(path)
        except OSError as exc:
            errors.append({'path': path, 'error': str(exc)})
            continue
        planned_size = item.get('size')
        if planned_size is not None and int(planned_size) != size:
            skipped.append({'path': path, 'reason': 'changed since the preview'})
            continue
        dest = _recycle_dest(deleted_folder, transfer_folder, path)
        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.move(path, dest)
        except OSError as exc:
            logger.error("[Duplicate Cleaner] Error moving file %s: %s", path, exc)
            errors.append({'path': path, 'error': str(exc)})
            continue
        # remember where it came from so the deleted-files manager can
        # restore it and retention can age it
        record_deleted_entry(deleted_folder, dest, path, 'duplicate-cleaner')
        moved += 1
        space_freed += size
        logger.warning("[Duplicate Cleaner] Moved to recycle bin: %s (kept %s)",
                       os.path.basename(path), os.path.basename(keep))
        if on_moved:
            on_moved(moved, space_freed)

    return {'moved': moved, 'space_freed': space_freed, 'refused': refused,
            'skipped': skipped, 'errors': errors}


# ── the worker the button / automation submit ───────────────────────────────


def _set_state(**values):
    with duplicate_cleaner_lock:
        duplicate_cleaner_state.update(values)


def _still_running() -> bool:
    with duplicate_cleaner_lock:
        return duplicate_cleaner_state.get("status") == "running"


def _run_duplicate_cleaner(plan_id: Optional[str] = None, *, confirm: bool = False):
    """Scan the Transfer folder for duplicates.

    * no ``plan_id`` and not ``confirm``: preview only — records a plan,
      moves nothing (state ``mode='plan'``, ``plan_id`` and ``plan``).
    * ``plan_id``: moves exactly that previewed plan's files.
    * ``confirm=True``: scan and move in one go (automations the user set to
      act). The last-copy checks apply on every path.
    """
    try:
        _set_state(status="running", phase="Initializing scan...", progress=0, files_scanned=0,
                   total_files=0, duplicates_found=0, deleted=0, space_freed=0, error_message="",
                   mode="apply" if (plan_id or confirm) else "plan", plan_id=None, plan=None,
                   refused=0, refused_items=[], skipped=0, error_code="")

        transfer_folder = docker_resolve_path(config_manager.get('soulseek.transfer_path', './Transfer'))
        if not transfer_folder or not os.path.exists(transfer_folder):
            _set_state(status="error", phase="Output folder not configured or does not exist",
                       error_message="Please configure output folder in settings")
            logger.warning(f"[Duplicate Cleaner] Transfer folder not found: {transfer_folder}")
            return

        if plan_id:
            try:
                plan = plan_store.consume(plan_id, TOOL)
            except PlanError as exc:
                _set_state(status="error", phase=exc.message, error_message=exc.message, error_code=exc.code)
                return
            items = plan.items
            files_scanned = int(plan.meta.get('files_scanned') or 0)
            _set_state(files_scanned=files_scanned, total_files=files_scanned,
                       duplicates_found=len(items), phase=f"Moving {len(items)} previewed duplicate(s)...")
        else:
            logger.warning("[Duplicate Cleaner] Starting duplicate scan (%s)...",
                           "confirmed run" if confirm else "preview")

            def _progress(done, total, name):
                _set_state(files_scanned=done, total_files=total,
                           progress=(done / total) * 100 if total else 0, phase=f"Scanning: {name}")

            try:
                database = get_database()
            except Exception as e:  # noqa: BLE001 - filesystem scan stays usable
                logger.debug("lossy companion database unavailable: %s", e)
                database = None
            companion_exts = lossy_companion_exts(config_manager, database, logger=logger)
            scan = scan_duplicates(transfer_folder, companion_exts, on_progress=_progress)
            items = scan['items']
            files_scanned = scan['files_scanned']
            _set_state(files_scanned=files_scanned, total_files=scan['total_files'], duplicates_found=len(items))

            if not confirm:
                plan = plan_store.create(TOOL, items, meta={
                    'transfer_folder': transfer_folder, 'files_scanned': files_scanned})
                summary = plan.summary()
                would_mb = summary['total_bytes'] / (1024 * 1024)
                phase = (f"Preview ready: {len(items)} duplicate file(s) ({would_mb:.1f} MB) would move to "
                         f"the recycle bin. Nothing was moved." if items else
                         "Preview ready: no duplicates found.")
                _set_state(status="finished", progress=100, phase=phase, plan_id=plan.plan_id, plan=summary)
                add_activity_item("", "Duplicate Cleaner Preview",
                                  f"{len(items)} duplicate file(s) found, nothing moved", "Now")
                _emit(files_scanned, len(items), 0.0, mode='plan')
                return

        # Acting: the recycle bin (hidden '.deleted' so media servers don't
        # index it; migrates a legacy bare 'deleted' folder on the way through).
        from core.repair_jobs.base import deleted_quarantine_root
        deleted_folder = deleted_quarantine_root(transfer_folder)
        os.makedirs(deleted_folder, exist_ok=True)

        def _moved(count, freed):
            _set_state(deleted=count, space_freed=freed)

        result = apply_duplicate_items(items, transfer_folder, deleted_folder,
                                       on_moved=_moved, should_stop=lambda: not _still_running())
        refused = result['refused']
        stopped = not _still_running()
        space_mb = result['space_freed'] / (1024 * 1024)
        phase = "Scan stopped by user" if stopped else "Cleaning complete"
        if refused:
            phase += f" — {len(refused)} file(s) kept because the copy to keep could not be verified"
        _set_state(status="finished", progress=100, phase=phase, deleted=result['moved'],
                   space_freed=result['space_freed'], refused=len(refused), refused_items=refused[:20],
                   skipped=len(result['skipped']))

        logger.warning(f"[Duplicate Cleaner] Complete: {files_scanned} files scanned, "
                       f"{len(items)} duplicates, {result['moved']} moved to the recycle bin, "
                       f"{len(refused)} refused, {space_mb:.2f} MB freed")
        add_activity_item("", "Duplicate Cleaner Complete",
                          f"{result['moved']} files moved to the recycle bin, {space_mb:.1f} MB freed"
                          + (f", {len(refused)} kept (copy to keep unverified)" if refused else ""), "Now")
        _emit(files_scanned, len(items), space_mb, mode='apply')

    except Exception as e:
        logger.error(f"[Duplicate Cleaner] Critical error: {e}")
        import traceback
        traceback.print_exc()
        _set_state(status="error", error_message=str(e), phase=f"Error: {str(e)}")


def _emit(files_scanned: int, duplicates_found: int, space_mb: float, *, mode: str) -> None:
    try:
        if automation_engine:
            automation_engine.emit('duplicate_scan_completed', {
                'files_scanned': str(files_scanned),
                'duplicates_found': str(duplicates_found),
                'space_freed': f"{space_mb:.1f} MB",
                'mode': mode,
            })
    except Exception as e:
        logger.debug("emit duplicate_scan_completed failed: %s", e)
