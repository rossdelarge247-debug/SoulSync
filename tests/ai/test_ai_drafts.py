"""Every draft is checked before it's sent: only blocks from the music parts
list, settings that fit each block's fields, no admin-only step for a
member, never "Act without a preview", and the result is exactly what
POST /api/automations/preview accepts."""

from __future__ import annotations

import pytest

from core.ai.drafts import clean_draft, from_tool, strip_secrets
from core.automation.api import needs_admin
from core.automation.blocks import blocks_for_scope

BLOCKS = blocks_for_scope("music")


def _draft(**over):
    base = {"name": "New releases", "trigger_type": "daily_time", "trigger_config": {"time": "06:00"},
            "action_type": "scan_watchlist", "action_config": {}, "then_actions": []}
    base.update(over)
    return base


def test_a_good_draft_comes_through_whole():
    draft, notes = clean_draft(_draft(then_actions=[{"type": "telegram", "config": {"message": "New: {artist}"},
                                                     "conditions": [{"field": "status", "operator": "equals",
                                                                     "value": "completed"}]}]),
                               BLOCKS, is_admin=False)
    assert notes == []
    assert draft == {"name": "New releases", "trigger_type": "daily_time", "trigger_config": {"time": "06:00"},
                     "action_type": "scan_watchlist", "action_config": {},
                     "then_actions": [{"type": "telegram", "config": {"message": "New: {artist}"},
                                       "conditions": [{"field": "status", "operator": "equals",
                                                       "value": "completed"}]}]}


def test_an_action_outside_the_parts_list_leaves_no_draft():
    for action in ("convert_to_flac", "video_scan_library", ""):
        draft, notes = clean_draft(_draft(action_type=action), BLOCKS, is_admin=True)
        assert draft is None and notes


def test_settings_that_dont_fit_are_left_out_and_said():
    draft, notes = clean_draft(_draft(action_type="apply_quality_upgrades",
                                      action_config={"limit": "lots", "made_up": 1}), BLOCKS, is_admin=True)
    assert draft["action_config"] == {}
    assert any("Most per run" in n for n in notes)
    draft, _ = clean_draft(_draft(action_type="apply_quality_upgrades", action_config={"limit": "40"}),
                           BLOCKS, is_admin=True)
    assert draft["action_config"] == {"limit": 40}


def test_trigger_settings_are_checked_against_their_fields():
    draft, _ = clean_draft(_draft(trigger_type="schedule", trigger_config={"interval": 0, "unit": "fortnights"}),
                           BLOCKS, is_admin=True)
    assert draft["trigger_config"] == {"interval": 6, "unit": "hours"}      # the fields' defaults
    draft, _ = clean_draft(_draft(trigger_type="weekly_time", trigger_config={"time": "23:00", "days": "sun,mon"}),
                           BLOCKS, is_admin=True)
    assert draft["trigger_config"] == {"time": "23:00", "days": ["sun", "mon"]}
    draft, notes = clean_draft(_draft(trigger_type="when_the_moon_is_full"), BLOCKS, is_admin=True)
    assert draft["trigger_type"] == "schedule" and notes


def test_event_conditions_use_the_triggers_own_fields():
    draft, _ = clean_draft(_draft(trigger_type="track_downloaded",
                                  trigger_config={"conditions": [{"field": "artist", "operator": "contains",
                                                                  "value": "Saltmarsh"},
                                                                 {"field": "rm -rf", "operator": "equals", "value": ""},
                                                                 {"field": "genre", "operator": "equals",
                                                                  "value": "x"}]}),
                          BLOCKS, is_admin=True)
    assert draft["trigger_config"] == {"conditions": [{"field": "artist", "operator": "contains",
                                                       "value": "Saltmarsh"}], "match": "all"}


@pytest.mark.parametrize("action", ["run_script", "library_cleanup", "clear_quarantine", "full_cleanup",
                                    "run_repair_job", "backup_database", "deep_scan_library",
                                    "run_duplicate_cleaner"])
def test_a_member_never_gets_an_admin_only_action(action):
    draft, notes = clean_draft(_draft(action_type=action), BLOCKS, is_admin=False, scripts=["tidy.sh"])
    assert draft is None
    assert "for admins only" in notes[0]
    admin_draft, _ = clean_draft(_draft(action_type=action), BLOCKS, is_admin=True, scripts=["tidy.sh"])
    assert admin_draft is not None


def test_a_member_never_gets_a_script_follow_up_and_is_told():
    draft, notes = clean_draft(_draft(then_actions=[{"type": "run_script", "config": {"script_name": "tidy.sh"}},
                                                    {"type": "fire_signal", "config": {"signal_name": "Done Now"}}]),
                               BLOCKS, is_admin=False, scripts=["tidy.sh"])
    assert [t["type"] for t in draft["then_actions"]] == ["fire_signal"]
    assert draft["then_actions"][0]["config"] == {"signal_name": "done_now"}
    assert notes == ["I left out “Run Script”: it's for admins only."]


def test_an_admin_gets_a_script_only_from_the_scripts_folder():
    draft, _ = clean_draft(_draft(then_actions=[{"type": "run_script", "config": {"script_name": "../../etc/x"}}]),
                           BLOCKS, is_admin=True, scripts=["tidy.sh"])
    assert draft["then_actions"][0]["config"] == {"timeout": 60}
    draft, _ = clean_draft(_draft(then_actions=[{"type": "run_script", "config": {"script_name": "tidy.sh"}}]),
                           BLOCKS, is_admin=True, scripts=["tidy.sh"])
    assert draft["then_actions"][0]["config"] == {"script_name": "tidy.sh", "timeout": 60}


def test_needs_admin_covers_scripts_cleanups_repairs_backups_purges_and_video():
    for kind in ("actions", "notifications"):
        for block in BLOCKS[kind]:
            t = block["type"]
            if t == "run_script" or any(w in t for w in ("clean", "repair", "backup", "purge", "quarantine")):
                assert needs_admin(t), t
    for t in ("video_scan_library", "video_purge_recycle_bin", "audiobook_purge_recycle"):
        assert needs_admin(t)
    for t in ("process_wishlist", "scan_watchlist", "telegram", "fire_signal", "notify_only", "refresh_mirrored"):
        assert not needs_admin(t), t


def test_a_draft_never_acts_without_a_preview():
    draft, _ = clean_draft(_draft(action_type="clear_quarantine", action_config={"confirm": True}),
                           BLOCKS, is_admin=True)
    assert draft["action_config"] == {"confirm": False}


def test_at_most_three_follow_ups():
    thens = [{"type": "fire_signal", "config": {"signal_name": f"s{n}"}} for n in range(5)]
    draft, notes = clean_draft(_draft(then_actions=thens), BLOCKS, is_admin=True)
    assert len(draft["then_actions"]) == 3 and any("three" in n for n in notes)


def test_credentials_are_never_taken_from_a_draft():
    draft, _ = clean_draft(_draft(then_actions=[{"type": "telegram", "config": {
        "bot_token": "123:abc", "chat_id": "-100", "message": "hi"}}]), BLOCKS, is_admin=True)
    assert draft["then_actions"][0]["config"] == {"message": "hi"}


def test_credentials_are_never_sent_to_the_provider():
    out = strip_secrets([{"type": "discord_webhook", "config": {"webhook_url": "https://x/y", "message": "hi"}}])
    assert out == [{"type": "discord_webhook", "config": {"message": "hi"}, "set_up": ["webhook_url"]}]


def test_a_playlist_must_be_one_the_profile_has():
    draft, notes = clean_draft(_draft(action_type="refresh_mirrored", action_config={"playlist_id": "9"}),
                               BLOCKS, is_admin=True, playlist_ids=["4"])
    assert "playlist_id" not in draft["action_config"] and notes
    draft, _ = clean_draft(_draft(action_type="refresh_mirrored", action_config={"playlist_id": "4"}),
                           BLOCKS, is_admin=True, playlist_ids=["4"])
    assert draft["action_config"]["playlist_id"] == "4"


def test_the_tool_shape_becomes_a_draft():
    raw = from_tool({"name": "Night search", "when": {"type": "weekly_time", "settings": [
        {"key": "time", "value": "23:00"}, {"key": "days", "value": "sun"}]},
        "do": {"type": "process_wishlist", "settings": [], "wait_minutes": 5},
        "then": [{"type": "discord_webhook", "settings": [{"key": "message", "value": "Ran: {status}"}],
                  "only_when": [{"field": "status", "operator": "equals", "value": "error"}]}]})
    draft, notes = clean_draft(raw, BLOCKS, is_admin=False)
    assert notes == []
    assert draft == {"name": "Night search", "trigger_type": "weekly_time",
                     "trigger_config": {"time": "23:00", "days": ["sun"]},
                     "action_type": "process_wishlist", "action_config": {"delay": 5},
                     "then_actions": [{"type": "discord_webhook", "config": {"message": "Ran: {status}"},
                                       "conditions": [{"field": "status", "operator": "equals",
                                                       "value": "error"}]}]}


# ── the round trip: a checked draft is exactly what the preview takes ───────

ROUND_TRIP = [
    _draft(),
    _draft(trigger_type="schedule", trigger_config={"interval": 6, "unit": "hours"}, action_type="process_wishlist",
           then_actions=[{"type": "telegram", "config": {"message": "{name}: {status}"}}]),
    _draft(action_type="notify_only", trigger_type="signal_received", trigger_config={"signal_name": "ready"},
           then_actions=[{"type": "fire_signal", "config": {"signal_name": "next"}}]),
    _draft(action_type="refresh_mirrored", action_config={"all": True, "playlist_id": "4"}),
    _draft(action_type="clear_quarantine", action_config={"confirm": True}),
]


@pytest.mark.parametrize("raw", ROUND_TRIP)
def test_a_checked_draft_is_accepted_by_the_preview_unchanged(client, raw):
    draft, _ = clean_draft(raw, BLOCKS, is_admin=True, playlist_ids=["4"])
    r = client.post("/api/automations/preview", json=draft)
    body = r.get_json()
    assert r.status_code == 200 and body["success"] is True, body
    assert body["action_type"] == draft["action_type"]
    assert [s["type"] for s in body["steps"]] == [draft["action_type"]] + [t["type"] for t in draft["then_actions"]]
