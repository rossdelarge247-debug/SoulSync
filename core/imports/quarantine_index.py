"""One shared snapshot of the quarantine folder, kept off the request path.

Quarantine can hold thousands of files, and on some installs the downloads
folder is a slow mount (Docker Desktop's bind mounts on Windows: listing and
statting 4,500 files there takes about 5 s). Several things want to know what
the folder holds on almost every request: Wanted's journey read (each song's
quarantined attempts), Activity's Needs you item and badge, Downloads' review
count and list, the sibling lookups behind approve and delete, and the search
that won't re-pick a quarantined upload. When each of them listed and statted
the folder itself, a few polls at once held every server thread on the disk
and everything else, the Wanted list included, queued behind them.

Now there's one snapshot per folder:

* **Refreshed in the background, one at a time.** A reader takes the last
  snapshot and never waits on the folder. A snapshot older than
  ``MAX_AGE`` (60 s), or marked stale by a change, starts one background
  refresh, and only one: callers that arrive while it runs get the old
  snapshot. Before the first refresh has finished there's no snapshot
  (``peek`` answers None), and callers say "not ready yet" instead of waiting.
* **One pass, one stat per file.** A refresh is a single ``os.scandir``; each
  ``.quarantined`` file and each sidecar is statted once, by its directory
  entry. A sidecar is read again only when its size or mtime (or its file's)
  changed since the last refresh; otherwise the record is reused.
* **Changes show at once.** Approve, delete, recover and clear take their
  entries out of the snapshot as they happen (``forget``) and mark it stale,
  so the next read is right without waiting for the folder. A new quarantined
  file marks it stale (``invalidate``); a stale snapshot is refreshed after
  ``MIN_INTERVAL`` (15 s), so a busy download batch can't keep the disk busy.
* **A user action may wait.** ``wait`` (used where a person asked for one
  song's attempts) waits for the refresh in flight, or starts one.

Read-only: nothing here writes, moves or deletes in the quarantine folder.
Never raises to a caller: an unreadable folder is an empty snapshot.
"""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, Iterable, List, Optional, Tuple

from core.imports.quarantine import (
    _QUARANTINE_SUFFIX,
    _entry_id_from_filename,
    entry_from_sidecar,
    quarantine_group_key,
    read_sidecar,
)
from utils.logging_config import get_logger

logger = get_logger("imports.quarantine_index")

#: a snapshot older than this is refreshed in the background (seconds)
MAX_AGE = 60.0
#: a snapshot marked stale by a change is refreshed after this long at most often
MIN_INTERVAL = 15.0

# track_info keys that hold the source id of the song a download was for.
# Wishlist rows carry spotify_track_id/track_id/id (the same value); playlist
# batches carry id; a pinned pick carries id.
_TRACK_ID_KEYS = ("spotify_track_id", "track_id", "id")


def name_key(artist: Any, title: Any) -> Optional[str]:
    """The ``nm:`` half of quarantine_group_key, for any artist and title."""
    a = " ".join(str(artist or "").split()).lower()
    t = " ".join(str(title or "").split()).lower()
    if not a or not t:
        return None
    return f"{a}|{t}"


@dataclass(frozen=True)
class QuarantineRecord:
    """What one quarantined file was meant to be, and why it was held."""

    entry_id: str
    filename: str
    track_ids: FrozenSet[str] = field(default_factory=frozenset)
    wishlist_id: Optional[str] = None
    isrc: Optional[str] = None
    name_key: Optional[str] = None
    group_key: Optional[str] = None
    reason: str = ""
    trigger: str = ""
    expected_track: str = ""
    expected_artist: str = ""
    #: the upload it came from, (username, filename), when the sidecar says
    source_key: Optional[Tuple[str, str]] = None
    #: the Downloads list's entry for it (core.imports.quarantine.entry_from_sidecar)
    entry: Dict[str, Any] = field(default_factory=dict, compare=False, hash=False)


def record_from_sidecar(name: str, sidecar: Dict[str, Any], size_bytes: int) -> QuarantineRecord:
    """The record for one file, from its sidecar (no filesystem access)."""
    entry_id = _entry_id_from_filename(name)
    ctx = sidecar.get("context") if isinstance(sidecar.get("context"), dict) else {}
    ti = ctx.get("track_info") if isinstance(ctx.get("track_info"), dict) else {}
    osr = ctx.get("original_search_result") if isinstance(ctx.get("original_search_result"), dict) else {}
    ids = set()
    for key in _TRACK_ID_KEYS:
        value = ti.get(key)
        if isinstance(value, (str, int)) and str(value).strip():
            ids.add(str(value).strip())
    wishlist_id = ti.get("wishlist_id")
    isrc = str(ti.get("isrc") or "").strip().lower() or None
    expected_artist = str(sidecar.get("expected_artist") or "")
    expected_track = str(sidecar.get("expected_track") or "")
    username = str(osr.get("username") or "")
    filename = str(osr.get("filename") or "")
    return QuarantineRecord(
        entry_id=entry_id,
        filename=name,
        track_ids=frozenset(ids),
        wishlist_id=str(wishlist_id) if wishlist_id not in (None, "") else None,
        isrc=isrc,
        name_key=name_key(expected_artist, expected_track),
        group_key=quarantine_group_key(expected_artist, expected_track, ctx),
        reason=str(sidecar.get("quarantine_reason") or ""),
        trigger=str(sidecar.get("trigger") or ""),
        expected_track=expected_track,
        expected_artist=expected_artist,
        source_key=(username, filename) if username and filename else None,
        entry=entry_from_sidecar(name, sidecar, size_bytes),
    )


@dataclass(frozen=True)
class Snapshot:
    """The folder as one refresh saw it, newest entry first."""

    quarantine_dir: str
    records: Tuple[QuarantineRecord, ...]
    taken_at: float  # time.monotonic(), when the refresh finished
    #: when that refresh started listing the folder (time.monotonic()): what was
    #: quarantined after this may be missing
    listed_at: float = 0.0

    @property
    def files(self) -> int:
        return len(self.records)

    def by_id(self, entry_id: str) -> Optional[QuarantineRecord]:
        for record in self.records:
            if record.entry_id == entry_id:
                return record
        return None


def _norm(quarantine_dir: str) -> str:
    """One key per folder however a caller spelled it ('./downloads/x' and
    'downloads/x' are one folder)."""
    if not quarantine_dir:
        return ""
    return os.path.normcase(os.path.abspath(str(quarantine_dir)))


class _ListingFailed(Exception):
    """The folder couldn't be listed (and exists): keep what we had."""


# (file size, file mtime, sidecar size, sidecar mtime): a sidecar is read again
# only when this changes
_Signature = Tuple[int, int, int, int]

#: a refresh running longer than this is taken for hung: another may start
HUNG_AFTER = 300.0


class QuarantineSnapshots:
    """Thread-safe; one per process is enough (see ``shared_index``)."""

    def __init__(self, *, max_age: float = MAX_AGE, min_interval: float = MIN_INTERVAL,
                 hung_after: float = HUNG_AFTER) -> None:
        self.max_age = max_age
        self.min_interval = min_interval
        self.hung_after = hung_after
        self._lock = threading.Lock()
        self._snaps: Dict[str, Snapshot] = {}
        self._stale: set = set()
        # folder -> (the running refresh's event, when it started)
        self._running: Dict[str, Tuple[threading.Event, float]] = {}
        # folder -> when the last listing failed (an unreadable folder isn't
        # listed again on every read)
        self._failed_at: Dict[str, float] = {}
        # folder -> entry id -> when it was forgotten: a refresh that listed the
        # folder before that can't bring it back
        self._gone: Dict[str, Dict[str, float]] = {}
        # folder -> file name -> (signature, record); written only by a refresh
        # (one at a time per folder), read by the user actions' fresh groups
        self._cache: Dict[str, Dict[str, Tuple[_Signature, QuarantineRecord]]] = {}

    # ── reading ────────────────────────────────────────────────────────────

    def peek(self, quarantine_dir: str) -> Optional[Snapshot]:
        """The last snapshot, or None before the first one: never waits on the
        folder. Starts a background refresh when the snapshot is due."""
        quarantine_dir = _norm(quarantine_dir)
        if not quarantine_dir:
            return None
        now = time.monotonic()
        with self._lock:
            snap = self._snaps.get(quarantine_dir)
            stale = quarantine_dir in self._stale
            failed_at = self._failed_at.get(quarantine_dir)
        if failed_at is not None and now - failed_at < self.min_interval:
            return snap  # the last listing failed just now: not again yet
        if snap is None or now - snap.taken_at >= self.max_age or (
                stale and now - snap.taken_at >= self.min_interval):
            self._kick(quarantine_dir)
        return snap

    def ready(self, quarantine_dir: str) -> bool:
        return self.peek(quarantine_dir) is not None

    def records(self, quarantine_dir: str) -> List[QuarantineRecord]:
        """The last snapshot's records; [] before the first one (never waits)."""
        snap = self.peek(quarantine_dir)
        return list(snap.records) if snap else []

    def wait(self, quarantine_dir: str, *, fresh: bool = False,
             timeout: Optional[float] = None) -> Snapshot:
        """A snapshot, waiting for the refresh in flight (or one it starts) when
        there's none yet; with ``fresh``, one that started listing the folder
        after this call (a refresh already running when it was made doesn't
        count: another one runs after it). For tests, tools and a person's own
        action, never a poll. An empty snapshot if none could be had in time."""
        quarantine_dir = _norm(quarantine_dir)
        asked_at = time.monotonic()
        deadline = None if timeout is None else asked_at + timeout
        if not fresh:
            with self._lock:
                snap = self._snaps.get(quarantine_dir)
            if snap is not None:
                return snap
        while True:
            if fresh:
                with self._lock:
                    self._stale.add(quarantine_dir)
            event = self._kick(quarantine_dir)
            left = None if deadline is None else max(0.0, deadline - time.monotonic())
            event.wait(left)
            with self._lock:
                snap = self._snaps.get(quarantine_dir)
            good = snap is not None and (not fresh or snap.listed_at >= asked_at)
            if good:
                return snap
            if deadline is not None and time.monotonic() >= deadline:
                return snap or Snapshot(quarantine_dir, (), time.monotonic())
            with self._lock:
                failed_at = self._failed_at.get(quarantine_dir)
            if failed_at is not None and failed_at >= asked_at:
                # the listing failed after the call: what we had, or nothing
                return snap or Snapshot(quarantine_dir, (), time.monotonic())

    def fresh_group(self, quarantine_dir: str, entry_id: str) -> List[QuarantineRecord]:
        """The entry and every other attempt at the same intended song, newest
        first, as the folder is now; [] when the entry isn't there. For a
        person's own action (approve, delete, the one-song list): one listing
        of the names, no stat per file, and a sidecar read only for files the
        snapshot hasn't read. An entry with no group key (nothing names its
        target) is a group of one."""
        quarantine_dir = _norm(quarantine_dir)
        try:
            names = [n for n in os.listdir(quarantine_dir) if n.endswith(_QUARANTINE_SUFFIX)]
        except OSError as exc:
            logger.debug("quarantine fresh group: listing %s failed: %s", quarantine_dir, exc)
            return []
        with self._lock:
            known = dict(self._cache.get(quarantine_dir, {}))
        records = []
        for name in names:
            cached = known.get(name)
            if cached is not None:
                records.append(cached[1])
                continue
            sidecar = read_sidecar(quarantine_dir, _entry_id_from_filename(name))
            records.append(record_from_sidecar(name, sidecar, 0))
        target = next((r for r in records if r.entry_id == entry_id), None)
        if target is None:
            return []
        if target.group_key is None:
            return [target]
        group = [r for r in records if r.group_key == target.group_key]
        return sorted(group, key=lambda r: r.entry_id, reverse=True)

    def group_of(self, quarantine_dir: str, entry_id: str) -> List[QuarantineRecord]:
        """``fresh_group``: user actions never go by a snapshot that may be old."""
        return self.fresh_group(quarantine_dir, entry_id)

    # ── changes ────────────────────────────────────────────────────────────

    def forget(self, quarantine_dir: str, entry_ids: Iterable[str]) -> None:
        """Entries a person approved, deleted or recovered: out of the snapshot
        at once, and the folder read again soon."""
        quarantine_dir = _norm(quarantine_dir)
        gone = {str(i) for i in entry_ids if i}
        now = time.monotonic()
        with self._lock:
            marks = self._gone.setdefault(quarantine_dir, {})
            for entry_id in gone:
                marks[entry_id] = now
            snap = self._snaps.get(quarantine_dir)
            if snap is not None and gone:
                self._snaps[quarantine_dir] = Snapshot(
                    quarantine_dir,
                    tuple(r for r in snap.records if r.entry_id not in gone),
                    snap.taken_at, snap.listed_at)
            self._stale.add(quarantine_dir)

    def forget_all(self, quarantine_dir: str, entry_ids: Optional[Iterable[str]] = None) -> None:
        """A clear: the named entries (or everything) out of the snapshot."""
        quarantine_dir = _norm(quarantine_dir)
        if entry_ids is not None:
            self.forget(quarantine_dir, entry_ids)
            return
        now = time.monotonic()
        with self._lock:
            snap = self._snaps.get(quarantine_dir)
            if snap is not None:
                marks = self._gone.setdefault(quarantine_dir, {})
                for record in snap.records:
                    marks[record.entry_id] = now
                self._snaps[quarantine_dir] = Snapshot(quarantine_dir, (), snap.taken_at,
                                                       snap.listed_at)
            self._stale.add(quarantine_dir)

    def invalidate(self, quarantine_dir: str) -> None:
        """Something changed in the folder (a new file): refresh when due."""
        quarantine_dir = _norm(quarantine_dir)
        with self._lock:
            self._stale.add(quarantine_dir)

    # ── refreshing ─────────────────────────────────────────────────────────

    def _kick(self, quarantine_dir: str) -> threading.Event:
        """Start one background refresh unless one is running (and isn't
        hung: older than ``hung_after``); the running one's event."""
        now = time.monotonic()
        with self._lock:
            running = self._running.get(quarantine_dir)
            if running is not None:
                event, started = running
                if now - started < self.hung_after:
                    return event
                logger.warning("quarantine snapshot of %s has run for %.0fs: starting another",
                               quarantine_dir, now - started)
            event = threading.Event()
            self._running[quarantine_dir] = (event, now)
        thread = threading.Thread(
            target=self._run, args=(quarantine_dir, event),
            name="quarantine-snapshot", daemon=True)
        thread.start()
        return event

    def _run(self, quarantine_dir: str, event: threading.Event) -> None:
        try:
            started = time.monotonic()
            with self._lock:
                self._stale.discard(quarantine_dir)
            snap = self._build(quarantine_dir)
            with self._lock:
                self._failed_at.pop(quarantine_dir, None)
                marks = self._gone.get(quarantine_dir, {})
                if marks:
                    # what was taken out while this listing ran stays out
                    snap = Snapshot(quarantine_dir,
                                    tuple(r for r in snap.records if r.entry_id not in marks),
                                    snap.taken_at, snap.listed_at)
                    for entry_id, when in list(marks.items()):
                        if when < started:
                            del marks[entry_id]
                current = self._snaps.get(quarantine_dir)
                # a hung refresh that finishes late never replaces a newer one
                if current is None or current.listed_at <= snap.listed_at:
                    self._snaps[quarantine_dir] = snap
        except _ListingFailed as exc:
            # keep the last good snapshot (or stay not ready); try again when due
            logger.warning("quarantine snapshot: listing %s failed, keeping the last one: %s",
                           quarantine_dir, exc)
            with self._lock:
                self._failed_at[quarantine_dir] = time.monotonic()
                self._stale.add(quarantine_dir)
        except Exception as exc:  # noqa: BLE001 - a refresh never raises
            logger.warning("quarantine snapshot of %s failed: %s", quarantine_dir, exc)
            with self._lock:
                self._failed_at[quarantine_dir] = time.monotonic()
                self._stale.add(quarantine_dir)
        finally:
            with self._lock:
                running = self._running.get(quarantine_dir)
                if running is not None and running[0] is event:
                    self._running.pop(quarantine_dir, None)
            event.set()

    def refresh_now(self, quarantine_dir: str) -> Snapshot:
        """Read the folder now and wait for it (tests and tools)."""
        return self.wait(quarantine_dir, fresh=True)

    def _build(self, quarantine_dir: str) -> Snapshot:
        listed_at = time.monotonic()
        files: Dict[str, Any] = {}
        sidecars: Dict[str, Any] = {}
        try:
            with os.scandir(quarantine_dir) as listing:
                for item in listing:
                    if item.name.endswith(_QUARANTINE_SUFFIX):
                        files[item.name] = item
                    elif item.name.endswith(".json"):
                        sidecars[item.name] = item
        except FileNotFoundError:
            # no quarantine folder yet: nothing is held
            return Snapshot(quarantine_dir, (), time.monotonic(), listed_at)
        except OSError as exc:
            raise _ListingFailed(str(exc)) from exc

        cache = self._cache.get(quarantine_dir, {})
        fresh: Dict[str, Tuple[_Signature, QuarantineRecord]] = {}
        read = 0
        for name, item in files.items():
            try:
                if not item.is_file():
                    continue
                st = item.stat()  # the one stat for this file
            except OSError:
                continue
            side = sidecars.get(f"{_entry_id_from_filename(name)}.json")
            side_size = side_mtime = -1
            if side is not None:
                try:
                    side_st = side.stat()
                    side_size, side_mtime = side_st.st_size, side_st.st_mtime_ns
                except OSError:
                    pass
            signature: _Signature = (st.st_size, st.st_mtime_ns, side_size, side_mtime)
            known = cache.get(name)
            if known is not None and known[0] == signature:
                fresh[name] = known
                continue
            sidecar = read_sidecar(quarantine_dir, _entry_id_from_filename(name)) if side else {}
            read += 1
            fresh[name] = (signature, record_from_sidecar(name, sidecar, int(st.st_size)))
        with self._lock:
            self._cache[quarantine_dir] = fresh
        records = sorted((record for _sig, record in fresh.values()),
                         key=lambda r: r.entry_id, reverse=True)
        logger.debug("quarantine snapshot of %s: %d files, %d sidecars read, %.2fs",
                     quarantine_dir, len(records), read, time.monotonic() - listed_at)
        return Snapshot(quarantine_dir, tuple(records), time.monotonic(), listed_at)

    def note_listing(self, quarantine_dir: str, names: Iterable[str]) -> None:
        """A fresh listing of the folder's names (the Downloads list): what's
        gone leaves the snapshot at once, so its count agrees with the list;
        anything new marks it stale (its sidecar is read on the next refresh)."""
        quarantine_dir = _norm(quarantine_dir)
        present = set(names)
        with self._lock:
            snap = self._snaps.get(quarantine_dir)
            if snap is None:
                return
            known = {r.filename for r in snap.records}
            if known - present:
                self._snaps[quarantine_dir] = Snapshot(
                    quarantine_dir,
                    tuple(r for r in snap.records if r.filename in present),
                    snap.taken_at, snap.listed_at)
            if present - known or known - present:
                self._stale.add(quarantine_dir)


def count_songs(records: Iterable[QuarantineRecord]) -> int:
    """How many songs the files are attempts at: one per group key (the same
    intended target, see quarantine_group_key), and one per file that names no
    target."""
    keys = set()
    loose = 0
    for record in records:
        if record.group_key is None:
            loose += 1
        else:
            keys.add(record.group_key)
    return len(keys) + loose


def newest_time(snap: Snapshot) -> int:
    """When the newest entry was quarantined (unix seconds, from its file
    name's local timestamp), 0 when no name says."""
    from datetime import datetime
    for record in snap.records:
        try:
            return int(datetime.strptime(record.entry_id[:15], "%Y%m%d_%H%M%S").timestamp())
        except ValueError:
            continue
    return 0


_shared = QuarantineSnapshots()


def shared_index() -> QuarantineSnapshots:
    return _shared


def quarantine_dir_for(config_manager: Any) -> str:
    """The quarantine folder for the configured downloads folder."""
    from core.imports.paths import docker_resolve_path
    return os.path.join(
        docker_resolve_path(config_manager.get("soulseek.download_path", "./downloads")),
        "ss_quarantine")


__all__ = [
    "MAX_AGE",
    "MIN_INTERVAL",
    "QuarantineRecord",
    "QuarantineSnapshots",
    "Snapshot",
    "count_songs",
    "name_key",
    "newest_time",
    "quarantine_dir_for",
    "record_from_sidecar",
    "shared_index",
]
