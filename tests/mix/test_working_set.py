"""The working set (core/sets/working.py; ``/api/sets/working``) and "Add"
while a set plays (``POST /api/sets/<id>/tracks`` with ``after``). Marked
``gauntlet``: a working set is per profile and only ever one of the
caller's own sets; bodies have a size; the add keeps Sets' revision and
playlist rules."""

from __future__ import annotations

import pytest

from tests.mix.conftest import make_set


def _working(client):
    res = client.get("/api/sets/working")
    assert res.status_code == 200
    return res.get_json()["working"]


def _rows(client, set_id):
    return [r["track_id"] for r in client.get(f"/api/sets/{set_id}").get_json()["rows"]]


@pytest.mark.gauntlet
def test_choose_read_and_clear(client):
    assert _working(client) is None
    set_id = make_set(client, "Sunday Set", ["4", "8"])
    res = client.put("/api/sets/working", json={"set_id": set_id})
    assert res.status_code == 200
    assert res.get_json()["working"]["id"] == set_id
    assert _working(client) == {**res.get_json()["working"], "name": "Sunday Set"}
    assert client.put("/api/sets/working", json={"set_id": None}).get_json()["working"] is None
    assert _working(client) is None


@pytest.mark.gauntlet
def test_one_per_profile_and_only_your_own_sets(client):
    mine = make_set(client, "Mine", ["4"])
    assert client.put("/api/sets/working", json={"set_id": mine}).status_code == 200
    client.state["profile"] = 2
    # another profile's set can't be chosen, and reads like one that doesn't exist
    res = client.put("/api/sets/working", json={"set_id": mine})
    assert res.status_code == 404 and res.get_json()["error"] == "That set isn't one of yours"
    assert client.put("/api/sets/working", json={"set_id": 99999}).get_json() == res.get_json()
    assert _working(client) is None
    theirs = make_set(client, "Theirs", ["8"])
    assert client.put("/api/sets/working", json={"set_id": theirs}).status_code == 200
    client.state["profile"] = 1
    assert _working(client)["id"] == mine


@pytest.mark.gauntlet
def test_a_removed_set_is_no_working_set(client):
    set_id = make_set(client, "Gone", ["4"])
    client.put("/api/sets/working", json={"set_id": set_id})
    assert client.delete(f"/api/sets/{set_id}").status_code == 200
    assert _working(client) is None


@pytest.mark.gauntlet
@pytest.mark.parametrize("body", [{"set_id": "1"}, {"set_id": True}, {"set_id": -3}, {"set_id": 1.5}, {}])
def test_bad_bodies(client, body):
    res = client.put("/api/sets/working", json=body)
    if body == {}:
        # no set_id: none
        assert res.status_code == 200 and res.get_json()["working"] is None
    else:
        assert res.status_code == 400


@pytest.mark.gauntlet
def test_bodies_are_capped(client):
    big = {"set_id": 1, "pad": "x" * 2048}
    assert client.put("/api/sets/working", json=big).status_code == 413
    huge = {"track_ids": ["4"], "name": "x" * (70 * 1024)}
    assert client.post("/api/sets/working/start", json=huge).status_code == 413


@pytest.mark.gauntlet
def test_start_makes_a_set_its_playlist_and_the_working_set(client, db):
    res = client.post("/api/sets/working/start", json={"name": "Set from Sunday 26 Oct", "track_ids": ["9", "20", "30"]})
    assert res.status_code == 201, res.get_json()
    set_id = res.get_json()["id"]
    assert res.get_json()["working"]["id"] == set_id
    # only your library's tracks with their file
    assert _rows(client, set_id) == ["9"]
    saved = client.get(f"/api/sets/{set_id}").get_json()["set"]
    assert saved["name"] == "Set from Sunday 26 Oct" and saved["playlist_id"]
    # nothing that can go in: nothing made
    res = client.post("/api/sets/working/start", json={"name": "Nope", "track_ids": ["20"]})
    assert res.status_code == 400
    assert _working(client)["id"] == set_id
    assert client.post("/api/sets/working/start", json={"name": "", "track_ids": ["9"]}).status_code == 400


@pytest.mark.gauntlet
def test_add_after_the_playing_track(client, db):
    set_id = make_set(client, "Playing", ["1", "2", "3", "4"])
    before = client.get(f"/api/sets/{set_id}").get_json()["set"]["revision"]
    res = client.post(f"/api/sets/{set_id}/tracks", json={"track_ids": ["8"], "after": {"track_id": "2", "number": 2}})
    body = res.get_json()
    assert res.status_code == 200 and body["placed"] == "after"
    assert body["added"] == [{"track_id": "8", "number": 3}]
    assert _rows(client, set_id) == ["1", "2", "8", "3", "4"]
    # the revision moved on: an open page's save from before is refused
    assert body["revision"] == before + 1
    stale = client.put(f"/api/sets/{set_id}", json={"name": "x", "base_revision": before})
    assert stale.status_code == 409
    # the playlist follows, in the set's order
    playlist_id = client.get(f"/api/sets/{set_id}").get_json()["set"]["playlist_id"]
    names = [t["track_name"] for t in db.get_mirrored_playlist_tracks(int(playlist_id))]
    assert names == ["Lowtide Hymn", "Foghorn Study", "Sand Script", "Undertow", "Copper Sky"]


@pytest.mark.gauntlet
def test_add_after_a_track_the_set_no_longer_holds_goes_at_the_end(client):
    set_id = make_set(client, "Playing", ["1", "2"])
    body = client.post(f"/api/sets/{set_id}/tracks",
                       json={"track_ids": ["8"], "after": {"track_id": "5", "number": 1}}).get_json()
    assert body["placed"] == "end" and body["added"] == [{"track_id": "8", "number": 3}]
    assert _rows(client, set_id) == ["1", "2", "8"]


def test_add_after_finds_the_track_when_its_number_moved(client):
    set_id = make_set(client, "Playing", ["1", "2", "3"])
    body = client.post(f"/api/sets/{set_id}/tracks",
                       json={"track_ids": ["8"], "after": {"track_id": "3", "number": 1}}).get_json()
    assert body["placed"] == "after" and _rows(client, set_id) == ["1", "2", "3", "8"]


@pytest.mark.gauntlet
def test_add_after_in_another_profiles_set_is_refused(client):
    set_id = make_set(client, "Mine", ["1", "2"])
    client.state["profile"] = 2
    res = client.post(f"/api/sets/{set_id}/tracks", json={"track_ids": ["8"], "after": {"track_id": "1", "number": 1}})
    assert res.status_code == 404
    client.state["profile"] = 1
    assert _rows(client, set_id) == ["1", "2"]


def test_add_without_after_is_unchanged(client):
    set_id = make_set(client, "Plain", ["1"])
    body = client.post(f"/api/sets/{set_id}/tracks", json={"track_ids": ["8", "1"]}).get_json()
    assert body["placed"] == "end" and body["added"] == [{"track_id": "8", "number": 2}]
    assert body["already"] == ["1"]
