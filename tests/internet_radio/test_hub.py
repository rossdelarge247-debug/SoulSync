"""The hub: listening sessions and the relay cap, identification in order (feed,
stream titles, fingerprint), Heard, auto-add's guards and daily limit, the
Activity roll-up and the radio trigger."""

from __future__ import annotations

import pytest

from core.activity import feed as activity_feed
from core.internet_radio import store
from core.internet_radio.feeds import FeedResult
from core.internet_radio.hub import MAX_RELAYS, Busy, hub
from core.internet_radio.stations import builtin_station


@pytest.fixture
def clock(app, monkeypatch):
    t = {"now": 1_761_130_000.0}
    monkeypatch.setattr(hub.deps, "clock", lambda: t["now"])
    return t


def somafm():
    return builtin_station("somafm-dronezone")


def dublab():
    return builtin_station("dublab")  # no feed: titles and fingerprints only


def test_the_third_relay_is_busy_and_a_direct_session_isnt_counted(app):
    st = somafm()
    s1 = hub.start_session(1, st, st.streams[0], "relay")
    s2 = hub.start_session(2, st, st.streams[0], "relay")
    assert hub.relay_count() == MAX_RELAYS
    with pytest.raises(Busy):
        hub.start_session(3, st, st.streams[0], "relay")
    hub.start_session(4, st, st.streams[0], "direct")  # direct holds no thread
    hub.end_session(s1.id, 1)
    assert hub.relay_count() == 1
    hub.start_session(3, st, st.streams[0], "relay")
    assert s2.id != s1.id


def test_a_profile_starting_another_station_ends_its_first(app):
    a, b = somafm(), dublab()
    first = hub.start_session(1, a, a.streams[0], "relay")
    hub.start_session(1, b, b.streams[0], "relay")
    assert first.stop.is_set() and hub.get_session(first.id) is None
    assert hub.relay_count() == 1


def test_relay_sessions_belong_to_their_profile_and_connect_once(app):
    st = dublab()
    sess = hub.start_session(1, st, st.streams[0], "relay")
    assert hub.claim_relay(sess.id, 2) is None
    assert hub.claim_relay(sess.id, 1) is sess
    assert hub.claim_relay(sess.id, 1) is None  # a second connection isn't a second listener


def test_pending_relays_and_idle_direct_sessions_expire(app, clock):
    st = somafm()
    relay = hub.start_session(1, st, st.streams[0], "relay")
    direct = hub.start_session(2, st, st.streams[0], "direct")
    clock["now"] += 60
    hub.expire()
    assert hub.get_session(relay.id) is None
    hub.touch(direct.id, 2)
    clock["now"] += 80
    hub.expire()
    assert hub.get_session(direct.id) is not None
    clock["now"] += 100
    hub.expire()
    assert hub.get_session(direct.id) is None


def test_feed_identifies_and_records_heard_for_each_listener(app, db, clock):
    st = somafm()
    hub.start_session(1, st, st.streams[0], "direct")
    hub.start_session(2, st, st.streams[0], "direct")
    hub.on_feed(st, FeedResult(True, artist="Pale Harbour", title="Harbour Light", release="Lantern"))
    np = hub.now_playing(st, 1)
    assert np["state"] == "identified" and np["source"] == "station_feed"
    assert np["track"]["title"] == "Harbour Light"
    assert [r["title"] for r in store.list_heard(db, 1)] == ["Harbour Light"]
    assert [r["title"] for r in store.list_heard(db, 2)] == ["Harbour Light"]
    # the same track again isn't a second play
    hub.on_feed(st, FeedResult(True, artist="Pale Harbour", title="Harbour Light"))
    assert len(store.list_heard(db, 1)) == 1


def test_the_feed_wins_over_stream_titles_while_it_names_tracks(app, clock):
    st = somafm()
    hub.start_session(1, st, st.streams[0], "relay")
    hub.on_feed(st, FeedResult(True, artist="A", title="Feed title"))
    hub.on_stream_title(st.id, "B - Stream title")
    assert hub.now_playing(st, 1)["track"]["title"] == "Feed title"


def test_stream_titles_identify_when_there_is_no_feed(app, clock):
    st = dublab()
    hub.start_session(1, st, st.streams[0], "relay")
    hub.on_stream_title(st.id, "Tidewater - Night Ferry (Dub)")
    np = hub.now_playing(st, 1)
    assert np["state"] == "identified" and np["source"] == "stream_titles"
    hub.on_stream_title(st.id, "Dublab Sessions with Someone")
    np = hub.now_playing(st, 1)
    assert np["state"] == "not_identified" and np["reason"]
    assert np["previous_title"] == "Night Ferry (Dub)"


def test_a_show_title_on_the_feed_lets_stream_titles_name_the_track(app, clock):
    st = builtin_station("nts-1")
    hub.start_session(1, st, st.streams[0], "relay")
    hub.on_stream_title(st.id, "Sault - Wildfires")  # arrives first: the feed isn't known yet
    hub.on_feed(st, FeedResult(False, reason="This is a show (Moxie)."))
    assert hub.now_playing(st, 1)["state"] == "identified"


def test_fingerprint_runs_only_when_nothing_names_the_track_and_is_rate_limited(app, clock, monkeypatch):
    st = dublab()
    calls = []
    monkeypatch.setattr(hub.deps, "fingerprint", lambda path: calls.append(path) or
                        {"status": "ok", "artist": "Saltmarsh", "title": "Static Bloom"})
    monkeypatch.setattr(hub.deps, "fingerprint_available", lambda: (True, ""))
    hub.start_session(1, st, st.streams[0], "relay")
    assert hub.wants_clip(st.id) is False          # too soon: let titles try first
    clock["now"] += 30
    assert hub.wants_clip(st.id) is True
    hub.submit_clip(st.id, b"\xff" * 1000, "audio/mpeg")
    assert len(calls) == 1
    np = hub.now_playing(st, 1)
    assert np["state"] == "identified" and np["source"] == "fingerprint"
    hub.on_stream_title(st.id, "Some Show")
    clock["now"] += 30
    assert hub.wants_clip(st.id) is False          # one per station every few minutes
    clock["now"] += 200
    assert hub.wants_clip(st.id) is True


def test_fingerprints_are_off_when_identification_is(app, config, clock, monkeypatch):
    monkeypatch.setattr(hub.deps, "fingerprint", lambda p: {"status": "no_match"})
    monkeypatch.setattr(hub.deps, "fingerprint_available", lambda: (True, ""))
    config.set("radio.identification", False)
    st = dublab()
    hub.start_session(1, st, st.streams[0], "relay")
    clock["now"] += 60
    assert hub.wants_clip(st.id) is False
    hub.on_stream_title(st.id, "A - B")
    assert hub.now_playing(st, 1)["state"] == "off"


def test_unavailable_when_no_feed_no_titles_and_no_fingerprint(app, clock):
    st = dublab()
    hub.start_session(1, st, st.streams[0], "relay")
    hub.stream_has_no_titles(st.id)
    np = hub.now_playing(st, 1)
    assert np["state"] == "unavailable"
    assert "no now-playing feed" in np["reason"] and "sends no track names" in np["reason"]


def test_a_long_unnamed_stretch_goes_into_heard(app, db, clock):
    st = dublab()
    hub.start_session(1, st, st.streams[0], "relay")
    hub.on_stream_title(st.id, "Live from the studio")
    clock["now"] += 8 * 60
    hub.on_stream_title(st.id, "Saltmarsh - Static Bloom")
    rows = store.list_heard(db, 1)
    assert [r["identified"] for r in rows] == [1, 0]
    assert rows[1]["duration_s"] == 480


# ── auto-add ─────────────────────────────────────────────────────────────────

def turn_on(db, pid=1, st=None):
    st = st or somafm()
    store.set_auto_add(db, pid, st.id, st.name, True)
    return st


def test_auto_add_adds_what_you_dont_have_once(app, db, library, clock):
    st = turn_on(db)
    hub.on_feed(st, FeedResult(True, artist="Tidewater", title="Night Ferry (Dub)"))
    assert [a["title"] for a in library.added] == ["Night Ferry (Dub)"]
    assert library.added[0]["auto"] is True
    rows = store.list_heard(db, 1)
    assert rows[0]["added_by_auto"] == 1
    # played again later the same day, and removed from Wanted meanwhile: never twice
    library.wanted.clear()
    hub.on_feed(st, FeedResult(True, artist="Other", title="Song"))
    clock["now"] += 3600
    hub.on_feed(st, FeedResult(True, artist="Tidewater", title="Night Ferry (Dub)"))
    assert [a["title"] for a in library.added] == ["Night Ferry (Dub)", "Song"]


def test_auto_add_skips_the_library_and_wanted(app, db, library, clock):
    st = turn_on(db)
    library.owned.add((1, "pale harbour", "harbour light"))
    library.wanted.add((1, "saltmarsh", "slack water"))
    hub.on_feed(st, FeedResult(True, artist="Pale Harbour", title="Harbour Light"))
    hub.on_feed(st, FeedResult(True, artist="Saltmarsh", title="Slack Water"))
    assert library.added == []


def test_auto_add_stops_at_the_daily_limit(app, db, config, library, clock):
    config.set("radio.daily_limit", 3)
    st = turn_on(db)
    for i in range(6):
        hub.on_feed(st, FeedResult(True, artist=f"Artist {i}", title=f"Song {i}"))
    assert len(library.added) == 3
    assert store.auto_added_since(db, 1, st.id, store.day_start(clock["now"])) == 3
    clock["now"] += 86400  # the next day starts over
    hub.on_feed(st, FeedResult(True, artist="Artist 9", title="Song 9"))
    assert len(library.added) == 4


def test_auto_add_needs_download_rights_at_add_time_too(app, db, library, who, clock):
    st = turn_on(db, pid=2)
    who["denied"] = "Downloads are disabled for this profile."
    hub.on_feed(st, FeedResult(True, artist="A", title="B"))
    assert library.added == []


def test_a_failed_add_gives_the_slot_back(app, db, library, clock):
    st = turn_on(db)
    library.fail_add = True
    hub.on_feed(st, FeedResult(True, artist="A", title="B"))
    assert not store.was_auto_added(db, 1, "a|b")
    library.fail_add = False
    hub.on_feed(st, FeedResult(True, artist="C", title="D"))
    hub.on_feed(st, FeedResult(True, artist="A", title="B"))
    assert [a["title"] for a in library.added] == ["D", "B"]


def test_auto_add_rolls_up_into_one_activity_item_per_station_per_hour(app, db, clock):
    st = turn_on(db)
    clock["now"] = clock["now"] - clock["now"] % 3600 + 60
    for i in range(3):
        hub.on_feed(st, FeedResult(True, artist=f"A{i}", title=f"T{i}"))
        clock["now"] += 60
    clock["now"] += 3600
    hub.on_feed(st, FeedResult(True, artist="Late", title="One"))
    out = activity_feed.build_feed(db, activity_feed.Viewer(profile_id=1), range_key="today", kind="radio",
                                   now=clock["now"])
    titles = [i["title"] for i in out["items"]]
    assert titles == ["Auto-add added 1 track from SomaFM · Drone Zone",
                      "Auto-add added 3 tracks from SomaFM · Drone Zone"]
    assert all(i["kind"] == "radio" for i in out["items"])
    assert out["counts"]["radio"] == 2
    # someone else's auto-add isn't in your Activity
    other = activity_feed.build_feed(db, activity_feed.Viewer(profile_id=2), range_key="today", kind="radio",
                                     now=clock["now"])
    assert other["items"] == []


# ── the radio trigger ────────────────────────────────────────────────────────

def test_the_trigger_fires_for_owners_who_dont_have_the_track(app, db, events, library, clock, monkeypatch):
    st = somafm()
    monkeypatch.setattr(hub.deps, "radio_automation_profiles", lambda: [1, 2])
    store.add_favourite(db, 1, st.id)
    library.owned.add((2, "a", "b"))
    hub.start_session(1, st, st.streams[0], "direct")
    hub.on_feed(st, FeedResult(True, artist="A", title="B"))
    (name, data), = events
    assert name == "radio_track_heard"
    assert data["station"] == st.name and data["artist"] == "A"
    assert data["_missing_for"] == [1] and data["_favourite_of"] == [1]


def test_no_trigger_without_radio_automations(app, events, clock):
    st = somafm()
    hub.start_session(1, st, st.streams[0], "direct")
    hub.on_feed(st, FeedResult(True, artist="A", title="B"))
    assert events == []


def test_the_engine_scopes_the_trigger_to_favourites_or_listed_stations():
    from core.automation_engine import AutomationEngine
    match = AutomationEngine._radio_scope_matches
    data = {"station_id": "kexp", "_missing_for": [1, 3], "_favourite_of": [1]}
    assert match({"profile_id": 1}, {}, data) is True
    assert match({"profile_id": 3}, {}, data) is False                      # not a favourite of 3
    assert match({"profile_id": 3}, {"stations": ["kexp"]}, data) is True   # listed explicitly
    assert match({"profile_id": 2}, {"stations": ["kexp"]}, data) is False  # 2 already has it


def test_watched_stations_need_auto_add_or_a_radio_automation(app, db, monkeypatch):
    assert hub.stations_to_poll() == []
    turn_on(db, st=builtin_station("kexp"))
    store.add_favourite(db, 5, "rp-main")
    assert [s.id for s in hub.stations_to_poll()] == ["kexp"]
    monkeypatch.setattr(hub.deps, "radio_automation_profiles", lambda: [5])
    assert [s.id for s in hub.stations_to_poll()] == ["kexp", "rp-main"]
    # a station without a feed is never polled (nothing to read without audio)
    turn_on(db, st=dublab())
    assert "dublab" not in [s.id for s in hub.stations_to_poll()]


# ── the watcher runs only while it has work ─────────────────────────────────

def test_the_watcher_only_starts_when_a_station_needs_watching(app, db, monkeypatch):
    from core.internet_radio import watcher as watcher_mod

    w = watcher_mod.Watcher(hub)
    started = []
    monkeypatch.setattr(w, "_start_locked", lambda: started.append(1))
    assert hub.has_work() is False
    assert w.ensure() is False and started == []
    turn_on(db, st=builtin_station("kexp"))
    assert hub.has_work() is True
    assert w.ensure() is True and started == [1]
    # turned off (module off): nothing restarts it until it's enabled again
    w.stop()
    assert w.ensure() is False and started == [1]
    w.enable()
    assert w.ensure() is True and started == [1, 1]


def test_a_listening_session_is_work(app):
    hub.start_session(1, somafm(), somafm().streams[0], "direct")
    assert hub.has_work() is True


def test_the_watcher_stops_itself_after_idling(app, monkeypatch):
    from core.internet_radio import watcher as watcher_mod

    monkeypatch.setattr(watcher_mod, "TICK_SECONDS", 0)
    monkeypatch.setattr(watcher_mod, "IDLE_STOP_SECONDS", 0)
    w = watcher_mod.Watcher(hub)
    monkeypatch.setattr(w, "tick", lambda: None)
    w.start()
    w._thread.join(timeout=5)
    assert not w.running() and w._thread is None
