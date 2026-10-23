"""playback tests build their own small Flask apps around api.player and the
kids guard (api/content_guard.py). player_api.configure() and
content_guard.register() set module globals that web_server's real app shares,
so a test that calls them would leave web_server reading its throwaway db: the
real kids guard then finds no track behind an explicit path and lets it through
to a 404, and /api/player/recent reads someone else's rows. hand them back
after every test."""

from __future__ import annotations

import pytest

_SHARED_GLOBALS = {
    "api.player": ("get_database", "_resolve_track_file", "_streamed_from", "_image_url"),
    "api.content_guard": ("_get_database", "_get_stream_state"),
}


@pytest.fixture(autouse=True)
def _restore_player_wiring():
    import importlib

    saved = []
    for mod_name, names in _SHARED_GLOBALS.items():
        mod = importlib.import_module(mod_name)
        saved.extend((mod, name, getattr(mod, name)) for name in names)
    yield
    for mod, name, value in saved:
        setattr(mod, name, value)
