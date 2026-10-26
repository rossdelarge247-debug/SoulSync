"""The Mix tab's working-set table (``_add_dj_working_sets_table``) on fresh
installs and upgrades: its columns and key (one row per profile), an old
release upgrades, a short table from an earlier build gets its columns and
keeps its rows, and a step that can't finish fails loudly (an ERROR naming
it, ``schema_health``) and runs again on the next start. A profile's working
set goes with the profile."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import pytest

from database.music_database import MusicDatabase

pytestmark = pytest.mark.gauntlet

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "old_databases"
COLUMNS = [name for name, _ in MusicDatabase._DJ_WORKING_SETS_COLUMNS]


def _q(path, sql, params=()):
    conn = sqlite3.connect(str(path))
    try:
        return conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def _columns(path):
    return [r[1] for r in _q(path, "PRAGMA table_info(dj_working_sets)")]


def test_fresh_install_has_the_table(tmp_path):
    path = tmp_path / "fresh.db"
    db = MusicDatabase(str(path))
    assert db.schema_health()["ok"]
    assert _columns(path) == COLUMNS == ["profile_id", "set_id", "chosen_at"]
    # one working set per profile
    assert [r[1] for r in _q(path, "PRAGMA table_info(dj_working_sets)") if r[5]] == ["profile_id"]
    assert _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'dj_working_sets_v1'")
    conn = sqlite3.connect(str(path))
    conn.execute("INSERT INTO dj_working_sets (profile_id, set_id) VALUES (1, 4)")
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO dj_working_sets (profile_id, set_id) VALUES (1, 5)")
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
    conn.execute("DROP TABLE dj_working_sets")
    conn.execute("CREATE TABLE dj_working_sets (profile_id INTEGER NOT NULL PRIMARY KEY, set_id INTEGER)")
    conn.execute("INSERT INTO dj_working_sets VALUES (2, 7)")
    conn.commit()
    conn.close()
    db._initialize_database()  # the next start
    assert db.schema_health()["ok"]
    assert _columns(path) == COLUMNS
    assert _q(path, "SELECT profile_id, set_id, chosen_at FROM dj_working_sets") == [(2, 7, None)]


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
    conn.execute("DROP TABLE dj_working_sets")
    conn.execute("DELETE FROM schema_migrations WHERE name = 'dj_working_sets_v1'")
    # a view in the table's place, short a column: the column can't be added to it
    conn.execute("CREATE VIEW dj_working_sets AS SELECT 1 AS profile_id, 1 AS set_id")
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
    assert any("add_dj_working_sets" in f["step"] for f in health["failed_steps"])
    assert any("add_dj_working_sets" in m for m in errors.messages)
    assert not _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'dj_working_sets_v1'")
    conn = sqlite3.connect(str(path))
    conn.execute("DROP VIEW dj_working_sets")
    conn.commit()
    conn.close()
    db._initialize_database()
    assert db.schema_health()["ok"] and _columns(path) == COLUMNS


def test_a_deleted_profiles_working_set_goes_with_it(tmp_path):
    path = tmp_path / "profiles.db"
    db = MusicDatabase(str(path))
    conn = sqlite3.connect(str(path))
    conn.execute("INSERT INTO profiles (id, name) VALUES (5, 'Guest')")
    conn.execute("INSERT INTO dj_working_sets (profile_id, set_id) VALUES (5, 3), (1, 2)")
    conn.commit()
    conn.close()
    assert db.delete_profile(5)
    assert _q(path, "SELECT profile_id FROM dj_working_sets") == [(1,)]
