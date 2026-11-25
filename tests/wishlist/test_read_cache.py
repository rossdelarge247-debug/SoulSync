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


def _counter(mdb, profile=1):
    return mdb.get_wishlist_change_counter(profile)


def _sql(mdb, statement, *args):
    conn = mdb._get_connection()
    conn.execute(statement, args)
    conn.commit()
    conn.close()


def test_writes_move_the_counters(mdb):
    """version: inserts, deletes, real edits; added: inserts; retry: updates
    that change only the retry columns."""
    assert _counter(mdb) == (0, 0, 0)
    _insert(mdb, "t1", _song("t1", "One"))
    assert _counter(mdb) == (1, 1, 0)
    mdb.update_wishlist_retry("t1", False, "no results", profile_id=1)
    assert _counter(mdb) == (1, 1, 1)
    mdb.reset_wishlist_retry_backoff(profile_id=1)
    assert _counter(mdb) == (1, 1, 2)
    _sql(mdb, "UPDATE wishlist_tracks SET retry_count = retry_count")  # nothing changed
    assert _counter(mdb) == (1, 1, 2)
    _sql(mdb, "UPDATE wishlist_tracks SET source_info = '{}', retry_count = 9")  # an edit too
    assert _counter(mdb)[:2] == (3, 1)  # both owners' rows: here the same one, twice
    _sql(mdb, "DELETE FROM wishlist_tracks")
    assert _counter(mdb)[:2] == (4, 1)



def test_approving_a_request_moves_the_counter(mdb):
    """request_status / request_resolved_at exist from start, so the triggers
    name them: an approve (which writes only those) is a real change."""
    conn = mdb._get_connection()
    cols = {c[1] for c in conn.execute("PRAGMA table_info(wishlist_tracks)")}
    conn.close()
    assert {"request_status", "request_resolved_at"} <= cols
    _insert(mdb, "t1", _song("t1", "One"))
    before = _counter(mdb)[0]
    _sql(mdb, "UPDATE wishlist_tracks SET request_status = 'approved'")
    assert _counter(mdb)[0] > before


def test_columns_added_later_are_named_by_regenerated_triggers(mdb):
    """a database whose request columns arrive at runtime (an old wishlist
    rebuild drops them) gets triggers that name them as they're added."""
    conn = mdb._get_connection()
    for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' "
                                "AND tbl_name = 'wishlist_tracks'").fetchall():
        conn.execute(f'DROP TRIGGER "{name}"')
    conn.execute("ALTER TABLE wishlist_tracks DROP COLUMN request_resolved_at")
    conn.execute("ALTER TABLE wishlist_tracks DROP COLUMN request_status")
    mdb._ensure_wishlist_changes(conn.cursor())  # triggers without the two columns
    mdb._ensure_music_request_schema(conn.cursor())
    conn.commit()
    conn.close()
    _insert(mdb, "t1", _song("t1", "One"))
    before = _counter(mdb)[0]
    _sql(mdb, "UPDATE wishlist_tracks SET request_status = 'approved'")
    assert _counter(mdb)[0] > before

def test_the_counters_are_per_profile(mdb):
    _insert(mdb, "t1", _song("t1", "One"), profile=1)
    _insert(mdb, "t2", _song("t2", "Two"), profile=2)
    before = _counter(mdb, 2)
    mdb.update_wishlist_retry("t1", False, "no results", profile_id=1)
    _sql(mdb, "UPDATE wishlist_tracks SET source_info = '{}' WHERE profile_id = 1")
    assert _counter(mdb, 2) == before
    # a row moved between profiles moves both
    _sql(mdb, "UPDATE wishlist_tracks SET profile_id = 2 WHERE spotify_track_id = 't1'")
    assert _counter(mdb, 2)[0] == before[0] + 1


def test_a_fresh_database_keeps_its_triggers_through_the_profile_rebuild(mdb):
    """The profile migration rebuilds wishlist_tracks (drop + rename), which
    drops a table's triggers; the triggers are made after every schema step."""
    conn = mdb._get_connection()
    names = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'wishlist_tracks'")}
    conn.close()
    assert {"wishlist_changes_insert", "wishlist_changes_delete", "wishlist_changes_edit",
            "wishlist_changes_retry"} <= names


def test_a_table_rebuild_keeps_its_triggers(mdb):
    conn = mdb._get_connection()
    cursor = conn.cursor()
    cursor.execute("CREATE TABLE wishlist_tracks_new AS SELECT * FROM wishlist_tracks")
    mdb._replace_table(cursor, "wishlist_tracks", "wishlist_tracks_new")
    conn.commit()
    conn.close()
    _insert(mdb, "t1", _song("t1", "One"))
    assert _counter(mdb)[:2] == (1, 1)


def test_an_old_database_gets_the_counters_on_start(tmp_path):
    """Without the counters (an older install), or with the first version's
    single global one: the next start makes them."""
    path = str(tmp_path / "old.db")
    MusicDatabase(path)
    conn = sqlite3.connect(path)
    for name in ("insert", "delete", "edit", "retry"):
        conn.execute(f"DROP TRIGGER wishlist_changes_{name}")
    conn.execute("DROP TABLE wishlist_changes")
    conn.execute("CREATE TABLE wishlist_change_counter (id INTEGER PRIMARY KEY, version INTEGER,"
                 " added INTEGER)")
    conn.execute("CREATE TRIGGER wishlist_tracks_counter_update AFTER UPDATE ON wishlist_tracks"
                 " BEGIN UPDATE wishlist_change_counter SET version = version + 1; END")
    conn.commit()
    conn.close()

    import database.music_database as mdb_module
    mdb_module._database_initialized_paths.discard(str((tmp_path / "old.db").resolve()))
    db = MusicDatabase(path)
    assert _counter(db) == (0, 0, 0)
    _insert(db, "t1", _song("t1", "One"))
    assert _counter(db) == (1, 1, 0)
    conn = sqlite3.connect(path)
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}
    conn.close()
    assert "wishlist_change_counter" not in names and "wishlist_tracks_counter_update" not in names


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


# ── a wishlist run's retry stamps ────────────────────────────────────────────


@pytest.fixture()
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr("core.wishlist.read_cache.time.monotonic", lambda: now[0])
    return now


def _reads(mdb, monkeypatch):
    reads = []
    real = mdb.get_wishlist_tracks
    monkeypatch.setattr(mdb, "get_wishlist_tracks", lambda **kw: reads.append(kw) or real(**kw))
    return reads


def _tries(payload, track_id):
    return next(t for t in payload["tracks"]
                if (t.get("spotify_track_id") or t.get("id")) == track_id)["retry_count"]


def test_retry_stamps_reuse_the_build_for_up_to_15_s(mdb, service, monkeypatch, clock):
    """A wishlist run stamps a retry about once a second: the reads keep the
    build (retry details up to 15 s old) instead of rebuilding on each one."""
    _seed_edge_cases(mdb)
    reads = _reads(mdb, monkeypatch)
    rt = _runtime(mdb)
    first, _ = get_wishlist_tracks(rt, category="singles")
    for second in range(1, 15):
        clock[0] += 1
        mdb.update_wishlist_retry("s1", False, "no results", profile_id=1)
        payload, _ = get_wishlist_tracks(rt, category="singles")
        assert _tries(payload, "s1") == _tries(first, "s1")
    assert len(reads) == 1

    clock[0] += 1  # 15 s since the build: the stamps show
    payload, _ = get_wishlist_tracks(rt, category="singles")
    assert len(reads) == 2
    assert _tries(payload, "s1") == _tries(first, "s1") + 14


def test_without_retry_stamps_a_build_isnt_redone_at_15_s(mdb, service, monkeypatch, clock):
    _seed_edge_cases(mdb)
    reads = _reads(mdb, monkeypatch)
    rt = _runtime(mdb)
    get_wishlist_tracks(rt, category="albums")
    clock[0] += 50
    get_wishlist_tracks(rt, category="albums")
    assert len(reads) == 1


def test_a_real_change_during_a_run_is_seen_at_once(mdb, service, monkeypatch, clock):
    _seed_edge_cases(mdb)
    reads = _reads(mdb, monkeypatch)
    rt = _runtime(mdb)
    before, _ = get_wishlist_tracks(rt, category="singles")
    clock[0] += 1
    mdb.update_wishlist_retry("s1", False, "no results", profile_id=1)
    _insert(mdb, "new", _song("new", "New single", album_type="single"))
    after, _ = get_wishlist_tracks(rt, category="singles")
    assert len(reads) == 2 and after["total"] == before["total"] + 1
    clock[0] += 1
    _sql(mdb, "DELETE FROM wishlist_tracks WHERE spotify_track_id = 'new'")
    assert get_wishlist_tracks(rt, category="singles")[0]["total"] == before["total"]


def test_the_journey_rows_follow_the_same_rule(mdb, service, clock):
    _seed_edge_cases(mdb)
    rows = shared_cache().rows(mdb, 1)
    clock[0] += 5
    mdb.update_wishlist_retry("s1", False, "no results", profile_id=1)
    assert shared_cache().rows(mdb, 1) is rows
    clock[0] += 10
    fresh = shared_cache().rows(mdb, 1)
    assert fresh is not rows
    assert next(r for r in fresh if r["spotify_track_id"] == "s1")["retry_count"] == 1


def test_retry_stamps_dont_redo_the_stats(mdb, service, monkeypatch):
    _seed_edge_cases(mdb)
    made = []
    real = mdb.count_wishlist_by_category
    monkeypatch.setattr(mdb, "count_wishlist_by_category",
                        lambda profile_id=1: made.append(profile_id) or real(profile_id))
    rt = _runtime(mdb)
    get_wishlist_stats(rt)
    mdb.update_wishlist_retry("s1", False, "no results", profile_id=1)
    get_wishlist_stats(rt)
    assert made == [1]
    _insert(mdb, "new", _song("new", "New single", album_type="single"))
    assert get_wishlist_stats(rt)[0]["singles"] == real(1)["singles"]
    assert made == [1, 1]


def test_another_profiles_run_leaves_this_build_alone(mdb, service, monkeypatch):
    _seed_edge_cases(mdb)
    reads = _reads(mdb, monkeypatch)
    rt = _runtime(mdb)
    get_wishlist_tracks(rt, category="albums")
    _insert(mdb, "p2", _song("p2", "Theirs", album_type="single"), profile=2)
    _sql(mdb, "UPDATE wishlist_tracks SET source_info = '{}' WHERE profile_id = 2")
    get_wishlist_tracks(rt, category="albums")
    assert len(reads) == 1


# ── what a build keeps ───────────────────────────────────────────────────────


def test_once_both_bodies_exist_the_formatted_copy_is_let_go(mdb, service):
    from flask import Flask, jsonify

    from core.wishlist.routes import wishlist_tracks_body

    _seed_edge_cases(mdb)
    rt = _runtime(mdb)
    with Flask(__name__).app_context():
        def serialise(payload):
            return jsonify(payload).get_data()

        albums, _, _ = wishlist_tracks_body(rt, "albums", serialise)
        build = shared_cache().build(mdb, 1)
        assert build.sanitized is not None  # singles is still to come
        singles, _, _ = wishlist_tracks_body(rt, "singles", serialise)
        assert build.sanitized is None
        assert set(build.bodies) == {"albums", "singles"}
        # and the bodies are still the payloads, reused
        assert wishlist_tracks_body(rt, "albums", serialise)[0] is albums
        assert json.loads(singles) == json.loads(json.dumps(
            _old_payload(service, mdb, "singles", None)))
        # a limit or no category is still made, from the rows
        assert get_wishlist_tracks(rt, category="albums", limit=2)[0]["tracks"]
        assert build.sanitized is None


def test_a_profile_unused_for_10_minutes_is_dropped(mdb, service, clock):
    cache = WishlistReadCache()
    cache.build(mdb, 1)
    cache.counts(mdb, 1, lambda: {"singles": 0})
    clock[0] += 599
    cache.build(mdb, 2)
    assert sorted(k[1] for k in cache._builds) == [1, 2]
    clock[0] += 2  # profile 1 last used 601 s ago
    cache.build(mdb, 2)
    assert [k[1] for k in cache._builds] == [2]
    assert [k[1] for k in cache._counts] == []


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


def test_the_staging_block_lookup_reads_one_song(mdb):
    mdb.add_quarantine_source_block("staging:id:a", "/s/x.mp3|1|2", trigger="t")
    mdb.add_quarantine_source_block("staging:id:b", "/s/y.mp3|1|2", trigger="t")
    mdb.add_quarantine_source_block("someone", "z.mp3", trigger="t")
    assert mdb.get_quarantine_source_block_files("staging:id:a") == {"/s/x.mp3|1|2"}
    assert mdb.get_quarantine_source_block_files("staging:id:none") == set()
