"""Settings → Library → DJ's "Show the Mix tab" (``library.dj_show_mix_tab``):
off by default while Ross rethinks mixing, saved with the rest of the
library settings (POST /api/settings, admins), and served where the web UI
reads it: the DJ status's ``settings.show_mix_tab`` and the page shell's
``window.SOULSYNC_MIX_TAB`` (api/dj.py ``initial_mix_tab``)."""

from __future__ import annotations

import json
import re

import pytest

from core.dj import worker


class _Config:
    def __init__(self, data):
        self.data = data

    def get(self, key, default=None):
        return self.data.get(key, default)


@pytest.fixture
def config(monkeypatch):
    import core.settings as settings

    fake = _Config({})
    monkeypatch.setattr(settings.config_manager, "get", fake.get)
    return fake


def test_the_default_config_has_it_off():
    from core.settings import ConfigManager

    defaults = ConfigManager._get_default_config(ConfigManager.__new__(ConfigManager))
    assert defaults["library"]["dj_show_mix_tab"] is False


@pytest.mark.parametrize("stored, shown", [
    (None, False), (False, False), (True, True), (0, False),
    # strict: a hand-edited config's strings, and nothing truthy but True
    ("false", False), ("0", False), ("no", False), ("", False), (1, False), ([1], False),
    ("true", True), ("1", True), (" TRUE ", True),
])
def test_the_setting_reads_off_unless_turned_on(config, stored, shown):
    if stored is not None:
        config.data["library.dj_show_mix_tab"] = stored
    assert worker.show_mix_tab() is shown
    assert worker.settings_state()["show_mix_tab"] is shown


def test_an_unreadable_config_keeps_it_hidden(monkeypatch):
    import core.settings as settings

    def broken(*_a, **_k):
        raise RuntimeError("no config")

    monkeypatch.setattr(settings.config_manager, "get", broken)
    assert worker.show_mix_tab() is False


def test_the_page_shell_context_carries_it(config, monkeypatch):
    import api.dj as dj_api

    assert dj_api._inject_initial_mix_tab() == {"initial_mix_tab": False}
    config.data["library.dj_show_mix_tab"] = True
    assert dj_api._inject_initial_mix_tab() == {"initial_mix_tab": True}

    def broken():
        raise RuntimeError("boom")

    monkeypatch.setattr(worker, "show_mix_tab", broken)
    assert dj_api._inject_initial_mix_tab() == {"initial_mix_tab": False}


def test_the_dj_status_serves_it(config, tmp_path, monkeypatch):
    from flask import Flask, g

    import api.dj as dj_api
    import core.profile_context as pc
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "mix-tab.db"))
    dj_api.configure(get_database_=lambda: database)
    monkeypatch.setattr(pc, "is_admin_request", lambda: False)
    app = Flask(__name__)

    @app.before_request
    def _profile():
        g.profile_id = 2

    app.register_blueprint(dj_api.create_blueprint())
    client = app.test_client()
    assert client.get("/api/library/dj/status").get_json()["settings"]["show_mix_tab"] is False
    config.data["library.dj_show_mix_tab"] = True
    # every profile reads it (the player is everyone's); only admins change it
    assert client.get("/api/library/dj/status").get_json()["settings"]["show_mix_tab"] is True


web_server = pytest.importorskip("web_server")


@pytest.fixture
def admin():
    c = web_server.app.test_client()
    with c.session_transaction() as sess:
        sess["profile_id"] = 1
    return c


def _rendered(client):
    page = client.get("/").get_data(as_text=True)
    found = re.search(r"window\.SOULSYNC_MIX_TAB = (.*?);\n", page)
    assert found, "the page shell lost window.SOULSYNC_MIX_TAB"
    return json.loads(found.group(1))


def test_saved_in_settings_and_rendered_into_the_page_shell(admin):
    cm = web_server.config_manager
    before = cm.get("library.dj_show_mix_tab", None)
    try:
        res = admin.post("/api/settings", json={"library": {"dj_show_mix_tab": True}})
        assert res.status_code == 200 and res.get_json()["success"] is True
        assert cm.get("library.dj_show_mix_tab") is True
        assert _rendered(admin) is True
        assert admin.get("/api/settings").get_json()["library"]["dj_show_mix_tab"] is True
        admin.post("/api/settings", json={"library": {"dj_show_mix_tab": False}})
        assert cm.get("library.dj_show_mix_tab") is False
        assert _rendered(admin) is False
    finally:
        cm.set("library.dj_show_mix_tab", False if before is None else before)


def test_only_admins_save_it(admin):
    import os

    pid = web_server.get_database().create_profile(name=f"member_{os.urandom(3).hex()}")
    member = web_server.app.test_client()
    with member.session_transaction() as sess:
        sess["profile_id"] = pid
    before = web_server.config_manager.get("library.dj_show_mix_tab", False)
    assert member.post("/api/settings", json={"library": {"dj_show_mix_tab": True}}).status_code == 403
    assert web_server.config_manager.get("library.dj_show_mix_tab", False) == before
