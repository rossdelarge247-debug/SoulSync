"""Keep one quarantined file: restore it and import it, as a person approved.

One definition for the approve route (``POST /api/quarantine/<id>/approve``)
and "Keep the best of each" (core.imports.quarantine_bulk), so a bulk keep is
exactly the same act as a click:

1. With ``remove_siblings``, the other attempts at the same song are looked
   up first (once this entry's file moves out, its group can't be found).
2. The file is restored next to the downloads and its pipeline context loaded
   (an older sidecar without one can't be approved: ``None``).
3. Every quarantine check is skipped for this one pass (the person said
   "import this").
4. The download task that owns the entry (the request's, or the one stamped
   with this ``quarantine_entry_id``) is re-supplied, and the import runs
   through the verification wrapper so that task is marked completed;
   without a task it runs through the plain pipeline.
5. The siblings found in step 1 are deleted.
6. A quarantine retry still searching for the same track is cancelled.

``run`` starts the import: the route hands it to a thread, keep-best runs it
in place (one song at a time).
"""

from __future__ import annotations

import time
from typing import Any, Callable, Dict, List, Optional

from utils.logging_config import get_logger

logger = get_logger("imports.quarantine_approve")


def approve_and_import(
    quarantine_dir: str,
    entry_id: str,
    restore_dir: str,
    *,
    post_process: Callable[..., Any],
    post_process_with_verification: Callable[..., Any],
    task_id: Optional[str] = None,
    remove_siblings: bool = False,
    run: Callable[[Callable[[], Any]], Any] = lambda fn: fn(),
    download_tasks: Optional[Dict[str, Any]] = None,
    tasks_lock: Any = None,
) -> Optional[Dict[str, Any]]:
    """Approve one entry. None for an older entry without its import
    context; otherwise the route's answer (``trigger_bypassed``,
    ``original_trigger``, ``removed_siblings``, ``cancelled_retry_task``)
    plus ``task_id``."""
    from core.imports.quarantine import (
        approve_quarantine_entry,
        delete_quarantine_entry,
        find_quarantine_siblings,
    )

    if download_tasks is None or tasks_lock is None:
        from core.runtime_state import download_tasks as _tasks, tasks_lock as _lock
        download_tasks = _tasks if download_tasks is None else download_tasks
        tasks_lock = _lock if tasks_lock is None else tasks_lock

    sibling_ids: List[str] = []
    if remove_siblings:
        try:
            sibling_ids = find_quarantine_siblings(quarantine_dir, entry_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[Quarantine] Sibling lookup for {entry_id} failed: {exc}")

    result = approve_quarantine_entry(quarantine_dir, entry_id, restore_dir)
    if result is None:
        return None
    restored_path, context, trigger = result
    # the person asked for this file: no quarantine check runs on this pass
    context['_skip_quarantine_check'] = 'all'
    context['_approved_quarantine_trigger'] = trigger

    task_id = (task_id or '').strip() or None
    batch_id = None
    with tasks_lock:
        if task_id:
            task = download_tasks.get(task_id)
            if isinstance(task, dict):
                batch_id = task.get('batch_id')
        else:
            for tid, task in download_tasks.items():
                if isinstance(task, dict) and task.get('quarantine_entry_id') == entry_id:
                    task_id, batch_id = tid, task.get('batch_id')
                    break
    if task_id:
        context['task_id'] = task_id
        if batch_id:
            context['batch_id'] = batch_id
    context_key = f"approve_{entry_id}_{int(time.time())}"
    if task_id:
        reprocess = lambda: post_process_with_verification(  # noqa: E731
            context_key, context, restored_path, task_id, batch_id)
    else:
        reprocess = lambda: post_process(context_key, context, restored_path)  # noqa: E731
    run(reprocess)
    logger.info(f"[Quarantine] Approved {entry_id} (original_trigger={trigger}, bypass=all, "
                f"task={task_id}) → re-running pipeline")

    removed: List[str] = []
    for sib_id in sibling_ids:
        try:
            if delete_quarantine_entry(quarantine_dir, sib_id):
                removed.append(sib_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[Quarantine] Sibling cleanup for {entry_id} failed: {exc}")
    if removed:
        logger.info(f"[Quarantine] Auto-removed {len(removed)} sibling alternative(s) of "
                    f"{entry_id}: {removed}")

    cancelled = None
    try:
        info = context.get('track_info') if isinstance(context.get('track_info'), dict) else {}
        name = (info.get('name') or '').strip().lower()
        if name:
            with tasks_lock:
                for tid, task in download_tasks.items():
                    if not isinstance(task, dict) or not task.get('_quarantine_retry'):
                        continue
                    if task.get('status') in ('completed', 'cancelled', 'failed'):
                        continue
                    other = task.get('track_info') if isinstance(task.get('track_info'), dict) else {}
                    if (other.get('name') or '').strip().lower() == name:
                        task['status'] = 'cancelled'
                        task['_quarantine_approved_alternative'] = True
                        cancelled = tid
                        logger.info(f"[Quarantine] Cancelled in-flight retry task {tid} for "
                                    f"'{name}' (user approved alternative)")
                        break
    except Exception as exc:  # noqa: BLE001
        logger.debug(f"[Quarantine] Retry-cancel scan failed: {exc}")

    return {
        "trigger_bypassed": "all",
        "original_trigger": trigger,
        "removed_siblings": removed,
        "cancelled_retry_task": cancelled,
        "task_id": task_id,
    }


__all__ = ["approve_and_import"]
