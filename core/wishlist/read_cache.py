"""One shared read of a profile's Wanted list, reused until it changes.

With thousands of wanted songs, every read of the list parsed every row's
track JSON: twice for each of the albums and singles requests (and once more
in the duplicate sweep that ran, as a write, on every request), again for the
stats and again for the journey. On a busy, slow server that was minutes.

Now one build per profile serves them all:

* **Reused until the list changes.** ``wishlist_changes`` (kept per profile by
  triggers on ``wishlist_tracks``, see MusicDatabase._ensure_wishlist_changes)
  says when it has. A build is also at most ``MAX_AGE`` old (the artist photos
  come from the library, which has no counter).
* **Retry stamps lag by up to ``RETRY_GRACE``.** A wishlist run stamps a retry
  on each track it tries, about one a second. Updates that change only those
  columns move the ``retry`` counter, and a build stays in use until it is
  ``RETRY_GRACE`` old, so the retry details shown are at most that stale. Any
  other change is seen on the next read.
* **Both categories at once.** The rows are read and parsed once, formatted
  and sanitized once, and the albums and singles responses are serialised once
  each: a repeat answers with the same bytes. The rows share one copy of each
  repeated market list (most of their memory). Once both exist the formatted
  copy is let go (the rows stay: the journey reads them, and a request with a
  limit or without a category is made from them).
* **The stats counts** (one SQL aggregate) are kept until the version moves:
  retry stamps don't change them.
* **The duplicate sweep runs when something was added** (the counter's
  ``added``), not on every read, and never while a wishlist batch runs.
* **One build at a time per profile**: the albums and singles requests that
  arrive together share it. A profile's build is dropped after ``IDLE_DROP``
  unused.

The responses are exactly what they were (built by the same functions).
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from utils.logging_config import get_logger

logger = get_logger("wishlist.read_cache")

#: a build is reused for at most this long (seconds) even when nothing changed
MAX_AGE = 60.0
#: while only retry stamps changed, a build is reused until it is this old
RETRY_GRACE = 15.0
#: a profile's build (and its bodies) is dropped after this long unused
IDLE_DROP = 600.0
#: the responses kept serialised (what the Wanted page asks for)
CACHED_BODIES = ("albums", "singles")


@dataclass
class _Build:
    #: (version, added) when it was built
    version: Tuple[int, int]
    retry: int
    built_at: float
    rows: List[Dict[str, Any]]
    #: the rows formatted for download and sanitized, until both bodies exist
    sanitized: Optional[List[Dict[str, Any]]] = None
    duplicates_found: int = 0
    #: 'albums' / 'singles' -> the response body
    bodies: Dict[str, bytes] = field(default_factory=dict)


def _share_repeated_lists(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One list object per distinct ``available_markets`` value. Every song
    carries Spotify's market list twice (the track's and its album's), about
    185 country codes each: parsed per row that is most of a build's memory,
    though nearly all of them are the same list. Values are unchanged; the
    rows are shared and read-only anyway."""
    seen: Dict[Tuple[Any, ...], List[Any]] = {}

    def share(holder: Any) -> None:
        if isinstance(holder, dict):
            value = holder.get("available_markets")
            if isinstance(value, list):
                try:
                    key = tuple(value)
                    holder["available_markets"] = seen.setdefault(key, value)
                except TypeError:  # unhashable entries: leave it
                    pass

    for row in rows:
        data = row.get("spotify_data") if isinstance(row, dict) else None
        if isinstance(data, dict):
            share(data)
            share(data.get("album"))
    return rows


class WishlistReadCache:
    def __init__(self, *, max_age: float = MAX_AGE, retry_grace: float = RETRY_GRACE,
                 idle_drop: float = IDLE_DROP) -> None:
        self.max_age = max_age
        self.retry_grace = retry_grace
        self.idle_drop = idle_drop
        self._lock = threading.Lock()
        self._builds: Dict[Tuple[str, int], _Build] = {}
        self._used: Dict[Tuple[str, int], float] = {}
        self._build_locks: Dict[Tuple[str, int], threading.Lock] = {}
        #: (db, profile) -> the `added` count the last duplicate sweep saw
        self._swept: Dict[Tuple[str, int], int] = {}
        #: (db, profile) -> (version, the category counts)
        self._counts: Dict[Tuple[str, int], Tuple[Tuple[int, int], Any]] = {}

    @staticmethod
    def _counter(db: Any, profile_id: int) -> Tuple[Tuple[int, int], int]:
        """((version, added), retry) for the profile; version -1, never
        reused, when the database can't say."""
        read = getattr(db, "get_wishlist_change_counter", None)
        if not callable(read):
            return (-1, -1), -1
        value = tuple(read(profile_id))
        version, added = value[0], value[1]
        retry = value[2] if len(value) > 2 else 0
        return (version, added), retry

    @staticmethod
    def _key(db: Any, profile_id: int) -> Tuple[str, int]:
        return (str(getattr(db, "database_path", id(db))), int(profile_id))

    def clear(self) -> None:
        with self._lock:
            self._builds.clear()
            self._used.clear()
            self._swept.clear()
            self._counts.clear()

    def _fresh(self, key, version, retry) -> Optional[_Build]:
        with self._lock:
            build = self._builds.get(key)
        if build is None or version[0] < 0 or build.version != version:
            return None
        age = time.monotonic() - build.built_at
        if age >= self.max_age:
            return None
        if build.retry != retry and age >= self.retry_grace:
            return None
        return build

    def _drop_idle(self, now: float) -> None:
        with self._lock:
            for key in [k for k, used in self._used.items() if now - used >= self.idle_drop]:
                self._builds.pop(key, None)
                self._used.pop(key, None)
                self._counts.pop(key, None)

    def build(self, db: Any, profile_id: int, *, batch_active: Callable[[], bool] = lambda: False,
              log: Any = None) -> _Build:
        """The profile's current build: reused, or made now (one at a time)."""
        key = self._key(db, profile_id)
        now = time.monotonic()
        self._drop_idle(now)
        with self._lock:
            self._used[key] = now
        version, retry = self._counter(db, profile_id)
        build = self._fresh(key, version, retry)
        if build is not None:
            return build
        with self._lock:
            build_lock = self._build_locks.setdefault(key, threading.Lock())
        with build_lock:
            # whoever held the lock may have just built it
            version, retry = self._counter(db, profile_id)
            build = self._fresh(key, version, retry)
            if build is not None:
                return build
            self._sweep_duplicates(db, profile_id, key, version, batch_active, log)
            version, retry = self._counter(db, profile_id)
            rows = _share_repeated_lists(db.get_wishlist_tracks(profile_id=profile_id))
            build = _Build(version=version, retry=retry, built_at=time.monotonic(), rows=rows)
            with self._lock:
                self._builds[key] = build
                self._used[key] = time.monotonic()
            return build

    def _sweep_duplicates(self, db, profile_id, key, version, batch_active, log) -> None:
        """The duplicate sweep, when rows were added since the last one."""
        added = version[1]
        with self._lock:
            swept = self._swept.get(key)
        if swept is not None and swept == added and added >= 0:
            return
        if batch_active():
            if log is not None:
                log.warning("Skipping wishlist duplicate cleanup - download in progress")
            return
        sweep = getattr(db, "remove_wishlist_duplicates", None)
        if not callable(sweep):
            return
        removed = sweep(profile_id=profile_id)
        if removed > 0 and log is not None:
            log.warning("Cleaned %s duplicate tracks from wishlist", removed)
        with self._lock:
            self._swept[key] = added

    # ── what the routes read ───────────────────────────────────────────────

    def rows(self, db: Any, profile_id: int, **kw) -> List[Dict[str, Any]]:
        """The profile's wishlist rows as ``db.get_wishlist_tracks`` returns
        them. Shared: read them, never change them."""
        return self.build(db, profile_id, **kw).rows

    def body(self, build: _Build, category: str, make: Callable[[], bytes]) -> bytes:
        """The albums or singles response body, serialised once per build."""
        with self._lock:
            body = build.bodies.get(category)
        if body is None:
            body = make()
            with self._lock:
                build.bodies.setdefault(category, body)
                body = build.bodies[category]
                if all(c in build.bodies for c in CACHED_BODIES):
                    build.sanitized = None  # the bodies hold what it made
        return body

    def counts(self, db: Any, profile_id: int, make: Callable[[], Any]) -> Any:
        """The stats route's category counts, made again only when the
        version moved (retry stamps don't change them)."""
        key = self._key(db, profile_id)
        version, _retry = self._counter(db, profile_id)
        with self._lock:
            hit = self._counts.get(key)
        if hit is not None and version[0] >= 0 and hit[0] == version:
            return hit[1]
        value = make()
        with self._lock:
            self._counts[key] = (version, value)
        return value


_shared = WishlistReadCache()


def shared_cache() -> WishlistReadCache:
    return _shared


__all__ = ["CACHED_BODIES", "IDLE_DROP", "MAX_AGE", "RETRY_GRACE", "WishlistReadCache",
           "shared_cache"]
