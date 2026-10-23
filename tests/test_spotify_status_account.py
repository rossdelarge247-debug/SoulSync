"""/status's Spotify ``account`` (Settings → Connections' "Connected as ross ·
14 playlists", HANDOFF 85): remembered from requests the server makes anyway,
cleared when Spotify isn't authenticated, never from a profile's own client."""

from __future__ import annotations

import pytest

from core.metadata import status


@pytest.fixture(autouse=True)
def _restore_status_cache():
    saved = dict(status._spotify_status_cache)
    saved_init = status._spotify_status_initialized
    yield
    with status._status_lock:
        status._spotify_status_cache.clear()
        status._spotify_status_cache.update(saved)
    status._spotify_status_initialized = saved_init


def test_the_account_is_remembered_and_merged():
    status._spotify_status_cache["account"] = None
    status.publish_spotify_account(name="ross")
    assert status._spotify_status_cache["account"] == {"name": "ross", "playlists": None}
    status.publish_spotify_account(playlists=14)
    assert status._spotify_status_cache["account"] == {"name": "ross", "playlists": 14}
    status.publish_spotify_account(playlists="bad")
    assert status._spotify_status_cache["account"]["playlists"] is None
    out = status.publish_spotify_status(connected=True, authenticated=True)
    assert out["account"] == {"name": "ross", "playlists": None}


def test_not_authenticated_forgets_the_account():
    status.publish_spotify_account(name="ross", playlists=3)
    out = status.publish_spotify_status(connected=False, authenticated=False)
    assert out["account"] is None


def test_only_the_global_client_publishes(monkeypatch):
    from core.spotify_client import SpotifyClient

    seen = []
    monkeypatch.setattr(status, "publish_spotify_account", lambda **kw: seen.append(kw))
    client = SpotifyClient.__new__(SpotifyClient)
    client._remember_account(name="ross")
    assert seen == [{"name": "ross"}]
    client._publishes_account = False
    client._remember_account(name="guest")
    assert seen == [{"name": "ross"}]
