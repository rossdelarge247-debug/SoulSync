"""ConfigManager is one object shared by the request threads and ~20
background workers. These tests pin what makes that safe:

- set()/get() and the save path share a lock, so a save never serializes the
  live dict while another thread is changing it.
- The database write and the retry backoff run outside that lock: a slow or
  locked database never stalls readers, and a sleeping retry never stalls
  other threads' saves.
- Writes land in order: a write copies the config only once it holds the
  write lock, so an older copy can never overwrite a newer one.
- batch() is per thread: one thread's batch defers only its own saves.
- get() hands out copies of dicts and lists, never the live ones.

Every wait is on an event with a timeout, never on a sleep.
"""

import json
import threading
import time
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from core.settings import ConfigManager

WAIT = 5  # seconds; only reached when something is genuinely stuck


@pytest.fixture
def manager(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ConfigManager:
    """A ConfigManager on a tmp DB (``DATABASE_PATH``, never the real one)."""
    config_path = tmp_path / "config.json"
    db_path = tmp_path / "database" / "music_library.db"
    monkeypatch.setenv("SOULSYNC_CONFIG_PATH", str(config_path))
    monkeypatch.setenv("DATABASE_PATH", str(db_path))
    mgr = ConfigManager(str(config_path))
    mgr.database_path = db_path
    mgr.config_path = config_path
    mgr.config_data = {"plex": {"base_url": "http://example.test"}}
    assert str(mgr.database_path).startswith(str(tmp_path))
    return mgr


def _start(fn, *args):
    """Run ``fn`` on a daemon thread, keeping any exception on ``.errors``."""
    errors = []

    def run():
        try:
            fn(*args)
        except BaseException as e:  # noqa: BLE001 — reported by the test
            errors.append(e)

    t = threading.Thread(target=run, daemon=True)
    t.errors = errors
    t.start()
    return t


def _is_free(lock) -> bool:
    """True when no other thread holds ``lock`` right now (never blocks)."""
    if lock.acquire(blocking=False):
        lock.release()
        return True
    return False


def test_concurrent_set_get_and_save_leave_a_consistent_config(manager):
    """Writers grow one shared dict while readers copy and serialize the whole
    config, all against the real database. Unlocked, this raised
    "dictionary changed size during iteration" and could persist a
    half-updated config."""
    writers, per_writer, readers = 6, 25, 2
    start = threading.Barrier(writers + readers)
    writers_done = threading.Event()

    def write(i):
        start.wait(WAIT)
        for j in range(per_writer):
            manager.set(f"stress.shared.w{i}_{j}", j)
            manager.set(f"stress.w{i}.k{j}", [i, j])
            assert manager.get(f"stress.w{i}.k{j}") == [i, j]

    def read():
        start.wait(WAIT)
        while not writers_done.is_set():
            json.dumps(manager.get_full_config())
            manager.redacted_config()
            manager.get("stress.shared", {})

    write_threads = [_start(write, i) for i in range(writers)]
    read_threads = [_start(read) for _ in range(readers)]
    for t in write_threads:
        t.join(60)
    writers_done.set()
    for t in read_threads:
        t.join(WAIT)

    threads = write_threads + read_threads
    assert not any(t.is_alive() for t in threads)
    assert [e for t in threads for e in t.errors] == []

    shared = manager.get("stress.shared")
    assert len(shared) == writers * per_writer
    for i in range(writers):
        assert manager.get(f"stress.w{i}") == {f"k{j}": [i, j] for j in range(per_writer)}

    # The last write carried the final state: a fresh load sees all of it.
    reloaded = ConfigManager(str(manager.config_path))
    assert reloaded.get("stress") == manager.get("stress")


def test_save_writes_a_snapshot_without_holding_the_config_lock(manager, monkeypatch):
    """Park a save inside its database write: other threads must still read
    and change the config, and the parked write must be serializing a copy
    that their changes cannot touch."""
    in_write, release = threading.Event(), threading.Event()
    written = []

    def parked_save(data):
        written.append(data)
        if len(written) == 1:
            in_write.set()
            release.wait(WAIT)
        return True

    monkeypatch.setattr(manager, "_save_to_database", parked_save)
    first = _start(manager.set, "plex.base_url", "http://first")
    try:
        assert in_write.wait(WAIT), "the first save never reached the database"
        assert _is_free(manager._sync.lock), "config lock held during the DB write"
        assert manager.get("plex.base_url") == "http://first"
        with manager.batch():  # defer this thread's save until the first is released
            manager.set("plex.base_url", "http://second")
            release.set()
    finally:
        release.set()
    first.join(WAIT)

    assert not first.is_alive() and first.errors == []
    assert len(written) == 2
    # The parked write serialized a copy, untouched by the later set()...
    assert written[0] is not manager.config_data
    assert written[0]["plex"]["base_url"] == "http://first"
    # ...and the newer state was written after it, never underneath it.
    assert written[1]["plex"]["base_url"] == "http://second"


def test_retry_backoff_sleeps_without_blocking_other_threads(manager):
    """While one save sleeps between retries, another thread's save goes
    straight through, and the sleeper then finds its change already written."""
    sleeping, wake = threading.Event(), threading.Event()
    written = []

    def first_attempt_locked(data):
        written.append(data)
        return len(written) > 1  # attempt one: "database is locked"

    def parked_sleep(_delay):
        sleeping.set()
        wake.wait(WAIT)

    # Patch settings' own time reference, never the process-wide time.sleep.
    with patch.object(manager, "_save_to_database", side_effect=first_attempt_locked), \
            patch("core.settings.time", wraps=time) as settings_time:
        settings_time.sleep = Mock(side_effect=parked_sleep)
        first = _start(manager.set, "plex.base_url", "http://first")
        try:
            assert sleeping.wait(WAIT), "the first save never hit its retry backoff"
            assert _is_free(manager._sync.lock), "config lock held while sleeping"
            assert _is_free(manager._sync.save_lock), "write lock held while sleeping"
            manager.set("plex.request_timeout_seconds", 45)
        finally:
            wake.set()
        first.join(WAIT)

    assert not first.is_alive() and first.errors == []
    assert settings_time.sleep.call_count == 1
    # Attempt one failed; this thread's write carried both changes, so the
    # first save's retry had nothing left to write.
    assert len(written) == 2
    assert written[1]["plex"] == {"base_url": "http://first", "request_timeout_seconds": 45}


def test_a_batch_on_one_thread_does_not_hold_back_another_threads_save(manager, monkeypatch):
    writes = []
    monkeypatch.setattr(manager, "_save_to_database", lambda data: writes.append(data) or True)
    in_batch, other_saved = threading.Event(), threading.Event()
    writes_before_exit = []

    def batching():
        with manager.batch():
            manager.set("batch.first", 1)
            in_batch.set()
            other_saved.wait(WAIT)
            manager.set("batch.second", 2)
            writes_before_exit.append(len(writes))

    t = _start(batching)
    try:
        assert in_batch.wait(WAIT)
        manager.set("other.key", "x")  # not in a batch: saves immediately
        assert len(writes) == 1
    finally:
        other_saved.set()
    t.join(WAIT)

    assert not t.is_alive() and t.errors == []
    # The batching thread's own sets stayed deferred until its one exit save.
    assert writes_before_exit == [1]
    assert len(writes) == 2
    assert writes[1]["batch"] == {"first": 1, "second": 2}
    assert writes[1]["other"] == {"key": "x"}


def test_nested_batches_on_one_thread_save_once_at_the_outer_exit(manager, monkeypatch):
    writes = []
    monkeypatch.setattr(manager, "_save_to_database", lambda data: writes.append(data) or True)
    with manager.batch():
        manager.set("nested.a", 1)
        with manager.batch():
            manager.set("nested.b", 2)
        assert writes == []
    assert len(writes) == 1
    assert writes[0]["nested"] == {"a": 1, "b": 2}


def test_get_returns_copies_of_dicts_and_lists(manager):
    """A caller editing what get() returned must not be changing the live
    config behind the lock (and the change would not be saved anyway)."""
    manager.config_data = {"plex": {"base_url": "u", "tags": ["a"]},
                           "library": {"music_paths": ["/music"]}}
    section = manager.get("plex")
    section["base_url"] = "edited"
    section["tags"].append("b")
    manager.get("library.music_paths").append("/elsewhere")

    assert manager.get("plex") == {"base_url": "u", "tags": ["a"]}
    assert manager.get("library.music_paths") == ["/music"]
    # Read-modify-set, the way callers change a section, still works.
    section = manager.get("plex")
    section["base_url"] = "http://new"
    manager.set("plex", section)
    assert manager.get("plex.base_url") == "http://new"
    # Scalars and a missing key's default come back as they are.
    default = {}
    assert manager.get("plex.missing", default) is default
