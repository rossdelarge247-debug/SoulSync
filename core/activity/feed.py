"""The Activity feed: what SoulSync did, newest first, and what needs you.

Nothing new is recorded for it except plan outcomes (safety_log). Each item
comes from a history that already exists:

==============  ==============================================  ===========
kind            source                                          scoped by
==============  ==============================================  ===========
download        library_history downloads, folded into          shared (as
                sessions; download batches (sync_history) that  /api/library
                are running, stopped early or had failures      /history)
import          library_history imports (media server scans,    shared
                Staging), folded; auto_import_history rows      Import page
automation      automation_run_history + live runs; library_jobs profile (+
                (Look for releases you don't have) + the live    system rows;
                run                                             jobs: admins
                                                                or who
                                                                started it)
sync            playlist_pipeline_run_history (mirror runs);    profile
                playlist sync_history rows
safety          action_plan_events (preview expired/confirmed)  admin, or
                                                                who previewed
radio           radio_activity: what Internet radio's auto-add  profile
                put on Wanted, one item per station per hour
==============  ==============================================  ===========

Library history writes one row per track, so rows of one type that land
within ``SESSION_GAP_SECONDS`` of each other become one item ("Downloaded 12
tracks"). A completed download batch with no failures is not its own item:
the tracks it landed already are. System automations (seeded, run on short
timers) only show when a run fails, so their housekeeping doesn't bury the
feed; scan_watchlist is the exception because its result is news.

"Needs you" (``needs_you_items``) is computed from current state, not stored,
and ignores the range:

* import: an auto-import folder waiting for a choice (pending_review,
  needs_identification), only partly imported, or failed, until it is
  approved, retried, imported by hand or dismissed;
* sync: a mirrored playlist whose latest mirror run failed, or had a phase
  fail, on authorisation (401/403, token or login errors), until a later run
  works;
* automation: an enabled automation whose latest run failed or timed out,
  until a run works (system automations: admins only);
* download: an album or track batch whose failed tracks are not on Wanted,
  so nothing will try them again, until the same release is downloaded again;
* safety: a preview that expired unconfirmed, until the same tool is
  previewed again or confirmed, or the item is dismissed.
"""

from __future__ import annotations

import base64
import json
import os
import re
import threading
import time
from collections import OrderedDict
from contextlib import closing
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple

from core.activity.common import (
    automations_paused,
    duration_words,
    in_words,
    next_scheduled,
    parse_utc,
    plural,
    size_words,
    utc_text,
    visible_automations,
)
from utils.logging_config import get_logger

logger = get_logger("activity.feed")

KINDS = ("download", "import", "automation", "sync", "safety", "radio")
FILTERS = KINDS + ("needs_you",)
RANGES = ("today", "7d", "30d")
DEFAULT_RANGE = "7d"
DEFAULT_LIMIT = 50
MAX_LIMIT = 200
NEEDS_YOU_LIMIT = 50
SESSION_GAP_SECONDS = 15 * 60
# an auto-import row still "processing" after this long was cut off
STALE_RUNNING_SECONDS = 6 * 3600

# Tie-break order for items with the same timestamp; part of the cursor.
_RANK = {"lh_download": 1, "lh_import": 2, "auto_import": 3, "sync_history": 4,
         "mirror": 5, "automation": 6, "automation_live": 7, "safety": 8, "radio": 9, "library_job": 10}

_SOURCES = {
    "download": ("lh_download", "sync_history"),
    "import": ("lh_import", "auto_import"),
    "automation": ("automation", "automation_live", "library_job"),
    "sync": ("sync_history", "mirror"),
    "safety": ("safety",),
    "radio": ("radio",),
}

_DOWNLOAD_SYNC_TYPES = ("album", "wishlist", "track")
_PLAYLIST_TYPE_SQL = "(sync_type = 'playlist' OR sync_type IS NULL OR sync_type = '')"

# library_history rows by session type. acoustid_scan rows are the scanner's
# review entries, not downloads; Auto-Import rows are auto_import_history's.
# The unary + keeps the planner on the created_at index (a time range) rather
# than the event_type one (every row of a type, ever).
_LH_TYPES = {
    "lh_download": "+event_type = 'download' AND COALESCE(download_source, '') NOT IN ('acoustid_scan', 'Auto-Import', 'Staging')",
    "lh_import": "(+event_type = 'import' OR (+event_type = 'download' AND download_source = 'Staging'))",
}

_AUTH_ERROR = re.compile(
    r"\b(401|403|unauthori[sz]ed|forbidden|auth|authenticat\w*|token|expired|credential\w*|log ?in|sign ?in|oauth)\b",
    re.IGNORECASE)

_MIRROR_ACTIONS = ("playlist_pipeline", "refresh_mirrored", "sync_playlist")

_TOOLS = {
    "duplicate_cleaner": ("Duplicate cleaner", "recycle {n} duplicate files"),
    "deep_scan": ("Deep Scan", "move {n} untracked files to Staging"),
    "repair_bulk_fix": ("Repair fixes", "apply {n} fixes"),
    "recycle_bin_purge": ("Empty recycle bin", "delete {n} files for good"),
    "quarantine_clear": ("Clear quarantine", "delete {n} quarantined files for good"),
    "video_recycle_purge": ("Empty video recycle bin", "delete {n} files for good"),
    "audiobook_recycle_purge": ("Empty audiobook recycle bin", "delete {n} books for good"),
    "video_repair_bulk_fix": ("Video repair fixes", "apply {n} fixes"),
}

# Where an Activity safety row opens, when it isn't the music Tools page.
_TOOL_LINKS = {
    "video_recycle_purge": "/active-downloads?media=video",
    "video_repair_bulk_fix": "/video-tools",
    "audiobook_recycle_purge": "/audiobooks",
}

_SERVER_NAMES = {"plex": "Plex", "jellyfin": "Jellyfin", "navidrome": "Navidrome", "emby": "Emby",
                 "soulsync": "SYNCHRO.S", "subsonic": "Subsonic"}


class CursorError(ValueError):
    """``before`` was not a cursor this endpoint handed out, or a number."""


@dataclass
class Viewer:
    """Who is asking. ``can_see_imports`` follows the Import page permission
    (the auto-import API is that page's)."""
    profile_id: int
    is_admin: bool = False
    can_see_imports: bool = True


@dataclass
class _Ctx:
    conn: Any
    database: Any
    viewer: Viewer
    since: int
    now: int
    automations: Dict[int, Dict[str, Any]]
    live_batches: Dict[str, Dict[str, Any]]
    running_automations: Dict[int, Dict[str, Any]]
    paused: bool
    needs_you_ids: set = field(default_factory=set)
    # owner profile -> source ids known to be on that profile's Wanted list
    wishlisted: Dict[int, set] = field(default_factory=dict)


# ── cursor and range ──────────────────────────────────────────────────────────

def encode_cursor(key: Tuple[int, int, int]) -> str:
    raw = json.dumps([int(key[0]), int(key[1]), int(key[2])], separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(value: Any) -> Optional[Tuple[int, int, int]]:
    """``next_before`` from a previous page, or plain unix seconds (items
    strictly older than that second)."""
    if value in (None, ""):
        return None
    text = str(value).strip()
    try:
        return (int(float(text)), -1, -1)
    except (ValueError, OverflowError):
        pass
    try:
        padded = text + "=" * (-len(text) % 4)
        t, r, i = json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
        return (int(t), int(r), int(i))
    except Exception as exc:  # noqa: BLE001 - any garbage is the same error
        raise CursorError("before is not a cursor from this feed") from exc


def range_start(range_key: str, now: float) -> int:
    """Unix seconds the range starts at. ``today`` is since local midnight on
    the server (pass ``since`` to the endpoint to use the browser's)."""
    if range_key == "today":
        local = datetime.fromtimestamp(now).astimezone()
        return int(local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
    days = 30 if range_key == "30d" else 7
    return int(now) - days * 86400


def _after_cursor(t_expr: str, id_expr: str, rank: int, cursor) -> Tuple[str, list]:
    """SQL for "sorts after the cursor" with key (time, rank, id) descending."""
    if cursor is None:
        return "1=1", []
    t, r, i = cursor
    if rank < r:
        return f"{t_expr} <= ?", [t]
    if rank > r:
        return f"{t_expr} < ?", [t]
    return f"({t_expr} < ? OR ({t_expr} = ? AND {id_expr} < ?))", [t, t, i]


def _before_cursor(key, cursor) -> bool:
    return cursor is None or tuple(key) < tuple(cursor)


def _ts(expr: str) -> str:
    return f"CAST(strftime('%s', {expr}) AS INTEGER)"


def _split(value) -> List[str]:
    return [v for v in str(value or "").split(",") if v]


def _json(value) -> Any:
    if not value:
        return None
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None


def _item(source: str, rid: int, *, id: str, time: int, kind: str, status: str, title: str,
          detail: str, link: str, **extra) -> Dict[str, Any]:
    out = {"id": id, "time": int(time), "kind": kind, "status": status, "title": title,
           "detail": detail, "link": link, "needs_you": False}
    out.update({k: v for k, v in extra.items() if v is not None})
    out["_key"] = (int(time), _RANK[source], int(rid))
    return out


def _sentence(*parts: str) -> str:
    return " · ".join(p for p in parts if p)


def _retry_phrase(ctx: _Ctx, action_types: Iterable[str], lead: str = "Next try") -> Tuple[str, Optional[int]]:
    """("Next try in about 2 hours.", at) from the automation that would run it."""
    if ctx.paused:
        return "Automations are paused, so nothing retries until they're back on.", None
    nxt = next_scheduled(ctx.automations, action_types)
    if not nxt:
        return "", None
    wait = nxt["at"] - ctx.now
    when = in_words(wait) if wait > 0 else "any moment now"
    return f"{lead} {when} ({nxt['automation_name']}).", nxt["at"]


# ── library history sessions ──────────────────────────────────────────────────

# Sessions are recomputed only when library_history changes (new max id or a
# different row count since the range's hour), and a session's details only
# when the session itself changes, so paging and polling stay cheap.
_SESSION_CACHE: Dict[tuple, tuple] = {}
_DETAIL_CACHE: "OrderedDict[tuple, Dict[str, Any]]" = OrderedDict()
_DETAIL_CACHE_MAX = 2048
_cache_lock = threading.Lock()


def clear_caches() -> None:
    with _cache_lock:
        _SESSION_CACHE.clear()
        _DETAIL_CACHE.clear()


def _db_key(ctx: _Ctx) -> str:
    return str(getattr(ctx.database, "database_path", id(ctx.database)))


def _lh_sessions(ctx: _Ctx, source: str) -> List[Dict[str, Any]]:
    """Every session of one type in the range, newest first. Computed over the
    whole range so a session is the same on every page."""
    bucket = ctx.since - ctx.since % 3600
    bucket_text = utc_text(bucket)
    stamp = tuple(ctx.conn.execute(
        "SELECT (SELECT MAX(id) FROM library_history), "
        "(SELECT COUNT(*) FROM library_history WHERE created_at >= ?)", (bucket_text,)).fetchone())
    key = (_db_key(ctx), source, bucket)
    with _cache_lock:
        hit = _SESSION_CACHE.get(key)
    if hit and hit[0] == stamp:
        sessions = hit[1]
    else:
        rows = ctx.conn.execute(
            f"SELECT id, {_ts('created_at')} AS ts FROM library_history "
            f"WHERE created_at >= ? AND {_LH_TYPES[source]} ORDER BY created_at, id", (bucket_text,)).fetchall()
        sessions = []
        cur = None
        for rid, ts in rows:
            if ts is None:
                continue
            if cur is not None and ts - cur["t_max"] <= SESSION_GAP_SECONDS:
                cur["n"] += 1
                cur["t_max"] = ts
                cur["id_min"] = min(cur["id_min"], rid)
                cur["id_max"] = max(cur["id_max"], rid)
            else:
                cur = {"n": 1, "t_min": ts, "t_max": ts, "id_min": rid, "id_max": rid}
                sessions.append(cur)
        sessions.reverse()
        with _cache_lock:
            for stale in [k for k in _SESSION_CACHE if k[:2] == key[:2] and k != key]:
                _SESSION_CACHE.pop(stale, None)
            _SESSION_CACHE[key] = (stamp, sessions)
    return [s for s in sessions if s["t_max"] >= ctx.since]


def _lh_details(ctx: _Ctx, source: str, sessions: List[Dict[str, Any]]) -> Dict[tuple, Dict[str, Any]]:
    """Album count, sources, qualities and origins per session, in one query
    for the sessions not already cached."""
    db = _db_key(ctx)
    out: Dict[tuple, Dict[str, Any]] = {}
    missing = []
    with _cache_lock:
        for s in sessions:
            k = (db, source, s["t_min"], s["t_max"], s["n"])
            if k in _DETAIL_CACHE:
                _DETAIL_CACHE.move_to_end(k)
                out[k] = _DETAIL_CACHE[k]
            else:
                missing.append(s)
    if missing:
        values = ", ".join("(?, ?, ?)" for _ in missing)
        params: list = []
        for i, s in enumerate(missing):
            params += [i, utc_text(s["t_min"]), utc_text(s["t_max"])]
        rows = ctx.conn.execute(f"""
            WITH b(k, lo, hi) AS (VALUES {values})
            SELECT b.k AS k,
                   COUNT(DISTINCT lower(COALESCE(artist_name, '')) || '|' ||
                                  lower(COALESCE(NULLIF(album_name, ''), title, ''))) AS albums,
                   GROUP_CONCAT(DISTINCT NULLIF(download_source, '')) AS sources,
                   GROUP_CONCAT(DISTINCT NULLIF(server_source, '')) AS servers,
                   GROUP_CONCAT(DISTINCT NULLIF(upper(CASE WHEN instr(trim(COALESCE(quality, '')), ' ') > 0
                        THEN substr(trim(quality), 1, instr(trim(quality), ' ') - 1)
                        ELSE trim(COALESCE(quality, '')) END), '')) AS qualities,
                   GROUP_CONCAT(DISTINCT NULLIF(origin, '')) AS origins,
                   COUNT(DISTINCT NULLIF(origin_context, '')) AS origin_contexts,
                   MAX(origin_context) AS origin_context
            FROM b JOIN library_history ON created_at BETWEEN b.lo AND b.hi
            WHERE {_LH_TYPES[source]}
            GROUP BY b.k""", params).fetchall()
        by_index = {r["k"]: dict(r) for r in rows}
        ids = [s["id_max"] for s in missing]
        newest = {r["id"]: dict(r) for r in ctx.conn.execute(
            f"SELECT id, artist_name, album_name, title FROM library_history WHERE id IN ({','.join('?' * len(ids))})",
            ids).fetchall()}
        with _cache_lock:
            for i, s in enumerate(missing):
                detail = by_index.get(i, {})
                detail["newest"] = newest.get(s["id_max"], {})
                k = (db, source, s["t_min"], s["t_max"], s["n"])
                out[k] = _DETAIL_CACHE[k] = detail
            while len(_DETAIL_CACHE) > _DETAIL_CACHE_MAX:
                _DETAIL_CACHE.popitem(last=False)
    return out


def _album_phrase(newest: Dict[str, Any], albums: int) -> str:
    artist = (newest.get("artist_name") or "").strip()
    album = (newest.get("album_name") or "").strip() or (newest.get("title") or "").strip()
    head = f"{album} by {artist}" if album and artist else (album or artist)
    if albums > 1 and head:
        return f"{head} and {albums - 1} more"
    return head


def _quality_phrase(qualities: List[str]) -> str:
    if len(qualities) == 1:
        return qualities[0]
    return "mixed quality" if qualities else ""


def _lh_items(ctx: _Ctx, source: str, sessions: List[Dict[str, Any]], cursor, limit: int) -> List[Dict[str, Any]]:
    rank = _RANK[source]
    picked = [s for s in sessions if _before_cursor((s["t_max"], rank, s["id_max"]), cursor)][:limit]
    if not picked:
        return []
    details = _lh_details(ctx, source, picked)
    db = _db_key(ctx)
    out = []
    for s in picked:
        d = details.get((db, source, s["t_min"], s["t_max"], s["n"]), {})
        n = int(s["n"])
        albums = _album_phrase(d.get("newest") or {}, int(d.get("albums") or 0))
        quality = _quality_phrase(_split(d.get("qualities")))
        ref = {"first_history_id": s["id_min"], "last_history_id": s["id_max"], "tracks": n}
        if source == "lh_download":
            title = f"Downloaded {plural(n, 'track')}"
            origins = set(_split(d.get("origins")))
            if origins == {"playlist"} and d.get("origin_contexts") == 1:
                title += f' for "{d.get("origin_context")}"'
            elif origins == {"watchlist"}:
                title += " from followed artists"
            sources = " and ".join(_split(d.get("sources")))
            out.append(_item(source, s["id_max"], id=f"lh:{s['id_max']}", time=s["t_max"], kind="download",
                             status="ok", title=title, detail=_sentence(albums, sources, quality),
                             link="/active-downloads", ref=ref))
        else:
            servers = [_SERVER_NAMES.get(x.lower(), x.title()) for x in _split(d.get("servers"))]
            via = []
            if servers:
                via.append(f"found by the {' and '.join(servers)} library scan")
            if "Staging" in _split(d.get("sources")):
                via.append("imported from Staging")
            how = " and ".join(via)
            out.append(_item(source, s["id_max"], id=f"lh:{s['id_max']}", time=s["t_max"], kind="import",
                             status="ok", title=f"Added {plural(n, 'track')} to your library",
                             detail=_sentence(albums, how[:1].upper() + how[1:] if how else "", quality),
                             link="/library", ref=ref))
    return out


# ── auto-import ───────────────────────────────────────────────────────────────

_IMPORT_NEEDS_YOU = ("pending_review", "needs_identification", "partial", "failed")


def _auto_import_item(ctx: _Ctx, row: Dict[str, Any]) -> Dict[str, Any]:
    status = row.get("status") or ""
    folder = row.get("folder_name") or "a folder"
    album = row.get("album_name") or ""
    artist = row.get("artist_name") or ""
    release = f'"{album}" by {artist}' if album and artist else (f'"{album}"' if album else f'"{folder}"')
    total = int(row.get("total_files") or 0)
    matched = int(row.get("matched_files") or 0)
    error = (row.get("error_message") or "").strip().rstrip(".")
    t = int(row["_t"] or 0)
    if status in ("processing", "approved", "scanning"):
        if ctx.now - t > STALE_RUNNING_SECONDS:
            st, title = "warning", f"Import of {release} didn't finish"
            detail = "It stopped part way, most likely because SYNCHRO.S restarted. The files are still in the import folder."
        else:
            st, title, detail = "running", f"Importing {release}", f"{plural(total, 'file')} from the import folder"
    elif status == "completed":
        st, title = "ok", f"Imported {release}"
        detail = f"{matched} of {plural(total, 'file')} tagged and filed" if total else "Tagged and filed"
    elif status == "partial":
        st, title = "warning", f"Imported part of {release}"
        detail = (f"{matched} of {total} files imported; the rest are still in the import folder."
                  + (f" {error}." if error else ""))
    elif status == "pending_review":
        conf = row.get("confidence")
        pct = f"{float(conf):.0%} match" if conf is not None else "A possible match"
        st, title = "warning", f'Import needs a decision: "{folder}"'
        detail = f"{pct} to {release}. The files stay in the import folder until you choose."
    elif status == "needs_identification":
        st, title = "warning", f'Couldn\'t identify "{folder}"'
        detail = "No release matched well enough. The files stay in the import folder until you pick one."
    elif status == "failed":
        st, title = "error", f'Import failed: "{folder}"'
        detail = (f"{error}. " if error else "") + "The files are still in the import folder; retry it from Import."
    elif status == "rejected":
        st, title, detail = "info", f'Import dismissed: "{folder}"', "You dismissed this folder; nothing was imported."
    else:
        st, title, detail = "info", f'Import of "{folder}"', status.replace("_", " ").capitalize()
    # import_status says which Import action fits: a choice to make
    # (pending_review, needs_identification), or a retry (failed, partial)
    return _item("auto_import", row["id"], id=f"import:{row['id']}", time=t, kind="import", status=st,
                 title=title, detail=detail, link="/import",
                 ref={"auto_import_id": row["id"], "import_status": status or None})


def _auto_import_query(ctx: _Ctx) -> Tuple[str, list]:
    return ("FROM auto_import_history WHERE created_at >= ?", [utc_text(ctx.since)])


_AUTO_IMPORT_COLS = ("id, folder_name, status, confidence, album_name, artist_name, total_files, "
                     "matched_files, error_message, created_at")


def _auto_import_items(ctx: _Ctx, cursor, limit: int) -> List[Dict[str, Any]]:
    if not ctx.viewer.can_see_imports:
        return []
    frm, params = _auto_import_query(ctx)
    t = _ts("created_at")
    cond, cparams = _after_cursor(t, "id", _RANK["auto_import"], cursor)
    rows = ctx.conn.execute(
        f"SELECT {_AUTO_IMPORT_COLS}, {t} AS _t {frm} AND {cond} ORDER BY created_at DESC, id DESC LIMIT ?",
        params + cparams + [limit]).fetchall()
    return [_auto_import_item(ctx, dict(r)) for r in rows]


# ── download batches and playlist syncs (sync_history) ────────────────────────

def _sync_history_where(ctx: _Ctx, kinds: Iterable[str]) -> Tuple[str, list]:
    owner, params = ctx.database._sync_history_owner_conditions(ctx.viewer.profile_id)
    preds = []
    if "download" in kinds:
        preds.append(f"(sync_type IN ({','.join('?' * len(_DOWNLOAD_SYNC_TYPES))}) "
                     "AND (tracks_failed > 0 OR completed_at IS NULL))")
        params = params + list(_DOWNLOAD_SYNC_TYPES)
    if "sync" in kinds:
        # pipeline syncs are the mirror runs' items, unless still going
        preds.append(f"({_PLAYLIST_TYPE_SQL} AND (COALESCE(playlist_id, '') NOT LIKE 'auto_mirror_%' "
                     "OR completed_at IS NULL))")
    where = " AND ".join(owner + ["(" + " OR ".join(preds) + ")"])
    return where, params


def _failed_tracks(row: Dict[str, Any]) -> Tuple[Dict[str, int], List[str], bool]:
    """(reason counts, failed source ids, results known) from track_results."""
    results = _json(row.get("track_results"))
    if not isinstance(results, list):
        return {}, [], False
    reasons: Dict[str, int] = {}
    ids: List[str] = []
    for r in results:
        if not isinstance(r, dict):
            continue
        ds = r.get("download_status")
        if ds in ("failed", "not_found") or (ds is None and r.get("status") == "not_found"):
            key = "failed" if ds == "failed" else "not_found"
            reasons[key] = reasons.get(key, 0) + 1
            if r.get("source_track_id"):
                ids.append(str(r["source_track_id"]))
    return reasons, ids, True


def _reason_words(reasons: Dict[str, int]) -> str:
    parts = []
    if reasons.get("not_found"):
        n = reasons["not_found"]
        parts.append(f"{n} {'wasn' if n == 1 else 'weren'}'t found")
    if reasons.get("failed"):
        parts.append(f"{reasons['failed']} failed to download")
    return ", ".join(parts)


def _retry_candidate(row: Dict[str, Any]) -> bool:
    return (row.get("sync_type") in ("album", "track") and bool(row.get("completed_at"))
            and int(row.get("tracks_failed") or 0) > 0)


def _row_owner(ctx: _Ctx, row: Dict[str, Any]) -> int:
    return int(row.get("profile_id") or ctx.viewer.profile_id)


def _prime_wishlisted(ctx: _Ctx, rows: Iterable[Dict[str, Any]]) -> None:
    """One Wanted lookup per owner for every failed track in ``rows``."""
    wanted: Dict[int, set] = {}
    for row in rows:
        if _retry_candidate(row):
            wanted.setdefault(_row_owner(ctx, row), set()).update(_failed_tracks(row)[1])
    for owner, ids in wanted.items():
        ids -= ctx.wishlisted.get(owner, set())
        if ids:
            found = ctx.database.get_wishlisted_ids(ids, profile_id=owner)
            ctx.wishlisted.setdefault(owner, set()).update(found)


def _no_retry_left(ctx: _Ctx, row: Dict[str, Any]) -> Optional[bool]:
    """For a finished album/track batch with failures: True when none of the
    failed tracks is on Wanted (nothing will try them again), None if unknown.
    Rows must have been through _prime_wishlisted."""
    if not _retry_candidate(row):
        return None
    _reasons, ids, known = _failed_tracks(row)
    if not known or not ids:
        return None
    return not (set(ids) & ctx.wishlisted.get(_row_owner(ctx, row), set()))


def _sync_history_item(ctx: _Ctx, row: Dict[str, Any]) -> Dict[str, Any]:
    name = row.get("playlist_name") or "a download"
    stype = row.get("sync_type") or "playlist"
    kind = "download" if stype in _DOWNLOAD_SYNC_TYPES else "sync"
    total = int(row.get("total_tracks") or 0)
    found = int(row.get("tracks_found") or 0)
    downloaded = int(row.get("tracks_downloaded") or 0)
    failed = int(row.get("tracks_failed") or 0)
    t = int(row["_t"] or 0)
    ref = {"sync_history_id": row["id"], "batch_id": row.get("batch_id"), "playlist_id": row.get("playlist_id")}
    link = "/active-downloads" if kind == "download" else "/sync"
    live = ctx.live_batches.get(row.get("batch_id") or "")
    retry_at = None
    if live is not None:
        done, total_live = int(live.get("done") or 0), int(live.get("total") or total)
        if stype == "wishlist":
            title = f"Downloading {plural(total_live, 'track')} for Wanted"
        elif kind == "download":
            title = f'Downloading "{name}"'
        elif str(row.get("playlist_id") or "").startswith("auto_mirror_"):
            title = f'Mirroring "{name}"'
        else:
            title = f'Syncing "{name}"'
        detail = _sentence(f"{done} of {total_live} done" if total_live else "Looking for the tracks",
                           f"{live['failed']} failed" if live.get("failed") else "")
        status = "running"
    elif not row.get("completed_at"):
        status = "warning"
        title = f'"{name}" stopped before it finished'
        detail = "It was cut off part way, most likely because SYNCHRO.S restarted. Start it again to pick up the rest."
    elif kind == "download":
        reasons, _ids, _known = _failed_tracks(row)
        why = _reason_words(reasons) or f"{failed} failed"
        if stype == "wishlist":
            title = f"Wanted search: {plural(failed, 'track')} not found this time"
            retry, retry_at = _retry_phrase(ctx, ("process_wishlist",), "Next search")
            detail = f"{why}. They stay on Wanted. {retry}".strip()
            status = "warning"
        else:
            title = f'{failed} of {plural(total, "track")} failed: "{name}"'
            no_retry = _no_retry_left(ctx, row)
            if no_retry:
                detail = f"{why}. They aren't on Wanted, so nothing will try them again."
                status = "error"
            else:
                retry, retry_at = _retry_phrase(ctx, ("process_wishlist",), "Next search")
                tail = f"They're on Wanted. {retry}".strip() if no_retry is False else ""
                detail = f"{why}." + (f" {tail}" if tail else "")
                status = "error" if downloaded == 0 else "warning"
    else:
        title = f'Synced "{name}"'
        detail = _sentence(f"{found} of {total} in your library" if total else "",
                           f"{downloaded} downloaded" if downloaded else "",
                           f"{failed} couldn't be found" if failed else "")
        status = "warning" if failed else "ok"
    return _item("sync_history", row["id"], id=f"batch:{row['id']}", time=t, kind=kind, status=status,
                 title=title, detail=detail, link=link, retry_at=retry_at, ref=ref)


# per-track results only where a failure needs explaining (they can be large)
_SH_COLS = ("id, batch_id, playlist_id, playlist_name, source, sync_type, total_tracks, tracks_found, "
            "tracks_downloaded, tracks_failed, started_at, completed_at, profile_id, "
            "CASE WHEN tracks_failed > 0 AND sync_type IN ('album', 'wishlist', 'track') "
            "THEN track_results END AS track_results")


def _sync_history_items(ctx: _Ctx, kinds, cursor, limit: int) -> List[Dict[str, Any]]:
    where, params = _sync_history_where(ctx, kinds)
    t = _ts("COALESCE(completed_at, started_at)")
    cond, cparams = _after_cursor(t, "id", _RANK["sync_history"], cursor)
    rows = ctx.conn.execute(
        f"SELECT {_SH_COLS}, {t} AS _t FROM sync_history WHERE {where} AND {t} >= ? AND {cond} "
        f"ORDER BY _t DESC, id DESC LIMIT ?",
        params + [ctx.since] + cparams + [limit]).fetchall()
    rows = [dict(r) for r in rows]
    _prime_wishlisted(ctx, rows)
    return [_sync_history_item(ctx, r) for r in rows]


# ── playlist mirror runs ──────────────────────────────────────────────────────

def _mirror_error(row: Dict[str, Any]) -> str:
    """Why a mirror run failed or partly failed ('' when it went fine)."""
    result = _json(row.get("result_json")) or {}
    text = ""
    if isinstance(result, dict):
        text = str(result.get("error") or result.get("discovery_error") or "")
    if not text and (row.get("status") or "").lower() in ("error", "failed", "timed_out", "timeout"):
        text = str(row.get("summary") or "")
    return text.strip()


def _mirror_item(ctx: _Ctx, row: Dict[str, Any]) -> Dict[str, Any]:
    name = row.get("playlist_name") or "a playlist"
    status_raw = (row.get("status") or "").lower()
    before = _json(row.get("before_json")) or {}
    after = _json(row.get("after_json")) or {}
    source = str(row.get("source") or "").replace("_", " ").title()
    took = duration_words(row.get("duration_seconds"))
    why = _mirror_error(row).rstrip(".")
    retry_at = None
    if status_raw in ("error", "failed", "timed_out", "timeout"):
        status = "error"
        title = f'Couldn\'t mirror "{name}"'
        retry, retry_at = _retry_phrase(ctx, _MIRROR_ACTIONS)
        detail = f"{why or 'The mirror run failed'}. {retry}".strip()
    else:
        def num(d, k):
            try:
                return int(d.get(k) or 0)
            except (TypeError, ValueError, AttributeError):
                return 0
        delta = num(after, "track_count") - num(before, "track_count")
        change = (f"{plural(delta, 'new track')}" if delta > 0
                  else f"{plural(-delta, 'track')} removed from the playlist" if delta < 0 else "No changes")
        have = f"{num(after, 'in_library_count')} of {num(after, 'track_count')} in your library" if after else ""
        wanted = f"{num(after, 'wishlisted_count')} on Wanted" if num(after, "wishlisted_count") else ""
        title = f'Mirrored "{name}"'
        if why:
            status = "warning"
            detail = f"{why}. " + _sentence(change, have, wanted)
        else:
            status = "ok"
            detail = _sentence(source, change, have, wanted, took)
    return _item("mirror", row["id"], id=f"mirror:{row['id']}", time=int(row["_t"] or 0), kind="sync",
                 status=status, title=title, detail=detail, link="/sync", retry_at=retry_at,
                 has_log=bool(row.get("has_log")),
                 ref={"mirror_run_id": row["id"], "mirrored_playlist_id": row.get("playlist_id")})


_MIRROR_COLS = ("id, playlist_id, playlist_name, source, trigger_source, started_at, finished_at, "
                "duration_seconds, status, summary, before_json, after_json, result_json, "
                "(log_lines IS NOT NULL AND log_lines NOT IN ('', '[]', 'null')) AS has_log")


_MIRROR_COLS_H = ("h.id, h.playlist_id, h.playlist_name, h.source, h.trigger_source, h.started_at, h.finished_at, "
                  "h.duration_seconds, h.status, h.summary, h.before_json, h.after_json, h.result_json, "
                  "(h.log_lines IS NOT NULL AND h.log_lines NOT IN ('', '[]', 'null')) AS has_log")


def _mirror_items(ctx: _Ctx, cursor, limit: int) -> List[Dict[str, Any]]:
    t = _ts("COALESCE(finished_at, started_at)")
    cond, cparams = _after_cursor(t, "id", _RANK["mirror"], cursor)
    rows = ctx.conn.execute(
        f"SELECT {_MIRROR_COLS}, {t} AS _t FROM playlist_pipeline_run_history "
        f"WHERE profile_id = ? AND {t} >= ? AND {cond} ORDER BY _t DESC, id DESC LIMIT ?",
        [ctx.viewer.profile_id, ctx.since] + cparams + [limit]).fetchall()
    return [_mirror_item(ctx, dict(r)) for r in rows]


# ── automation runs ───────────────────────────────────────────────────────────

def _automation_ids_sql(ctx: _Ctx) -> Tuple[str, list]:
    ids = list(ctx.automations)
    if not ids:
        return "0", []
    return f"h.automation_id IN ({','.join('?' * len(ids))})", ids


# user automations: every run; system ones only when they fail (scan_watchlist
# always); mirror pipeline runs come from their own history; never 'skipped'
_AUTOMATION_RULE = ("h.status != 'skipped' AND (h.status IN ('error', 'timeout') OR "
                    "(COALESCE(a.is_system, 0) = 0 AND a.action_type != 'playlist_pipeline') OR "
                    "a.action_type = 'scan_watchlist')")


def automation_link(automation_id: Any) -> str:
    """The Automations page with this automation selected."""
    try:
        return f"/automations?automation={int(automation_id)}"
    except (TypeError, ValueError):
        return "/automations"


def _automation_item(ctx: _Ctx, row: Dict[str, Any]) -> Dict[str, Any]:
    auto = ctx.automations.get(int(row["automation_id"]), {})
    name = auto.get("name") or "Automation"
    status_raw = (row.get("status") or "").lower()
    summary = re.sub(r"\s+", " ", str(row.get("summary") or "")).strip()
    if len(summary) > 200:
        summary = summary[:197].rstrip() + "…"
    took = duration_words(row.get("duration_seconds"))
    retry_at = None
    ref = {"automation_id": int(row["automation_id"]), "run_id": row["id"]}
    if status_raw == "preview":
        # a preview run (core/automation/dry_run.py): what a run would have
        # done, with nothing changed; the summary already says so
        status = "info"
        title = f'Automation "{name}": preview'
        detail = summary or "Nothing was changed."
        ref["preview"] = True
    elif status_raw in ("error", "timeout"):
        status = "error"
        title = f'Automation "{name}" ' + ("timed out" if status_raw == "timeout" else "failed")
        why = summary.rstrip(".") or "It stopped with an error"
        own_next = parse_utc(auto.get("next_run"))
        if not auto.get("enabled"):
            retry = "It's switched off, so it won't run again until you turn it on."
        elif ctx.paused:
            retry = "Automations are paused, so it won't run again until they're back on."
        elif own_next:
            retry_at = own_next
            retry = f"Next run {in_words(own_next - ctx.now) if own_next > ctx.now else 'any moment now'}."
        elif auto.get("trigger_type") == "schedule":
            retry = ""
        else:
            retry = "It runs again on its next trigger."
        detail = f"{why}. {retry}".strip()
    else:
        status = "ok"
        title = f'Automation "{name}" ran'
        detail = _sentence(summary, took)
    return _item("automation", row["id"], id=f"automation:{row['id']}", time=int(row["_t"] or 0), kind="automation",
                 status=status, title=title, detail=detail, link=automation_link(row["automation_id"]),
                 retry_at=retry_at, has_log=bool(row.get("has_log")), ref=ref)


_AUTOMATION_COLS = ("h.id, h.automation_id, h.started_at, h.finished_at, h.duration_seconds, h.status, h.summary, "
                    "(h.log_lines IS NOT NULL AND h.log_lines NOT IN ('', '[]', 'null')) AS has_log")


def _automation_query(ctx: _Ctx) -> Tuple[str, str, list]:
    ids_sql, ids = _automation_ids_sql(ctx)
    t = _ts("COALESCE(h.finished_at, h.started_at)")
    frm = ("FROM automation_run_history h JOIN automations a ON a.id = h.automation_id "
           f"WHERE {ids_sql} AND {_AUTOMATION_RULE} AND {t} >= ?")
    return frm, t, ids + [ctx.since]


def _automation_items(ctx: _Ctx, cursor, limit: int) -> List[Dict[str, Any]]:
    frm, t, params = _automation_query(ctx)
    cond, cparams = _after_cursor(t, "h.id", _RANK["automation"], cursor)
    rows = ctx.conn.execute(
        f"SELECT {_AUTOMATION_COLS}, {t} AS _t {frm} AND {cond} ORDER BY _t DESC, h.id DESC LIMIT ?",
        params + cparams + [limit]).fetchall()
    return [_automation_item(ctx, dict(r)) for r in rows]


def _live_automation_items(ctx: _Ctx, cursor, limit: int) -> List[Dict[str, Any]]:
    out = []
    for aid, state in ctx.running_automations.items():
        auto = ctx.automations.get(int(aid))
        if not auto:
            continue
        started = parse_utc(state.get("started_at")) or ctx.now
        if started < ctx.since:
            continue
        key = (started, _RANK["automation_live"], int(aid))
        if not _before_cursor(key, cursor):
            continue
        phase = str(state.get("phase") or "").strip()
        pct = state.get("progress")
        detail = _sentence(phase, f"{pct}%" if isinstance(pct, (int, float)) and pct else "")
        out.append(_item("automation_live", int(aid), id=f"automation-live:{aid}", time=started,
                         kind="automation", status="running", title=f'Running "{auto.get("name") or "automation"}"',
                         detail=detail, link=automation_link(aid), ref={"automation_id": int(aid)}))
    out.sort(key=lambda i: i["_key"], reverse=True)
    return out[:limit]


# ── preview outcomes ──────────────────────────────────────────────────────────

def _unattended_delete_item(row: Dict[str, Any]) -> Dict[str, Any]:
    """A file an unattended run deleted under the user's own setting."""
    try:
        facts = json.loads(row.get("counts_json") or "{}")
    except (TypeError, ValueError):
        facts = {}
    facts = facts if isinstance(facts, dict) else {}
    name = os.path.basename(str(facts.get("path") or "")) or "a lossless file"
    label = str(facts.get("label") or "a lossy copy")
    size = size_words(row.get("total_bytes"))
    detail = (f"Converted {name} to {label}, checked the copy, then deleted the lossless original"
              f"{f' ({size})' if size else ''} for good, as the quality profile says.")
    return _item("safety", row["id"], id=f"safety:{row['id']}", time=int(row["_t"] or 0), kind="safety",
                 status="info", title="Lossy copy: lossless original deleted", detail=detail,
                 link="/settings?tab=quality", ref={"tool": row.get("tool"), "path": facts.get("path"),
                                        "kept": facts.get("kept")})


def _safety_item(ctx: _Ctx, row: Dict[str, Any]) -> Dict[str, Any]:
    if row.get("event") == "auto_deleted":
        return _unattended_delete_item(row)
    label, verb = _TOOLS.get(row.get("tool") or "", (str(row.get("tool") or "Tool").replace("_", " ").capitalize(),
                                                     "act on {n} files"))
    n = int(row.get("total") or 0)
    size = size_words(row.get("total_bytes"))
    what = verb.format(n=n) + (f" ({size})" if size else "")
    if row.get("event") == "expired":
        title = f"{label} preview expired"
        if row.get("resolved_at"):
            done = {"confirmed": "a later preview was confirmed", "dismissed": "you dismissed it"}.get(
                row.get("resolution") or "", "it was previewed again")
            status, detail = "info", f"Nothing was changed; {done}."
        else:
            status = "warning"
            detail = f"Nothing was changed. Preview again to {what}."
    else:
        status, title = "info", f"{label}: preview confirmed"
        detail = f"You confirmed the preview to {what}."
    return _item("safety", row["id"], id=f"safety:{row['id']}", time=int(row["_t"] or 0), kind="safety",
                 status=status, title=title, detail=detail,
                 link=_TOOL_LINKS.get(row.get("tool") or "", "/tools"),
                 ref={"tool": row.get("tool"), "plan_id": row.get("plan_id")})


_SAFETY_COLS = ("id, plan_id, tool, event, total, total_bytes, counts_json, profile_id, occurred_at, "
                "resolved_at, resolution")


def _safety_where(ctx: _Ctx) -> Tuple[str, list]:
    return "(? = 1 OR profile_id = ?)", [1 if ctx.viewer.is_admin else 0, ctx.viewer.profile_id]


def _safety_items(ctx: _Ctx, cursor, limit: int) -> List[Dict[str, Any]]:
    where, params = _safety_where(ctx)
    t = "CAST(occurred_at AS INTEGER)"
    cond, cparams = _after_cursor(t, "id", _RANK["safety"], cursor)
    rows = ctx.conn.execute(
        f"SELECT {_SAFETY_COLS}, {t} AS _t FROM action_plan_events WHERE {where} AND occurred_at >= ? "
        f"AND {cond} ORDER BY _t DESC, id DESC LIMIT ?",
        params + [ctx.since] + cparams + [limit]).fetchall()
    return [_safety_item(ctx, dict(r)) for r in rows]


# ── radio auto-add ────────────────────────────────────────────────────────────

def _radio_item(row: Dict[str, Any]) -> Dict[str, Any]:
    n = int(row.get("added") or 0)
    station = str(row.get("station_name") or "a station")
    titles = _json(row.get("titles_json")) or []
    titles = [str(t) for t in titles if t][-3:] if isinstance(titles, list) else []
    more = f" and {n - len(titles)} more" if n > len(titles) else ""
    detail = (f"{'; '.join(titles)}{more}. " if titles else "") + "They're on Wanted at your quality target."
    return _item("radio", row["id"], id=f"radio:{row['id']}", time=int(row["updated_at"] or 0), kind="radio",
                 status="ok", title=f"Auto-add added {plural(n, 'track')} from {station}", detail=detail,
                 link="/wanted", ref={"station_id": row.get("station_id"), "hour_start": row.get("hour_start")})


def _radio_items(ctx: _Ctx, cursor, limit: int) -> List[Dict[str, Any]]:
    cond, cparams = _after_cursor("updated_at", "id", _RANK["radio"], cursor)
    try:
        rows = ctx.conn.execute(
            "SELECT id, station_id, station_name, hour_start, added, titles_json, updated_at FROM radio_activity "
            f"WHERE profile_id = ? AND updated_at >= ? AND {cond} ORDER BY updated_at DESC, id DESC LIMIT ?",
            [ctx.viewer.profile_id, ctx.since] + cparams + [limit]).fetchall()
    except Exception as exc:  # noqa: BLE001 - no table yet reads as nothing
        logger.debug("radio activity unreadable: %s", exc)
        return []
    return [_radio_item(dict(r)) for r in rows]


def _radio_count(ctx: _Ctx) -> int:
    try:
        return int(ctx.conn.execute("SELECT COUNT(*) FROM radio_activity WHERE profile_id = ? AND updated_at >= ?",
                                    (ctx.viewer.profile_id, ctx.since)).fetchone()[0] or 0)
    except Exception:  # noqa: BLE001
        return 0


# ── library jobs (Look for releases you don't have, HANDOFF 68) ─────────────

_JOB_TITLES = {
    "running": "Looking for releases you don't have",
    "done": "Looked for releases you don't have",
    "stopped": "Stopped looking for releases you don't have",
    "failed": "Couldn't finish looking for releases you don't have",
}
_JOB_LINK = "/library?show=incomplete"
_JOB_STOP = "library/missing-releases/stop"


def _job_found(row: Dict[str, Any]) -> str:
    n, artists = int(row.get("found_releases") or 0), int(row.get("found_artists") or 0)
    if not n:
        return "found nothing new"
    return f"found {plural(n, 'release')} by {plural(artists, 'artist')}"


def _job_visible(ctx: _Ctx, profile_id) -> bool:
    try:
        return ctx.viewer.is_admin or int(profile_id) == int(ctx.viewer.profile_id)
    except (TypeError, ValueError):
        return ctx.viewer.is_admin


def _library_job_item(ctx: _Ctx, row: Dict[str, Any], live: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    total = int(row.get("total") or 0)
    if live is not None:
        done = int(live.get("done") or 0)
        detail = _sentence(plural(total, "artist"), f"{done:,} done")
        until = live.get("waiting_until")
        if until:
            detail = _sentence(detail, f"waiting for Spotify's pause, {duration_words(max(1, int(until) - ctx.now))} left")
        return _item("library_job", int(row["id"]), id=f"library-job:{row['id']}", time=int(row["started_at"] or 0),
                     kind="automation", status="running", title=_JOB_TITLES["running"], detail=detail, link=_JOB_LINK,
                     ref={"job_id": int(row["id"]), "stop_path": _JOB_STOP})
    status = row.get("status") or "done"
    if status == "running":
        status = "stopped"  # its thread is gone: a restart cut it off
    done = int(row.get("done") or 0)
    failed = int(row.get("failed") or 0)
    cant = f"{plural(failed, 'artist')} couldn't be checked" if failed else ""
    if status == "done":
        detail, tone = _sentence(plural(total, "artist"), _job_found(row), cant), ("warning" if failed else "ok")
    elif status == "stopped":
        why = "when SYNCHRO.S restarted" if row.get("note") == "restart" else ""
        detail = _sentence(f"Stopped after {done:,} of {plural(total, 'artist')}" + (f" {why}" if why else ""),
                           _job_found(row))
        tone = "warning"
    else:
        detail, tone = _sentence(f"{done:,} of {plural(total, 'artist')} checked", str(row.get("note") or "")), "error"
    t = int(row.get("finished_at") or row.get("started_at") or 0)
    return _item("library_job", int(row["id"]), id=f"library-job:{row['id']}", time=t, kind="automation",
                 status=tone, title=_JOB_TITLES.get(status, _JOB_TITLES["done"]), detail=detail, link=_JOB_LINK,
                 ref={"job_id": int(row["id"])})


def _live_library_job() -> Optional[Dict[str, Any]]:
    try:
        from core.library.missing_releases import JOB
        return JOB.live()
    except Exception:  # noqa: BLE001 - no job module: nothing running
        return None


def _library_job_items(ctx: _Ctx, cursor, limit: int) -> List[Dict[str, Any]]:
    t = "COALESCE(finished_at, started_at)"
    cond, cparams = _after_cursor(t, "id", _RANK["library_job"], cursor)
    try:
        rows = ctx.conn.execute(
            f"SELECT * FROM library_jobs WHERE {t} >= ? AND {cond} ORDER BY {t} DESC, id DESC LIMIT ?",
            [ctx.since] + cparams + [limit]).fetchall()
    except Exception as exc:  # noqa: BLE001 - no table yet reads as nothing
        logger.debug("library jobs unreadable: %s", exc)
        return []
    live = _live_library_job()
    out = []
    for r in rows:
        row = dict(r)
        if not _job_visible(ctx, row.get("profile_id")):
            continue
        is_live = live is not None and int(live.get("id") or 0) == int(row["id"])
        item = _library_job_item(ctx, row, live if is_live else None)
        if _before_cursor(item["_key"], cursor):
            out.append(item)
    return out


def _library_job_count(ctx: _Ctx) -> int:
    try:
        rows = ctx.conn.execute(
            "SELECT profile_id FROM library_jobs WHERE COALESCE(finished_at, started_at) >= ?", (ctx.since,)).fetchall()
    except Exception:  # noqa: BLE001
        return 0
    return sum(1 for r in rows if _job_visible(ctx, r[0]))


# ── needs you ─────────────────────────────────────────────────────────────────

def _needs_you_automation_ids(ctx: _Ctx) -> List[int]:
    """Enabled automations the viewer answers for: their own, and the system
    ones for admins."""
    return [aid for aid, a in ctx.automations.items()
            if a.get("enabled") and (not a.get("is_system") or ctx.viewer.is_admin)]


def _latest_failed_runs_sql(ids: List[int]) -> str:
    """FROM/WHERE for each automation's latest run, when it failed. The
    GROUP BY walks idx_arh_automation_id instead of a subquery per run. A
    preview isn't a run, so it never hides a failure."""
    return ("FROM (SELECT MAX(id) AS mid FROM automation_run_history "
            f"WHERE automation_id IN ({','.join('?' * len(ids))}) AND status != 'preview' "
            "GROUP BY automation_id) m "
            "JOIN automation_run_history h ON h.id = m.mid WHERE h.status IN ('error', 'timeout')")


def _needs_you_mirror_rows(ctx: _Ctx) -> List[Dict[str, Any]]:
    """Latest mirror run per playlist that failed, wholly or in a phase, on
    authorisation. SQL keeps only runs with an error to read."""
    t = _ts("COALESCE(h.finished_at, h.started_at)")
    rows = ctx.conn.execute(
        f"SELECT {_MIRROR_COLS_H}, {t} AS _t FROM (SELECT MAX(id) AS mid FROM playlist_pipeline_run_history "
        "WHERE profile_id = ? AND playlist_id IS NOT NULL GROUP BY playlist_id) m "
        "JOIN playlist_pipeline_run_history h ON h.id = m.mid "
        "WHERE lower(h.status) IN ('error', 'failed', 'timed_out', 'timeout') OR (json_valid(h.result_json) AND "
        "(COALESCE(json_extract(h.result_json, '$.error'), '') != '' "
        " OR COALESCE(json_extract(h.result_json, '$.discovery_error'), '') != ''))",
        [ctx.viewer.profile_id]).fetchall()
    return [dict(r) for r in rows if _AUTH_ERROR.search(_mirror_error(dict(r)))]


# a track_results entry that failed (json_each row j), as _failed_tracks reads it
_FAILED_ENTRY_SQL = ("(json_extract(j.value, '$.download_status') IN ('failed', 'not_found') OR "
                     "(json_extract(j.value, '$.download_status') IS NULL AND json_extract(j.value, '$.status') = 'not_found'))")


def _needs_you_download_rows(ctx: _Ctx) -> List[Dict[str, Any]]:
    """Finished album/track batches with failed tracks, none of them on the
    owner's Wanted list, so nothing retries them. Worked out in SQL
    (json_each against the wishlist's unique index); sync_history keeps the
    last 100 batches."""
    owner, oparams = ctx.database._sync_history_owner_conditions(ctx.viewer.profile_id)
    where = " AND ".join(owner + [
        "sync_type IN ('album', 'track')", "completed_at IS NOT NULL", "tracks_failed > 0",
        "json_valid(track_results)",
        f"EXISTS (SELECT 1 FROM json_each(sync_history.track_results) j WHERE {_FAILED_ENTRY_SQL} "
        "AND COALESCE(json_extract(j.value, '$.source_track_id'), '') != '')",
        "NOT EXISTS (SELECT 1 FROM json_each(sync_history.track_results) j JOIN wishlist_tracks w "
        "ON w.spotify_track_id = json_extract(j.value, '$.source_track_id') "
        f"AND w.profile_id = COALESCE(sync_history.profile_id, ?) WHERE {_FAILED_ENTRY_SQL})",
    ])
    st = _ts("COALESCE(completed_at, started_at)")
    return [dict(r) for r in ctx.conn.execute(
        f"SELECT {_SH_COLS}, {st} AS _t FROM sync_history WHERE {where} ORDER BY _t DESC LIMIT 100",
        oparams + [ctx.viewer.profile_id]).fetchall()]


def needs_you_count(ctx: _Ctx) -> int:
    """How many things need the viewer, without building them: COUNTs where
    the rule is plain SQL, a bounded read where it needs a look at the row."""
    conn = ctx.conn
    n = 0
    if ctx.viewer.can_see_imports:
        n += conn.execute(
            f"SELECT COUNT(*) FROM auto_import_history WHERE status IN ({','.join('?' * len(_IMPORT_NEEDS_YOU))})",
            list(_IMPORT_NEEDS_YOU)).fetchone()[0]
    ids = _needs_you_automation_ids(ctx)
    if ids:
        n += conn.execute(f"SELECT COUNT(*) {_latest_failed_runs_sql(ids)}", ids).fetchone()[0]
    n += len(_needs_you_mirror_rows(ctx))
    n += len(_needs_you_download_rows(ctx))
    where, params = _safety_where(ctx)
    n += conn.execute(
        f"SELECT COUNT(*) FROM action_plan_events WHERE {where} AND event = 'expired' AND resolved_at IS NULL",
        params).fetchone()[0]
    return n


def needs_you_items(ctx: _Ctx) -> Tuple[List[Dict[str, Any]], int]:
    """The newest ``NEEDS_YOU_LIMIT`` things that need the viewer, whatever
    the range, and how many there are in all."""
    items: List[Dict[str, Any]] = []
    conn = ctx.conn
    if ctx.viewer.can_see_imports:
        rows = conn.execute(
            f"SELECT {_AUTO_IMPORT_COLS}, {_ts('created_at')} AS _t FROM auto_import_history "
            f"WHERE status IN ({','.join('?' * len(_IMPORT_NEEDS_YOU))}) ORDER BY created_at DESC, id DESC LIMIT ?",
            list(_IMPORT_NEEDS_YOU) + [NEEDS_YOU_LIMIT]).fetchall()
        items += [_auto_import_item(ctx, dict(r)) for r in rows]

    ids = _needs_you_automation_ids(ctx)
    if ids:
        rows = conn.execute(
            f"SELECT {_AUTOMATION_COLS}, {_ts('COALESCE(h.finished_at, h.started_at)')} AS _t "
            f"{_latest_failed_runs_sql(ids)}", ids).fetchall()
        items += [_automation_item(ctx, dict(r)) for r in rows]

    items += [_mirror_item(ctx, r) for r in _needs_you_mirror_rows(ctx)]
    items += [_sync_history_item(ctx, r) for r in _needs_you_download_rows(ctx)]

    where, params = _safety_where(ctx)
    rows = conn.execute(
        f"SELECT {_SAFETY_COLS}, CAST(occurred_at AS INTEGER) AS _t FROM action_plan_events "
        f"WHERE {where} AND event = 'expired' AND resolved_at IS NULL ORDER BY occurred_at DESC LIMIT ?",
        params + [NEEDS_YOU_LIMIT]).fetchall()
    items += [_safety_item(ctx, dict(r)) for r in rows]

    for item in items:
        item["needs_you"] = True
    items.sort(key=lambda i: i["_key"], reverse=True)
    total = len(items) if len(items) < NEEDS_YOU_LIMIT else needs_you_count(ctx)
    return items[:NEEDS_YOU_LIMIT], total


# ── assembly ──────────────────────────────────────────────────────────────────

def _fetch(ctx: _Ctx, sources: Iterable[str], kinds: Iterable[str], cursor, limit: int,
           sessions: Dict[str, List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for source in sources:
        if source in _LH_TYPES:
            out += _lh_items(ctx, source, sessions[source], cursor, limit)
        elif source == "auto_import":
            out += _auto_import_items(ctx, cursor, limit)
        elif source == "sync_history":
            out += _sync_history_items(ctx, kinds, cursor, limit)
        elif source == "mirror":
            out += _mirror_items(ctx, cursor, limit)
        elif source == "automation":
            out += _automation_items(ctx, cursor, limit)
        elif source == "automation_live":
            out += _live_automation_items(ctx, cursor, limit)
        elif source == "safety":
            out += _safety_items(ctx, cursor, limit)
        elif source == "radio":
            out += _radio_items(ctx, cursor, limit)
        elif source == "library_job":
            out += _library_job_items(ctx, cursor, limit)
    out.sort(key=lambda i: i["_key"], reverse=True)
    return out


def _counts(ctx: _Ctx, sessions) -> Dict[str, int]:
    conn = ctx.conn
    counts = {k: 0 for k in KINDS}
    counts["download"] = len(sessions["lh_download"])
    counts["import"] = len(sessions["lh_import"])
    for kind in ("download", "sync"):
        where, params = _sync_history_where(ctx, (kind,))
        t = _ts("COALESCE(completed_at, started_at)")
        counts[kind] += conn.execute(f"SELECT COUNT(*) FROM sync_history WHERE {where} AND {t} >= ?",
                                     params + [ctx.since]).fetchone()[0]
    if ctx.viewer.can_see_imports:
        frm, params = _auto_import_query(ctx)
        counts["import"] += conn.execute(f"SELECT COUNT(*) {frm}", params).fetchone()[0]
    frm, _t, params = _automation_query(ctx)
    counts["automation"] = conn.execute(f"SELECT COUNT(*) {frm}", params).fetchone()[0] + len(
        _live_automation_items(ctx, None, MAX_LIMIT)) + _library_job_count(ctx)
    t = _ts("COALESCE(finished_at, started_at)")
    counts["sync"] += conn.execute(
        f"SELECT COUNT(*) FROM playlist_pipeline_run_history WHERE profile_id = ? AND {t} >= ?",
        [ctx.viewer.profile_id, ctx.since]).fetchone()[0]
    where, params = _safety_where(ctx)
    counts["safety"] = conn.execute(f"SELECT COUNT(*) FROM action_plan_events WHERE {where} AND occurred_at >= ?",
                                    params + [ctx.since]).fetchone()[0]
    counts["radio"] = _radio_count(ctx)
    return counts


def _running_count(ctx: _Ctx) -> int:
    owner_ok = _batch_visible_fn(ctx)
    n = sum(1 for b in ctx.live_batches.values() if owner_ok(b.get("profile_id")))
    n += sum(1 for aid in ctx.running_automations if int(aid) in ctx.automations)
    live_job = _live_library_job()
    if live_job is not None and _job_visible(ctx, live_job.get("profile_id")):
        n += 1
    if ctx.viewer.can_see_imports:
        n += ctx.conn.execute(
            "SELECT COUNT(*) FROM auto_import_history WHERE status IN ('processing', 'approved', 'scanning') "
            "AND created_at >= ?", [utc_text(ctx.now - STALE_RUNNING_SECONDS)]).fetchone()[0]
    return n


def _batch_visible_fn(ctx: _Ctx):
    pid = int(ctx.viewer.profile_id)

    def ok(owner) -> bool:
        if owner is None:
            return pid == 1
        try:
            return int(owner) == pid
        except (TypeError, ValueError):
            return False
    return ok


def snapshot_live_batches() -> Dict[str, Dict[str, Any]]:
    """Download batches still going, with progress, from runtime state."""
    from core.runtime_state import download_batches, download_tasks, tasks_lock
    out: Dict[str, Dict[str, Any]] = {}
    if not tasks_lock.acquire(timeout=1.0):
        return out
    try:
        for batch_id, batch in download_batches.items():
            if batch.get("phase") in ("complete", "error", "cancelled"):
                continue
            queue = list(batch.get("queue") or [])
            done = sum(1 for task_id in queue
                       if (download_tasks.get(task_id) or {}).get("status") in ("completed", "skipped", "already_owned"))
            out[str(batch_id)] = {
                "phase": batch.get("phase"), "playlist_id": batch.get("playlist_id"),
                "playlist_name": batch.get("playlist_name"), "profile_id": batch.get("profile_id"),
                "total": len(queue), "done": done,
                "failed": len(batch.get("permanently_failed_tracks") or []),
            }
    finally:
        tasks_lock.release()
    return out


def snapshot_running_automations() -> Dict[int, Dict[str, Any]]:
    from core.automation.progress import get_running_progress
    out: Dict[int, Dict[str, Any]] = {}
    for aid, state in get_running_progress().items():
        if state.get("status") != "running":
            continue
        try:
            out[int(aid)] = state
        except (TypeError, ValueError):
            continue
    return out


def _public(item: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in item.items() if not k.startswith("_")}


def _context(conn, database, viewer: Viewer, since: int, now: float, live_batches, running_automations) -> _Ctx:
    running = snapshot_running_automations() if running_automations is None else running_automations
    live = snapshot_live_batches() if live_batches is None else live_batches
    return _Ctx(conn=conn, database=database, viewer=viewer, since=int(since), now=int(now),
                automations=visible_automations(conn, viewer.profile_id), live_batches=live,
                running_automations={int(k): v for k, v in running.items()},
                paused=automations_paused(conn))


def build_status(database, viewer: Viewer, *, now: Optional[float] = None,
                 live_batches: Optional[Dict[str, Dict[str, Any]]] = None,
                 running_automations: Optional[Dict[int, Dict[str, Any]]] = None) -> Dict[str, Any]:
    """The two navigation badges, for polling: what's running and how many
    things need the viewer. Same visibility as the feed; no list, no ranges."""
    now_f = time.time() if now is None else float(now)
    with closing(database._get_connection()) as conn:
        ctx = _context(conn, database, viewer, int(now_f), now_f, live_batches, running_automations)
        return {"running_count": _running_count(ctx), "needs_you_count": needs_you_count(ctx),
                "generated_at": int(now_f)}


def build_feed(database, viewer: Viewer, *, range_key: str = DEFAULT_RANGE, kind: Optional[str] = None,
               limit: int = DEFAULT_LIMIT, before: Any = None, since: Optional[int] = None,
               now: Optional[float] = None, live_batches: Optional[Dict[str, Dict[str, Any]]] = None,
               running_automations: Optional[Dict[int, Dict[str, Any]]] = None) -> Dict[str, Any]:
    """One page of the feed plus counts, running count and the pinned list.

    Raises ValueError (CursorError included) for a bad range, kind or cursor."""
    now_f = time.time() if now is None else float(now)
    if range_key not in RANGES:
        raise ValueError(f"range must be one of {', '.join(RANGES)}")
    if kind not in (None, "", "all") and kind not in FILTERS:
        raise ValueError(f"kind must be one of all, {', '.join(FILTERS)}")
    kind = None if kind in (None, "", "all") else kind
    limit = max(1, min(MAX_LIMIT, int(limit)))
    cursor = decode_cursor(before)
    start = range_start(range_key, now_f)
    if since is not None:
        # a caller's own "today" (browser midnight); never wider than 31 days
        start = max(int(since), int(now_f) - 31 * 86400)

    with closing(database._get_connection()) as conn:
        ctx = _context(conn, database, viewer, start, now_f, live_batches, running_automations)

        pinned, pinned_total = needs_you_items(ctx)
        ctx.needs_you_ids = {i["id"] for i in pinned}
        sessions = {s: _lh_sessions(ctx, s) for s in _LH_TYPES}
        counts = _counts(ctx, sessions)
        counts["needs_you"] = pinned_total

        if kind == "needs_you":
            page, next_before = pinned, None
        else:
            kinds = (kind,) if kind else KINDS
            sources: List[str] = []
            for k in kinds:
                for s in _SOURCES[k]:
                    if s not in sources:
                        sources.append(s)
            merged = _fetch(ctx, sources, kinds, cursor, limit + 1, sessions)
            page = merged[:limit]
            next_before = encode_cursor(page[-1]["_key"]) if len(merged) > limit else None
            for item in page:
                item["needs_you"] = item["id"] in ctx.needs_you_ids

        return {
            "range": range_key,
            "since": start,
            "kind": kind or "all",
            "items": [_public(i) for i in page],
            "next_before": next_before,
            "counts": counts,
            "running_count": _running_count(ctx),
            "needs_you": [_public(i) for i in pinned],
            "generated_at": int(now_f),
        }


def get_log(database, viewer: Viewer, item_id: str) -> Optional[List[Dict[str, Any]]]:
    """The full log of one automation or mirror run the viewer can see, or None."""
    prefix, _, raw = str(item_id or "").partition(":")
    try:
        row_id = int(raw)
    except ValueError:
        return None
    with closing(database._get_connection()) as conn:
        if prefix == "automation":
            automations = visible_automations(conn, viewer.profile_id)
            row = conn.execute("SELECT automation_id, log_lines FROM automation_run_history WHERE id = ?",
                               (row_id,)).fetchone()
            if row is None or int(row["automation_id"]) not in automations:
                return None
        elif prefix == "mirror":
            row = conn.execute("SELECT log_lines FROM playlist_pipeline_run_history WHERE id = ? AND profile_id = ?",
                               (row_id, viewer.profile_id)).fetchone()
            if row is None:
                return None
        else:
            return None
    lines = _json(row["log_lines"])
    return lines if isinstance(lines, list) else []


__all__ = ["KINDS", "FILTERS", "RANGES", "DEFAULT_RANGE", "DEFAULT_LIMIT", "MAX_LIMIT", "SESSION_GAP_SECONDS",
           "CursorError", "Viewer", "build_feed", "build_status", "get_log", "needs_you_items", "needs_you_count", "encode_cursor", "decode_cursor",
           "range_start", "snapshot_live_batches", "snapshot_running_automations"]
