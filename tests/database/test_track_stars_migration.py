"""The stars table (``_add_track_stars_table``) on fresh installs and
upgrades: its columns, key and index, an old release upgrades, a short table
from an earlier build gets its columns and keeps its rows, and a step that
can't finish fails loudly (an ERROR naming it, ``schema_health``) and runs
again on the next start. Profiles' stars go with a deleted profile."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import pytest

from database.music_database import MusicDatabase

pytestmark = pytest.mark.gauntlet

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "old_databases"
COLUMNS = [name for name, _ in MusicDatabase._TRACK_STARS_COLUMNS]


def _q(path, sql, params=()):
    conn = sqlite3.connect(str(path))
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def _columns(path):
    return [r[1] for r in _q(path, "PRAGMA table_info(track_stars)")]


def test_fresh_install_has_the_table(tmp_path):
    path = tmp_path / "fresh.db"
    db = MusicDatabase(str(path))
    assert db.schema_health()["ok"]
    assert _columns(path) == COLUMNS == ["profile_id", "track_id", "starred_at"]
    # one star per track per profile
    assert [r[1] for r in _q(path, "PRAGMA table_info(track_stars)") if r[5]] == ["profile_id", "track_id"]
    assert "idx_track_stars_profile" in {r[1] for r in _q(path, "PRAGMA index_list(track_stars)")}
    assert _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'track_stars_v1'")
    conn = sqlite3.connect(str(path))
    conn.execute("INSERT INTO track_stars (profile_id, track_id) VALUES (1, '4')")
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO track_stars (profile_id, track_id) VALUES (1, '4')")
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
    assert _columns(path) == COLUMNS


def test_a_short_table_gets_its_missing_columns_and_keeps_its_rows(tmp_path):
    path = tmp_path / "short.db"
    db = MusicDatabase(str(path))
    conn = sqlite3.connect(str(path))
    conn.execute("DROP TABLE track_stars")
    conn.execute("CREATE TABLE track_stars (profile_id INTEGER NOT NULL, track_id TEXT NOT NULL, "
                 "PRIMARY KEY (profile_id, track_id))")
    conn.execute("INSERT INTO track_stars VALUES (2, '7')")
    conn.commit()
    conn.close()
    db._initialize_database()  # the next start
    assert db.schema_health()["ok"]
    assert _columns(path) == COLUMNS
    assert _q(path, "SELECT profile_id, track_id, starred_at FROM track_stars") == [(2, "7", None)]


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
    conn.execute("DROP TABLE track_stars")
    conn.execute("DELETE FROM schema_migrations WHERE name = 'track_stars_v1'")
    # a view in the table's place: the index can't be made on it
    conn.execute("CREATE VIEW track_stars AS SELECT 1 AS profile_id, '1' AS track_id, 0 AS starred_at")
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
    assert any("add_track_stars" in f["step"] for f in health["failed_steps"])
    assert any("add_track_stars" in m for m in errors.messages)
    assert not _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'track_stars_v1'")
    conn = sqlite3.connect(str(path))
    conn.execute("DROP VIEW track_stars")
    conn.commit()
    conn.close()
    db._initialize_database()
    assert db.schema_health()["ok"] and _columns(path) == COLUMNS


def test_a_deleted_profiles_stars_go_with_it(tmp_path):
    path = tmp_path / "profiles.db"
    db = MusicDatabase(str(path))
    conn = sqlite3.connect(str(path))
    conn.execute("INSERT INTO profiles (id, name) VALUES (5, 'Guest')")
    conn.execute("INSERT INTO track_stars (profile_id, track_id) VALUES (5, '1'), (1, '1')")
    conn.commit()
    conn.close()
    assert db.delete_profile(5)
    assert _q(path, "SELECT profile_id FROM track_stars") == [(1,)]
