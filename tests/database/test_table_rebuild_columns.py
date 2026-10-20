"""Table rebuilds keep the columns they weren't told about.

SQLite can't change a constraint in place, so several migrations rebuild a
table: create the new shape, copy the rows, drop the old table, rename. The
copy used to name its columns by hand, and every column the list didn't name
was dropped with its data (amazon_artist_id and preferred_metadata_source, #983,
were lost that way; see test_db_watchlist_amazon_id_migration.py). Rebuilds now
copy what the two tables actually share, and carry over an old-only column that
holds data.
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


def test_a_rebuild_keeps_a_column_it_does_not_know_and_its_data(tmp_path: Path) -> None:
    """The profile rebuild's new watchlist_artists has no 'notes' column. The
    hand-kept copy list dropped it and its data; now it carries over."""
    db_path = tmp_path / "old.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE watchlist_artists (       -- pre-profile shape: gets rebuilt
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            spotify_artist_id TEXT UNIQUE,
            artist_name TEXT NOT NULL,
            date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            notes TEXT
        )
    """)
    conn.execute("INSERT INTO watchlist_artists (spotify_artist_id, artist_name, notes) "
                 "VALUES ('sp1', 'Kept', 'seen live 2019')")
    conn.commit()
    conn.close()

    MusicDatabase(str(db_path))

    sql = _query(db_path, "SELECT sql FROM sqlite_master WHERE name = 'watchlist_artists'")[0][0]
    assert "UNIQUE(profile_id, spotify_artist_id)" in sql   # the rebuild did run
    assert _query(db_path, "SELECT artist_name, notes FROM watchlist_artists") == [("Kept", "seen live 2019")]


def test_copy_rows_for_rebuild(tmp_path: Path) -> None:
    db = MusicDatabase.__new__(MusicDatabase)   # just the helper, no init
    conn = sqlite3.connect(str(tmp_path / "copy.db"))
    cur = conn.cursor()
    cur.execute("""CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
                   colour TEXT DEFAULT 'red', unused TEXT, legacy_flag INTEGER NOT NULL DEFAULT 0,
                   stamped TIMESTAMP DEFAULT CURRENT_TIMESTAMP)""")
    cur.execute("INSERT INTO things (id, name, colour, legacy_flag) VALUES (7, 'a', 'blue', 1)")
    cur.execute("INSERT INTO things (id, name) VALUES (9, 'b')")
    cur.execute("""CREATE TABLE things_new (id INTEGER PRIMARY KEY, name TEXT NOT NULL,
                   colour TEXT, added_later TEXT DEFAULT 'later', profile_id INTEGER)""")

    copied = db._copy_rows_for_rebuild(cur, "things", "things_new", expressions={"profile_id": "1"})

    new_cols = [r[1] for r in cur.execute("PRAGMA table_info(things_new)")]
    # shared columns, the expression column, and the old-only columns that
    # hold data; 'unused' is empty everywhere so it's left behind, which is
    # what keeps a fresh install's schema unchanged
    assert copied == ["id", "name", "colour", "profile_id", "legacy_flag", "stamped"]
    assert "unused" not in new_cols
    rows = cur.execute("SELECT id, name, colour, added_later, profile_id, legacy_flag "
                       "FROM things_new ORDER BY id").fetchall()
    assert rows == [(7, "a", "blue", "later", 1, 1), (9, "b", "red", "later", 1, 0)]
    # a carried column keeps its constraint where ALTER allows it...
    flag = next(r for r in cur.execute("PRAGMA table_info(things_new)") if r[1] == "legacy_flag")
    assert (flag[2], flag[3], flag[4]) == ("INTEGER", 1, "0")
    # ...and its values where it doesn't (ALTER can't add a CURRENT_TIMESTAMP default)
    assert cur.execute("SELECT COUNT(*) FROM things_new WHERE stamped IS NULL").fetchone()[0] == 0
    conn.close()


def test_copy_rows_for_rebuild_or_ignore_drops_duplicates(tmp_path: Path) -> None:
    db = MusicDatabase.__new__(MusicDatabase)
    conn = sqlite3.connect(str(tmp_path / "copy.db"))
    cur = conn.cursor()
    cur.execute("CREATE TABLE pairs (id INTEGER PRIMARY KEY, a TEXT, b TEXT)")
    cur.executemany("INSERT INTO pairs (a, b) VALUES (?, ?)", [("x", "y"), ("x", "y"), ("x", "z")])
    cur.execute("CREATE TABLE pairs_new (id INTEGER PRIMARY KEY, a TEXT, b TEXT, UNIQUE(a, b))")

    db._copy_rows_for_rebuild(cur, "pairs", "pairs_new", or_ignore=True)

    assert cur.execute("SELECT id, a, b FROM pairs_new ORDER BY id").fetchall() == [(1, "x", "y"), (3, "x", "z")]
    conn.close()
