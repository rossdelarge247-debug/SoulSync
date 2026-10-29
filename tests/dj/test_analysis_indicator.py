"""Brief A, the analysis indicator (31a–31g), on the server: the line's order
(a person's own ask goes before what pages asked for, Analyse mine, an
admin's Move up), why each track is in line and who may see it (HANDOFF
325), each step's time (326), readiness (ready to mix, BPM and key, can't be
beat-matched), who stopped the sweep, when the next one comes, and what the
sweep waits for. The limits stand: a profile's own library, 200 in line, one
ask a second, the held 409."""

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


def _dj_done(db, track_id):
    store.save(db, track_id, {"bpm": 124.0, "musical_key": "8A", "energy": 6, "status": "done",
                              "dj_analyzer_version": worker.analyzer_version()})


def _grid(db, track_id, **result):
    base = {"status": "done", "kind": "constant", "bpm": 124.0, "period": 60 / 124.0, "first_beat": 0.1,
            "downbeat_index": 0, "meter": "4/4", "bars": 64, "confidence": 0.9, "beat_confidence": 0.9}
    base.update(result)
    grid_store.save_result(db, track_id, base, source_sig=None)


def _gated(gate: threading.Event, reached: threading.Event, slow=("2",)):
    def process(d, t, **kw):
        progress.mode("full")
        progress.step("read")
        if t in slow:
            reached.set()
            gate.wait(5)
        _dj_done(d, t)
        _grid(d, t)
        return "done"
    return process


def _job(**kw):
    defaults = dict(busy=lambda d: None, away=lambda: False, sleep_floor=0, rest_factor=0,
                    settings=lambda: {"analyze": True, "write_tags": False, "overwrite_tags": False})
    defaults.update(kw)
    return worker.DjAnalysisJob(**defaults)


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "indicator.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Tidewater')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'Lantern')")
    for tid, title in (("1", "Night Ferry"), ("2", "Canopy"), ("3", "Static Bloom"), ("4", "Undertow"),
                       ("5", "Glass Harbour"), ("6", "Low Orbit"), ("7", "Brass Tide")):
        _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration) "
                       "VALUES (?, '10', '1', ?, ?, 240000)", (tid, title, f"/m/{tid}.flac"))
    # 9 is another profile's own library (outside the shared one)
    _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration, owner_profile_id) "
                   "VALUES ('9', '10', '1', 'Theirs', '/m/9.flac', 240000, 7)")
    for pid, name, admin in ((1, "Ross", 1), (2, "Mira K.", 0), (3, "Sam", 0)):
        _sql(database, "INSERT OR REPLACE INTO profiles (id, name, is_admin) VALUES (?, ?, ?)", (pid, name, admin))
    _sql(database, "INSERT INTO dj_sets (id, profile_id, name) VALUES (40, 2, 'Sunday Set')")
    _sql(database, "INSERT INTO dj_sets (id, profile_id, name) VALUES (41, 3, 'Sam''s Set')")
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
    gate, reached = threading.Event(), threading.Event()
    job = _job(process=_gated(gate, reached, slow=("1",)))
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
    c.state, c.job, c.gate, c.reached = state, job, gate, reached
    yield c
    gate.set()
    job.join(5)


def _busy_on_1(client):
    """Start a run held on track 1, so the line can be looked at."""
    assert client.post("/api/library/dj/analyse", json={"track_ids": ["1"], "reason": "asked"}).status_code == 202
    assert client.reached.wait(3)


def _line_order(client):
    return [t for t, _front, _why in client.job.queue_snapshot([], line=True)["line"]]


# ── 325: the line's order, and why each track is in it ───────────────────────

def test_a_persons_own_ask_goes_before_what_pages_asked_for(client):
    _busy_on_1(client)
    client.post("/api/library/dj/analyse", json={"track_ids": ["3", "4"], "source": "set", "set_id": 40})
    client.post("/api/library/dj/analyse", json={"track_ids": ["5"], "reason": "asked"})
    assert _line_order(client) == ["5", "3", "4"]
    # positions are ordinals, and follow the jump
    tracks = client.post("/api/library/dj/progress", json={"track_ids": ["3", "5"]}).get_json()["tracks"]
    assert tracks["5"]["position"] == 1 and tracks["3"]["position"] == 2
    # a page's track asked for again by a person joins the front, after it
    client.post("/api/library/dj/analyse", json={"track_ids": ["4"], "reason": "asked"})
    assert _line_order(client) == ["5", "4", "3"]


def test_analyse_mine_moves_the_callers_tracks_to_the_front(client):
    _busy_on_1(client)
    client.state["profile"] = 3
    client.post("/api/library/dj/analyse", json={"track_ids": ["3", "4"], "source": "up_next"})
    client.state["profile"] = 2
    client.post("/api/library/dj/analyse", json={"track_ids": ["5", "6"], "source": "set", "set_id": 40})
    assert _line_order(client) == ["3", "4", "5", "6"]
    # an automatic ask can't be Analyse mine
    assert client.post("/api/library/dj/analyse", json={"mine": True}).status_code == 400
    res = client.post("/api/library/dj/analyse", json={"mine": True, "reason": "asked"})
    assert res.status_code == 202 and res.get_json()["moved"] == 2 and res.get_json()["yours"] == 2
    assert _line_order(client) == ["5", "6", "3", "4"]
    sweep = client.post("/api/library/dj/progress", json={"track_ids": []}).get_json()["sweep"]
    assert sweep["yours"] == 2 and sweep["yours_first"] is True
    client.state["profile"] = 3
    sweep = client.post("/api/library/dj/progress", json={"track_ids": []}).get_json()["sweep"]
    assert sweep["yours"] == 2 and sweep["yours_first"] is False


def test_analyse_mine_is_rate_limited_and_refused_while_off(client, monkeypatch):
    monkeypatch.setattr(ondemand, "ASK_LIMIT", ondemand.RateLimit(every=60))
    assert client.post("/api/library/dj/analyse", json={"mine": True, "reason": "asked"}).status_code == 202
    assert client.post("/api/library/dj/analyse", json={"mine": True, "reason": "asked"}).status_code == 429
    monkeypatch.setattr(ondemand, "ASK_LIMIT", ondemand.RateLimit(every=0))
    monkeypatch.setattr(worker, "settings_state",
                        lambda: {"analyze": False, "write_tags": False, "overwrite_tags": False})
    res = client.post("/api/library/dj/analyse", json={"mine": True, "reason": "asked"})
    assert res.status_code == 409 and res.get_json()["code"] == "off"


def test_an_admins_move_up_goes_to_the_very_front(client):
    _busy_on_1(client)
    client.post("/api/library/dj/analyse", json={"track_ids": ["3"], "reason": "asked"})
    client.post("/api/library/dj/analyse", json={"track_ids": ["4", "5"]})
    client.state["admin"] = True
    client.state["profile"] = 1
    assert client.post("/api/library/dj/start", json={"track_id": "5"}).status_code == 202
    assert _line_order(client) == ["5", "3", "4"]
    client.state["admin"] = False
    assert client.post("/api/library/dj/start", json={"track_id": "4"}).status_code == 403


def test_source_and_set_id_are_checked(client):
    assert client.post("/api/library/dj/analyse", json={"track_ids": ["3"], "source": "x"}).status_code == 400
    for bad in ("40", True, 0, -1, 1.5):
        assert client.post("/api/library/dj/analyse",
                           json={"track_ids": ["3"], "source": "set", "set_id": bad}).status_code == 400


def test_a_member_sees_its_own_tracks_in_line_and_a_count_of_the_rest(client):
    _busy_on_1(client)
    client.state["profile"] = 3
    client.post("/api/library/dj/analyse", json={"track_ids": ["3"], "source": "set", "set_id": 41})
    client.state["profile"] = 2
    client.post("/api/library/dj/analyse", json={"track_ids": ["4"], "source": "set", "set_id": 40})
    client.post("/api/library/dj/analyse", json={"track_ids": ["5"], "reason": "asked"})
    client.post("/api/library/dj/analyse", json={"track_ids": ["6"], "source": "up_next"})
    # without line: nothing about the line's tracks
    plain = client.post("/api/library/dj/progress", json={"track_ids": []}).get_json()["sweep"]
    assert "line" not in plain
    sweep = client.post("/api/library/dj/progress", json={"track_ids": [], "line": True}).get_json()["sweep"]
    line = sweep["line"]
    assert [e["track_id"] for e in line] == ["5", "4", "6"]
    assert line[0] == {"track_id": "5", "title": "Glass Harbour", "artist": "Tidewater", "position": 1,
                       "source": "asked", "by": "you", "set_name": None, "front": True}
    assert line[1]["source"] == "set" and line[1]["set_name"] == "Sunday Set" and line[1]["position"] == 3
    assert line[2]["source"] == "up_next"
    # Sam's track is only counted: never named, nor who asked, nor Sam's set
    assert sweep["line_more"] == 1
    assert all(e["track_id"] != "3" for e in line)


def test_an_admin_sees_who_asked_but_not_another_profiles_set_name(client):
    _busy_on_1(client)
    client.post("/api/library/dj/analyse", json={"track_ids": ["4"], "source": "set", "set_id": 40})
    client.post("/api/library/dj/analyse", json={"track_ids": ["5"], "reason": "asked"})
    client.state.update(profile=1, admin=True)
    client.post("/api/library/dj/analyse", json={"track_ids": ["6"], "source": "up_next"})
    line = client.post("/api/library/dj/progress", json={"track_ids": [], "line": True}).get_json()["sweep"]["line"]
    by = {e["track_id"]: (e["by"], e["source"], e["set_name"]) for e in line}
    assert by == {"5": ("Mira K.", "asked", None), "4": ("Mira K.", "set", None), "6": ("you", "up_next", None)}


def test_a_set_id_names_only_the_askers_own_set(client):
    _busy_on_1(client)
    # Mira says Sam's set: the line doesn't name it
    client.post("/api/library/dj/analyse", json={"track_ids": ["4"], "source": "set", "set_id": 41})
    line = client.post("/api/library/dj/progress", json={"track_ids": [], "line": True}).get_json()["sweep"]["line"]
    assert line[0]["source"] == "set" and line[0]["set_name"] is None


def test_another_profiles_library_is_never_in_the_line_it_sees(client, db):
    _busy_on_1(client)
    client.job.ask(db, ["9"], 7, source="asked")
    client.state.update(profile=1, admin=True)
    sweep = client.post("/api/library/dj/progress", json={"track_ids": [], "line": True}).get_json()["sweep"]
    assert sweep["line"] == [] and sweep["line_more"] == 1


def test_the_200_cap_and_the_held_409_stand(client, db):
    _busy_on_1(client)
    many = [str(100 + i) for i in range(205)]
    result = client.job.ask(db, many, 2, explicit=True, source="asked")
    assert len(result["added"]) == 200 and result["over"] == 5
    client.job.stop(by_person=True, profile_id=1)
    res = client.post("/api/library/dj/analyse", json={"track_ids": ["3"], "source": "set", "set_id": 40})
    assert res.status_code == 409 and res.get_json()["code"] == "held"


# ── 326: each step's time ─────────────────────────────────────────────────────

def test_step_times_fold_the_tag_write_into_energy():
    live = {"steps": [("read", 10.0), ("tempo", 11.2), ("key", 12.0), ("energy", 12.6), ("tags", 12.8),
                      ("grid", 12.9), ]}
    out = ondemand._step_times(live, 14.0)
    assert out == {"times": {"read": 1.2, "tempo": 0.8, "key": 0.6, "energy": 0.3}, "now": "grid",
                   "elapsed": 1.1}
    # a grid-only run: tempo, key and energy were known
    grid_only = ondemand._step_times({"steps": [("read", 5.0), ("grid", 7.5)]}, 8.0)
    assert grid_only == {"times": {"read": 2.5}, "now": "grid", "elapsed": 0.5}
    assert ondemand._step_times({}, 1.0) == {"times": {}, "now": None, "elapsed": None}


def test_the_running_job_keeps_when_each_step_started(db):
    gate, reached = threading.Event(), threading.Event()

    def process(d, t, **kw):
        progress.mode("full")
        progress.step("read")
        progress.step("tempo")
        progress.step("key")
        reached.set()
        gate.wait(3)
        _dj_done(d, t)
        return "done"

    job = _job(process=process)
    job.ask(db, ["2"], 2)
    assert reached.wait(3)
    live = job.live()
    assert [s for s, _at in live["steps"]] == ["read", "tempo", "key"]
    sweep = ondemand.progress(db, [], 2, job=job, settings={"analyze": True})["sweep"]
    assert set(sweep["current"]["times"]) == {"read", "tempo"} and sweep["current"]["now"] == "key"
    gate.set()
    job.join(5)
    assert job.live() is None


def test_another_profiles_current_track_has_no_times(db, monkeypatch):
    from core.library_scope import reset_library_scope, set_library_scope

    gate, reached = threading.Event(), threading.Event()
    job = _job(process=_gated(gate, reached, slow=("9",)))
    job.ask(db, ["9"], 7)
    assert reached.wait(3)
    token = set_library_scope("shared")
    try:
        sweep = ondemand.progress(db, [], 2, job=job, settings={"analyze": True})["sweep"]
    finally:
        reset_library_scope(token)
    assert sweep["current"]["track_id"] is None and sweep["current"]["times"] == {}
    assert sweep["current"]["title"] is None and sweep["current"]["artist"] is None
    gate.set()
    job.join(5)


# ── readiness: ready to mix, BPM and key, can't be beat-matched ──────────────

def test_ready_to_mix_means_a_grid_at_this_version(db):
    job = _job()
    _dj_done(db, "1")
    _grid(db, "1")                     # ready
    _dj_done(db, "2")                  # BPM and key, no grid yet
    _dj_done(db, "3")
    _grid(db, "3", meter="not_4_4")    # analysed, not 4/4
    _dj_done(db, "4")
    grid_store.save_result(db, "4", {"status": "none", "reason": "no_beat"}, source_sig=None)
    _dj_done(db, "5")
    _grid(db, "5")
    _sql(db, "UPDATE track_grid SET grid_version = ? WHERE track_id = '5'", (GRID_VERSION - 1,))
    tracks = ondemand.progress(db, ["1", "2", "3", "4", "5", "6"], 2, job=job, settings={"analyze": True})["tracks"]
    assert tracks["1"] == {"state": "done", "ready": True, "bpm_key": True}
    assert tracks["2"]["state"] == "waiting" and tracks["2"]["reason"] == "not_queued"
    assert tracks["2"]["bpm_key"] is True and tracks["2"]["ready"] is False
    assert tracks["3"] == {"state": "done", "ready": False, "bpm_key": True, "beat": "not_4_4"}
    assert tracks["4"] == {"state": "done", "ready": False, "bpm_key": True, "beat": "no_beat"}
    # a grid from an older version isn't ready
    assert tracks["5"]["ready"] is False and tracks["5"]["state"] == "waiting"
    assert tracks["6"]["bpm_key"] is False and tracks["6"]["ready"] is False


# ── who stopped it, the next sweep, what it waits for ────────────────────────

def test_who_stopped_it_is_named_to_admins_and_a_start_forgets_it(client):
    _busy_on_1(client)
    client.state.update(profile=1, admin=True)
    assert client.post("/api/library/dj/stop").status_code == 200
    client.gate.set()
    client.job.join(5)
    sweep = client.post("/api/library/dj/progress", json={"track_ids": []}).get_json()["sweep"]
    assert sweep["held"] is True and sweep["held_by"] == "Ross" and sweep["held_by_you"] is True
    assert sweep["next_in"] is None  # held: no next sweep
    client.state.update(profile=2, admin=False)
    sweep = client.post("/api/library/dj/progress", json={"track_ids": []}).get_json()["sweep"]
    assert sweep["held"] is True and sweep["held_by"] is None and sweep["held_by_you"] is False
    client.state.update(profile=1, admin=True)
    client.post("/api/library/dj/start")
    client.job.join(5)
    assert client.job.held is False and client.job.held_by is None


def test_the_next_sweep_is_counted_down_from_the_scheduler(monkeypatch):
    calls = []

    class _Job:
        held = False

        def running(self):
            return False

        def start(self, *a, **kw):
            calls.append(a)

    monkeypatch.setattr(worker, "JOB", _Job())
    monkeypatch.setattr(worker, "settings_state", lambda: {"analyze": True})
    worker.stop_scheduler()
    if worker._scheduler is not None:
        worker._scheduler.join(2)
    worker._scheduler = None
    assert worker.next_sweep_in() is None
    try:
        assert worker.start_scheduler(lambda: None, first_delay=1500, interval=1800) is True
        deadline = time.time() + 2
        while worker._next_sweep_at is None and time.time() < deadline:
            time.sleep(0.01)
        left = worker.next_sweep_in()
        assert left is not None and 1490 <= left <= 1500
        worker.JOB.held = True
        assert worker.next_sweep_in() is None
    finally:
        worker.stop_scheduler()
        worker._scheduler.join(2)
        worker._scheduler = None
    assert worker._next_sweep_at is None and calls == []


def test_waiting_says_how_many_downloads_and_names_the_drive_to_admins(db, monkeypatch):
    """A member's numbers are their own (review L9): their own download
    batches; the import keeps no owner, so only admins get its count."""
    from core.activity import feed
    from core.drives import markers

    monkeypatch.setattr(feed, "snapshot_live_batches",
                        lambda: {"a": {"total": 5, "done": 1, "failed": 1, "profile_id": 2},
                                 "b": {"total": 1, "done": 0, "profile_id": 3}})
    assert ondemand._wait_detail(db, "download", True) == {"count": 4, "drive": None}
    assert ondemand._wait_detail(db, "download", False, 2) == {"count": 3, "drive": None}
    assert ondemand._wait_detail(db, "download", False, 4) == {"count": None, "drive": None}

    class _Watch:
        def peek(self):
            return {"folders": {"library": {"drive": "Music HD"}}}

    monkeypatch.setattr(markers, "get_watch", lambda: _Watch())
    assert ondemand._wait_detail(db, "drive_away", True) == {"count": None, "drive": "Music HD"}
    assert ondemand._wait_detail(db, "drive_away", False) == {"count": None, "drive": None}
    _sql(db, "INSERT INTO auto_import_history (folder_name, folder_path, status, total_files) "
             "VALUES ('x', '/x', 'processing', 42)")
    assert ondemand._wait_detail(db, "import", True) == {"count": 42, "drive": None}
    assert ondemand._wait_detail(db, "import", False, 2) == {"count": None, "drive": None}
    assert ondemand._wait_detail(db, None, True) is None


def test_the_sweeps_own_tracks_left_are_counted(db):
    gate, reached = threading.Event(), threading.Event()
    job = _job(process=_gated(gate, reached, slow=("1",)))
    for t in ("2", "3", "4"):
        store.mark(db, t, "stale", None, 0)
    job.start(db, 1, manual=True, first="1")
    try:
        assert reached.wait(3)
        snap = job.queue_snapshot([])
        # every track still to do but the one being worked out
        assert snap["in_line"] == 0 and snap["left"] == snap["live"]["total"] - 1
    finally:
        gate.set()
        job.join(5)


def test_the_ask_says_where_its_tracks_are_for_the_added_toast(client):
    _busy_on_1(client)
    client.post("/api/library/dj/analyse", json={"track_ids": ["3"], "source": "set", "set_id": 40})
    body = client.post("/api/library/dj/analyse",
                       json={"track_ids": ["4", "5"], "source": "set", "set_id": 40}).get_json()
    # "Added to Sunday Set · #7 · analysing, 2nd in line"
    assert body["position"] == 2 and body["working"] is False
    body = client.post("/api/library/dj/analyse", json={"track_ids": ["1"], "reason": "asked"}).get_json()
    assert body["working"] is True and body["position"] is None
    _finish_all = client.post("/api/library/dj/analyse", json={"track_ids": []}).get_json()
    assert _finish_all["position"] is None and _finish_all["working"] is False


# ── Cancel and Try again ─────────────────────────────────────────────────────

def test_cancel_takes_only_the_callers_own_asks_out_of_the_line(client):
    _busy_on_1(client)
    client.post("/api/library/dj/analyse", json={"track_ids": ["3", "4"], "source": "mix"})
    client.state["profile"] = 3
    client.post("/api/library/dj/analyse", json={"track_ids": ["4"], "source": "up_next"})
    client.state["profile"] = 2
    total = client.job.live()["total"]
    res = client.post("/api/library/dj/analyse", json={"track_ids": ["3", "4", "5"], "cancel": True})
    assert res.status_code == 200 and res.get_json()["withdrawn"] == 2
    # 3 leaves the line; 4 stays for Sam
    assert _line_order(client) == ["4"]
    assert client.job.live()["total"] == total - 1
    tracks = client.post("/api/library/dj/progress", json={"track_ids": ["3"]}).get_json()["tracks"]
    assert tracks["3"]["state"] == "waiting" and tracks["3"]["reason"] == "not_queued"
    assert client.post("/api/library/dj/analyse", json={"playlist_id": 1, "cancel": True}).status_code == 400


def test_try_again_is_an_admins_and_asks_a_failed_track_again(client, db):
    store.save(db, "6", {"status": "error", "error": "bad file", "dj_analyzer_version": worker.analyzer_version()})
    _dj_done(db, "7")
    grid_store.mark(db, "7", "error", "no beats", source_sig=None)
    body = client.post("/api/library/dj/analyse", json={"track_ids": ["6", "7"], "reason": "asked"}).get_json()
    assert body["cant"] == 2 and body["queued"] == 0
    # a member can't, nor can an automatic ask
    assert client.post("/api/library/dj/analyse",
                       json={"track_ids": ["6"], "reason": "asked", "retry": True}).status_code == 403
    client.state.update(profile=1, admin=True)
    assert client.post("/api/library/dj/analyse", json={"track_ids": ["6"], "retry": True}).status_code == 403
    client.gate.set()
    body = client.post("/api/library/dj/analyse",
                       json={"track_ids": ["6", "7"], "reason": "asked", "retry": True}).get_json()
    assert body["queued"] == 2 and body["cant"] == 0
    client.job.join(5)
    # 7's BPM and key were kept while its grid was looked for again
    assert store.get(db, "7")["bpm"] == 124.0
    tracks = client.post("/api/library/dj/progress", json={"track_ids": ["6", "7"]}).get_json()["tracks"]
    assert tracks["6"]["ready"] is True and tracks["7"]["ready"] is True


def test_analyse_again_is_an_admins_and_finds_a_done_tracks_grid_again(client, db):
    """Ross's report of 28 October: grids that said "no steady beat" were
    done, so asking for them again did nothing. Analyse again (an admin's)
    finds the grid again; BPM and key stay."""
    _dj_done(db, "7")
    grid_store.save_result(db, "7", {"status": "none", "reason": "no_beat", "beat_confidence": 0.05},
                           source_sig=None)
    body = client.post("/api/library/dj/analyse", json={"track_ids": ["7"], "reason": "asked"}).get_json()
    assert body["already_done"] == 1 and body["queued"] == 0
    # a member can't, nor can an automatic ask
    assert client.post("/api/library/dj/analyse",
                       json={"track_ids": ["7"], "reason": "asked", "again": True}).status_code == 403
    client.state.update(profile=1, admin=True)
    assert client.post("/api/library/dj/analyse", json={"track_ids": ["7"], "again": True}).status_code == 403
    client.gate.set()
    body = client.post("/api/library/dj/analyse",
                       json={"track_ids": ["7"], "reason": "asked", "again": True}).get_json()
    assert body["queued"] == 1 and body["already_done"] == 0
    client.job.join(5)
    assert store.get(db, "7")["bpm"] == 124.0
    tracks = client.post("/api/library/dj/progress", json={"track_ids": ["7"]}).get_json()["tracks"]
    assert tracks["7"]["state"] == "done" and tracks["7"]["ready"] is True


def test_analyse_again_says_in_line_and_leaves_the_grid_until_it_is_taken(client, db):
    """M2: nothing is wiped when asked; the track says it's in line."""
    _dj_done(db, "7")
    grid_store.save_result(db, "7", {"status": "none", "reason": "no_beat", "beat_confidence": 0.05},
                           source_sig=None)
    client.state.update(profile=1, admin=True)
    # the gate stays shut: the line doesn't move
    body = client.post("/api/library/dj/analyse",
                       json={"track_ids": ["7"], "reason": "asked", "again": True}).get_json()
    assert body["queued"] == 1
    assert grid_store.get(db, "7")["status"] == "none"  # not marked yet
    tracks = client.post("/api/library/dj/progress", json={"track_ids": ["7"]}).get_json()["tracks"]
    assert tracks["7"]["state"] in ("queued", "working")
    client.gate.set()
    client.job.join(5)


def test_join_waits_for_a_next_run_made_but_not_yet_started():
    """A run's end starts the next run's thread; a join that lands between
    the thread being made and started used to raise (a flaky test)."""
    job = _job()
    pending = threading.Thread(target=lambda: None)
    job._thread = pending
    job.join(0.05)  # not started: waits, then gives up, without raising
    threading.Timer(0.02, pending.start).start()
    job.join(2)
    assert pending.ident is not None and not pending.is_alive()


# ── the Brief A review's fixes ───────────────────────────────────────────────

def test_m1_ready_to_mix_is_the_planners_own_rule(db, monkeypatch):
    """A grid saved from 0.3 but under the planner's 0.5, or with a meter
    not worked out, isn't "Ready to mix": the planner would echo out or cut
    (the reviewer's probe, as a test). The count follows the same rule."""
    from core.dj import planner
    from core.library_scope import reset_library_scope, set_library_scope

    for t, extra in (("1", {"beat_confidence": 0.4}), ("2", {"meter": "unknown"}), ("3", {}),
                     ("4", {"meter": None})):
        _dj_done(db, t)
        _grid(db, t, **extra)
    token = set_library_scope("shared")
    try:
        tracks = ondemand.progress(db, ["1", "2", "3", "4"], 2, job=_job(), settings={"analyze": True})["tracks"]
    finally:
        reset_library_scope(token)
    for t in ("1", "2", "3", "4"):
        trusted = planner._trust(grid_store.public(grid_store.get(db, t), t), "X") is None
        assert tracks[t]["ready"] is trusted, t
    # found, but not sure enough: not "no steady beat" (Ross's report of 28 October)
    assert tracks["1"]["beat"] == "unsure" and tracks["2"]["beat"] == "not_4_4"
    assert tracks["3"]["ready"] is True and tracks["4"]["ready"] is True
    counts = grid_store.counts(db)
    assert counts["done"] == 4 and counts["ready"] == 2


def test_m1_the_planner_and_readiness_share_one_predicate():
    from core.dj import grid, planner

    assert planner.BEAT_CONFIDENT == grid.BEAT_CONFIDENT == grid_store.BEAT_CONFIDENT
    assert grid.beatmatch_problem(0.49, "4/4") == "low_confidence"
    assert grid.beatmatch_problem(0.9, "unknown") == "not_4_4"
    assert grid.beatmatch_problem(0.9, None) is None
    assert grid.beatmatch_problem(None, "4/4") == "low_confidence"


def test_l2_cancel_takes_off_the_total_only_what_an_ask_added(db):
    """A track the run took already and let in again is counted once; a
    Cancel of it doesn't push the total under what's done (the reviewer's
    probe, as a test)."""
    gate, reached = threading.Event(), threading.Event()

    def process(d, t, **kw):
        if t == "3":
            reached.set()
            gate.wait(5)
            return "done"
        return "unreachable"

    job = _job(process=process)
    job.ask(db, ["2", "3"], 2)
    assert reached.wait(3)
    job.ask(db, ["2"], 2)  # taken already, needs again: one more try
    job.withdraw(["2"], 2)
    live = job.live()
    try:
        assert live["total"] == 2 and live["unreachable"] == 1 and live["current"] == "3"
    finally:
        gate.set()
        job.join(5)


def test_l3_a_track_put_back_is_done_with_for_left(db):
    gate, reached = threading.Event(), threading.Event()
    calls = []

    def process(d, t, **kw):
        calls.append(t)
        if t == "3":
            reached.set()
            gate.wait(5)
            return "done"
        return "deferred"

    job = _job(process=process)
    job.ask(db, ["2", "3"], 2)
    assert reached.wait(3)
    snap = job.queue_snapshot([])
    try:
        assert calls[0] == "2" and snap["left"] == 0 and snap["in_line"] == 0
    finally:
        gate.set()
        job.join(5)


def test_l4_each_queued_entry_says_whether_its_yours_and_cancel_works_when_off(client, monkeypatch):
    _busy_on_1(client)
    client.state["profile"] = 3
    client.post("/api/library/dj/analyse", json={"track_ids": ["3"]})
    client.state["profile"] = 2
    client.post("/api/library/dj/analyse", json={"track_ids": ["4"]})
    tracks = client.post("/api/library/dj/progress", json={"track_ids": ["3", "4"]}).get_json()["tracks"]
    assert tracks["3"]["yours"] is False and tracks["4"]["yours"] is True
    monkeypatch.setattr(worker, "settings_state",
                        lambda: {"analyze": False, "write_tags": False, "overwrite_tags": False})
    res = client.post("/api/library/dj/analyse", json={"track_ids": ["4"], "cancel": True})
    assert res.status_code == 200 and res.get_json()["withdrawn"] == 1


def test_l5_move_up_with_nothing_running_never_starts_a_full_sweep_nor_lifts_a_stop(client, db, monkeypatch):
    order = []

    def process(d, t, **kw):
        order.append(t)
        _dj_done(d, t)
        _grid(d, t)
        return "done"

    job = _job(process=process)
    job.held, job.held_by = True, 1
    monkeypatch.setattr(worker, "JOB", job)
    client.state.update(profile=1, admin=True)
    res = client.post("/api/library/dj/start", json={"track_id": "5"})
    assert res.status_code == 202
    job.join(5)
    assert order == ["5"] and job.held is True and job.held_by == 1
    # done already: nothing to move up
    res = client.post("/api/library/dj/start", json={"track_id": "5"})
    assert res.status_code == 409 and res.get_json()["code"] == "nothing_to_move"
    monkeypatch.setattr(ondemand, "ASK_LIMIT", ondemand.RateLimit(every=60))
    assert client.post("/api/library/dj/start", json={"track_id": "6"}).status_code == 202
    assert client.post("/api/library/dj/start", json={"track_id": "7"}).status_code == 429


def test_l5_move_up_reads_you_asked_for_the_admin(client):
    _busy_on_1(client)
    client.post("/api/library/dj/analyse", json={"track_ids": ["3", "4"], "source": "set", "set_id": 40})
    client.state.update(profile=1, admin=True)
    assert client.post("/api/library/dj/start", json={"track_id": "4"}).status_code == 202
    line = client.post("/api/library/dj/progress", json={"track_ids": [], "line": True}).get_json()["sweep"]["line"]
    assert line[0]["track_id"] == "4" and line[0]["by"] == "you" and line[0]["source"] == "asked"


def test_l6_an_admins_line_is_filled_from_its_library_first(client, db):
    _busy_on_1(client)
    many = [str(200 + i) for i in range(10)]
    client.job.ask(db, many, 7, source="asked")  # another library's tracks, ahead
    client.post("/api/library/dj/analyse", json={"track_ids": ["3", "4"]})
    client.state.update(profile=1, admin=True)
    sweep = client.post("/api/library/dj/progress", json={"track_ids": [], "line": True}).get_json()["sweep"]
    assert [e["track_id"] for e in sweep["line"]] == ["3", "4"] and sweep["line_more"] == 10


def test_l8_join_gives_up_on_a_thread_that_never_starts():
    job = _job()
    job._thread = threading.Thread(target=lambda: None)
    t0 = time.monotonic()
    job.join(0.2)
    assert time.monotonic() - t0 < 1.0
    # a thread whose start failed: join returns after its bound, never hangs
    job._thread = threading.Thread(target=lambda: None)
    t0 = time.monotonic()
    job.join(None)
    assert 4.0 <= time.monotonic() - t0 < 7.0


def test_l10_up_nexts_next_transition_goes_before_a_members_bulk_ask(client, db):
    """A member's 200-track Analyse mine doesn't delay the admin's next mix."""
    _busy_on_1(client)
    many = [str(300 + i) for i in range(200)]
    for i, t in enumerate(many):
        _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration) "
                 "VALUES (?, '10', '1', ?, ?, 240000)", (t, f"Bulk {i}", f"/m/{t}.flac"))
    client.state["profile"] = 3
    assert client.post("/api/library/dj/analyse", json={"track_ids": many, "reason": "asked"}).get_json()["queued"] == 200
    client.state.update(profile=1, admin=True)
    client.post("/api/library/dj/analyse", json={"track_ids": ["5", "6"], "source": "up_next", "soon": True})
    order = _line_order(client)
    assert order[:2] == ["5", "6"] and order[2] == "300"
    # page asks wait behind people's: an Up next ask that isn't the next transition
    client.post("/api/library/dj/analyse", json={"track_ids": ["7"], "source": "up_next"})
    assert _line_order(client)[-1] == "7"
    # the next transition moves on: the earlier pair drops back to its own tier
    client.post("/api/library/dj/analyse", json={"track_ids": ["7"], "source": "up_next", "soon": True})
    order = _line_order(client)
    assert order[0] == "7" and order.index("5") > 200
    # soon is Up next's, two tracks at most
    assert client.post("/api/library/dj/analyse", json={"track_ids": ["3"], "soon": True}).status_code == 400
    assert client.post("/api/library/dj/analyse",
                       json={"track_ids": ["2", "3", "4"], "source": "up_next", "soon": True}).status_code == 400


def test_l11_analyse_mine_keeps_why_and_a_plain_poll_copies_no_line(client):
    _busy_on_1(client)
    client.post("/api/library/dj/analyse", json={"track_ids": ["4"], "source": "set", "set_id": 40})
    client.post("/api/library/dj/analyse", json={"mine": True, "reason": "asked"})
    line = client.post("/api/library/dj/progress", json={"track_ids": [], "line": True}).get_json()["sweep"]["line"]
    assert line[0]["source"] == "set" and line[0]["set_name"] == "Sunday Set" and line[0]["front"] is True
    assert client.job.queue_snapshot([], 2)["line"] is None


def test_the_200_cap_holds_at_the_route(client, db):
    _busy_on_1(client)
    many = [str(600 + i) for i in range(205)]
    for t in many:
        _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration) "
                 "VALUES (?, '10', '1', ?, ?, 240000)", (t, f"T{t}", f"/m/{t}.flac"))
    body = client.post("/api/library/dj/analyse", json={"track_ids": many[:205]}).get_json()
    assert body["queued"] == 200 and body["over_limit"] == 5 and body["limit"] == 200


# ── the re-review's second round ─────────────────────────────────────────────

def _more_tracks(db, ids):
    for t in ids:
        _sql(db, "INSERT OR IGNORE INTO tracks (id, album_id, artist_id, title, file_path, duration) "
                 "VALUES (?, '10', '1', ?, ?, 240000)", (t, f"T{t}", f"/m/{t}.flac"))


def test_n1_soon_pairs_dropped_a_tier_go_to_its_end(client, db):
    """Sam asks for 2 and 3; Mira sends four Up next pairs (the reviewer's
    probe): each earlier pair goes to the end of the people's tier, behind
    Sam's earlier asks, never ahead of them."""
    _more_tracks(db, ["8", "10", "11"])
    _busy_on_1(client)
    client.state["profile"] = 3
    client.post("/api/library/dj/analyse", json={"track_ids": ["2", "3"], "reason": "asked"})
    client.state["profile"] = 2
    for pair in (["4", "5"], ["6", "7"], ["8", "2"], ["10", "11"]):
        assert client.post("/api/library/dj/analyse",
                           json={"track_ids": pair, "reason": "asked", "source": "up_next",
                                 "soon": True}).status_code == 202
    assert _line_order(client) == ["10", "11", "3", "4", "5", "6", "7", "8", "2"]


def test_n1_a_page_ask_never_heads_the_tier_it_drops_to(client, db):
    _busy_on_1(client)
    client.state["profile"] = 3
    client.post("/api/library/dj/analyse", json={"track_ids": ["2"], "source": "set", "set_id": 41})
    client.state["profile"] = 2
    client.post("/api/library/dj/analyse", json={"track_ids": ["4", "5"], "source": "up_next", "soon": True})
    assert _line_order(client) == ["4", "5", "2"]
    client.post("/api/library/dj/analyse", json={"track_ids": ["6", "7"], "source": "up_next", "soon": True})
    assert _line_order(client) == ["6", "7", "2", "4", "5"]
    # Move up stays newest first
    client.state.update(profile=1, admin=True)
    client.post("/api/library/dj/start", json={"track_id": "4"})
    client.post("/api/library/dj/start", json={"track_id": "2"})
    assert _line_order(client)[:4] == ["2", "4", "6", "7"]


def test_l2_cancel_after_a_retry_of_an_ask_added_track_keeps_the_total(db):
    """The reviewer's sequence: 2 and 3 added to a run by an ask, 2 taken
    (unreachable), asked again (one more try), then cancelled."""
    g1, g3, r1, r3 = threading.Event(), threading.Event(), threading.Event(), threading.Event()

    def process(d, t, **kw):
        if t == "1":
            r1.set()
            g1.wait(5)
            return "done"
        if t == "3":
            r3.set()
            g3.wait(5)
            return "done"
        return "unreachable"

    job = _job(process=process)
    job.ask(db, ["1"], 2)
    assert r1.wait(3)
    job.ask(db, ["2", "3"], 2)
    g1.set()
    assert r3.wait(3)
    job.ask(db, ["2"], 2)
    job.withdraw(["2"], 2)
    live = job.live()
    try:
        assert live["total"] == 3 and live["done"] == 1 and live["unreachable"] == 1 and live["current"] == "3"
    finally:
        g3.set()
        job.join(5)


def test_l10_a_new_pair_that_needs_nothing_puts_the_old_pair_back(client, db):
    _busy_on_1(client)
    client.state["profile"] = 3
    client.post("/api/library/dj/analyse", json={"track_ids": ["2"], "reason": "asked"})
    client.state["profile"] = 2
    client.post("/api/library/dj/analyse", json={"track_ids": ["4", "5"], "source": "up_next", "soon": True})
    assert _line_order(client) == ["4", "5", "2"]
    for t in ("6", "7"):
        _dj_done(db, t)
        _grid(db, t)
    client.post("/api/library/dj/analyse", json={"track_ids": ["6", "7"], "source": "up_next", "soon": True})
    assert 2 not in client.job._soon_by
    assert _line_order(client) == ["2", "4", "5"]


def test_l10_soon_is_two_tracks_by_id_never_a_playlist(client):
    for body in ({"playlist_id": 99, "source": "up_next", "soon": True},
                 {"mine": True, "reason": "asked", "source": "up_next", "soon": True},
                 {"track_ids": ["4"], "cancel": True, "source": "up_next", "soon": True}):
        assert client.post("/api/library/dj/analyse", json=body).status_code == 400, body


def test_l5_move_up_over_the_200_cap_says_so(client, db):
    _busy_on_1(client)
    client.job.ask(db, [str(5000 + i) for i in range(worker.PRIORITY_PER_PROFILE)], 1)
    client.state.update(profile=1, admin=True)
    res = client.post("/api/library/dj/start", json={"track_id": "4"})
    assert res.status_code == 409 and res.get_json()["code"] == "over_limit"
    assert "200 tracks in line, the most at once" in res.get_json()["error"]


def test_l6_the_line_reads_the_library_a_few_batches_a_poll(client, db, monkeypatch):
    _busy_on_1(client)
    client.job.ask(db, [str(1000 + i) for i in range(150)], 7, limit=None)  # another library's
    client.job.ask(db, [str(2000 + i) for i in range(150)], 8, limit=None)
    client.job.ask(db, [str(3000 + i) for i in range(150)], 9, limit=None)
    reads = []
    real = ondemand._rows
    monkeypatch.setattr(ondemand, "_rows", lambda d, ids: reads.append(len(ids)) or real(d, ids))
    client.state.update(profile=1, admin=True)
    sweep = client.post("/api/library/dj/progress", json={"track_ids": [], "line": True}).get_json()["sweep"]
    assert sweep["line"] == [] and sweep["line_more"] == 450
    assert len([n for n in reads if n == ondemand.LINE_BATCH]) == ondemand.LINE_BATCHES


def test_l8_joins_five_seconds_count_from_the_first_unstarted_join():
    """A run that ends after 5.5 s having made the next run's thread, which
    starts half a second later: join waits for it (the 5 s for an unstarted
    thread count from finding it unstarted, not from the call)."""
    job = _job()
    second = threading.Thread(target=lambda: None)

    def run():
        time.sleep(5.5)
        job._thread = second
        threading.Timer(0.5, second.start).start()

    first = threading.Thread(target=run)
    first.start()
    job._thread = first
    t0 = time.monotonic()
    job.join(None)
    took = time.monotonic() - t0
    assert second.ident is not None and 5.9 <= took < 7.0
