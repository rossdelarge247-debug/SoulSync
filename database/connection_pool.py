"""Reuse sqlite connections without changing what a caller gets.

MusicDatabase._get_connection opened a new connection for every call. Opening
one costs ~3 ms on the real schema (sqlite re-parses ~420 schema objects per
connection); a query on an open one costs a few microseconds. This keeps the
closed connections and hands them out again, under the same rules a fresh
connection gave:

- a checkout belongs to one caller at a time. Nested calls in one thread get
  separate connections and separate transactions, as before.
- a connection goes back when its caller is done with it: on close(), or
  as soon as nothing refers to the PooledConnection or any cursor made
  through it. Leaving a ``with`` block does not return it, because ``conn``
  stays usable after the block. (A sqlite3.Connection nobody closed used to
  wait for the garbage collector: on python 3.11 it sits in a reference
  cycle with its own statement cache. So leftover work is now rolled back
  sooner, never later.)
- going back rolls back whatever the caller left uncommitted (what closing
  did), restores row_factory, text_factory and isolation_level, and sets
  the pragmas it was opened with back if a caller changed them. A
  connection with temp tables or anything else the pool can't reset
  (create_function, set_authorizer, backup, ...: any Connection attribute
  this proxy doesn't define) is closed instead of kept.
- connections stay on the thread that opened them (sqlite3's
  check_same_thread). Each thread keeps at most MAX_IDLE_PER_KEY idle
  connections per database and MAX_IDLE_PER_THREAD in all, and lets go of
  them when it ends.
- a connection is not reused if the database file at that path was replaced
  (different inode), if the process forked, or after invalidate().

What still differs from a new connection: total_changes and
last_insert_rowid() carry over from earlier checkouts (the music database's
callers only diff total_changes within one checkout and never call
last_insert_rowid()), and the page and statement caches are warm.

invalidate() closes every idle connection in every thread and keeps checked
out ones from coming back. Call it on shutdown, before a restore, and after
ANALYZE: sqlite loads the planner statistics when a connection opens and an
ANALYZE on another connection does not reach connections that are already
open, so a kept connection would go on planning with the old statistics.
"""

import gc
import os
import sqlite3
import threading
import weakref

MAX_IDLE_PER_KEY = 3
MAX_IDLE_PER_THREAD = 4

_CLOSED_MESSAGE = "Cannot operate on a closed database."

# connections a forked child inherited. never closed there: closing a
# parent's sqlite connection from a child can break the parent's locks.
_forked_orphans = []

# set while this thread is inside a pool critical section. a checkout freed
# by the garbage collector in the middle of one (or a signal handler that
# shuts down) would otherwise try to take the same lock again.
_busy = threading.local()


def _enter_busy():
    was = getattr(_busy, "active", False)
    _busy.active = True
    return was


def _file_id(path):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (st.st_dev, st.st_ino)


def _close_quietly(raw):
    try:
        raw.close()
    except Exception:  # noqa: S110 - a connection that can't close is dropped anyway
        pass


class _Entry:
    """one open connection and what it was opened with."""

    __slots__ = ("raw", "key", "thread_id", "pid", "epoch", "file_id", "defaults", "pragmas")

    def __init__(self, raw, key, ticket, pragmas):
        self.raw = raw
        self.key = key
        self.thread_id = threading.get_ident()
        self.pid = os.getpid()
        self.epoch, self.file_id = ticket
        self.defaults = (raw.row_factory, raw.text_factory, raw.isolation_level)
        self.pragmas = tuple((f"PRAGMA {name}", value, f"PRAGMA {name} = {value}")
                             for name, value in pragmas)


class _ThreadIdle:
    """one thread's idle connections, oldest first."""

    __slots__ = ("lock", "entries", "__weakref__")

    def __init__(self):
        self.lock = threading.Lock()
        self.entries = []


class _Lease:
    """one checkout. the PooledConnection and every cursor made through it
    hold it, so the connection goes back when the last of them is gone."""

    __slots__ = ("pool", "entry", "poolable", "cursors", "prune_at")

    def __init__(self, pool, entry, poolable):
        self.pool = pool
        self.entry = entry
        self.poolable = poolable
        self.cursors = []
        self.prune_at = 32

    def track(self, cursor):
        cursors = self.cursors
        if len(cursors) >= self.prune_at:
            # a loop of conn.execute() makes a cursor per call
            cursors[:] = [ref for ref in cursors if ref() is not None]
            self.prune_at = max(32, 2 * len(cursors))
        cursors.append(weakref.ref(cursor))

    def end(self, close_cursors):
        entry = self.entry
        if entry is None:
            return
        self.entry = None
        if close_cursors:
            # close() on a connection made its cursors unusable; keep that,
            # so nobody reads through a cursor on a connection that is now
            # someone else's
            for ref in self.cursors:
                cursor = ref()
                if cursor is not None:
                    try:
                        cursor.close()
                    except Exception:  # noqa: BLE001 - wrong thread or already closed
                        self.poolable = False
        self.cursors = []
        self.pool._check_in(entry, self.poolable)

    def __del__(self):
        try:
            self.end(close_cursors=False)
        except Exception:  # noqa: BLE001,S110 - nothing can be raised from __del__
            pass


class _LeasedCursor(sqlite3.Cursor):
    __slots__ = ("_pool_lease",)


class PooledConnection:
    """What _get_connection returns: a sqlite3.Connection stand-in that
    gives its connection back to the pool instead of closing it. Same
    methods and attributes; it is not a sqlite3.Connection subclass."""

    __slots__ = ("_raw", "_lease", "__weakref__")

    def __init__(self, lease):
        self._lease = lease
        self._raw = lease.entry.raw

    def _live(self):
        raw = self._raw
        if raw is None:
            raise sqlite3.ProgrammingError(_CLOSED_MESSAGE)
        return raw

    def cursor(self, factory=None):
        raw = self._live()
        lease = self._lease
        cursor = raw.cursor(factory or _LeasedCursor)
        try:
            cursor._pool_lease = lease
        except AttributeError:
            # a factory whose cursors can't hold it: close the connection
            # when the checkout ends instead of reusing it
            lease.poolable = False
        lease.track(cursor)
        return cursor

    def execute(self, sql, parameters=(), /):
        return self.cursor().execute(sql, parameters)

    def executemany(self, sql, parameters, /):
        return self.cursor().executemany(sql, parameters)

    def executescript(self, sql_script, /):
        return self.cursor().executescript(sql_script)

    def commit(self):
        self._live().commit()

    def rollback(self):
        self._live().rollback()

    def close(self):
        lease = self._lease
        if lease is None:
            return
        entry = lease.entry
        if entry is not None and entry.thread_id != threading.get_ident():
            self._raw.close()  # sqlite3's own wrong-thread error, as before
        self._lease = None
        self._raw = None
        lease.end(close_cursors=True)

    def __enter__(self):
        self._live()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return self._live().__exit__(exc_type, exc_value, traceback)

    @property
    def row_factory(self):
        return self._live().row_factory

    @row_factory.setter
    def row_factory(self, value):
        self._live().row_factory = value

    @property
    def text_factory(self):
        return self._live().text_factory

    @text_factory.setter
    def text_factory(self, value):
        self._live().text_factory = value

    @property
    def isolation_level(self):
        return self._live().isolation_level

    @isolation_level.setter
    def isolation_level(self, value):
        self._live().isolation_level = value

    @property
    def in_transaction(self):
        return self._live().in_transaction

    @property
    def total_changes(self):
        return self._live().total_changes

    def __getattr__(self, name):
        # anything else (create_function, set_authorizer, backup, iterdump,
        # blobopen, ...) works on the real connection, but may leave state
        # behind or hand out objects tied to it, so this checkout is closed
        # at the end instead of reused
        if name in ("_raw", "_lease"):
            raise AttributeError(name)
        value = getattr(self._live(), name)
        self._lease.poolable = False
        return value

    def __repr__(self):
        return f"<PooledConnection {self._raw!r}>"


class ConnectionPool:
    """idle sqlite connections per thread, keyed by database path."""

    def __init__(self, max_idle_per_key=MAX_IDLE_PER_KEY, max_idle_per_thread=MAX_IDLE_PER_THREAD):
        self.max_idle_per_key = max_idle_per_key
        self.max_idle_per_thread = max_idle_per_thread
        self._epoch = 0
        self._local = threading.local()
        self._registry = weakref.WeakSet()
        self._registry_lock = threading.RLock()  # see invalidate()

    def ticket(self, key):
        """take before opening a connection for ``key``; hand to wrap(). Read
        before the open so an invalidate() or file swap during the open
        counts against the new connection rather than being missed."""
        return (self._epoch, _file_id(key))

    def wrap(self, raw, key, ticket, pragmas=()):
        """a PooledConnection for a connection just opened for ``key``.
        ``pragmas`` are (name, value) pairs it was opened with, value as
        ``PRAGMA name`` reads it back; each is set again on reuse if a
        caller changed it."""
        entry = _Entry(raw, key, ticket, pragmas)
        return PooledConnection(_Lease(self, entry, poolable=entry.file_id is not None))

    def checkout(self, key):
        """an idle connection for ``key`` opened by this thread, or None."""
        idle = getattr(self._local, "idle", None)
        if idle is None or not idle.entries:
            return None
        while True:
            entry = None
            was_busy = _enter_busy()
            try:
                with idle.lock:
                    entries = idle.entries
                    for i in range(len(entries) - 1, -1, -1):
                        if entries[i].key == key:
                            entry = entries.pop(i)
                            break
            finally:
                _busy.active = was_busy
            if entry is None:
                return None
            if entry.pid != os.getpid():
                _forked_orphans.append(entry)
                continue
            if entry.epoch != self._epoch or entry.file_id != _file_id(key):
                _close_quietly(entry.raw)
                continue
            return PooledConnection(_Lease(self, entry, poolable=True))

    def _check_in(self, entry, poolable):
        if entry.pid != os.getpid():
            _forked_orphans.append(entry)
            return
        if entry.thread_id != threading.get_ident():
            # let go of on another thread (passed there, or collected
            # there). sqlite3 won't let this thread call it; the garbage
            # collector closes it, which is what happened before
            return
        raw = entry.raw
        keep = poolable and entry.epoch == self._epoch
        try:
            if raw.in_transaction:
                raw.rollback()
            if keep:
                raw.row_factory, raw.text_factory, raw.isolation_level = entry.defaults
                if raw.execute("SELECT 1 FROM temp.sqlite_master LIMIT 1").fetchone() is not None:
                    keep = False  # temp tables die with the connection; keep it that way
            if keep:
                # read first: setting a flag pragma like foreign_keys, even to
                # the value it has, expires every prepared statement on the
                # connection, and the statement cache is half the point
                for read, value, write in entry.pragmas:
                    row = raw.execute(read).fetchone()
                    if row is None or row[0] != value:
                        raw.execute(write)
        except Exception:  # noqa: BLE001 - anything odd: close it, as before
            keep = False
        if keep:
            # inside a pool critical section on this thread already (freed
            # by the garbage collector there): parking would take its lock
            keep = not getattr(_busy, "active", False) and self._park(entry)
        if not keep:
            _close_quietly(raw)

    def _park(self, entry):
        idle = getattr(self._local, "idle", None)
        if idle is None:
            idle = _ThreadIdle()
            self._local.idle = idle
            with self._registry_lock:
                self._registry.add(idle)
        evicted = None
        was_busy = _enter_busy()
        try:
            with idle.lock:
                if entry.epoch != self._epoch:
                    return False
                entries = idle.entries
                if sum(1 for e in entries if e.key == entry.key) >= self.max_idle_per_key:
                    return False
                entries.append(entry)
                if len(entries) > self.max_idle_per_thread:
                    evicted = entries.pop(0)
        finally:
            _busy.active = was_busy
        if evicted is not None:
            _close_quietly(evicted.raw)
        return True

    def invalidate(self, collect=False):
        """close every idle connection, in every thread, and close checked
        out ones when they come back instead of keeping them.

        another thread's connection can't be closed from here (sqlite3's
        thread check), only let go of, and a python 3.11 sqlite3.Connection
        sits in a reference cycle with its own statement cache, so it closes
        when the garbage collector next runs. ``collect`` runs it now."""
        with self._registry_lock:
            self._epoch += 1
            containers = list(self._registry)
        own = getattr(self._local, "idle", None)
        dropped = []
        was_busy = _enter_busy()
        try:
            for idle in containers:
                if was_busy and idle is own:
                    # a signal handler that interrupted this thread inside
                    # the pool: its lock may be held. the new epoch already
                    # keeps those connections from being reused.
                    continue
                with idle.lock:
                    dropped.extend(idle.entries)
                    idle.entries.clear()
        finally:
            _busy.active = was_busy
        me, pid = threading.get_ident(), os.getpid()
        others = False
        for entry in dropped:
            if entry.pid != pid:
                _forked_orphans.append(entry)
            elif entry.thread_id == me:
                _close_quietly(entry.raw)
            else:
                others = True  # nobody else holds an idle connection
        entry = None
        dropped.clear()
        if others and collect:
            gc.collect()

    def idle_count(self, key=None):
        """idle connections this thread holds (for ``key``, or all)."""
        idle = getattr(self._local, "idle", None)
        entries = list(idle.entries) if idle is not None else []
        return sum(1 for e in entries if key is None or e.key == key)
