"""The sync-match-cache rows and library rows one playlist sync will ask about,
read up front.

The sync matcher used to go to the database for every playlist track: the
``sync_match_cache`` row (a connection, plus an UPDATE and a commit to bump
the row's use count on a hit) and then the cached library track, twice (once
to materialize it, once for the staleness check). A re-sync of a
1,000-track playlist whose tracks are all cached opened ~3,000 connections
to read what a few ``IN`` queries return.

A ``SyncMatchPrefetch`` answers those reads from memory with the same values:

* cache rows come from ``peek_sync_match_cache_bulk``; each hit
  the matcher actually uses is counted and the bumps are written together by
  ``flush()`` (``use_count`` / ``last_used_at`` are bookkeeping nothing reads);
* library rows come from ``get_track_by_id_many``, which records a missing
  track as None just as ``get_track_by_id`` answers None;
* once the sync rewrites a cache row (saves a new pairing or drops a stale
  one), that id goes back to the database for every later read, and any bump
  still pending for it is dropped: the old row it would have bumped is gone
  or replaced, exactly as when the bump went in before the rewrite.

Anything it was not loaded for (another server, an id it never saw, a track
id outside the cached pairings) is read from the database as before.
"""

from __future__ import annotations

import threading
from collections import Counter
from typing import Any, Dict, Iterable, Optional

from utils.logging_config import get_logger

logger = get_logger("sync.match_prefetch")


class SyncMatchPrefetch:
    def __init__(self, server_source: str, cache_rows: Dict[str, Dict[str, Any]],
                 tracks: Dict[str, Any]):
        self.server_source = server_source
        self._cache_rows = cache_rows
        self._tracks = tracks
        self._seen = set()          # ids loaded: a miss among them is a known miss
        self._rewritten = set()
        self._uses: Counter = Counter()
        self._lock = threading.Lock()

    @classmethod
    def load(cls, db, server_source: str, source_ids: Iterable[Any]) -> "SyncMatchPrefetch":
        ids = list(dict.fromkeys(str(i) for i in source_ids if i))
        rows = db.peek_sync_match_cache_bulk(ids, server_source) if ids else {}
        track_ids = [row['server_track_id'] for row in rows.values() if row.get('server_track_id') is not None]
        tracks = db.get_track_by_id_many(track_ids) if track_ids else {}
        prefetch = cls(server_source, rows, tracks)
        prefetch._seen.update(ids)
        return prefetch

    def read_sync_match_cache(self, db, source_id: Any, server_source: str) -> Optional[Dict[str, Any]]:
        """``db.read_sync_match_cache(source_id, server_source)``'s answer."""
        key = str(source_id)
        with self._lock:
            known = server_source == self.server_source and key in self._seen and key not in self._rewritten
            if known:
                row = self._cache_rows.get(key)
                if row is not None:
                    self._uses[key] += 1
        if not known:
            return db.read_sync_match_cache(source_id, server_source)
        return dict(row) if row is not None else None

    def get_track_by_id(self, db, track_id: Any):
        """``db.get_track_by_id(track_id)``'s answer."""
        key = str(track_id)
        if key in self._tracks:
            return self._tracks[key]
        return db.get_track_by_id(track_id)

    def rewrote(self, source_id: Any) -> None:
        """The sync saved or deleted this id's cache row: read it live from now on."""
        key = str(source_id)
        with self._lock:
            self._rewritten.add(key)
            self._uses.pop(key, None)

    def flush(self, db) -> None:
        """Write the use-count bumps of the hits the matcher used."""
        with self._lock:
            uses = dict(self._uses)
            self._uses.clear()
        if uses:
            db.bump_sync_match_cache_uses(uses, self.server_source)
