"""DJ mode's fine waveform (Brief F step 4b, 37s): a track's level every
10 ms, for a lane zoomed to 4 bars or 1 bar, before a blend as well as in one
(GET /api/library/dj/levels/<id>).

The player's 200 bars (core/playback/peaks.py) are a whole track's outline;
zoomed in they're slabs. These are the whole track at 10 ms a level (longer
files at a coarser step, so a level count never passes ``MAX_LEVELS``), each
the loudest sample in its step, 0..255 with the track's loudest at 255, so a
kick reads as a spike and a breakdown as a dip.

Worked out once per file in the background, on the player's waveform queue
(one decode at a time, never on a request thread: core/playback/peaks.py
``jobs``), kept in ``track_dj_levels`` until the file changes (its size and
mtime, as the peaks are). A request for one that isn't ready answers
"pending" and the lane asks again.
"""

from __future__ import annotations

import base64
import os
import time
from contextlib import closing
from typing import Any, Dict, Optional

from utils.logging_config import get_logger

logger = get_logger("dj.levels")

#: bump when the levels change shape; older rows are worked out again
LEVELS_VERSION = 1
#: a level every 10 ms: a beat at 174 BPM is 34 of them, a transient one or two
STEP_S = 0.01
#: at most this many levels a track (25 minutes at 10 ms; longer files get a coarser step)
MAX_LEVELS = 150_000


def step_for(duration_s: Optional[float]) -> float:
    """The step for a file this long: STEP_S, coarser past MAX_LEVELS levels."""
    try:
        seconds = float(duration_s or 0)
    except (TypeError, ValueError):
        seconds = 0.0
    if seconds <= 0:
        return STEP_S
    return max(STEP_S, seconds / MAX_LEVELS)


def levels_from(mono, sample_rate: int, step_s: float) -> bytes:
    """Each step's loudest sample, scaled so the loudest is 255 (silence 0)."""
    import numpy as np

    per = max(1, int(round(sample_rate * step_s)))
    n = int(np.ceil(len(mono) / per)) if len(mono) else 0
    if n == 0:
        return b""
    padded = np.zeros(n * per, dtype=np.float32)
    padded[: len(mono)] = np.abs(np.asarray(mono, dtype=np.float32))
    peaks = padded.reshape(n, per).max(axis=1)
    top = float(peaks.max()) if n else 0.0
    if top <= 0:
        return bytes(n)
    return np.clip(np.round(peaks / top * 255.0), 0, 255).astype(np.uint8).tobytes()


def compute(path: str, duration_s: Optional[float] = None) -> Dict[str, Any]:
    """{"levels": bytes, "step": s, "duration_s": s} for one file."""
    from core.playback.peaks import decode_rate_for
    from core.sample.analyze import decode_mono_at

    rate = decode_rate_for(duration_s)
    mono, sr = decode_mono_at(path, rate)
    duration = float(len(mono) / sr) if sr else 0.0
    step = step_for(duration)
    # the decode rate must give a step two samples at least
    if sr * step < 2:
        step = 2.0 / sr
    return {"levels": levels_from(mono, int(sr), step), "step": step, "duration_s": round(duration, 3)}


# ── the cache ────────────────────────────────────────────────────────────────

def read_cached(db, track_id: str, sig: str) -> Optional[Dict[str, Any]]:
    """The cached answer for this exact file, or None (none, an older file, an older version)."""
    with closing(db._get_connection()) as conn:
        row = conn.execute(
            "SELECT file_sig, version, step, duration_s, levels, error FROM track_dj_levels WHERE track_id = ?",
            (track_id,),
        ).fetchone()
    if row is None or row[0] != sig or int(row[1] or 0) != LEVELS_VERSION:
        return None
    if row[4] is not None:
        return {"levels": bytes(row[4]), "step": float(row[2]), "duration_s": row[3]}
    return {"levels": None, "duration_s": row[3], "error": row[5] or "unreadable"}


def write_cached(db, track_id: str, sig: str, result: Optional[Dict[str, Any]],
                 error: Optional[str] = None) -> None:
    levels = result.get("levels") if result else None
    with closing(db._get_connection()) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO track_dj_levels "
            "(track_id, file_sig, version, step, duration_s, levels, error, computed_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (track_id, sig, LEVELS_VERSION, result.get("step") if result else None,
             result.get("duration_s") if result else None,
             levels, None if levels is not None else (error or "unreadable")[:300], time.time()),
        )
        conn.commit()


def _track(db, track_id: str) -> Optional[Dict[str, Any]]:
    """The track's file and length, in the caller's library scope only."""
    from core.dj.store import _scope

    where, params = _scope(db)
    with closing(db._get_connection()) as conn:
        # ``where`` is the library scope's fixed SQL (core/dj/store.py _scope); every value is bound
        row = conn.execute(f"SELECT t.file_path, t.duration FROM tracks t WHERE t.id = ? AND {where}",  # nosemgrep: sqlalchemy-execute-raw-query
                           [track_id, *params]).fetchone()
    if row is None:
        return None
    duration_ms = row[1]
    return {"path": row[0], "duration_s": (float(duration_ms) / 1000.0) if duration_ms else None}


def levels_for_track(db, track_id: str, queue=None) -> Optional[Dict[str, Any]]:
    """What the route answers: None outside the caller's library, else

    - ``{"state": "ready", "step", "duration_s", "levels": base64}``
    - ``{"state": "failed", "reason"}`` (not on this computer, not audio, unreadable)
    - ``{"state": "pending"}`` after queueing the decode
    """
    from core.playback import peaks

    track = _track(db, track_id)
    if track is None:
        return None
    path = track["path"]
    if not path or not os.path.isfile(path):
        return {"state": "failed", "reason": "not_on_disk"}
    if not peaks.is_audio_path(path):
        return {"state": "failed", "reason": "not_audio"}
    sig = peaks.file_signature(path)
    if sig is None:
        return {"state": "failed", "reason": "not_on_disk"}
    cached = read_cached(db, track_id, sig)
    if cached is not None:
        if cached.get("levels") is None:
            return {"state": "failed", "reason": "unreadable"}
        return {"state": "ready", "step": cached["step"], "duration_s": cached["duration_s"],
                "levels": base64.b64encode(cached["levels"]).decode("ascii")}

    duration = track["duration_s"]

    def work():
        current = peaks.file_signature(path) or sig
        try:
            result = compute(path, duration)
        except Exception as exc:  # noqa: BLE001 - stored, so the lane stops asking
            logger.info("fine waveform for track %s couldn't be worked out: %s", track_id, exc)
            write_cached(db, track_id, current, None, error=str(exc))
            return
        write_cached(db, track_id, current, result)

    queued = (queue or peaks.jobs()).submit(f"levels:{track_id}:{sig}", work)
    return {"state": "pending", "queued": queued}


__all__ = ["LEVELS_VERSION", "STEP_S", "MAX_LEVELS", "step_for", "levels_from", "compute",
           "read_cached", "write_cached", "levels_for_track"]
