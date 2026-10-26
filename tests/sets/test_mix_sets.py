"""Mix sets beyond 22c (boards 28a–28g): "Add to mix set…" (one track, many,
Add again, the downloaded-only rule), the picker's list, a note per track and
the transition chip saved with the set as ``{style, bars}``, with Sets 1's
revision and playlist rules kept. Marked ``gauntlet``: a member adds only to
their own sets and only their library's tracks."""

from __future__ import annotations

import pytest

from core.sets import store
from tests.sets.conftest import _sql


def _rows(*ids, **extra):
    return [{"track_id": i, **extra} for i in ids]


def _make(client, *ids, name="Sunday Set"):
    res = client.post("/api/sets", json={"name": name, "tracks": _rows(*ids)})
    assert res.status_code == 201
    return res.get_json()["id"], res.get_json()["playlist_id"]


def _add(client, set_id, *ids, again=None):
    body = {"track_ids": list(ids)}
    if again is not None:
        body["again"] = again
    return client.post(f"/api/sets/{set_id}/tracks", json=body)


def test_add_one_track_at_the_end_and_the_playlist_follows(client, db):
    set_id, playlist_id = _make(client, "1", "2", "3")
    res = _add(client, set_id, "9")
    body = res.get_json()
    assert res.status_code == 200
    assert body["name"] == "Sunday Set" and body["added"] == [{"track_id": "9", "number": 4}]
    assert body["already"] == [] and body["left_out"] == [] and body["revision"] == 1
    got = client.get(f"/api/sets/{set_id}").get_json()
    assert [r["track_id"] for r in got["rows"]] == ["1", "2", "3", "9"]
    assert got["set"]["revision"] == 1
    assert [t["track_name"] for t in db.get_mirrored_playlist_tracks(playlist_id)][-1] == "Night Ferry"


def test_one_already_in_it_is_skipped_unless_added_again(client):
    set_id, _ = _make(client, "1", "4")
    body = _add(client, set_id, "4").get_json()
    assert body["added"] == [] and body["already"] == ["4"] and body["revision"] == 0  # nothing moved on
    body = _add(client, set_id, "4", again=True).get_json()
    assert body["added"] == [{"track_id": "4", "number": 3}] and body["revision"] == 1


def test_many_at_once_add_the_new_ones_or_all_and_leave_missing_files_out(client, db):
    """28b: 2 of 6 are in it already ("Add 4" / "Add all 6"); one file is
    missing and is left out and said."""
    _sql(db, "UPDATE tracks SET file_path = '' WHERE id = '8'")
    set_id, _ = _make(client, "1", "2", "3")
    ids = ["2", "3", "4", "5", "6", "7", "8"]
    holding = client.post("/api/sets/holding", json={"track_ids": ids}).get_json()["sets"]
    assert holding == [{"id": set_id, "name": "Sunday Set", "kind": "hand", "updated_at": holding[0]["updated_at"],
                        "next": 4, "rows": 3, "holds": {"2": [2], "3": [3]}}]
    body = _add(client, set_id, *ids).get_json()
    assert [a["track_id"] for a in body["added"]] == ["4", "5", "6", "7"]
    assert [a["number"] for a in body["added"]] == [4, 5, 6, 7]
    assert body["already"] == ["2", "3"] and body["left_out"] == [{"id": "8", "reason": "file_missing"}]
    body = _add(client, set_id, "2", "3", again=True).get_json()
    assert [a["number"] for a in body["added"]] == [8, 9]


def test_the_picker_numbers_rows_as_the_page_does(client):
    """A famous mix's lines that aren't in the library take no number; a
    track the set holds whose file is missing keeps one."""
    res = client.post("/api/sets", json={"name": "Famous", "kind": "famous", "tracks": [
        {"track_id": "1"}, {"artist": "Vela Sund", "title": "Gravity Well", "state": "missing"},
        {"artist": "ID", "title": "ID", "state": "id"}, {"track_id": "4"}]})
    set_id = res.get_json()["id"]
    sets = client.post("/api/sets/holding", json={"track_ids": ["4"]}).get_json()["sets"]
    assert sets[0]["holds"] == {"4": [2]} and sets[0]["next"] == 3 and sets[0]["rows"] == 4
    assert _add(client, set_id, "9").get_json()["added"] == [{"track_id": "9", "number": 3}]


def test_an_open_pages_older_autosave_is_refused_after_an_add(client):
    """Sets 1's revision rule: an add moves the revision on, so a page that
    saved revision 1 and then sends 1 again is stale, not applied."""
    set_id, _ = _make(client, "1", "2")
    assert client.put(f"/api/sets/{set_id}", json={"tracks": _rows("2", "1"), "revision": 1}).status_code == 200
    assert _add(client, set_id, "9").get_json()["revision"] == 2
    res = client.put(f"/api/sets/{set_id}", json={"tracks": _rows("1", "2"), "revision": 2})
    assert res.status_code == 409 and res.get_json()["stale"] is True
    assert [r["track_id"] for r in client.get(f"/api/sets/{set_id}").get_json()["rows"]] == ["2", "1", "9"]


def test_a_playlist_changed_elsewhere_stops_following(client, db):
    from core.playlists import user_playlists as up

    set_id, playlist_id = _make(client, "1", "2")
    playlist = db.get_mirrored_playlist(playlist_id, profile_id=1)
    up.replace_tracks(db, playlist, [{"track_name": "Something else", "artist_name": "X", "album_name": "",
                                      "duration_ms": 0}])
    body = _add(client, set_id, "9").get_json()
    assert body["playlist_state"] == "changed"
    assert [t["track_name"] for t in db.get_mirrored_playlist_tracks(playlist_id)] == ["Something else"]


def test_a_set_holds_at_most_500(client, monkeypatch):
    monkeypatch.setattr(store, "MAX_ROWS", 3)
    set_id, _ = _make(client, "1", "2", "3")
    res = _add(client, set_id, "4")
    assert res.status_code == 400 and "at most 3" in res.get_json()["error"]


def test_the_input_is_checked(client):
    set_id, _ = _make(client, "1")
    assert client.post(f"/api/sets/{set_id}/tracks", json={"track_ids": "4"}).status_code == 400
    assert client.post(f"/api/sets/{set_id}/tracks", json={"track_ids": []}).status_code == 400
    assert client.post("/api/sets/holding", json={}).status_code == 400
    assert _add(client, 99999, "4").status_code == 404


@pytest.mark.gauntlet
def test_a_member_adds_only_to_their_own_sets_and_their_own_tracks(client):
    """Another profile's set reads as missing, and a track outside the
    caller's library (profile 7's own track 20) is left out, never written."""
    set_id, _ = _make(client, "1")
    client.state["profile"] = 2
    assert _add(client, set_id, "4").status_code == 404
    assert client.post("/api/sets/holding", json={"track_ids": ["1"]}).get_json()["sets"] == []
    client.state["profile"] = 1
    body = _add(client, set_id, "20", "4").get_json()
    assert body["left_out"] == [{"id": "20", "reason": "not_in_library"}]
    assert [r["track_id"] for r in client.get(f"/api/sets/{set_id}").get_json()["rows"]] == ["1", "4"]


def test_notes_and_transitions_are_saved_with_the_set(client):
    set_id, _ = _make(client, "1", "2", "3")
    rows = [{"track_id": "1", "note": "mix out at the breakdown", "transition": {"style": "long_blend", "bars": 32}},
            {"track_id": "2", "transition": {"style": "cut", "bars": 8}},
            {"track_id": "3", "transition": {"style": "nonsense", "bars": 7}}]
    assert client.put(f"/api/sets/{set_id}", json={"tracks": rows}).status_code == 200
    got = client.get(f"/api/sets/{set_id}").get_json()["rows"]
    assert got[0]["note"] == "mix out at the breakdown"
    assert [r["transition"] for r in got] == [{"style": "long_blend", "bars": 32}, {"style": "cut", "bars": None},
                                              {"style": "auto", "bars": None}]
    # the view (drafts) answers the same shape
    view = client.post("/api/sets/view", json={"tracks": rows}).get_json()
    assert view["rows"][0]["transition"] == {"style": "long_blend", "bars": 32}


@pytest.mark.parametrize("sent, kept", [
    (None, None),
    ({"style": "auto"}, None),
    ({"style": "auto", "bars": 16}, '{"style":"auto","bars":16}'),
    ({"style": "bass_swap", "bars": 16}, '{"style":"bass_swap","bars":16}'),
    ({"style": "echo_out"}, '{"style":"echo_out","bars":null}'),
    ({"style": "cut", "bars": 4}, '{"style":"cut","bars":null}'),
    ({"style": "filter_sweep", "bars": True}, '{"style":"filter_sweep","bars":null}'),
    ({"style": "drop_swap", "bars": 64}, '{"style":"drop_swap","bars":null}'),
    ('{"style":"short_blend","bars":8}', '{"style":"short_blend","bars":8}'),
    ("long_blend", '{"style":"long_blend","bars":null}'),
    ("<script>", None),
    (["x"], None),
])
def test_a_transition_is_kept_as_style_and_bars(sent, kept):
    assert store.clean_transition(sent) == kept


def test_a_file_gone_missing_keeps_its_place_and_values(client, db):
    """28e: the row keeps its number, its title and values (at 62% on the
    page), the step is worked out around it, and Export leaves it out."""
    set_id, _ = _make(client, "3", "5", "4")
    _sql(db, "UPDATE tracks SET file_path = '' WHERE id = '5'")
    got = client.get(f"/api/sets/{set_id}").get_json()
    gone = got["rows"][1]
    assert gone["track"] is None and gone["unreachable"] is True
    assert gone["gone_track"]["title"] == "Signal Fire (Original Mix)" and "file_path" not in gone["gone_track"]
    assert gone["gone_track"]["dj"]["bpm"] == 121
    # the step from Undertow goes to Copper Sky, around the missing one
    assert got["steps"][0]["reason"].startswith("7A → 8A") and got["steps"][1] is None


@pytest.mark.gauntlet
def test_a_file_missing_row_shows_nothing_of_another_profiles_track(client, db):
    """A set that names profile 7's own track never gets its details."""
    _sql(db, "UPDATE tracks SET file_path = '' WHERE id = '20'")
    view = client.post("/api/sets/view", json={"tracks": [{"track_id": "20", "state": "owned"}]}).get_json()
    assert view["rows"][0]["gone_track"] is None


# ── after the gauntlet review ─────────────────────────────────────────────────

@pytest.mark.gauntlet
def test_an_add_elsewhere_is_never_undone_by_an_open_pages_save(client, db):
    """H1: the page read the set at revision R; another tab adds a track
    (R+1). The page's save from base R is refused, whatever revision it
    would have counted to, and the add (and its playlist entry) stay."""
    set_id, playlist_id = _make(client, "1", "2")
    base = client.get(f"/api/sets/{set_id}").get_json()["set"]["revision"]
    assert _add(client, set_id, "9").get_json()["revision"] == base + 1
    for sent in ({"base_revision": base}, {"base_revision": base, "revision": base + 1}):
        res = client.put(f"/api/sets/{set_id}", json={"tracks": _rows("2", "1"), **sent})
        assert res.status_code == 409 and res.get_json() == {
            "success": False, "stale": True, "revision": base + 1,
            "error": "A newer change to this set is already saved."}
    got = client.get(f"/api/sets/{set_id}").get_json()
    assert [r["track_id"] for r in got["rows"]] == ["1", "2", "9"]
    assert [t["track_name"] for t in db.get_mirrored_playlist_tracks(playlist_id)] == [
        "Lowtide Hymn", "Foghorn Study", "Night Ferry"]
    # from the newest base the save applies, and the revision is one more
    res = client.put(f"/api/sets/{set_id}", json={"tracks": _rows("9", "1", "2"), "base_revision": base + 1})
    assert res.status_code == 200 and res.get_json()["revision"] == base + 2


@pytest.mark.gauntlet
def test_saves_chained_on_their_bases_all_land(client):
    """Two quick edits from one window: the second goes from the first's
    confirmed revision, and both apply."""
    set_id, _ = _make(client, "1", "2", "3")
    first = client.put(f"/api/sets/{set_id}", json={"tracks": _rows("3", "2", "1"), "base_revision": 0})
    assert first.status_code == 200
    second = client.put(f"/api/sets/{set_id}", json={"name": "Renamed",
                                                    "base_revision": first.get_json()["revision"]})
    assert second.status_code == 200 and second.get_json()["revision"] == 2
    got = client.get(f"/api/sets/{set_id}").get_json()
    assert got["set"]["name"] == "Renamed" and [r["track_id"] for r in got["rows"]] == ["3", "2", "1"]
    # the same base twice: only the first applies
    again = client.put(f"/api/sets/{set_id}", json={"name": "Again", "base_revision": 1})
    assert again.status_code == 409 and again.get_json()["revision"] == 2


@pytest.mark.parametrize("base", [-1, 2 ** 53, "1", 1.5, True])
def test_a_base_revision_is_checked(client, base):
    set_id, _ = _make(client, "1")
    res = client.put(f"/api/sets/{set_id}", json={"name": "x", "base_revision": base})
    assert res.status_code == 400
    assert client.get(f"/api/sets/{set_id}").get_json()["set"]["revision"] == 0


def test_two_adds_at_once_leave_the_playlist_with_both(client, db, monkeypatch):
    """L3: the sync reads the set again under its lock, so an add whose sync
    runs late can't write its older rows over a newer add's."""
    import threading

    set_id, playlist_id = _make(client, "1")
    in_follow, b_synced = threading.Event(), threading.Event()
    real_follow = store.follow_playlist

    def follow(database, pid, sid, rows):
        # A has read its rows and is about to write them: it waits for B's
        # whole sync (or, as it must with the lock held, gives up waiting)
        if threading.current_thread().name == "A":
            in_follow.set()
            b_synced.wait(2)
            return real_follow(database, pid, sid, rows)
        done = real_follow(database, pid, sid, rows)
        b_synced.set()
        return done

    monkeypatch.setattr(store, "follow_playlist", follow)
    app = client.application
    a = threading.Thread(name="A", target=lambda: app.test_client().post(
        f"/api/sets/{set_id}/tracks", json={"track_ids": ["9"]}))
    b = threading.Thread(name="B", target=lambda: app.test_client().post(
        f"/api/sets/{set_id}/tracks", json={"track_ids": ["4"]}))
    a.start()
    assert in_follow.wait(5)
    b.start()
    a.join(10)
    b.join(10)
    assert [r["track_id"] for r in client.get(f"/api/sets/{set_id}").get_json()["rows"]] == ["1", "9", "4"]
    assert [t["track_name"] for t in db.get_mirrored_playlist_tracks(playlist_id)] == [
        "Lowtide Hymn", "Night Ferry", "Copper Sky"]
