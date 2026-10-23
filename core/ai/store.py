"""The Assistant's rows in the music database (tables made by
MusicDatabase._add_ai_assistant_tables):

- ``ai_usage``: one row per calendar month (UTC): requests, token counts, the
  estimated cost and drafts saved. Settings → AI shows the current month; the
  monthly cap reads it (the cap is one figure for the install).
- ``ai_usage_profiles``: the same requests and cost per month and profile, for
  Settings → AI's per-profile table once everyone may use the Assistant
  (HANDOFF 39). Counted from this release on, so a month that started before
  it has requests no profile holds; deleting a profile takes its rows.
- ``ai_suggestion_dismissals``: "Not now" on the list's suggestion card, per
  profile and suggestion key.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set

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


def record_request(database, *, profile_id: Optional[int] = None, input_tokens: int = 0,
                   output_tokens: int = 0, cache_read_tokens: int = 0, cache_write_tokens: int = 0,
                   cost_usd: float = 0.0, month: Optional[str] = None) -> None:
    """Count one Assistant request against this month, for the install and
    (with ``profile_id``) for the profile that asked."""
    month = month or current_month()
    try:
        with database._get_connection() as conn:
            if profile_id is not None:
                conn.execute(
                    "INSERT INTO ai_usage_profiles (month, profile_id, requests, input_tokens, output_tokens, "
                    "cache_read_tokens, cache_write_tokens, cost_usd) VALUES (?, ?, 1, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(month, profile_id) DO UPDATE SET requests = requests + 1, "
                    "input_tokens = input_tokens + excluded.input_tokens, "
                    "output_tokens = output_tokens + excluded.output_tokens, "
                    "cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, "
                    "cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens, "
                    "cost_usd = cost_usd + excluded.cost_usd, updated_at = CURRENT_TIMESTAMP",
                    (month, int(profile_id), int(input_tokens or 0), int(output_tokens or 0),
                     int(cache_read_tokens or 0), int(cache_write_tokens or 0), float(cost_usd or 0.0)))
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


def profile_usage(database, month: Optional[str] = None,
                  total: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """This month per profile, most expensive first, for admins:
    ``{rows: [{profile_id, name, requests, estimated_cost_usd}], unattributed}``.
    ``unattributed`` is what the install's total holds beyond the rows:
    requests from before per-profile counting began, or from a profile since
    deleted (None when there's nothing)."""
    month = month or current_month()
    rows: List[Dict[str, Any]] = []
    try:
        with database._get_connection() as conn:
            found = conn.execute(
                "SELECT u.profile_id, p.name, u.requests, u.cost_usd FROM ai_usage_profiles u "
                "LEFT JOIN profiles p ON p.id = u.profile_id WHERE u.month = ? "
                "ORDER BY u.cost_usd DESC, u.requests DESC, u.profile_id", (month,)).fetchall()
    except Exception as exc:  # noqa: BLE001 - a missing table reads as no rows
        logger.debug("ai per-profile usage read failed: %s", exc)
        found = []
    for r in found:
        pid = int(r[0])
        rows.append({"profile_id": pid, "name": str(r[1]) if r[1] else f"Profile {pid}",
                     "requests": int(r[2] or 0), "estimated_cost_usd": round(float(r[3] or 0.0), 4)})
    total = total if total is not None else month_usage(database, month)
    extra_requests = max(0, int(total.get("requests") or 0) - sum(x["requests"] for x in rows))
    extra_cost = max(0.0, float(total.get("cost_usd") or 0.0) - sum(x["estimated_cost_usd"] for x in rows))
    unattributed = ({"requests": extra_requests, "estimated_cost_usd": round(extra_cost, 4)}
                    if extra_requests else None)
    return {"month": month, "rows": rows, "unattributed": unattributed}


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
