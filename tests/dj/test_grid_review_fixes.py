"""Auto-mix stage A after the gauntlet review: tracks that can't be analysed
say why instead of waiting for ever (M1), noise gets no grid (M2, with the
noise tests in test_grid_accuracy.py), a track's stated length can't make a
plan expensive (M3), grid failures count and are tried again (L-a), a
rekeyed or reused track id carries the right rows (L-b), and levels are
never inf or NaN (L-e)."""

from __future__ import annotations

import time

import numpy as np
import pytest
from flask import Flask, g

from core.dj import grid, grid_store, planner, store, worker
from core.dj.grid import GRID_VERSION, phrases_from

from .grid_fixtures import SR


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.fetchall()
    finally:
        conn.close()


SECTIONS = [["intro", 0, 16, 0.9], ["main", 16, 48, 0.5], ["breakdown", 48, 64, 0.8], ["drop", 64, 96, 0.8],
            ["outro", 96, 112, 0.9]]


def _grid(bpm=124.0):
    return {"version": GRID_VERSION, "status": "done", "kind": "constant", "bpm": bpm, "period": 60.0 / bpm,
            "first_beat": 0.5, "first_downbeat": 0.5, "downbeat_index": 0, "beat_confidence": 0.86,
            "downbeat_confidence": 0.9, "meter": "4/4", "bars": 112, "beats": None,
            "phrases": phrases_from([16, 48, 64, 96], 112), "sections": SECTIONS,
            "mix_in": [0, 16, 0.9, "intro"], "mix_out": [96, 112, 0.9, "outro"], "analysed_s": 220.0,
            "truncated": False, "level_db": -9.0}


@pytest.fixture
def db(tmp_path, monkeypatch):
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "review.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Saltmarsh')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'Lantern')")
    import core.sample.store as sample_store

    monkeypatch.setattr(sample_store, "get_database", lambda: database)
    return database


def _track(db, tid, title, path, duration_ms=240000):
    _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration) VALUES (?, '10', '1', ?, ?, ?)",
         (str(tid), title, path, duration_ms))


@pytest.fixture
def client(db):
    import api.dj as dj_api
    from core.library_scope import reset_library_scope, set_library_scope

    dj_api.configure(get_database_=lambda: db)
    app = Flask(__name__)
    tokens = []

    @app.before_request
    def _profile():
        g.profile_id = 1
        tokens.append(set_library_scope("shared"))

    @app.teardown_request
    def _scope(_exc):
        if tokens:
            reset_library_scope(tokens.pop())

    app.register_blueprint(dj_api.create_blueprint())
    return app.test_client()


def _analysed(db, tid="1", title="Night Ferry"):
    _track(db, tid, title, f"/m/{tid}.flac")
    store.save(db, tid, {"bpm": 124.0, "musical_key": "8A", "status": "done",
                         "dj_analyzer_version": worker.analyzer_version()})
    grid_store.save_result(db, tid, _grid(), source_sig=None)


# ── M1: a track that can't be analysed says why ──────────────────────────────

@pytest.mark.gauntlet
@pytest.mark.parametrize("case, reason, words", [
    ("skipped", "too_long", "A Mix is too long to analyse"),
    ("error", "error", "A Mix couldn't be analysed"),
    ("unreachable", "unreachable", "A Mix can't be opened"),
])
def test_m1_the_sweep_through_to_the_plan_falls_back_with_the_reason(db, client, tmp_path, monkeypatch,
                                                                      case, reason, words):
    _analysed(db)
    path = tmp_path / "mix.wav"
    path.write_bytes(b"x" * 64)
    _track(db, "2", "A Mix", str(path))
    monkeypatch.setattr(worker, "_too_long", lambda p: case == "skipped")

    def unreadable(p):
        raise RuntimeError("ffmpeg could not decode")

    out = worker.process_track(db, "2", resolve=(lambda s: None) if case == "unreachable" else (lambda s: s),
                               analyze=unreadable)
    assert out == case
    assert store.get(db, "2")["status"] == case and grid_store.get(db, "2")["status"] == case
    shaped = client.get("/api/library/dj/grid/2").get_json()["grid"]
    assert shaped == {"track_id": "2", "analyzed": False, "reason": reason}
    # into it: a blend falls back with the reason; out of it, whatever the style
    plan = client.get("/api/library/dj/plan?from=1&to=2&style=long_blend").get_json()["plan"]
    # 302: the outgoing track is ready to mix, so a cut on its last phrase
    assert plan["status"] == "cut" and plan["fallback"]["reason"] == words
    cut = client.get("/api/library/dj/plan?from=1&to=2&style=cut").get_json()["plan"]
    assert cut["status"] == "ok" and cut["style"] == "cut"  # the outgoing grid is enough for a cut
    out_of = client.get("/api/library/dj/plan?from=2&to=1").get_json()["plan"]
    # no grid and no BPM going out: it plays on, never a crossfade
    assert out_of["status"] == "play_on" and out_of["fallback"]["reason"] == words
    # and it isn't on the grid sweep's list
    assert "2" not in grid_store.pending_ids(db, worker.analyzer_version(), retry_unreachable_before=0)


@pytest.mark.gauntlet
@pytest.mark.parametrize("status, reason", [("skipped", "too_long"), ("error", "error"),
                                            ("unreachable", "unreachable")])
def test_m1_a_track_that_failed_before_grids_existed_says_why_too(db, client, status, reason):
    """Installs that ran stage 1 have DJ rows like these and no grid row."""
    _analysed(db)
    _track(db, "3", "Old Failure", "/m/3.flac")
    store.mark(db, "3", status, "earlier", worker.analyzer_version())
    assert grid_store.get(db, "3") is None
    assert client.get("/api/library/dj/grid/3").get_json()["grid"]["reason"] == reason
    body = client.post("/api/library/dj/grids", json={"track_ids": ["3"]}).get_json()
    assert body["grids"]["3"]["reason"] == reason
    plan = client.get("/api/library/dj/plan?from=1&to=3&style=short_blend").get_json()["plan"]
    assert plan["status"] == "cut" and plan["fallback"]["kind"] == "cut"


def test_m1_a_track_not_reached_yet_still_waits(db, client):
    _analysed(db)
    _track(db, "4", "Soon", "/m/4.flac")
    assert client.get("/api/library/dj/plan?from=1&to=4").get_json()["plan"]["status"] == "waiting"


# ── M2: noise through to the planner ─────────────────────────────────────────

@pytest.mark.gauntlet
def test_m2_noise_gets_no_grid_and_the_plan_says_so(db, client):
    _analysed(db)
    _track(db, "5", "Static", "/m/5.flac")
    store.save(db, "5", {"status": "done", "dj_analyzer_version": worker.analyzer_version()})
    noise = np.random.default_rng(3).standard_normal(SR * 60).astype(np.float32)
    grid_store.save_result(db, "5", grid.analyze_audio(noise, SR), source_sig=None)
    assert client.get("/api/library/dj/grid/5").get_json()["grid"]["reason"] == "no_beat"
    plan = client.get("/api/library/dj/plan?from=1&to=5&style=long_blend").get_json()["plan"]
    assert plan["status"] == "cut" and plan["fallback"]["reason"] == "Static has no steady beat"


# ── M3: a stated length costs nothing ────────────────────────────────────────

def _truncated_track(duration_s):
    row = {"status": "done", "grid_version": GRID_VERSION, "kind": "constant", "period": 60 / 124,
           "first_beat": 0.1, "downbeat_index": 0, "beat_confidence": 0.9, "downbeat_confidence": 0.8,
           "meter": "4/4", "bars": 300, "bpm": 124.0,
           "phrases_json": '[[0, 32, 0], [16, 32, 1], [24, 8, 0]]',
           "sections_json": '[["intro", 0, 16, 0.8], ["main", 16, 300, 0.5]]',
           "mix_json": '{"in": [0, 16, 0.8, "intro"], "out": null}', "truncated": 1, "analysed_s": 600}
    return {**grid_store.public(row, "1"), "dj_bpm": 124.0, "key": "8A", "duration_s": duration_s, "title": "Long"}


@pytest.mark.gauntlet
@pytest.mark.parametrize("duration_ms", [2 ** 31, 2 ** 40, float("inf")])
def test_m3_a_huge_stated_length_plans_at_once_and_stays_inside_thirty_minutes(duration_ms):
    started = time.perf_counter()
    plan = planner.plan(_truncated_track(duration_ms / 1000), _truncated_track(300.0), style="short_blend")
    assert time.perf_counter() - started < 0.05
    if plan["status"] == "ok":
        assert plan["out"]["end"] <= planner.MAX_TRACK_SECONDS
    cross = planner.plan(_truncated_track(duration_ms / 1000),
                         {"track_id": "2", "analyzed": True, "grid": None, "reason": None}, style="long_blend")
    # its ending wasn't analysed: straight on (302), never a cut on a guess
    assert cross["status"] == "play_on" and "out" not in cross


def test_m3_the_phrases_carry_on_by_arithmetic():
    phrases = planner._Phrases({"phrases": [{"bar": 0, "level": 16, "section": False},
                                            {"bar": 16, "level": 32, "section": True},
                                            {"bar": 24, "level": 8, "section": False}]})
    assert phrases.latest(10 ** 12) == (16 + 8 * ((10 ** 12 - 16) // 8), phrases.level(16 + 8 * ((10 ** 12 - 16) // 8)))
    assert phrases.latest(30) == (24, 8) and phrases.latest(33) == (32, 16) and phrases.latest(48) == (48, 32)
    assert phrases.first(25, 100) == (32, 16) and phrases.first(10, 100) == (16, 32)
    assert phrases.first(41, 47) is None


def test_m3_a_whole_track_is_kept_to_its_analysed_length():
    track = {"duration_s": 4000.0, "analysed_s": 215.0, "truncated": False}
    assert planner._length(track) == 216.0
    assert planner._length({"duration_s": float("nan")}) is None
    assert planner._length({"duration_s": 4000.0, "truncated": True}) == planner.MAX_TRACK_SECONDS


# ── L-a: grid failures count, and are tried again ────────────────────────────

def test_l_a_grid_failures_are_counted_on_their_own(db):
    """(Changed by the re-review's L3.) A grid that fails is counted as a
    grid failure; the track is done, since its DJ data was kept, and a run
    of them never ends the sweep for BPM and key."""
    for i in range(1, worker.MAX_ERRORS_IN_A_ROW + 4):
        _track(db, i, f"T{i}", f"/m/{i}.flac")
    job = worker.DjAnalysisJob(process=lambda d, t, **kw: "grid_error", busy=lambda d: None, away=lambda: False,
                               settings=lambda: {"analyze": True, "write_tags": False, "overwrite_tags": False},
                               sleep_floor=0, rest_factor=0)
    job.start(db, 1, background=False)
    state = worker.public_state(db, job)
    assert state["status"] == "done" and state["failed"] == 0
    assert state["done"] == worker.MAX_ERRORS_IN_A_ROW + 3


def test_l_a_a_failed_grid_is_tried_again_after_a_week_but_not_a_crash(db):
    v = worker.analyzer_version()
    for tid in ("1", "2"):
        _track(db, tid, f"T{tid}", f"/m/{tid}.flac")
        store.save(db, tid, {"status": "done", "dj_analyzer_version": v})
    grid_store.mark(db, "1", "error", "bad frame")
    grid_store.mark(db, "2", "analyzing", None)
    grid_store.fail_leftover_analyzing(db)
    assert grid_store.pending_ids(db, v) == []
    later = time.time() + 1
    assert grid_store.pending_ids(db, v, retry_errors_before=later) == ["1"]
    _sql(db, "UPDATE track_grid SET analyzed_at = ? WHERE track_id = '1'",
         (time.time() - grid_store.ERROR_RETRY_SECONDS - 60,))
    assert grid_store.pending_ids(db, v) == ["1"]
    assert grid_store.counts(db)["pending"] == 1


def test_l_a_a_top_up_whose_grid_fails_reports_it(db, tmp_path):
    from core.sample.store import source_signature

    path = tmp_path / "t.wav"
    path.write_bytes(b"x" * 64)
    _track(db, "6", "T6", str(path))
    store.save(db, "6", {"bpm": 124.0, "status": "done", "dj_analyzer_version": worker.analyzer_version(),
                         "source_sig": source_signature(str(path))})

    def broken(p, **kw):
        raise RuntimeError("bad frame")

    assert worker.process_track(db, "6", resolve=lambda s: s, analyze_grid=broken) == "grid_error"
    assert store.get(db, "6")["status"] == "done"


# ── L-b: a track's rows follow its id ────────────────────────────────────────

def test_l_b_a_rekeyed_track_takes_its_dj_data_and_grid(db):
    _analysed(db, "7")
    _track(db, "70", "Keeper", "/m/70.flac")
    _track(db, "8", "Has its own", "/m/8.flac")
    _track(db, "80", "Keeper with rows", "/m/80.flac")
    store.save(db, "8", {"bpm": 100.0, "status": "done", "dj_analyzer_version": worker.analyzer_version()})
    store.save(db, "80", {"bpm": 128.0, "status": "done", "dj_analyzer_version": worker.analyzer_version()})
    conn = db._get_connection()
    try:
        db._absorb_track_row(conn.cursor(), "7", "70", [])
        db._absorb_track_row(conn.cursor(), "8", "80", [])
        conn.commit()
    finally:
        conn.close()
    assert store.get(db, "7") is None and grid_store.get(db, "7") is None
    assert store.get(db, "70")["bpm"] == 124.0 and grid_store.get(db, "70")["status"] == "done"
    assert store.get(db, "80")["bpm"] == 128.0  # the keeper's own stays
    assert store.get(db, "8") is None


def test_l_b_a_grid_for_another_file_is_due_again(db):
    v = worker.analyzer_version()
    _track(db, "9", "Reused", "/m/9.flac")
    store.save(db, "9", {"status": "done", "dj_analyzer_version": v, "source_sig": "100:1"})
    grid_store.save_result(db, "9", _grid(), source_sig="100:1")
    assert grid_store.pending_ids(db, v) == []
    store.save(db, "9", {"source_sig": "200:2"})  # a new file under the id
    assert grid_store.pending_ids(db, v) == ["9"]
    # a grid row that only records a state (no file) isn't compared
    grid_store.mark(db, "9", "skipped", "too long")
    assert grid_store.pending_ids(db, v) == []


# ── L-e: no inf or NaN ───────────────────────────────────────────────────────

def test_l_e_levels_are_finite_and_damaged_samples_are_silence():
    from .grid_fixtures import dance_track

    assert grid._level_db(np.full(4096, np.inf, dtype=np.float32)) is None
    assert grid._level_db((np.ones(4096) * 1e30).astype(np.float32)) == 20.0
    y, _ = dance_track(124.0, sections=(("intro", 8), ("groove", 8)))
    y[5000] = np.inf
    y[9000] = np.nan
    r = grid.analyze_audio(y, SR)
    assert r["status"] == "done" and r["bpm"] == pytest.approx(124.0, abs=0.02)
    assert np.isfinite(r["level_db"])


# ── the stage A re-review: L1, L2, L3 ────────────────────────────────────────

def _wav(tmp_path, name="t.wav"):
    path = tmp_path / name
    path.write_bytes(b"RIFF" + b"x" * 60)
    return str(path)


def _analysis(**_kw):
    return {"bpm": 124.0, "onsets": [0.5], "duration_s": 220.0, "key": {"name": "A minor", "confidence": 0.9},
            "energy": 6, "analyzer_version": 1, "truncated": False}


def test_l1_a_failed_decode_doesnt_hold_back_the_grid_of_a_later_analysis(db, tmp_path):
    """The DJ decode failed, so its grid row said error too; it was stamped
    with the file, so when the analysis later worked the grid looked current
    and waited a week. It isn't stamped now, and a full analysis that works
    looks for a grid an error row stands for at once (also for rows stamped
    before the fix)."""
    path = _wav(tmp_path)
    _track(db, "11", "Brass Tide", path)

    def broken(_p):
        raise RuntimeError("couldn't decode a frame")

    assert worker.process_track(db, "11", resolve=lambda s: s, analyze=broken) == "error"
    row = grid_store.get(db, "11")
    assert row["status"] == "error" and row["source_sig"] is None
    found = []

    def finds(p, **kw):
        found.append(p)
        return _grid()

    assert worker.process_track(db, "11", resolve=lambda s: s, analyze=lambda p: _analysis(),
                                analyze_grid=finds) == "done"
    assert found == [path] and grid_store.get(db, "11")["status"] == "done"


def test_l1_an_error_grid_stamped_before_the_fix_is_found_again(db, tmp_path):
    from core.sample.store import source_signature

    path = _wav(tmp_path)
    _track(db, "12", "Copper Sky", path)
    store.mark(db, "12", "error", "couldn't decode", worker.analyzer_version())
    grid_store.mark(db, "12", "error", "couldn't decode", source_sig=source_signature(path))
    found = []
    assert worker.process_track(db, "12", resolve=lambda s: s, analyze=lambda p: _analysis(),
                                analyze_grid=lambda p, **kw: found.append(p) or _grid()) == "done"
    assert found == [path] and grid_store.get(db, "12")["status"] == "done"
    # a crash's error isn't tried again: it could crash again
    grid_store.mark(db, "12", "error", "SYNCHRO.S stopped while finding this track's beats; skipped",
                    source_sig=source_signature(path))
    store.mark(db, "12", "error", "again", worker.analyzer_version())
    found.clear()
    worker.process_track(db, "12", resolve=lambda s: s, analyze=lambda p: _analysis(),
                         analyze_grid=lambda p, **kw: found.append(p) or _grid())
    assert found == []


@pytest.mark.gauntlet
def test_l2_a_finished_row_replaces_the_keepers_unfinished_one(db):
    """When a scan folds an old track row into the keeper, the keeper's own
    DJ data and grid stay, unless they aren't finished (an error, still
    waiting) and the old ones are: then the old ones replace them."""
    _analysed(db, "21")
    _track(db, "210", "Keeper", "/m/210.flac")
    store.mark(db, "210", "error", "couldn't decode", worker.analyzer_version())
    grid_store.mark(db, "210", "error", "couldn't decode")
    _analysed(db, "22")
    _track(db, "220", "Keeper done", "/m/220.flac")
    store.save(db, "220", {"bpm": 128.0, "status": "done", "dj_analyzer_version": worker.analyzer_version()})
    grid_store.save_result(db, "220", _grid(128.0), source_sig=None)
    _track(db, "23", "Old, failed", "/m/23.flac")
    store.mark(db, "23", "error", "gone", worker.analyzer_version())
    grid_store.mark(db, "23", "error", "gone")
    _track(db, "230", "Keeper analysing", "/m/230.flac")
    store.mark(db, "230", "analyzing", None, worker.analyzer_version())
    conn = db._get_connection()
    try:
        for old, keeper in (("21", "210"), ("22", "220"), ("23", "230")):
            db._absorb_track_row(conn.cursor(), old, keeper, [])
        conn.commit()
    finally:
        conn.close()
    assert store.get(db, "210")["status"] == "done" and store.get(db, "210")["bpm"] == 124.0
    assert grid_store.get(db, "210")["status"] == "done"
    assert store.get(db, "220")["bpm"] == 128.0 and grid_store.get(db, "220")["bpm"] == 128.0  # its own stay
    assert store.get(db, "230")["status"] == "analyzing"  # an unfinished old row never replaces anything
    assert grid_store.get(db, "230")["status"] == "error"  # the keeper had none: the old one follows
    for old in ("21", "22", "23"):
        assert store.get(db, old) is None and grid_store.get(db, old) is None


def _sweep(db, outcome, count):
    for i in range(1, count + 1):
        _track(db, f"s{i}", f"T{i}", f"/m/s{i}.flac")
    calls = []

    def process(d, t, **kw):
        calls.append(kw.get("find_grid"))
        store.save(d, t, {"status": "done", "dj_analyzer_version": worker.analyzer_version()})
        if not kw.get("find_grid"):
            return "done"
        grid_store.mark(d, t, "error", "bad frame")
        return outcome

    job = worker.DjAnalysisJob(process=process, busy=lambda d: None, away=lambda: False,
                               settings=lambda: {"analyze": True, "write_tags": False, "overwrite_tags": False},
                               sleep_floor=0, rest_factor=0)
    job.start(db, 1, background=False)
    return job, calls


def test_l3_grid_errors_alone_never_end_the_sweep(db):
    """A run of grid failures stops only the looking for grids: BPM, key and
    energy carry on for every track; each such track counts as done, with a
    separate grid-failed count, and the run says the grids wait."""
    n = worker.MAX_GRID_ERRORS_IN_A_ROW + 5
    job, calls = _sweep(db, "done_grid_error", n)
    state = worker.public_state(db, job)
    assert state["status"] == "done" and state["done"] == n and state["failed"] == 0
    assert state["grid_failed"] == worker.MAX_GRID_ERRORS_IN_A_ROW and state["grids_paused"] is True
    assert calls == [True] * worker.MAX_GRID_ERRORS_IN_A_ROW + [False] * 5
    assert state["note"] == f"grids_paused:{worker.MAX_GRID_ERRORS_IN_A_ROW}"


def test_l3_activity_counts_grid_failures_apart(db):
    from core.activity import feed

    job, _ = _sweep(db, "done_grid_error", 3)
    row = worker.last_run(db)
    conn = db._get_connection()
    try:
        class Ctx:
            pass

        ctx = Ctx()
        ctx.conn = conn
        item = feed._dj_job_item(ctx, row)
    finally:
        conn.close()
    assert "3 tracks" in item["detail"] and "No beat grid found for 3 tracks" in item["detail"]
    assert "couldn't be analysed" not in item["detail"] and item["status"] == "warning"


def test_l3_a_dj_failure_still_counts_toward_its_own_stop(db):
    for i in range(1, worker.MAX_ERRORS_IN_A_ROW + 4):
        _track(db, i, f"T{i}", f"/m/{i}.flac")
    job = worker.DjAnalysisJob(process=lambda d, t, **kw: "error", busy=lambda d: None, away=lambda: False,
                               settings=lambda: {"analyze": True, "write_tags": False, "overwrite_tags": False},
                               sleep_floor=0, rest_factor=0)
    job.start(db, 1, background=False)
    state = worker.public_state(db, job)
    assert state["status"] == "failed" and state["failed"] == worker.MAX_ERRORS_IN_A_ROW


# ── after the stage B gauntlet review ────────────────────────────────────────

@pytest.mark.gauntlet
def test_review_m1_paused_top_ups_go_by_without_a_rest_or_a_save(db):
    """Once 25 grids in a row have failed, each remaining top-up is
    ``grid_paused``: nothing was decoded, so the sweep neither rests nor
    saves for it, and counts it done so the run reaches its total (a 50k
    library at GRID_VERSION 2 no longer "runs" for hours doing nothing)."""
    n = worker.MAX_GRID_ERRORS_IN_A_ROW + 40
    for i in range(1, n + 1):
        _track(db, f"p{i}", f"T{i}", f"/m/p{i}.flac")

    def process(d, t, **kw):
        store.save(d, t, {"status": "done", "dj_analyzer_version": worker.analyzer_version()})
        if not kw.get("find_grid"):
            return "grid_paused"
        grid_store.mark(d, t, "error", "bad frame")
        return "grid_error"

    job = worker.DjAnalysisJob(process=process, busy=lambda d: None, away=lambda: False,
                               settings=lambda: {"analyze": True, "write_tags": False, "overwrite_tags": False},
                               sleep_floor=0.5, rest_factor=0)
    waits = []
    job._stop.wait = lambda t=None: (waits.append(t), False)[1]
    saves = []
    real_save = job._save
    job._save = lambda d, final=False, **kw: (saves.append(final), real_save(d, final=final, **kw))[1]
    job.start(db, 1, background=False)
    state = worker.public_state(db, job)
    assert len(waits) == worker.MAX_GRID_ERRORS_IN_A_ROW  # a rest only after a real decode
    assert saves.count(False) == worker.MAX_GRID_ERRORS_IN_A_ROW and saves.count(True) == 1
    assert state["status"] == "done" and state["done"] == state["total"] == n
    assert state["grid_failed"] == worker.MAX_GRID_ERRORS_IN_A_ROW and state["grids_paused"] is True
    assert job._state["grids_waiting"] == 40


def test_review_l7_a_runs_grid_failures_are_its_own_and_cost_no_query(db):
    """Activity reads a finished run's grid failures from its note, so a
    run from before (no such note) shows none, whatever grid rows were
    marked while it ran, and nothing is counted over track_grid per row."""
    from core.activity import feed

    _sweep(db, "done_grid_error", 3)
    row = worker.last_run(db)
    assert row["note"] == "grids:3"
    assert worker.grid_note(row["note"]) == (3, False)
    assert worker.grid_note("grids_paused:25") == (25, True)
    assert worker.grid_note("restart") == (0, False) and worker.grid_note(None) == (0, False)
    # a run from before this change: grid errors marked during it aren't its
    old = {**row, "note": None}

    class Ctx:
        conn = None  # nothing may be queried

    item = feed._dj_job_item(Ctx(), old)
    assert "beat grid" not in item["detail"]
    item = feed._dj_job_item(Ctx(), row)
    assert "No beat grid found for 3 tracks" in item["detail"]
