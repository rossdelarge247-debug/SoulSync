"""DJ mode's cue points (Brief F 3b, 37g; 439, 445): ``GET``/``PUT
/api/library/dj/cues/<id>`` (core/dj/cues.py), four per track, a profile's
own, in the caller's library scope; the seconds follow the grid; Export to
Traktor writes them as hot cues. The table's migration is in
tests/database/test_dj_cues_migration.py."""

from __future__ import annotations

import xml.etree.ElementTree as ET

import pytest
from flask import Flask, g

from core.dj import cues, grid_store, store, traktor, worker
from core.dj.grid import GRID_VERSION


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _grid(bpm=120.0, first=1.0):
    period = 60.0 / bpm
    beats = [first + i * period for i in range(400)]
    return {"version": GRID_VERSION, "status": "done", "kind": "constant", "bpm": bpm, "period": period,
            "first_beat": first, "first_downbeat": beats[0], "downbeat_index": 0, "beat_confidence": 0.8,
            "downbeat_confidence": 0.6, "meter": "4/4", "bars": 64, "beats": None, "phrases": [],
            "sections": [], "mix_in": [0, 8, 0.6, "intro"], "mix_out": [56, 64, 0.6, "outro"],
            "analysed_s": 200.0, "truncated": False, "level_db": -9.0}


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "cues.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Tidewater')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'Lantern')")
    for tid, title, owner in (("1", "Night Ferry", None), ("2", "No grid", None), ("3", "Someone else's", 7)):
        _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration, owner_profile_id) "
                       "VALUES (?, '10', '1', ?, ?, 300000, ?)", (tid, title, f"/app/Transfer/{tid}.flac", owner))
        store.save(database, tid, {"bpm": 120.0, "bpm_source": "tag", "musical_key": "8A", "key_source": "tag",
                                   "status": "done", "dj_analyzer_version": worker.analyzer_version()})
    grid_store.save_result(database, "1", _grid(), source_sig="s")
    return database


@pytest.fixture
def client(db):
    import api.dj as dj_api
    from core.library_scope import reset_library_scope, set_library_scope

    dj_api.configure(get_database_=lambda: db)
    state = {"profile": 1}
    app = Flask(__name__)
    tokens = []

    @app.before_request
    def _profile():
        if state["profile"] is not None:
            g.profile_id = state["profile"]
        tokens.append(set_library_scope("shared"))

    @app.teardown_request
    def _scope(_exc):
        if tokens:
            reset_library_scope(tokens.pop())

    app.register_blueprint(dj_api.create_blueprint())
    c = app.test_client()
    c.state = state
    return c


URL = "/api/library/dj/cues/"


def test_put_then_get_and_clear(client):
    assert client.get(URL + "1").get_json() == {"success": True, "cues": []}
    body = client.put(URL + "1", json={"cues": [{"slot": 3, "bar": 16, "seconds": 33.0},
                                              {"slot": 1, "bar": 0, "seconds": 1.0}]}).get_json()
    assert body["cues"] == [{"slot": 1, "bar": 0, "seconds": 1.0}, {"slot": 3, "bar": 16, "seconds": 33.0}]
    assert client.get(URL + "1").get_json()["cues"] == body["cues"]
    assert client.put(URL + "1", json={"cues": []}).get_json()["cues"] == []


def test_a_cue_follows_the_grid_and_a_track_without_one_keeps_its_seconds(client, db):
    client.put(URL + "1", json={"cues": [{"slot": 2, "bar": 16, "seconds": 33.0}]})
    # a re-analysis moves the grid: the first downbeat now at 1.5 s
    grid_store.save_result(db, "1", _grid(first=1.5), source_sig="s2")
    assert client.get(URL + "1").get_json()["cues"] == [{"slot": 2, "bar": 16, "seconds": 33.5}]
    client.put(URL + "2", json={"cues": [{"slot": 1, "bar": None, "seconds": 12.25}]})
    assert client.get(URL + "2").get_json()["cues"] == [{"slot": 1, "bar": None, "seconds": 12.25}]


@pytest.mark.parametrize("bad", [
    {"cues": "x"},
    {"cues": [{"slot": 5, "seconds": 1}]},
    {"cues": [{"slot": 1, "seconds": 1}, {"slot": 1, "seconds": 2}]},
    {"cues": [{"slot": 1, "seconds": -1}]},
    {"cues": [{"slot": 1, "seconds": float("inf")}]},
    {"cues": [{"slot": 1, "seconds": "1"}]},
    {"cues": [{"slot": True, "seconds": 1}]},
    {"cues": [{"slot": 1, "bar": "x", "seconds": 1}]},
    {"cues": [{"slot": s, "seconds": 1} for s in (1, 2, 3, 4, 1)]},
    {"cues": [{"slot": 1, "bar": cues.MIN_BAR - 0.25, "seconds": 1}]},
    {"cues": [{"slot": 1, "bar": cues.MAX_BAR + 1, "seconds": 1}]},
])
def test_a_body_that_isnt_four_cues_in_range_is_refused(client, bad):
    import json

    res = client.put(URL + "1", data=json.dumps(bad, allow_nan=True), content_type="application/json")
    assert res.status_code == 400
    assert client.get(URL + "1").get_json()["cues"] == []


def test_a_bar_before_the_first_downbeat_is_kept(client):
    # a long beatless intro: cues 18 and 600 bars before the grid's first downbeat (review L1)
    body = {"cues": [{"slot": 1, "bar": -18.5, "seconds": 0.0}, {"slot": 2, "bar": cues.MIN_BAR, "seconds": 0.0},
                     {"slot": 3, "bar": cues.MAX_BAR, "seconds": 5.0}]}
    res = client.put(URL + "2", json=body)
    assert res.status_code == 200
    assert [c["bar"] for c in client.get(URL + "2").get_json()["cues"]] == [-18.5, cues.MIN_BAR, cues.MAX_BAR]


def test_a_long_track_id_is_cut_as_the_grid_routes_cut_it(client, db):
    long_id = "x" * 100
    _sql(db, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration) "
             "VALUES (?, '10', '1', 'Long id', '/app/Transfer/long.flac', 300000)", (long_id,))
    assert client.put(URL + long_id, json={"cues": [{"slot": 1, "bar": None, "seconds": 2.0}]}).status_code == 200
    assert client.get(URL + long_id).get_json()["cues"] == [{"slot": 1, "bar": None, "seconds": 2.0}]


def test_the_main_cue_is_slot_0_beside_the_hot_cues(client):
    # step 4b: CUE's point is kept with the hot cues as slot 0
    body = {"cues": [{"slot": 0, "bar": 2, "seconds": 5.0}, {"slot": 1, "bar": 0, "seconds": 1.0}]}
    assert client.put(URL + "1", json=body).status_code == 200
    assert [c["slot"] for c in client.get(URL + "1").get_json()["cues"]] == [0, 1]
    five = {"cues": [{"slot": s, "bar": None, "seconds": float(s)} for s in (0, 1, 2, 3, 4)]}
    assert client.put(URL + "2", json=five).status_code == 200
    six = {"cues": five["cues"] + [{"slot": 0, "bar": None, "seconds": 9.0}]}
    assert client.put(URL + "2", json=six).status_code == 400


def test_a_big_body_is_refused_unread(client):
    res = client.put(URL + "1", data=b'{"cues": [' + b" " * 4096 + b"]}", content_type="application/json")
    assert res.status_code == 413


def test_a_profile_is_needed(client, monkeypatch):
    import api.dj as dj_api

    monkeypatch.setattr(dj_api, "get_current_profile_id", lambda: None)
    assert client.get(URL + "1").status_code == 401
    assert client.put(URL + "1", json={"cues": []}).status_code == 401


@pytest.mark.gauntlet
def test_gauntlet_cues_are_the_callers_own_and_in_their_library_only(client, db):
    client.put(URL + "1", json={"cues": [{"slot": 1, "bar": 0, "seconds": 1.0}]})
    # another profile sees none of them, and writes its own
    client.state["profile"] = 2
    assert client.get(URL + "1").get_json()["cues"] == []
    client.put(URL + "1", json={"cues": [{"slot": 4, "bar": 8, "seconds": 17.0}]})
    client.state["profile"] = 1
    assert [c["slot"] for c in client.get(URL + "1").get_json()["cues"]] == [1]
    # another profile's own track and an unknown one: not found, nothing written
    assert client.get(URL + "3").status_code == 404
    assert client.put(URL + "3", json={"cues": [{"slot": 1, "seconds": 1}]}).status_code == 404
    assert client.put(URL + "nope", json={"cues": [{"slot": 1, "seconds": 1}]}).status_code == 404
    conn = db._get_connection()
    try:
        rows = conn.execute("SELECT profile_id, track_id, slot FROM track_dj_cues ORDER BY profile_id").fetchall()
    finally:
        conn.close()
    assert [tuple(r) for r in rows] == [(1, "1", 1), (2, "1", 4)]


@pytest.mark.gauntlet
def test_gauntlet_a_deleted_profiles_cues_go_with_it(db):
    _sql(db, "INSERT INTO profiles (id, name) VALUES (5, 'Guest')")
    cues.put(db, 5, "1", [{"slot": 1, "bar": 0, "seconds": 1.0}])
    cues.put(db, 1, "1", [{"slot": 2, "bar": 0, "seconds": 1.0}])
    assert db.delete_profile(5)
    assert cues.for_export(db, 5, ["1"]) == {}
    assert [c["slot"] for c in cues.for_export(db, 1, ["1"])["1"]] == [2]


def test_export_writes_the_callers_cues_as_hot_cues(db):
    cues.put(db, 1, "1", [{"slot": 1, "bar": 0, "seconds": 1.0}, {"slot": 4, "bar": 16, "seconds": 33.0}])
    cues.put(db, 2, "1", [{"slot": 2, "bar": 4, "seconds": 9.0}])
    hot = cues.for_export(db, 1, ["1", "2"])
    entries = [{"track": {"id": "1", "title": "Night Ferry"},
                "location": {"DIR": "/:Music/:", "FILE": "1.flac", "VOLUME": "Music HD"}}]
    root = ET.fromstring(traktor.build_nml("Set", entries, cues=hot))
    found = [(c.get("HOTCUE"), c.get("TYPE"), c.get("START"), c.get("NAME"))
             for c in root.findall("COLLECTION/ENTRY/CUE_V2")]
    assert found == [("0", "0", "1000.000000", "Cue 1"), ("3", "0", "33000.000000", "Cue 4")]
    # the main cue (slot 0) is Traktor's Load marker, not a hot cue; with all
    # five set every one goes (review M-1)
    cues.put(db, 1, "1", [{"slot": s, "bar": None, "seconds": 1.0 + s} for s in (0, 1, 2, 3, 4)])
    root = ET.fromstring(traktor.build_nml("Set", entries, cues=cues.for_export(db, 1, ["1"])))
    marks = [(c.get("NAME"), c.get("TYPE"), c.get("HOTCUE")) for c in root.findall("COLLECTION/ENTRY/CUE_V2")]
    assert marks == [("Cue", "3", "-1"), ("Cue 1", "0", "0"), ("Cue 2", "0", "1"), ("Cue 3", "0", "2"),
                     ("Cue 4", "0", "3")]
    # without cues the entry is as before
    root = ET.fromstring(traktor.build_nml("Set", entries))
    assert root.findall("COLLECTION/ENTRY/CUE_V2") == []
