"""Internet radio's rows in the music database (MusicDatabase._add_internet_radio_tables).

- ``radio_favourites``: per profile. A directory station keeps a snapshot of
  itself so Favourites can draw it without asking the directory.
- ``radio_links``: stream links admins added and checked; everyone's
  Favourites show them as "Your link".
- ``radio_heard``: what was identified (or a stretch that wasn't), per
  profile, kept for Settings → Radio's days.
- ``radio_auto_add``: the auto-add switch, per profile and station.
- ``radio_auto_added``: every track auto-add put on a profile's Wanted, so
  it never adds the same track twice; also counts the daily limit.
- ``radio_activity``: auto-add's Activity items, one per station per hour.
- ``radio_shows``: shows seen on a station's feed, and tracklists fetched.
- ``radio_scan_usage``: Scan now's requests to each identification service
  (and how many found the track), per local month. Automatic AudD's daily
  count shares it: rows with ``provider`` ``audd_auto`` and a local day
  (``2026-10-23``) in ``month``, so they never mix with a month's counts.
- ``radio_scan_keys``: when each service's key was saved through Settings →
  Radio, and what the service last said of it (``ok``, ``bad_key`` or
  ``out_of_credit``). Never the key.

Times are unix seconds.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional

from utils.logging_config import get_logger

logger = get_logger("internet_radio.store")
_claim_lock = threading.Lock()


def _now() -> int:
    return int(time.time())


def day_start(now: Optional[float] = None, days_ago: int = 0) -> int:
    """Local midnight, ``days_ago`` days back: the daily limit's day."""
    local = datetime.fromtimestamp(now if now is not None else time.time()).astimezone()
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days_ago)
    return int(midnight.timestamp())


# ── favourites ───────────────────────────────────────────────────────────────

def favourite_ids(db, profile_id: int) -> List[str]:
    with db._get_connection() as conn:
        rows = conn.execute("SELECT station_id FROM radio_favourites WHERE profile_id = ? ORDER BY created_at",
                            (int(profile_id),)).fetchall()
    return [r[0] for r in rows]


def favourite_rows(db, profile_id: int) -> List[Dict[str, Any]]:
    with db._get_connection() as conn:
        rows = conn.execute("SELECT station_id, station_json FROM radio_favourites WHERE profile_id = ? "
                            "ORDER BY created_at", (int(profile_id),)).fetchall()
    return [{"station_id": r[0], "station_json": r[1]} for r in rows]


def add_favourite(db, profile_id: int, station_id: str, snapshot: Optional[Dict[str, Any]] = None) -> None:
    with db._get_connection() as conn:
        conn.execute("INSERT INTO radio_favourites (profile_id, station_id, station_json, created_at) "
                     "VALUES (?, ?, ?, ?) ON CONFLICT(profile_id, station_id) DO UPDATE SET "
                     "station_json = COALESCE(excluded.station_json, radio_favourites.station_json)",
                     (int(profile_id), station_id, json.dumps(snapshot) if snapshot else None, _now()))
        conn.commit()


def remove_favourite(db, profile_id: int, station_id: str) -> bool:
    with db._get_connection() as conn:
        cur = conn.execute("DELETE FROM radio_favourites WHERE profile_id = ? AND station_id = ?",
                           (int(profile_id), station_id))
        conn.commit()
        return cur.rowcount > 0


def profiles_favouriting(db, station_id: str) -> List[int]:
    with db._get_connection() as conn:
        rows = conn.execute("SELECT profile_id FROM radio_favourites WHERE station_id = ?", (station_id,)).fetchall()
    return [int(r[0]) for r in rows]


def all_favourite_station_ids(db, profile_ids: Iterable[int]) -> List[str]:
    ids = [int(p) for p in profile_ids]
    if not ids:
        return []
    ph = ",".join("?" for _ in ids)
    with db._get_connection() as conn:
        rows = conn.execute(f"SELECT DISTINCT station_id FROM radio_favourites WHERE profile_id IN ({ph})",
                            ids).fetchall()
    return [r[0] for r in rows]


def station_snapshot(db, station_id: str) -> Optional[Dict[str, Any]]:
    """A directory station's last snapshot (from a favourite or auto-add row)."""
    with db._get_connection() as conn:
        row = conn.execute("SELECT station_json FROM radio_favourites WHERE station_id = ? AND station_json "
                           "IS NOT NULL UNION ALL SELECT station_json FROM radio_auto_add WHERE station_id = ? "
                           "AND station_json IS NOT NULL LIMIT 1", (station_id, station_id)).fetchone()
    if not row or not row[0]:
        return None
    try:
        data = json.loads(row[0])
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


# ── your links ───────────────────────────────────────────────────────────────

_LINK_COLS = ("id, name, url, kind, codec, bitrate_kbps, sends_titles, allows_direct, check_ok, checked_at, "
              "check_error, added_by, added_at, logo_url")


def _link(row) -> Dict[str, Any]:
    keys = [c.strip() for c in _LINK_COLS.split(",")]
    return dict(zip(keys, tuple(row), strict=False))


def list_links(db) -> List[Dict[str, Any]]:
    with db._get_connection() as conn:
        rows = conn.execute(f"SELECT {_LINK_COLS} FROM radio_links ORDER BY added_at").fetchall()
    return [_link(r) for r in rows]


def get_link(db, link_id: int) -> Optional[Dict[str, Any]]:
    with db._get_connection() as conn:
        row = conn.execute(f"SELECT {_LINK_COLS} FROM radio_links WHERE id = ?", (int(link_id),)).fetchone()
    return _link(row) if row else None


def add_link(db, *, name: str, url: str, kind: str, codec: str, bitrate_kbps: int, sends_titles: bool,
             allows_direct: bool, added_by: str, logo_url: Optional[str] = None) -> int:
    with db._get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO radio_links (name, url, kind, codec, bitrate_kbps, sends_titles, allows_direct, check_ok, "
            "checked_at, added_by, added_at, logo_url) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
            (name, url, kind, codec, int(bitrate_kbps or 0), 1 if sends_titles else 0, 1 if allows_direct else 0,
             _now(), added_by, _now(), logo_url or None))
        conn.commit()
        return int(cur.lastrowid)


def record_link_check(db, link_id: int, *, ok: bool, error: Optional[str], codec: str = "",
                      bitrate_kbps: int = 0, sends_titles: Optional[bool] = None) -> None:
    with db._get_connection() as conn:
        if ok:
            conn.execute("UPDATE radio_links SET check_ok = 1, checked_at = ?, check_error = NULL, "
                         "codec = COALESCE(NULLIF(?, ''), codec), bitrate_kbps = COALESCE(NULLIF(?, 0), bitrate_kbps), "
                         "sends_titles = COALESCE(?, sends_titles) WHERE id = ?",
                         (_now(), codec, int(bitrate_kbps or 0),
                          None if sends_titles is None else int(bool(sends_titles)), int(link_id)))
        else:
            conn.execute("UPDATE radio_links SET check_ok = 0, checked_at = ?, check_error = ? WHERE id = ?",
                         (_now(), (error or "")[:300], int(link_id)))
        conn.commit()


def set_link_logo(db, link_id: int, logo_url: Optional[str]) -> bool:
    with db._get_connection() as conn:
        cur = conn.execute("UPDATE radio_links SET logo_url = ? WHERE id = ?", (logo_url or None, int(link_id)))
        conn.commit()
        return cur.rowcount > 0


def remove_link(db, link_id: int) -> bool:
    with db._get_connection() as conn:
        cur = conn.execute("DELETE FROM radio_links WHERE id = ?", (int(link_id),))
        sid = f"link-{int(link_id)}"
        conn.execute("DELETE FROM radio_favourites WHERE station_id = ?", (sid,))
        conn.execute("UPDATE radio_auto_add SET enabled = 0 WHERE station_id = ?", (sid,))
        conn.commit()
        return cur.rowcount > 0


# ── heard ────────────────────────────────────────────────────────────────────

_HEARD_COLS = ("id, profile_id, station_id, station_name, heard_at, artist, title, release, art_url, source, "
               "track_key, identified, duration_s, reason, added_at, added_by_auto")


def _heard(row) -> Dict[str, Any]:
    keys = [c.strip() for c in _HEARD_COLS.split(",")]
    return dict(zip(keys, tuple(row), strict=False))


def record_heard(db, *, profile_id: int, station_id: str, station_name: str, heard_at: int,
                 artist: str = "", title: str = "", release: str = "", art_url: str = "",
                 source: Optional[str] = None, track_key: str = "", identified: bool = True,
                 duration_s: Optional[int] = None, reason: Optional[str] = None,
                 dedupe_seconds: int = 20 * 60) -> Optional[int]:
    """One heard row; the same track on the same station within
    ``dedupe_seconds`` is the same play and isn't recorded again."""
    with db._get_connection() as conn:
        if identified and track_key:
            dup = conn.execute("SELECT id FROM radio_heard WHERE profile_id = ? AND station_id = ? AND track_key = ? "
                               "AND heard_at >= ? LIMIT 1",
                               (int(profile_id), station_id, track_key, int(heard_at) - dedupe_seconds)).fetchone()
            if dup:
                return None
        cur = conn.execute(
            "INSERT INTO radio_heard (profile_id, station_id, station_name, heard_at, artist, title, release, art_url, "
            "source, track_key, identified, duration_s, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (int(profile_id), station_id, station_name, int(heard_at), artist or "", title or "", release or "",
             art_url or "", source, track_key or "", 1 if identified else 0, duration_s, reason))
        conn.commit()
        return int(cur.lastrowid)


def list_heard(db, profile_id: int, *, station_id: Optional[str] = None, since: Optional[int] = None,
               limit: int = 200) -> List[Dict[str, Any]]:
    where = ["profile_id = ?"]
    params: List[Any] = [int(profile_id)]
    if station_id:
        where.append("station_id = ?")
        params.append(station_id)
    if since:
        where.append("heard_at >= ?")
        params.append(int(since))
    with db._get_connection() as conn:
        rows = conn.execute(f"SELECT {_HEARD_COLS} FROM radio_heard WHERE {' AND '.join(where)} "
                            "ORDER BY heard_at DESC, id DESC LIMIT ?", params + [int(limit)]).fetchall()
    return [_heard(r) for r in rows]


def count_heard(db, profile_id: int, *, since: Optional[int] = None, station_id: Optional[str] = None) -> Dict[str, int]:
    where = ["profile_id = ?"]
    params: List[Any] = [int(profile_id)]
    if station_id:
        where.append("station_id = ?")
        params.append(station_id)
    if since:
        where.append("heard_at >= ?")
        params.append(int(since))
    with db._get_connection() as conn:
        row = conn.execute(f"SELECT SUM(identified = 1), SUM(identified = 0) FROM radio_heard "
                           f"WHERE {' AND '.join(where)}", params).fetchone()
    return {"identified": int((row or [0])[0] or 0), "not_identified": int((row or [0, 0])[1] or 0)}


def get_heard(db, heard_id: int) -> Optional[Dict[str, Any]]:
    with db._get_connection() as conn:
        row = conn.execute(f"SELECT {_HEARD_COLS} FROM radio_heard WHERE id = ?", (int(heard_id),)).fetchone()
    return _heard(row) if row else None


def find_heard(db, profile_id: int, station_id: str, track_key: str, since: int) -> Optional[Dict[str, Any]]:
    """This profile's latest Heard row for a track on a station."""
    with db._get_connection() as conn:
        row = conn.execute(f"SELECT {_HEARD_COLS} FROM radio_heard WHERE profile_id = ? AND station_id = ? AND "
                           "track_key = ? AND heard_at >= ? ORDER BY heard_at DESC LIMIT 1",
                           (int(profile_id), station_id, track_key, int(since))).fetchone()
    return _heard(row) if row else None


def mark_heard_added(db, heard_id: int, *, auto: bool = False) -> None:
    with db._get_connection() as conn:
        conn.execute("UPDATE radio_heard SET added_at = ?, added_by_auto = ? WHERE id = ?",
                     (_now(), 1 if auto else 0, int(heard_id)))
        conn.commit()


def prune_heard(db, keep_days: int, now: Optional[float] = None) -> int:
    cutoff = int((now if now is not None else time.time()) - max(1, int(keep_days)) * 86400)
    with db._get_connection() as conn:
        cur = conn.execute("DELETE FROM radio_heard WHERE heard_at < ?", (cutoff,))
        conn.execute("DELETE FROM radio_activity WHERE updated_at < ?", (cutoff,))
        conn.commit()
        return cur.rowcount


def station_identified_keys(db, station_id: str, since: int, until: int) -> List[Dict[str, str]]:
    """Distinct tracks identified on a station in a window, any profile."""
    with db._get_connection() as conn:
        rows = conn.execute("SELECT track_key, MAX(artist), MAX(title) FROM radio_heard WHERE station_id = ? AND "
                            "identified = 1 AND track_key != '' AND heard_at >= ? AND heard_at < ? "
                            "GROUP BY track_key", (station_id, int(since), int(until))).fetchall()
    return [{"key": r[0], "artist": r[1] or "", "title": r[2] or ""} for r in rows]


# ── auto-add ─────────────────────────────────────────────────────────────────

def auto_add_enabled(db, profile_id: int, station_id: str) -> bool:
    with db._get_connection() as conn:
        row = conn.execute("SELECT enabled FROM radio_auto_add WHERE profile_id = ? AND station_id = ?",
                           (int(profile_id), station_id)).fetchone()
    return bool(row and row[0])


def set_auto_add(db, profile_id: int, station_id: str, station_name: str, enabled: bool,
                 snapshot: Optional[Dict[str, Any]] = None) -> None:
    with db._get_connection() as conn:
        conn.execute("INSERT INTO radio_auto_add (profile_id, station_id, station_name, station_json, enabled, "
                     "changed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(profile_id, station_id) DO UPDATE SET "
                     "enabled = excluded.enabled, changed_at = excluded.changed_at, station_name = "
                     "excluded.station_name, station_json = COALESCE(excluded.station_json, radio_auto_add.station_json)",
                     (int(profile_id), station_id, station_name, json.dumps(snapshot) if snapshot else None,
                      1 if enabled else 0, _now()))
        conn.commit()


def auto_add_profiles(db, station_id: str) -> List[int]:
    with db._get_connection() as conn:
        rows = conn.execute("SELECT profile_id FROM radio_auto_add WHERE station_id = ? AND enabled = 1",
                            (station_id,)).fetchall()
    return [int(r[0]) for r in rows]


def auto_add_station_ids(db) -> List[str]:
    with db._get_connection() as conn:
        rows = conn.execute("SELECT DISTINCT station_id FROM radio_auto_add WHERE enabled = 1").fetchall()
    return [r[0] for r in rows]


def auto_add_rows(db, profile_id: Optional[int] = None) -> List[Dict[str, Any]]:
    sql = "SELECT profile_id, station_id, station_name, enabled, changed_at FROM radio_auto_add WHERE enabled = 1"
    params: List[Any] = []
    if profile_id is not None:
        sql += " AND profile_id = ?"
        params.append(int(profile_id))
    with db._get_connection() as conn:
        rows = conn.execute(sql + " ORDER BY changed_at", params).fetchall()
    return [{"profile_id": int(r[0]), "station_id": r[1], "station_name": r[2], "changed_at": r[4]} for r in rows]


def was_auto_added(db, profile_id: int, track_key: str) -> bool:
    with db._get_connection() as conn:
        row = conn.execute("SELECT 1 FROM radio_auto_added WHERE profile_id = ? AND track_key = ?",
                           (int(profile_id), track_key)).fetchone()
    return row is not None


def auto_added_since(db, profile_id: int, station_id: str, since: int) -> int:
    with db._get_connection() as conn:
        row = conn.execute("SELECT COUNT(*) FROM radio_auto_added WHERE profile_id = ? AND station_id = ? "
                           "AND added_at >= ?", (int(profile_id), station_id, int(since))).fetchone()
    return int(row[0] or 0)


def claim_auto_add(db, profile_id: int, track_key: str, station_id: str, *, daily_limit: int,
                   day_since: int, now: Optional[float] = None) -> str:
    """Reserve one auto-add: ``"ok"``, ``"duplicate"`` or ``"limit"``.

    Under one lock (the app runs one process), so two identifications racing
    can't both add the same track or both take the last slot of the day.
    """
    with _claim_lock, db._get_connection() as conn:
        if conn.execute("SELECT 1 FROM radio_auto_added WHERE profile_id = ? AND track_key = ?",
                        (int(profile_id), track_key)).fetchone():
            return "duplicate"
        used = conn.execute("SELECT COUNT(*) FROM radio_auto_added WHERE profile_id = ? AND station_id = ? "
                            "AND added_at >= ?", (int(profile_id), station_id, int(day_since))).fetchone()[0]
        if int(used or 0) >= int(daily_limit):
            return "limit"
        conn.execute("INSERT INTO radio_auto_added (profile_id, track_key, station_id, added_at) VALUES (?, ?, ?, ?)",
                     (int(profile_id), track_key, station_id, int(now) if now is not None else _now()))
        conn.commit()
        return "ok"


def release_auto_add(db, profile_id: int, track_key: str) -> None:
    """Give a claimed slot back when the add itself failed."""
    with db._get_connection() as conn:
        conn.execute("DELETE FROM radio_auto_added WHERE profile_id = ? AND track_key = ?",
                     (int(profile_id), track_key))
        conn.commit()


def record_activity(db, *, profile_id: int, station_id: str, station_name: str, title: str,
                    now: Optional[float] = None) -> None:
    """Count one addition in this station's Activity item for the hour."""
    t = int(now if now is not None else time.time())
    hour = t - t % 3600
    with db._get_connection() as conn:
        row = conn.execute("SELECT id, titles_json FROM radio_activity WHERE profile_id = ? AND station_id = ? AND "
                           "hour_start = ?", (int(profile_id), station_id, hour)).fetchone()
        if row:
            try:
                titles = json.loads(row[1] or "[]")
            except ValueError:
                titles = []
            titles = (titles if isinstance(titles, list) else [])[:19] + [title]
            conn.execute("UPDATE radio_activity SET added = added + 1, titles_json = ?, updated_at = ?, "
                         "station_name = ? WHERE id = ?", (json.dumps(titles[-20:]), t, station_name, row[0]))
        else:
            conn.execute("INSERT INTO radio_activity (profile_id, station_id, station_name, hour_start, added, "
                         "titles_json, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
                         (int(profile_id), station_id, station_name, hour, json.dumps([title]), t))
        conn.commit()


def added_this_week(db, profile_id: Optional[int] = None, now: Optional[float] = None) -> int:
    since = int((now if now is not None else time.time()) - 7 * 86400)
    sql = "SELECT COUNT(*) FROM radio_auto_added WHERE added_at >= ?"
    params: List[Any] = [since]
    if profile_id is not None:
        sql += " AND profile_id = ?"
        params.append(int(profile_id))
    with db._get_connection() as conn:
        return int(conn.execute(sql, params).fetchone()[0] or 0)


# ── shows ────────────────────────────────────────────────────────────────────

def upsert_show(db, *, show_id: str, station_id: str, title: str, aired_at: Optional[int],
                ended_at: Optional[int], ref: Dict[str, Any]) -> None:
    with db._get_connection() as conn:
        conn.execute("INSERT INTO radio_shows (id, station_id, title, aired_at, ended_at, ref_json) VALUES "
                     "(?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, "
                     "aired_at = COALESCE(excluded.aired_at, radio_shows.aired_at), "
                     "ended_at = COALESCE(excluded.ended_at, radio_shows.ended_at), ref_json = excluded.ref_json",
                     (show_id, station_id, title[:200], aired_at, ended_at, json.dumps(ref)))
        conn.commit()


def list_shows(db, station_id: str, since: int) -> List[Dict[str, Any]]:
    with db._get_connection() as conn:
        rows = conn.execute("SELECT id, station_id, title, aired_at, ended_at, ref_json, tracks_json, fetched_at "
                            "FROM radio_shows WHERE station_id = ? AND COALESCE(aired_at, 0) >= ? "
                            "ORDER BY aired_at DESC LIMIT 30", (station_id, int(since))).fetchall()
    return [_show(r) for r in rows]


def get_show(db, show_id: str) -> Optional[Dict[str, Any]]:
    with db._get_connection() as conn:
        row = conn.execute("SELECT id, station_id, title, aired_at, ended_at, ref_json, tracks_json, fetched_at "
                           "FROM radio_shows WHERE id = ?", (show_id,)).fetchone()
    return _show(row) if row else None


def _show(row) -> Dict[str, Any]:
    def j(v):
        try:
            return json.loads(v) if v else None
        except ValueError:
            return None
    return {"id": row[0], "station_id": row[1], "title": row[2], "aired_at": row[3], "ended_at": row[4],
            "ref": j(row[5]) or {}, "tracks": j(row[6]), "fetched_at": row[7]}


def save_show_tracks(db, show_id: str, tracks: List[Dict[str, Any]]) -> None:
    with db._get_connection() as conn:
        conn.execute("UPDATE radio_shows SET tracks_json = ?, fetched_at = ? WHERE id = ?",
                     (json.dumps(tracks), _now(), show_id))
        conn.commit()


__all__ = [n for n in dir() if not n.startswith("_") and n not in ("annotations", "json", "time", "datetime",
                                                                     "timedelta", "logger", "get_logger",
                                                                     "threading")]


# ── Scan now's usage ─────────────────────────────────────────────────────────

def month_key(now: Optional[float] = None) -> str:
    return datetime.fromtimestamp(now if now is not None else time.time()).astimezone().strftime("%Y-%m")


def bump_scan_usage(db, provider: str, *, found: bool = False, now: Optional[float] = None) -> None:
    with db._get_connection() as conn:
        conn.execute("INSERT INTO radio_scan_usage (month, provider, requests, found) VALUES (?, ?, 1, ?) "
                     "ON CONFLICT(month, provider) DO UPDATE SET requests = requests + 1, found = found + excluded.found",
                     (month_key(now), provider, 1 if found else 0))
        conn.commit()


def scan_usage(db, now: Optional[float] = None) -> Dict[str, Dict[str, int]]:
    """This month's ``{provider: {requests, found}}``."""
    with db._get_connection() as conn:
        rows = conn.execute("SELECT provider, requests, found FROM radio_scan_usage WHERE month = ?",
                            (month_key(now),)).fetchall()
    return {r[0]: {"requests": int(r[1]), "found": int(r[2])} for r in rows}


# ── automatic AudD's daily count ─────────────────────────────────────────────

AUDD_AUTO_USAGE = "audd_auto"


def day_key(now: Optional[float] = None) -> str:
    """The local day, ``2026-10-23``: automatic AudD's cap resets at local midnight."""
    return datetime.fromtimestamp(now if now is not None else time.time()).astimezone().strftime("%Y-%m-%d")


def audd_auto_used(db, now: Optional[float] = None) -> int:
    """Automatic AudD requests sent today (local day)."""
    with db._get_connection() as conn:
        row = conn.execute("SELECT requests FROM radio_scan_usage WHERE month = ? AND provider = ?",
                           (day_key(now), AUDD_AUTO_USAGE)).fetchone()
    return int(row[0]) if row else 0


def claim_audd_auto(db, cap: int, now: Optional[float] = None) -> bool:
    """Count one automatic AudD request against today's cap; False (and
    nothing counted) when the cap is already reached."""
    if cap <= 0:
        return False
    with _claim_lock, db._get_connection() as conn:
        row = conn.execute("SELECT requests FROM radio_scan_usage WHERE month = ? AND provider = ?",
                           (day_key(now), AUDD_AUTO_USAGE)).fetchone()
        if row and int(row[0]) >= cap:
            return False
        conn.execute("INSERT INTO radio_scan_usage (month, provider, requests, found) VALUES (?, ?, 1, 0) "
                     "ON CONFLICT(month, provider) DO UPDATE SET requests = requests + 1",
                     (day_key(now), AUDD_AUTO_USAGE))
        conn.commit()
    return True


# ── Scan now's keys: when each was saved, what its service last said ─────────

SCAN_KEY_STATES = ("ok", "bad_key", "out_of_credit")


def record_scan_key_saved(db, provider: str, now: Optional[float] = None) -> None:
    """A key was saved: its date, and nothing known about it yet."""
    with db._get_connection() as conn:
        conn.execute("INSERT INTO radio_scan_keys (provider, set_at, state, state_at) VALUES (?, ?, NULL, NULL) "
                     "ON CONFLICT(provider) DO UPDATE SET set_at = excluded.set_at, state = NULL, state_at = NULL",
                     (provider, int(now if now is not None else time.time())))
        conn.commit()


def forget_scan_key(db, provider: str) -> None:
    with db._get_connection() as conn:
        conn.execute("DELETE FROM radio_scan_keys WHERE provider = ?", (provider,))
        conn.commit()


def record_scan_key_answer(db, provider: str, state: str, now: Optional[float] = None) -> None:
    """What a service said of its key, from a scan or a Test: ``ok`` (it answered,
    match or not), ``bad_key`` or ``out_of_credit``. Anything else isn't about the key."""
    if state not in SCAN_KEY_STATES:
        return
    with db._get_connection() as conn:
        conn.execute("INSERT INTO radio_scan_keys (provider, set_at, state, state_at) VALUES (?, NULL, ?, ?) "
                     "ON CONFLICT(provider) DO UPDATE SET state = excluded.state, state_at = excluded.state_at",
                     (provider, state, int(now if now is not None else time.time())))
        conn.commit()


def scan_key_states(db) -> Dict[str, Dict[str, Any]]:
    """``{provider: {set_at, state, state_at}}``."""
    with db._get_connection() as conn:
        rows = conn.execute("SELECT provider, set_at, state, state_at FROM radio_scan_keys").fetchall()
    return {r[0]: {"set_at": r[1], "state": r[2], "state_at": r[3]} for r in rows}
