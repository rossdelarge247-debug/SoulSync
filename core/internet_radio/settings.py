"""Settings → Radio (boards 5b–5d): kept in the config under ``radio.*``.

The AcoustID key is the existing ``acoustid.api_key`` (the download
identifier's), stored encrypted with the app's other secrets; this module only
ever hands out a masked copy.

Scan now's paid services (AudD, ACRCloud) keep their keys under
``radio.audd_api_token`` and ``radio.acrcloud_*``, all four in
``ConfigManager._SENSITIVE_PATHS`` (encrypted at rest, masked in every
settings read). They're write-only here: a read says only whether each is set.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Optional

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


# ── Scan now's services ──────────────────────────────────────────────────────

AUDD_TOKEN = "radio.audd_api_token"
ACR_HOST = "radio.acrcloud_host"
ACR_KEY = "radio.acrcloud_access_key"
ACR_SECRET = "radio.acrcloud_access_secret"
SCAN_SECRET_PATHS = (AUDD_TOKEN, ACR_HOST, ACR_KEY, ACR_SECRET)
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_\-]{8,128}\Z")
# an ACRCloud project's host: identify-<region>.acrcloud.com, or another name
# under acrcloud.com; nothing else, so the setting can't point the server at
# an address of someone's choosing
_ACR_HOST_RE = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+acrcloud\.com\Z")


def acrcloud_host(raw: Any) -> Optional[str]:
    """The ACRCloud host, normalised, or None when it isn't one.

    A bare name under ``acrcloud.com`` (``identify-eu-west-1.acrcloud.com``);
    an ``https://`` in front and a trailing ``/`` are forgiven. Ports, paths,
    queries, user names, IP addresses and every other domain are refused.
    """
    if not isinstance(raw, str):
        return None
    host = raw.strip().lower()
    if host.startswith("https://"):
        host = host[len("https://"):]
    if host.endswith("/"):
        host = host[:-1]
    if not host or len(host) > 253 or not _ACR_HOST_RE.match(host):
        return None
    return host


def _secret(config, path: str) -> str:
    try:
        value = config.get(path, "") or ""
    except Exception:  # noqa: BLE001
        return ""
    return str(value).strip() if isinstance(value, str) else ""


def audd_token(config) -> str:
    return _secret(config, AUDD_TOKEN)


def acrcloud_credentials(config) -> Optional[Dict[str, str]]:
    """``{host, access_key, access_secret}`` when all three are set and the
    host is an ACRCloud one, else None."""
    host = acrcloud_host(_secret(config, ACR_HOST))
    key, secret = _secret(config, ACR_KEY), _secret(config, ACR_SECRET)
    if not (host and key and secret):
        return None
    return {"host": host, "access_key": key, "access_secret": secret}


def scan_services_public(config) -> Dict[str, Any]:
    """Whether each key is set; never the keys."""
    def state(path: str) -> Dict[str, Any]:
        return {"set": bool(_secret(config, path))}
    return {"audd_api_token": state(AUDD_TOKEN), "acrcloud_host": state(ACR_HOST),
            "acrcloud_access_key": state(ACR_KEY), "acrcloud_access_secret": state(ACR_SECRET),
            "audd_ready": bool(audd_token(config)), "acrcloud_ready": acrcloud_credentials(config) is not None}


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
    out["scan_services"] = scan_services_public(config)
    return out


def save(config, body: Any) -> Dict[str, Any]:
    """Validate everything first, then write; a bad value changes nothing."""
    return save_with_changes(config, body)[0]


def save_with_changes(config, body: Any):
    """``save``, also saying which services' keys were saved and which removed
    (``acoustid``, ``audd``, ``acrcloud``), for the dates Settings → Radio shows."""
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
    for field, path in (("audd_api_token", AUDD_TOKEN), ("acrcloud_access_key", ACR_KEY),
                        ("acrcloud_access_secret", ACR_SECRET)):
        if field in body:
            value = body[field]
            if value is not None and not isinstance(value, str):
                raise SettingsError("Keys are text.")
            value = (value or "").strip()
            if value:  # empty leaves the saved one alone; "remove" clears it
                if not _TOKEN_RE.match(value):
                    raise SettingsError({"audd_api_token": "That doesn't look like an AudD API token.",
                                         "acrcloud_access_key": "That doesn't look like an ACRCloud access key.",
                                         "acrcloud_access_secret": "That doesn't look like an ACRCloud access secret.",
                                         }[field])
                writes[path] = value
    if "acrcloud_host" in body:
        raw = body["acrcloud_host"]
        if raw is not None and not isinstance(raw, str):
            raise SettingsError("The ACRCloud host is text.")
        if (raw or "").strip():
            host = acrcloud_host(raw)
            if host is None:
                raise SettingsError("The ACRCloud host is the one your project shows, ending in .acrcloud.com "
                                    "(like identify-eu-west-1.acrcloud.com).")
            writes[ACR_HOST] = host
    removes = []
    if "remove" in body:
        names = body["remove"]
        if not isinstance(names, list) or any(n not in ("audd", "acrcloud") for n in names):
            raise SettingsError("Remove either “audd” or “acrcloud”.")
        if "audd" in names:
            removes.append(AUDD_TOKEN)
        if "acrcloud" in names:
            removes.extend((ACR_HOST, ACR_KEY, ACR_SECRET))
    for k, v in writes.items():
        config.set(k, v)
    for path in removes:
        if path not in writes:
            clear = getattr(config, "clear_secret", None)
            if clear is not None:
                clear(path)
    saved = set()
    if "acoustid.api_key" in writes:
        saved.add("acoustid")
    if AUDD_TOKEN in writes:
        saved.add("audd")
    if any(p in writes for p in (ACR_HOST, ACR_KEY, ACR_SECRET)):
        saved.add("acrcloud")
    removed = {name for name in (body.get("remove") or []) if name not in saved}
    return public(config), saved, removed


__all__ = ["DEFAULTS", "RELAY_CHOICES", "KEEP_CHOICES", "SettingsError", "read", "public", "save",
           "acoustid_key", "masked", "acrcloud_host", "save_with_changes", "audd_token", "acrcloud_credentials", "scan_services_public",
           "SCAN_SECRET_PATHS"]
