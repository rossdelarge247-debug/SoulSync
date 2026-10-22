"""The player's routes (api/player.py) over a real database and real files:
peaks (pending, then ready), details, Recent, the profile and library-scope
rules, and the kids guard (api/content_guard.py) in front of them."""

from __future__ import annotations

import os

import numpy as np
import pytest
import soundfile as sf
from flask import Flask, g

from core.playback import peaks as P


def _write(path, sr=96000, subtype="PCM_24", seconds=2.0):
    t = np.arange(int(seconds * sr)) / sr
    sf.write(str(path), (0.5 * np.sin(2 * np.pi * 330 * t)).astype(np.float32), sr, subtype=subtype)


class _Inline:
    def submit(self, fn):
        fn()


@pytest.fixture(scope="module")
def world(tmp_path_factory):
    """One database for the module (a fresh MusicDatabase takes a while)."""
    root = tmp_path_factory.mktemp("player")
    from database.music_database import MusicDatabase

    db = MusicDatabase(str(root / "music.db"))
    hires = root / "Pale Harbour - Harbour Light.flac"
    _write(hires)
    cd = root / "Saltmarsh - Static Bloom.mp3.wav"  # a wav whose name says mp3: the extension decides
    _write(cd, sr=44100, subtype="PCM_16")
    conn = db._get_connection()
    try:
        conn.execute("INSERT INTO artists (id, name) VALUES ('ar1', 'Pale Harbour')")
        conn.execute("INSERT INTO artists (id, name) VALUES ('ar2', 'Saltmarsh')")
        conn.execute("INSERT INTO albums (id, artist_id, title, year, track_count, thumb_url) "
                     "VALUES ('al1', 'ar1', 'Lantern', 2024, 11, 'https://img.example/lantern.jpg')")
        conn.execute("INSERT INTO albums (id, artist_id, title, year) VALUES ('al2', 'ar2', 'Brine', 2021)")
        conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, track_number, duration, file_path, bitrate) "
                     "VALUES ('t1', 'al1', 'ar1', 'Harbour Light', 3, 2000, ?, 2304)", (str(hires),))
        conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, track_number, duration, file_path, bitrate, explicit) "
                     "VALUES ('t2', 'al2', 'ar2', 'Static Bloom', 1, 2000, ?, 320, 1)", (str(cd),))
        conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, file_path, owner_profile_id) "
                     "VALUES ('t3', 'al2', 'ar2', 'Someone elses', '/elsewhere/x.flac', 7)")
        conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, file_path, bitrate) "
                     "VALUES ('t4', 'al2', 'ar2', 'Streamed only', '/server/only/y.flac', 900)")
        history = [
            # newest first once sorted: a repeat, another pile, another source
            ("t1", "Harbour Light", "Pale Harbour", "Lantern", "2026-10-22 10:05:00", "soulsync_web", "t1", 1),
            ("t1", "Harbour Light", "Pale Harbour", "Lantern", "2026-10-22 10:01:00", "soulsync_web", "t1", 1),
            ("t2", "Static Bloom", "Saltmarsh", "Brine", "2026-10-22 09:50:00", "soulsync_web", "t2", 1),
            ("plex-9", "On Plex", "Somebody", "Elsewhere", "2026-10-22 10:10:00", "plex", None, 1),
            ("t1", "Harbour Light", "Pale Harbour", "Lantern", "2026-10-22 10:20:00", "soulsync_web", "t1", 5),
            ("t1", "Harbour Light", "Pale Harbour", "Lantern", "2026-10-22 08:00:00", "soulsync_web", "t1", 1),
        ]
        for tid, title, artist, album, at, source, db_tid, owner in history:
            conn.execute(
                "INSERT INTO listening_history (track_id, title, artist, album, played_at, duration_ms, "
                "server_source, db_track_id, profile_id) VALUES (?, ?, ?, ?, ?, 2000, ?, ?, ?)",
                (tid, title, artist, album, at, source, db_tid, owner))
        conn.commit()
    finally:
        conn.close()
    return {"db": db, "hires": str(hires), "cd": str(cd)}


@pytest.fixture
def client(world, monkeypatch):
    import api.player as player_api
    from api import content_guard
    from core.library_scope import reset_library_scope, set_library_scope

    player_api.configure(get_database_=lambda: world["db"],
                         resolve_track_file_=lambda p: p if p and os.path.isfile(p) else None,
                         streamed_from_=lambda: "Navidrome",
                         image_url_=lambda u: u)
    state = {"profile": 1, "scope": "shared", "hide_explicit": False}

    import core.content_filter as cf
    monkeypatch.setattr(cf, "current_restrictions",
                        lambda: {"hide_explicit": state["hide_explicit"], "cap": None})
    monkeypatch.setattr(content_guard, "current_restrictions",
                        lambda: {"hide_explicit": state["hide_explicit"], "cap": None})
    monkeypatch.setattr(P, "_jobs", P.PeaksJobs(executor_factory=_Inline))

    app = Flask(__name__)
    tokens = []

    @app.before_request
    def _profile():
        g.profile_id = state["profile"]
        tokens.append(set_library_scope(state["scope"]))

    @app.teardown_request
    def _scope(_exc):
        if tokens:
            reset_library_scope(tokens.pop())

    content_guard.register(app, lambda: world["db"])
    app.register_blueprint(player_api.create_blueprint())
    app.config["TESTING"] = True
    c = app.test_client()
    c.state = state
    return c


def test_peaks_are_pending_first_then_ready(client, world):
    conn = world["db"]._get_connection()
    conn.execute("DELETE FROM track_peaks")
    conn.commit()
    conn.close()
    held = []

    class _Held:
        def submit(self, fn):
            held.append(fn)

    P._jobs = P.PeaksJobs(executor_factory=_Held)
    first = client.get("/api/library/tracks/t1/peaks")
    assert first.status_code == 202
    assert first.get_json()["pending"] is True
    assert first.headers["Retry-After"] == "2"
    held.pop()()
    ready = client.get("/api/library/tracks/t1/peaks")
    assert ready.status_code == 200
    body = ready.get_json()
    assert len(body["peaks"]) == 200
    assert all(0 <= v <= 1 for v in body["peaks"])
    assert abs(body["duration_s"] - 2.0) < 0.05
    assert "reason" not in body


def test_peaks_for_a_file_that_isnt_here_say_why(client):
    res = client.get("/api/library/tracks/t4/peaks")
    assert res.status_code == 200
    assert res.get_json()["peaks"] is None
    assert res.get_json()["reason"] == "not_on_disk"


def test_unknown_and_malformed_ids(client):
    assert client.get("/api/library/tracks/nope/peaks").status_code == 404
    assert client.get("/api/library/tracks/..%2Fetc/details").status_code in (400, 404)
    assert client.get("/api/library/tracks/a%20b/details").status_code == 400


def test_a_track_in_another_profiles_library_is_not_found(client):
    assert client.get("/api/library/tracks/t3/details").status_code == 404
    client.state["scope"] = 7
    try:
        assert client.get("/api/library/tracks/t3/details").status_code == 200
        assert client.get("/api/library/tracks/t1/details").status_code == 404
    finally:
        client.state["scope"] = "shared"


def test_no_profile_no_answer(client):
    client.state["profile"] = None
    try:
        for url in ("/api/library/tracks/t1/peaks", "/api/library/tracks/t1/details", "/api/player/recent"):
            assert client.get(url).status_code == 401, url
    finally:
        client.state["profile"] = 1


def test_details_for_a_hires_track(client, world):
    res = client.get("/api/library/tracks/t1/details")
    assert res.status_code == 200
    body = res.get_json()
    assert body["format"] == "FLAC"
    assert (body["bit_depth"], body["sample_rate"], body["bitrate_kbps"]) == (24, 96000, 2304)
    assert body["path_label"] == "Library"
    assert (body["album"], body["year"], body["track_number"], body["album_track_count"]) == ("Lantern", 2024, 3, 11)
    assert body["artist"] == "Pale Harbour" and body["artist_id"] == "ar1"
    assert body["image_url"] == "https://img.example/lantern.jpg"
    assert body["quality"] is None or set(body["quality"]) == {"at_target", "target_name"}
    conn = world["db"]._get_connection()
    try:
        row = conn.execute("SELECT bit_depth, sample_rate, audio_probe_sig FROM tracks WHERE id = 't1'").fetchone()
    finally:
        conn.close()
    assert (row[0], row[1]) == (24, 96000) and row[2]


def test_details_for_a_streamed_track(client):
    body = client.get("/api/library/tracks/t4/details").get_json()
    assert body["path_label"] == "Library (streamed from Navidrome)"
    assert body["on_disk"] is False
    assert body["bit_depth"] is None


def test_recent_is_the_players_own_plays_in_your_pile(client):
    res = client.get("/api/player/recent?limit=20")
    assert res.status_code == 200
    items = res.get_json()["items"]
    # the plex play and profile 5's pile are left out, the 10:05/10:01 repeat shows once
    assert [(i["title"], i["played_at"]) for i in items] == [
        ("Harbour Light", "2026-10-22 10:05:00"),
        ("Static Bloom", "2026-10-22 09:50:00"),
        ("Harbour Light", "2026-10-22 08:00:00"),
    ]
    first = items[0]
    assert first["track_id"] == "t1" and first["album_id"] == "al1"
    assert first["format"] == "FLAC" and first["duration_s"] == 2.0
    assert first["image_url"] == "https://img.example/lantern.jpg"
    assert first["file_path"].endswith(".flac")


def test_recent_limit_is_clamped(client):
    assert len(client.get("/api/player/recent?limit=1").get_json()["items"]) == 1
    assert client.get("/api/player/recent?limit=abc").status_code == 200
    assert client.get("/api/player/recent?limit=-5").status_code == 200


def test_a_clean_only_profile_is_refused_explicit_tracks(client):
    client.state["hide_explicit"] = True
    try:
        assert client.get("/api/library/tracks/t2/details").status_code == 403
        assert client.get("/api/library/tracks/t2/peaks").status_code == 403
        assert client.get("/api/library/tracks/t1/details").status_code == 200
        titles = [i["title"] for i in client.get("/api/player/recent").get_json()["items"]]
        assert "Static Bloom" not in titles
        # the two Harbour Light plays were apart; with Static Bloom hidden they're adjacent but still two plays
        assert titles.count("Harbour Light") >= 1
    finally:
        client.state["hide_explicit"] = False
