"""The two bins a music library leaves behind, and one sweep for both.

quarantine (``<download_path>/ss_quarantine``) holds downloads that failed
verification and are waiting on a decision. the recycle bin (the deleted
quarantine under the transfer folder) holds library files a tool deleted,
kept so they can be reclaimed. neither empties itself: the quarantine never
did, and the recycle bin's retention only ever ran when someone opened the
Recycle Bin tab, so a bin nobody looked at grew forever (LettuceSnob, Sep 17
2026: "is there any way for me to manually trigger that scrub myself?").

this module is the single place that knows how to empty each one. the api
route, the clear_quarantine automation, full_cleanup and the weekly
library_cleanup automation all call in here instead of carrying their own
copy of the folder walk.

emptying either bin deletes files for good, so the http routes only do it
against a preview plan (core.library.action_plans): ``preview_*`` lists what
would go, and ``clear_planned_quarantine`` / ``purge_planned_recycle`` delete
exactly those entries, never whatever arrived after the preview. the
automations keep their own switch (``confirm``) and call the folder-level
functions directly.
"""

from __future__ import annotations

import os
import shutil
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from utils.logging_config import get_logger

logger = get_logger("library.cleanup")

QUARANTINE_DIRNAME = "ss_quarantine"
QUARANTINE_SUFFIX = ".quarantined"

# action-plan tool names for the two permanent deletes the ui can ask for
QUARANTINE_CLEAR_TOOL = "quarantine_clear"
RECYCLE_PURGE_TOOL = "recycle_bin_purge"


def quarantine_path(download_path: str) -> str:
    return os.path.join(download_path, QUARANTINE_DIRNAME)


def clear_quarantine_folder(path: str) -> Dict[str, Any]:
    """Delete everything directly under ``path``. Files and folders both
    count as one item, as they always have. A missing folder is an empty
    one. Never raises for one bad entry: it is reported and the rest still
    go. Returns ``{'existed', 'removed', 'errors': [{'entry', 'error'}]}``."""
    if not os.path.isdir(path):
        return {"existed": False, "removed": 0, "errors": []}
    removed = 0
    errors: List[Dict[str, str]] = []
    for entry in os.listdir(path):
        fp = os.path.join(path, entry)
        try:
            if os.path.isfile(fp) or os.path.islink(fp):
                os.remove(fp)
                removed += 1
            elif os.path.isdir(fp):
                shutil.rmtree(fp)
                removed += 1
        except Exception as exc:  # noqa: BLE001 - best-effort purge, keep going
            logger.debug("quarantine entry purge failed for %s: %s", entry, exc)
            errors.append({"entry": entry, "error": str(exc)})
    return {"existed": True, "removed": removed, "errors": errors}


def purge_recycle_bin(transfer_folder: str, keep_days: float) -> Dict[str, Any]:
    """Empty the deleted quarantine the way its retention setting says to.

    keep_days > 0: only entries older than that (the same age rule the
    Recycle Bin tab applies on open). keep_days == 0 means "keep forever"
    on the tab, but an automation someone switched on is an instruction to
    empty the bin, so 0 empties it. Returns ``{'mode', 'keep_days',
    'purged', 'errors'}``."""
    from core.library import deleted_quarantine

    try:
        days = float(keep_days or 0)
    except (TypeError, ValueError):
        days = 0.0
    if days > 0:
        purged = deleted_quarantine.purge_expired(transfer_folder, days)
        return {"mode": "expired", "keep_days": days, "purged": int(purged or 0), "errors": []}
    result = deleted_quarantine.purge_entries(transfer_folder, None, purge_all=True)
    return {"mode": "all", "keep_days": 0.0,
            "purged": len(result.get("purged") or []),
            "errors": list(result.get("errors") or [])}


def _entry_size(fp: str) -> int:
    """Bytes a quarantine entry holds: the file, or everything under a folder."""
    try:
        if os.path.isfile(fp) or os.path.islink(fp):
            return os.path.getsize(fp) if os.path.isfile(fp) else 0
        total = 0
        for dirpath, _dirs, files in os.walk(fp):
            for name in files:
                try:
                    total += os.path.getsize(os.path.join(dirpath, name))
                except OSError:
                    continue
        return total
    except OSError:
        return 0


def _iso_utc(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def _quarantine_kind(name: str) -> str:
    if name.endswith(QUARANTINE_SUFFIX):
        return "file"
    if name.endswith(".json"):
        return "info"
    return "other"


def preview_quarantine(path: str) -> List[Dict[str, Any]]:
    """What clear_quarantine_folder WOULD delete, one item per entry. Reads only.

    Each item: ``path``, ``name``, ``kind`` (``file`` for a quarantined
    download, ``info`` for its sidecar, ``other`` for anything else),
    ``size`` (bytes, folders summed), ``modified`` (UTC ISO; a download is
    dated by its sidecar, which is written when it is quarantined)."""
    if not os.path.isdir(path):
        return []
    items: List[Dict[str, Any]] = []
    for entry in sorted(os.listdir(path)):
        fp = os.path.join(path, entry)
        kind = _quarantine_kind(entry)
        stamp_from = fp
        if kind == "file":
            stem = os.path.splitext(entry[: -len(QUARANTINE_SUFFIX)])[0]
            sidecar = os.path.join(path, f"{stem}.json")
            if os.path.isfile(sidecar):
                stamp_from = sidecar
        try:
            modified = _iso_utc(os.path.getmtime(stamp_from))
        except OSError:
            modified = None
        items.append({"path": fp, "name": entry, "kind": kind, "action": "delete_permanently",
                      "reason": "held in the download quarantine (failed verification)",
                      "size": _entry_size(fp), "modified": modified})
    return items


def removal_stats(items: Iterable[Dict[str, Any]], date_key: str) -> Dict[str, Any]:
    """The numbers a permanent-delete confirm shows: how many files (sidecars
    counted apart), total bytes, and the oldest and newest date. Pure."""
    files = info = 0
    total = 0
    dated: List[tuple] = []
    for item in items:
        if item.get("kind") == "info":
            info += 1
        else:
            files += 1
        try:
            total += int(item.get("size") or 0)
        except (TypeError, ValueError):
            pass
        raw = item.get(date_key)
        if raw and item.get("kind") != "info":
            try:
                dated.append((datetime.fromisoformat(str(raw)), str(raw)))
            except ValueError:
                continue
    dated.sort(key=lambda pair: pair[0])
    return {"files": files, "info_files": info, "total_bytes": total,
            "oldest": dated[0][1] if dated else None,
            "newest": dated[-1][1] if dated else None}


def clear_planned_quarantine(path: str, items: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Delete exactly the planned quarantine entries that are still there.

    Anything quarantined after the preview stays. An entry that is gone, a
    file whose size changed since the preview, or a name that is not a plain
    entry of this folder, is skipped. Returns
    ``{'existed', 'removed', 'files_removed', 'freed_bytes', 'skipped',
    'errors': [{'entry', 'error'}]}``; ``files_removed`` leaves out
    sidecars."""
    out: Dict[str, Any] = {"existed": os.path.isdir(path), "removed": 0, "files_removed": 0,
                           "freed_bytes": 0, "skipped": 0, "errors": []}
    if not out["existed"]:
        return out
    for item in items:
        name = str(item.get("name") or "")
        if not name or name in (".", "..") or os.sep in name or (os.altsep and os.altsep in name):
            out["skipped"] += 1
            continue
        fp = os.path.join(path, name)
        if not os.path.lexists(fp):
            out["skipped"] += 1
            continue
        size = _entry_size(fp)
        if os.path.isfile(fp) and "size" in item and size != item.get("size"):
            out["skipped"] += 1
            continue
        try:
            if os.path.isfile(fp) or os.path.islink(fp):
                os.remove(fp)
            else:
                shutil.rmtree(fp)
        except Exception as exc:  # noqa: BLE001 - report the entry, keep going
            out["errors"].append({"entry": name, "error": str(exc)})
            continue
        out["removed"] += 1
        out["freed_bytes"] += size
        if _quarantine_kind(name) != "info":
            out["files_removed"] += 1
    return out


def preview_recycle_entries(transfer_folder: str, ids: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    """What emptying the recycle bin (``ids=None``) or purging these entries
    WOULD delete for good. Reads only: listing with keep_days=0 never runs
    the age purge."""
    from core.library import deleted_quarantine

    entries = deleted_quarantine.list_entries(transfer_folder, keep_days=0)["entries"]
    if ids is not None:
        wanted = {str(i) for i in ids}
        entries = [e for e in entries if e["id"] in wanted]
    return [{"id": e["id"], "name": e["name"], "path": e["original_path"], "size": e["size"],
             "deleted_at": e["deleted_at"], "source": e["source"], "kind": "file",
             "action": "delete_permanently", "reason": "in the recycle bin"}
            for e in entries]


def purge_planned_recycle(transfer_folder: str, items: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Delete for good exactly the planned recycle-bin entries that are still
    there unchanged (same size, same deletion time). A file restored since
    the preview, or a different file now at the same place, is skipped.
    Returns ``{'purged': [ids], 'skipped': [ids], 'errors': [...],
    'freed_bytes'}``."""
    from core.library import deleted_quarantine

    current = {e["id"]: e for e in deleted_quarantine.list_entries(transfer_folder, keep_days=0)["entries"]}
    ids: List[str] = []
    skipped: List[str] = []
    sizes: Dict[str, int] = {}
    for item in items:
        entry_id = str(item.get("id") or "")
        now = current.get(entry_id)
        if not now or now["size"] != item.get("size") or now["deleted_at"] != item.get("deleted_at"):
            skipped.append(entry_id)
            continue
        ids.append(entry_id)
        sizes[entry_id] = int(now["size"] or 0)
    result = deleted_quarantine.purge_entries(transfer_folder, ids) if ids else {"purged": [], "errors": []}
    purged = list(result.get("purged") or [])
    return {"purged": purged, "skipped": skipped, "errors": list(result.get("errors") or []),
            "freed_bytes": sum(sizes.get(i, 0) for i in purged)}


def preview_recycle_purge(transfer_folder: str, keep_days: float) -> List[Dict[str, Any]]:
    """What purge_recycle_bin WOULD delete for good, with the same keep-window
    rule (0 = an automation empties the whole bin). Reads only: it lists with
    keep_days=0 so the listing's own opportunistic purge never fires."""
    from core.library import deleted_quarantine

    try:
        days = float(keep_days or 0)
    except (TypeError, ValueError):
        days = 0.0
    entries = deleted_quarantine.list_entries(transfer_folder, keep_days=0)["entries"]
    if days > 0:
        expired = set(deleted_quarantine.expired_entry_ids(transfer_folder, days))
        entries = [e for e in entries if e["id"] in expired]
        reason = f"in the recycle bin longer than the {days:g}-day keep window"
    else:
        reason = "recycle bin is set to keep forever, so an automation empties all of it"
    return [{"path": e["original_path"], "recycle_id": e["id"], "action": "delete_permanently",
             "reason": reason, "size": e["size"], "deleted_at": e["deleted_at"], "source": e["source"]}
            for e in entries]


def preview_library_cleanup(*, download_path: str, transfer_folder: str, keep_days: float,
                            clear_quarantine: bool = True, empty_recycle_bin: bool = True) -> Dict[str, Any]:
    """The plan for run_library_cleanup: every file it would delete for good
    and why. Deletes nothing. Returns ``{'quarantine': [...], 'recycle_bin':
    [...], 'items': [...]}``."""
    quarantine = preview_quarantine(quarantine_path(download_path)) if clear_quarantine else []
    recycle = preview_recycle_purge(transfer_folder, keep_days) if empty_recycle_bin else []
    return {"quarantine": quarantine, "recycle_bin": recycle, "items": quarantine + recycle}


def run_library_cleanup(*, download_path: str, transfer_folder: str, keep_days: float,
                        clear_quarantine: bool = True, empty_recycle_bin: bool = True,
                        say: Optional[Any] = None) -> Dict[str, Any]:
    """The weekly sweep: quarantine, then the recycle bin, each optional.
    ``say(line, kind)`` narrates a step when given. Returns a summary with
    both step results, the total removed and every error, and never raises
    for one step so the other still runs."""
    summary: Dict[str, Any] = {"quarantine": None, "recycle_bin": None, "removed": 0, "errors": []}

    def _say(line: str, kind: str = "info") -> None:
        if say is None:
            return
        try:
            say(line, kind)
        except Exception as exc:  # noqa: BLE001 - narration never breaks the sweep
            logger.debug("cleanup narration failed: %s", exc)

    if clear_quarantine:
        try:
            q = clear_quarantine_folder(quarantine_path(download_path))
        except Exception as exc:  # noqa: BLE001
            logger.exception("library cleanup: quarantine step failed")
            q = {"existed": True, "removed": 0, "errors": [{"entry": "", "error": str(exc)}]}
        summary["quarantine"] = q
        summary["removed"] += q["removed"]
        summary["errors"].extend({"step": "quarantine", **e} for e in q["errors"])
        _say("Quarantine: removed %d item(s)" % q["removed"] if q["existed"]
             else "Quarantine: no folder yet, nothing to clear",
             "success" if q["removed"] else "info")

    if empty_recycle_bin:
        try:
            r = purge_recycle_bin(transfer_folder, keep_days)
        except Exception as exc:  # noqa: BLE001
            logger.exception("library cleanup: recycle bin step failed")
            r = {"mode": "error", "keep_days": keep_days, "purged": 0,
                 "errors": [{"id": "", "error": str(exc)}]}
        summary["recycle_bin"] = r
        summary["removed"] += r["purged"]
        summary["errors"].extend({"step": "recycle_bin", **e} for e in r["errors"])
        if r["mode"] == "expired":
            _say("Recycle bin: purged %d file(s) older than %g day(s)" % (r["purged"], r["keep_days"]),
                 "success" if r["purged"] else "info")
        elif r["mode"] == "all":
            _say("Recycle bin: emptied, %d file(s) deleted for good" % r["purged"],
                 "success" if r["purged"] else "info")
        else:
            _say("Recycle bin: step failed, see log", "error")

    return summary
