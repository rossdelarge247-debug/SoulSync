"""Library → Listening history (board 13a, HANDOFF 64): the Music kind from
every source in the caller's pile, the format and length from the library
track, the source phrase's fields (server, player, Heard), ranges on the
browser's clock, day counts, the counts route, and Podcasts and Audiobooks
through GET /api/player/plays with a range.

Fixed clock: every range is measured from NOW, never the real time."""

from __future__ import annotations

import pytest
from flask import Flask, g

from core.playback import history, spoken

# 2026-10-23 14:30:00 UTC
NOW = 1792765800.0


@pytest.fixture(scope="module")
def world(tmp_path_factory):
    root = tmp_path_factory.mktemp("history")
    from database.music_database import MusicDatabase

    db = MusicDatabase(str(root / "music.db"))
    conn = db._get_connection()
    try:
        conn.execute("INSERT INTO artists (id, name) VALUES ('ar1', 'Saltmarsh')")
        conn.execute("INSERT INTO artists (id, name) VALUES ('ar2', 'Tidewater')")
        conn.execute("INSERT INTO albums (id, artist_id, title, thumb_url) VALUES ('al1', 'ar1', 'Lantern', "
                     "'https://img.example/lantern.jpg')")
        conn.execute("INSERT INTO albums (id, artist_id, title, explicit) VALUES ('al2', 'ar2', 'Night', 1)")
        conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, duration, file_path, bitrate, bit_depth, "
                     "sample_rate) VALUES ('11', 'al1', 'ar1', 'Static Bloom', 276000, '/m/a.flac', 2304, 24, 96000)")
        conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, duration, file_path, bitrate) "
                     "VALUES ('12', 'al2', 'ar2', 'Night Ferry (Dub)', 372000, '/m/b.mp3', 320)")
        rows = [
            # (title, artist, album, played_at, source, db_track_id, owner, player)
            ("Static Bloom", "Saltmarsh", "Lantern", "2026-10-23 14:02:00", "soulsync_web", 11, 1, None),
            ("Night Ferry (Dub)", "Tidewater", "Night", "2026-10-23 13:51:00", "soulsync_web", 12, 1, None),
            ("Glasshouse", "Marrow Field", "Glasshouse EP", "2026-10-23 11:20:00", "plex", None, 1, "Living room"),
            ("Blue in Green", "Miles Davis", "Kind of Blue", "2026-10-23 11:15:00", "soulsync_web", None, 1, None),
            ("Orchard Sodium", "The Quiet Rooms", "", "2026-10-22 21:40:00", "soulsync_web", 99, 1, None),
            ("Tide Tables", "Saltmarsh", "Lantern", "2026-10-22 22:14:00", "lastfm", 11, 1, None),
            ("Old one", "Saltmarsh", "Lantern", "2026-09-01 10:00:00", "soulsync_web", 11, 1, None),
            ("Someone else", "Kim", "Elsewhere", "2026-10-23 12:00:00", "soulsync_web", None, 5, None),
        ]
        for i, (title, artist, album, at, source, dbt, owner, player) in enumerate(rows):
            conn.execute(
                "INSERT INTO listening_history (track_id, title, artist, album, played_at, duration_ms, "
                "server_source, db_track_id, profile_id, player_name) VALUES (?, ?, ?, ?, ?, 300000, ?, ?, ?, ?)",
                (f"k{i}", title, artist, album, at, source, dbt, owner, player))
        conn.execute(
            "INSERT INTO radio_heard (profile_id, station_id, station_name, heard_at, artist, title, added_at) "
            "VALUES (1, 'fip-jazz', 'FIP Jazz', 1, 'Miles Davis', 'Blue in Green', 2)")
        # heard, but never added: no phrase
        conn.execute(
            "INSERT INTO radio_heard (profile_id, station_id, station_name, heard_at, artist, title) "
            "VALUES (1, 'nts-1', 'NTS 1', 1, 'Saltmarsh', 'Static Bloom')")
        conn.commit()
    finally:
        conn.close()
    for i, (kind, title, at) in enumerate([("podcast", "Episode 48", NOW - 3600), ("podcast", "Episode 47", NOW - 90000),
                                           ("audiobook", "Tide Lines", NOW - 86400 * 40)]):
        spoken.log_play(db, 1, {"kind": kind, "media_id": f"m{i}", "title": title, "subtitle": "Quiet Rooms"}, now=at)
    return db


def _page(world, **kw):
    kw.setdefault("now", NOW)
    return history.music_page(world, 1, **kw)


def test_ranges_start_where_the_browser_says():
    # BST: getTimezoneOffset is -60, so local midnight is 23:00 UTC the day before
    assert history.since_stamp("today", -60, NOW) == "2026-10-22 23:00:00"
    assert history.since_stamp("today", 0, NOW) == "2026-10-23 00:00:00"
    assert history.since_stamp("7d", 0, NOW) == "2026-10-16 14:30:00"
    assert history.since_stamp("all", 0, NOW) is None
    assert history.clean_range("forever") == "7d"
    assert history.clean_tz("-60") == -60 and history.clean_tz("x") == 0 and history.clean_tz(99999) == 840


def test_music_reads_every_source_in_the_pile(world):
    page = _page(world, range_key="7d")
    titles = [i["title"] for i in page["items"]]
    assert titles == ["Static Bloom", "Night Ferry (Dub)", "Glasshouse", "Blue in Green", "Tide Tables",
                      "Orchard Sodium"]
    assert page["total"] == 6 and page["shared_with"] == 0
    assert page["sources"][0] == "soulsync_web" and set(page["sources"]) == {"soulsync_web", "plex", "lastfm"}
    # another profile's own pile stays out
    assert "Someone else" not in titles


def test_whose_pile(world):
    kim = world.create_profile(name="kim-pile")
    try:
        assert _page(world, range_key="7d")["shared_with"] == 1
    finally:
        conn = world._get_connection()
        conn.execute("DELETE FROM profiles WHERE id = ?", (kim,))
        conn.commit()
        conn.close()


def test_format_length_and_quality_come_from_the_track(world, monkeypatch):
    from core.quality import presets
    from core.quality.model import QualityTarget

    monkeypatch.setattr(presets, "current_target", lambda db: {
        "name": "FLAC", "targets": [QualityTarget(label="FLAC", format="flac")]})
    items = {i["title"]: i for i in _page(world, range_key="7d")["items"]}
    bloom = items["Static Bloom"]
    assert bloom["format"] == "FLAC 24/96" and bloom["length_s"] == 276 and bloom["in_library"]
    assert bloom["artist_id"] == "ar1" and bloom["album_id"] == "al1" and bloom["track_id"] == "11"
    assert bloom["image_url"] == "https://img.example/lantern.jpg"
    ferry = items["Night Ferry (Dub)"]
    assert ferry["format"] == "MP3 320" and ferry["length_s"] == 372
    assert ferry["below_target"] is True and bloom["below_target"] is False


def test_source_fields(world):
    items = {i["title"]: i for i in _page(world, range_key="7d")["items"]}
    assert items["Glasshouse"]["server_source"] == "plex"
    assert items["Glasshouse"]["player_name"] == "Living room"
    assert items["Blue in Green"]["heard_on"] == "FIP Jazz"
    # heard but not added, and a play on Plex: no Heard phrase
    assert items["Static Bloom"]["heard_on"] is None
    assert items["Glasshouse"]["heard_on"] is None


def test_left_the_library_and_never_in_it(world):
    items = {i["title"]: i for i in _page(world, range_key="7d")["items"]}
    gone = items["Orchard Sodium"]
    assert gone["in_library"] is False and gone["was_in_library"] is True and gone["track_id"] is None
    assert gone["format"] is None and gone["length_s"] == 300
    never = items["Glasshouse"]
    assert never["in_library"] is False and never["was_in_library"] is False


def test_days_are_counted_whole_on_the_browsers_clock(world):
    page = _page(world, range_key="7d", limit=2)
    assert [i["title"] for i in page["items"]] == ["Static Bloom", "Night Ferry (Dub)"]
    assert page["days"] == {"2026-10-23": 4}
    # in UTC+10 the 22nd's evening is the 23rd and 14:02 is past midnight
    page = _page(world, range_key="7d", tz=-600)
    assert page["days"] == {"2026-10-24": 1, "2026-10-23": 5}


def test_filter_today_paging_and_explicit(world):
    assert [i["title"] for i in _page(world, range_key="7d", q="lantern")["items"]] == [
        "Static Bloom", "Tide Tables"]
    assert _page(world, range_key="today")["total"] == 4
    assert _page(world, range_key="all")["total"] == 7
    second = _page(world, range_key="7d", offset=4, limit=50)
    assert [i["title"] for i in second["items"]] == ["Tide Tables", "Orchard Sodium"]
    hidden = _page(world, range_key="7d", hide_explicit=True)
    assert "Night Ferry (Dub)" not in [i["title"] for i in hidden["items"]] and hidden["total"] == 5


def test_counts_per_kind_and_range(world):
    counts = history.counts(world, 1, now=NOW)
    assert counts["music"] == {"today": 4, "7d": 6, "30d": 6, "all": 7}
    assert counts["podcast"] == {"today": 1, "7d": 2, "30d": 2, "all": 2}
    assert counts["audiobook"] == {"today": 0, "7d": 0, "30d": 0, "all": 1}
    assert history.counts(world, 1, now=NOW, hide_explicit=True)["music"]["7d"] == 5


def test_spoken_page(world):
    page = spoken.plays_page(world, 1, ["podcast"], since=history.since_stamp("7d", 0, NOW), with_total=True)
    assert [i["title"] for i in page["items"]] == ["Episode 48", "Episode 47"]
    assert page["total"] == 2 and sum(page["days"].values()) == 2
    assert spoken.plays_page(world, 1, ["podcast"], q="48", with_total=True)["total"] == 1
    # Recent's shape is unchanged
    assert "day" not in spoken.recent_plays(world, 1, ["podcast"])[0]


@pytest.fixture
def client(world, monkeypatch):
    import api.player as player_api
    import core.content_filter as cf
    from core.library_scope import reset_library_scope, set_library_scope

    player_api.configure(get_database_=lambda: world, image_url_=lambda u: u)
    state = {"profile": 1, "hide": False}
    monkeypatch.setattr(cf, "current_restrictions", lambda: {"hide_explicit": state["hide"], "cap": None})
    monkeypatch.setattr(history.time, "time", lambda: NOW)
    app = Flask(__name__)
    tokens = []

    @app.before_request
    def _profile():
        g.profile_id = state["profile"]
        tokens.append(set_library_scope("shared"))

    @app.teardown_request
    def _scope(_exc):
        if tokens:
            reset_library_scope(tokens.pop())

    app.register_blueprint(player_api.create_blueprint())
    c = app.test_client()
    c.state = state
    return c


def test_routes(client):
    body = client.get("/api/library/listening-history?range=7d&tz=0&limit=3").get_json()
    assert body["success"] and body["total"] == 6 and len(body["items"]) == 3
    counts = client.get("/api/library/listening-history/counts?tz=0").get_json()["counts"]
    assert counts["music"]["7d"] == 6 and counts["podcast"]["all"] == 2
    plays = client.get("/api/player/plays?kind=podcast&range=7d&tz=0").get_json()
    assert plays["total"] == 2 and plays["range"] == "7d"
    # without a range, the old answer
    old = client.get("/api/player/plays?kind=podcast").get_json()
    assert "total" not in old and len(old["items"]) == 2
    client.state["hide"] = True
    assert client.get("/api/library/listening-history?range=7d").get_json()["total"] == 5


def test_routes_need_a_profile(client):
    client.state["profile"] = None
    assert client.get("/api/library/listening-history").status_code == 401
    assert client.get("/api/library/listening-history/counts").status_code == 401


def test_player_name_is_kept_from_the_server(world):
    from core.listening_import.dedup import insert_import_events

    insert_import_events(world, [{"track_id": "p1", "title": "Harbour", "artist": "Pale", "album": "L",
                                  "played_at": "2026-10-20 10:00:00", "player_name": "  Kitchen  "}],
                         "plex", profile_id=1)
    conn = world._get_connection()
    try:
        row = conn.execute("SELECT player_name FROM listening_history WHERE track_id = 'p1'").fetchone()
    finally:
        conn.close()
    assert row[0] == "Kitchen"


def test_plex_history_names_the_player(monkeypatch):
    from types import SimpleNamespace

    from core.plex_client import PlexClient

    client = PlexClient.__new__(PlexClient)
    item = SimpleNamespace(type="track", title="Glasshouse", grandparentTitle="Marrow Field",
                           parentTitle="Glasshouse EP", viewedAt=None, duration=1, ratingKey=7, accountID=1,
                           deviceID=3)
    client.server = SimpleNamespace(history=lambda **kw: [item],
                                    systemDevices=lambda: [SimpleNamespace(id=3, name="Living room")])
    client.music_library = None
    monkeypatch.setattr(PlexClient, "ensure_connection", lambda self: True)
    [entry] = client.get_play_history()
    assert entry["player_name"] == "Living room"
    client.server.systemDevices = lambda: (_ for _ in ()).throw(RuntimeError("no"))
    assert client.get_play_history()[0]["player_name"] is None
