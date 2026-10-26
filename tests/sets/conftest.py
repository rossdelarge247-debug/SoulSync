"""A small library for the Sets tests: tracks with BPM, key and energy, one
another profile owns, and a Flask app with the Sets routes."""

from __future__ import annotations

import pytest
from flask import Flask, g

from core.dj import store as dj_store
from core.dj import worker


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


# (id, artist, title, bpm, key, energy, owner)
LIBRARY = [
    ("1", "Saltmarsh", "Lowtide Hymn", 118.0, "6A", 3, None),
    ("2", "Pale Harbour", "Foghorn Study", 119.0, "7A", 3, None),
    ("3", "Tidewater", "Undertow", 120.0, "7A", 4, None),
    ("4", "Ines Varga", "Copper Sky", 122.0, "8A", 5, None),
    ("5", "Mareld", "Signal Fire (Original Mix)", 121.0, "8A", 4, None),
    ("6", "Pale Harbour", "Kelp Garden", 120.0, "7A", 4, None),
    ("7", "Saltmarsh", "Slow Tide", 119.0, "6A", 3, None),
    ("8", "Okan Dere", "Sand Script", 123.0, "8A", 6, None),
    ("9", "Tidewater", "Night Ferry", 124.0, "8A", 6, None),
    ("20", "Someone", "Not Yours", 120.0, "7A", 5, 7),
]


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "sets.db"))
    artists = {}
    for tid, artist, title, bpm, key, energy, owner in LIBRARY:
        aid = artists.setdefault(artist, str(100 + len(artists)))
        _sql(database, "INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)", (aid, artist))
        _sql(database, "INSERT OR IGNORE INTO albums (id, artist_id, title) VALUES (?, ?, ?)",
             (f"a{aid}", aid, f"{artist} EP"))
        _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration, owner_profile_id) "
                       "VALUES (?, ?, ?, ?, ?, 360000, ?)", (tid, f"a{aid}", aid, title, f"/m/{tid}.flac", owner))
        dj_store.save(database, tid, {"bpm": bpm, "bpm_source": "tag", "musical_key": key, "key_source": "tag",
                                      "energy": energy, "status": "done",
                                      "dj_analyzer_version": worker.analyzer_version()})
    _sql(database, "UPDATE tracks SET musicbrainz_recording_id = 'mb-copper' WHERE id = '4'")
    return database


class Config:
    def __init__(self):
        self.data = {}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value

    def get_active_media_server(self):
        return None


@pytest.fixture
def cfg(monkeypatch):
    import core.settings as settings

    config = Config()
    monkeypatch.setattr(settings, "config_manager", config)
    return config


@pytest.fixture
def client(db, cfg, monkeypatch):
    import api.sets as sets_api
    from core.library_scope import reset_library_scope, set_library_scope
    from core.sets import sources

    sources.clear_cache()
    sources.reset_limits()
    sets_api.configure(get_database_=lambda: db)
    state = {"profile": 1, "scope": "shared"}
    monkeypatch.setattr(sets_api, "get_current_profile_id", lambda: state["profile"])
    app = Flask(__name__)
    tokens = []

    @app.before_request
    def _profile():
        if state["profile"] is not None:
            g.profile_id = state["profile"]
        tokens.append(set_library_scope(state["scope"]))

    @app.teardown_request
    def _reset(_exc):
        if tokens:
            reset_library_scope(tokens.pop())

    app.register_blueprint(sets_api.create_blueprint())
    c = app.test_client()
    c.state = state
    return c


def put_set(client, set_id, body):
    """PUT a set's change the way the page does: from the revision it read
    (``base_revision`` is required)."""
    got = client.get(f"/api/sets/{set_id}")
    base = got.get_json()["set"]["revision"] if got.status_code == 200 else 0
    return client.put(f"/api/sets/{set_id}", json={**body, "base_revision": base})
