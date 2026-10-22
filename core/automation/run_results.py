"""What a Wanted search run found, written back onto its run row.

The Wanted search (``process_wishlist``) starts its batches and returns, so
the engine records the run before anything has downloaded. Its batches finish
later, in the background. This keeps one small entry per search run, keyed by
the wishlist run id the batches carry (``wishlist_run_id``), and writes the
counts onto the automation's run row (``automation_run_history.result_json``)
by that row's id once both halves are known:

- ``begin`` (just before the batches go out, so a fast batch can't finish
  first) and ``set_searched``: the automation, and what it searched: tracks,
  and albums as album batches.
- ``attach``: the engine recorded the automation's run row (its id).
- ``add_batch`` / ``finish``: a batch of the run ended, then the last one.

``attach`` and ``finish`` can arrive in either order; whichever comes second
writes. The row's ``result_json`` gains::

    {"searched": {"tracks": 41, "albums": 3}, "found": {"tracks": 12, "albums": 2}}

``found.albums`` counts album batches that downloaded at least one track.
Entries nobody claims (the run row was never recorded, a batch never ended)
are dropped after a day, and at most ``MAX_PENDING`` are kept.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

MAX_PENDING = 64
PENDING_TTL_SECONDS = 24 * 3600

_lock = threading.Lock()
_pending: Dict[str, Dict[str, Any]] = {}


def _norm(automation_id: Any) -> Any:
    try:
        return int(automation_id)
    except (TypeError, ValueError):
        return str(automation_id)


def _prune(now: float) -> None:
    for run_id in [k for k, v in _pending.items() if now - v["created"] > PENDING_TTL_SECONDS]:
        _pending.pop(run_id, None)
    while len(_pending) > MAX_PENDING:
        oldest = min(_pending, key=lambda k: _pending[k]["created"])
        _pending.pop(oldest, None)


def begin(run_id: str, automation_id: Optional[int], *, tracks: int, albums: int) -> None:
    """A search run dispatched its batches. Without an automation (a click
    on Wanted's own button) there is no run row to write to, so nothing is
    kept."""
    if not run_id or automation_id is None:
        return
    now = time.time()
    with _lock:
        # one search runs at a time: an older entry for the same automation
        # that never got its row is stale
        aid = _norm(automation_id)
        for key in [k for k, v in _pending.items()
                    if v["automation_id"] == aid and v["history_id"] is None]:
            _pending.pop(key, None)
        _pending[run_id] = {
            "automation_id": aid,
            "history_id": None,
            "searched": {"tracks": int(tracks), "albums": int(albums)},
            "found": {"tracks": 0, "albums": 0},
            "finished": False,
            "created": now,
        }
        _prune(now)


def set_searched(run_id: str, *, tracks: int, albums: int) -> None:
    """What the run searched, once its batches are dispatched."""
    with _lock:
        entry = _pending.get(run_id)
        if entry is not None:
            entry["searched"] = {"tracks": int(tracks), "albums": int(albums)}


def attach(automation_id: int, history_id: Optional[int], database) -> None:
    """The engine recorded the automation's run row. Writes what the run
    searched now, and what it found if its batches already finished."""
    if not history_id:
        return
    with _lock:
        aid = _norm(automation_id)
        entry = next((v for v in _pending.values()
                      if v["automation_id"] == aid and v["history_id"] is None), None)
        if entry is None:
            return
        entry["history_id"] = int(history_id)
        payload = _payload(entry)
        if entry["finished"]:
            _forget(entry)
    _write(database, int(history_id), payload)


def add_batch(run_id: str, *, found_tracks: int, is_album: bool) -> None:
    """One batch of the run ended, having downloaded ``found_tracks``."""
    if not run_id:
        return
    with _lock:
        entry = _pending.get(run_id)
        if entry is None:
            return
        found = max(0, int(found_tracks or 0))
        entry["found"]["tracks"] += found
        if is_album and found:
            entry["found"]["albums"] += 1


def finish(run_id: str, database) -> None:
    """The run's last batch ended. Writes the counts if the row is known."""
    if not run_id:
        return
    with _lock:
        entry = _pending.get(run_id)
        if entry is None:
            return
        entry["finished"] = True
        history_id = entry["history_id"]
        payload = _payload(entry)
        if history_id is not None:
            _forget(entry)
    if history_id is not None:
        _write(database, history_id, payload)


def _payload(entry: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {"searched": dict(entry["searched"])}
    if entry["finished"]:
        out["found"] = dict(entry["found"])
    return out


def _forget(entry: Dict[str, Any]) -> None:
    for key in [k for k, v in _pending.items() if v is entry]:
        _pending.pop(key, None)


def _write(database, history_id: int, patch: Dict[str, Any]) -> bool:
    """Merge ``patch`` into the run row's result_json, by the row's id."""
    if database is None:
        return False
    try:
        with database._get_connection() as conn:
            cursor = conn.cursor()
            row = cursor.execute("SELECT result_json FROM automation_run_history WHERE id = ?",
                                 (history_id,)).fetchone()
            if row is None:
                return False
            try:
                current = json.loads(row[0]) if row[0] else {}
            except (TypeError, ValueError):
                current = {}
            if not isinstance(current, dict):
                current = {}
            current.update(patch)
            cursor.execute("UPDATE automation_run_history SET result_json = ? WHERE id = ?",
                           (json.dumps(current), history_id))
            conn.commit()
            return True
    except Exception as exc:  # noqa: BLE001 - bookkeeping must never break a run
        logger.debug("could not write the found count onto run %s: %s", history_id, exc)
        return False


def batch_found_tracks(batch: Dict[str, Any], download_tasks: Dict[str, Dict[str, Any]]) -> int:
    """Tracks a finished batch downloaded: its tasks that completed."""
    count = 0
    for task_id in batch.get("queue", []) or []:
        task = download_tasks.get(task_id)
        if isinstance(task, dict) and task.get("status") == "completed":
            count += 1
    return count


def reset_for_tests() -> None:
    with _lock:
        _pending.clear()
