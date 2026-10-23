"""The DJ data table (``_add_track_dj_table``) on fresh installs and on
upgrades: every column and index, a table an earlier build left short gets
its columns, Sample Studio's analysis gains ``energy``, and a step that can't
finish fails loudly (an ERROR naming it, ``schema_health``) and runs again
on the next start. The full upgrade from each old release is covered by
test_upgrade_from_old_releases.py, which compares every table with a fresh
install."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import pytest

from database.music_database import MusicDatabase

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "old_databases"


def _columns(path, table):
    conn = sqlite3.connect(str(path))
    try:
        return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]
    finally:
        conn.close()


def _indexes(path, table):
    conn = sqlite3.connect(str(path))
    try:
        return {r[1] for r in conn.execute(f"PRAGMA index_list({table})")}
    finally:
        conn.close()


WANTED = ["track_id"] + [name for name, _ in MusicDatabase._TRACK_DJ_COLUMNS]


def test_fresh_install_has_the_table(tmp_path):
    path = tmp_path / "fresh.db"
    db = MusicDatabase(str(path))
    assert db.schema_health()["ok"]
    assert _columns(path, "track_dj") == WANTED
    assert {"idx_track_dj_bpm", "idx_track_dj_key", "idx_track_dj_version"} <= _indexes(path, "track_dj")
    assert "energy" in _columns(path, "sample_analysis")
    conn = sqlite3.connect(str(path))
    assert conn.execute("SELECT 1 FROM schema_migrations WHERE name = 'track_dj_v1'").fetchone()
    conn.close()


def _oldest_release():
    releases = sorted(p for p in FIXTURES.iterdir() if (p / "music.sql").exists())
    return releases[0] if releases else None


@pytest.mark.skipif(_oldest_release() is None, reason="no old database fixtures")
def test_an_old_release_upgrades(tmp_path):
    path = tmp_path / "old.db"
    conn = sqlite3.connect(str(path))
    conn.executescript((_oldest_release() / "music.sql").read_text(encoding="utf-8"))
    conn.close()
    assert "track_dj" not in {r for r in _tables(path)}
    db = MusicDatabase(str(path))
    assert db.schema_health()["ok"], db.schema_health()
    assert _columns(path, "track_dj") == WANTED


def _tables(path):
    conn = sqlite3.connect(str(path))
    try:
        return [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    finally:
        conn.close()


def test_a_short_table_gets_its_missing_columns(tmp_path):
    path = tmp_path / "short.db"
    db = MusicDatabase(str(path))
    conn = sqlite3.connect(str(path))
    conn.execute("DROP TABLE track_dj")
    conn.execute("CREATE TABLE track_dj (track_id TEXT PRIMARY KEY, bpm REAL)")
    conn.execute("INSERT INTO track_dj (track_id, bpm) VALUES ('7', 124.0)")
    conn.commit()
    conn.close()
    db._initialize_database()  # the next start
    assert db.schema_health()["ok"]
    assert set(_columns(path, "track_dj")) == set(WANTED)
    conn = sqlite3.connect(str(path))
    assert conn.execute("SELECT bpm FROM track_dj WHERE track_id = '7'").fetchone()[0] == 124.0
    conn.close()


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
    conn.execute("DROP TABLE track_dj")
    conn.execute("DELETE FROM schema_migrations WHERE name = 'track_dj_v1'")
    # a view in the table's place: the columns can't be added to it
    conn.execute("CREATE VIEW track_dj AS SELECT '1' AS track_id")
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
    assert any("add_track_dj" in f["step"] for f in health["failed_steps"])
    assert any("add_track_dj" in m for m in errors.messages)
    conn = sqlite3.connect(str(path))
    assert not conn.execute("SELECT 1 FROM schema_migrations WHERE name = 'track_dj_v1'").fetchone()
    # fixed by hand: the next start finishes the step
    conn.execute("DROP VIEW track_dj")
    conn.commit()
    conn.close()
    db._initialize_database()
    assert db.schema_health()["ok"] and _columns(path, "track_dj") == WANTED
