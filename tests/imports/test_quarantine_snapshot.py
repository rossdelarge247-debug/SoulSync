"""The shared quarantine snapshot's edges (core/imports/quarantine_index.py).

Pinned here: a person's action (approve, delete, the one-song list) sees the
folder as it is now, not an old snapshot; ``wait(fresh=True)`` never settles
for a refresh that started before it; a listing that fails keeps what was
there (and a missing folder is simply empty); a hung refresh doesn't block the
next one for ever; the Downloads list and the badge agree; a clear forgets only
what it deleted; and the journey's playlist figures are read again after a
mirror or a sync.
"""

from __future__ import annotations

import json
import os
import threading
import time
from types import SimpleNamespace

import pytest

from core.imports import quarantine_index as qi


def _put(folder, stem, track="Song", artist="A", sid="sid1"):
    (folder / f"{stem}.flac.quarantined").write_bytes(b"x")
    (folder / f"{stem}.json").write_text(json.dumps({
        "expected_artist": artist, "expected_track": track,
        "context": {"track_info": {"spotify_track_id": sid}},
    }))


@pytest.fixture
def folder(tmp_path):
    path = tmp_path / "ss_quarantine"
    path.mkdir()
    return path


# ── M1: user actions read the folder as it is now ────────────────────────────

def test_siblings_include_an_attempt_quarantined_after_the_last_snapshot(folder):
    from core.imports.quarantine import find_quarantine_siblings

    _put(folder, "20261101_100000_a")
    qi.shared_index().refresh_now(str(folder))
    _put(folder, "20261101_100005_b")  # after the snapshot
    qi.shared_index().invalidate(str(folder))
    assert find_quarantine_siblings(str(folder), "20261101_100000_a") == ["20261101_100005_b"]


@pytest.fixture
def client(tmp_path, folder, monkeypatch):
    from flask import Flask

    import api.quarantine as routes
    settings = {"soulseek.download_path": str(tmp_path)}
    monkeypatch.setattr(routes, "config_manager",
                        SimpleNamespace(get=lambda key, default=None: settings.get(key, default)))
    monkeypatch.setattr(routes, "docker_resolve_path", lambda p: p)
    app = Flask(__name__)
    app.register_blueprint(routes.bp)
    return app.test_client()


def test_delete_with_siblings_removes_one_quarantined_after_the_snapshot(folder, client):
    _put(folder, "20261101_100000_a")
    qi.shared_index().refresh_now(str(folder))
    _put(folder, "20261101_100005_b")
    body = client.delete("/api/quarantine/20261101_100000_a?siblings=1").get_json()
    assert body == {"success": True, "deleted": 2}
    assert [n for n in os.listdir(folder) if n.endswith(".quarantined")] == []


def test_approve_removes_a_sibling_quarantined_after_the_snapshot(folder, client, monkeypatch,
                                                                  tmp_path):
    import api.quarantine as routes
    monkeypatch.setattr(routes, "_post_process_matched_download", lambda *a, **k: None,
                        raising=False)
    # a full sidecar, so one-click approve works
    (folder / "20261101_100000_a.flac.quarantined").write_bytes(b"x")
    (folder / "20261101_100000_a.json").write_text(json.dumps({
        "expected_artist": "A", "expected_track": "Song", "trigger": "acoustid_unverified",
        "original_filename": "Song.flac",
        "context": {"track_info": {"spotify_track_id": "sid1"}}}))
    qi.shared_index().refresh_now(str(folder))
    _put(folder, "20261101_100005_b")
    body = client.post("/api/quarantine/20261101_100000_a/approve",
                       json={"remove_siblings": True}).get_json()
    assert body["success"] is True
    assert body["removed_siblings"] == ["20261101_100005_b"]


def test_the_one_song_list_has_a_just_quarantined_attempt_with_its_size(folder, client):
    _put(folder, "20261101_100000_a")
    qi.shared_index().refresh_now(str(folder))
    _put(folder, "20261101_100005_b")
    entries = client.get("/api/quarantine/list?entry=20261101_100000_a").get_json()["entries"]
    assert [(e["id"], e["size_bytes"]) for e in entries] == [
        ("20261101_100005_b", 1), ("20261101_100000_a", 1)]


# ── M2: a fresh wait never settles for a refresh that started before it ─────

def test_a_fresh_wait_runs_another_refresh_after_one_already_in_flight(folder):
    snaps = qi.QuarantineSnapshots()
    real = snaps._build
    gate = threading.Event()

    def slow_build(path):
        snap = real(path)  # lists now: before the new file
        gate.wait(2)
        return snap

    snaps._build = slow_build
    snaps._kick(qi._norm(str(folder)))  # a refresh in flight
    time.sleep(0.2)
    _put(folder, "20261101_120000_new")
    threading.Timer(0.3, gate.set).start()
    snap = snaps.wait(str(folder), fresh=True, timeout=10)
    assert [r.entry_id for r in snap.records] == ["20261101_120000_new"]


# ── M3: a failed listing keeps what was there ────────────────────────────────

def test_a_failed_listing_keeps_the_last_snapshot(folder, monkeypatch):
    _put(folder, "20261101_100000_x")
    snaps = qi.QuarantineSnapshots(min_interval=0.0)
    assert snaps.refresh_now(str(folder)).files == 1

    def denied(path):
        raise PermissionError("EACCES")

    monkeypatch.setattr(qi.os, "scandir", denied)
    assert snaps.refresh_now(str(folder)).files == 1
    assert snaps.ready(str(folder)) is True


def test_a_failed_first_listing_stays_not_ready_and_isnt_retried_on_every_read(folder,
                                                                             monkeypatch):
    calls = []

    def denied(path):
        calls.append(path)
        raise PermissionError("EACCES")

    monkeypatch.setattr(qi.os, "scandir", denied)
    snaps = qi.QuarantineSnapshots(min_interval=60.0)
    snaps.wait(str(folder), timeout=5)
    assert snaps.peek(str(folder)) is None
    for _ in range(20):
        snaps.peek(str(folder))
    time.sleep(0.1)
    assert len(calls) == 1  # backed off until min_interval


def test_a_missing_folder_is_an_empty_ready_snapshot(tmp_path):
    snaps = qi.QuarantineSnapshots()
    snap = snaps.refresh_now(str(tmp_path / "not_made_yet"))
    assert snap.files == 0 and snaps.peek(str(tmp_path / "not_made_yet")) is not None


def test_a_hung_refresh_doesnt_block_the_next_one_for_ever(folder):
    snaps = qi.QuarantineSnapshots(hung_after=0.2)
    real = snaps._build
    release = threading.Event()
    started = []

    def build(path):
        started.append(time.monotonic())
        if len(started) == 1:
            release.wait(5)  # the first one hangs
        return real(path)

    snaps._build = build
    first = snaps._kick(qi._norm(str(folder)))
    time.sleep(0.05)
    assert snaps._kick(qi._norm(str(folder))) is first  # not hung yet: the same one
    time.sleep(0.3)
    second = snaps._kick(qi._norm(str(folder)))  # hung now: another starts
    assert second is not first
    second.wait(5)
    assert snaps.peek(str(folder)) is not None
    release.set()
    first.wait(5)


# ── L1: the list and the badge agree ─────────────────────────────────────────

def test_the_list_takes_what_is_gone_out_of_the_badges_count(folder, client):
    _put(folder, "20261101_100000_a")
    _put(folder, "20261101_100001_b", track="Other")
    qi.shared_index().refresh_now(str(folder))
    # removed outside the app (a person tidying the folder)
    (folder / "20261101_100001_b.flac.quarantined").unlink()
    listed = client.get("/api/quarantine/list?limit=100&offset=0").get_json()
    assert listed["total"] == 1
    assert qi.shared_index().peek(str(folder)).files == 1


# ── L2: a clear forgets only what it deleted ─────────────────────────────────

def test_a_clear_forgets_only_what_it_deleted(folder, monkeypatch):
    from core.library import cleanup

    _put(folder, "20261101_100000_a")
    _put(folder, "20261101_100001_b", track="Other")
    qi.shared_index().refresh_now(str(folder))
    real_remove = os.remove

    def remove(path):
        if "100001_b.flac" in str(path):
            raise PermissionError("in use")
        return real_remove(path)

    monkeypatch.setattr(cleanup.os, "remove", remove)
    items = ({"name": n} for n in sorted(os.listdir(folder)))  # a generator: walked once
    result = cleanup.clear_planned_quarantine(str(folder), items)
    assert result["files_removed"] == 1 and len(result["errors"]) == 1
    left = [r.entry_id for r in qi.shared_index().peek(str(folder)).records]
    assert left == ["20261101_100001_b"]


# ── L3: playlist figures are read again after a mirror or a sync ────────────

def test_playlist_figures_are_read_again_after_a_sync(tmp_path, monkeypatch):
    import core.wishlist.journey as journey
    from database.music_database import MusicDatabase

    db = MusicDatabase(str(tmp_path / "music.db"))
    journey._playlist_cache.clear()
    calls = []
    monkeypatch.setattr(journey, "playlist_progress",
                        lambda d, rows, pid: calls.append(1) or [{"name": "Running", "mirror": None}])
    rows = [{"source_type": "playlist", "source_info": {"playlist_name": "Running"}}]
    first = journey.cached_playlist_progress(db, rows, 1)
    first[0]["name"] = "changed by a caller"  # a copy: the cache isn't touched
    assert journey.cached_playlist_progress(db, rows, 1)[0]["name"] == "Running"
    assert len(calls) == 1
    conn = db._get_connection()
    conn.execute("INSERT INTO sync_history (batch_id, playlist_id, playlist_name, source, sync_type,"
                 " tracks_json, started_at) VALUES ('b1', 'auto_mirror_1', 'Running', 'spotify',"
                 " 'playlist', '[]', CURRENT_TIMESTAMP)")
    conn.commit()
    conn.close()
    journey.cached_playlist_progress(db, rows, 1)
    assert len(calls) == 2
    conn = db._get_connection()
    conn.execute("INSERT INTO mirrored_playlists (source, source_playlist_id, name, profile_id)"
                 " VALUES ('spotify', 'x', 'Running', 1)")
    conn.commit()
    conn.close()
    journey.cached_playlist_progress(db, rows, 1)
    assert len(calls) == 3
    journey._playlist_cache.clear()
