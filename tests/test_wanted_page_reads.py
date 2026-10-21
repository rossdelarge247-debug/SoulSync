"""The two read-only additions behind the Wanted page (ux/wanted-page).

* ``GET /api/wishlist/found`` — "Found this week": the wishlist removal audit
  joined to the library history on the published path.
* ``GET /api/watchlist/artists/summary`` — per followed artist: releases in the
  library, the latest cached release, the last release a check found, and
  whether that was this week.

Pinned here: what counts as found (download reasons only, inside the window,
one row per track), the per-artist numbers, profile scoping for both, and that
neither is admin-only (they are a profile's own lists, like the routes beside
them).
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta

import pytest

from core.watchlist.summary import followed_artist_summary
from core.wishlist.found import clamp_days, recently_found
from database.music_database import MusicDatabase


# ── recently_found ───────────────────────────────────────────────────────────

@pytest.fixture()
def mdb(tmp_path):
    return MusicDatabase(str(tmp_path / "music.db"))


def _removal(conn, track_id, *, reason="download_complete", path=None, profiles=None,
             age="-1 hours", rows=1):
    conn.execute(
        "INSERT INTO wishlist_removals (spotify_track_id, profile_ids, rows_removed, reason,"
        " final_path, removed_at) VALUES (?, ?, ?, ?, ?, datetime('now', ?))",
        (track_id, json.dumps(profiles) if profiles is not None else None, rows, reason,
         path, age))


def _history(conn, path, title, artist="Saltmarsh", album="Lantern", quality="FLAC 16bit",
             thumb="https://cdn.example/cover.jpg"):
    conn.execute(
        "INSERT INTO library_history (event_type, title, artist_name, album_name, quality,"
        " file_path, thumb_url) VALUES ('download', ?, ?, ?, ?, ?, ?)",
        (title, artist, album, quality, path, thumb))


def test_found_lists_downloads_in_the_window_newest_first(mdb):
    conn = mdb._get_connection()
    _history(conn, "/music/Saltmarsh/Lantern/03 Static Bloom.flac", "Static Bloom")
    _history(conn, "/music/Pale Harbour/Tidewater/01 Harbour Light.flac", "Harbour Light",
             artist="Pale Harbour", album="Tidewater")
    _removal(conn, "t-old-but-in", path="/music/Pale Harbour/Tidewater/01 Harbour Light.flac",
             age="-3 days")
    _removal(conn, "t-new", path="/music/Saltmarsh/Lantern/03 Static Bloom.flac", age="-2 hours")
    _removal(conn, "t-outside", path="/music/x.flac", age="-9 days")
    _removal(conn, "t-owned", reason="already_owned", path="/music/y.flac")
    _removal(conn, "t-manual", reason="manual_match", path="/music/z.flac")
    conn.commit()
    conn.close()

    items = recently_found(mdb, 1, days=7)
    assert [i["id"] for i in items] == ["t-new", "t-old-but-in"]
    top = items[0]
    assert (top["title"], top["artist"], top["album"], top["quality"]) == (
        "Static Bloom", "Saltmarsh", "Lantern", "FLAC 16bit")
    assert top["image"] == "https://cdn.example/cover.jpg"
    assert top["found_at"].endswith("Z")
    assert top["reason"] == "download_complete"


def test_found_counts_the_atomic_album_publish_too(mdb):
    conn = mdb._get_connection()
    _removal(conn, "t-album", reason="atomic_published", path="/music/A/B/01 Song.flac")
    conn.commit()
    conn.close()
    items = recently_found(mdb, 1)
    assert [i["id"] for i in items] == ["t-album"]
    # no library history row: the title falls back to the file name
    assert items[0]["title"] == "01 Song"
    assert items[0]["artist"] == ""


def test_found_lists_a_track_once_at_its_latest_find(mdb):
    conn = mdb._get_connection()
    _removal(conn, "t1", path="/music/a.flac", age="-2 days")
    _removal(conn, "t1", reason="atomic_published", path="/music/a.flac", age="-1 hours")
    conn.commit()
    conn.close()
    items = recently_found(mdb, 1)
    assert len(items) == 1 and items[0]["reason"] == "atomic_published"


def test_found_is_scoped_to_the_profiles_whose_library_holds_the_file(mdb):
    conn = mdb._get_connection()
    _removal(conn, "mine", path="/music/mine.flac", profiles=[1])
    _removal(conn, "theirs", path="/music/theirs.flac", profiles=[2])
    _removal(conn, "shared", path="/music/shared.flac", profiles=[1, 2])
    _removal(conn, "sweep", path="/music/sweep.flac", profiles=None)
    conn.commit()
    conn.close()
    assert {i["id"] for i in recently_found(mdb, 1)} == {"mine", "shared", "sweep"}
    assert {i["id"] for i in recently_found(mdb, 2)} == {"theirs", "shared", "sweep"}


def test_found_window_is_clamped():
    assert clamp_days(None) == 7
    assert clamp_days("abc") == 7
    assert clamp_days(0) == 1
    assert clamp_days(400) == 30
    assert clamp_days("3") == 3


# ── followed_artist_summary ──────────────────────────────────────────────────

def _artist(conn, name, profile_id=1, sp=None):
    cur = conn.execute(
        "INSERT INTO watchlist_artists (spotify_artist_id, artist_name, profile_id) VALUES (?, ?, ?)",
        (sp or f"sp-{name}-{profile_id}", name, profile_id))
    return cur.lastrowid


def _library_album(conn, artist_name, title, server="plex", artist_id=None):
    artist_id = artist_id or f"ar-{artist_name}-{server}"
    conn.execute("INSERT OR IGNORE INTO artists (id, name, server_source) VALUES (?, ?, ?)",
                 (artist_id, artist_name, server))
    conn.execute("INSERT INTO albums (id, artist_id, title, server_source) VALUES (?, ?, ?, ?)",
                 (f"al-{artist_name}-{title}-{server}", artist_id, title, server))


def _scan_run(db, run_id, completed, events, profile_id=1):
    assert db.save_watchlist_scan_run(run_id, profile_id=profile_id, completed_at=completed,
                                      track_events=events)


def _event(artist, album, status="added", track="t"):
    return {"track_name": track, "artist_name": artist, "album_name": album,
            "album_image_url": "", "status": status}


def test_summary_counts_library_releases_by_name_on_the_active_server(mdb):
    conn = mdb._get_connection()
    sm = _artist(conn, "Saltmarsh")
    nobody = _artist(conn, "Marrow & Pine")
    _library_album(conn, "saltmarsh ", "Lantern")
    _library_album(conn, "Saltmarsh", "Ferry Songs")
    _library_album(conn, "Saltmarsh", "Other Server Album", server="jellyfin")
    conn.commit()
    conn.close()

    by_id = {a["id"]: a for a in followed_artist_summary(mdb, 1, active_server="plex")}
    assert by_id[sm]["library_releases"] == 2
    assert by_id[nobody]["library_releases"] == 0
    # with no active server every server's albums count
    by_id = {a["id"]: a for a in followed_artist_summary(mdb, 1)}
    assert by_id[sm]["library_releases"] == 3


def test_summary_carries_the_latest_cached_release(mdb):
    conn = mdb._get_connection()
    ph = _artist(conn, "Pale Harbour")
    for alb_id, name, date in [("a1", "Older", "2025-01-10"), ("a2", "Tidewater", "2026-03-02")]:
        conn.execute(
            "INSERT INTO recent_releases (watchlist_artist_id, album_spotify_id, album_name,"
            " release_date) VALUES (?, ?, ?, ?)", (ph, alb_id, name, date))
    conn.commit()
    conn.close()
    (entry,) = followed_artist_summary(mdb, 1)
    assert entry["latest_release"] == {"album_name": "Tidewater", "release_date": "2026-03-02"}


def test_summary_last_found_and_new_release_come_from_the_scan_ledger(mdb):
    conn = mdb._get_connection()
    ph = _artist(conn, "Pale Harbour")
    sm = _artist(conn, "Saltmarsh")
    lt = _artist(conn, "Low Tide Collective")
    conn.commit()
    conn.close()
    now = datetime(2026, 10, 21, 12, 0, 0)
    _scan_run(mdb, "old", (now - timedelta(days=20)).isoformat(),
              [_event("Saltmarsh", "Lantern", status="added")])
    _scan_run(mdb, "recent", (now - timedelta(days=2)).isoformat(),
              [_event("pale harbour", "Tidewater", status="skipped"),
               _event("Pale Harbour", "Tidewater", status="added"),
               _event("Someone Else", "Nope")])

    by_id = {a["id"]: a for a in followed_artist_summary(mdb, 1, now=now)}
    assert by_id[ph]["new_release"] is True
    assert by_id[ph]["last_found"]["album_name"] == "Tidewater"
    assert by_id[ph]["last_found"]["added_to_wanted"] is True
    assert by_id[ph]["last_found"]["found_at"].endswith("Z")
    assert by_id[sm]["new_release"] is False          # found, but 20 days ago
    assert by_id[sm]["last_found"]["album_name"] == "Lantern"
    assert by_id[lt]["last_found"] is None and by_id[lt]["new_release"] is False


def test_summary_is_scoped_to_one_profile(mdb):
    conn = mdb._get_connection()
    mine = _artist(conn, "Saltmarsh", profile_id=1)
    theirs = _artist(conn, "Saltmarsh", profile_id=2)
    conn.commit()
    conn.close()
    now = datetime(2026, 10, 21, 12, 0, 0)
    _scan_run(mdb, "p2-run", (now - timedelta(days=1)).isoformat(),
              [_event("Saltmarsh", "Theirs Only")], profile_id=2)

    mine_rows = followed_artist_summary(mdb, 1, now=now)
    assert [a["id"] for a in mine_rows] == [mine]
    assert mine_rows[0]["last_found"] is None        # profile 2's check, not ours
    theirs_rows = followed_artist_summary(mdb, 2, now=now)
    assert [a["id"] for a in theirs_rows] == [theirs]
    assert theirs_rows[0]["new_release"] is True


def test_summary_of_nobody_followed_is_empty(mdb):
    assert followed_artist_summary(mdb, 1) == []


# ── the routes: profile-scoped, not admin-only ───────────────────────────────

web_server = pytest.importorskip("web_server")


@pytest.fixture
def client():
    return web_server.app.test_client()


def _as(client, profile_id):
    with client.session_transaction() as sess:
        sess["profile_id"] = profile_id


@pytest.fixture
def nonadmin(client):
    pid = web_server.get_database().create_profile(name=f"wanted_{os.urandom(3).hex()}")
    _as(client, pid)
    return pid


def test_found_route_answers_a_non_admin(client, nonadmin):
    response = client.get("/api/wishlist/found?days=3")
    assert response.status_code == 200
    body = response.get_json()
    assert body["success"] is True and body["days"] == 3
    assert isinstance(body["items"], list) and body["count"] == len(body["items"])


def test_summary_route_answers_a_non_admin(client, nonadmin):
    response = client.get("/api/watchlist/artists/summary")
    assert response.status_code == 200
    body = response.get_json()
    assert body["success"] is True and body["new_release_days"] == 7
    assert body["artists"] == []


def test_summary_route_only_returns_the_session_profiles_artists(client):
    db = web_server.get_database()
    tag = os.urandom(3).hex()
    first = db.create_profile(name=f"wanted_a_{tag}")
    second = db.create_profile(name=f"wanted_b_{tag}")
    conn = db._get_connection()
    try:
        mine = _artist(conn, f"Mine {tag}", profile_id=first, sp=f"sp-mine-{tag}")
        theirs = _artist(conn, f"Theirs {tag}", profile_id=second, sp=f"sp-theirs-{tag}")
        conn.commit()
    finally:
        conn.close()

    _as(client, first)
    ids = [a["id"] for a in client.get("/api/watchlist/artists/summary").get_json()["artists"]]
    assert ids == [mine]
    _as(client, second)
    ids = [a["id"] for a in client.get("/api/watchlist/artists/summary").get_json()["artists"]]
    assert ids == [theirs]


def test_found_route_hides_finds_in_another_profiles_library(client):
    db = web_server.get_database()
    tag = os.urandom(3).hex()
    first = db.create_profile(name=f"found_a_{tag}")
    second = db.create_profile(name=f"found_b_{tag}")
    conn = db._get_connection()
    try:
        _removal(conn, f"only-first-{tag}", path=f"/music/{tag}.flac", profiles=[first])
        conn.commit()
    finally:
        conn.close()

    _as(client, first)
    ids = {i["id"] for i in client.get("/api/wishlist/found").get_json()["items"]}
    assert f"only-first-{tag}" in ids
    _as(client, second)
    ids = {i["id"] for i in client.get("/api/wishlist/found").get_json()["items"]}
    assert f"only-first-{tag}" not in ids
