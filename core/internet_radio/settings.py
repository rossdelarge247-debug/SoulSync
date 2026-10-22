"""Settings → Radio (boards 5b–5d): kept in the config under ``radio.*``.

The AcoustID key is the existing ``acoustid.api_key`` (the download
identifier's), stored encrypted with the app's other secrets; this module only
ever hands out a masked copy.
"""

from __future__ import annotations

from typing import Any, Dict

DEFAULTS = {
    "identification": True,
    "daily_limit": 50,
    "relay": "when_needed",
    "prefer_lossless": True,
    "keep_heard_days": 90,
}
RELAY_CHOICES = ("when_needed", "always")
KEEP_CHOICES = (7, 30, 90, 365)
DAILY_LIMIT_MAX = 500


class SettingsError(ValueError):
    """A bad value; ``str()`` is the sentence to show."""


def _get(config, key: str) -> Any:
    try:
        value = config.get(f"radio.{key}", DEFAULTS[key])
    except Exception:  # noqa: BLE001 - an unreadable config reads as the default
        value = DEFAULTS[key]
    return DEFAULTS[key] if value is None else value


def read(config) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    out["identification"] = bool(_get(config, "identification"))
    try:
        limit = int(_get(config, "daily_limit"))
    except (TypeError, ValueError):
        limit = DEFAULTS["daily_limit"]
    out["daily_limit"] = max(1, min(DAILY_LIMIT_MAX, limit))
    relay = str(_get(config, "relay"))
    out["relay"] = relay if relay in RELAY_CHOICES else "when_needed"
    out["prefer_lossless"] = bool(_get(config, "prefer_lossless"))
    try:
        keep = int(_get(config, "keep_heard_days"))
    except (TypeError, ValueError):
        keep = DEFAULTS["keep_heard_days"]
    out["keep_heard_days"] = keep if keep in KEEP_CHOICES else DEFAULTS["keep_heard_days"]
    return out


def acoustid_key(config) -> str:
    try:
        return str(config.get("acoustid.api_key", "") or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def masked(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 6:
        return "•" * len(key)
    return f"{key[:4]}{'•' * 7}{key[-2:]}"


def public(config) -> Dict[str, Any]:
    out = read(config)
    key = acoustid_key(config)
    out["acoustid_api_key"] = {"set": bool(key), "masked": masked(key)}
    return out


def save(config, body: Any) -> Dict[str, Any]:
    """Validate everything first, then write; a bad value changes nothing."""
    if not isinstance(body, dict):
        raise SettingsError("Send the settings as an object.")
    writes: Dict[str, Any] = {}
    if "identification" in body:
        if not isinstance(body["identification"], bool):
            raise SettingsError("Track identification is on or off.")
        writes["radio.identification"] = body["identification"]
    if "daily_limit" in body:
        try:
            limit = int(body["daily_limit"])
        except (TypeError, ValueError):
            raise SettingsError("The daily limit is a number of tracks.") from None
        if limit < 1 or limit > DAILY_LIMIT_MAX:
            raise SettingsError(f"The daily limit is between 1 and {DAILY_LIMIT_MAX} tracks.")
        writes["radio.daily_limit"] = limit
    if "relay" in body:
        if body["relay"] not in RELAY_CHOICES:
            raise SettingsError("Relay is either “when needed” or “always”.")
        writes["radio.relay"] = body["relay"]
    if "prefer_lossless" in body:
        if not isinstance(body["prefer_lossless"], bool):
            raise SettingsError("Prefer lossless is on or off.")
        writes["radio.prefer_lossless"] = body["prefer_lossless"]
    if "keep_heard_days" in body:
        try:
            keep = int(body["keep_heard_days"])
        except (TypeError, ValueError):
            raise SettingsError("Keep Heard on radio for 7, 30, 90 or 365 days.") from None
        if keep not in KEEP_CHOICES:
            raise SettingsError("Keep Heard on radio for 7, 30, 90 or 365 days.")
        writes["radio.keep_heard_days"] = keep
    if "acoustid_api_key" in body:
        key = body["acoustid_api_key"]
        if key is not None and not isinstance(key, str):
            raise SettingsError("The AcoustID key is text.")
        key = (key or "").strip()
        if key:  # an empty key leaves the saved one alone
            if len(key) > 64 or not key.replace("-", "").replace("_", "").isalnum():
                raise SettingsError("That doesn't look like an AcoustID key.")
            writes["acoustid.api_key"] = key
    for k, v in writes.items():
        config.set(k, v)
    return public(config)


__all__ = ["DEFAULTS", "RELAY_CHOICES", "KEEP_CHOICES", "SettingsError", "read", "public", "save",
           "acoustid_key", "masked"]
