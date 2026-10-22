"""Emptying the video recycle bin only happens against a fresh preview plan.

POST /api/video/downloads/recycle/purge-preview lists what would be deleted for
good (count, size, oldest and newest date, a sample) and deletes nothing;
/downloads/recycle/purge deletes exactly that plan's entries, given its
plan_id, and answers 409 with a code without one. The daily age-based purge is
the user's own setting and is not touched here.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from flask import Flask

from core.library.action_plans import plan_store
from core.video import recycle
from database.video_database import VideoDatabase


@pytest.fixture()
def env(tmp_path, monkeypatch):
    import api.video as videoapi
    db = VideoDatabase(database_path=str(tmp_path / "video_library.db"))
    db.set_setting("movies_path", str(tmp_path / "Movies"))
    monkeypatch.setattr(videoapi, "_video_db", db)
    app = Flask(__name__)

    @app.before_request
    def _stamp():
        from flask import g
        g.is_admin = True
        g.allowed_sides = "both"

    app.register_blueprint(videoapi.create_video_blueprint(), url_prefix="/api/video")
    plan_store.clear()
    yield db, app.test_client(), tmp_path
    plan_store.clear()


def _bin(db, tmp_path, name, content=b"movie"):
    from core.video import organization
    f = tmp_path / "Movies" / Path(name).stem / name
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(content)
    res = recycle.discard(str(f), organization.load(db), db, reason="test")
    assert res["recycled"]
    return Path(res["trash_path"])


def _entries(client):
    return client.get("/api/video/downloads/recycle").get_json()["items"]


def _preview(client, body):
    r = client.post("/api/video/downloads/recycle/purge-preview", json=body)
    assert r.status_code == 200
    return r.get_json()


def test_the_preview_says_how_many_how_big_and_deletes_nothing(env):
    db, client, tmp = env
    _bin(db, tmp, "Heat (1995).mkv", b"1234")
    _bin(db, tmp, "Ronin (1998).mkv", b"123456")

    plan = _preview(client, {"all": True})

    assert plan["success"] is True and plan["plan_id"]
    assert plan["tool"] == "video_recycle_purge"
    assert plan["files"] == 2 and plan["total"] == 2
    assert plan["total_bytes"] == 10
    assert plan["oldest"] and plan["newest"]
    assert {i["name"] for i in plan["sample"]} == {"Heat (1995).mkv", "Ronin (1998).mkv"}
    assert all(i["path"].endswith(".mkv") for i in plan["sample"])      # where it came from
    assert plan["recycle_enabled"] is True
    assert plan["expires_at"] > plan["created_at"]
    assert len(_entries(client)) == 2                                    # nothing deleted


def test_a_fresh_plan_deletes_exactly_its_entries(env):
    db, client, tmp = env
    a = _bin(db, tmp, "Heat (1995).mkv")
    b = _bin(db, tmp, "Ronin (1998).mkv")
    plan = _preview(client, {"all": True})
    late = _bin(db, tmp, "Thief (1981).mkv")                             # binned after the preview

    r = client.post("/api/video/downloads/recycle/purge", json={"plan_id": plan["plan_id"]})

    assert r.status_code == 200
    body = r.get_json()
    assert sorted(body["purged"]) == sorted([a.name, b.name])
    assert body["freed_bytes"] == 10
    assert not a.exists() and not b.exists()
    assert late.exists()
    assert [e["name"] for e in _entries(client)] == [late.name]


def test_an_entry_that_changed_since_the_preview_is_kept(env):
    db, client, tmp = env
    a = _bin(db, tmp, "Heat (1995).mkv")
    b = _bin(db, tmp, "Ronin (1998).mkv")
    plan = _preview(client, {"all": True})
    b.write_bytes(b"a different, bigger file")

    body = client.post("/api/video/downloads/recycle/purge", json={"plan_id": plan["plan_id"]}).get_json()

    assert body["purged"] == [a.name] and body["skipped"] == [b.name]
    assert b.exists()


def test_choosing_entries_previews_and_deletes_only_those(env):
    db, client, tmp = env
    a = _bin(db, tmp, "Heat (1995).mkv")
    b = _bin(db, tmp, "Ronin (1998).mkv")
    plan = _preview(client, {"entries": [{"trash_dir": str(a.parent), "name": a.name}]})
    assert plan["files"] == 1 and plan["sample"][0]["entry"] == a.name

    client.post("/api/video/downloads/recycle/purge", json={"plan_id": plan["plan_id"]})

    assert not a.exists() and b.exists()


@pytest.mark.parametrize("body", [
    {}, {"all": True}, {"trash_dir": "x", "name": "y"},
])
def test_without_a_plan_nothing_is_deleted(env, body):
    db, client, tmp = env
    a = _bin(db, tmp, "Heat (1995).mkv")
    if "trash_dir" in body:
        body = {"trash_dir": str(a.parent), "name": a.name}

    r = client.post("/api/video/downloads/recycle/purge", json=body)

    assert r.status_code == 409
    assert r.get_json()["code"] == "plan_required"
    assert a.exists()


def test_unknown_expired_and_wrong_tool_plans_are_refused(env):
    db, client, tmp = env
    a = _bin(db, tmp, "Heat (1995).mkv")

    unknown = client.post("/api/video/downloads/recycle/purge", json={"plan_id": "nope"})
    assert unknown.status_code == 409 and unknown.get_json()["code"] == "plan_unknown"

    other = plan_store.create("recycle_bin_purge", [{"id": "x"}])
    wrong = client.post("/api/video/downloads/recycle/purge", json={"plan_id": other.plan_id})
    assert wrong.status_code == 409 and wrong.get_json()["code"] == "plan_wrong_tool"

    plan = _preview(client, {"all": True})
    plan_store.peek(plan["plan_id"], recycle.VIDEO_RECYCLE_PURGE_TOOL).expires_at = time.time() - 1
    expired = client.post("/api/video/downloads/recycle/purge", json={"plan_id": plan["plan_id"]})
    assert expired.status_code == 409 and expired.get_json()["code"] == "plan_expired"
    assert a.exists()


def test_a_plan_is_spent_by_its_purge(env):
    db, client, tmp = env
    _bin(db, tmp, "Heat (1995).mkv")
    plan = _preview(client, {"all": True})
    assert client.post("/api/video/downloads/recycle/purge", json={"plan_id": plan["plan_id"]}).status_code == 200
    _bin(db, tmp, "Ronin (1998).mkv")

    again = client.post("/api/video/downloads/recycle/purge", json={"plan_id": plan["plan_id"]})

    assert again.status_code == 409 and again.get_json()["code"] == "plan_unknown"
    assert len(_entries(client)) == 1


def test_an_empty_bin_has_nothing_to_confirm(env):
    _db, client, _tmp = env
    plan = _preview(client, {"all": True})
    assert plan["plan_id"] is None and plan["files"] == 0


def test_the_preview_needs_a_scope(env):
    _db, client, _tmp = env
    assert client.post("/api/video/downloads/recycle/purge-preview", json={}).status_code == 400
    assert client.post("/api/video/downloads/recycle/purge-preview", json={"entries": []}).status_code == 400


def test_a_path_outside_the_bin_is_never_listed(env):
    db, client, tmp = env
    victim = tmp / "Movies" / "Keep (2000)" / "Keep (2000).mkv"
    victim.parent.mkdir(parents=True)
    victim.write_bytes(b"keep")
    plan = _preview(client, {"entries": [{"trash_dir": str(victim.parent), "name": victim.name}]})
    assert plan["plan_id"] is None
    assert victim.exists()


def _gated_client(tmp_path, monkeypatch, *, is_admin, sides):
    import api.video as videoapi
    db = VideoDatabase(database_path=str(tmp_path / "gate.db"))
    monkeypatch.setattr(videoapi, "_video_db", db)
    app = Flask(__name__)

    @app.before_request
    def _stamp():
        from flask import g
        g.is_admin = is_admin
        g.allowed_sides = sides

    app.register_blueprint(videoapi.create_video_blueprint(), url_prefix="/api/video")
    return app.test_client()


def test_the_new_routes_keep_the_bins_side_gate(tmp_path, monkeypatch):
    """Same gate as the bin's other routes: a music-only profile gets nothing
    from the video side; a video profile may empty the bin, as it always could."""
    music_only = _gated_client(tmp_path, monkeypatch, is_admin=False, sides="music")
    for path in ("/api/video/downloads/recycle/purge-preview", "/api/video/downloads/recycle/purge",
                 "/api/video/downloads/recycle"):
        method = music_only.get if path.endswith("recycle") else music_only.post
        assert method(path, json={"all": True}).status_code == 403
    video = _gated_client(tmp_path, monkeypatch, is_admin=False, sides="video")
    assert video.post("/api/video/downloads/recycle/purge-preview", json={"all": True}).status_code == 200
