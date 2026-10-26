"""The Mix tab's order (core/dj/ranking.py) through ``GET
/api/library/dj/mixes/<id>?rank=mix``: the set's tracks left out and its
energy followed, the starred boost, not played recently, style closeness,
"Widen the search", the words, and the route's old answer kept for its
current callers. Seed: Night Ferry (#9, 124 BPM, 8A, energy 6, Tidewater)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from core.dj import ranking
from core.dj import store as dj_store
from tests.mix.conftest import make_set


def _mix(client, track="9", **params):
    query = "&".join(f"{k}={v}" for k, v in {"rank": "mix", **params}.items())
    res = client.get(f"/api/library/dj/mixes/{track}?{query}")
    assert res.status_code == 200, res.get_json()
    return res.get_json()


def _ids(body):
    return [m["id"] for m in body["matches"]]


def test_current_callers_get_the_old_answer(client, db):
    body = client.get("/api/library/dj/mixes/9").get_json()
    assert _ids(body) == ["8", "4", "5", "6", "3", "2"]
    assert "ranked" not in body and "set" not in body
    assert "reason" in body and body["reason"] is None
    assert all("reason_short" not in m for m in body["matches"])
    assert body == {"success": True, **dj_store.mixes_with(db, "9")}


def test_the_tabs_order_words_and_limit(client):
    body = _mix(client)
    assert body["ranked"] == "mix" and body["set"] is None and body["wide"] is False
    # five by default; the same artist (Undertow, Tidewater) edges past Kelp Garden
    assert _ids(body) == ["8", "4", "5", "3", "6"]
    assert body["total"] == 6
    by_id = {m["id"]: m for m in body["matches"]}
    assert by_id["8"]["reason"] == "Same key · −0.8% BPM · same energy"
    assert by_id["8"]["reason_short"] == "same key · −0.8%"
    assert by_id["4"]["reason"] == "Same key · −1.6% BPM · energy ↓1"
    assert by_id["4"]["reason_short"] == "same key · −1.6% · ↓1"
    assert by_id["3"]["reason"] == "One step on the wheel · −3.2% BPM · energy ↓2"
    assert by_id["3"]["signals"]["same_artist"] is True
    assert _ids(_mix(client, limit=2)) == ["8", "4"]
    # the cap
    assert len(_mix(client, limit=500)["matches"]) == 6


def test_a_starred_track_moves_up(client):
    assert client.post("/api/stars", json={"track_ids": ["5"]}).status_code == 200
    body = _mix(client)
    assert _ids(body)[:3] == ["5", "8", "4"]
    assert body["matches"][0]["starred"] is True and body["matches"][0]["signals"]["starred"] is True


def test_a_track_played_today_moves_down(client, sql):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    sql("INSERT INTO listening_history (track_id, title, played_at, db_track_id, profile_id) "
        "VALUES ('x', 'Sand Script', ?, 8, 1)", (now.strftime("%Y-%m-%d %H:%M:%S"),))
    body = _mix(client)
    assert _ids(body)[:3] == ["4", "5", "8"]
    assert body["matches"][2]["signals"]["played"] == "today"


def test_recent_plays_are_the_profiles_own_pile_and_the_week_only(db, sql):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    stamp = lambda d: (now - timedelta(days=d)).strftime("%Y-%m-%d %H:%M:%S")  # noqa: E731
    sql("INSERT INTO listening_history (track_id, title, played_at, db_track_id, profile_id) VALUES "
        "('a', 'A', ?, 4, 1), ('b', 'B', ?, 5, 1), ('c', 'C', ?, 8, 1)", (stamp(1), stamp(4), stamp(30)))
    assert ranking.recent_plays(db, 1, ["4", "5", "8"]) == {"4": "today", "5": "this_week"}


def test_style_closeness_from_genres(client, sql):
    sql("UPDATE artists SET genres = ? WHERE name = 'Tidewater'", ('["Deep House", "Ambient"]',))
    sql("UPDATE artists SET genres = ? WHERE name = 'Mareld'", ('["deep house", "ambient"]',))
    body = _mix(client)
    assert _ids(body)[0] == "5"
    assert body["matches"][0]["signals"]["style"] == 1.0
    assert body["matches"][0]["signals"]["shared_genres"] == ["ambient", "deep house"]


def test_the_working_set_is_left_out_and_its_energy_followed(client):
    # energy 6, 4, 3: heading down; Kelp Garden is in it
    set_id = make_set(client, "Sunday Set", ["9", "6", "1"])
    body = _mix(client, set_id=set_id)
    assert body["set"] == {"id": set_id, "name": "Sunday Set", "direction": "down", "left_out": 1}
    assert "6" not in _ids(body)
    # down: the ones that keep going down lead
    assert _ids(body)[:3] == ["4", "5", "8"]
    # a set_id alone asks for the tab's order
    res = client.get(f"/api/library/dj/mixes/9?set_id={set_id}").get_json()
    assert res["ranked"] == "mix" and "6" not in _ids(res)


def test_a_rising_set_prefers_rising_matches(client):
    set_id = make_set(client, "Up", ["1", "7", "4"])  # 3, 3, 5
    body = _mix(client, set_id=set_id)
    assert body["set"]["direction"] == "up"
    assert _ids(body)[0] == "8"


@pytest.mark.gauntlet
def test_another_profiles_set_is_not_followed(client):
    set_id = make_set(client, "Mine", ["9", "8", "4"])
    client.state["profile"] = 2
    body = _mix(client, set_id=set_id)
    # read as no set: nothing about it, nothing left out
    assert body["set"] is None
    assert "8" in _ids(body) and "4" in _ids(body)


def test_widen_the_search_takes_any_key_at_ten_percent(client):
    body = _mix(client, wide=1, limit=20)
    assert body["wide"] is True and body["within"] == 10
    by_id = {m["id"]: m for m in body["matches"]}
    assert {"1", "7"} <= set(by_id)
    assert by_id["7"]["key_relation"] == "other"
    assert by_id["7"]["reason"] == "2 steps on the wheel · −4% BPM · energy ↓3"
    # the four that mix still lead
    assert _ids(body)[:3] == ["8", "4", "5"]


def test_a_track_not_worked_out_yet_says_so(client, sql):
    sql("UPDATE track_dj SET musical_key = NULL WHERE track_id = '9'")
    body = _mix(client)
    assert body["reason"] == "not_analyzed" and body["matches"] == []


def test_not_in_your_library(client):
    assert client.get("/api/library/dj/mixes/20?rank=mix").status_code == 404
    assert client.get("/api/library/dj/mixes/999?rank=mix").status_code == 404


def test_a_bad_set_id_is_no_set(client):
    assert _mix(client, set_id="abc")["set"] is None
    assert _mix(client, set_id="99999")["set"] is None


@pytest.mark.parametrize("energies, heading", [
    ([], None), ([5], None), ([3, None, 3], "steady"), ([2, 3, 5, 6, 6], "up"), ([8, 7, 5], "down"),
    ([1, 9, 9, 9, 9], "steady"),
])
def test_direction(energies, heading):
    assert ranking.direction(energies) == heading


def test_words():
    assert ranking.bpm_words("same", 2.0)["long"] == "+2% BPM"
    assert ranking.bpm_words("same", -1.25)["short"] == "−1.2%"
    assert ranking.bpm_words("same", 0.0) == {"long": "same BPM", "short": ""}
    assert ranking.bpm_words("half", 1.0)["long"] == "half time"
    assert ranking.energy_words(1) == {"long": "energy ↑1", "short": "↑1"}
    assert ranking.energy_words(0) == {"long": "same energy", "short": ""}
    assert ranking.energy_words(None) == {"long": "", "short": ""}
    assert ranking.key_words("relative", "8B", "8A")["long"] == "Relative major"
    assert ranking.key_words("relative", "8A", "8B")["short"] == "relative minor"
    assert ranking.key_words("up", "9A", "8A")["long"] == "One step on the wheel"
