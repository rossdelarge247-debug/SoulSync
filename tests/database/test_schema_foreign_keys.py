"""Schema steps run with foreign keys off, and are checked afterwards.

_get_connection turns foreign keys on, and with them on the DROP TABLE of a
table rebuild deletes every row first, which fires ON DELETE CASCADE in the
tables pointing at it, although the rebuild keeps the ids. Upgrading a
pre-profiles database lost recent_releases and listenbrainz_tracks that way
(the 1.3 cases in test_upgrade_from_old_releases). Init now follows sqlite's
documented procedure: foreign keys off for the steps, PRAGMA foreign_key_check
afterwards (reported like a failed step), then on again.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from database.music_database import MusicDatabase


def _query(db_path: Path, sql: str, args=()):
    conn = sqlite3.connect(str(db_path))
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def _execute(db_path: Path, *statements) -> None:
    conn = sqlite3.connect(str(db_path))
    try:
        for sql, args in statements:
            conn.execute(sql, args)
        conn.commit()
    finally:
        conn.close()


def test_listenbrainz_rebuild_keeps_tracks_and_trackless_playlists(tmp_path: Path) -> None:
    """The rebuild keeps every playlist and its tracks. It used to empty
    listenbrainz_tracks through the cascade and then delete every playlist
    left without tracks; a playlist cached with no tracks went with them.
    A track whose playlist is gone is removed, which is all the cascade
    should have done."""
    db_path = tmp_path / "library.db"
    db = MusicDatabase(str(db_path))
    _execute(
        db_path,
        ("INSERT INTO listenbrainz_playlists (id, playlist_mbid, title, playlist_type, profile_id) "
         "VALUES (7, 'mbid-7', 'Weekly Jams', 'weekly-jams', 1)", ()),
        ("INSERT INTO listenbrainz_playlists (id, playlist_mbid, title, playlist_type, profile_id) "
         "VALUES (8, 'mbid-8', 'Nothing yet', 'weekly-exploration', 1)", ()),
        ("INSERT INTO listenbrainz_tracks (playlist_id, position, track_name, artist_name, album_name) "
         "VALUES (7, 0, 'Song', 'Artist', 'Album')", ()),
        ("INSERT INTO listenbrainz_tracks (playlist_id, position, track_name, artist_name, album_name) "
         "VALUES (99, 0, 'Orphan', 'Artist', 'Album')", ()),
        ("DELETE FROM metadata WHERE key = 'profiles_listenbrainz_v1'", ()),
    )

    db._initialize_database()

    assert _query(db_path, "SELECT id FROM listenbrainz_playlists ORDER BY id") == [(7,), (8,)]
    assert _query(db_path, "SELECT playlist_id, track_name FROM listenbrainz_tracks") == [(7, "Song")]
    assert _query(db_path, "SELECT value FROM metadata WHERE key = 'profiles_listenbrainz_v1'") == [("1",)]
    assert db.schema_health() == {"ok": True, "failed_steps": []}


def test_a_foreign_key_violation_is_reported_until_it_is_fixed(tmp_path: Path, monkeypatch) -> None:
    """A step that leaves a row pointing at nothing is reported like a failed
    step. The check covers the tables a start changed (and the ones pointing
    at them), and once it has found something it checks every table on each
    start, until the violation is gone."""
    db_path = tmp_path / "library.db"
    db = MusicDatabase(str(db_path))
    real_step = MusicDatabase._add_retag_tables

    def step_leaving_an_orphan(self, cursor):
        real_step(self, cursor)
        cursor.execute("CREATE TABLE fk_parent (id INTEGER PRIMARY KEY)")
        cursor.execute("CREATE TABLE fk_child (id INTEGER PRIMARY KEY, "
                       "parent_id INTEGER REFERENCES fk_parent (id) ON DELETE CASCADE)")
        cursor.execute("INSERT INTO fk_child VALUES (1, 42)")

    monkeypatch.setattr(MusicDatabase, "_add_retag_tables", step_leaving_an_orphan)
    db._initialize_database()
    monkeypatch.setattr(MusicDatabase, "_add_retag_tables", real_step)

    health = db.schema_health()
    assert not health["ok"]
    assert [f["step"] for f in health["failed_steps"]] == ["foreign_key_check"]
    assert "1 fk_child row(s) point at a missing fk_parent row" in health["failed_steps"][0]["error"]

    # nothing changes the schema on this start, the violation is still there
    db._initialize_database()
    assert [f["step"] for f in db.schema_health()["failed_steps"]] == ["foreign_key_check"]

    _execute(db_path, ("DELETE FROM fk_child", ()))
    db._initialize_database()
    assert db.schema_health() == {"ok": True, "failed_steps": []}


def _capture_init_connection(monkeypatch, foreign_keys: bool) -> list:
    """Hand _initialize_database a real connection with foreign keys on or
    off, and keep it, so its pragma state can be read after init."""
    captured = []
    real_get = MusicDatabase._get_connection

    def get(self):
        conn = real_get(self)
        if not captured:
            conn.execute(f"PRAGMA foreign_keys = {'ON' if foreign_keys else 'OFF'}")
            captured.append(conn)
        return conn

    monkeypatch.setattr(MusicDatabase, "_get_connection", get)
    return captured


def test_init_puts_foreign_keys_back_the_way_it_found_them(tmp_path: Path, monkeypatch) -> None:
    db = MusicDatabase(str(tmp_path / "library.db"))
    for foreign_keys in (True, False):
        captured = _capture_init_connection(monkeypatch, foreign_keys)
        db._initialize_database()
        assert captured[0].execute("PRAGMA foreign_keys").fetchone()[0] == int(foreign_keys)


def test_steps_run_with_foreign_keys_off(tmp_path: Path, monkeypatch) -> None:
    db = MusicDatabase(str(tmp_path / "library.db"))
    seen = []
    real_step = MusicDatabase._add_retag_tables

    def spy(self, cursor):
        seen.append(cursor.execute("PRAGMA foreign_keys").fetchone()[0])
        real_step(self, cursor)

    _capture_init_connection(monkeypatch, foreign_keys=True)
    monkeypatch.setattr(MusicDatabase, "_add_retag_tables", spy)
    db._initialize_database()
    assert seen == [0]
