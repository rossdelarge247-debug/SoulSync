"""The preview-then-confirm plan store every destructive bulk tool shares.

A plan is the exact list a preview showed. These pin the properties the
tools lean on: a plan is single use, expires, belongs to one tool, and its
summary counts what is really in it.
"""

from __future__ import annotations

import pytest

from core.library.action_plans import (
    PLAN_EXPIRED,
    PLAN_MISSING,
    PLAN_UNKNOWN,
    PLAN_WRONG_TOOL,
    PlanError,
    PlanStore,
    automation_may_act,
    summarize_items,
)


class _Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now


def _items(n, action="recycle", reason="duplicate"):
    return [{"path": f"/m/{i}.mp3", "action": action, "reason": reason, "size": 10} for i in range(n)]


def test_summary_counts_and_samples_exactly_what_the_plan_holds():
    items = _items(3) + _items(2, action="move_to_staging", reason="not in database")
    summary = summarize_items(items, sample_size=4)
    assert summary["total"] == 5
    assert summary["counts"] == {"recycle": 3, "move_to_staging": 2}
    assert summary["by_reason"] == {"duplicate": 3, "not in database": 2}
    assert summary["total_bytes"] == 50
    assert len(summary["sample"]) == 4
    assert summary["truncated"] is True


def test_a_plan_is_single_use():
    store = PlanStore(clock=_Clock())
    plan = store.create("dup", _items(2))
    assert store.consume(plan.plan_id, "dup").items == plan.items
    with pytest.raises(PlanError) as err:
        store.consume(plan.plan_id, "dup")
    assert err.value.code == PLAN_UNKNOWN


def test_peek_does_not_spend_the_plan():
    store = PlanStore(clock=_Clock())
    plan = store.create("dup", _items(1))
    store.peek(plan.plan_id, "dup")
    assert store.consume(plan.plan_id, "dup").plan_id == plan.plan_id


def test_an_old_preview_cannot_authorise_today():
    clock = _Clock()
    store = PlanStore(ttl_seconds=60, clock=clock)
    plan = store.create("dup", _items(1))
    clock.now += 61
    with pytest.raises(PlanError) as err:
        store.consume(plan.plan_id, "dup")
    assert err.value.code in (PLAN_EXPIRED, PLAN_UNKNOWN)


def test_a_plan_only_authorises_its_own_tool():
    store = PlanStore(clock=_Clock())
    plan = store.create("dup", _items(1))
    with pytest.raises(PlanError) as err:
        store.consume(plan.plan_id, "deep_scan")
    assert err.value.code == PLAN_WRONG_TOOL
    # the refusal did not burn it for its real owner
    assert store.consume(plan.plan_id, "dup")


@pytest.mark.parametrize("plan_id", [None, "", 123])
def test_acting_without_a_plan_is_refused(plan_id):
    store = PlanStore(clock=_Clock())
    with pytest.raises(PlanError) as err:
        store.consume(plan_id, "dup")
    assert err.value.code == PLAN_MISSING
    assert "Preview" in err.value.message


def test_store_is_bounded():
    store = PlanStore(max_plans=2, clock=_Clock())
    first = store.create("dup", _items(1))
    store.create("dup", _items(1))
    store.create("dup", _items(1))
    with pytest.raises(PlanError):
        store.peek(first.plan_id, "dup")


def test_latest_returns_the_newest_plan_for_a_tool():
    store = PlanStore(clock=_Clock())
    store.create("dup", _items(1))
    newer = store.create("dup", _items(2))
    store.create("deep_scan", _items(3))
    assert store.latest("dup").plan_id == newer.plan_id


@pytest.mark.parametrize("config,expected", [
    (None, False),
    ({}, False),
    ({"confirm": False}, False),
    ({"confirm": "false"}, False),
    ({"confirm": "maybe"}, False),
    ({"confirm": 0}, False),
    ({"confirm": True}, True),
    ({"confirm": "true"}, True),
    ({"confirm": "on"}, True),
    ({"confirm": 1}, True),
])
def test_only_an_explicit_confirm_lets_an_automation_act(config, expected):
    assert automation_may_act(config) is expected
