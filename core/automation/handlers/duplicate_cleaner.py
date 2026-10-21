"""Automation handler: ``run_duplicate_cleaner`` action.

Lifted from ``web_server._register_automation_handlers`` (the
``_auto_run_duplicate_cleaner`` closure). Submits the duplicate
cleaner to its executor, then polls the shared state dict until
the worker transitions away from ``running``.
"""

from __future__ import annotations

import time
from typing import Any, Dict

from core.automation.deps import AutomationDeps
from core.library.action_plans import automation_may_act


_TIMEOUT_SECONDS = 7200          # 2 hours
_POLL_INTERVAL_SECONDS = 3
_INITIAL_DELAY_SECONDS = 1


def auto_run_duplicate_cleaner(config: Dict[str, Any], deps: AutomationDeps) -> Dict[str, Any]:
    """Kick off the duplicate cleaner and report final stats.

    Preview-only unless the automation's config has ``confirm: true``: a
    plan-mode run reports how many duplicates it WOULD move to the recycle
    bin (and leaves a plan the user can confirm on the Tools page)."""
    automation_id = config.get('_automation_id')
    state = deps.get_duplicate_cleaner_state()
    if state.get('status') == 'running':
        return {'status': 'skipped', 'reason': 'Duplicate cleaner already running'}
    act = automation_may_act(config)

    # Pre-set status before submit so the polling loop doesn't see a
    # stale 'finished' from a previous run.
    with deps.duplicate_cleaner_lock:
        state['status'] = 'running'
    deps.duplicate_cleaner_executor.submit(deps.run_duplicate_cleaner, confirm=act)
    deps.update_progress(automation_id, log_type='info',
                         log_line='Duplicate cleaner started' if act else
                         'Duplicate cleaner started (preview only, nothing will be moved)')

    # Monitor progress (max 2 hours).
    time.sleep(_INITIAL_DELAY_SECONDS)
    poll_start = time.time()
    while time.time() - poll_start < _TIMEOUT_SECONDS:
        time.sleep(_POLL_INTERVAL_SECONDS)
        current_status = state.get('status', 'idle')
        if current_status not in ('running',):
            break
        deps.update_progress(
            automation_id,
            phase=state.get('phase', 'Scanning...'),
            progress=state.get('progress', 0),
            processed=state.get('files_scanned', 0),
            total=state.get('total_files', 0),
        )
    else:
        # 2-hour timeout reached.
        deps.update_progress(
            automation_id, status='error',
            phase='Timed out',
            log_line='Duplicate cleaner timed out after 2 hours',
            log_type='error',
        )
        return {'status': 'error', 'reason': 'Timed out', '_manages_own_progress': True}

    # Check actual exit status (could be 'finished' or 'error').
    final_status = state.get('status', 'idle')
    if final_status == 'error':
        err = state.get('error_message', 'Unknown error')
        deps.update_progress(
            automation_id, status='error', progress=100,
            phase='Error', log_line=err, log_type='error',
        )
        return {'status': 'error', 'reason': err, '_manages_own_progress': True}

    dupes = state.get('duplicates_found', 0)
    removed = state.get('deleted', 0)
    space_freed = state.get('space_freed', 0)
    scanned = state.get('files_scanned', 0)
    if not act:
        plan = state.get('plan') or {}
        would_mb = round((plan.get('total_bytes') or 0) / (1024 * 1024), 1)
        deps.update_progress(
            automation_id, status='finished', progress=100, phase='Preview ready',
            log_line=(f"Preview only: {dupes} duplicate file(s) ({would_mb} MB) would move to the "
                      f"recycle bin. Nothing was moved. Review and confirm on the Tools page, or turn "
                      f"on 'Act without a preview' in this automation."),
            log_type='info',
        )
        return {
            'status': 'completed', '_manages_own_progress': True, 'mode': 'plan',
            'files_scanned': scanned, 'duplicates_found': dupes, 'files_deleted': 0,
            'space_freed_mb': 0.0, 'would_remove': dupes, 'would_free_mb': would_mb,
            'plan_id': state.get('plan_id') or '',
        }
    refused = state.get('refused', 0)
    deps.update_progress(
        automation_id, status='finished', progress=100,
        phase='Complete',
        log_line=(f'Found {dupes} duplicates, moved {removed} files to the recycle bin'
                  + (f', kept {refused} whose copy to keep could not be verified' if refused else '')),
        log_type='success',
    )
    return {
        'status': 'completed', '_manages_own_progress': True,
        'files_scanned': scanned,
        'duplicates_found': dupes,
        'files_deleted': removed,
        'files_refused': refused,
        'space_freed_mb': round(space_freed / (1024 * 1024), 1),
    }
