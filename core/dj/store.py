"""The library's DJ data: one ``track_dj`` row per track (the table and its
migration are in database/music_database.py, ``_add_track_dj_table``).

Which value is kept, and why (``*_source`` says which won):

* **BPM:** the file's own tag, else the BPM enrichment found (``tracks.bpm``:
  Beatport, Deezer, Tidal or HiFi at import, or the BPM Backfill job), else
  analysis. A tag or a label's figure was set by a person or the label;
  analysis can lock onto half or double the beat.
* **Key:** the file's own tag (in any spelling, kept in canonical form), else
  analysis, with its confidence.
* **Energy:** analysis only; nothing else gives one.

What analysis heard is kept beside a tag's value (``analyzed_bpm``,
``analyzed_key``), so a later "replace the tags" choice has it to hand.
"""

from __future__ import annotations

import time
from contextlib import closing
from typing import Any, Dict, Iterable, List, Optional, Tuple

from core.dj.camelot import bpm_relation, bpm_windows, compatible_keys, fold_bpm, parse_key
from utils.logging_config import get_logger

logger = get_logger("dj.store")

#: how sure analysis must be before its key is shown without "key uncertain"
#: (Sample Studio's own threshold)
KEY_CONFIDENT = 0.5


# ── deciding what to keep ────────────────────────────────────────────────────

def decide(*, tag_bpm=None, tag_key=None, enrichment_bpm=None,
           analysis: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The values to keep from what the file, enrichment and analysis said."""
    analysis = analysis or {}
    out: Dict[str, Any] = {"bpm": None, "bpm_source": None, "musical_key": None, "key_name": None,
                           "key_source": None, "key_confidence": None, "energy": None, "energy_source": None,
                           "analyzed_bpm": fold_bpm(analysis.get("bpm")), "analyzed_key": None}
    akey = parse_key((analysis.get("key") or {}).get("name"))
    if akey:
        out["analyzed_key"] = akey["camelot"]

    try:
        enrichment = float(enrichment_bpm) if enrichment_bpm is not None else None
    except (TypeError, ValueError):
        enrichment = None
    if tag_bpm:
        out["bpm"], out["bpm_source"] = round(float(tag_bpm), 1), "tag"
    elif enrichment and enrichment > 0:
        out["bpm"], out["bpm_source"] = round(enrichment, 1), "enrichment"
    elif out["analyzed_bpm"]:
        out["bpm"], out["bpm_source"] = out["analyzed_bpm"], "analysis"

    tkey = parse_key(tag_key)
    if tkey:
        out.update(musical_key=tkey["camelot"], key_name=tkey["name"], key_source="tag")
    elif akey:
        conf = (analysis.get("key") or {}).get("confidence")
        out.update(musical_key=akey["camelot"], key_name=akey["name"], key_source="analysis",
                   key_confidence=float(conf) if conf is not None else None)

    if analysis.get("energy") is not None:
        out["energy"], out["energy_source"] = int(analysis["energy"]), "analysis"
    return out


# ── reading and writing rows ─────────────────────────────────────────────────

_FIELDS = ("bpm", "bpm_source", "musical_key", "key_name", "key_source", "key_confidence", "energy",
           "energy_source", "analyzed_bpm", "analyzed_key", "dj_analyzed_at", "dj_analyzer_version", "source_sig",
           "status", "error", "tags_written", "tags_written_at")


def save(database, track_id: str, values: Dict[str, Any]) -> None:
    """Upsert one track's row with ``values`` (any of _FIELDS)."""
    fields = [f for f in _FIELDS if f in values]
    if not fields:
        return
    cols = ", ".join(["track_id"] + fields)
    marks = ", ".join("?" * (len(fields) + 1))
    updates = ", ".join(f"{f} = excluded.{f}" for f in fields)
    with closing(database._get_connection()) as conn:
        conn.execute(f"INSERT INTO track_dj ({cols}) VALUES ({marks}) "
                     f"ON CONFLICT(track_id) DO UPDATE SET {updates}",
                     [str(track_id)] + [values[f] for f in fields])
        conn.commit()


def get(database, track_id: str) -> Optional[Dict[str, Any]]:
    with closing(database._get_connection()) as conn:
        row = conn.execute("SELECT * FROM track_dj WHERE track_id = ?", (str(track_id),)).fetchone()
    return dict(row) if row else None


def mark(database, track_id: str, status: str, error: Optional[str], version: int) -> None:
    """Record a track that couldn't be analysed (``error``) or reached
    (``unreachable``), so the job doesn't ask again at this version."""
    save(database, track_id, {"status": status, "error": (error or "")[:300] or None,
                              "dj_analyzer_version": int(version), "dj_analyzed_at": time.time()})


# ── the job's work list ──────────────────────────────────────────────────────

def pending_ids(database, version: int, *, retry_unreachable_before: Optional[float] = None,
                limit: int = 100000) -> List[str]:
    """Tracks with a file and no DJ row at ``version``, oldest first. Rows
    marked ``unreachable`` (the file wasn't there) come back once they're
    older than ``retry_unreachable_before`` (None: never)."""
    retry = float(retry_unreachable_before) if retry_unreachable_before is not None else -1.0
    with closing(database._get_connection()) as conn:
        rows = conn.execute(
            "SELECT t.id FROM tracks t LEFT JOIN track_dj d ON d.track_id = t.id "
            "WHERE t.file_path IS NOT NULL AND t.file_path != '' AND ("
            "  d.track_id IS NULL OR COALESCE(d.dj_analyzer_version, 0) < ? "
            "  OR (d.status = 'unreachable' AND COALESCE(d.dj_analyzed_at, 0) < ?)) "
            "ORDER BY t.rowid LIMIT ?", (int(version), retry, int(limit))).fetchall()
    return [str(r[0]) for r in rows]


def counts(database, version: int) -> Dict[str, int]:
    """Library tracks with a file, how many have DJ data at this version, and
    how many couldn't be analysed or reached."""
    with closing(database._get_connection()) as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS tracks, "
            "SUM(CASE WHEN d.dj_analyzer_version >= ? AND d.status = 'done' THEN 1 ELSE 0 END) AS analyzed, "
            "SUM(CASE WHEN d.dj_analyzer_version >= ? AND d.status = 'error' THEN 1 ELSE 0 END) AS failed, "
            "SUM(CASE WHEN d.status = 'unreachable' THEN 1 ELSE 0 END) AS unreachable "
            "FROM tracks t LEFT JOIN track_dj d ON d.track_id = t.id "
            "WHERE t.file_path IS NOT NULL AND t.file_path != ''", (int(version), int(version))).fetchone()
    tracks = int(row["tracks"] or 0)
    analyzed = int(row["analyzed"] or 0)
    failed = int(row["failed"] or 0)
    unreachable = int(row["unreachable"] or 0)
    return {"tracks": tracks, "analyzed": analyzed, "failed": failed, "unreachable": unreachable,
            "pending": max(0, tracks - analyzed - failed - unreachable)}


def track_row(database, track_id: str) -> Optional[Dict[str, Any]]:
    """What the job needs about a library track: its stored path and the BPM
    enrichment found."""
    with closing(database._get_connection()) as conn:
        row = conn.execute("SELECT id, file_path, bpm FROM tracks WHERE id = ?", (str(track_id),)).fetchone()
    return dict(row) if row else None


# ── shaping for the routes ───────────────────────────────────────────────────

def public(row: Optional[Dict[str, Any]], *, enrichment_bpm=None) -> Optional[Dict[str, Any]]:
    """One track's DJ data for the page: ``{bpm, bpm_source, key, key_name,
    key_long, key_source, key_confidence, key_uncertain, energy, analyzed}``.
    A track analysis hasn't reached yet still shows the BPM enrichment found."""
    row = row or {}
    bpm = row.get("bpm")
    source = row.get("bpm_source")
    if bpm is None and enrichment_bpm:
        try:
            bpm, source = round(float(enrichment_bpm), 1), "enrichment"
        except (TypeError, ValueError):
            bpm = None
    key = parse_key(row.get("musical_key")) if row.get("musical_key") else None
    if bpm is None and key is None and row.get("energy") is None:
        return None
    conf = row.get("key_confidence")
    return {
        "bpm": bpm, "bpm_source": source,
        "key": key["camelot"] if key else None,
        "key_name": key["name"] if key else None,
        "key_long": key["long"] if key else None,
        "key_source": row.get("key_source") if key else None,
        "key_confidence": conf,
        "key_uncertain": bool(key and row.get("key_source") == "analysis" and conf is not None
                              and float(conf) < KEY_CONFIDENT),
        "energy": row.get("energy"),
        "analyzed": row.get("status") == "done",
    }


def lookup(database, track_ids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    """DJ data for many tracks at once (the track rows' BPM and key)."""
    ids = [str(t) for t in track_ids if t not in (None, "")][:500]
    if not ids:
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    with closing(database._get_connection()) as conn:
        for start in range(0, len(ids), 250):
            chunk = ids[start:start + 250]
            marks = ",".join("?" * len(chunk))
            rows = conn.execute(
                f"SELECT t.id AS tid, t.bpm AS enrichment_bpm, d.* FROM tracks t "
                f"LEFT JOIN track_dj d ON d.track_id = t.id WHERE t.id IN ({marks})", chunk).fetchall()
            for r in rows:
                shaped = public(dict(r), enrichment_bpm=r["enrichment_bpm"])
                if shaped:
                    out[str(r["tid"])] = shaped
    return out


# ── the Library's Tracks view and "Mixes well with…" ─────────────────────────

SORTS = ("bpm", "key", "energy", "title", "artist", "recent")

_BPM_SQL = "COALESCE(d.bpm, NULLIF(t.bpm, 0))"


def _scope(database, alias: str = "t") -> Tuple[str, List[Any]]:
    clauses, values = [], []
    try:
        from core.settings import config_manager

        server = config_manager.get_active_media_server()
    except Exception:  # noqa: BLE001 - no config: every server
        server = None
    if server:
        clauses.append(f"({alias}.server_source = ? OR {alias}.server_source IS NULL)")
        values.append(server)
    try:
        sql, params = database._current_scope_sql(f"{alias}.owner_profile_id")
        clauses.append(sql)
        values.extend(params)
    except Exception as exc:  # noqa: BLE001 - a bare test database has no scope
        logger.debug("no library scope: %s", exc)
    return " AND ".join(clauses) or "1=1", values


def _track_select() -> str:
    return (f"SELECT t.id AS id, t.title AS title, t.duration AS duration, t.file_path AS file_path, "
            f"t.bitrate AS bitrate, t.album_id AS album_id, t.artist_id AS artist_id, t.bpm AS enrichment_bpm, "
            f"COALESCE(NULLIF(t.track_artist, ''), ar.name) AS artist_name, al.title AS album_title, "
            f"al.thumb_url AS album_thumb, {_BPM_SQL} AS eff_bpm, d.* "
            f"FROM tracks t LEFT JOIN track_dj d ON d.track_id = t.id "
            f"LEFT JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id ")


def _shape_track(row, fix_art=None) -> Dict[str, Any]:
    r = dict(row)
    thumb = r.get("album_thumb")
    if thumb and fix_art:
        try:
            thumb = fix_art(thumb)
        except Exception as exc:  # noqa: BLE001 - the stored art stands
            logger.debug("art url unfixable: %s", exc)
    return {
        "id": str(r["id"]), "title": r.get("title") or "", "artist_name": r.get("artist_name") or "",
        "album_title": r.get("album_title") or "", "artist_id": r.get("artist_id"), "album_id": r.get("album_id"),
        "duration_ms": r.get("duration"), "file_path": r.get("file_path"), "bitrate": r.get("bitrate"),
        "image_url": thumb or None,
        "dj": public(r, enrichment_bpm=r.get("enrichment_bpm")),
    }


def browse(database, *, bpm_min=None, bpm_max=None, key: str = "", q: str = "", sort: str = "bpm",
           page: int = 1, limit: int = 50, fix_art=None) -> Dict[str, Any]:
    """Library tracks with a file, filtered by a BPM range, a Camelot key
    (``key``, or ``key:mix`` for the key and the keys that mix with it) and
    text, sorted. Tracks without the sort's value go last."""
    where, params = _scope(database)
    clauses = [where, "t.file_path IS NOT NULL", "t.file_path != ''"]
    values: List[Any] = list(params)
    if bpm_min is not None:
        clauses.append(f"{_BPM_SQL} >= ?")
        values.append(float(bpm_min))
    if bpm_max is not None:
        clauses.append(f"{_BPM_SQL} <= ?")
        values.append(float(bpm_max))
    key = (key or "").strip()
    with_mix = key.endswith(":mix")
    code = parse_key(key[:-4] if with_mix else key)
    if code:
        keys = list(compatible_keys(code["camelot"])) if with_mix else [code["camelot"]]
        clauses.append(f"d.musical_key IN ({','.join('?' * len(keys))})")
        values.extend(keys)
    if q:
        like = f"%{q.strip()}%"
        clauses.append("(t.title LIKE ? OR ar.name LIKE ? OR t.track_artist LIKE ? OR al.title LIKE ?)")
        values.extend([like] * 4)
    sort = sort if sort in SORTS else "bpm"
    order = {
        "bpm": f"{_BPM_SQL} IS NULL, {_BPM_SQL}, t.title COLLATE NOCASE",
        "key": "d.musical_key IS NULL, CAST(d.musical_key AS INTEGER), SUBSTR(d.musical_key, -1), "
               f"{_BPM_SQL}",
        "energy": "d.energy IS NULL, d.energy DESC, t.title COLLATE NOCASE",
        "title": "t.title COLLATE NOCASE",
        "artist": "artist_name COLLATE NOCASE, al.title COLLATE NOCASE, t.track_number",
        "recent": "t.created_at DESC, t.rowid DESC",
    }[sort]
    limit = max(1, min(200, int(limit or 50)))
    page = max(1, int(page or 1))
    base = (f"FROM tracks t LEFT JOIN track_dj d ON d.track_id = t.id "
            f"LEFT JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id "
            f"WHERE {' AND '.join(clauses)}")
    with closing(database._get_connection()) as conn:
        total = int(conn.execute(f"SELECT COUNT(*) {base}", values).fetchone()[0])
        rows = conn.execute(f"{_track_select()} WHERE {' AND '.join(clauses)} ORDER BY {order} LIMIT ? OFFSET ?",
                            values + [limit, (page - 1) * limit]).fetchall()
    return {"tracks": [_shape_track(r, fix_art) for r in rows], "total": total, "page": page, "limit": limit,
            "has_more": page * limit < total, "sort": sort}


#: how each harmonic relation ranks in "Mixes well with…": the same key first
_KEY_RANK = {"same": 0, "relative": 1, "up": 2, "down": 2}
_BPM_RANK = {"same": 0, "half": 1, "double": 1}


def mixes_with(database, track_id: str, *, limit: int = 50, fix_art=None) -> Dict[str, Any]:
    """Tracks that mix well with one: the same key, ±1 on the Camelot wheel or
    the relative major/minor, at a BPM within ±6% (half and double time
    count). Ranked by key (same, then relative, then neighbours), then
    tempo (same before half/double), then the closest BPM."""
    where, params = _scope(database)
    with closing(database._get_connection()) as conn:
        seed_row = conn.execute(f"{_track_select()} WHERE t.id = ?", (str(track_id),)).fetchone()
        if seed_row is None:
            return {"track": None, "matches": [], "reason": "unknown"}
        seed = _shape_track(seed_row, fix_art)
        dj = seed["dj"] or {}
        if not dj.get("bpm") or not dj.get("key"):
            return {"track": seed, "matches": [], "reason": "not_analyzed"}
        keys = compatible_keys(dj["key"])
        windows = bpm_windows(dj["bpm"])
        bpm_sql = " OR ".join(f"({_BPM_SQL} BETWEEN ? AND ?)" for _ in windows)
        values = list(params) + list(keys) + [v for w in windows for v in w] + [str(track_id)]
        rows = conn.execute(
            f"{_track_select()} WHERE {where} AND t.file_path IS NOT NULL AND t.file_path != '' "
            f"AND d.musical_key IN ({','.join('?' * len(keys))}) AND ({bpm_sql}) AND t.id != ? LIMIT 2000",
            values).fetchall()
    matches = []
    for row in rows:
        shaped = _shape_track(row, fix_art)
        other = shaped["dj"] or {}
        relation = bpm_relation(dj["bpm"], other.get("bpm"))
        key_rel = keys.get(other.get("key") or "")
        if relation is None or key_rel is None:
            continue
        shaped["key_relation"] = key_rel
        shaped["bpm_relation"] = relation[0]
        shaped["bpm_diff_pct"] = round(relation[1] * 100, 1)
        matches.append(shaped)
    matches.sort(key=lambda m: (_KEY_RANK[m["key_relation"]], _BPM_RANK[m["bpm_relation"]],
                                abs(m["bpm_diff_pct"]), m["title"].lower()))
    return {"track": seed, "matches": matches[:max(1, min(200, int(limit)))], "total": len(matches),
            "reason": None if matches else "none"}


__all__ = ["KEY_CONFIDENT", "SORTS", "browse", "counts", "decide", "get", "lookup", "mark", "mixes_with",
           "pending_ids", "public", "save", "track_row"]
