"""The Wanted page's journey read (core/wishlist/journey.py, GET /api/wishlist/journey).

Pinned here: how a wanted row is joined to the live download queue (wishlist
row id, or the source track id) and to quarantine (ids from the sidecar's
track_info, then the ISRC, then artist and title for sidecars that name no
ids), the per-playlist library figures (only stated once the sync matcher has
checked every track), the cached sidecar index, and the route's shape.
"""

from __future__ import annotations

import json
import threading
from types import SimpleNamespace

import pytest

from core.imports.quarantine_index import QuarantineSnapshots, count_songs, shared_index
from core.wishlist.journey import (
    playlist_progress,
    snapshot_active_tasks,
    wishlist_journey,
)


def _row(rid, sid, name="Harbour Light", artist="Pale Harbour", **extra):
    data = {"id": sid, "name": name, "artists": [{"name": artist}], "album": {"name": "Tidewater"}}
    data.update(extra.pop("data", {}))
    return {"id": rid, "spotify_track_id": sid, "spotify_data": data,
            "source_type": extra.get("source_type", "manual"),
            "source_info": extra.get("source_info", {}), "retry_count": 0}


def _sidecar(folder, stem, *, artist="Pale Harbour", track="Harbour Light", track_info=None,
             trigger="acoustid_unverified", reason="no match"):
    (folder / f"{stem}.flac.quarantined").write_bytes(b"x")
    payload = {"expected_artist": artist, "expected_track": track, "trigger": trigger,
               "quarantine_reason": reason}
    if track_info is not None:
        payload["context"] = {"track_info": track_info}
    (folder / f"{stem}.json").write_text(json.dumps(payload))


# ── the live queue ────────────────────────────────────────────────────────────

def test_a_task_joins_by_wishlist_row_or_by_source_id_and_the_furthest_along_wins():
    tasks = {
        "a": {"status": "searching", "track_info": {"wishlist_id": 7}},
        "b": {"status": "downloading", "progress": 62.4, "track_info": {"id": "sp-2"}},
        "c": {"status": "completed", "track_info": {"id": "sp-3"}},
        "d": {"status": "queued", "track_info": {"spotify_track_id": "sp-1"}},
    }
    live = snapshot_active_tasks(tasks, threading.Lock())
    assert "sid:sp-3" not in live  # a finished task is not on its way
    out = wishlist_journey([_row(7, "sp-1"), _row(8, "sp-2"), _row(9, "sp-3")],
                           tasks=live, quarantine=[])
    # row 7 has a searching task by row id and a queued one by source id: queued is further
    assert out["sp-1"]["download"]["status"] == "queued"
    assert out["sp-1"]["download"]["phase"] == "downloading"
    assert out["sp-2"]["download"] == {"status": "downloading", "phase": "downloading",
                                       "task_id": "b", "batch_id": "", "progress": 62}
    assert "sp-3" not in out


# ── quarantine ────────────────────────────────────────────────────────────────

@pytest.fixture
def qdir(tmp_path):
    folder = tmp_path / "ss_quarantine"
    folder.mkdir()
    return folder


def test_quarantine_joins_by_id_then_isrc_then_name(qdir):
    _sidecar(qdir, "20261101_100000_a", track_info={"id": "sp-1"})
    _sidecar(qdir, "20261102_100000_b", track_info={"spotify_track_id": "sp-1"}, trigger="integrity")
    _sidecar(qdir, "20261103_100000_c", artist="X", track="Y", track_info={"isrc": "GBAAA0000001"})
    _sidecar(qdir, "20261104_100000_d", artist="  saltmarsh ", track="Static  Bloom")
    # names its own ids: never joined by name to another song
    _sidecar(qdir, "20261105_100000_e", artist="Saltmarsh", track="Static Bloom",
             track_info={"id": "someone-else"})
    records = QuarantineSnapshots().refresh_now(str(qdir)).records
    rows = [
        _row(1, "sp-1"),
        _row(2, "sp-2", name="Other", data={"external_ids": {"isrc": "gbaaa0000001"}}),
        _row(3, "sp-3", name="Static Bloom", artist="Saltmarsh"),
        _row(4, "sp-4", name="Nothing held"),
    ]
    out = wishlist_journey(rows, tasks={}, quarantine=records)
    assert out["sp-1"]["quarantine"] == {"entry_id": "20261102_100000_b", "count": 2,
                                         "reason": "no match", "trigger": "integrity",
                                         "matched_by": "id"}
    assert out["sp-2"]["quarantine"]["matched_by"] == "isrc"
    assert out["sp-3"]["quarantine"]["entry_id"] == "20261104_100000_d"
    assert out["sp-3"]["quarantine"]["count"] == 1
    assert out["sp-3"]["quarantine"]["matched_by"] == "name"
    assert "sp-4" not in out


def test_a_reused_wishlist_row_id_only_joins_its_own_song(qdir):
    _sidecar(qdir, "20261101_100000_a", track_info={"wishlist_id": 5, "id": "old-song"},
             artist="A", track="B")
    out = wishlist_journey([_row(5, "new-song")], tasks={},
                           quarantine=QuarantineSnapshots().refresh_now(str(qdir)).records)
    assert out == {}


def test_the_snapshot_reads_a_sidecar_once_and_again_only_when_it_changes(qdir, monkeypatch):
    import core.imports.quarantine_index as mod
    _sidecar(qdir, "20261101_100000_a")
    _sidecar(qdir, "20261102_100000_b")
    reads = []
    real = mod.read_sidecar
    monkeypatch.setattr(mod, "read_sidecar", lambda d, e: reads.append(e) or real(d, e))
    snaps = QuarantineSnapshots()
    assert [r.entry_id for r in snaps.refresh_now(str(qdir)).records] == [
        "20261102_100000_b", "20261101_100000_a"]
    assert len(reads) == 2
    snaps.refresh_now(str(qdir))
    assert len(reads) == 2  # nothing changed: no sidecar read
    _sidecar(qdir, "20261103_100000_c")
    (qdir / "20261101_100000_a.flac.quarantined").unlink()
    ids = [r.entry_id for r in snaps.refresh_now(str(qdir)).records]
    assert ids == ["20261103_100000_c", "20261102_100000_b"]
    assert len(reads) == 3
    # a rewritten sidecar (another size) is read again
    _sidecar(qdir, "20261102_100000_b", reason="a longer reason than before")
    snaps.refresh_now(str(qdir))
    assert reads[-1] == "20261102_100000_b" and len(reads) == 4


def test_a_group_is_every_attempt_at_the_same_song_and_songs_count_groups(qdir):
    _sidecar(qdir, "20261101_100000_a")
    _sidecar(qdir, "20261102_100000_b", artist="PALE HARBOUR")
    _sidecar(qdir, "20261103_100000_c", artist="Saltmarsh", track="Static Bloom")
    (qdir / "20261104_100000_orphan.flac.quarantined").write_bytes(b"x")  # no sidecar
    index = QuarantineSnapshots()
    assert [r.entry_id for r in index.group_of(str(qdir), "20261101_100000_a")] == [
        "20261102_100000_b", "20261101_100000_a"]
    assert index.group_of(str(qdir), "missing") == []
    assert [r.entry_id for r in index.group_of(str(qdir), "20261104_100000_orphan")] == [
        "20261104_100000_orphan"]
    # 4 files, 3 songs: the two Harbour Lights are one
    assert count_songs(index.refresh_now(str(qdir)).records) == 3


# ── playlists ─────────────────────────────────────────────────────────────────

class _Db:
    def __init__(self, mirrors, counts):
        self._mirrors, self._counts = mirrors, counts

    def get_mirrored_playlists(self, profile_id=1):
        return self._mirrors

    def get_all_mirrored_playlist_status_counts(self, profile_id=1):
        return self._counts


def test_a_playlist_has_library_figures_only_when_mirrored_and_checked_through():
    rows = [
        _row(1, "a", source_type="playlist",
             source_info={"playlist_name": "Running", "playlist_id": "auto_mirror_3"}),
        _row(2, "b", source_type="playlist",
             source_info={"playlist_name": "Classical calm", "playlist_id": "sp-pl-9"}),
        _row(3, "c", source_type="playlist", source_info={"playlist_name": "Liked Songs"}),
        _row(4, "d", source_type="playlist", source_info={"playlist_name": "Unknown Playlist"}),
        _row(5, "e", source_type="watchlist"),
    ]
    db = _Db(
        [{"id": 3, "name": "Running", "source": "spotify"},
         {"id": 4, "name": "Calm", "source_playlist_id": "sp-pl-9", "source": "spotify"}],
        {3: {"total": 240, "in_library": 212, "library_checked": 240},
         4: {"total": 140, "in_library": 50, "library_checked": 96}},
    )
    out = {p["name"]: p["mirror"] for p in playlist_progress(db, rows, 1)}
    assert set(out) == {"Running", "Classical calm", "Liked Songs"}
    assert out["Running"]["library_known"] is True
    assert (out["Running"]["in_library"], out["Running"]["total"]) == (212, 240)
    assert out["Classical calm"]["library_known"] is False
    assert out["Classical calm"]["library_checked"] == 96
    assert out["Liked Songs"] is None


def test_a_playlist_is_matched_by_name_only_when_one_mirror_has_it():
    rows = [_row(1, "a", source_type="playlist", source_info={"playlist_name": "Mix"})]
    two = _Db([{"id": 1, "name": "Mix"}, {"id": 2, "name": "mix"}], {})
    assert playlist_progress(two, rows, 1)[0]["mirror"] is None
    one = _Db([{"id": 1, "name": "Mix", "custom_name": ""}],
              {1: {"total": 3, "in_library": 1, "library_checked": 3}})
    assert playlist_progress(one, rows, 1)[0]["mirror"]["id"] == 1


# ── the route ─────────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _fresh_playlist_cache():
    import core.wishlist.journey as journey
    journey._playlist_cache.clear()
    yield
    journey._playlist_cache.clear()


def _journey_client(tmp_path, monkeypatch, *, admin, warm=True):
    from flask import Flask

    import api.wishlist_routes as routes
    import core.imports.paths as paths
    import database.music_database as mdb

    folder = tmp_path / "ss_quarantine"
    folder.mkdir()
    _sidecar(folder, "20261101_100000_a", track_info={"id": "sp-1"})
    _sidecar(folder, "20261102_100000_b", track_info={"id": "sp-1"})
    if warm:
        # what the background refresh does on the first poll
        shared_index().refresh_now(str(folder))

    class FakeDb:
        def get_wishlist_tracks(self, profile_id=1):
            assert profile_id == 1
            return [_row(1, "sp-1"), _row(2, "sp-2")]

        def get_mirrored_playlists(self, profile_id=1):
            return []

        def get_metadata(self, key):
            return None

    monkeypatch.setattr(mdb, "MusicDatabase", FakeDb)
    monkeypatch.setattr(paths, "docker_resolve_path", lambda p: p)
    monkeypatch.setattr(routes, "config_manager",
                        SimpleNamespace(get=lambda key, default=None: str(tmp_path)))
    monkeypatch.setattr(routes, "get_current_profile_id", lambda: 1)
    monkeypatch.setattr(routes, "download_tasks",
                        {"t": {"status": "searching", "track_info": {"wishlist_id": 2}}})
    import core.profile_context as profile_context
    monkeypatch.setattr(profile_context, "is_admin_request", lambda: admin)
    app = Flask(__name__)
    app.register_blueprint(routes.bp)
    return app.test_client()


def test_the_route_answers_tracks_playlists_and_the_retry_ladder(tmp_path, monkeypatch):
    body = _journey_client(tmp_path, monkeypatch, admin=True).get(
        "/api/wishlist/journey").get_json()
    assert body["success"] is True and body["quarantine_ready"] is True
    assert body["tracks"]["sp-1"]["quarantine"]["count"] == 2
    assert body["tracks"]["sp-1"]["quarantine"]["entry_id"] == "20261102_100000_b"
    assert body["tracks"]["sp-2"]["download"]["phase"] == "searching"
    # the install's quarantine totals aren't a profile's business
    assert "quarantine_total" not in body and "quarantine_songs" not in body
    assert body["playlists"] == []
    assert body["retry"]["name"] == "standard"
    assert body["retry"]["ladder"] == {"2": 14400, "3": 86400}


def test_before_the_first_quarantine_read_the_journey_says_so_and_waits_for_nothing(
        tmp_path, monkeypatch):
    """A cold start: no snapshot yet. The read answers at once, statuses
    without quarantine, and says it isn't ready; the refresh runs behind it."""
    body = _journey_client(tmp_path, monkeypatch, admin=True, warm=False).get(
        "/api/wishlist/journey").get_json()
    assert body["success"] is True and body["quarantine_ready"] is False
    assert "quarantine" not in body["tracks"].get("sp-1", {})
    assert body["tracks"]["sp-2"]["download"]["phase"] == "searching"
    # once the background read lands, the next poll has it
    shared_index().wait(str(tmp_path / "ss_quarantine"))
    from flask import Flask

    import api.wishlist_routes as routes
    app = Flask(__name__)
    app.register_blueprint(routes.bp)
    again = app.test_client().get("/api/wishlist/journey").get_json()
    assert again["quarantine_ready"] is True
    assert again["tracks"]["sp-1"]["quarantine"]["count"] == 2


def test_a_member_sees_the_status_but_no_way_into_the_quarantine(tmp_path, monkeypatch):
    body = _journey_client(tmp_path, monkeypatch, admin=False).get(
        "/api/wishlist/journey").get_json()
    held = body["tracks"]["sp-1"]["quarantine"]
    assert held["count"] == 2 and held["trigger"] == "acoustid_unverified"
    assert "entry_id" not in held
    assert "quarantine_total" not in body


def test_the_quarantine_list_narrows_to_one_songs_attempts(tmp_path, monkeypatch):
    from flask import Flask

    import api.quarantine as routes
    import core.imports.quarantine_library as qlib

    folder = tmp_path / "ss_quarantine"
    folder.mkdir()
    _sidecar(folder, "20261101_100000_a")
    _sidecar(folder, "20261102_100000_b")
    _sidecar(folder, "20261103_100000_c", artist="Saltmarsh", track="Static Bloom")
    monkeypatch.setattr(routes, "config_manager",
                        SimpleNamespace(get=lambda key, default=None: str(tmp_path)))
    monkeypatch.setattr(routes, "docker_resolve_path", lambda p: p)
    monkeypatch.setattr(qlib, "annotate_quarantine_library", lambda *a, **k: None)
    app = Flask(__name__)
    app.register_blueprint(routes.bp)
    client = app.test_client()
    body = client.get("/api/quarantine/list?entry=20261101_100000_a").get_json()
    assert [e["id"] for e in body["entries"]] == ["20261102_100000_b", "20261101_100000_a"]
    assert (body["total"], body["entry"]) == (2, "20261101_100000_a")
    gone = client.get("/api/quarantine/list?entry=nope").get_json()
    assert gone["entries"] == [] and gone["success"] is True
    # without entry the list is unchanged
    assert client.get("/api/quarantine/list").get_json()["total"] == 3


def test_a_playlist_being_checked_says_how_many_checked_tracks_are_owned(tmp_path):
    """While the sync is still checking a mirror, its bar splits the checked
    tracks from the rest: owned_checked counts the sync's own in_library flag,
    never the join's guess."""
    from database.music_database import MusicDatabase

    db = MusicDatabase(str(tmp_path / "music.db"))
    conn = db._get_connection()
    conn.execute("INSERT INTO mirrored_playlists (id, source, source_playlist_id, name, profile_id)"
                 " VALUES (4, 'spotify', 'sp-pl-9', 'Calm', 1)")
    flags = ['{"in_library": true, "library_checked_at": "x"}',
             '{"in_library": true, "library_checked_at": "x"}',
             '{"in_library": false, "library_checked_at": "x"}',
             None, None]
    for pos, extra in enumerate(flags):
        conn.execute("INSERT INTO mirrored_playlist_tracks (playlist_id, position, track_name,"
                     " artist_name, extra_data) VALUES (4, ?, ?, 'A', ?)", (pos, f"T{pos}", extra))
    conn.commit()
    conn.close()
    rows = [_row(1, "a", source_type="playlist",
                 source_info={"playlist_name": "Calm", "playlist_id": "auto_mirror_4"})]
    mirror = playlist_progress(db, rows, 1)[0]["mirror"]
    assert (mirror["total"], mirror["library_checked"], mirror["library_known"]) == (5, 3, False)
    assert mirror["owned_checked"] == 2
