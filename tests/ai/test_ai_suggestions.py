"""The suggestion card: one at a time, worked out locally from the facts (no
model call), only when the Assistant can be used and the reason has a number
in it, and "Not now" kept per profile."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from core.ai import suggestions

from .conftest import automation, run_row, set_key

NOW = datetime.now(timezone.utc)


def _iso(days_ago):
    return (NOW - timedelta(days=days_ago)).isoformat()


def _pause(db, aid, days_ago):
    db.toggle_automation(aid)
    with db._get_connection() as conn:
        conn.execute("UPDATE automations SET paused_at = ? WHERE id = ?",
                     ((NOW - timedelta(days=days_ago)).strftime("%Y-%m-%d %H:%M:%S"), aid))
        conn.commit()


def _stale_wanted(db, n, profile_id=1, days=45, tries=3):
    with db._get_connection() as conn:
        for i in range(n):
            conn.execute(
                "INSERT INTO wishlist_tracks (spotify_track_id, spotify_data, retry_count, date_added, profile_id) "
                "VALUES (?, ?, ?, datetime('now', ?), ?)",
                (f"t{profile_id}-{days}-{i}", json.dumps({"name": f"Track {i}"}), tries, f"-{days} days",
                 profile_id))
        conn.commit()


def test_repeated_failures_without_a_notification(db):
    aid = automation(db)
    for i in range(59):
        run_row(db, aid, started=_iso(i % 29))
    run_row(db, aid, status="error", started=_iso(3))
    run_row(db, aid, status="error", started=_iso(5))
    run_row(db, aid, status="error", started=_iso(45))        # outside the 30 days
    item = suggestions.pick(db, profile_id=1, is_admin=True)
    assert item["key"] == f"failing:{aid}"
    assert item["title"] == "Tell you when Fill Wanted fails"
    assert item["reason"].startswith("2 of its last 61 runs failed and nothing told you.")
    assert "only when a run fails" in item["draft_prompt"] and item["automation_id"] == aid


def test_an_automation_that_already_tells_someone_isnt_suggested(db):
    aid = automation(db, then=[{"type": "telegram", "config": {}}])
    run_row(db, aid, status="error", started=_iso(1))
    run_row(db, aid, status="error", started=_iso(2))
    assert suggestions.pick(db, profile_id=1, is_admin=True) is None


def test_paused_for_weeks(db):
    aid = automation(db, name="Check followed artists", action="scan_watchlist")
    _pause(db, aid, 21)
    item = suggestions.pick(db, profile_id=1, is_admin=True)
    assert item["key"] == f"paused:{aid}" and item["title"] == "Resume Check followed artists?"
    assert "paused for 3 weeks" in item["reason"] and "aren't reaching Wanted" in item["reason"]


def test_recently_paused_isnt_suggested(db):
    _pause(db, automation(db), 5)
    assert suggestions.pick(db, profile_id=1, is_admin=True) is None


def test_old_wanted_tracks_that_arent_found(db):
    _stale_wanted(db, 23)
    _stale_wanted(db, 5, days=10)                    # too recent
    item = suggestions.pick(db, profile_id=1, is_admin=True)
    assert item["key"] == "wanted_stale"
    assert item["reason"] == "23 tracks have been on Wanted for over a month without being found."


def test_only_the_profiles_own_wanted_counts(db):
    member = db.create_profile(name="kid")
    _stale_wanted(db, 30, profile_id=1)
    assert suggestions.pick(db, profile_id=member, is_admin=False) is None


def test_a_member_isnt_told_about_built_in_automations(db):
    member = db.create_profile(name="kid")
    aid = automation(db, name="Auto-Backup Database", action="backup_database", system=True)
    _pause(db, aid, 30)
    assert suggestions.pick(db, profile_id=member, is_admin=False) is None
    assert suggestions.pick(db, profile_id=1, is_admin=True)["key"] == f"paused:{aid}"


def test_every_reason_has_a_number(db):
    _stale_wanted(db, 12)
    aid = automation(db)
    _pause(db, aid, 70)
    for item in suggestions.candidates(db, profile_id=1, is_admin=True):
        assert any(ch.isdigit() for ch in item["reason"]), item


# ── the routes ──────────────────────────────────────────────────────────────

def test_no_suggestion_while_the_assistant_cant_be_used(client, config, db):
    _stale_wanted(db, 20)
    assert client.get("/api/ai/suggestion").get_json() == {"success": True, "suggestion": None}
    set_key(config)
    body = client.get("/api/ai/suggestion").get_json()
    assert body["suggestion"]["key"] == "wanted_stale"


def test_not_now_is_kept_per_profile(client, config, db):
    set_key(config, who_can_use="everyone")
    member = db.create_profile(name="kid")
    _stale_wanted(db, 20, profile_id=1)
    _stale_wanted(db, 20, profile_id=member)
    assert client.post("/api/ai/suggestion/wanted_stale/dismiss").get_json() == {"success": True}
    assert client.get("/api/ai/suggestion").get_json()["suggestion"] is None
    client.who.update(pid=member, admin=False)
    assert client.get("/api/ai/suggestion").get_json()["suggestion"]["key"] == "wanted_stale"


def test_dismissing_an_unknown_key_is_a_404(client, config):
    set_key(config)
    assert client.post("/api/ai/suggestion/anything/dismiss").status_code == 404
    assert client.post("/api/ai/suggestion/failing:abc/dismiss").status_code == 404


def test_the_suggestion_never_calls_the_model(client, config, db, provider):
    set_key(config)
    _stale_wanted(db, 20)
    client.get("/api/ai/suggestion")
    assert provider.calls == [] and provider.keys == []
