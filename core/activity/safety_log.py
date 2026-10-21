"""What happened to each preview-then-confirm plan, for the Activity feed.

Plans live in memory (core/library/action_plans.py), so once a preview expires
or is confirmed nothing records that it existed. This listener writes one
``action_plan_events`` row when a plan expires unused or is confirmed, and
closes an expired preview when the same tool is previewed again or confirmed.
Writes are best-effort: losing an event must never break a plan.

An expired preview "needs you" until it is closed (previewed again, confirmed,
or dismissed from Activity).
"""

from __future__ import annotations

import json
import time
from contextlib import closing
from typing import Any, Callable, Optional

from utils.logging_config import get_logger

logger = get_logger("activity.safety_log")

EXPIRED = "expired"
CONFIRMED = "confirmed"


def _counts(plan) -> tuple:
    items = list(getattr(plan, "items", None) or [])
    counts: dict = {}
    total_bytes = 0
    for item in items:
        action = str(item.get("action") or "")
        counts[action] = counts.get(action, 0) + 1
        try:
            total_bytes += int(item.get("size") or 0)
        except (TypeError, ValueError):
            continue
    return len(items), total_bytes, counts


def record(database, event: str, plan, *, now: Optional[float] = None) -> None:
    """Persist one plan event. ``created`` only closes earlier expired
    previews of the same tool; ``expired`` and ``confirmed`` add a row."""
    now = time.time() if now is None else float(now)
    try:
        with closing(database._get_connection()) as conn:
            if event in (CONFIRMED, "created"):
                conn.execute(
                    "UPDATE action_plan_events SET resolved_at = ?, resolution = ? "
                    "WHERE tool = ? AND event = 'expired' AND resolved_at IS NULL",
                    (now, "confirmed" if event == CONFIRMED else "previewed_again", plan.tool))
            if event in (EXPIRED, CONFIRMED):
                total, total_bytes, counts = _counts(plan)
                # an expired plan is dated when it lapsed, not when it was noticed
                occurred = float(plan.expires_at) if event == EXPIRED else now
                conn.execute(
                    "INSERT OR IGNORE INTO action_plan_events "
                    "(plan_id, tool, event, total, total_bytes, counts_json, profile_id, occurred_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (plan.plan_id, plan.tool, event, total, total_bytes, json.dumps(counts),
                     getattr(plan, "owner", None), occurred))
            conn.commit()
    except Exception as exc:  # noqa: BLE001 - bookkeeping only
        logger.debug("could not record plan event %s for %s: %s", event, getattr(plan, "tool", "?"), exc)


def install(get_database: Callable[[], Any], store=None) -> None:
    """Listen to ``store`` (the shared plan store by default). Idempotent."""
    if store is None:
        from core.library.action_plans import plan_store as store
    if getattr(store, "_safety_log_installed", False):
        return
    store._safety_log_installed = True
    store.add_listener(lambda event, plan: record(get_database(), event, plan))


def dismiss(database, event_id: int, *, profile_id: Optional[int], is_admin: bool,
            now: Optional[float] = None) -> bool:
    """Close one expired preview the viewer can see. True when it was open."""
    now = time.time() if now is None else float(now)
    with closing(database._get_connection()) as conn:
        cur = conn.execute(
            "UPDATE action_plan_events SET resolved_at = ?, resolution = 'dismissed' "
            "WHERE id = ? AND event = 'expired' AND resolved_at IS NULL "
            "AND (? = 1 OR profile_id = ?)",
            (now, int(event_id), 1 if is_admin else 0, profile_id))
        conn.commit()
        return cur.rowcount > 0


__all__ = ["EXPIRED", "CONFIRMED", "record", "install", "dismiss"]
