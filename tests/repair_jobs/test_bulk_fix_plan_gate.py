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


# ── "Fix selected": a ticked selection goes through the same plan ───────────
#
# The findings list used to loop the single-finding fix endpoint over every
# ticked row, so one prompt about orphans moved or deleted every selected
# file with no preview. A selection is now previewed with the action chosen
# for each kind (fix_actions) and confirmed by plan id.


class _Cfg:
    def __init__(self, **values):
        self._values = {k.replace("__", "."): v for k, v in values.items()}

    def get(self, key, default=None):
        return self._values.get(key, default)


def _genre_id(db, n):
    _genre(db, n)
    with db._get_connection() as conn:
        return conn.execute(
            "SELECT id FROM repair_findings WHERE entity_id = ? AND finding_type = 'genre_cleanup'",
            (f"AR{n}",)).fetchone()[0]


def _fake_lossless(db, worker, name):
    path = os.path.join(worker.transfer_folder, "Fake", name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"audio")
    with db._get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO repair_findings (job_id, finding_type, severity, status, entity_type, file_path, title) "
            "VALUES ('fake_lossless_detector', 'fake_lossless', 'warning', 'pending', 'file', ?, ?)",
            (path, f"Fake lossless: {name}"))
        conn.commit()
        return cur.lastrowid, path


def test_fix_selected_with_a_destructive_type_is_refused_without_a_plan(env):
    db, worker, client = env
    orphan_id, path = _orphan(db, worker, "o.mp3")
    genre_id = _genre_id(db, 1)

    res = client.post("/api/repair/findings/bulk-fix-start",
                      json={"ids": [orphan_id, genre_id], "fix_actions": {"orphan_file": "delete"}})

    assert res.status_code == 409
    body = res.get_json()
    assert body["code"] == "plan_required" and body["plan"]["destructive"] == 1
    assert os.path.isfile(path)
    assert _pending(db) == 2


def test_fix_selected_preview_lists_each_item_and_what_happens(env):
    db, worker, client = env
    orphan_id, path = _orphan(db, worker, "o.mp3")
    genre_id = _genre_id(db, 1)

    body = client.post("/api/repair/findings/bulk-fix-preview",
                       json={"ids": [orphan_id, genre_id],
                             "fix_actions": {"orphan_file": "delete"}}).get_json()

    assert body["success"] is True and body["total"] == 2 and body["plan_id"]
    assert body["destructive"] == 1
    assert body["recycle_deletes"] is True
    assert body["by_effect"] == {"recycle": 1, "write": 1}
    items = {i["finding_id"]: i for i in body["sample"]}
    assert items[orphan_id]["path"] == path
    assert items[orphan_id]["action"] == "delete"
    assert items[orphan_id]["effect"] == "Moves the file to the recycle bin"
    assert items[orphan_id]["destructive"] is True
    assert items[genre_id]["effect"] == "Clean Genres"
    assert items[genre_id]["destructive"] is False
    assert os.path.isfile(path) and _pending(db) == 2      # changed nothing


def test_fix_selected_confirm_applies_exactly_the_plan_with_each_kinds_action(env):
    db, worker, client = env
    orphan_id, path = _orphan(db, worker, "picked.mp3")
    genre_id = _genre_id(db, 1)
    _unticked_id, unticked = _orphan(db, worker, "unticked.mp3")
    preview = client.post("/api/repair/findings/bulk-fix-preview",
                          json={"ids": [orphan_id, genre_id],
                                "fix_actions": {"orphan_file": "delete"}}).get_json()

    # whatever else the confirm says, only the plan's ids and actions count
    res = client.post("/api/repair/findings/bulk-fix-start",
                      json={"plan_id": preview["plan_id"], "ids": [_unticked_id],
                            "fix_actions": {"orphan_file": "staging"}})

    assert res.status_code == 200 and res.get_json()["started"] is True
    status = _wait(worker)
    # the orphan only fixes when it gets the previewed 'delete' for its type
    assert status["fixed"] == 2 and status["failed"] == 0
    assert not os.path.exists(path)
    assert os.path.isfile(unticked)
    assert list_entries(worker.transfer_folder)["count"] == 1
    assert _pending(db) == 1


def test_fix_selected_without_destructive_types_runs_without_a_plan(env):
    db, worker, client = env
    ids = [_genre_id(db, i) for i in range(2)]
    res = client.post("/api/repair/findings/bulk-fix-start", json={"ids": ids, "fix_actions": {}})
    assert res.status_code == 200 and res.get_json()["started"] is True
    assert _wait(worker)["fixed"] == 2


def test_preview_says_permanent_when_recycling_is_off(env):
    db, worker, client = env
    orphan_id, _path = _orphan(db, worker, "o.mp3")
    worker._config_manager = _Cfg(library__recycle_deletes=False)

    body = client.post("/api/repair/findings/bulk-fix-preview",
                       json={"ids": [orphan_id], "fix_actions": {"orphan_file": "delete"}}).get_json()

    assert body["recycle_deletes"] is False
    assert body["by_effect"] == {"delete": 1}
    assert body["sample"][0]["effect"] == "Deletes the file permanently"


def test_one_action_and_per_type_actions_together_are_refused(env):
    db, worker, client = env
    orphan_id, path = _orphan(db, worker, "o.mp3")
    for url in ("/api/repair/findings/bulk-fix-preview", "/api/repair/findings/bulk-fix-start"):
        res = client.post(url, json={"ids": [orphan_id], "fix_action": "delete",
                                     "fix_actions": {"orphan_file": "delete"}})
        assert res.status_code == 400, url
    bad = client.post("/api/repair/findings/bulk-fix-start",
                      json={"ids": [orphan_id], "fix_actions": ["delete"]})
    assert bad.status_code == 400
    assert os.path.isfile(path)


def test_an_explicit_delete_needs_a_plan_even_on_a_type_that_defaults_to_safe(env):
    db, worker, client = env
    fid, path = _fake_lossless(db, worker, "fake.flac")
    for body in ({"finding_type": "fake_lossless", "fix_action": "delete"},
                 {"ids": [fid], "fix_actions": {"fake_lossless": "delete"}}):
        res = client.post("/api/repair/findings/bulk-fix-start", json=body)
        assert res.status_code == 409, body
        assert res.get_json()["plan"]["sample"][0]["effect"] == (
            "Moves the file to the recycle bin and removes the track")
    assert os.path.isfile(path)


@pytest.mark.parametrize("ftype,action,recycle,expected", [
    ("orphan_file", "staging", True, ("Moves the file to Staging, where you can review and import it", "move")),
    ("orphan_file", "delete", False, ("Deletes the file permanently", "delete")),
    ("duplicate_tracks", None, False, ("Keeps the best copy and moves the others to the recycle bin", "recycle")),
    ("expired_download", None, True, ("Deletes the file permanently and removes the track", "delete")),
    ("corrupt_audio", None, False,
     ("Moves the damaged file to the recycle bin and re-downloads the track", "recycle")),
    ("quality_upgrade", None, True, ("Adds the better version to the wishlist. The current file stays", "write")),
    ("empty_folder", None, True, ("Deletes the empty folder and any junk files left in it", "folder")),
])
def test_bulk_fix_effect_mirrors_what_each_fixer_does(ftype, action, recycle, expected):
    from core.repair_worker import bulk_fix_effect
    assert bulk_fix_effect(ftype, action, recycle) == expected
