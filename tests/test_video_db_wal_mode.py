"""The video database is put in WAL mode once, at init, not on every connection.

WAL is stored in the database file. Asking for it on every connection takes a
lock, and on the music side that sat ~250 ms per connection in the busy
backoff while workers were writing; it was moved to init there and here.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import database.video_database as video_database
from database.video_database import VideoDatabase


def _record_statements(monkeypatch) -> list:
    statements = []
    real_connect = sqlite3.connect

    def connect(*args, **kwargs):
        conn = real_connect(*args, **kwargs)
        conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(video_database.sqlite3, "connect", connect)
    return statements


def test_init_puts_the_file_in_wal_mode(tmp_path: Path) -> None:
    db = VideoDatabase(str(tmp_path / "video.db"))
    conn = sqlite3.connect(str(db.database_path))
    try:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    finally:
        conn.close()


def test_a_connection_does_not_ask_for_wal_again(tmp_path: Path, monkeypatch) -> None:
    db = VideoDatabase(str(tmp_path / "video.db"))
    statements = _record_statements(monkeypatch)

    with db.connect() as conn:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1

    pragmas = [s for s in statements if "journal_mode" in s.lower()]
    assert pragmas == ["PRAGMA journal_mode"]   # only the test's own read
