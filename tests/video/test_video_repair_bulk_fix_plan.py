"""Video repair bulk fixes that move or delete files need a confirmed preview.

Watched Cleanup recycles (or, with recycling off, deletes) a movie's files and
Naming Conformance renames them. A bulk fix that includes either is refused
without a plan id (the preview comes back attached); a confirmed plan fixes
exactly the previewed findings and nothing else. Fixes that only touch the
wishlist or the library record run straight away, as on the music side.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest
from flask import Flask

from core.library.action_plans import plan_store
from core.video.repair import worker as worker_mod
from core.video.repair.worker import VIDEO_REPAIR_BULK_FIX_TOOL, VideoRepairWorker
from database.video_database import VideoDatabase


@pytest.fixture()
def env(tmp_path, monkeypatch):
    import api.video as videoapi
    db = VideoDatabase(database_path=str(tmp_path / "video_library.db"))
    db.set_setting("movies_path", str(tmp_path / "Movies"))
    monkeypatch.setattr(videoapi, "_video_db", db)
    monkeypatch.setattr(worker_mod, "_worker", VideoRepairWorker(db))
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


def _watched(db, tmp_path, title):
    """A watched movie on disk with its Watched Cleanup finding."""
    mid = db.upsert_movie("plex", {"server_id": "sv-" + title, "title": title, "year": 2020,
                                   "tmdb_id": abs(hash(title)) % 10 ** 6})
    real = tmp_path / "Movies" / title / f"{title}.mkv"
    real.parent.mkdir(parents=True, exist_ok=True)
    real.write_bytes(b"x" * 16)
    conn = db._get_connection()
    conn.execute("INSERT INTO media_files (movie_id, relative_path, size_bytes) VALUES (?,?,?)",
                 (mid, str(real), 16))
    conn.execute("UPDATE movies SET has_file=1 WHERE id=?", (mid,))
    conn.commit()
    conn.close()
    db.repair_create_finding("watched_cleanup", "watched_cleanup", entity_type="movie",
                             entity_id=f"m:{mid}", title=f"{title} — watched 90 days ago",
                             details={"movie_id": mid, "title": title, "relative_path": str(real),
                                      "size_bytes": 16})
    return _id_of(db, "watched_cleanup", f"m:{mid}"), real


def _naming(db, tmp_path, name):
    cur = tmp_path / "Movies" / "old" / f"{name}.mkv"
    cur.parent.mkdir(parents=True, exist_ok=True)
    cur.write_bytes(b"y" * 8)
    want = tmp_path / "Movies" / name / f"{name} (2020).mkv"
    db.repair_create_finding("naming_conformance", "naming_mismatch", entity_type="file",
                             entity_id=name, title=f"{name}: name differs",
                             details={"current_path": str(cur), "expected_path": str(want),
                                      "size_bytes": 8})
    return _id_of(db, "naming_mismatch", name), cur, want


def _collection(db, n):
    db.repair_create_finding("movie_collections", "incomplete_collection", entity_type="collection",
                             entity_id=f"c{n}", title=f"Collection {n}: 1 missing",
                             details={"name": f"Collection {n}",
                                      "missing": [{"tmdb_id": 9000 + n, "title": f"Film {n}", "year": 2001}]})
    return _id_of(db, "incomplete_collection", f"c{n}")


def _id_of(db, ftype, entity_id):
    for f in db.repair_get_findings(limit=200)["items"]:
        if f["finding_type"] == ftype and f["entity_id"] == str(entity_id):
            return f["id"]
    raise AssertionError("finding not created")


def _status(db, fid):
    return db.repair_get_finding(fid)["status"]


def test_a_bulk_fix_over_watched_cleanup_without_a_plan_is_refused(env):
    db, client, tmp = env
    fid, real = _watched(db, tmp, "Heat")

    r = client.post("/api/video/repair/findings/bulk-fix", json={"ids": [fid]})

    assert r.status_code == 409
    body = r.get_json()
    assert body["code"] == "plan_required" and body["plan_required"] is True
    plan = body["plan"]
    assert plan["total"] == 1 and plan["destructive"] == 1
    assert plan["by_effect"] == {"recycle": 1}
    assert plan["sample"][0]["effect"].startswith("Moves the movie's file to the recycle bin")
    assert real.exists() and _status(db, fid) == "pending"


def test_a_job_wide_fix_that_includes_renames_is_refused_too(env):
    db, client, tmp = env
    fid, cur, want = _naming(db, tmp, "Ronin")
    r = client.post("/api/video/repair/findings/bulk-fix", json={"job_id": "naming_conformance"})
    assert r.status_code == 409 and r.get_json()["code"] == "plan_required"
    assert cur.exists() and not want.exists()


def test_the_preview_says_what_happens_to_each_file_and_changes_nothing(env):
    db, client, tmp = env
    w, real = _watched(db, tmp, "Heat")
    n, cur, want = _naming(db, tmp, "Ronin")
    c = _collection(db, 1)

    plan = client.post("/api/video/repair/findings/bulk-fix-preview", json={"ids": [w, n, c]}).get_json()

    assert plan["success"] is True and plan["plan_id"] and plan["tool"] == VIDEO_REPAIR_BULK_FIX_TOOL
    assert plan["total"] == 3 and plan["destructive"] == 2
    assert plan["by_effect"] == {"recycle": 1, "move": 1, "write": 1}
    # the files those fixes touch, for the confirm's "2 files deleted for good"
    assert plan["files_by_effect"] == {"recycle": 1, "move": 1}
    assert plan["recycle_deletes"] is True
    effects = {i["finding_id"]: i for i in plan["sample"]}
    assert effects[w]["path"] == str(real) and effects[w]["size"] == 16
    assert effects[n]["effect"] == "Renames the file to Ronin (2020).mkv, with its sidecars. Nothing is deleted"
    assert effects[c]["effect"] == "Adds the missing films to the wishlist"
    assert real.exists() and cur.exists()
    assert all(_status(db, i) == "pending" for i in (w, n, c))


def test_with_recycling_off_the_preview_says_the_delete_is_permanent(env):
    db, client, tmp = env
    from core.video import organization
    organization.save(db, {**organization.load(db), "recycle_deletes": False})
    w, _real = _watched(db, tmp, "Heat")
    plan = client.post("/api/video/repair/findings/bulk-fix-preview", json={"ids": [w]}).get_json()
    assert plan["recycle_deletes"] is False and plan["by_effect"] == {"delete": 1}
    assert "permanently" in plan["sample"][0]["effect"]
    assert plan["files_by_effect"] == {"delete": 1} and plan["sample"][0]["files"] == 1


def test_the_preview_counts_every_file_a_delete_takes(env):
    """A movie with two files on disk is one finding and two files deleted."""
    db, client, tmp = env
    from core.video import organization
    organization.save(db, {**organization.load(db), "recycle_deletes": False})
    w, real = _watched(db, tmp, "Heat")
    extra = real.with_name("Heat (Director's Cut).mkv")
    extra.write_bytes(b"z" * 4)
    mid = db.repair_get_finding(w)["details"]["movie_id"]
    conn = db._get_connection()
    conn.execute("INSERT INTO media_files (movie_id, relative_path, size_bytes) VALUES (?,?,?)",
                 (mid, str(extra), 4))
    conn.commit()
    conn.close()
    plan = client.post("/api/video/repair/findings/bulk-fix-preview", json={"ids": [w]}).get_json()
    assert plan["by_effect"] == {"delete": 1}
    assert plan["files_by_effect"] == {"delete": 2}
    assert plan["sample"][0]["files"] == 2 and "2 files" in plan["sample"][0]["effect"]
    assert real.exists() and extra.exists()


def test_a_fresh_plan_fixes_exactly_the_previewed_findings(env):
    db, client, tmp = env
    w, real = _watched(db, tmp, "Heat")
    n, cur, want = _naming(db, tmp, "Ronin")
    plan = client.post("/api/video/repair/findings/bulk-fix-preview", json={"ids": [w, n]}).get_json()
    late, late_real = _watched(db, tmp, "Thief")                     # raised after the preview

    r = client.post("/api/video/repair/findings/bulk-fix",
                    json={"plan_id": plan["plan_id"], "ids": [late], "job_id": "watched_cleanup"})

    assert r.status_code == 200
    body = r.get_json()
    assert body["fixed"] == 2 and body["total"] == 2
    assert not real.exists() and (tmp / "Movies" / "ss_recycle").is_dir()   # recycled, not unlinked
    assert want.exists() and not cur.exists()
    assert late_real.exists() and _status(db, late) == "pending"


def test_a_plan_is_spent_and_belongs_to_its_tool(env):
    db, client, tmp = env
    w, _real = _watched(db, tmp, "Heat")
    url = "/api/video/repair/findings/bulk-fix"
    plan = client.post("/api/video/repair/findings/bulk-fix-preview", json={"ids": [w]}).get_json()
    assert client.post(url, json={"plan_id": plan["plan_id"]}).status_code == 200

    again = client.post(url, json={"plan_id": plan["plan_id"]})
    assert again.status_code == 409 and again.get_json()["code"] == "plan_unknown"

    w2, real2 = _watched(db, tmp, "Ronin")
    other = plan_store.create("repair_bulk_fix", [{"finding_id": w2}], meta={"ids": [w2]})
    wrong = client.post(url, json={"plan_id": other.plan_id})
    assert wrong.status_code == 409 and wrong.get_json()["code"] == "plan_wrong_tool"
    assert client.post(url, json={"plan_id": "nope"}).get_json()["code"] == "plan_unknown"

    plan = client.post("/api/video/repair/findings/bulk-fix-preview", json={"ids": [w2]}).get_json()
    plan_store.peek(plan["plan_id"], VIDEO_REPAIR_BULK_FIX_TOOL).expires_at = time.time() - 1
    expired = client.post(url, json={"plan_id": plan["plan_id"]})
    assert expired.status_code == 409 and expired.get_json()["code"] == "plan_expired"
    assert real2.exists() and _status(db, w2) == "pending"


def test_fixes_that_only_touch_the_wishlist_still_run_straight_away(env):
    db, client, _tmp = env
    c1, c2 = _collection(db, 1), _collection(db, 2)
    r = client.post("/api/video/repair/findings/bulk-fix", json={"ids": [c1, c2]})
    assert r.status_code == 200 and r.get_json()["fixed"] == 2


def test_the_single_finding_fix_is_unchanged(env):
    """One click on one finding is not a bulk run (the music rule)."""
    db, client, tmp = env
    w, real = _watched(db, tmp, "Heat")
    r = client.post(f"/api/video/repair/findings/{w}/fix", json={})
    assert r.status_code == 200 and not real.exists()


def test_the_preview_is_admin_only_like_the_rest_of_video_repair(tmp_path, monkeypatch):
    import api.video as videoapi
    monkeypatch.setattr(videoapi, "_video_db", VideoDatabase(database_path=str(tmp_path / "g.db")))
    app = Flask(__name__)

    @app.before_request
    def _stamp():
        from flask import g
        g.is_admin = False
        g.allowed_sides = "both"

    app.register_blueprint(videoapi.create_video_blueprint(), url_prefix="/api/video")
    c = app.test_client()
    assert c.post("/api/video/repair/findings/bulk-fix-preview", json={"ids": [1]}).status_code == 403
    assert c.post("/api/video/repair/findings/bulk-fix", json={"plan_id": "x"}).status_code == 403
