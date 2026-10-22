"""Settings → AI: the key is stored with the app's other secrets, never sent
back, and the status says who can use the Assistant and why not."""

from __future__ import annotations

from api.settings import _redact_sensitive
from core.ai import config as ai_config
from core.ai import store
from core.settings import ConfigManager

from .conftest import set_key

KEY = "sk-ant-api03-SECRETVALUE123"


# ── the key is a secret like the others ─────────────────────────────────────

def test_the_key_is_one_of_the_encrypted_paths():
    assert "ai.anthropic_api_key" in ConfigManager._SENSITIVE_PATHS


def test_the_key_is_encrypted_at_rest(tmp_path):
    cm = ConfigManager.__new__(ConfigManager)
    cm.config_data = {}
    cm._fernet = None
    cm.database_path = tmp_path / "db" / "music_library.db"
    cm.database_path.parent.mkdir()
    cm.config_path = tmp_path / "config.json"
    stored = cm._encrypt_sensitive({"ai": {"anthropic_api_key": KEY, "model": "fast"}})
    assert stored["ai"]["anthropic_api_key"] != KEY and KEY not in str(stored)
    assert stored["ai"]["model"] == "fast"
    assert cm._decrypt_sensitive(stored)["ai"]["anthropic_api_key"] == KEY


def test_get_settings_masks_the_key(config):
    set_key(config, KEY)
    redacted = config.redacted_config()
    assert redacted["ai"]["anthropic_api_key"] == ConfigManager.REDACTED_SENTINEL
    assert KEY not in str(redacted)


def test_the_public_settings_api_masks_the_key():
    out = _redact_sensitive({"ai": {"anthropic_api_key": KEY, "model": "best"}})
    assert out["ai"]["anthropic_api_key"] == "***REDACTED***" and out["ai"]["model"] == "best"


def test_a_round_tripped_mask_or_empty_value_keeps_the_key(config):
    set_key(config, KEY)
    config.set("ai.anthropic_api_key", ConfigManager.REDACTED_SENTINEL)
    config.set("ai.anthropic_api_key", "")
    assert ai_config.api_key(config) == KEY


def test_debug_info_never_carries_the_key():
    """/api/debug-info picks its config fields by name; the Assistant adds
    only whether a key is set."""
    import inspect

    from core import debug_info
    source = inspect.getsource(debug_info.get_debug_info)
    assert "ai.anthropic_api_key" in source
    assert "bool(config_manager.get('ai.anthropic_api_key'" in source


# ── GET / PUT /api/ai/settings ──────────────────────────────────────────────

def test_settings_are_admin_only(client):
    client.who.update(pid=2, admin=False)
    assert client.get("/api/ai/settings").status_code == 403
    assert client.put("/api/ai/settings", json={"model": "best"}).status_code == 403
    assert client.post("/api/ai/test", json={}).status_code == 403


def test_settings_never_return_the_key(client, config, db):
    set_key(config, KEY)
    body = client.get("/api/ai/settings").get_json()
    assert KEY not in str(body)
    assert body["settings"]["api_key"] == {"set": True, "masked": "sk-ant-" + "•" * 20 + "123"}
    assert body["settings"]["model"] == "fast" and body["settings"]["who_can_use"] == "admins"
    assert [m["value"] for m in body["models"]] == ["fast", "best"]
    assert body["models"][0]["label"] == "Faster and cheaper"
    assert body["usage"]["requests"] == 0 and body["usage"]["cap_usd"] is None


def test_saving_a_new_key_records_who_and_resets_its_test(client, config, db):
    db.create_profile(name="ross", is_admin=True)
    body = client.put("/api/ai/settings", json={"api_key": KEY, "model": "best", "who_can_use": "everyone",
                                                "monthly_cap_usd": "$10"}).get_json()
    assert body["success"] is True and KEY not in str(body)
    assert ai_config.api_key(config) == KEY
    settings = body["settings"]
    assert settings["model"] == "best" and settings["who_can_use"] == "everyone"
    assert settings["monthly_cap_usd"] == 10.0
    assert settings["key_status"]["state"] == "untested" and settings["key_status"]["added_at"]


def test_an_empty_key_keeps_the_saved_one(client, config):
    set_key(config, KEY)
    client.put("/api/ai/settings", json={"api_key": "", "model": "fast"})
    assert ai_config.api_key(config) == KEY


def test_bad_values_are_refused_with_a_sentence(client):
    for body in ({"model": "huge"}, {"who_can_use": "guests"}, {"monthly_cap_usd": "lots"},
                 {"monthly_cap_usd": -4}, {"provider": "other"}, {"api_key": "two words"}):
        r = client.put("/api/ai/settings", json=body)
        assert r.status_code == 400 and r.get_json()["error"], body


def test_a_cap_can_be_cleared(client, config):
    client.put("/api/ai/settings", json={"monthly_cap_usd": 5})
    client.put("/api/ai/settings", json={"monthly_cap_usd": None})
    assert ai_config.monthly_cap(config) is None


# ── POST /api/ai/test ───────────────────────────────────────────────────────

def test_testing_the_saved_key_updates_its_status(client, config, provider):
    set_key(config, KEY)
    body = client.post("/api/ai/test", json={}).get_json()
    assert body["ok"] is True and body["message"] == "Key works." and body["saved_key"] is True
    assert body["key_status"]["state"] == "ok" and body["key_status"]["tested_at"]
    assert provider.keys == [KEY] and provider.model == "claude-sonnet-5-5"
    provider.test_result = (False, "Anthropic refused this key.")
    body = client.post("/api/ai/test", json={}).get_json()
    assert body["ok"] is False and body["key_status"]["state"] == "refused"
    assert body["key_status"]["message"] == "Anthropic refused this key."


def test_testing_a_pasted_key_leaves_the_saved_status_alone(client, config, provider):
    set_key(config, KEY, key_state="ok")
    body = client.post("/api/ai/test", json={"api_key": "sk-ant-other", "model": "best"}).get_json()
    assert body["saved_key"] is False and body["key_status"] is None
    assert provider.keys == ["sk-ant-other"] and provider.model == "claude-opus-5-5"
    assert ai_config.key_status(config)["state"] == "ok"


def test_testing_without_a_key_says_so(client):
    r = client.post("/api/ai/test", json={})
    assert r.status_code == 400 and r.get_json()["message"] == "Add an API key first."


# ── GET /api/ai/status ──────────────────────────────────────────────────────

def test_status_without_a_key(client):
    body = client.get("/api/ai/status").get_json()
    assert body["configured"] is False and body["can_use"] is False and body["reason"] == "not_configured"
    assert body["provider_name"] == "Anthropic" and body["model"] == "fast"


def test_members_are_left_out_by_default(client, config):
    set_key(config)
    client.who.update(pid=2, admin=False)
    body = client.get("/api/ai/status").get_json()
    assert body["reason"] == "members_not_allowed" and "usage" not in body
    config.set("ai.who_can_use", "everyone")
    body = client.get("/api/ai/status").get_json()
    assert body["can_use"] is True and body["reason"] is None and "usage" not in body


def test_a_refused_key_stops_it(client, config):
    set_key(config, key_state="refused")
    assert client.get("/api/ai/status").get_json()["reason"] == "key_refused"


def test_the_cap_stops_it_once_spent(client, config, db):
    set_key(config, monthly_cap_usd=1.0)
    store.record_request(db, input_tokens=10, output_tokens=10, cost_usd=0.4)
    assert client.get("/api/ai/status").get_json()["can_use"] is True
    store.record_request(db, input_tokens=10, output_tokens=10, cost_usd=0.6)
    body = client.get("/api/ai/status").get_json()
    assert body["reason"] == "cap_reached"
    assert body["usage"]["requests"] == 2 and body["usage"]["estimated_cost_usd"] == 1.0
    assert body["usage"]["cap_usd"] == 1.0


def test_usage_is_kept_per_month(db):
    store.record_request(db, input_tokens=100, output_tokens=50, cost_usd=0.01, month="2026-09")
    store.record_request(db, input_tokens=100, output_tokens=50, cost_usd=0.01, month="2026-10")
    store.record_draft_saved(db, month="2026-10")
    assert store.month_usage(db, "2026-09")["requests"] == 1
    october = store.month_usage(db, "2026-10")
    assert october["requests"] == 1 and october["drafts_saved"] == 1 and october["input_tokens"] == 100


def test_cost_is_estimated_from_token_counts():
    usage = {"input_tokens": 1_000_000, "output_tokens": 100_000, "cache_read_tokens": 1_000_000,
             "cache_write_tokens": 0}
    assert ai_config.estimate_cost_usd("fast", usage) == 2.0 + 1.0 + 0.2
    assert ai_config.estimate_cost_usd("claude-opus-5-5", usage) == 4.0 + 2.0 + 0.2


def test_saving_a_draft_from_the_assistant_counts(client, db):
    payload = {"name": "Night search", "trigger_type": "schedule", "trigger_config": {"interval": 6, "unit": "hours"},
               "action_type": "process_wishlist", "action_config": {}, "then_actions": []}
    assert client.post("/api/automations", json=payload).status_code == 200
    assert store.month_usage(db)["drafts_saved"] == 0
    assert client.post("/api/automations", json={**payload, "assistant_draft": True}).status_code == 200
    assert store.month_usage(db)["drafts_saved"] == 1
