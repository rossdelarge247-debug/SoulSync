"""The drives SYNCHRO.S can see, their space and format, and folder sizes.

SYNCHRO.S runs in Docker, so it sees the computer's drives only through the
drives folder the Docker step mounts at the same path inside: ``/Volumes`` on
a Mac, ``/mnt`` and ``/media`` on Linux, ``/drives/<letter>`` on Windows
(Docker Desktop). ``SOULSYNC_DRIVES_ROOTS`` (paths joined with ``os.pathsep``)
overrides the list, for tests and unusual set-ups.

Nothing here writes. Every probe that can fail answers "unknown" rather than
raising, and nothing follows a symlink: ``/Volumes/Macintosh HD`` is a link
to the computer's own root, and a link inside a folder never leads a size
count or a listing out of it.
"""

from __future__ import annotations

import os
import re
import shutil
import stat as _stat
import threading
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

from utils.logging_config import get_logger

logger = get_logger("drives.disks")

PLATFORMS = ("mac", "linux", "windows")
ROOTS_BY_PLATFORM = {
    "mac": ("/Volumes",),
    "linux": ("/mnt", "/media"),
    "windows": ("/drives",),
}
#: what the helper adds, per platform, as "host:container" (the same path
#: inside); Windows mounts each drive letter the helper finds
MOUNT_LINES = {
    "mac": ("/Volumes:/Volumes",),
    "linux": ("/mnt:/mnt", "/media:/media"),
    "windows": ("D:\\:/drives/d",),
}
HOME_DISK = {"mac": "Macintosh HD", "windows": "C:", "linux": "this computer's disk"}

#: entries under a drives folder that are never offered
_SKIP_NAMES = {"Recovery", "Preboot", "VM", "Update", "com.apple.TimeMachine.localsnapshots",
               "Macintosh HD", "Macintosh HD - Data"}
_BACKUP_MARKS = ("Backups.backupdb", ".timemachine", ".com.apple.timemachine.donotpresent",
                 ".com.apple.timemachine.supported")
_BACKUP_NAME = re.compile(r"time ?machine|backup", re.IGNORECASE)

FORMAT_NAMES = {
    "exfat": "exFAT", "vfat": "FAT32", "msdos": "FAT32", "fat": "FAT32",
    "ntfs": "NTFS", "ntfs3": "NTFS", "fuseblk": "NTFS",
    "apfs": "APFS", "hfs": "Mac OS Extended", "hfsplus": "Mac OS Extended",
    "ext4": "ext4", "ext3": "ext3", "ext2": "ext2", "btrfs": "Btrfs", "xfs": "XFS", "zfs": "ZFS",
}
#: Docker Desktop's file sharing hides the real format behind these
_PASSTHROUGH_FS = {"fakeowner", "virtiofs", "grpcfuse", "fuse.grpcfuse", "osxfs", "9p", "drvfs",
                   "overlay", "fuse", "fuse.osxfs"}


def _now() -> float:
    return time.time()


# ── where the drives are ──────────────────────────────────────────────────────

def drives_roots(platform: Optional[str] = None) -> Tuple[str, ...]:
    """The drives folders to look in, inside the container."""
    env = os.environ.get("SOULSYNC_DRIVES_ROOTS", "").strip()
    if env:
        return tuple(os.path.abspath(p) for p in env.split(os.pathsep) if p.strip())
    if platform in ROOTS_BY_PLATFORM:
        return ROOTS_BY_PLATFORM[platform]
    out: List[str] = []
    for roots in ROOTS_BY_PLATFORM.values():
        out.extend(roots)
    return tuple(out)


def visible_roots(platform: Optional[str] = None) -> List[str]:
    """The drives folders that exist here and hold at least one drive."""
    return [r for r in drives_roots(platform) if _drive_dirs(r)]


# ── the mount table ───────────────────────────────────────────────────────────

def _unescape(field: str) -> str:
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), field)


def mount_table(text: Optional[str] = None) -> List[Dict[str, Any]]:
    """``/proc/mounts`` as dicts (source, point, fstype, options); [] when
    it can't be read (a Mac running the tests, say)."""
    if text is None:
        try:
            with open("/proc/mounts", encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            return []
    rows = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        rows.append({"source": _unescape(parts[0]), "point": _unescape(parts[1]),
                     "fstype": parts[2], "options": parts[3].split(",")})
    return rows


def mount_for(path: str, table: Optional[List[Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    """The mount holding ``path`` (the longest mount point that contains it)."""
    table = mount_table() if table is None else table
    path = os.path.abspath(path)
    best = None
    for row in table:
        point = row["point"].rstrip("/") or "/"
        if path == point or path.startswith(point.rstrip("/") + "/") or point == "/":
            if best is None or len(point) > len(best["point"].rstrip("/") or "/"):
                best = row
    return best


def format_of(path: str, table: Optional[List[Dict[str, Any]]] = None) -> Optional[str]:
    """The filesystem's friendly name when the mount table says it ("exFAT",
    "NTFS", …), else None (Docker Desktop's sharing hides it)."""
    row = mount_for(path, table)
    if not row:
        return None
    fstype = str(row.get("fstype") or "").lower()
    if fstype in _PASSTHROUGH_FS:
        return None
    return FORMAT_NAMES.get(fstype)


def is_read_only(path: str, table: Optional[List[Dict[str, Any]]] = None) -> bool:
    row = mount_for(path, table)
    return bool(row) and "ro" in (row.get("options") or [])


def guess_platform(path: Optional[str] = None, table: Optional[List[Dict[str, Any]]] = None) -> str:
    """Mac, Linux or Windows, guessed from how ``path`` (the library) is
    mounted: Docker Desktop on a Mac shares through fakeowner / virtiofs /
    grpcfuse / osxfs, on Windows through 9p / drvfs or ``/run/desktop/mnt/host``."""
    table = mount_table() if table is None else table
    for root in ROOTS_BY_PLATFORM["mac"]:
        if any(r["point"] == root for r in table):
            return "mac"
    row = mount_for(path or "/app", table) if (path or table) else None
    if row:
        fstype = str(row.get("fstype") or "").lower()
        source = str(row.get("source") or "")
        if "/run/desktop/mnt/host" in source or fstype in ("9p", "drvfs") or re.match(r"^[A-Za-z]:\\", source):
            return "windows"
        if fstype in ("fakeowner", "grpcfuse", "fuse.grpcfuse", "osxfs", "fuse.osxfs") or "/host_mark/" in source:
            return "mac"
        if fstype == "virtiofs":
            return "mac"
    return "linux"


def home_disk_name(platform: str) -> str:
    return HOME_DISK.get(platform, HOME_DISK["linux"])


# ── drives ────────────────────────────────────────────────────────────────────

def _drive_dirs(root: str) -> List[str]:
    """One level of real folders under a drives folder (``/media/<user>/<drive>``
    counts two levels). Links, dot-folders and the Mac's system volumes are
    skipped."""
    out: List[str] = []
    try:
        entries = list(os.scandir(root))
    except OSError:
        return out
    for entry in entries:
        name = entry.name
        if name.startswith(".") or name in _SKIP_NAMES:
            continue
        try:
            if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                continue
        except OSError:
            continue
        if os.path.basename(root.rstrip("/")) == "media":
            # /media/<user>/<drive> on most desktops
            inner = _drive_dirs(entry.path)
            if inner:
                out.extend(inner)
                continue
        out.append(entry.path)
    return sorted(out)


def usage(path: str) -> Optional[Dict[str, int]]:
    """Total and free bytes of the drive holding ``path`` (its nearest
    existing parent), or None."""
    probe = os.path.abspath(path or "")
    while probe and not os.path.exists(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            return None
        probe = parent
    try:
        du = shutil.disk_usage(probe)
    except OSError:
        return None
    return {"total": int(du.total), "free": int(du.free), "used": int(du.used)}


def is_backup_drive(path: str) -> bool:
    if _BACKUP_NAME.search(os.path.basename(path.rstrip("/"))):
        return True
    return any(os.path.lexists(os.path.join(path, mark)) for mark in _BACKUP_MARKS)


def list_drives(platform: Optional[str] = None, *, home: Optional[str] = None,
                table: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    """Every drive under the drives folders: name, path, size, free space,
    format (when known), whether it's a backup drive (shown, not offered) and
    whether it's read-only. The computer's own disk shows up in ``/Volumes``
    as a link (skipped). ``home`` is kept for the callers; Docker Desktop
    reports every shared drive on one device, so it can't tell drives apart."""
    table = mount_table() if table is None else table
    out = []
    seen = set()
    for root in drives_roots(platform):
        for path in _drive_dirs(root):
            real = os.path.realpath(path)
            if real in seen:
                continue
            seen.add(real)
            space = usage(path) or {}
            backup = is_backup_drive(path)
            out.append({
                "name": os.path.basename(path.rstrip("/")),
                "path": path,
                "total": space.get("total"),
                "free": space.get("free"),
                "format": format_of(path, table),
                "backup": backup,
                "read_only": is_read_only(path, table),
                "offered": not backup,
            })
    return out


def drive_root_of(path: str, platform: Optional[str] = None) -> Optional[str]:
    """The drive folder (``/Volumes/Music HD``) holding ``path``, or None
    when it isn't under a drives folder."""
    path = os.path.abspath(path or "")
    for root in drives_roots(platform):
        root = root.rstrip("/")
        if path.startswith(root + "/"):
            rest = path[len(root) + 1:].split("/")
            if os.path.basename(root) == "media" and len(rest) >= 2 and not os.path.ismount(os.path.join(root, rest[0])):
                candidate = os.path.join(root, rest[0], rest[1])
                if os.path.isdir(candidate):
                    return candidate
            return os.path.join(root, rest[0])
    return None


def drive_label(path: str, platform: str = "linux") -> str:
    """What a person calls the drive ``path`` is on: "Music HD" under a
    drives folder, else the computer's own disk ("Macintosh HD")."""
    root = drive_root_of(path, None)
    if root:
        name = os.path.basename(root.rstrip("/"))
        if platform == "windows" and len(name) == 1:
            return f"{name.upper()}:"
        return name
    return home_disk_name(platform)


# ── folder sizes ──────────────────────────────────────────────────────────────

def walk_files(root: str, *, skip: Iterable[str] = ()) -> Iterable[Tuple[str, os.stat_result]]:
    """Every regular file under ``root`` as (relative path, lstat), never
    following a link (links are skipped, so nothing leads out of the tree).
    ``skip`` holds names (files or folders) left out wherever they are."""
    skip = set(skip)
    stack = [""]
    while stack:
        rel_dir = stack.pop()
        current = os.path.join(root, rel_dir) if rel_dir else root
        try:
            entries = sorted(os.scandir(current), key=lambda e: e.name)
        except OSError:
            continue
        for entry in entries:
            if entry.name in skip:
                continue
            rel = os.path.join(rel_dir, entry.name) if rel_dir else entry.name
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if _stat.S_ISLNK(st.st_mode):
                continue
            if _stat.S_ISDIR(st.st_mode):
                stack.append(rel)
            elif _stat.S_ISREG(st.st_mode):
                yield rel, st


def count_folder(root: str, *, skip: Iterable[str] = ()) -> Dict[str, int]:
    files = size = 0
    for _rel, st in walk_files(root, skip=skip):
        files += 1
        size += int(st.st_size)
    return {"files": files, "bytes": size}


class SizeCache:
    """Folder sizes measured in the background, kept ``ttl`` seconds. ``get``
    answers at once: the last measure (maybe stale) or None while the first
    is running."""

    def __init__(self, ttl: float = 600.0, skip: Iterable[str] = ()) -> None:
        self.ttl = float(ttl)
        self.skip = tuple(skip)
        self._lock = threading.Lock()
        self._values: Dict[str, Tuple[float, Dict[str, int]]] = {}
        self._running: set = set()

    def get(self, path: str, *, wait: bool = False) -> Optional[Dict[str, int]]:
        path = os.path.abspath(path)
        with self._lock:
            hit = self._values.get(path)
            fresh = hit is not None and _now() - hit[0] < self.ttl
            if not fresh and path not in self._running:
                self._running.add(path)
                start = True
            else:
                start = False
        if start:
            if wait:
                self._measure(path)
            else:
                threading.Thread(target=self._measure, args=(path,), name="folder-size", daemon=True).start()
        with self._lock:
            hit = self._values.get(path)
        return dict(hit[1]) if hit else None

    def forget(self, path: Optional[str] = None) -> None:
        with self._lock:
            if path is None:
                self._values.clear()
            else:
                self._values.pop(os.path.abspath(path), None)

    def _measure(self, path: str) -> None:
        try:
            value = count_folder(path, skip=self.skip) if os.path.isdir(path) else {"files": 0, "bytes": 0}
            with self._lock:
                self._values[path] = (_now(), value)
        except Exception as exc:  # noqa: BLE001 - a size is a nicety
            logger.debug("couldn't measure %s: %s", path, exc)
        finally:
            with self._lock:
                self._running.discard(path)


__all__ = ["FORMAT_NAMES", "HOME_DISK", "MOUNT_LINES", "PLATFORMS", "ROOTS_BY_PLATFORM", "SizeCache",
           "count_folder", "drive_label", "drive_root_of", "drives_roots", "format_of", "guess_platform",
           "home_disk_name", "is_backup_drive", "is_read_only", "list_drives", "mount_for", "mount_table",
           "usage", "visible_roots", "walk_files"]
