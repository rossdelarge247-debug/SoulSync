"""Schema steps in MusicDatabase._initialize_database fail loudly and retry.

Every step runs on every start. Steps used to log a failure (often at DEBUG),
carry on, write their "done" marker anyway, and the single commit at the end
of init saved whatever half-migrated state that left. Now a failing step:

- rolls back what it did (each step, and each part of a step, is a SAVEPOINT),
- leaves its done marker unwritten, so the next start runs it again,
- says so: an ERROR log naming the step, MusicDatabase.schema_health(), and a
  metadata row.

"Already applied" errors (duplicate column, table/index already exists) are the
normal outcome of a re-run and stay quiet.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path

import pytest

from database.music_database import MusicDatabase


class _Records(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.records = []

    def emit(self, record):
        self.records.append(record)

    def errors(self):
        return [r.getMessage() for r in self.records if r.levelno >= logging.ERROR]


@pytest.fixture
def db_log():
    """Everything soulsync.music_database logs during the test. Attached to the
    logger itself so it works whatever other tests did to propagation."""
    log = logging.getLogger("soulsync.music_database")
    handler = _Records()
    old_level = log.level
    log.addHandler(handler)
    log.setLevel(logging.DEBUG)
    yield handler
    log.removeHandler(handler)
    log.setLevel(old_level)


def _query(db_path: Path, sql: str, args=()):
    conn = sqlite3.connect(str(db_path))
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def _metadata(db_path: Path, key: str):
    rows = _query(db_path, "SELECT value FROM metadata WHERE key = ?", (key,))
    return rows[0][0] if rows else None


def _table_sql(db_path: Path, table: str) -> str:
    rows = _query(db_path, "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,))
    return rows[0][0] if rows else ""


def _columns(db_path: Path, table: str) -> list:
    return [r[1] for r in _query(db_path, f"PRAGMA table_info({table})")]


def _tables(db_path: Path) -> set:
    return {r[0] for r in _query(db_path, "SELECT name FROM sqlite_master WHERE type='table'")}


def _snapshot(db_path: Path) -> dict:
    tables = sorted(_tables(db_path) - {"sqlite_sequence"})
    return {
        "schema": _query(db_path, "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"),
        "metadata": _query(db_path, "SELECT key, value FROM metadata ORDER BY key"),
        "ledger": _query(db_path, "SELECT name FROM schema_migrations ORDER BY name"),
        "user_version": _query(db_path, "PRAGMA user_version"),
        "rows": {t: _query(db_path, f'SELECT COUNT(*) FROM "{t}"') for t in tables if "fts" not in t},
    }


def _fail_copy_of(monkeypatch, table: str):
    """Make the rebuild of ``table`` fail with a real (not "already applied")
    sqlite error, the way a full disk or a constraint violation would."""
    real_copy = MusicDatabase._copy_rows_for_rebuild

    def failing_copy(self, cursor, old_table, new_table, **kwargs):
        if old_table == table:
            raise sqlite3.OperationalError("disk I/O error (injected)")
        return real_copy(self, cursor, old_table, new_table, **kwargs)

    monkeypatch.setattr(MusicDatabase, "_copy_rows_for_rebuild", failing_copy)


# ── a clean database stays quiet ─────────────────────────────────────────────


def test_fresh_init_has_no_failed_steps(tmp_path: Path, db_log) -> None:
    """Also guards the ordering fix: _fix_profile_one_owner_rows used to run
    before _add_own_library_columns created owner_profile_id, so it failed with
    "no such column" on every fresh install."""
    db_path = tmp_path / "fresh.db"
    db = MusicDatabase(str(db_path))

    assert db.schema_health() == {"ok": True, "failed_steps": []}
    assert db_log.errors() == []
    assert _metadata(db_path, MusicDatabase._SCHEMA_FAILURES_KEY) is None


def test_reinit_of_an_initialised_db_changes_nothing(tmp_path: Path, db_log) -> None:
    """The first start on an empty file isn't quite a fixed point: the profile
    rebuilds drop indexes _add_discovery_tables made earlier in the same start
    and the second start puts them back (that predates this change). From then
    on a start must change nothing and fail nothing."""
    db_path = tmp_path / "library.db"
    db = MusicDatabase(str(db_path))
    db._initialize_database()
    before = _snapshot(db_path)
    db_log.records.clear()

    db._initialize_database()

    assert _snapshot(db_path) == before
    assert db.schema_health() == {"ok": True, "failed_steps": []}
    assert db_log.errors() == []


# ── a failing step is rolled back, reported, and retried ─────────────────────


def test_failed_part_of_a_step_leaves_its_marker_unwritten_and_retries(
        tmp_path: Path, db_log, monkeypatch) -> None:
    """_add_profile_support rebuilds four tables, then writes
    profiles_migration_v1. With the bubble_snapshots rebuild failing, the other
    parts still land, the failed one leaves nothing half done, the marker is not
    written, and the next start finishes the job."""
    db_path = tmp_path / "library.db"
    _fail_copy_of(monkeypatch, "bubble_snapshots")

    db = MusicDatabase(str(db_path))

    step = "add_profile_support / rebuild bubble_snapshots"
    assert db.schema_health() == {
        "ok": False,
        "failed_steps": [{"step": step, "error": "OperationalError: disk I/O error (injected)"}],
    }
    errors = db_log.errors()
    assert any(step in e and "disk I/O error (injected)" in e for e in errors), errors
    assert any("finished with 1 failed step(s)" in e for e in errors), errors
    stored = json.loads(_metadata(db_path, MusicDatabase._SCHEMA_FAILURES_KEY))
    assert [f["step"] for f in stored] == [step]

    # not marked done
    assert _metadata(db_path, "profiles_migration_v1") is None
    # the failed part left nothing behind and the old table is untouched
    assert "bubble_snapshots_new" not in _tables(db_path)
    assert "id" not in _columns(db_path, "bubble_snapshots")
    # the parts that worked are kept
    assert _query(db_path, "SELECT id, name FROM profiles") == [(1, "Admin")]
    assert "UNIQUE(profile_id" in _table_sql(db_path, "wishlist_tracks")

    monkeypatch.undo()
    db._initialize_database()

    assert db.schema_health() == {"ok": True, "failed_steps": []}
    assert _metadata(db_path, "profiles_migration_v1") == "true"
    assert "UNIQUE(profile_id, type)" in _table_sql(db_path, "bubble_snapshots")
    assert _metadata(db_path, MusicDatabase._SCHEMA_FAILURES_KEY) is None


def test_a_step_that_stops_part_way_is_rolled_back_whole(tmp_path: Path, db_log, monkeypatch) -> None:
    """_add_profile_listenbrainz_support adds three profile columns, then
    rebuilds listenbrainz_playlists. A failure in the rebuild undoes the
    columns too, and the next start runs the whole step again."""
    db_path = tmp_path / "library.db"
    _fail_copy_of(monkeypatch, "listenbrainz_playlists")

    db = MusicDatabase(str(db_path))

    assert [f["step"] for f in db.schema_health()["failed_steps"]] == ["add_profile_listenbrainz_support"]
    assert _metadata(db_path, "profiles_listenbrainz_v1") is None
    assert "listenbrainz_token" not in _columns(db_path, "profiles")
    assert "listenbrainz_playlists_new" not in _tables(db_path)
    assert "profile_id" not in _columns(db_path, "listenbrainz_playlists")

    monkeypatch.undo()
    db._initialize_database()

    assert db.schema_health()["ok"] is True
    assert _metadata(db_path, "profiles_listenbrainz_v1") == "1"
    assert "listenbrainz_token" in _columns(db_path, "profiles")
    assert "UNIQUE(playlist_mbid, profile_id)" in _table_sql(db_path, "listenbrainz_playlists")


# a pre-profile watchlist_artists: rebuilt by _add_profile_support
_OLD_WATCHLIST = """
    CREATE TABLE watchlist_artists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spotify_artist_id TEXT UNIQUE,
        itunes_artist_id TEXT,
        deezer_artist_id TEXT,
        artist_name TEXT NOT NULL,
        date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_scan_timestamp TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
"""


def _seed_old_watchlist(db_path: Path, rows) -> None:
    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute(_OLD_WATCHLIST)
        for row in rows:
            cols = ", ".join(row)
            marks = ", ".join("?" for _ in row)
            conn.execute(f"INSERT INTO watchlist_artists ({cols}) VALUES ({marks})", tuple(row.values()))
        conn.commit()
    finally:
        conn.close()


def test_a_rebuild_that_hits_a_real_conflict_keeps_the_old_table_and_retries(tmp_path: Path, db_log) -> None:
    """The profile rebuild adds UNIQUE(profile_id, itunes_artist_id). Two
    watchlist rows sharing an iTunes id can't satisfy it. That used to log,
    write profiles_migration_v1 anyway and never try again; now the rows stay
    where they were and the rebuild runs again once the data allows it."""
    db_path = tmp_path / "old.db"
    _seed_old_watchlist(db_path, [
        {"spotify_artist_id": "sp1", "itunes_artist_id": "123", "artist_name": "One"},
        {"spotify_artist_id": "sp2", "itunes_artist_id": "123", "artist_name": "Two"},
    ])

    db = MusicDatabase(str(db_path))

    failed = db.schema_health()["failed_steps"]
    assert [f["step"] for f in failed] == ["add_profile_support / rebuild watchlist_artists"]
    assert "UNIQUE constraint failed" in failed[0]["error"]
    assert _metadata(db_path, "profiles_migration_v1") is None
    assert "watchlist_artists_new" not in _tables(db_path)
    assert "UNIQUE(profile_id" not in _table_sql(db_path, "watchlist_artists")
    assert _query(db_path, "SELECT artist_name FROM watchlist_artists ORDER BY id") == [("One",), ("Two",)]

    conn = sqlite3.connect(str(db_path))
    conn.execute("UPDATE watchlist_artists SET itunes_artist_id = '456' WHERE artist_name = 'Two'")
    conn.commit()
    conn.close()
    db._initialize_database()

    assert db.schema_health()["ok"] is True
    assert _metadata(db_path, "profiles_migration_v1") == "true"
    assert "UNIQUE(profile_id, itunes_artist_id)" in _table_sql(db_path, "watchlist_artists")
    assert _query(db_path, "SELECT artist_name FROM watchlist_artists ORDER BY id") == [("One",), ("Two",)]


# ── _migration_step itself ───────────────────────────────────────────────────


def _bare_db():
    db = MusicDatabase.__new__(MusicDatabase)
    db._migration_failures = []
    return db


def test_migration_step_rolls_back_a_real_failure_and_flags_its_parent(tmp_path: Path, db_log) -> None:
    db = _bare_db()
    conn = sqlite3.connect(str(tmp_path / "steps.db"))
    cur = conn.cursor()
    cur.execute("CREATE TABLE t (a INTEGER)")
    conn.commit()

    with db._migration_step(cur, "outer"):
        with db._migration_step(cur, "good part"):
            cur.execute("INSERT INTO t VALUES (1)")
        with db._migration_step(cur, "bad part"):
            cur.execute("INSERT INTO t VALUES (2)")
            cur.execute("INSERT INTO missing_table VALUES (3)")
        outer_ok = db._migration_step_ok()
    conn.commit()

    assert outer_ok is False   # a marker written here would be skipped
    assert cur.execute("SELECT a FROM t").fetchall() == [(1,)]   # (2) was rolled back
    assert db._migration_failures == [
        {"step": "outer / bad part", "error": "OperationalError: no such table: missing_table"}]
    assert any("outer / bad part" in e for e in db_log.errors())
    conn.close()


def test_migration_step_treats_already_applied_as_quiet(tmp_path: Path, db_log) -> None:
    db = _bare_db()
    conn = sqlite3.connect(str(tmp_path / "steps.db"))
    cur = conn.cursor()
    cur.execute("CREATE TABLE t (a INTEGER, b TEXT)")
    conn.commit()

    with db._migration_step(cur, "outer"):
        with db._migration_step(cur, "re-add b"):
            cur.execute("INSERT INTO t VALUES (1, 'x')")
            cur.execute("ALTER TABLE t ADD COLUMN b TEXT")   # duplicate column name
        with db._migration_step(cur, "re-create index"):
            cur.execute("CREATE INDEX idx_t_a ON t (a)")
            cur.execute("CREATE INDEX idx_t_a ON t (a)")     # index already exists
        outer_ok = db._migration_step_ok()
    conn.commit()

    assert outer_ok is True
    assert db._migration_failures == []
    assert db_log.errors() == []
    # work before the "already applied" error is kept, as the old except/pass did
    assert cur.execute("SELECT a, b FROM t").fetchall() == [(1, "x")]
    conn.close()
