"""The beat grid table for auto-mix (``_add_track_grid_table``) on fresh
installs and upgrades: its columns, key and index, an old release upgrades,
a short table from an earlier build gets its columns and keeps its rows, an
install that already has DJ data gains the table with nothing lost (the grid
sweep tops it up), and a step that can't finish fails loudly (an ERROR naming
it, ``schema_health``) and runs again on the next start."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import pytest

from database.music_database import MusicDatabase

pytestmark = pytest.mark.gauntlet

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "old_databases"
WANTED = ["track_id"] + [name for name, _ in MusicDatabase._TRACK_GRID_COLUMNS]


def _q(path, sql, params=()):
    conn = sqlite3.connect(str(path))
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def _columns(path):
    return [r[1] for r in _q(path, "PRAGMA table_info(track_grid)")]


def test_fresh_install_has_the_table(tmp_path):
    path = tmp_path / "fresh.db"
    db = MusicDatabase(str(path))
    assert db.schema_health()["ok"]
    assert _columns(path) == WANTED
    assert [r[1] for r in _q(path, "PRAGMA table_info(track_grid)") if r[5]] == ["track_id"]
    assert "idx_track_grid_version" in {r[1] for r in _q(path, "PRAGMA index_list(track_grid)")}
    assert _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'track_grid_v1'")
    conn = sqlite3.connect(str(path))
    conn.execute("INSERT INTO track_grid (track_id, bpm) VALUES ('7', 124.0)")
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO track_grid (track_id, bpm) VALUES ('7', 125.0)")
    conn.close()


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
    assert _columns(path) == WANTED


def test_an_install_with_dj_data_gains_the_table_and_keeps_its_rows(tmp_path):
    """The build before stage A: track_dj rows and no track_grid. The new
    table comes in empty; the DJ rows stay as they were."""
    path = tmp_path / "stage1.db"
    db = MusicDatabase(str(path))
    conn = sqlite3.connect(str(path))
    conn.execute("DROP TABLE track_grid")
    conn.execute("DELETE FROM schema_migrations WHERE name = 'track_grid_v1'")
    conn.execute("INSERT INTO track_dj (track_id, bpm, musical_key, status, dj_analyzer_version) "
                 "VALUES ('1', 124.0, '8A', 'done', 4)")
    conn.commit()
    conn.close()
    db._initialize_database()  # the next start, on the new build
    assert db.schema_health()["ok"]
    assert _columns(path) == WANTED and _q(path, "SELECT COUNT(*) FROM track_grid") == [(0,)]
    assert _q(path, "SELECT track_id, bpm, musical_key, status FROM track_dj") == [("1", 124.0, "8A", "done")]
    assert _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'track_grid_v1'")


def test_a_short_table_gets_its_missing_columns_and_keeps_its_rows(tmp_path):
    path = tmp_path / "short.db"
    db = MusicDatabase(str(path))
    conn = sqlite3.connect(str(path))
    conn.execute("DROP TABLE track_grid")
    conn.execute("CREATE TABLE track_grid (track_id TEXT PRIMARY KEY, grid_version INTEGER, bpm REAL)")
    conn.execute("INSERT INTO track_grid VALUES ('2', 1, 128.0)")
    conn.commit()
    conn.close()
    db._initialize_database()
    assert db.schema_health()["ok"]
    assert _columns(path)[:3] == ["track_id", "grid_version", "bpm"]
    assert set(_columns(path)) == set(WANTED)
    assert _q(path, "SELECT track_id, grid_version, bpm, status FROM track_grid") == [("2", 1, 128.0, None)]


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
    conn.execute("DROP TABLE track_grid")
    conn.execute("DELETE FROM schema_migrations WHERE name = 'track_grid_v1'")
    # a view in the table's place, short a column: the column can't be added to it
    conn.execute("CREATE VIEW track_grid AS SELECT '1' AS track_id, 1 AS grid_version")
    conn.commit()
    conn.close()
    log = logging.getLogger("soulsync.music_database")
    errors = _Errors()
    log.addHandler(errors)
    try:
        db._initialize_database()
    finally:
        log.removeHandler(errors)
    health = db.schema_health()
    assert not health["ok"]
    assert any("add_track_grid" in f["step"] for f in health["failed_steps"])
    assert any("add_track_grid" in m for m in errors.messages)
    assert not _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'track_grid_v1'")
    conn = sqlite3.connect(str(path))
    conn.execute("DROP VIEW track_grid")
    conn.commit()
    conn.close()
    db._initialize_database()
    assert db.schema_health()["ok"] and _columns(path) == WANTED
