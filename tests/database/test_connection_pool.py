"""MusicDatabase._get_connection reuses connections without changing what a
caller gets (database/connection_pool.py).

a connection is only handed out again once its last user is done with it,
with leftover work rolled back and per-connection settings back to how a new
connection starts. these tests pin each of those, plus thread confinement and
closing the kept connections (shutdown, restore, ANALYZE, a replaced file).
"""

import os
import sqlite3
import threading
import types

import pytest

import database.connection_pool as cp
import database.music_database as mdb
from database.music_database import MusicDatabase, close_pooled_connections


@pytest.fixture(scope="module")
def _template(tmp_path_factory):
    path = tmp_path_factory.mktemp("pool") / "template.db"
    MusicDatabase(str(path))
    close_pooled_connections()
    return path


def _copy(src, dst, journal_mode=None):
    """a consistent copy, whatever is still in src's wal"""
    source, target = sqlite3.connect(src), sqlite3.connect(dst)
    source.backup(target)
    if journal_mode:
        target.execute(f"PRAGMA journal_mode = {journal_mode}")
    source.close()
    target.close()


def _music_db(template, path):
    _copy(template, path)
    mdb._database_initialized_paths.add(str(path.resolve()))  # schema is in the copy
    return MusicDatabase(str(path))


@pytest.fixture
def db(_template, tmp_path):
    return _music_db(_template, tmp_path / "music.db")


def _raw(conn):
    return conn._raw


def _idle(db):
    return mdb._connection_pool.idle_count(str(db.database_path))


def _is_closed(raw):
    try:
        raw.total_changes
    except sqlite3.ProgrammingError:
        return True
    return False


# --- reuse ------------------------------------------------------------------

def test_a_closed_connection_is_handed_out_again(db):
    first = db._get_connection()
    raw = _raw(first)
    first.close()
    assert _idle(db) == 1

    second = db._get_connection()
    assert _raw(second) is raw
    assert _idle(db) == 0


def test_a_connection_nobody_refers_to_goes_back_without_close(db):
    def a_method_that_never_closes():
        conn = db._get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT 1 FROM tracks WHERE id = ?", ("x",))
        return cursor.fetchone(), id(_raw(conn))

    _, raw_id = a_method_that_never_closes()
    conn = db._get_connection()
    assert id(_raw(conn)) == raw_id


def test_leaving_a_with_block_does_not_hand_the_connection_out(db):
    with db._get_connection() as conn:
        conn.execute("SELECT 1").fetchone()
    raw = _raw(conn)
    other = db._get_connection()
    assert _raw(other) is not raw
    assert conn.execute("SELECT 2").fetchone()[0] == 2  # still usable after the block
    del conn
    assert _idle(db) == 1  # back once nothing refers to it
    again = db._get_connection()
    assert _raw(again) is raw


def test_nested_calls_get_separate_connections_and_transactions(db):
    outer = db._get_connection()
    outer.execute("INSERT INTO metadata (key, value) VALUES ('nested', 'outer')")
    inner = db._get_connection()
    assert _raw(inner) is not _raw(outer)
    assert outer.in_transaction and not inner.in_transaction
    # the outer write is not visible to the inner connection until committed
    assert inner.execute("SELECT 1 FROM metadata WHERE key = 'nested'").fetchone() is None
    outer.commit()
    assert inner.execute("SELECT 1 FROM metadata WHERE key = 'nested'").fetchone() is not None


def test_a_method_called_inside_a_checkout_gets_its_own_connection(db):
    db.set_metadata("other", "2")
    holder = db._get_connection()
    holder.execute("INSERT INTO metadata (key, value) VALUES ('held', '1')")
    # the nested calls read on connections of their own: they can't see the
    # holder's uncommitted row, and giving theirs back doesn't touch it
    assert db.get_metadata("held") is None
    assert db.get_metadata("other") == "2"
    assert holder.in_transaction
    holder.commit()
    assert db.get_metadata("held") == "1"


# --- reset before reuse -----------------------------------------------------

def test_uncommitted_work_is_rolled_back_and_the_lock_released(db):
    conn = db._get_connection()
    raw = _raw(conn)
    conn.execute("INSERT INTO metadata (key, value) VALUES ('left', 'over')")
    assert conn.in_transaction
    del conn  # never committed, never closed

    # the write lock is free right away: another connection can take it
    # without waiting
    probe = sqlite3.connect(str(db.database_path), timeout=0)
    probe.execute("BEGIN IMMEDIATE")
    probe.rollback()
    probe.close()

    again = db._get_connection()
    assert _raw(again) is raw
    assert not again.in_transaction
    assert again.execute("SELECT 1 FROM metadata WHERE key = 'left'").fetchone() is None


def test_connection_settings_a_caller_changed_do_not_reach_the_next_caller(db):
    conn = db._get_connection()
    raw = _raw(conn)
    conn.row_factory = None
    conn.text_factory = bytes
    conn.isolation_level = None
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("PRAGMA busy_timeout = 10")
    conn.close()

    again = db._get_connection()
    assert _raw(again) is raw
    assert again.row_factory is sqlite3.Row
    assert again.text_factory is str
    assert again.isolation_level == ""
    assert again.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert again.execute("PRAGMA busy_timeout").fetchone()[0] == 30000
    assert isinstance(again.execute("SELECT 'x' AS v").fetchone()["v"], str)


def test_unchanged_pragmas_are_read_not_set_again(db):
    # setting foreign_keys, even to its current value, throws away every
    # prepared statement on the connection
    conn = db._get_connection()
    raw = _raw(conn)
    seen = []
    raw.set_trace_callback(seen.append)
    conn.close()
    raw.set_trace_callback(None)
    assert "PRAGMA foreign_keys" in seen
    assert not any("=" in sql for sql in seen if sql.startswith("PRAGMA")), seen


def test_a_connection_with_temp_tables_is_closed_not_kept(db):
    conn = db._get_connection()
    raw = _raw(conn)
    conn.execute("CREATE TEMP TABLE scratch (v TEXT PRIMARY KEY)")
    conn.close()
    assert _is_closed(raw)
    again = db._get_connection()
    assert _raw(again) is not raw
    # the next caller can create the same temp table, as with a new connection
    again.execute("CREATE TEMP TABLE scratch (v TEXT PRIMARY KEY)")


def test_state_the_pool_cannot_reset_closes_the_connection(db):
    conn = db._get_connection()
    raw = _raw(conn)
    conn.create_function("norm_text", 1, lambda x: "overridden")
    conn.close()
    assert _is_closed(raw)
    again = db._get_connection()
    assert again.execute("SELECT norm_text('Abc')").fetchone()[0] != "overridden"


# --- cursors ----------------------------------------------------------------

def test_a_live_cursor_keeps_its_connection_out_of_the_pool(db):
    cursor = db._get_connection().execute("SELECT 1 UNION SELECT 2")  # proxy dropped at once
    raw = cursor.connection
    other = db._get_connection()
    assert _raw(other) is not raw
    assert [r[0] for r in cursor.fetchall()] == [1, 2]
    other.close()
    del other, cursor
    again = db._get_connection()
    assert _raw(again) is raw


def test_close_makes_live_cursors_unusable_and_keeps_their_results(db):
    conn = db._get_connection()
    raw = _raw(conn)
    cursor = conn.cursor()
    cursor.execute("INSERT INTO metadata (key, value) VALUES ('a', '1'), ('b', '2')")
    conn.commit()
    reader = conn.execute("SELECT key FROM metadata")
    conn.close()
    assert cursor.rowcount == 2 and cursor.lastrowid  # read after close, as before
    with pytest.raises(sqlite3.ProgrammingError):
        reader.fetchall()
    again = db._get_connection()
    assert _raw(again) is raw


def test_a_loop_of_execute_calls_keeps_the_cursor_bookkeeping_small(db):
    conn = db._get_connection()
    for _ in range(1000):
        conn.execute("SELECT 1").fetchone()
    assert len(conn._lease.cursors) <= 64


def test_a_closed_connection_refuses_use_like_sqlite3(db):
    conn = db._get_connection()
    conn.close()
    conn.close()  # twice is fine
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")
    with pytest.raises(sqlite3.ProgrammingError):
        conn.cursor()
    with pytest.raises(sqlite3.ProgrammingError):
        with conn:
            pass


# --- threads ----------------------------------------------------------------

def _in_thread(fn):
    out = {}

    def run():
        try:
            out["value"] = fn()
        except BaseException as e:  # noqa: BLE001 - re-raised below
            out["error"] = e

    t = threading.Thread(target=run)
    t.start()
    t.join()
    if "error" in out:
        raise out["error"]
    return out.get("value")


def test_connections_stay_on_the_thread_that_opened_them(db):
    def pool_one():
        conn = db._get_connection()
        raw = _raw(conn)
        conn.close()
        return raw, _idle(db)

    theirs, idle_there = _in_thread(pool_one)
    assert idle_there == 1
    assert _idle(db) == 0
    conn = db._get_connection()
    assert _raw(conn) is not theirs


def test_a_connection_let_go_of_on_another_thread_is_not_kept(db):
    conn = db._get_connection()
    raw = _raw(conn)
    box = [conn]
    del conn
    _in_thread(box.clear)  # last reference dropped over there: no error
    assert _idle(db) == 0
    assert _in_thread(lambda: _idle(db)) == 0
    again = db._get_connection()
    assert _raw(again) is not raw


def test_closing_from_another_thread_fails_as_before(db):
    conn = db._get_connection()
    with pytest.raises(sqlite3.ProgrammingError):
        _in_thread(conn.close)
    assert conn.execute("SELECT 1").fetchone()[0] == 1  # still open here


def test_idle_connections_are_capped_per_database_and_per_thread(db, _template, tmp_path):
    held = [db._get_connection() for _ in range(cp.MAX_IDLE_PER_KEY + 2)]
    del held
    assert _idle(db) == cp.MAX_IDLE_PER_KEY

    others = []
    for i in range(cp.MAX_IDLE_PER_THREAD):
        other = _music_db(_template, tmp_path / f"other{i}.db")
        others.append(other)
        other._get_connection().close()
    assert mdb._connection_pool.idle_count() == cp.MAX_IDLE_PER_THREAD
    assert mdb._connection_pool.idle_count(str(others[-1].database_path)) == 1


def test_a_checkout_freed_inside_a_pool_critical_section_is_closed_not_kept(db):
    # the garbage collector can free a checkout while this thread is inside
    # the pool holding its lock; parking it then would deadlock
    conn = db._get_connection()
    raw = _raw(conn)
    was = cp._enter_busy()
    try:
        del conn
    finally:
        cp._busy.active = was
    assert _is_closed(raw)
    assert _idle(db) == 0


# --- closing the kept connections -------------------------------------------

def test_close_pooled_connections_closes_this_threads_idle_ones(db):
    conn = db._get_connection()
    raw = _raw(conn)
    checked_out = db._get_connection()
    out_raw = _raw(checked_out)
    conn.close()
    close_pooled_connections()
    assert _is_closed(raw)
    checked_out.close()  # out during the close: not kept afterwards either
    assert _is_closed(out_raw)
    assert _idle(db) == 0


def _open_files(path):
    fd_dir = "/proc/self/fd"
    if not os.path.isdir(fd_dir):
        pytest.skip("needs /proc/self/fd")
    names = []
    for fd in os.listdir(fd_dir):
        try:
            names.append(os.readlink(os.path.join(fd_dir, fd)))
        except OSError:
            pass
    return [n for n in names if n.startswith(str(path))]


def test_close_pooled_connections_reaches_other_threads(db):
    parked = threading.Event()
    done = threading.Event()
    after = {}

    def worker():
        db._get_connection().close()
        parked.set()
        done.wait(10)
        after["idle"] = _idle(db)

    t = threading.Thread(target=worker)
    t.start()
    try:
        assert parked.wait(10)
        assert _open_files(db.database_path), "the worker's kept connection holds the file"
        close_pooled_connections(collect=True)
        assert _open_files(db.database_path) == []
    finally:
        done.set()
        t.join()
    assert after["idle"] == 0


def test_a_shutdown_that_interrupts_the_pool_on_its_thread_does_not_hang(db):
    # a direct run shuts down from a signal handler, which runs on the main
    # thread between two bytecodes: possibly while the pool holds its lock
    result = {}

    def scenario():
        conn = db._get_connection()
        raw = _raw(conn)
        conn.close()
        idle = mdb._connection_pool._local.idle
        was = cp._enter_busy()
        try:
            with idle.lock:
                close_pooled_connections()
        finally:
            cp._busy.active = was
        result["reused"] = _raw(db._get_connection()) is raw
        result["closed"] = _is_closed(raw)

    t = threading.Thread(target=scenario, daemon=True)
    t.start()
    t.join(10)
    assert not t.is_alive(), "close_pooled_connections deadlocked"
    assert result == {"reused": False, "closed": True}


def test_close_database_closes_the_kept_connections(db, monkeypatch):
    monkeypatch.setattr(mdb, "_database_instances", {})
    conn = db._get_connection()
    raw = _raw(conn)
    conn.close()
    mdb.close_database()  # what the backup restore calls first
    assert _is_closed(raw)


def test_analyze_closes_the_kept_connections(db):
    # an open connection keeps the planner statistics it opened with
    conn = db._get_connection()
    raw = _raw(conn)
    conn.close()
    db.refresh_planner_stats()
    assert _is_closed(raw)
    again = db._get_connection()
    assert _raw(again) is not raw


def test_a_replaced_database_file_is_not_served_from_a_kept_connection(db, tmp_path):
    conn = db._get_connection()
    raw = _raw(conn)
    conn.close()

    replacement = tmp_path / "replacement.db"
    # rollback journal, so the old file's -wal/-shm don't apply to it
    _copy(db.database_path, replacement, journal_mode="DELETE")
    side = sqlite3.connect(replacement)
    side.execute("INSERT INTO metadata (key, value) VALUES ('from', 'replacement')")
    side.commit()
    side.close()
    os.replace(replacement, db.database_path)

    again = db._get_connection()
    assert _raw(again) is not raw
    assert _is_closed(raw)
    assert again.execute("SELECT value FROM metadata WHERE key = 'from'").fetchone()[0] == "replacement"


def test_a_forked_child_does_not_reuse_or_close_the_parents_connections(db, monkeypatch):
    conn = db._get_connection()
    raw = _raw(conn)
    conn.close()
    child_pid = os.getpid() + 1
    monkeypatch.setattr(cp, "os", types.SimpleNamespace(getpid=lambda: child_pid, stat=os.stat))
    try:
        child = db._get_connection()
        assert _raw(child) is not raw
        assert not _is_closed(raw)  # left alone, not closed from the "child"
        assert any(entry.raw is raw for entry in cp._forked_orphans)
        child.close()
        close_pooled_connections()
    finally:
        monkeypatch.undo()
        cp._forked_orphans[:] = [e for e in cp._forked_orphans if e.raw is not raw]
        raw.close()


def test_the_stand_in_covers_the_connection_methods_callers_use(db):
    conn = db._get_connection()
    before = conn.total_changes
    conn.executemany("INSERT INTO metadata (key, value) VALUES (?, ?)", [("m1", "1"), ("m2", "2")])
    assert conn.total_changes - before == 2
    conn.commit()
    conn.executescript("UPDATE metadata SET value = 'x' WHERE key = 'm1';")
    assert conn.execute("SELECT value FROM metadata WHERE key = 'm1'").fetchone()["value"] == "x"
    with conn:
        conn.execute("DELETE FROM metadata WHERE key IN ('m1', 'm2')")
    assert not conn.in_transaction
    assert "PooledConnection" in repr(conn)


def test_the_pool_can_be_turned_off(db, monkeypatch):
    monkeypatch.setattr(mdb, "_CONNECTION_POOL_ENABLED", False)
    conn = db._get_connection()
    assert type(conn) is sqlite3.Connection
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    conn.close()
    assert _idle(db) == 0
