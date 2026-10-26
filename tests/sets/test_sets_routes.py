"""The Sets routes (api/sets.py) and store (core/sets/store.py): saving a
set and its playlist, the view with steps, Swap, matching a tracklist and
a paste, Wanted, and the rules marked ``gauntlet``: sets are per profile,
bodies have a size, and a set never points at another profile's track."""

from __future__ import annotations

import pytest

from core.sets import matching
from tests.sets.conftest import put_set


def _rows(*ids, **extra):
    return [{"track_id": i, **extra} for i in ids]


def test_the_view_has_steps_and_the_meta_line(client):
    body = client.post("/api/sets/view", json={"tracks": _rows("1", "2", "3", "4") + [
        {"artist": "Vela Sund", "title": "Gravity Well", "state": "missing"}, {"track_id": "9", "locked": True}]}
    ).get_json()
    assert [r["track"]["title"] if r["track"] else None for r in body["rows"]] == [
        "Lowtide Hymn", "Foghorn Study", "Undertow", "Copper Sky", None, "Night Ferry"]
    kinds = [(s["kind"], s["reason"]) if s else None for s in body["steps"]]
    assert kinds[0] == ("smooth", "6A → 7A, +1 BPM")
    assert kinds[1] == ("smooth", "7A → 7A, +1 BPM · same key")
    # the missing line is stepped over: Copper Sky's step goes to Night Ferry
    assert kinds[3] == ("smooth", "8A → 8A, +2 BPM · same key") and kinds[4] is None and kinds[5] is None
    assert body["summary"] == {"tracks": 5, "seconds": 1800, "bpm_min": 118, "bpm_max": 124, "smooth": 4,
                               "jumps": 0, "unknown": 0, "locked": 1}


def test_save_as_mix_keeps_a_set_and_a_playlist(client, db):
    res = client.post("/api/sets", json={"name": "Sunday Set", "kind": "hand", "tracks": _rows("3", "1", "4")})
    assert res.status_code == 201
    set_id, playlist_id = res.get_json()["id"], res.get_json()["playlist_id"]
    assert playlist_id
    tracks = db.get_mirrored_playlist_tracks(playlist_id)
    assert [t["track_name"] for t in tracks] == ["Undertow", "Lowtide Hymn", "Copper Sky"]
    listed = client.get("/api/sets").get_json()["sets"]
    assert [(s["name"], s["tracks"], s["seconds"], s["energy"]) for s in listed] == [
        ("Sunday Set", 3, 1080, [4, 3, 5])]
    got = client.get(f"/api/sets/{set_id}").get_json()
    assert got["set"]["name"] == "Sunday Set" and len(got["rows"]) == 3 and got["steps"][1]["kind"] == "jump"
    # reorder: the playlist follows
    assert put_set(client, set_id, {"tracks": _rows("1", "3", "4")}).status_code == 200
    assert [t["track_name"] for t in db.get_mirrored_playlist_tracks(playlist_id)] == [
        "Lowtide Hymn", "Undertow", "Copper Sky"]
    assert put_set(client, set_id, {"name": "Renamed"}).status_code == 200
    assert client.get(f"/api/sets/{set_id}").get_json()["set"]["name"] == "Renamed"
    # deleting the set leaves its playlist
    assert client.delete(f"/api/sets/{set_id}").status_code == 200
    assert client.get(f"/api/sets/{set_id}").status_code == 404
    assert db.get_mirrored_playlist(playlist_id, profile_id=1) is not None


def test_a_saved_famous_mix_keeps_its_tracklist(client):
    res = client.post("/api/sets", json={
        "name": "Essential Mix: Saltmarsh", "kind": "famous", "source": "mixesdb", "source_id": "2019 - x",
        "source_url": "https://www.mixesdb.com/w/2019_-_x", "source_meta": {"title": "x", "date": "2019-05-12"},
        "tracks": [{"track_id": "4", "at": "00:00"}, {"artist": "Vela Sund", "title": "Gravity Well", "at": "04:12",
                                                       "state": "missing"},
                   {"artist": "ID", "title": "ID", "state": "id"}]})
    got = client.get(f"/api/sets/{res.get_json()['id']}").get_json()
    assert [r["state"] for r in got["rows"]] == ["owned", "missing", "id"]
    assert got["rows"][1]["at"] == "04:12" and got["set"]["source_url"] == "https://www.mixesdb.com/w/2019_-_x"
    assert got["set"]["source_meta"]["date"] == "2019-05-12"


def test_only_a_source_link_is_kept(client):
    res = client.post("/api/sets", json={"name": "x", "source": "mixesdb", "source_url": "javascript:alert(1)",
                                         "tracks": _rows("1")})
    assert client.get(f"/api/sets/{res.get_json()['id']}").get_json()["set"]["source_url"] is None


def test_the_input_is_checked(client):
    assert client.post("/api/sets", json={"name": "", "tracks": _rows("1")}).status_code == 400
    assert client.post("/api/sets", json={"name": "x", "tracks": []}).status_code == 400
    assert client.post("/api/sets", json={"name": "x", "tracks": "1"}).status_code == 400
    assert client.post("/api/sets", json={"name": "x", "tracks": _rows(*[str(i) for i in range(501)])}).status_code == 400
    assert client.post("/api/sets", data="nope", content_type="text/plain").status_code == 400
    assert client.post("/api/sets/paste", json={"text": "  "}).status_code == 400


@pytest.mark.gauntlet
def test_bodies_have_a_size(client):
    """Every body is read with a hard cap, even without a Content-Length."""
    big = b'{"x": "' + b"a" * (300 * 1024) + b'"}'
    for path in ("/api/sets", "/api/sets/view", "/api/sets/match"):
        assert client.post(path, data=big, content_type="application/json").status_code == 413
    paste = b'{"text": "' + b"A - B\\n" * 20000 + b'"}'
    assert client.post("/api/sets/paste", data=paste, content_type="application/json").status_code == 413

    # no Content-Length (a chunked body): still cut off at the cap
    import io

    res = client.post("/api/sets/paste", input_stream=io.BytesIO(paste), content_type="application/json",
                      environ_overrides={"wsgi.input_terminated": True})
    assert res.status_code == 413


@pytest.mark.gauntlet
def test_sets_are_per_profile(client, db):
    """A member never sees, changes or deletes another profile's set: it
    reads exactly like one that doesn't exist."""
    set_id = client.post("/api/sets", json={"name": "Mine", "tracks": _rows("1", "2")}).get_json()["id"]
    client.state["profile"] = 2
    assert client.get("/api/sets").get_json()["sets"] == []
    assert client.get(f"/api/sets/{set_id}").status_code == 404
    assert client.put(f"/api/sets/{set_id}", json={"name": "Taken"}).status_code == 404
    assert client.delete(f"/api/sets/{set_id}").status_code == 404
    client.state["profile"] = 1
    got = client.get(f"/api/sets/{set_id}").get_json()
    assert got["set"]["name"] == "Mine" and len(got["rows"]) == 2


@pytest.mark.gauntlet
def test_a_set_never_points_at_another_profiles_track(client, db):
    """Track 20 is profile 7's own: saved by profile 1 (shared library) it
    becomes a plain missing line, and the view never shows its details."""
    set_id = client.post("/api/sets", json={"name": "x", "tracks": _rows("1", "20")}).get_json()["id"]
    rows = client.get(f"/api/sets/{set_id}").get_json()["rows"]
    assert rows[1]["track"] is None and rows[1]["track_id"] is None and rows[1]["state"] == "missing"
    view = client.post("/api/sets/view", json={"tracks": _rows("20")}).get_json()
    assert view["rows"][0]["track"] is None
    swap = client.get("/api/sets/swap?before=2&after=4").get_json()
    assert "20" not in [a["track"]["id"] for a in swap["alternatives"]]


def test_swap_offers_what_fits_both_sides(client):
    body = client.get("/api/sets/swap?before=2&after=4&current=3&exclude=1,2,3,4").get_json()
    alts = body["alternatives"]
    ids = [a["track"]["id"] for a in alts]
    assert "3" not in ids and "1" not in ids
    assert ids[0] == "6"  # Kelp Garden: 7A at 120, smooth both sides
    first = alts[0]
    assert first["into"]["kind"] == "smooth" and first["out_of"]["kind"] == "smooth" and first["jumps"] == 0
    slow = next(a for a in alts if a["track"]["id"] == "7")
    assert slow["out_of"]["kind"] == "jump" and "2 steps on the wheel" in slow["out_of"]["reason"]
    assert body["before"]["title"] == "Foghorn Study" and body["after"]["title"] == "Copper Sky"


def test_matching_a_tracklist(client):
    body = client.post("/api/sets/match", json={"lines": [
        {"artist": "Pale Harbour", "title": "Foghorn Study", "at": "00:00"},
        {"artist": "Mareld", "title": "Signal Fire (Dub)"},
        {"artist": "Mareld", "title": "Signal Fire"},
        {"artist": "Okan Dere feat. Mira", "title": "Sand Script"},
        {"artist": "Someone Else", "title": "Copper Sky", "mbid": "mb-copper"},
        {"artist": "Vela Sund", "title": "Gravity Well"},
        {"artist": "ID", "title": "ID", "kind": "id"},
        {"artist": "Tidewater", "title": "Nite Ferry"},
        {"artist": "Someone", "title": "Not Yours"},
    ]}).get_json()
    states = [(r["state"], r["track"]["id"] if r["track"] else None) for r in body["rows"]]
    assert states == [("owned", "2"), ("version", "5"), ("owned", "5"), ("owned", "8"), ("owned", "4"),
                      ("missing", None), ("id", None), ("missing", None), ("missing", None)]
    version = body["rows"][1]
    assert version["have"] == "the original" and version["want_version"] == "Dub" and version["confidence"] == 0.8
    assert body["rows"][4]["matched_by"] == "musicbrainz"
    assert body["counts"] == {"owned": 4, "version": 1, "missing": 3, "ids": 1, "of": 8}


def test_a_close_spelling_is_owned_but_never_a_guessed_version(db):
    from core.library_scope import reset_library_scope, set_library_scope

    token = set_library_scope("shared")
    try:
        rows = matching.match_lines(db, [{"artist": "Tidewater", "title": "Night Ferrys"},
                                         {"artist": "Tidewater", "title": "Night Ferrys (Dub)"}])
    finally:
        reset_library_scope(token)
    assert [(r["state"], r["confidence"]) for r in rows] == [("owned", 0.9), ("missing", 0.0)]


def test_a_paste_is_read_and_matched(client):
    body = client.post("/api/sets/paste", json={"text": "01. Pale Harbour - Foghorn Study\n02. the vocals lol\n"
                                                        "03. ID - ID\n04. Vela Sund – Gravity Well\n"}).get_json()
    assert [r["state"] for r in body["rows"]] == ["owned", "id", "missing"]
    assert body["unread"][0]["why"] == "A comment, not a track" and body["unread"][0]["n"] == 2
    assert body["counts"]["of"] == 2 and body["lines"] == 4


def test_wanted_takes_missing_tracks_and_versions(client, db):
    body = client.post("/api/sets/wanted", json={"set_name": "Essential Mix", "tracks": [
        {"artist": "Vela Sund", "title": "Gravity Well"}, {"artist": "Mareld", "title": "Signal Fire (Dub)"}]}
    ).get_json()
    assert body["added"] == 2 and body["refused"] == []
    stored = db.get_wishlist_tracks(profile_id=1)
    names = sorted(t.get("name") or t.get("spotify_data", {}).get("name") for t in stored)
    assert names == ["Gravity Well", "Signal Fire (Dub)"]
    again = client.post("/api/sets/wanted", json={"tracks": [{"artist": "Vela Sund", "title": "Gravity Well"}]})
    assert again.get_json()["added"] == 0
    assert client.post("/api/sets/wanted", json={"tracks": []}).status_code == 400


def test_a_profile_is_needed(client):
    client.state["profile"] = None
    for method, path in (("get", "/api/sets"), ("post", "/api/sets"), ("get", "/api/sets/1"),
                         ("post", "/api/sets/view"), ("get", "/api/sets/swap"), ("get", "/api/sets/sources"),
                         ("get", "/api/sets/famous/search?q=x"), ("post", "/api/sets/famous/open"),
                         ("post", "/api/sets/match"), ("post", "/api/sets/paste"), ("post", "/api/sets/wanted")):
        assert getattr(client, method)(path, json={}).status_code == 401


def test_replace_tracks_keeps_rows_it_already_had(db):
    from core.playlists import user_playlists as up

    pid = up.create_playlist(db, 1, "Set")
    playlist = db.get_mirrored_playlist(pid, profile_id=1)
    up.add_tracks(db, playlist, [{"track_name": "A", "artist_name": "X"}, {"track_name": "B", "artist_name": "Y"}])
    first = {t["track_name"]: t["source_track_id"] for t in db.get_mirrored_playlist_tracks(pid)}
    assert up.replace_tracks(db, playlist, [{"track_name": "B", "artist_name": "Y"},
                                            {"track_name": "C", "artist_name": "Z"}]) == 2
    after = db.get_mirrored_playlist_tracks(pid)
    assert [t["track_name"] for t in after] == ["B", "C"] and after[0]["source_track_id"] == first["B"]
