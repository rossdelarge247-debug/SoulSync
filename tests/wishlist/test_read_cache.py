"""The shared Wanted-list read (core/wishlist/read_cache.py) and the stats
aggregate: the same answers as the per-request reads they replace.

With ~9,000 wanted songs every GET parsed every row's JSON (the albums and
singles requests twice each, plus a duplicate sweep, a write, on each), and the
stats and journey once more. Pinned here, against a real database:

* the change counter: made by the schema (also on an old database), bumped by
  every insert, update and delete, and kept through a table rebuild;
* the stats counts from SQL equal what parsing every row gave, odd rows too;
* the tracks payloads equal what the old route built, cached or not;
* a write is seen on the next read; the duplicate sweep runs after an insert
  only, and never while a wishlist batch runs.
"""

from __future__ import annotations

import json
import sqlite3
import threading

import pytest

import core.wishlist.routes as routes_module
from core.wishlist.read_cache import WishlistReadCache, shared_cache
from core.wishlist.reporting import count_wishlist_tracks_by_category
from core.wishlist.routes import (
    WishlistRouteRuntime,
    _enrich_wishlist_images,
    get_wishlist_stats,
    get_wishlist_tracks,
)
from core.wishlist.selection import prepare_wishlist_tracks_for_display
from core.wishlist.service import WishlistService
from database.music_database import MusicDatabase


@pytest.fixture()
def mdb(tmp_path):
    return MusicDatabase(str(tmp_path / "music.db"))


@pytest.fixture()
def service(mdb, monkeypatch):
    svc = WishlistService(mdb.database_path)
    svc._database = mdb
    monkeypatch.setattr(routes_module, "get_wishlist_service", lambda: svc)
    shared_cache().clear()
    yield svc
    shared_cache().clear()


def _runtime(mdb, *, batches=None, logs=None):
    class _Log:
        def __getattr__(self, level):
            return lambda msg, *a: (logs if logs is not None else []).append((level, msg % a if a else msg))

    return WishlistRouteRuntime(
        get_music_database=lambda: mdb,
        profile_id=1,
        download_batches=batches if batches is not None else {},
        download_tasks={},
        tasks_lock=threading.Lock(),
        is_wishlist_actually_processing=lambda: False,
        reset_wishlist_processing_state=lambda: None,
        add_activity_item=lambda *a: None,
        active_server="navidrome",
        logger=_Log(),
        get_next_run_seconds=lambda _name: 42,
    )


def _insert(mdb, track_id, data, *, profile=1, source_info=None, raw=None):
    conn = mdb._get_connection()
    conn.execute(
        "INSERT INTO wishlist_tracks (spotify_track_id, spotify_data, profile_id, source_type,"
        " source_info) VALUES (?, ?, ?, 'playlist', ?)",
        (track_id, raw if raw is not None else json.dumps(data), profile, source_info))
    conn.commit()
    conn.close()


def _song(track_id, title, *, album_type=None, total=None, album=True, image=None, artist="Saltmarsh"):
    data = {"id": track_id, "name": title, "artists": [{"name": artist}], "duration_ms": 200000}
    if album:
        data["album"] = {"name": f"{title} LP",
                         "images": [{"url": image or f"https://i.scdn.co/image/{track_id}"}]}
        if album_type is not None:
            data["album"]["album_type"] = album_type
        if total is not None:
            data["album"]["total_tracks"] = total
    return data


def _seed_edge_cases(mdb):
    _insert(mdb, "s1", _song("s1", "Single", album_type="single"))
    _insert(mdb, "s2", _song("s2", "EP", album_type="EP"))
    _insert(mdb, "a1", _song("a1", "Album", album_type="album"))
    _insert(mdb, "a2", _song("a2", "Comp", album_type="compilation", total=2))
    _insert(mdb, "n1", _song("n1", "No type, short", total=4))
    _insert(mdb, "n2", _song("n2", "No type, long", total=12))
    _insert(mdb, "n3", _song("n3", "String total", total="3"))
    _insert(mdb, "n4", _song("n4", "Float string total", total="5.5"))
    _insert(mdb, "n5", _song("n5", "Bool total", total=True))
    _insert(mdb, "n6", _song("n6", "Bad total", total="lots"))
    _insert(mdb, "n7", _song("n7", "Zero total", total=0))
    _insert(mdb, "n8", _song("n8", "No album", album=False))
    _insert(mdb, "n9", {"id": "n9", "name": "Album not a dict", "album": "Some LP"})
    _insert(mdb, "x1", {"track_data": _song("x1", "Nested", album_type="single")})
    _insert(mdb, "x2", {"spotify_data": json.dumps(_song("x2", "Nested string", total=2))})
    _insert(mdb, "x3", {})
    _insert(mdb, "bad", None, raw="{not json")
    _insert(mdb, "bad-src", _song("bad-src", "Bad source", album_type="single"), source_info="{oops")
    _insert(mdb, "other", _song("other", "Other profile", album_type="single"), profile=2)
    _insert(mdb, "lib", _song("lib", "Library art", total=1, image="/library/metadata/9/thumb/1"))


# ── the change counter ───────────────────────────────────────────────────────


def _counter(mdb):
    return mdb.get_wishlist_change_counter()


def test_every_write_moves_the_counter_and_inserts_move_added(mdb):
    v0, a0 = _counter(mdb)
    _insert(mdb, "t1", _song("t1", "One"))
    assert _counter(mdb) == (v0 + 1, a0 + 1)
    conn = mdb._get_connection()
    conn.execute("UPDATE wishlist_tracks SET retry_count = retry_count + 1")
    conn.commit()
    assert _counter(mdb) == (v0 + 2, a0 + 1)
    conn.execute("DELETE FROM wishlist_tracks")
    conn.commit()
    conn.close()
    assert _counter(mdb) == (v0 + 3, a0 + 1)


def test_a_fresh_database_keeps_its_triggers_through_the_profile_rebuild(mdb):
    """The profile migration rebuilds wishlist_tracks (drop + rename), which
    drops a table's triggers: they must be put back."""
    conn = mdb._get_connection()
    names = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'wishlist_tracks'")}
    conn.close()
    assert {"wishlist_tracks_counter_insert", "wishlist_tracks_counter_update",
            "wishlist_tracks_counter_delete"} <= names


def test_an_old_database_gets_the_counter_on_start(tmp_path):
    path = str(tmp_path / "old.db")
    MusicDatabase(path)
    conn = sqlite3.connect(path)
    for name in ("insert", "update", "delete"):
        conn.execute(f"DROP TRIGGER wishlist_tracks_counter_{name}")
    conn.execute("DROP TABLE wishlist_change_counter")
    conn.commit()
    conn.close()

    import database.music_database as mdb_module
    mdb_module._database_initialized_paths.discard(str((tmp_path / "old.db").resolve()))
    db = MusicDatabase(path)
    assert _counter(db) == (0, 0)
    _insert(db, "t1", _song("t1", "One"))
    assert _counter(db) == (1, 1)


# ── the stats aggregate ──────────────────────────────────────────────────────


def test_the_stats_counts_equal_parsing_every_row(mdb, service):
    _seed_edge_cases(mdb)
    for profile in (1, 2):
        before = count_wishlist_tracks_by_category(
            service.get_wishlist_tracks_for_download(profile_id=profile))
        assert mdb.count_wishlist_by_category(profile) == before
    assert mdb.count_wishlist_by_category(1)["total"] == 17  # "bad" and "bad-src" left out, as before


def test_the_stats_payload_is_unchanged_and_follows_writes(mdb, service):
    _seed_edge_cases(mdb)
    rt = _runtime(mdb, batches={"b": {"playlist_id": "wishlist", "phase": "downloading"}})
    payload, status = get_wishlist_stats(rt)
    expected = count_wishlist_tracks_by_category(service.get_wishlist_tracks_for_download(profile_id=1))
    assert status == 200
    assert payload == {**expected, "next_run_in_seconds": 42, "is_auto_processing": False,
                       "current_cycle": payload["current_cycle"], "active_batches": 1}
    assert list(payload) == ["singles", "albums", "total", "next_run_in_seconds",
                             "is_auto_processing", "current_cycle", "active_batches"]

    _insert(mdb, "new", _song("new", "New single", album_type="single"))
    again, _ = get_wishlist_stats(rt)
    assert (again["singles"], again["total"]) == (payload["singles"] + 1, payload["total"] + 1)


# ── the tracks payloads ──────────────────────────────────────────────────────


def _old_payload(service, mdb, category, limit):
    """What the tracks route returned before the shared read (its duplicate
    sweep first)."""
    mdb.remove_wishlist_duplicates(profile_id=1)
    raw = service.get_wishlist_tracks_for_download(profile_id=1)
    prepared = prepare_wishlist_tracks_for_display(raw, category=category, limit=limit)
    artist_images = _enrich_wishlist_images(prepared["tracks"], mdb)
    if category:
        return {"tracks": prepared["tracks"], "category": category, "total": prepared["total"],
                "artist_images": artist_images}
    return {"tracks": prepared["tracks"], "total": prepared["total"], "artist_images": artist_images}


@pytest.mark.parametrize("category, limit", [
    ("albums", None), ("singles", None), (None, None), ("albums", 3), ("singles", 2), (None, 4),
])
def test_the_tracks_payload_equals_the_old_route(mdb, service, category, limit):
    _seed_edge_cases(mdb)
    rt = _runtime(mdb)
    expected = json.loads(json.dumps(_old_payload(service, mdb, category, limit)))
    for _ in range(2):  # built, then reused
        payload, status = get_wishlist_tracks(rt, category=category, limit=limit)
        assert status == 200
        assert json.loads(json.dumps(payload)) == expected


def test_the_cached_response_bytes_equal_jsonify(mdb, service):
    """The API route answers a repeat with the bytes it serialised first:
    the same bytes jsonify makes from the payload."""
    from flask import Flask, jsonify

    from api.wishlist_routes import bp

    _seed_edge_cases(mdb)
    app = Flask(__name__)
    app.register_blueprint(bp)
    import api.wishlist_routes as api_module

    rt = _runtime(mdb)
    api_module._build_wishlist_route_runtime = lambda: rt
    with app.test_request_context():
        for category in ("albums", "singles", None):
            url = "/api/wishlist/tracks" + (f"?category={category}" if category else "")
            first = app.test_client().get(url)
            second = app.test_client().get(url)
            payload, _ = get_wishlist_tracks(rt, category=category)
            assert first.status_code == second.status_code == 200
            assert first.get_data() == second.get_data() == jsonify(payload).get_data()
            assert first.mimetype == "application/json"


def test_a_write_is_seen_by_the_next_read(mdb, service):
    _seed_edge_cases(mdb)
    rt = _runtime(mdb)
    before, _ = get_wishlist_tracks(rt, category="singles")
    _insert(mdb, "new", _song("new", "New single", album_type="single"))
    after, _ = get_wishlist_tracks(rt, category="singles")
    assert after["total"] == before["total"] + 1
    assert "new" in {t.get("spotify_track_id") or t.get("id") for t in after["tracks"]}

    conn = mdb._get_connection()
    conn.execute("DELETE FROM wishlist_tracks WHERE spotify_track_id = 'new'")
    conn.commit()
    conn.close()
    assert get_wishlist_tracks(rt, category="singles")[0]["total"] == before["total"]


def test_the_build_is_shared_between_categories_and_reused(mdb, service, monkeypatch):
    _seed_edge_cases(mdb)
    reads = []
    real = mdb.get_wishlist_tracks
    monkeypatch.setattr(mdb, "get_wishlist_tracks", lambda **kw: reads.append(kw) or real(**kw))
    rt = _runtime(mdb)
    for category in ("albums", "singles", "albums", None, "singles"):
        get_wishlist_tracks(rt, category=category)
    assert len(reads) == 1


def test_a_build_older_than_max_age_is_made_again(mdb, service, monkeypatch):
    """The artist photos come from the library, which has no counter."""
    cache = WishlistReadCache(max_age=60)
    clock = [1000.0]
    monkeypatch.setattr("core.wishlist.read_cache.time.monotonic", lambda: clock[0])
    first = cache.build(mdb, 1)
    assert cache.build(mdb, 1) is first
    clock[0] += 61
    assert cache.build(mdb, 1) is not first


# ── the duplicate sweep ──────────────────────────────────────────────────────


def test_the_duplicate_sweep_runs_after_an_insert_only(mdb, service, monkeypatch):
    sweeps = []
    monkeypatch.setattr(mdb, "remove_wishlist_duplicates",
                        lambda profile_id=1: sweeps.append(profile_id) or 0)
    rt = _runtime(mdb)
    _insert(mdb, "t1", _song("t1", "One", album_type="single"))
    get_wishlist_tracks(rt, category="singles")
    assert sweeps == [1]

    conn = mdb._get_connection()
    conn.execute("UPDATE wishlist_tracks SET retry_count = retry_count + 1")
    conn.commit()
    conn.close()
    get_wishlist_tracks(rt, category="singles")   # rebuilt, no sweep: nothing added
    get_wishlist_tracks(rt, category="albums")
    assert sweeps == [1]

    _insert(mdb, "t2", _song("t2", "Two", album_type="single"))
    get_wishlist_tracks(rt, category="singles")
    assert sweeps == [1, 1]


def test_no_duplicate_sweep_while_a_wishlist_batch_runs(mdb, service, monkeypatch):
    sweeps = []
    monkeypatch.setattr(mdb, "remove_wishlist_duplicates",
                        lambda profile_id=1: sweeps.append(profile_id) or 0)
    logs = []
    batches = {"b": {"playlist_id": "wishlist", "phase": "downloading"}}
    rt = _runtime(mdb, batches=batches, logs=logs)
    _insert(mdb, "t1", _song("t1", "One", album_type="single"))
    get_wishlist_tracks(rt, category="singles")
    assert sweeps == []
    assert ("warning", "Skipping wishlist duplicate cleanup - download in progress") in logs

    batches["b"]["phase"] = "complete"
    _insert(mdb, "t2", _song("t2", "Two", album_type="single"))
    get_wishlist_tracks(rt, category="singles")
    assert sweeps == [1]


def test_the_journey_reads_the_shared_rows(mdb, service):
    _seed_edge_cases(mdb)
    rows = shared_cache().rows(mdb, 1)
    assert {r["spotify_track_id"] for r in rows} == {
        r["spotify_track_id"] for r in mdb.get_wishlist_tracks(profile_id=1)}
    assert shared_cache().rows(mdb, 1) is rows
