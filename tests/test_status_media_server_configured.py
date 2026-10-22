"""GET /status and the status:update frame say whether the chosen media server
is set up (``media_server.configured``), read from settings alone, so Home can
say no library is chosen instead of "Plex — Disconnected"."""

from __future__ import annotations

import time

import pytest


class _Config:
    """Just the reads the status payloads make."""

    def __init__(self, active, values=None):
        self.active = active
        self.values = dict(values or {})

    def get_active_media_server(self):
        return self.active

    def get(self, key, default=None):
        return self.values.get(key, default)


PLEX_SET_UP = {"plex": {"base_url": "http://plex:32400", "token": "t"}}


@pytest.fixture(scope="module")
def ws():
    import web_server
    return web_server


@pytest.fixture
def fresh_cache(ws, monkeypatch):
    """A cache /status trusts as current, so it contacts nothing."""
    monkeypatch.setitem(ws._status_cache, "media_server", {"connected": False, "response_time": 0, "type": "plex"})
    monkeypatch.setitem(ws._status_cache, "soulseek", {"connected": False, "response_time": 0,
                                                       "source_cache_key": "hybrid:hifi,youtube,soulseek"})
    now = time.time() + 3600
    monkeypatch.setitem(ws._status_cache_timestamps, "media_server", now)
    monkeypatch.setitem(ws._status_cache_timestamps, "soulseek", now)


@pytest.mark.parametrize("active, values, expected", [
    ("plex", {}, False),                       # the shipped default, never set up
    ("plex", PLEX_SET_UP, True),
    ("plex", {"plex": {"base_url": "http://plex:32400"}}, False),
    ("soulsync", {}, True),                    # Standalone needs nothing
    ("none", {}, False),
    ("", {}, False),
    ("nonsense", {}, False),
])
def test_configured_comes_from_settings(ws, monkeypatch, fresh_cache, active, values, expected):
    monkeypatch.setattr(ws, "config_manager", _Config(active, values))
    status = ws._media_server_status()
    assert status["configured"] is expected
    # the cached connection fields pass through untouched
    assert status["connected"] is False and status["type"] == "plex"
    assert "configured" not in ws._status_cache["media_server"]


def test_an_unreadable_setting_leaves_configured_out(ws, monkeypatch, fresh_cache):
    class Broken(_Config):
        def get_active_media_server(self):
            raise RuntimeError("locked")

    monkeypatch.setattr(ws, "config_manager", Broken("plex"))
    assert "configured" not in ws._media_server_status()


@pytest.mark.parametrize("active, values, expected", [
    ("plex", {}, False), ("plex", PLEX_SET_UP, True), ("soulsync", {}, True), ("none", {}, False)])
def test_both_status_payloads_carry_it(ws, monkeypatch, fresh_cache, active, values, expected):
    monkeypatch.setattr(ws, "config_manager", _Config(active, values))
    assert ws._build_status_payload()["media_server"]["configured"] is expected

    ws.app.config["TESTING"] = True
    body = ws.app.test_client().get("/status").get_json()
    assert body["media_server"]["configured"] is expected
    assert body["active_media_server"] == active
