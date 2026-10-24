"""The computer's own names for SYNCHRO.S's folders (Design's 125, Dev's 160).

Inside Docker, SYNCHRO.S sees its music folders at container paths
(``/app/Transfer``), which mean nothing in Finder. The drives helper runs on
the computer itself, reads each mount's two sides from the set-up file
(``./music:/app/Transfer``) and writes **one hints file into SYNCHRO.S's own
settings folder** (``./config``, mounted at ``/app/config``), keyed by each
music folder's marker id::

    /app/config/host-paths.json
    {"v": 1, "folders": {"<marker id>": {"host_path": "/Users/ross/SoulSync/music",
                                          "volume": "Macintosh HD", "os": "mac",
                                          "target": "/app/Transfer",
                                          "written_at": 1761300000}}}

Nothing is written into the music folders: slskd shares the library's root,
and the computer's paths (the Mac's user folder) must not be shared with
Soulseek. An older build's ``.synchros-host.json`` inside a music folder
(``LEGACY_HINT_NAME``) is never read; the helper deletes it.

The file is **display text only**. It is untrusted data written from outside
the container, so:

* it is read without following a link, from a regular file of at most
  ``HINTS_MAX_BYTES``, and must match the schema exactly (``parse_hints``);
* a folder's entry is trusted only while its key equals the id of the marker
  at that folder (``markers.marker_id``) **and** the folder is exactly the
  one the helper named inside SYNCHRO.S (``target``): a folder SYNCHRO.S marked
  afresh, a copy of a folder that kept its marker (Finder, rsync, Time
  Machine), or a mount the compose file has since moved names nothing;
* each entry passes the same check the helper applies when it writes
  (``compose_tool.clean_entry``);
* nothing here, and nothing that calls it, uses a host path to open, list,
  write or delete a file. The routes and the page escape it like any text.

Folders under the drives folder the Docker step mounts at the same path
inside (``/Volumes`` on a Mac, ``/mnt`` and ``/media`` on Linux) need no hint:
their container path *is* the computer's path. On Windows, ``/drives/d/...``
is ``D:\\...``. That rule applies only with the platform's own drives folders
(not with ``SOULSYNC_DRIVES_ROOTS``, which tests and unusual set-ups use).

**For other features** (Export to Traktor, phase D2a): :func:`to_host` maps a
library file's container path to the computer's path, or None when SYNCHRO.S
doesn't know it. Its name and signature are stable.
"""

from __future__ import annotations

import json
import os
import re
import stat as _stat
import threading
import time
from typing import Any, Callable, Dict, Optional, Tuple

from core.drives import compose_tool, disks, markers
from utils.logging_config import get_logger

logger = get_logger("drives.host_paths")

HINTS_NAME = "host-paths.json"
#: overrides where the hints file is read (tests, unusual set-ups)
HINTS_FILE_ENV = "SOULSYNC_HOST_PATHS_FILE"
#: what an older build wrote inside each music folder: never read, the helper deletes it
LEGACY_HINT_NAME = ".synchros-host.json"
HINT_VERSION = 1
HINTS_MAX_FOLDERS = 64
#: 64 entries of at most ~1.4 KB each
HINTS_MAX_BYTES = 96 * 1024
HINTS_KEYS = frozenset({"v", "folders"})
ENTRY_KEYS = frozenset(compose_tool.ENTRY_KEYS)
HINT_OS = compose_tool.ENTRY_OS
#: where the helper writes the file, inside the container (the settings folder's mount)
HELPER_CONFIG_DIR = compose_tool.CONFIG_TARGET
#: how long the file and each folder's answer are remembered before reading again
CACHE_SECONDS = 5.0



# ── the hints file ────────────────────────────────────────────────────────────

def parse_entry(data: Any) -> Optional[Dict[str, Any]]:
    """One folder's entry when it is exactly the schema (the helper's own
    check, ``compose_tool.clean_entry``), else None."""
    return compose_tool.clean_entry(data)


def parse_hints(raw: bytes) -> Optional[Dict[str, Dict[str, Any]]]:
    """``{marker_id: entry}`` when ``raw`` is exactly the schema, else None
    (one bad entry refuses the whole file)."""
    if not isinstance(raw, (bytes, bytearray)) or len(raw) > HINTS_MAX_BYTES:
        return None
    try:
        data = json.loads(bytes(raw).decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None
    if not isinstance(data, dict) or set(data) != HINTS_KEYS:
        return None
    if type(data["v"]) is not int or data["v"] != HINT_VERSION:
        return None
    folders = data["folders"]
    if not isinstance(folders, dict) or len(folders) > HINTS_MAX_FOLDERS:
        return None
    out = {}
    for key, value in folders.items():
        entry = parse_entry(value)
        if not isinstance(key, str) or not markers.MARKER_ID.match(key) or entry is None:
            return None
        out[key] = entry
    return out


def _read_small(path: str, cap: int) -> Optional[bytes]:
    """A regular file's bytes (at most ``cap``), read without following a
    link; None otherwise."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not _stat.S_ISREG(st.st_mode) or st.st_size > cap:
            return None
        chunks = []
        left = cap + 1
        while left > 0:
            chunk = os.read(fd, left)
            if not chunk:
                break
            chunks.append(chunk)
            left -= len(chunk)
        raw = b"".join(chunks)
        return None if len(raw) > cap else raw
    except OSError:
        return None
    finally:
        os.close(fd)


_GAP_SAID = False


def hints_file() -> str:
    """Where the helper's hints live: SYNCHRO.S's own settings folder. When
    that isn't the folder the helper writes to (``SOULSYNC_CONFIG_PATH``
    points elsewhere while /app/config is mounted), it says so in the log
    once rather than showing container paths without a word."""
    global _GAP_SAID
    env = os.environ.get(HINTS_FILE_ENV, "").strip()
    if env:
        return env
    try:
        from core.settings import config_manager
        folder = str(config_manager.config_path.parent)
    except Exception:  # noqa: BLE001
        folder = HELPER_CONFIG_DIR
    if not _GAP_SAID and os.path.normpath(folder) != HELPER_CONFIG_DIR and os.path.isdir(HELPER_CONFIG_DIR):
        _GAP_SAID = True
        logger.warning("[Drives] The drives helper writes your computer's folder names to %s/%s, but SYNCHRO.S's "
                       "settings are in %s (SOULSYNC_CONFIG_PATH), so the names aren't read. Set %s to %s/%s to "
                       "read them.", HELPER_CONFIG_DIR, HINTS_NAME, folder, HINTS_FILE_ENV, HELPER_CONFIG_DIR,
                       HINTS_NAME)
    return os.path.join(folder, HINTS_NAME)


_UNREADABLE_SAID = False


def _say_unreadable(path: str) -> None:
    """Once: the file is there but SYNCHRO.S can't open it (written by
    another user, 0600), rather than showing container paths without a word."""
    global _UNREADABLE_SAID
    if _UNREADABLE_SAID:
        return
    try:
        st = os.lstat(path)
    except OSError:
        return
    if _stat.S_ISREG(st.st_mode) and not os.access(path, os.R_OK):
        _UNREADABLE_SAID = True
        logger.warning("[Drives] SYNCHRO.S can't read %s (owned by user %s, mode %o), so it shows container "
                       "paths. Run the drives helper again with --names as the user SYNCHRO.S runs as, or let "
                       "that user read the file.", path, st.st_uid, st.st_mode & 0o777)


def read_hints(path: Optional[str] = None) -> Dict[str, Dict[str, Any]]:
    """Every well-formed entry in the hints file, by marker id; {} when the
    file is missing, a link, too big or not exactly the schema."""
    path = path or hints_file()
    raw = _read_small(path, HINTS_MAX_BYTES)
    if raw is None:
        _say_unreadable(path)
        return {}
    parsed = parse_hints(raw)
    if parsed is None:
        logger.debug("ignored a malformed host hints file at %s", path)
        return {}
    return parsed


def _same_folder(path: str, target: str) -> bool:
    """The helper writes the exact folder as the target, so only that folder
    counts (a copy inside the same mount doesn't)."""
    return os.path.normpath(path) == os.path.normpath(target)


def read_hint(folder: str, hints: Optional[Dict[str, Dict[str, Any]]] = None) -> Optional[Dict[str, Any]]:
    """The entry for ``folder``: the one keyed by the id of the marker at
    ``folder`` right now, and only while ``folder`` is exactly the folder it
    was written for (its ``target``); None otherwise (no marker, no id, no entry, a
    copy elsewhere that kept the marker, a mount since moved)."""
    if not isinstance(folder, str) or not folder.startswith("/"):
        return None
    current = markers.marker_id(folder)
    if current is None:
        return None
    entry = (read_hints() if hints is None else hints).get(current)
    if not entry or not _same_folder(folder, entry["target"]):
        return None
    return {**entry, "marker_id": current}


class _Cache:
    """The file and each folder's answer for a few seconds, so a status poll
    or a long export reads them once, not once per track."""

    def __init__(self, ttl: float = CACHE_SECONDS, clock: Callable[[], float] = time.monotonic) -> None:
        self.ttl = ttl
        self._clock = clock
        self._lock = threading.Lock()
        self._file: Optional[Tuple[float, Dict[str, Dict[str, Any]]]] = None
        self._hits: Dict[str, Tuple[float, Optional[Dict[str, Any]]]] = {}

    def get(self, folder: str) -> Optional[Dict[str, Any]]:
        now = self._clock()
        with self._lock:
            hit = self._hits.get(folder)
            if hit and now - hit[0] < self.ttl:
                return hit[1]
            cached = self._file if self._file and now - self._file[0] < self.ttl else None
        hints = cached[1] if cached else read_hints()
        value = read_hint(folder, hints)
        with self._lock:
            if cached is None:
                self._file = (now, hints)
            if len(self._hits) > 256:
                self._hits.clear()
            self._hits[folder] = (now, value)
        return value

    def forget(self) -> None:
        with self._lock:
            self._file = None
            self._hits.clear()


CACHE = _Cache()


def forget() -> None:
    """Read every hint again next time (``--names`` ran, a move switched)."""
    CACHE.forget()


# ── the same path inside and out ──────────────────────────────────────────────

def _same_path(path: str, platform: str) -> Optional[Dict[str, Any]]:
    """For a path under the platform's own drives folder: the computer's
    path and the drive's name. None elsewhere, or when the drives folders are
    overridden (then nothing says they're mounted at the same path)."""
    if os.environ.get("SOULSYNC_DRIVES_ROOTS", "").strip():
        return None
    roots = disks.ROOTS_BY_PLATFORM.get(platform) or ()
    norm = os.path.normpath(path)
    for root in roots:
        if not norm.startswith(root.rstrip("/") + "/"):
            continue
        rest = norm[len(root.rstrip("/")) + 1:]
        if not rest:
            return None
        if platform == "windows":
            letter, _, tail = rest.partition("/")
            if len(letter) != 1 or not letter.isalpha():
                return None
            host = f"{letter.upper()}:\\" + tail.replace("/", "\\")
            return {"host_path": host, "volume": f"{letter.upper()}:", "source": "same"}
        return {"host_path": norm, "volume": disks.drive_label(norm, platform), "source": "same"}
    return None


# ── what the routes and other features ask ────────────────────────────────────

def _rel_under(path: str, root: str) -> Optional[str]:
    """``path`` relative to ``root`` ("" for the root itself), compared as
    text after normalising (never by touching the disk), or None."""
    root = os.path.normpath(root)
    norm = os.path.normpath(path)
    if norm == root:
        return ""
    if norm.startswith(root.rstrip("/") + "/"):
        return norm[len(root.rstrip("/")) + 1:]
    return None


def folder_host(folder: Optional[str], platform: str) -> Optional[Dict[str, Any]]:
    """``{"host_path", "volume", "source"}`` for one folder SYNCHRO.S uses (or
    used: a move's old folders), or None when SYNCHRO.S doesn't know its
    name on the computer. ``source`` is ``hint`` or ``same``."""
    if not isinstance(folder, str) or not folder.startswith("/") or "\x00" in folder:
        return None
    # the drives folder is the computer's own path: no file needed, nothing to go stale
    same = _same_path(folder, platform)
    if same is not None:
        return same
    hint = CACHE.get(os.path.normpath(folder))
    if hint is not None:
        return {"host_path": hint["host_path"], "volume": hint["volume"], "source": "hint"}
    return None


def public_fields(folder: Optional[str], platform: str) -> Dict[str, Any]:
    """The fields a route adds for an admin: ``host_path``, ``volume`` and
    ``host_source`` (all None when unknown)."""
    try:
        found = folder_host(folder, platform)
    except Exception as exc:  # noqa: BLE001 - a display nicety never breaks a route
        logger.debug("host path for %s: %s", folder, exc)
        found = None
    if not found:
        return {"host_path": None, "volume": None, "host_source": None}
    return {"host_path": found["host_path"], "volume": found["volume"], "host_source": found["source"]}


def _join_host(host_root: str, rel: str) -> str:
    if not rel:
        return host_root
    if re.match(r"^[A-Z]:\\", host_root):
        return host_root.rstrip("\\") + "\\" + rel.replace("/", "\\")
    return host_root.rstrip("/") + "/" + rel


def current_platform(config=None) -> str:
    """The platform the drives pages use: the saved choice, else a guess."""
    try:
        config = config or markers._default_config()
        saved = config.get("drives.platform", "") or ""
        if saved in disks.PLATFORMS:
            return saved
        return disks.guess_platform(markers.folder_paths(config)["library"])
    except Exception:  # noqa: BLE001
        return "linux"


def to_host(container_path: str) -> str | None:
    """The computer's path for a file or folder SYNCHRO.S sees at
    ``container_path``, or None when it isn't known.

    Stable for other features (Export to Traktor writes these into
    collection.nml). Display and export text only: never open, list, write or
    delete anything by the path this returns. Under the library, downloads or
    staging folder it uses that folder's trusted host hint; under the drives
    folder the Docker step mounts at the same path, the path itself (``D:\\``
    on Windows). A relative path, one with ``..`` or a NUL, or one outside
    every known folder is None.
    """
    if not isinstance(container_path, str) or not container_path.startswith("/") or "\x00" in container_path \
            or ".." in container_path.split("/") or len(container_path) > 4096:
        return None
    # the drives folder is the computer's own path: preferred, nothing to go stale
    found = _same_path(container_path, current_platform())
    if found is not None:
        return found["host_path"]
    try:
        roots = markers.folder_paths()
    except Exception as exc:  # noqa: BLE001
        logger.debug("to_host: folder settings unreadable: %s", exc)
        roots = {}
    best: Optional[Tuple[str, str]] = None
    for root in roots.values():
        if not root:
            continue
        rel = _rel_under(container_path, root)
        if rel is not None and (best is None or len(root) > len(best[0])):
            best = (root, rel)
    if best is not None:
        hint = CACHE.get(os.path.normpath(best[0]))
        if hint is not None:
            return _join_host(hint["host_path"], best[1])
    return None


__all__ = ["HINTS_FILE_ENV", "HINTS_MAX_BYTES", "HINTS_NAME", "HINT_VERSION", "LEGACY_HINT_NAME", "folder_host",
           "forget", "hints_file", "parse_hints", "public_fields", "read_hint", "read_hints", "to_host"]
