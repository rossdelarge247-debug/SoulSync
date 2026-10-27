"""Analyse on demand (core/dj/ondemand.py, the asked-for line in
core/dj/worker.py, api/dj.py's /analyse and /progress): any profile can put
its own tracks first in line, with a cap and a rate limit; asked-for tracks
don't wait for downloads or imports but do wait for the library's drive;
each track says where it is, with its step from real points in the
analysis; and the sweep's own rules (Stop's hold, the error limits, the
grid top-up) stand."""

from __future__ import annotations

import threading
import time

import pytest
from flask import Flask, g

from core.dj import grid_store, ondemand, progress, store, worker
from core.dj.grid import GRID_VERSION

pytestmark = pytest.mark.gauntlet


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _finish(db, track_id):
    """What a real analysis leaves: DJ data at this version and a grid."""
    store.save(db, track_id, {"bpm": 124.0, "musical_key": "8A", "energy": 6, "status": "done",
                              "dj_analyzer_version": worker.analyzer_version()})
    grid_store.save_result(db, track_id, {"status": "none", "reason": "too_short"}, source_sig=None)


def _done_process(order=None, steps=None):
    def process(d, t, **kw):
        if order is not None:
            order.append(t)
        progress.mode("full")
        progress.step("read")
        progress.step("grid")
        _finish(d, t)
        return "done"
    return process


def _job(**kw):
    defaults = dict(busy=lambda d: None, away=lambda: False, sleep_floor=0, rest_factor=0,
                    process=_done_process(),
                    settings=lambda: {"analyze": True, "write_tags": False, "overwrite_tags": False})
    defaults.update(kw)
    return worker.DjAnalysisJob(**defaults)


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "ondemand.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Saltmarsh')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'Lantern')")
    # 1 analysed; 2, 3, 5 not yet; 4 another profile's (outside the shared library)
    for tid, title, owner in (("1", "Night Ferry", None), ("2", "Static Bloom", None), ("3", "Sand Script", None),
                              ("4", "Theirs", 7), ("5", "Brass Tide", None)):
        _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration, owner_profile_id) "
                       "VALUES (?, '10', '1', ?, ?, 240000, ?)", (tid, title, f"/m/{tid}.flac", owner))
    _finish(database, "1")
    return database


@pytest.fixture
def client(db, monkeypatch):
    import api.dj as dj_api
    import core.profile_context as pc
    from core.library_scope import reset_library_scope, set_library_scope

    dj_api.configure(get_database_=lambda: db)
    state = {"profile": 2, "admin": False}
    monkeypatch.setattr(pc, "is_admin_request", lambda: state["admin"])
    monkeypatch.setattr(ondemand, "ASK_LIMIT", ondemand.RateLimit(every=0))
    monkeypatch.setattr(worker, "settings_state",
                        lambda: {"analyze": True, "write_tags": False, "overwrite_tags": False})
    job = _job()
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


# ── access: every profile, its own library, JSON only, caps ──────────────────

def test_a_profile_is_needed(client, monkeypatch):
    import api.dj as dj_api

    monkeypatch.setattr(dj_api, "get_current_profile_id", lambda: None)
    assert client.post("/api/library/dj/analyse", json={"track_ids": ["2"]}).status_code == 401
    assert client.post("/api/library/dj/progress", json={"track_ids": ["2"]}).status_code == 401


def test_a_member_asks_for_its_own_tracks_and_another_profiles_are_left_out(client, db):
    res = client.post("/api/library/dj/analyse", json={"track_ids": ["2", "4", "nope", "1"]})
    assert res.status_code == 202
    body = res.get_json()
    # 4 is another profile's and "nope" isn't a track: neither is counted or queued
    assert body["asked"] == 2 and body["queued"] == 1 and body["already_done"] == 1
    assert body["limit"] == worker.PRIORITY_PER_PROFILE and body["started"] is True
    client.job.join(5)
    assert store.get(db, "4") is None  # never analysed for this profile
    assert store.get(db, "2")["status"] == "done"
    # progress leaves another profile's track out too
    tracks = client.post("/api/library/dj/progress", json={"track_ids": ["2", "4"]}).get_json()["tracks"]
    assert set(tracks) == {"2"} and tracks["2"] == {"state": "done"}


def test_only_json_bodies_within_the_cap(client):
    form = client.post("/api/library/dj/analyse", data={"track_ids": "2"})
    assert form.status_code == 400
    text = client.post("/api/library/dj/analyse", data='{"track_ids": ["2"]}', content_type="text/plain")
    assert text.status_code == 400
    assert client.post("/api/library/dj/analyse", json=["2"]).status_code == 400
    assert client.post("/api/library/dj/analyse", json={"track_ids": "2"}).status_code == 400
    big = client.post("/api/library/dj/analyse", data="{" + " " * (64 * 1024) + "}",
                      content_type="application/json")
    assert big.status_code == 413
    many = client.post("/api/library/dj/analyse", json={"track_ids": [str(i) for i in range(501)]})
    assert many.status_code == 400
    assert client.post("/api/library/dj/progress", data={"track_ids": "2"}).status_code == 400
    assert client.post("/api/library/dj/progress", json={"track_ids": [str(i) for i in range(501)]}).status_code == 400
    for bad in (True, "3", 0, -1, 2.5):
        assert client.post("/api/library/dj/analyse", json={"playlist_id": bad}).status_code == 400


def test_one_request_a_second_a_profile(client, monkeypatch):
    clock = {"t": 100.0}
    monkeypatch.setattr(ondemand, "ASK_LIMIT", ondemand.RateLimit(every=1.0, clock=lambda: clock["t"]))
    client.job.ask = lambda *a, **k: {"added": [], "already": 0, "over": 0, "yours": 0, "limit": 200,
                                       "started": False}
    assert client.post("/api/library/dj/analyse", json={"track_ids": ["2"]}).status_code == 202
    res = client.post("/api/library/dj/analyse", json={"track_ids": ["3"]})
    assert res.status_code == 429 and res.headers["Retry-After"] == "1"
    assert res.get_json()["code"] == "rate_limited"
    # another profile has its own second
    client.state["profile"] = 3
    assert client.post("/api/library/dj/analyse", json={"track_ids": ["3"]}).status_code == 202
    client.state["profile"] = 2
    clock["t"] += 1.0
    assert client.post("/api/library/dj/analyse", json={"track_ids": ["3"]}).status_code == 202
    # progress isn't limited: a page polls it
    for _ in range(3):
        assert client.post("/api/library/dj/progress", json={"track_ids": ["2"]}).status_code == 200


def test_off_in_settings_is_refused(client, monkeypatch):
    monkeypatch.setattr(worker, "settings_state",
                        lambda: {"analyze": False, "write_tags": False, "overwrite_tags": False})
    res = client.post("/api/library/dj/analyse", json={"track_ids": ["2"]})
    assert res.status_code == 409 and res.get_json()["code"] == "off"
    assert client.job.running() is False


def test_each_profile_has_room_for_200(db):
    job = _job()
    job._state = {"status": "running", "total": 0}  # held open: nothing is taken
    ids = [f"x{i}" for i in range(250)]
    first = job.ask(db, ids, 2)
    assert len(first["added"]) == 200 and first["over"] == 50 and first["yours"] == 200
    again = job.ask(db, ["y1"], 2)
    assert again["added"] == [] and again["over"] == 1
    # another profile has its own 200; asking for one already in line keeps its place
    other = job.ask(db, ["x0", "z1"], 3)
    assert other["added"] == ["z1"] and other["already"] == 1 and job._priority[0] == "x0"


def test_a_playlist_is_matched_to_the_callers_library(client, db, monkeypatch):
    from core.dj import traktor

    seen = {}

    def fake(database, playlist_id, owner):
        seen["owner"] = owner
        if playlist_id != 9:
            return None
        return {"name": "P", "over": 0,
                "rows": [({"id": "2"}, "Static Bloom", "Saltmarsh"), (None, "Gone", "Someone"),
                         ({"id": "3"}, "Sand Script", "Saltmarsh")]}

    monkeypatch.setattr(traktor, "playlist_tracks", fake)
    assert client.post("/api/library/dj/analyse", json={"playlist_id": 8}).status_code == 404
    res = client.post("/api/library/dj/analyse", json={"playlist_id": 9})
    assert res.status_code == 202 and res.get_json()["asked"] == 2
    assert seen["owner"] == 2  # a member reads only its own playlists
    client.job.join(5)


# ── the line: first, not waiting for downloads, still waiting for the drive ──

def test_asked_for_tracks_go_first_and_dont_wait_for_downloads(db):
    order = []
    busy = {"word": "download"}
    job = _job(process=_done_process(order), busy=lambda d: busy["word"], wait_step=0.05)
    # the sweep waits for the download before its own tracks
    job.start(db, 1, manual=False)
    deadline = time.time() + 2
    while job.live() and job.live().get("waiting") != "download" and time.time() < deadline:
        time.sleep(0.01)
    assert job.live()["waiting"] == "download" and order == []
    # an asked-for track doesn't wait for it
    job.ask(db, ["5"], 2)
    deadline = time.time() + 3
    while order != ["5"] and time.time() < deadline:
        time.sleep(0.01)
    assert order == ["5"]
    busy["word"] = None
    job.join(5)
    assert order[0] == "5" and sorted(order[1:]) == ["2", "3", "4"]


def test_asked_for_tracks_still_wait_for_the_library_drive(db):
    order = []
    away = {"away": True}
    job = _job(process=_done_process(order), away=lambda: away["away"], wait_step=0.05)
    result = job.ask(db, ["2"], 2)
    assert result["started"] is True
    deadline = time.time() + 2
    while (job.live() or {}).get("waiting") != "drive_away" and time.time() < deadline:
        time.sleep(0.01)
    assert job.live()["waiting"] == "drive_away" and order == []
    snap = ondemand.progress(db, ["2"], 2, job=job, settings={"analyze": True})
    assert snap["tracks"]["2"] == {"state": "waiting", "position": 1, "asked_for": True, "reason": "drive_away"}
    away["away"] = False
    job.join(5)
    assert order == ["2"]


def test_asking_with_nothing_running_analyses_only_those_tracks(db):
    order = []
    job = _job(process=_done_process(order))
    job.ask(db, ["3"], 2)
    job.join(5)
    assert order == ["3"]  # not the whole library: the automatic sweep does the rest
    assert job.held is False


def test_stops_hold_stays_and_stop_empties_the_line(db):
    order = []
    gate = threading.Event()

    def slow(d, t, **kw):
        order.append(t)
        gate.wait(2)
        _finish(d, t)
        return "done"

    job = _job(process=slow)
    job.start(db, 1, manual=True)
    deadline = time.time() + 2
    while not order and time.time() < deadline:
        time.sleep(0.01)
    job.ask(db, ["5"], 2)
    assert job.stop(by_person=True) is True
    gate.set()
    job.join(5)
    assert job.held is True and job._priority == [] and "5" not in order
    # asking after a Stop analyses what was asked for, and the hold stays
    job.ask(db, ["5"], 2)
    job.join(5)
    assert order[-1] == "5" and job.held is True
    # a restart (a new job) starts with an empty line
    assert worker.DjAnalysisJob()._priority == []


def test_rests_follow_asked_for_tracks_too(db):
    rests = []
    job = _job(sleep_floor=0.5, rest_factor=1.0)
    real_wait = job._stop.wait

    def wait(timeout=None):
        rests.append(timeout)
        return real_wait(0)

    job._stop.wait = wait
    job.ask(db, ["2", "3"], 2)
    job.join(5)
    assert [r for r in rests if r is not None and r >= 0.5][:2] == [0.5, 0.5]


def test_the_error_limit_still_ends_a_run(db, monkeypatch):
    monkeypatch.setattr(worker, "MAX_ERRORS_IN_A_ROW", 2)
    order = []

    def broken(d, t, **kw):
        order.append(t)
        return "error"

    job = _job(process=broken)
    job.ask(db, ["2", "3", "5"], 2)
    job.join(5)
    assert len(order) == 2 and worker.last_run(db)["status"] == "failed"
    assert job._priority == []  # the line isn't kept for a run that failed


def test_a_track_asked_for_as_a_run_ends_starts_the_next(db):
    order = []
    job = _job(process=_done_process(order))
    real_next = job._next
    asked = {}

    def next_then_ask(ids, *, peek=False):
        found = real_next(ids, peek=peek)
        if found is None and not peek and not asked:
            # a request lands just as the run finds nothing left
            asked["result"] = job.ask(db, ["3"], 2)
        return found

    job._next = next_then_ask
    job.ask(db, ["2"], 2)
    job.join(5)
    assert asked["result"]["started"] is False  # the finishing run takes it
    assert order == ["2", "3"]
    assert job.running() is False and job._priority == []


# ── what each track says ─────────────────────────────────────────────────────

def test_progress_says_done_queued_working_waiting_and_failed(db):
    store.save(db, "5", {"status": "skipped", "error": worker.TOO_LONG,
                         "dj_analyzer_version": worker.analyzer_version()})
    seen = {}
    gate = threading.Event()
    reached = threading.Event()

    def process(d, t, **kw):
        progress.mode("full")
        progress.step("read")
        progress.step("tempo")
        progress.step("grid")
        if t == "2":
            reached.set()
            gate.wait(3)
        _finish(d, t)
        return "done"

    job = _job(process=process)
    job.ask(db, ["2", "3"], 2)
    assert reached.wait(3)
    snap = ondemand.progress(db, ["1", "2", "3", "4", "5"], 2, job=job, settings={"analyze": True})
    tracks = snap["tracks"]
    assert tracks["1"] == {"state": "done"}
    assert tracks["2"] == {"state": "working", "step": "grid", "percent": progress.FULL["grid"]}
    assert tracks["3"] == {"state": "queued", "position": 1, "asked_for": True}
    assert tracks["5"] == {"state": "failed", "reason": "too_long"}
    assert "4" not in tracks
    sweep = snap["sweep"]
    assert sweep["running"] is True and sweep["total"] == 2 and sweep["in_line"] == 1 and sweep["yours"] == 1
    assert sweep["current"] == {"step": "grid", "percent": 60, "asked_for": True, "track_id": "2",
                                "title": "Static Bloom"}
    seen["mid"] = snap
    gate.set()
    job.join(5)
    after = ondemand.progress(db, ["2", "3"], 2, job=job, settings={"analyze": True})
    assert after["tracks"] == {"2": {"state": "done"}, "3": {"state": "done"}}
    assert after["sweep"]["running"] is False


def test_another_profiles_track_is_never_named_as_the_one_being_worked(db, monkeypatch):
    gate = threading.Event()
    reached = threading.Event()

    def process(d, t, **kw):
        reached.set()
        gate.wait(3)
        _finish(d, t)
        return "done"

    job = _job(process=process)
    job._state = None
    with job._lock:
        job._enqueue_locked(["4"], 7, None)
    job.start(db, 7, manual=False, priority_only=True)
    assert reached.wait(3)
    from core.library_scope import reset_library_scope, set_library_scope

    token = set_library_scope("shared")
    try:
        snap = ondemand.progress(db, ["4"], 2, job=job, settings={"analyze": True})
    finally:
        reset_library_scope(token)
    assert snap["tracks"] == {}
    assert snap["sweep"]["current"]["track_id"] is None and snap["sweep"]["current"]["title"] is None
    gate.set()
    job.join(5)


def test_a_track_not_in_any_line_says_why(db):
    job = _job()
    snap = ondemand.progress(db, ["2"], 2, job=job, settings={"analyze": True})
    assert snap["tracks"]["2"]["reason"] == "not_queued"
    job.held = True
    assert ondemand.progress(db, ["2"], 2, job=job, settings={"analyze": True})["tracks"]["2"]["reason"] == "held"
    assert ondemand.progress(db, ["2"], 2, job=job, settings={"analyze": False})["tracks"]["2"]["reason"] == "off"


def test_a_grid_from_an_older_version_still_needs_analysis(db):
    _sql(db, "UPDATE track_grid SET grid_version = ? WHERE track_id = '1'", (GRID_VERSION - 1,))
    assert ondemand.classify(ondemand._rows(db, ["1"])["1"], worker.analyzer_version()) == {
        "needs": True, "failed": None}
    _sql(db, "UPDATE track_grid SET grid_version = ?, status = 'error' WHERE track_id = '1'", (GRID_VERSION,))
    assert ondemand.classify(ondemand._rows(db, ["1"])["1"], worker.analyzer_version()) == {
        "needs": False, "failed": "no_grid"}


# ── steps from real points in the analysis ───────────────────────────────────

def test_process_track_reports_its_steps_in_order(db, tmp_path, monkeypatch):
    path = tmp_path / "2.flac"
    path.write_bytes(b"x")
    _sql(db, "UPDATE tracks SET file_path = ? WHERE id = '2'", (str(path),))
    monkeypatch.setattr(worker, "_too_long", lambda p: False)
    seen = []

    def analyze(p):
        return {"bpm": 124.0, "key": {"name": "A minor", "confidence": 0.8}, "energy": 6, "truncated": True,
                "audio": ([0.0], 22050)}

    def grid(p, *, audio=None, bpm_hint=None):
        progress.step("phrases")
        return {"status": "none", "reason": "too_short"}

    with progress.reporting(lambda mode, step: seen.append((mode, step))):
        assert worker.process_track(db, "2", analyze=analyze, analyze_grid=grid) == "done"
    assert seen == [("full", "read"), ("full", "grid"), ("full", "phrases")]
    # the grid top-up: its own, shorter scale
    _sql(db, "UPDATE track_grid SET grid_version = 0 WHERE track_id = '2'")
    seen.clear()
    with progress.reporting(lambda mode, step: seen.append((mode, step))):
        worker.process_track(db, "2", analyze=analyze, analyze_grid=grid)
    assert seen == [("grid", "read"), ("grid", "phrases")]
    assert progress.percent("grid", "read") < progress.percent("grid", "phrases")
    # no reporter (Sample Studio's own thread): nothing happens
    progress.step("read")


def test_the_analyzer_says_each_step_as_it_starts(tmp_path):
    pytest.importorskip("librosa")
    import numpy as np
    import soundfile as sf

    from core.sample.analyze import analyze_track

    sr = 22050
    t = np.arange(sr * 4) / sr
    y = (0.3 * np.sin(2 * np.pi * 220 * t) * (np.sin(2 * np.pi * 2 * t) > 0)).astype("float32")
    path = tmp_path / "tone.wav"
    sf.write(str(path), y, sr)
    seen = []
    analyze_track(str(path), on_step=seen.append)
    assert seen == ["read", "tempo", "key", "energy"]


def test_activity_offers_the_progress_while_it_runs(db, monkeypatch):
    from core.activity import feed

    job = _job()
    job._state = {"id": 1, "status": "running", "total": 3, "done": 1, "failed": 0, "waiting": None,
                  "tags_written": 0, "unreachable": 0}
    monkeypatch.setattr(worker, "JOB", job)
    item = feed._dj_job_item(None, {"id": 1, "started_at": 0, "status": "running", "total": 3, "done": 1})
    assert item["ref"]["dj_progress"] is True and item["ref"]["stop_path"] == "library/dj/stop"
