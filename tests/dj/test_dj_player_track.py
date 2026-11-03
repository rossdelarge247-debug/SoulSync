"""DJ mode's Hand over (Brief F step 4, 414): ``GET /api/library/dj/track/<id>``
(core/dj/store.py ``player_track``), one library track as the player's queue
takes it, so B can become the player's track. Only in the caller's library
scope."""

from __future__ import annotations

import pytest
from flask import Flask, g

from core.dj import store


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "handover.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Marram')")
    _sql(database, "INSERT INTO albums (id, artist_id, title, thumb_url) VALUES ('10', '1', 'Shore', '/art/10.jpg')")
    for tid, title, path, owner in (("1", "Harbour Lights", "/app/Transfer/1.flac", None),
                                    ("2", "No file", None, None),
                                    ("3", "Someone else's", "/app/Transfer/3.flac", 7)):
        _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration, bitrate, "
                       "owner_profile_id) VALUES (?, '10', '1', ?, ?, 288000, 1411, ?)", (tid, title, path, owner))
    return database


@pytest.fixture
def client(db):
    import api.dj as dj_api
    from core.library_scope import reset_library_scope, set_library_scope

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
    c.state = state
    return c


URL = "/api/library/dj/track/"


def test_a_track_as_the_player_queues_it(client):
    res = client.get(URL + "1")
    assert res.status_code == 200
    assert res.headers["Cache-Control"] == "no-store"
    track = res.get_json()["track"]
    assert {k: track[k] for k in ("id", "title", "artist_name", "album_title", "file_path", "duration_ms",
                                  "bitrate", "artist_id", "album_id", "file_missing")} == {
        "id": "1", "title": "Harbour Lights", "artist_name": "Marram", "album_title": "Shore",
        "file_path": "/app/Transfer/1.flac", "duration_ms": 288000, "bitrate": 1411, "artist_id": "1",
        "album_id": "10", "file_missing": False}


def test_a_track_without_its_file_says_so(client):
    assert client.get(URL + "2").get_json()["track"]["file_missing"] is True


def test_a_profile_is_needed(client, monkeypatch):
    import api.dj as dj_api

    monkeypatch.setattr(dj_api, "get_current_profile_id", lambda: None)
    assert client.get(URL + "1").status_code == 401


def test_a_long_id_is_cut_and_unknown(client):
    assert client.get(URL + "x" * 400).status_code == 404
    assert store.player_track(None, "") is None


@pytest.mark.gauntlet
def test_gauntlet_only_a_track_in_the_callers_library(client, db):
    # another profile's own track and an unknown one: not found, nothing about them
    res = client.get(URL + "3")
    assert res.status_code == 404
    assert "Transfer" not in res.get_data(as_text=True)
    assert client.get(URL + "nope").status_code == 404
    # nor for another profile; the shared track is everyone's
    client.state["profile"] = 2
    assert client.get(URL + "3").status_code == 404
    assert client.get(URL + "1").get_json()["track"]["id"] == "1"
    # an injection-shaped id is just an id
    assert client.get(URL + "1' OR '1'='1").status_code == 404
