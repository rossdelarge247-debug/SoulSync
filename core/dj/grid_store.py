"""The library's beat grids: one ``track_grid`` row per track (the table and
its migration are in database/music_database.py, ``_add_track_grid_table``),
written by the DJ analysis sweep (core/dj/worker.py) from core/dj/grid.py's
analysis, and shaped here for the routes and the pair planner.

Compact by design: a steady track's grid is its first beat and period, and
phrases, sections and mix regions are counted in bars; only a track whose
tempo drifts keeps its beats (``beats_ms``: the first beat and each gap
after it, in milliseconds). A typical row is well under 1 KB.
"""

from __future__ import annotations

import json
import time
from contextlib import closing
from typing import Any, Dict, Iterable, List, Optional

from core.dj.grid import GRID_VERSION, Grid
from utils.logging_config import get_logger

logger = get_logger("dj.grid_store")

#: below this the downbeat is shown as uncertain (and the planner won't
#: trust phrase-aligned starts on it)
DOWNBEAT_CONFIDENT = 0.3
#: below this the beat grid isn't trusted for beat-matching
BEAT_CONFIDENT = 0.5

_FIELDS = ("grid_version", "analyzed_at", "source_sig", "status", "reason", "kind", "bpm", "period",
           "first_beat", "downbeat_index", "first_downbeat", "beat_confidence", "downbeat_confidence", "meter",
           "bars", "beats_ms", "phrases_json", "sections_json", "mix_json", "analysed_s", "truncated",
           "level_db", "replaygain_db")


def _save(database, track_id: str, values: Dict[str, Any]) -> None:
    fields = [f for f in _FIELDS if f in values]
    cols = ", ".join(["track_id"] + fields)
    marks = ", ".join("?" * (len(fields) + 1))
    updates = ", ".join(f"{f} = excluded.{f}" for f in fields)
    with closing(database._get_connection()) as conn:
        conn.execute(f"INSERT INTO track_grid ({cols}) VALUES ({marks}) "
                     f"ON CONFLICT(track_id) DO UPDATE SET {updates}",
                     [str(track_id)] + [values[f] for f in fields])
        conn.commit()


def encode_beats(beats: Optional[Iterable[float]]) -> Optional[str]:
    """Beat times as ``"first,gap,gap,…"`` in whole milliseconds (the gaps
    rounded so the running sum never drifts more than half a millisecond)."""
    if not beats:
        return None
    ms = [int(round(float(b) * 1000)) for b in beats]
    return ",".join([str(ms[0])] + [str(b - a) for a, b in zip(ms, ms[1:], strict=False)])


def decode_beats(text: Optional[str]) -> Optional[List[float]]:
    if not text:
        return None
    out: List[float] = []
    total = 0
    for i, part in enumerate(str(text).split(",")):
        try:
            value = int(part)
        except ValueError:
            return None
        total = value if i == 0 else total + value
        out.append(total / 1000.0)
    return out


def save_result(database, track_id: str, result: Dict[str, Any], *, source_sig: Optional[str],
                replaygain_db: Optional[float] = None) -> None:
    """Keep one analysis (core/dj/grid.analyze_audio's result)."""
    done = result.get("status") == "done"
    mix = {"in": result.get("mix_in"), "out": result.get("mix_out")} if done else None
    _save(database, track_id, {
        "grid_version": int(result.get("version") or GRID_VERSION), "analyzed_at": time.time(),
        "source_sig": source_sig, "status": "done" if done else "none",
        "reason": None if done else (result.get("reason") or "no_beat"),
        "kind": result.get("kind") if done else None,
        "bpm": result.get("bpm"), "period": result.get("period") if done else None,
        "first_beat": result.get("first_beat") if done else None,
        "downbeat_index": result.get("downbeat_index") if done else None,
        "first_downbeat": result.get("first_downbeat") if done else None,
        "beat_confidence": result.get("beat_confidence"),
        "downbeat_confidence": result.get("downbeat_confidence") if done else None,
        "meter": result.get("meter") if done else None, "bars": result.get("bars") if done else None,
        "beats_ms": encode_beats(result.get("beats")) if done and result.get("kind") == "beats" else None,
        "phrases_json": json.dumps(result.get("phrases") or [], separators=(",", ":")) if done else None,
        "sections_json": json.dumps(result.get("sections") or [], separators=(",", ":")) if done else None,
        "mix_json": json.dumps(mix, separators=(",", ":")) if done else None,
        "analysed_s": result.get("analysed_s"), "truncated": 1 if result.get("truncated") else 0,
        "level_db": result.get("level_db"), "replaygain_db": replaygain_db,
    })


def mark(database, track_id: str, status: str, reason: Optional[str], *, version: int = GRID_VERSION,
         source_sig: Optional[str] = None) -> None:
    """A grid's state without values: ``analyzing`` (before the decode),
    ``error``, ``unreachable`` or ``skipped``."""
    _save(database, track_id, {"grid_version": int(version), "analyzed_at": time.time(), "status": status,
                               "reason": (reason or "")[:300] or None, "source_sig": source_sig,
                               "kind": None, "beats_ms": None, "phrases_json": None, "sections_json": None,
                               "mix_json": None})


def get(database, track_id: str) -> Optional[Dict[str, Any]]:
    with closing(database._get_connection()) as conn:
        row = conn.execute("SELECT * FROM track_grid WHERE track_id = ?", (str(track_id),)).fetchone()
    return dict(row) if row else None


def current(row: Optional[Dict[str, Any]], source_sig: Optional[str]) -> bool:
    """The row is this file's at this grid version (whatever it found)."""
    return bool(row and int(row.get("grid_version") or 0) >= GRID_VERSION
                and row.get("status") in ("done", "none", "error", "skipped")
                and (source_sig is None or row.get("source_sig") == source_sig))


def fail_leftover_analyzing(database) -> int:
    """A grid still ``analyzing`` at a sweep's start: the decode took the
    process down. It's an error, not tried again at this version."""
    with closing(database._get_connection()) as conn:
        cur = conn.execute("UPDATE track_grid SET status = 'error', reason = ? WHERE status = 'analyzing'",
                           ("SYNCHRO.S stopped while finding this track's beats; skipped",))
        conn.commit()
        return int(cur.rowcount or 0)


# ── the sweep's top-up list ──────────────────────────────────────────────────

#: a grid that failed (not one left by a crash) is tried again after this long
ERROR_RETRY_SECONDS = 7 * 24 * 3600.0

#: the grid is due: none yet, an older version, a different file than the DJ
#: data's (a reused id, a replaced file), unreachable a while, or failed a
#: week ago. Shared by pending_ids and counts so the two agree.
_DUE_SQL = ("(g.track_id IS NULL OR COALESCE(g.grid_version, 0) < ? "
            " OR (g.status IN ('done', 'none') AND g.source_sig IS NOT d.source_sig) "
            " OR (g.status = 'unreachable' AND COALESCE(g.analyzed_at, 0) < ?) "
            " OR (g.status = 'error' AND COALESCE(g.analyzed_at, 0) < ? "
            "     AND COALESCE(g.reason, '') NOT LIKE 'SYNCHRO.S stopped%'))")


def pending_ids(database, dj_version: int, *, retry_unreachable_before: Optional[float] = None,
                retry_errors_before: Optional[float] = None, limit: int = 100000) -> List[str]:
    """Tracks whose DJ data is done at ``dj_version`` and whose grid is due
    (the top-up: tracks analysed before grids existed or before a new grid
    version; a grid kept for another file than the DJ data's, as when an id
    is reused). A grid ``unreachable`` comes back once it's older than
    ``retry_unreachable_before``; one that failed once it's older than
    ``retry_errors_before`` (a week by default; never one a crash left)."""
    retry = float(retry_unreachable_before) if retry_unreachable_before is not None else -1.0
    errors = (float(retry_errors_before) if retry_errors_before is not None
              else time.time() - ERROR_RETRY_SECONDS)
    with closing(database._get_connection()) as conn:
        rows = conn.execute(
            "SELECT t.id FROM tracks t JOIN track_dj d ON d.track_id = t.id "
            "LEFT JOIN track_grid g ON g.track_id = t.id "
            "WHERE t.file_path IS NOT NULL AND t.file_path != '' AND d.status = 'done' "
            f"AND COALESCE(d.dj_analyzer_version, 0) >= ? AND {_DUE_SQL} "
            "ORDER BY t.rowid LIMIT ?", (int(dj_version), GRID_VERSION, retry, errors, int(limit))).fetchall()
    return [str(r[0]) for r in rows]


def counts(database) -> Dict[str, int]:
    """Library tracks with a file: how many have a grid at this version, how
    many were analysed without finding a beat, and how many are still to do
    (only tracks whose BPM and key are done count as to do)."""
    with closing(database._get_connection()) as conn:
        row = conn.execute(
            "SELECT SUM(CASE WHEN g.grid_version >= ? AND g.status = 'done' THEN 1 ELSE 0 END) AS done, "
            "SUM(CASE WHEN g.grid_version >= ? AND g.status = 'none' THEN 1 ELSE 0 END) AS no_beat, "
            f"SUM(CASE WHEN d.status = 'done' AND {_DUE_SQL} THEN 1 ELSE 0 END) AS pending "
            "FROM tracks t LEFT JOIN track_dj d ON d.track_id = t.id LEFT JOIN track_grid g ON g.track_id = t.id "
            "WHERE t.file_path IS NOT NULL AND t.file_path != ''",
            (GRID_VERSION, GRID_VERSION, GRID_VERSION, -1.0, time.time() - ERROR_RETRY_SECONDS)).fetchone()
    return {"done": int(row["done"] or 0), "no_beat": int(row["no_beat"] or 0), "pending": int(row["pending"] or 0)}


# ── shaping for the routes and the planner ───────────────────────────────────

def grid_of(row: Dict[str, Any]) -> Optional[Grid]:
    """A done row's grid as times (core/dj/grid.Grid)."""
    if not row or row.get("status") != "done" or not row.get("period"):
        return None
    return Grid(kind=row.get("kind") or "constant", period=float(row["period"]),
                first_beat=float(row.get("first_beat") or 0.0), downbeat_index=int(row.get("downbeat_index") or 0),
                beats=decode_beats(row.get("beats_ms")))


def _loads(text: Optional[str], default):
    if not text:
        return default
    try:
        return json.loads(text)
    except ValueError:
        return default


def _region(grid: Grid, value) -> Optional[Dict[str, Any]]:
    if not isinstance(value, list) or len(value) < 4:
        return None
    start_bar, end_bar, confidence, how = value[:4]
    return {"start_bar": int(start_bar), "end_bar": int(end_bar), "start": round(grid.bar(start_bar), 3),
            "end": round(grid.bar(end_bar), 3), "bars": int(end_bar) - int(start_bar),
            "confidence": float(confidence), "how": how}


#: a not-analysed reason for each row state
_REASONS = {None: "not_analyzed", "analyzing": "analyzing", "error": "error", "unreachable": "unreachable",
            "skipped": "too_long"}


def public(row: Optional[Dict[str, Any]], track_id: str, *, with_beats: bool = True,
           dj_status: Optional[str] = None) -> Dict[str, Any]:
    """One track's grid for the page and the engine: the tempo and grid,
    downbeats, phrases, sections, the mix-in and mix-out regions and how sure
    each is, the loudness; or ``analyzed: false`` with ``reason``
    (``not_analyzed``, ``analyzing``, ``too_short``, ``no_beat``,
    ``too_long``, ``unreachable``, ``error``). Times are seconds from the
    file's start; bars count from the first downbeat.

    ``dj_status`` is the track's DJ row status: a track whose BPM and key
    couldn't be worked out (skipped, error, unreachable) before grids
    existed has no grid row, and says why instead of ``not_analyzed``,
    which would wait for ever (gauntlet M1)."""
    track_id = str(track_id)
    if row is None and dj_status in ("skipped", "error", "unreachable"):
        row = {"grid_version": GRID_VERSION, "status": dj_status}
    status = (row or {}).get("status")
    stale = row is not None and int(row.get("grid_version") or 0) < GRID_VERSION
    if row is None or stale or status != "done":
        if row is None or stale:
            reason = "not_analyzed"
        elif status == "none":
            reason = row.get("reason") or "no_beat"
        else:
            reason = _REASONS.get(status, "not_analyzed")
        out: Dict[str, Any] = {"track_id": track_id, "analyzed": False, "reason": reason}
        if row is not None and status == "none" and row.get("beat_confidence") is not None:
            out["beat_confidence"] = row.get("beat_confidence")
        return out
    grid = grid_of(row)
    assert grid is not None
    bars = int(row.get("bars") or 0)
    dconf = float(row.get("downbeat_confidence") or 0.0)
    meter = row.get("meter") or "4/4"
    note = None
    if meter != "4/4":
        note = "The accents don't fall in fours: bars and phrases assume 4/4 and may be off."
    elif dconf < DOWNBEAT_CONFIDENT:
        note = "Not sure which beat is the one: bars and phrases may be a beat or two off."
    phrases = [{"bar": int(p[0]), "time": round(grid.bar(p[0]), 3), "level": int(p[1]), "section": bool(p[2])}
               for p in _loads(row.get("phrases_json"), []) if isinstance(p, list) and len(p) >= 3]
    sections = [{"kind": s[0], "start_bar": int(s[1]), "end_bar": int(s[2]), "start": round(grid.bar(s[1]), 3),
                 "end": round(grid.bar(s[2]), 3), "confidence": float(s[3])}
                for s in _loads(row.get("sections_json"), []) if isinstance(s, list) and len(s) >= 4]
    mix = _loads(row.get("mix_json"), {}) or {}
    rg = row.get("replaygain_db")
    level = row.get("level_db")
    beats = grid.beats if (with_beats and grid.kind == "beats") else None
    return {
        "track_id": track_id, "analyzed": True, "version": int(row.get("grid_version") or GRID_VERSION),
        "bpm": row.get("bpm"),
        "grid": {"kind": grid.kind, "first_beat": round(grid.first_beat, 4), "period": round(grid.period, 6),
                 "beats": [round(b, 3) for b in beats] if beats else None,
                 "confidence": float(row.get("beat_confidence") or 0.0),
                 "steady": grid.kind == "constant",
                 "confident": float(row.get("beat_confidence") or 0.0) >= BEAT_CONFIDENT},
        "downbeats": {"first": round(grid.bar(0), 4), "beat_index": grid.downbeat_index, "beats_per_bar": 4,
                      "meter": meter, "confidence": dconf,
                      "uncertain": meter != "4/4" or dconf < DOWNBEAT_CONFIDENT, "note": note},
        "bars": bars,
        "phrases": phrases,
        "sections": sections,
        "mix_in": _region(grid, mix.get("in")),
        "mix_out": _region(grid, mix.get("out")),
        "loudness": {"replaygain_db": rg, "level_db": level,
                     "source": "replaygain" if rg is not None else ("analysis" if level is not None else None)},
        "analysed_s": row.get("analysed_s"), "truncated": bool(row.get("truncated")),
    }


def public_entry(entry: Dict[str, Any], track_id: str, *, with_beats: bool = True) -> Dict[str, Any]:
    """``public`` for one of ``scoped_rows``' entries."""
    return public(entry.get("grid"), track_id, with_beats=with_beats, dj_status=entry.get("dj_status"))


def scoped_rows(database, track_ids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    """For each id in the caller's library (the DJ routes' scope), its grid
    row (None when there's none yet) beside the track's duration, DJ BPM,
    key, title and DJ status: ``{id: {"grid": row | None, "duration_s",
    "bpm", "key", "title", "dj_status"}}``. Ids
    outside the library aren't in the answer."""
    from core.dj.store import _BPM_SQL, _scope

    ids = [str(t) for t in track_ids if t not in (None, "")][:500]
    out: Dict[str, Dict[str, Any]] = {}
    if not ids:
        return out
    where, params = _scope(database)
    with closing(database._get_connection()) as conn:
        for start in range(0, len(ids), 250):
            chunk = ids[start:start + 250]
            marks = ",".join("?" * len(chunk))
            # "?" placeholders and the library scope's fixed fragment are
            # formatted in; every value is a bound parameter
            rows = conn.execute(  # nosemgrep: sqlalchemy-execute-raw-query
                f"SELECT t.id AS tid, t.title AS track_title, t.duration AS duration, {_BPM_SQL} AS eff_bpm, "
                f"d.musical_key AS musical_key, d.status AS dj_status, "
                f"g.* FROM tracks t LEFT JOIN track_dj d ON d.track_id = t.id "
                f"LEFT JOIN track_grid g ON g.track_id = t.id WHERE t.id IN ({marks}) AND {where}",
                chunk + params).fetchall()
            for r in rows:
                r = dict(r)
                duration = r.get("duration")
                try:
                    duration_s = float(duration) / 1000.0 if duration else None
                except (TypeError, ValueError):
                    duration_s = None
                out[str(r["tid"])] = {"grid": r if r.get("track_id") else None, "duration_s": duration_s,
                                      "bpm": r.get("eff_bpm"), "key": r.get("musical_key"),
                                      "title": r.get("track_title"), "dj_status": r.get("dj_status")}
    return out


__all__ = ["BEAT_CONFIDENT", "DOWNBEAT_CONFIDENT", "ERROR_RETRY_SECONDS", "counts", "current", "decode_beats", "encode_beats",
           "fail_leftover_analyzing", "get", "grid_of", "mark", "pending_ids", "public", "public_entry", "save_result",
           "scoped_rows"]
