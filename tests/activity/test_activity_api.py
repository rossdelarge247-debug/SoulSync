"""The Activity endpoints (api/activity.py) on a bare Flask app: argument
errors, who sees what, the plan sweep on read, logs and dismissing."""

from __future__ import annotations

import time

import pytest
from flask import Flask

import api.activity as activity_api
from core.activity import safety_log
from core.library.action_plans import PlanStore
from tests.activity.activity_rows import HOUR


@pytest.fixture
def client(db, monkeypatch):
    who = {"pid": 1, "admin": True}
    monkeypatch.setattr(activity_api, "get_current_profile_id", lambda: who["pid"])
    monkeypatch.setattr(activity_api, "is_admin_request", lambda: who["admin"])
    store = PlanStore()
    monkeypatch.setattr("core.library.action_plans.plan_store", store)
    monkeypatch.setattr(activity_api, "get_database", lambda: db)
    safety_log.install(lambda: db, store=store)
    app = Flask(__name__)
    app.register_blueprint(activity_api.bp)
    c = app.test_client()
    c.who = who
    c.store = store
    return c


def test_the_feed_answers_with_the_contract(client, rows):
    rows.history(ago=HOUR)
    r = client.get("/api/activity?range=30d")
    assert r.status_code == 200 and r.headers["Cache-Control"] == "no-store"
    body = r.get_json()
    assert body["success"] is True
    assert set(body) >= {"items", "next_before", "counts", "running_count", "needs_you", "range", "since", "kind"}
    assert body["items"][0]["kind"] == "download"


@pytest.mark.parametrize("query", ["range=forever", "kind=everything", "limit=lots", "before=%%%", "since=yesterday"])
def test_bad_arguments_are_a_400_with_a_sentence(client, query):
    r = client.get(f"/api/activity?{query}")
    assert r.status_code == 400
    assert r.get_json()["success"] is False and r.get_json()["error"]


def test_the_status_poll_returns_just_the_badges(client, rows):
    rows.auto_import(status="pending_review")
    plan = client.store.create("deep_scan", [{"path": "/a", "action": "move_to_staging"}])
    plan.expires_at = time.time() - 5           # lapsed: the poll records it too
    r = client.get("/api/activity/status")
    assert r.status_code == 200 and r.headers["Cache-Control"] == "no-store"
    body = r.get_json()
    assert set(body) == {"success", "running_count", "needs_you_count", "generated_at"}
    assert body["success"] is True and body["needs_you_count"] == 2 and body["running_count"] == 0


def test_no_profile_is_a_401(client):
    client.who["pid"] = None
    assert client.get("/api/activity").status_code == 401
    assert client.get("/api/activity/status").status_code == 401
    assert client.get("/api/activity/log/automation:1").status_code == 401
    assert client.post("/api/activity/dismiss", json={"id": "safety:1"}).status_code == 401


def test_a_member_without_the_import_page_sees_no_imports(client, db, rows):
    rows.auto_import(status="pending_review")
    blocked = db.create_profile(name="kid", allowed_pages=["search"])
    allowed = db.create_profile(name="teen", allowed_pages=["search", "import"])
    client.who.update(pid=blocked, admin=False)
    assert client.get("/api/activity").get_json()["needs_you"] == []
    client.who.update(pid=allowed, admin=False)
    assert len(client.get("/api/activity").get_json()["needs_you"]) == 1


def test_reading_the_feed_records_previews_that_lapsed(client):
    plan = client.store.create("duplicate_cleaner", [{"path": "/a", "action": "recycle", "size": 10}])
    plan.expires_at = time.time() - 5
    body = client.get("/api/activity").get_json()
    assert [i["title"] for i in body["needs_you"]] == ["Duplicate cleaner preview expired"]
    assert body["needs_you"][0]["time"] == int(plan.expires_at)


def test_dismissing_an_expired_preview_unpins_it(client, rows):
    event = rows.plan_event(ago=HOUR)
    r = client.post("/api/activity/dismiss", json={"id": f"safety:{event}"})
    assert r.status_code == 200 and r.get_json() == {"success": True, "id": f"safety:{event}"}
    assert client.get("/api/activity").get_json()["needs_you"] == []
    assert client.post("/api/activity/dismiss", json={"id": f"safety:{event}"}).status_code == 404


def test_only_previews_can_be_dismissed(client):
    r = client.post("/api/activity/dismiss", json={"id": "automation:3"})
    assert r.status_code == 400 and "dealt with" in r.get_json()["error"]


def test_a_member_cannot_dismiss_someone_elses_preview(client, rows):
    event = rows.plan_event(ago=HOUR, profile_id=1)
    client.who.update(pid=4, admin=False)
    assert client.post("/api/activity/dismiss", json={"id": f"safety:{event}"}).status_code == 404


def test_logs_come_one_item_at_a_time(client, rows):
    aid = rows.automation()
    run = rows.run(aid, log=[{"type": "error", "text": "slskd: no response in 10 s"}])
    r = client.get(f"/api/activity/log/automation:{run}")
    assert r.status_code == 200
    assert r.get_json()["log_lines"] == [{"type": "error", "text": "slskd: no response in 10 s"}]
    assert client.get("/api/activity/log/automation:999").status_code == 404
