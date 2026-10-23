"""Look for releases you don't have (HANDOFF 68): which artists it asks about,
the background run (one at a time, stoppable, waiting out Spotify's pause,
asking again after a rate limit, giving up after refusals), what it found,
its rows in Activity and its routes."""

from __future__ import annotations

import json
import threading
import time

import pytest
from flask import Flask, g

from core.library import missing_releases as mr
from core.library import release_index as ri
from core.quality import presets


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _cached(db, entity_id, title, artist_name, *, artist_id=None, album_type="album"):
    _sql(db, "INSERT INTO metadata_cache_entities (source, entity_type, entity_id, name, artist_name, artist_id, "
             "album_type, total_tracks, release_date, raw_json) VALUES ('spotify', 'album', ?, ?, ?, ?, ?, 10, "
             "'2024-01-01', '{}')", (entity_id, title, artist_name, artist_id, album_type))


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase
    presets.clear_cache()
    ri.clear_cache()
    database = MusicDatabase(database_path=str(tmp_path / "missing.db"))
    _sql(database, "INSERT INTO artists (id, name, spotify_artist_id) VALUES (1, 'Pale Harbour', 'sp-ph')")
    _sql(database, "INSERT INTO artists (id, name, deezer_id) VALUES (2, 'Saltmarsh', '77')")
    _sql(database, "INSERT INTO artists (id, name) VALUES (3, 'Vera Lund')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES (10, 1, 'Night Ferry')")
    _sql(database, "INSERT INTO tracks (album_id, artist_id, title, file_path, bitrate) "
                   "VALUES (10, 1, 'One', '/m/1.flac', 900)")
    # Pale Harbour's discography was fetched once (a single counts: it's listed)
    _cached(database, "s1", "Harbour Single", "Pale Harbour", artist_id="sp-ph", album_type="single")
    return database


def test_the_artists_it_asks_about(db):
    index = ri.build_index(db, 1)
    assert "1" in {str(c) for c in index.listed}
    assert [a["name"] for a in ri.artists_without_releases(index)] == ["Saltmarsh", "Vera Lund"]


def _artists(db):
    return ri.artists_without_releases(ri.build_index(db, 1))


def _job(fetch, **kw):
    kw.setdefault("wait_seconds", lambda: 0)
    kw.setdefault("uses_spotify", lambda: True)
    return mr.MissingReleasesJob(fetch=fetch, pace=0, wait_step=0.001, **kw)


def _rows(db):
    conn = db._get_connection()
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM library_jobs ORDER BY id").fetchall()]
    finally:
        conn.close()


def test_a_run_fetches_each_artist_and_counts_what_it_found(db):
    asked = []

    def fetch(database, artist):
        asked.append(artist["name"])
        if artist["name"] == "Saltmarsh":
            _cached(database, "d1", "Brine", "Saltmarsh", artist_id=None)
            _cached(database, "d2", "Tide Tables", "Saltmarsh", artist_id=None)
            return {"state": "results"}
        return {"state": "empty"}

    job = _job(fetch)
    job.start(db, 1, _artists(db), on_finish=lambda st: mr.count_found(db, 1, st["checked"]), background=False)
    assert asked == ["Saltmarsh", "Vera Lund"]
    [row] = _rows(db)
    assert (row["status"], row["total"], row["done"], row["failed"]) == ("done", 2, 2, 0)
    assert (row["found_releases"], row["found_artists"]) == (2, 1)
    state = mr.public_state(db, job)
    assert state["status"] == "done" and state["recent"] is True and state["found_releases"] == 2
    assert mr.public_state(db, job, now=int(time.time()) + 2 * 86400)["recent"] is False
    # the index now lists Saltmarsh: the next run would only ask about Vera Lund
    ri.clear_cache()
    assert [a["name"] for a in _artists(db)] == ["Vera Lund"]


def test_it_waits_out_spotifys_pause(db):
    waits = iter([600, 300, 0, 0, 0])
    seen = []
    job = _job(lambda d, a: seen.append(job.live()["waiting_until"]) or {"state": "empty"},
               wait_seconds=lambda: next(waits))
    job.start(db, 1, _artists(db), background=False)
    assert _rows(db)[0]["status"] == "done"
    # it asked nobody while paused, and asked once the pause was over
    assert seen == [None, None]


def test_it_does_not_wait_when_spotify_is_not_asked(db):
    job = _job(lambda d, a: {"state": "empty"}, wait_seconds=lambda: 999, uses_spotify=lambda: False)
    job.start(db, 1, _artists(db), background=False)
    assert _rows(db)[0]["done"] == 2


def test_a_rate_limit_waits_then_asks_again(db):
    calls = []
    pauses = iter([0, 30, 0, 0, 0, 0])

    def fetch(database, artist):
        calls.append(artist["name"])
        if len(calls) == 1:
            return {"state": "error", "status_code": 429, "error": "rate limited"}
        return {"state": "empty"}

    job = _job(fetch, wait_seconds=lambda: next(pauses))
    job.start(db, 1, _artists(db), background=False)
    assert calls == ["Saltmarsh", "Saltmarsh", "Vera Lund"]
    assert _rows(db)[0]["failed"] == 0


def test_refusals_in_a_row_end_the_run(db, monkeypatch):
    monkeypatch.setattr(mr, "MAX_REFUSALS_IN_A_ROW", 2)
    job = _job(lambda d, a: {"state": "error", "status_code": 503, "error": "Deezer is down"})
    job.start(db, 1, _artists(db), background=False)
    row = _rows(db)[0]
    assert row["status"] == "failed" and row["failed"] == 2 and "Deezer" in row["note"]


def test_one_at_a_time_and_stoppable(db):
    gate = threading.Event()

    def fetch(database, artist):
        gate.wait(5)
        return {"state": "empty"}

    job = _job(fetch)
    job.start(db, 1, _artists(db))
    assert job.running()
    with pytest.raises(mr.JobRunning):
        job.start(db, 1, _artists(db))
    assert job.stop() is True
    gate.set()
    job.join(5)
    assert not job.running() and job.stop() is False
    row = _rows(db)[0]
    assert row["status"] == "stopped" and row["done"] == 1 and row["finished_at"]


def test_a_run_cut_off_by_a_restart_reads_as_stopped(db):
    conn = db._get_connection()
    mr.ensure_table(conn)
    conn.execute("INSERT INTO library_jobs (kind, profile_id, status, total, done, started_at) "
                 "VALUES ('missing_releases', 1, 'running', 9, 4, 100)")
    conn.commit()
    conn.close()
    state = mr.public_state(db, mr.MissingReleasesJob())
    assert state["status"] == "stopped" and state["note"] == "restart"


# ── Activity ──────────────────────────────────────────────────────────────────

def test_activity_shows_the_run(db, monkeypatch):
    from core.activity import feed

    job = _job(lambda d, a: {"state": "empty"})
    job.start(db, 1, _artists(db), on_finish=lambda st: {"found_releases": 61, "found_artists": 18},
              background=False)
    monkeypatch.setattr(feed, "_live_library_job", lambda: None)
    out = feed.build_feed(db, feed.Viewer(profile_id=1, is_admin=True), kind="library", live_batches={},
                          running_automations={})
    [item] = [i for i in out["items"] if i["id"].startswith("library-job:")]
    assert item["title"] == "Looked for releases you don't have"
    assert item["detail"] == "2 artists · found 61 releases by 18 artists"
    assert item["status"] == "ok" and item["link"] == "/library?show=incomplete"
    assert item["kind"] == "library" and out["counts"]["library"] >= 1
    # another profile's run stays out for a member
    member = feed.build_feed(db, feed.Viewer(profile_id=5, is_admin=False), kind="library",
                             live_batches={}, running_automations={})
    assert not [i for i in member["items"] if i["id"].startswith("library-job:")]


def test_activity_shows_a_running_job_with_stop(db, monkeypatch):
    from core.activity import feed

    conn = db._get_connection()
    mr.ensure_table(conn)
    cur = conn.execute("INSERT INTO library_jobs (kind, profile_id, status, total, started_at) "
                       "VALUES ('missing_releases', 1, 'running', 212, ?)", (int(time.time()) - 60,))
    conn.commit()
    run_id = cur.lastrowid
    conn.close()
    monkeypatch.setattr(feed, "_live_library_job", lambda: {
        "id": run_id, "profile_id": 1, "status": "running", "total": 212, "done": 40,
        "waiting_until": int(time.time()) + 540})
    out = feed.build_feed(db, feed.Viewer(profile_id=1, is_admin=True), live_batches={}, running_automations={})
    [item] = [i for i in out["items"] if i["id"] == f"library-job:{run_id}"]
    assert item["status"] == "running" and item["title"] == "Looking for releases you don't have"
    assert item["detail"].startswith("212 artists · 40 done · waiting for Spotify's pause, ")
    assert item["ref"]["stop_path"] == "library/missing-releases/stop"
    assert out["running_count"] >= 1


# ── routes ────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(db, monkeypatch):
    import api.library_index as li
    from core.library_scope import reset_library_scope, set_library_scope

    li.configure(get_database_=lambda: db)
    job = _job(lambda d, a: {"state": "empty"})
    monkeypatch.setattr(mr, "JOB", job)
    state = {"profile": 1, "admin": True}
    import core.profile_context as pc
    monkeypatch.setattr(pc, "is_admin_request", lambda: state["admin"])
    app = Flask(__name__)
    tokens = []

    @app.before_request
    def _profile():
        g.profile_id = state["profile"]
        tokens.append(set_library_scope("shared"))

    @app.teardown_request
    def _scope(_exc):
        if tokens:
            reset_library_scope(tokens.pop())

    app.register_blueprint(li.create_blueprint())
    c = app.test_client()
    c.state = state
    c.job = job
    return c


def test_routes(client, db):
    body = client.get("/api/library/missing-releases").get_json()
    assert body["candidates"] == 2 and body["job"] is None and body["can_start"] is True
    res = client.post("/api/library/missing-releases/start")
    assert res.status_code == 202
    client.job.join(5)
    body = client.get("/api/library/missing-releases").get_json()
    assert body["job"]["status"] == "done" and body["job"]["total"] == 2
    assert client.post("/api/library/missing-releases/stop").status_code == 409


def test_members_cannot_start_or_stop(client):
    client.state["admin"] = False
    assert client.get("/api/library/missing-releases").get_json()["can_start"] is False
    assert client.post("/api/library/missing-releases/start").status_code == 403
    assert client.post("/api/library/missing-releases/stop").status_code == 403


def test_nothing_to_look_for(client, db):
    for i, name in ((2, "Saltmarsh"), (3, "Vera Lund")):
        _cached(db, f"z{i}", "Something", name)
    ri.clear_cache()
    assert client.post("/api/library/missing-releases/start").status_code == 409


def test_fetch_gives_each_service_its_own_id(db, monkeypatch):
    import core.metadata.discography_strict as ds

    seen = {}

    def fake(artist_id, artist_name="", options=None):
        seen.update(id=artist_id, name=artist_name, ids=options.artist_source_ids)
        return {"state": "empty"}

    monkeypatch.setattr(ds, "get_artist_discography", fake)
    artist = next(a for a in _artists(db) if a["name"] == "Saltmarsh")
    mr.fetch_discography(db, artist)
    assert seen == {"id": "", "name": "Saltmarsh", "ids": {"deezer": "77"}}
    vera = next(a for a in _artists(db) if a["name"] == "Vera Lund")
    mr.fetch_discography(db, vera)
    assert seen["ids"] is None and seen["id"] == ""


def test_json_dumps_state_is_plain(db):
    # the routes send public_state as JSON
    job = _job(lambda d, a: {"state": "empty"})
    job.start(db, 1, _artists(db), background=False)
    json.dumps(mr.public_state(db, job))
