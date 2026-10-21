"""Small pieces the Activity feed and the targets summary share: which
automations a profile sees, when the next one of a kind runs, and the plain
words both use for times, durations and sizes."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, Optional

# Stored in the music DB's metadata table by AutomationEngine.set_master_enabled.
MUSIC_MASTER_KEY = "automation_master_music_enabled"


def utc_text(epoch: float) -> str:
    """``YYYY-MM-DD HH:MM:SS`` in UTC, the format SQLite's CURRENT_TIMESTAMP writes."""
    return datetime.fromtimestamp(float(epoch), timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def parse_utc(value: Any) -> Optional[int]:
    """Unix seconds for a stored timestamp (CURRENT_TIMESTAMP text, or ISO 8601
    with or without an offset; naive values are read as UTC)."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        try:
            dt = datetime.strptime(text[:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def is_video_automation(row: Dict[str, Any]) -> bool:
    """Same test as AutomationEngine.automation_side, without the import."""
    return (row.get("owned_by") == "video"
            or str(row.get("action_type") or "").startswith("video_")
            or str(row.get("trigger_type") or "").startswith("video_"))


def visible_automations(conn, profile_id: int) -> Dict[int, Dict[str, Any]]:
    """The automations a profile sees on the Automations page (its own plus
    the system ones, as MusicDatabase.get_automations), video side left out."""
    rows = conn.execute(
        "SELECT * FROM automations WHERE profile_id = ? OR is_system = 1",
        (int(profile_id),)).fetchall()
    out: Dict[int, Dict[str, Any]] = {}
    for row in rows:
        auto = dict(row)
        if is_video_automation(auto):
            continue
        out[int(auto["id"])] = auto
    return out


def automations_paused(conn) -> bool:
    """True when the music side's master switch is off."""
    try:
        row = conn.execute("SELECT value FROM metadata WHERE key = ?", (MUSIC_MASTER_KEY,)).fetchone()
    except Exception:  # noqa: BLE001 - no metadata table means the default (on)
        return False
    if row is None or str(row[0] or "").strip() == "":
        return False
    return str(row[0]).strip().lower() not in ("1", "true", "yes", "on")


def _action_config(auto: Dict[str, Any]) -> Dict[str, Any]:
    raw = auto.get("action_config")
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def next_scheduled(automations: Dict[int, Dict[str, Any]], action_types: Iterable[str],
                   *, job_ids: Iterable[str] = ()) -> Optional[Dict[str, Any]]:
    """The soonest scheduled run among enabled automations of these action
    types: ``{"at": unix seconds, "automation_id", "automation_name"}``, or None.

    ``job_ids`` admits ``run_repair_job`` automations whose ``job_id`` is one
    of them (the quality jobs run that way)."""
    wanted = set(action_types)
    jobs = set(job_ids)
    best = None
    for auto in automations.values():
        if not auto.get("enabled"):
            continue
        action = auto.get("action_type")
        if action not in wanted:
            if not (jobs and action == "run_repair_job" and _action_config(auto).get("job_id") in jobs):
                continue
        at = parse_utc(auto.get("next_run"))
        if at is None:
            continue
        if best is None or at < best["at"]:
            best = {"at": at, "automation_id": int(auto["id"]), "automation_name": auto.get("name") or ""}
    return best


def in_words(seconds: float) -> str:
    """"in about 2 hours", for a time this far ahead."""
    s = int(seconds)
    if s <= 60:
        return "in under a minute"
    minutes = round(s / 60)
    if minutes < 60:
        return f"in {minutes} minute{'s' if minutes != 1 else ''}"
    hours = round(s / 3600)
    if hours < 36:
        return f"in about {hours} hour{'s' if hours != 1 else ''}"
    days = round(s / 86400)
    return f"in {days} days"


def duration_words(seconds: Any) -> str:
    """"40 s", "4 min 02 s", "1 h 05 min"."""
    try:
        s = int(round(float(seconds)))
    except (TypeError, ValueError):
        return ""
    if s < 60:
        return f"{max(0, s)} s"
    if s < 3600:
        return f"{s // 60} min {s % 60:02d} s"
    return f"{s // 3600} h {(s % 3600) // 60:02d} min"


def size_words(num_bytes: Any) -> str:
    """"3.2 GB"."""
    try:
        n = float(num_bytes or 0)
    except (TypeError, ValueError):
        return ""
    if n <= 0:
        return ""
    for unit in ("bytes", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit in ("bytes", "KB") else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def plural(n: int, word: str, many: Optional[str] = None) -> str:
    return f"{n} {word if n == 1 else (many or word + 's')}"


__all__ = ["MUSIC_MASTER_KEY", "utc_text", "parse_utc", "is_video_automation", "visible_automations",
           "automations_paused", "next_scheduled", "in_words", "duration_words", "size_words", "plural"]
