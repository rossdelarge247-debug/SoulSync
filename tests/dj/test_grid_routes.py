"""The auto-mix stage A routes (api/dj.py): a track's grid, the batch form
for a queue, and the pair planner; each needs a profile, stays in the
caller's library, and caps what it reads."""

from __future__ import annotations

import json

import pytest
from flask import Flask, g

from core.dj import grid_store, store, worker
from core.dj.grid import GRID_VERSION, phrases_from

pytestmark = pytest.mark.gauntlet


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


SECTIONS = [["intro", 0, 16, 0.9], ["main", 16, 48, 0.5], ["breakdown", 48, 64, 0.8], ["drop", 64, 96, 0.8],
            ["outro", 96, 112, 0.9]]


def _grid(bpm, first=0.5):
    return {"version": GRID_VERSION, "status": "done", "kind": "constant", "bpm": bpm, "period": 60.0 / bpm,
            "first_beat": first, "first_downbeat": first, "downbeat_index": 0, "beat_confidence": 0.86,
            "downbeat_confidence": 0.9, "meter": "4/4", "bars": 112, "beats": None,
            "phrases": phrases_from([16, 48, 64, 96], 112), "sections": SECTIONS,
            "mix_in": [0, 16, 0.9, "intro"], "mix_out": [96, 112, 0.9, "outro"], "analysed_s": 220.0,
            "truncated": False, "level_db": -9.0}


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase

    database = MusicDatabase(database_path=str(tmp_path / "grid_routes.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES ('1', 'Saltmarsh')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES ('10', '1', 'Lantern')")
    # 1 and 2 analysed, 3 not yet, 4 another profile's (outside the shared library)
    for tid, title, owner, bpm, key in (("1", "Night Ferry", None, 124.0, "8A"), ("2", "Static Bloom", None, 126.0, "9A"),
                                        ("3", "Not yet", None, None, None), ("4", "Theirs", 7, 124.0, "8A")):
        _sql(database, "INSERT INTO tracks (id, album_id, artist_id, title, file_path, duration, owner_profile_id) "
                       "VALUES (?, '10', '1', ?, ?, 240000, ?)", (tid, title, f"/m/{tid}.flac", owner))
        if bpm:
            store.save(database, tid, {"bpm": bpm, "musical_key": key, "status": "done",
                                       "dj_analyzer_version": worker.analyzer_version()})
            grid_store.save_result(database, tid, _grid(bpm), source_sig=None, replaygain_db=-6.0)
    return database


@pytest.fixture
def client(db, monkeypatch):
    import api.dj as dj_api
    import core.profile_context as pc
    from core.library_scope import reset_library_scope, set_library_scope

    dj_api.configure(get_database_=lambda: db)
    monkeypatch.setattr(pc, "is_admin_request", lambda: False)
    app = Flask(__name__)
    tokens = []
    state = {"profile": 1}

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


def test_a_profile_is_needed(client, monkeypatch):
    import api.dj as dj_api

    monkeypatch.setattr(dj_api, "get_current_profile_id", lambda: None)
    assert client.get("/api/library/dj/grid/1").status_code == 401
    assert client.post("/api/library/dj/grids", json={"track_ids": ["1"]}).status_code == 401
    assert client.get("/api/library/dj/plan?from=1&to=2").status_code == 401


def test_a_tracks_grid(client):
    res = client.get("/api/library/dj/grid/1")
    assert res.status_code == 200
    grid = res.get_json()["grid"]
    assert grid["analyzed"] is True and grid["bpm"] == 124.0 and grid["bars"] == 112
    assert grid["grid"]["kind"] == "constant" and grid["downbeats"]["first"] == 0.5
    assert grid["mix_in"]["how"] == "intro" and grid["mix_out"]["start_bar"] == 96
    assert [s["kind"] for s in grid["sections"]] == ["intro", "main", "breakdown", "drop", "outro"]
    assert grid["loudness"]["replaygain_db"] == -6.0


def test_a_track_not_analysed_says_so(client):
    body = client.get("/api/library/dj/grid/3").get_json()
    assert body["success"] is True and body["grid"] == {"track_id": "3", "analyzed": False, "reason": "not_analyzed"}


def test_another_profiles_track_and_an_unknown_one_are_not_found(client):
    assert client.get("/api/library/dj/grid/4").status_code == 404
    assert client.get("/api/library/dj/grid/nope").status_code == 404
    assert client.get("/api/library/dj/plan?from=1&to=4").status_code == 404
    assert client.get("/api/library/dj/plan?from=4&to=1").status_code == 404
    body = client.post("/api/library/dj/grids", json={"track_ids": ["1", "4", "nope"]}).get_json()
    assert set(body["grids"]) == {"1"}


def test_the_batch_form_for_a_queue(client):
    body = client.post("/api/library/dj/grids", json={"track_ids": ["1", "2", "3", "1", 2, True, None]}).get_json()
    assert body["success"] is True and list(body["grids"]) == ["1", "2", "3"]
    assert body["grids"]["3"]["reason"] == "not_analyzed"
    assert body["grids"]["2"]["bpm"] == 126.0


def test_the_batch_form_is_capped(client):
    res = client.post("/api/library/dj/grids", json={"track_ids": [str(i) for i in range(51)]})
    assert res.status_code == 400
    assert client.post("/api/library/dj/grids", json={"track_ids": [str(i) for i in range(50)]}).status_code == 200
    big = json.dumps({"track_ids": ["x" * 100] * 50, "pad": "y" * 9000})
    assert client.post("/api/library/dj/grids", data=big, content_type="application/json").status_code == 413
    assert client.post("/api/library/dj/grids", json={"track_ids": "1"}).status_code == 400
    assert client.post("/api/library/dj/grids", data="track_ids=1").status_code == 400


def test_the_pair_plan(client):
    res = client.get("/api/library/dj/plan?from=1&to=2")
    assert res.status_code == 200
    body = res.get_json()
    assert body["from"] == "1" and body["to"] == "2"
    plan = body["plan"]
    assert plan["status"] == "ok" and plan["style"] == "long_blend" and plan["bars"] == 32
    assert plan["out"]["bar"] == 80 and plan["in"]["bar"] == 0
    assert plan["tempo"]["rate"] == pytest.approx(124 / 126, abs=1e-4)
    assert plan["why"].startswith("8A → 9A, +2 BPM")
    styled = client.get("/api/library/dj/plan?from=1&to=2&style=echo_out&bars=8").get_json()["plan"]
    assert styled["style"] == "echo_out" and styled["bars"] == 8 and styled["chosen_by"] == "yours"


def test_a_plan_waits_for_a_track_not_analysed(client):
    plan = client.get("/api/library/dj/plan?from=1&to=3").get_json()["plan"]
    assert plan["status"] == "waiting" and plan["waiting_for"] == "to"


@pytest.mark.parametrize("query", ["from=1", "to=2", "from=1&to=2&style=scratch", "from=1&to=2&bars=3",
                                   "from=1&to=2&bars=²", "from=1&to=2&bars=-8", "from=1&to=2&bars=8.0"])
def test_a_plan_with_a_bad_query_is_refused(client, query):
    assert client.get(f"/api/library/dj/plan?{query}").status_code == 400


def test_status_counts_the_grids(client, db):
    body = client.get("/api/library/dj/status").get_json()
    assert body["grids"] == {"done": 3, "no_beat": 0, "pending": 0}
