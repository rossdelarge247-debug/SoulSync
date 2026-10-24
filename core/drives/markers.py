"""A drive that's away is never an empty library (boards 14k, 14t).

SYNCHRO.S writes a small marker file at the root of each folder it manages
(the library, downloads and staging). When a folder is missing, unreadable,
or empty without its marker while SYNCHRO.S expects something there, the
folder's drive "isn't connected": the library pages say so instead of an
empty grid, and the jobs that would mark files missing or clean them up skip
the run (:func:`library_away`).

The rules for one folder, in order:

1. missing, not a folder, or unreadable: away;
2. the marker is there: connected;
3. anything else is in it: connected (the marker is written now, which is how
   every install that predates this gets one);
4. empty, and SYNCHRO.S wrote a marker at this path before: away (an empty
   mount point is what Docker leaves when a drive isn't plugged in);
5. empty, and the library has tracks stored under it: away;
6. otherwise (a fresh install): connected, and the marker is written.

A watch thread looks every ``CHECK_SECONDS`` and keeps "last seen" (stored, so
it survives a restart). Everything that reads state reads the watch's last
answer; ``check_now`` looks again.
"""

from __future__ import annotations

import json
import os
import re
import stat as _stat
import tempfile
import threading
import time
import uuid
from contextlib import closing
from typing import Any, Callable, Dict, List, Optional

from utils.logging_config import get_logger

logger = get_logger("drives.markers")

MARKER_NAME = ".synchros-folder.json"
ROLES = ("library", "downloads", "staging")
SETTING_KEYS = {"library": "soulseek.transfer_path", "downloads": "soulseek.download_path",
                "staging": "import.staging_path"}
DEFAULTS = {"library": "./Transfer", "downloads": "./downloads", "staging": "./Staging"}
LABELS = {"library": "Library", "downloads": "Downloads", "staging": "Staging"}
CHECK_SECONDS = 30
#: "last seen" is written to the database at most this often while connected
PERSIST_SECONDS = 600
#: how long "does the library hold tracks under this folder" is remembered
EXPECT_TTL_SECONDS = 600

_TABLE = """
CREATE TABLE IF NOT EXISTS drive_markers (
    role TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    written_at INTEGER,
    last_seen INTEGER
)
"""


def _now() -> int:
    return int(time.time())


def ensure_table(conn) -> None:
    conn.execute(_TABLE)


def _default_config():
    from core.settings import config_manager
    return config_manager


def _default_database():
    from database.music_database import get_database
    return get_database()


def resolve(value: Any, default: str) -> str:
    from core.imports.paths import config_root_path
    return config_root_path(value, default)


def folder_paths(config=None) -> Dict[str, str]:
    """The three managed folders, resolved the way the rest of the app does."""
    config = config or _default_config()
    return {role: resolve(config.get(SETTING_KEYS[role], DEFAULTS[role]), DEFAULTS[role]) for role in ROLES}


#: a marker's id: 32 lowercase hex characters (a uuid4)
MARKER_ID = re.compile(r"^[0-9a-f]{32}$")
#: a marker is a few dozen bytes; anything bigger isn't one SYNCHRO.S wrote
MARKER_MAX_BYTES = 4096


def marker_body(role: str, *, marker_id: Optional[str] = None, created: Optional[int] = None) -> Dict[str, Any]:
    # kept small: slskd may share the library's root, so nothing private goes in.
    # ``id`` names this folder for the drives helper's host hint
    # (core/drives/host_paths.py), which is trusted only while it matches.
    return {"app": "SYNCHRO.S", "role": role, "about": "Keeps this folder recognisable when its drive is away.",
            "created": int(created) if created else _now(), "id": marker_id or uuid.uuid4().hex}


def read_marker(path: str) -> Optional[Dict[str, Any]]:
    """The marker at the root of ``path`` as a dict, or None (missing, a link,
    not a regular file, too big, or not a JSON object). Never follows a link."""
    target = os.path.join(path, MARKER_NAME)
    try:
        fd = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not _stat.S_ISREG(st.st_mode) or st.st_size > MARKER_MAX_BYTES:
            return None
        with os.fdopen(fd, "rb", closefd=False) as f:
            raw = f.read(MARKER_MAX_BYTES + 1)
    except OSError:
        return None
    finally:
        os.close(fd)
    if len(raw) > MARKER_MAX_BYTES:
        return None
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def marker_id(path: str) -> Optional[str]:
    """The id of the marker at ``path``, or None when there's no marker or it
    has no valid id (a marker written before ids existed)."""
    data = read_marker(path)
    value = (data or {}).get("id")
    return value if isinstance(value, str) and MARKER_ID.match(value) else None


def write_marker(path: str, role: str, *, keep_id: bool = True) -> bool:
    """Write the marker at ``path`` (atomically). False when it can't. A
    marker already there for the same role keeps its id and creation time, so
    the drives helper's host hint stays valid when SYNCHRO.S writes it again
    (a switch back, say); ``keep_id=False`` gives it a fresh id (a move's
    forward switch, so a folder copied with its marker isn't taken for the
    one it was copied from)."""
    target = os.path.join(path, MARKER_NAME)
    tmp = None
    try:
        if os.path.islink(target):
            return False
        before = read_marker(path) or {}
        kept_id = before.get("id") if keep_id and before.get("role") == role and isinstance(before.get("id"), str) \
            and MARKER_ID.match(before["id"]) else None
        kept_created = before.get("created") if before.get("role") == role \
            and isinstance(before.get("created"), int) else None
        # a new, uniquely named file (never through a link), then renamed over
        fd, tmp = tempfile.mkstemp(dir=path, prefix=MARKER_NAME + ".", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(marker_body(role, marker_id=kept_id, created=kept_created), f)
        os.chmod(tmp, 0o644)
        os.replace(tmp, target)
        return True
    except OSError as exc:
        logger.debug("couldn't write the marker in %s: %s", path, exc)
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        return False


def has_marker(path: str) -> bool:
    target = os.path.join(path, MARKER_NAME)
    try:
        return os.path.isfile(target) and not os.path.islink(target)
    except OSError:
        return False


def probe(path: str, *, wrote_here_before: bool, expects_content: bool) -> Dict[str, Any]:
    """One folder's state: ``{"connected": bool, "reason": str, "write": bool}``.
    ``write`` says the marker should be written now."""
    try:
        if not path or not os.path.isdir(path):
            return {"connected": False, "reason": "missing", "write": False}
    except OSError:
        return {"connected": False, "reason": "missing", "write": False}
    if has_marker(path):
        # a marker from before ids existed is written again, with one
        return {"connected": True, "reason": "marker", "write": marker_id(path) is None}
    try:
        with os.scandir(path) as entries:
            nonempty = any(True for _ in entries)
    except OSError:
        return {"connected": False, "reason": "unreadable", "write": False}
    if nonempty:
        return {"connected": True, "reason": "content", "write": True}
    if wrote_here_before:
        return {"connected": False, "reason": "empty", "write": False}
    if expects_content:
        return {"connected": False, "reason": "empty", "write": False}
    return {"connected": True, "reason": "fresh", "write": True}


def library_rows_under(database, root: str) -> bool:
    """Whether the library stores any track under ``root``."""
    if not root:
        return False
    prefix = root.rstrip("/") + "/"
    try:
        with closing(database._get_connection()) as conn:
            row = conn.execute("SELECT 1 FROM tracks WHERE substr(file_path, 1, ?) = ? LIMIT 1",
                               (len(prefix), prefix)).fetchone()
    except Exception as exc:  # noqa: BLE001 - unknown: don't call an empty folder away
        logger.debug("couldn't read the library's paths: %s", exc)
        return False
    return row is not None


class DriveWatch:
    """The watch: looks at the three folders every ``interval`` seconds."""

    def __init__(self, *, config_getter: Callable = _default_config, database_getter: Callable = _default_database,
                 interval: int = CHECK_SECONDS, clock: Callable[[], int] = _now,
                 drive_label: Optional[Callable[[str], str]] = None) -> None:
        self._config = config_getter
        self._database = database_getter
        self.interval = int(interval)
        self._clock = clock
        self._label = drive_label
        self._lock = threading.Lock()
        self._state: Optional[Dict[str, Any]] = None
        self._expect: Dict[str, tuple] = {}
        self._persisted: Dict[str, int] = {}
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._listeners: List[Callable[[Dict[str, Any]], None]] = []

    # -- life --

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="drive-watch", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def on_change(self, fn: Callable[[Dict[str, Any]], None]) -> None:
        self._listeners.append(fn)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.check_now()
            except Exception as exc:  # noqa: BLE001 - the watch never dies
                logger.warning("drive watch: %s", exc)
            if self._stop.wait(self.interval):
                break

    # -- the stored part --

    def _rows(self) -> Dict[str, Dict[str, Any]]:
        try:
            with closing(self._database()._get_connection()) as conn:
                ensure_table(conn)
                return {r["role"]: dict(r) for r in conn.execute("SELECT * FROM drive_markers").fetchall()}
        except Exception as exc:  # noqa: BLE001
            logger.debug("drive markers unreadable: %s", exc)
            return {}

    def _store(self, role: str, path: str, *, written: Optional[int] = None, seen: Optional[int] = None) -> None:
        try:
            with closing(self._database()._get_connection()) as conn:
                ensure_table(conn)
                row = conn.execute("SELECT path, written_at, last_seen FROM drive_markers WHERE role = ?",
                                   (role,)).fetchone()
                if row is None or row["path"] != path:
                    conn.execute("INSERT OR REPLACE INTO drive_markers (role, path, written_at, last_seen) "
                                 "VALUES (?, ?, ?, ?)", (role, path, written, seen))
                else:
                    conn.execute("UPDATE drive_markers SET written_at = COALESCE(?, written_at), "
                                 "last_seen = COALESCE(?, last_seen) WHERE role = ?", (written, seen, role))
                conn.commit()
        except Exception as exc:  # noqa: BLE001
            logger.debug("couldn't store the drive marker row: %s", exc)

    def _expects_content(self, role: str, path: str) -> bool:
        if role != "library":
            return False
        hit = self._expect.get(path)
        t = self._clock()
        if hit and t - hit[0] < EXPECT_TTL_SECONDS:
            return hit[1]
        value = library_rows_under(self._database(), path)
        self._expect[path] = (t, value)
        return value

    def forget_expectations(self) -> None:
        self._expect.clear()

    # -- looking --

    def check_now(self) -> Dict[str, Any]:
        config = self._config()
        paths = folder_paths(config)
        rows = self._rows()
        t = self._clock()
        folders: Dict[str, Dict[str, Any]] = {}
        for role, path in paths.items():
            row = rows.get(role) or {}
            same = row.get("path") == path
            wrote_before = same and bool(row.get("written_at"))
            result = probe(path, wrote_here_before=wrote_before, expects_content=self._expects_content(role, path))
            written = None
            if result["write"] and write_marker(path, role):
                written = t
                wrote_before = True
            last_seen = row.get("last_seen") if same else None
            if result["connected"]:
                last_seen = t
                if written or not same or t - self._persisted.get(role, 0) >= PERSIST_SECONDS:
                    self._store(role, path, written=written, seen=t)
                    self._persisted[role] = t
            elif not same:
                self._store(role, path, written=None, seen=None)
            folders[role] = {
                "role": role,
                "label": LABELS[role],
                "path": path,
                "connected": bool(result["connected"]),
                "reason": result["reason"],
                "last_seen": int(last_seen) if last_seen else None,
                "drive": self._label(path) if self._label else None,
            }
        state = {"checked_at": t, "interval": self.interval, "folders": folders,
                 "library_away": not folders["library"]["connected"],
                 "away": [r for r in ROLES if not folders[r]["connected"]]}
        with self._lock:
            before = self._state
            self._state = state
        if before is not None and before.get("away") != state["away"]:
            if state["away"]:
                logger.warning("[Drives] Not connected: %s", ", ".join(state["away"]))
            else:
                logger.info("[Drives] Every folder's drive is connected again")
            for fn in list(self._listeners):
                try:
                    fn(state)
                except Exception as exc:  # noqa: BLE001
                    logger.debug("drive watch listener: %s", exc)
        return state

    def state(self) -> Dict[str, Any]:
        with self._lock:
            state = self._state
        return state if state is not None else self.check_now()

    def peek(self) -> Optional[Dict[str, Any]]:
        """The last look, or None before the first (never looks itself, so
        the guards on hot paths don't touch the disk)."""
        with self._lock:
            return self._state

    def remember_written(self, role: str, path: str) -> None:
        """Record that a marker was written at ``path`` (the move's switch)."""
        self._store(role, path, written=self._clock(), seen=self._clock())


_WATCH: Optional[DriveWatch] = None
_WATCH_LOCK = threading.Lock()


def get_watch() -> DriveWatch:
    global _WATCH
    with _WATCH_LOCK:
        if _WATCH is None:
            _WATCH = DriveWatch()
        return _WATCH


def set_watch(watch: Optional[DriveWatch]) -> Optional[DriveWatch]:
    """Swap the process's watch (tests); returns the old one."""
    global _WATCH
    with _WATCH_LOCK:
        old, _WATCH = _WATCH, watch
    return old


def library_away() -> bool:
    """Whether the library's drive isn't connected, from the watch's last
    look. Errs on "connected" when there's no look yet (the watch starts with
    the app and looks at once) or the state can't be read, so nothing is ever
    blocked by a bug here; the guarded jobs carry their own visibility checks
    too."""
    try:
        state = get_watch().peek()
        return bool(state and state.get("library_away"))
    except Exception as exc:  # noqa: BLE001
        logger.debug("drive state unreadable: %s", exc)
        return False


def away_roles() -> List[str]:
    try:
        state = get_watch().peek()
        return list((state or {}).get("away") or [])
    except Exception:  # noqa: BLE001
        return []


AWAY_SKIP_WORDS = "Skipped: your library's drive isn't connected, so nothing was marked missing or cleaned up."


__all__ = ["AWAY_SKIP_WORDS", "CHECK_SECONDS", "DriveWatch", "LABELS", "MARKER_ID", "MARKER_NAME", "ROLES",
           "SETTING_KEYS", "away_roles", "ensure_table", "folder_paths", "get_watch", "has_marker", "library_away",
           "library_rows_under", "marker_id", "probe", "read_marker", "set_watch", "write_marker"]
