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
    # only your library's tracks with their file, and it says how many went in
    # (the toast says the server's count, gauntlet review L1)
    assert _rows(client, set_id) == ["9"]
    assert res.get_json()["tracks"] == 1
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


# ── after the gauntlet review (L5) ────────────────────────────────────────────

from core.sets import store as sets_store  # noqa: E402


def _r(tid, locked=False, transition=None):
    return {"track_id": tid, "locked": 1 if locked else 0, "transition": transition}


def test_l5_insert_keeps_locked_rows_in_their_places():
    rows = [_r("1"), _r("2"), _r("3", locked=True), _r("4"), _r("5", locked=True)]
    fresh = [_r("8"), _r("9")]
    out = sets_store.insert_keeping_locked(rows, 0, fresh)
    assert [r["track_id"] for r in out] == ["1", "8", "3", "9", "5", "2", "4"]
    # the locked rows hold their indexes; nothing before the insert moves
    assert out[2] is rows[2] and out[4] is rows[4] and out[0] is rows[0]
    # after the last row, or with no locked rows: plainly after
    assert [r["track_id"] for r in sets_store.insert_keeping_locked(rows, 4, fresh)] == \
        ["1", "2", "3", "4", "5", "8", "9"]
    plain = [_r("1"), _r("2")]
    assert [r["track_id"] for r in sets_store.insert_keeping_locked(plain, 0, [_r("8")])] == ["1", "8", "2"]


def test_l5_a_row_whose_next_track_changed_goes_back_to_auto():
    long = sets_store.clean_transition({"style": "long_blend", "bars": 32})
    rows = [_r("1", transition=long), {"track_id": None, "transition": None}, _r("2", transition=long),
            _r("3", transition=long)]
    fresh = [_r("8")]
    placed = sets_store.insert_keeping_locked(rows, 2, fresh)
    out = sets_store.reset_changed_joins(rows, placed)
    by = {r["track_id"]: r["transition"] for r in out if r["track_id"]}
    auto16 = sets_store.clean_transition(sets_store.RESET_TRANSITION)
    # 2 now goes into 8, not 3: reset; 1 still goes into 2; 3 is last (it had no next)
    assert by == {"1": long, "2": auto16, "8": None, "3": long}
    assert sets_store.read_transition(auto16) == {"style": "auto", "bars": 16}


def test_l8_adding_the_track_that_already_comes_next_keeps_the_join():
    long = sets_store.clean_transition({"style": "long_blend", "bars": 32})
    rows = [_r("1", transition=long), _r("2", transition=long), _r("3")]
    # "Add again": a second 2 straight after 1, which already led into 2
    placed = sets_store.insert_keeping_locked(rows, 0, [_r("2")])
    out = sets_store.reset_changed_joins(rows, placed)
    assert [r["track_id"] for r in out] == ["1", "2", "2", "3"]
    assert out[0]["transition"] == long  # still 1 into 2: the same join
    assert out[2]["transition"] == long  # the old 2 still goes into 3
    # a different track in between is still a new join
    other = sets_store.reset_changed_joins(rows, sets_store.insert_keeping_locked(rows, 0, [_r("9")]))
    assert other[0]["transition"] == sets_store.clean_transition(sets_store.RESET_TRANSITION)


@pytest.mark.gauntlet
def test_l5_add_after_keeps_locked_rows_and_resets_the_changed_joins(client):
    rows = [{"track_id": "1", "state": "owned", "transition": {"style": "long_blend", "bars": 32}},
            {"track_id": "2", "state": "owned", "transition": {"style": "cut"}},
            {"track_id": "3", "state": "owned", "locked": True, "transition": {"style": "bass_swap", "bars": 8}},
            {"track_id": "4", "state": "owned"}]
    set_id = client.post("/api/sets", json={"name": "Locked", "kind": "hand", "tracks": rows}).get_json()["id"]
    body = client.post(f"/api/sets/{set_id}/tracks",
                       json={"track_ids": ["8"], "after": {"track_id": "1", "number": 1}}).get_json()
    assert body["placed"] == "after" and body["added"] == [{"track_id": "8", "number": 2}]
    got = client.get(f"/api/sets/{set_id}").get_json()["rows"]
    assert [r["track_id"] for r in got] == ["1", "8", "3", "2", "4"]
    assert got[2]["locked"] is True  # Undertow keeps #3
    tr = {r["track_id"]: r["transition"] for r in got}
    assert tr["1"] == {"style": "auto", "bars": 16}   # was into 2, now into 8
    assert tr["3"] == {"style": "auto", "bars": 16}   # was into 4, now into 2
    assert tr["2"] == {"style": "auto", "bars": 16}   # a cut into 3, now into 4
    assert tr["8"] == {"style": "auto", "bars": None}


@pytest.mark.gauntlet
def test_m1_the_add_names_the_joins_it_reset_for_an_undo(client):
    """Brief B's review M1: a drop's Undo takes the added rows out and gives
    the reset joins back, so the add answers which they were and what they had."""
    rows = [{"track_id": "1", "state": "owned", "transition": {"style": "long_blend", "bars": 32}},
            {"track_id": "2", "state": "owned", "transition": {"style": "cut"}},
            {"track_id": "3", "state": "owned", "locked": True, "transition": {"style": "bass_swap", "bars": 8}},
            {"track_id": "4", "state": "owned"}]
    set_id = client.post("/api/sets", json={"name": "Locked", "kind": "hand", "tracks": rows}).get_json()["id"]
    body = client.post(f"/api/sets/{set_id}/tracks",
                       json={"track_ids": ["8"], "after": {"track_id": "1", "number": 1}}).get_json()
    # numbers as the rows stand after the add: 1, 8, 3, 2, 4
    assert body["reset"] == [
        {"track_id": "1", "number": 1, "transition": {"style": "long_blend", "bars": 32}},
        {"track_id": "3", "number": 3, "transition": {"style": "bass_swap", "bars": 8}},
        {"track_id": "2", "number": 4, "transition": {"style": "cut", "bars": None}},
    ]
    # at the end, or with no join changed, nothing is reset
    end = client.post(f"/api/sets/{set_id}/tracks", json={"track_ids": ["5"]}).get_json()
    assert end["reset"] == []


def test_l9_placed_says_where_the_tracks_really_went():
    assert sets_store.placed_as(0, [1, 2], 5) == "after"
    assert sets_store.placed_as(0, [2], 4) == "later"
    assert sets_store.placed_as(0, [3], 4) == "end"
    assert sets_store.placed_as(0, [1, 3], 6) == "split"
    assert sets_store.placed_as(3, [4], 5) == "after"  # after the last row is after it


@pytest.mark.gauntlet
@pytest.mark.parametrize("locks, add, placed, order", [
    ((False, False, False), ["8"], "after", ["1", "8", "2", "3"]),
    ((False, True, False), ["8"], "later", ["1", "2", "8", "3"]),
    ((False, True, True), ["8"], "end", ["1", "2", "3", "8"]),
    ((False, False, True), ["8", "9"], "split", ["1", "8", "3", "9", "2"]),
])
def test_l9_the_add_answer_does_not_say_after_when_locked_rows_moved_them(client, locks, add, placed, order):
    rows = [{"track_id": tid, "state": "owned", "locked": lock}
            for tid, lock in zip(("1", "2", "3"), locks, strict=True)]
    set_id = client.post("/api/sets", json={"name": "Locks", "kind": "hand", "tracks": rows}).get_json()["id"]
    body = client.post(f"/api/sets/{set_id}/tracks",
                       json={"track_ids": add, "after": {"track_id": "1", "number": 1}}).get_json()
    assert body["placed"] == placed
    assert _rows(client, set_id) == order
    numbers = {a["track_id"]: a["number"] for a in body["added"]}
    assert all(order[numbers[t] - 1] == t for t in add)


@pytest.mark.gauntlet
@pytest.mark.parametrize("method, path, data", [
    ("put", "/api/sets/working", "set_id=1"),
    ("post", "/api/sets/working/start", "track_ids=9&name=x"),
    ("post", "/api/sets/{sid}/tracks", "track_ids=8"),
])
def test_m1_the_new_writes_take_json_only(client, method, path, data):
    """M1's audit: a cross-site form or text/plain body is refused, nothing changes."""
    sid = make_set(client, "Mine", ["1"])
    for content_type, body in (("application/x-www-form-urlencoded", data), ("text/plain", '{"set_id": 1}')):
        res = getattr(client, method)(path.format(sid=sid), data=body, content_type=content_type)
        assert res.status_code == 400
    assert _working(client) is None
    assert _rows(client, sid) == ["1"]
