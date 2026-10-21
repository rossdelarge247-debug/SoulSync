"""Bulk fixes that move or delete files need a confirmed preview.

"Fix All" over orphan files, duplicates, unwanted content and the other
DESTRUCTIVE_FINDING_TYPES used to act the moment it was clicked. Now the API
refuses such a run without a plan id (and hands back the preview), and a
confirmed plan fixes exactly the previewed findings with the previewed action.
Harmless selections (safe_only, tag/genre fixes) run as before.
"""

from __future__ import annotations

import json
import os
import time

import pytest
from flask import Flask

import api.repair as repair_api
from core.library.action_plans import plan_store
from core.library.deleted_quarantine import list_entries
from core.repair_worker import RepairWorker
from database.music_database import MusicDatabase


@pytest.fixture()
def env(tmp_path):
    db = MusicDatabase(str(tmp_path / "m.db"))
    worker = RepairWorker(database=db)
    worker._config_manager = None
    worker.transfer_folder = str(tmp_path / "Transfer")
    os.makedirs(worker.transfer_folder)
    app = Flask(__name__)
    repair_api.configure(worker_getter=lambda: worker, image_url_fixer=lambda u: u, metadata_cache=lambda: None)
    app.register_blueprint(repair_api.create_blueprint())
    plan_store.clear()
    yield db, worker, app.test_client()
    plan_store.clear()


def _orphan(db, worker, name):
    path = os.path.join(worker.transfer_folder, "Loose", name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"audio")
    with db._get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO repair_findings (job_id, finding_type, severity, status, entity_type, file_path, title) "
            "VALUES ('orphan_file_detector', 'orphan_file', 'warning', 'pending', 'file', ?, ?)",
            (path, f"Orphan file: {name}"))
        conn.commit()
        return cur.lastrowid, path


def _genre(db, n):
    with db._get_connection() as conn:
        conn.execute("INSERT INTO artists (id, name, genres, server_source) VALUES (?, ?, ?, 'test')",
                     (f"AR{n}", f"Artist {n}", json.dumps(["Rock", "junk"])))
        conn.execute(
            "INSERT INTO repair_findings (job_id, finding_type, severity, status, entity_type, entity_id, "
            "title, details_json) VALUES ('genre_cleanup', 'genre_cleanup', 'info', 'pending', 'artist', ?, ?, ?)",
            (f"AR{n}", f"Off-whitelist genres: Artist {n}",
             json.dumps({"kept_genres": ["Rock"], "removed_genres": ["junk"]})))
        conn.commit()


def _wait(worker):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if not worker.get_bulk_fix_status().get("running"):
            return worker.get_bulk_fix_status()
        time.sleep(0.02)
    raise AssertionError("bulk fix did not finish")


def _pending(db):
    with db._get_connection() as conn:
        return conn.execute("SELECT COUNT(*) FROM repair_findings WHERE status = 'pending'").fetchone()[0]


def test_fix_all_on_destructive_findings_without_a_plan_is_refused(env):
    db, worker, client = env
    paths = [_orphan(db, worker, f"o{i}.mp3")[1] for i in range(2)]

    res = client.post("/api/repair/findings/bulk-fix-start",
                      json={"job_id": "orphan_file_detector", "fix_action": "delete"})

    assert res.status_code == 409
    body = res.get_json()
    assert body["plan_required"] is True and body["started"] is False
    plan = body["plan"]
    assert plan["total"] == 2 and plan["destructive"] == 2
    assert plan["counts"] == {"delete": 2}
    assert sorted(i["path"] for i in plan["sample"]) == sorted(paths)
    assert all(i["reason"].startswith("Orphan file:") for i in plan["sample"])
    assert all(os.path.isfile(p) for p in paths)       # nothing touched
    assert _pending(db) == 2


def test_the_synchronous_bulk_fix_is_gated_too(env):
    db, worker, client = env
    _fid, path = _orphan(db, worker, "o.mp3")
    res = client.post("/api/repair/findings/bulk-fix", json={"ids": [_fid], "fix_action": "delete"})
    assert res.status_code == 409
    assert os.path.isfile(path)


def test_a_confirmed_plan_fixes_exactly_the_previewed_findings(env):
    db, worker, client = env
    previewed = [_orphan(db, worker, f"o{i}.mp3")[1] for i in range(2)]
    preview = client.post("/api/repair/findings/bulk-fix-preview",
                          json={"job_id": "orphan_file_detector", "fix_action": "delete"}).get_json()
    assert preview["success"] is True and preview["total"] == 2
    _late_id, late = _orphan(db, worker, "late.mp3")    # raised after the preview

    res = client.post("/api/repair/findings/bulk-fix-start",
                      json={"plan_id": preview["plan_id"], "job_id": "something-else"})

    assert res.status_code == 200 and res.get_json()["started"] is True
    status = _wait(worker)
    assert status["fixed"] == 2
    assert not any(os.path.exists(p) for p in previewed)
    assert os.path.isfile(late)                         # not in the plan
    assert list_entries(worker.transfer_folder)["count"] == 2   # recycle bin
    assert _pending(db) == 1


def test_a_plan_is_spent_by_its_run(env):
    db, worker, client = env
    _orphan(db, worker, "o.mp3")
    preview = client.post("/api/repair/findings/bulk-fix-preview",
                          json={"job_id": "orphan_file_detector", "fix_action": "delete"}).get_json()
    assert client.post("/api/repair/findings/bulk-fix-start", json={"plan_id": preview["plan_id"]}).status_code == 200
    _wait(worker)

    again = client.post("/api/repair/findings/bulk-fix-start", json={"plan_id": preview["plan_id"]})
    assert again.status_code == 409
    assert again.get_json()["code"] == "plan_unknown"


def test_preview_changes_nothing(env):
    db, worker, client = env
    paths = [_orphan(db, worker, f"o{i}.mp3")[1] for i in range(3)]
    client.post("/api/repair/findings/bulk-fix-preview", json={"job_id": "orphan_file_detector"})
    assert all(os.path.isfile(p) for p in paths)
    assert _pending(db) == 3


def test_harmless_fix_all_still_runs_without_a_plan(env):
    db, worker, client = env
    for i in range(3):
        _genre(db, i)
    _orphan(db, worker, "o.mp3")

    res = client.post("/api/repair/findings/bulk-fix-start", json={"safe_only": True})
    assert res.status_code == 200 and res.get_json()["started"] is True
    assert _wait(worker)["fixed"] == 3

    for i in range(3, 5):
        _genre(db, i)
    res = client.post("/api/repair/findings/bulk-fix-start", json={"job_id": "genre_cleanup"})
    assert res.status_code == 200
    assert _wait(worker)["fixed"] == 2
