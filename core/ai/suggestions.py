"""The suggestion card at the top of the Automations list.

Worked out locally from the library's facts, with no model call: the model
only runs when the person presses "Use this", which sends ``draft_prompt``
to the conversation. One at a time, the first a profile hasn't said "Not
now" to, and only one whose reason has a number in it. Read as the profile:
its own automations (and, for an admin, the built-in ones, which only an
admin can change), its own Wanted.

Kinds, in order:

- ``failing:<id>``: an automation with 2 or more failed runs in the last 30
  days and no follow-up that would tell anyone.
- ``paused:<id>``: an automation paused for 14 days or more (``paused_at``).
- ``wanted_stale``: 10 or more Wanted tracks on the list for over 30 days,
  tried and not found.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from core.ai import store
from core.ai.context import stale_wanted_count

logger = logging.getLogger(__name__)

FAIL_MIN = 2
FAIL_WINDOW_DAYS = 30
PAUSED_MIN_DAYS = 14
STALE_WANTED_MIN = 10
NOTIFY_TYPES = {"discord_webhook", "pushbullet", "telegram", "ntfy", "gotify", "webhook"}


def _parse_time(value: Any) -> Optional[datetime]:
    if not value:
        return None
    text = str(value).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text if "T" in text else text.replace(" ", "T"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def paused_words(days: int) -> str:
    if days < 14:
        return f"{days} days"
    if days < 60:
        weeks = days // 7
        return f"{weeks} weeks"
    return f"{days // 30} months"


def _quote(name: Any) -> str:
    return f"“{str(name or 'this automation')[:80]}”"


def _runs_by_automation(database, ids: List[int], since: datetime) -> Dict[int, List[str]]:
    if not ids:
        return {}
    out: Dict[int, List[str]] = {}
    try:
        with database._get_connection() as conn:
            marks = ",".join("?" for _ in ids)
            rows = conn.execute(
                f"SELECT automation_id, status, started_at FROM automation_run_history "  # noqa: S608
                f"WHERE automation_id IN ({marks}) AND status NOT IN ('preview', 'skipped')", ids).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.debug("runs unreadable for suggestions: %s", exc)
        return {}
    for aid, status, started in rows:
        started_at = _parse_time(started)
        if started_at is None or started_at < since:
            continue
        out.setdefault(int(aid), []).append(str(status))
    return out


def candidates(database, *, profile_id: int, is_admin: bool, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
    from core.automation.api import _hydrate_automation

    now = now or datetime.now(timezone.utc)
    try:
        automations = [_hydrate_automation(dict(a)) for a in database.get_automations(int(profile_id))]
    except Exception as exc:  # noqa: BLE001
        logger.debug("automations unreadable for suggestions: %s", exc)
        automations = []
    mine = [a for a in automations if (a.get("owned_by") or "") != "video"
            and (is_admin or not a.get("is_system"))]
    out: List[Dict[str, Any]] = []

    runs = _runs_by_automation(database, [int(a["id"]) for a in mine if a.get("enabled")],
                               now - timedelta(days=FAIL_WINDOW_DAYS))
    for a in mine:
        if not a.get("enabled"):
            continue
        statuses = runs.get(int(a["id"]), [])
        failed = sum(1 for s in statuses if s in ("error", "timeout"))
        tells = any(isinstance(t, dict) and t.get("type") in NOTIFY_TYPES for t in a.get("then_actions") or [])
        if failed >= FAIL_MIN and not tells:
            out.append({
                "key": f"failing:{a['id']}",
                "title": f"Tell you when {a.get('name')} fails",
                "reason": f"{failed} of its last {len(statuses)} runs failed and nothing told you. "
                          "Adds one follow-up: a message, only when a run fails.",
                "draft_prompt": f"Add a follow-up to {_quote(a.get('name'))} that sends me a message only "
                                "when a run fails.",
                "automation_id": a["id"],
            })

    for a in mine:
        if a.get("enabled"):
            continue
        paused_at = _parse_time(a.get("paused_at"))
        if paused_at is None:
            continue
        days = (now - paused_at).days
        if days < PAUSED_MIN_DAYS:
            continue
        reason = f"{_quote(a.get('name'))} has been paused for {paused_words(days)}."
        if a.get("action_type") == "scan_watchlist":
            reason += " New releases from the artists you follow aren't reaching Wanted."
        out.append({
            "key": f"paused:{a['id']}",
            "title": f"Resume {a.get('name')}?",
            "reason": reason,
            "draft_prompt": f"{_quote(a.get('name'))} has been paused for {paused_words(days)}. Explain what "
                            "it does and whether I should turn it back on.",
            "automation_id": a["id"],
        })

    stale = stale_wanted_count(database, int(profile_id))
    if stale >= STALE_WANTED_MIN:
        out.append({
            "key": "wanted_stale",
            "title": "Do something about Wanted tracks that aren't turning up",
            "reason": f"{stale} tracks have been on Wanted for over a month without being found.",
            "draft_prompt": f"{stale} tracks have been on Wanted for over a month without being found. "
                            "What automation would help?",
            "automation_id": None,
        })
    return [c for c in out if re.search(r"\d", c["reason"])]


def pick(database, *, profile_id: int, is_admin: bool, now: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """The one suggestion to show, or None."""
    dismissed = store.dismissed_keys(database, int(profile_id))
    for item in candidates(database, profile_id=profile_id, is_admin=is_admin, now=now):
        if item["key"] not in dismissed:
            return item
    return None


KEY_RE = re.compile(r"^(failing:\d+|paused:\d+|wanted_stale)$")


def valid_key(key: str) -> bool:
    return bool(KEY_RE.match(str(key or "")))
