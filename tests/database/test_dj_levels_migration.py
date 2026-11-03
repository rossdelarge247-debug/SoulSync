"""DJ mode's fine waveform cache (``_add_track_dj_levels_table``, Brief F
step 4b) on fresh installs and upgrades: its columns and key, an old release
upgrades, a short table from an earlier build gets its columns and keeps its
rows, and a step that can't finish fails loudly (an ERROR naming it,
``schema_health``) and runs again on the next start."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import pytest

from database.music_database import MusicDatabase

pytestmark = pytest.mark.gauntlet

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "old_databases"
COLUMNS = [name for name, _ in MusicDatabase._TRACK_DJ_LEVELS_COLUMNS]


def _q(path, sql, params=()):
    conn = sqlite3.connect(str(path))
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def _columns(path):
    return [r[1] for r in _q(path, "PRAGMA table_info(track_dj_levels)")]


def test_fresh_install_has_the_table(tmp_path):
    path = tmp_path / "fresh.db"
    db = MusicDatabase(str(path))
    assert db.schema_health()["ok"]
    assert _columns(path) == COLUMNS == ["track_id", "file_sig", "version", "step", "duration_s", "levels",
                                         "error", "computed_at"]
    assert [r[1] for r in _q(path, "PRAGMA table_info(track_dj_levels)") if r[5]] == ["track_id"]
    assert _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'track_dj_levels_v1'")


def _oldest_release():
    releases = sorted(p for p in FIXTURES.iterdir() if (p / "music.sql").exists()) if FIXTURES.exists() else []
    return releases[0] if releases else None


@pytest.mark.skipif(_oldest_release() is None, reason="no old database fixtures")
def test_an_old_release_upgrades(tmp_path):
    path = tmp_path / "old.db"
    conn = sqlite3.connect(str(path))
    conn.executescript((_oldest_release() / "music.sql").read_text(encoding="utf-8"))
    conn.close()
    db = MusicDatabase(str(path))
    assert db.schema_health()["ok"], db.schema_health()
    assert _columns(path) == COLUMNS


def test_a_short_table_gets_its_missing_columns_and_keeps_its_rows(tmp_path):
    path = tmp_path / "short.db"
    db = MusicDatabase(str(path))
    conn = sqlite3.connect(str(path))
    conn.execute("DROP TABLE track_dj_levels")
    conn.execute("CREATE TABLE track_dj_levels (track_id TEXT NOT NULL, file_sig TEXT NOT NULL, "
                 "version INTEGER NOT NULL, PRIMARY KEY (track_id))")
    conn.execute("INSERT INTO track_dj_levels VALUES ('7', '1:2', 1)")
    conn.commit()
    conn.close()
    db._initialize_database()  # the next start
    assert db.schema_health()["ok"]
    assert _columns(path) == COLUMNS
    assert _q(path, "SELECT track_id, file_sig, version, levels FROM track_dj_levels") == [("7", "1:2", 1, None)]


class _Errors(logging.Handler):
    def __init__(self):
        super().__init__(logging.ERROR)
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())


def test_a_step_that_cannot_finish_fails_loudly_and_retries(tmp_path):
    path = tmp_path / "broken.db"
    db = MusicDatabase(str(path))
    conn = sqlite3.connect(str(path))
    conn.execute("DROP TABLE track_dj_levels")
    conn.execute("DELETE FROM schema_migrations WHERE name = 'track_dj_levels_v1'")
    # a view in the table's place, short a column: the column can't be added to it
    conn.execute("CREATE VIEW track_dj_levels AS SELECT '1' AS track_id")
    conn.commit()
    conn.close()
    log = logging.getLogger("soulsync.music_database")
    errors = _Errors()
    log.addHandler(errors)
    try:
        db._initialize_database()  # the next start
    finally:
        log.removeHandler(errors)
    health = db.schema_health()
    assert not health["ok"]
    assert any("add_track_dj_levels" in f["step"] for f in health["failed_steps"])
    assert any("add_track_dj_levels" in m for m in errors.messages)
    assert not _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'track_dj_levels_v1'")
    conn = sqlite3.connect(str(path))
    conn.execute("DROP VIEW track_dj_levels")
    conn.commit()
    conn.close()
    db._initialize_database()
    assert db.schema_health()["ok"] and _columns(path) == COLUMNS
