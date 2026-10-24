"""The computer's own names for SYNCHRO.S's folders (Design's 125, Dev's 160).

Inside Docker, SYNCHRO.S sees its music folders at container paths
(``/app/Transfer``), which mean nothing in Finder. The drives helper runs on
the computer itself, reads each mount's two sides from the set-up file
(``./music:/app/Transfer``) and writes a small **host hint** beside the
folder's marker::

    <folder>/.synchros-host.json
    {"v": 1, "host_path": "/Users/ross/SoulSync/music", "volume": "Macintosh HD",
     "os": "mac", "marker_id": "<the folder's marker id>", "written_at": 1761300000}

The hint is **display text only**. It is untrusted data written from outside
the container, so:

* it is read without following a link, from a regular file of at most
  ``HINT_MAX_BYTES``, and must match the schema exactly (``read_hint``);
* it is trusted only while ``marker_id`` equals the id of the marker at the
  same folder (``markers.marker_id``): a folder SYNCHRO.S marked afresh, or a
  hint copied from elsewhere, is ignored;
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

from core.drives import disks, markers
from utils.logging_config import get_logger

logger = get_logger("drives.host_paths")

HINT_NAME = ".synchros-host.json"
HINT_VERSION = 1
#: a hint is under 300 bytes; anything bigger isn't one the helper wrote
HINT_MAX_BYTES = 4096
HINT_KEYS = frozenset({"v", "host_path", "volume", "os", "marker_id", "written_at"})
HINT_OS = ("mac", "linux")
#: how long a folder's hint is remembered before it's read again
CACHE_SECONDS = 5.0

_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]")
_MAX_PATH = 1024
_MAX_VOLUME = 255


# ── the hint ──────────────────────────────────────────────────────────────────

def _clean_host_path(value: Any) -> Optional[str]:
    """A plain absolute POSIX path, normalised, or None."""
    if not isinstance(value, str) or not value or len(value) > _MAX_PATH or _CONTROL.search(value):
        return None
    if not value.startswith("/") or value.startswith("//"):
        return None
    parts = value.split("/")
    if any(p in (".", "..") for p in parts):
        return None
    clean = "/" + "/".join(p for p in parts if p)
    return clean


def _clean_volume(value: Any) -> Optional[str]:
    if not isinstance(value, str) or _CONTROL.search(value):
        return None
    text = value.strip()
    if not text or len(text) > _MAX_VOLUME or "/" in text:
        return None
    return text


def parse_hint(raw: bytes) -> Optional[Dict[str, Any]]:
    """The hint's fields when ``raw`` is exactly the schema, else None."""
    if not isinstance(raw, (bytes, bytearray)) or len(raw) > HINT_MAX_BYTES:
        return None
    try:
        data = json.loads(bytes(raw).decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None
    if not isinstance(data, dict) or set(data) != HINT_KEYS:
        return None
    if type(data["v"]) is not int or data["v"] != HINT_VERSION:
        return None
    host_path = _clean_host_path(data["host_path"])
    volume = _clean_volume(data["volume"])
    marker_id = data["marker_id"]
    written_at = data["written_at"]
    if host_path is None or volume is None or data["os"] not in HINT_OS:
        return None
    if not isinstance(marker_id, str) or not markers.MARKER_ID.match(marker_id):
        return None
    if type(written_at) is not int or written_at <= 0:
        return None
    return {"host_path": host_path, "volume": volume, "os": data["os"], "marker_id": marker_id,
            "written_at": written_at}


def _read_small(path: str) -> Tuple[Optional[bytes], Optional[Tuple[int, int, int]]]:
    """A regular file's bytes (at most ``HINT_MAX_BYTES``) and its identity,
    read without following a link; (None, None) otherwise."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None, None
    try:
        st = os.fstat(fd)
        if not _stat.S_ISREG(st.st_mode) or st.st_size > HINT_MAX_BYTES:
            return None, None
        chunks = []
        left = HINT_MAX_BYTES + 1
        while left > 0:
            chunk = os.read(fd, left)
            if not chunk:
                break
            chunks.append(chunk)
            left -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > HINT_MAX_BYTES:
            return None, None
        return raw, (st.st_ino, st.st_size, st.st_mtime_ns)
    except OSError:
        return None, None
    finally:
        os.close(fd)


def read_hint(folder: str) -> Optional[Dict[str, Any]]:
    """The helper's hint at ``folder`` when it's well formed **and** its
    ``marker_id`` matches the folder's marker; else None. Reads two small
    files and nothing else."""
    if not isinstance(folder, str) or not folder.startswith("/"):
        return None
    raw, _ident = _read_small(os.path.join(folder, HINT_NAME))
    if raw is None:
        return None
    hint = parse_hint(raw)
    if hint is None:
        logger.debug("ignored a malformed host hint in %s", folder)
        return None
    current = markers.marker_id(folder)
    if current is None or current != hint["marker_id"]:
        logger.debug("ignored a host hint in %s: it was written for another marker", folder)
        return None
    return hint


class _Cache:
    """Each folder's trusted hint for a few seconds, so a status poll or a
    long export reads the two files once, not once per track."""

    def __init__(self, ttl: float = CACHE_SECONDS, clock: Callable[[], float] = time.monotonic) -> None:
        self.ttl = ttl
        self._clock = clock
        self._lock = threading.Lock()
        self._hits: Dict[str, Tuple[float, Optional[Dict[str, Any]]]] = {}

    def get(self, folder: str) -> Optional[Dict[str, Any]]:
        now = self._clock()
        with self._lock:
            hit = self._hits.get(folder)
            if hit and now - hit[0] < self.ttl:
                return hit[1]
        value = read_hint(folder)
        with self._lock:
            if len(self._hits) > 256:
                self._hits.clear()
            self._hits[folder] = (now, value)
        return value

    def forget(self) -> None:
        with self._lock:
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
    hint = CACHE.get(os.path.normpath(folder))
    if hint is not None:
        return {"host_path": hint["host_path"], "volume": hint["volume"], "source": "hint"}
    return _same_path(folder, platform)


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
    found = _same_path(container_path, current_platform())
    return found["host_path"] if found else None


__all__ = ["HINT_KEYS", "HINT_MAX_BYTES", "HINT_NAME", "HINT_VERSION", "folder_host", "forget", "parse_hint",
           "public_fields", "read_hint", "to_host"]
