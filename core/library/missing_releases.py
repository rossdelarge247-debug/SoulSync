"""Look for releases you don't have (HANDOFF 68): a background job that
fetches the discography of every library artist the metadata cache lists no
release for, so Library → Albums and Artists can show what's missing.

One job at a time for the install, started by a person (never on its own: it
spends the metadata services' limits). It runs on its own thread, one artist
at a time, through the same discography fetch the Artist page uses
(``core.metadata.discography_strict.get_artist_discography``), which fills the
metadata cache the release index reads.

Spotify's pause is obeyed: while Spotify is paused (or cooling down after a
pause) and the discography chain includes Spotify, the job waits and says so;
a rate-limit refusal mid-run waits for the pause and asks again, never more
than once a second otherwise. The calls run under
``spotify_feature("looking for releases you don't have")`` so a pause they set
off names the job.

Each run is a ``library_jobs`` row (kind ``missing_releases``): Activity reads
it, and the Artists header names what the last run found. Stopping is a flag
the loop checks between artists and while it waits.
"""

from __future__ import annotations

import threading
import time
from contextlib import closing
from typing import Any, Callable, Dict, List, Optional

from utils.logging_config import get_logger

logger = get_logger("library.missing_releases")

KIND = "missing_releases"
FEATURE = "looking for releases you don't have"
#: at most one artist a second, whatever the services allow
PACE_SECONDS = 1.0
#: how long one wait for a pause sleeps before looking again
WAIT_STEP_SECONDS = 5.0
#: this many refusals in a row (not rate limits) and the job gives up
MAX_REFUSALS_IN_A_ROW = 5
#: a finished run's result stays in the Artists header this long
RECENT_SECONDS = 24 * 3600

_TABLE = """
CREATE TABLE IF NOT EXISTS library_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    profile_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    done INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    found_releases INTEGER NOT NULL DEFAULT 0,
    found_artists INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    note TEXT
)
"""


def ensure_table(conn) -> None:
    conn.execute(_TABLE)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_library_jobs_kind ON library_jobs (kind, started_at)")


class JobRunning(RuntimeError):
    """A run is already going."""


def _now() -> int:
    return int(time.time())


# ── the Spotify pause ─────────────────────────────────────────────────────────

def _chain_uses_spotify() -> bool:
    """Whether the discography chain the job will ask includes Spotify."""
    try:
        from core.metadata.discography_strict import _get_strict_source_plan
        from core.metadata.lookup import MetadataLookupOptions

        chain, _ = _get_strict_source_plan(MetadataLookupOptions(allow_fallback=True))
        return "spotify" in [str(s).lower() for s in chain]
    except Exception as exc:  # noqa: BLE001 - unknown: obey the pause to be safe
        logger.debug("discography chain unreadable: %s", exc)
        return True


def spotify_wait_seconds() -> int:
    """Seconds left of Spotify's pause, or of the cooldown after it; 0 when
    Spotify can be asked."""
    try:
        from core.spotify_client import SpotifyClient

        if SpotifyClient.is_rate_limited():
            info = SpotifyClient.get_rate_limit_info() or {}
            return max(1, int(info.get("remaining_seconds") or info.get("retry_after") or WAIT_STEP_SECONDS))
        return max(0, int(SpotifyClient.get_post_ban_cooldown_remaining() or 0))
    except Exception as exc:  # noqa: BLE001 - no Spotify client: nothing to wait for
        logger.debug("spotify pause unreadable: %s", exc)
        return 0


# ── one artist ────────────────────────────────────────────────────────────────

def _source_ids(database, artist_ids: List[Any]) -> Dict[str, str]:
    """The provider ids the library knows for an artist (any of its rows)."""
    ids: Dict[str, str] = {}
    if not artist_ids:
        return ids
    marks = ",".join("?" * len(artist_ids))
    with closing(database._get_connection()) as conn:
        rows = conn.execute(
            f"SELECT spotify_artist_id, itunes_artist_id, deezer_id, musicbrainz_id FROM artists WHERE id IN ({marks})",
            [str(a) for a in artist_ids]).fetchall()
    for row in rows:
        for source, column in (("spotify", "spotify_artist_id"), ("itunes", "itunes_artist_id"),
                               ("deezer", "deezer_id"), ("musicbrainz", "musicbrainz_id")):
            value = row[column]
            if value not in (None, "") and source not in ids:
                ids[source] = str(value)
    return ids


def fetch_discography(database, artist: Dict[str, Any]) -> Dict[str, Any]:
    """Ask the metadata services for one artist's releases, the way the
    Artist page does (each service gets its own id, else a name search).
    Returns the strict result (``state`` results / empty / error)."""
    from core.metadata.discography_strict import get_artist_discography
    from core.metadata.lookup import MetadataLookupOptions
    from core.spotify_client import spotify_feature

    ids = _source_ids(database, artist.get("_ids") or [artist.get("id")])
    with spotify_feature(FEATURE):
        return get_artist_discography(
            "",
            artist_name=artist.get("name") or "",
            options=MetadataLookupOptions(allow_fallback=True, skip_cache=False, max_pages=0, limit=200,
                                          artist_source_ids=ids or None),
        )


def _is_rate_limit(result: Dict[str, Any]) -> bool:
    code = int(result.get("status_code") or 0)
    words = str(result.get("error") or "").lower()
    return code == 429 or "rate limit" in words or "rate-limit" in words


# ── the job ───────────────────────────────────────────────────────────────────

class MissingReleasesJob:
    """The one run. ``fetch(database, artist)`` and ``sleep(stop, seconds)``
    are injectable for tests; ``wait_seconds()`` reads Spotify's pause."""

    def __init__(self, *, fetch: Optional[Callable] = None, wait_seconds: Optional[Callable[[], int]] = None,
                 pace: float = PACE_SECONDS, wait_step: float = WAIT_STEP_SECONDS,
                 uses_spotify: Optional[Callable[[], bool]] = None) -> None:
        self._fetch = fetch or fetch_discography
        self._wait_seconds = wait_seconds or spotify_wait_seconds
        self._uses_spotify = uses_spotify or _chain_uses_spotify
        self._pace = pace
        self._wait_step = wait_step
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._state: Optional[Dict[str, Any]] = None

    # -- reading --

    def live(self) -> Optional[Dict[str, Any]]:
        """The running job's state, or None."""
        with self._lock:
            if self._state and self._state.get("status") == "running":
                return dict(self._state)
            return None

    def running(self) -> bool:
        return self.live() is not None

    # -- starting and stopping --

    def start(self, database, profile_id: int, artists: List[Dict[str, Any]], *,
              on_finish: Optional[Callable[[Dict[str, Any]], Dict[str, int]]] = None,
              background: bool = True) -> Dict[str, Any]:
        """Start a run over ``artists`` (from ``artists_without_releases``).
        ``on_finish(state)`` returns ``{found_releases, found_artists}``."""
        with self._lock:
            if self._state and self._state.get("status") == "running":
                raise JobRunning("Already looking for releases you don't have.")
            self._stop.clear()
            started = _now()
            with closing(database._get_connection()) as conn:
                ensure_table(conn)
                # a run cut off by a restart never finished: say so
                conn.execute("UPDATE library_jobs SET status = 'stopped', finished_at = ?, "
                             "note = 'restart' WHERE kind = ? AND status = 'running'", (started, KIND))
                cur = conn.execute(
                    "INSERT INTO library_jobs (kind, profile_id, status, total, started_at) VALUES (?, ?, 'running', ?, ?)",
                    (KIND, int(profile_id), len(artists), started))
                conn.commit()
                run_id = int(cur.lastrowid)
            self._state = {"id": run_id, "status": "running", "profile_id": int(profile_id), "total": len(artists),
                           "done": 0, "failed": 0, "started_at": started, "waiting_until": None,
                           "current": None, "found_releases": 0, "found_artists": 0}
            state = dict(self._state)
        args = (database, artists, on_finish)
        if background:
            self._thread = threading.Thread(target=self._run, args=args, name="missing-releases", daemon=True)
            self._thread.start()
        else:
            self._run(*args)
        return state

    def stop(self) -> bool:
        with self._lock:
            if not self._state or self._state.get("status") != "running":
                return False
        self._stop.set()
        return True

    def join(self, timeout: Optional[float] = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout)

    # -- the loop --

    def _update(self, **fields) -> None:
        with self._lock:
            if self._state is not None:
                self._state.update(fields)

    def _save(self, database, *, final: bool = False) -> None:
        with self._lock:
            state = dict(self._state or {})
        if not state:
            return
        try:
            with closing(database._get_connection()) as conn:
                conn.execute(
                    "UPDATE library_jobs SET status = ?, done = ?, failed = ?, found_releases = ?, found_artists = ?, "
                    "finished_at = ?, note = ? WHERE id = ?",
                    (state["status"], state["done"], state["failed"], state["found_releases"], state["found_artists"],
                     state.get("finished_at") if final else None, state.get("note"), state["id"]))
                conn.commit()
        except Exception as exc:  # noqa: BLE001 - the run carries on; Activity reads the live state
            logger.warning("couldn't save the missing-releases run: %s", exc)

    def _wait_for_spotify(self, database) -> bool:
        """Wait out Spotify's pause when the chain asks Spotify. False when
        stopped while waiting."""
        if not self._uses_spotify():
            return True
        while not self._stop.is_set():
            left = self._wait_seconds()
            if left <= 0:
                self._update(waiting_until=None)
                return True
            self._update(waiting_until=_now() + left)
            if self._stop.wait(min(left, self._wait_step)):
                break
        self._update(waiting_until=None)
        return False

    def _run(self, database, artists: List[Dict[str, Any]], on_finish) -> None:
        refusals = 0
        status, note = "done", None
        checked: List[Any] = []
        try:
            for artist in artists:
                if self._stop.is_set():
                    status = "stopped"
                    break
                if not self._wait_for_spotify(database):
                    status = "stopped"
                    break
                self._update(current=artist.get("name"))
                result = self._fetch(database, artist)
                if result.get("state") == "error" and _is_rate_limit(result):
                    # the pause starts now: wait for it, then ask once more
                    if not self._wait_for_spotify(database):
                        status = "stopped"
                        break
                    result = self._fetch(database, artist)
                if result.get("state") == "error":
                    refusals += 1
                    self._update(failed=(self._state or {}).get("failed", 0) + 1)
                    if refusals >= MAX_REFUSALS_IN_A_ROW:
                        status, note = "failed", str(result.get("error") or "The metadata service refused")[:300]
                        break
                else:
                    refusals = 0
                checked.append(artist.get("id"))
                self._update(done=(self._state or {}).get("done", 0) + 1)
                self._save(database)
                if self._stop.wait(self._pace):
                    status = "stopped"
                    break
        except Exception as exc:  # noqa: BLE001 - a broken run says so in Activity
            logger.error("missing-releases run failed: %s", exc, exc_info=True)
            status, note = "failed", "Something went wrong; the log has the details."
        found = {"found_releases": 0, "found_artists": 0}
        if on_finish is not None and checked:
            try:
                found = on_finish({"checked": checked}) or found
            except Exception as exc:  # noqa: BLE001 - the run still ends
                logger.warning("couldn't count what the run found: %s", exc)
        self._update(status=status, note=note, finished_at=_now(), current=None, waiting_until=None,
                     found_releases=int(found.get("found_releases") or 0),
                     found_artists=int(found.get("found_artists") or 0))
        self._save(database, final=True)
        logger.info("[Library] Looked for releases you don't have: %s, %s artists checked", status, len(checked))


JOB = MissingReleasesJob()


def count_found(database, profile_id: int, checked: List[Any], *, fix_art=None) -> Dict[str, int]:
    """What a run found: releases you don't have (and aren't on Wanted) by
    the artists it checked, from a fresh build of the release index."""
    from core.library import release_index as _index

    _index.clear_cache()
    index = _index.get_index(database, int(profile_id), fix_art=fix_art)
    wanted = {str(a) for a in checked}
    found = [r for r in index.releases if _index.addable_missing(r) and str(r.get("artist_id")) in wanted]
    return {"found_releases": len(found), "found_artists": len({str(r["artist_id"]) for r in found})}


def last_run(database) -> Optional[Dict[str, Any]]:
    """The newest run's row, or None."""
    try:
        with closing(database._get_connection()) as conn:
            ensure_table(conn)
            row = conn.execute("SELECT * FROM library_jobs WHERE kind = ? ORDER BY id DESC LIMIT 1", (KIND,)).fetchone()
    except Exception as exc:  # noqa: BLE001
        logger.debug("library jobs unreadable: %s", exc)
        return None
    return dict(row) if row else None


def public_state(database, job: MissingReleasesJob = JOB, *, now: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """The running job, else the last run (with ``recent`` while it finished
    within a day), shaped for the routes."""
    live = job.live()
    if live:
        return {k: live.get(k) for k in ("id", "status", "total", "done", "failed", "started_at", "waiting_until",
                                         "current")} | {"recent": True}
    row = last_run(database)
    if not row:
        return None
    if row["status"] == "running":
        # the thread is gone (a restart): it didn't finish
        row = {**row, "status": "stopped", "note": "restart"}
    t = int(now if now is not None else _now())
    return {k: row.get(k) for k in ("id", "status", "total", "done", "failed", "found_releases", "found_artists",
                                    "started_at", "finished_at", "note")} | {
        "recent": bool(row.get("finished_at")) and t - int(row.get("finished_at") or 0) < RECENT_SECONDS}


__all__ = ["FEATURE", "JOB", "JobRunning", "KIND", "MissingReleasesJob", "count_found", "ensure_table",
           "fetch_discography", "last_run", "public_state", "spotify_wait_seconds"]
