"""A small library for the Stars tests (the Sets tests' tracks, plus one
whose file has gone), and a Flask app with the Stars, Sets and DJ routes."""

from __future__ import annotations

import pytest
from flask import Flask, g

from core.dj import store as dj_store
from core.dj import worker
from tests.sets.conftest import LIBRARY, Config, _sql


@pytest.fixture
def db(tmp_path):
    """The Sets tests' library (track 20 is profile 7's own), plus track 30:
    in the library, its file gone."""
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "stars.db"))
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
    _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration) "
                   "VALUES ('30', 'a100', '100', 'Gone Tide', '', 300000)")
    return database


@pytest.fixture
def client(db, monkeypatch):
    import api.dj as dj_api
    import api.sets as sets_api
    import api.stars as stars_api
    import core.settings as settings
    from core.library_scope import reset_library_scope, set_library_scope

    monkeypatch.setattr(settings, "config_manager", Config())
    stars_api.configure(get_database_=lambda: db)
    sets_api.configure(get_database_=lambda: db)
    dj_api.configure(get_database_=lambda: db)
    state = {"profile": 1, "scope": "shared"}
    for module in (stars_api, sets_api, dj_api):
        monkeypatch.setattr(module, "get_current_profile_id", lambda: state["profile"])
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

    for module in (stars_api, sets_api, dj_api):
        app.register_blueprint(module.create_blueprint())
    c = app.test_client()
    c.state = state
    return c
