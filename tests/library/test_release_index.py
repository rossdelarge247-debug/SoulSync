"""The library's release index (core/library/release_index.py): Library →
Albums, Genres and Artists (boards 7a–7g). Your albums with their state, your
artists' albums you don't have from the metadata cache, Wanted grouped by
album, genres (an album with several counts in each), the facets the toolbar
shows and what a selection means."""

from __future__ import annotations

import json

import pytest

from core.library import release_index as ri
from core.quality import presets


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _album(db, album_id, artist_id, title, *, files=(), year=2020, genres=None, expected=None, owner=None,
           server=None, created="2026-01-01 00:00:00", spotify=None, record_type=None):
    _sql(db, "INSERT INTO albums (id, artist_id, title, year, genres, api_track_count, owner_profile_id, "
             "server_source, created_at, spotify_album_id, record_type) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
         (album_id, artist_id, title, year, json.dumps(genres) if genres is not None else None, expected, owner,
          server, created, spotify, record_type))
    for i, (path, kbps) in enumerate(files):
        _sql(db, "INSERT INTO tracks (album_id, artist_id, title, file_path, bitrate, owner_profile_id, server_source, "
                 "play_count) VALUES (?,?,?,?,?,?,?,?)",
             (album_id, artist_id, f"{title} {i + 1}", path, kbps, owner, server, i))


def _cached(db, entity_id, title, artist_name, *, source="spotify", artist_id=None, album_type="album", tracks=10,
            genres=None, date="2024-05-01"):
    _sql(db, "INSERT INTO metadata_cache_entities (source, entity_type, entity_id, name, artist_name, artist_id, "
             "album_type, total_tracks, genres, release_date, raw_json) VALUES (?, 'album', ?, ?, ?, ?, ?, ?, ?, ?, '{}')",
         (source, entity_id, title, artist_name, artist_id, album_type, tracks,
          json.dumps(genres) if genres else None, date))


def _wanted(db, track_id, album_title, artist, *, profile=1, tries=0, album_type="album", album_id="w1"):
    data = {"id": track_id, "name": track_id, "artists": [{"name": artist}],
            "album": {"id": album_id, "name": album_title, "album_type": album_type, "artists": [{"name": artist}],
                      "total_tracks": 8, "release_date": "2025-02-02"}, "_source": "spotify"}
    _sql(db, "INSERT INTO wishlist_tracks (spotify_track_id, spotify_data, retry_count, profile_id, source_type) "
             "VALUES (?,?,?,?, 'album')", (track_id, json.dumps(data), tries, profile))


FLAC = [("/m/a.flac", 900)] * 1


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase
    presets.clear_cache()
    ri.clear_cache()
    database = MusicDatabase(database_path=str(tmp_path / "release-index.db"))
    _sql(database, "UPDATE quality_profiles SET ranked_targets = ?, upgrade_policy = 'acceptable' WHERE is_default = 1",
         (json.dumps([{"label": "FLAC 16-bit", "format": "flac", "bit_depth": 16}]),))
    _sql(database, "INSERT INTO artists (id, name, genres, spotify_artist_id) VALUES (1, 'Pale Harbour', ?, 'sp-ph')",
         (json.dumps(["Ambient", "Electronic"]),))
    _sql(database, "INSERT INTO artists (id, name, genres) VALUES (2, 'Saltmarsh', ?)", (json.dumps(["Folk"]),))
    _sql(database, "INSERT INTO artists (id, name, genres) VALUES (3, 'Vera Lund', NULL)")
    return database


def _flac(n):
    return [(f"/m/{i}.flac", 900) for i in range(n)]


def _mp3(n):
    return [(f"/m/{i}.mp3", 320) for i in range(n)]


def _by_title(index):
    return {r["title"]: r for r in index.releases}


# ── states ────────────────────────────────────────────────────────────────────

def test_owned_partial_below_and_missing(db):
    _album(db, 10, 1, "Night Ferry", files=_flac(12), expected=12)
    _album(db, 11, 1, "Tidewater", files=_flac(11), expected=12)
    _album(db, 12, 1, "Low Light", files=_mp3(9) + _flac(1))
    _cached(db, "x1", "Lantern", "Pale Harbour", artist_id="sp-ph", tracks=11)
    index = ri.build_index(db, 1)
    rel = _by_title(index)
    assert rel["Night Ferry"]["state"] == "owned" and rel["Night Ferry"]["format"] == "FLAC"
    assert rel["Tidewater"]["state"] == "partial"
    assert (rel["Tidewater"]["tracks_owned"], rel["Tidewater"]["tracks_total"]) == (11, 12)
    assert rel["Low Light"]["state"] == "below_target" and rel["Low Light"]["below_target"] == 9
    assert rel["Low Light"]["format"] == "MP3 320"
    assert rel["Lantern"]["kind"] == "missing" and rel["Lantern"]["state"] == "missing"
    assert rel["Lantern"]["tracks_total"] == 11 and rel["Lantern"]["year"] == 2024
    assert rel["Lantern"]["id"] == "release:spotify:x1"
    assert rel["Night Ferry"]["id"] == "album:10"


def test_an_album_row_with_no_file_is_not_yours(db):
    _album(db, 10, 1, "Night Ferry")
    assert ri.build_index(db, 1).releases == []


def test_a_cached_edition_of_an_album_you_have_is_not_missing(db):
    _album(db, 10, 1, "Night Ferry", files=_flac(10))
    _cached(db, "x1", "Night Ferry (Deluxe Edition)", "Pale Harbour", artist_id="sp-ph")
    _cached(db, "x2", "Night Ferry - Remastered 2011", "Pale Harbour", artist_id="sp-ph")
    assert [r["title"] for r in ri.build_index(db, 1).releases] == ["Night Ferry"]


def test_singles_compilations_and_other_artists_are_left_out(db):
    _album(db, 10, 1, "Night Ferry", files=_flac(10))
    _cached(db, "s1", "A Single", "Pale Harbour", artist_id="sp-ph", album_type="single")
    _cached(db, "c1", "Hits", "Pale Harbour", artist_id="sp-ph", album_type="compilation")
    _cached(db, "o1", "Elsewhere", "Somebody Else")
    _cached(db, "e1", "An EP", "Pale Harbour", artist_id="sp-ph", album_type="ep")
    titles = {r["title"]: r["album_type"] for r in ri.build_index(db, 1).releases}
    assert titles == {"Night Ferry": "album", "An EP": "ep"}


def test_a_namesake_on_a_source_the_library_matched_is_not_your_artist(db):
    # the library knows Pale Harbour on Spotify as sp-ph: another Spotify
    # artist with the same name isn't them; a source without an id matches by name
    _album(db, 10, 1, "Night Ferry", files=_flac(10))
    _cached(db, "n1", "Not Theirs", "Pale Harbour", artist_id="sp-other")
    _cached(db, "d1", "On Deezer", "pale harbour", source="deezer", artist_id="dz-1")
    titles = [r["title"] for r in ri.build_index(db, 1).releases]
    assert "Not Theirs" not in titles and "On Deezer" in titles


def test_one_release_listed_by_two_sources_appears_once(db):
    _album(db, 10, 1, "Night Ferry", files=_flac(10))
    _cached(db, "d1", "Lantern", "Pale Harbour", source="deezer", artist_id=None)
    _cached(db, "s1", "Lantern", "Pale Harbour", source="spotify", artist_id="sp-ph")
    lanterns = [r for r in ri.build_index(db, 1).releases if r["title"] == "Lantern"]
    assert len(lanterns) == 1 and lanterns[0]["source"] == "spotify"


def test_scope_and_media_server(db):
    _album(db, 10, 1, "Mine", files=_flac(3), server="plex")
    _album(db, 11, 1, "Jellyfin's", files=_flac(3), server="jellyfin")
    _album(db, 12, 1, "Someone else's", files=_flac(3), server="plex", owner=5)
    _sql(db, "UPDATE artists SET server_source = 'plex'")
    assert [r["title"] for r in ri.build_index(db, 1, server="plex").releases] == ["Mine"]


# ── Wanted ────────────────────────────────────────────────────────────────────

def test_wanted_marks_missing_and_partial_releases(db):
    _album(db, 11, 1, "Tidewater", files=_flac(11), expected=12)
    _cached(db, "x1", "Lantern", "Pale Harbour", artist_id="sp-ph")
    _wanted(db, "t1", "Lantern", "Pale Harbour", tries=1)
    _wanted(db, "t2", "Lantern", "Pale Harbour", tries=4)
    _wanted(db, "t3", "Tidewater", "Pale Harbour", tries=0)
    rel = _by_title(ri.build_index(db, 1))
    assert rel["Lantern"]["wanted"] == {"status": "not_found", "tracks": 2}
    assert rel["Tidewater"]["wanted"] == {"status": "searching", "tracks": 1}


def test_wanted_is_per_profile(db):
    _cached(db, "x1", "Lantern", "Pale Harbour", artist_id="sp-ph")
    _wanted(db, "t1", "Lantern", "Pale Harbour", profile=2)
    assert _by_title(ri.build_index(db, 1))["Lantern"]["wanted"] is None
    assert _by_title(ri.build_index(db, 2))["Lantern"]["wanted"]["status"] == "searching"


def test_an_album_only_wanted_still_shows(db):
    _wanted(db, "t1", "Open Water", "Vera Lund", album_id="ow")
    _wanted(db, "t2", "A Single", "Vera Lund", album_type="single", album_id="sg")
    _wanted(db, "t3", "Not Ours", "Stranger", album_id="no")
    rel = _by_title(ri.build_index(db, 1))
    assert set(rel) == {"Open Water"}
    assert rel["Open Water"]["kind"] == "missing" and rel["Open Water"]["wanted"]["tracks"] == 1
    assert rel["Open Water"]["id"] == "wanted:spotify:ow"


# ── genres ────────────────────────────────────────────────────────────────────

def test_genres_come_from_the_album_then_the_artist(db):
    _album(db, 10, 1, "Tagged", files=_flac(2), genres=["Dub"])
    _album(db, 11, 1, "Untagged", files=_flac(2))
    _cached(db, "x1", "Listed", "Pale Harbour", artist_id="sp-ph", genres=["Techno"])
    _cached(db, "x2", "Bare", "Pale Harbour", artist_id="sp-ph")
    rel = _by_title(ri.build_index(db, 1))
    assert rel["Tagged"]["genres"] == ["Dub"]
    assert rel["Untagged"]["genres"] == ["Ambient", "Electronic"]
    assert rel["Listed"]["genres"] == ["Techno"]
    assert rel["Bare"]["genres"] == ["Ambient", "Electronic"]


def test_legacy_comma_genres_and_casing_fold(db):
    _sql(db, "INSERT INTO albums (id, artist_id, title, genres) VALUES (10, 3, 'Old', 'ambient, Drone')")
    _sql(db, "INSERT INTO tracks (album_id, artist_id, title, file_path) VALUES (10, 3, 'x', '/m/x.flac')")
    _album(db, 11, 3, "New", files=_flac(1), genres=["Ambient"])
    page = ri.album_page(ri.build_index(db, 1))
    assert {g["name"]: g["count"] for g in page["genres"]} == {"Ambient": 2, "Drone": 1}


def test_an_album_with_several_genres_counts_in_each(db):
    _album(db, 10, 1, "Both", files=_flac(2), genres=["Ambient", "Jazz"])
    _album(db, 11, 2, "One", files=_flac(2), genres=["Jazz"])
    page = ri.album_page(ri.build_index(db, 1))
    assert {g["name"]: g["count"] for g in page["genres"]} == {"Jazz": 2, "Ambient": 1}
    assert page["totals"]["genres"] == 2


# ── the albums page ───────────────────────────────────────────────────────────

@pytest.fixture
def library(db):
    _album(db, 10, 1, "Night Ferry", files=_flac(12), genres=["Ambient"], year=2023, created="2026-01-03")
    _album(db, 11, 1, "Tidewater", files=_flac(11), expected=12, genres=["Ambient"], year=2026, created="2026-01-05")
    _album(db, 12, 2, "Low Light", files=_mp3(9), genres=["Folk"], year=2021, created="2026-01-04")
    _album(db, 13, 3, "Salt Flats", files=_flac(10), genres=["Jazz", "Ambient"], year=2024, created="2026-01-01")
    _cached(db, "x1", "Lantern", "Pale Harbour", artist_id="sp-ph", genres=["Ambient"], tracks=11, date="2025")
    _cached(db, "x2", "Weather Systems", "Saltmarsh", genres=["Folk"], tracks=9, date="2020")
    _wanted(db, "t1", "Lantern", "Pale Harbour")
    return db


def test_show_counts_genre_counts_and_totals(library):
    page = ri.album_page(ri.build_index(library, 1))
    assert page["show_counts"] == {"all": 6, "library": 4, "missing": 2, "below": 1}
    assert page["totals"]["albums"] == 6 and page["totals"]["tracks"] == 42 and page["totals"]["missing"] == 2
    assert [g["name"] for g in page["genres"]][:1] == ["Ambient"]
    # genre + show combine, and each one's counts follow the other
    page = ri.album_page(ri.build_index(library, 1), show="missing", genre="ambient")
    assert [r["title"] for r in page["releases"]] == ["Lantern"]
    assert page["show_counts"] == {"all": 4, "library": 3, "missing": 1, "below": 0}
    assert {g["name"]: g["count"] for g in page["genres"]} == {"Ambient": 1, "Folk": 1}
    assert page["genre_total"] == 2


def test_the_genre_summary_line(library):
    page = ri.album_page(ri.build_index(library, 1), genre="Ambient")
    summary = page["genre_summary"]
    assert (summary["name"], summary["albums"], summary["library"], summary["missing"], summary["below"]) == (
        "Ambient", 4, 3, 1, 0)
    # Lantern, the one Ambient album you don't have, is on Wanted already;
    # Tidewater (short a track) is picked by hand, not by the genre's button
    assert summary["wantable"]["count"] == 0


def test_sorts(library):
    index = ri.build_index(library, 1)
    titles = lambda sort: [r["title"] for r in ri.album_page(index, sort=sort, show="library")["releases"]]  # noqa: E731
    assert titles("recent") == ["Tidewater", "Low Light", "Night Ferry", "Salt Flats"]
    assert titles("title") == ["Low Light", "Night Ferry", "Salt Flats", "Tidewater"]
    assert titles("year") == ["Tidewater", "Salt Flats", "Night Ferry", "Low Light"]
    assert titles("artist") == ["Tidewater", "Night Ferry", "Low Light", "Salt Flats"]
    grouped = ri.album_page(index, sort="genre", show="library")["releases"]
    assert [(r["group"], r["title"]) for r in grouped] == [
        ("Ambient", "Night Ferry"), ("Ambient", "Tidewater"), ("Folk", "Low Light"), ("Jazz", "Salt Flats")]


def test_filter_text_matches_title_artist_or_genre(library):
    index = ri.build_index(library, 1)
    assert [r["title"] for r in ri.album_page(index, q="ferry")["releases"]] == ["Night Ferry"]
    assert {r["title"] for r in ri.album_page(index, q="saltmarsh")["releases"]} == {"Low Light", "Weather Systems"}
    assert {r["title"] for r in ri.album_page(index, q="jazz")["releases"]} == {"Salt Flats"}


def test_paging(library):
    index = ri.build_index(library, 1)
    first = ri.album_page(index, limit=4)
    second = ri.album_page(index, limit=4, page=2)
    assert first["has_more"] and not second["has_more"]
    assert len(first["releases"]) == 4 and len(second["releases"]) == 2
    assert not {r["id"] for r in first["releases"]} & {r["id"] for r in second["releases"]}


def test_unknown_params_fall_back(library):
    page = ri.album_page(ri.build_index(library, 1), show="nope", sort="DROP TABLE", page="x", limit="9999")
    assert (page["show"], page["sort"], page["page"], page["limit"]) == ("all", "recent", 1, 200)


def test_the_missing_summary_follows_the_view(library):
    index = ri.build_index(library, 1)
    summary = ri.album_page(index, show="missing")["missing_summary"]
    # Lantern is already wanted: only Weather Systems is there to add
    assert summary["count"] == 1 and summary["tracks"] == 9
    assert summary["artists"] == [{"id": "2", "name": "Saltmarsh"}]


# ── genres tab ────────────────────────────────────────────────────────────────

def test_genre_tiles(library):
    body = ri.genre_tiles(ri.build_index(library, 1))
    tiles = {t["name"]: t for t in body["genres"]}
    assert [t["name"] for t in body["genres"]][0] == "Ambient"
    amb = tiles["Ambient"]
    assert (amb["albums"], amb["library"], amb["missing"], amb["below"]) == (4, 3, 1, 0)
    # Ambient's one missing album is on Wanted: nothing to add from the tile
    assert amb["wantable"] == 0 and tiles["Folk"]["wantable"] == 1
    assert tiles["Folk"]["below"] == 1 and tiles["Jazz"]["missing"] == 0
    assert body["show_counts"] == {"all": 3, "gaps": 2}
    gaps = ri.genre_tiles(ri.build_index(library, 1), show="gaps", sort="name")
    assert [t["name"] for t in gaps["genres"]] == ["Ambient", "Folk"]


def test_genre_mosaic_is_the_most_played_covers(db):
    for i in range(6):
        _album(db, 20 + i, 1, f"A{i}", files=_flac(i + 1), genres=["Dub"])
        _sql(db, "UPDATE albums SET thumb_url = ? WHERE id = ?", (f"https://art/{i}.jpg", 20 + i))
    tile = ri.genre_tiles(ri.build_index(db, 1))["genres"][0]
    # play counts are 0..n-1 per track, so the album with most tracks played most
    assert tile["covers"] == ["https://art/5.jpg", "https://art/4.jpg", "https://art/3.jpg", "https://art/2.jpg"]


# ── artists ───────────────────────────────────────────────────────────────────

def test_artist_counts_following_and_filters(library):
    _sql(library, "INSERT INTO watchlist_artists (spotify_artist_id, artist_name, profile_id) VALUES ('sp-ph', 'Pale Harbour', 1)")
    index = ri.build_index(library, 1)
    page = ri.artist_page(index)
    artists = {a["name"]: a for a in page["artists"]}
    assert [a["name"] for a in page["artists"]] == ["Pale Harbour", "Saltmarsh", "Vera Lund"]
    ph = artists["Pale Harbour"]
    assert (ph["releases"], ph["in_library"], ph["missing"], ph["wanted"], ph["following"]) == (3, 2, 1, 1, True)
    assert artists["Saltmarsh"]["wantable"] == 1
    assert page["show_counts"] == {"all": 3, "following": 1, "incomplete": 2}
    assert page["genre_total"] == 3
    assert [a["name"] for a in ri.artist_page(index, show="incomplete", sort="missing")["artists"]] == [
        "Pale Harbour", "Saltmarsh"]
    assert [a["name"] for a in ri.artist_page(index, genre="folk")["artists"]] == ["Saltmarsh"]
    assert [a["name"] for a in ri.artist_page(index, q="ambient")["artists"]] == ["Pale Harbour"]
    assert {g["name"]: g["count"] for g in page["genres"]} == {"Ambient": 1, "Electronic": 1, "Folk": 1}
    # following is per profile
    assert not {a["name"]: a for a in ri.artist_page(ri.build_index(library, 2))["artists"]}["Pale Harbour"]["following"]


def test_artists_with_the_same_name_fold_into_one(db):
    _sql(db, "INSERT INTO artists (id, name) VALUES (9, 'Pale Harbour')")
    _album(db, 10, 1, "One", files=_flac(1))
    _album(db, 11, 9, "Two", files=_flac(1))
    page = ri.artist_page(ri.build_index(db, 1))
    ph = [a for a in page["artists"] if a["name"] == "Pale Harbour"]
    assert len(ph) == 1 and ph[0]["id"] == "1" and ph[0]["in_library"] == 2


# ── selections ────────────────────────────────────────────────────────────────

def test_a_filter_selects_what_there_is_to_add(library):
    index = ri.build_index(library, 1)
    chosen, unknown = ri.resolve_selection(index, {"filter": {"show": "all", "genre": "Folk"}})
    assert [r["title"] for r in chosen] == ["Weather Systems"] and unknown == []
    # an album you have part of is picked by hand, never by a filter
    chosen, _ = ri.resolve_selection(index, {"filter": {"show": "all", "genre": "Ambient"}})
    assert chosen == []
    chosen, _ = ri.resolve_selection(index, {"filter": {"show": "missing"}, "exclude_ids": ["release:spotify:x2"],
                                             "release_ids": ["album:10", "nope"]})
    assert [r["title"] for r in chosen] == ["Night Ferry"]
    chosen, unknown = ri.resolve_selection(index, {"release_ids": ["album:10", "nope"]})
    assert unknown == ["nope"]
    chosen, _ = ri.resolve_selection(index, {"filter": {"artist_ids": ["2"]}})
    assert [r["title"] for r in chosen] == ["Weather Systems"]
    chosen, _ = ri.resolve_selection(index, {"filter": {"genres": ["folk", "jazz"]}})
    assert [r["title"] for r in chosen] == ["Weather Systems"]


def test_selection_summary(library):
    index = ri.build_index(library, 1)
    chosen, _ = ri.resolve_selection(index, {"release_ids": ["album:10", "album:11", "release:spotify:x1",
                                                             "release:spotify:x2"]})
    summary = ri.selection_summary(index, chosen)
    assert (summary["selected"], summary["count"], summary["tracks"]) == (4, 2, 10)
    assert (summary["already_have"], summary["already_wanted"]) == (1, 1)
    assert summary["types"] == {"album": 2}
    assert summary["target"]["name"] == "FLAC or better"


# ── the cache ─────────────────────────────────────────────────────────────────

def test_the_build_is_cached_briefly_and_cleared(db, monkeypatch):
    _album(db, 10, 1, "Night Ferry", files=_flac(2))
    first = ri.get_index(db, 1, server=None)
    assert ri.get_index(db, 1, server=None) is first
    assert ri.get_index(db, 2, server=None) is not first
    ri.clear_cache()
    assert ri.get_index(db, 1, server=None) is not first


def test_norm_title():
    assert ri.norm_title("Night Ferry (Deluxe Edition)") == ri.norm_title("night ferry")
    assert ri.norm_title("Low Light - EP") == "low light"
    assert ri.norm_title("(Untitled)") == "untitled"
    assert ri.norm_title("Ágætis byrjun") == "ágætis byrjun"


def test_concurrent_requests_share_one_build(db, monkeypatch):
    import threading
    import time as _time

    _album(db, 10, 1, "Night Ferry", files=_flac(2))
    builds = []
    real = ri.build_index

    def slow_build(*args, **kwargs):
        builds.append(1)
        _time.sleep(0.2)
        return real(*args, **kwargs)

    monkeypatch.setattr(ri, "build_index", slow_build)
    got = []
    threads = [threading.Thread(target=lambda: got.append(ri.get_index(db, 1, server=None))) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(builds) == 1 and len({id(i) for i in got}) == 1
