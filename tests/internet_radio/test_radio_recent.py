"""Recent stations per profile on the server (HANDOFF 142, 163): the
expanded player's Stations tab. A station counts once this profile's own
session has played it for 30 s (``POST /api/radio/recent``), the list keeps
the newest 20 per profile, and ``GET /api/radio/recent`` only ever answers a
profile's own rows, drawn without asking the directory."""

from __future__ import annotations

import pytest

import api.radio as radio_api
from core.internet_radio import directory, store
from core.internet_radio.hub import hub

UUID = "96062a7b-0601-11e8-ae97-52543be04c81"


def _play(client, station_id="kexp"):
    body = client.post("/api/radio/play", json={"station_id": station_id}).get_json()
    return body["session_id"]


def _age(session_id, seconds=31):
    hub.get_session(session_id).created_at -= seconds


def _ids(client):
    return [s["id"] for s in client.get("/api/radio/recent").get_json()["stations"]]


def test_a_station_counts_after_30_seconds_of_its_own_session(client):
    sid = _play(client)
    r = client.post("/api/radio/recent", json={"session_id": sid})
    assert r.status_code == 409 and r.get_json()["error"] == "too_soon"
    assert _ids(client) == []
    _age(sid)
    assert client.post("/api/radio/recent", json={"session_id": sid}).get_json() == {
        "success": True, "station_id": "kexp"}
    body = client.get("/api/radio/recent").get_json()
    assert body["keep"] == 20 and body["after_seconds"] == 30
    [kexp] = body["stations"]
    assert kexp["id"] == "kexp" and kexp["name"] == "KEXP" and kexp["played_at"] > 0
    assert "url" not in str(kexp["streams"])  # no addresses, as in every station list


def test_newest_first_and_once_per_station(client):
    for station_id, played_at in (("kexp", 100), ("nts-1", 200), ("fip-jazz", 300)):
        store.record_recent(radio_api._db(), 1, station_id, played_at=played_at)
    store.record_recent(radio_api._db(), 1, "kexp", played_at=400)
    assert _ids(client) == ["kexp", "fip-jazz", "nts-1"]


def test_only_the_newest_twenty_are_kept_per_profile(client, db):
    for i in range(store.RECENT_KEEP + 5):
        store.record_recent(db, 1, f"station-{i:02d}", played_at=1000 + i)
    store.record_recent(db, 2, "kexp", played_at=5)
    rows = store.recent_rows(db, 1)
    assert len(rows) == store.RECENT_KEEP
    assert rows[0]["station_id"] == "station-24" and rows[-1]["station_id"] == "station-05"
    with db._get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM radio_recent WHERE profile_id = 1").fetchone()[0] == 20
    # another profile's row isn't trimmed by this one's list
    assert [r["station_id"] for r in store.recent_rows(db, 2)] == ["kexp"]


def test_a_profile_only_sees_and_writes_its_own(client, who):
    sid = _play(client)
    _age(sid)
    who["pid"], who["admin"] = 2, False
    # profile 2 can't count profile 1's session, or read profile 1's list
    r = client.post("/api/radio/recent", json={"session_id": sid})
    assert r.status_code == 404 and r.get_json()["error"] == "no_session"
    assert _ids(client) == []
    who["pid"], who["admin"] = 1, True
    client.post("/api/radio/recent", json={"session_id": sid})
    assert _ids(client) == ["kexp"]
    who["pid"], who["admin"] = 2, False
    assert _ids(client) == []


def test_an_ended_or_unknown_session_isnt_counted(client):
    sid = _play(client)
    _age(sid)
    client.post("/api/radio/stop", json={"session_id": sid})
    assert client.post("/api/radio/recent", json={"session_id": sid}).status_code == 404
    assert client.post("/api/radio/recent", json={}).status_code == 404
    assert client.post("/api/radio/recent", json={"session_id": "made-up"}).status_code == 404
    assert _ids(client) == []


def test_no_profile_is_401(client, who):
    who["pid"] = None
    assert client.get("/api/radio/recent").status_code == 401
    assert client.post("/api/radio/recent", json={"session_id": "x"}).status_code == 401


def test_a_directory_station_is_drawn_from_its_snapshot(client, monkeypatch):
    snap = {"id": f"rb-{UUID}", "name": "Ambient Sleeping Pill", "kind": "electronic", "genre": "Ambient",
            "country": "United States", "homepage": "", "tags": ["ambient"], "logo_url": "",
            "streams": [{"id": "s0", "url": "https://x.example.com/s", "codec": "FLAC", "bitrate_kbps": 0}]}
    monkeypatch.setattr(directory, "lookup", lambda sid: radio_api._from_snapshot(snap))
    sid = _play(client, f"rb-{UUID}")
    _age(sid)
    assert client.post("/api/radio/recent", json={"session_id": sid}).status_code == 200

    def offline(_sid):
        raise AssertionError("the list mustn't ask the directory")

    monkeypatch.setattr(directory, "lookup", offline)
    [pill] = client.get("/api/radio/recent").get_json()["stations"]
    assert pill["id"] == f"rb-{UUID}" and pill["name"] == "Ambient Sleeping Pill"
    assert pill["source"] == "directory"


def test_a_removed_link_or_unknown_station_drops_out(client, db):
    link_id = store.add_link(db, name="Lowlands Radio", url="https://stream.example.org/live.mp3",
                             kind="electronic", codec="MP3", bitrate_kbps=320, sends_titles=True,
                             allows_direct=False, added_by="ross")
    store.record_recent(db, 1, f"link-{link_id}", played_at=300)
    store.record_recent(db, 1, "not-a-station", played_at=200)
    store.record_recent(db, 1, "kexp", played_at=100)
    assert _ids(client) == [f"link-{link_id}", "kexp"]
    assert client.get("/api/radio/recent").get_json()["stations"][0]["source"] == "your_link"
    store.remove_link(db, link_id)
    assert _ids(client) == ["kexp"]
    assert [r["station_id"] for r in store.recent_rows(db, 1)] == ["not-a-station", "kexp"]


@pytest.mark.parametrize("limit", [0, -3, 500])
def test_recent_rows_limit_is_clamped(db, limit):
    for i in range(3):
        store.record_recent(db, 1, f"s{i}", played_at=i)
    assert 1 <= len(store.recent_rows(db, 1, limit)) <= 3
