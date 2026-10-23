"""Library → Listening history's reads (board 13a, HANDOFF 64).

Music is the listening history the way the player's Recent reads it, but every
source in the caller's pile, not only the web player's plays: SYNCHRO.S's
player, the media server's poll (``server_source`` and, where the server names
it, ``player_name``), and Last.fm / ListenBrainz imports. Podcasts and
audiobooks are ``media_plays`` (core/playback/spoken.py), kept apart.

The history keeps what the source said about a play (title, artist, album, the
length the source reported); the format, the length and the quality verdict
are read from the library track the play is linked to (``db_track_id``), as the
queue does, so they describe the copy you have now.

Ranges are the browser's: ``tz`` is ``Date.getTimezoneOffset()`` (minutes,
UTC minus local), so "Today" starts at the browser's midnight and the day
groups are its days.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from utils.logging_config import get_logger

logger = get_logger("playback.history")

RANGES = ("today", "7d", "30d", "all")
DEFAULT_RANGE = "7d"
PAGE_DEFAULT = 50
PAGE_MAX = 100
MAX_TZ = 14 * 60
_STAMP = "%Y-%m-%d %H:%M:%S"
_EXPLICIT = "('1', 'true', 'yes', 'explicit')"


def clean_range(value: Any) -> str:
    value = str(value or "").strip().lower()
    return value if value in RANGES else DEFAULT_RANGE


def clean_tz(value: Any) -> int:
    """Minutes, UTC minus local (what the browser's getTimezoneOffset says)."""
    try:
        tz = int(float(value))
    except (TypeError, ValueError):
        return 0
    return max(-MAX_TZ, min(MAX_TZ, tz))


def _int(value: Any, default: int, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def since_stamp(range_key: str, tz: int, now: Optional[float] = None) -> Optional[str]:
    """The UTC stamp a range starts at, or None for All time. Today is the
    browser's midnight; 7 and 30 days are rolling."""
    now_dt = datetime.fromtimestamp(time.time() if now is None else float(now), tz=timezone.utc)
    if range_key == "today":
        local = now_dt - timedelta(minutes=tz)
        midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
        return (midnight + timedelta(minutes=tz)).strftime(_STAMP)
    if range_key == "7d":
        return (now_dt - timedelta(days=7)).strftime(_STAMP)
    if range_key == "30d":
        return (now_dt - timedelta(days=30)).strftime(_STAMP)
    return None


def _local_modifier(tz: int) -> str:
    """The sqlite date modifier from UTC to the browser's clock."""
    return f"{-tz:+d} minutes"


def _explicit_sql() -> str:
    return (f"NOT (LOWER(CAST(COALESCE(t.explicit, '') AS TEXT)) IN {_EXPLICIT} "
            f"OR LOWER(CAST(COALESCE(al.explicit, '') AS TEXT)) IN {_EXPLICIT})")


def _has_columns(conn, table: str, wanted: Sequence[str]) -> Dict[str, bool]:
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    return {name: name in cols for name in wanted}


def _music_where(conn, owner: int, *, since: Optional[str], q: str, hide_explicit: bool) -> Tuple[str, List[Any]]:
    from core.listening_scope import owner_clause

    clauses = [owner_clause(owner, "lh")]
    params: List[Any] = []
    if since:
        clauses.append("lh.played_at >= ?")
        params.append(since)
    if q:
        like = f"%{q.lower()}%"
        clauses.append("(LOWER(lh.title) LIKE ? OR LOWER(COALESCE(lh.artist, '')) LIKE ? "
                       "OR LOWER(COALESCE(lh.album, '')) LIKE ?)")
        params += [like, like, like]
    if hide_explicit:
        clauses.append(_explicit_sql())
    return " AND ".join(clauses), params


# the joins every music read uses: the library track a play is linked to and
# its album. CAST keeps tracks' primary key searchable (core/stats/queries.py)
_JOINS = ("FROM listening_history lh "
          "LEFT JOIN tracks t ON t.id = CAST(lh.db_track_id AS TEXT) "
          "LEFT JOIN albums al ON al.id = t.album_id")


class _Quality:
    """The current quality target, judged once per request."""

    def __init__(self, database) -> None:
        from core.quality import presets

        self._presets = presets
        try:
            current = presets.current_target(database)
        except Exception as exc:  # noqa: BLE001 - no verdict beats a wrong one
            logger.debug("quality target unreadable: %s", exc)
            current = {}
        self.targets = current.get("targets") or []
        self.name = current.get("name")
        self._seen: Dict[Tuple[str, int], Tuple[Optional[str], bool]] = {}

    def judge(self, path: Optional[str], bitrate: Any, depth: Any, rate: Any) -> Tuple[Optional[str], bool]:
        """(the format as the artist page says it, below the target)."""
        path = path or ""
        ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
        if not ext:
            return None, False
        try:
            br = int(bitrate or 0)
        except (TypeError, ValueError):
            br = 0
        key = (ext, br)
        verdict = self._seen.get(key)
        if verdict is None:
            aq = self._presets.audio_quality(ext, br)
            if aq.format == "unknown":
                verdict = (None, False)
            else:
                below = bool(self.targets) and not self._presets.meets_targets(aq, self.targets)
                verdict = (self._presets.quality_label(aq), below)
            self._seen[key] = verdict
        label, below = verdict
        try:
            depth_i, rate_i = int(depth or 0), int(rate or 0)
        except (TypeError, ValueError):
            depth_i, rate_i = 0, 0
        if label == "FLAC" and depth_i > 16 and rate_i:
            label = f"FLAC {depth_i}/{rate_i / 1000:g}"
        return label, below


def _heard_stations(conn, profile_id: int, pairs: Iterable[Tuple[str, str]]) -> Dict[Tuple[str, str], str]:
    """(artist, title) lowered -> the station a Heard row you added came from.
    Only identifications this profile added to Wanted count: that's how a
    radio find becomes a track you then played."""
    pairs = sorted({p for p in pairs if p[0] and p[1]})
    if not pairs:
        return {}
    out: Dict[Tuple[str, str], str] = {}
    try:
        for start in range(0, len(pairs), 200):
            chunk = pairs[start:start + 200]
            keys = [f"{a}\x1f{t}" for a, t in chunk]
            marks = ",".join("?" * len(keys))
            rows = conn.execute(
                "SELECT LOWER(TRIM(artist)) AS a, LOWER(TRIM(title)) AS t, station_name, MAX(heard_at) "
                "FROM radio_heard WHERE profile_id = ? AND added_at IS NOT NULL "
                f"AND LOWER(TRIM(artist)) || char(31) || LOWER(TRIM(title)) IN ({marks}) "
                "GROUP BY a, t", [int(profile_id), *keys]).fetchall()
            for row in rows:
                out[(row[0], row[1])] = row[2]
    except Exception as exc:  # noqa: BLE001 - no Heard table: no radio phrase
        logger.debug("heard match skipped: %s", exc)
    return out


def music_page(database, profile_id: int, *, range_key: Any = DEFAULT_RANGE, tz: Any = 0, q: Any = "",
               offset: Any = 0, limit: Any = PAGE_DEFAULT, hide_explicit: bool = False,
               image_url=None, now: Optional[float] = None) -> Dict[str, Any]:
    """One page of the Music kind, newest first, with the total for the range
    and filter, the play count of each local day the page touches, and the
    sources the range holds (for "from SYNCHRO.S's player and Plex")."""
    from core.listening_scope import listening_owner

    range_key = clean_range(range_key)
    tz_i = clean_tz(tz)
    query = str(q or "").strip()[:200]
    offset_i = _int(offset, 0, 0, 10_000_000)
    limit_i = _int(limit, PAGE_DEFAULT, 1, PAGE_MAX)
    owner = listening_owner(database, profile_id)
    since = since_stamp(range_key, tz_i, now)
    modifier = _local_modifier(tz_i)
    fix = image_url or (lambda url: url)

    conn = database._get_connection()
    try:
        have = _has_columns(conn, "listening_history", ("player_name",))
        tcols = _has_columns(conn, "tracks", ("explicit", "bit_depth", "sample_rate"))
        acols = _has_columns(conn, "albums", ("explicit",))
        hide = hide_explicit and tcols["explicit"] and acols["explicit"]
        where, params = _music_where(conn, owner, since=since, q=query, hide_explicit=hide)
        player = "lh.player_name" if have["player_name"] else "NULL"
        depth = "t.bit_depth" if tcols["bit_depth"] else "NULL"
        rate = "t.sample_rate" if tcols["sample_rate"] else "NULL"
        rows = conn.execute(
            f"SELECT lh.id, lh.title, lh.artist, lh.album, lh.played_at, lh.duration_ms, lh.server_source, "
            f"lh.db_track_id, {player} AS player_name, date(lh.played_at, ?) AS day, "
            f"t.id AS track_id, t.file_path, t.bitrate, t.duration AS track_duration, t.artist_id, t.album_id, "
            f"{depth} AS bit_depth, {rate} AS sample_rate, al.thumb_url, al.title AS album_title "
            f"{_JOINS} WHERE {where} ORDER BY lh.played_at DESC, lh.id DESC LIMIT ? OFFSET ?",
            [modifier, *params, limit_i, offset_i]).fetchall()
        total = conn.execute(f"SELECT COUNT(*) {_JOINS} WHERE {where}", params).fetchone()[0]
        days: Dict[str, int] = {}
        if rows:
            # the days this page touches, counted whole (a day's count is the
            # day's, not the page's); bounded on played_at so the index drives it
            first_day, last_day = rows[-1]["day"], rows[0]["day"]
            low = (datetime.strptime(first_day, "%Y-%m-%d") + timedelta(minutes=tz_i)).strftime(_STAMP)
            high = (datetime.strptime(last_day, "%Y-%m-%d") + timedelta(days=1, minutes=tz_i)).strftime(_STAMP)
            day_rows = conn.execute(
                f"SELECT date(lh.played_at, ?) AS day, COUNT(*) {_JOINS} WHERE {where} "
                f"AND lh.played_at >= ? AND lh.played_at < ? GROUP BY day",
                [modifier, *params, low, high]).fetchall()
            days = {r[0]: int(r[1]) for r in day_rows if r[0]}
        sources = [r[0] for r in conn.execute(
            f"SELECT lh.server_source, COUNT(*) AS n {_JOINS} WHERE {where} "
            f"GROUP BY lh.server_source ORDER BY n DESC", params).fetchall() if r[0]]
        from core.playback.play_log import WEB_PLAYER_SOURCE
        heard = _heard_stations(
            conn, int(profile_id),
            ((str(r["artist"] or "").strip().lower(), str(r["title"] or "").strip().lower())
             for r in rows if r["server_source"] == WEB_PLAYER_SOURCE))
    finally:
        conn.close()

    quality = _Quality(database)
    items: List[Dict[str, Any]] = []
    for r in rows:
        in_library = bool(r["track_id"]) and bool(r["file_path"])
        fmt, below = quality.judge(r["file_path"], r["bitrate"], r["bit_depth"], r["sample_rate"]) \
            if in_library else (None, False)
        length_ms = (r["track_duration"] if in_library and r["track_duration"] else None) or r["duration_ms"] or 0
        heard_on = None
        if r["server_source"] == WEB_PLAYER_SOURCE:
            heard_on = heard.get((str(r["artist"] or "").strip().lower(), str(r["title"] or "").strip().lower()))
        items.append({
            "id": int(r["id"]),
            "kind": "music",
            "played_at": r["played_at"],
            "day": r["day"],
            "title": r["title"],
            "artist": r["artist"] or "",
            "album": r["album"] or (r["album_title"] if in_library else "") or "",
            "track_id": r["track_id"] if in_library else None,
            "artist_id": r["artist_id"] if in_library else None,
            "album_id": r["album_id"] if in_library else None,
            "file_path": r["file_path"] if in_library else None,
            "bitrate": r["bitrate"] if in_library else None,
            "format": fmt,
            "below_target": below,
            "length_s": round(length_ms / 1000) if length_ms else None,
            "image_url": fix(r["thumb_url"]) if (in_library and r["thumb_url"]) else None,
            "in_library": in_library,
            # linked once, gone since: "no longer in your library"; never
            # linked (an import of something you never had): "not in your library"
            "was_in_library": bool(r["db_track_id"]) and not in_library,
            "server_source": r["server_source"],
            "player_name": r["player_name"] or None,
            "heard_on": heard_on,
        })
    return {
        "items": items, "total": int(total), "offset": offset_i, "limit": limit_i, "range": range_key,
        "since": since, "days": days, "sources": sources,
        # whose plays these are: "yours only" unless other profiles write to
        # the same shared pile (#1293)
        "shared_with": _shared_with(database, owner, int(profile_id)),
        "target_name": quality.name,
    }


def _shared_with(database, owner: int, profile_id: int) -> int:
    """How many other profiles read and write this pile: 0 for a profile's
    own pile, else the profiles without their own (the shared one's)."""
    from core.listening_scope import SHARED_OWNER, listening_owners

    if owner != SHARED_OWNER:
        return 0
    try:
        own = set(listening_owners(database)) - {SHARED_OWNER}
        conn = database._get_connection()
        try:
            ids = [int(r[0]) for r in conn.execute("SELECT id FROM profiles").fetchall()]
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001 - unknown: say nothing about others
        logger.debug("pile sharing unreadable: %s", exc)
        return 0
    return len([i for i in ids if i not in own and i != profile_id])


def counts(database, profile_id: int, *, tz: Any = 0, hide_explicit: bool = False,
           now: Optional[float] = None) -> Dict[str, Dict[str, int]]:
    """Plays per kind and per range, in two queries (one for music, one for
    podcasts and audiobooks): {kind: {today, 7d, 30d, all}}."""
    from core.listening_scope import listening_owner, owner_clause

    tz_i = clean_tz(tz)
    stamps = {k: since_stamp(k, tz_i, now) for k in ("today", "7d", "30d")}
    owner = listening_owner(database, profile_id)
    out: Dict[str, Dict[str, int]] = {k: {r: 0 for r in RANGES} for k in ("music", "podcast", "audiobook")}
    sums = ", ".join("COALESCE(SUM(CASE WHEN lh.played_at >= ? THEN 1 ELSE 0 END), 0)" for _ in stamps)
    conn = database._get_connection()
    try:
        tcols = _has_columns(conn, "tracks", ("explicit",))
        acols = _has_columns(conn, "albums", ("explicit",))
        where = owner_clause(owner, "lh")
        if hide_explicit and tcols["explicit"] and acols["explicit"]:
            where += " AND " + _explicit_sql()
        row = conn.execute(f"SELECT COUNT(*), {sums} {_JOINS} WHERE {where}", list(stamps.values())).fetchone()
        out["music"] = {"all": int(row[0] or 0), "today": int(row[1] or 0), "7d": int(row[2] or 0),
                        "30d": int(row[3] or 0)}
        spoken_sums = sums.replace("lh.played_at", "played_at")
        try:
            for r in conn.execute(
                    f"SELECT kind, COUNT(*), {spoken_sums} FROM media_plays WHERE profile_id = ? GROUP BY kind",
                    [*stamps.values(), int(profile_id)]).fetchall():
                if r[0] in out:
                    out[r[0]] = {"all": int(r[1] or 0), "today": int(r[2] or 0), "7d": int(r[3] or 0),
                                 "30d": int(r[4] or 0)}
        except Exception as exc:  # noqa: BLE001 - no media_plays yet: none played
            logger.debug("spoken counts skipped: %s", exc)
    finally:
        conn.close()
    return out


__all__ = ["DEFAULT_RANGE", "PAGE_DEFAULT", "PAGE_MAX", "RANGES", "clean_range", "clean_tz", "counts",
           "music_page", "since_stamp"]
