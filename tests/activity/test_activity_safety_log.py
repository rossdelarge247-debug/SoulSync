"""Preview outcomes recorded for Activity (core/activity/safety_log.py) and
the plan-store events that feed them (core/library/action_plans.py)."""

from __future__ import annotations

import pytest
from flask import Flask, g

from core.activity import safety_log
from core.library.action_plans import PlanError, PlanStore


class _Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


def _items(n=2):
    return [{"path": f"/m/{i}.mp3", "action": "recycle", "reason": "duplicate", "size": 100} for i in range(n)]


def _events(db):
    conn = db._get_connection()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT plan_id, tool, event, total, total_bytes, counts_json, profile_id, occurred_at, "
            "resolved_at, resolution FROM action_plan_events ORDER BY id")]
    finally:
        conn.close()


# ── the store's events ────────────────────────────────────────────────────────

def test_listeners_hear_created_confirmed_and_expired():
    clock = _Clock()
    store = PlanStore(ttl_seconds=60, clock=clock)
    heard = []
    store.add_listener(lambda event, plan: heard.append((event, plan.tool)))
    used = store.create("dup", _items())
    store.consume(used.plan_id, "dup")
    store.create("deep", _items())
    clock.now += 61
    assert store.sweep() == 1
    assert heard == [("created", "dup"), ("confirmed", "dup"), ("created", "deep"), ("expired", "deep")]


def test_an_expired_plan_found_by_a_lookup_is_heard_once():
    clock = _Clock()
    store = PlanStore(ttl_seconds=60, clock=clock)
    heard = []
    store.add_listener(lambda event, plan: heard.append(event))
    plan = store.create("dup", _items())
    clock.now += 61
    with pytest.raises(PlanError):
        store.peek(plan.plan_id, "dup")
    assert store.sweep() == 0
    assert heard == ["created", "expired"]


def test_a_failing_listener_never_breaks_a_plan():
    store = PlanStore(clock=_Clock())
    store.add_listener(lambda event, plan: 1 / 0)
    plan = store.create("dup", _items())
    assert store.consume(plan.plan_id, "dup").plan_id == plan.plan_id


def test_a_plan_remembers_whose_request_made_it():
    store = PlanStore(clock=_Clock())
    assert store.create("dup", _items()).owner is None
    app = Flask(__name__)
    with app.test_request_context("/"):
        g.profile_id = 3
        assert store.create("dup", _items()).owner == 3


def test_the_owner_is_not_in_the_preview_summary():
    plan = PlanStore(clock=_Clock()).create("dup", _items())
    assert "owner" not in plan.summary()


# ── what gets written ─────────────────────────────────────────────────────────

def test_an_expired_preview_is_dated_when_it_lapsed(db):
    clock = _Clock(5000.0)
    store = PlanStore(ttl_seconds=60, clock=clock)
    safety_log.install(lambda: db, store=store)
    plan = store.create("duplicate_cleaner", _items(3))
    clock.now += 600
    store.sweep()
    [row] = _events(db)
    assert row["event"] == "expired" and row["tool"] == "duplicate_cleaner"
    assert row["occurred_at"] == plan.expires_at == 5060.0
    assert row["total"] == 3 and row["total_bytes"] == 300 and row["counts_json"] == '{"recycle": 3}'
    assert row["resolved_at"] is None


def test_previewing_again_closes_the_expired_one_for_that_tool_only(db):
    clock = _Clock()
    store = PlanStore(ttl_seconds=60, clock=clock)
    safety_log.install(lambda: db, store=store)
    store.create("duplicate_cleaner", _items())
    store.create("deep_scan", _items())
    clock.now += 61
    store.sweep()
    store.create("duplicate_cleaner", _items())
    by_tool = {r["tool"]: r for r in _events(db)}
    assert by_tool["duplicate_cleaner"]["resolution"] == "previewed_again"
    assert by_tool["deep_scan"]["resolved_at"] is None


def test_confirming_records_the_outcome_and_closes_earlier_expiries(db):
    clock = _Clock()
    store = PlanStore(ttl_seconds=60, clock=clock)
    safety_log.install(lambda: db, store=store)
    store.create("deep_scan", _items())
    clock.now += 61
    store.sweep()
    fresh = store.create("deep_scan", _items(5))
    store.consume(fresh.plan_id, "deep_scan")
    rows = _events(db)
    assert [r["event"] for r in rows] == ["expired", "confirmed"]
    assert rows[1]["total"] == 5
    assert rows[0]["resolution"] == "previewed_again"


def test_the_same_expiry_is_written_once(db):
    clock = _Clock()
    store = PlanStore(ttl_seconds=60, clock=clock)
    plan = store.create("dup", _items())
    safety_log.record(db, "expired", plan)
    safety_log.record(db, "expired", plan)
    assert len(_events(db)) == 1


def test_installing_twice_listens_once(db):
    store = PlanStore(clock=_Clock())
    safety_log.install(lambda: db, store=store)
    safety_log.install(lambda: db, store=store)
    assert len(store._listeners) == 1


def test_a_broken_database_costs_only_the_event():
    class _Broken:
        def _get_connection(self):
            raise RuntimeError("disk gone")
    plan = PlanStore(clock=_Clock()).create("dup", _items())
    safety_log.record(_Broken(), "expired", plan)   # no exception


def test_dismiss_is_scoped_to_the_previewer_or_an_admin(db):
    store = PlanStore(clock=_Clock())
    for owner in (2, 3):
        plan = store.create("dup", _items())
        plan.owner = owner
        safety_log.record(db, "expired", plan)
    assert safety_log.dismiss(db, 1, profile_id=3, is_admin=False) is False
    assert safety_log.dismiss(db, 1, profile_id=2, is_admin=False) is True
    assert safety_log.dismiss(db, 2, profile_id=9, is_admin=True) is True
    assert [r["resolution"] for r in _events(db)] == ["dismissed", "dismissed"]
