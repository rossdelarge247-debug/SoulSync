"""The Sets tables (``_add_dj_sets_tables``) on fresh installs and upgrades:
every column and the index, an old release upgrades, a short table from an
earlier build gets its columns and keeps its rows, and a step that can't
finish fails loudly (an ERROR naming it, ``schema_health``) and runs again
on the next start."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import pytest

from database.music_database import MusicDatabase

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "old_databases"
SETS = ["id"] + [name for name, _ in MusicDatabase._DJ_SETS_COLUMNS]
ROWS = ["set_id", "position"] + [name for name, _ in MusicDatabase._DJ_SET_TRACKS_COLUMNS]


def _q(path, sql, params=()):
    conn = sqlite3.connect(str(path))
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def _columns(path, table):
    return [r[1] for r in _q(path, f"PRAGMA table_info({table})")]


def test_fresh_install_has_the_tables(tmp_path):
    path = tmp_path / "fresh.db"
    db = MusicDatabase(str(path))
    assert db.schema_health()["ok"]
    assert _columns(path, "dj_sets") == SETS and _columns(path, "dj_set_tracks") == ROWS
    assert "idx_dj_sets_profile" in {r[1] for r in _q(path, "PRAGMA index_list(dj_sets)")}
    assert _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'dj_sets_v1'")


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
    assert _columns(path, "dj_sets") == SETS and _columns(path, "dj_set_tracks") == ROWS


def test_a_short_table_gets_its_missing_columns(tmp_path):
    path = tmp_path / "short.db"
    db = MusicDatabase(str(path))
    conn = sqlite3.connect(str(path))
    conn.execute("DROP TABLE dj_set_tracks")
    conn.execute("DROP TABLE dj_sets")
    conn.execute("CREATE TABLE dj_sets (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL, "
                 "name TEXT NOT NULL)")
    conn.execute("CREATE TABLE dj_set_tracks (set_id INTEGER NOT NULL, position INTEGER NOT NULL, track_id TEXT, "
                 "PRIMARY KEY (set_id, position))")
    conn.execute("INSERT INTO dj_sets (id, profile_id, name) VALUES (3, 1, 'Sunday Set')")
    conn.execute("INSERT INTO dj_set_tracks (set_id, position, track_id) VALUES (3, 0, '7')")
    conn.commit()
    conn.close()
    db._initialize_database()  # the next start
    assert db.schema_health()["ok"]
    assert set(_columns(path, "dj_sets")) == set(SETS) and set(_columns(path, "dj_set_tracks")) == set(ROWS)
    assert _q(path, "SELECT name, kind, status FROM dj_sets") == [("Sunday Set", "hand", "saved")]
    assert _q(path, "SELECT track_id, locked FROM dj_set_tracks") == [("7", 0)]


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
    conn.execute("DROP TABLE dj_set_tracks")
    conn.execute("DROP TABLE dj_sets")
    conn.execute("DELETE FROM schema_migrations WHERE name = 'dj_sets_v1'")
    # a view in the table's place: the columns and index can't be added to it
    conn.execute("CREATE VIEW dj_sets AS SELECT 1 AS id")
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
    assert any("add_dj_sets" in f["step"] for f in health["failed_steps"])
    assert any("add_dj_sets" in m for m in errors.messages)
    assert not _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'dj_sets_v1'")
    conn = sqlite3.connect(str(path))
    conn.execute("DROP VIEW dj_sets")
    conn.commit()
    conn.close()
    db._initialize_database()
    assert db.schema_health()["ok"] and _columns(path, "dj_sets") == SETS
