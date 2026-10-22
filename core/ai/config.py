"""Settings → AI: what's stored, what the browser may see, and the prices.

Everything lives in the app's config under ``ai.*``. The API key is
``ai.anthropic_api_key``, one of ``ConfigManager._SENSITIVE_PATHS``: it's
encrypted at rest with the app's other secrets, ``redacted_config()`` masks
it, and nothing here ever returns it. Other providers would get their own
``ai.<provider>_api_key`` path.

The legacy Settings page's own save only writes the sections it lists, so it
never touches ``ai.*``; Settings → AI saves through ``PUT /api/ai/settings``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

PROVIDERS = {
    "anthropic": {
        "name": "Anthropic",
        "label": "Anthropic (Claude)",
        "key_path": "ai.anthropic_api_key",
        "key_prefix": "sk-ant-",
    },
}
DEFAULT_PROVIDER = "anthropic"

# Two choices on Settings → AI. "fast" is the default (Ross, 22 October).
# Prices are the provider's list prices per million tokens, used only for the
# local estimate on the Usage card. cache_write is the 5-minute cache write.
MODELS: Dict[str, Dict[str, Any]] = {
    "fast": {
        "id": "claude-sonnet-5-5",
        "label": "Faster and cheaper",
        "name": "Claude Sonnet",
        "description": "Enough for drafts, suggestions and explanations; answers in a few seconds. The default.",
        "price": {"input": 2.00, "output": 10.00, "cache_read": 0.20, "cache_write": 2.50},
    },
    "best": {
        "id": "claude-opus-5-5",
        "label": "Best answers",
        "name": "Claude Opus",
        "description": "Better at long run logs and vague requests; slower and several times the cost.",
        "price": {"input": 4.00, "output": 20.00, "cache_read": 0.20, "cache_write": 5.00},
    },
}
DEFAULT_MODEL = "fast"
WHO_CAN_USE = ("admins", "everyone")
DEFAULT_WHO = "admins"
MAX_CAP_USD = 10_000.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def provider(config) -> str:
    value = str(config.get("ai.provider", DEFAULT_PROVIDER) or DEFAULT_PROVIDER)
    return value if value in PROVIDERS else DEFAULT_PROVIDER


def api_key(config) -> str:
    """The stored key, decrypted. Server side only: never put it in a response
    or a log line."""
    return str(config.get(PROVIDERS[provider(config)]["key_path"], "") or "").strip()


def model_key(config) -> str:
    value = str(config.get("ai.model", DEFAULT_MODEL) or DEFAULT_MODEL)
    return value if value in MODELS else DEFAULT_MODEL


def model_id(config) -> str:
    return MODELS[model_key(config)]["id"]


def who_can_use(config) -> str:
    value = str(config.get("ai.who_can_use", DEFAULT_WHO) or DEFAULT_WHO)
    return value if value in WHO_CAN_USE else DEFAULT_WHO


def monthly_cap(config) -> Optional[float]:
    value = config.get("ai.monthly_cap_usd", None)
    try:
        cap = float(value)
    except (TypeError, ValueError):
        return None
    return cap if cap > 0 else None


def masked_key(key: str) -> str:
    """"sk-ant-••••…3f9": the prefix and the last three characters, so an admin
    can tell which key is saved without the browser ever holding it."""
    if not key:
        return ""
    prefix = "sk-ant-" if key.startswith("sk-ant-") else ""
    return f"{prefix}{'•' * 20}{key[-3:]}"


def key_status(config) -> Dict[str, Any]:
    state = str(config.get("ai.key_state", "") or "")
    if not api_key(config):
        state = "missing"
    elif state not in ("ok", "refused"):
        state = "untested"
    return {
        "state": state,
        "message": config.get("ai.key_message", None) or None,
        "tested_at": config.get("ai.key_tested_at", None) or None,
        "tested_by": config.get("ai.key_tested_by", None) or None,
        "added_at": config.get("ai.key_added_at", None) or None,
        "added_by": config.get("ai.key_added_by", None) or None,
    }


def public_settings(config) -> Dict[str, Any]:
    """Settings as GET /api/ai/settings returns them. The key is write-only."""
    key = api_key(config)
    return {
        "provider": provider(config),
        "api_key": {"set": bool(key), "masked": masked_key(key)},
        "model": model_key(config),
        "who_can_use": who_can_use(config),
        "monthly_cap_usd": monthly_cap(config),
        "key_status": key_status(config),
    }


def catalogue() -> Dict[str, Any]:
    """The choices Settings → AI draws: providers and the two model cards."""
    return {
        "providers": [{"value": k, "label": v["label"], "name": v["name"]} for k, v in PROVIDERS.items()],
        "models": [{"value": k, "label": v["label"], "name": v["name"], "description": v["description"]}
                   for k, v in MODELS.items()],
    }


class SettingsError(ValueError):
    """A value Settings → AI can't save; the message is the sentence to show."""


def save_settings(config, patch: Dict[str, Any], *, actor: str) -> Dict[str, Any]:
    """Apply a PUT /api/ai/settings body. Returns the public settings.

    A new key resets its test status ("untested") and records who added it.
    An empty or missing ``api_key`` keeps the stored one (the settings page
    never round-trips the key), exactly as ``ConfigManager.set`` does for
    every secret. Raises SettingsError for a value it won't store.
    """
    if not isinstance(patch, dict):
        raise SettingsError("Send the settings as an object.")
    updates: Dict[str, Any] = {}
    if "provider" in patch:
        value = str(patch.get("provider") or "")
        if value not in PROVIDERS:
            raise SettingsError("Choose a provider from the list.")
        updates["ai.provider"] = value
    if "model" in patch:
        value = str(patch.get("model") or "")
        if value not in MODELS:
            raise SettingsError("Choose Faster and cheaper or Best answers.")
        updates["ai.model"] = value
    if "who_can_use" in patch:
        value = str(patch.get("who_can_use") or "")
        if value not in WHO_CAN_USE:
            raise SettingsError("Choose who can use the Assistant: admins or everyone.")
        updates["ai.who_can_use"] = value
    if "monthly_cap_usd" in patch:
        raw = patch.get("monthly_cap_usd")
        if raw in (None, "", 0, "0"):
            updates["ai.monthly_cap_usd"] = None
        else:
            try:
                cap = round(float(str(raw).strip().lstrip("$")), 2)
            except (TypeError, ValueError):
                raise SettingsError("Write the cap as an amount in dollars, like 10.") from None
            if cap <= 0 or cap > MAX_CAP_USD:
                raise SettingsError("Write the cap as an amount between $1 and $10,000.")
            updates["ai.monthly_cap_usd"] = cap
    new_key = patch.get("api_key")
    key_path = PROVIDERS[str(updates.get("ai.provider") or provider(config))]["key_path"]
    if isinstance(new_key, str) and new_key.strip() and new_key.strip() != getattr(
            config, "REDACTED_SENTINEL", "__redacted_unchanged__"):
        key = new_key.strip()
        if len(key) > 400 or any(c.isspace() for c in key):
            raise SettingsError("That doesn't look like an API key. Paste the whole key, without spaces.")
        updates[key_path] = key
        updates["ai.key_added_at"] = _now_iso()
        updates["ai.key_added_by"] = actor
        updates["ai.key_state"] = "untested"
        updates["ai.key_message"] = None
        updates["ai.key_tested_at"] = None
        updates["ai.key_tested_by"] = None
    batch = getattr(config, "batch", None)
    if callable(batch):
        with batch():
            for path, value in updates.items():
                config.set(path, value)
    else:
        for path, value in updates.items():
            config.set(path, value)
    return public_settings(config)


def record_key_test(config, *, ok: bool, message: str, actor: str) -> Dict[str, Any]:
    """Store what the last test (or a refused call) said about the key."""
    values = {
        "ai.key_state": "ok" if ok else "refused",
        "ai.key_message": message,
        "ai.key_tested_at": _now_iso(),
        "ai.key_tested_by": actor,
    }
    batch = getattr(config, "batch", None)
    if callable(batch):
        with batch():
            for path, value in values.items():
                config.set(path, value)
    else:
        for path, value in values.items():
            config.set(path, value)
    return key_status(config)


def estimate_cost_usd(model: str, usage: Dict[str, int]) -> float:
    """The list-price cost of one request from its token counts. ``model`` is
    a key of MODELS or a model id; an unknown one is priced as the default."""
    entry = MODELS.get(model) or next((m for m in MODELS.values() if m["id"] == model), MODELS[DEFAULT_MODEL])
    price = entry["price"]
    total = (
        int(usage.get("input_tokens") or 0) * price["input"]
        + int(usage.get("output_tokens") or 0) * price["output"]
        + int(usage.get("cache_read_tokens") or 0) * price["cache_read"]
        + int(usage.get("cache_write_tokens") or 0) * price["cache_write"]
    )
    return round(total / 1_000_000, 6)
