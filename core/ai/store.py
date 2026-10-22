"""The Assistant's rows in the music database (tables made by
MusicDatabase._add_ai_assistant_tables):

- ``ai_usage``: one row per calendar month (UTC): requests, token counts, the
  estimated cost and drafts saved. Settings → AI shows the current month; the
  monthly cap reads it.
- ``ai_suggestion_dismissals``: "Not now" on the list's suggestion card, per
  profile and suggestion key.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Set

logger = logging.getLogger(__name__)

USAGE_FIELDS = ("requests", "input_tokens", "output_tokens", "cache_read_tokens",
                "cache_write_tokens", "cost_usd", "drafts_saved")


def current_month(now: Optional[datetime] = None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y-%m")


def month_usage(database, month: Optional[str] = None) -> Dict[str, Any]:
    """This month's usage (zeros when nothing was recorded)."""
    month = month or current_month()
    out: Dict[str, Any] = {"month": month, **{k: 0 for k in USAGE_FIELDS}}
    out["cost_usd"] = 0.0
    try:
        with database._get_connection() as conn:
            row = conn.execute(
                "SELECT requests, input_tokens, output_tokens, cache_read_tokens, "
                "cache_write_tokens, cost_usd, drafts_saved FROM ai_usage WHERE month = ?",
                (month,)).fetchone()
    except Exception as exc:  # noqa: BLE001 - a missing table reads as no usage
        logger.debug("ai usage read failed: %s", exc)
        return out
    if row:
        for key, value in zip(USAGE_FIELDS, tuple(row), strict=False):
            out[key] = float(value or 0) if key == "cost_usd" else int(value or 0)
    return out


def record_request(database, *, input_tokens: int = 0, output_tokens: int = 0,
                   cache_read_tokens: int = 0, cache_write_tokens: int = 0,
                   cost_usd: float = 0.0, month: Optional[str] = None) -> None:
    """Count one Assistant request against this month."""
    month = month or current_month()
    try:
        with database._get_connection() as conn:
            conn.execute(
                "INSERT INTO ai_usage (month, requests, input_tokens, output_tokens, cache_read_tokens, "
                "cache_write_tokens, cost_usd) VALUES (?, 1, ?, ?, ?, ?, ?) "
                "ON CONFLICT(month) DO UPDATE SET requests = requests + 1, "
                "input_tokens = input_tokens + excluded.input_tokens, "
                "output_tokens = output_tokens + excluded.output_tokens, "
                "cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, "
                "cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens, "
                "cost_usd = cost_usd + excluded.cost_usd, updated_at = CURRENT_TIMESTAMP",
                (month, int(input_tokens or 0), int(output_tokens or 0), int(cache_read_tokens or 0),
                 int(cache_write_tokens or 0), float(cost_usd or 0.0)))
            conn.commit()
    except Exception as exc:  # noqa: BLE001 - usage is bookkeeping
        logger.warning("Could not record Assistant usage: %s", exc)


def record_draft_saved(database, month: Optional[str] = None) -> None:
    """A draft from the Assistant was saved as an automation."""
    month = month or current_month()
    try:
        with database._get_connection() as conn:
            conn.execute(
                "INSERT INTO ai_usage (month, drafts_saved) VALUES (?, 1) "
                "ON CONFLICT(month) DO UPDATE SET drafts_saved = drafts_saved + 1, "
                "updated_at = CURRENT_TIMESTAMP", (month,))
            conn.commit()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not count a saved Assistant draft: %s", exc)


def dismissed_keys(database, profile_id: int) -> Set[str]:
    try:
        with database._get_connection() as conn:
            rows = conn.execute("SELECT suggestion_key FROM ai_suggestion_dismissals WHERE profile_id = ?",
                                (int(profile_id),)).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.debug("dismissals read failed: %s", exc)
        return set()
    return {str(r[0]) for r in rows}


def dismiss(database, profile_id: int, key: str) -> bool:
    try:
        with database._get_connection() as conn:
            conn.execute(
                "INSERT INTO ai_suggestion_dismissals (profile_id, suggestion_key) VALUES (?, ?) "
                "ON CONFLICT(profile_id, suggestion_key) DO UPDATE SET dismissed_at = CURRENT_TIMESTAMP",
                (int(profile_id), str(key)))
            conn.commit()
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not store Not now for a suggestion: %s", exc)
        return False
