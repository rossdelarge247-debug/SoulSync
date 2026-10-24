"""Move your music to another drive: copy, check, then switch (boards 14b–14j).

The rule is "never move first". The job copies every file of the folders that
move to the new place, checks each copy (count and size, optionally the
contents), and only then switches: the folder settings and every path the
library stores change in ONE database transaction, then slskd and the media
server are pointed at the new place. If any of that refuses, it all switches
back. The old copies stay until the person removes them through the Safe
action, which deletes only the exact files this job copied and checked.

State lives in the database (``drive_moves`` and one row per file in
``drive_move_files``), so it survives a restart and reads the same on a
second device; a ``library_jobs`` row (kind ``drive_move``) puts it in
Activity's Library jobs with Stop.

Statuses: ``draft`` (Choose, Check, Plan) → ``copying`` → ``verifying`` →
``switching`` → ``switched`` (Done; the old copies kept) → ``removed`` (old
copies deleted) or ``switched_back``. ``failed`` (nothing switched; carry on
or delete the half-made copy) and ``stopped`` (stopped and undone) end a try.
"""

from __future__ import annotations

import errno
import functools
import hashlib
import json
import os
import sqlite3
import stat as _stat
import threading
import time
from contextlib import closing
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, FrozenSet, Iterable, List, Optional, Tuple

from core.drives import disks, holds, host_paths
from core.drives.markers import LABELS, MARKER_NAME, ROLES, SETTING_KEYS, write_marker
from core.drives.paths import PathRefused, protected_folders, safe_join, validate_target, within
from utils.logging_config import get_logger

logger = get_logger("drives.move")

KIND = "drive_move"
REMOVE_TOOL = "drive_move_remove_old"
FOLDER_NAMES = {"library": "Library", "downloads": "Downloads", "staging": "Staging"}
MOVE_MARK = ".synchros-move.json"
#: never copied, counted, listed for removal or deleted by a move: SYNCHRO.S's
#: marker, the move's note, and an older build's host hint (never read now)
SKIP_NAMES = (MARKER_NAME, MOVE_MARK, host_paths.LEGACY_HINT_NAME)
APPLEDOUBLE_PREFIX = "._"
REMIND_SECONDS = 7 * 86400
#: the write test in Check; tests make it small
TEST_WRITE_BYTES = 32 * 1024 * 1024
#: slower than this and Check says "slow drive" (bytes a second)
SLOW_BPS = 40 * 1024 * 1024
#: what the estimate assumes before Check has measured anything
DEFAULT_BPS = 60 * 1024 * 1024
CHUNK = 1024 * 1024
#: progress is written to the database at most this often
SAVE_SECONDS = 2.0
#: how long the copy waits for running downloads and imports to finish
BUSY_WAIT_SECONDS = 30 * 60
#: Check stops counting other files in a destination after this many
FOREIGN_CAP = 1000

ACTIVE = ("copying", "verifying", "switching")
OPEN = ("draft",) + ACTIVE + ("failed", "switched")

#: every stored column that can hold a path under a moved folder
PATH_COLUMNS = (
    ("tracks", "file_path"), ("track_downloads", "file_path"), ("library_history", "file_path"),
    ("retag_tracks", "file_path"), ("repair_findings", "file_path"),
    ("manual_library_track_matches", "library_file_path"), ("auto_import_history", "folder_path"),
    ("rematch_hints", "staged_path"), ("sample_stash", "file_path"), ("curation_signals", "source_path"),
    ("downloaded_podcast_episodes", "file_path"),
)

_TABLES = (
    """CREATE TABLE IF NOT EXISTS drive_moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        profile_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        switched_at INTEGER,
        finished_at INTEGER,
        choice_json TEXT,
        checks_json TEXT,
        plan_json TEXT,
        progress_json TEXT,
        result_json TEXT,
        failure_json TEXT,
        secret TEXT,
        job_id INTEGER,
        docker_boot_id TEXT
    )""",
    """CREATE TABLE IF NOT EXISTS drive_move_files (
        move_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        rel TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime REAL,
        mtime_ns INTEGER,
        copied INTEGER NOT NULL DEFAULT 0,
        verified INTEGER NOT NULL DEFAULT 0,
        problem TEXT,
        excluded INTEGER NOT NULL DEFAULT 0,
        removed INTEGER NOT NULL DEFAULT 0,
        added_after INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (move_id, role, rel)
    )""",
)


class MoveError(Exception):
    """A request the move can't do now; ``str(exc)`` is the sentence."""

    def __init__(self, message: str, status: int = 409, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class Stopped(Exception):
    pass


class Failure(Exception):
    def __init__(self, kind: str, words: str, **extra: Any) -> None:
        super().__init__(words)
        self.kind = kind
        self.words = words
        self.extra = extra


def ensure_tables(conn) -> None:
    for sql in _TABLES:
        conn.execute(sql)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(drive_move_files)").fetchall()}
    if "mtime_ns" not in cols:
        conn.execute("ALTER TABLE drive_move_files ADD COLUMN mtime_ns INTEGER")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_drive_move_files_state ON drive_move_files (move_id, copied, verified)")
    from core.library.missing_releases import ensure_table
    ensure_table(conn)


def _now() -> int:
    return int(time.time())


def _json_file(path: str) -> Dict[str, Any]:
    """A small JSON file SYNCHRO.S wrote (never through a link), or {}."""
    try:
        if os.path.islink(path) or not os.path.isfile(path) or os.path.getsize(path) > 65536:
            return {}
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) and data.get("app") == "SYNCHRO.S" else {}
    except (OSError, ValueError):
        return {}


def size_words(n: Optional[float]) -> str:
    n = float(n or 0)
    for unit, scale in (("TB", 1e12), ("GB", 1e9), ("MB", 1e6), ("KB", 1e3)):
        if n >= scale:
            value = n / scale
            return f"{value:.1f} {unit}" if value < 100 else f"{value:.0f} {unit}"
    return f"{int(n)} bytes"


def duration_words(seconds: Optional[float]) -> str:
    s = int(max(0, seconds or 0))
    if s < 90:
        return "about a minute" if s >= 30 else "less than a minute"
    m = round(s / 60)
    if m < 60:
        return f"{m} min"
    h, m = divmod(m, 60)
    return f"{h} h {m} min" if m else f"{h} h"


def _plural(n: int, word: str) -> str:
    return f"{n:,} {word}" + ("" if n == 1 else "s")


# ── one folder, however it's reached ──────────────────────────────────────────

def _stats_up(path: str) -> List[os.stat_result]:
    """The stat of ``path`` (when it exists) and of every existing folder above it."""
    out = []
    p = os.path.abspath(path)
    while True:
        try:
            out.append(os.stat(p))
        except OSError:
            pass
        parent = os.path.dirname(p)
        if parent == p:
            return out
        p = parent


def _stat_of(path: str) -> Optional[os.stat_result]:
    try:
        return os.stat(path)
    except OSError:
        return None


def same_folder(a: str, b: str) -> bool:
    """Whether ``a`` and ``b`` are one folder on disk, even when reached
    through two different mounts (realpath can't see through those)."""
    if os.path.realpath(a) == os.path.realpath(b):
        return True
    sa, sb = _stat_of(a), _stat_of(b)
    return sa is not None and sb is not None and os.path.samestat(sa, sb)


def overlaps(a: str, b: str) -> bool:
    """Whether ``a`` is ``b``, inside it or around it: by path, and by what's
    on disk (a bind mount shows one folder at two paths)."""
    if not a or not b:
        return False
    if within(a, b) or within(b, a):
        return True
    sa, sb = _stat_of(a), _stat_of(b)
    if sb is not None and any(os.path.samestat(s, sb) for s in _stats_up(a)):
        return True
    if sa is not None and any(os.path.samestat(s, sa) for s in _stats_up(b)):
        return True
    return False


PROBE_PREFIX = ".synchros-probe-"


@functools.lru_cache(maxsize=8192)
def _ids_up(folder: str) -> FrozenSet[Tuple[int, int]]:
    """(device, inode) of ``folder`` and every existing folder above it,
    cached per folder: a walk asks once per folder, not once per file."""
    return frozenset((st.st_dev, st.st_ino) for st in _stats_up(folder))


def _inside_any(path: str, roots: Iterable[str]) -> bool:
    """Whether ``path`` is one of ``roots`` or under one: by its spelling, by
    the roots' resolved paths (links in a root's own path count), and by
    what's on disk (a bind mount shows one folder at two paths)."""
    p = os.path.normpath(path)
    roots = list(roots)
    for root in roots:
        for r in {os.path.normpath(root), os.path.realpath(root)}:
            if p == r or p.startswith(r.rstrip("/") + "/"):
                return True
    ids = None
    for root in roots:
        st = _stat_of(root)
        if st is None:
            continue
        if ids is None:
            ids = _ids_up(os.path.dirname(p) or p)
        if (st.st_dev, st.st_ino) in ids:
            return True
    return False


def _seen_through(sources: Iterable[str], dests: Iterable[str]) -> bool:
    """A random file written in each source folder: when it shows up above a
    destination, that destination is inside a source however it's mounted."""
    made: List[str] = []
    names = []
    try:
        for src in sources:
            if not src or not os.path.isdir(src):
                continue
            name = PROBE_PREFIX + os.urandom(12).hex()
            path = os.path.join(src, name)
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
                os.close(fd)
            except OSError:
                continue
            made.append(path)
            names.append(name)
        if not names:
            return False
        for dest in dests:
            p = os.path.abspath(dest)
            while True:
                if any(os.path.lexists(os.path.join(p, n)) for n in names):
                    return True
                parent = os.path.dirname(p)
                if parent == p:
                    break
                p = parent
        return False
    finally:
        for path in made:
            try:
                os.unlink(path)
            except OSError:
                pass


#: what never leaves the server in a move's payload
SECRET_KEYS = frozenset({"config_before", "secret"})


def _scrub(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _scrub(v) for k, v in value.items() if k not in SECRET_KEYS}
    if isinstance(value, list):
        return [_scrub(v) for v in value]
    return value


# ── what the job needs from the app ───────────────────────────────────────────

@dataclass
class Deps:
    """Everything the job touches outside itself, injectable for tests."""

    database: Callable[[], Any]
    config: Callable[[], Any]
    platform: Callable[[], str] = lambda: "linux"
    slskd: Callable[[], Any] = lambda: None
    media: Callable[[], Any] = lambda: None
    #: names of what runs right now and writes to the folders ("2 downloads")
    busy: Callable[[], List[str]] = lambda: []
    pause_workers: Callable[[], None] = lambda: None
    resume_workers: Callable[[], None] = lambda: None
    #: called after the switch (and back) so caches forget the old paths
    after_switch: Callable[[], None] = lambda: None
    encrypt: Callable[[str], str] = lambda s: s
    decrypt: Callable[[str], str] = lambda s: s
    clock: Callable[[], float] = time.time
    sleep: Callable[[float], None] = time.sleep
    drive_watch: Callable[[], Any] = lambda: None
    extra_protected: List[str] = field(default_factory=list)


# ── storage ───────────────────────────────────────────────────────────────────

def _loads(value: Any, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


class Store:
    def __init__(self, deps: Deps) -> None:
        self.deps = deps

    def conn(self):
        conn = self.deps.database()._get_connection()
        try:
            conn.row_factory = sqlite3.Row
        except Exception:  # noqa: BLE001,S110 - a stand-in connection without row_factory
            pass
        ensure_tables(conn)
        return conn

    def row(self, move_id: int) -> Optional[Dict[str, Any]]:
        with closing(self.conn()) as conn:
            r = conn.execute("SELECT * FROM drive_moves WHERE id = ?", (int(move_id),)).fetchone()
        return self._decode(r) if r else None

    def current(self) -> Optional[Dict[str, Any]]:
        """The open move (draft, running, failed or switched with old copies
        kept), else None."""
        marks = ",".join("?" * len(OPEN))
        with closing(self.conn()) as conn:
            r = conn.execute(f"SELECT * FROM drive_moves WHERE status IN ({marks}) ORDER BY id DESC LIMIT 1",
                             OPEN).fetchone()
        return self._decode(r) if r else None

    def latest(self) -> Optional[Dict[str, Any]]:
        with closing(self.conn()) as conn:
            r = conn.execute("SELECT * FROM drive_moves ORDER BY id DESC LIMIT 1").fetchone()
        return self._decode(r) if r else None

    @staticmethod
    def _decode(r) -> Dict[str, Any]:
        d = dict(r)
        for key, default in (("choice_json", {}), ("checks_json", None), ("plan_json", None), ("progress_json", {}),
                             ("result_json", {}), ("failure_json", None)):
            d[key[:-5]] = _loads(d.pop(key), default)
        return d

    def create(self, profile_id: int, choice: Dict[str, Any]) -> int:
        t = _now()
        with closing(self.conn()) as conn:
            cur = conn.execute("INSERT INTO drive_moves (status, profile_id, created_at, updated_at, choice_json) "
                               "VALUES ('draft', ?, ?, ?, ?)", (int(profile_id), t, t, json.dumps(choice)))
            conn.commit()
            return int(cur.lastrowid)

    def update(self, move_id: int, *, expect_status: Optional[str] = None, **fields: Any) -> int:
        """Write ``fields``; with ``expect_status``, only while the move is
        still in that status. Returns how many rows changed (0 or 1)."""
        cols, vals = [], []
        for key, value in fields.items():
            if key in ("choice", "checks", "plan", "progress", "result", "failure"):
                key, value = key + "_json", (json.dumps(value) if value is not None else None)
            cols.append(f"{key} = ?")
            vals.append(value)
        cols.append("updated_at = ?")
        vals.append(_now())
        vals.append(int(move_id))
        with closing(self.conn()) as conn:
            if expect_status is not None:
                # read and write in one immediate transaction: nothing changes the status between
                conn.execute("BEGIN IMMEDIATE")
                now = conn.execute("SELECT status FROM drive_moves WHERE id = ?", (int(move_id),)).fetchone()
                if now is None or now[0] != expect_status:
                    conn.rollback()
                    return 0
            before = getattr(conn, "total_changes", 0)
            conn.execute(f"UPDATE drive_moves SET {', '.join(cols)} WHERE id = ?", vals)
            changed = getattr(conn, "total_changes", 1) - before
            conn.commit()
            return int(changed)

    # -- the activity row --

    def job_row(self, move: Dict[str, Any], status: str, *, total: int = 0, done: int = 0, note: str = "") -> int:
        t = _now()
        with closing(self.conn()) as conn:
            job_id = move.get("job_id")
            if job_id:
                conn.execute("UPDATE library_jobs SET status = ?, total = ?, done = ?, note = ?, "
                             "finished_at = ? WHERE id = ?",
                             (status, total, done, note, None if status == "running" else t, int(job_id)))
            else:
                cur = conn.execute("INSERT INTO library_jobs (kind, profile_id, status, total, done, started_at, note) "
                                   "VALUES (?, ?, ?, ?, ?, ?, ?)",
                                   (KIND, int(move["profile_id"]), status, total, done, t, note))
                job_id = int(cur.lastrowid)
                conn.execute("UPDATE drive_moves SET job_id = ? WHERE id = ?", (job_id, int(move["id"])))
            conn.commit()
        move["job_id"] = job_id
        return int(job_id)

    # -- files --

    def add_files(self, move_id: int, role: str, rows: Iterable[Tuple[Any, ...]], *, added_after: bool = False) -> int:
        """``rows`` are (rel, size, mtime[, mtime_ns])."""
        n = 0
        sql = ("INSERT OR IGNORE INTO drive_move_files (move_id, role, rel, size, mtime, mtime_ns, added_after) "
               "VALUES (?, ?, ?, ?, ?, ?, ?)")
        with closing(self.conn()) as conn:
            batch = []
            for row in rows:
                rel, size, mtime = row[0], row[1], row[2]
                mtime_ns = int(row[3]) if len(row) > 3 and row[3] is not None else int(float(mtime) * 1e9)
                batch.append((int(move_id), role, rel, int(size), float(mtime), mtime_ns, 1 if added_after else 0))
                if len(batch) >= 500:
                    conn.executemany(sql, batch)
                    n += len(batch)
                    batch = []
            if batch:
                conn.executemany(sql, batch)
                n += len(batch)
            conn.commit()
        return n

    def files(self, move_id: int, *, where: str = "1", params: Tuple = ()) -> List[Dict[str, Any]]:
        with closing(self.conn()) as conn:
            rows = conn.execute(f"SELECT * FROM drive_move_files WHERE move_id = ? AND ({where}) "
                                "ORDER BY role, rel", (int(move_id),) + tuple(params)).fetchall()
        return [dict(r) for r in rows]

    def mark(self, move_id: int, updates: List[Tuple[str, str, Dict[str, Any]]]) -> None:
        if not updates:
            return
        with closing(self.conn()) as conn:
            for role, rel, fields in updates:
                cols = ", ".join(f"{k} = ?" for k in fields)
                conn.execute(f"UPDATE drive_move_files SET {cols} WHERE move_id = ? AND role = ? AND rel = ?",
                             tuple(fields.values()) + (int(move_id), role, rel))
            conn.commit()

    def counts(self, move_id: int) -> Dict[str, Dict[str, int]]:
        with closing(self.conn()) as conn:
            rows = conn.execute(
                "SELECT role, COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes, "
                "SUM(CASE WHEN copied = 1 THEN 1 ELSE 0 END) AS copied_files, "
                "COALESCE(SUM(CASE WHEN copied = 1 THEN size ELSE 0 END), 0) AS copied_bytes, "
                "SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified, "
                "SUM(CASE WHEN problem IS NOT NULL AND excluded = 0 THEN 1 ELSE 0 END) AS problems "
                "FROM drive_move_files WHERE move_id = ? AND excluded = 0 GROUP BY role", (int(move_id),)).fetchall()
        return {r["role"]: {k: int(r[k] or 0) for k in r.keys() if k != "role"} for r in rows}


# ── the job ───────────────────────────────────────────────────────────────────

class MoveJob:
    def __init__(self, deps: Deps) -> None:
        self.deps = deps
        self.store = Store(deps)
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._live: Dict[str, Any] = {}
        self._last_save = 0.0
        #: the slskd user name each move signed in as, for Check's row ("Signed in
        #: as slskd"); never the password, and forgotten with the session
        self._slskd_user: Dict[int, str] = {}

    # ── reading ──────────────────────────────────────────────────────────────

    def config(self):
        return self.deps.config()

    def platform(self) -> str:
        try:
            saved = self.config().get("drives.platform", "")
        except Exception:  # noqa: BLE001
            saved = ""
        return saved if saved in disks.PLATFORMS else self.deps.platform()

    def roots(self) -> List[str]:
        return list(disks.drives_roots(self.platform()))

    def current_paths(self) -> Dict[str, str]:
        from core.drives.markers import folder_paths
        return folder_paths(self.config())

    def home_label(self) -> str:
        return disks.home_disk_name(self.platform())

    def label_of(self, path: str) -> str:
        return disks.drive_label(path, self.platform())

    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # ── Choose ───────────────────────────────────────────────────────────────

    def draft(self, profile_id: int) -> Dict[str, Any]:
        """The open move, or a new draft."""
        move = self.store.current()
        if move is None:
            move_id = self.store.create(profile_id, {"roles": {r: True for r in ROLES}, "target": "",
                                                     "separate": False, "per_role": {}, "exfat": None,
                                                     "checksum": False})
            move = self.store.row(move_id)
        return move  # type: ignore[return-value]

    def destinations(self, choice: Dict[str, Any]) -> Dict[str, str]:
        """Where each ticked folder goes, as typed (validated separately)."""
        roles = [r for r in ROLES if (choice.get("roles") or {}).get(r)]
        out = {}
        if choice.get("separate"):
            per = choice.get("per_role") or {}
            for r in roles:
                if per.get(r):
                    out[r] = str(per[r]).rstrip("/")
        elif choice.get("target"):
            target = str(choice["target"]).rstrip("/")
            for r in roles:
                out[r] = os.path.join(target, FOLDER_NAMES[r])
        return out

    def set_choice(self, move_id: int, choice: Dict[str, Any]) -> Dict[str, Any]:
        # under the lock, so a choice can't land while Start lists the files
        with self._lock:
            return self._set_choice(move_id, choice)

    def _set_choice(self, move_id: int, choice: Dict[str, Any]) -> Dict[str, Any]:
        move = self._require(move_id, ("draft",))
        clean = dict(move["choice"])
        roles = choice.get("roles")
        if isinstance(roles, dict):
            clean["roles"] = {r: bool(roles.get(r, clean["roles"].get(r, True))) for r in ROLES}
        for key in ("separate", "checksum"):
            if key in choice:
                clean[key] = bool(choice[key])
        if "target" in choice:
            clean["target"] = str(choice.get("target") or "").strip()[:1024]
        if isinstance(choice.get("per_role"), dict):
            clean["per_role"] = {r: str(v).strip()[:1024] for r, v in choice["per_role"].items() if r in ROLES and v}
        if "exfat" in choice:
            clean["exfat"] = choice["exfat"] if choice["exfat"] in ("carry_on", "erase") else None
        # Check's slskd row (19a): "Leave Downloads on …" takes Downloads out of
        # this move; "Move Downloads too" puts it back. Ticking folders on Choose
        # is a fresh choice, so it forgets the row's.
        if "downloads_left" in choice:
            left = bool(choice["downloads_left"])
            if left:
                clean["roles"] = {**clean["roles"], "downloads": False}
            elif clean.get("downloads_left"):
                clean["roles"] = {**clean["roles"], "downloads": True}
            clean["downloads_left"] = left
        elif isinstance(roles, dict):
            clean["downloads_left"] = False
        if not any(clean["roles"].values()):
            raise MoveError("Tick at least one folder to move.", 400)
        changed_place = (clean.get("target"), clean.get("per_role"), clean.get("separate"), clean.get("roles")) != (
            move["choice"].get("target"), move["choice"].get("per_role"), move["choice"].get("separate"),
            move["choice"].get("roles"))
        fields: Dict[str, Any] = {"checks": None, "plan": None} if changed_place else {}
        if not clean["roles"].get("downloads") and move.get("secret"):
            # slskd's session was only for moving Downloads: without it, forget it now
            fields["secret"] = None
            self._slskd_user.pop(move["id"], None)
        if not self.store.update(move_id, expect_status="draft", choice=clean, **fields):
            raise MoveError("The move has moved on; reload to see where it is.")
        return self.store.row(move_id)  # type: ignore[return-value]

    @staticmethod
    def nested_staying(dests: Dict[str, Any], sources: Dict[str, str]) -> List[Tuple[str, str]]:
        """(staying role, moving role) pairs where a folder that isn't moving
        is, sits inside or holds one that is."""
        out = []
        for staying in ROLES:
            if staying in dests or not sources.get(staying):
                continue
            for role in dests:
                if sources.get(role) and overlaps(sources[staying], sources[role]):
                    out.append((staying, role))
        return out

    def validated_destinations(self, choice: Dict[str, Any]) -> Dict[str, str]:
        """Where each ticked folder goes, resolved, or :class:`MoveError`. A
        destination may not be, sit inside or hold any of the three music
        folders (moving or not), however the folders are mounted, and two
        destinations may not overlap."""
        dests = self.destinations(choice)
        if not dests:
            raise MoveError("Choose where your music goes.", 400)
        sources = self.current_paths()
        nested = self.nested_staying(dests, sources)
        if nested:
            staying, role = nested[0]
            raise MoveError(
                f"The {LABELS[staying]} folder ({sources[staying]}) is inside the {LABELS[role]} folder, or holds "
                f"it, and isn't moving. Moving {LABELS[role]} would copy it, and removing the old copies afterwards "
                f"would delete files SYNCHRO.S still uses. Move {LABELS[staying]} too, or move it out of the "
                f"{LABELS[role]} folder first.", 400, code="nested_folder")
        moving = [sources[r] for r in dests]
        protected = protected_folders(self.deps.extra_protected)
        out: Dict[str, str] = {}
        for role, dest in dests.items():
            try:
                out[role] = validate_target(dest, roots=self.roots(), protected=protected, moving=moving)
            except PathRefused as exc:
                raise MoveError(f"{LABELS[role]}: {exc}", 400) from None
            if overlaps(out[role], sources[role]):
                raise MoveError(f"{LABELS[role]} is already there.", 400)
            for other in ROLES:
                if other != role and overlaps(out[role], sources.get(other) or ""):
                    raise MoveError(f"{LABELS[role]}: that folder is, holds or sits inside the {LABELS[other]} "
                                    "folder. Choose a folder of its own.", 400)
        placed = list(out.items())
        for i, (_r, a) in enumerate(placed):
            for _r2, b in placed[i + 1:]:
                if overlaps(a, b):
                    raise MoveError("Two folders would go to the same place.", 400)
        if _seen_through([p for p in sources.values() if p], out.values()):
            raise MoveError("That folder is one of your music folders, seen through another mount. "
                            "Choose a folder of its own.", 400)
        return out

    # ── Check ────────────────────────────────────────────────────────────────

    def check(self, move_id: int, *, background: bool = False) -> Dict[str, Any]:
        """The checks. The places are validated at once (a refusal is the
        answer); the slow part (the folder sizes, the write test, the look
        for other files) runs on a thread when ``background``, and the page
        reads ``checks.running`` until it's done."""
        move = self._require(move_id, ("draft",))
        try:
            self.validated_destinations(move["choice"])
        except MoveError as exc:
            if exc.code == "nested_folder":
                # Check says it as a row too, so the page shows why nothing can go on
                self.store.update(move_id, expect_status="draft", checks=self._nested_checks(str(exc)))
            raise
        if not background:
            self._run_checks(move_id, None)
            return self.store.row(move_id)  # type: ignore[return-value]
        run = os.urandom(8).hex()
        self.store.update(move_id, checks={"running": True, "run": run, "rows": [], "ok": False, "at": _now(),
                                           "summary": "Looking at the drive…"})
        t = threading.Thread(target=self._run_checks, args=(move_id, run), name="drive-move-check", daemon=True)
        self._check_thread = t
        t.start()
        return self.store.row(move_id)  # type: ignore[return-value]

    def join_check(self, timeout: Optional[float] = None) -> None:
        t = getattr(self, "_check_thread", None)
        if t is not None:
            t.join(timeout)

    def _run_checks(self, move_id: int, run: Optional[str]) -> None:
        try:
            checks = self._checks(move_id)
        except MoveError as exc:
            checks = self._nested_checks(str(exc)) if exc.code == "nested_folder" else self._check_error(str(exc))
        except Exception as exc:  # noqa: BLE001
            logger.error("drive move check failed: %s", exc, exc_info=True)
            checks = self._check_error("SYNCHRO.S couldn't finish the checks; the log has the details.")
        with self._lock:
            move = self.store.row(move_id)
            if move is None or move["status"] != "draft":
                return
            if run is not None and (move.get("checks") or {}).get("run") != run:
                return  # the choice changed or Check ran again: this answer is stale
            self.store.update(move_id, checks=checks)

    @staticmethod
    def _nested_checks(words: str) -> Dict[str, Any]:
        return {"rows": [{"key": "nested", "title": "A folder that isn't moving is inside one that is",
                          "tone": "danger", "tag": "Move it too", "stop": True, "detail": words}],
                "at": _now(), "ok": False, "summary": "Something needs fixing before anything is copied."}

    @staticmethod
    def _check_error(words: str) -> Dict[str, Any]:
        return {"rows": [{"key": "error", "title": "The checks didn't finish", "tone": "danger",
                          "tag": "Couldn't check", "stop": True, "detail": words}],
                "at": _now(), "ok": False, "summary": "Something needs fixing before anything is copied."}

    def _checks(self, move_id: int) -> Dict[str, Any]:
        move = self._require(move_id, ("draft",))
        choice = move["choice"]
        dests = self.validated_destinations(choice)
        sources = self.current_paths()
        sizes = {r: disks.count_folder(sources[r], skip=SKIP_NAMES) for r in dests}
        need = sum(s["bytes"] for s in sizes.values())
        by_drive: Dict[str, List[str]] = {}
        for role, dest in dests.items():
            by_drive.setdefault(disks.drive_root_of(dest, self.platform()) or dest, []).append(role)
        rows: List[Dict[str, Any]] = []
        speed = None
        fmt_name = None
        for drive_root, roles in by_drive.items():
            label = self.label_of(drive_root)
            need_here = sum(sizes[r]["bytes"] for r in roles)
            space = disks.usage(drive_root) or {}
            free = space.get("free")
            if free is None:
                rows.append({"key": "space", "title": "Enough space", "tone": "warning", "tag": "Couldn't tell",
                             "detail": f"SYNCHRO.S couldn't read {label}'s free space."})
            elif free < need_here * 1.02 + 256 * 1024 * 1024:
                short = need_here * 1.02 + 256 * 1024 * 1024 - free
                leave = [LABELS[r] for r in roles if r != "library" and sizes[r]["bytes"] >= short]
                way = f"leave {leave[0]} out, " if leave else ""
                rows.append({"key": "space", "title": "Not enough space", "tone": "danger", "tag": "Not enough space",
                             "stop": True,
                             "detail": f"Needs {size_words(need_here)}; {label} has {size_words(free)} free. Free "
                                       f"{size_words(short)} on it, {way}or choose another drive."})
            else:
                rows.append({"key": "space", "title": "Enough space", "tone": "success", "tag": "Fine",
                             "detail": f"{size_words(need_here)} to copy · {size_words(free)} free · "
                                       f"{size_words(free - need_here)} left after"})
            write = self._check_write(dests[roles[0]], label)
            rows.append(write)
            if write.get("speed"):
                speed = write["speed"] if speed is None else min(speed, write["speed"])
            fmt = write.get("format") or disks.format_of(drive_root)
            if fmt in ("exFAT", "FAT32"):
                fmt_name = fmt
                choice_made = choice.get("exfat")
                rows.append({"key": "format", "title": f"The drive's format: {fmt}", "tone": "warning",
                             "tag": "Works, with a catch", "choice": choice_made, "needs_choice": choice_made != "carry_on",
                             "detail": "On a Mac, exFAT drives collect a hidden “._” file beside every file, and slskd "
                                       "would share those as if they were music. Your choice:"
                             if self.platform() == "mac" else
                             f"{fmt} can't keep links or permissions; SYNCHRO.S copies without them. Your choice:"})
            elif fmt == "NTFS" and self.platform() == "mac":
                rows.append({"key": "format", "title": "Can't write there", "tone": "danger", "tag": "Can't write there",
                             "stop": True, "detail": f"{label} is NTFS, which a Mac can only read. Erase it as APFS or "
                                                     "exFAT in Disk Utility, or choose another drive."})
            for role in roles:
                crowd = self._foreign_files(dests[role], role)
                if crowd:
                    many = f"more than {FOREIGN_CAP:,} files" if crowd > FOREIGN_CAP else _plural(crowd, "file")
                    rows.append({"key": f"empty-{role}", "title": "The folder isn't empty", "tone": "danger",
                                 "tag": "The folder isn't empty", "stop": True,
                                 "detail": f"{dests[role]} has {many} SYNCHRO.S didn't put there. "
                                           "Choose an empty folder; nothing in it will be touched."})
        if speed is not None and speed < SLOW_BPS:
            rows.append({"key": "speed", "title": "Slow drive", "tone": "warning", "tag": "Slow drive",
                         "detail": f"It copies at about {size_words(speed)}/s, so this takes about "
                                   f"{duration_words(need / max(speed, 1))}. A faster port (USB 3) would be quicker."})
        rows.extend(self._check_services(dests, choice, move))
        stop = any(r.get("stop") for r in rows)
        needs_choice = any(r.get("needs_choice") for r in rows)
        passed = sum(1 for r in rows if r["tone"] == "success")
        say = sum(1 for r in rows if r["tone"] != "success")
        return {"rows": rows, "at": _now(), "speed": speed, "format": fmt_name, "need": need,
                "sizes": sizes, "dests": dests, "ok": not stop and not needs_choice,
                "summary": self._check_summary(passed, say, stop)}

    @staticmethod
    def _check_summary(passed: int, say: int, stop: bool) -> str:
        if stop:
            return "Something needs fixing before anything is copied."
        if not say:
            return "Every check passed."
        words = {1: "One", 2: "Two", 3: "Three", 4: "Four"}
        p = words.get(passed, str(passed))
        s = words.get(say, str(say)).lower()
        return f"{p} {'check' if passed == 1 else 'checks'} passed and {s} {'needs' if say == 1 else 'need'} your say."

    def _check_write(self, dest: str, label: str) -> Dict[str, Any]:
        parent = os.path.dirname(dest.rstrip("/")) or dest
        made = []
        probe_dir = parent
        try:
            # make the folder the move will use, remembering what was made so
            # nothing is left behind if the move never starts
            p = parent
            todo = []
            while not os.path.lexists(p):
                todo.append(p)
                p = os.path.dirname(p)
            for d in reversed(todo):
                os.mkdir(d)
                made.append(d)
            if not os.path.isdir(parent) or os.path.islink(parent):
                raise OSError(errno.ENOTDIR, "not a folder")
            test = os.path.join(probe_dir, f".synchros-write-test-{os.getpid()}-{os.urandom(4).hex()}")
            data = os.urandom(min(TEST_WRITE_BYTES, 1024 * 1024))
            started = time.monotonic()
            written = 0
            fd = os.open(test, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(fd, "wb") as f:
                while written < TEST_WRITE_BYTES:
                    f.write(data)
                    written += len(data)
                f.flush()
                os.fsync(f.fileno())
            took = max(time.monotonic() - started, 1e-3)
            fmt = None
            try:
                link = test + ".link"
                os.symlink(os.path.basename(test), link)
                os.unlink(link)
            except OSError as exc:
                if exc.errno in (errno.EPERM, errno.ENOTSUP, errno.EOPNOTSUPP, errno.EINVAL, errno.ENOSYS):
                    fmt = "exFAT"
            os.unlink(test)
            return {"key": "write", "title": "SYNCHRO.S can write there", "tone": "success", "tag": "Fine",
                    "detail": f"Made a test file in {parent} and removed it", "speed": written / took, "format": fmt}
        except OSError as exc:
            if exc.errno == errno.EROFS:
                detail = (f"{label} is read-only to SYNCHRO.S. On a Mac that's how an NTFS drive looks: erase it as "
                          "APFS or exFAT in Disk Utility, or choose another drive.")
            elif exc.errno in (errno.EACCES, errno.EPERM):
                detail = "Docker can see the drive but not write to it. Run the helper again; it fixes this."
            elif exc.errno == errno.ENOSPC:
                detail = f"{label} is full."
            else:
                detail = f"SYNCHRO.S couldn't write a test file there ({exc.strerror or exc})."
            return {"key": "write", "title": "Can't write there", "tone": "danger", "tag": "Can't write there",
                    "stop": True, "detail": detail}
        finally:
            for d in reversed(made):
                try:
                    os.rmdir(d)
                except OSError:
                    pass

    def _foreign_files(self, dest: str, role: str) -> int:
        """Files in ``dest`` that SYNCHRO.S didn't put there (0 when it's
        missing, empty, or a ``role`` folder an earlier move made). A marker
        counts only when it's for ``role`` and ``dest`` isn't one of the
        folders SYNCHRO.S uses now; anything already there is copied over."""
        if not os.path.isdir(dest):
            return 0
        configured = any(p and same_folder(dest, p) for p in self.current_paths().values())
        marker_role = _json_file(os.path.join(dest, MARKER_NAME)).get("role")
        parent = os.path.dirname(dest.rstrip("/"))
        mark = _json_file(os.path.join(parent, MOVE_MARK))
        ours = not configured and (marker_role == role or (
            marker_role is None and mark.get("app") == "SYNCHRO.S"))
        if ours:
            return 0
        n = 0
        for _rel, _st in disks.walk_files(dest, skip=SKIP_NAMES + (".DS_Store",)):
            n += 1
            if n > FOREIGN_CAP:
                break
        return n

    def _check_services(self, dests: Dict[str, str], choice: Dict[str, Any], move: Dict[str, Any]) -> List[Dict[str, Any]]:
        rows = []
        media = self._media()
        if "library" in dests and media is not None and getattr(media, "name", "none") != "none":
            if media.api:
                seen = media.can_see(os.path.dirname(dests["library"]))
                if seen is False:
                    rows.append({"key": "media", "title": f"{media.label} can't see it", "tone": "warning",
                                 "tag": f"{media.label} can't see it",
                                 "detail": f"{media.label} runs somewhere the helper didn't change. {media.label} keeps "
                                           "reading the old folder until you add the new one to its Music library; "
                                           "SYNCHRO.S says how on the last step."})
            else:
                rows.append({"key": "media", "title": f"{media.label} reads its own folder", "tone": "warning",
                             "tag": "Change it by hand",
                             "detail": f"{media.label} takes its music folder from its own settings, not from SYNCHRO.S. "
                                       "After the switch, set it to the new Library folder; SYNCHRO.S says how."})
        slskd = self._slskd()
        if slskd is not None and slskd.configured():
            unsupported = self._slskd_unsupported(slskd, dests, choice) \
                if ("library" in dests or "downloads" in dests) and slskd.can_edit() else None
            if unsupported:
                stop = "downloads" in dests
                rows.append({"key": "slskd", "title": "slskd's settings", "tone": "danger" if stop else "warning",
                             "tag": "Can't edit slskd.yml", "stop": stop,
                             "detail": (f"SYNCHRO.S can't change slskd.yml safely ({unsupported}), and slskd "
                                        "downloads into the Downloads folder. Change it by hand, or leave "
                                        "Downloads out.") if stop else
                                       (f"SYNCHRO.S can't change slskd.yml safely ({unsupported}), so slskd keeps "
                                        "sharing the old copies until you point it at the new Library folder.")})
            elif ("library" in dests or "downloads" in dests) and not slskd.can_edit():
                stop = "downloads" in dests
                rows.append({"key": "slskd", "title": "slskd's settings", "tone": "danger" if stop else "warning",
                             "tag": "Can't reach slskd.yml", "stop": stop,
                             "detail": ("slskd downloads into the Downloads folder, and SYNCHRO.S can't change where "
                                        "without slskd's settings file. Run the helper again (it adds it), or leave "
                                        "Downloads out.") if stop else
                                       ("SYNCHRO.S can't change what slskd shares without its settings file, so slskd "
                                        "keeps sharing the old copies. Run the helper again to add it.")})
            elif "downloads" in dests:
                rows.append(self._slskd_choice_row(dests, choice, move))
            elif choice.get("downloads_left"):
                rows.append(self._slskd_choice_row(dests, choice, move))
        return rows

    def _slskd_choice_row(self, dests: Dict[str, str], choice: Dict[str, Any],
                          move: Dict[str, Any]) -> Dict[str, Any]:
        """Check's slskd row (19a): moving Downloads needs slskd's sign-in, so the
        row asks for the choice: sign in and move Downloads too (the default,
        picked on Choose), or leave Downloads where it is. It doesn't stop the
        move; See the plan waits until the choice is settled."""
        home = self.label_of(self.current_paths().get("downloads") or "") or self.home_label()
        target_path = dests.get("downloads") or next(iter(dests.values()), "")
        target = self.label_of(target_path) if target_path else "the new drive"
        base = {"key": "slskd", "title": "slskd downloads to the new place", "home_label": home,
                "target_label": target}
        if "downloads" not in dests:
            return {**base, "tone": "success", "tag": "Fine", "slskd_choice": "leave", "signed_in": False,
                    "detail": f"Downloads stays on {home}. slskd keeps downloading there; imports copy across "
                              f"to {target}. You can move Downloads later."}
        if not move.get("secret"):
            return {**base, "tone": "warning", "tag": "Needs your choice", "needs_choice": True,
                    "sign_in": True, "slskd_choice": "move", "signed_in": False,
                    "detail": f"To download into {target}, slskd has to restart, and it only lets a signed-in "
                              "admin do that. SYNCHRO.S signs in once, keeps only what slskd hands back, and "
                              "forgets it when the move is done."}
        user = self._slskd_user.get(move["id"])
        return {**base, "tone": "success", "tag": f"Signed in as {user}" if user else "Signed in",
                "slskd_choice": "move", "signed_in": True,
                "detail": "SYNCHRO.S restarts slskd once at the switch, then forgets the sign-in."}

    def _slskd_unsupported(self, slskd: Any, dests: Dict[str, str], choice: Dict[str, Any]) -> Optional[str]:
        """Why the switch couldn't edit slskd.yml, from a dry run of the same
        edit, or None when it can."""
        from core.drives.services import ServiceRefused, library_share_in, plan_slskd_config
        try:
            text = slskd.read_config()
            current = slskd.shared_directories()
            hint = self.config().get("drives.slskd_library_share", "") or None
            plan_slskd_config(text, share_old=library_share_in(current, hint) if "library" in dests else None,
                              share_new=dests.get("library"), current_shares=current,
                              downloads_new=dests.get("downloads"),
                              skip_appledouble=choice.get("exfat") == "carry_on")
        except ServiceRefused as exc:
            return str(exc).rstrip(".")
        except (ValueError, OSError) as exc:  # compose_tool.Unsupported and UnicodeDecodeError are ValueErrors
            return str(exc).rstrip(".") or type(exc).__name__
        return None

    def slskd_sign_in(self, move_id: int, username: str, password: str, *, background: bool = False) -> Dict[str, Any]:
        move = self._require(move_id, ("draft",))
        slskd = self._slskd()
        if slskd is None or not slskd.configured():
            raise MoveError("slskd isn't set up in SYNCHRO.S.", 400)
        from core.drives.services import ServiceRefused
        try:
            token = slskd.sign_in(str(username or ""), str(password or ""))
        except ServiceRefused as exc:
            raise MoveError(str(exc), 400, code="slskd_refused") from None
        with self._lock:
            # the sign-in took a moment: keep the session only if Downloads still moves
            now = self.store.row(move["id"])
            if now is None or now["status"] != "draft" or not (now.get("choice") or {}).get("roles", {}).get("downloads") \
                    or not self.store.update(move["id"], expect_status="draft", secret=self.deps.encrypt(token)):
                token = ""
                raise MoveError("Downloads isn't moving any more, so the sign-in wasn't kept.", 409,
                                code="slskd_not_needed")
            token = ""
            name = str(username or "").strip()
            if name:
                self._slskd_user[move["id"]] = name[:80]
            return self.check(move_id, background=background)

    # ── Plan ─────────────────────────────────────────────────────────────────

    def automations_that_move_files(self) -> List[str]:
        try:
            with closing(self.store.conn()) as conn:
                rows = conn.execute("SELECT * FROM automations WHERE enabled = 1").fetchall()
        except Exception:  # noqa: BLE001
            return []
        names = []
        for r in rows:
            d = dict(r)
            if d.get("is_system"):
                continue
            if d.get("action_type") in holds.MOVES_FILES:
                names.append(str(d.get("name") or "an automation"))
        return names

    def plan(self, move_id: int) -> Dict[str, Any]:
        move = self._require(move_id, ("draft",))
        checks = move.get("checks")
        if not checks:
            raise MoveError("Check the drive first.")
        if checks.get("running"):
            raise MoveError("The checks are still running.")
        if not checks.get("ok"):
            raise MoveError("Something in the checks needs fixing first.")
        dests = checks["dests"]
        sizes = checks["sizes"]
        speed = checks.get("speed") or DEFAULT_BPS
        total = sum(s["bytes"] for s in sizes.values())
        files = sum(s["files"] for s in sizes.values())
        order = sorted(dests, key=lambda r: sizes[r]["bytes"])
        target_label = self.label_of(next(iter(dests.values())))
        est = total / max(speed, 1) + files * 0.004
        autos = self.automations_that_move_files()
        sources = self.current_paths()
        plan = {
            "order": order, "dests": dests, "sources": {r: sources[r] for r in dests}, "total_bytes": total,
            "total_files": files, "estimate_seconds": int(est), "checksum_seconds": int(total / max(speed, 1) * 0.5),
            "target_label": target_label, "source_label": self.home_label() if not any(
                disks.drive_root_of(sources[r]) for r in dests) else self.label_of(sources[order[-1]]),
            "automations": autos, "speed": speed,
            "library_paths": self._stored_path_count(sources.get("library")) if "library" in dests else 0,
            "media_label": getattr(self._media(), "label", "") or "",
        }
        self.store.update(move_id, plan=plan)
        return self.store.row(move_id)  # type: ignore[return-value]

    def _stored_path_count(self, root: Optional[str]) -> int:
        if not root:
            return 0
        prefix = root.rstrip("/") + "/"
        try:
            with closing(self.store.conn()) as conn:
                return int(conn.execute("SELECT COUNT(*) FROM tracks WHERE substr(file_path, 1, ?) = ?",
                                        (len(prefix), prefix)).fetchone()[0])
        except Exception:  # noqa: BLE001
            return 0

    # ── Start, copy, check ───────────────────────────────────────────────────

    def start(self, move_id: int, *, checksum: Optional[bool] = None, background: bool = True) -> Dict[str, Any]:
        with self._lock:
            if self.running():
                raise MoveError("A move is already running.")
            move = self._require(move_id, ("draft",))
            if not move.get("plan"):
                raise MoveError("See the plan first.")
            choice = dict(move["choice"])
            if checksum is not None:
                choice["checksum"] = bool(checksum)
            # the places are checked again now: a drive can change between the plan and the press
            dests = self.validated_destinations(choice)
            if dests != move["plan"]["dests"]:
                raise MoveError("Where the folders go changed since the plan. Check again.")
            plan = move["plan"]
            sources = self.current_paths()
            if any(sources[r] != plan["sources"][r] for r in dests):
                raise MoveError("A folder setting changed since the plan. Start again from Choose.")
            for role, src in plan["sources"].items():
                if not os.path.isdir(src):
                    raise MoveError(f"SYNCHRO.S can't see {LABELS[role]} at {src} right now.")
            exfat = choice.get("exfat") == "carry_on"
            t = _now()
            # the manifest: every file that moves, as it is now
            with closing(self.store.conn()) as conn:
                conn.execute("DELETE FROM drive_move_files WHERE move_id = ?", (move_id,))
                conn.commit()
            # a folder that stays is never listed, even if it sits inside one that moves
            # (validated_destinations refuses that; this is the second guard)
            staying = [sources[r] for r in ROLES if r not in dests and sources.get(r)]
            _ids_up.cache_clear()
            for role in plan["order"]:
                skip = SKIP_NAMES
                root = plan["sources"][role]
                real_root = os.path.realpath(root)
                rows = ((rel, st.st_size, st.st_mtime, st.st_mtime_ns)
                        for rel, st in disks.walk_files(root, skip=skip)
                        if not (exfat and os.path.basename(rel).startswith(APPLEDOUBLE_PREFIX))
                        and not (staying and (_inside_any(os.path.join(root, rel), staying)
                                              or _inside_any(os.path.join(real_root, rel), staying))))
                self.store.add_files(move_id, role, rows)
            # the walk takes a while: if the move changed meanwhile, nothing starts
            again = self.store.row(move_id)
            if again is None or again["status"] != "draft" or again.get("choice") != move.get("choice") \
                    or again.get("plan") != move.get("plan") or again.get("updated_at") != move.get("updated_at"):
                self._forget_manifest(move_id)
                raise MoveError("The move changed while SYNCHRO.S listed the files. Check again.")
            counts = self.store.counts(move_id)
            total_files = sum(c["files"] for c in counts.values())
            if not self.store.update(move_id, expect_status="draft", status="copying", choice=choice, started_at=t,
                                     failure=None, progress={"phase": "waiting", "started": t}):
                self._forget_manifest(move_id)
                raise MoveError("The move changed while SYNCHRO.S listed the files. Check again.")
            move = self.store.row(move_id)
            self.store.job_row(move, "running", total=total_files, done=0, note="copying")  # type: ignore[arg-type]
            self._begin(move_id, "copy", background=background)
            return self.store.row(move_id)  # type: ignore[return-value]

    def _forget_manifest(self, move_id: int) -> None:
        with closing(self.store.conn()) as conn:
            conn.execute("DELETE FROM drive_move_files WHERE move_id = ?", (move_id,))
            conn.commit()

    def _begin(self, move_id: int, what: str, *, background: bool) -> None:
        self._stop.clear()
        move = self.store.row(move_id)
        holds.hold(move_id, (move or {}).get("plan", {}).get("target_label", ""))
        self._safe(self.deps.pause_workers)
        args = (move_id, what)
        if background:
            self._thread = threading.Thread(target=self._run, args=args, name="drive-move", daemon=True)
            self._thread.start()
        else:
            self._run(*args)

    @staticmethod
    def _safe(fn: Callable[[], None]) -> None:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            logger.warning("drive move: %s", exc)

    def join(self, timeout: Optional[float] = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout)

    def _run(self, move_id: int, what: str) -> None:
        try:
            if what in ("copy", "resume", "recopy"):
                self._wait_for_writers(move_id)
                self._copy(move_id)
                self._verify(move_id)
                self._switch(move_id)
            elif what == "verify":
                self._verify(move_id)
                self._switch(move_id)
        except Stopped:
            try:
                self._undo_copy(move_id, status="stopped")
            except MoveError as exc:
                self._fail(move_id, Failure("stuck", str(exc)))
        except Failure as f:
            self._fail(move_id, f)
        except Exception as exc:  # noqa: BLE001
            logger.error("drive move failed: %s", exc, exc_info=True)
            self._fail(move_id, Failure("error", "Something went wrong; the log has the details."))
        finally:
            holds.release(move_id)
            self._safe(self.deps.resume_workers)

    def _wait_for_writers(self, move_id: int) -> None:
        deadline = self.deps.clock() + BUSY_WAIT_SECONDS
        while True:
            busy = []
            try:
                busy = list(self.deps.busy() or [])
            except Exception:  # noqa: BLE001
                busy = []
            if not busy or self.deps.clock() > deadline:
                return
            self._progress(move_id, {"phase": "waiting", "waiting_for": busy}, force=True)
            if self._stop.wait(2):
                raise Stopped()

    def _progress(self, move_id: int, fields: Dict[str, Any], *, force: bool = False) -> None:
        with self._lock:
            self._live.update(fields)
            live = dict(self._live)
        t = time.monotonic()
        if force or t - self._last_save >= SAVE_SECONDS:
            self._last_save = t
            move = self.store.row(move_id) or {}
            progress = dict(move.get("progress") or {})
            progress.update(live)
            self.store.update(move_id, progress=progress)

    def live(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._live)

    def _copy(self, move_id: int) -> None:
        move = self.store.row(move_id)
        plan = move["plan"]  # type: ignore[index]
        dests = plan["dests"]
        sources = plan["sources"]
        for dest in dests.values():
            os.makedirs(dest, exist_ok=True)
        self._mark_target(move)  # type: ignore[arg-type]
        counts = self.store.counts(move_id)
        total = sum(c["bytes"] for c in counts.values())
        done_bytes = sum(c["copied_bytes"] for c in counts.values())
        window: List[Tuple[float, int]] = [(time.monotonic(), done_bytes)]
        with self._lock:
            self._live = {"phase": "copying", "copied_bytes": done_bytes, "total_bytes": total, "role": None,
                          "current": None, "speed": None}
        unreadable: List[Dict[str, Any]] = []
        for role in plan["order"]:
            src_root, dst_root = sources[role], dests[role]
            rows = self.store.files(move_id, where="excluded = 0 AND copied = 0")
            rows = [r for r in rows if r["role"] == role]
            pending: List[Tuple[str, str, Dict[str, Any]]] = []
            self._progress(move_id, {"role": role}, force=True)
            for row in rows:
                if self._stop.is_set():
                    self.store.mark(move_id, pending)
                    raise Stopped()
                src = safe_join(src_root, row["rel"])
                dst = safe_join(dst_root, row["rel"])
                if src is None or dst is None:
                    pending.append((role, row["rel"], {"problem": "bad path", "excluded": 1}))
                    continue
                self._progress(move_id, {"current": row["rel"]})

                def on_bytes(n: int) -> None:
                    nonlocal done_bytes
                    done_bytes += n
                    now = time.monotonic()
                    window.append((now, done_bytes))
                    while len(window) > 2 and now - window[0][0] > 20:
                        window.pop(0)
                    span = now - window[0][0]
                    speed = (done_bytes - window[0][1]) / span if span > 1 else None
                    self._progress(move_id, {"copied_bytes": done_bytes, "speed": speed})

                try:
                    # never trust what's already there: a row that isn't marked
                    # copied is copied now, over whatever an earlier try or an
                    # earlier move left (the part file and rename make that safe)
                    st = copy_file(src, dst, dst_root, on_bytes=on_bytes, stop=self._stop)
                    if not isinstance(st, os.stat_result):
                        st = os.lstat(src)
                    # what was copied, so the check and the removal can tell
                    # an old file edited since
                    pending.append((role, row["rel"], {"copied": 1, "problem": None, "size": int(st.st_size),
                                                       "mtime": float(st.st_mtime),
                                                       "mtime_ns": int(st.st_mtime_ns)}))
                except Stopped:
                    self.store.mark(move_id, pending)
                    raise
                except SourceUnreadable as exc:
                    unreadable.append({"role": role, "rel": row["rel"], "why": str(exc)})
                    pending.append((role, row["rel"], {"problem": "unreadable"}))
                except OSError as exc:
                    self.store.mark(move_id, pending)
                    raise self._classify(exc, move, done_bytes, total) from None  # type: ignore[arg-type]
                if len(pending) >= 50:
                    self.store.mark(move_id, pending)
                    self.store.job_row(move, "running", total=sum(c["files"] for c in counts.values()),  # type: ignore[arg-type]
                                       done=self._copied_files(move_id), note="copying")
                    pending = []
            self.store.mark(move_id, pending)
        self._progress(move_id, {"phase": "copied", "current": None, "copied_bytes": done_bytes}, force=True)
        if unreadable:
            raise Failure("unreadable", f"{_plural(len(unreadable), 'file')} on {plan['source_label']} couldn't be "
                                        "read; they may already be damaged.", files=unreadable[:50],
                          count=len(unreadable))

    def _copied_files(self, move_id: int) -> int:
        return sum(c["copied_files"] for c in self.store.counts(move_id).values())

    def _classify(self, exc: OSError, move: Dict[str, Any], done: int, total: int) -> Failure:
        plan = move["plan"]
        label = plan["target_label"]
        at = time.strftime("%H:%M")
        drive = disks.drive_root_of(next(iter(plan["dests"].values())), self.platform())
        gone = drive is not None and not os.path.isdir(drive)
        if exc.errno in (errno.ENOSPC, errno.EDQUOT):
            return Failure("full", f"{label} filled up after {size_words(done)} of {size_words(total)}.",
                           copied=done, total=total, at=at)
        if gone or exc.errno in (errno.ENODEV, errno.ENXIO, errno.EIO, errno.ENOENT):
            return Failure("drive_away", f"{label} disconnected at {at}, after {size_words(done)} of "
                                         f"{size_words(total)}.", copied=done, total=total, at=at)
        return Failure("write", f"Writing to {label} failed after {size_words(done)} ({exc.strerror or exc}).",
                       copied=done, total=total, at=at)

    def _mark_target(self, move: Dict[str, Any]) -> None:
        """A note in the target's parent folder so a later Check knows this
        move made it."""
        parents = {os.path.dirname(d.rstrip("/")) for d in move["plan"]["dests"].values()}
        body = json.dumps({"app": "SYNCHRO.S", "move": move["id"], "made": _now()}).encode("utf-8")
        for parent in parents:
            try:
                path = os.path.join(parent, MOVE_MARK)
                # never through a link, and never over a file already there
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
                try:
                    os.write(fd, body)
                finally:
                    os.close(fd)
            except OSError:
                pass

    def _verify(self, move_id: int) -> None:
        move = self.store.row(move_id)
        plan = move["plan"]  # type: ignore[index]
        checksum = bool(move["choice"].get("checksum"))  # type: ignore[index]
        self.store.update(move_id, status="verifying")
        self.store.job_row(move, "running", total=0, done=0, note="verifying")  # type: ignore[arg-type]
        rows = self.store.files(move_id, where="excluded = 0 AND problem IS NULL")
        total = len(rows)
        with self._lock:
            self._live = {"phase": "verifying", "checked": 0, "total": total, "different": 0, "checksum": checksum}
        mismatched: List[Dict[str, Any]] = []
        pending: List[Tuple[str, str, Dict[str, Any]]] = []
        for i, row in enumerate(rows, 1):
            if self._stop.is_set():
                self.store.mark(move_id, pending)
                raise Stopped()
            src = safe_join(plan["sources"][row["role"]], row["rel"])
            dst = safe_join(plan["dests"][row["role"]], row["rel"])
            why = compare(src, dst, row["size"], checksum=checksum, stop=self._stop, mtime_ns=row.get("mtime_ns"))
            if why:
                mismatched.append({"role": row["role"], "rel": row["rel"], "why": why, "size": row["size"]})
                pending.append((row["role"], row["rel"], {"verified": 0, "problem": why}))
            else:
                pending.append((row["role"], row["rel"], {"verified": 1}))
            if len(pending) >= 200:
                self.store.mark(move_id, pending)
                pending = []
            self._progress(move_id, {"checked": i, "different": len(mismatched)})
        self.store.mark(move_id, pending)
        self._progress(move_id, {"checked": total, "different": len(mismatched), "phase": "verified"}, force=True)
        if mismatched:
            raise Failure("mismatch", f"{_plural(len(mismatched), 'file')} didn't match.", files=mismatched[:50],
                          count=len(mismatched))

    # ── the switch ───────────────────────────────────────────────────────────

    def _switch(self, move_id: int) -> None:
        move = self.store.row(move_id)
        plan = move["plan"]  # type: ignore[index]
        if self._stop.is_set():
            raise Stopped()
        self.store.update(move_id, status="switching")
        self._progress(move_id, {"phase": "switching", "step": "settings"}, force=True)
        result = self._do_switch(move, plan["sources"], plan["dests"], forward=True)  # type: ignore[arg-type]
        self._progress(move_id, {"phase": "switched", "step": "done"}, force=True)
        counts = self.store.counts(move_id)
        t = _now()
        # the slskd session was only for the switch's restart
        self.store.update(move_id, status="switched", switched_at=t, result=result, failure=None, secret=None)
        self._slskd_user.pop(move_id, None)
        self.store.job_row(self.store.row(move_id), "done",  # type: ignore[arg-type]
                           total=sum(c["files"] for c in counts.values()),
                           done=sum(c["verified"] for c in counts.values()), note="switched")
        logger.info("[Drives] Switched to %s; the old copies are kept", plan["target_label"])

    def _do_switch(self, move: Dict[str, Any], old: Dict[str, str], new: Dict[str, str], *, forward: bool,
                   token: Optional[str] = None) -> Dict[str, Any]:
        """Settings and stored paths in one transaction, then slskd and the
        media server; anything going wrong after the transaction undoes the
        lot (the settings, slskd.yml and slskd's restart, the media server's
        new folder). Returns what was done; raises :class:`Failure`."""
        from core.drives.services import RestartRefused, ServiceRefused
        plan = move["plan"]
        target, source = plan.get("target_label") or "the new drive", plan.get("source_label") or "the old drive"
        here = target if forward else source
        before = (move.get("result") or {}) if not forward else {}
        result: Dict[str, Any] = {}
        # 1. markers at the new folders, so the watch reads them as connected at once
        for role, path in new.items():
            write_marker(path, role)
            watch = self._safe_get(self.deps.drive_watch)
            if watch is not None:
                try:
                    watch.remember_written(role, path)
                except Exception:  # noqa: BLE001,S110 - the watch's row is a nicety
                    pass
        # 2. one transaction for the folder settings and every stored path
        #    (it rolls itself back when it fails: then nothing switched)
        updates = {SETTING_KEYS[r]: new[r] for r in new}
        self._transaction(old, new, updates)
        undo_db = lambda: self._transaction(new, old, {SETTING_KEYS[r]: old[r] for r in old})  # noqa: E731
        slskd_before: Optional[str] = None
        restarted = False
        slskd = self._slskd()
        media = self._media()
        added_location: Optional[str] = None
        if token is None and move.get("secret"):
            token = self.deps.decrypt(move["secret"])
        try:
            # 3. slskd: what it shares and where it downloads
            self._progress(move["id"], {"step": "services"}, force=True)
            if slskd is not None and slskd.configured() and ("library" in new or "downloads" in new) \
                    and slskd.can_edit():
                text_before = slskd.read_config()
                text, info = self._slskd_text(slskd, move, text_before, old, new, forward=forward,
                                              before=before.get("slskd") or {})
                result["slskd"] = info
                if text is not None and text != text_before:
                    slskd.write_config(text)
                    slskd_before = text_before
                if "downloads" in new and text is not None:
                    if not token:
                        raise ServiceRefused("slskd needs its sign-in to restart and use the new download folder.")
                    restarted = True  # from here a rollback restarts it again
                    try:
                        slskd.restart(token)
                    except RestartRefused:
                        restarted = False  # it never took the request, so it didn't restart
                        raise
                if text is not None:
                    try:
                        slskd.rescan()
                        result["slskd"]["rescan_at"] = _now()
                    except ServiceRefused as exc:
                        result["slskd"]["rescan_error"] = str(exc)
            elif slskd is not None and slskd.configured() and "library" in new:
                result["slskd"] = {"manual": True}
            # 4. the media server's Music library
            if media is not None and getattr(media, "name", "none") != "none" and "library" in new:
                if not media.api:
                    result["media"] = {"name": media.name, "label": media.label, "state": "manual",
                                       "folder": new["library"]}
                elif forward:
                    locations = media.locations()
                    seen = media.can_see(new["library"])
                    if seen is False:
                        result["media"] = {"name": media.name, "label": media.label, "state": "cant_see",
                                           "folder": new["library"]}
                    else:
                        if new["library"] not in locations:
                            media.add_location(new["library"])
                            added_location = new["library"]
                        old_loc = self._old_media_location(locations, old.get("library"))
                        result["media"] = {"name": media.name, "label": media.label, "state": "added",
                                           "folder": new["library"], "old_location": old_loc,
                                           "added": added_location}
                        media.rescan()
                else:
                    info = before.get("media") or {}
                    if info.get("added"):
                        media.remove_location(info["added"])
                    result["media"] = {**info, "state": "switched_back"}
        except Exception as exc:  # noqa: BLE001 - whatever it was, everything goes back
            why = str(exc).strip() if isinstance(exc, ServiceRefused) else (
                f"Pointing slskd and the media server at {here} went wrong ({type(exc).__name__}).")
            logger.warning("[Drives] Switch failed, switching back: %s", exc, exc_info=not isinstance(exc, ServiceRefused))
            left: List[str] = []
            if slskd_before is not None:
                try:
                    slskd.write_config(slskd_before)
                except Exception as e:  # noqa: BLE001
                    logger.error("couldn't put slskd.yml back: %s", e)
                    left.append("slskd.yml")
            if restarted:
                try:
                    slskd.restart(token)
                except Exception as e:  # noqa: BLE001
                    logger.error("couldn't restart slskd after putting slskd.yml back: %s", e)
                    left.append("slskd's restart")
            if added_location and media is not None:
                try:
                    media.remove_location(added_location)
                except Exception as e:  # noqa: BLE001
                    logger.error("couldn't take the new folder out of the media server: %s", e)
                    left.append(f"{getattr(media, 'label', 'the media server')}'s Music library")
            try:
                undo_db()
            except Exception as e:  # noqa: BLE001
                logger.error("couldn't switch the folder settings back: %s", e, exc_info=True)
                self._safe(self.deps.after_switch)
                raise Failure("stuck", f"{why} SYNCHRO.S couldn't switch its folder settings back, so they may "
                                       f"point at {here}. Nothing has been deleted. Try the switch again.",
                              forward=forward) from None
            self._safe(self.deps.after_switch)
            if forward:
                back = f"So SYNCHRO.S switched back; the copy on {target} is kept."
            else:
                back = f"So SYNCHRO.S stayed on {target}; the old copies on {source} are kept."
            if left:
                back += f" Check {' and '.join(left)} by hand: SYNCHRO.S couldn't put {'it' if len(left) == 1 else 'them'} back."
            if why and why[-1] not in ".!?":
                why += "."
            raise Failure("refused", f"{why} {back}", left=left) from None
        self._safe(self.deps.after_switch)
        result["switched_paths"] = {"old": old, "new": new}
        result["checks"] = self._after_checks(move, new, result)
        return result

    def _slskd_text(self, slskd: Any, move: Dict[str, Any], text_before: str, old: Dict[str, str],
                    new: Dict[str, str], *, forward: bool, before: Dict[str, Any]) -> Tuple[Optional[str], Dict[str, Any]]:
        """The slskd.yml to write (None: leave it, slskd is changed by hand)
        and what to remember. Switching back applies the reverse edit to the
        file as it is now, so edits made since are kept."""
        from core.drives import compose_tool as yaml_blocks
        from core.drives.services import ServiceRefused, library_share_in, plan_slskd_config, reverse_slskd_config
        try:
            if forward:
                current = slskd.shared_directories()
                hint = self.config().get("drives.slskd_library_share", "") or None
                old_share = library_share_in(current, hint) if "library" in new else None
                change = plan_slskd_config(
                    text_before, share_old=old_share, share_new=new.get("library"), current_shares=current,
                    downloads_new=new.get("downloads"), skip_appledouble=move["choice"].get("exfat") == "carry_on")
                return change["text"], {
                    "before_share": old_share, "changed": change["changed"],
                    "downloads_before": yaml_blocks.get_scalar(text_before, ["directories", "downloads"]),
                    "filter_added": "filters" in change["changed"],
                    # kept only for a person to recover by hand, encrypted, never sent out
                    "config_before": self.deps.encrypt(text_before)}
            text = reverse_slskd_config(
                text_before, share_now=old.get("library"), share_before=before.get("before_share"),
                current_shares=slskd.shared_directories(), downloads_before=before.get("downloads_before"),
                restore_downloads="downloads" in new, drop_filter=bool(before.get("filter_added")))
            return text, {"reverted": True}
        except yaml_blocks.Unsupported as exc:
            if "downloads" in new:
                raise ServiceRefused(f"SYNCHRO.S can't change slskd.yml safely ({str(exc).rstrip('.')}).") from None
            return None, {"manual": True, "why": str(exc)}

    @staticmethod
    def _safe_get(fn):
        try:
            return fn()
        except Exception:  # noqa: BLE001
            return None

    def _old_media_location(self, locations: List[str], old_library: Optional[str]) -> Optional[str]:
        from core.drives.services import old_location
        sample: List[str] = []
        try:
            with closing(self.store.conn()) as conn:
                sample = [r[0] for r in conn.execute(
                    "SELECT file_path FROM tracks WHERE file_path IS NOT NULL ORDER BY RANDOM() LIMIT 300").fetchall()]
        except Exception:  # noqa: BLE001,S110 - no sample: only a single folder is matched
            pass
        return old_location(locations, sample)

    def _transaction(self, old: Dict[str, str], new: Dict[str, str], updates: Dict[str, str]) -> None:
        """Rewrite the stored paths under each old folder to the new one and
        save the folder settings, in one transaction."""
        config = self.config()
        db = self.deps.database()
        db_path = getattr(db, "database_path", None)
        cfg_path = getattr(config, "database_path", None)
        same = False
        try:
            same = bool(db_path and cfg_path and os.path.samefile(str(db_path), str(cfg_path)))
        except OSError:
            same = False
        lock = config.save_lock() if hasattr(config, "save_lock") else threading.Lock()
        with lock:
            conn = db._get_connection()
            try:
                if conn.in_transaction:
                    conn.commit()
                conn.execute("BEGIN IMMEDIATE")
                for role in old:
                    rewrite_paths(conn, old[role], new[role])
                if same and hasattr(config, "write_in_transaction"):
                    config.write_in_transaction(conn, updates)
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:  # noqa: BLE001,S110 - the original error is the one to raise
                    pass
                raise
            finally:
                conn.close()
            if same and hasattr(config, "apply_committed"):
                config.apply_committed(updates)
            else:
                # a separate settings database: saved straight after, and
                # undone with the paths if that save fails
                try:
                    with config.batch() if hasattr(config, "batch") else _null():
                        for key, value in updates.items():
                            config.set(key, value)
                except Exception:
                    conn = db._get_connection()
                    try:
                        for role in old:
                            rewrite_paths(conn, new[role], old[role])
                        conn.commit()
                    finally:
                        conn.close()
                    raise

    def _after_checks(self, move: Dict[str, Any], new: Dict[str, str], result: Dict[str, Any]) -> List[Dict[str, Any]]:
        out = []
        plan = move["plan"]
        if "library" in new:
            rows = self.store.files(move["id"], where="role = 'library' AND excluded = 0")
            found = sum(1 for r in rows if (p := safe_join(new["library"], r["rel"])) and os.path.isfile(p))
            out.append({"key": "library", "ok": found == len(rows),
                        "title": f"Library: {found:,} of {len(rows):,} files found", "detail": new["library"],
                        "mono": True})
        s = result.get("slskd") or {}
        if s.get("manual"):
            out.append({"key": "slskd", "ok": False, "title": "slskd still shares the old copies",
                        "detail": "Point slskd's shared folder at the new Library folder in its settings."})
        elif s:
            out.append({"key": "slskd", "ok": not s.get("rescan_error"),
                        "title": f"slskd shares the Library from {plan['target_label']}",
                        "detail": s.get("rescan_error") or "Rescanning what it shares"})
        m = result.get("media") or {}
        if m.get("state") == "added":
            keep = " The old folder stays in it until you remove the old copies, so play counts and ratings carry over." \
                if m.get("old_location") else ""
            out.append({"key": "media", "ok": True, "title": f"{m['label']}'s Music library reads {plan['target_label']}",
                        "detail": keep.strip()})
        elif m.get("state") in ("cant_see", "manual"):
            out.append({"key": "media", "ok": False, "title": f"{m['label']} still reads the old folder",
                        "detail": f"Add {m.get('folder')} to {m['label']}'s Music library in its own settings."})
        n = len(plan.get("automations") or [])
        out.append({"key": "restarted", "ok": True,
                    "title": ("Downloads, imports and " + _plural(n, "automation") if n else "Downloads and imports")
                    + " started again",
                    "detail": f"New downloads land on {self.label_of(new['downloads'])}" if "downloads" in new else ""})
        return out

    # ── stop, fail, carry on ─────────────────────────────────────────────────

    def stop(self, move_id: Optional[int] = None) -> Dict[str, Any]:
        """Stop and undo: a running copy stops and its half-made copy goes;
        a failed one's half-made copy goes."""
        move = self.store.current()
        if move is None or (move_id is not None and move["id"] != move_id):
            raise MoveError("Nothing is being moved right now.")
        if move["status"] == "switching":
            raise MoveError("The switch has started; it finishes in a few seconds.")
        if move["status"] in ("copying", "verifying") and self.running():
            self._stop.set()
            self.join(60)
            return self.store.row(move["id"])  # type: ignore[return-value]
        if move["status"] in ("copying", "verifying", "failed"):
            self._undo_copy(move["id"], status="stopped")
            return self.store.row(move["id"])  # type: ignore[return-value]
        if move["status"] == "draft":
            self.store.update(move["id"], status="stopped", finished_at=_now(), secret=None)
            return self.store.row(move["id"])  # type: ignore[return-value]
        raise MoveError("There's nothing to stop.")

    def _undo_copy(self, move_id: int, *, status: str) -> None:
        """Delete exactly the files this move copied to the new place (never
        by pattern), then the folders it made if they're empty."""
        move = self.store.row(move_id)
        plan = (move or {}).get("plan") or {}
        dests = plan.get("dests") or {}
        in_use = self._in_use(dests)
        if in_use:
            raise MoveError(f"SYNCHRO.S's {LABELS[in_use[0]]} setting points at the copy on "
                            f"{plan.get('target_label') or 'the new drive'}, so it isn't deleted. Try the switch "
                            "again, or set the folders back in Settings first.")
        removed = 0
        for row in self.store.files(move_id):
            dst_root = dests.get(row["role"])
            if not dst_root:
                continue
            dst = safe_join(dst_root, row["rel"])
            for path in (dst, (dst + PART_SUFFIX) if dst else None):
                if path and os.path.lexists(path) and not os.path.islink(path) and os.path.isfile(path) \
                        and within(path, dst_root):
                    try:
                        os.unlink(path)
                        removed += 1
                    except OSError as exc:
                        logger.debug("couldn't remove %s: %s", path, exc)
        for root in dests.values():
            remove_empty_dirs(root, keep_root=False, skip=(MARKER_NAME,))
        for parent in {os.path.dirname(d.rstrip("/")) for d in dests.values()}:
            mark = os.path.join(parent, MOVE_MARK)
            try:
                if os.path.isfile(mark) and not os.path.islink(mark):
                    os.unlink(mark)
                os.rmdir(parent)
            except OSError:
                pass
        self.store.update(move_id, status=status, finished_at=_now(), secret=None)
        self.store.job_row(move, "stopped", total=0, done=0, note=status)  # type: ignore[arg-type]
        logger.info("[Drives] Stopped and undone: %s half-made files removed", removed)

    def _in_use(self, dests: Dict[str, str]) -> List[str]:
        """The roles whose folder setting points at one of ``dests`` now."""
        try:
            now = self.current_paths()
        except Exception:  # noqa: BLE001 - unknown: say in use, so nothing is deleted
            return list(dests)
        return [r for r, d in dests.items() if d and now.get(r) and (now[r] == d or same_folder(now[r], d))]

    def _fail(self, move_id: int, f: Failure) -> None:
        move = self.store.row(move_id) or {}
        plan = move.get("plan") or {}
        in_use = self._in_use(plan.get("dests") or {}) if plan.get("dests") and f.kind != "stuck" else []
        if in_use:
            # the settings point at the new place: never say "nothing switched"
            f = Failure("stuck", f"{f.words} SYNCHRO.S's folder settings point at {plan.get('target_label')} "
                                 "now. Nothing has been deleted. Try the switch again.", **f.extra)
        failure = {"kind": f.kind, "words": f.words, "at": _now(), "source_label": plan.get("source_label"),
                   "target_label": plan.get("target_label"), **f.extra}
        # slskd's session isn't kept through a failure; carrying on asks for it again
        self.store.update(move_id, status="failed", failure=failure, secret=None)
        self._slskd_user.pop(move_id, None)
        self.store.job_row(move, "failed", total=0, done=0, note=f.words[:300])
        logger.warning("[Drives] The move stopped: %s", f.words)

    def _plan_to_carry_on(self, move: Dict[str, Any]) -> Dict[str, Any]:
        plan = move.get("plan")
        if not isinstance(plan, dict) or not plan.get("dests") or not plan.get("sources"):
            raise MoveError("This move has no plan to carry on with. Close it and start again from Choose.", 409,
                            code="no_plan")
        return plan

    def _drive_to_carry_on(self, plan: Dict[str, Any]) -> None:
        for dest in plan["dests"].values():
            drive = disks.drive_root_of(dest, self.platform())
            if drive and not os.path.isdir(drive):
                raise MoveError(f"SYNCHRO.S still can't see {plan['target_label']}. Plug it in, then carry on.")

    def _session_to_carry_on(self, move: Dict[str, Any], username: Optional[str], password: Optional[str]) -> None:
        """Carrying on ends with the switch, and when Downloads moves slskd has
        to restart then: its session was forgotten at the failure, so it's
        asked for again (and kept, encrypted, until the move is done)."""
        slskd = self._slskd()
        if "downloads" not in (move.get("plan") or {}).get("dests", {}) or move.get("secret") \
                or slskd is None or not slskd.configured() or not slskd.can_edit():
            return
        if not username:
            raise MoveError("slskd has to restart to download into the new folder, and only its own sign-in can ask "
                            "for that. Sign in to slskd to carry on.", 409, code="slskd_sign_in")
        from core.drives.services import ServiceRefused
        try:
            token = slskd.sign_in(str(username), str(password or ""))
        except ServiceRefused as exc:
            raise MoveError(str(exc), 400, code="slskd_refused") from None
        if not self.store.update(move["id"], expect_status="failed", secret=self.deps.encrypt(token)):
            raise MoveError("The move has moved on; reload to see where it is.")
        move["secret"] = "kept"
        self._slskd_user[move["id"]] = str(username).strip()[:80]

    def resume(self, move_id: int, *, background: bool = True, username: Optional[str] = None,
               password: Optional[str] = None) -> Dict[str, Any]:
        """Carry on after a failure: check the drive, keep what matches,
        copy the rest."""
        with self._lock:
            if self.running():
                raise MoveError("A move is already running.")
            move = self._require(move_id, ("failed",))
            failure = move.get("failure") or {}
            plan = self._plan_to_carry_on(move)
            self._drive_to_carry_on(plan)
            # only once everything else says yes: a refused carry-on never keeps a session
            self._session_to_carry_on(move, username, password)
            if failure.get("kind") in ("refused", "stuck"):
                self.store.update(move_id, status="verifying", failure=None)
                self.store.job_row(move, "running", note="switching")
                self._begin(move_id, "verify", background=background)
                return self.store.row(move_id)  # type: ignore[return-value]
            # rows that never copied or didn't match get copied again
            with closing(self.store.conn()) as conn:
                conn.execute("UPDATE drive_move_files SET copied = 0, problem = NULL WHERE move_id = ? AND "
                             "excluded = 0 AND (problem IS NOT NULL AND problem != 'unreadable')", (move_id,))
                conn.commit()
            self.store.update(move_id, status="copying", failure=None)
            self.store.job_row(move, "running", note="copying")
            self._begin(move_id, "resume", background=background)
            return self.store.row(move_id)  # type: ignore[return-value]

    def recopy(self, move_id: int, *, background: bool = True, username: Optional[str] = None,
               password: Optional[str] = None) -> Dict[str, Any]:
        """"Copy them again": the files that didn't match, then the check."""
        with self._lock:
            move = self._require(move_id, ("failed",))
            if (move.get("failure") or {}).get("kind") != "mismatch":
                raise MoveError("There's nothing to copy again.")
            plan = self._plan_to_carry_on(move)
            self._drive_to_carry_on(plan)
            self._session_to_carry_on(move, username, password)
            for row in self.store.files(move_id, where="problem IS NOT NULL AND problem != 'unreadable'"):
                src = safe_join(plan["sources"][row["role"]], row["rel"])
                try:
                    st = os.lstat(src) if src else None
                except OSError:
                    st = None
                fields: Dict[str, Any] = {"copied": 0, "verified": 0, "problem": None}
                if st is not None:
                    fields.update(size=int(st.st_size), mtime=float(st.st_mtime))
                dst = safe_join(plan["dests"][row["role"]], row["rel"])
                if dst and os.path.isfile(dst) and not os.path.islink(dst):
                    try:
                        os.unlink(dst)
                    except OSError:
                        pass
                self.store.mark(move_id, [(row["role"], row["rel"], fields)])
            self.store.update(move_id, status="copying", failure=None)
            self.store.job_row(move, "running", note="copying")
            self._begin(move_id, "recopy", background=background)
            return self.store.row(move_id)  # type: ignore[return-value]

    def skip_unreadable(self, move_id: int, *, background: bool = True, username: Optional[str] = None,
                        password: Optional[str] = None) -> Dict[str, Any]:
        """"Carry on without them": the unreadable files stay where they are."""
        with self._lock:
            move = self._require(move_id, ("failed",))
            if (move.get("failure") or {}).get("kind") != "unreadable":
                raise MoveError("There's nothing to leave out.")
            self._drive_to_carry_on(self._plan_to_carry_on(move))
            self._session_to_carry_on(move, username, password)
            with closing(self.store.conn()) as conn:
                conn.execute("UPDATE drive_move_files SET excluded = 1 WHERE move_id = ? AND problem = 'unreadable'",
                             (move_id,))
                conn.commit()
            self.store.update(move_id, status="verifying", failure=None)
            self.store.job_row(move, "running", note="verifying")
            self._begin(move_id, "verify", background=background)
            return self.store.row(move_id)  # type: ignore[return-value]

    def recover_after_restart(self) -> None:
        """A move that was running when SYNCHRO.S stopped didn't finish: say so."""
        move = self.store.current()
        if move is None or move["status"] not in ACTIVE:
            return
        progress = move.get("progress") or {}
        done = int(progress.get("copied_bytes") or 0)
        f = Failure("restart", f"Stopped after {size_words(done)} when SYNCHRO.S restarted.", copied=done,
                    total=int(progress.get("total_bytes") or 0))
        if move["status"] == "switching":
            # the switch is one transaction: whichever side the settings are on is the truth
            sources = (move.get("plan") or {}).get("sources") or {}
            now_paths = self.current_paths()
            if sources and all(now_paths.get(r) != p for r, p in sources.items()):
                self.store.update(move["id"], status="switched", switched_at=_now())
                self.store.job_row(move, "done", note="switched")
                return
        self._fail(move["id"], f)

    # ── Done: remove the old copies, switch back ─────────────────────────────

    def remove_preview(self, move_id: int, plans: Any) -> Dict[str, Any]:
        move = self._require(move_id, ("switched",))
        plan = move["plan"]
        items = []
        for row in self.store.files(move_id, where="verified = 1 AND removed = 0 AND excluded = 0 AND added_after = 0"):
            src = safe_join(plan["sources"][row["role"]], row["rel"])
            if src:
                items.append({"path": src, "size": row["size"], "mtime_ns": row.get("mtime_ns"), "action": "delete",
                              "role": row["role"], "rel": row["rel"],
                              "reason": f"Checked against the copy on {plan['target_label']}"})
        if not items:
            raise MoveError("There are no old copies left to remove.")
        stored = plans.create(REMOVE_TOOL, items, meta={"move_id": move_id, "source_label": plan["source_label"],
                                                        "target_label": plan["target_label"]})
        summary = stored.summary()
        summary["sample"] = [{k: i[k] for k in ("path", "size", "action", "reason", "role", "rel")}
                             for i in summary["sample"]]
        summary["roots"] = self.host_roots(plan)
        summary["platform"] = self.platform()
        return summary

    def host_roots(self, plan: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
        """Each old folder of ``plan`` as the list heads it (125): its
        container path, and its name on the computer when SYNCHRO.S knows it
        (``host_paths``). Display text only; the plan's items, and so what
        Remove deletes, never come from it."""
        platform = self.platform()
        out = {}
        for role, src in (plan.get("sources") or {}).items():
            out[role] = {"role": role, "label": LABELS.get(role, role), "path": src,
                         "drive": plan.get("source_label"), **host_paths.public_fields(src, platform)}
        return out

    def remove_confirm(self, move_id: int, plan_id: str, plans: Any) -> Dict[str, Any]:
        move = self._require(move_id, ("switched",))
        stored = plans.consume(plan_id, REMOVE_TOOL)
        if int(stored.meta.get("move_id") or 0) != int(move_id):
            raise MoveError("That preview belongs to another move.")
        plan = move["plan"]
        # the folders SYNCHRO.S still uses that this move didn't move: nothing in
        # them is deleted, even if one sits inside an old folder
        try:
            now = self.current_paths()
        except Exception as exc:  # noqa: BLE001 - unknown: delete nothing
            raise MoveError("SYNCHRO.S couldn't read its folder settings, so nothing was deleted.") from exc
        live = [p for r, p in now.items() if p and r not in plan["dests"]]
        _ids_up.cache_clear()
        deleted, freed, skipped = 0, 0, 0
        marks: List[Tuple[str, str, Dict[str, Any]]] = []
        for item in stored.items:
            role, rel = item["role"], item["rel"]
            src_root, dst_root = plan["sources"][role], plan["dests"][role]
            src, dst = safe_join(src_root, rel), safe_join(dst_root, rel)
            if not src or not dst or src != item["path"] or (live and (
                    _inside_any(src, live) or _inside_any(os.path.join(os.path.realpath(src_root), rel), live))):
                skipped += 1
                continue
            try:
                st = os.lstat(src)
                dst_st = os.lstat(dst)
            except OSError:
                skipped += 1
                continue
            # only the exact file that was checked (same size, not edited since
            # it was copied), only while its copy is still there, and never
            # when the "copy" is the very same file seen through another mount
            mtime_ns = item.get("mtime_ns")
            if not _stat.S_ISREG(st.st_mode) or st.st_size != int(item["size"]) or not within(src, src_root) \
                    or (mtime_ns is not None and st.st_mtime_ns != int(mtime_ns)) \
                    or not _stat.S_ISREG(dst_st.st_mode) or dst_st.st_size != int(item["size"]) \
                    or os.path.samestat(st, dst_st):
                skipped += 1
                continue
            try:
                os.unlink(src)
                deleted += 1
                freed += int(st.st_size)
                marks.append((role, rel, {"removed": 1}))
            except OSError as exc:
                logger.debug("couldn't remove %s: %s", src, exc)
                skipped += 1
            if len(marks) >= 200:
                self.store.mark(move_id, marks)
                marks = []
        self.store.mark(move_id, marks)
        for root in plan["sources"].values():
            if any(overlaps(root, p) for p in live):
                continue  # a folder in use is inside: its empty folders stay
            remove_empty_dirs(root, keep_root=True, skip=(MARKER_NAME,))
        result = dict(move.get("result") or {})
        media = self._media()
        info = result.get("media") or {}
        if info.get("state") == "added" and info.get("old_location") and media is not None:
            try:
                media.remove_location(info["old_location"])
                info["old_removed"] = True
            except Exception as exc:  # noqa: BLE001
                info["old_remove_error"] = str(exc)
            result["media"] = info
        result["removed"] = {"files": deleted, "bytes": freed, "skipped": skipped, "at": _now()}
        self.store.update(move_id, status="removed", result=result, finished_at=_now(), secret=None)
        logger.info("[Drives] Removed %s old copies (%s skipped)", deleted, skipped)
        return {"deleted": deleted, "freed_bytes": freed, "skipped": skipped}

    def switch_back(self, move_id: int, *, username: Optional[str] = None,
                    password: Optional[str] = None) -> Dict[str, Any]:
        """The switch in reverse: files added at the new place since, and
        files changed there since, are copied back first, then settings,
        paths, slskd and the media server. When Downloads moved, slskd has to
        restart again, which takes its sign-in (asked for now, kept only in
        memory)."""
        with self._lock:
            if self.running():
                raise MoveError("A move is already running.")
            move = self._require(move_id, ("switched",))
            plan = move["plan"]
            new, old = plan["dests"], plan["sources"]
            for role, src in old.items():
                if not os.path.isdir(src):
                    raise MoveError(f"SYNCHRO.S can't see {LABELS[role]}'s old folder ({src}).")
            token = self._switch_back_token(move, username, password)
            holds.hold(move_id, plan["source_label"])
            self._safe(self.deps.pause_workers)
            try:
                rows = {(r["role"], r["rel"]): r for r in self.store.files(move_id)}
                for role, root in new.items():
                    extra = []
                    for rel, st in disks.walk_files(root, skip=SKIP_NAMES):
                        row = rows.get((role, rel))
                        src, dst = safe_join(root, rel), safe_join(old[role], rel)
                        if not src or not dst:
                            continue
                        if row is None:
                            extra.append((rel, st.st_size, st.st_mtime, st.st_mtime_ns))
                            if not os.path.lexists(dst):
                                copy_file(src, dst, old[role], on_bytes=lambda n: None, stop=threading.Event())
                        elif not row["excluded"] and _changed_since(st, row):
                            # edited at the new place since the switch (a retag): that's the newer file
                            copy_file(src, dst, old[role], on_bytes=lambda n: None, stop=threading.Event())
                    self.store.add_files(move_id, role, extra, added_after=True)
                try:
                    result = self._do_switch(move, new, old, forward=False, token=token)
                except Failure as f:
                    raise MoveError(f.words) from None
                self.store.update(move_id, status="switched_back", result={**(move.get("result") or {}),
                                                                           "back": result},
                                  finished_at=_now(), secret=None)
            finally:
                holds.release(move_id)
                self._safe(self.deps.resume_workers)
            return self.store.row(move_id)  # type: ignore[return-value]

    def _switch_back_token(self, move: Dict[str, Any], username: Optional[str], password: Optional[str]) -> str:
        """slskd's session for switching back, when Downloads moved (its
        download folder changes, which needs a restart); else ""."""
        slskd = self._slskd()
        if "downloads" not in move["plan"]["dests"] or slskd is None or not slskd.configured() \
                or not slskd.can_edit():
            return ""
        if not username:
            raise MoveError("slskd has to restart to download into the old folder again, and only its own sign-in "
                            "can ask for that. Sign in to slskd to switch back.", 409, code="slskd_sign_in")
        from core.drives.services import ServiceRefused
        try:
            return slskd.sign_in(str(username), str(password or ""))
        except ServiceRefused as exc:
            raise MoveError(str(exc), 400, code="slskd_sign_in") from None

    def leave(self, move_id: int) -> Dict[str, Any]:
        """Leave a draft (nothing changed) or close a finished move's Done."""
        move = self.store.row(move_id)
        if move is None:
            raise MoveError("That move isn't there.", 404)
        if move["status"] == "draft":
            with self._lock:
                if not self.store.update(move_id, expect_status="draft", status="stopped", finished_at=_now(),
                                         secret=None):
                    raise MoveError("The move has moved on; reload to see where it is.")
            self._slskd_user.pop(move_id, None)
        elif move["status"] == "failed":
            # closing a failed move is Stop and undo: only its half-made copy goes,
            # and not while the folder settings point at it
            with self._lock:
                if self.running():
                    raise MoveError("A move is already running.")
                self._undo_copy(move_id, status="stopped")
            self._slskd_user.pop(move_id, None)
        elif move.get("secret") and move["status"] not in ACTIVE + ("failed",):
            self.store.update(move_id, secret=None)
            self._slskd_user.pop(move_id, None)
        return self.store.row(move_id)  # type: ignore[return-value]

    # ── helpers ──────────────────────────────────────────────────────────────

    def _require(self, move_id: Any, statuses: Tuple[str, ...]) -> Dict[str, Any]:
        try:
            move = self.store.row(int(move_id))
        except (TypeError, ValueError):
            move = None
        if move is None:
            raise MoveError("That move isn't there.", 404)
        if move["status"] not in statuses:
            raise MoveError("The move has moved on; reload to see where it is.")
        return move

    def _slskd(self):
        return self._safe_get(self.deps.slskd)

    def _media(self):
        return self._safe_get(self.deps.media)

    def reminder(self, now: Optional[float] = None) -> Optional[Dict[str, Any]]:
        """Home's nudge: a move switched a week ago whose old copies are kept."""
        move = self.store.current()
        if not move or move["status"] != "switched" or not move.get("switched_at"):
            return None
        t = now if now is not None else self.deps.clock()
        if t - int(move["switched_at"]) < REMIND_SECONDS:
            return None
        plan = move["plan"]
        return {"move_id": move["id"], "source_label": plan["source_label"], "target_label": plan["target_label"],
                "bytes": plan["total_bytes"], "files": plan["total_files"], "switched_at": move["switched_at"]}


class _null:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


# ── files ─────────────────────────────────────────────────────────────────────

PART_SUFFIX = ".synchros-part"


class SourceUnreadable(Exception):
    pass


def copy_file(src: str, dst: str, dst_root: str, *, on_bytes: Callable[[int], None],
              stop: threading.Event) -> os.stat_result:
    """Copy one regular file without following a link at either end; write to
    a part file, sync it, then rename. Returns the source's stat as it was
    copied. Raises :class:`SourceUnreadable` for a source that can't be read,
    OSError for the destination."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(src, flags)
    except OSError as exc:
        raise SourceUnreadable(exc.strerror or str(exc)) from None
    try:
        st = os.fstat(fd)
        if not _stat.S_ISREG(st.st_mode):
            raise SourceUnreadable("not a regular file")
        parent = os.path.dirname(dst)
        os.makedirs(parent, exist_ok=True)
        if not within(parent, dst_root) or os.path.islink(dst):
            raise OSError(errno.EPERM, "the destination leads outside the new folder")
        part = dst + PART_SUFFIX
        out_flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
        out_fd = os.open(part, out_flags, 0o644)
        try:
            while True:
                if stop.is_set():
                    raise Stopped()
                try:
                    chunk = os.read(fd, CHUNK)
                except OSError as exc:
                    raise SourceUnreadable(exc.strerror or str(exc)) from None
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    n = os.write(out_fd, view)
                    view = view[n:]
                on_bytes(len(chunk))
            os.fsync(out_fd)
        finally:
            os.close(out_fd)
        try:
            os.utime(part, ns=(st.st_atime_ns, st.st_mtime_ns))
        except OSError:
            pass
        os.replace(part, dst)
        return st
    except (Stopped, SourceUnreadable):
        try:
            os.unlink(dst + PART_SUFFIX)
        except OSError:
            pass
        raise
    finally:
        os.close(fd)


def _sha256(path: str, stop: threading.Event) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            if stop.is_set():
                raise Stopped()
            chunk = f.read(CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _changed_since(st: os.stat_result, row: Dict[str, Any]) -> bool:
    """Whether a file at the new place differs from what was copied there
    (its size, or its time by more than a FAT drive's rounding)."""
    if int(st.st_size) != int(row["size"]):
        return True
    if row.get("mtime_ns") is None:
        return False
    return abs(int(st.st_mtime_ns) - int(row["mtime_ns"])) > 2_000_000_000


def compare(src: Optional[str], dst: Optional[str], size: int, *, checksum: bool, stop: threading.Event,
            mtime_ns: Optional[int] = None) -> Optional[str]:
    """None when the copy matches, else why not. ``size`` and ``mtime_ns``
    are the old file's as it was copied: an old file changed since (even at
    the same size) doesn't match."""
    if not src or not dst:
        return "bad path"
    try:
        s = os.lstat(src)
    except OSError:
        return "the old file is gone"
    try:
        d = os.lstat(dst)
    except OSError:
        return "missing"
    if not _stat.S_ISREG(d.st_mode):
        return "missing"
    if s.st_size != size or (mtime_ns is not None and s.st_mtime_ns != int(mtime_ns)):
        return "changed since it was copied"
    if d.st_size != size:
        return "different size"
    if checksum:
        try:
            if _sha256(src, stop) != _sha256(dst, stop):
                return "different contents"
        except OSError:
            return "couldn't be read"
    return None


def remove_empty_dirs(root: str, *, keep_root: bool, skip: Tuple[str, ...] = ()) -> int:
    """Remove empty folders under ``root`` from the bottom up (never following
    links). A folder holding only ``skip`` names counts as empty only under
    the root (the root's own marker stays when ``keep_root``)."""
    removed = 0
    if not os.path.isdir(root) or os.path.islink(root):
        return 0
    for dirpath, _dirnames, _filenames in os.walk(root, topdown=False, followlinks=False):
        if dirpath == root:
            continue
        try:
            if not os.listdir(dirpath):
                os.rmdir(dirpath)
                removed += 1
        except OSError:
            continue
    if not keep_root:
        try:
            left = os.listdir(root)
            if all(name in skip for name in left):
                for name in left:
                    p = os.path.join(root, name)
                    if os.path.isfile(p) and not os.path.islink(p):
                        os.unlink(p)
                os.rmdir(root)
                removed += 1
        except OSError:
            pass
    return removed


def rewrite_paths(conn, old_root: str, new_root: str) -> int:
    """Every stored path under ``old_root`` (and ``old_root`` itself) now
    under ``new_root``. Tables that don't exist are skipped."""
    old_root = old_root.rstrip("/")
    new_root = new_root.rstrip("/")
    prefix = old_root + "/"
    changed = 0
    existing = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()}
    for table, column in PATH_COLUMNS:
        if table not in existing:
            continue
        cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in cols:
            continue
        cur = conn.execute(
            f"UPDATE {table} SET {column} = ? || substr({column}, ?) WHERE substr({column}, 1, ?) = ?",
            (new_root + "/", len(prefix) + 1, len(prefix), prefix))
        changed += cur.rowcount or 0
        cur = conn.execute(f"UPDATE {table} SET {column} = ? WHERE {column} = ?", (new_root, old_root))
        changed += cur.rowcount or 0
    return changed


# ── for the routes ────────────────────────────────────────────────────────────

def promise(move: Optional[Dict[str, Any]], home: str) -> Dict[str, str]:
    """The header's line: what has changed so far (always true)."""
    if not move:
        return {"tone": "success", "words": "Nothing has changed yet"}
    plan = move.get("plan") or {}
    src = plan.get("source_label") or home
    dst = plan.get("target_label") or "the new drive"
    status = move["status"]
    if status in ("copying",):
        return {"tone": "info", "words": f"Copying · your music is still on {src}"}
    if status in ("verifying", "switching"):
        return {"tone": "info", "words": f"Checking · your music is still on {src}"}
    if status == "switched":
        return {"tone": "success", "words": f"Switched to {dst} · the old copies are kept"}
    if status == "removed":
        return {"tone": "success", "words": f"Your music lives on {dst}"}
    if status == "switched_back":
        return {"tone": "success", "words": f"Switched back · your music is on {src}"}
    if status == "failed" and (move.get("failure") or {}).get("kind") == "stuck":
        return {"tone": "danger", "words": "The switch didn't finish · nothing was deleted"}
    if status in ("failed", "stopped"):
        return {"tone": "success", "words": f"Nothing switched · your music is on {src}"}
    return {"tone": "success", "words": "Nothing has changed yet"}


def public(job: MoveJob, move: Optional[Dict[str, Any]], *, admin: bool) -> Optional[Dict[str, Any]]:
    """The move as the flow reads it (paths only for admins)."""
    if move is None:
        return None
    out = {k: move.get(k) for k in ("id", "status", "created_at", "updated_at", "started_at", "switched_at",
                                    "finished_at")}
    out["promise"] = promise(move, job.home_label())
    out["choice"] = move.get("choice") or {}
    out["checks"] = move.get("checks")
    out["plan"] = move.get("plan")
    out["failure"] = move.get("failure")
    out["result"] = dict(move.get("result") or {})
    out["has_slskd_session"] = bool(move.get("secret"))
    progress = dict(move.get("progress") or {})
    if move["status"] in ACTIVE and job.running():
        progress.update(job.live())
    counts = job.store.counts(move["id"]) if move["status"] not in ("draft",) else {}
    plan = move.get("plan") or {}
    folders = []
    platform = job.platform() if admin else ""
    for role in plan.get("order") or []:
        c = counts.get(role) or {}
        row = {"role": role, "label": LABELS[role], "source": plan["sources"][role],
               "dest": plan["dests"][role], "files": c.get("files", 0), "bytes": c.get("bytes", 0),
               "copied_files": c.get("copied_files", 0), "copied_bytes": c.get("copied_bytes", 0),
               "verified": c.get("verified", 0)}
        if admin:
            # the computer's names for both ends (display only; host_paths)
            src = host_paths.public_fields(plan["sources"][role], platform)
            dst = host_paths.public_fields(plan["dests"][role], platform)
            row.update(source_host_path=src["host_path"], source_volume=src["volume"],
                       dest_host_path=dst["host_path"], dest_volume=dst["volume"])
        folders.append(row)
    out["folders"] = folders
    if admin and out["result"].get("checks"):
        dests = {v: k for k, v in (plan.get("dests") or {}).items()}
        checks = []
        for c in out["result"]["checks"]:
            c = dict(c)
            if c.get("mono") and c.get("detail") in dests:
                c["detail_host"] = host_paths.public_fields(c["detail"], platform)["host_path"]
            checks.append(c)
        out["result"]["checks"] = checks
    total = sum(f["bytes"] for f in folders)
    copied = progress.get("copied_bytes")
    if copied is None:
        copied = sum(f["copied_bytes"] for f in folders)
    speed = progress.get("speed")
    out["progress"] = {**{k: v for k, v in progress.items() if k not in ("current",)},
                       "current": progress.get("current") if move["status"] == "copying" else None,
                       "copied_bytes": int(copied or 0), "total_bytes": total,
                       "eta_seconds": int((total - copied) / speed) if speed and speed > 0 and total else None}
    if move.get("failure", None) and move["failure"].get("kind") in ("drive_away", "restart", "full"):
        out["failure"]["matching_files"] = sum(f["copied_files"] for f in folders)
    if not admin:
        for f in out["folders"]:
            f.pop("source", None)
            f.pop("dest", None)
    return _scrub(out)


__all__ = ["Deps", "KIND", "MoveError", "MoveJob", "REMOVE_TOOL", "compare", "copy_file", "promise", "public",
           "remove_empty_dirs", "rewrite_paths", "size_words"]
