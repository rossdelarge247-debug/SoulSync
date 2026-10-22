"""Every draft the Assistant sends is checked here first.

A draft is exactly the body ``POST /api/automations/preview`` takes, plus the
two parts that body ignores and the editor needs (``name``, the trigger):

    {"name", "trigger_type", "trigger_config", "action_type", "action_config", "then_actions"}

The check (``clean_draft``):

- keeps only blocks from ``blocks_for_scope('music')``: the trigger from
  ``triggers``, the action from ``actions``, follow-ups from
  ``notifications``;
- keeps only settings each block declares, with values that fit the field
  (a number in range, a choice from the options, a time as HH:MM, a playlist
  the profile has, a script that's in the scripts folder);
- for a member, drops any step ``needs_admin()`` (core/automation/api.py)
  marks: a script, clean-up, repair, backup, purge or video step, and says so
  in ``notes``; an action like that leaves no draft at all;
- never turns on "Act without a preview" (``confirm``): a draft always runs
  in plan mode until the person changes it;
- caps follow-ups at three, the engine's limit.

``from_tool`` turns the model's When / Do / Then tool input into that shape.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

from core.automation.api import needs_admin

MAX_THEN = 3
MAX_TEXT = 500
MAX_NAME = 80
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
FIELD_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
SIGNAL_RE = re.compile(r"[^a-z0-9_-]")
OPERATORS = ("contains", "equals", "not_equals", "starts_with", "ends_with", "not_contains",
             "greater_than", "less_than")
TIMED_TRIGGERS = ("schedule", "daily_time", "weekly_time", "monthly_time")

# The follow-up settings the editor shows (webui …/editor-fields.tsx THEN_FIELDS);
# the notification blocks don't declare them in blocks.py.
NOTIFY_FIELDS: Dict[str, Tuple[str, ...]] = {
    "discord_webhook": ("webhook_url", "message"),
    "pushbullet": ("access_token", "title", "message"),
    "telegram": ("bot_token", "chat_id", "message", "thread_id"),
    "ntfy": ("topic", "title", "message", "server", "priority", "tags", "token", "username", "password"),
    "gotify": ("server", "token", "title", "message", "priority"),
    "webhook": ("url", "message", "headers", "payload_template"),
}
# Secrets in a follow-up's settings: never sent to the provider (context.py)
# and never taken from a draft, which only the person fills in.
NOTIFY_SECRETS = frozenset({"webhook_url", "access_token", "bot_token", "chat_id", "token", "password",
                            "username", "url", "headers", "server", "thread_id", "topic"})


def _text(value: Any, limit: int = MAX_TEXT) -> str:
    if isinstance(value, bool):
        value = "true" if value else "false"
    if isinstance(value, (int, float)):
        value = str(value)
    if not isinstance(value, str):
        return ""
    # control characters other than newline and tab go
    cleaned = "".join(ch for ch in value if ch in "\n\t" or ord(ch) >= 32)
    return cleaned.strip()[:limit]


def _truthy(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() not in ("", "0", "false", "no", "off")
    return bool(value)


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def _field_value(field: Dict[str, Any], raw: Any, ctx: "_Ctx") -> Tuple[bool, Any]:
    """(ok, value) for one declared setting."""
    kind = field.get("type")
    if kind == "number":
        n = _number(raw)
        if n is None:
            return False, None
        if field.get("min") is not None and n < float(field["min"]):
            return False, None
        if field.get("max") is not None and n > float(field["max"]):
            return False, None
        return True, int(n) if float(n).is_integer() else n
    if kind == "checkbox":
        return True, _truthy(raw)
    if kind == "select":
        value = _text(raw, 100)
        options = [str(o.get("value")) for o in field.get("options") or []]
        return (value in options), value
    if kind == "multi_select":
        items = raw if isinstance(raw, list) else [p.strip() for p in _text(raw).split(",")]
        options = {str(o.get("value")) for o in field.get("options") or []}
        picked = [str(i) for i in items if str(i) in options]
        if not picked and items and any(str(i).strip() for i in items):
            return False, None
        return True, list(dict.fromkeys(picked))
    if kind == "time":
        value = _text(raw, 5)
        return bool(TIME_RE.match(value)), value
    if kind == "text":
        return True, _text(raw, 200)
    if kind == "signal_input":
        value = SIGNAL_RE.sub("_", _text(raw, 60).lower()).strip("_")
        value = re.sub(r"_+", "_", value)
        return bool(value), value
    if kind == "mirrored_playlist_select":
        value = _text(raw, 40)
        return (value in ctx.playlist_ids), value
    if kind == "script_select":
        value = _text(raw, 200)
        return (ctx.is_admin and value in ctx.scripts), value
    # personalized playlist picks and anything newer: only the full builder sets them
    return False, None


class _Ctx:
    def __init__(self, *, is_admin: bool, playlist_ids: Iterable[str] = (), scripts: Iterable[str] = ()):
        self.is_admin = bool(is_admin)
        self.playlist_ids = {str(p) for p in playlist_ids}
        self.scripts = {str(s) for s in scripts}


def _index(blocks: Dict[str, Any], kind: str) -> Dict[str, Dict[str, Any]]:
    return {b["type"]: b for b in blocks.get(kind) or [] if isinstance(b, dict) and b.get("type")}


def _settings(raw: Any) -> Dict[str, Any]:
    """Settings as a dict, from a dict or the tool's [{key, value}] pairs."""
    if isinstance(raw, dict):
        return dict(raw)
    out: Dict[str, Any] = {}
    if isinstance(raw, list):
        for pair in raw:
            if isinstance(pair, dict) and isinstance(pair.get("key"), str):
                out[pair["key"]] = pair.get("value")
    return out


def _conditions(raw: Any, allowed_fields: Optional[Iterable[str]] = None) -> List[Dict[str, str]]:
    allowed = set(allowed_fields) if allowed_fields is not None else None
    out: List[Dict[str, str]] = []
    for c in raw if isinstance(raw, list) else []:
        if not isinstance(c, dict):
            continue
        field = _text(c.get("field"), 40)
        operator = _text(c.get("operator"), 20) or "contains"
        if not FIELD_RE.match(field) or operator not in OPERATORS:
            continue
        if allowed is not None and field not in allowed:
            continue
        out.append({"field": field, "operator": operator, "value": _text(c.get("value"), 200)})
    return out[:5]


def label_for(blocks: Dict[str, Any], kind: str, block_type: str) -> str:
    block = _index(blocks, kind).get(block_type) or {}
    return str(block.get("label") or block_type.replace("_", " "))


def clean_draft(raw: Any, blocks: Dict[str, Any], *, is_admin: bool, playlist_ids: Iterable[str] = (),
                scripts: Iterable[str] = ()) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    """``(draft, notes)``. ``draft`` is None when nothing buildable is left
    (no valid action); ``notes`` are plain sentences about what was left out."""
    ctx = _Ctx(is_admin=is_admin, playlist_ids=playlist_ids, scripts=scripts)
    notes: List[str] = []
    if not isinstance(raw, dict):
        return None, ["The draft didn't come back in a shape I can use."]
    triggers = _index(blocks, "triggers")
    actions = _index(blocks, "actions")
    notifications = _index(blocks, "notifications")

    # ── Do ──
    action_type = _text(raw.get("action_type"), 60)
    action = actions.get(action_type)
    if action is None:
        return None, [f"“{action_type or 'nothing'}” isn't something an automation can do here."]
    if not ctx.is_admin and needs_admin(action_type):
        return None, [f"“{label_for(blocks, 'actions', action_type)}” is for admins only, so I can't put it "
                      "in a draft for you."]
    fields = {f["key"]: f for f in action.get("config_fields") or [] if isinstance(f, dict) and f.get("key")}
    action_config: Dict[str, Any] = {}
    for key, value in _settings(raw.get("action_config")).items():
        if key == "delay":
            n = _number(value)
            if n is not None and 0 < n <= 24 * 60:
                action_config["delay"] = int(n)
            continue
        field = fields.get(key)
        if field is None:
            continue
        if key == "confirm":
            # a draft never acts without a preview; the person can switch it on
            action_config["confirm"] = False
            continue
        ok, cleaned = _field_value(field, value, ctx)
        if ok:
            action_config[key] = cleaned
        else:
            notes.append(f"I left out the setting “{field.get('label') or key}”: its value didn't fit.")
    if action_type == "run_script":
        given = _settings(raw.get("action_config"))
        name = _text(given.get("script_name"), 200)
        if ctx.is_admin and name in ctx.scripts:
            action_config["script_name"] = name
        timeout = _number(given.get("timeout"))
        action_config["timeout"] = int(timeout) if timeout and 5 <= timeout <= 300 else 60
    if "confirm" in fields:
        action_config["confirm"] = False

    # ── When ──
    trigger_type = _text(raw.get("trigger_type"), 60) or "schedule"
    trigger = triggers.get(trigger_type)
    if trigger is None:
        notes.append(f"“{trigger_type}” isn't a way automations start here, so it runs every 6 hours. "
                     "Change When in the editor.")
        trigger_type, trigger = "schedule", triggers.get("schedule") or {"config_fields": []}
    trigger_config: Dict[str, Any] = {}
    raw_trigger = _settings(raw.get("trigger_config"))
    for field in trigger.get("config_fields") or []:
        key = field.get("key")
        if key not in raw_trigger:
            if field.get("default") is not None and trigger_type in TIMED_TRIGGERS:
                trigger_config[key] = field["default"]
            continue
        ok, cleaned = _field_value(field, raw_trigger[key], ctx)
        if ok:
            trigger_config[key] = cleaned
        elif field.get("default") is not None:
            trigger_config[key] = field["default"]
    if trigger_type == "weekly_time" and "days" not in trigger_config:
        trigger_config["days"] = []
    if trigger_type == "monthly_time" and not trigger_config.get("tz"):
        trigger_config.pop("tz", None)
    if trigger.get("has_conditions"):
        conditions = _conditions(raw_trigger.get("conditions") or raw.get("conditions"),
                                 trigger.get("condition_fields") or [])
        if conditions:
            trigger_config["conditions"] = conditions
            trigger_config["match"] = "any" if raw_trigger.get("match") == "any" else "all"
    if trigger_type == "signal_received" and not trigger_config.get("signal_name"):
        notes.append("The signal it listens for needs a name; add it in the editor.")

    # ── Then ──
    then_actions: List[Dict[str, Any]] = []
    raw_then = raw.get("then_actions") if isinstance(raw.get("then_actions"), list) else []
    if len(raw_then) > MAX_THEN:
        notes.append("An automation takes at most three follow-ups, so I kept the first three.")
    for item in raw_then:
        if len(then_actions) >= MAX_THEN:
            break
        if not isinstance(item, dict):
            continue
        ttype = _text(item.get("type"), 60)
        block = notifications.get(ttype)
        if block is None:
            notes.append(f"“{ttype or 'a step'}” can't follow an action, so I left it out.")
            continue
        if not ctx.is_admin and needs_admin(ttype):
            notes.append(f"I left out “{label_for(blocks, 'notifications', ttype)}”: it's for admins only.")
            continue
        settings = _settings(item.get("config"))
        config: Dict[str, Any] = {}
        if ttype in NOTIFY_FIELDS:
            for key in NOTIFY_FIELDS[ttype]:
                if key in settings and key not in NOTIFY_SECRETS:
                    value = _text(settings[key])
                    if value:
                        config[key] = value
        else:
            declared = {f["key"]: f for f in block.get("config_fields") or [] if f.get("key")}
            for key, value in settings.items():
                field = declared.get(key)
                if field is None:
                    continue
                ok, cleaned = _field_value(field, value, ctx)
                if ok:
                    config[key] = cleaned
            if ttype == "run_script":
                timeout = _number(settings.get("timeout"))
                config["timeout"] = int(timeout) if timeout and 5 <= timeout <= 300 else 60
        entry: Dict[str, Any] = {"type": ttype, "config": config}
        conditions = _conditions(item.get("conditions"))
        if conditions:
            entry["conditions"] = conditions
        then_actions.append(entry)

    name = _text(raw.get("name"), MAX_NAME) or "New automation"
    draft = {
        "name": name,
        "trigger_type": trigger_type,
        "trigger_config": trigger_config,
        "action_type": action_type,
        "action_config": action_config,
        "then_actions": then_actions,
    }
    return draft, notes


def from_tool(obj: Any) -> Dict[str, Any]:
    """The model's ``{name, when, do, then}`` into the draft shape (before
    ``clean_draft``). Missing parts come through empty, for the check to judge."""
    if not isinstance(obj, dict):
        return {}
    when = obj.get("when") if isinstance(obj.get("when"), dict) else {}
    do = obj.get("do") if isinstance(obj.get("do"), dict) else {}
    then = obj.get("then") if isinstance(obj.get("then"), list) else []
    trigger_config = _settings(when.get("settings"))
    if when.get("conditions"):
        trigger_config["conditions"] = when.get("conditions")
        trigger_config["match"] = when.get("match") or "all"
    action_config = _settings(do.get("settings"))
    wait = _number(do.get("wait_minutes"))
    if wait:
        action_config["delay"] = wait
    then_actions = []
    for step in then:
        if not isinstance(step, dict):
            continue
        then_actions.append({"type": step.get("type"), "config": _settings(step.get("settings")),
                             "conditions": step.get("only_when") or []})
    return {
        "name": obj.get("name"),
        "trigger_type": when.get("type"),
        "trigger_config": trigger_config,
        "action_type": do.get("type"),
        "action_config": action_config,
        "then_actions": then_actions,
    }


def strip_secrets(then_actions: Any) -> List[Dict[str, Any]]:
    """Follow-ups with their credentials taken out, for the provider."""
    out = []
    for item in then_actions if isinstance(then_actions, list) else []:
        if not isinstance(item, dict):
            continue
        config = item.get("config") if isinstance(item.get("config"), dict) else {}
        kept = {k: _text(v, 300) for k, v in config.items() if k not in NOTIFY_SECRETS}
        filled = sorted(k for k, v in config.items() if k in NOTIFY_SECRETS and v)
        entry = {"type": item.get("type"), "config": kept}
        if filled:
            entry["set_up"] = filled          # which credentials are filled in, not their values
        if item.get("conditions"):
            entry["conditions"] = item.get("conditions")
        out.append(entry)
    return out
