"""Waveform peaks for the player (GET /api/library/tracks/<id>/peaks).

The player's bar and tray draw a library track as 200 bars. The bars come from
Sample Studio's decoder (core.sample.analyze.compute_peaks), worked out once
per file in the background and kept in the ``track_peaks`` table until the
file changes (its size or mtime, the same signature Sample Studio uses), so
imports pay nothing and a replaced file gets a fresh outline.

Bounded on purpose: the web server is one process with a handful of request
threads, and a full decode of an album's worth of tracks at once would take
all of them and a lot of memory. Decoding happens on ONE background thread,
at most ``MAX_PENDING`` tracks wait behind it, and a request never decodes.
A request for a track that's neither cached nor queued (because the queue is
full) still answers "pending"; the player asks again a little later.
"""

from __future__ import annotations

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional, Sequence

from utils.logging_config import get_logger

logger = get_logger("playback.peaks")

# Bump when the bars change shape (count, scale); older rows are recomputed.
PEAKS_VERSION = 1
PEAK_COUNT = 200

# ffmpeg resamples while it decodes, so a coarse rate keeps memory flat. The
# rate scales down for long files so a decode never holds more than about
# MAX_DECODED_SAMPLES samples (16 MB of float32), whatever its length.
DECODE_RATE = 8000
MIN_DECODE_RATE = 200
MAX_DECODED_SAMPLES = 4_000_000

# Only audio gets decoded, whatever a track row's path says.
AUDIO_EXTENSIONS = frozenset({
    ".flac", ".mp3", ".m4a", ".mp4", ".aac", ".alac", ".ogg", ".oga", ".opus",
    ".wav", ".wave", ".aif", ".aiff", ".aifc", ".wma", ".ape", ".wv", ".dsf", ".dff",
})

MAX_PENDING = 8


def ensure_schema(cursor) -> None:
    """The peaks cache: one row per library track (MusicDatabase migration)."""
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS track_peaks (
            track_id TEXT PRIMARY KEY,
            file_sig TEXT NOT NULL,     -- "<size>:<mtime_ns>" of the file the row is from
            version INTEGER NOT NULL,   -- PEAKS_VERSION when it was worked out
            duration_s REAL,
            peaks_json TEXT,            -- PEAK_COUNT floats 0..1, NULL when it failed
            error TEXT,                 -- why it failed (kept so a bad file isn't retried every play)
            computed_at REAL NOT NULL
        )
        """
    )


def file_signature(path: Optional[str]) -> Optional[str]:
    """size + mtime of a file, or None when it can't be read."""
    if not path:
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    return f"{st.st_size}:{st.st_mtime_ns}"


def is_audio_path(path: Optional[str]) -> bool:
    return bool(path) and os.path.splitext(str(path))[1].lower() in AUDIO_EXTENSIONS


def decode_rate_for(duration_s: Optional[float]) -> int:
    """The ffmpeg rate for a file this long: DECODE_RATE for anything up to
    about eight minutes, lower for longer ones, never under MIN_DECODE_RATE.
    Unknown lengths decode at a quarter of the usual rate, to be safe."""
    try:
        seconds = float(duration_s or 0)
    except (TypeError, ValueError):
        seconds = 0.0
    if seconds <= 0:
        return DECODE_RATE // 4
    rate = int(MAX_DECODED_SAMPLES / seconds)
    return max(MIN_DECODE_RATE, min(DECODE_RATE, rate))


def normalise(mins: Sequence[float], maxs: Sequence[float]) -> List[float]:
    """Sample Studio's min/max buckets as bar heights from 0 to 1.

    Each bar is the bucket's larger excursion either side of zero, scaled so
    the loudest bar is 1 (the outline of a quiet recording still fills the
    bar). Silence stays 0. Three decimals is plenty for 28-72px bars.
    """
    heights = [max(abs(float(lo)), abs(float(hi))) for lo, hi in zip(mins, maxs, strict=False)]
    top = max(heights) if heights else 0.0
    if top <= 0:
        return [0.0 for _ in heights]
    return [round(min(1.0, h / top), 3) for h in heights]


def compute(path: str, duration_s: Optional[float] = None) -> Dict[str, Any]:
    """{"peaks": [...PEAK_COUNT floats], "duration_s": float} for one file."""
    from core.sample.analyze import compute_peaks

    raw = compute_peaks(path, buckets=PEAK_COUNT, sample_rate=decode_rate_for(duration_s))
    return {"peaks": normalise(raw["min"], raw["max"]), "duration_s": raw["duration_s"]}


# ── the cache ────────────────────────────────────────────────────────────────

def read_cached(db, track_id: str, sig: str) -> Optional[Dict[str, Any]]:
    """The cached answer for this exact file, or None when there's none (or
    it's for an older file or an older PEAKS_VERSION)."""
    conn = db._get_connection()
    try:
        row = conn.execute(
            "SELECT file_sig, version, duration_s, peaks_json, error FROM track_peaks WHERE track_id = ?",
            (track_id,),
        ).fetchone()
    finally:
        conn.close()
    if row is None or row[0] != sig or int(row[1] or 0) != PEAKS_VERSION:
        return None
    if row[3]:
        try:
            peaks = json.loads(row[3])
        except ValueError:
            return None
        return {"peaks": peaks, "duration_s": row[2]}
    return {"peaks": None, "duration_s": row[2], "error": row[4] or "unreadable"}


def write_cached(db, track_id: str, sig: str, result: Optional[Dict[str, Any]],
                 error: Optional[str] = None) -> None:
    peaks = result.get("peaks") if result else None
    duration = result.get("duration_s") if result else None
    conn = db._get_connection()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO track_peaks "
            "(track_id, file_sig, version, duration_s, peaks_json, error, computed_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (track_id, sig, PEAKS_VERSION, duration,
             json.dumps(peaks) if peaks is not None else None,
             None if peaks is not None else (error or "unreadable"), time.time()),
        )
        conn.commit()
    finally:
        conn.close()


# ── the background queue ─────────────────────────────────────────────────────

class PeaksJobs:
    """One decode at a time, at most ``max_pending`` waiting, one job per key.

    ``submit`` never blocks and never runs the work on the caller's thread:
    it answers True when the key is queued (now or already), False when the
    queue is full and nothing was added.
    """

    def __init__(self, max_pending: int = MAX_PENDING, executor_factory: Optional[Callable[[], Any]] = None):
        self._lock = threading.Lock()
        self._keys: set = set()
        self._max_pending = max(1, int(max_pending))
        self._executor = None
        self._executor_factory = executor_factory or (
            lambda: ThreadPoolExecutor(max_workers=1, thread_name_prefix="PlayerPeaks"))

    def is_queued(self, key: str) -> bool:
        with self._lock:
            return key in self._keys

    def queued_count(self) -> int:
        with self._lock:
            return len(self._keys)

    def submit(self, key: str, work: Callable[[], None]) -> bool:
        with self._lock:
            if key in self._keys:
                return True
            # the running job counts: one decoding plus max_pending - 1 waiting
            if len(self._keys) >= self._max_pending:
                return False
            self._keys.add(key)
            if self._executor is None:
                self._executor = self._executor_factory()
            executor = self._executor

        def run():
            try:
                work()
            except Exception:  # noqa: BLE001 - one bad file must not stop the queue
                logger.exception("waveform job %s failed", key)
            finally:
                with self._lock:
                    self._keys.discard(key)

        try:
            executor.submit(run)
        except RuntimeError:
            # the executor was shut down (interpreter exit); forget the key
            with self._lock:
                self._keys.discard(key)
            return False
        return True


_jobs = PeaksJobs()


def jobs() -> PeaksJobs:
    return _jobs


def peaks_for_track(db, track_id: str, path: Optional[str], duration_s: Optional[float] = None,
                    queue: Optional[PeaksJobs] = None) -> Dict[str, Any]:
    """What the route answers for one library track.

    - ``{"state": "ready", "peaks": [...], "duration_s": n}`` from the cache
    - ``{"state": "failed", "peaks": None, "reason": ...}`` when the file can't
      be drawn (not on this machine, not audio, couldn't be decoded)
    - ``{"state": "pending"}`` otherwise, after queueing the decode
    """
    queue = queue or _jobs
    if not path or not os.path.isfile(path):
        return {"state": "failed", "peaks": None, "duration_s": duration_s, "reason": "not_on_disk"}
    if not is_audio_path(path):
        return {"state": "failed", "peaks": None, "duration_s": duration_s, "reason": "not_audio"}
    sig = file_signature(path)
    if sig is None:
        return {"state": "failed", "peaks": None, "duration_s": duration_s, "reason": "not_on_disk"}
    cached = read_cached(db, track_id, sig)
    if cached is not None:
        if cached.get("peaks") is None:
            return {"state": "failed", "peaks": None, "duration_s": cached.get("duration_s"),
                    "reason": "unreadable"}
        return {"state": "ready", "peaks": cached["peaks"], "duration_s": cached["duration_s"]}

    def work():
        # the file may have changed while this waited; key the row to what was read
        current = file_signature(path) or sig
        try:
            result = compute(path, duration_s)
        except Exception as exc:  # noqa: BLE001 - stored, so the player stops asking
            logger.info("waveform for track %s couldn't be worked out: %s", track_id, exc)
            write_cached(db, track_id, current, None, error=str(exc)[:300])
            return
        write_cached(db, track_id, current, result)

    queued = queue.submit(f"{track_id}:{sig}", work)
    return {"state": "pending", "queued": queued}


__all__ = [
    "PEAKS_VERSION", "PEAK_COUNT", "DECODE_RATE", "MIN_DECODE_RATE", "MAX_DECODED_SAMPLES",
    "MAX_PENDING", "AUDIO_EXTENSIONS", "PeaksJobs", "ensure_schema", "file_signature",
    "is_audio_path", "decode_rate_for", "normalise", "compute", "read_cached", "write_cached",
    "jobs", "peaks_for_track",
]
