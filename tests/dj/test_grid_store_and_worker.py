"""Keeping the beat grid (core/dj/grid_store.py) and finding it in the DJ
analysis sweep (core/dj/worker.py): one decode a track, the grid top-up for
tracks analysed before grids existed (their BPM, key and energy aren't
worked out again), a grid that fails never costing the track its DJ data, and
the compact row."""

from __future__ import annotations

import json

import pytest

from core.dj import grid_store, store, worker
from core.dj.grid import GRID_VERSION

from .grid_fixtures import SR, dance_track
from .grid_fixtures import write_wav as write_grid_wav


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.fetchall()
    finally:
        conn.close()


@pytest.fixture
def db(tmp_path, monkeypatch):
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "grid.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Saltmarsh')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'Lantern')")
    import core.sample.store as sample_store

    monkeypatch.setattr(sample_store, "get_database", lambda: database)
    return database


def _track(db, tid, path, bpm=None):
    _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, bpm) VALUES (?, '10', '1', ?, ?, ?)",
         (str(tid), f"T{tid}", path, bpm))


def _analysis(bpm=124.0):
    from core.sample.analyze import ANALYZER_VERSION

    return {"bpm": bpm, "onsets": [0.5], "duration_s": 60.0, "key": {"name": "A minor", "confidence": 0.8},
            "energy": 7, "analyzer_version": ANALYZER_VERSION}


def _grid_result(bpm=124.0, kind="constant", beats=None):
    return {"version": GRID_VERSION, "status": "done", "kind": kind, "bpm": bpm, "period": 60.0 / bpm,
            "first_beat": 0.5, "first_downbeat": 0.5, "downbeat_index": 0, "beat_confidence": 0.86,
            "downbeat_confidence": 0.9, "meter": "4/4", "bars": 112, "beats": beats,
            "phrases": [[0, 16, 0], [8, 8, 0], [16, 32, 1]], "sections": [["intro", 0, 16, 0.9], ["main", 16, 112, 0.5]],
            "mix_in": [0, 16, 0.9, "intro"], "mix_out": [96, 112, 0.5, "beat_only"], "analysed_s": 217.4,
            "truncated": False, "level_db": -8.5}


# ── the store ────────────────────────────────────────────────────────────────

def test_beat_lists_round_trip_to_the_millisecond_without_drifting():
    beats = [0.3 + i * 0.4837 for i in range(2000)]
    text = grid_store.encode_beats(beats)
    back = grid_store.decode_beats(text)
    assert len(back) == 2000 and max(abs(a - b) for a, b in zip(back, beats, strict=True)) <= 0.0005 + 1e-9
    assert text.startswith("300,484,483,484,")
    assert grid_store.encode_beats([]) is None and grid_store.decode_beats("") is None
    assert grid_store.decode_beats("1,x") is None


def test_a_steady_tracks_row_is_small_and_reads_back_as_times(db):
    _track(db, 1, "/m/1.flac")
    grid_store.save_result(db, "1", _grid_result(), source_sig="9:9", replaygain_db=-7.25)
    row = grid_store.get(db, "1")
    assert row["beats_ms"] is None and row["status"] == "done" and row["grid_version"] == GRID_VERSION
    stored = sum(len(str(v)) for v in row.values() if v is not None)
    assert stored < 1024, stored
    shaped = grid_store.public(row, "1")
    period = 60 / 124.0
    assert shaped["analyzed"] is True and shaped["bpm"] == 124.0
    assert shaped["grid"] == {"kind": "constant", "first_beat": 0.5, "period": round(period, 6), "beats": None,
                              "confidence": 0.86, "steady": True, "confident": True}
    assert shaped["downbeats"]["first"] == 0.5 and shaped["downbeats"]["uncertain"] is False
    assert shaped["phrases"][2] == {"bar": 16, "time": round(0.5 + 16 * 4 * period, 3), "level": 32, "section": True}
    assert shaped["sections"][1]["kind"] == "main" and shaped["sections"][1]["end_bar"] == 112
    assert shaped["mix_in"]["how"] == "intro" and shaped["mix_in"]["bars"] == 16
    assert shaped["mix_out"]["start"] == pytest.approx(0.5 + 96 * 4 * period, abs=1e-3)
    assert shaped["loudness"] == {"replaygain_db": -7.25, "level_db": -8.5, "source": "replaygain"}


def test_a_drifting_tracks_beats_are_kept_and_left_out_of_the_batch_form(db):
    beats = [0.25 + i * 0.5 + i * i * 1e-5 for i in range(400)]
    grid_store.save_result(db, "2", _grid_result(kind="beats", beats=beats), source_sig=None)
    row = grid_store.get(db, "2")
    full = grid_store.public(row, "2")
    assert full["grid"]["kind"] == "beats" and full["grid"]["steady"] is False
    assert full["grid"]["beats"][399] == pytest.approx(beats[399], abs=1e-3)
    assert grid_store.public(row, "2", with_beats=False)["grid"]["beats"] is None


@pytest.mark.parametrize("status,reason,expected", [
    (None, None, "not_analyzed"),
    ("analyzing", None, "analyzing"),
    ("none", "no_beat", "no_beat"),
    ("none", "too_short", "too_short"),
    ("error", "boom", "error"),
    ("unreachable", "gone", "unreachable"),
    ("skipped", "too long to analyse", "too_long"),
])
def test_each_state_says_why_there_is_no_grid(db, status, reason, expected):
    if status:
        grid_store.mark(db, "3", status, reason)
        if status == "none":
            grid_store.save_result(db, "3", {"status": "none", "reason": reason, "beat_confidence": 0.1},
                                   source_sig=None)
    shaped = grid_store.public(grid_store.get(db, "3"), "3")
    assert shaped == {"track_id": "3", "analyzed": False, "reason": expected,
                      **({"beat_confidence": 0.1} if status == "none" else {})}


def test_an_older_grid_version_reads_as_not_analysed(db):
    grid_store.save_result(db, "4", _grid_result(), source_sig=None)
    _sql(db, "UPDATE track_grid SET grid_version = ?", (GRID_VERSION - 1,))
    assert grid_store.public(grid_store.get(db, "4"), "4")["reason"] == "not_analyzed"


def test_an_uncertain_downbeat_and_another_meter_say_so(db):
    grid_store.save_result(db, "5", {**_grid_result(), "downbeat_confidence": 0.1}, source_sig=None)
    assert grid_store.public(grid_store.get(db, "5"), "5")["downbeats"]["note"].startswith("Not sure which beat")
    grid_store.save_result(db, "6", {**_grid_result(), "meter": "not_4_4"}, source_sig=None)
    shaped = grid_store.public(grid_store.get(db, "6"), "6")
    assert shaped["downbeats"]["uncertain"] is True and "fours" in shaped["downbeats"]["note"]


# ── the sweep: one decode a track ────────────────────────────────────────────

def test_a_new_track_gets_its_grid_from_the_same_decode(db, tmp_path):
    y, _ = dance_track(124.0, sections=(("intro", 8), ("groove", 8)))
    path = write_grid_wav(tmp_path / "a.wav", y)
    _track(db, 1, "/stored/a.wav")
    audio = object()
    analysed, gridded = [], []

    def analyze(p):
        analysed.append(p)
        return {**_analysis(), "audio": audio}

    def find_grid(p, *, audio=None, bpm_hint=None):
        gridded.append((p, audio, bpm_hint))
        return _grid_result()

    assert worker.process_track(db, "1", resolve=lambda p: path, analyze=analyze, analyze_grid=find_grid) == "done"
    assert analysed == [path] and gridded == [(path, audio, 124.0)]
    assert store.get(db, "1")["status"] == "done"
    row = grid_store.get(db, "1")
    assert row["status"] == "done" and row["source_sig"] == store.get(db, "1")["source_sig"]
    # Sample Studio's copy of the analysis never holds the audio
    from core.sample import store as sample_store

    assert "audio" not in json.dumps(sample_store.get_analysis("1"), default=str)


def test_the_real_analysis_finds_bpm_key_and_the_grid_end_to_end(db, tmp_path):
    y, truth = dance_track(126.0, sections=(("intro", 8), ("groove", 16), ("outro", 8)))
    path = write_grid_wav(tmp_path / "real.wav", y)
    _track(db, 1, "/stored/real.wav")
    assert worker.process_track(db, "1", resolve=lambda p: path) == "done"
    # the first analysis's tempo is a few percent out (librosa's tracker
    # works in whole frames); the grid only looks near it and finds the tempo
    assert store.get(db, "1")["bpm"] == pytest.approx(126.0, rel=0.03)
    shaped = grid_store.public(grid_store.get(db, "1"), "1")
    assert shaped["analyzed"] and shaped["bpm"] == pytest.approx(126.0, abs=0.02)
    assert shaped["downbeats"]["first"] == pytest.approx(truth["downbeats"][0], abs=0.005)


def test_an_analysed_track_only_gets_its_grid(db, tmp_path):
    """The top-up: the DJ data is this file's at this version, so it isn't
    worked out again; only the grid is found, near the BPM already known."""
    y, _ = dance_track(124.0, sections=(("intro", 8), ("groove", 8)))
    path = write_grid_wav(tmp_path / "b.wav", y)
    _track(db, 2, "/stored/b.wav")
    from core.sample.store import source_signature

    store.save(db, "2", {"bpm": 124.0, "bpm_source": "tag", "musical_key": "8A", "status": "done",
                         "dj_analyzer_version": worker.analyzer_version(), "source_sig": source_signature(path)})
    before = store.get(db, "2")
    gridded = []

    def analyze(p):
        raise AssertionError("BPM, key and energy are analysed twice")

    def find_grid(p, *, audio=None, bpm_hint=None):
        gridded.append((audio, bpm_hint))
        return _grid_result()

    assert worker.process_track(db, "2", resolve=lambda p: path, analyze=analyze, analyze_grid=find_grid) == "done"
    assert gridded == [(None, 124.0)]
    assert store.get(db, "2") == before
    assert grid_store.get(db, "2")["status"] == "done"
    # and again: nothing to do
    assert worker.process_track(db, "2", resolve=lambda p: path, analyze=analyze, analyze_grid=find_grid) == "done"
    assert len(gridded) == 1


def test_a_replaced_file_is_analysed_again_whole(db, tmp_path):
    y, _ = dance_track(124.0, sections=(("intro", 8), ("groove", 8)))
    path = write_grid_wav(tmp_path / "c.wav", y)
    _track(db, 3, "/stored/c.wav")
    store.save(db, "3", {"bpm": 124.0, "status": "done", "dj_analyzer_version": worker.analyzer_version(),
                         "source_sig": "old:sig"})
    calls = []
    worker.process_track(db, "3", resolve=lambda p: path, analyze=lambda p: calls.append(p) or _analysis(),
                         analyze_grid=lambda p, **kw: _grid_result())
    assert calls == [path]


def test_a_top_up_on_a_missing_file_marks_only_the_grid(db):
    _track(db, 4, "/gone/d.flac")
    store.save(db, "4", {"bpm": 124.0, "status": "done", "dj_analyzer_version": worker.analyzer_version()})
    assert worker.process_track(db, "4", resolve=lambda p: None) == "unreachable"
    assert store.get(db, "4")["status"] == "done"
    assert grid_store.get(db, "4")["status"] == "unreachable"


def test_a_grid_that_fails_keeps_the_dj_data(db, tmp_path):
    y, _ = dance_track(124.0, sections=(("intro", 8), ("groove", 8)))
    path = write_grid_wav(tmp_path / "e.wav", y)
    _track(db, 5, "/stored/e.wav")

    def broken(p, **kw):
        raise RuntimeError("bad frame")

    out = worker.process_track(db, "5", resolve=lambda p: path, analyze=lambda p: _analysis(), analyze_grid=broken)
    # the DJ data is kept; the sweep still counts the failure (gauntlet L-a)
    assert out == "done_grid_error" and store.get(db, "5")["status"] == "done"
    row = grid_store.get(db, "5")
    assert row["status"] == "error" and row["reason"] == "bad frame"
    assert grid_store.public(row, "5")["reason"] == "error"


def test_a_missing_library_ends_the_sweep_and_queues_the_grid_again(db, tmp_path):
    y, _ = dance_track(124.0, sections=(("intro", 8), ("groove", 8)))
    path = write_grid_wav(tmp_path / "f.wav", y)
    _track(db, 6, "/stored/f.wav")

    def no_librosa(p, **kw):
        raise ImportError("no librosa")

    with pytest.raises(worker._Abort):
        worker.process_track(db, "6", resolve=lambda p: path, analyze=lambda p: _analysis(), analyze_grid=no_librosa)
    assert "6" in grid_store.pending_ids(db, worker.analyzer_version())


def test_replaygain_is_read_from_the_file(db, tmp_path, monkeypatch):
    import core.replaygain as rg

    monkeypatch.setattr(rg, "read_replaygain_tags", lambda p: {"track_gain": "-6.40 dB"})
    assert worker._replaygain_db("/x.flac") == -6.4
    monkeypatch.setattr(rg, "read_replaygain_tags", lambda p: {"track_gain": "loud"})
    assert worker._replaygain_db("/x.flac") is None
    monkeypatch.setattr(rg, "read_replaygain_tags", lambda p: {"track_gain": None})
    assert worker._replaygain_db("/x.flac") is None


def test_the_default_grid_decodes_the_first_ten_minutes_when_given_no_audio(tmp_path, monkeypatch):
    import core.sample.analyze as analyze

    seen = {}

    def decode(path, rate, max_seconds=None):
        seen.update(path=path, rate=rate, max_seconds=max_seconds)
        return (dance_track(124.0, sections=(("intro", 4),))[0], SR)

    monkeypatch.setattr(analyze, "decode_mono_at", decode)
    result = worker._default_grid("/x.wav")
    assert seen == {"path": "/x.wav", "rate": SR, "max_seconds": worker.DECODE_SECONDS}
    assert result["status"] == "none" and result["reason"] == "too_short"


# ── the sweep's list ─────────────────────────────────────────────────────────

def test_the_top_up_list_and_the_sweep_take_analysed_tracks_without_a_grid(db):
    v = worker.analyzer_version()
    for tid in ("1", "2", "3", "4", "5"):
        _track(db, tid, f"/m/{tid}.flac")
    store.save(db, "1", {"status": "done", "dj_analyzer_version": v})            # no grid: due
    store.save(db, "2", {"status": "done", "dj_analyzer_version": v})            # a grid: done
    grid_store.save_result(db, "2", _grid_result(), source_sig=None)
    store.save(db, "3", {"status": "done", "dj_analyzer_version": v})            # an old grid: due
    grid_store.save_result(db, "3", _grid_result(), source_sig=None)
    _sql(db, "UPDATE track_grid SET grid_version = 0 WHERE track_id = '3'")
    store.save(db, "4", {"status": "error", "dj_analyzer_version": v})           # its DJ data failed: not due
    assert grid_store.pending_ids(db, v) == ["1", "3"]
    assert grid_store.counts(db) == {"done": 1, "ready": 1, "no_beat": 0, "pending": 2}
    seen = []

    def process(d, t, **kw):
        seen.append(t)
        store.save(d, t, {"status": "done", "dj_analyzer_version": v})
        grid_store.save_result(d, t, _grid_result(), source_sig=None)
        return "done"

    job = worker.DjAnalysisJob(process=process, busy=lambda d: None, away=lambda: False,
                               settings=lambda: {"analyze": True, "write_tags": False, "overwrite_tags": False},
                               sleep_floor=0, rest_factor=0)
    state = job.start(db, 1, background=False)
    # the track with no DJ data first (5), then the top-ups
    assert state["total"] == 3 and seen == ["5", "1", "3"]
    assert job.start(db, 1, background=False) is None


def test_a_grid_left_analysing_is_failed_at_the_next_sweep(db):
    grid_store.mark(db, "7", "analyzing", None)
    assert grid_store.fail_leftover_analyzing(db) == 1
    row = grid_store.get(db, "7")
    assert row["status"] == "error" and "stopped" in row["reason"]
    assert grid_store.current(row, None) is True


def test_unreachable_grids_wait_a_day(db):
    v = worker.analyzer_version()
    _track(db, 8, "/m/8.flac")
    store.save(db, "8", {"status": "done", "dj_analyzer_version": v})
    grid_store.mark(db, "8", "unreachable", "gone")
    import time

    assert grid_store.pending_ids(db, v, retry_unreachable_before=time.time() - 3600) == []
    assert grid_store.pending_ids(db, v, retry_unreachable_before=time.time() + 1) == ["8"]


def test_analyse_again_finds_a_current_grid_again_and_keeps_it_when_that_fails(db, tmp_path):
    """The gauntlet review's M2: Analyse again finds a current grid again
    when the line takes it (``force_grid``); a new analysis that fails puts
    the old grid back as it was, a person's ×2 and its measured grid too."""
    y, _ = dance_track(124.0, sections=(("intro", 8), ("groove", 8)))
    path = write_grid_wav(tmp_path / "g.wav", y)
    _track(db, 6, "/stored/g.wav")
    from core.sample.store import source_signature

    sig = source_signature(path)
    store.save(db, "6", {"bpm": 124.0, "status": "done", "dj_analyzer_version": worker.analyzer_version(),
                         "source_sig": sig})
    # a person's ×2 of a grid measured at 62: kept with its measured grid
    _sql(db, "UPDATE track_dj SET bpm_override = 124.0 WHERE track_id = '6'")
    grid_store.save_result(db, "6", _grid_result(62.0), source_sig=sig)
    before = grid_store.get(db, "6")
    assert before["bpm"] == pytest.approx(124.0) and before["measured_json"]
    calls = []

    def again(p, **kw):
        calls.append(p)
        return _grid_result(bpm=124.5)

    # current: nothing to do, unless asked again
    assert worker.process_track(db, "6", resolve=lambda p: path, analyze_grid=again) == "done"
    assert calls == []
    assert worker.process_track(db, "6", resolve=lambda p: path, analyze_grid=again, force_grid=True) == "done"
    assert calls == [path] and grid_store.get(db, "6")["bpm"] == pytest.approx(124.5)

    grid_store.restore(db, before)

    def broken(p, **kw):
        raise RuntimeError("bad frame")

    assert worker.process_track(db, "6", resolve=lambda p: path, analyze_grid=broken, force_grid=True) == "grid_error"
    after = grid_store.get(db, "6")
    assert {k: after[k] for k in grid_store._FIELDS if k != "analyzed_at"} == \
        {k: before[k] for k in grid_store._FIELDS if k != "analyzed_at"}


def test_analyse_again_marks_only_what_the_line_took(db):
    """M2: ids past the profile's room in line aren't touched (their grid
    stays), and the job remembers the rest to find again when it takes them."""
    job = worker.DjAnalysisJob(process=lambda *a, **k: "done")
    job.start = lambda *a, **k: None  # no sweep takes them meanwhile
    out = job.ask(db, ["1", "2", "3"], 1, limit=2, again=["1", "2", "3"])
    assert out["over"] == 1
    assert job.queue_snapshot(["1", "2", "3"], 1)["again"] == {"1", "2"}


def test_a_restored_grid_follows_a_bpm_set_during_the_decode(db):
    """The phase follow-up of 29 October: Analyse again's failed decode puts
    the old grid back at the octave of the person's BPM as it is now; a ×2
    or a reset made meanwhile isn't undone."""
    _track(db, 7, "/stored/h.wav")
    store.save(db, "7", {"bpm": 124.0, "status": "done", "dj_analyzer_version": worker.analyzer_version()})
    grid_store.save_result(db, "7", _grid_result(124.0), source_sig="s")
    before = grid_store.get(db, "7")
    # ×2 during the decode
    _sql(db, "UPDATE track_dj SET bpm_override = 248.0 WHERE track_id = '7'")
    grid_store.restore(db, before)
    doubled = grid_store.get(db, "7")
    assert doubled["bpm"] == pytest.approx(248.0) and doubled["measured_json"]
    # and a reset during the next one: the measured grid comes back
    _sql(db, "UPDATE track_dj SET bpm_override = NULL WHERE track_id = '7'")
    grid_store.restore(db, doubled)
    back = grid_store.get(db, "7")
    assert back["bpm"] == pytest.approx(124.0) and back["measured_json"] is None
    assert back["period"] == pytest.approx(before["period"])


def test_a_crash_in_analyse_agains_decode_keeps_the_old_grid(db):
    """The follow-up's item 3: the row says ``analyzing`` with the grid it
    replaces; the next sweep's start puts that grid back (a plain decode
    that crashed is still an error)."""
    for tid in ("8", "9"):
        _track(db, int(tid), f"/stored/{tid}.wav")
        store.save(db, tid, {"bpm": 124.0, "status": "done", "dj_analyzer_version": worker.analyzer_version()})
        grid_store.save_result(db, tid, _grid_result(124.0), source_sig="s")
    before = grid_store.get(db, "8")
    grid_store.mark_analyzing_again(db, before, "s")
    grid_store.mark(db, "9", "analyzing", None, source_sig="s")
    assert grid_store.get(db, "8")["status"] == "analyzing"
    assert grid_store.fail_leftover_analyzing(db) == 2
    after = grid_store.get(db, "8")
    assert {k: after[k] for k in grid_store._FIELDS if k != "analyzed_at"} == \
        {k: before[k] for k in grid_store._FIELDS if k != "analyzed_at"}
    assert grid_store.get(db, "9")["status"] == "error"


def test_a_restore_that_fails_at_the_sweeps_start_doesnt_stop_it(db, monkeypatch):
    """The follow-up's review: a locked database while a crashed Analyse
    again's grid is put back is logged, the sweep still starts, and the row
    keeps its grid for the next start to try again."""
    _track(db, 10, "/stored/10.wav")
    store.save(db, "10", {"bpm": 124.0, "status": "done", "dj_analyzer_version": worker.analyzer_version()})
    grid_store.save_result(db, "10", _grid_result(124.0), source_sig="s")
    grid_store.mark_analyzing_again(db, grid_store.get(db, "10"), "s")
    row = grid_store.get(db, "10")
    assert row["status"] == "analyzing" and row["reason"].startswith(grid_store.AGAIN_PREFIX)

    def locked(*a, **k):
        raise RuntimeError("database is locked")

    real = grid_store.restore
    monkeypatch.setattr(grid_store, "restore", locked)
    assert grid_store.fail_leftover_analyzing(db) == 0
    # left for the next start, its grid still in the row
    row = grid_store.get(db, "10")
    assert row["status"] == "analyzing" and row["reason"].startswith(grid_store.AGAIN_PREFIX)
    monkeypatch.setattr(grid_store, "restore", real)
    assert grid_store.fail_leftover_analyzing(db) == 1
    assert grid_store.get(db, "10")["status"] == "done"
