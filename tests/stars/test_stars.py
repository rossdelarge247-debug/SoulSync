"""Stars (api/stars.py, core/stars/store.py), the Starred filter on Tracks
(``/api/library/dj/browse?starred=1``) and Export to Traktor's rating. The
rules marked ``gauntlet``: stars are per profile, only a library track of
the caller's with its file can be starred, and bodies have a size."""

from __future__ import annotations

import io
import xml.etree.ElementTree as ET

import pytest

from core.dj import traktor


def _star(client, *ids):
    return client.post("/api/stars", json={"track_ids": list(ids)})


def _status(client, *ids, songs=None):
    body = {"track_ids": list(ids)}
    if songs is not None:
        body["songs"] = songs
    return client.post("/api/stars/status", json=body).get_json()


def test_star_unstar_and_count(client):
    res = _star(client, "4", "9", "4")
    assert res.status_code == 200
    assert res.get_json()["starred"] == ["4", "9"] and res.get_json()["count"] == 2
    # starring again changes nothing
    assert _star(client, "4").get_json()["count"] == 2
    assert client.get("/api/stars/count").get_json() == {"success": True, "count": 2, "missing": 0}
    body = _status(client, "4", "9", "1")
    assert body["tracks"] == {"4": {"starred": True, "can_star": True}, "9": {"starred": True, "can_star": True},
                              "1": {"starred": False, "can_star": True}}
    res = client.post("/api/stars/remove", json={"track_ids": ["4", "1"]})
    assert res.get_json()["unstarred"] == ["4"] and res.get_json()["count"] == 1


def test_the_status_of_a_page_is_one_request(client):
    ids = [str(i) for i in range(1, 10)] + ["999", "30"]
    _star(client, "2", "3")
    body = _status(client, *ids)
    assert [i for i, s in body["tracks"].items() if s["starred"]] == ["2", "3"]
    # not in the library, or no file: no star at all
    assert body["tracks"]["999"] == {"starred": False, "can_star": False}
    assert body["tracks"]["30"] == {"starred": False, "can_star": False}


def test_a_playlists_rows_are_matched_by_title_and_artist(client):
    _star(client, "9")
    body = _status(client, songs=[{"title": "night ferry", "artist": "TIDEWATER"},
                                  {"title": "Gravity Well", "artist": "Vela Sund"}, {"title": "Undertow"}])
    assert body["songs"] == [{"track_id": "9", "starred": True, "can_star": True},
                             {"track_id": None, "starred": False, "can_star": False},
                             {"track_id": None, "starred": False, "can_star": False}]


def test_a_track_whose_file_went_missing_keeps_its_star(client, db):
    from tests.sets.conftest import _sql

    _star(client, "5")
    _sql(db, "UPDATE tracks SET file_path = '' WHERE id = '5'")
    assert client.get("/api/stars/count").get_json()["missing"] == 1
    assert _status(client, "5")["tracks"]["5"] == {"starred": True, "can_star": False}
    # it can be taken off, not put back on until the file returns
    assert client.post("/api/stars/remove", json={"track_ids": ["5"]}).get_json()["unstarred"] == ["5"]
    res = _star(client, "5")
    assert res.status_code == 409 and res.get_json()["left_out"] == [{"id": "5", "reason": "file_missing"}]


def test_the_starred_filter_on_tracks(client, db):
    from tests.sets.conftest import _sql

    _star(client, "9", "4")
    _sql(db, "UPDATE tracks SET file_path = '' WHERE id = '4'")
    every = client.get("/api/library/dj/browse?sort=title").get_json()
    assert {t["id"]: t["starred"] for t in every["tracks"]}["9"] is True
    assert "4" not in {t["id"] for t in every["tracks"]}  # no file: not on Tracks
    starred = client.get("/api/library/dj/browse?starred=1&sort=title").get_json()
    assert [(t["id"], t["starred"], t["file_missing"]) for t in starred["tracks"]] == [
        ("4", True, True), ("9", True, False)]
    assert starred["total"] == 2
    # the filters still apply
    assert [t["id"] for t in client.get("/api/library/dj/browse?starred=1&key=8A&bpm_min=123").get_json()[
        "tracks"]] == ["9"]


def test_the_input_is_checked(client):
    assert client.post("/api/stars", json={"track_ids": "4"}).status_code == 400
    assert client.post("/api/stars", json={"track_ids": []}).status_code == 400
    assert client.post("/api/stars", json={"track_ids": [str(i) for i in range(501)]}).status_code == 400
    assert client.post("/api/stars", data="nope", content_type="text/plain").status_code == 400
    assert client.post("/api/stars/status", json={"songs": "x"}).status_code == 400
    assert _star(client, True, None, {"a": 1}).status_code == 400
    client.state["profile"] = None
    assert _star(client, "4").status_code == 401
    assert client.get("/api/stars/count").status_code == 401


@pytest.mark.gauntlet
def test_stars_are_per_profile(client):
    """Profiles never see each other's stars, and one can't take another's off."""
    _star(client, "4", "9")
    client.state["profile"] = 2
    assert client.get("/api/stars/count").get_json()["count"] == 0
    assert _status(client, "4")["tracks"]["4"] == {"starred": False, "can_star": True}
    assert client.post("/api/stars/remove", json={"track_ids": ["4", "9"]}).get_json()["unstarred"] == []
    assert [t["id"] for t in client.get("/api/library/dj/browse?starred=1").get_json()["tracks"]] == []
    _star(client, "1")
    client.state["profile"] = 1
    assert client.get("/api/stars/count").get_json()["count"] == 2
    assert _status(client, "1", "4")["tracks"] == {"1": {"starred": False, "can_star": True},
                                                  "4": {"starred": True, "can_star": True}}


@pytest.mark.gauntlet
def test_only_a_library_track_of_yours_can_be_starred(client, db):
    """Track 20 is profile 7's own; a shared-library member can't star it,
    learn whether it exists, or see it under Starred. Track 30 has no file."""
    res = _star(client, "20", "30", "999")
    assert res.status_code == 409
    assert res.get_json()["left_out"] == [{"id": "20", "reason": "not_in_library"},
                                          {"id": "30", "reason": "file_missing"},
                                          {"id": "999", "reason": "not_in_library"}]
    assert _status(client, "20")["tracks"]["20"] == {"starred": False, "can_star": False}
    # a mixed request stars only what it may
    assert _star(client, "4", "20").get_json()["starred"] == ["4"]
    conn = db._get_connection()
    try:
        assert [tuple(r) for r in conn.execute("SELECT profile_id, track_id FROM track_stars")] == [(1, "4")]
    finally:
        conn.close()
    # profile 7 with its own library scope may star its own track
    client.state.update(profile=7, scope=7)
    assert _star(client, "20").status_code == 200
    client.state.update(profile=1, scope="shared")
    assert [t["id"] for t in client.get("/api/library/dj/browse?starred=1").get_json()["tracks"]] == ["4"]


@pytest.mark.gauntlet
def test_bodies_have_a_size(client):
    big = b'{"track_ids": ["' + b"a" * (300 * 1024) + b'"]}'
    for path in ("/api/stars", "/api/stars/remove", "/api/stars/status", "/api/sets/holding", "/api/sets/1/tracks"):
        assert client.post(path, data=big, content_type="application/json").status_code == 413, path
    res = client.post("/api/stars", input_stream=io.BytesIO(big), content_type="application/json",
                      environ_overrides={"wsgi.input_terminated": True})
    assert res.status_code == 413


def test_traktor_rates_a_starred_track_at_the_top():
    location = {"VOLUME": "Music HD", "DIR": "/:x/:", "FILE": "a.flac"}
    entries = [{"track": {"id": "1", "title": "Night Ferry"}, "location": location},
               {"track": {"id": "2", "title": "Low Tide"}, "location": {**location, "FILE": "b.flac"}}]
    root = ET.fromstring(traktor.build_nml("x", entries, starred={"1"}))
    info = {e.get("TITLE"): e.find("INFO") for e in root.findall("COLLECTION/ENTRY")}
    assert info["Night Ferry"].get("RANKING") == "255"
    assert info["Low Tide"] is None or info["Low Tide"].get("RANKING") is None


# ── after the gauntlet review ─────────────────────────────────────────────────

@pytest.mark.gauntlet
def test_a_star_follows_its_track_when_the_row_is_rekeyed(client, db):
    """M1: a scan folds a superseded row into the live one
    (``_absorb_track_row``): every profile's star moves to the keeper, a
    star already there stays, and a mix set's row follows too."""
    from tests.sets.conftest import _sql

    _star(client, "4")
    client.state["profile"] = 2
    _star(client, "4", "3")
    client.state["profile"] = 1
    set_id = client.post("/api/sets", json={"name": "x", "tracks": [{"track_id": "4"}]}).get_json()["id"]
    _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration) "
             "VALUES ('40', 'a103', '103', 'Copper Sky', '/m/40.flac', 360000)")
    conn = db._get_connection()
    try:
        conn.execute("INSERT INTO track_stars (profile_id, track_id, starred_at) VALUES (2, '40', 1)")
        db._absorb_track_row(conn.cursor(), "4", "40", [])
        conn.commit()
        rows = sorted(tuple(r) for r in conn.execute("SELECT profile_id, track_id FROM track_stars"))
        set_rows = [r[0] for r in conn.execute("SELECT track_id FROM dj_set_tracks WHERE set_id = ?", (set_id,))]
    finally:
        conn.close()
    assert rows == [(1, "40"), (2, "3"), (2, "40")]
    assert set_rows == ["40"]
    assert _status(client, "40")["tracks"]["40"] == {"starred": True, "can_star": True}


@pytest.mark.gauntlet
def test_stars_on_tracks_away_for_a_while_reattach_when_they_return(client, db):
    """H-A: a stopped full refresh (or an unplugged drive) leaves the track
    rows gone for a while; the scans that follow must not sweep the stars,
    and when the same ids come back the stars are there."""
    from tests.sets.conftest import _sql

    _star(client, "4", "9")
    client.state["profile"] = 2
    _star(client, "4")
    client.state["profile"] = 1
    conn = db._get_connection()
    try:
        saved = [tuple(r) for r in conn.execute(
            "SELECT id, album_id, artist_id, title, file_path, duration FROM tracks WHERE id IN ('4', '9')")]
        artists = [tuple(r) for r in conn.execute("SELECT id, name FROM artists")]
        albums = [tuple(r) for r in conn.execute("SELECT id, artist_id, title FROM albums")]
    finally:
        conn.close()
    _sql(db, "DELETE FROM tracks WHERE id IN ('4', '9')")  # what a stopped clear_server_data leaves
    db.cleanup_orphaned_records()
    db.delete_removed_content(set(), set(), "plex")
    db.absorb_superseded_tracks({"a103"}, {"5"}, "plex")
    assert client.get("/api/stars/count").get_json()["count"] == 0  # away: not counted
    # the next scan writes them back, artists and albums first
    for row in artists:
        _sql(db, "INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)", row)
    for row in albums:
        _sql(db, "INSERT OR IGNORE INTO albums (id, artist_id, title) VALUES (?, ?, ?)", row)
    for row in saved:
        _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration) "
                 "VALUES (?, ?, ?, ?, ?, ?)", row)
    assert _status(client, "4", "9")["tracks"] == {"4": {"starred": True, "can_star": True},
                                                   "9": {"starred": True, "can_star": True}}
    client.state["profile"] = 2
    assert _status(client, "4")["tracks"]["4"]["starred"] is True


def test_stars_on_ids_that_are_away_dont_fill_the_cap(client, db, monkeypatch):
    """H-A: the per-profile cap counts stars on tracks the library has now."""
    from core.stars import store
    from tests.sets.conftest import _sql

    monkeypatch.setattr(store, "MAX_STARS", 2)
    assert _star(client, "1", "2").status_code == 200
    assert _star(client, "3").status_code == 400  # at the cap
    _sql(db, "DELETE FROM tracks WHERE id = '2'")
    assert _star(client, "3").get_json()["starred"] == ["3"]


def test_starring_many_reads_the_stars_once(db, monkeypatch):
    """L1: one lookup of what's starred already, not one per track."""
    from core.library_scope import reset_library_scope, set_library_scope
    from core.stars import store

    calls = []
    real = store._starred
    monkeypatch.setattr(store, "_starred", lambda *a: calls.append(1) or real(*a))
    token = set_library_scope("shared")
    try:
        assert store.star(db, 1, ["1", "2", "3", "4", "5"])["starred"] == ["1", "2", "3", "4", "5"]
    finally:
        reset_library_scope(token)
    assert len(calls) == 1


def test_ids_and_songs_are_looked_up_apart(client):
    """L2: 500 ids and 500 songs in one status request: neither is cut off."""
    _star(client, "9")
    ids = [str(i) for i in range(1, 9)] + [f"x{i}" for i in range(492)]  # 500, not "9"
    songs = [{"title": "Lowtide Hymn", "artist": "x"}] * 499 + [{"title": "Night Ferry", "artist": "Tidewater"}]
    body = _status(client, *ids, songs=songs)
    assert len(body["tracks"]) == 500 and body["tracks"]["1"] == {"starred": False, "can_star": True}
    assert len(body["songs"]) == 500
    assert body["songs"][-1] == {"track_id": "9", "starred": True, "can_star": True}


def test_a_rekeyed_set_row_moves_the_sets_revision(client, db):
    """L-A: the absorb that repoints a set's row counts the set on, so a
    page holding the old id gets a conflict instead of saving it back."""
    from tests.sets.conftest import _sql

    set_id = client.post("/api/sets", json={"name": "x", "tracks": [{"track_id": "4"}, {"track_id": "1"}]}
                         ).get_json()["id"]
    _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration) "
             "VALUES ('40', 'a103', '103', 'Copper Sky', '/m/40.flac', 360000)")
    conn = db._get_connection()
    try:
        db._absorb_track_row(conn.cursor(), "4", "40", [])
        conn.commit()
    finally:
        conn.close()
    stale = client.put(f"/api/sets/{set_id}", json={"tracks": [{"track_id": "4"}, {"track_id": "1"}],
                                                    "base_revision": 0})
    assert stale.status_code == 409 and stale.get_json()["revision"] == 1
    assert [r["track_id"] for r in client.get(f"/api/sets/{set_id}").get_json()["rows"]] == ["40", "1"]
