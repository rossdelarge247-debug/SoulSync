"""Automatic AudD (core/internet_radio/audd_auto.py, the hub's fingerprint step):
asked only when needed (a watched station that isn't naming the track, after
AcoustID found nothing), the daily cap and its reset at local midnight, pacing
per station, stopping for the day on a refused key or no requests left, the
Settings keys, the source, Heard and auto-add, and the token kept out of every
log and answer. Fake clocks; AudD's requests are faked at the outbound guard."""

from __future__ import annotations

import json
import logging
import time

import pytest

import api.radio as radio_api
from core.internet_radio import scan_providers, store
from core.internet_radio.audd_auto import STATION_GAP_SECONDS, WINDOW_MAX_SECONDS
from core.internet_radio.feeds import FeedResult
from core.internet_radio.hub import hub
from core.internet_radio.stations import builtin_station

AUDD = "auddTOKEN1234567890abcdef"
HIT = {"status": "success", "result": {"artist": "Tidewater", "title": "Night Ferry", "album": "Dub"}}
NONE = {"status": "success", "result": None}
REFUSED = {"status": "error", "error": {"error_code": 900, "error_message": "Wrong api_token"}}
NO_CREDIT = {"status": "error", "error": {"error_code": 901, "error_message": "Request limit reached"}}


class Resp:
    def __init__(self, body, status=200):
        self.status_code = status
        self._raw = json.dumps(body).encode()

    def iter_content(self, chunk_size=None):
        yield self._raw

    def close(self):
        pass


class Net:
    """The guarded request, faked: AudD's answer, each call recorded."""

    def __init__(self):
        self.calls = []
        self.answer = HIT

    def __call__(self, method, url, **kw):
        assert url == scan_providers.AUDD_URL, url
        self.calls.append({"method": method, "url": url, **kw})
        return Resp(self.answer), url


@pytest.fixture
def net(monkeypatch):
    n = Net()
    monkeypatch.setattr(scan_providers, "guarded_request", n)
    return n


@pytest.fixture
def clock(app, monkeypatch):
    # local noon today: Settings → Radio's "No requests left" is for this month,
    # and no test's few minutes cross midnight by accident
    t = {"now": float(store.day_start(time.time()) + 12 * 3600)}
    monkeypatch.setattr(hub.deps, "clock", lambda: t["now"])
    monkeypatch.setattr(radio_api.audd_auto, "clock", lambda: t["now"])
    radio_api.audd_auto.reset()
    yield t
    radio_api.audd_auto.reset()


@pytest.fixture
def acoustid(app, config, monkeypatch):
    """The automatic fingerprint, faked: AcoustID answers ``state["status"]``."""
    state = {"status": "no_match", "calls": 0}

    def fp(_path):
        state["calls"] += 1
        if state["status"] == "ok":
            return {"status": "ok", "artist": "Saltmarsh", "title": "Static Bloom"}
        return {"status": state["status"]}

    monkeypatch.setattr(hub.deps, "fingerprint", fp)
    monkeypatch.setattr(hub.deps, "fingerprint_available", lambda: (True, ""))
    config.set("radio.audd_api_token", AUDD)
    return state


def dublab():
    return builtin_station("dublab")  # no feed: titles and fingerprints only


def clip(st, clock):
    """Let the hub ask for a clip, as the relay does, and hand one over.
    True when a clip was taken."""
    clock["now"] += 30
    if not hub.wants_clip(st.id):
        return False
    hub.submit_clip(st.id, b"\xff" * 1000, "audio/mpeg")
    return True


def listen(st, pid=1):
    return hub.start_session(pid, st, st.streams[0], "relay")


# ── only when needed ─────────────────────────────────────────────────────────

def test_audd_names_the_track_after_acoustid_found_nothing(app, db, clock, acoustid, net):
    st = dublab()
    listen(st)
    assert clip(st, clock)
    assert acoustid["calls"] == 1 and len(net.calls) == 1
    np = hub.now_playing(st, 1)
    assert np["state"] == "identified" and np["source"] == "audd"
    assert (np["track"]["artist"], np["track"]["title"], np["track"]["release"]) == ("Tidewater", "Night Ferry", "Dub")
    assert net.calls[0]["data"] == {"api_token": AUDD} and "file" in net.calls[0]["files"]
    assert net.calls[0]["max_redirects"] == 0
    assert store.audd_auto_used(db, clock["now"]) == 1
    assert store.scan_usage(db, clock["now"])["audd"] == {"requests": 1, "found": 1}


def test_a_station_naming_the_track_is_never_sent_to_audd(app, db, clock, acoustid, net):
    st = dublab()
    listen(st)
    hub.on_stream_title(st.id, "Tidewater - Night Ferry (Dub)")
    clock["now"] += 30
    assert hub.wants_clip(st.id) is False  # identified: no clip at all
    # even when a clip is in flight and AcoustID finds nothing, a named track isn't sent
    hub.on_fingerprint(st.id, {"status": "no_match"})
    assert hub.audd_needed(st.id) == "station_names_track"
    hub._run_fingerprint(st.id, b"\xff" * 1000, "audio/mpeg")
    assert net.calls == []


def test_a_feed_naming_the_track_counts_as_named(app, clock, acoustid, net):
    st = builtin_station("somafm-dronezone")
    listen(st)
    hub.on_feed(st, FeedResult(True, artist="Pale Harbour", title="Harbour Light"))
    assert hub.audd_needed(st.id) == "station_names_track"
    hub.on_feed(st, FeedResult(False, reason="This is a show."))
    assert hub.audd_needed(st.id) is None


@pytest.mark.parametrize("title", ["", "Dublab", "Advert break", "Dublab Sessions with Someone"])
def test_generic_titles_dont_count_as_named(app, clock, acoustid, net, title):
    st = dublab()
    listen(st)
    if title:
        hub.on_stream_title(st.id, title)
    assert hub.audd_needed(st.id) is None
    assert clip(st, clock)
    assert len(net.calls) == 1


def test_acoustid_finding_it_means_no_audd_request(app, clock, acoustid, net):
    acoustid["status"] = "ok"
    st = dublab()
    listen(st)
    assert clip(st, clock)
    assert net.calls == []
    assert hub.now_playing(st, 1)["source"] == "fingerprint"


def test_an_acoustid_error_isnt_a_miss(app, clock, acoustid, net):
    acoustid["status"] = "error"
    st = dublab()
    listen(st)
    assert clip(st, clock)
    assert net.calls == []


def test_only_watched_stations(app, db, clock, acoustid, net):
    st = dublab()
    sess = listen(st)
    hub.end_session(sess.id, 1)          # nobody plays it now; the monitor lingers
    assert hub.audd_needed(st.id) == "not_watched"
    store.set_auto_add(db, 1, st.id, st.name, True)
    assert hub.audd_needed(st.id) is None


def test_switched_off_cap_zero_or_no_token_sends_nothing(app, config, db, clock, acoustid, net):
    st = dublab()
    listen(st)
    config.set("radio.audd_auto", False)
    assert clip(st, clock) and net.calls == []
    config.set("radio.audd_auto", True)
    config.set("radio.audd_auto_daily_cap", 0)
    clock["now"] += STATION_GAP_SECONDS
    assert clip(st, clock) and net.calls == []
    config.set("radio.audd_auto_daily_cap", 100)
    config.clear_secret("radio.audd_api_token")
    clock["now"] += STATION_GAP_SECONDS
    assert clip(st, clock) and net.calls == []
    assert store.audd_auto_used(db, clock["now"]) == 0


# ── the cap ──────────────────────────────────────────────────────────────────

def test_the_daily_cap_stops_it_until_local_midnight(app, config, db, clock, acoustid, net):
    config.set("radio.audd_auto_daily_cap", 2)
    stations = [dublab(), builtin_station("somafm-dronezone"), builtin_station("nts-1")]
    for i, st in enumerate(stations):
        hub.start_session(i + 1, st, st.streams[0], "direct")
    for st in stations:
        clock["now"] += 30
        hub._run_fingerprint(st.id, b"\xff" * 1000, "audio/mpeg")
    assert len(net.calls) == 2                       # the third station waits for tomorrow
    assert store.audd_auto_used(db, clock["now"]) == 2
    status = client_status(app)
    assert status["used_today"] == 2 and status["daily_cap"] == 2 and status["stopped"] == "cap_reached"
    # local midnight: the count starts again
    clock["now"] = store.day_start(clock["now"], days_ago=-1) + 60
    hub._run_fingerprint(stations[2].id, b"\xff" * 1000, "audio/mpeg")
    assert len(net.calls) == 3
    assert store.audd_auto_used(db, clock["now"]) == 1


def test_scan_now_by_hand_isnt_counted_against_the_cap(app, client, config, db, clock, acoustid, net):
    config.set("radio.audd_auto_daily_cap", 1)
    st = dublab()
    listen(st)
    assert clip(st, clock) and len(net.calls) == 1
    # capped for today, but the admin's Test (by hand) still goes, and isn't counted here
    r = client.post("/api/radio/scan/test", json={"service": "audd"})
    assert r.status_code == 200 and len(net.calls) == 2
    assert store.audd_auto_used(db, clock["now"]) == 1
    assert store.scan_usage(db, clock["now"])["audd"]["requests"] == 2  # the month counts both


# ── pacing ───────────────────────────────────────────────────────────────────

def test_one_request_per_station_per_track_window(app, clock, acoustid, net):
    net.answer = NONE
    st = dublab()
    listen(st)
    hub.on_stream_title(st.id, "Dublab Sessions with Someone")
    assert clip(st, clock) and len(net.calls) == 1
    assert "neither AcoustID nor AudD recognised it" in hub.now_playing(st, 1)["reason"]
    # the fingerprint's own gap passes, AcoustID tries again, but this window is spent
    clock["now"] += STATION_GAP_SECONDS
    assert clip(st, clock) and acoustid["calls"] == 2 and len(net.calls) == 1
    # the title changes: a new window, and the station gap has passed
    hub.on_stream_title(st.id, "Dublab Sessions with Someone Else")
    clock["now"] += STATION_GAP_SECONDS
    assert clip(st, clock) and len(net.calls) == 2


def test_at_least_three_minutes_between_requests_on_a_station(app, clock, acoustid, net):
    st = dublab()
    listen(st)
    auto = radio_api.audd_auto
    db = hub.deps.get_database()
    assert auto.identify(st.id, __file__, 1) is not None
    clock["now"] += STATION_GAP_SECONDS - 10
    assert auto.why_not(db, st.id, 2, clock["now"]) == "paced"   # a new title, but too soon
    assert auto.identify(st.id, __file__, 2) is None
    clock["now"] += 10
    assert auto.why_not(db, st.id, 2, clock["now"]) is None
    assert len(net.calls) == 1
    assert STATION_GAP_SECONDS >= 180


def test_a_station_whose_title_never_changes_gets_a_new_window_slowly(app, clock, acoustid, net):
    st = dublab()
    listen(st)
    auto = radio_api.audd_auto
    db = hub.deps.get_database()
    assert auto.identify(st.id, __file__, 0) is not None
    clock["now"] += WINDOW_MAX_SECONDS - 1
    assert auto.why_not(db, st.id, 0, clock["now"]) == "same_window"
    clock["now"] += 1
    assert auto.why_not(db, st.id, 0, clock["now"]) is None


def test_each_station_is_paced_on_its_own(app, clock, acoustid, net):
    auto = radio_api.audd_auto
    assert auto.identify("a", __file__, 0) is not None
    assert auto.identify("b", __file__, 0) is not None
    assert auto.identify("a", __file__, 1) is None
    assert len(net.calls) == 2


# ── stopping for the day ─────────────────────────────────────────────────────

@pytest.mark.parametrize("answer,state,tag", [(REFUSED, "bad_key", "refused"),
                                              (NO_CREDIT, "out_of_credit", "no_requests_left")])
def test_refused_or_no_requests_left_stops_it_for_the_day(app, client, db, clock, acoustid, net, answer, state, tag):
    net.answer = answer
    auto = radio_api.audd_auto
    st = dublab()
    listen(st)
    assert clip(st, clock) and len(net.calls) == 1
    assert hub.now_playing(st, 1)["state"] == "not_identified"   # AcoustID's miss stands
    assert auto.stopped_today(db) == state
    # another station, a new window, hours later: still nothing today
    clock["now"] = store.day_start(clock["now"], days_ago=-1) - 600
    assert auto.identify("another", __file__, 5) is None
    assert len(net.calls) == 1
    body = client.get("/api/radio/settings").get_json()
    assert body["scan"]["services"]["audd"]["state"] == tag
    assert body["scan"]["audd_auto"]["stopped"] == state
    # a new day: it may ask again
    clock["now"] = store.day_start(clock["now"], days_ago=-1) + 60
    net.answer = NONE
    assert auto.identify("another", __file__, 6) is not None


def test_a_new_token_lifts_todays_stop(app, client, db, clock, acoustid, net):
    net.answer = REFUSED
    auto = radio_api.audd_auto
    assert auto.identify("a", __file__, 0) is not None
    assert auto.stopped_today(db) == "bad_key"
    client.put("/api/radio/settings", json={"audd_api_token": "auddNEWTOKEN0987654321"})
    assert auto.stopped_today(db) is None


def test_errors_are_paced_never_retried_in_a_loop(app, db, clock, acoustid, net):
    net.answer = {"status": "error", "error": {"error_code": 0, "error_message": "busy"}}
    st = dublab()
    listen(st)
    assert clip(st, clock)
    for _ in range(6):  # the relay keeps asking (90 s apart here); AcoustID goes again every few minutes
        clock["now"] += 60
        clip(st, clock)
    assert len(net.calls) == 1


# ── Heard and auto-add ───────────────────────────────────────────────────────

def test_matches_flow_into_heard_and_auto_add_with_the_same_guards(app, db, clock, acoustid, net, library):
    st = dublab()
    store.set_auto_add(db, 1, st.id, st.name, True)
    store.set_auto_add(db, 2, st.id, st.name, True)
    library.owned.add((2, "tidewater", "night ferry"))  # profile 2 has it already
    listen(st, pid=3)
    assert clip(st, clock)
    for pid in (1, 2, 3):
        rows = store.list_heard(db, pid)
        assert [(r["title"], r["source"]) for r in rows] == [("Night Ferry", "audd")]
    assert [(a["profile_id"], a["title"], a["auto"]) for a in library.added] == [(1, "Night Ferry", True)]


def test_auto_add_respects_the_daily_limit(app, config, db, clock, acoustid, net, library):
    config.set("radio.daily_limit", 1)
    st = dublab()
    store.set_auto_add(db, 1, st.id, st.name, True)
    listen(st, pid=3)
    store.claim_auto_add(db, 1, "someone|else", st.id, daily_limit=1, day_since=store.day_start(clock["now"]),
                         now=clock["now"])
    assert clip(st, clock)
    assert [r["title"] for r in store.list_heard(db, 1)] == ["Night Ferry"]
    assert library.added == []


# ── Settings ─────────────────────────────────────────────────────────────────

def client_status(app):
    with app.test_client() as c:
        return c.get("/api/radio/settings").get_json()["scan"]["audd_auto"]


def test_settings_save_and_read(app, client, config, clock, who):
    s = client.get("/api/radio/settings").get_json()
    assert s["settings"]["audd_auto"] is True and s["settings"]["audd_auto_daily_cap"] == 100
    assert s["scan"]["audd_auto"] == {"on": True, "daily_cap": 100, "used_today": 0, "ready": False,
                                      "stopped": None}
    r = client.put("/api/radio/settings", json={"audd_auto": False, "audd_auto_daily_cap": 25})
    assert r.status_code == 200
    body = r.get_json()
    assert body["settings"]["audd_auto"] is False and body["settings"]["audd_auto_daily_cap"] == 25
    assert config.get("radio.audd_auto") is False and config.get("radio.audd_auto_daily_cap") == 25
    assert body["scan"]["audd_auto"]["on"] is False
    for bad in ({"audd_auto": "yes"}, {"audd_auto_daily_cap": -1}, {"audd_auto_daily_cap": 1001},
                {"audd_auto_daily_cap": "lots"}, {"audd_auto_daily_cap": True}):
        assert client.put("/api/radio/settings", json=bad).status_code == 400
    assert config.get("radio.audd_auto_daily_cap") == 25
    assert client.put("/api/radio/settings", json={"audd_auto_daily_cap": 0}).get_json()["scan"]["audd_auto"][
        "on"] is False


def test_members_see_the_line_only_and_cant_change_it(app, client, config, who):
    config.set("radio.audd_api_token", AUDD)
    who["pid"], who["admin"] = 2, False
    body = client.get("/api/radio/settings").get_json()
    assert body["scan"]["audd_auto"] == {"on": True, "daily_cap": 100}
    assert client.put("/api/radio/settings", json={"audd_auto": False}).status_code == 403
    assert config.get("radio.audd_auto", True) is True


# ── the token stays secret ───────────────────────────────────────────────────

def test_the_token_never_appears_in_logs_or_answers(app, client, db, clock, acoustid, net, caplog):
    caplog.set_level(logging.DEBUG)
    st = dublab()
    listen(st)
    texts = []
    for answer in (HIT, REFUSED):
        net.answer = answer
        hub.on_stream_title(st.id, f"Dublab {answer['status']}")
        clock["now"] += 24 * 3600
        hub._run_fingerprint(st.id, b"\xff" * 1000, "audio/mpeg")
        texts.append(json.dumps(hub.now_playing(st, 1)))
    texts.append(client.get("/api/radio/settings").get_data(as_text=True))
    texts.append(caplog.text)
    assert len(net.calls) == 2
    for text in texts:
        assert AUDD not in text
