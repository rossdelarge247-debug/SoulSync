"""Podcast episodes and audiobooks in the app's player: where each profile got
to, and what it played (HANDOFF 46).

Two tables (made by ``MusicDatabase._add_spoken_word_tables``):

- ``media_progress``: one row per profile, kind and item (an episode's guid or
  its address, an audiobook's ASIN): the position, the length and whether it
  was finished. Resuming starts from the position; a finished item starts
  again from the top.
- ``media_plays``: a play of an episode or an audiobook, per profile, for
  Library → Listening history's Podcasts and Audiobooks and the player's
  Recent. Kept apart from ``listening_history`` on purpose: that table feeds
  Stats, smart radio, the history importers and scrobbling, which all stay
  music only, and none of them has to learn to skip these rows.

Everything here is scoped by the profile id the route passes in, which is
always the session's own (api/player.py): nobody reads or writes another
profile's progress or plays.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from utils.logging_config import get_logger

logger = get_logger("playback.spoken")

KINDS = ("podcast", "audiobook")
MAX_ID = 512
MAX_TEXT = 300
MAX_URL = 2000
MAX_IDS = 100
PLAYS_MAX = 100
#: the same item again within this many seconds is the same play (a resume)
SAME_PLAY_S = 30 * 60
#: positions under this aren't worth resuming from
MIN_RESUME_S = 5.0

# Where the player may be sent back to on "play again": an episode's own
# address, or the server's own proxies (audiobook samples go through one).
_LOCAL_SRC = re.compile(r"^/api/(audiobooks/sample-proxy|podcasts/audio-proxy)\?[^\s<>\"']*$")
_LOCAL_ART = re.compile(r"^/api/[A-Za-z0-9/_\-.?=&%:]*$")


class SpokenError(ValueError):
    """A request the routes answer with 400; ``str()`` is safe to show."""


def now_stamp(now: Optional[float] = None) -> str:
    """UTC 'YYYY-MM-DD HH:MM:SS', as listening_history stores played_at."""
    return datetime.fromtimestamp(now if now is not None else time.time(), timezone.utc).strftime(
        "%Y-%m-%d %H:%M:%S")


def check_kind(kind: Any) -> str:
    kind = str(kind or "").strip().lower()
    if kind not in KINDS:
        raise SpokenError("kind is podcast or audiobook.")
    return kind


def check_media_id(media_id: Any) -> str:
    value = str(media_id or "").strip()
    if not value or len(value) > MAX_ID:
        raise SpokenError("media_id is missing or too long.")
    return value


def _number(value: Any, *, allow_none: bool = False) -> Optional[float]:
    if value is None and allow_none:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        if allow_none:
            return None
        raise SpokenError("position_s and duration_s are seconds.") from None
    if out != out or out < 0 or out > 7 * 24 * 3600:  # NaN, negative, over a week
        if allow_none:
            return None
        raise SpokenError("position_s and duration_s are seconds.")
    return out


def finish_margin(duration: float) -> float:
    """How close to the end counts as finished: 5% of the length, between 10
    seconds and a minute (outros, credits and trailing ads)."""
    return min(60.0, max(10.0, duration * 0.05))


def is_finished(position: float, duration: Optional[float]) -> bool:
    if not duration or duration <= 0:
        return False
    return duration - position <= finish_margin(duration)


def resume_at(row: Optional[Dict[str, Any]]) -> float:
    """Where to start: the saved position, the top for a finished item or
    one barely started."""
    if not row or row.get("finished"):
        return 0.0
    pos = float(row.get("position_s") or 0)
    return pos if pos >= MIN_RESUME_S else 0.0


def clean_text(value: Any, limit: int = MAX_TEXT) -> str:
    return " ".join(str(value or "").split())[:limit]


def clean_src(value: Any) -> Optional[str]:
    """An episode's http(s) address or one of the server's own proxy paths;
    anything else isn't kept (it would be handed back to the player)."""
    raw = str(value or "").strip()
    if not raw or len(raw) > MAX_URL or any(c in raw for c in "\r\n\t "):
        return None
    if raw.lower().startswith(("https://", "http://")):
        return raw
    return raw if _LOCAL_SRC.match(raw) else None


def clean_art(value: Any) -> Optional[str]:
    raw = str(value or "").strip()
    if not raw or len(raw) > MAX_URL or any(c in raw for c in "\r\n\t \"'<>"):
        return None
    if raw.lower().startswith(("https://", "http://")):
        return raw
    return raw if _LOCAL_ART.match(raw) else None


# ── progress ─────────────────────────────────────────────────────────────────

def _progress_row(row) -> Dict[str, Any]:
    out = {"position_s": round(float(row["position_s"] or 0), 1),
           "duration_s": round(float(row["duration_s"]), 1) if row["duration_s"] is not None else None,
           "finished": bool(row["finished"]), "updated_at": int(row["updated_at"] or 0)}
    out["resume_at"] = round(resume_at(out), 1)
    return out


def get_progress(db, profile_id: int, kind: str, media_ids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    """{media_id: progress} for the ones this profile has started."""
    kind = check_kind(kind)
    ids = [check_media_id(i) for i in list(media_ids)[:MAX_IDS]]
    if not ids:
        return {}
    marks = ",".join("?" for _ in ids)
    with db._get_connection() as conn:
        rows = conn.execute(
            f"SELECT media_id, position_s, duration_s, finished, updated_at FROM media_progress "  # noqa: S608 - placeholders only
            f"WHERE profile_id = ? AND kind = ? AND media_id IN ({marks})",
            (int(profile_id), kind, *ids)).fetchall()
    return {r["media_id"]: _progress_row(r) for r in rows}


def save_progress(db, profile_id: int, kind: str, media_id: str, position_s: Any,
                  duration_s: Any = None, *, ended: bool = False, now: Optional[float] = None) -> Dict[str, Any]:
    """Keep where this profile got to. ``ended`` is the player's own end of
    the item; otherwise finished means near the end (``is_finished``). A
    finished item stays finished if the player saves a position past the end
    again; starting it over from the top makes it unfinished."""
    kind = check_kind(kind)
    media_id = check_media_id(media_id)
    position = _number(position_s)
    duration = _number(duration_s, allow_none=True)
    if duration and position > duration:
        position = duration
    finished = bool(ended) or is_finished(position, duration)
    stamp = int(now if now is not None else time.time())
    with db._get_connection() as conn:
        conn.execute(
            "INSERT INTO media_progress (profile_id, kind, media_id, position_s, duration_s, finished, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(profile_id, kind, media_id) DO UPDATE SET position_s = excluded.position_s, "
            "duration_s = COALESCE(excluded.duration_s, media_progress.duration_s), "
            "finished = excluded.finished, updated_at = excluded.updated_at",
            (int(profile_id), kind, media_id, position, duration, 1 if finished else 0, stamp))
        conn.commit()
        row = conn.execute(
            "SELECT media_id, position_s, duration_s, finished, updated_at FROM media_progress "
            "WHERE profile_id = ? AND kind = ? AND media_id = ?", (int(profile_id), kind, media_id)).fetchone()
    return _progress_row(row)


# ── plays ────────────────────────────────────────────────────────────────────

def log_play(db, profile_id: int, item: Dict[str, Any], *, now: Optional[float] = None) -> int:
    """Record a play (the player sends it once an item has played ~10 s).
    The same item again within half an hour is the same play: its time moves
    up instead of a second row. Returns the play's id."""
    if not isinstance(item, dict):
        raise SpokenError("Send the item that played.")
    kind = check_kind(item.get("kind"))
    media_id = check_media_id(item.get("media_id"))
    title = clean_text(item.get("title"))
    if not title:
        raise SpokenError("title is missing.")
    subtitle = clean_text(item.get("subtitle")) or None
    duration = _number(item.get("duration_s"), allow_none=True)
    ts = now if now is not None else time.time()
    stamp = now_stamp(ts)
    since = now_stamp(ts - SAME_PLAY_S)
    with db._get_connection() as conn:
        row = conn.execute(
            "SELECT id FROM media_plays WHERE profile_id = ? AND kind = ? AND media_id = ? AND played_at >= ? "
            "ORDER BY played_at DESC LIMIT 1", (int(profile_id), kind, media_id, since)).fetchone()
        if row:
            conn.execute("UPDATE media_plays SET played_at = ? WHERE id = ?", (stamp, row["id"]))
            conn.commit()
            return int(row["id"])
        cur = conn.execute(
            "INSERT INTO media_plays (profile_id, kind, media_id, title, subtitle, art_url, src, duration_s, played_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (int(profile_id), kind, media_id, title, subtitle, clean_art(item.get("art_url")),
             clean_src(item.get("src")), duration, stamp))
        conn.commit()
        return int(cur.lastrowid)


def recent_plays(db, profile_id: int, kinds: Iterable[str] = KINDS, limit: int = 20) -> List[Dict[str, Any]]:
    """This profile's plays of the given kinds, newest first, with where each
    got to."""
    kinds = [check_kind(k) for k in kinds]
    limit = max(1, min(PLAYS_MAX, int(limit)))
    if not kinds:
        return []
    marks = ",".join("?" for _ in kinds)
    with db._get_connection() as conn:
        rows = conn.execute(
            "SELECT p.id, p.kind, p.media_id, p.title, p.subtitle, p.art_url, p.src, p.duration_s, p.played_at, "  # noqa: S608
            "g.position_s, g.duration_s AS progress_duration, g.finished "
            "FROM media_plays p LEFT JOIN media_progress g ON g.profile_id = p.profile_id "
            "AND g.kind = p.kind AND g.media_id = p.media_id "
            f"WHERE p.profile_id = ? AND p.kind IN ({marks}) ORDER BY p.played_at DESC, p.id DESC LIMIT ?",
            (int(profile_id), *kinds, limit)).fetchall()
    out = []
    for r in rows:
        duration = r["progress_duration"] if r["progress_duration"] is not None else r["duration_s"]
        out.append({
            "play_id": int(r["id"]), "kind": r["kind"], "media_id": r["media_id"], "title": r["title"],
            "subtitle": r["subtitle"], "image_url": r["art_url"], "src": r["src"],
            "duration_s": round(float(duration), 1) if duration is not None else None,
            "played_at": r["played_at"],
            "position_s": round(float(r["position_s"]), 1) if r["position_s"] is not None else None,
            "finished": bool(r["finished"]) if r["finished"] is not None else False,
        })
    return out


__all__ = ["KINDS", "SpokenError", "check_kind", "check_media_id", "finish_margin", "is_finished", "resume_at",
           "clean_src", "clean_art", "get_progress", "save_progress", "log_play", "recent_plays", "now_stamp"]
