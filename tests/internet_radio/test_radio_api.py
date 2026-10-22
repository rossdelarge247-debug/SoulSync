"""The radio routes (api/radio.py) over a real database, with the network faked:
stations and favourites, playing (direct and relayed), the relay's audio-only
gate and headers, Heard and its Want button, auto-add's confirm numbers and
download rights, tracklists, admin-only links and settings, and the module
switch."""

from __future__ import annotations

import time

import pytest

import api.radio as radio_api
from core.internet_radio import directory, net, relay, store
from core.internet_radio.feeds import FeedResult
from core.internet_radio.hub import hub
from core.internet_radio.stations import builtin_station

UUID = "96062a7b-0601-11e8-ae97-52543be04c81"


class Upstream:
    """A station's response: headers and chunks, closed when the relay ends."""

    def __init__(self, ctype="audio/mpeg", chunks=(b"\xff\xfb" * 512,) * 3, headers=None, status=200):
        self.status_code = status
        self.headers = {"content-type": ctype, "set-cookie": "track=1", "server": "Icecast 2.4",
                        "access-control-allow-origin": "*", **(headers or {})}
        self.chunks = list(chunks)
        self.closed = False

    def iter_content(self, chunk_size=None):
        yield from self.chunks

    def close(self):
        self.closed = True


def test_stations_lists_kinds_in_order_and_favourites(client, db):
    store.add_favourite(db, 1, "nts-1")
    store.add_link(db, name="Lowlands Radio", url="https://stream.example.org/live.mp3", kind="electronic",
                   codec="MP3", bitrate_kbps=320, sends_titles=True, allows_direct=False, added_by="ross")
    body = client.get("/api/radio/stations").get_json()
    assert [k["kind"] for k in body["kinds"]] == ["electronic", "world", "eclectic", "jazz_soul_funk"]
    assert [k["label"] for k in body["kinds"]][2:] == ["Eclectic tastemakers", "Jazz, soul and funk"]
    fav = [(f["id"], f["source"]) for f in body["favourites"]]
    assert fav[0] == ("nts-1", "built_in") and fav[1][1] == "your_link"
    first = body["kinds"][0]["stations"][0]
    assert "url" not in str(first["streams"])  # no addresses until Play
    assert first["quality"]["label"]


def test_favourites_are_per_profile(client, who):
    assert client.post("/api/radio/favourites/kexp").get_json()["favourite"] is True
    who["pid"], who["admin"] = 2, False
    assert all(f["id"] != "kexp" for f in client.get("/api/radio/stations").get_json()["favourites"])
    assert client.post("/api/radio/favourites/not-a-station").status_code == 404


def test_no_profile_is_401(client, who):
    who["pid"] = None
    assert client.get("/api/radio/stations").status_code == 401
    assert client.post("/api/radio/play", json={"station_id": "kexp"}).status_code == 401


def test_play_direct_for_https_streams_with_a_feed(client):
    body = client.post("/api/radio/play", json={"station_id": "somafm-dronezone"}).get_json()
    assert body["mode"] == "direct" and body["play_url"].startswith("https://ice1.somafm.com/")
    assert hub.get_session(body["session_id"], 1) is not None


def test_play_relays_when_the_stream_cant_play_directly(client, config):
    body = client.post("/api/radio/play", json={"station_id": "kexp"}).get_json()
    assert body["mode"] == "relay" and body["play_url"] == f"/api/radio/relay/{body['session_id']}"
    config.set("radio.relay", "always")
    body = client.post("/api/radio/play", json={"station_id": "somafm-dronezone"}).get_json()
    assert body["mode"] == "relay"


def test_play_only_resolves_stations_the_server_knows(client, monkeypatch):
    """A body can't smuggle an address: unknown ids are 404 and a url field is ignored."""
    r = client.post("/api/radio/play", json={"station_id": "http://169.254.169.254/", "url": "http://10.0.0.1/"})
    assert r.status_code == 404
    monkeypatch.setattr(directory, "lookup", lambda sid: None)
    assert client.post("/api/radio/play", json={"station_id": f"rb-{UUID}"}).status_code == 404
    assert client.post("/api/radio/play", json={"station_id": "rb-../../etc"}).status_code == 404


def test_the_third_relay_gets_busy(client, who):
    for pid in (1, 2):
        who["pid"] = pid
        assert client.post("/api/radio/play", json={"station_id": "kexp"}).get_json()["mode"] == "relay"
    who["pid"] = 3
    r = client.post("/api/radio/play", json={"station_id": "kexp"})
    assert r.status_code == 409 and r.get_json()["error"] == "busy"


def test_relay_passes_audio_only_with_its_own_headers(client, monkeypatch):
    up = Upstream(headers={"icy-metaint": "0"})
    monkeypatch.setattr(radio_api, "open_stream", lambda url: (up, "audio/mpeg"))
    sid = client.post("/api/radio/play", json={"station_id": "kexp"}).get_json()["session_id"]
    r = client.get(f"/api/radio/relay/{sid}")
    assert r.status_code == 200 and r.mimetype == "audio/mpeg"
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert "Set-Cookie" not in r.headers
    assert r.headers.get("Server") != "Icecast 2.4"
    assert r.headers["Cache-Control"] == "no-store"
    assert "Access-Control-Allow-Origin" not in r.headers
    assert r.data == b"\xff\xfb" * 512 * 3
    assert up.closed
    assert hub.get_session(sid) is None  # the relay ended with the listener


def test_relay_session_is_the_profiles_own(client, who, monkeypatch):
    monkeypatch.setattr(radio_api, "open_stream", lambda url: (Upstream(), "audio/mpeg"))
    sid = client.post("/api/radio/play", json={"station_id": "kexp"}).get_json()["session_id"]
    who["pid"] = 2
    assert client.get(f"/api/radio/relay/{sid}").status_code == 404
    assert client.get("/api/radio/relay/made-up").status_code == 404


def test_relay_refuses_what_isnt_audio(client, monkeypatch):
    def html(url):
        raise relay.StreamError("This link isn't an audio stream. The address answered with a web page.")
    monkeypatch.setattr(radio_api, "open_stream", html)
    sid = client.post("/api/radio/play", json={"station_id": "kexp"}).get_json()["session_id"]
    r = client.get(f"/api/radio/relay/{sid}")
    assert r.status_code == 502 and r.mimetype == "application/json"
    assert hub.relay_count() == 0  # the slot is handed back


@pytest.mark.parametrize("ctype,passed", [
    ("audio/mpeg", "audio/mpeg"), ("audio/aacp; charset=x", "audio/aacp"), ("application/ogg", "application/ogg"),
    ("audio/flac", "audio/flac"), ("text/html; charset=utf-8", None), ("image/svg+xml", None),
    ("application/json", None), ("audio/x-mpegurl", None), ("audio/x-scpls", None), ("video/mp4", None),
    ("text/plain", None), ("", None), (None, None), ("audio/<script>", None),
])
def test_audio_type_gate(ctype, passed):
    assert relay.audio_type(ctype) == passed


def test_open_stream_refuses_html_and_closes_it(monkeypatch):
    up = Upstream(ctype="text/html")
    monkeypatch.setattr(relay, "guarded_request", lambda *a, **kw: (up, "https://x.example.com/"))
    with pytest.raises(relay.StreamError, match="isn't an audio stream"):
        relay.open_stream("https://x.example.com/listen")
    assert up.closed


def test_relay_strips_titles_and_stops_on_stop(app, monkeypatch):
    st = builtin_station("dublab")
    sess = hub.start_session(1, st, st.streams[0], "relay")
    hub.claim_relay(sess.id, 1)
    meta = b"StreamTitle='Tidewater - Night Ferry';"
    meta += b"\x00" * ((16 - len(meta) % 16) % 16)
    up = Upstream(headers={"icy-metaint": "4"}, chunks=[b"AAAA" + bytes([len(meta) // 16]) + meta + b"BBBB\x00",
                                                         b"CCCC\x00"])
    gen = relay.relay_chunks(hub, sess, up, "audio/mpeg")
    assert next(gen) == b"AAAABBBB"
    assert hub.now_playing(st, 1)["track"]["title"] == "Night Ferry"
    sess.stop.set()
    assert list(gen) == []
    assert up.closed


def test_relay_ends_after_the_total_cap(app, monkeypatch):
    st = builtin_station("dublab")
    sess = hub.start_session(1, st, st.streams[0], "relay")
    t = {"now": 0.0}

    def clock():
        t["now"] += relay.MAX_SECONDS / 2 + 1
        return t["now"]
    up = Upstream(chunks=[b"a", b"b", b"c", b"d"])
    out = list(relay.relay_chunks(hub, sess, up, "audio/mpeg", clock=clock))
    assert len(out) < 4 and up.closed


def test_now_playing_touches_the_session_and_reports_state(client):
    sid = client.post("/api/radio/play", json={"station_id": "somafm-dronezone"}).get_json()["session_id"]
    hub.on_feed(builtin_station("somafm-dronezone"), FeedResult(True, artist="Pale Harbour", title="Harbour Light"))
    body = client.get(f"/api/radio/now-playing?station_id=somafm-dronezone&session_id={sid}").get_json()
    assert body["state"] == "identified" and body["session_active"] is True
    assert body["library"] == {"in_library": False, "below_target": None, "track_id": None}


def test_heard_list_states_and_want(client, db, library):
    st = builtin_station("kexp")
    hub.start_session(1, st, st.streams[0], "relay")
    library.owned.add((1, "pale harbour", "harbour light"))
    hub.on_feed(st, FeedResult(True, artist="Pale Harbour", title="Harbour Light"))
    hub.on_feed(st, FeedResult(True, artist="Tidewater", title="Night Ferry"))
    body = client.get("/api/radio/heard").get_json()
    states = {i["title"]: i["state"] for i in body["items"]}
    assert states == {"Harbour Light": "in_library", "Night Ferry": "not_added"}
    assert body["counts"]["not_in_library"] == 1
    item = next(i for i in body["items"] if i["title"] == "Night Ferry")
    r = client.post(f"/api/radio/heard/{item['id']}/want").get_json()
    assert r["item"]["state"] == "on_wanted" and library.added[-1]["auto"] is False
    missing = client.get("/api/radio/heard?missing=1").get_json()["items"]
    assert missing == []


def test_heard_is_per_profile(client, db, who):
    store.record_heard(db, profile_id=2, station_id="kexp", station_name="KEXP", heard_at=int(time.time()),
                       artist="A", title="B", track_key="a|b")
    hid = store.list_heard(db, 2)[0]["id"]
    assert client.get("/api/radio/heard").get_json()["items"] == []
    assert client.post(f"/api/radio/heard/{hid}/want").status_code == 404


def test_heard_without_an_artist_cant_be_matched(client, db):
    store.record_heard(db, profile_id=1, station_id="kexp", station_name="KEXP", heard_at=int(time.time()),
                       artist="", title="Untitled", track_key="")
    item = client.get("/api/radio/heard").get_json()["items"][0]
    assert item["state"] == "cant_match"
    assert client.post(f"/api/radio/heard/{item['id']}/want").status_code == 400


def test_auto_add_confirm_numbers(client, db, library):
    yesterday = store.day_start(days_ago=1) + 3600
    for i in range(5):
        store.record_heard(db, profile_id=9, station_id="nts-1", station_name="NTS 1", heard_at=yesterday + i,
                           artist=f"A{i}", title=f"T{i}", track_key=f"a{i}|t{i}")
    library.owned.add((1, "a0", "t0"))
    library.wanted.add((1, "a1", "t1"))
    body = client.get("/api/radio/stations/nts-1/auto-add").get_json()
    assert (body["identified_yesterday"], body["already_have"], body["would_add"], body["daily_limit"]) == (5, 2, 3, 50)
    assert body["enabled"] is False


def test_turning_on_auto_add_needs_download_rights(client, who):
    who["pid"], who["admin"], who["denied"] = 2, False, "Downloads are disabled for this profile."
    r = client.put("/api/radio/stations/kexp/auto-add", json={"enabled": True})
    assert r.status_code == 403 and r.get_json()["error"] == "no_download_rights"
    # turning it off never needs them
    assert client.put("/api/radio/stations/kexp/auto-add", json={"enabled": False}).status_code == 200
    who["denied"] = None
    assert client.put("/api/radio/stations/kexp/auto-add", json={"enabled": True}).get_json()["enabled"] is True


def test_auto_add_is_off_by_default(client):
    assert client.get("/api/radio/stations/kexp/auto-add").get_json()["enabled"] is False
    assert all(not s["auto_add"] for k in client.get("/api/radio/stations").get_json()["kinds"] for s in k["stations"])


def test_tracklist_and_want_missing(client, db, library):
    def fake(url, params, headers, timeout):
        if url.endswith("/v2/shows/"):
            return {"results": [{"id": 7, "program_name": "The Morning Show", "host_names": ["John"],
                                 "start_time": "2026-10-22T06:00:00Z"}]}
        if url.endswith("/v2/plays/"):
            return {"results": [
                {"play_type": "trackplay", "artist": "Saltmarsh", "song": "Static Bloom", "airdate": "2026-10-22T06:02:00Z"},
                {"play_type": "trackplay", "artist": "Marrow Field", "song": "Glasshouse", "airdate": "2026-10-22T06:07:00Z"},
                {"play_type": "trackplay", "artist": "", "song": "Untitled (white label)", "airdate": "2026-10-22T06:26:00Z"}]}
        raise net.FetchError("unexpected")
    net.set_fetcher(fake)
    library.owned.add((1, "saltmarsh", "static bloom"))
    shows = client.get("/api/radio/stations/kexp/shows").get_json()["shows"]
    assert shows[0]["id"] == "kexp:7" and shows[0]["track_count"] == 3 and shows[0]["missing_count"] == 1
    tl = client.get("/api/radio/shows/kexp:7").get_json()
    assert [t["state"] for t in tl["tracks"]] == ["in_library", "not_added", "cant_match"]
    assert client.post("/api/radio/shows/kexp:7/want", json={"position": 3}).status_code == 400  # no artist
    one = client.post("/api/radio/shows/kexp:7/want", json={"position": 2}).get_json()
    assert one["track"]["state"] == "on_wanted"
    r = client.post("/api/radio/shows/kexp:7/want-missing").get_json()
    assert (r["added"], r["skipped"]) == (0, 3)
    assert [a["title"] for a in library.added] == ["Glasshouse"]


def test_directory_search_maps_stations_and_is_cached(client, monkeypatch):
    calls = []

    def fake(url, params, headers, timeout):
        calls.append(params.get("name") or params.get("tag"))
        return [{"stationuuid": UUID, "name": "Ambient Sleeping Pill", "url_resolved": "https://x.example.com/s",
                 "codec": "FLAC", "bitrate": 0, "tags": "ambient,sleep,drone", "country": "United States", "hls": 0},
                {"stationuuid": "00000000-0000-0000-0000-000000000000", "name": "HLS one",
                 "url_resolved": "https://x.example.com/p.m3u8", "codec": "AAC", "hls": 1}]
    net.set_fetcher(fake)
    body = client.get("/api/radio/directory?q=ambient&codec=FLAC").get_json()
    assert [r["id"] for r in body["results"]] == [f"rb-{UUID}"]
    assert body["results"][0]["source"] == "directory" and body["results"][0]["quality"]["lossless"]
    client.get("/api/radio/directory?q=ambient&codec=FLAC")
    assert len(calls) == 2  # name + tag once; the second search came from the cache


def test_directory_down_says_so(client):
    r = client.get("/api/radio/directory?q=jazz")
    assert r.status_code == 502 and "directory" in r.get_json()["message"].lower()


# ── admin-only: links and settings ───────────────────────────────────────────

@pytest.mark.parametrize("method,path,body", [
    ("get", "/api/radio/links", None),
    ("post", "/api/radio/links/check", {"url": "https://x.example.com/s"}),
    ("post", "/api/radio/links", {"url": "https://x.example.com/s", "name": "X", "kind": "world"}),
    ("delete", "/api/radio/links/1", None),
    ("get", "/api/radio/settings", None),
    ("put", "/api/radio/settings", {"daily_limit": 10}),
])
def test_members_cant_manage_links_or_settings(client, who, method, path, body):
    who["pid"], who["admin"] = 2, False
    r = getattr(client, method)(path, json=body) if body is not None else getattr(client, method)(path)
    assert r.status_code == 403


def test_link_check_refuses_private_addresses_without_fetching(client, monkeypatch):
    fetched = []
    monkeypatch.setattr(relay, "guarded_request", lambda *a, **kw: fetched.append(a) or None)
    for url in ("http://127.0.0.1:8000/stream", "http://192.168.1.20/live", "http://169.254.169.254/latest",
                "http://localhost/x", "file:///etc/passwd"):
        body = client.post("/api/radio/links/check", json={"url": url}).get_json()
        assert body["ok"] is False and body["error"]
    assert fetched == []


def test_adding_a_link_needs_a_passing_check(client, db, monkeypatch):
    monkeypatch.setattr(radio_api, "check_url", lambda url: (True, ""))
    monkeypatch.setattr(radio_api, "check_link", lambda url: {"ok": False, "error": "This link isn't an audio stream."})
    r = client.post("/api/radio/links", json={"url": "https://x.example.com/listen", "name": "X", "kind": "world"})
    assert r.status_code == 400 and store.list_links(db) == []
    monkeypatch.setattr(radio_api, "check_link", lambda url: {"ok": True, "codec": "MP3", "bitrate_kbps": 320,
                                                              "sends_titles": True, "allows_direct": False})
    link = client.post("/api/radio/links", json={"url": "https://x.example.com/live.mp3", "name": "Lowlands Radio",
                                                 "kind": "electronic"}).get_json()["link"]
    assert link["added_by"] == "ross" and link["codec"] == "MP3"
    assert client.delete(f"/api/radio/links/{link['id']}").status_code == 200


def test_check_link_listens_and_reports(monkeypatch):
    meta = b"StreamTitle='A - B';"
    meta += b"\x00" * ((16 - len(meta) % 16) % 16)
    up = Upstream(headers={"icy-metaint": "4", "icy-br": "320"},
                  chunks=[b"AAAA" + bytes([len(meta) // 16]) + meta + b"BB"])
    monkeypatch.setattr(relay, "guarded_request", lambda *a, **kw: (up, "https://x.example.com/live.mp3"))
    out = relay.check_link("https://x.example.com/live.mp3")
    assert out["ok"] and out["codec"] == "MP3" and out["bitrate_kbps"] == 320 and out["sends_titles"]
    assert out["allows_direct"] is True and up.closed


def test_settings_round_trip_and_the_key_stays_masked(client, config):
    config.set("acoustid.api_key", "x9KfABCDEFQ2")
    body = client.get("/api/radio/settings").get_json()
    assert body["settings"]["daily_limit"] == 50 and body["settings"]["relay"] == "when_needed"
    assert body["settings"]["acoustid_api_key"] == {"set": True, "masked": "x9Kf•••••••Q2"}
    assert "x9KfABCDEFQ2" not in str(body)
    body = client.put("/api/radio/settings", json={"daily_limit": 20, "keep_heard_days": 30, "prefer_lossless": False,
                                                   "acoustid_api_key": ""}).get_json()
    assert body["settings"]["daily_limit"] == 20 and config.get("acoustid.api_key") == "x9KfABCDEFQ2"
    r = client.put("/api/radio/settings", json={"daily_limit": 0, "relay": "always"})
    assert r.status_code == 400 and config.get("radio.relay", "when_needed") == "when_needed"


# ── the module switch ────────────────────────────────────────────────────────

def test_every_radio_route_belongs_to_the_module(config):
    from core.modules import disabled_module_for_path, module_for_block
    for path in ("/api/radio/stations", "/api/radio/relay/abc", "/api/radio/settings", "/api/radio/play"):
        assert disabled_module_for_path(path, config) is None
    config.set("modules.radio.enabled", False)
    for path in ("/api/radio/stations", "/api/radio/relay/abc", "/api/radio/settings", "/api/radio/play"):
        assert disabled_module_for_path(path, config) == "radio"
    assert disabled_module_for_path("/api/radiology", config) is None
    assert module_for_block("radio_track_heard") == "radio"


def test_turning_the_module_off_ends_every_session(app):
    st = builtin_station("kexp")
    sess = hub.start_session(1, st, st.streams[0], "relay")
    radio_api.stop_watcher()
    assert sess.stop.is_set() and hub.relay_count() == 0


def test_playing_favouriting_and_auto_add_wake_the_watcher(client, fake_watcher):
    before = fake_watcher.ensured
    client.post("/api/radio/play", json={"station_id": "somafm-dronezone"})
    assert fake_watcher.ensured == before + 1
    client.post("/api/radio/favourites/kexp")
    assert fake_watcher.ensured == before + 2
    client.put("/api/radio/stations/kexp/auto-add", json={"enabled": True})
    assert fake_watcher.ensured == before + 3
    client.put("/api/radio/stations/kexp/auto-add", json={"enabled": False})
    assert fake_watcher.ensured == before + 3
