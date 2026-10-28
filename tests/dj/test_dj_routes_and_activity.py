"""The DJ routes (api/dj.py): status, start and stop for admins, the track
rows' lookup, Library → Tracks' filters and sorts, "Mixes well with…"; and
the sweep's rows in Activity."""

from __future__ import annotations

import time

import pytest
from flask import Flask, g

from core.dj import grid_store, store, worker


def _no_grid(db, track_id):
    """A grid row (found no beat) beside a fake job's DJ row: the track is
    fully analysed, so the sweep's grid top-up has nothing to do."""
    grid_store.save_result(db, track_id, {"status": "none", "reason": "too_short"}, source_sig=None)


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


# (id, title, bpm, camelot, energy): a small crate around 8A at 124
CRATE = [
    ("1", "Seed", 124.0, "8A", 7),
    ("2", "Same key", 126.0, "8A", 6),
    ("3", "Relative", 122.0, "8B", 5),
    ("4", "Up one", 124.0, "9A", 8),
    ("5", "Down one", 120.0, "7A", 4),
    ("6", "Half time", 62.0, "8A", 3),
    ("7", "Clash", 124.0, "3B", 9),
    ("8", "Too fast", 140.0, "8A", 9),
]


@pytest.fixture
def db(tmp_path, monkeypatch):
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "routes.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Saltmarsh')")
    _sql(database, "INSERT INTO albums (id, artist_id, title, thumb_url) VALUES ('10', '1', 'Lantern', '/art.jpg')")
    for tid, title, bpm, key, energy in CRATE:
        _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path) VALUES (?, '10', '1', ?, ?)",
             (tid, title, f"/m/{tid}.flac"))
        store.save(database, tid, {"bpm": bpm, "bpm_source": "analysis", "musical_key": key,
                                   "key_source": "analysis", "key_confidence": 0.8, "energy": energy,
                                   "status": "done", "dj_analyzer_version": worker.analyzer_version()})
        _no_grid(database, tid)
    # enrichment knows a BPM for a track analysis hasn't reached yet
    _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, bpm) "
                   "VALUES ('9', '10', '1', 'Not yet', '/m/9.flac', 128)")
    return database


@pytest.fixture
def client(db, monkeypatch):
    import api.dj as dj_api
    import core.profile_context as pc
    from core.library_scope import reset_library_scope, set_library_scope

    dj_api.configure(get_database_=lambda: db, fix_art_url_=lambda url: f"/fixed{url}")
    state = {"profile": 1, "admin": True}
    monkeypatch.setattr(pc, "is_admin_request", lambda: state["admin"])
    job = worker.DjAnalysisJob(busy=lambda d: None, away=lambda: False, sleep_floor=0, rest_factor=0,
                               process=lambda d, t, **kw: (store.save(d, t, {
                                   "status": "done", "dj_analyzer_version": worker.analyzer_version()}),
                                   _no_grid(d, t), "done")[2],
                               settings=lambda: {"analyze": True, "write_tags": False, "overwrite_tags": False})
    monkeypatch.setattr(worker, "JOB", job)
    app = Flask(__name__)
    tokens = []

    @app.before_request
    def _profile():
        if state["profile"] is not None:
            g.profile_id = state["profile"]
        tokens.append(set_library_scope("shared"))

    @app.teardown_request
    def _scope(_exc):
        if tokens:
            reset_library_scope(tokens.pop())

    app.register_blueprint(dj_api.create_blueprint())
    c = app.test_client()
    c.state, c.job = state, job
    return c


def test_status_start_and_stop(client, db):
    body = client.get("/api/library/dj/status").get_json()
    assert body["counts"] == {"tracks": 9, "analyzed": 8, "failed": 0, "unreachable": 0, "skipped": 0, "pending": 1}
    assert body["settings"]["analyze"] is True and body["can_start"] is True and body["job"] is None
    res = client.post("/api/library/dj/start")
    assert res.status_code == 202
    client.job.join(5)
    body = client.get("/api/library/dj/status").get_json()
    assert body["job"]["status"] == "done" and body["job"]["total"] == 1 and body["counts"]["pending"] == 0
    assert client.post("/api/library/dj/start").status_code == 409  # nothing left
    assert client.post("/api/library/dj/stop").status_code == 409  # nothing running


def test_members_read_but_cannot_start_or_stop(client):
    client.state["admin"] = False
    assert client.get("/api/library/dj/status").get_json()["can_start"] is False
    assert client.post("/api/library/dj/start").status_code == 403
    assert client.post("/api/library/dj/stop").status_code == 403


def test_a_profile_is_needed(client, monkeypatch):
    import api.dj as dj_api

    monkeypatch.setattr(dj_api, "get_current_profile_id", lambda: None)
    assert client.get("/api/library/dj/status").status_code == 401
    assert client.get("/api/library/dj/browse").status_code == 401
    assert client.get("/api/library/dj/mixes/1").status_code == 401
    assert client.post("/api/library/dj/tracks", json={"track_ids": ["1"]}).status_code == 401


def test_track_rows_lookup(client):
    body = client.post("/api/library/dj/tracks", json={"track_ids": ["1", "9", "nope", 3]}).get_json()
    one = body["tracks"]["1"]
    assert one == {"bpm": 124.0, "bpm_source": "analysis", "bpm_tag": None, "key": "8A", "key_name": "Am", "key_long": "A minor",
                   "key_source": "analysis", "key_confidence": 0.8, "key_uncertain": False, "energy": 7,
                   "analyzed": True, "skipped": None}
    # not analysed yet: the BPM enrichment found
    assert body["tracks"]["9"]["bpm"] == 128.0 and body["tracks"]["9"]["bpm_source"] == "enrichment"
    assert body["tracks"]["9"]["key"] is None
    assert "nope" not in body["tracks"] and "3" in body["tracks"]
    assert client.post("/api/library/dj/tracks", json={"track_ids": "1"}).status_code == 400
    assert client.post("/api/library/dj/tracks", json={"track_ids": ["1"] * 501}).status_code == 400


def _titles(body):
    return [t["title"] for t in body["tracks"]]


def test_browse_filters_and_sorts(client):
    body = client.get("/api/library/dj/browse?bpm_min=121&bpm_max=126").get_json()
    assert _titles(body) == ["Relative", "Clash", "Seed", "Up one", "Same key"]
    assert body["total"] == 5 and body["sort"] == "bpm"
    # min and max the wrong way round are swapped
    assert body["total"] == client.get("/api/library/dj/browse?bpm_min=126&bpm_max=121").get_json()["total"]
    body = client.get("/api/library/dj/browse?key=Am").get_json()
    assert set(_titles(body)) == {"Seed", "Same key", "Half time", "Too fast"}
    body = client.get("/api/library/dj/browse?key=8A:mix&bpm_min=100").get_json()
    assert set(_titles(body)) == {"Seed", "Same key", "Relative", "Up one", "Down one", "Too fast"}
    body = client.get("/api/library/dj/browse?sort=energy&limit=3").get_json()
    assert _titles(body) == ["Clash", "Too fast", "Up one"] and body["has_more"] is True
    body = client.get("/api/library/dj/browse?sort=key").get_json()
    assert [t["dj"]["key"] for t in body["tracks"][:2]] == ["3B", "7A"]
    assert body["tracks"][-1]["dj"]["key"] is None  # no key goes last
    body = client.get("/api/library/dj/browse?q=time").get_json()
    assert _titles(body) == ["Half time"]
    assert body["tracks"][0]["image_url"] == "/fixed/art.jpg"
    # unknown values fall back
    assert client.get("/api/library/dj/browse?sort=nope&bpm_min=abc").get_json()["sort"] == "bpm"


def test_mixes_well_with(client):
    body = client.get("/api/library/dj/mixes/1").get_json()
    assert body["track"]["title"] == "Seed"
    got = [(m["title"], m["key_relation"], m["bpm_relation"]) for m in body["matches"]]
    assert got == [("Same key", "same", "same"), ("Half time", "same", "half"), ("Relative", "relative", "same"),
                   ("Up one", "up", "same"), ("Down one", "down", "same")]
    assert body["matches"][0]["bpm_diff_pct"] == pytest.approx(1.6)
    assert "Clash" not in [m["title"] for m in body["matches"]]  # 3B doesn't mix with 8A
    assert "Too fast" not in [m["title"] for m in body["matches"]]  # 140 is 13% off


def test_mixes_well_with_a_track_without_data(client):
    body = client.get("/api/library/dj/mixes/9").get_json()
    assert body["matches"] == [] and body["reason"] == "not_analyzed"
    assert client.get("/api/library/dj/mixes/404").status_code == 404


# ── Activity ─────────────────────────────────────────────────────────────────

def test_activity_shows_the_sweep_with_stop_then_what_it_did(db, monkeypatch):
    from core.activity import feed
    from core.library.missing_releases import ensure_table

    conn = db._get_connection()
    ensure_table(conn)
    cur = conn.execute("INSERT INTO library_jobs (kind, profile_id, status, total, started_at) "
                       "VALUES ('dj_analysis', 1, 'running', 4980, ?)", (int(time.time()) - 60,))
    conn.commit()
    run_id = cur.lastrowid
    conn.close()
    monkeypatch.setattr(feed, "_live_library_job", lambda: None)
    monkeypatch.setattr(feed, "_live_dj_job", lambda: {"id": run_id, "profile_id": 1, "status": "running",
                                                        "total": 4980, "done": 1240, "waiting": "download",
                                                        "tags_written": 0, "unreachable": 0})
    out = feed.build_feed(db, feed.Viewer(profile_id=1, is_admin=True), live_batches={}, running_automations={})
    [item] = [i for i in out["items"] if i["id"] == f"library-job:{run_id}"]
    assert item["status"] == "running" and item["title"] == "Working out BPM, key and energy"
    assert item["detail"] == "4,980 tracks · 1,240 done · waiting while a download runs"
    assert item["ref"]["stop_path"] == "library/dj/stop" and item["link"] == "/library?view=tracks"
    assert item["kind"] == "library"  # under Activity's Library jobs filter
    assert out["running_count"] >= 1

    _sql(db, "UPDATE library_jobs SET status = 'done', done = 4970, failed = 3, found_releases = 1200, "
             "found_artists = 7, finished_at = ? WHERE id = ?", (int(time.time()), run_id))
    monkeypatch.setattr(feed, "_live_dj_job", lambda: None)
    out = feed.build_feed(db, feed.Viewer(profile_id=1, is_admin=True), kind="library", live_batches={},
                          running_automations={})
    [item] = [i for i in out["items"] if i["id"] == f"library-job:{run_id}"]
    assert item["title"] == "Worked out BPM, key and energy" and item["status"] == "warning"
    assert item["detail"] == ("4,980 tracks · 3 tracks couldn't be analysed · 7 files weren't there · "
                              "BPM and key written into 1,200 files")
    assert "stop_path" not in item["ref"]
    # a member sees nothing of the admin's sweep
    member = feed.build_feed(db, feed.Viewer(profile_id=5, is_admin=False), kind="library",
                             live_batches={}, running_automations={})
    assert not [i for i in member["items"] if i["id"] == f"library-job:{run_id}"]


def test_activity_says_a_restart_stopped_it(db, monkeypatch):
    from core.activity import feed
    from core.library.missing_releases import ensure_table

    conn = db._get_connection()
    ensure_table(conn)
    conn.execute("INSERT INTO library_jobs (kind, profile_id, status, total, done, started_at, finished_at, note) "
                 "VALUES ('dj_analysis', 1, 'stopped', 50, 20, ?, ?, 'restart')",
                 (int(time.time()) - 60, int(time.time())))
    conn.commit()
    conn.close()
    monkeypatch.setattr(feed, "_live_dj_job", lambda: None)
    out = feed.build_feed(db, feed.Viewer(profile_id=1, is_admin=True), live_batches={}, running_automations={})
    [item] = [i for i in out["items"] if i["title"].startswith("Stopped working out")]
    assert item["detail"] == "Stopped after 20 of 50 tracks when SYNCHRO.S restarted"


# ── Phase B2 (17a, 17b): the count line's keys, Widen, "analyse it now" ─────

def test_browse_says_which_keys_the_filter_covered(client):
    # the count line names them: the key, −1, +1, then the relative ("8A, 7A, 9A or 8B")
    assert client.get("/api/library/dj/browse?key=8A:mix").get_json()["keys"] == ["8A", "7A", "9A", "8B"]
    assert client.get("/api/library/dj/browse?key=1B:mix").get_json()["keys"] == ["1B", "12B", "2B", "1A"]
    assert client.get("/api/library/dj/browse?key=Am").get_json()["keys"] == ["8A"]
    assert client.get("/api/library/dj/browse").get_json()["keys"] == []
    assert client.get("/api/library/dj/browse?key=nonsense").get_json()["keys"] == []


def test_mixes_well_with_widens_and_narrows_the_tempo(client):
    assert client.get("/api/library/dj/mixes/1").get_json()["within"] == 6
    body = client.get("/api/library/dj/mixes/1?within=1").get_json()
    assert body["within"] == 1
    assert [m["title"] for m in body["matches"]] == ["Half time", "Up one"]
    # at most 12%: "Too fast" (140 against 124, 12.9% off) stays out
    body = client.get("/api/library/dj/mixes/1?within=99").get_json()
    assert body["within"] == 12 and "Too fast" not in [m["title"] for m in body["matches"]]
    assert client.get("/api/library/dj/mixes/9?within=10").get_json()["reason"] == "not_analyzed"


def test_analyse_it_now_starts_with_that_track(client, db, monkeypatch):
    _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path) VALUES ('11', '10', '1', 'Later', '/m/11.flac')")
    order = []

    def process(d, t, **kw):
        order.append(t)
        store.save(d, t, {"status": "done", "dj_analyzer_version": worker.analyzer_version()})
        return "done"

    job = worker.DjAnalysisJob(busy=lambda d: None, away=lambda: False, sleep_floor=0, rest_factor=0,
                               process=process,
                               settings=lambda: {"analyze": True, "write_tags": False, "overwrite_tags": False})
    monkeypatch.setattr(worker, "JOB", job)
    res = client.post("/api/library/dj/start", json={"track_id": "11"})
    assert res.status_code == 202
    job.join(5)
    # that track alone: Analyse now never starts a full sweep (Brief A review L5)
    assert order == ["11"]
    client.state["admin"] = False
    assert client.post("/api/library/dj/start", json={"track_id": "11"}).status_code == 403


def test_a_track_asked_for_while_a_sweep_runs_goes_next():
    """Analyse it now, or an admin's Move up (31a, state 4): the track goes
    next, before everything else in line, the last one asked first."""
    job = worker.DjAnalysisJob(busy=lambda d: None, away=lambda: False)
    assert job.prioritise("c") is False  # nothing runs: start with first= instead
    job._state = {"status": "running", "total": 3}
    job._queued = {"a", "b", "c"}
    assert job.prioritise("c") is True and job.prioritise("c") is True
    assert job._state["total"] == 3  # already in the sweep: counted once
    assert job.prioritise("z") is True and job._state["total"] == 4
    assert list(job._ordered(["a", "b", "c"])) == ["z", "c", "a", "b"]
