"""HTTP surface of the preview-then-confirm flow (duplicate cleaner, Deep Scan)."""

from __future__ import annotations

from unittest.mock import patch

import pytest

from core.library.action_plans import plan_store


class _Executor:
    def __init__(self):
        self.calls = []

    def submit(self, fn, *args, **kwargs):
        self.calls.append(args)


@pytest.fixture()
def client(monkeypatch):
    from core.security import session_profile as _sp
    from api import database_admin as da
    _resolve = _sp.resolve_session_profile
    with patch.object(_sp, "resolve_session_profile",
                      lambda **kw: _resolve(**{**kw, "profile_count": 1})), \
            patch("web_server.add_activity_item"):
        import web_server
        executor = _Executor()
        monkeypatch.setattr(web_server, "duplicate_cleaner_executor", executor)
        web_server.duplicate_cleaner_state["status"] = "idle"
        web_server.app.config["TESTING"] = True
        plan_store.clear()
        # A Deep Scan started here bumps db_update_state's run_epoch with no
        # worker to match it, and _db_update_finished_callback then drops
        # every later callback on this xdist worker as a superseded run.
        with da.db_update_lock:
            saved_state = dict(da.db_update_state)
        saved_epoch = da._active_task_epoch
        yield web_server.app.test_client(), executor, web_server
        with da.db_update_lock:
            da.db_update_state.clear()
            da.db_update_state.update(saved_state)
        da._active_task_epoch = saved_epoch
        web_server.duplicate_cleaner_state["status"] = "idle"
        plan_store.clear()


def test_start_without_a_plan_only_previews(client):
    http, executor, ws = client
    res = http.post("/api/duplicate-cleaner/start", json={})
    assert res.status_code == 200
    body = res.get_json()
    assert body["mode"] == "plan"
    assert executor.calls == [(None,)]            # worker runs with no plan id = preview
    assert ws.duplicate_cleaner_state["mode"] == "plan"


def test_start_with_an_unknown_plan_is_refused_before_anything_runs(client):
    http, executor, _ws = client
    res = http.post("/api/duplicate-cleaner/start", json={"plan_id": "nope"})
    assert res.status_code == 409
    assert res.get_json()["code"] == "plan_unknown"
    assert executor.calls == []


def test_start_with_a_fresh_plan_applies_it(client):
    http, executor, _ws = client
    from core.library.duplicate_cleaner import TOOL
    plan = plan_store.create(TOOL, [{"path": "/m/a.mp3", "keep": "/m/a.flac", "action": "recycle",
                                     "reason": "dup", "size": 3}])
    res = http.post("/api/duplicate-cleaner/start", json={"plan_id": plan.plan_id})
    assert res.status_code == 200 and res.get_json()["mode"] == "apply"
    assert executor.calls == [(plan.plan_id,)]


def test_plan_items_are_paged(client):
    http, _executor, _ws = client
    from core.library.duplicate_cleaner import TOOL
    items = [{"path": f"/m/{i}.mp3", "keep": f"/m/{i}.flac", "action": "recycle", "reason": "dup", "size": 1}
             for i in range(5)]
    plan = plan_store.create(TOOL, items)
    body = http.get(f"/api/duplicate-cleaner/plan?plan_id={plan.plan_id}&offset=2&limit=2").get_json()
    assert body["total"] == 5
    assert [i["path"] for i in body["items"]] == ["/m/2.mp3", "/m/3.mp3"]
    assert http.get("/api/duplicate-cleaner/plan?plan_id=missing").status_code == 404


# ── Deep Scan's confirm endpoint refuses what was not previewed ─────────────


def test_deep_scan_with_an_unknown_plan_is_refused(client):
    http, _executor, ws = client
    import api.database_admin as da
    submitted = []
    with patch.object(da, "db_update_executor") as ex:
        ex.submit.side_effect = lambda *a, **k: submitted.append((a, k))
        res = http.post("/api/database/update", json={"deep_scan": True, "plan_id": "stale"})
    assert res.status_code == 409
    assert res.get_json()["code"] == "plan_unknown"
    assert submitted == []


def test_deep_scan_large_move_plan_needs_its_confirmation(client):
    http, _executor, ws = client
    import api.database_admin as da
    from core.library.standalone_scan import DEEP_SCAN_TOOL
    plan = plan_store.create(DEEP_SCAN_TOOL, [{"path": "/t/a.flac", "action": "move_to_staging"}],
                             meta={"needs_confirmation": True})
    submitted = []
    with patch.object(da, "db_update_executor") as ex:
        ex.submit.side_effect = lambda *a, **k: submitted.append((a, k))
        res = http.post("/api/database/update", json={"deep_scan": True, "plan_id": plan.plan_id})
        assert res.status_code == 409
        assert res.get_json()["code"] == "confirm_large_move_required"
        assert submitted == []
        res = http.post("/api/database/update", json={"deep_scan": True, "plan_id": plan.plan_id,
                                                       "confirm_large_move": True})
    assert res.status_code == 200
    assert submitted and submitted[0][1] == {"plan_id": plan.plan_id, "allow_large_move": True}
    with da.db_update_lock:
        da.db_update_state["status"] = "idle"


def test_deep_scan_plan_items_are_paged_without_spending_the_plan(client):
    http, _executor, _ws = client
    from core.library.standalone_scan import DEEP_SCAN_TOOL
    items = [{"path": f"/t/{i}.flac", "dest": f"/s/{i}.flac", "action": "move_to_staging",
              "reason": "no database record for this file", "size": 1} for i in range(5)]
    plan = plan_store.create(DEEP_SCAN_TOOL, items)
    body = http.get(f"/api/database/deep-scan/plan?plan_id={plan.plan_id}&offset=3&limit=10").get_json()
    assert body["total"] == 5
    assert [i["path"] for i in body["items"]] == ["/t/3.flac", "/t/4.flac"]
    assert plan_store.peek(plan.plan_id, DEEP_SCAN_TOOL)          # still usable
    missing = http.get("/api/database/deep-scan/plan?plan_id=gone")
    assert missing.status_code == 404 and missing.get_json()["code"] == "plan_unknown"
