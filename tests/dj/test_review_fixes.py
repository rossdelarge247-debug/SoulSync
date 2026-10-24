"""Regression tests for the review of DJ stage 1: the drive move's holds, a
bounded decode with size caps, the per-file lock and the Write Tags batch, no
in-place fallback, a file replaced mid-analysis, which tags count as present,
equal values, the tag layout, Sample Studio's stems, profile scope and where
writes may land."""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path

import pytest

from core.dj import store, worker
from core.dj.tags import read_dj_tags, write_dj_tags

from .audio_fixtures import dj_track, write_flac, write_with_ffmpeg

HERE = Path(__file__).resolve().parents[2]


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

    database = MusicDatabase(database_path=str(tmp_path / "review.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Saltmarsh')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'Lantern')")
    import core.sample.store as sample_store

    monkeypatch.setattr(sample_store, "get_database", lambda: database)
    return database


def _track(db, tid, path, owner=None):
    _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, owner_profile_id) "
             "VALUES (?, '10', '1', ?, ?, ?)", (str(tid), f"T{tid}", path, owner))


def _analysis(conf=0.8, truncated=False):
    from core.sample.analyze import ANALYZER_VERSION

    return {"bpm": 124.0, "onsets": [0.5], "duration_s": 3.0, "key": {"name": "A minor", "confidence": conf},
            "energy": 7, "analyzer_version": ANALYZER_VERSION, "truncated": truncated}


def _roots(tmp_path):
    return lambda: [str(tmp_path)]


def _job(process, **kw):
    return worker.DjAnalysisJob(process=process, busy=kw.get("busy", lambda d: None),
                                away=kw.get("away", lambda: False), held=kw.get("held", lambda: False),
                                settings=lambda: {"analyze": True, "write_tags": True, "overwrite_tags": False},
                                sleep_floor=0, rest_factor=0, wait_step=0.01)


def _done(db, track_id, **_kw):
    store.save(db, track_id, {"status": "done", "dj_analyzer_version": worker.analyzer_version()})
    return "done"


# ── 1. the drive move ────────────────────────────────────────────────────────

def test_a_drive_move_hold_makes_the_sweep_wait(db):
    _track(db, 1, "/m/1.flac")
    holds = iter([True, True, False])
    waits = []
    job = _job(_done, held=lambda: next(holds, False))
    orig = job._update
    job._update = lambda **f: (waits.append(f["waiting"]) if f.get("waiting") else None, orig(**f))[1]
    job.start(db, 1, background=False)
    assert waits[:2] == ["drive_move", "drive_move"]


def test_the_default_hold_reads_the_drive_move(monkeypatch):
    from core.drives import holds

    holds.hold(5, "Music HD")
    try:
        assert worker.DjAnalysisJob()._held() is True
    finally:
        holds.release(5)
    assert worker.DjAnalysisJob()._held() is False


def test_pause_for_move_holds_until_resumed():
    job = worker.DjAnalysisJob(away=lambda: False)
    job.pause_for_move()
    assert job._held() is True
    job.resume_after_move()
    assert job._held() is False


def test_the_move_sees_a_track_in_progress():
    job = worker.DjAnalysisJob()
    assert job.busy_words() == []
    job._in_track.set()
    assert job.busy_words() == ["BPM/key analysis"]


def test_web_server_tells_the_move_about_the_job():
    src = (HERE / "web_server.py").read_text(encoding="utf-8")
    busy = src[src.index("def _drives_busy"):src.index("def _drives_pause_workers")]
    pause = src[src.index("def _drives_pause_workers"):src.index("def _drives_resume_workers")]
    resume = src[src.index("def _drives_resume_workers"):src.index("def _drives_after_switch")]
    assert "busy_words()" in busy
    assert "pause_for_move()" in pause
    assert "resume_after_move()" in resume


def test_a_hold_arriving_mid_track_stops_the_write(db, tmp_path):
    path = write_flac(tmp_path / "a.flac", dj_track(124, 9, True, seconds=2))
    _track(db, 1, path)
    out = worker.process_track(db, "1", resolve=lambda p: p, analyze=lambda p: _analysis(), write_tags=True,
                               notify=lambda n: None, may_write=lambda: False, library_roots=_roots(tmp_path))
    assert out == "deferred"
    assert read_dj_tags(path)["bpm"] is None
    assert "1" in store.pending_ids(db, worker.analyzer_version())


# ── 2. bounded decode and caps ───────────────────────────────────────────────

def test_a_provisional_row_is_written_before_decoding(db, tmp_path):
    path = write_flac(tmp_path / "b.flac", dj_track(124, 9, True, seconds=2))
    _track(db, 2, path)
    seen = []

    def analyze(p):
        seen.append(store.get(db, "2")["status"])
        return _analysis()

    worker.process_track(db, "2", resolve=lambda p: p, analyze=analyze, library_roots=_roots(tmp_path))
    assert seen == ["analyzing"] and store.get(db, "2")["status"] == "done"


def test_a_track_left_analyzing_by_a_crash_is_skipped_with_a_reason(db):
    _track(db, 3, "/m/3.flac")
    store.save(db, "3", {"status": "analyzing", "dj_analyzer_version": worker.analyzer_version()})
    seen = []
    job = _job(lambda d, t, **kw: seen.append(t) or _done(d, t))
    job.start(db, 1, background=False)
    row = store.get(db, "3")
    assert seen == [] and row["status"] == "error" and "stopped while analysing" in row["error"]


def test_long_and_huge_files_are_skipped(db, tmp_path, monkeypatch):
    path = write_flac(tmp_path / "c.flac", dj_track(124, 9, True, seconds=3))
    _track(db, 4, path)
    monkeypatch.setattr(worker, "MAX_SECONDS", 1.0)
    called = []
    assert worker.process_track(db, "4", resolve=lambda p: p, analyze=lambda p: called.append(p),
                                library_roots=_roots(tmp_path)) == "skipped"
    assert called == [] and store.get(db, "4")["error"] == "too long to analyse"
    monkeypatch.setattr(worker, "MAX_SECONDS", 3600.0)
    monkeypatch.setattr(worker, "MAX_BYTES", 10)
    _track(db, 5, path)
    assert worker.process_track(db, "5", resolve=lambda p: p, analyze=lambda p: called.append(p),
                                library_roots=_roots(tmp_path)) == "skipped"
    assert store.lookup(db, ["5"])["5"]["skipped"] == "too long to analyse"


def test_analysis_decodes_only_the_first_minutes(tmp_path):
    from core.sample import analyze

    path = write_flac(tmp_path / "d.flac", dj_track(124, 9, True, seconds=6))
    result = analyze.analyze_track(path, max_seconds=2)
    assert result["duration_s"] <= 2.1 and result["truncated"] is True
    full = analyze.analyze_track(path)
    assert full["duration_s"] == pytest.approx(6.0, abs=0.1) and full["truncated"] is False


def test_the_ffmpeg_decode_is_bounded(monkeypatch, tmp_path):
    from core.sample import analyze

    calls = []

    class _P:
        returncode = 1
        stdout = b""
        stderr = b"x"

    monkeypatch.setattr(analyze.subprocess, "run", lambda cmd, **kw: calls.append(cmd) or _P())
    with pytest.raises(RuntimeError):
        analyze._decode_via_ffmpeg(__file__, target_sr=22050, max_seconds=600)
    cmd = calls[0]
    assert cmd[cmd.index("-t") + 1] == "600" and cmd[cmd.index("-ar") + 1] == "22050" and "-ac" in cmd


def test_a_truncated_analysis_is_not_handed_to_sample_studio(db, tmp_path):
    path = write_flac(tmp_path / "e.flac", dj_track(124, 9, True, seconds=2))
    _track(db, 6, path)
    worker.process_track(db, "6", resolve=lambda p: p, analyze=lambda p: _analysis(truncated=True),
                         library_roots=_roots(tmp_path))
    from core.sample import store as sample_store

    assert sample_store.get_analysis("6") is None and store.get(db, "6")["status"] == "done"


# ── 3. the per-file lock and the Write Tags batch ────────────────────────────

def test_tag_writes_take_the_file_lock(tmp_path):
    from core.metadata.common import get_file_lock

    path = write_flac(tmp_path / "f.flac", dj_track(124, 9, True, seconds=2))
    lock = get_file_lock(path)
    lock.acquire()
    done = threading.Event()
    t = threading.Thread(target=lambda: (write_dj_tags(path, bpm=124, key_name="Am"), done.set()))
    t.start()
    try:
        assert not done.wait(0.5)  # blocked behind the lock
    finally:
        lock.release()
    assert done.wait(10)
    assert read_dj_tags(path)["bpm"] == 124.0


def test_the_write_tags_batch_makes_the_sweep_wait(db, monkeypatch):
    import core.activity.feed as feed

    monkeypatch.setattr(feed, "snapshot_live_batches", lambda: {})
    monkeypatch.setattr(worker, "_busy_hooks", [lambda: "tag_write"])
    assert worker.busy_reason(db) == "tag_write"


# ── 4. no in-place fallback ──────────────────────────────────────────────────

def test_a_failed_safe_save_leaves_the_file_alone(tmp_path, monkeypatch):
    import errno
    import shutil

    path = write_flac(tmp_path / "g.flac", dj_track(124, 9, True, seconds=2))
    before = Path(path).read_bytes()

    def full(*_a, **_k):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(shutil, "copy2", full)
    result = write_dj_tags(path, bpm=124, key_name="Am")
    assert result["written"] == [] and result["error"]
    assert Path(path).read_bytes() == before


def test_other_callers_keep_the_in_place_fallback(tmp_path, monkeypatch):
    import shutil
    from types import SimpleNamespace

    from mutagen import File as MutagenFile
    from mutagen.flac import FLAC
    from mutagen.id3 import ID3

    from core.metadata.common import save_audio_file

    path = write_flac(tmp_path / "h.flac", dj_track(124, 9, True, seconds=2))
    audio = FLAC(path)
    audio["TITLE"] = ["x"]
    monkeypatch.setattr(shutil, "copy2", lambda *a, **k: (_ for _ in ()).throw(OSError("busy")))
    assert save_audio_file(audio, SimpleNamespace(ID3=ID3, FLAC=FLAC, File=MutagenFile)) is True
    assert FLAC(path)["TITLE"] == ["x"]


# ── 5. a file replaced during analysis ───────────────────────────────────────

def test_a_file_replaced_during_analysis_is_not_tagged_or_stamped(db, tmp_path):
    path = write_flac(tmp_path / "i.flac", dj_track(124, 9, True, seconds=2))
    _track(db, 7, path)

    def analyze(p):
        time.sleep(0.01)
        write_flac(p, dj_track(100, 0, False, seconds=3))  # an upgrade lands meanwhile
        return _analysis()

    out = worker.process_track(db, "7", resolve=lambda p: p, analyze=analyze, write_tags=True,
                               notify=lambda n: None, library_roots=_roots(tmp_path))
    assert out == "stale"
    assert read_dj_tags(path)["bpm"] is None
    assert "7" in store.pending_ids(db, worker.analyzer_version())


# ── 6 and 7. which tags count, equal values ──────────────────────────────────

def _flac_with(tmp_path, name, **fields):
    from mutagen.flac import FLAC

    path = write_flac(tmp_path / name, dj_track(124, 9, True, seconds=2))
    f = FLAC(path)
    for k, v in fields.items():
        f[k] = [v]
    f.save()
    return path


@pytest.mark.parametrize("raw", ["128 BPM", "0", "12800"])
def test_an_unreadable_bpm_already_in_the_file_stays(tmp_path, raw):
    from mutagen.flac import FLAC

    path = _flac_with(tmp_path, "j.flac", BPM=raw)
    write_dj_tags(path, bpm=124, key_name="Am")
    assert FLAC(path)["BPM"] == [raw]
    assert FLAC(path)["INITIALKEY"] == ["Am"]


@pytest.mark.parametrize("bpm", [0.3, 10, 500])
def test_only_a_sensible_bpm_is_written(tmp_path, bpm):
    path = write_flac(tmp_path / "k.flac", dj_track(124, 9, True, seconds=2))
    assert "bpm" not in write_dj_tags(path, bpm=bpm)["written"]
    assert read_dj_tags(path)["bpm"] is None


def test_replace_skips_values_already_equal(tmp_path):
    path = _flac_with(tmp_path, "l.flac", BPM="124", INITIALKEY="Am")
    mtime = os.stat(path).st_mtime_ns
    assert write_dj_tags(path, bpm=124.2, key_name="Am", overwrite=True) == {"written": [], "error": None}
    assert os.stat(path).st_mtime_ns == mtime


# ── 8. the tag layout ────────────────────────────────────────────────────────

@pytest.mark.skipif(not os.path.exists("/usr/bin/ffmpeg"), reason="ffmpeg makes the mp3")
def test_an_mp3_keeps_its_id3v1_and_v23(tmp_path):
    from mutagen.id3 import ID3, TIT2

    path = write_with_ffmpeg(tmp_path / "m.mp3", dj_track(124, 9, True, seconds=2),
                             ["-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "0"])
    tags = ID3()
    tags.add(TIT2(encoding=1, text=["Static Bloom"]))
    tags.save(path, v1=2, v2_version=3)
    assert write_dj_tags(path, bpm=124, key_name="Am")["written"] == ["bpm", "key"]
    after = ID3(path)
    assert after.version[:2] == (2, 3)
    assert Path(path).read_bytes()[-128:-125] == b"TAG"


# ── 9. Sample Studio's stems ─────────────────────────────────────────────────

def test_a_tag_write_keeps_the_stems_current(db, tmp_path):
    from core.sample import store as sample_store
    from core.sample.store import source_signature

    path = write_flac(tmp_path / "n.flac", dj_track(124, 9, True, seconds=2))
    _track(db, 8, path)
    old = source_signature(path)
    sample_store.save_analysis("8", _analysis(), source_sig=old)
    _sql(db, "INSERT INTO sample_stems (track_id, stem, file_path, source_sig) VALUES ('8', 'drums', '/s', ?)", (old,))
    assert worker.process_track(db, "8", resolve=lambda p: p, analyze=lambda p: _analysis(), write_tags=True,
                                notify=lambda n: None, library_roots=_roots(tmp_path)) == "tagged"
    new = source_signature(path)
    assert _sql(db, "SELECT source_sig FROM sample_stems WHERE track_id = '8'")[0][0] == new


# ── 10. profile scope ────────────────────────────────────────────────────────

def test_lookup_and_mixes_stay_in_the_callers_library(db):
    from core.library_scope import reset_library_scope, set_library_scope

    for tid, owner in (("20", None), ("21", 7)):
        _track(db, tid, f"/m/{tid}.flac", owner=owner)
        store.save(db, tid, {"bpm": 124.0, "musical_key": "8A", "status": "done",
                             "dj_analyzer_version": worker.analyzer_version()})
    token = set_library_scope("shared")
    try:
        assert set(store.lookup(db, ["20", "21"])) == {"20"}
        assert store.mixes_with(db, "21")["track"] is None
        assert [m["id"] for m in store.mixes_with(db, "20")["matches"]] == []
    finally:
        reset_library_scope(token)


def test_a_broken_scope_fails_closed():
    class Broken:
        def _current_scope_sql(self, column):
            raise RuntimeError("no scope")

    sql, _params = store._scope(Broken())
    assert "1=0" in sql


# ── 11. where writes may land ────────────────────────────────────────────────

def test_no_write_into_a_copy_outside_the_library(db, tmp_path):
    lib = tmp_path / "library"
    lib.mkdir()
    elsewhere = tmp_path / "downloads"
    elsewhere.mkdir()
    path = write_flac(elsewhere / "o.flac", dj_track(124, 9, True, seconds=2))
    _track(db, 9, "/gone/o.flac")
    out = worker.process_track(db, "9", resolve=lambda p: path, analyze=lambda p: _analysis(), write_tags=True,
                               notify=lambda n: None, library_roots=lambda: [str(lib)])
    assert out == "done" and read_dj_tags(path)["bpm"] is None
    # a stored path that exists as it is may be written
    _track(db, 10, path)
    assert worker.process_track(db, "10", resolve=lambda p: p, analyze=lambda p: _analysis(), write_tags=True,
                                notify=lambda n: None, library_roots=lambda: [str(lib)]) == "tagged"
