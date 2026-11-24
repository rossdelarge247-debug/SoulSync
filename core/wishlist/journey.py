"""Where each wanted track is on its way in: the Wanted page's journey read.

A wishlist row knows its tries and last failure. The rest of a song's journey
lives elsewhere, and this joins it back on:

* **the live download queue** (``download_tasks``, in memory). A task's
  ``track_info`` carries the wishlist row id (``wishlist_id``) when the task came
  from Wanted, and the source track id (``spotify_track_id``/``track_id``/
  ``id``) for Wanted and for playlist batches alike. Either joins. A download
  started from Search for the same song carries a different id and is not
  joined.
* **quarantine** (``ss_quarantine/*.json`` sidecars, via the cached index).
  The sidecar's ``context.track_info`` is the task's, so the same ids join;
  then the ISRC; then, for sidecars written before the full context was kept,
  the expected artist and title against the row's first artist and title
  (case and spacing ignored). A name join can't tell two versions of a song
  apart, so it says ``matched_by: "name"``.
* **mirrored playlists**, for the From filter: a wishlist row added by a
  playlist sync carries ``source_info.playlist_id`` (``auto_mirror_<id>`` for a
  mirror's sync, else the source playlist id) and ``playlist_name``. The
  mirror's own counts say how much of it is in the library, but only once the
  sync matcher has checked every track (``library_known``); until then the
  figure is a guess the Mirrored playlists page doesn't show either.

Read-only. Scoped to the profile's own wishlist rows: tasks and quarantine are
global, but only rows of this profile are answered for.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, List, Optional

from core.imports.quarantine_index import QuarantineRecord, name_key
from utils.logging_config import get_logger

logger = get_logger("wishlist.journey")

#: task statuses that mean "being looked for now"
SEARCH_STATUSES = ("pending", "searching")
#: task statuses that mean "a file is on its way"
DOWNLOAD_STATUSES = ("queued", "downloading", "post_processing", "postprocessing")
_RANK = {status: i for i, status in enumerate(SEARCH_STATUSES + DOWNLOAD_STATUSES)}

_TRACK_ID_KEYS = ("spotify_track_id", "track_id", "id")

#: playlist names that aren't names (sourceLabel in the web UI drops these too)
UNNAMED_PLAYLISTS = frozenset({"", "unknown playlist", "wishlist"})


def _as_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, ValueError):
            return {}
    return value if isinstance(value, dict) else {}


def _first_artist(data: Dict[str, Any]) -> str:
    artists = data.get("artists")
    if isinstance(artists, list) and artists:
        first = artists[0]
        if isinstance(first, dict):
            return str(first.get("name") or "")
        return str(first or "")
    return ""


# ── the live queue ────────────────────────────────────────────────────────────

def snapshot_active_tasks(download_tasks: Dict[str, Any], tasks_lock) -> Dict[str, Dict[str, Any]]:
    """id -> the furthest-along live task for it. Keys are ``wid:<row id>`` and
    ``sid:<source track id>``. Copies under the lock and returns plain dicts."""
    out: Dict[str, Dict[str, Any]] = {}
    with tasks_lock:
        items = list(download_tasks.items())
        snapshot = []
        for task_id, task in items:
            if not isinstance(task, dict):
                continue
            status = str(task.get("status") or "")
            if status not in _RANK:
                continue
            ti = task.get("track_info") if isinstance(task.get("track_info"), dict) else {}
            keys = []
            if ti.get("wishlist_id") not in (None, ""):
                keys.append(f"wid:{ti.get('wishlist_id')}")
            for key in _TRACK_ID_KEYS:
                value = ti.get(key)
                if isinstance(value, (str, int)) and str(value).strip():
                    keys.append(f"sid:{str(value).strip()}")
            if keys:
                progress = task.get("progress")
                snapshot.append((task_id, status, task.get("batch_id"), keys,
                                 progress if isinstance(progress, (int, float)) else None))
    for task_id, status, batch_id, keys, progress in snapshot:
        entry = {"status": status, "task_id": str(task_id), "batch_id": str(batch_id or "")}
        if progress is not None and status == "downloading":
            entry["progress"] = max(0, min(100, int(progress)))
        for key in keys:
            known = out.get(key)
            if known is None or _RANK[status] > _RANK[known["status"]]:
                out[key] = entry
    return out


def _task_for(row: Dict[str, Any], tasks: Dict[str, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    found = []
    if row.get("id") not in (None, ""):
        found.append(tasks.get(f"wid:{row['id']}"))
    if row.get("spotify_track_id"):
        found.append(tasks.get(f"sid:{row['spotify_track_id']}"))
    found = [t for t in found if t]
    if not found:
        return None
    return max(found, key=lambda t: _RANK[t["status"]])


def download_phase(status: str) -> str:
    """'searching' or 'downloading' for a live task status."""
    return "downloading" if status in DOWNLOAD_STATUSES else "searching"


# ── quarantine ────────────────────────────────────────────────────────────────

class _QuarantineLookup:
    def __init__(self, records: Iterable[QuarantineRecord]):
        self.by_id: Dict[str, List[QuarantineRecord]] = {}
        self.by_wishlist: Dict[str, List[QuarantineRecord]] = {}
        self.by_isrc: Dict[str, List[QuarantineRecord]] = {}
        self.by_name: Dict[str, List[QuarantineRecord]] = {}
        for record in records:  # newest first
            for tid in record.track_ids:
                self.by_id.setdefault(tid, []).append(record)
            if record.wishlist_id:
                self.by_wishlist.setdefault(record.wishlist_id, []).append(record)
            if record.isrc:
                self.by_isrc.setdefault(record.isrc, []).append(record)
            if record.name_key:
                self.by_name.setdefault(record.name_key, []).append(record)

    def match(self, row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        data = _as_dict(row.get("spotify_data"))
        hits: Dict[str, QuarantineRecord] = {}
        matched_by = None
        sid = str(row.get("spotify_track_id") or "")
        for record in self.by_id.get(sid, []) if sid else []:
            hits[record.entry_id] = record
        for record in self.by_wishlist.get(str(row.get("id")), []) if row.get("id") else []:
            # a wishlist row id is only meaningful with the same song's ids or
            # none at all (rows are deleted and the ids reused)
            if not record.track_ids or sid in record.track_ids:
                hits[record.entry_id] = record
        if hits:
            matched_by = "id"
        isrc = str(_as_dict(data.get("external_ids")).get("isrc") or "").strip().lower()
        if not hits and isrc:
            for record in self.by_isrc.get(isrc, []):
                hits[record.entry_id] = record
            if hits:
                matched_by = "isrc"
        if not hits:
            key = name_key(_first_artist(data), data.get("name"))
            for record in self.by_name.get(key, []) if key else []:
                # only sidecars that name no ids: one that does is for another song
                if not record.track_ids:
                    hits[record.entry_id] = record
            if hits:
                matched_by = "name"
        if not hits:
            return None
        newest = max(hits.values(), key=lambda r: r.entry_id)
        return {
            "entry_id": newest.entry_id,
            "count": len(hits),
            "reason": newest.reason,
            "trigger": newest.trigger,
            "matched_by": matched_by,
        }


# ── playlists ─────────────────────────────────────────────────────────────────

def _playlist_ref(source_info: Dict[str, Any]) -> tuple:
    name = str(source_info.get("playlist_name") or "").strip()
    pid = source_info.get("playlist_id")
    return name, (str(pid).strip() if pid not in (None, "") else "")


def _owned_among_checked(database: Any, mirror_ids: List[int]) -> Dict[int, int]:
    """mirror id -> tracks the sync matcher checked and found in the library
    (its ``in_library`` flag; the flag alone, never the join fallback). For a
    playlist still being checked, so its bar can tell the checked from the
    rest. Empty when it can't be read."""
    if not mirror_ids:
        return {}
    try:
        conn = database._get_connection()
    except Exception as exc:  # noqa: BLE001 - a nicety
        logger.debug("journey: owned-among-checked unavailable: %s", exc)
        return {}
    try:
        marks = ",".join("?" * len(mirror_ids))
        rows = conn.execute(
            "SELECT playlist_id, SUM(CASE WHEN extra_data LIKE '%\"in_library\": true%' "
            f"THEN 1 ELSE 0 END) FROM mirrored_playlist_tracks WHERE playlist_id IN ({marks}) "
            "GROUP BY playlist_id", list(mirror_ids)).fetchall()
        return {int(r[0]): int(r[1] or 0) for r in rows}
    except Exception as exc:  # noqa: BLE001 - a nicety
        logger.debug("journey: owned-among-checked unavailable: %s", exc)
        return {}
    finally:
        try:
            conn.close()
        except Exception as exc:  # noqa: BLE001 - closing never fails the read
            logger.debug("journey: closing the connection failed: %s", exc)


def playlist_progress(database: Any, rows: List[Dict[str, Any]], profile_id: int) -> List[Dict[str, Any]]:
    """One entry per playlist name on the wishlist, with its mirror's library
    figures when a mirror is found for it."""
    groups: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        if str(row.get("source_type") or "") != "playlist":
            continue
        name, pid = _playlist_ref(_as_dict(row.get("source_info")))
        if name.lower() in UNNAMED_PLAYLISTS:
            continue
        group = groups.setdefault(name.lower(), {"name": name, "playlist_ids": set()})
        if pid:
            group["playlist_ids"].add(pid)
    if not groups:
        return []

    mirrors: List[Dict[str, Any]] = []
    counts: Dict[int, Dict[str, int]] = {}
    try:
        mirrors = list(database.get_mirrored_playlists(profile_id=profile_id) or [])
        if mirrors:
            counts = database.get_all_mirrored_playlist_status_counts(profile_id=profile_id) or {}
    except Exception as exc:  # noqa: BLE001 - progress is a nicety
        logger.debug("journey: mirrored playlists unavailable: %s", exc)
        mirrors = []

    by_ref: Dict[str, Dict[str, Any]] = {}
    by_name: Dict[str, List[Dict[str, Any]]] = {}
    for mirror in mirrors:
        mid = mirror.get("id")
        by_ref[f"auto_mirror_{mid}"] = mirror
        for key in ("source_playlist_id", "upstream_playlist_id"):
            if mirror.get(key):
                by_ref[str(mirror[key])] = mirror
        for key in ("custom_name", "name"):
            label = str(mirror.get(key) or "").strip().lower()
            if label:
                by_name.setdefault(label, [])
                if mirror not in by_name[label]:
                    by_name[label].append(mirror)

    out = []
    checking: List[int] = []
    for lowered, group in sorted(groups.items()):
        mirror = None
        for pid in sorted(group["playlist_ids"]):
            if pid in by_ref:
                mirror = by_ref[pid]
                break
        if mirror is None and len(by_name.get(lowered, [])) == 1:
            mirror = by_name[lowered][0]
        entry: Dict[str, Any] = {"name": group["name"], "mirror": None}
        if mirror is not None:
            c = counts.get(mirror.get("id"), {})
            total = int(c.get("total") or 0)
            checked = int(c.get("library_checked") or 0)
            entry["mirror"] = {
                "id": mirror.get("id"),
                "name": str(mirror.get("custom_name") or mirror.get("name") or ""),
                "source": str(mirror.get("source") or ""),
                "total": total,
                "in_library": int(c.get("in_library") or 0),
                "library_checked": checked,
                # the same rule as the Mirrored playlists page (libraryOwnedKnown)
                "library_known": total > 0 and checked >= total,
            }
            if not entry["mirror"]["library_known"] and checked > 0:
                checking.append(int(mirror.get("id")))
        out.append(entry)
    owned = _owned_among_checked(database, checking)
    for entry in out:
        mirror = entry["mirror"]
        if mirror is not None and not mirror["library_known"]:
            # of the checked tracks, the ones the sync found in the library
            mirror["owned_checked"] = owned.get(int(mirror["id"]), 0)
    return out


# ── the whole read ────────────────────────────────────────────────────────────

def wishlist_journey(
    rows: List[Dict[str, Any]],
    *,
    tasks: Dict[str, Dict[str, Any]],
    quarantine: Iterable[QuarantineRecord],
) -> Dict[str, Dict[str, Any]]:
    """spotify_track_id -> {download?, quarantine?} for the rows that have one."""
    lookup = _QuarantineLookup(quarantine)
    out: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        sid = str(row.get("spotify_track_id") or "")
        if not sid:
            continue
        entry: Dict[str, Any] = {}
        task = _task_for(row, tasks)
        if task:
            entry["download"] = {**task, "phase": download_phase(task["status"])}
        held = lookup.match(row)
        if held:
            entry["quarantine"] = held
        if entry:
            out[sid] = entry
    return out


__all__ = [
    "DOWNLOAD_STATUSES",
    "SEARCH_STATUSES",
    "download_phase",
    "playlist_progress",
    "snapshot_active_tasks",
    "wishlist_journey",
]
