"""A small, cached index of what each quarantined download was meant to be.

The Wanted page asks "is there a quarantined attempt at this song?" for every
row, and Downloads → Review asks "which other attempts are there at this
song?" for one entry. Both need each sidecar's *intended target* (the ids the
download task carried, the ISRC, the expected artist and title), not the whole
pipeline context. A big review queue holds thousands of sidecars, so reading
every one on every request is too slow.

The index lists the folder each time (cheap) and reads a sidecar only when its
file is new or changed since the last read. Entries are keyed by the
``.quarantined`` file name, which never changes for the life of an entry
(approve, delete and clear remove the file; they never rename it).

Read-only: it never writes or moves anything in the quarantine folder. Never
raises: an unreadable sidecar is indexed with what its file name gives.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, List, Optional, Tuple

from core.imports.quarantine import (
    _QUARANTINE_SUFFIX,
    _entry_id_from_filename,
    quarantine_group_key,
)
from utils.logging_config import get_logger

logger = get_logger("imports.quarantine_index")

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


def _read_record(quarantine_dir: str, name: str) -> QuarantineRecord:
    entry_id = _entry_id_from_filename(name)
    sidecar: Dict[str, Any] = {}
    try:
        with open(os.path.join(quarantine_dir, f"{entry_id}.json"), encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            sidecar = loaded
    except Exception as exc:  # noqa: BLE001 - missing/garbled sidecars are normal
        logger.debug("quarantine index: no sidecar for %s: %s", entry_id, exc)

    ctx = sidecar.get("context") if isinstance(sidecar.get("context"), dict) else {}
    ti = ctx.get("track_info") if isinstance(ctx.get("track_info"), dict) else {}
    ids = set()
    for key in _TRACK_ID_KEYS:
        value = ti.get(key)
        if isinstance(value, (str, int)) and str(value).strip():
            ids.add(str(value).strip())
    wishlist_id = ti.get("wishlist_id")
    isrc = str(ti.get("isrc") or "").strip().lower() or None
    expected_artist = str(sidecar.get("expected_artist") or "")
    expected_track = str(sidecar.get("expected_track") or "")
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
    )


class QuarantineIndex:
    """Thread-safe; one per process is enough (see ``shared_index``)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._dir: Optional[str] = None
        # file name -> (mtime of the sidecar or file, record)
        self._records: Dict[str, Tuple[float, QuarantineRecord]] = {}

    def records(self, quarantine_dir: str) -> List[QuarantineRecord]:
        """Every quarantined file's record, newest first (as the list sorts)."""
        if not quarantine_dir or not os.path.isdir(quarantine_dir):
            return []
        try:
            names = [n for n in os.listdir(quarantine_dir) if n.endswith(_QUARANTINE_SUFFIX)]
        except OSError as exc:
            logger.debug("quarantine index: listdir failed: %s", exc)
            return []
        with self._lock:
            if self._dir != quarantine_dir:
                self._dir = quarantine_dir
                self._records = {}
            fresh: Dict[str, Tuple[float, QuarantineRecord]] = {}
            for name in names:
                stamp = self._stamp(quarantine_dir, name)
                if stamp is None:
                    continue
                known = self._records.get(name)
                if known is not None and known[0] == stamp:
                    fresh[name] = known
                else:
                    fresh[name] = (stamp, _read_record(quarantine_dir, name))
            self._records = fresh
            out = [record for _stamp, record in fresh.values()]
        out.sort(key=lambda r: r.entry_id, reverse=True)
        return out

    @staticmethod
    def _stamp(quarantine_dir: str, name: str) -> Optional[float]:
        """The newer of the file's and its sidecar's mtimes; None if the file is gone."""
        path = os.path.join(quarantine_dir, name)
        try:
            if not os.path.isfile(path):
                return None
            stamp = os.path.getmtime(path)
        except OSError:
            return None
        try:
            sidecar = os.path.join(quarantine_dir, f"{_entry_id_from_filename(name)}.json")
            stamp = max(stamp, os.path.getmtime(sidecar))
        except OSError:
            pass
        return stamp

    def group_of(self, quarantine_dir: str, entry_id: str) -> List[QuarantineRecord]:
        """The entry and every other attempt at the same intended song, newest
        first; [] when the entry isn't there. An entry with no group key (nothing
        names its target) is a group of one."""
        records = self.records(quarantine_dir)
        target = next((r for r in records if r.entry_id == entry_id), None)
        if target is None:
            return []
        if target.group_key is None:
            return [target]
        return [r for r in records if r.group_key == target.group_key]


def count_songs(records: List[QuarantineRecord]) -> int:
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


_shared = QuarantineIndex()


def shared_index() -> QuarantineIndex:
    return _shared


__all__ = ["QuarantineIndex", "QuarantineRecord", "count_songs", "name_key", "shared_index"]
