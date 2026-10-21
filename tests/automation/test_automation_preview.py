"""Preview a run (core/automation/dry_run.py) and its routes
(POST /api/automations/<id>/preview, POST /api/automations/preview).

A preview works out what a run would do from what SoulSync already stores,
changes nothing, and is recorded as a run tagged Preview when the automation
is the viewer's own or the viewer is an admin.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

import pytest
from flask import Flask

import api.automations as automations_api
from core.automation import dry_run
from core.automation.dry_run import DryRunContext

NOW = datetime(2026, 10, 21, 12, 0, tzinfo=timezone.utc)


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _FakeDB:
    """Just what the simulators read."""

    def __init__(self, profiles=None, artists=None, playlists=None):
        self.profiles = profiles or [{"id": 1, "name": "Admin", "is_admin": 1, "can_download": 1}]
        self.artists = artists or {}
        self.playlists = playlists or []

    def get_all_profiles(self):
        return list(self.profiles)

    def get_metadata(self, key):
        return None  # standard retry profile

    def get_watchlist_artists(self, profile_id=1):
        return list(self.artists.get(profile_id, []))

    def get_mirrored_playlists(self, profile_id=1):
        return [p for p in self.playlists if p.get("profile_id", 1) == profile_id]

    def get_mirrored_playlist(self, playlist_id):
        return next((p for p in self.playlists if p["id"] == playlist_id), None)


class _FakeConfig:
    def __init__(self, values):
        self.values = values

    def get(self, key, default=None):
        return self.values.get(key, default)


def _track(tid, name, album_type="album", tries=0, attempted_hours_ago=None, release_date=None):
    album = {"name": f"{name} LP", "album_type": album_type}
    if release_date:
        album["release_date"] = release_date
    # the shape WishlistService.format_track_for_download gives the processor
    return {
        "id": tid, "spotify_track_id": tid, "track_id": tid, "track_name": name, "name": name,
        "artist_name": "Pale Harbour", "artists": ["Pale Harbour"], "album_name": album["name"],
        "album": album, "track_data": {"id": tid, "name": name, "album": album}, "retry_count": tries,
        "last_attempted": ((NOW - timedelta(hours=attempted_hours_ago)).strftime("%Y-%m-%d %H:%M:%S")
                           if attempted_hours_ago is not None else None),
        "profile_id": 1,
    }


@pytest.fixture
def ctx():
    return DryRunContext(database=_FakeDB(), now=NOW)


# ---------------------------------------------------------------------------
# Search for what's due on Wanted (process_wishlist)
# ---------------------------------------------------------------------------

def test_wishlist_preview_counts_what_the_next_search_would_pick(ctx, monkeypatch):
    rows = [
        _track("a", "Harbour Light", tries=0),
        _track("b", "Ferry Song", tries=6, attempted_hours_ago=1),        # cooling down (a week)
        _track("c", "Slack Water", album_type="single"),                 # not this turn
        _track("d", "Tidewater", release_date="2099-05-01"),             # not out yet
        _track("e", "Lantern", tries=2, attempted_hours_ago=5),          # due again after 4h
    ]
    monkeypatch.setattr(dry_run, "_wishlist_rows", lambda c: [dict(r) for r in rows])
    monkeypatch.setattr(dry_run, "_wishlist_cycle", lambda c: "albums")
    out = dry_run.preview_steps(ctx, action_type="process_wishlist", action_config={})
    assert out["available"] is True
    counts = {c["key"]: c["value"] for c in out["counts"]}
    assert counts == {"would_search": 2, "waiting": 1, "unreleased": 1}
    assert [s["title"] for s in out["sample"]] == ["Harbour Light", "Lantern"]
    assert out["sample"][0]["detail"] == "Pale Harbour · Harbour Light LP · not tried yet"
    assert out["sample"][1]["detail"].endswith("2 tries")
    assert out["sample_total"] == 2 and out["sample_noun"] == "track"
    assert "search for 2 tracks" in out["summary"] and "this turn is albums" in out["summary"]
    assert "Nothing was searched, downloaded, moved or changed." in out["summary"]
    assert out["files"] is False


def test_wishlist_preview_says_when_this_turn_has_nothing_due(ctx, monkeypatch):
    monkeypatch.setattr(dry_run, "_wishlist_rows", lambda c: [_track("s", "Single", album_type="single")])
    monkeypatch.setattr(dry_run, "_wishlist_cycle", lambda c: "albums")
    out = dry_run.preview_steps(ctx, action_type="process_wishlist")
    assert out["counts"][0]["value"] == 0
    assert "hand the next turn to singles (1 track due)" in out["summary"]


def test_wishlist_preview_of_an_empty_wanted_list(ctx, monkeypatch):
    monkeypatch.setattr(dry_run, "_wishlist_rows", lambda c: [])
    out = dry_run.preview_steps(ctx, action_type="process_wishlist")
    assert out["available"] is True and out["sample"] == []
    assert out["summary"].startswith("Wanted is empty")


# ---------------------------------------------------------------------------
# Check followed artists (scan_watchlist)
# ---------------------------------------------------------------------------

def test_watchlist_preview_lists_who_a_check_would_look_at():
    db = _FakeDB(profiles=[{"id": 1}, {"id": 2}], artists={
        1: [{"artist_name": "Saltmarsh", "last_scan_timestamp": (NOW - timedelta(days=2)).isoformat()}],
        2: [{"artist_name": "Low Tide", "last_scan_timestamp": None}],
    })
    out = dry_run.preview_steps(DryRunContext(database=db, now=NOW, spotify_ready=lambda: True),
                                action_type="scan_watchlist")
    assert out["available"] is True
    assert {c["key"]: c["value"] for c in out["counts"]} == {"would_check": 2, "never_checked": 1}
    assert out["sample"] == [{"title": "Saltmarsh", "detail": "checked 2 days ago"},
                             {"title": "Low Tide", "detail": "never checked"}]


def test_watchlist_preview_is_unavailable_without_spotify():
    db = _FakeDB(artists={1: [{"artist_name": "Saltmarsh", "last_scan_timestamp": None}]})
    out = dry_run.preview_steps(DryRunContext(database=db, now=NOW, spotify_ready=lambda: False),
                                action_type="scan_watchlist")
    assert out["available"] is False
    assert "Spotify isn't connected" in out["reason"]
    assert out["steps"][0]["previewed"] is False


# ---------------------------------------------------------------------------
# Mirrored playlists
# ---------------------------------------------------------------------------

def test_mirrored_preview_names_the_playlists_a_run_would_refresh():
    db = _FakeDB(playlists=[
        {"id": 1, "name": "Sunday Mornings", "source": "spotify", "track_count": 48, "profile_id": 1},
        {"id": 2, "name": "From a file", "source": "file", "track_count": 10, "profile_id": 1},
        {"id": 3, "name": "Someone else's", "source": "spotify", "track_count": 9, "profile_id": 2},
    ])
    out = dry_run.preview_steps(DryRunContext(database=db, now=NOW), action_type="refresh_mirrored",
                                action_config={"all": True})
    assert [s["title"] for s in out["sample"]] == ["Sunday Mornings"]      # files have no upstream
    assert {c["key"]: c["value"] for c in out["counts"]} == {"playlists": 1, "tracks": 48}
    one = dry_run.preview_steps(DryRunContext(database=db, now=NOW), action_type="sync_playlist",
                                action_config={"playlist_id": "2"})
    assert one["sample"][0]["title"] == "From a file"


def test_mirrored_preview_without_a_playlist_is_unavailable():
    out = dry_run.preview_steps(DryRunContext(database=_FakeDB(), now=NOW), action_type="refresh_mirrored",
                                action_config={})
    assert out["available"] is False and "no playlist chosen" in out["reason"]


# ---------------------------------------------------------------------------
# File steps: counted, never touched
# ---------------------------------------------------------------------------

def test_quarantine_preview_counts_files_and_deletes_nothing(tmp_path):
    downloads = tmp_path / "downloads"
    quarantine = downloads / "ss_quarantine"
    quarantine.mkdir(parents=True)
    (quarantine / "a.flac.quarantined").write_bytes(b"x" * 2048)
    (quarantine / "a.json").write_text("{}")
    ctx = DryRunContext(database=_FakeDB(), now=NOW, config_manager=_FakeConfig({
        "soulseek.download_path": str(downloads), "soulseek.transfer_path": str(tmp_path / "music")}))
    out = dry_run.preview_steps(ctx, action_type="clear_quarantine", action_config={"confirm": True})
    assert out["available"] is True and out["files"] is True
    counts = {c["key"]: c for c in out["counts"]}
    assert counts["quarantine"]["value"] == 1                   # the sidecar isn't counted
    assert counts["size"]["unit"] == "bytes" and counts["size"]["value"] == 2048
    assert out["sample"][0]["title"] == "a.flac.quarantined"
    assert "confirm before anything is deleted" in out["summary"]
    assert sorted(os.listdir(quarantine)) == ["a.flac.quarantined", "a.json"]


def test_library_cleanup_preview_follows_its_two_switches(tmp_path):
    ctx = DryRunContext(database=_FakeDB(), now=NOW, config_manager=_FakeConfig({
        "soulseek.download_path": str(tmp_path / "d"), "soulseek.transfer_path": str(tmp_path / "t")}))
    out = dry_run.preview_steps(ctx, action_type="library_cleanup", action_config={"quarantine": False})
    assert [c["key"] for c in out["counts"]] == ["recycle_bin", "size"]
    assert out["summary"].startswith("There's nothing for this step to delete")


# ---------------------------------------------------------------------------
# What can't be previewed, and the follow-up steps
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("action", ["scan_library", "run_duplicate_cleaner", "deep_scan_library", "something_new"])
def test_steps_that_cant_be_tried_say_why(ctx, action):
    out = dry_run.preview_steps(ctx, action_type=action)
    assert out["available"] is False and out["reason"]
    assert "counts" not in out
    assert out["steps"][0] == {"position": 1, "kind": "action", "type": action, "previewed": False,
                               "note": out["reason"]}


def test_follow_up_steps_are_never_run_and_say_so(ctx, monkeypatch):
    monkeypatch.setattr(dry_run, "_wishlist_rows", lambda c: [])
    out = dry_run.preview_steps(ctx, action_type="process_wishlist", then_actions=[
        {"type": "discord_webhook", "config": {"webhook_url": "https://example.invalid"}},
        {"type": "fire_signal", "config": {"signal_name": "ready"}},
    ])
    assert [(s["position"], s["type"], s["previewed"]) for s in out["steps"]] == [
        (1, "process_wishlist", True), (2, "discord_webhook", False), (3, "fire_signal", False)]
    assert out["steps"][1]["note"] == "A preview doesn't send notifications."
    assert "signals" in out["steps"][2]["note"]


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------

@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase
    return MusicDatabase(database_path=str(tmp_path / "preview.db"))


def _automation(db, name="Fill Wanted", action="process_wishlist", profile_id=1, system=False, config=None,
                then=None):
    return db.create_automation(name, "schedule", json.dumps({"interval": 6, "unit": "hours"}), action,
                                json.dumps(config or {}), profile_id=profile_id,
                                then_actions=json.dumps(then or []), is_system=system)


def test_a_recorded_preview_is_a_run_tagged_preview(db):
    aid = _automation(db)
    result = {"available": True, "summary": "A run now would search for 41 tracks.",
              "counts": [{"key": "would_search", "label": "Would search", "value": 41}],
              "sample_total": 41, "sample_noun": "track", "action_type": "process_wishlist",
              "steps": [{"kind": "then", "note": "A preview doesn't send notifications."}]}
    run_id = dry_run.record_preview(db, aid, result, started_at=1_792_000_000.0, finished_at=1_792_000_000.4)
    assert run_id
    row = db.get_automation_run_history(aid)["history"][0]
    assert row["id"] == run_id and row["status"] == "preview"
    assert row["summary"] == "Would search 41 · nothing changed"
    assert json.loads(row["result_json"])["counts"][0]["value"] == 41
    assert [line["type"] for line in json.loads(row["log_lines"])] == ["info", "skip"]
    # a preview isn't a run: the automation's own run stats don't move
    auto = db.get_automation(aid)
    assert auto["run_count"] == 0 and auto["last_run"] is None


def test_previews_never_crowd_out_real_runs(db):
    aid = _automation(db)
    db.insert_automation_run_history(aid, "2026-10-01T00:00:00+00:00", "2026-10-01T00:01:00+00:00", 60,
                                     "completed", "Done")
    result = {"available": True, "summary": "x", "counts": [], "steps": []}
    for _ in range(dry_run.MAX_PREVIEWS_KEPT + 5):
        dry_run.record_preview(db, aid, result, started_at=1.0, finished_at=2.0)
    history = db.get_automation_run_history(aid, limit=100)["history"]
    assert sum(1 for h in history if h["status"] == "preview") == dry_run.MAX_PREVIEWS_KEPT
    assert sum(1 for h in history if h["status"] == "completed") == 1


# ---------------------------------------------------------------------------
# Routes: who may preview what, and what gets recorded
# ---------------------------------------------------------------------------

@pytest.fixture
def client(db, monkeypatch):
    who = {"pid": 1, "admin": True}
    monkeypatch.setattr(automations_api, "get_current_profile_id", lambda: who["pid"])
    monkeypatch.setattr(automations_api, "is_admin_request", lambda: who["admin"])
    monkeypatch.setattr(automations_api, "get_database", lambda: db)
    monkeypatch.setattr(automations_api, "config_manager", _FakeConfig({}))
    monkeypatch.setattr(automations_api, "docker_resolve_path", lambda p: p)
    monkeypatch.setattr(automations_api, "spotify_ready", None)
    monkeypatch.setattr(dry_run, "_wishlist_rows", lambda c: [_track("a", "Harbour Light")])
    monkeypatch.setattr(dry_run, "_wishlist_cycle", lambda c: "albums")
    app = Flask(__name__)
    app.register_blueprint(automations_api.bp)
    c = app.test_client()
    c.who = who
    return c


def test_previewing_your_own_automation_records_a_preview_run(client, db):
    aid = _automation(db)
    r = client.post(f"/api/automations/{aid}/preview")
    assert r.status_code == 200
    body = r.get_json()
    assert body["success"] is True and body["available"] is True
    assert body["automation_id"] == aid and body["recorded"] is True and body["run_id"]
    assert body["counts"][0] == {"key": "would_search", "label": "Would search", "value": 1}
    assert isinstance(body["previewed_at"], int) and body["duration_ms"] >= 0
    assert db.get_automation_run_history(aid)["history"][0]["status"] == "preview"


def test_a_member_previews_their_own_automation(client, db):
    member = db.create_profile(name="kid")
    aid = _automation(db, profile_id=member)
    client.who.update(pid=member, admin=False)
    body = client.post(f"/api/automations/{aid}/preview").get_json()
    assert body["recorded"] is True


def test_another_profiles_automation_is_not_found(client, db):
    other = db.create_profile(name="teen")
    aid = _automation(db, profile_id=other)
    r = client.post(f"/api/automations/{aid}/preview")       # admin, but it isn't on their page
    assert r.status_code == 404 and r.get_json() == {"success": False, "error": "Automation not found"}
    assert db.get_automation_run_history(aid)["history"] == []
    assert client.post("/api/automations/999/preview").status_code == 404


def test_system_automations_are_recorded_only_for_admins(client, db):
    aid = _automation(db, name="Auto-Process Wishlist", system=True)
    member = db.create_profile(name="kid")
    client.who.update(pid=member, admin=False)
    body = client.post(f"/api/automations/{aid}/preview").get_json()
    assert body["available"] is True and body["recorded"] is False and body["run_id"] is None
    assert db.get_automation_run_history(aid)["history"] == []
    client.who.update(pid=1, admin=True)
    assert client.post(f"/api/automations/{aid}/preview").get_json()["recorded"] is True


def test_unsaved_edits_are_previewed_instead_of_the_saved_steps(client, db):
    aid = _automation(db, action="scan_library")
    body = client.post(f"/api/automations/{aid}/preview", json={"action_type": "process_wishlist"}).get_json()
    assert body["action_type"] == "process_wishlist" and body["available"] is True


def test_a_step_that_cant_be_previewed_is_not_recorded(client, db):
    aid = _automation(db, action="scan_library")
    body = client.post(f"/api/automations/{aid}/preview").get_json()
    assert body["available"] is False and body["reason"] and body["recorded"] is False
    assert db.get_automation_run_history(aid)["history"] == []


def test_a_draft_previews_without_being_saved_or_recorded(client, db):
    r = client.post("/api/automations/preview", json={
        "action_type": "process_wishlist", "action_config": {},
        "then_actions": [{"type": "telegram", "config": {}}]})
    body = r.get_json()
    assert r.status_code == 200 and body["automation_id"] is None and body["recorded"] is False
    assert [s["type"] for s in body["steps"]] == ["process_wishlist", "telegram"]


@pytest.mark.parametrize("payload", [{}, {"action_type": ""}, {"action_type": "process_wishlist", "then_actions": {}},
                                     {"action_type": "process_wishlist", "action_config": []}])
def test_a_draft_needs_an_action_and_well_formed_parts(client, payload):
    r = client.post("/api/automations/preview", json=payload)
    assert r.status_code == 400 and r.get_json()["success"] is False and r.get_json()["error"]


def test_no_profile_is_a_401(client, db):
    aid = _automation(db)
    client.who["pid"] = None
    assert client.post(f"/api/automations/{aid}/preview").status_code == 401
    assert client.post("/api/automations/preview", json={"action_type": "process_wishlist"}).status_code == 401


def test_a_preview_that_breaks_says_so_without_a_code(client, db, monkeypatch):
    aid = _automation(db)

    def boom(*_a, **_k):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(dry_run, "_wishlist_rows", boom)
    r = client.post(f"/api/automations/{aid}/preview")
    assert r.status_code == 500
    assert r.get_json() == {"success": False, "error": "The preview didn't work. Nothing was changed."}


def test_the_master_switch_stays_admin_only(client, db, monkeypatch):
    """The one automation route that is admin-gated today, beside the new ones."""
    member = db.create_profile(name="kid")
    client.who.update(pid=member, admin=False)
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: False)
    r = client.post("/api/automations/master", json={"side": "music", "enabled": False})
    assert r.status_code == 403
