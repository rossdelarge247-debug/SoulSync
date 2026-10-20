"""/api/debug-info carries MusicDatabase.schema_health(): the schema steps that
failed at startup (rolled back, retried next start), so a support dump shows a
half-migrated database instead of it hiding in the logs."""

from __future__ import annotations

from pathlib import Path

import pytest
from flask import Flask

import core.debug_info as debug_info


class _StubDatabase:
    def __init__(self, health):
        self._health = health

    def schema_health(self):
        if isinstance(self._health, Exception):
            raise self._health
        return self._health


@pytest.mark.parametrize("health, expected", [
    ({"ok": True, "failed_steps": []}, {"ok": True, "failed_steps": []}),
    ({"ok": False, "failed_steps": [{"step": "add_profile_support / rebuild watchlist_artists",
                                     "error": "IntegrityError: UNIQUE constraint failed"}]},
     {"ok": False, "failed_steps": [{"step": "add_profile_support / rebuild watchlist_artists",
                                     "error": "IntegrityError: UNIQUE constraint failed"}]}),
    (RuntimeError("database unavailable"), {"ok": None, "failed_steps": []}),
])
def test_debug_info_reports_schema_health(tmp_path: Path, monkeypatch, health, expected) -> None:
    app = Flask(__name__)
    for name, value in {
        "SOULSYNC_VERSION": "test", "_DIRECT_RUN": True, "_status_cache": {},
        "download_batches": {}, "sync_states": {}, "youtube_playlist_states": {},
        "tidal_discovery_states": {}, "download_orchestrator": None,
        "_log_path": str(tmp_path / "app.log"), "_log_dir": tmp_path, "app": app,
        "get_database": lambda: _StubDatabase(health),
    }.items():
        monkeypatch.setattr(debug_info, name, value)

    with app.test_request_context("/api/debug-info"):
        info = debug_info.get_debug_info().get_json()

    assert info["schema"] == expected
