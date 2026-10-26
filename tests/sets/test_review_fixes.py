"""The gauntlet review of Sets 1 (HANDOFF, "Dev, Sets 1 of 24 October",
After the gauntlet review): each finding's regression test. H1's tests are in
test_steps_and_tracklist.py."""

from __future__ import annotations

import io
import json
import threading
import time

import pytest
import requests

from core.sets import matching, sources, store, wanted


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _rows(*ids, **extra):
    return [{"track_id": i, **extra} for i in ids]


def _playlist_names(db, playlist_id):
    return [t["track_name"] for t in db.get_mirrored_playlist_tracks(playlist_id)]


# ── M1: an edit never drops a track that's briefly unreachable ───────────────

@pytest.mark.gauntlet
def test_a_briefly_unreachable_track_survives_any_edit(client, db):
    """A track whose file is away for a moment (a server switch, a rescan, a
    file being moved) keeps its row and its playlist entry through a rename
    and through a save of the same tracks, and plays again once it's back."""
    made = client.post("/api/sets", json={"name": "Sunday", "tracks": _rows("1", "2", "3")}).get_json()
    set_id, playlist_id = made["id"], made["playlist_id"]
    _sql(db, "UPDATE tracks SET file_path = NULL WHERE id = '2'")
    view = client.get(f"/api/sets/{set_id}").get_json()
    assert view["rows"][1]["track"] is None and view["rows"][1]["track_id"] == "2"
    assert view["rows"][1]["unreachable"] is True
    # a rename (name only), then an old client sending the tracks it was shown
    assert client.put(f"/api/sets/{set_id}", json={"name": "Sunday Set"}).status_code == 200
    shown = [{k: r[k] for k in ("track_id", "artist", "title", "state")} for r in view["rows"]]
    assert client.put(f"/api/sets/{set_id}", json={"tracks": shown}).status_code == 200
    assert _playlist_names(db, playlist_id) == ["Lowtide Hymn", "Foghorn Study", "Undertow"]
    # a reorder while it's away keeps it in the playlist by the set's own words
    assert client.put(f"/api/sets/{set_id}", json={"tracks": [shown[2], shown[1], shown[0]]}).status_code == 200
    assert _playlist_names(db, playlist_id) == ["Undertow", "Foghorn Study", "Lowtide Hymn"]
    _sql(db, "UPDATE tracks SET file_path = '/m/2.flac' WHERE id = '2'")
    back = client.get(f"/api/sets/{set_id}").get_json()
    assert back["rows"][1]["track"]["id"] == "2" and back["rows"][1]["state"] == "owned"
    assert back["set"]["name"] == "Sunday Set"


def test_a_new_id_outside_the_library_is_still_refused_on_update(client, db):
    set_id = client.post("/api/sets", json={"name": "x", "tracks": _rows("1")}).get_json()["id"]
    client.put(f"/api/sets/{set_id}", json={"tracks": _rows("1", "20")})
    rows = client.get(f"/api/sets/{set_id}").get_json()["rows"]
    assert rows[1]["track_id"] is None and rows[1]["state"] == "missing"


def test_a_save_without_track_changes_leaves_the_playlist_alone(client, db, monkeypatch):
    made = client.post("/api/sets", json={"name": "x", "tracks": _rows("1", "2")}).get_json()
    called = []
    monkeypatch.setattr(store, "follow_playlist", lambda *a, **k: called.append(a))
    client.put(f"/api/sets/{made['id']}", json={"name": "y"})
    client.put(f"/api/sets/{made['id']}", json={"tracks": _rows("1", "2", locked=True)})
    assert called == []
    client.put(f"/api/sets/{made['id']}", json={"tracks": _rows("2", "1")})
    assert len(called) == 1


# ── M2: a playlist changed or deleted elsewhere stops following ──────────────

def test_a_playlist_edited_elsewhere_stops_following_the_set(client, db):
    from core.playlists import user_playlists as up

    made = client.post("/api/sets", json={"name": "Sunday", "tracks": _rows("1", "2")}).get_json()
    set_id, playlist_id = made["id"], made["playlist_id"]
    playlist = db.get_mirrored_playlist(playlist_id, profile_id=1)
    up.add_tracks(db, playlist, [{"track_name": "Someone's addition", "artist_name": "Ross"}])
    res = client.put(f"/api/sets/{set_id}", json={"tracks": _rows("2", "1", "3")}).get_json()
    assert res["playlist_state"] == "changed"
    # the person's edit is kept, the set's order isn't forced on it
    assert _playlist_names(db, playlist_id) == ["Lowtide Hymn", "Foghorn Study", "Someone's addition"]
    got = client.get(f"/api/sets/{set_id}").get_json()["set"]
    assert got["playlist_state"] == "changed" and got["playlist_id"] is None
    # "Make a new playlist from this set" follows from now on
    fresh = client.post(f"/api/sets/{set_id}/playlist", json={"action": "new"}).get_json()["playlist_id"]
    assert fresh != playlist_id and _playlist_names(db, fresh) == ["Foghorn Study", "Lowtide Hymn", "Undertow"]
    assert client.get(f"/api/sets/{set_id}").get_json()["set"]["playlist_state"] is None
    client.put(f"/api/sets/{set_id}", json={"tracks": _rows("3", "2")})
    assert _playlist_names(db, fresh) == ["Undertow", "Foghorn Study"]


def test_a_deleted_playlist_isnt_made_again(client, db):
    made = client.post("/api/sets", json={"name": "Sunday", "tracks": _rows("1", "2")}).get_json()
    db.delete_mirrored_playlist(made["playlist_id"])
    before = len(db.get_mirrored_playlists(profile_id=1))
    res = client.put(f"/api/sets/{made['id']}", json={"tracks": _rows("2", "1")}).get_json()
    assert res["playlist_state"] == "deleted"
    assert len(db.get_mirrored_playlists(profile_id=1)) == before
    assert client.post(f"/api/sets/{made['id']}/playlist", json={"action": "dismiss"}).status_code == 200
    assert client.get(f"/api/sets/{made['id']}").get_json()["set"]["playlist_state"] is None
    assert client.post(f"/api/sets/{made['id']}/playlist", json={"action": "x"}).status_code == 400
    client.state["profile"] = 2
    assert client.post(f"/api/sets/{made['id']}/playlist", json={"action": "new"}).status_code == 404


# ── Low 8: autosaves apply in order ──────────────────────────────────────────

def test_an_older_autosave_is_refused(client):
    set_id = client.post("/api/sets", json={"name": "x", "tracks": _rows("1", "2")}).get_json()["id"]
    assert client.get(f"/api/sets/{set_id}").get_json()["set"]["revision"] == 0
    assert client.put(f"/api/sets/{set_id}", json={"name": "b", "revision": 2}).get_json()["revision"] == 2
    late = client.put(f"/api/sets/{set_id}", json={"name": "a", "revision": 1})
    assert late.status_code == 409 and late.get_json() == {
        "success": False, "stale": True, "revision": 2, "error": "A newer change to this set is already saved."}
    assert client.get(f"/api/sets/{set_id}").get_json()["set"]["name"] == "b"
    # without a revision (an older page) it still saves, counting up
    assert client.put(f"/api/sets/{set_id}", json={"name": "c"}).get_json()["revision"] == 3


# ── Low 6 and 8: what a row may say ──────────────────────────────────────────

def test_rows_are_cleaned_and_checked():
    rows = store.clean_rows([{"track_id": "1", "title": "A‮B\u0000C​", "artist": "x⁦y",
                              "note": "\x1b[31mred"}])
    assert rows[0]["title"] == "ABC" and rows[0]["artist"] == "xy" and rows[0]["note"] == "[31mred"
    with pytest.raises(store.SetError):
        store.clean_rows([{"artist": "A", "title": "B", "state": "owned"}])
    with pytest.raises(store.SetError):
        store.clean_rows([{"artist": "A", "title": "B", "state": "version"}])
    assert store.clean_rows([{"artist": "A", "title": "B", "state": "missing"}])[0]["track_id"] is None


def test_wanted_text_is_cleaned(client, db):
    client.post("/api/sets/wanted", json={"tracks": [{"artist": "Vela‮ Sund", "title": "Gravity\u0000 Well"}]})
    stored = db.get_wishlist_track(wanted.wanted_id("Vela Sund", "Gravity Well"), profile_id=1)
    assert stored is not None and json.loads(stored["spotify_data"])["name"] == "Gravity Well"


# ── Low 5: long mixes, and taking back a Want the Dub ────────────────────────

def test_wanted_takes_a_whole_mix_and_gives_a_version_back(client, db):
    many = [{"artist": f"Artist {i}", "title": f"Track {i}"} for i in range(450)]
    assert client.post("/api/sets/wanted", json={"tracks": many}).get_json()["added"] == 450
    assert client.post("/api/sets/wanted", json={"tracks": many + many[:60]}).status_code == 400
    dub = {"artist": "Mareld", "title": "Signal Fire (Dub)"}
    client.post("/api/sets/wanted", json={"tracks": [dub], "set_name": "Essential Mix"})
    # another set's name, or a row nobody's set added, isn't taken back
    assert client.post("/api/sets/wanted/remove", json={**dub, "set_name": "Other"}).get_json()["removed"] is False
    assert client.post("/api/sets/wanted/remove", json={**dub, "set_name": "Essential Mix"}).get_json()["removed"]
    assert db.get_wishlist_track(wanted.wanted_id("Mareld", "Signal Fire (Dub)"), profile_id=1) is None
    assert client.post("/api/sets/wanted/remove", json=dub).get_json()["removed"] is False
    db.add_to_wishlist_detailed({"id": wanted.wanted_id("A", "B"), "name": "B", "artists": [{"name": "A"}]},
                                source_type="manual", profile_id=1, user_initiated=True)
    assert client.post("/api/sets/wanted/remove", json={"artist": "A", "title": "B"}).get_json()["removed"] is False


# ── Low 8: the paste cap counts characters, not bytes ────────────────────────

def test_a_long_non_latin_paste_fits(client):
    line = "Ряды – Снег над городом\n"
    text = (line * (64_000 // len(line)))[:64_000]
    assert len(text.encode("utf-8")) > 100_000
    assert client.post("/api/sets/paste", json={"text": text}).status_code == 200
    assert client.post("/api/sets/paste", json={"text": text + "x" * 2000}).status_code == 413


# ── Low 4: Your sets in two queries, right past 1,000 tracks ────────────────

def test_list_sets_counts_every_track(db):
    from core.library_scope import reset_library_scope, set_library_scope

    token = set_library_scope("shared")
    try:
        conn = db._get_connection()
        conn.execute("INSERT INTO dj_sets (profile_id, name, kind, status, created_at, updated_at) "
                     "VALUES (1, 'Big', 'hand', 'saved', 1, 1)")
        set_id = conn.execute("SELECT id FROM dj_sets WHERE name = 'Big'").fetchone()[0]
        ids = [str(1000 + i) for i in range(1200)]
        conn.executemany("INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration) "
                         "VALUES (?, 'a100', '100', ?, ?, 60000)", [(i, f"T{i}", f"/m/{i}") for i in ids])
        conn.executemany("INSERT INTO dj_set_tracks (set_id, position, track_id, state) VALUES (?, ?, ?, 'owned')",
                         [(set_id, n, i) for n, i in enumerate(ids)])
        conn.commit()
        statements = []
        conn.close()
        real = db._get_connection

        def counting():
            c = real()
            c.set_trace_callback(lambda sql: statements.append(sql) if sql.lstrip().upper().startswith("SELECT")
                                 else None)
            return c

        db._get_connection = counting
        try:
            listed = store.list_sets(db, 1)
        finally:
            db._get_connection = real
        big = next(s for s in listed if s["name"] == "Big")
        assert big["tracks"] == 1200 and big["seconds"] == 1200 * 60 and len(big["energy"]) == 200
        assert len(statements) <= 3
    finally:
        reset_library_scope(token)


# ── Low 3: matching reads an index ───────────────────────────────────────────

def test_matching_uses_the_title_norm_index(db):
    from core.library_scope import reset_library_scope, set_library_scope

    token = set_library_scope("shared")
    try:
        conn = db._get_connection()
        try:
            db.ensure_norm_backfilled()
            where, params = matching.dj_store._scope(db)
            seen = []
            conn.set_trace_callback(seen.append)
            matching._prefix_range(conn, where, params, "night", True)
            conn.set_trace_callback(None)
            plan = " ".join(str(tuple(r)) for r in conn.execute("EXPLAIN QUERY PLAN " + seen[-1]))
        finally:
            conn.close()
        assert "idx_tracks_title_norm" in plan
        rows = matching.match_lines(db, [{"artist": "Tidewater", "title": "Night Ferry"},
                                         {"artist": "Tidewater", "title": "Night Ferrys"},
                                         {"artist": "Mareld", "title": "Signal Fire (Dub)"}])
        assert [(r["state"], r["track"]["id"] if r["track"] else None) for r in rows] == [
            ("owned", "9"), ("owned", "9"), ("version", "5")]
    finally:
        reset_library_scope(token)


# ── Low 1 and 2: outbound requests are bounded, Discogs is shared ────────────

class _Slow:
    status_code = 200

    def __init__(self, delay):
        self.delay = delay
        self.closed = False

    def iter_content(self, size):
        while True:
            time.sleep(self.delay)
            yield b" "

    def close(self):
        self.closed = True


@pytest.mark.gauntlet
def test_an_answer_that_trickles_is_cut_off_at_the_deadline(monkeypatch):
    """A source that sends a byte just inside the read timeout, forever,
    would hold a worker for as long as it liked: the whole answer has a
    deadline."""
    slow = _Slow(0.01)
    monkeypatch.setattr(sources, "_http_get", lambda *a, **k: slow)
    monkeypatch.setattr(sources, "TOTAL_DEADLINE", 0.3)
    monkeypatch.setattr(sources, "MIN_INTERVAL", {"mixesdb": 0.0, "discogs": 0.0})
    sources.reset_limits()
    started = time.monotonic()
    with pytest.raises(sources.SourceDown, match="too long"):
        sources._get_json("mixesdb", sources.MIXESDB_API, {})
    assert time.monotonic() - started < 2 and slow.closed


def test_one_request_at_a_time_per_source(monkeypatch):
    inflight, most = [0], [0]
    lock = threading.Lock()

    def fake(*a, **k):
        with lock:
            inflight[0] += 1
            most[0] = max(most[0], inflight[0])
        time.sleep(0.05)
        with lock:
            inflight[0] -= 1

        class R:
            status_code = 200

            def iter_content(self, size):
                yield b"{}"

            def close(self):
                pass
        return R()

    monkeypatch.setattr(sources, "_http_get", fake)
    monkeypatch.setattr(sources, "MIN_INTERVAL", {"mixesdb": 0.0, "discogs": 0.0})
    # one holds the source and MAX_WAITERS wait for it (one more would be
    # refused at once: test_rereview_fixes)
    threads = [threading.Thread(target=sources._get_json, args=("mixesdb", sources.MIXESDB_API, {}))
               for _ in range(1 + sources.MAX_WAITERS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)
    assert most[0] == 1


def test_discogs_backs_off_on_429_and_each_profile_has_a_budget(monkeypatch, cfg):
    calls = []

    class Answer:
        def __init__(self, status):
            self.status_code = status

        def iter_content(self, size):
            yield b'{"results": []}'

        def close(self):
            pass

    status = [429]
    monkeypatch.setattr(sources, "_http_get", lambda url, **k: (calls.append(url), Answer(status[0]))[1])
    monkeypatch.setattr(sources, "MIN_INTERVAL", {"mixesdb": 0.0, "discogs": 0.0})
    monkeypatch.setattr(sources, "_mb_client", type("MB", (), {"search_dj_mixes": lambda self, q, limit=8: []})())
    cfg.data.update({"discogs.token": "tok", sources.SETTING_MIXESDB: False})
    sources.clear_cache()
    sources.reset_limits()
    first = sources.search("fabric", profile_id=1)
    assert first["sources"]["discogs"] == {"state": "limited", "why": "rate_limited"}
    n = len(calls)
    assert sources.search("fabric 2", profile_id=1)["sources"]["discogs"]["state"] == "limited"
    assert len(calls) == n  # backing off: Discogs isn't asked
    sources.reset_limits()
    status[0] = 200
    for i in range(sources.DISCOGS_PER_PROFILE):
        assert sources.search(f"q{i}", profile_id=1)["sources"]["discogs"]["state"] == "ok"
    over = sources.search("one more", profile_id=1)
    assert over["sources"]["discogs"] == {"state": "limited", "why": "profile"}
    # a cached search costs nothing, and another profile has its own budget
    assert sources.search("q0", profile_id=1)["sources"]["discogs"]["state"] == "ok"
    assert sources.search("one more", profile_id=2)["sources"]["discogs"]["state"] == "ok"


def test_discogs_ids_are_ascii_digits(client, monkeypatch, cfg):
    cfg.data["discogs.token"] = "tok"
    monkeypatch.setattr(sources, "_http_get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("fetched")))
    for bad in ("²", "١٢٣", "12a", "", "1" * 13):
        res = client.post("/api/sets/famous/open", json={"source": "discogs", "id": bad or " "})
        assert res.status_code in (400, 404), bad


def test_a_busy_discogs_says_so_when_opening(client, monkeypatch, cfg):
    cfg.data["discogs.token"] = "tok"
    monkeypatch.setattr(sources, "_discogs_until", time.monotonic() + 60)
    res = client.post("/api/sets/famous/open", json={"source": "discogs", "id": "4242"})
    assert res.status_code == 429 and res.get_json()["limited"] == "discogs"


def test_requests_exceptions_still_read_as_down(monkeypatch):
    monkeypatch.setattr(sources, "_http_get", lambda *a, **k: (_ for _ in ()).throw(requests.ConnectTimeout("x")))
    monkeypatch.setattr(sources, "MIN_INTERVAL", {"mixesdb": 0.0, "discogs": 0.0})
    with pytest.raises(sources.SourceDown):
        sources._get_json("mixesdb", sources.MIXESDB_API, {})
    assert io  # (imported for symmetry with the other files' fixtures)
