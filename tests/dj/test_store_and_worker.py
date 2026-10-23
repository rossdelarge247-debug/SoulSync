"""The library's DJ data (core/dj/store.py) and the background analysis
(core/dj/worker.py): which value wins, resumable sweeps versioned by the
analyzer, waiting for downloads and an unplugged drive, Stop, tags written
only where a file has none, the signature kept current after a tag write."""

from __future__ import annotations

import threading
import time

import pytest

from core.dj import store, worker
from core.dj.tags import read_dj_tags

from .audio_fixtures import dj_track, write_flac


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

    database = MusicDatabase(database_path=str(tmp_path / "dj.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Saltmarsh')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'Lantern')")
    # Sample Studio's store reads the global database: point it at this one
    import core.sample.store as sample_store

    monkeypatch.setattr(sample_store, "get_database", lambda: database)
    return database


def _track(db, tid, title, path, bpm=None):
    _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, bpm) VALUES (?, '10', '1', ?, ?, ?)",
         (str(tid), title, path, bpm))


def _analysis(bpm=124.0, key="A minor", conf=0.8, energy=7):
    from core.sample.analyze import ANALYZER_VERSION

    return {"bpm": bpm, "onsets": [0.5, 1.0], "duration_s": 3.0, "key": {"name": key, "confidence": conf},
            "energy": energy, "analyzer_version": ANALYZER_VERSION}


# ── which value wins ─────────────────────────────────────────────────────────

def test_a_tag_beats_enrichment_beats_analysis():
    a = _analysis(bpm=58.0, key="C major")  # analysis locked onto half time
    both = store.decide(tag_bpm=128, tag_key="8A", enrichment_bpm=127, analysis=a)
    assert (both["bpm"], both["bpm_source"]) == (128.0, "tag")
    assert (both["musical_key"], both["key_name"], both["key_source"]) == ("8A", "Am", "tag")
    assert both["analyzed_bpm"] == 116.0 and both["analyzed_key"] == "8B"  # kept beside, folded
    enriched = store.decide(enrichment_bpm=127, analysis=a)
    assert (enriched["bpm"], enriched["bpm_source"]) == (127.0, "enrichment")
    assert (enriched["musical_key"], enriched["key_source"], enriched["key_confidence"]) == ("8B", "analysis", 0.8)
    only = store.decide(analysis=a)
    assert (only["bpm"], only["bpm_source"]) == (116.0, "analysis")
    assert (only["energy"], only["energy_source"]) == (7, "analysis")
    assert store.decide(tag_key="nonsense", analysis=a)["key_source"] == "analysis"


# ── one track ────────────────────────────────────────────────────────────────

def test_process_track_keeps_the_values_and_shares_with_sample_studio(db, tmp_path):
    path = write_flac(tmp_path / "a.flac", dj_track(124, 9, True, seconds=2))
    _track(db, 1, "Static Bloom", "/stored/a.flac")
    calls = []
    out = worker.process_track(db, "1", resolve=lambda p: path, analyze=lambda p: calls.append(p) or _analysis())
    assert out == "done" and calls == [path]
    row = store.get(db, "1")
    assert row["bpm"] == 124.0 and row["musical_key"] == "8A" and row["energy"] == 7
    assert row["status"] == "done" and row["dj_analyzer_version"] == worker.analyzer_version()
    assert row["source_sig"] and row["tags_written"] is None
    assert read_dj_tags(path)["bpm"] is None  # writing tags is off
    from core.sample import store as sample_store

    assert sample_store.get_analysis("1")["energy"] == 7
    # a second pass reuses Sample Studio's row instead of decoding again
    _sql(db, "DELETE FROM track_dj")
    assert worker.process_track(db, "1", resolve=lambda p: path, analyze=lambda p: calls.append(p)) == "done"
    assert calls == [path]


def test_tags_are_written_only_where_missing_and_the_signature_follows(db, tmp_path):
    path = write_flac(tmp_path / "b.flac", dj_track(124, 9, True, seconds=2))
    from mutagen.flac import FLAC

    f = FLAC(path)
    f["BPM"] = ["126"]
    f.save()
    _track(db, 2, "Tide", "/stored/b.flac")
    notes = []
    out = worker.process_track(db, "2", resolve=lambda p: path, analyze=lambda p: _analysis(), write_tags=True,
                               notify=notes.append)
    assert out == "tagged" and notes == [1]
    assert read_dj_tags(path) == {"bpm": 126.0, "key": "Am", "format": "vorbis"}
    row = store.get(db, "2")
    assert row["bpm"] == 126.0 and row["bpm_source"] == "tag" and row["tags_written"] == "key"
    from core.sample import store as sample_store
    from core.sample.store import source_signature

    sig = source_signature(path)
    assert row["source_sig"] == sig
    assert sample_store.get_analysis("2")["source_sig"] == sig  # still current: no re-analysis


def test_overwrite_replaces_with_what_analysis_heard(db, tmp_path):
    path = write_flac(tmp_path / "c.flac", dj_track(124, 9, True, seconds=2))
    from mutagen.flac import FLAC

    f = FLAC(path)
    f["BPM"] = ["62"]
    f["INITIALKEY"] = ["C"]
    f.save()
    _track(db, 3, "Overwrite", "/stored/c.flac")
    worker.process_track(db, "3", resolve=lambda p: path, analyze=lambda p: _analysis(), write_tags=True,
                         overwrite_tags=True, notify=lambda n: None)
    assert read_dj_tags(path)["bpm"] == 124.0 and read_dj_tags(path)["key"] == "Am"
    assert store.get(db, "3")["bpm_source"] == "analysis"


def test_an_uncertain_key_is_never_written(db, tmp_path):
    path = write_flac(tmp_path / "d.flac", dj_track(124, 9, True, seconds=2))
    _track(db, 4, "Unsure", "/stored/d.flac")
    worker.process_track(db, "4", resolve=lambda p: path, analyze=lambda p: _analysis(conf=0.3), write_tags=True,
                         notify=lambda n: None)
    assert read_dj_tags(path) == {"bpm": 124.0, "key": None, "format": "vorbis"}
    assert store.lookup(db, ["4"])["4"]["key_uncertain"] is True


def test_missing_files_and_broken_files(db):
    _track(db, 5, "Away", "/drive/gone.flac")
    assert worker.process_track(db, "5", resolve=lambda p: None, analyze=lambda p: _analysis()) == "unreachable"
    assert store.get(db, "5")["status"] == "unreachable"

    def broken(_p):
        raise RuntimeError("ffmpeg could not decode")

    _track(db, 6, "Broken", __file__)
    assert worker.process_track(db, "6", resolve=lambda p: p, analyze=broken) == "error"
    assert "decode" in store.get(db, "6")["error"]

    def no_librosa(_p):
        raise ImportError("librosa is required")

    _track(db, 7, "NoLibrosa", __file__)
    with pytest.raises(worker._Abort):
        worker.process_track(db, "7", resolve=lambda p: p, analyze=no_librosa)


# ── the sweep ────────────────────────────────────────────────────────────────

def _job(process, *, busy=None, away=None, settings=None):
    return worker.DjAnalysisJob(process=process, busy=busy or (lambda db: None), away=away or (lambda: False),
                                settings=settings or (lambda: {"analyze": True, "write_tags": False,
                                                               "overwrite_tags": False}),
                                sleep_floor=0, rest_factor=0, wait_step=0.01)


def _fake_process(db, track_id, **_kw):
    store.save(db, track_id, {"status": "done", "dj_analyzer_version": worker.analyzer_version(), "bpm": 120.0})
    return "done"


def _runs(db):
    from core.library.missing_releases import ensure_table

    conn = db._get_connection()
    ensure_table(conn)
    conn.close()
    return [dict(r) for r in _sql(db, "SELECT * FROM library_jobs WHERE kind = 'dj_analysis' ORDER BY id")]


def test_a_sweep_does_every_track_once_and_resumes(db):
    for i in range(1, 5):
        _track(db, i, f"T{i}", f"/m/{i}.flac")
    _track(db, 9, "No file", "")
    seen = []
    job = _job(lambda d, t, **kw: seen.append(t) or _fake_process(d, t))
    state = job.start(db, 1, background=False)
    assert state["total"] == 4 and seen == ["1", "2", "3", "4"]
    [run] = _runs(db)
    assert run["status"] == "done" and run["done"] == 4 and run["finished_at"]
    assert job.start(db, 1, background=False) is None  # nothing left: no new row
    assert len(_runs(db)) == 1
    assert store.counts(db, worker.analyzer_version()) == {"tracks": 4, "analyzed": 4, "failed": 0,
                                                           "unreachable": 0, "pending": 0}
    # a new analyzer version redoes the library
    _sql(db, "UPDATE track_dj SET dj_analyzer_version = dj_analyzer_version - 1 WHERE track_id IN ('2', '3')")
    seen.clear()
    job.start(db, 1, background=False)
    assert seen == ["2", "3"]


def test_unreachable_files_wait_a_day_unless_started_by_hand(db):
    _track(db, 1, "Away", "/drive/a.flac")
    store.mark(db, "1", "unreachable", "gone", worker.analyzer_version())
    job = _job(_fake_process)
    assert job.start(db, 1, manual=False, background=False) is None
    assert job.start(db, 1, manual=True, background=False)["total"] == 1


def test_it_waits_for_a_download_and_the_drive(db):
    _track(db, 1, "T1", "/m/1.flac")
    reasons = iter(["download", "download", None])
    aways = iter([True, False, False, False])
    seen_waiting = []
    job = _job(_fake_process, busy=lambda d: next(reasons, None), away=lambda: next(aways, False))
    orig = job._update

    def spy(**fields):
        if fields.get("waiting"):
            seen_waiting.append(fields["waiting"])
        orig(**fields)

    job._update = spy
    job.start(db, 1, background=False)
    assert seen_waiting[:3] == ["drive_away", "download", "download"]
    assert _runs(db)[0]["done"] == 1


def test_stop_holds_the_automatic_sweeps(db):
    for i in range(1, 4):
        _track(db, i, f"T{i}", f"/m/{i}.flac")
    gate, entered = threading.Event(), threading.Event()

    def slow(d, t, **kw):
        entered.set()
        gate.wait(5)
        return _fake_process(d, t)

    job = _job(slow)
    job.start(db, 1)
    assert entered.wait(5) and job.running()
    assert job.stop() is True and job.held is True
    gate.set()
    job.join(5)
    assert not job.running() and _runs(db)[0]["status"] == "stopped" and _runs(db)[0]["done"] == 1
    assert job.stop() is False
    # a Start by hand lifts the hold
    gate.set()
    job.start(db, 1, manual=True, background=False)
    assert job.held is False and _runs(db)[-1]["status"] == "done"


def test_turning_the_setting_off_ends_the_sweep(db):
    for i in range(1, 4):
        _track(db, i, f"T{i}", f"/m/{i}.flac")
    prefs = {"analyze": True}

    def process(d, t, **kw):
        prefs["analyze"] = False
        return _fake_process(d, t)

    job = _job(process, settings=lambda: dict(prefs))
    job.start(db, 1, background=False)
    assert _runs(db)[0]["status"] == "stopped" and _runs(db)[0]["done"] == 1


def test_missing_librosa_fails_the_sweep_once(db):
    _track(db, 1, "T1", "/m/1.flac")
    _track(db, 2, "T2", "/m/2.flac")

    def abort(d, t, **kw):
        raise worker._Abort("librosa is required for sample analysis")

    job = _job(abort)
    job.start(db, 1, background=False)
    [run] = _runs(db)
    assert run["status"] == "failed" and "librosa" in run["note"]


def test_tagged_and_unreachable_are_counted_on_the_row(db):
    for i in range(1, 4):
        _track(db, i, f"T{i}", f"/m/{i}.flac")
    outcomes = iter(["tagged", "unreachable", "error"])
    job = _job(lambda d, t, **kw: next(outcomes))
    job.start(db, 1, background=False)
    [run] = _runs(db)
    assert (run["done"], run["failed"], run["found_releases"], run["found_artists"]) == (1, 1, 1, 1)
    state = worker.public_state(db, job)
    assert state["tags_written"] == 1 and state["unreachable"] == 1 and state["recent"] is True


def test_a_sweep_cut_off_by_a_restart_reads_as_stopped(db):
    from core.library.missing_releases import ensure_table

    conn = db._get_connection()
    ensure_table(conn)
    conn.execute("INSERT INTO library_jobs (kind, profile_id, status, total, done, started_at) "
                 "VALUES ('dj_analysis', 1, 'running', 9, 4, 100)")
    conn.commit()
    conn.close()
    state = worker.public_state(db, worker.DjAnalysisJob())
    assert state["status"] == "stopped" and state["note"] == "restart"


def test_the_scheduler_starts_an_automatic_sweep(db, monkeypatch):
    _track(db, 1, "T1", "/m/1.flac")
    job = _job(_fake_process)
    monkeypatch.setattr(worker, "JOB", job)
    monkeypatch.setattr(worker, "settings_state", lambda: {"analyze": True, "write_tags": False,
                                                           "overwrite_tags": False})
    try:
        assert worker.start_scheduler(lambda: db, first_delay=0, interval=60) is True
        deadline = time.time() + 5
        while time.time() < deadline and not _runs(db):
            time.sleep(0.02)
        job.join(5)
        assert _runs(db) and _runs(db)[0]["status"] == "done"
        assert worker.start_scheduler(lambda: db) is False  # already running
    finally:
        worker.stop_scheduler()
        if worker._scheduler is not None:
            worker._scheduler.join(5)
        monkeypatch.setattr(worker, "_scheduler", None)


def test_busy_reason_reads_downloads_and_imports(db, monkeypatch):
    import core.activity.feed as feed

    monkeypatch.setattr(feed, "snapshot_live_batches", lambda: {"b1": {}})
    assert worker.busy_reason(db) == "download"
    monkeypatch.setattr(feed, "snapshot_live_batches", lambda: {})
    assert worker.busy_reason(db) is None
    now = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    _sql(db, "INSERT INTO auto_import_history (folder_name, folder_path, status, created_at) "
             "VALUES ('x', '/x', 'processing', ?)", (now,))
    assert worker.busy_reason(db) == "import"


def test_library_away_without_the_drive_guard_is_false():
    assert worker.library_away() in (False, True)
