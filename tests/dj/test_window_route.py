"""Auto-mix stage B's one server route (api/dj.py, core/dj/window.py): a
stretch of a library track as WAV for the browser's two-deck engine. It
needs a profile, stays in the caller's library, refuses what isn't a plain
number and caps the length, the end and how many decode at once, keeps a
hide-explicit profile from an explicit track, and its samples are the same
decoder's as the analysis's, on the same timeline."""

from __future__ import annotations

import io
import shutil
import threading

import numpy as np
import pytest
from flask import Flask, g

from core.dj import store, window, worker

pytestmark = pytest.mark.gauntlet

needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg isn't installed")
SR = 48000


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _clicks(seconds=30.0, sr=SR):
    """Stereo: a click every half second on the left, a tone on the right,
    so a window's place in the track can be checked to the sample."""
    n = int(seconds * sr)
    y = np.zeros((n, 2), np.float32)
    y[::sr // 2, 0] = 0.9
    t = np.arange(n) / sr
    y[:, 1] = 0.3 * np.sin(2 * np.pi * (220 + 20 * t) * t)
    return y


@pytest.fixture
def files(tmp_path):
    import soundfile as sf

    y = _clicks()
    flac = tmp_path / "night-ferry.flac"
    sf.write(str(flac), y, SR, subtype="PCM_16")
    return {"flac": str(flac), "audio": y}


@pytest.fixture
def db(tmp_path, files):
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "window.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Saltmarsh')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'Lantern')")
    # 1 yours, 2 another profile's, 3 a file that isn't there, 5 explicit
    for tid, path, owner, explicit in (("1", files["flac"], None, 0), ("2", files["flac"], 7, 0),
                                       ("3", "/nowhere/gone.flac", None, 0), ("5", files["flac"], None, 1)):
        _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration, owner_profile_id, "
                       "explicit) VALUES (?, '10', '1', ?, ?, 30000, ?, ?)", (tid, f"T{tid}", path, owner, explicit))
        store.save(database, tid, {"bpm": 120.0, "status": "done", "dj_analyzer_version": worker.analyzer_version()})
    return database


@pytest.fixture
def client(db, monkeypatch):
    import api.content_guard as guard
    import api.dj as dj_api
    from core.library_scope import reset_library_scope, set_library_scope

    dj_api.configure(get_database_=lambda: db)
    app = Flask(__name__)
    tokens = []
    state = {"profile": 1, "kid": False}

    @app.before_request
    def _profile():
        if state["profile"] is not None:
            g.profile_id = state["profile"]
        tokens.append(set_library_scope("shared"))

    @app.teardown_request
    def _scope(_exc):
        if tokens:
            reset_library_scope(tokens.pop())

    monkeypatch.setattr(guard, "_hide_explicit", lambda: state["kid"])
    # the guard's own hook, on this app, with its database swapped only for
    # this test (register() would leave it set for the next test's app)
    monkeypatch.setattr(guard, "_get_database", lambda: db)
    app.before_request(guard._guard_play)
    app.register_blueprint(dj_api.create_blueprint())
    c = app.test_client()
    c.state = state
    return c


def _read(res):
    import soundfile as sf

    data, sr = sf.read(io.BytesIO(res.data), dtype="float32", always_2d=True)
    return data, sr


def test_a_profile_is_needed(client, monkeypatch):
    import api.dj as dj_api

    monkeypatch.setattr(dj_api, "get_current_profile_id", lambda: None)
    assert client.get("/api/library/dj/window/1?start=0&dur=5").status_code == 401


@needs_ffmpeg
def test_a_window_is_the_tracks_own_samples_on_its_own_timeline(client, files):
    res = client.get("/api/library/dj/window/1?start=10.25&dur=4&rate=48000")
    assert res.status_code == 200 and res.mimetype == "audio/wav"
    assert res.headers["Cache-Control"] == "private, no-store"
    assert res.headers["X-Window-Start"] == "10.250000" and res.headers["X-Window-Rate"] == "48000"
    data, sr = _read(res)
    assert sr == SR and data.shape == (4 * SR, 2)
    want = files["audio"][int(10.25 * SR):int(14.25 * SR)]
    # 16-bit: within a quantisation step, and the clicks on the very sample
    assert np.max(np.abs(data - want)) < 2.0 / 32768
    assert list(np.flatnonzero(data[:, 0] > 0.5)) == list(np.flatnonzero(want[:, 0] > 0.5))


@needs_ffmpeg
@needs_ffmpeg
def test_an_mp3_window_sits_where_the_analysis_decode_puts_it(tmp_path, files):
    """An MP3 starts with the encoder's delay: the window must be on the
    same timeline as the analysis's decode (core/sample/analyze.py), which
    the grid's seconds come from, to the sample."""
    import subprocess

    from core.sample.analyze import decode_mono_at

    mp3 = tmp_path / "night-ferry.mp3"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", files["flac"], "-codec:a", "libmp3lame", "-b:a", "192k",
                    str(mp3)], check=True)
    whole, sr = decode_mono_at(str(mp3), SR)
    import soundfile as sf

    data, rate = sf.read(io.BytesIO(window.decode(str(mp3), 12.0, 3.0, SR)), dtype="float32", always_2d=True)
    part = data.mean(axis=1)
    ref = whole[int(12.0 * SR) - 200:int(15.0 * SR) + 200]
    scores = [float(np.dot(part[:SR], ref[k:k + SR])) for k in range(401)]
    assert int(np.argmax(scores)) == 200  # no offset at all


@needs_ffmpeg
def test_44100_is_resampled_and_the_end_of_the_track_is_short(client):
    res = client.get("/api/library/dj/window/1?start=28&dur=5&rate=44100")
    data, sr = _read(res)
    assert sr == 44100 and abs(data.shape[0] - 2 * 44100) <= 2  # the track ends at 30 s


@pytest.mark.parametrize("query", [
    "start=0", "dur=5", "start=-1&dur=5", "start=nan&dur=5", "start=1e3&dur=5", "start=0&dur=0",
    "start=0&dur=181", "start=0&dur=inf", "start=1980&dur=5", "start=0&dur=5&rate=22050", "start=0x10&dur=5",
    "start=%EF%BC%91&dur=5", "start=1..2&dur=5", "start=00000000000000001&dur=5",
])
def test_anything_but_plain_numbers_in_range_is_refused(client, query):
    res = client.get(f"/api/library/dj/window/1?{query}")
    assert res.status_code == 400 and res.get_json()["success"] is False


def test_another_profiles_track_an_unknown_one_and_a_missing_file_are_not_found(client):
    assert client.get("/api/library/dj/window/2?start=0&dur=5").status_code == 404
    assert client.get("/api/library/dj/window/nope?start=0&dur=5").status_code == 404
    res = client.get("/api/library/dj/window/3?start=0&dur=5")
    assert res.status_code == 404 and "can't open" in res.get_json()["error"]


def test_a_hide_explicit_profile_gets_no_explicit_track(client, monkeypatch):
    monkeypatch.setattr(window, "decode", lambda *a, **k: window.wav_bytes(b"\0" * 400, 48000))
    client.state["kid"] = True
    res = client.get("/api/library/dj/window/5?start=0&dur=5")
    assert res.status_code == 403 and res.get_json()["restricted"] is True
    assert client.get("/api/library/dj/window/1?start=0&dur=5").status_code == 200
    client.state["kid"] = False
    assert client.get("/api/library/dj/window/5?start=0&dur=5").status_code == 200


def test_two_decodes_at_most_then_wait(client, monkeypatch):
    """Every slot taken: 429 with Retry-After, and the slot comes back."""
    held = []
    for _ in range(window.MAX_RUNNING):
        assert window._slots.acquire(blocking=False)
        held.append(1)
    try:
        res = client.get("/api/library/dj/window/1?start=0&dur=5")
        assert res.status_code == 429 and res.headers["Retry-After"] == "1"
    finally:
        for _ in held:
            window._slots.release()
    assert client.get("/api/library/dj/window/3?start=0&dur=5").status_code == 404  # and it's free again


def test_a_failed_decode_releases_its_slot(tmp_path, monkeypatch):
    import subprocess

    bad = tmp_path / "bad.flac"
    bad.write_bytes(b"not audio")

    def fails(*a, **k):
        return subprocess.CompletedProcess(a, 1, b"", b"Invalid data")

    monkeypatch.setattr("core.sample.analyze.ffmpeg_bin", lambda: "ffmpeg")  # installed or not
    monkeypatch.setattr(subprocess, "run", fails)
    for _ in range(window.MAX_RUNNING + 2):
        with pytest.raises(window.WindowError):
            window.decode(str(bad), 0.0, 5.0, 48000)


def test_a_slow_decode_hits_its_deadline(tmp_path, monkeypatch):
    import subprocess

    f = tmp_path / "slow.flac"
    f.write_bytes(b"x")

    def slow(*a, **k):
        assert k["timeout"] == window.TIMEOUT_S
        raise subprocess.TimeoutExpired(a, k["timeout"])

    monkeypatch.setattr("core.sample.analyze.ffmpeg_bin", lambda: "ffmpeg")  # installed or not
    monkeypatch.setattr(subprocess, "run", slow)
    with pytest.raises(window.WindowError, match="too long"):
        window.decode(str(f), 0.0, 5.0, 48000)


def test_without_ffmpeg_a_window_says_so(tmp_path, monkeypatch):
    def missing():
        raise RuntimeError("ffmpeg isn't installed, so mp3/m4a/opus files can't be decoded")

    f = tmp_path / "t.flac"
    f.write_bytes(b"x")
    monkeypatch.setattr("core.sample.analyze.ffmpeg_bin", missing)
    with pytest.raises(window.WindowError, match="isn't installed"):
        window.decode(str(f), 0.0, 5.0, 48000)
    assert window._slots.acquire(blocking=False)  # the slot came back
    window._slots.release()


def test_the_wav_header_says_its_length():
    import struct

    data = window.wav_bytes(b"\x01\x00\x02\x00" * 10 + b"\x09", 44100)
    riff, size, wave = struct.unpack("<4sI4s", data[:12])
    assert riff == b"RIFF" and wave == b"WAVE" and size == len(data) - 8
    assert struct.unpack("<I", data[40:44])[0] == 40 and len(data) == 44 + 40


@needs_ffmpeg
def test_concurrent_requests_never_exceed_the_slots(client, monkeypatch):
    running = []
    peak = []
    real = window.subprocess.run
    lock = threading.Lock()

    def counting(*a, **k):
        with lock:
            running.append(1)
            peak.append(len(running))
        try:
            return real(*a, **k)
        finally:
            with lock:
                running.pop()

    monkeypatch.setattr(window.subprocess, "run", counting)
    codes = []

    def get():
        codes.append(client.get("/api/library/dj/window/1?start=0&dur=10").status_code)

    threads = [threading.Thread(target=get) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert max(peak) <= window.MAX_RUNNING and set(codes) <= {200, 429} and 200 in codes
