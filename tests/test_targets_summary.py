"""Home's four targets (core/targets/summary.py, GET /api/targets/summary):
fixed order, real numbers from the existing tables, the schedule that serves
each one, and a status that only says "can't search" from the cached check."""

from __future__ import annotations

import json

import pytest
from flask import Flask

from core.activity.common import utc_text
from core.quality import presets
from core.targets import summary
from tests.activity.activity_rows import DAY, HOUR, NOW, Rows


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase
    summary.clear_cache()
    presets.clear_cache()
    return MusicDatabase(database_path=str(tmp_path / "targets.db"))


@pytest.fixture
def rows(db):
    return Rows(db)


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def _targets(db, pid=1, source=None):
    summary.clear_cache()
    body = summary.build_summary(db, pid, now=NOW, download_source=(lambda: source) if source else None)
    return {t["key"]: t for t in body["targets"]}, body


def _flac_only(db, policy="acceptable", cutoff=0, targets=None):
    targets = targets or [{"label": "FLAC 24-bit/96kHz", "format": "flac", "bit_depth": 24, "min_sample_rate": 96000},
                          {"label": "FLAC 16-bit", "format": "flac", "bit_depth": 16}]
    _sql(db, "UPDATE quality_profiles SET ranked_targets = ?, upgrade_policy = ?, upgrade_cutoff_index = ? "
             "WHERE is_default = 1", (json.dumps(targets), policy, cutoff))
    presets.clear_cache()


def _library(db, files):
    _sql(db, "INSERT INTO artists (id, name) VALUES (1, 'Saltmarsh')")
    _sql(db, "INSERT INTO albums (id, artist_id, title) VALUES (1, 1, 'Lantern')")
    for i, (path, kbps) in enumerate(files):
        _sql(db, "INSERT INTO tracks (album_id, artist_id, title, file_path, bitrate) VALUES (1, 1, ?, ?, ?)",
             (f"t{i}", path, kbps))


# ── shape ─────────────────────────────────────────────────────────────────────

def test_four_targets_in_a_fixed_order_with_every_field(db):
    by_key, body = _targets(db)
    assert [t["key"] for t in body["targets"]] == ["wanted", "mirrored", "followed", "quality"]
    for t in body["targets"]:
        assert {"key", "set_up", "items", "have", "in_progress", "not_found_yet", "next_search_at",
                "next_search_automation", "status", "reason", "unit"} <= set(t)
        assert t["items"] == t["have"] + t["in_progress"] + t["not_found_yet"]
    assert body["generated_at"] == NOW


def test_nothing_set_up_reads_as_not_set_up(db):
    by_key, body = _targets(db)
    for key in ("wanted", "mirrored", "followed"):
        assert by_key[key]["set_up"] is False and by_key[key]["status"] == "not_set_up"
        assert by_key[key]["items"] == 0
    # a default quality profile ships with every install, so Quality always has a target
    assert by_key["quality"]["set_up"] is True
    assert body["any_set_up"] is False


# ── wanted ────────────────────────────────────────────────────────────────────

def test_wanted_splits_by_retry_cadence_and_counts_what_was_found(db, rows):
    rows.wishlist("a", retry_count=0)
    rows.wishlist("b", retry_count=3)
    rows.wishlist("c", retry_count=4)        # slowest cadence of the standard profile
    rows.wishlist("d", profile_id=2)
    for track, profiles, ago in (("e", "[1]", DAY), ("f", None, 2 * DAY), ("g", "[2]", DAY), ("h", "[1]", 40 * DAY)):
        _sql(db, "INSERT INTO wishlist_removals (spotify_track_id, profile_ids, rows_removed, reason, removed_at) "
                 "VALUES (?, ?, 1, 'download_complete', ?)", (track, profiles, utc_text(NOW - ago)))
    w = _targets(db)[0]["wanted"]
    assert (w["items"], w["have"], w["in_progress"], w["not_found_yet"]) == (5, 2, 2, 1)
    assert w["set_up"] is True and w["status"] == "searching" and w["found_window_days"] == 30


def test_wanted_is_per_profile(db, rows):
    rows.wishlist("a", profile_id=2)
    by_key, _ = _targets(db, pid=1)
    assert by_key["wanted"]["set_up"] is False
    assert _targets(db, pid=2)[0]["wanted"]["items"] == 1


def test_only_long_waits_is_ok_not_searching(db, rows):
    rows.wishlist("a", retry_count=9)
    w = _targets(db)[0]["wanted"]
    assert w["in_progress"] == 0 and w["status"] == "ok"


# ── mirrored ──────────────────────────────────────────────────────────────────

def test_mirrored_counts_tracks_across_the_profiles_playlists(db, rows):
    pl = rows.mirrored_playlist("A")
    rows.mirrored_playlist("Empty")
    rows.mirrored_playlist("Theirs", profile_id=2)
    checked = {"library_checked_at": "2026-10-20"}
    for pos, (sid, owned) in enumerate((("s1", True), ("s2", True), ("s3", False), ("s4", False))):
        _sql(db, "INSERT INTO mirrored_playlist_tracks (playlist_id, position, track_name, artist_name, "
                 "source_track_id, extra_data) VALUES (?, ?, ?, 'X', ?, ?)",
             (pl, pos, f"T{pos}", sid, json.dumps({**checked, "in_library": owned})))
    rows.wishlist("s3")
    m = _targets(db)[0]["mirrored"]
    assert (m["items"], m["have"], m["in_progress"], m["not_found_yet"]) == (4, 2, 1, 1)
    assert m["playlists"] == 2 and m["set_up"] is True


# ── followed ──────────────────────────────────────────────────────────────────

def test_followed_counts_new_release_tracks(db, rows):
    _sql(db, "INSERT INTO watchlist_artists (spotify_artist_id, artist_name, profile_id) VALUES ('sp1', 'Saltmarsh', 1)")
    rows.wishlist("n1", source_type="watchlist")
    rows.wishlist("n2", source_type="watchlist", retry_count=6)
    rows.wishlist("m1", source_type="manual")
    rows.history(origin="watchlist", origin_context="Saltmarsh", ago=DAY)
    rows.history(origin="watchlist", origin_context="Someone Else", ago=DAY)
    rows.history(origin="watchlist", origin_context="Saltmarsh", ago=45 * DAY)
    f = _targets(db)[0]["followed"]
    assert (f["items"], f["have"], f["in_progress"], f["not_found_yet"]) == (3, 1, 1, 1)
    assert f["artists"] == 1 and f["set_up"] is True


# ── quality ───────────────────────────────────────────────────────────────────

def test_quality_checks_the_library_against_the_default_profile(db, rows):
    _flac_only(db)
    _library(db, [("/m/a.flac", 900), ("/m/b.flac", 1600), ("/m/c.mp3", 320), ("/m/d.mp3", 128)])
    rows.wishlist("u1", source_type="repair", source_info={"job": "quality_upgrade"})
    q = _targets(db)[0]["quality"]
    assert q["name"] == "FLAC or better" and q["preset"] == "flac"
    assert (q["tracks_checked"], q["meeting_target"]) == (4, 2)
    assert (q["items"], q["have"], q["in_progress"], q["not_found_yet"]) == (4, 2, 1, 1)
    assert q["status"] == "searching"


def test_an_upgrade_cutoff_raises_the_bar(db):
    _flac_only(db, policy="until_cutoff", cutoff=0)
    _library(db, [("/m/a.flac", 900), ("/m/b.flac", 3000)])
    q = _targets(db)[0]["quality"]
    assert q["preset"] == "flac_24" and q["name"] == "FLAC 24-bit or better"
    assert q["meeting_target"] == 1


# ── schedule ──────────────────────────────────────────────────────────────────

def test_next_search_is_the_soonest_enabled_automation_serving_the_target(db, rows):
    rows.wishlist("a")
    rows.automation(name="Later", next_in=6 * HOUR)
    rows.automation(name="Sooner", next_in=2 * HOUR)
    rows.automation(name="Off", next_in=HOUR, enabled=0)
    rows.automation(name="Someone else's", next_in=60, profile_id=2)
    rows.automation(name="Scan", action="scan_watchlist", next_in=3 * HOUR, system=1)
    rows.automation(name="Upgrades", action="run_repair_job", next_in=9 * HOUR)
    _sql(db, "UPDATE automations SET action_config = ? WHERE name = 'Upgrades'", (json.dumps({"job_id": "quality_upgrade"}),))
    by_key, _ = _targets(db)
    assert by_key["wanted"]["next_search_at"] == NOW + 2 * HOUR
    assert by_key["wanted"]["next_search_automation"]["name"] == "Sooner"
    assert by_key["followed"]["next_search_automation"]["name"] == "Scan"
    assert by_key["quality"]["next_search_automation"]["name"] == "Upgrades"
    assert by_key["mirrored"]["next_search_at"] is None


def test_paused_automations_mean_no_next_search(db, rows):
    rows.wishlist("a")
    rows.automation(next_in=HOUR)
    db.set_metadata("automation_master_music_enabled", "0")
    w = _targets(db)[0]["wanted"]
    assert w["next_search_at"] is None and w["schedule_paused"] is True


# ── status ────────────────────────────────────────────────────────────────────

def test_cant_search_comes_from_a_recent_cached_check(db, rows):
    rows.wishlist("a")
    by_key, body = _targets(db, source={"connected": False, "checked_at": NOW - 120, "source": "soulseek"})
    w = by_key["wanted"]
    assert w["status"] == "cant_search" and w["reason_code"] == "download_source_unreachable"
    assert w["reason"] == ("Soulseek (slskd) didn't answer when SYNCHRO.S last checked, 2 minutes ago, "
                           "so searches can't run.")
    assert by_key["mirrored"]["status"] == "not_set_up"
    assert body["download_source"] == {"reachable": False, "checked_at": NOW - 120}


def test_an_old_or_missing_check_is_not_a_problem(db, rows):
    rows.wishlist("a")
    stale = {"connected": False, "checked_at": NOW - 2 * HOUR}
    assert _targets(db, source=stale)[0]["wanted"]["status"] == "searching"
    never = {"connected": False, "checked_at": None}
    assert _targets(db, source=never)[0]["wanted"]["status"] == "searching"
    fine = {"connected": True, "checked_at": NOW - 60}
    assert _targets(db, source=fine)[0]["wanted"]["status"] == "searching"


def test_numbers_are_cached_briefly(db, rows):
    rows.wishlist("a")
    assert summary.build_summary(db, 1, now=NOW)["targets"][0]["items"] == 1
    rows.wishlist("b")
    assert summary.build_summary(db, 1, now=NOW)["targets"][0]["items"] == 1
    summary.clear_cache()
    assert summary.build_summary(db, 1, now=NOW)["targets"][0]["items"] == 2


# ── endpoints ─────────────────────────────────────────────────────────────────

@pytest.fixture
def client(db, monkeypatch):
    import api.targets as targets_api
    who = {"pid": 1}
    monkeypatch.setattr(targets_api, "get_current_profile_id", lambda: who["pid"])
    monkeypatch.setattr(targets_api, "get_database", lambda: db)
    monkeypatch.setattr(targets_api, "download_source_state", lambda: {"connected": True, "checked_at": NOW})
    app = Flask(__name__)
    app.register_blueprint(targets_api.bp)
    c = app.test_client()
    c.who = who
    return c


def test_the_summary_endpoint(client, rows):
    rows.wishlist("a")
    r = client.get("/api/targets/summary")
    assert r.status_code == 200 and r.headers["Cache-Control"] == "no-store"
    body = r.get_json()
    assert body["success"] is True and [t["key"] for t in body["targets"]][0] == "wanted"
    assert body["download_source"]["reachable"] is True


def test_the_presets_endpoint(client, db):
    _library(db, [("/m/a.flac", 900), ("/m/b.mp3", 320)])
    presets.clear_cache()
    body = client.get("/api/quality/presets").get_json()
    assert body["success"] is True and body["total"] == 2
    assert [p["key"] for p in body["presets"]] == ["mp3_320", "flac", "flac_24", "lossless"]
    assert body["current"]["name"]


def test_both_endpoints_need_a_profile(client):
    client.who["pid"] = None
    assert client.get("/api/targets/summary").status_code == 401
    assert client.get("/api/quality/presets").status_code == 401
