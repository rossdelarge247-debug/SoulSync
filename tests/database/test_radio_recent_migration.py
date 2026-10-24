"""Recent stations per profile (``_add_radio_recent_table``, HANDOFF 142 and
163) on fresh installs and on upgrades: the table, its key and index, the
ledger row; a second start changes nothing and keeps the rows; an old release
upgrades; and a step that can't finish fails loudly (an ERROR naming it,
``schema_health``) and runs again on the next start. The full upgrade from
each old release is compared table by table in
test_upgrade_from_old_releases.py."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import pytest

from database.music_database import MusicDatabase

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "old_databases"
WANTED = ["profile_id", "station_id", "station_json", "played_at"]


def _q(path, sql, args=()):
    conn = sqlite3.connect(str(path))
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def _columns(path):
    return [r[1] for r in _q(path, "PRAGMA table_info(radio_recent)")]


def _key(path):
    # pk position per column: the primary key is (profile_id, station_id)
    return [(r[1], r[5]) for r in _q(path, "PRAGMA table_info(radio_recent)") if r[5]]


def test_fresh_install_has_the_table(tmp_path):
    path = tmp_path / "fresh.db"
    db = MusicDatabase(str(path))
    assert db.schema_health()["ok"]
    assert _columns(path) == WANTED
    assert _key(path) == [("profile_id", 1), ("station_id", 2)]
    assert ("idx_radio_recent_profile",) in _q(
        path, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='radio_recent'")
    assert _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'radio_recent_v1'")


def test_a_second_start_changes_nothing_and_keeps_the_rows(tmp_path):
    path = tmp_path / "again.db"
    db = MusicDatabase(str(path))
    conn = sqlite3.connect(str(path))
    conn.execute("INSERT INTO radio_recent VALUES (2, 'nts-1', NULL, 1700000000)")
    conn.commit()
    conn.close()
    before = _q(path, "SELECT sql FROM sqlite_master WHERE tbl_name = 'radio_recent' ORDER BY name")
    db._initialize_database()  # the next start
    db._initialize_database()
    assert db.schema_health()["ok"]
    assert _q(path, "SELECT sql FROM sqlite_master WHERE tbl_name = 'radio_recent' ORDER BY name") == before
    assert _q(path, "SELECT profile_id, station_id, played_at FROM radio_recent") == [(2, "nts-1", 1700000000)]
    assert _q(path, "SELECT COUNT(*) FROM schema_migrations WHERE name = 'radio_recent_v1'") == [(1,)]


def _oldest_release():
    releases = sorted(p for p in FIXTURES.iterdir() if (p / "music.sql").exists())
    return releases[0] if releases else None


@pytest.mark.skipif(_oldest_release() is None, reason="no old database fixtures")
def test_an_old_release_upgrades(tmp_path):
    path = tmp_path / "old.db"
    conn = sqlite3.connect(str(path))
    conn.executescript((_oldest_release() / "music.sql").read_text(encoding="utf-8"))
    conn.close()
    assert not _q(path, "SELECT 1 FROM sqlite_master WHERE name = 'radio_recent'")
    db = MusicDatabase(str(path))
    assert db.schema_health()["ok"], db.schema_health()
    assert _columns(path) == WANTED


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
    conn.execute("DROP TABLE radio_recent")
    conn.execute("DELETE FROM schema_migrations WHERE name = 'radio_recent_v1'")
    # a view in the table's place: the index can't be made on it
    conn.execute("CREATE VIEW radio_recent AS SELECT 1 AS profile_id, 'x' AS station_id, "
                 "NULL AS station_json, 0 AS played_at")
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
    assert any("add_radio_recent" in f["step"] for f in health["failed_steps"])
    assert any("add_radio_recent" in m for m in errors.messages)
    assert not _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'radio_recent_v1'")
    # fixed by hand: the next start finishes the step
    conn = sqlite3.connect(str(path))
    conn.execute("DROP VIEW radio_recent")
    conn.commit()
    conn.close()
    db._initialize_database()
    assert db.schema_health()["ok"] and _columns(path) == WANTED
    assert _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'radio_recent_v1'")


def test_a_step_that_fails_after_the_table_isnt_recorded_by_the_ledger_sync(tmp_path):
    """The step records its own ledger row only when it finished; the ledger
    back-fill (_sync_migration_ledger) mustn't record it just because the
    table exists after a later part of the step failed."""
    path = tmp_path / "half.db"
    db = MusicDatabase(str(path))
    conn = sqlite3.connect(str(path))
    conn.execute("DELETE FROM schema_migrations WHERE name = 'radio_recent_v1'")
    conn.execute("DROP INDEX idx_radio_recent_profile")
    # a table in the index's name: the table is there, the index can't be made
    conn.execute("CREATE TABLE idx_radio_recent_profile (x INTEGER)")
    conn.commit()
    conn.close()
    db._initialize_database()  # the next start
    assert any("add_radio_recent" in f["step"] for f in db.schema_health()["failed_steps"])
    assert not _q(path, "SELECT 1 FROM schema_migrations WHERE name = 'radio_recent_v1'")
