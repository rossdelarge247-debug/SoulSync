"""Quarantine by song and by verdict, and the bulk actions on a verdict.

Everything here works from the shared snapshot's records (each entry carries
its verdict, core.imports.quarantine_verdict), so a page over thousands of
held files never reads the folder.

* ``songs`` groups the files by the song they tried to be (the group key the
  list and the sibling lookups already use), marks each song's best try and
  says in a sentence what the tries are.
* ``delete_plan_items``: "Delete all N" for a verdict (cut off, broken). The
  items are exactly the files previewed (and their sidecars); the delete goes
  through ``core.library.cleanup.clear_planned_quarantine``, which skips a
  file that's gone or changed size since, so nothing quarantined after the
  preview is touched.
* ``keep_best_plan_items``: "Keep the best of each" for right_song /
  longer_version: per song, its best try to approve and the song's other
  tries to delete. ``KeepBestRunner`` does them one song at a time in the
  background (each approve re-runs the import), checking each best file is
  still the one previewed, and deleting only the planned others.

Nothing is imported automatically: both bulk actions start from a person's
confirm of a preview.
"""

from __future__ import annotations

import os
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional

from core.imports.quarantine_verdict import (
    DELETE_KINDS,
    KEEP_KINDS,
    LABELS,
    choose_best,
    song_summary,
)
from utils.logging_config import get_logger

logger = get_logger("imports.quarantine_bulk")

#: action plan tools (core.library.action_plans)
GROUP_DELETE_TOOL = "quarantine_group_delete"
KEEP_BEST_TOOL = "quarantine_keep_best"


def _explained(record: Any) -> Dict[str, Any]:
    return (getattr(record, "entry", None) or {}).get("explained") or {}


def _kind(record: Any) -> str:
    return str(_explained(record).get("kind") or "other")


def _song_key(record: Any) -> str:
    return str(getattr(record, "group_key", None) or f"id:{record.entry_id}")


def group_by_song(records: Iterable[Any]) -> Dict[str, List[Any]]:
    """Song (group key) -> its tries, newest first (records come newest first)."""
    songs: Dict[str, List[Any]] = {}
    for record in records:
        songs.setdefault(_song_key(record), []).append(record)
    return songs


def _try(record: Any) -> Dict[str, Any]:
    explained = _explained(record)
    return {"id": record.entry_id, "kind": explained.get("kind") or "other", "facts": explained}


def song_view(key: str, tries: List[Any]) -> Dict[str, Any]:
    """One song: its tries as list entries (each with ``explained``, the best
    one's ``verdict`` "best"), the best try's id and a summary sentence."""
    plain = [_try(r) for r in tries]
    best_id = choose_best(plain)
    best = next((r for r in tries if r.entry_id == best_id), None)
    best_len = _explained(best).get("actual_s") if best is not None else None
    # the best first, then the other likely keeps, then the rest (newest first within)
    order = {kind: i for i, kind in enumerate(KEEP_KINDS)}
    ranked = sorted(tries, key=lambda r: (r.entry_id != best_id, order.get(_kind(r), 9)))
    entries = []
    for record in ranked:
        entry = dict(record.entry)
        explained = dict(entry.get("explained") or {})
        is_best = record.entry_id == best_id
        explained["verdict"] = "best" if is_best else explained.get("kind")
        explained["verdict_label"] = LABELS["best"] if is_best else (
            explained.get("label") or LABELS.get(explained.get("kind") or "other", "Other"))
        own = explained.get("actual_s")
        if (not is_best and best_len and own and explained.get("kind") in KEEP_KINDS
                and abs(float(own) - float(best_len)) < 1.0):
            ends = {True: " Plays to the end.", None: ""}.get(explained.get("plays_to_end"), "")
            explained["text"] = "Same length as the best." + ends
        entry["explained"] = explained
        entries.append(entry)
    first = tries[0]
    return {
        "key": key,
        "title": first.expected_track or first.entry.get("original_filename") or "",
        "artist": first.expected_artist,
        "best": best_id,
        "summary": song_summary(plain, best_id),
        "tries": entries,
        "kinds": sorted({t["kind"] for t in plain}),
    }


def overview(records: List[Any]) -> List[Dict[str, Any]]:
    """Per verdict: files, songs and an example (the newest)."""
    out: Dict[str, Dict[str, Any]] = {}
    for record in records:
        kind = _kind(record)
        group = out.setdefault(kind, {"kind": kind, "files": 0, "songs": set(), "example": None})
        group["files"] += 1
        group["songs"].add(_song_key(record))
        if group["example"] is None:
            explained = _explained(record)
            group["example"] = {
                "title": record.expected_track or record.entry.get("original_filename") or "",
                "length": explained.get("length") or "",
                "spotify_length": explained.get("spotify_length") or "",
                "size_bytes": record.entry.get("size_bytes") or 0,
            }
    for group in out.values():
        group["songs"] = len(group["songs"])
    return list(out.values())


def songs_for_kind(records: List[Any], kind: Optional[str]) -> List[Dict[str, Any]]:
    """The songs with at least one try of ``kind`` (every song with None),
    newest first, each with all its tries."""
    views = []
    for key, tries in group_by_song(records).items():
        if kind and not any(_kind(r) == kind for r in tries):
            continue
        views.append(song_view(key, tries))
    return views


# ── the plans ────────────────────────────────────────────────────────────


def _file_items(quarantine_dir: str, record: Any) -> List[Dict[str, Any]]:
    from core.imports.quarantine import _entry_id_from_filename
    size = int(record.entry.get("size_bytes") or 0)
    sidecar = f"{_entry_id_from_filename(record.filename)}.json"
    return [
        {"name": record.filename, "path": os.path.join(quarantine_dir, record.filename),
         "kind": "file", "size": size, "action": "delete_permanently",
         "title": record.expected_track, "artist": record.expected_artist,
         "song": _song_key(record)},
        # no size: the AcoustID re-check may have rewritten it since
        {"name": sidecar, "path": os.path.join(quarantine_dir, sidecar), "kind": "info",
         "action": "delete_permanently"},
    ]


def delete_plan_items(quarantine_dir: str, records: List[Any], kind: str) -> List[Dict[str, Any]]:
    """Every file of ``kind`` (cut off or broken) and its sidecar."""
    if kind not in DELETE_KINDS:
        raise ValueError(f"Delete all is for {', '.join(DELETE_KINDS)}, not {kind}")
    items: List[Dict[str, Any]] = []
    for record in records:
        if _kind(record) == kind:
            items.extend(_file_items(quarantine_dir, record))
    return items


def keep_best_plan_items(records: List[Any], kind: str) -> List[Dict[str, Any]]:
    """Per song with a try of ``kind`` and a best try: the best to keep, the
    song's other tries to delete."""
    if kind not in KEEP_KINDS:
        raise ValueError(f"Keep the best is for {', '.join(KEEP_KINDS)}, not {kind}")
    items = []
    for key, tries in group_by_song(records).items():
        if not any(_kind(r) == kind for r in tries):
            continue
        view = song_view(key, tries)
        if not view["best"]:
            continue
        best = next(r for r in tries if r.entry_id == view["best"])
        items.append({
            "kind": "song", "song": key, "title": view["title"], "artist": view["artist"],
            "best": best.entry_id, "best_name": best.filename,
            "best_size": int(best.entry.get("size_bytes") or 0),
            "others": [{"id": r.entry_id, "name": r.filename,
                        "size": int(r.entry.get("size_bytes") or 0)}
                       for r in tries if r.entry_id != best.entry_id],
        })
    return items


def plan_counts(items: List[Dict[str, Any]]) -> Dict[str, Any]:
    """files, songs and bytes a plan covers (a keep-best plan: files kept and
    deleted)."""
    if items and items[0].get("kind") == "song":
        return {"songs": len(items), "keep": len(items),
                "delete": sum(len(i["others"]) for i in items),
                "bytes": sum(o["size"] for i in items for o in i["others"])}
    files = [i for i in items if i.get("kind") == "file"]
    return {"songs": len({i.get("song") for i in files}), "files": len(files),
            "bytes": sum(int(i.get("size") or 0) for i in files)}


# ── keep the best, in the background ─────────────────────────────────────


@dataclass
class KeepBestRunner:
    """Runs one keep-best plan at a time, one song at a time."""

    approve: Callable[[str], bool]
    delete: Callable[[str], bool]
    #: the current size of a quarantined file, by its name (None when it's gone)
    size_of: Callable[[str], Optional[int]]
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _thread: Optional[threading.Thread] = None
    _cancel: threading.Event = field(default_factory=threading.Event)
    state: Dict[str, Any] = field(default_factory=lambda: {"status": "idle"})

    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self, items: List[Dict[str, Any]], *, background: bool = True) -> bool:
        with self._lock:
            if self.running():
                return False
            self._cancel.clear()
            self.state = {"status": "running", "songs": len(items), "done": 0, "kept": 0,
                          "deleted": 0, "skipped": 0, "errors": 0}
            if background:
                self._thread = threading.Thread(target=self._run, args=(items,), daemon=True,
                                                name="quarantine-keep-best")
                self._thread.start()
                return True
        self._run(items)
        return True

    def cancel(self) -> None:
        self._cancel.set()

    def _count(self, **changes: int) -> None:
        with self._lock:
            for key, value in changes.items():
                self.state[key] = int(self.state.get(key) or 0) + value

    def _run(self, items: List[Dict[str, Any]]) -> None:
        for item in items:
            if self._cancel.is_set():
                self.state["status"] = "cancelled"
                return
            try:
                # only the file previewed: gone, or another size, and the song is left as it is
                if self.size_of(item["best_name"]) != item["best_size"]:
                    self._count(done=1, skipped=1)
                    continue
                if not self.approve(item["best"]):
                    self._count(done=1, errors=1)
                    continue
                deleted = 0
                for other in item["others"]:
                    if self.size_of(other["name"]) != other["size"]:
                        continue
                    if self.delete(other["id"]):
                        deleted += 1
                self._count(done=1, kept=1, deleted=deleted)
            except Exception as exc:  # noqa: BLE001 - one song never stops the rest
                logger.warning("keep-best failed for %s: %s", item.get("title"), exc)
                self._count(done=1, errors=1)
        self.state["status"] = "done"


__all__ = ["GROUP_DELETE_TOOL", "KEEP_BEST_TOOL", "KeepBestRunner", "delete_plan_items",
           "group_by_song", "keep_best_plan_items", "overview", "plan_counts", "song_view",
           "songs_for_kind"]
