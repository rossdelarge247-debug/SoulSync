"""The quarantine snapshot on a slow filesystem (Docker Desktop's bind mounts
on Windows: a listing plus a stat of 4,500 files took about 5 s there).

Simulated: 4,500 quarantined files with sidecars, ``os.stat`` and every
directory entry's ``stat()`` sleeping 1 ms, and listing a name costing 0.1 ms.
Pinned here:

* a cold start never makes a request wait on the folder: the first journey
  read answers at once with ``quarantine_ready: false``, and a list read
  beside it isn't held up;
* once the background read has landed, a burst of journey, Activity and list
  reads all answer in well under a second;
* approve and delete take their entries out of the snapshot at once.
"""

from __future__ import annotations

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

FILES = 4500
STAT_DELAY = 0.001
LIST_DELAY = 0.0001


def _fill(folder, n=FILES):
    for i in range(n):
        stem = f"20261101_{i // 3600:02d}{(i // 60) % 60:02d}{i % 60:02d}_song{i}"
        (folder / f"{stem}.flac.quarantined").write_bytes(b"x")
        (folder / f"{stem}.json").write_text(json.dumps({
            "expected_artist": f"Artist {i % 400}", "expected_track": f"Song {i % 1500}",
            "trigger": "acoustid_unverified", "quarantine_reason": "no match",
            "context": {"track_info": {"id": f"sp-{i % 1500}"},
                        "original_search_result": {"username": f"u{i}", "filename": f"f{i}"}},
        }))


class _SlowEntry:
    """A directory entry whose stat() is slow, as on the mount."""

    def __init__(self, entry):
        self._entry = entry
        self.name = entry.name
        self.path = entry.path

    def is_file(self, *a, **k):
        return self._entry.is_file(*a, **k)

    def is_dir(self, *a, **k):
        return self._entry.is_dir(*a, **k)

    def stat(self, *a, **k):
        time.sleep(STAT_DELAY)
        return self._entry.stat(*a, **k)


@pytest.fixture
def slow_fs(monkeypatch):
    real_stat, real_scandir, real_listdir = os.stat, os.scandir, os.listdir
    counts = {"stat": 0, "paths": []}

    def slow_stat(path, *a, **k):
        counts["stat"] += 1
        counts["paths"].append(str(path))
        time.sleep(STAT_DELAY)
        return real_stat(path, *a, **k)

    class SlowScandir:
        def __init__(self, path):
            self._it = real_scandir(path)

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self._it.close()

        def __iter__(self):
            for entry in self._it:
                time.sleep(LIST_DELAY)
                yield _SlowEntry(entry)

        def close(self):
            self._it.close()

    def slow_listdir(path="."):
        names = real_listdir(path)
        time.sleep(LIST_DELAY * len(names))
        return names

    monkeypatch.setattr(os, "stat", slow_stat)
    monkeypatch.setattr(os, "scandir", SlowScandir)
    monkeypatch.setattr(os, "listdir", slow_listdir)
    return counts


@pytest.fixture
def world(tmp_path, monkeypatch):
    """A quarantine of 4,500 files, the journey route and the Activity status
    over a real (temporary) music database."""
    from flask import Flask

    import api.wishlist_routes as routes
    import core.imports.paths as paths
    import core.profile_context as profile_context
    import core.wishlist.journey as journey
    from core.activity import feed
    from database.music_database import MusicDatabase

    folder = tmp_path / "ss_quarantine"
    folder.mkdir()
    _fill(folder)
    db = MusicDatabase(str(tmp_path / "music.db"))
    conn = db._get_connection()
    for i in range(300):
        conn.execute(
            "INSERT INTO wishlist_tracks (spotify_track_id, spotify_data, retry_count, profile_id)"
            " VALUES (?, ?, ?, 1)",
            (f"sp-{i}", json.dumps({"name": f"Song {i}", "artists": [{"name": "A"}]}), i % 5))
    conn.commit()
    conn.close()

    import database.music_database as mdb
    monkeypatch.setattr(mdb, "MusicDatabase", lambda *a, **k: db)
    monkeypatch.setattr(paths, "docker_resolve_path", lambda p: p)
    monkeypatch.setattr(routes, "config_manager",
                        SimpleNamespace(get=lambda key, default=None: str(tmp_path)))
    monkeypatch.setattr(routes, "get_current_profile_id", lambda: 1)
    monkeypatch.setattr(routes, "download_tasks", {})
    monkeypatch.setattr(profile_context, "is_admin_request", lambda: True)
    monkeypatch.setattr(feed, "_quarantine_dir", lambda: str(folder))
    monkeypatch.setattr(feed, "_live_tasks", lambda: {})
    journey._playlist_cache.clear()
    app = Flask(__name__)
    app.register_blueprint(routes.bp)
    viewer = feed.Viewer(profile_id=1, is_admin=True)

    def journey_read():
        return app.test_client().get("/api/wishlist/journey").get_json()

    def activity_read():
        return feed.build_status(db, viewer, live_batches={}, running_automations={})

    def list_read():
        # the Wanted list's read never touches quarantine: the database only
        return db.get_wishlist_tracks(profile_id=1)

    return SimpleNamespace(folder=folder, journey=journey_read, activity=activity_read,
                           list=list_read, db=db)


def _timed(fn):
    started = time.perf_counter()
    result = fn()
    return time.perf_counter() - started, result


def test_a_cold_start_never_waits_on_the_folder(world, slow_fs):
    from core.imports.quarantine_index import shared_index

    took, body = _timed(world.journey)
    assert body["success"] is True and body["quarantine_ready"] is False
    assert took < 0.5, f"the first journey read took {took:.2f}s"
    # the background read is running now; a list read beside it isn't held up
    took_list, rows = _timed(world.list)
    assert len(rows) == 300 and took_list < 0.5, f"the list read took {took_list:.2f}s"
    took_activity, _ = _timed(world.activity)
    assert took_activity < 0.5, f"the Activity read took {took_activity:.2f}s"
    # and the read lands
    snap = shared_index().wait(str(world.folder))
    assert snap.files == FILES


def test_after_warm_up_a_burst_of_reads_all_answer_well_under_a_second(world, slow_fs):
    from core.imports.quarantine_index import shared_index

    started = time.perf_counter()
    shared_index().wait(str(world.folder))
    warm_up = time.perf_counter() - started
    seen_before = len(slow_fs["paths"])

    calls = [world.journey, world.activity, world.list] * 8
    with ThreadPoolExecutor(max_workers=8) as pool:
        timings = list(pool.map(lambda fn: _timed(fn)[0], calls))
    assert max(timings) < 1.0, f"slowest of {len(calls)} reads: {max(timings):.2f}s"
    body = world.journey()
    assert body["quarantine_ready"] is True
    # the songs the quarantine has attempts at show it
    assert body["tracks"]["sp-1"]["quarantine"]["count"] == 3
    # no request statted anything in the quarantine folder: the reads came
    # from the snapshot (the database's own file checks aren't the folder's)
    touched = [p for p in slow_fs["paths"][seen_before:] if "ss_quarantine" in p]
    assert touched == []
    print(f"\nslow FS: warm-up {warm_up:.2f}s (background), burst of {len(calls)}: "
          f"slowest {max(timings) * 1000:.0f} ms, median "
          f"{sorted(timings)[len(timings) // 2] * 1000:.0f} ms")


def test_approve_and_delete_leave_the_snapshot_at_once(world, slow_fs, tmp_path):
    from core.imports.quarantine import approve_quarantine_entry, delete_quarantine_entry
    from core.imports.quarantine_index import shared_index

    folder = str(world.folder)
    shared_index().wait(folder)
    before = world.journey()["tracks"]["sp-2"]["quarantine"]["count"]
    assert before == 3
    held = [r.entry_id for r in shared_index().peek(folder).records
            if "sp-2" in r.track_ids]
    assert delete_quarantine_entry(folder, held[0]) is True
    assert approve_quarantine_entry(folder, held[1], str(tmp_path / "restore")) is not None
    # the next read is right without waiting for the folder to be read again
    assert world.journey()["tracks"]["sp-2"]["quarantine"]["count"] == 1
    assert shared_index().peek(folder).files == FILES - 2
    # and a refresh that listed the folder before the change can't bring them back
    snap = shared_index().refresh_now(folder)
    assert {held[0], held[1]}.isdisjoint(r.entry_id for r in snap.records)


def test_a_clear_empties_the_snapshot_at_once(tmp_path):
    from core.imports.quarantine_index import QuarantineSnapshots, shared_index
    from core.library.cleanup import clear_planned_quarantine

    folder = tmp_path / "ss_quarantine"
    folder.mkdir()
    _fill(folder, 3)
    shared_index().refresh_now(str(folder))
    names = [{"name": n} for n in os.listdir(folder)]
    result = clear_planned_quarantine(str(folder), names)
    assert result["files_removed"] == 3
    assert shared_index().peek(str(folder)).files == 0
    assert isinstance(QuarantineSnapshots().refresh_now(str(folder)).files, int)


def test_only_one_refresh_runs_however_many_ask(tmp_path, slow_fs, monkeypatch):
    import core.imports.quarantine_index as mod

    folder = tmp_path / "ss_quarantine"
    folder.mkdir()
    _fill(folder, 300)
    builds = []
    real = mod.QuarantineSnapshots._build

    def counting(self, d):
        builds.append(threading.get_ident())
        return real(self, d)

    monkeypatch.setattr(mod.QuarantineSnapshots, "_build", counting)
    snaps = mod.QuarantineSnapshots()
    with ThreadPoolExecutor(max_workers=16) as pool:
        answers = list(pool.map(lambda _: snaps.peek(str(folder)), range(64)))
    assert all(a is None for a in answers)  # nobody waited
    snaps.wait(str(folder))
    assert len(builds) == 1

