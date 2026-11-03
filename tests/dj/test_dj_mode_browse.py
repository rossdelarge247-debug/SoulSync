"""DJ mode's Browse (Brief F, 37f; 418, 435): ``GET /api/library/dj/browse``
with ``near``, ``near_key``, ``tempo=near``, ``recent``, ``exclude`` and
``sort=closest``. Scoped to the caller's library and listening history,
bounded (at most 100 rows, at most 5 excluded ids)."""

from __future__ import annotations

import time

import pytest
from flask import Flask, g

from core.dj import grid_store, store, worker
from core.dj.grid import GRID_VERSION
from core.listening_scope import SHARED_OWNER


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _done_grid(bpm):
    period = 60.0 / bpm
    beats = [0.1 + i * period for i in range(65)]
    return {"version": GRID_VERSION, "status": "done", "kind": "constant", "bpm": bpm, "period": period,
            "first_beat": 0.1, "first_downbeat": beats[0], "downbeat_index": 0, "beat_confidence": 0.8,
            "downbeat_confidence": 0.6, "meter": "4/4", "bars": 16, "beats": None, "phrases": [],
            "sections": [], "mix_in": [0, 8, 0.6, "intro"], "mix_out": [8, 16, 0.6, "outro"],
            "analysed_s": 60.0, "truncated": False, "level_db": -9.0}


# (id, title, bpm, camelot, owner): around Night Ferry, 8A at 124
CRATE = [
    ("1", "Night Ferry", 124.0, "8A", None),
    ("2", "Harbour Lights", 126.0, "8A", None),
    ("3", "Copper Sky", 124.0, "8A", None),
    ("4", "Static Bloom", 123.0, "9A", None),
    ("5", "Low Tide", 62.0, "8B", None),
    ("6", "Sand Script", 128.0, "7A", None),
    ("7", "Too fast", 140.0, "8A", None),
    ("8", "Clash", 124.5, "3B", None),
    ("9", "Double", 248.0, "8A", None),
    ("10", "Someone else's", 124.0, "8A", 7),
]


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "browse.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Tidewater')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'Lantern')")
    for tid, title, bpm, key, owner in CRATE:
        _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, owner_profile_id) "
                       "VALUES (?, '10', '1', ?, ?, ?)", (tid, title, f"/m/{tid}.flac", owner))
        store.save(database, tid, {"bpm": bpm, "bpm_source": "analysis", "musical_key": key,
                                   "key_source": "analysis", "key_confidence": 0.8, "energy": 5,
                                   "status": "done", "dj_analyzer_version": worker.analyzer_version()})
    # Harbour Lights and Copper Sky have their beat grids; the rest don't yet
    for tid in ("2", "3"):
        grid_store.save_result(database, tid, _done_grid(dict((c[0], c[2]) for c in CRATE)[tid]), source_sig="s")
    return database


@pytest.fixture
def client(db):
    import api.dj as dj_api
    from core.library_scope import reset_library_scope, set_library_scope

    dj_api.configure(get_database_=lambda: db, fix_art_url_=lambda url: url)
    app = Flask(__name__)
    tokens = []

    @app.before_request
    def _profile():
        g.profile_id = SHARED_OWNER
        tokens.append(set_library_scope("shared"))

    @app.teardown_request
    def _scope(_exc):
        if tokens:
            reset_library_scope(tokens.pop())

    app.register_blueprint(dj_api.create_blueprint())
    return app.test_client()


def _ids(body):
    return [t["id"] for t in body["tracks"]]


BASE = "/api/library/dj/browse?near=124&near_key=8A&exclude=1&sort=closest"


def test_near_keeps_six_percent_and_half_and_double_time(client):
    body = client.get(f"{BASE}&tempo=near").get_json()
    # 117–131, 58.3–65.7 and 233–263: Too fast (140) is out; Low Tide (62) and Double (248) in
    assert set(_ids(body)) == {"2", "3", "4", "5", "6", "8", "9"}
    assert body["total"] == 7 and body["sort"] == "closest"


def test_keys_that_mix_and_near_together(client):
    body = client.get(f"{BASE}&tempo=near&key=8A:mix").get_json()
    assert set(_ids(body)) == {"2", "3", "4", "5", "6", "9"}  # Clash (3B) is out
    assert body["keys"] == ["8A", "7A", "9A", "8B"]


def test_closest_first_is_the_tempo_gap_then_the_key_step(client):
    body = client.get(f"{BASE}&tempo=near").get_json()
    # 0%: Copper Sky (same key) and Double (248 = 124 × 2, same key), then
    # Clash at 124.5 (0.4%, 5 steps) and Static Bloom at 123 (0.8%, one
    # step), Harbour Lights 1.6%, Low Tide 0% half time but relative
    order = _ids(body)
    assert order.index("3") < order.index("4") and order.index("9") < order.index("4")
    assert order.index("5") < order.index("2")  # Low Tide: 62 × 2 = 124, no tempo gap
    assert order.index("8") < order.index("4") < order.index("2") < order.index("6")
    # equal tempo gaps: the key step decides (Copper Sky 0 steps before Low Tide's relative)
    assert order.index("3") < order.index("5")


def test_the_playing_track_and_other_profiles_tracks_are_left_out(client):
    body = client.get(BASE).get_json()
    assert "1" not in _ids(body)
    assert "10" not in _ids(body)  # another profile's own track, under the shared scope


def test_rows_say_whether_their_grid_is_ready(client):
    rows = {t["id"]: t for t in client.get(BASE).get_json()["tracks"]}
    assert rows["2"]["grid_ready"] is True and rows["3"]["grid_ready"] is True
    assert rows["4"]["grid_ready"] is False
    assert rows["2"]["dj"]["key"] == "8A" and rows["2"]["dj"]["bpm"] == pytest.approx(126.0)


def test_recently_played_is_the_callers_history_only(client, db):
    now = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime())
    old = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() - 40 * 86400))
    for tid, profile, played in (("2", SHARED_OWNER, now), ("3", 99, now), ("4", SHARED_OWNER, old)):
        _sql(db, "INSERT INTO listening_history (track_id, title, played_at, db_track_id, profile_id) "
                 "VALUES (?, 'x', ?, ?, ?)", (tid, played, int(tid), profile))
    assert _ids(client.get(f"{BASE}&recent=1").get_json()) == ["2"]


def test_starred_still_filters(client, db):
    _sql(db, "INSERT INTO track_stars (profile_id, track_id) VALUES (?, '6')", (SHARED_OWNER,))
    assert _ids(client.get(f"{BASE}&starred=1").get_json()) == ["6"]


def test_the_list_is_bounded(client):
    body = client.get(f"{BASE}&limit=5000").get_json()
    assert body["limit"] == store.CLOSEST_LIMIT
    many = "&".join(f"exclude={i}" for i in range(1, 10))
    # only the first five ids are honoured: 6 onwards stay in
    ids = _ids(client.get(f"/api/library/dj/browse?sort=closest&near=124&{many}").get_json())
    assert not set(ids) & {"1", "2", "3", "4", "5"} and {"6", "7"} <= set(ids)


@pytest.mark.parametrize("query", ("near=abc", "near=nan", "near=-4", "near_key=nonsense", "tempo=near"))
def test_odd_values_are_ignored_not_errors(client, query):
    res = client.get(f"/api/library/dj/browse?sort=closest&{query}")
    assert res.status_code == 200
    # tempo=near without a usable near filters nothing
    assert res.get_json()["total"] == 9


def test_a_profile_is_needed(client, monkeypatch):
    import api.dj as dj_api

    monkeypatch.setattr(dj_api, "get_current_profile_id", lambda: None)
    assert client.get(BASE).status_code == 401


def test_tracks_page_sorts_are_unchanged(client):
    body = client.get("/api/library/dj/browse?sort=bpm&limit=3").get_json()
    assert [t["title"] for t in body["tracks"]] == ["Low Tide", "Static Bloom", "Copper Sky"]
    assert body["limit"] == 3


@pytest.mark.gauntlet
def test_gauntlet_browse_never_reaches_past_the_callers_library(client, db):
    # access: under the shared scope another profile's own track never shows,
    # whatever the filters; nor does a track without its file
    _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path) VALUES ('11', '10', '1', 'No file', NULL)")
    for query in (BASE, f"{BASE}&tempo=near&key=8A:mix", f"{BASE}&q=Someone", f"{BASE}&recent=1"):
        ids = _ids(client.get(query).get_json())
        assert "10" not in ids and "11" not in ids
