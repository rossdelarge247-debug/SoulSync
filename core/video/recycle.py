"""Video recycle bin — deletes move to trash instead of unlinking (Radarr-style).

Every path that destroys a user's media file (upgrade-replace, YouTube
retention, dismissed imports — and future watched-cleanup / duplicate deletes)
routes through :func:`discard`. With ``recycle_deletes`` on (the default) the
file moves into an ``ss_recycle`` folder — the video sibling of the music
side's ``ss_quarantine`` convention — named ``<YYYYMMDD_HHMMSS>_<original>``.

Entries older than ``recycle_keep_days`` are purged by the daily "Empty Recycle
Bin" automation, plus opportunistically on each discard. the automation is the
one that matters: the opportunistic pass only fires when something ELSE gets
deleted, so on a quiet library nothing ever expired. age is read off the name
stamp, never mtime, because moving a file keeps its original mtime.

Trash location: ``recycle_path`` when set; otherwise ``<library root>/ss_recycle``
for whichever configured library root (movies/tv/youtube) contains the file.
A file under NO known root falls back to a permanent delete (logged) — refusing
to delete would silently wedge retention/cleanup semantics and fill the disk.

Failure discipline: if the trash move itself fails, the file is LEFT IN PLACE
and ``{"ok": False}`` comes back — callers keep their existing "couldn't
delete → retry later / non-fatal" behaviour. discard never half-deletes.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
from datetime import datetime
from typing import Any, Callable, Dict, Optional

from utils.logging_config import get_logger

logger = get_logger("video.recycle")

TRASH_DIRNAME = "ss_recycle"

def _library_roots(db) -> list:
    from core.video.library_roots import library_roots
    return library_roots(db)


def _root_for(path: str, roots) -> Optional[str]:
    """The configured library root that contains ``path`` (deepest wins)."""
    ap = os.path.abspath(path)
    best = None
    for r in roots:
        ar = os.path.abspath(r)
        try:
            if os.path.commonpath([ap, ar]) == ar:
                if best is None or len(ar) > len(best):
                    best = ar
        except ValueError:   # different drives (Windows) → not an ancestor
            continue
    return best


def trash_dir_for(path: str, settings: Dict[str, Any], db) -> Optional[str]:
    """Where ``path`` would be recycled to, or None (→ permanent delete)."""
    override = str((settings or {}).get("recycle_path") or "").strip()
    if override:
        return override
    root = _root_for(path, _library_roots(db))
    return os.path.join(root, TRASH_DIRNAME) if root else None


def discard(path: str, settings: Dict[str, Any], db, *, reason: str = "") -> Dict[str, Any]:
    """Delete-or-recycle one file per the organization settings.

    Returns ``{"ok": bool, "recycled": bool, "trash_path": str|None}``.
    ``ok`` False = the file is still where it was (caller retries later)."""
    if not path or not os.path.exists(path):
        return {"ok": True, "recycled": False, "trash_path": None}   # already gone = done
    if not (settings or {}).get("recycle_deletes", True):
        return _unlink(path)
    trash = trash_dir_for(path, settings, db)
    if not trash:
        logger.warning("recycle: %s is under no configured library root — deleting permanently", path)
        return _unlink(path)
    try:
        os.makedirs(trash, exist_ok=True)
        stamp = datetime.fromtimestamp(time.time()).strftime("%Y%m%d_%H%M%S")
        dest = os.path.join(trash, f"{stamp}_{os.path.basename(path)}")
        n = 2
        while os.path.exists(dest):   # same second, same name → suffix like quarantine
            dest = os.path.join(trash, f"{stamp}_({n})_{os.path.basename(path)}")
            n += 1
        shutil.move(path, dest)
        _manifest_record(trash, os.path.basename(dest), path, reason)
        logger.info("recycled %s -> %s%s", path, dest, f" ({reason})" if reason else "")
    except OSError:
        logger.exception("recycle: could not move %s to trash — leaving it in place", path)
        return {"ok": False, "recycled": False, "trash_path": None}
    try:
        purge_old(settings, db, roots_hint=[trash])
    except Exception:   # noqa: BLE001 - the purge is housekeeping, never a failure
        logger.exception("recycle: purge pass failed")
    return {"ok": True, "recycled": True, "trash_path": dest}


def _unlink(path: str) -> Dict[str, Any]:
    try:
        os.remove(path)
        return {"ok": True, "recycled": False, "trash_path": None}
    except OSError:
        logger.exception("recycle: permanent delete failed for %s", path)
        return {"ok": False, "recycled": False, "trash_path": None}


# entries are named "<YYYYMMDD_HHMMSS>_<original>" (plus "(n)_" on a same-second
# collision). that stamp is the only honest record of when a file was recycled.
_STAMP_RE = re.compile(r"^(\d{8})_(\d{6})_")


def _stamp_epoch(name: str):
    m = _STAMP_RE.match(str(name or ""))
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").timestamp()
    except ValueError:
        return None


def entry_age_seconds(name: str, now=None):
    """How long ago this entry was recycled, or None if it isn't ours.

    Age comes from the name stamp, NOT mtime. shutil.move keeps the original
    file's mtime, so a movie from 2019 lands in the bin already older than any
    keep window and the next purge deletes it on the spot. that gave the
    recycle bin a zero second undo window for exactly the files people most
    want back. no stamp means something else put the file there, so leave it
    alone.
    """
    t = _stamp_epoch(name)
    if t is None:
        return None
    return max(0.0, (time.time() if now is None else now) - t)


def purge_old(settings: Dict[str, Any], db, roots_hint=None) -> int:
    """Unlink trash entries older than ``recycle_keep_days``. Returns the count."""
    return purge_old_detailed(settings, db, roots_hint)[0]


def purge_old_detailed(settings: Dict[str, Any], db, roots_hint=None):
    """Same sweep, as ``(count, bytes_freed)``. The bytes are what anyone
    emptying a bin actually wants to see."""
    keep_days = int((settings or {}).get("recycle_keep_days") or 7)
    now = time.time()
    dirs = list(roots_hint or [])
    if not dirs:
        override = str((settings or {}).get("recycle_path") or "").strip()
        dirs = [override] if override else [
            os.path.join(r, TRASH_DIRNAME) for r in _library_roots(db)]
    removed = 0
    freed = 0
    for d in dirs:
        if not d or not os.path.isdir(d):
            continue
        dropped = []
        for name in os.listdir(d):
            fp = os.path.join(d, name)
            # only ever touch entries discard() wrote (they carry the stamp
            # prefix). someone can point recycle_path at a folder that holds
            # other stuff, and this used to delete by mtime alone.
            age = entry_age_seconds(name, now=now)
            if age is None or age < keep_days * 86400:
                continue
            try:
                if os.path.isfile(fp):
                    size = os.path.getsize(fp)
                    os.remove(fp)
                    removed += 1
                    freed += size
                    dropped.append(name)
            except OSError:   # noqa: PERF203 - per-file resilience
                logger.exception("recycle purge: could not remove %s", fp)
        # the manifest row outlives the file it describes unless we say
        # otherwise, so an install that purges for years grows a sidecar full
        # of entries for files that are long gone
        if dropped:
            data = _manifest_read(d)
            if any(name in data for name in dropped):
                for name in dropped:
                    data.pop(name, None)
                _manifest_write(d, data)
    if removed:
        logger.info("recycle purge: removed %d expired file(s), freed %.1f GB",
                    removed, freed / 1024 ** 3)
    return removed, freed


# ── the browsable bin (Aug 27) ───────────────────────────────────────────────
# music's deleted-files manager taught this: without a manifest the bin knows
# WHEN but not WHERE FROM, and restore is impossible. discard() records the
# original path in a per-trash-dir sidecar; entries older than the manifest
# list with original_path None and restore into _restored/ for a rescan.

_MANIFEST = ".soulsync_recycle.json"
_COLLISION_RE = re.compile(r"^(\d{8})_(\d{6})_(\(\d+\)_)?")


def _manifest_read(trash: str) -> Dict[str, Any]:
    try:
        with open(os.path.join(trash, _MANIFEST), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _manifest_write(trash: str, data: Dict[str, Any]) -> None:
    tmp = os.path.join(trash, _MANIFEST + ".tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=1)
        os.replace(tmp, os.path.join(trash, _MANIFEST))
    except OSError:
        logger.exception("recycle: could not write manifest in %s", trash)


def _manifest_record(trash: str, name: str, original: str, reason: str) -> None:
    data = _manifest_read(trash)
    data[name] = {
        "original_path": original,
        "reason": reason or "",
        "deleted_at": datetime.now().isoformat(timespec="seconds"),
    }
    _manifest_write(trash, data)


def _manifest_drop(trash: str, name: str) -> None:
    data = _manifest_read(trash)
    if name in data:
        del data[name]
        _manifest_write(trash, data)


def trash_dirs(settings: Dict[str, Any], db) -> list:
    """Every trash dir the current config can produce (override or per-root)."""
    override = str((settings or {}).get("recycle_path") or "").strip()
    if override:
        return [override]
    return [os.path.join(r, TRASH_DIRNAME) for r in _library_roots(db)]


def list_entries(settings: Dict[str, Any], db) -> list:
    """Browsable bin contents across every configured trash dir, newest first."""
    items = []
    for trash in trash_dirs(settings, db):
        if not trash or not os.path.isdir(trash):
            continue
        manifest = _manifest_read(trash)
        for name in os.listdir(trash):
            if name == _MANIFEST or name.endswith(".tmp"):
                continue
            fp = os.path.join(trash, name)
            if not os.path.isfile(fp):
                continue
            meta = manifest.get(name) or {}
            try:
                size = os.path.getsize(fp)
            except OSError:
                size = 0
            items.append({
                "name": name,
                "trash_dir": trash,
                "original_path": meta.get("original_path"),
                "reason": meta.get("reason") or "",
                "deleted_at": meta.get("deleted_at"),
                "age_seconds": entry_age_seconds(name),
                "size": size,
            })
    items.sort(key=lambda e: ((e.get("deleted_at") or ""), -(e.get("age_seconds") or 0)),
               reverse=True)
    return items


def _checked_entry(trash_dir: str, name: str, settings: Dict[str, Any], db) -> Optional[str]:
    """Validate a client-supplied (trash_dir, name) pair against the LIVE
    config. A dir that isn't currently a trash dir, or a name that isn't a
    bare basename, is a traversal attempt and returns None."""
    if not name or os.path.basename(name) != name or name == _MANIFEST:
        return None
    known = {os.path.abspath(d) for d in trash_dirs(settings, db) if d}
    trash_abs = os.path.abspath(str(trash_dir or ""))
    if trash_abs not in known:
        return None
    fp = os.path.join(trash_abs, name)
    return fp if os.path.isfile(fp) else None


def restore_entry(trash_dir: str, name: str, settings: Dict[str, Any], db) -> Dict[str, Any]:
    """Put one bin entry back. Manifested entries return to their exact
    original path; legacy ones (origin unrecorded) land in _restored/ next to
    the trash dir so a scan can pick them up."""
    fp = _checked_entry(trash_dir, name, settings, db)
    if not fp:
        return {"success": False, "error": "No such bin entry."}
    trash_abs = os.path.dirname(fp)
    meta = _manifest_read(trash_abs).get(name) or {}
    dest = meta.get("original_path")
    if not dest:
        base = _COLLISION_RE.sub("", name) or name
        parent = os.path.dirname(trash_abs) \
            if os.path.basename(trash_abs) == TRASH_DIRNAME else trash_abs
        dest = os.path.join(parent, "_restored", base)
    if os.path.exists(dest):
        return {"success": False, "error": f"A file already exists at {dest}"}
    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.move(fp, dest)
    except OSError as exc:
        logger.exception("recycle restore failed for %s", fp)
        return {"success": False, "error": str(exc)}
    _manifest_drop(trash_abs, name)
    logger.info("recycle: restored %s -> %s", fp, dest)
    return {"success": True, "restored_to": dest}


def purge_entry(trash_dir: str, name: str, settings: Dict[str, Any], db) -> Dict[str, Any]:
    """Permanently delete one bin entry."""
    fp = _checked_entry(trash_dir, name, settings, db)
    if not fp:
        return {"success": False, "error": "No such bin entry."}
    try:
        os.remove(fp)
    except OSError as exc:
        logger.exception("recycle purge failed for %s", fp)
        return {"success": False, "error": str(exc)}
    _manifest_drop(os.path.dirname(fp), name)
    return {"success": True}


# ── emptying the bin by hand: preview, then confirm ──────────────────────────
# Purging is permanent, so the http route only does it against a preview plan
# (core.library.action_plans): preview_purge lists exactly what would go, and
# purge_planned deletes those entries and nothing that arrived afterwards. The
# daily age-based purge above is the user's own setting and is left as it is.

VIDEO_RECYCLE_PURGE_TOOL = "video_recycle_purge"


def _deleted_at_iso(entry: Dict[str, Any]) -> Optional[str]:
    """When an entry was recycled: the manifest's record, else its name stamp."""
    if entry.get("deleted_at"):
        return str(entry["deleted_at"])
    stamp = _stamp_epoch(entry.get("name"))
    if stamp is None:
        return None
    return datetime.fromtimestamp(stamp).isoformat(timespec="seconds")


def preview_purge(settings: Dict[str, Any], db, wanted=None) -> list:
    """What purging the bin WOULD delete for good. Reads only.

    ``wanted`` is None for the whole bin, or a list of ``(trash_dir, name)``
    pairs for chosen entries; anything not in the bin under the live config is
    simply not listed. Each item: ``trash_dir``, ``entry`` (the name in the
    bin), ``name`` (without the stamp), ``path`` (where it came from, when
    recorded), ``size``, ``deleted_at``, ``reason``."""
    entries = list_entries(settings, db)
    if wanted is not None:
        keys = {(os.path.abspath(str(t or "")), str(n or "")) for t, n in wanted}
        entries = [e for e in entries if (os.path.abspath(e["trash_dir"]), e["name"]) in keys]
    return [{"trash_dir": e["trash_dir"], "entry": e["name"],
             "name": _COLLISION_RE.sub("", e["name"]) or e["name"],
             "path": e.get("original_path") or None, "size": int(e.get("size") or 0),
             "deleted_at": _deleted_at_iso(e), "kind": "file", "action": "delete_permanently",
             "reason": e.get("reason") or "in the video recycle bin"}
            for e in entries]


def purge_planned(settings: Dict[str, Any], db, items) -> Dict[str, Any]:
    """Delete for good exactly the planned bin entries that are still there
    unchanged (same size). One restored since the preview, or a different file
    now under the same name, is skipped. Returns ``{'purged': [entries],
    'skipped': [entries], 'errors': [{'entry', 'error'}], 'freed_bytes'}``."""
    current = {(os.path.abspath(e["trash_dir"]), e["name"]): e for e in list_entries(settings, db)}
    out: Dict[str, Any] = {"purged": [], "skipped": [], "errors": [], "freed_bytes": 0}
    for item in items:
        name = str(item.get("entry") or "")
        now = current.get((os.path.abspath(str(item.get("trash_dir") or "")), name))
        if not now or int(now.get("size") or 0) != int(item.get("size") or 0):
            out["skipped"].append(name)
            continue
        res = purge_entry(now["trash_dir"], now["name"], settings, db)
        if res.get("success"):
            out["purged"].append(name)
            out["freed_bytes"] += int(now.get("size") or 0)
        else:
            out["errors"].append({"entry": name, "error": res.get("error") or "could not delete"})
    if out["purged"]:
        logger.info("recycle: purged %d file(s) for good from the bin, freed %.1f GB",
                    len(out["purged"]), out["freed_bytes"] / 1024 ** 3)
    return out


def discarder(db, settings: Dict[str, Any]) -> Callable[[str], Dict[str, Any]]:
    """A bound ``discard(path)`` for injection into pure pipelines (the importer's
    upgrade-replace, retention's delete seam)."""
    def _discard(path: str, *, reason: str = "") -> Dict[str, Any]:
        return discard(path, settings, db, reason=reason)
    return _discard
