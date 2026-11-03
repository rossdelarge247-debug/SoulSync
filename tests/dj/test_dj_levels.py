"""DJ mode's fine waveform (Brief F step 4b, 37s): ``GET
/api/library/dj/levels/<id>`` (core/dj/levels.py), a track's level every
10 ms worked out once in the background and kept until its file changes;
only for a track in the caller's library. The table's migration is in
tests/database/test_dj_levels_migration.py."""

from __future__ import annotations

import base64
import math
import struct
import wave

import pytest
from flask import Flask, g

from core.dj import levels


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _wav(path, seconds=2.0, rate=8000):
    """A quiet tone with a loud click every half second (a kick on every beat at 120)."""
    frames = []
    for i in range(int(seconds * rate)):
        t = i / rate
        v = 0.1 * math.sin(2 * math.pi * 220 * t)
        if (i % (rate // 2)) < 40:
            v = 0.9
        frames.append(struct.pack("<h", int(v * 32767)))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(frames))


class _Now:
    """A queue that runs the decode at once (the real one is a background thread)."""

    def __init__(self):
        self.keys = []

    def submit(self, key, work):
        self.keys.append(key)
        work()
        return True


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "levels.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Marram')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'Shore')")
    audio = tmp_path / "beat.wav"
    _wav(audio)
    for tid, title, path, owner in (("1", "Harbour Lights", str(audio), None), ("2", "Gone", "/nope/2.flac", None),
                                    ("3", "Someone else's", str(audio), 7), ("4", "Not audio", str(tmp_path / "x.txt"), None)):
        _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration, owner_profile_id) "
                       "VALUES (?, '10', '1', ?, ?, 2000, ?)", (tid, title, path, owner))
    (tmp_path / "x.txt").write_text("not audio")
    return database


@pytest.fixture
def client(db, monkeypatch):
    import api.dj as dj_api
    from core.library_scope import reset_library_scope, set_library_scope
    from core.playback import peaks

    queue = _Now()
    monkeypatch.setattr(peaks, "_jobs", queue)
    dj_api.configure(get_database_=lambda: db)
    state = {"profile": 1}
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
    c.state, c.queue = state, queue
    return c


URL = "/api/library/dj/levels/"


def test_levels_are_each_steps_loudest_scaled_to_255():
    import numpy as np

    mono = np.zeros(800, dtype=np.float32)
    mono[0] = 0.5
    mono[400] = -1.0
    out = levels.levels_from(mono, 8000, 0.01)
    assert len(out) == 10
    assert out[0] == 128 and out[5] == 255 and out[1] == 0
    assert levels.levels_from(np.zeros(160, dtype=np.float32), 8000, 0.01) == bytes(2)
    assert levels.levels_from(np.zeros(0, dtype=np.float32), 8000, 0.01) == b""


def test_the_step_is_10ms_and_coarser_only_past_max_levels():
    assert levels.step_for(300) == 0.01
    assert levels.step_for(None) == 0.01
    assert levels.step_for(levels.MAX_LEVELS * 0.02) == pytest.approx(0.02)


def test_pending_then_ready_with_the_beats_as_spikes(client):
    res = client.get(URL + "1")
    # the decode runs at once here; the first answer is still "pending"
    assert res.status_code == 202 and res.get_json()["state"] == "pending"
    assert res.headers["Cache-Control"] == "no-store"
    body = client.get(URL + "1").get_json()
    assert body["state"] == "ready" and body["step"] == pytest.approx(0.01)
    raw = base64.b64decode(body["levels"])
    assert abs(len(raw) - 200) <= 1
    # a click every half second is loud, the tone between is quiet
    for beat in (0, 50, 100, 150):
        assert raw[beat] > 200
    assert max(raw[20:40]) < 60
    # asked again: the cache, no new decode
    client.get(URL + "1")
    assert len(client.queue.keys) == 1


def test_a_changed_file_is_worked_out_again(client, db, tmp_path):
    client.get(URL + "1")
    _wav(tmp_path / "beat.wav", seconds=3.0)
    import os

    st = os.stat(tmp_path / "beat.wav")
    os.utime(tmp_path / "beat.wav", ns=(st.st_atime_ns, st.st_mtime_ns + 10_000_000))
    assert client.get(URL + "1").status_code == 202
    body = client.get(URL + "1").get_json()
    assert abs(len(base64.b64decode(body["levels"])) - 300) <= 1


def test_a_failed_decode_is_tried_again_after_an_hour(db, client, monkeypatch, tmp_path):
    import time

    from core.playback import peaks

    sig = peaks.file_signature(str(tmp_path / "beat.wav"))
    levels.write_cached(db, "1", sig, None, error="decoder hiccup")
    assert client.get(URL + "1").get_json() == {"success": True, "state": "failed", "reason": "unreadable"}
    assert client.queue.keys == []
    # an hour on: worked out again
    later = time.time() + levels.RETRY_FAILED_S + 1
    assert levels.read_cached(db, "1", sig, now=later) is None
    monkeypatch.setattr(levels.time, "time", lambda: later)
    assert client.get(URL + "1").status_code == 202
    assert client.get(URL + "1").get_json()["state"] == "ready"


def test_files_that_cant_be_drawn_say_why(client):
    assert client.get(URL + "2").get_json() == {"success": True, "state": "failed", "reason": "not_on_disk"}
    assert client.get(URL + "4").get_json()["reason"] == "not_audio"


def test_a_profile_is_needed(client, monkeypatch):
    import api.dj as dj_api

    monkeypatch.setattr(dj_api, "get_current_profile_id", lambda: None)
    assert client.get(URL + "1").status_code == 401


@pytest.mark.gauntlet
def test_gauntlet_only_a_track_in_the_callers_library(client):
    res = client.get(URL + "3")
    assert res.status_code == 404
    assert client.queue.keys == []
    assert client.get(URL + "nope").status_code == 404
    assert client.get(URL + "1' OR '1'='1").status_code == 404
    client.state["profile"] = 2
    assert client.get(URL + "3").status_code == 404


@pytest.mark.gauntlet
def test_gauntlet_a_kids_profile_cant_read_an_explicit_tracks_levels():
    from api import content_guard

    assert content_guard._DJ_WINDOW.match("/api/library/dj/levels/9").group(1) == "9"
    assert content_guard._DJ_WINDOW.match("/api/library/dj/window/9").group(1) == "9"
    assert content_guard._DJ_WINDOW.match("/api/library/dj/levels/9/x") is None
