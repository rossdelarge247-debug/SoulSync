"""Shared pieces for Internet radio's tests: one real music database per module
(radio's tables emptied before each test), a ConfigManager without its
database, a hub with every outside piece faked, and a Flask app with the radio
blueprint. Nothing here touches the network: feeds, the directory and streams
are fakes."""

from __future__ import annotations

from typing import Any, Dict, List

import pytest
from flask import Flask

import api.radio as radio_api
from core.internet_radio import net
from core.internet_radio.hub import hub
from core.settings import ConfigManager

RADIO_TABLES = ("radio_favourites", "radio_links", "radio_heard", "radio_auto_add", "radio_auto_added",
                "radio_activity", "radio_shows")


@pytest.fixture(scope="module")
def module_db(tmp_path_factory):
    from database.music_database import MusicDatabase
    return MusicDatabase(database_path=str(tmp_path_factory.mktemp("radio") / "radio.db"))


@pytest.fixture
def db(module_db):
    with module_db._get_connection() as conn:
        for t in RADIO_TABLES:
            conn.execute(f"DELETE FROM {t}")
        conn.commit()
    return module_db


@pytest.fixture
def config():
    cm = ConfigManager.__new__(ConfigManager)
    cm.config_data = {}
    cm._save_config = lambda: None
    return cm


class Library:
    """The library check and Wanted, faked: sets of (profile, artist, title)."""

    def __init__(self):
        self.owned: set = set()
        self.wanted: set = set()
        self.added: List[Dict[str, Any]] = []
        self.fail_add = False

    @staticmethod
    def _k(pid, artist, title):
        return (int(pid), (artist or "").lower(), (title or "").lower())

    def presence(self, pid, tracks):
        out = []
        for t in tracks:
            k = self._k(pid, t.get("artist"), t.get("name"))
            out.append({"in_library": k in self.owned, "in_wishlist": k in self.wanted,
                        "track_id": "t1" if k in self.owned else None,
                        "file_path": "/m/a.flac" if k in self.owned else None, "bitrate": 1000})
        return out

    def add(self, pid, heard):
        if self.fail_add:
            return {"ok": False, "skipped": False, "message": "nope"}
        self.added.append({"profile_id": pid, **heard})
        self.wanted.add(self._k(pid, heard.get("artist"), heard.get("title")))
        return {"ok": True, "skipped": False, "message": "added"}


@pytest.fixture
def library():
    return Library()


@pytest.fixture
def who():
    return {"pid": 1, "admin": True, "denied": None}


@pytest.fixture
def events():
    return []


class FakeWatcher:
    """Stands in for the watcher thread in route tests; counts the wake-ups."""

    def __init__(self):
        self.ensured = 0
        self.enabled = True

    def ensure(self):
        self.ensured += 1
        return False

    def enable(self):
        self.enabled = True

    def start(self):
        self.enabled = True

    def stop(self):
        self.enabled = False


@pytest.fixture
def fake_watcher(monkeypatch):
    w = FakeWatcher()
    monkeypatch.setattr(radio_api, "watcher", w)
    return w


@pytest.fixture
def app(db, config, library, who, events, monkeypatch, fake_watcher):
    monkeypatch.setattr(radio_api, "get_current_profile_id", lambda: who["pid"])
    monkeypatch.setattr(radio_api, "is_admin_request", lambda: who["admin"])
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: who["admin"])
    radio_api.configure(get_database_=lambda: db, config_manager_=config,
                        library_presence_=library.presence, add_to_wanted_=library.add,
                        download_denied_=lambda pid: who["denied"],
                        emit_event_=lambda t, d: events.append((t, d)),
                        fingerprint_=None, radio_automation_profiles_=lambda: [],
                        actor_name_=lambda: "ross")
    hub.reset()
    hub.run_inline(True)
    net.set_fetcher(lambda url, params, headers, timeout: (_ for _ in ()).throw(net.FetchError("offline")))
    flask_app = Flask(__name__)
    flask_app.register_blueprint(radio_api.create_blueprint())
    yield flask_app
    hub.reset()
    hub.run_inline(False)
    net.set_fetcher(None)


@pytest.fixture
def client(app):
    return app.test_client()
