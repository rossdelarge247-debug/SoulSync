"""One shared read of a profile's Wanted list, reused until it changes.

With thousands of wanted songs, every read of the list parsed every row's
track JSON: twice for each of the albums and singles requests (and once more
in the duplicate sweep that ran, as a write, on every request), again for the
stats and again for the journey. On a busy, slow server that was minutes.

Now one build per profile serves them all:

* **Reused until the list changes.** ``wishlist_change_counter`` (bumped by
  triggers on every insert, update and delete of ``wishlist_tracks``) says when
  it has; a build is also at most ``MAX_AGE`` old (the artist photos come from
  the library, which has no counter).
* **Both categories at once.** The rows are read and parsed once, formatted
  and sanitized once, and each category's response is serialised once: a
  repeat answers with the same bytes.
* **The duplicate sweep runs when something was added** (the counter's
  ``added``), not on every read, and never while a wishlist batch runs.
* **The stats counts** (one SQL aggregate) are kept until the counter moves.
* **One build at a time per profile**: the albums and singles requests that
  arrive together share it.

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


@dataclass
class _Build:
    version: Tuple[int, int]
    built_at: float
    rows: List[Dict[str, Any]]
    #: the rows formatted for download and sanitized (shared by both categories)
    sanitized: Optional[List[Dict[str, Any]]] = None
    duplicates_found: int = 0
    #: category ('albums' / 'singles' / None for all) -> the route's payload
    payloads: Dict[Optional[str], Dict[str, Any]] = field(default_factory=dict)
    #: category -> the response body jsonify made from it
    bodies: Dict[Optional[str], bytes] = field(default_factory=dict)


class WishlistReadCache:
    def __init__(self, *, max_age: float = MAX_AGE) -> None:
        self.max_age = max_age
        self._lock = threading.Lock()
        self._builds: Dict[Tuple[str, int], _Build] = {}
        self._build_locks: Dict[Tuple[str, int], threading.Lock] = {}
        #: (db, profile) -> the `added` count the last duplicate sweep saw
        self._swept: Dict[Tuple[str, int], int] = {}
        #: (db, profile) -> (counter version, the category counts)
        self._counts: Dict[Tuple[str, int], Tuple[Tuple[int, int], Any]] = {}

    @staticmethod
    def _version(db: Any) -> Tuple[int, int]:
        """The wishlist's change counter; (-1, -1), never reused, when the
        database can't say."""
        read = getattr(db, "get_wishlist_change_counter", None)
        return read() if callable(read) else (-1, -1)

    @staticmethod
    def _key(db: Any, profile_id: int) -> Tuple[str, int]:
        return (str(getattr(db, "database_path", id(db))), int(profile_id))

    def clear(self) -> None:
        with self._lock:
            self._builds.clear()
            self._swept.clear()
            self._counts.clear()

    def _fresh(self, key, version) -> Optional[_Build]:
        with self._lock:
            build = self._builds.get(key)
        if build is None or version[0] < 0 or build.version != version:
            return None
        if time.monotonic() - build.built_at >= self.max_age:
            return None
        return build

    def build(self, db: Any, profile_id: int, *, batch_active: Callable[[], bool] = lambda: False,
              log: Any = None) -> _Build:
        """The profile's current build: reused, or made now (one at a time)."""
        key = self._key(db, profile_id)
        version = self._version(db)
        build = self._fresh(key, version)
        if build is not None:
            return build
        with self._lock:
            build_lock = self._build_locks.setdefault(key, threading.Lock())
        with build_lock:
            # whoever held the lock may have just built it
            version = self._version(db)
            build = self._fresh(key, version)
            if build is not None:
                return build
            self._sweep_duplicates(db, profile_id, key, version, batch_active, log)
            version = self._version(db)
            rows = db.get_wishlist_tracks(profile_id=profile_id)
            build = _Build(version=version, built_at=time.monotonic(), rows=rows)
            with self._lock:
                self._builds[key] = build
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

    def counts(self, db: Any, profile_id: int, make: Callable[[], Any]) -> Any:
        """The stats route's category counts, made again only when the
        wishlist changed (they come from the table alone)."""
        key = self._key(db, profile_id)
        version = self._version(db)
        with self._lock:
            hit = self._counts.get(key)
        if hit is not None and version[0] >= 0 and hit[0] == version:
            return hit[1]
        value = make()
        with self._lock:
            self._counts[key] = (version, value)
        return value

    def payload(self, build: _Build, category: Optional[str],
                make: Callable[[], Dict[str, Any]]) -> Dict[str, Any]:
        """The tracks route's payload for a category, made once per build."""
        with self._lock:
            payload = build.payloads.get(category)
        if payload is None:
            payload = make()
            with self._lock:
                build.payloads.setdefault(category, payload)
                payload = build.payloads[category]
        return payload

    def body(self, build: _Build, category: Optional[str], make: Callable[[], bytes]) -> bytes:
        """The response body for a category, serialised once per build."""
        with self._lock:
            body = build.bodies.get(category)
        if body is None:
            body = make()
            with self._lock:
                build.bodies.setdefault(category, body)
                body = build.bodies[category]
        return body


_shared = WishlistReadCache()


def shared_cache() -> WishlistReadCache:
    return _shared


__all__ = ["MAX_AGE", "WishlistReadCache", "shared_cache"]
