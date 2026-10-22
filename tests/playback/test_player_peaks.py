"""The player's waveform peaks (core/playback/peaks.py).

The pure parts (bar heights, decode rate, the bounded queue) run without a
database; the cache and the full "pending, then ready" round trip run on a
real temporary database and a real file through Sample Studio's decoder.
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import threading

import numpy as np
import pytest
import soundfile as sf

from core.playback import peaks as P


# ── bar heights ──────────────────────────────────────────────────────────────

def test_normalise_scales_the_loudest_bar_to_one():
    assert P.normalise([-0.2, -0.5, 0.0], [0.1, 0.25, 0.0]) == [0.4, 1.0, 0.0]


def test_normalise_uses_the_larger_excursion_either_side_of_zero():
    # a bucket that only dips negative still has height
    assert P.normalise([-0.8, -0.1], [0.2, 0.4]) == [1.0, 0.5]


def test_normalise_keeps_silence_flat():
    assert P.normalise([0.0, 0.0], [0.0, 0.0]) == [0.0, 0.0]
    assert P.normalise([], []) == []


def test_normalise_rounds_to_three_places_and_never_passes_one():
    out = P.normalise([-1 / 3, -1.0], [1 / 3, 1.0])
    assert out == [0.333, 1.0]
    assert all(0.0 <= v <= 1.0 for v in out)


# ── decode rate ──────────────────────────────────────────────────────────────

def test_short_tracks_decode_at_the_full_coarse_rate():
    assert P.decode_rate_for(240) == P.DECODE_RATE
    assert P.decode_rate_for(60) == P.DECODE_RATE


def test_long_files_decode_slower_so_memory_stays_flat():
    two_hours = 2 * 3600
    rate = P.decode_rate_for(two_hours)
    assert rate < P.DECODE_RATE
    assert rate * two_hours <= P.MAX_DECODED_SAMPLES


def test_very_long_files_never_drop_under_the_floor():
    assert P.decode_rate_for(40 * 3600) == P.MIN_DECODE_RATE


def test_unknown_length_decodes_at_a_safe_rate():
    assert P.decode_rate_for(None) == P.DECODE_RATE // 4
    assert P.decode_rate_for("nonsense") == P.DECODE_RATE // 4
    assert P.decode_rate_for(0) == P.DECODE_RATE // 4


def test_only_audio_extensions_count():
    assert P.is_audio_path("/m/a/b.FLAC")
    assert P.is_audio_path("song.m4a")
    assert not P.is_audio_path("/etc/passwd")
    assert not P.is_audio_path("cover.jpg")
    assert not P.is_audio_path(None)


# ── the bounded queue ────────────────────────────────────────────────────────

class _HeldExecutor:
    """Runs nothing until release(): lets a test fill the queue."""

    def __init__(self):
        self.jobs = []

    def submit(self, fn):
        self.jobs.append(fn)

    def release(self):
        while self.jobs:
            self.jobs.pop(0)()


def test_queue_refuses_past_its_bound_and_never_runs_on_the_caller():
    held = _HeldExecutor()
    q = P.PeaksJobs(max_pending=3, executor_factory=lambda: held)
    ran = []
    assert q.submit("a", lambda: ran.append("a"))
    assert q.submit("b", lambda: ran.append("b"))
    assert q.submit("c", lambda: ran.append("c"))
    # full: nothing added, nothing run here
    assert q.submit("d", lambda: ran.append("d")) is False
    assert ran == []
    assert q.queued_count() == 3
    held.release()
    assert ran == ["a", "b", "c"]
    assert q.queued_count() == 0
    # room again
    assert q.submit("d", lambda: ran.append("d"))


def test_queue_runs_one_job_per_key():
    held = _HeldExecutor()
    q = P.PeaksJobs(max_pending=5, executor_factory=lambda: held)
    ran = []
    assert q.submit("same", lambda: ran.append(1))
    assert q.submit("same", lambda: ran.append(2))  # already queued: True, not added
    assert len(held.jobs) == 1
    held.release()
    assert ran == [1]


def test_a_failing_job_frees_its_slot():
    held = _HeldExecutor()
    q = P.PeaksJobs(max_pending=1, executor_factory=lambda: held)

    def boom():
        raise RuntimeError("bad file")

    assert q.submit("x", boom)
    held.release()
    assert q.queued_count() == 0
    assert q.submit("y", lambda: None)


def test_the_real_executor_decodes_one_file_at_a_time():
    q = P.PeaksJobs(max_pending=4)
    running = []
    peak = []
    lock = threading.Lock()
    done = threading.Event()

    def work():
        with lock:
            running.append(1)
            peak.append(len(running))
        threading.Event().wait(0.02)
        with lock:
            running.pop()
            if len(peak) == 4:
                done.set()

    for key in "abcd":
        assert q.submit(key, work)
    assert done.wait(5)
    assert max(peak) == 1


# ── the cache and the round trip, on a real database ────────────────────────

class _Db:
    """The two calls the module makes on MusicDatabase, over a temp sqlite file."""

    def __init__(self, path):
        self.path = str(path)
        conn = sqlite3.connect(self.path)
        P.ensure_schema(conn.cursor())
        conn.commit()
        conn.close()

    def _get_connection(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn


def _tone(path, seconds=3.0, sr=44100, subtype="PCM_16"):
    t = np.arange(int(seconds * sr)) / sr
    # loud first half, quiet second half: the outline should show it
    y = np.where(t < seconds / 2, 0.8, 0.2) * np.sin(2 * np.pi * 220 * t)
    sf.write(str(path), y.astype(np.float32), sr, subtype=subtype)


class _Inline:
    def submit(self, fn):
        fn()


def test_first_ask_is_pending_then_the_cache_answers(tmp_path):
    db = _Db(tmp_path / "m.db")
    song = tmp_path / "song.flac"
    _tone(song)
    held = _HeldExecutor()
    q = P.PeaksJobs(executor_factory=lambda: held)

    first = P.peaks_for_track(db, "t1", str(song), 3.0, queue=q)
    assert first == {"state": "pending", "queued": True}
    # asking again while it waits queues nothing new
    assert P.peaks_for_track(db, "t1", str(song), 3.0, queue=q)["state"] == "pending"
    assert len(held.jobs) == 1

    held.release()
    ready = P.peaks_for_track(db, "t1", str(song), 3.0, queue=q)
    assert ready["state"] == "ready"
    assert len(ready["peaks"]) == P.PEAK_COUNT
    assert max(ready["peaks"]) == 1.0
    assert abs(ready["duration_s"] - 3.0) < 0.05
    first_half = sum(ready["peaks"][: P.PEAK_COUNT // 2 - 5])
    second_half = sum(ready["peaks"][P.PEAK_COUNT // 2 + 5:])
    assert first_half > second_half * 2


def test_a_changed_file_is_worked_out_again(tmp_path):
    db = _Db(tmp_path / "m.db")
    song = tmp_path / "song.wav"
    _tone(song)
    q = P.PeaksJobs(executor_factory=_Inline)
    P.peaks_for_track(db, "t1", str(song), 3.0, queue=q)
    assert P.peaks_for_track(db, "t1", str(song), 3.0, queue=q)["state"] == "ready"
    # an upgrade replaces the file: a new size, a new signature
    _tone(song, seconds=5.0)
    assert P.peaks_for_track(db, "t1", str(song), 5.0, queue=q)["state"] == "pending"
    again = P.peaks_for_track(db, "t1", str(song), 5.0, queue=q)
    assert again["state"] == "ready"
    assert abs(again["duration_s"] - 5.0) < 0.05


def test_an_older_version_row_is_recomputed(tmp_path):
    db = _Db(tmp_path / "m.db")
    song = tmp_path / "song.wav"
    _tone(song)
    sig = P.file_signature(str(song))
    conn = db._get_connection()
    conn.execute(
        "INSERT INTO track_peaks (track_id, file_sig, version, duration_s, peaks_json, error, computed_at) "
        "VALUES ('t1', ?, 0, 3.0, '[0.5]', NULL, 0)", (sig,))
    conn.commit()
    conn.close()
    assert P.read_cached(db, "t1", sig) is None


def test_an_undecodable_file_is_remembered_as_failed(tmp_path):
    db = _Db(tmp_path / "m.db")
    junk = tmp_path / "broken.flac"
    junk.write_bytes(b"not audio at all" * 64)
    q = P.PeaksJobs(executor_factory=_Inline)
    assert P.peaks_for_track(db, "t9", str(junk), None, queue=q)["state"] == "pending"
    failed = P.peaks_for_track(db, "t9", str(junk), None, queue=q)
    assert failed["state"] == "failed"
    assert failed["peaks"] is None
    assert failed["reason"] == "unreadable"


def test_missing_and_non_audio_files_answer_at_once(tmp_path):
    db = _Db(tmp_path / "m.db")
    q = P.PeaksJobs(executor_factory=_HeldExecutor)
    assert P.peaks_for_track(db, "t1", None, queue=q)["reason"] == "not_on_disk"
    assert P.peaks_for_track(db, "t1", str(tmp_path / "gone.flac"), queue=q)["reason"] == "not_on_disk"
    text = tmp_path / "notes.txt"
    text.write_text("hello")
    assert P.peaks_for_track(db, "t1", str(text), queue=q)["reason"] == "not_audio"
    assert q.queued_count() == 0


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_compute_peaks_at_a_low_rate_keeps_the_length(tmp_path):
    from core.sample.analyze import compute_peaks

    song = tmp_path / "hires.flac"
    _tone(song, seconds=4.0, sr=96000, subtype="PCM_24")
    out = compute_peaks(str(song), buckets=200, sample_rate=2000)
    assert out["buckets"] == 200
    assert abs(out["duration_s"] - 4.0) < 0.05


def test_compute_peaks_without_ffmpeg_falls_back_to_the_files_own_rate(tmp_path, monkeypatch):
    from core.sample import analyze

    song = tmp_path / "plain.wav"
    _tone(song, seconds=2.0)

    def no_ffmpeg():
        raise RuntimeError("ffmpeg isn't installed")

    monkeypatch.setattr(analyze, "ffmpeg_bin", no_ffmpeg)
    out = analyze.compute_peaks(str(song), buckets=200, sample_rate=2000)
    assert abs(out["duration_s"] - 2.0) < 0.05


def test_ensure_schema_is_repeatable(tmp_path):
    conn = sqlite3.connect(os.path.join(tmp_path, "x.db"))
    P.ensure_schema(conn.cursor())
    P.ensure_schema(conn.cursor())
    cols = [r[1] for r in conn.execute("PRAGMA table_info(track_peaks)")]
    assert cols == ["track_id", "file_sig", "version", "duration_s", "peaks_json", "error", "computed_at"]
