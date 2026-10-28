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
    assert set(tracks) == {"2"} and tracks["2"] == {"state": "done", "ready": False, "bpm_key": True, "beat": "too_short"}


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
    assert snap["tracks"]["2"] == {"state": "waiting", "position": 1, "asked_for": True, "reason": "drive_away",
                                   "yours": True, "ready": False, "bpm_key": False}
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
    assert tracks["1"] == {"state": "done", "ready": False, "bpm_key": True, "beat": "too_short"}
    assert tracks["2"] == {"state": "working", "step": "grid", "percent": progress.FULL["grid"], "mode": "full",
                           "ready": False, "bpm_key": False}
    assert tracks["3"] == {"state": "queued", "position": 1, "asked_for": True, "yours": True, "ready": False,
                           "bpm_key": False}
    # too long: how long it is, for "Skipped, 2 h 14 min is too long to analyse" (31a)
    assert tracks["5"] == {"state": "failed", "reason": "too_long", "ready": False, "bpm_key": False,
                           "duration": 240}
    assert "4" not in tracks
    sweep = snap["sweep"]
    assert sweep["running"] is True and sweep["total"] == 2 and sweep["in_line"] == 1 and sweep["yours"] == 1
    current = dict(sweep["current"])
    times, elapsed = current.pop("times"), current.pop("elapsed")
    assert current == {"step": "grid", "percent": 60, "asked_for": True, "track_id": "2",
                       "title": "Static Bloom", "artist": "Saltmarsh", "mode": "full", "now": "grid"}
    # each finished step's time, the one it's on running (HANDOFF 326)
    assert set(times) == {"read", "tempo"} and all(t >= 0 for t in times.values()) and elapsed >= 0
    seen["mid"] = snap
    gate.set()
    job.join(5)
    after = ondemand.progress(db, ["2", "3"], 2, job=job, settings={"analyze": True})
    assert after["tracks"] == {"2": {"state": "done", "ready": False, "bpm_key": True, "beat": "too_short"}, "3": {"state": "done", "ready": False, "bpm_key": True, "beat": "too_short"}}
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


def test_activity_offers_the_progress_while_it_runs_and_stop_to_admins_only(db, monkeypatch):
    from core.activity import feed

    job = _job()
    job._state = {"id": 1, "status": "running", "total": 3, "done": 1, "failed": 0, "waiting": None,
                  "tags_written": 0, "unreachable": 0}
    monkeypatch.setattr(worker, "JOB", job)

    class Viewer:
        def __init__(self, admin):
            self.is_admin = admin

    class Ctx:
        def __init__(self, admin):
            self.viewer = Viewer(admin)

    row = {"id": 1, "started_at": 0, "status": "running", "total": 3, "done": 1}
    item = feed._dj_job_item(Ctx(True), row)
    assert item["ref"]["dj_progress"] is True and item["ref"]["stop_path"] == "library/dj/stop"
    # a member's own run: no Stop that POST /api/library/dj/stop (admins) would refuse
    member = feed._dj_job_item(Ctx(False), row)
    assert member["ref"]["dj_progress"] is True and "stop_path" not in member["ref"]


# ── the review's fixes ───────────────────────────────────────────────────────

def test_m1_while_stopped_automatic_asks_are_refused_and_a_persons_ask_goes_in(client, db):
    client.job.held = True
    auto = client.post("/api/library/dj/analyse", json={"track_ids": ["2"]})
    assert auto.status_code == 409 and auto.get_json()["code"] == "held"
    also_auto = client.post("/api/library/dj/analyse", json={"track_ids": ["2"], "reason": "auto"})
    assert also_auto.status_code == 409
    assert client.job.running() is False and store.get(db, "2") is None
    assert client.post("/api/library/dj/analyse", json={"track_ids": ["2"], "reason": "x"}).status_code == 400
    asked = client.post("/api/library/dj/analyse", json={"track_ids": ["2"], "reason": "asked"})
    assert asked.status_code == 202 and asked.get_json()["started"] is True
    client.job.join(5)
    assert store.get(db, "2")["status"] == "done" and client.job.held is True
    # nothing to do while held is no refusal (it's quiet either way)
    assert client.post("/api/library/dj/analyse", json={"track_ids": ["1"]}).status_code == 202


def test_l1_a_request_as_a_run_saves_its_end_leaves_its_row_done(db):
    """The review's repro: an ask lands between the run's last state and its
    final save. The row stays done; the asked-for track still runs."""
    order = []
    job = _job(process=_done_process(order))
    real_save = job._save
    hit = {}

    def save(database, *, final=False, state=None):
        if final and not hit:
            hit["x"] = True
            # from a request's thread, as a real ask comes
            t = threading.Thread(target=lambda: hit.__setitem__("started", job.ask(database, ["3"], 2)["started"]))
            t.start()
            t.join(5)
        return real_save(database, final=final, state=state)

    job._save = save
    job.ask(db, ["2"], 2)
    job.join(5)
    deadline = time.time() + 5
    while (job.running() or order != ["2", "3"]) and time.time() < deadline:
        time.sleep(0.02)
        job.join(1)
    conn = db._get_connection()
    rows = [dict(r) for r in conn.execute(
        "SELECT id, status, note, done, total FROM library_jobs WHERE kind = ? ORDER BY id",
        (worker.KIND,)).fetchall()]
    conn.close()
    assert hit["started"] is False  # the finishing run takes it
    assert rows[0]["status"] == "done" and rows[0]["note"] is None and rows[0]["done"] == 1, rows
    assert order == ["2", "3"] and rows[-1]["status"] == "done"


def test_l1_a_persons_ask_as_a_stopped_run_saves_its_end_starts_the_next(db):
    """A run stopped by a person: a person's ask that lands while its end is
    being saved isn't left waiting in a line no run will take."""
    order = []
    done = _done_process(order)
    box = {}

    def process(d, t, **kw):
        if t == "2":
            box["job"].stop()  # a person's Stop while it works
        return done(d, t, **kw)

    job = box["job"] = _job(process=process)
    real_save = job._save
    hit = {}

    def save(database, *, final=False, state=None):
        if final and not hit:
            hit["x"] = True
            t = threading.Thread(target=lambda: hit.__setitem__("started", job.ask(database, ["3"], 2)["started"]))
            t.start()
            t.join(5)
        return real_save(database, final=final, state=state)

    job._save = save
    job.ask(db, ["2", "5"], 2)
    job.join(5)
    deadline = time.time() + 5
    while (job.running() or "3" not in order) and time.time() < deadline:
        time.sleep(0.02)
        job.join(1)
    assert hit["started"] is False  # the finishing run starts the next itself
    # 5 went with the Stop; 3, asked for after it, is analysed; the hold stays
    assert order == ["2", "3"] and job.held is True


def test_l5_a_track_this_run_took_already_gets_one_more_try_then_is_said(db):
    job = _job()
    job._state = {"status": "running", "total": 2}
    job._seen = {"2"}
    first = job.ask(db, ["2"], 2)
    assert first["added"] == ["2"] and first["taken"] == 0
    assert job._next([], peek=True) == ("2", True)  # it will be taken again
    job._next([])
    # while it's being worked out, asking again is already in line (re-review 5)
    working = job.ask(db, ["2"], 2)
    assert working["added"] == [] and working["already"] == 1 and working["taken"] == 0
    job._state["current"] = None  # its second try is over
    again = job.ask(db, ["2"], 2)
    assert again["added"] == [] and again["taken"] == 1


def test_l8_the_library_is_read_without_holding_the_jobs_lock(db, monkeypatch):
    job = _job()
    seen = {}
    real = store.pending_ids

    def pending(*a, **k):
        seen["locked"] = job._lock.locked()
        return real(*a, **k)

    monkeypatch.setattr(store, "pending_ids", pending)
    job.start(db, 1, manual=False)
    job.join(5)
    assert seen["locked"] is False


def test_l7_status_names_the_current_track_to_admins_only(client, db):
    gate = threading.Event()
    reached = threading.Event()

    def slow(d, t, **kw):
        reached.set()
        gate.wait(3)
        _finish(d, t)
        return "done"

    client.job._process = slow
    client.state["admin"] = True
    client.post("/api/library/dj/analyse", json={"track_ids": ["2"], "reason": "asked"})
    assert reached.wait(3)
    try:
        assert client.get("/api/library/dj/status").get_json()["job"]["current"] == "2"
        client.state["admin"] = False
        assert client.get("/api/library/dj/status").get_json()["job"]["current"] is None
    finally:
        gate.set()
        client.job.join(5)


def test_the_playlist_path_is_rate_limited_before_its_rows_are_read(client, monkeypatch):
    from core.dj import traktor

    clock = {"t": 100.0}
    monkeypatch.setattr(ondemand, "ASK_LIMIT", ondemand.RateLimit(every=1.0, clock=lambda: clock["t"]))
    reads = []
    monkeypatch.setattr(traktor, "playlist_tracks",
                        lambda d, pid, owner: reads.append(pid) or {"name": "P", "over": 0, "rows": []})
    assert client.post("/api/library/dj/analyse", json={"playlist_id": 9}).status_code == 202
    res = client.post("/api/library/dj/analyse", json={"playlist_id": 9})
    assert res.status_code == 429 and reads == [9]  # refused before reading again


def test_a_chunked_body_past_the_cap_is_refused(client):
    """No Content-Length (chunked): the body is still read only to the cap."""
    import io

    big = b'{"track_ids": ["' + b"x" * (70 * 1024) + b'"]}'
    for path in ("/api/library/dj/analyse", "/api/library/dj/progress"):
        res = client.post(path, input_stream=io.BytesIO(big), content_type="application/json",
                          headers={"Transfer-Encoding": "chunked"},
                          environ_overrides={"wsgi.input_terminated": True})
        assert res.status_code == 413, path


# ── the second review round ──────────────────────────────────────────────────

def test_re_review_8_the_plan_route_reads_disc_numbers(client, db):
    # 2 and 3 on disc 1 (tracks 1 and 2), 5 on disc 2 track 1, 6 on disc 2 track 3
    _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration) "
             "VALUES ('6', '10', '1', 'Sixth', '/m/6.flac', 240000)")
    for tid, disc, no in (("2", 1, 1), ("3", 1, 2), ("5", 2, 1), ("6", 2, 3)):
        _sql(db, "UPDATE tracks SET disc_number = ?, track_number = ? WHERE id = ?", (disc, no, tid))

    def plan(a, b):
        r = client.get(f"/api/library/dj/plan?from={a}&to={b}")
        assert r.status_code == 200, r.get_json()
        return r.get_json()["plan"]

    assert plan("2", "3")["fallback"]["code"] == "album_in_order"
    # the last of disc 1 into the first of disc 2
    assert plan("3", "5")["fallback"]["code"] == "album_in_order"
    # disc 1's first into disc 2's first: not in order
    assert (plan("2", "5").get("fallback") or {}).get("code") != "album_in_order"
    assert (plan("5", "6").get("fallback") or {}).get("code") != "album_in_order"


def test_re_review_4_a_persons_ask_after_stop_during_the_last_track_still_runs(db):
    """Stop pressed while track 2 is mid-analysis; a person's ask for 3 lands
    before it finishes. It's in line, and it runs once the stopped run ends."""
    order = []
    gate = threading.Event()
    reached = threading.Event()
    done = _done_process(order)

    def process(d, t, **kw):
        if t == "2":
            reached.set()
            gate.wait(5)
        return done(d, t, **kw)

    job = _job(process=process)
    job.ask(db, ["2"], 2)
    assert reached.wait(5)
    assert job.stop(by_person=True)
    res = job.ask(db, ["3"], 2, explicit=True)
    gate.set()
    deadline = time.time() + 5
    while (job.running() or "3" not in order) and time.time() < deadline:
        time.sleep(0.02)
        job.join(1)
    assert res["added"] == ["3"]
    assert order == ["2", "3"] and job.held is True


def test_re_review_4_a_run_stopped_by_the_setting_still_drops_its_line(db):
    order = []
    gate = threading.Event()
    reached = threading.Event()
    done = _done_process(order)
    prefs = {"analyze": True, "write_tags": False, "overwrite_tags": False}

    def process(d, t, **kw):
        if t == "2":
            reached.set()
            gate.wait(5)
        return done(d, t, **kw)

    job = _job(process=process, settings=lambda: prefs)
    job.ask(db, ["2", "3"], 2)
    assert reached.wait(5)
    prefs["analyze"] = False
    gate.set()
    job.join(5)
    time.sleep(0.2)
    job.join(5)
    assert order == ["2"] and job._priority == [] and not job.running()


def test_re_review_5_asking_for_the_track_being_worked_out_doesnt_run_it_twice(db):
    order = []
    gate = threading.Event()
    reached = threading.Event()
    done = _done_process(order)

    def process(d, t, **kw):
        if t == "2" and not reached.is_set():
            reached.set()
            gate.wait(5)
        return done(d, t, **kw)

    job = _job(process=process)
    job.ask(db, ["2"], 2)
    assert reached.wait(5)
    # another profile (or the Mix tab) asks for the track being worked on
    res = job.ask(db, ["2"], 3)
    assert res["added"] == [] and res["already"] == 1 and res["taken"] == 0
    gate.set()
    job.join(5)
    conn = db._get_connection()
    row = dict(conn.execute("SELECT total, done FROM library_jobs ORDER BY id DESC LIMIT 1").fetchone())
    conn.close()
    assert order == ["2"]
    assert row["done"] <= row["total"]


def test_re_review_5_done_never_passes_total(db):
    job = _job()
    job._state = {"status": "running", "total": 1, "done": 1, "failed": 0}
    job._bump("done")
    assert job._state["done"] == 2 and job._state["total"] == 2


def test_re_review_6_a_stop_while_the_scheduler_reads_the_library_holds_its_sweep(db, monkeypatch):
    """The scheduler saw held False; while start() read the library a person
    stopped a run (held True). No automatic sweep starts."""
    job = _job()
    real = store.pending_ids
    box = {}

    def pending(*a, **k):
        if "x" not in box:
            box["x"] = True
            gate = threading.Event()
            reached = threading.Event()

            def process(d, t, **kw):
                reached.set()
                gate.wait(5)
                _finish(d, t)
                return "done"

            job._process = process
            job.ask(db, ["5"], 2, explicit=True)
            assert reached.wait(5)
            job.stop(by_person=True)
            gate.set()
            job.join(5)
            time.sleep(0.2)
            job._process = _done_process(box.setdefault("order", []))
        return real(*a, **k)

    monkeypatch.setattr(store, "pending_ids", pending)
    assert not job.held
    state = job.start(db, 1, manual=False)  # what the scheduler calls
    job.join(5)
    assert job.held is True and state is None and not box.get("order")
