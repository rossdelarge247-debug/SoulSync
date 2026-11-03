"""DJ mode's cue points (Brief F 3b, 37g; 439, 445): four per track, a
person's own (one profile's cues never show for another), on the track's
beat grid.

Each cue is a slot 1–4 with its place as a bar on the grid (``bar``: bars
from the first downbeat, fractional to the beat) and as seconds. The bar is
the truth while the track has a grid: a re-analysis that moves the grid
moves the cue with it (``seconds`` is worked out again from the grid on
every read). Without a grid the seconds are.

Only a track in the caller's library scope can have cues read or written
(the same scope as the rest of ``/api/library/dj``). Export to Traktor
writes them as hot cues 1–4 (core/dj/traktor.py).
"""

from __future__ import annotations

import math
import time
from contextlib import closing
from typing import Any, Dict, Iterable, List, Optional

from utils.logging_config import get_logger

logger = get_logger("dj.cues")

#: four cue points a track (439)
SLOTS = (1, 2, 3, 4)
#: the furthest a cue can sit (seconds): a 10-hour file is past any DJ's
MAX_SECONDS = 36_000.0
#: how many tracks' cues one read for an export takes at a time
_CHUNK = 250


class CueError(ValueError):
    """A body that isn't four cues or fewer, each in range."""


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    v = float(value)
    return v if math.isfinite(v) else None


def clean(cues: Any) -> List[Dict[str, Any]]:
    """The body's cues, checked: at most four, slots 1–4 each once, a place
    in range. Raises CueError with the words to send back."""
    if not isinstance(cues, list):
        raise CueError("cues must be a list")
    if len(cues) > len(SLOTS):
        raise CueError("At most four cues a track")
    out: Dict[int, Dict[str, Any]] = {}
    for cue in cues:
        if not isinstance(cue, dict):
            raise CueError("Each cue is {slot, bar, seconds}")
        slot = cue.get("slot")
        if isinstance(slot, bool) or slot not in SLOTS:
            raise CueError("A cue's slot is 1, 2, 3 or 4")
        if slot in out:
            raise CueError("Each slot once")
        seconds = _number(cue.get("seconds"))
        if seconds is None or not 0 <= seconds <= MAX_SECONDS:
            raise CueError("A cue's place is seconds into the track")
        bar = cue.get("bar")
        if bar is not None:
            bar = _number(bar)
            if bar is None or not -16 <= bar <= 10_000:
                raise CueError("A cue's bar is a number on the grid")
        out[int(slot)] = {"slot": int(slot), "bar": bar, "seconds": round(seconds, 4)}
    return [out[s] for s in sorted(out)]


def _in_scope(database, track_id: str) -> bool:
    from core.dj.store import _scope

    # ``where`` is the library scope's fixed SQL (core/dj/store.py _scope);
    # every value, the id included, is a bound parameter
    where, params = _scope(database)
    with closing(database._get_connection()) as conn:
        return conn.execute(f"SELECT 1 FROM tracks t WHERE t.id = ? AND {where}",  # nosemgrep: sqlalchemy-execute-raw-query
                            [track_id, *params]).fetchone() is not None


def _grids(database, ids: List[str]) -> Dict[str, Any]:
    from core.dj import grid_store

    out: Dict[str, Any] = {}
    for tid in ids:
        try:
            g = grid_store.grid_of(grid_store.get(database, tid) or {})
        except Exception as exc:  # noqa: BLE001 - a cue without its grid keeps its seconds
            logger.debug("grid unreadable for cues: %s", exc)
            g = None
        if g is not None:
            out[tid] = g
    return out


def _placed(row: Dict[str, Any], grid) -> Dict[str, Any]:
    bar = row.get("bar")
    seconds = float(row.get("seconds") or 0.0)
    if grid is not None and bar is not None:
        try:
            seconds = max(0.0, float(grid.bar(float(bar))))
        except Exception as exc:  # noqa: BLE001 - the stored seconds stand
            logger.debug("cue off its grid: %s", exc)
    return {"slot": int(row["slot"]), "bar": bar, "seconds": round(seconds, 4)}


def get(database, profile_id: int, track_id: str) -> Optional[List[Dict[str, Any]]]:
    """The profile's cues on a track (None outside the caller's library)."""
    track_id = str(track_id)
    if not _in_scope(database, track_id):
        return None
    with closing(database._get_connection()) as conn:
        conn.row_factory = None
        rows = conn.execute(
            "SELECT slot, bar, seconds FROM track_dj_cues WHERE profile_id = ? AND track_id = ? "
            "ORDER BY slot LIMIT 4", (int(profile_id), track_id)).fetchall()
    grid = _grids(database, [track_id]).get(track_id)
    return [_placed({"slot": s, "bar": b, "seconds": sec}, grid) for s, b, sec in rows]


def put(database, profile_id: int, track_id: str, cues: Any) -> Optional[List[Dict[str, Any]]]:
    """Replace the profile's cues on a track with ``cues`` (checked; [] clears
    them). None outside the caller's library."""
    track_id = str(track_id)
    checked = clean(cues)
    if not _in_scope(database, track_id):
        return None
    now = time.time()
    with closing(database._get_connection()) as conn:
        with conn:
            conn.execute("DELETE FROM track_dj_cues WHERE profile_id = ? AND track_id = ?",
                         (int(profile_id), track_id))
            conn.executemany(
                "INSERT INTO track_dj_cues (profile_id, track_id, slot, bar, seconds, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                [(int(profile_id), track_id, c["slot"], c["bar"], c["seconds"], now) for c in checked])
    return get(database, profile_id, track_id)


def for_export(database, profile_id: int, track_ids: Iterable[Any]) -> Dict[str, List[Dict[str, Any]]]:
    """The profile's cues on these tracks (already scoped by the export's
    plan), placed on each track's grid now: {id: [{slot, seconds}, …]}."""
    ids = list(dict.fromkeys(str(i) for i in track_ids if i is not None))
    found: Dict[str, List[Dict[str, Any]]] = {}
    with closing(database._get_connection()) as conn:
        conn.row_factory = None
        for start in range(0, len(ids), _CHUNK):
            chunk = ids[start:start + _CHUNK]
            marks = ",".join("?" * len(chunk))
            # only "?" marks are formatted in; the ids are bound
            for tid, slot, bar, sec in conn.execute(  # nosemgrep: sqlalchemy-execute-raw-query
                    f"SELECT track_id, slot, bar, seconds FROM track_dj_cues "
                    f"WHERE profile_id = ? AND track_id IN ({marks}) ORDER BY track_id, slot",
                    [int(profile_id), *chunk]).fetchall():
                found.setdefault(str(tid), []).append({"slot": slot, "bar": bar, "seconds": sec})
    grids = _grids(database, list(found))
    return {tid: [_placed(r, grids.get(tid)) for r in rows][:4] for tid, rows in found.items()}
