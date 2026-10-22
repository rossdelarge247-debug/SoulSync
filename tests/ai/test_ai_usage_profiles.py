"""Settings → AI's usage per profile (HANDOFF 39).

Every request is counted for the install (the monthly cap reads that one
figure) and for the profile that asked (``ai_usage_profiles``). Admins get the
per-profile rows in GET /api/ai/settings; members never see them.
"""

from __future__ import annotations

import pytest

from core.ai import store

from .conftest import events, set_key


def _ask(client, message="Search Wanted every morning"):
    return client.post("/api/ai/assistant", json={"message": message, "context": {"page": "list"}})


def test_requests_are_counted_per_profile_and_for_the_install(db):
    kim = db.create_profile(name="kim")
    store.record_request(db, profile_id=1, input_tokens=10, cost_usd=0.4, month="2026-10")
    store.record_request(db, profile_id=kim, input_tokens=10, cost_usd=0.1, month="2026-10")
    store.record_request(db, profile_id=kim, input_tokens=10, cost_usd=0.2, month="2026-10")
    assert store.month_usage(db, "2026-10")["requests"] == 3
    per = store.profile_usage(db, "2026-10")
    # most expensive first
    assert per["rows"] == [
        {"profile_id": 1, "name": "Admin", "requests": 1, "estimated_cost_usd": pytest.approx(0.4)},
        {"profile_id": kim, "name": "kim", "requests": 2, "estimated_cost_usd": pytest.approx(0.3)},
    ]
    assert per["unattributed"] is None
    assert store.profile_usage(db, "2026-09")["rows"] == []


def test_requests_from_before_per_profile_counting_are_shown_apart(db):
    # a month that began before this release: the install's row has more
    store.record_request(db, cost_usd=0.5, month="2026-10")
    store.record_request(db, cost_usd=0.5, month="2026-10")
    store.record_request(db, profile_id=1, cost_usd=0.25, month="2026-10")
    per = store.profile_usage(db, "2026-10")
    assert [r["requests"] for r in per["rows"]] == [1]
    assert per["unattributed"] == {"requests": 2, "estimated_cost_usd": pytest.approx(1.0)}


def test_a_deleted_profiles_requests_stay_in_the_total(db):
    kim = db.create_profile(name="kim")
    store.record_request(db, profile_id=kim, cost_usd=0.3)
    assert db.delete_profile(kim)
    per = store.profile_usage(db)
    assert per["rows"] == []
    assert per["unattributed"]["requests"] == 1


def test_the_assistant_counts_the_asking_profile(client, config, db):
    set_key(config, who_can_use="everyone")
    kim = db.create_profile(name="kim")
    client.who.update(pid=kim, admin=False)
    events(_ask(client))
    events(_ask(client))
    client.who.update(pid=1, admin=True)
    events(_ask(client))
    rows = {r["profile_id"]: r["requests"] for r in store.profile_usage(db)["rows"]}
    assert rows == {kim: 2, 1: 1}
    assert store.month_usage(db)["requests"] == 3


def test_admins_get_the_rows_in_settings_members_get_nothing(client, config, db):
    set_key(config, who_can_use="everyone")
    kim = db.create_profile(name="kim")
    store.record_request(db, profile_id=kim, cost_usd=0.2)
    body = client.get("/api/ai/settings").get_json()
    assert body["usage"]["profiles"]["rows"][0]["name"] == "kim"
    assert body["usage"]["requests"] == 1
    client.who.update(pid=kim, admin=False)
    assert client.get("/api/ai/settings").status_code == 403
    status = client.get("/api/ai/status").get_json()
    assert "usage" not in status
