"""Auto-mix stage B's one server route (api/dj.py, core/dj/window.py): a
stretch of a library track as WAV for the browser's two-deck engine. It
needs a profile, stays in the caller's library, refuses what isn't a plain
number and caps the length, the end and how many decode at once, keeps a
hide-explicit profile from an explicit track, and its samples are the same
decoder's as the analysis's, on the same timeline."""

from __future__ import annotations

import io
import os
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
        from flask import request

        if state["profile"] is not None:
            # a request can say whose it is (the concurrency test's threads)
            g.profile_id = int(request.headers.get("X-Test-Profile", state["profile"]))
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
    assert res.headers["X-Content-Type-Options"] == "nosniff"
    assert int(res.headers["Content-Length"]) == len(res.data) == 44 + 4 * SR * 4
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
    "start=.&dur=5", "start=0&dur=.", "start=0&dur=0.0000001", "start=0&dur=0.04", "start=%201&dur=5",
    "start=1%00&dur=5", "start=%D9%A1&dur=5", "start=0&dur=5&rate=44100.0", "start=0&dur=5&rate=%2048000",
])
def test_anything_but_plain_numbers_in_range_is_refused(client, query):
    res = client.get(f"/api/library/dj/window/1?{query}")
    assert res.status_code == 400 and res.get_json()["success"] is False


def test_a_window_past_the_tracks_end_is_refused_without_decoding(client, monkeypatch):
    calls = []
    monkeypatch.setattr(window, "decode", lambda *a, **k: calls.append(a) or window.wav_bytes(b"", 48000))
    # the track is 30 s long (its duration in the library)
    res = client.get("/api/library/dj/window/1?start=31.5&dur=5")
    assert res.status_code == 400 and "past the track's end" in res.get_json()["error"]
    assert calls == []
    assert client.get("/api/library/dj/window/1?start=29&dur=5").status_code == 200


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


def test_a_hide_explicit_profiles_head_is_refused_too_and_decodes_nothing(client, monkeypatch):
    """Flask answers HEAD with the GET route: the guard checks it the same."""
    calls = []
    monkeypatch.setattr(window, "decode", lambda *a, **k: calls.append(a) or bytearray(window.wav_bytes(b"", 48000)))
    client.state["kid"] = True
    res = client.head("/api/library/dj/window/5?start=0&dur=2")
    assert res.status_code == 403 and calls == []
    assert client.head("/api/library/tracks/5/peaks").status_code == 403
    client.state["kid"] = False
    assert client.head("/api/library/dj/window/5?start=0&dur=2").status_code == 200


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


def _fake_ffmpeg(monkeypatch, script: str):
    """window.command runs a small Python program in ffmpeg's place."""
    import sys

    monkeypatch.setattr("core.sample.analyze.ffmpeg_bin", lambda: "ffmpeg")  # installed or not
    monkeypatch.setattr(window, "command", lambda *a, **k: [sys.executable, "-c", script])


def test_a_failed_decode_releases_its_slot(tmp_path, monkeypatch):
    bad = tmp_path / "bad.flac"
    bad.write_bytes(b"not audio")
    _fake_ffmpeg(monkeypatch, "import sys; sys.stderr.write('Invalid data'); sys.exit(1)")
    for _ in range(window.MAX_RUNNING + 2):
        with pytest.raises(window.WindowError, match="couldn't decode"):
            window.decode(str(bad), 0.0, 5.0, 48000, owner=1)
    assert window._owners == {}


def test_a_slow_decode_hits_its_deadline(tmp_path, monkeypatch):
    f = tmp_path / "slow.flac"
    f.write_bytes(b"x")
    _fake_ffmpeg(monkeypatch, "import time; time.sleep(30)")
    monkeypatch.setattr(window, "TIMEOUT_S", 0.3)
    with pytest.raises(window.WindowError, match="too long"):
        window.decode(str(f), 0.0, 5.0, 48000, owner=1)
    assert window._owners == {}


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


def test_concurrent_requests_never_exceed_the_slots(client, monkeypatch):
    """Six at once from two profiles: never more than two decoding, never
    more than one a profile, and each profile gets its window."""
    import subprocess

    running: dict = {}
    peak = {"all": 0, "one": 0}
    lock = threading.Lock()
    real = subprocess.Popen

    class Counting(real):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            with lock:
                running[self.pid] = 1
                peak["all"] = max(peak["all"], len(running))

        def wait(self, *a, **k):
            code = super().wait(*a, **k)
            with lock:
                running.pop(self.pid, None)
            return code

    _fake_ffmpeg(monkeypatch, "import sys, time; time.sleep(0.4); sys.stdout.buffer.write(bytes(4000))")
    monkeypatch.setattr(window.subprocess, "Popen", Counting)
    owners_peak = []
    take = window._take

    def counting_take(owner):
        take(owner)
        with window._owners_lock:
            owners_peak.append(max(window._owners.values(), default=0))

    monkeypatch.setattr(window, "_take", counting_take)
    codes: dict = {1: [], 9: []}

    def get(profile):
        res = client.get("/api/library/dj/window/1?start=0&dur=1", headers={"X-Test-Profile": str(profile)})
        codes[profile].append(res.status_code)

    threads = [threading.Thread(target=get, args=(p,)) for p in (1, 1, 1, 9, 9, 9)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert peak["all"] <= window.MAX_RUNNING and max(owners_peak) <= window.MAX_PER_PROFILE
    for profile in (1, 9):
        assert set(codes[profile]) <= {200, 429} and 200 in codes[profile]
    assert window._owners == {}


def test_one_profile_waits_for_its_own_window_but_not_for_anyone_else(monkeypatch, tmp_path):
    f = tmp_path / "t.flac"
    f.write_bytes(b"x")
    window._take(1)
    try:
        with pytest.raises(window.Busy, match="of yours"):
            window.decode(str(f), 0.0, 1.0, 48000, owner=1)
        _fake_ffmpeg(monkeypatch, "import sys; sys.stdout.buffer.write(bytes(400))")
        out = window.decode(str(f), 0.0, 1.0, 48000, owner=2)
        assert len(out) == 44 + 400
    finally:
        window._give(1)
    assert window._owners == {}


def test_a_profiles_second_window_is_told_when_to_ask_again(client):
    """The per-profile 429 carries Retry-After, which the browser's loader
    honours (re-review N2)."""
    window._take(1)
    try:
        res = client.get("/api/library/dj/window/1?start=0&dur=1")
        assert res.status_code == 429 and res.headers["Retry-After"] == "1"
    finally:
        window._give(1)


def test_ffmpeg_runs_niced_and_seeks_just_before_the_window(monkeypatch, tmp_path):
    f = tmp_path / "t.flac"
    f.write_bytes(b"x")
    niced = []
    command = window.command
    monkeypatch.setattr(window.os, "setpriority", lambda which, pid, n: niced.append(n))
    _fake_ffmpeg(monkeypatch, "import sys; sys.stdout.buffer.write(bytes(40))")
    window.decode(str(f), 100.0, 1.0, 48000)
    assert niced == [window.NICE]
    args = command("ffmpeg", str(f), 100.0, 2.0, 48000)
    i = args.index("-i")
    # a quick seek to five seconds before, then five seconds decoded and dropped
    assert args[i - 2:i] == ["-ss", "95.000000"] and args[i + 2:i + 4] == ["-ss", "5.000000"]
    assert args[i + 1] == "file:" + str(f)  # a name never reads as an ffmpeg protocol
    early = command("ffmpeg", str(f), 2.5, 2.0, 48000)
    j = early.index("-i")
    # in the first five seconds no quick seek at all (N3), only the exact one
    assert "-ss" not in early[:j] and early[j + 2:j + 4] == ["-ss", "2.500000"]


@needs_ffmpeg
@pytest.mark.parametrize("name", ["concat:x.flac", "-i.flac", "http:x.flac", "subfile:,,start,0,end,0,,:x.flac"])
def test_odd_file_names_are_files(tmp_path, files, name):
    import shutil as sh

    p = tmp_path / name
    sh.copy(files["flac"], p)
    import soundfile as sf

    data, sr = sf.read(io.BytesIO(bytes(window.decode(str(p), 1.0, 1.0, SR))), dtype="float32", always_2d=True)
    assert data.shape == (SR, 2)


def _encode(tmp_path, files, codec):
    import subprocess

    ext = {"flac": "flac", "libmp3lame": "mp3", "libvorbis": "ogg", "aac": "m4a"}[codec[1]]
    path = tmp_path / f"t.{ext}"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", files["flac"], *codec, str(path)], check=True)
    return path


def _lag(path, start):
    """How far (samples) a window sits from where a decode from the file's start puts it, and the error there."""
    import soundfile as sf

    from core.sample.analyze import decode_mono_at

    whole, _ = decode_mono_at(str(path), SR)
    data, _ = sf.read(io.BytesIO(bytes(window.decode(str(path), start, 3.0, SR))), dtype="float32", always_2d=True)
    part = data.mean(axis=1)
    pad = 600
    at = int(round(start * SR))
    ref = np.concatenate([np.zeros(pad, np.float32), whole])[at:at + 3 * SR + 2 * pad]
    seg = part[SR // 2:SR // 2 + SR]
    scores = [float(np.dot(seg, ref[k + SR // 2:k + SR // 2 + SR])) for k in range(2 * pad + 1)]
    lag = int(np.argmax(scores)) - pad
    err = float(np.max(np.abs(seg - ref[pad + lag + SR // 2:pad + lag + SR // 2 + SR])))
    return lag, err


@needs_ffmpeg
@pytest.mark.parametrize("codec", [["-c:a", "flac"], ["-c:a", "libmp3lame", "-q:a", "2"],
                                   ["-c:a", "libmp3lame", "-b:a", "192k"], ["-c:a", "aac", "-b:a", "192k"]],
                         ids=["flac", "mp3_vbr", "mp3_cbr", "aac"])
@pytest.mark.parametrize("start", [0.0, 1.0, 3.0, 21.37])
def test_a_window_is_on_the_analysis_timeline_to_the_sample(tmp_path, files, codec, start):
    """The quick seek (only past the first five seconds: N3, an AAC file's
    priming frame) lands every sample where a decode from the start does."""
    lag, err = _lag(_encode(tmp_path, files, codec), start)
    assert lag == 0 and err < 2.0 / 32768


@needs_ffmpeg
def test_a_vorbis_window_is_within_a_few_hundred_samples(tmp_path, files):
    """ffmpeg trims Ogg packets so a Vorbis window can sit a few hundred
    samples off (worst near the file's end); refine.py's ±25 ms takes it."""
    path = _encode(tmp_path, files, ["-c:a", "libvorbis", "-q:a", "5"])
    for start in (0.0, 3.0, 21.37, 26.0):
        lag, _ = _lag(path, start)
        assert abs(lag) <= 400


def test_no_quick_seek_in_the_first_five_seconds():
    for start in (0.0, 1.0, 4.99, 5.0):
        args = window.command("ffmpeg", "/m/t.m4a", start, 2.0, 48000)
        assert args.index("-ss") > args.index("-i")  # only the exact one, after the input
    late = window.command("ffmpeg", "/m/t.m4a", 5.5, 2.0, 48000)
    assert late.index("-ss") < late.index("-i")


@pytest.mark.parametrize("ok", [True, False])
def test_a_flood_of_ffmpeg_errors_never_stalls_a_decode(tmp_path, monkeypatch, ok):
    """ffmpeg writing more than a pipe holds to stderr (a damaged file): its
    complaints go to a file, so the decode ends at once, not at the
    deadline, and leaves no slot, reservation or file behind (N1)."""
    import time

    f = tmp_path / "noisy.mp3"
    f.write_bytes(b"x")
    _fake_ffmpeg(monkeypatch, "import sys\n"
                              "for _ in range(1500): sys.stderr.write('[mp3] invalid frame ' * 40 + '\\n')\n"
                              "sys.stderr.flush()\n"
                              "sys.stdout.buffer.write(bytes(4000))\n"
                              f"sys.exit({0 if ok else 1})\n")
    fds = len(os.listdir("/proc/self/fd")) if os.path.isdir("/proc/self/fd") else None
    started = time.monotonic()
    if ok:
        assert len(window.decode(str(f), 0.0, 1.0, 48000, owner=3)) == 44 + 4000
    else:
        with pytest.raises(window.WindowError, match="couldn't decode"):
            window.decode(str(f), 0.0, 1.0, 48000, owner=3)
    assert time.monotonic() - started < 10 < window.TIMEOUT_S
    assert window._owners == {} and window._slots._value == window.MAX_RUNNING
    if fds is not None:
        assert len(os.listdir("/proc/self/fd")) == fds


def test_ffmpeg_that_cant_start_gives_its_slot_back(tmp_path, monkeypatch):
    f = tmp_path / "t.flac"
    f.write_bytes(b"x")
    monkeypatch.setattr("core.sample.analyze.ffmpeg_bin", lambda: "ffmpeg")
    monkeypatch.setattr(window, "command", lambda *a, **k: [str(tmp_path / "no-such-ffmpeg")])
    with pytest.raises(window.WindowError, match="couldn't start"):
        window.decode(str(f), 0.0, 1.0, 48000, owner=4)
    assert window._owners == {} and window._slots._value == window.MAX_RUNNING


@pytest.mark.parametrize("ok", [True, False])
def test_no_writable_temp_directory_still_decodes(client, tmp_path, monkeypatch, ok):
    """Where no temporary file can be made (a read-only or full temp
    directory), ffmpeg's complaints are dropped (stderr to DEVNULL) and the
    window is still decoded: never a 500 (stage B review). A failing decode
    still says so, with nothing left behind."""
    f = tmp_path / "quiet.flac"
    f.write_bytes(b"x")

    def no_temp(*a, **k):
        raise OSError(30, "Read-only file system")

    monkeypatch.setattr(window.tempfile, "TemporaryFile", no_temp)
    _fake_ffmpeg(monkeypatch, "import sys\n"
                              "sys.stderr.write('[flac] a complaint nobody keeps\\n' * 5000)\n"
                              "sys.stdout.buffer.write(bytes(4000))\n"
                              f"sys.exit({0 if ok else 1})\n")
    if ok:
        assert len(window.decode(str(f), 0.0, 1.0, 48000, owner=5)) == 44 + 4000
        # and through the route: a WAV, not a 500
        res = client.get("/api/library/dj/window/1?start=0&dur=1")
        assert res.status_code == 200 and res.mimetype == "audio/wav"
    else:
        with pytest.raises(window.WindowError, match="couldn't decode"):
            window.decode(str(f), 0.0, 1.0, 48000, owner=5)
    assert window._owners == {} and window._slots._value == window.MAX_RUNNING
