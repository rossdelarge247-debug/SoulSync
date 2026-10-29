"""The library's DJ data: one ``track_dj`` row per track (the table and its
migration are in database/music_database.py, ``_add_track_dj_table``).

Which value is kept, and why (``*_source`` says which won):

* **BPM:** the file's own tag, else the BPM enrichment found (``tracks.bpm``:
  Beatport, Deezer, Tidal or HiFi at import, or the BPM Backfill job), else
  analysis. A tag or a label's figure was set by a person or the label. One
  exception: a tag or enrichment at half the analysis's tempo, where the
  analysis chose the fast octave (core/sample/tempo.py: drum and bass tagged
  87, analysed 174), is the same tempo, and the analysis's octave is kept.
* **The BPM shown** (``_BPM_SQL`` and ``public``) is, first, the one a person
  set with ×2 or ÷2 (``bpm_override``, ``bpm_source`` ``override``: no
  analysis ever undoes it); then the beat grid's measured BPM once the track
  has a grid at this version (``grid``: HANDOFF 300, tags no longer win over
  a measured grid); then the value above.
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

from core.dj.camelot import BPM_TOLERANCE, bpm_relation, bpm_windows, compatible_keys, fold_bpm, parse_key
from core.dj.grid import BEAT_CONFIDENT, GRID_VERSION
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
    # drum and bass tagged (or enriched) 87 that the analysis found at 174
    # from evidence (the file's genre, or the backbeat at 174): the same
    # tempo, at the analysis's octave. Never when the fast reading is only
    # the tracker's ("kept") or the range's (under 78): a boom-bap track
    # tagged 72 that librosa reads at 144 keeps its tag. Never halves a tag.
    from core.sample.tempo import EVIDENCE, is_fast

    heard = out["analyzed_bpm"]
    out["analyzed_bpm_basis"] = analysis.get("tempo_basis")
    if (out["bpm_source"] in ("tag", "enrichment") and heard and is_fast(heard)
            and out["analyzed_bpm_basis"] in EVIDENCE and abs(out["bpm"] * 2 - heard) / heard <= 0.04):
        out["bpm"], out["bpm_source"] = heard, "analysis"

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
           "status", "error", "tags_written", "tags_written_at", "analyzed_bpm_basis", "bpm_tag_written")


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
    """Record a track's state without values: ``analyzing`` (written before
    the decode, so a crash mid-track is known at the next start), ``error``,
    ``unreachable`` or ``skipped`` (too long to analyse), so the job doesn't
    ask again at this version. ``version`` 0 puts it back in the queue."""
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
            "SUM(CASE WHEN d.status = 'unreachable' THEN 1 ELSE 0 END) AS unreachable, "
            "SUM(CASE WHEN d.dj_analyzer_version >= ? AND d.status = 'skipped' THEN 1 ELSE 0 END) AS skipped "
            "FROM tracks t LEFT JOIN track_dj d ON d.track_id = t.id "
            "WHERE t.file_path IS NOT NULL AND t.file_path != ''", (int(version),) * 3).fetchone()
    tracks = int(row["tracks"] or 0)
    analyzed = int(row["analyzed"] or 0)
    failed = int(row["failed"] or 0)
    unreachable = int(row["unreachable"] or 0)
    skipped = int(row["skipped"] or 0)
    return {"tracks": tracks, "analyzed": analyzed, "failed": failed, "unreachable": unreachable,
            "skipped": skipped, "pending": max(0, tracks - analyzed - failed - unreachable - skipped)}


def requeue(database, track_id: str, why: str) -> None:
    """Put a track back in the queue (its row stays, at version 0)."""
    mark(database, track_id, "stale", why, 0)


def fail_leftover_analyzing(database) -> int:
    """At a sweep's start: a track still marked ``analyzing`` was being decoded
    when SYNCHRO.S stopped (perhaps the decode itself took the process down).
    It becomes an error with that reason and isn't tried again at this
    version, so one file can't crash every boot."""
    with closing(database._get_connection()) as conn:
        cur = conn.execute(
            "UPDATE track_dj SET status = 'error', error = ? WHERE status = 'analyzing'",
            ("SYNCHRO.S stopped while analysing this track (it may be too big to analyse); skipped",))
        conn.commit()
        return int(cur.rowcount or 0)


def track_row(database, track_id: str) -> Optional[Dict[str, Any]]:
    """What the job needs about a library track: its stored path and the BPM
    enrichment found."""
    with closing(database._get_connection()) as conn:
        row = conn.execute("SELECT id, file_path, bpm FROM tracks WHERE id = ?", (str(track_id),)).fetchone()
    return dict(row) if row else None


# ── shaping for the routes ───────────────────────────────────────────────────

def _positive(value) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 and number == number and number != float("inf") else None


def public(row: Optional[Dict[str, Any]], *, enrichment_bpm=None) -> Optional[Dict[str, Any]]:
    """One track's DJ data for the page: ``{bpm, bpm_source, bpm_tag, key,
    key_name, key_long, key_source, key_confidence, key_uncertain, energy,
    analyzed, skipped, bpm_unsure}``. A track analysis hasn't reached yet still shows the BPM
    enrichment found.

    The BPM is the person's ×2 / ÷2 (``override``), else the grid's measured
    one (``grid``, when the row carries ``grid_bpm``: a done grid at this
    version), else the tag, enrichment or analysis. ``bpm_tag`` is the
    file's tag when another value is shown (300's "Tagged 123")."""
    row = row or {}
    bpm = _positive(row.get("bpm"))
    source = row.get("bpm_source") if bpm is not None else None
    if bpm is None and enrichment_bpm:
        bpm = _positive(enrichment_bpm)
        if bpm is not None:
            bpm, source = round(bpm, 1), "enrichment"
    tag = bpm if source == "tag" else None
    grid_bpm = _positive(row.get("grid_bpm"))
    if grid_bpm is not None:
        bpm, source = round(grid_bpm, 2), "grid"
    override = _positive(row.get("bpm_override"))
    if override is not None:
        bpm, source = round(override, 2), "override"
    key = parse_key(row.get("musical_key")) if row.get("musical_key") else None
    skipped = row.get("error") if row.get("status") == "skipped" else None
    if bpm is None and key is None and row.get("energy") is None and not skipped:
        return None
    conf = row.get("key_confidence")
    return {
        "bpm": bpm, "bpm_source": source,
        "bpm_tag": tag if (tag is not None and source != "tag") else None,
        "key": key["camelot"] if key else None,
        "key_name": key["name"] if key else None,
        "key_long": key["long"] if key else None,
        "key_source": row.get("key_source") if key else None,
        "key_confidence": conf,
        "key_uncertain": bool(key and row.get("key_source") == "analysis" and conf is not None
                              and float(conf) < KEY_CONFIDENT),
        "energy": row.get("energy"),
        "analyzed": row.get("status") == "done",
        "skipped": skipped,
        # held for beat-matching only until a person says which octave
        # (``_BPM_UNSURE``): the track's "BPM is right"
        "bpm_unsure": bool(row.get("bpm_unsure")),
    }


def lookup(database, track_ids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    """DJ data for many tracks at once (the track rows' BPM and key)."""
    ids = [str(t) for t in track_ids if t not in (None, "")][:500]
    if not ids:
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    where, params = _scope(database)
    with closing(database._get_connection()) as conn:
        for start in range(0, len(ids), 250):
            chunk = ids[start:start + 250]
            marks = ",".join("?" * len(chunk))
            rows = conn.execute(
                f"SELECT t.id AS tid, t.bpm AS enrichment_bpm, {_GRID_BPM} AS grid_bpm, {_BPM_UNSURE} AS bpm_unsure, "
                f"d.* FROM tracks t "
                f"LEFT JOIN track_dj d ON d.track_id = t.id {_GRID_JOIN} WHERE t.id IN ({marks}) AND {where}",
                chunk + params).fetchall()
            for r in rows:
                shaped = public(dict(r), enrichment_bpm=r["enrichment_bpm"])
                if shaped:
                    out[str(r["tid"])] = shaped
    return out


# ── the Library's Tracks view and "Mixes well with…" ─────────────────────────

SORTS = ("bpm", "key", "energy", "title", "artist", "recent")

#: the grid's measured BPM, from a done grid at this version that's ready to
#: mix (HANDOFF 300; since grid v5's review only a ready one: a grid held back
#: may be at the wrong octave, and the DJ data's BPM stands then). Since its
#: second review also a grid held only for its octave (ready at the octave
#: it's at, or since the third at its ×2 or ÷2: ``octave`` in its mix
#: regions) when the DJ data's BPM isn't an octave of it: untagged drum and
#: bass at 174 showed the analysis's 117.5, whose ×2 (235) nobody wants. At
#: an octave of the DJ data's BPM, that one shows, and a ×2, ÷2 or "BPM is
#: right" from it puts the grid at the octave chosen, in one press.
#: Every query that uses it or _BPM_SQL joins the grid as ``g`` (_GRID_JOIN)
_GRID_DONE = f"g.status = 'done' AND g.grid_version >= {int(GRID_VERSION)}"
def _octave_sql(key: str) -> str:
    return (f"COALESCE(CASE WHEN json_valid(g.mix_json) THEN json_extract(g.mix_json, '$.octave.\"{key}\"') END, 0)")


#: the grid would be ready at the octave it's at, once a person says so
_OCTAVE_FREE = f"{_octave_sql('1')} >= {float(BEAT_CONFIDENT)}"
#: or at its ×2 or ÷2: shown, so that one press of Double or Halve from the
#: BPM shown reaches it (grid v5's third review: a real Amen read at 85 under
#: an analysis's 117.5 showed 117.5, whose ×2 is 235)
_OCTAVE_ANY = (f"MAX({_octave_sql('1')}, {_octave_sql('2')}, {_octave_sql('0.5')}) "
               f">= {float(BEAT_CONFIDENT)}")
_NOT_OCTAVE_OF_DJ = ("(d.bpm IS NULL OR d.bpm <= 0 OR (ABS(g.bpm / d.bpm - 2.0) > 0.08 "
                     "AND ABS(g.bpm / d.bpm - 0.5) > 0.02 AND ABS(g.bpm / d.bpm - 1.0) > 0.04))")
_GRID_BPM = (f"CASE WHEN {_GRID_DONE} AND COALESCE(g.beat_confidence, 0) >= {float(BEAT_CONFIDENT)} THEN g.bpm "
             f"WHEN {_GRID_DONE} AND {_OCTAVE_ANY} AND {_NOT_OCTAVE_OF_DJ} THEN g.bpm END")
_GRID_JOIN = "LEFT JOIN track_grid g ON g.track_id = t.id"
#: the BPM shown: a person's ×2 / ÷2, the measured grid, the DJ data, enrichment
_BPM_SQL = f"COALESCE(d.bpm_override, {_GRID_BPM}, d.bpm, NULLIF(t.bpm, 0))"
#: a grid held only because its octave (or a related tempo) isn't sure, with
#: no person's BPM yet: the BPM's "BPM is right" (``confirm``) releases it
_BPM_UNSURE = (f"CASE WHEN {_GRID_DONE} AND d.bpm_override IS NULL "
               f"AND COALESCE(g.beat_confidence, 0) < {float(BEAT_CONFIDENT)} AND {_OCTAVE_FREE} THEN 1 ELSE 0 END")


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
    except Exception as exc:  # noqa: BLE001 - no scope: show nothing rather than everyone's
        logger.warning("library scope unreadable, showing no tracks: %s", exc)
        return "1=0", []
    return " AND ".join(clauses) or "1=1", values


def _track_select() -> str:
    return (f"SELECT t.id AS id, t.title AS title, t.duration AS duration, t.file_path AS file_path, "
            f"t.bitrate AS bitrate, t.album_id AS album_id, t.artist_id AS artist_id, t.bpm AS enrichment_bpm, "
            f"COALESCE(NULLIF(t.track_artist, ''), ar.name) AS artist_name, al.title AS album_title, "
            f"al.thumb_url AS album_thumb, {_BPM_SQL} AS eff_bpm, {_GRID_BPM} AS grid_bpm, "
            f"{_BPM_UNSURE} AS bpm_unsure, "
            f"t.owner_profile_id AS track_owner, d.* "
            f"FROM tracks t LEFT JOIN track_dj d ON d.track_id = t.id {_GRID_JOIN} "
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
        # everyone's library (no owner): only an admin sets its BPM by hand
        "shared": r.get("track_owner") is None,
    }


def browse(database, *, bpm_min=None, bpm_max=None, key: str = "", q: str = "", sort: str = "bpm",
           page: int = 1, limit: int = 50, fix_art=None, profile_id: Optional[int] = None,
           starred: bool = False) -> Dict[str, Any]:
    """Library tracks with a file, filtered by a BPM range, a Camelot key
    (``key``, or ``key:mix`` for the key and the keys that mix with it) and
    text, sorted. Tracks without the sort's value go last.

    With ``profile_id`` each track says whether that profile starred it
    (``starred``). ``starred`` (Tracks' Starred filter, 24a) keeps only that
    profile's starred tracks, and keeps a starred track whose file has gone
    missing too, marked ``file_missing`` (it keeps its star, BACKLOG)."""
    where, params = _scope(database)
    only_starred = bool(starred and profile_id is not None)
    clauses = [where] if only_starred else [where, "t.file_path IS NOT NULL", "t.file_path != ''"]
    values: List[Any] = list(params)
    if only_starred:
        clauses.append("t.id IN (SELECT st.track_id FROM track_stars st WHERE st.profile_id = ?)")
        values.append(int(profile_id))
    if bpm_min is not None:
        clauses.append(f"{_BPM_SQL} >= ?")
        values.append(float(bpm_min))
    if bpm_max is not None:
        clauses.append(f"{_BPM_SQL} <= ?")
        values.append(float(bpm_max))
    key = (key or "").strip()
    with_mix = key.endswith(":mix")
    code = parse_key(key[:-4] if with_mix else key)
    keys: List[str] = []
    if code:
        keys = mix_keys(code["camelot"]) if with_mix else [code["camelot"]]
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
    base = (f"FROM tracks t LEFT JOIN track_dj d ON d.track_id = t.id {_GRID_JOIN} "
            f"LEFT JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id "
            f"WHERE {' AND '.join(clauses)}")
    with closing(database._get_connection()) as conn:
        total = int(conn.execute(f"SELECT COUNT(*) {base}", values).fetchone()[0])
        rows = conn.execute(f"{_track_select()} WHERE {' AND '.join(clauses)} ORDER BY {order} LIMIT ? OFFSET ?",
                            values + [limit, (page - 1) * limit]).fetchall()
    tracks = [_shape_track(r, fix_art) for r in rows]
    if profile_id is not None:
        if only_starred:
            mine = {t["id"] for t in tracks}
        else:
            from core.stars.store import starred_among

            mine = starred_among(database, int(profile_id), [t["id"] for t in tracks])
        for track in tracks:
            track["starred"] = track["id"] in mine
            track["file_missing"] = not track.get("file_path")
    return {"tracks": tracks, "total": total, "page": page, "limit": limit,
            "has_more": page * limit < total, "sort": sort, "keys": keys}


#: the order the count line names the keys in: the key, then −1 and +1 on
#: the wheel, then the relative major or minor ("8A, 7A, 9A or 8B")
_MIX_ORDER = {"same": 0, "down": 1, "up": 2, "relative": 3}


def mix_keys(code: str) -> List[str]:
    """The Camelot codes a key filter with "and keys that mix" covers, in the
    order Tracks' count line names them."""
    found = compatible_keys(code)
    return sorted(found, key=lambda k: _MIX_ORDER[found[k]])


#: how each harmonic relation ranks in "Mixes well with…": the same key first
#: ("other" is any other key, only when the Mix tab widens to any key)
_KEY_RANK = {"same": 0, "relative": 1, "up": 2, "down": 2, "other": 3}
_BPM_RANK = {"same": 0, "half": 1, "double": 1}


#: how far "Widen" may take the tempo window, as a fraction
MAX_TOLERANCE = 0.12
#: the most candidate rows one "Mixes well with" reads
MIXES_READ = 2000


def mixes_with(database, track_id: str, *, limit: int = 50, fix_art=None,
               tolerance: float = BPM_TOLERANCE, any_key: bool = False) -> Dict[str, Any]:
    """Tracks that mix well with one: the same key, ±1 on the Camelot wheel or
    the relative major/minor, at a BPM within ±6% (``tolerance``; half and
    double time count). Ranked by key (same, then relative, then
    neighbours), then tempo (same before half/double), then the closest
    BPM.

    ``any_key`` (the Mix tab's "Widen the search", 29d) keeps every track
    with a known key in the tempo window; one outside the four that mix is
    ``key_relation`` "other" and ranks after them."""
    tolerance = min(MAX_TOLERANCE, max(0.01, float(tolerance)))
    within = round(tolerance * 100)
    where, params = _scope(database)
    with closing(database._get_connection()) as conn:
        seed_row = conn.execute(f"{_track_select()} WHERE t.id = ? AND {where}",
                                [str(track_id)] + list(params)).fetchone()
        if seed_row is None:
            return {"track": None, "matches": [], "reason": "unknown", "within": within}
        seed = _shape_track(seed_row, fix_art)
        dj = seed["dj"] or {}
        if not dj.get("bpm") or not dj.get("key"):
            return {"track": seed, "matches": [], "total": 0, "reason": "not_analyzed", "within": within}
        keys = compatible_keys(dj["key"])
        windows = bpm_windows(dj["bpm"], tolerance)
        bpm_sql = " OR ".join(f"({_BPM_SQL} BETWEEN ? AND ?)" for _ in windows)
        key_sql = ("d.musical_key IS NOT NULL AND d.musical_key != ''" if any_key
                   else f"d.musical_key IN ({','.join('?' * len(keys))})")
        values = (list(params) + ([] if any_key else list(keys)) + [v for w in windows for v in w]
                  + [str(track_id)])
        # a fixed SELECT, fixed key and tempo fragments with "?" placeholders
        # and the library scope's fixed fragment are formatted in; every
        # value is a bound parameter
        # any key: the four that mix come first, then the closest tempo, so
        # the cap can only cut the furthest of the other keys (gauntlet L6)
        order_sql = ""
        if any_key:
            order_sql = (f" ORDER BY CASE WHEN d.musical_key IN ({','.join('?' * len(keys))}) THEN 0 ELSE 1 END, "
                         f"ABS({_BPM_SQL} - ?)")
            values = values + list(keys) + [float(dj["bpm"])]
        rows = conn.execute(  # nosemgrep: sqlalchemy-execute-raw-query
            f"{_track_select()} WHERE {where} AND t.file_path IS NOT NULL AND t.file_path != '' "
            f"AND {key_sql} AND ({bpm_sql}) AND t.id != ?{order_sql} LIMIT {MIXES_READ}",
            values).fetchall()
    matches = []
    for row in rows:
        shaped = _shape_track(row, fix_art)
        other = shaped["dj"] or {}
        relation = bpm_relation(dj["bpm"], other.get("bpm"), tolerance)
        key_rel = keys.get(other.get("key") or "")
        if key_rel is None and any_key and other.get("key"):
            key_rel = "other"
        if relation is None or key_rel is None:
            continue
        shaped["key_relation"] = key_rel
        shaped["bpm_relation"] = relation[0]
        shaped["bpm_diff_pct"] = round(relation[1] * 100, 1)
        matches.append(shaped)
    matches.sort(key=lambda m: (_KEY_RANK[m["key_relation"]], _BPM_RANK[m["bpm_relation"]],
                                abs(m["bpm_diff_pct"]), m["title"].lower()))
    return {"track": seed, "matches": matches[:max(1, min(200, int(limit)))], "total": len(matches),
            "reason": None if matches else "none", "within": within}


# ── a person's ×2 or ÷2 ───────────────────────────────────────────────────────

#: what the BPM route does to each track
TEMPO_ACTIONS = {"double": 2.0, "halve": 0.5, "reset": None, "confirm": 1.0}
#: a BPM a person can set by ×2 or ÷2 stays within this
OVERRIDE_RANGE = (40.0, 300.0)
#: the most tracks one request changes
MAX_TEMPO_TRACKS = 500


def set_tempo(database, track_ids: Iterable[str], action: str, *,
              profile_id: Optional[int] = None, is_admin: bool) -> Dict[str, Any]:
    """Double, halve, confirm or reset the BPM of the caller's tracks
    (``action`` ``double``, ``halve``, ``confirm`` or ``reset``), only those
    in their library scope
    (``_scope``, as every DJ read). The value is kept as ``bpm_override``,
    which analysis never writes, so no later analysis undoes it. Each
    track's grid follows at once without a decode, always worked out from
    the grid as measured (grid_store.follow_override, which keeps it), and
    ``reset`` puts the measured grid back. ``confirm`` ("BPM is right")
    keeps the BPM shown as the person's: a grid held only because its octave
    wasn't sure is then ready in one press, at the octave shown (grid v5's
    third review; Design question 399). The person's BPM and the grid are
    written in one transaction, which the sweep's grid save also takes, so
    neither can undo the other.

    A shared track (no owner: everyone's library) is changed by an admin
    only; a member changes the tracks of their own library.

    ``{"changed": {id: bpm | None}, "skipped": {id: reason}, "found": n}``;
    reasons ``no_bpm`` (nothing to double yet), ``out_of_range`` (it would
    leave 40-300), ``not_set`` (reset with nothing set), ``shared`` (a
    member, a shared track) and ``not_yours`` (a member, another profile's
    track). Ids outside the caller's library aren't in the answer."""
    from core.dj import grid_store

    if action not in TEMPO_ACTIONS:
        raise ValueError("action must be double, halve, confirm or reset")
    factor = TEMPO_ACTIONS[action]
    ids = list(dict.fromkeys(str(t) for t in track_ids if t not in (None, "")))[:MAX_TEMPO_TRACKS]
    changed: Dict[str, Optional[float]] = {}
    skipped: Dict[str, str] = {}
    if not ids:
        return {"changed": changed, "skipped": skipped, "found": 0}
    where, params = _scope(database)
    rows = []
    with closing(database._get_connection()) as conn:
        conn.execute("BEGIN IMMEDIATE")
        try:
            for start in range(0, len(ids), 250):
                chunk = ids[start:start + 250]
                marks = ",".join("?" * len(chunk))
                # "?" placeholders, the fixed grid fragments and the library
                # scope's fixed fragment are formatted in; every value is bound
                rows.extend(dict(r) for r in conn.execute(  # nosemgrep: sqlalchemy-execute-raw-query
                    f"SELECT t.id AS tid, t.owner_profile_id AS owner, {_BPM_SQL} AS eff_bpm, "
                    f"d.bpm_override AS bpm_override FROM tracks t LEFT JOIN track_dj d ON d.track_id = t.id "
                    f"{_GRID_JOIN} WHERE t.id IN ({marks}) AND {where}", chunk + params).fetchall())
            now = time.time()
            for r in rows:
                tid = str(r["tid"])
                owner = r["owner"]
                if not is_admin and (owner is None or profile_id is None or str(owner) != str(profile_id)):
                    skipped[tid] = "shared" if owner is None else "not_yours"
                    continue
                if factor is None:
                    if r["bpm_override"] is None:
                        skipped[tid] = "not_set"
                        continue
                    conn.execute("UPDATE track_dj SET bpm_override = NULL, bpm_override_at = ?, "
                                 "bpm_override_by = ? WHERE track_id = ?", (now, profile_id, tid))
                    grid_store.apply_override(conn, tid, None)
                    changed[tid] = None
                    continue
                current = _positive(r["eff_bpm"])
                if current is None:
                    skipped[tid] = "no_bpm"
                    continue
                target = round(current * factor, 2)
                if not OVERRIDE_RANGE[0] <= target <= OVERRIDE_RANGE[1]:
                    skipped[tid] = "out_of_range"
                    continue
                conn.execute("INSERT INTO track_dj (track_id, bpm_override, bpm_override_at, bpm_override_by) "
                             "VALUES (?, ?, ?, ?) ON CONFLICT(track_id) DO UPDATE SET "
                             "bpm_override = excluded.bpm_override, bpm_override_at = excluded.bpm_override_at, "
                             "bpm_override_by = excluded.bpm_override_by", (tid, target, now, profile_id))
                grid_store.apply_override(conn, tid, target)
                changed[tid] = target
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
    return {"changed": changed, "skipped": skipped, "found": len(rows)}


__all__ = ["KEY_CONFIDENT", "MAX_TEMPO_TRACKS", "SORTS", "TEMPO_ACTIONS", "browse", "counts", "decide",
           "fail_leftover_analyzing", "get", "lookup", "mark", "mix_keys", "mixes_with", "pending_ids", "public",
           "requeue", "save", "set_tempo", "track_row"]
