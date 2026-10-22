"""Module switches: turn whole optional areas of SoulSync off.

SoulSync started as a music app and grew video, podcasts, audiobooks, chat and
Sample Studio on top. Each of those is a *module* here, and an admin can turn a
module off for the whole install:

- its background starts are skipped (``web_server._deferred_start(...,
  module=...)``), and turning it off at runtime calls the stop methods its
  workers have;
- automations whose action or trigger belongs to it are skipped, and the run is
  recorded as ``skipped``, not as an error (``core/automation_engine.py``);
- its API answers 409 ``module_disabled`` (one path-prefix check in
  ``web_server._enforce_module_switches``).

This is a global, admin-level layer above the per-profile page list
(``profiles.allowed_pages``, ``core/permissions.py``): a module that is off is
off for every profile, admins included.

State lives in the config as ``modules.<name>.enabled``. A missing key means on,
so an install that predates the switches keeps every module, and an unreadable
config never turns anything off.

Some workers have no stop method. When turning a module off can't stop
everything it runs, the module reports ``restart_required`` (with a reason)
until it is turned back on or the process restarts.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

from utils.logging_config import get_logger

logger = get_logger("modules")

# What a runtime hook returns: None or True when the change took full effect,
# a reason string (or False) when a restart is needed to finish it.
HookResult = Union[None, bool, str]


@dataclass(frozen=True)
class ModuleSpec:
    name: str
    display_name: str
    description: str
    # API paths that belong to the module: a prefix owns itself and everything
    # below it ("/api/video" owns "/api/video/x", not "/api/videos").
    api_prefixes: Tuple[str, ...] = ()
    # API paths owned exactly (nothing below them).
    api_paths: Tuple[str, ...] = ()
    # Automation blocks that belong to the module.
    action_prefixes: Tuple[str, ...] = ()
    action_types: Tuple[str, ...] = ()
    trigger_prefixes: Tuple[str, ...] = ()
    trigger_types: Tuple[str, ...] = ()
    # Values of automations.owned_by that mean "this module's system row".
    owned_by: Tuple[str, ...] = ()
    # Shell page ids (VALID_PAGE_IDS / data-page / data-video-page) the UI
    # should hide while the module is off.
    pages: Tuple[str, ...] = ()

    def owns_path(self, path: str) -> bool:
        if path in self.api_paths:
            return True
        return any(path == p or path.startswith(p + "/") for p in self.api_prefixes)

    def owns_action(self, action_type: str) -> bool:
        return action_type in self.action_types or any(
            action_type.startswith(p) for p in self.action_prefixes)

    def owns_trigger(self, trigger_type: str) -> bool:
        return trigger_type in self.trigger_types or any(
            trigger_type.startswith(p) for p in self.trigger_prefixes)


_SPECS = (
    ModuleSpec(
        name="video",
        display_name="Video",
        description=("Movies, TV and YouTube: the video side's library, search, "
                     "calendar, wishlist and downloads, with its download monitor, "
                     "maintenance worker and video automations."),
        api_prefixes=("/api/video", "/api/v1/video"),
        action_prefixes=("video_",),
        trigger_prefixes=("video_",),
        owned_by=("video",),
        pages=("video-dashboard", "video-search", "video-discover", "video-calendar",
               "video-library", "video-watchlist", "video-wishlist", "video-downloads",
               "video-requests", "video-import", "video-automations", "video-tools",
               "video-settings", "video-issues", "video-help"),
    ),
    ModuleSpec(
        name="podcasts",
        display_name="Podcasts",
        description=("Podcast search, subscriptions and episode downloads, and the "
                     "scheduled scan of watchlisted podcasts."),
        api_prefixes=("/api/podcasts",),
        action_types=("scan_watchlist_podcasts",),
        pages=("podcasts",),
    ),
    ModuleSpec(
        name="audiobooks",
        display_name="Audiobooks",
        description=("Audiobook search, library, wishlist, followed authors and "
                     "downloads, with the audiobook download monitor and automations."),
        api_prefixes=("/api/audiobooks",),
        action_prefixes=("audiobook_",),
        trigger_prefixes=("audiobook_",),
        pages=("audiobooks",),
    ),
    ModuleSpec(
        name="chat",
        display_name="Chat & Arcade",
        description=("Soulseek chat rooms and private messages, the community room "
                     "auto-join and the arcade games. Automatic replies to download "
                     "challenges keep working while it is off."),
        api_prefixes=("/api/chat",),
        pages=("chat", "video-chat"),
    ),
    ModuleSpec(
        name="sample_studio",
        display_name="Sample Studio",
        description=("Waveform analysis, chopping and stem separation for library "
                     "tracks. While it is off, newly imported tracks are not queued "
                     "for analysis."),
        api_prefixes=("/api/sample", "/api/v1/sample"),
        # The Studio's library panel. Only the Studio calls these two; the
        # other /api/library/tracks/* routes are the library's own.
        api_paths=("/api/library/tracks", "/api/library/tracks/recent"),
        pages=("sample-studio",),
    ),
    ModuleSpec(
        name="radio",
        display_name="Internet radio",
        description=("Free internet radio stations with what's playing identified, the Heard on radio "
                     "list, auto-add to Wanted, tracklists and stream links. While it is off nothing is "
                     "relayed or watched."),
        api_prefixes=("/api/radio",),
        trigger_types=("radio_track_heard",),
        pages=("radio",),
    ),
)

MODULES: Dict[str, ModuleSpec] = {spec.name: spec for spec in _SPECS}

_FALSE = frozenset({"0", "false", "no", "off"})

_lock = threading.RLock()
_hooks: Dict[str, Tuple[Optional[Callable[[], HookResult]],
                        Optional[Callable[[], HookResult]]]] = {}
_restart_reasons: Dict[str, str] = {}


def _spec(name: str) -> ModuleSpec:
    spec = MODULES.get(name)
    if spec is None:
        raise KeyError(f"unknown module {name!r}")
    return spec


def _config():
    from core.settings import config_manager
    return config_manager


def config_key(name: str) -> str:
    return f"modules.{_spec(name).name}.enabled"


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        # only an explicit "off" word turns a module off; junk reads as on
        return value.strip().lower() not in _FALSE
    if isinstance(value, (int, float)):
        return bool(value)
    return True


def is_enabled(name: str, config=None) -> bool:
    """Is the module on? Missing or unreadable config means on."""
    key = config_key(name)
    try:
        value = (config or _config()).get(key, True)
    except Exception as exc:  # noqa: BLE001 - a config hiccup never turns a module off
        logger.debug("reading %s failed: %s", key, exc)
        return True
    return _as_bool(value)


def display_name(name: str) -> str:
    return _spec(name).display_name


# ── ownership ────────────────────────────────────────────────────────────────

def module_for_path(path: str) -> Optional[str]:
    path = path or ""
    for spec in _SPECS:
        if spec.owns_path(path):
            return spec.name
    return None


def disabled_module_for_path(path: str, config=None) -> Optional[str]:
    """The module that owns this API path, when that module is off."""
    name = module_for_path(path)
    if name is not None and not is_enabled(name, config):
        return name
    return None


def modules_for_automation(auto: Any) -> List[str]:
    """Every module an automation row (or blocks dict) depends on."""
    if not isinstance(auto, dict):
        return []
    action = str(auto.get("action_type") or "")
    trigger = str(auto.get("trigger_type") or "")
    owner = str(auto.get("owned_by") or "")
    found = []
    for spec in _SPECS:
        if ((action and spec.owns_action(action))
                or (trigger and spec.owns_trigger(trigger))
                or (owner and owner in spec.owned_by)):
            found.append(spec.name)
    return found


def disabled_module_for_automation(auto: Any, config=None) -> Optional[str]:
    """The first module this automation depends on that is off, or None."""
    for name in modules_for_automation(auto):
        if not is_enabled(name, config):
            return name
    return None


def module_for_block(block_type: str) -> Optional[str]:
    """The module an automation trigger/action type belongs to, or None."""
    block_type = str(block_type or "")
    for spec in _SPECS:
        if block_type and (spec.owns_action(block_type) or spec.owns_trigger(block_type)):
            return spec.name
    return None


def disabled_payload(name: str) -> Dict[str, Any]:
    """The body every route of a turned-off module answers with (409)."""
    spec = _spec(name)
    return {
        "success": False,
        "error": "module_disabled",
        "module": spec.name,
        "message": f"{spec.display_name} is turned off. An admin can turn it back on in Settings.",
    }


# ── runtime switching ────────────────────────────────────────────────────────

def register_runtime_hooks(name: str, *, on_enable: Optional[Callable[[], HookResult]] = None,
                           on_disable: Optional[Callable[[], HookResult]] = None) -> None:
    """What turning the module on/off does to the running process.

    Each hook returns None/True when the change took full effect, or a reason
    string (False for a generic one) when a restart is needed to finish it.
    """
    _spec(name)
    with _lock:
        _hooks[name] = (on_enable, on_disable)


def _run_hook(name: str, enabled: bool) -> Optional[str]:
    on_enable, on_disable = _hooks.get(name, (None, None))
    hook = on_enable if enabled else on_disable
    if hook is None:
        return None
    try:
        result = hook()
    except Exception as exc:  # noqa: BLE001 - report it; the setting itself is saved
        logger.exception("turning %s %s failed", name, "on" if enabled else "off")
        return f"Applying the change failed ({exc}); restart SoulSync to finish it."
    if result is None or result is True:
        return None
    if isinstance(result, str) and result.strip():
        return result.strip()
    return "Restart SoulSync to finish applying this change."


def set_enabled(name: str, enabled: bool, config=None) -> Dict[str, Any]:
    """Turn a module on or off, apply it to the running process, return its state.

    Re-saving the value it already has is a no-op for the running process.
    """
    _spec(name)
    enabled = bool(enabled)
    cfg = config or _config()
    with _lock:
        changed = is_enabled(name, cfg) != enabled
        cfg.set(config_key(name), enabled)
        if changed:
            reason = _run_hook(name, enabled)
            if reason:
                _restart_reasons[name] = reason
            else:
                _restart_reasons.pop(name, None)
            logger.info("Module %s turned %s%s", name, "on" if enabled else "off",
                        f" (restart required: {reason})" if reason else "")
    return module_state(name, cfg)


def restart_reason(name: str) -> Optional[str]:
    # No lock: a toggle holds it while its hook stops workers (seconds), and
    # reading the state must not wait for that.
    _spec(name)
    return _restart_reasons.get(name)


def module_state(name: str, config=None) -> Dict[str, Any]:
    spec = _spec(name)
    reason = restart_reason(name)
    return {
        "name": spec.name,
        "display_name": spec.display_name,
        "description": spec.description,
        "enabled": is_enabled(name, config),
        "default_enabled": True,
        "restart_required": reason is not None,
        "restart_reason": reason,
        "pages": list(spec.pages),
    }


def list_modules(config=None) -> List[Dict[str, Any]]:
    return [module_state(spec.name, config) for spec in _SPECS]


__all__ = [
    "MODULES", "ModuleSpec", "config_key", "is_enabled", "display_name",
    "module_for_path", "disabled_module_for_path", "modules_for_automation",
    "disabled_module_for_automation", "module_for_block", "disabled_payload",
    "register_runtime_hooks", "set_enabled", "restart_reason", "module_state",
    "list_modules",
]
