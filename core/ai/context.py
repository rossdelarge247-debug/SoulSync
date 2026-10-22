"""The facts one Assistant request sends, read as the asking profile.

Everything is read the way the existing routes read it for that profile:
its automations and the built-in ones (``get_automations(profile_id)``, as
``GET /api/automations``), a focused automation or run only when
``automation_for_viewer`` says the profile sees it (as the preview route),
its Wanted, mirrored playlists and targets (``build_summary(db, profile_id)``,
as ``GET /api/targets/summary``). Setup check results and the scripts folder
are admin-only, as their routes are.

Library text (names, run logs, Wanted items) is data: it's serialised as JSON
with ``<``, ``>`` and ``&`` escaped, so nothing in it can close the
``<library_data>`` block it travels in, and the system prompt says to treat
it as information only. Follow-up credentials are never included
(``drafts.strip_secrets``). The whole block is capped at ``MAX_CHARS``.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from core.ai import drafts as _drafts

logger = logging.getLogger(__name__)

MAX_AUTOMATIONS = 40
MAX_RUNS = 10
MAX_LOG_LINES = 40
QUOTE_LINES = 8
MAX_LINE = 240
MAX_CHARS = 24_000
STALE_WANTED_DAYS = 30


@dataclass
class Facts:
    data: Dict[str, Any]
    reading: str
    quote: Optional[Dict[str, Any]] = None
    playlist_ids: List[str] = field(default_factory=list)
    scripts: List[str] = field(default_factory=list)
    automation: Optional[Dict[str, Any]] = None


def _short(value: Any, limit: int = 300) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _json(value: Any, default: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    try:
        parsed = json.loads(value) if value else default
    except (TypeError, ValueError):
        return default
    return parsed if parsed is not None else default


def _automation_summary(auto: Dict[str, Any]) -> Dict[str, Any]:
    action_config = dict(_json(auto.get("action_config"), {}))
    return {
        "id": auto.get("id"),
        "name": _short(auto.get("name"), 120),
        "built_in": bool(auto.get("is_system")),
        "on": bool(auto.get("enabled")),
        "paused_since": auto.get("paused_at") if not auto.get("enabled") else None,
        "group": _short(auto.get("group_name"), 60),
        "when": {"type": auto.get("trigger_type"), "settings": _json(auto.get("trigger_config"), {})},
        "do": {"type": auto.get("action_type"),
               "settings": {k: _short(v, 120) if isinstance(v, str) else v for k, v in action_config.items()}},
        "then": _drafts.strip_secrets(_json(auto.get("then_actions"), [])),
        "last_run": auto.get("last_run"),
        "next_run": auto.get("next_run"),
        "last_error": _short(auto.get("last_error"), 200),
        "runs_total": auto.get("run_count"),
    }


def _run_summary(run: Dict[str, Any]) -> Dict[str, Any]:
    result = _json(run.get("result_json"), {})
    kept = {k: result[k] for k in ("found", "searched", "counts", "status", "reason", "error")
            if isinstance(result, dict) and k in result}
    return {
        "run_id": run.get("id"),
        "status": run.get("status"),
        "started_at": run.get("started_at"),
        "duration_seconds": run.get("duration_seconds"),
        "summary": _short(run.get("summary"), 200),
        "result": kept or None,
    }


def _log_lines(run: Dict[str, Any], limit: int = MAX_LOG_LINES) -> List[str]:
    lines = _json(run.get("log_lines"), [])
    out = []
    for line in lines[-limit:] if isinstance(lines, list) else []:
        if isinstance(line, dict):
            out.append(_short(line.get("text"), MAX_LINE) or "")
        elif isinstance(line, str):
            out.append(_short(line, MAX_LINE) or "")
    return out


def _run_row(database, run_id: int) -> Optional[Dict[str, Any]]:
    try:
        with database._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT id, automation_id, started_at, finished_at, duration_seconds, status, summary, "
                "result_json, log_lines FROM automation_run_history WHERE id = ?", (int(run_id),))
            row = cursor.fetchone()
            if row is None:
                return None
            cols = [d[0] for d in cursor.description]
            return dict(zip(cols, tuple(row), strict=False))
    except Exception as exc:  # noqa: BLE001
        logger.debug("run %s unreadable: %s", run_id, exc)
        return None


def _wanted_facts(database, profile_id: int) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    try:
        with database._get_connection() as conn:
            row = conn.execute(
                "SELECT COUNT(*), "
                "SUM(CASE WHEN date_added < datetime('now', ?) THEN 1 ELSE 0 END), "
                "SUM(CASE WHEN date_added < datetime('now', ?) AND COALESCE(retry_count, 0) > 0 "
                "THEN 1 ELSE 0 END) FROM wishlist_tracks WHERE profile_id = ?",
                (f"-{STALE_WANTED_DAYS} days", f"-{STALE_WANTED_DAYS} days", int(profile_id))).fetchone()
        out = {"tracks": int(row[0] or 0), "older_than_30_days": int(row[1] or 0),
               "tried_and_not_found_after_30_days": int(row[2] or 0)}
    except Exception as exc:  # noqa: BLE001
        logger.debug("wanted facts unreadable: %s", exc)
    return out


def stale_wanted_count(database, profile_id: int) -> int:
    """Wanted tracks on the list for over 30 days, tried and not found."""
    return int(_wanted_facts(database, profile_id).get("tried_and_not_found_after_30_days") or 0)


def _targets(database, profile_id: int) -> List[Dict[str, Any]]:
    try:
        from core.targets.summary import build_summary
        summary = build_summary(database, int(profile_id))
    except Exception as exc:  # noqa: BLE001
        logger.debug("targets unreadable: %s", exc)
        return []
    keep = ("key", "set_up", "items", "have", "in_progress", "not_found_yet", "status", "reason",
            "artists", "playlists", "name", "schedule_paused")
    return [{k: t.get(k) for k in keep if k in t} for t in summary.get("targets", [])]


def _modules(config) -> Dict[str, bool]:
    try:
        from core.modules import list_modules
        return {m["name"]: bool(m.get("enabled")) for m in list_modules(config)}
    except Exception as exc:  # noqa: BLE001
        logger.debug("modules unreadable: %s", exc)
        return {}


def _playlists(database, profile_id: int) -> List[Dict[str, Any]]:
    try:
        rows = database.get_mirrored_playlists(profile_id=int(profile_id)) or []
    except Exception as exc:  # noqa: BLE001
        logger.debug("mirrored playlists unreadable: %s", exc)
        return []
    return [{"id": str(p.get("id")), "name": _short(p.get("custom_name") or p.get("name"), 100),
             "source": p.get("source")} for p in rows[:30] if p.get("id") is not None]


def escape_data(data: Dict[str, Any]) -> str:
    """JSON that can't close the block it's quoted in."""
    text = json.dumps(data, ensure_ascii=False, default=str, separators=(",", ":"))
    return text.replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")


def data_block(facts: Facts) -> str:
    return f"<library_data>\n{escape_data(facts.data)}\n</library_data>"


def gather(database, config, *, profile_id: int, is_admin: bool, page: str = "list",
           automation_id: Optional[int] = None, run_id: Optional[int] = None,
           draft: Optional[Dict[str, Any]] = None, blocks: Optional[Dict[str, Any]] = None,
           list_scripts: Optional[Callable[[], List[str]]] = None,
           now: Optional[float] = None) -> Facts:
    """Read what one request sends. Never raises for a missing piece: a part
    that can't be read is left out."""
    from core.automation.api import _hydrate_automation, automation_for_viewer

    now = time.time() if now is None else now
    pid = int(profile_id)
    data: Dict[str, Any] = {
        "now": datetime.fromtimestamp(now).astimezone().strftime("%A %d %B %Y, %H:%M %Z"),
        "you": {"admin": bool(is_admin)},
        "page": "editor" if page == "editor" else "list",
    }

    try:
        visible = [_hydrate_automation(dict(a)) for a in database.get_automations(pid)]
    except Exception as exc:  # noqa: BLE001
        logger.debug("automations unreadable: %s", exc)
        visible = []
    visible = [a for a in visible if (a.get("owned_by") or "") != "video"]
    data["automations"] = [_automation_summary(a) for a in visible[:MAX_AUTOMATIONS]]
    if len(visible) > MAX_AUTOMATIONS:
        data["automations_not_listed"] = len(visible) - MAX_AUTOMATIONS

    channels = sorted({t.get("type") for a in visible for t in a.get("then_actions") or []
                       if isinstance(t, dict) and any(v for k, v in (t.get("config") or {}).items()
                                                      if k in _drafts.NOTIFY_SECRETS)})
    data["notifications_set_up"] = [c for c in channels if c]

    focus = None
    quote = None
    reading = "your automations, Wanted and your targets"
    run = None
    if run_id is not None:
        run = _run_row(database, run_id)
        if run is not None and automation_for_viewer(database, int(run["automation_id"]), pid) is None:
            run = None
        if run is not None:
            automation_id = int(run["automation_id"])
    if automation_id is not None:
        saved = automation_for_viewer(database, int(automation_id), pid)
        if saved is not None:
            focus = _hydrate_automation(dict(saved))
            try:
                history = database.get_automation_run_history(int(automation_id), limit=MAX_RUNS)
            except Exception as exc:  # noqa: BLE001
                logger.debug("history unreadable: %s", exc)
                history = {"history": [], "total": 0}
            data["focused_automation"] = {
                **_automation_summary(focus),
                "recent_runs": [_run_summary(r) for r in history.get("history", [])],
                "runs_kept": history.get("total"),
            }
            reading = f"“{_short(focus.get('name'), 60)}” and its last {MAX_RUNS} runs"
    if run is not None and focus is not None:
        lines = _log_lines(run)
        data["focused_run"] = {**_run_summary(run), "log": lines}
        quote = {"run_id": run.get("id"), "started_at": run.get("started_at"),
                 "lines": lines[-QUOTE_LINES:]}
        reading = "the run's log and the runs around it"

    playlists = _playlists(database, pid)
    data["mirrored_playlists"] = playlists
    scripts: List[str] = []
    if is_admin and list_scripts is not None:
        try:
            scripts = [s for s in list_scripts()][:40]
        except Exception as exc:  # noqa: BLE001
            logger.debug("scripts unreadable: %s", exc)
        data["scripts"] = scripts

    if isinstance(draft, dict) and blocks:
        cleaned, _notes = _drafts.clean_draft(draft, blocks, is_admin=is_admin,
                                              playlist_ids=[p["id"] for p in playlists], scripts=scripts)
        if cleaned:
            data["draft_on_screen"] = cleaned
            if run is None and focus is None:
                reading = "the draft and your automations"

    data["wanted"] = _wanted_facts(database, pid)
    data["targets"] = _targets(database, pid)
    data["modules_on"] = _modules(config)
    if is_admin:
        try:
            from core.setup_check import last_report
            report = last_report()
        except Exception:  # noqa: BLE001
            report = None
        if report:
            data["setup_check"] = {
                "ran_at": datetime.fromtimestamp(report["ran_at"], tz=timezone.utc).isoformat(),
                "summary": report.get("summary"),
                "problems": report.get("problems"),
            }

    # cap: drop the least useful parts first until it fits
    for key in ("mirrored_playlists", "targets", "automations"):
        if len(escape_data(data)) <= MAX_CHARS:
            break
        if key == "automations":
            while data["automations"] and len(escape_data(data)) > MAX_CHARS:
                data["automations"].pop()
                data["automations_not_listed"] = data.get("automations_not_listed", 0) + 1
        else:
            data.pop(key, None)
    if len(escape_data(data)) > MAX_CHARS and "focused_run" in data:
        data["focused_run"]["log"] = data["focused_run"]["log"][-10:]

    return Facts(data=data, reading=reading, quote=quote, playlist_ids=[p["id"] for p in playlists],
                 scripts=scripts, automation=focus)
