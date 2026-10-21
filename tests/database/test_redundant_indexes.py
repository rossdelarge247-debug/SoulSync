"""No index repeats another index on the same table.

An index that is an exact copy of a UNIQUE constraint's index, or the leading
columns of a longer index, answers no query the longer one doesn't, and every
insert and delete still writes it. MusicDatabase._REDUNDANT_INDEXES lists the
ones a review of the schema found; a fresh install no longer creates them, and
_drop_redundant_indexes drops them from existing databases, each only when that
database has the covering index.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from database.music_database import MusicDatabase


def _indexes(db_path: Path) -> dict:
    conn = sqlite3.connect(str(db_path))
    try:
        return dict(conn.execute("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'").fetchall())
    finally:
        conn.close()


def test_a_fresh_install_has_no_index_another_one_covers(tmp_path: Path) -> None:
    db_path = tmp_path / "fresh.db"
    MusicDatabase(str(db_path))

    conn = sqlite3.connect(str(db_path))
    try:
        cursor = conn.cursor()
        covered = []
        for name, table in conn.execute("SELECT name, tbl_name FROM sqlite_master "
                                        "WHERE type = 'index' AND sql IS NOT NULL").fetchall():
            other = MusicDatabase._covering_index(cursor, table, name)
            if other:
                covered.append(f"{name} on {table} (covered by {other})")
    finally:
        conn.close()
    assert covered == []
    assert not set(MusicDatabase._REDUNDANT_INDEXES) & set(_indexes(db_path))


def test_an_existing_database_loses_them_where_something_covers_them(tmp_path: Path) -> None:
    """An upgraded database still has the indexes; init drops each one whose
    covering index this database really has. watchlist_labels here predates
    its UNIQUE constraint, so its index on the same column is the only one and
    stays."""
    db_path = tmp_path / "old.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE watchlist_labels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            musicbrainz_label_id TEXT,
            label_name TEXT NOT NULL
        )
    """)
    conn.commit()
    conn.close()
    db = MusicDatabase(str(db_path))

    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("CREATE INDEX idx_wishlist_profile ON wishlist_tracks (profile_id)")
        conn.execute("CREATE INDEX idx_tracks_server_source ON tracks (server_source)")
        conn.execute("CREATE INDEX idx_mce_lookup ON metadata_cache_entities (source, entity_type, entity_id)")
        conn.execute("CREATE INDEX idx_watchlist_labels_mbid ON watchlist_labels (musicbrainz_label_id)")
        conn.commit()
    finally:
        conn.close()

    db._initialize_database()

    indexes = _indexes(db_path)
    assert "idx_wishlist_profile" not in indexes           # UNIQUE(profile_id, spotify_track_id)
    assert "idx_tracks_server_source" not in indexes       # idx_tracks_source_owner
    assert "idx_mce_lookup" not in indexes                  # UNIQUE(source, entity_type, entity_id)
    assert {"idx_tracks_source_owner", "idx_tracks_source_updated"} <= set(indexes)
    assert indexes["idx_watchlist_labels_mbid"] == "watchlist_labels"
    assert db.schema_health() == {"ok": True, "failed_steps": []}


def test_covering_index_rules(tmp_path: Path) -> None:
    conn = sqlite3.connect(str(tmp_path / "rules.db"))
    cur = conn.cursor()
    cur.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT, c TEXT, UNIQUE(a, b))")
    cur.execute("CREATE INDEX t_a ON t (a)")                         # prefix of UNIQUE(a, b)
    cur.execute("CREATE INDEX t_a_nocase ON t (a COLLATE NOCASE)")   # other collation
    cur.execute("CREATE INDEX t_b ON t (b)")                         # second column, not a prefix
    cur.execute("CREATE UNIQUE INDEX t_c_unique ON t (c)")
    cur.execute("CREATE INDEX t_c_d ON t (c, b)")                    # longer, but not unique
    cur.execute("CREATE INDEX t_partial ON t (a) WHERE c IS NOT NULL")
    cur.execute("CREATE INDEX t_lower ON t (LOWER(a))")

    covering = MusicDatabase._covering_index
    assert covering(cur, "t", "t_a") == "sqlite_autoindex_t_1"
    assert covering(cur, "t", "t_a_nocase") is None
    assert covering(cur, "t", "t_b") is None
    assert covering(cur, "t", "t_c_unique") is None      # its uniqueness is a constraint
    assert covering(cur, "t", "t_partial") is None
    assert covering(cur, "t", "t_lower") is None
    assert covering(cur, "t", "missing") is None
