"""Preview-then-confirm plans for the tools that move or delete media files.

Every bulk tool that relocates or removes a user's files (Deep Scan's
untracked -> Staging move, the duplicate cleaner, repair bulk fixes, the
recycle-bin purge) used to act the moment it was asked. A stray click, or an
automation nobody remembered switching on, moved 1,500 tracks into Staging
(#904) and deleted the only copy of a song (#1210).

The rule now: a bulk action first produces a PLAN, a list of exactly what it
would do, file by file, with the reason for each. The plan gets an id. The
action only runs against a plan id that a person (or an automation the user
explicitly configured to act) hands back while it is still fresh, and it acts
on that plan's items, not on a fresh scan that might have grown in between.

Plans live in memory. SoulSync runs one gunicorn worker (gunicorn.conf.py), so
a process-wide store is shared by every request; a restart drops pending plans
and the user simply previews again. Plans are single use and expire after
``PLAN_TTL_SECONDS`` so an old preview cannot authorise today's state.

Listeners (``PlanStore.add_listener``) hear what happens to a plan: it was
created, confirmed, or it expired unused. The Activity feed records the last
two (core/activity/safety_log.py). Listeners run outside the store's lock and
a failing one never breaks the plan flow.
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections import Counter, OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)

PLAN_TTL_SECONDS = 15 * 60
DEFAULT_SAMPLE_SIZE = 50
MAX_PLANS = 32

# Plan refusal codes. The web layer maps them to a 409 and user copy.
PLAN_MISSING = "plan_required"
PLAN_UNKNOWN = "plan_unknown"
PLAN_EXPIRED = "plan_expired"
PLAN_WRONG_TOOL = "plan_wrong_tool"

_REFUSAL_MESSAGES = {
    PLAN_MISSING: "Preview this action first, then confirm it.",
    PLAN_UNKNOWN: "That preview is no longer available (it was used already, or SYNCHRO.S restarted). Preview again.",
    PLAN_EXPIRED: "That preview is out of date. Preview again so you confirm what is on disk now.",
    PLAN_WRONG_TOOL: "That preview belongs to a different tool.",
}


class PlanError(Exception):
    """A bulk action was asked to run without a usable plan."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(_REFUSAL_MESSAGES.get(code, code))

    @property
    def message(self) -> str:
        return _REFUSAL_MESSAGES.get(self.code, self.code)


@dataclass
class ActionPlan:
    plan_id: str
    tool: str
    items: List[Dict[str, Any]]
    created_at: float
    expires_at: float
    meta: Dict[str, Any] = field(default_factory=dict)
    # The profile whose request made the preview; None when an automation or
    # other background job made it. Not part of the summary.
    owner: Optional[int] = None

    def summary(self, sample_size: int = DEFAULT_SAMPLE_SIZE, now: Optional[float] = None) -> Dict[str, Any]:
        """JSON-safe description for a preview screen: counts, a sample of the
        items with the reason for each, and when the plan stops being valid."""
        now = time.time() if now is None else now
        out = summarize_items(self.items, sample_size=sample_size)
        out.update({
            "plan_id": self.plan_id,
            "tool": self.tool,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
            "expires_in_seconds": max(0, int(self.expires_at - now)),
            "meta": dict(self.meta),
        })
        return out


def summarize_items(items: Iterable[Dict[str, Any]], sample_size: int = DEFAULT_SAMPLE_SIZE) -> Dict[str, Any]:
    """Counts by action and by reason, total bytes when known, plus the first
    ``sample_size`` items. Pure."""
    items = list(items)
    by_action = Counter(str(i.get("action") or "") for i in items)
    by_reason = Counter(str(i.get("reason") or "") for i in items)
    total_bytes = 0
    for i in items:
        try:
            total_bytes += int(i.get("size") or 0)
        except (TypeError, ValueError):
            continue
    sample_size = max(0, int(sample_size))
    return {
        "total": len(items),
        "counts": dict(by_action),
        "by_reason": dict(by_reason),
        "total_bytes": total_bytes,
        "sample": [dict(i) for i in items[:sample_size]],
        "truncated": len(items) > sample_size,
    }


class PlanStore:
    """Thread-safe, bounded, expiring store of single-use plans."""

    def __init__(self, ttl_seconds: float = PLAN_TTL_SECONDS, max_plans: int = MAX_PLANS,
                 clock: Callable[[], float] = time.time):
        self._ttl = float(ttl_seconds)
        self._max = int(max_plans)
        self._clock = clock
        self._lock = threading.Lock()
        self._plans: "OrderedDict[str, ActionPlan]" = OrderedDict()
        self._listeners: List[Callable[[str, ActionPlan], None]] = []

    def add_listener(self, listener: Callable[[str, ActionPlan], None]) -> None:
        """Call ``listener(event, plan)`` when a plan is ``created``,
        ``confirmed`` (consumed) or ``expired`` (dropped unused after its TTL)."""
        with self._lock:
            if listener not in self._listeners:
                self._listeners.append(listener)

    def _emit(self, events: Iterable[tuple]) -> None:
        for event, plan in events:
            for listener in list(self._listeners):
                try:
                    listener(event, plan)
                except Exception as exc:  # noqa: BLE001 - a listener must never break a plan
                    logger.debug("plan listener failed on %s: %s", event, exc)

    def _prune(self, now: float) -> List[tuple]:
        """Drop expired plans (returned as events) and the oldest beyond the cap."""
        expired = [plan for plan in self._plans.values() if plan.expires_at <= now]
        for plan in expired:
            self._plans.pop(plan.plan_id, None)
        while len(self._plans) > self._max:
            self._plans.popitem(last=False)
        return [("expired", plan) for plan in expired]

    def create(self, tool: str, items: Iterable[Dict[str, Any]], meta: Optional[Dict[str, Any]] = None) -> ActionPlan:
        now = self._clock()
        plan = ActionPlan(
            plan_id=uuid.uuid4().hex,
            tool=str(tool),
            items=[dict(i) for i in items],
            created_at=now,
            expires_at=now + self._ttl,
            meta=dict(meta or {}),
            owner=_request_profile(),
        )
        with self._lock:
            self._plans[plan.plan_id] = plan
            events = self._prune(now)
        self._emit(events + [("created", plan)])
        return plan

    def _lookup(self, plan_id: Optional[str], tool: str, events: List[tuple]) -> ActionPlan:
        if not plan_id or not isinstance(plan_id, str):
            raise PlanError(PLAN_MISSING)
        now = self._clock()
        plan = self._plans.get(plan_id)
        if plan is None:
            events.extend(self._prune(now))
            raise PlanError(PLAN_UNKNOWN)
        if plan.expires_at <= now:
            self._plans.pop(plan_id, None)
            events.append(("expired", plan))
            raise PlanError(PLAN_EXPIRED)
        if plan.tool != tool:
            raise PlanError(PLAN_WRONG_TOOL)
        return plan

    def peek(self, plan_id: Optional[str], tool: str) -> ActionPlan:
        """The plan, still valid and unused, without spending it."""
        events: List[tuple] = []
        try:
            with self._lock:
                return self._lookup(plan_id, tool, events)
        finally:
            self._emit(events)

    def consume(self, plan_id: Optional[str], tool: str) -> ActionPlan:
        """The plan, removed so it cannot authorise a second run."""
        events: List[tuple] = []
        try:
            with self._lock:
                plan = self._lookup(plan_id, tool, events)
                self._plans.pop(plan.plan_id, None)
            events.append(("confirmed", plan))
            return plan
        finally:
            self._emit(events)

    def latest(self, tool: str) -> Optional[ActionPlan]:
        """Most recent unexpired plan for ``tool`` (for status screens)."""
        found = None
        with self._lock:
            events = self._prune(self._clock())
            for plan in reversed(self._plans.values()):
                if plan.tool == tool:
                    found = plan
                    break
        self._emit(events)
        return found

    def sweep(self) -> int:
        """Drop expired plans now, so their listeners hear about it without
        waiting for the next preview. Returns how many expired."""
        with self._lock:
            events = self._prune(self._clock())
        self._emit(events)
        return len(events)

    def clear(self) -> None:
        with self._lock:
            self._plans.clear()


def _request_profile() -> Optional[int]:
    """The profile of the web request making a plan, or None outside one."""
    try:
        from flask import has_request_context
        if not has_request_context():
            return None
        from core.profile_context import get_current_profile_id
        pid = get_current_profile_id()
        return int(pid) if pid is not None else None
    except Exception:  # noqa: BLE001 - owner is informational only
        return None


# The process-wide store every tool shares.
plan_store = PlanStore()


_TRUTHY = {"1", "true", "yes", "on"}


def automation_may_act(config: Optional[Dict[str, Any]]) -> bool:
    """True only when an automation's action config explicitly says to act.

    The key is ``confirm`` (the "act without a preview" switch). Absent,
    false, or anything unrecognised means plan mode: the automation reports
    what it WOULD do and touches nothing. A default or forgotten automation
    therefore can never act blind.
    """
    if not config:
        return False
    value = config.get("confirm")
    if isinstance(value, str):
        return value.strip().lower() in _TRUTHY
    return value is True or (isinstance(value, int) and not isinstance(value, bool) and value == 1)


__all__ = [
    "ActionPlan",
    "PlanError",
    "PlanStore",
    "plan_store",
    "summarize_items",
    "automation_may_act",
    "PLAN_TTL_SECONDS",
    "DEFAULT_SAMPLE_SIZE",
    "PLAN_MISSING",
    "PLAN_UNKNOWN",
    "PLAN_EXPIRED",
    "PLAN_WRONG_TOOL",
]
