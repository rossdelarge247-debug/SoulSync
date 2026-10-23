"""Putting a selection of library releases on Wanted (core/library/bulk_wanted.py)
and the routes around it: POST /api/wishlist/bulk with action "add", the
release, genre and artist indexes, the confirm's summary, following and
Remove from library's preview and confirm (api/library_index.py)."""

from __future__ import annotations

import json
import os

import pytest
from flask import Flask

from core.library import bulk_wanted, release_index as ri
from core.quality import presets


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _rows(db, sql, params=()):
    conn = db._get_connection()
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase
    presets.clear_cache()
    ri.clear_cache()
    database = MusicDatabase(database_path=str(tmp_path / "bulk-wanted.db"))
    _sql(database, "INSERT INTO artists (id, name, genres, spotify_artist_id) VALUES (1, 'Pale Harbour', '[\"Ambient\"]', 'sp-ph')")
    _sql(database, "INSERT INTO artists (id, name, genres) VALUES (2, 'Saltmarsh', '[\"Folk\"]')")
    # owned whole
    _sql(database, "INSERT INTO albums (id, artist_id, title, spotify_album_id) VALUES (10, 1, 'Night Ferry', 'sp-nf')")
    for i in range(3):
        _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, bitrate) VALUES (?, 10, 1, ?, ?, 900)",
             (f"nf{i}", f"Ferry {i + 1}", f"{tmp_path}/nf{i}.flac"))
    # owned, one short
    _sql(database, "INSERT INTO albums (id, artist_id, title, api_track_count, spotify_album_id) "
                   "VALUES (11, 1, 'Tidewater', 3, 'sp-tw')")
    for i in range(2):
        _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, bitrate) VALUES (?, 11, 1, ?, ?, 900)",
             (f"tw{i}", f"Tide {i + 1}", f"{tmp_path}/tw{i}.flac"))
    for eid, title, artist, aid in (("x1", "Lantern", "Pale Harbour", "sp-ph"), ("x2", "Weather Systems", "Saltmarsh", None),
                                     ("x3", "Open Water", "Saltmarsh", None)):
        _sql(database, "INSERT INTO metadata_cache_entities (source, entity_type, entity_id, name, artist_name, artist_id, "
                       "album_type, total_tracks, raw_json) VALUES ('spotify', 'album', ?, ?, ?, ?, 'album', 2, '{}')",
             (eid, title, artist, aid))
    # Open Water is already wanted
    data = {"id": "ow1", "name": "Ow 1", "artists": [{"name": "Saltmarsh"}],
            "album": {"id": "x3", "name": "Open Water", "album_type": "album", "artists": [{"name": "Saltmarsh"}]}}
    _sql(database, "INSERT INTO wishlist_tracks (spotify_track_id, spotify_data, profile_id) VALUES ('ow1', ?, 1)",
         (json.dumps(data),))
    return database


def _tracklist(release):
    titles = {"Tidewater": ["Tide 1", "Tide 2", "Tide 3"], "Lantern": ["Lamp", "Wick"],
              "Weather Systems": ["Front", "Isobar"]}
    names = titles.get(release["title"])
    if names is None:
        return {"success": False, "error": "Album not found"}
    return {"success": True, "source": "spotify", "resolved_album_id": release.get("source_id") or "sp-tw",
            "album": {"name": release["title"], "artists": [{"name": release["artist_name"]}], "images": []},
            "tracks": [{"id": f"{release['title']}-{i}", "name": n, "track_number": i + 1} for i, n in enumerate(names)]}


def _select(db, ids, pid=1):
    index = ri.build_index(db, pid)
    return ri.resolve_selection(index, {"release_ids": ids})[0]


def test_each_release_is_added_wanted_or_had(db):
    releases = _select(db, ["album:10", "album:11", "release:spotify:x1", "release:spotify:x2", "release:spotify:x3"])
    result = bulk_wanted.add_releases(db, releases, profile_id=1, fetch=_tracklist)
    assert (result["added"], result["already_wanted"], result["already_have"], result["failed"]) == (3, 1, 1, 0)
    # Tidewater: only the track you don't have; Lantern and Weather Systems whole
    assert result["tracks_added"] == 5
    wanted = {r["spotify_track_id"] for r in _rows(db, "SELECT spotify_track_id FROM wishlist_tracks WHERE profile_id = 1")}
    assert {"Tidewater-2", "Lantern-0", "Lantern-1", "Weather Systems-0", "Weather Systems-1"} <= wanted
    assert "Tidewater-0" not in wanted
    row = _rows(db, "SELECT spotify_data, source_type, source_info FROM wishlist_tracks WHERE spotify_track_id = 'Lantern-0'")[0]
    data = json.loads(row["spotify_data"])
    assert data["album"]["name"] == "Lantern" and data["album"]["album_type"] == "album"
    assert row["source_type"] == "album" and json.loads(row["source_info"])["source_page"] == "Library"
    outcomes = {r["title"]: r["outcome"] for r in result["results"]}
    assert outcomes == {"Night Ferry": "already_have", "Tidewater": "added", "Lantern": "added",
                        "Weather Systems": "added", "Open Water": "already_wanted"}


def test_adding_again_counts_as_already_wanted(db):
    releases = _select(db, ["release:spotify:x1"])
    bulk_wanted.add_releases(db, releases, profile_id=1, fetch=_tracklist)
    # the same release object (the index hasn't been rebuilt): every track is a duplicate
    again = bulk_wanted.add_releases(db, releases, profile_id=1, fetch=_tracklist)
    assert (again["added"], again["already_wanted"]) == (0, 1)


def test_a_release_without_a_tracklist_fails_on_its_own(db):
    releases = _select(db, ["release:spotify:x1"])
    releases[0] = {**releases[0], "title": "Nobody Knows"}
    result = bulk_wanted.add_releases(db, releases + _select(db, ["release:spotify:x2"]), profile_id=1, fetch=_tracklist)
    assert (result["failed"], result["added"]) == (1, 1)
    assert result["results"][0]["message"] == "Album not found"


def test_quality_and_profile_are_kept(db):
    qid = _rows(db, "SELECT id FROM quality_profiles WHERE is_default = 0 ORDER BY id LIMIT 1")
    qid = qid[0]["id"] if qid else None
    releases = _select(db, ["release:spotify:x2"], pid=3)
    bulk_wanted.add_releases(db, releases, profile_id=3, quality_profile_id=qid, fetch=_tracklist)
    rows = _rows(db, "SELECT profile_id, quality_profile_id FROM wishlist_tracks WHERE spotify_track_id LIKE 'Weather%'")
    assert {r["profile_id"] for r in rows} == {3}
    if qid is not None:
        assert {r["quality_profile_id"] for r in rows} == {qid}


def test_a_request_limit_refuses_whats_past_it(db, monkeypatch):
    monkeypatch.setattr(type(db), "add_to_wishlist_detailed",
                        lambda self, **kw: {"status": "rejected", "reason": "request_limit"})
    result = bulk_wanted.add_releases(db, _select(db, ["release:spotify:x1"]), profile_id=2, fetch=_tracklist)
    assert result["refused"] == 1 and result["added"] == 0


# ── routes ────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(db, monkeypatch, tmp_path):
    import api.library_index as lib_api
    import api.wishlist_routes as wl_routes
    who = {"pid": 1, "admin": True}
    monkeypatch.setattr(lib_api, "get_current_profile_id", lambda: who["pid"])
    monkeypatch.setattr("core.profile_context.get_current_profile_id", lambda: who["pid"])
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: who["admin"])
    monkeypatch.setattr(ri, "_active_server", lambda: None)
    monkeypatch.setattr(bulk_wanted, "_default_fetch", _tracklist)
    library = tmp_path / "Transfer"
    library.mkdir()
    lib_api.configure(get_database_=lambda: db, fix_art_url_=lambda u: f"/fixed{u}",
                      resolve_library_path_=lambda p: p, transfer_folder_=lambda: str(library))
    app = Flask(__name__)
    app.register_blueprint(lib_api.create_blueprint())
    app.register_blueprint(wl_routes.create_blueprint())
    c = app.test_client()
    c.who = who
    c.library = library
    return c


def test_releases_route(client):
    body = client.get("/api/library/releases?show=missing&sort=title").get_json()
    assert body["success"] and [r["title"] for r in body["releases"]] == ["Lantern", "Open Water", "Weather Systems"]
    assert body["show_counts"]["missing"] == 3 and body["totals"]["library"] == 2
    assert "built_ms" in body
    body = client.get("/api/library/releases?genre=Folk").get_json()
    assert body["genre_summary"]["missing"] == 2 and body["genre"] == "Folk"


def test_genres_and_artist_index_routes(client):
    genres = client.get("/api/library/genres?show=gaps").get_json()
    assert {g["name"] for g in genres["genres"]} == {"Ambient", "Folk"}
    artists = client.get("/api/library/artist-index?show=incomplete").get_json()
    assert [a["name"] for a in artists["artists"]] == ["Pale Harbour", "Saltmarsh"]


def test_summary_route(client):
    body = client.post("/api/library/releases/summary", json={"filter": {"show": "missing"}}).get_json()
    assert body["count"] == 2 and body["tracks"] == 4
    assert {a["name"] for a in body["artists"]} == {"Pale Harbour", "Saltmarsh"}
    assert client.post("/api/library/releases/summary", json={}).status_code == 400


def test_bulk_add_route(client, db):
    resp = client.post("/api/wishlist/bulk", json={"action": "add", "quality": "target",
                                                    "release_ids": ["album:10", "release:spotify:x1"]})
    body = resp.get_json()
    assert resp.status_code == 200 and body["success"]
    assert (body["added"], body["already_have"], body["already_wanted"]) == (1, 1, 0)
    assert body["asks_first"] is False
    # the index sees it at once
    rel = {r["title"]: r for r in client.get("/api/library/releases").get_json()["releases"]}
    assert rel["Lantern"]["wanted"]["status"] == "searching"


def test_bulk_add_by_filter_with_exclusions(client):
    body = client.post("/api/wishlist/bulk", json={"action": "add", "filter": {"show": "missing"},
                                                    "exclude_ids": ["release:spotify:x2"]}).get_json()
    assert body["added"] == 1 and [r["title"] for r in body["results"]] == ["Lantern"]


def test_bulk_add_refuses_an_unknown_quality_and_too_many(client, monkeypatch):
    bad = client.post("/api/wishlist/bulk", json={"action": "add", "quality": 99999, "release_ids": ["album:10"]})
    assert bad.status_code == 400 and bad.get_json()["error"] == "unknown_quality"
    monkeypatch.setattr(ri, "MAX_SELECTION", 1)
    many = client.post("/api/wishlist/bulk", json={"action": "add", "filter": {"show": "missing"}})
    assert many.status_code == 400 and many.get_json()["error"] == "too_many"


def test_a_member_adds_to_their_own_wanted(client, db):
    pid = db.create_profile(name="kim")
    client.who.update(pid=pid, admin=False)
    # naming another profile doesn't work for a member
    client.post("/api/wishlist/bulk", json={"action": "add", "profile_id": 1, "release_ids": ["release:spotify:x2"]})
    owners = {r["profile_id"] for r in _rows(db, "SELECT profile_id FROM wishlist_tracks WHERE spotify_track_id LIKE 'Weather%'")}
    assert owners == {pid}


def test_a_profile_without_download_rights_asks(client, db):
    pid = db.create_profile(name="guest")
    _sql(db, "UPDATE profiles SET can_download = 0 WHERE id = ?", (pid,))
    client.who.update(pid=pid, admin=False)
    body = client.post("/api/wishlist/bulk", json={"action": "add", "release_ids": ["release:spotify:x2"]}).get_json()
    assert body["asks_first"] is True and body["added"] == 1
    # the rows are requests: an admin approves them before anything downloads
    pending = {r["spotify_track_id"] for r in db.get_pending_request_rows(pid)}
    assert pending == {"Weather Systems-0", "Weather Systems-1"}


def test_the_old_bulk_actions_still_answer(client):
    resp = client.post("/api/wishlist/bulk", json={"action": "nope"})
    assert resp.status_code == 400


def test_follow_route_and_bulk_follow(client, db):
    body = client.post("/api/library/artists/follow", json={"artist_ids": ["1", "2"]}).get_json()
    # Saltmarsh has no source id the watchlist can use
    assert (body["followed"], body["no_id"]) == (1, 1)
    again = client.post("/api/library/artists/follow", json={"artist_ids": ["1"]}).get_json()
    assert again["already_following"] == 1
    page = client.get("/api/library/artist-index?show=following").get_json()
    assert [a["name"] for a in page["artists"]] == ["Pale Harbour"]


def test_remove_from_library_previews_then_moves_to_the_recycle_bin(client, db, tmp_path):
    files = [r["file_path"] for r in _rows(db, "SELECT file_path FROM tracks WHERE album_id = 10")]
    for path in files:
        with open(path, "wb") as fh:
            fh.write(b"x" * 10)
    preview = client.post("/api/library/albums/remove-preview", json={"release_ids": ["album:10"]}).get_json()
    assert preview["success"] and preview["total"] == 3 and preview["total_bytes"] == 30
    assert preview["meta"]["albums"] == 1 and preview["sample"][0]["action"] == "recycle"
    # nothing moved yet
    assert all(os.path.exists(p) for p in files)
    refused = client.post("/api/library/albums/remove", json={"plan_id": "nope"})
    assert refused.status_code == 409 and refused.get_json()["code"] == "plan_unknown"
    done = client.post("/api/library/albums/remove", json={"plan_id": preview["plan_id"]}).get_json()
    assert done["albums_removed"] == 1 and done["files_moved"] == 3
    assert not any(os.path.exists(p) for p in files)
    assert _rows(db, "SELECT id FROM albums WHERE id = 10") == []
    assert os.listdir(os.path.join(str(client.library), ".deleted"))


def test_the_artist_pages_remove_goes_through_the_same_plan(client, db):
    """HANDOFF 74: every album of the artist, previewed, to the recycle bin;
    the artist row goes once nothing of theirs is left."""
    for path in [r["file_path"] for r in _rows(db, "SELECT file_path FROM tracks WHERE artist_id = 1")]:
        with open(path, "wb") as fh:
            fh.write(b"x" * 10)
    _sql(db, "INSERT INTO albums (id, artist_id, title) VALUES (12, 1, 'Empty Row')")
    preview = client.post("/api/library/albums/remove-preview", json={"artist_id": 1}).get_json()
    assert preview["success"] and preview["total"] == 5
    assert preview["meta"]["albums"] == 3 and preview["meta"]["artist_id"] == "1"
    assert {i["reason"] for i in preview["sample"]} == {"Pale Harbour · Night Ferry", "Pale Harbour · Tidewater"}
    # nothing moved or forgotten by the preview
    assert len(_rows(db, "SELECT id FROM albums WHERE artist_id = 1")) == 3
    done = client.post("/api/library/albums/remove", json={"plan_id": preview["plan_id"]}).get_json()
    assert done["albums_removed"] == 3 and done["files_moved"] == 5 and done["artist_removed"] is True
    assert _rows(db, "SELECT id FROM artists WHERE id = 1") == []
    assert len(_rows(db, "SELECT id FROM artists WHERE id = 2")) == 1


def test_the_artist_stays_while_something_of_theirs_is_left(client, db):
    _sql(db, "INSERT INTO albums (id, artist_id, title) VALUES (30, 2, 'Brine')")
    _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path) VALUES ('g1', 10, 2, 'Guest', '')")
    preview = client.post("/api/library/albums/remove-preview", json={"artist_id": 2}).get_json()
    done = client.post("/api/library/albums/remove", json={"plan_id": preview["plan_id"]}).get_json()
    # their guest track on Pale Harbour's album keeps them
    assert done["albums_removed"] == 1 and done["artist_removed"] is False
    assert len(_rows(db, "SELECT id FROM artists WHERE id = 2")) == 1


def test_remove_from_library_is_for_admins(client, db):
    client.who.update(pid=db.create_profile(name="kim"), admin=False)
    assert client.post("/api/library/albums/remove-preview", json={"album_ids": [10]}).status_code == 403
    assert client.post("/api/library/albums/remove", json={"plan_id": "x"}).status_code == 403


def test_reads_need_a_profile(client):
    client.who["pid"] = None
    assert client.get("/api/library/releases").status_code == 401


def test_upgrade_applies_pending_findings_for_those_albums(client, db, monkeypatch):
    import api.library_index as lib_api
    track = _rows(db, "SELECT id FROM tracks WHERE album_id = 10 ORDER BY id LIMIT 1")[0]["id"]
    monkeypatch.setattr("core.quality.upgrades.pending_upgrades_for_tracks",
                        lambda _db, ids: {str(track): {"finding_id": 77}} if str(track) in {str(i) for i in ids} else {})
    applied = []
    monkeypatch.setattr(lib_api, "bulk_fix_findings", lambda ids: applied.append(ids) or {"fixed": len(ids)})
    body = client.post("/api/library/albums/upgrade", json={"album_ids": [10, 11]}).get_json()
    assert applied == [[77]]
    assert (body["queued"], body["albums_with_upgrades"], body["albums_without"]) == (1, 1, 1)


def test_summary_sample_size(client):
    body = client.post("/api/library/releases/summary", json={"filter": {"show": "missing"}, "sample": 50}).get_json()
    assert len(body["sample"]) == 2
    body = client.post("/api/library/releases/summary", json={"filter": {"show": "missing"}, "sample": 1}).get_json()
    assert len(body["sample"]) == 1
