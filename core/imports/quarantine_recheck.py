"""Ask AcoustID about everything already in quarantine, in the background.

Files quarantined before the pipeline asked AcoustID about a length mismatch
(core.imports.quarantine_facts) only have their reason text. This job listens
to each held file once: it fingerprints it, asks AcoustID, measures whether it
plays to the end, and writes the answer into the file's sidecar ``facts``. The
verdict (core.imports.quarantine_verdict) is read from the sidecar, so the
entry is re-classified, and the shared snapshot gets the new record at once.

* **Rate limited.** At most one AcoustID request every ``INTERVAL`` seconds
  (AcoustID allows three a second; every lookup also goes through
  core.acoustid_api's own pacing).
* **Low priority.** One file at a time, on one thread, and after each file a
  pause as long as the file took (at least ``MIN_PAUSE``, at most
  ``MAX_PAUSE``), so on a slow disk it gives way in proportion. It never
  imports, moves or deletes anything.
* **Light.** Per file: the header's length (mutagen) and a fingerprint
  (fpcalc reads only the first two minutes). The full ffmpeg decode that
  tells whether a file plays to the end is off unless
  ``quarantine.recheck_decode`` is on; without it "plays to the end" stays
  unknown. Expect about 2–4 s per file with the pause (1–1.5 s of work on a
  slow mount, the pause as long again, a 0.3–0.5 s lookup): 2,568 files take
  roughly 1.5–3 hours.
* **One at a time across processes.** A lease row in the database (owner
  host:pid and a heartbeat) lets one process run it; pause and cancel are
  read from the stored state on every file, so they reach it from any worker.
* **Resumable.** Each file's answer is in its sidecar, so a file that has one
  is skipped. The job's own state (running, paused, the counts) is kept in the
  database, and a job that was running when the server stopped starts again
  (``resume_if_interrupted``).
* **Pause, resume, cancel**, and progress: done / total, confirmed, a
  different song, no match.
* **A refused key stops it**, and is remembered (until the key changes) so the
  page can say so.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from utils.logging_config import get_logger

logger = get_logger("imports.quarantine_recheck")

#: seconds between AcoustID requests (AcoustID allows three a second)
INTERVAL = 0.34
#: the pause after each file: as long as the file took, within these bounds
MIN_PAUSE = 1.0
MAX_PAUSE = 10.0
#: a lease not renewed for this long is taken for a dead process's
LEASE_STALE = 120.0
#: the setting that turns the full decode ("plays to the end") on
DECODE_SETTING = "quarantine.recheck_decode"
#: the database metadata key holding the job's state
STATE_KEY = "quarantine_recheck_state"
#: the decisions that count as answered (an error is tried again next run)
ANSWERED = ("pass", "fail", "skip")


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def key_fingerprint(key: str) -> str:
    """A short hash of the AcoustID key: tells a changed key apart without
    keeping the key."""
    return hashlib.sha256(str(key or "").encode("utf-8")).hexdigest()[:12] if key else ""


class DbStateStore:
    """The job's state in the database's metadata table."""

    def get(self) -> Dict[str, Any]:
        try:
            from database.music_database import MusicDatabase
            raw = MusicDatabase().get_metadata(STATE_KEY)
            value = json.loads(raw) if raw else {}
            return value if isinstance(value, dict) else {}
        except Exception as exc:  # noqa: BLE001
            logger.debug("recheck state unreadable: %s", exc)
            return {}

    def set(self, state: Dict[str, Any]) -> None:
        try:
            from database.music_database import MusicDatabase
            MusicDatabase().set_metadata(STATE_KEY, json.dumps(state))
        except Exception as exc:  # noqa: BLE001
            logger.debug("recheck state not saved: %s", exc)


def _me() -> str:
    import socket
    return f"{socket.gethostname()}:{os.getpid()}"


class DbLease:
    """Who runs the re-check: one row, taken atomically, renewed by a
    heartbeat; a row not renewed for ``LEASE_STALE`` seconds can be taken."""

    def __init__(self, owner: Optional[str] = None, clock: Callable[[], float] = time.time,
                 connect: Optional[Callable[[], Any]] = None) -> None:
        self.owner = owner or _me()
        self.clock = clock
        self.connect = connect

    def _conn(self):
        if self.connect is not None:
            conn = self.connect()
        else:
            from database.music_database import MusicDatabase
            conn = MusicDatabase()._get_connection()
        conn.execute("CREATE TABLE IF NOT EXISTS quarantine_recheck_lease ("
                     "id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT, heartbeat REAL)")
        return conn

    def acquire(self) -> bool:
        now = self.clock()
        conn = self._conn()
        try:
            conn.execute("INSERT OR IGNORE INTO quarantine_recheck_lease (id, owner, heartbeat) "
                         "VALUES (1, ?, ?)", (self.owner, now))
            conn.execute("UPDATE quarantine_recheck_lease SET owner = ?, heartbeat = ? "
                         "WHERE id = 1 AND (owner = ? OR owner IS NULL OR heartbeat < ?)",
                         (self.owner, now, self.owner, now - LEASE_STALE))
            conn.commit()
            row = conn.execute("SELECT owner FROM quarantine_recheck_lease WHERE id = 1").fetchone()
            return bool(row) and row[0] == self.owner
        finally:
            conn.close()

    def renew(self) -> bool:
        conn = self._conn()
        try:
            cur = conn.execute("UPDATE quarantine_recheck_lease SET heartbeat = ? "
                               "WHERE id = 1 AND owner = ?", (self.clock(), self.owner))
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()

    def release(self) -> None:
        conn = self._conn()
        try:
            conn.execute("UPDATE quarantine_recheck_lease SET owner = NULL "
                         "WHERE id = 1 AND owner = ?", (self.owner,))
            conn.commit()
        finally:
            conn.close()

    def held_elsewhere(self) -> bool:
        """Another live process runs it."""
        conn = self._conn()
        try:
            row = conn.execute("SELECT owner, heartbeat FROM quarantine_recheck_lease "
                               "WHERE id = 1").fetchone()
        finally:
            conn.close()
        return bool(row and row[0] and row[0] != self.owner
                    and (row[1] or 0) >= self.clock() - LEASE_STALE)


class LocalLease:
    """A lease for one process (tests, tools)."""

    def __init__(self) -> None:
        self.holder: Optional[str] = None

    def acquire(self) -> bool:
        if self.holder in (None, "me"):
            self.holder = "me"
            return True
        return False

    def renew(self) -> bool:
        return self.holder == "me"

    def release(self) -> None:
        if self.holder == "me":
            self.holder = None

    def held_elsewhere(self) -> bool:
        return self.holder not in (None, "me")


def _current_key() -> str:
    try:
        from core.settings import config_manager
        return str(config_manager.get("acoustid.api_key", "") or "")
    except Exception:  # noqa: BLE001
        return ""


def note_key_refused(store: Any = None) -> None:
    """AcoustID refused the key (seen by the pipeline or the job)."""
    store = store or DbStateStore()
    state = store.get()
    state["key_refused"] = key_fingerprint(_current_key()) or "unknown"
    store.set(state)


def key_refused(state: Dict[str, Any]) -> bool:
    """Whether the key now configured is the one AcoustID refused."""
    refused = state.get("key_refused")
    return bool(refused) and refused in (key_fingerprint(_current_key()), "unknown")


def needs_recheck(record: Any) -> bool:
    """A held file AcoustID hasn't answered for yet."""
    explained = (getattr(record, "entry", None) or {}).get("explained") or {}
    acoustid = explained.get("acoustid") or {}
    return acoustid.get("decision") not in ANSWERED


def _write_sidecar_facts(quarantine_dir: str, filename: str, facts: Dict[str, Any]) -> Dict[str, Any]:
    """Merge ``facts`` into the entry's sidecar (written whole, then swapped
    in), and hand the snapshot the new record. Returns the sidecar."""
    from core.imports.quarantine import _entry_id_from_filename, read_sidecar
    from core.imports.quarantine_index import shared_index

    entry_id = _entry_id_from_filename(filename)
    sidecar = read_sidecar(quarantine_dir, entry_id)
    merged = dict(sidecar.get("facts") or {}) if isinstance(sidecar.get("facts"), dict) else {}
    merged.update({k: v for k, v in facts.items() if v is not None})
    sidecar["facts"] = merged
    path = os.path.join(quarantine_dir, f"{entry_id}.json")
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(sidecar, f, indent=2, ensure_ascii=False)
    if not os.path.exists(os.path.join(quarantine_dir, filename)):
        # approved or deleted while it was being listened to: no orphan sidecar
        os.remove(tmp)
        return {}
    os.replace(tmp, path)
    shared_index().replace(quarantine_dir, filename, sidecar)
    return sidecar


def _decode_enabled() -> bool:
    try:
        from core.settings import config_manager
        return bool(config_manager.get(DECODE_SETTING, False))
    except Exception:  # noqa: BLE001
        return False


def check_one(quarantine_dir: str, record: Any, *, verifier: Any = None,
              probe: Optional[Callable[[str], float]] = None,
              decode: Optional[bool] = None) -> Dict[str, Any]:
    """Listen to one held file: its facts (AcoustID's answer included, when
    it gave one), written into its sidecar. The full decode ("plays to the
    end") only with ``decode`` (default: the setting, off)."""
    from core.imports.quarantine_facts import acoustid_facts, audio_facts

    path = os.path.join(quarantine_dir, record.filename)
    facts = audio_facts(path, probe=probe, decode=_decode_enabled() if decode is None else decode)
    sidecar_facts = ((getattr(record, "entry", None) or {}).get("explained") or {})
    expected_s = sidecar_facts.get("expected_s")
    answer = acoustid_facts(path, record.expected_track, record.expected_artist, expected_s,
                            verifier=verifier)
    if answer is not None:
        facts["acoustid"] = answer
    # the header's length is what the check compared: keep the one recorded
    if sidecar_facts.get("actual_s"):
        facts.pop("actual_s", None)
    _write_sidecar_facts(quarantine_dir, record.filename, facts)
    return facts


@dataclass
class RecheckDeps:
    """What the job uses, swappable in tests."""

    records: Callable[[], List[Any]]
    quarantine_dir: Callable[[], str]
    check: Callable[[str, Any], Dict[str, Any]] = check_one
    available: Callable[[], tuple] = field(default=lambda: _acoustid_available())
    store: Any = field(default_factory=DbStateStore)
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    interval: float = INTERVAL
    lease: Any = field(default_factory=DbLease)
    min_pause: float = MIN_PAUSE
    max_pause: float = MAX_PAUSE


def _acoustid_available() -> tuple:
    try:
        from core.acoustid_verification import AcoustIDVerification
        return AcoustIDVerification().quick_check_available()
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


class RecheckJob:
    """One re-check at a time per process."""

    def __init__(self, deps: RecheckDeps) -> None:
        self.deps = deps
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._pause = threading.Event()
        self._cancel = threading.Event()
        self._last_request = None  # deps.clock() of the last lookup

    # ── state ──────────────────────────────────────────────────────────────

    def status(self) -> Dict[str, Any]:
        state = self.deps.store.get()
        running = self._thread is not None and self._thread.is_alive()
        out = {
            "status": state.get("status", "idle"),
            "total": int(state.get("total") or 0),
            "done": int(state.get("done") or 0),
            "confirmed": int(state.get("confirmed") or 0),
            "different": int(state.get("different") or 0),
            "no_match": int(state.get("no_match") or 0),
            "errors": int(state.get("errors") or 0),
            "started_at": state.get("started_at"),
            "updated_at": state.get("updated_at"),
            "key_refused": key_refused(state),
            "active": running,
        }
        if out["status"] in ("running", "paused") and not running:
            try:
                elsewhere = self.deps.lease.held_elsewhere()
            except Exception:  # noqa: BLE001
                elsewhere = False
            if elsewhere:
                out["active"] = True  # another worker runs it
            else:
                out["status"] = "interrupted"
        return out

    def _save(self, **changes: Any) -> Dict[str, Any]:
        with self._lock:
            state = self.deps.store.get()
            state.update(changes)
            state["updated_at"] = _now()
            self.deps.store.set(state)
            return state

    # ── control ────────────────────────────────────────────────────────────

    def start(self, *, resume: bool = False) -> Dict[str, Any]:
        """Start (or, with ``resume``, carry on after a restart). A job already
        running is left alone."""
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return {"started": False, "reason": "already_running"}
        ok, why = self.deps.available()
        if not ok:
            return {"started": False, "reason": "acoustid_unavailable", "detail": why}
        if not self.deps.lease.acquire():
            return {"started": False, "reason": "running_elsewhere"}
        pending = [r for r in self.deps.records() if needs_recheck(r)]
        state = self.deps.store.get()
        if resume and state.get("status") in ("running", "paused"):
            done = int(state.get("done") or 0)
            self._save(status="running", total=done + len(pending))
        else:
            self._save(status="running", total=len(pending), done=0, confirmed=0, different=0,
                       no_match=0, errors=0, started_at=_now(), key_refused=None)
        self._pause.clear()
        self._cancel.clear()
        thread = threading.Thread(target=self._run, args=(pending,), daemon=True,
                                  name="quarantine-recheck")
        with self._lock:
            self._thread = thread
        thread.start()
        return {"started": True, "total": len(pending)}

    def pause(self) -> None:
        self._pause.set()
        self._save(status="paused")

    def resume(self) -> Dict[str, Any]:
        mine = self._thread is not None and self._thread.is_alive()
        if mine or self.deps.lease.held_elsewhere():
            # the running loop reads the stored state on every file
            self._pause.clear()
            self._save(status="running")
            return {"started": True}
        return self.start(resume=True)

    def cancel(self) -> None:
        self._cancel.set()
        self._pause.clear()
        self._save(status="cancelled")

    def wait(self, timeout: Optional[float] = None) -> None:
        thread = self._thread
        if thread is not None:
            thread.join(timeout)

    # ── the work ───────────────────────────────────────────────────────────

    def _pace(self) -> None:
        if self._last_request is not None:
            wait = self.deps.interval - (self.deps.clock() - self._last_request)
            if wait > 0:
                self.deps.sleep(wait)
        self._last_request = self.deps.clock()

    def _stored_status(self) -> str:
        return str(self.deps.store.get().get("status") or "")

    def _held(self) -> bool:
        """Paused here or from another worker (the stored state)."""
        return self._pause.is_set() or self._stored_status() == "paused"

    def _cancelled(self) -> bool:
        return self._cancel.is_set() or self._stored_status() == "cancelled"

    def _run(self, pending: List[Any]) -> None:
        try:
            self._work(pending)
        finally:
            try:
                self.deps.lease.release()
            except Exception as exc:  # noqa: BLE001 - goes stale on its own
                logger.debug("re-check lease release failed: %s", exc)

    def _work(self, pending: List[Any]) -> None:
        folder = self.deps.quarantine_dir()
        for index, record in enumerate(pending):
            held_ticks = 0
            while self._held() and not self._cancelled():
                # keep the lease while paused, without a write every tick
                if held_ticks % 60 == 0:
                    self.deps.lease.renew()
                held_ticks += 1
                self.deps.sleep(0.5)
            if self._cancelled():
                return
            if not self.deps.lease.renew():
                logger.warning("[Quarantine re-check] another process took it over: stopped here")
                return
            if not os.path.exists(os.path.join(folder, record.filename)):
                self._bump(errors=0)  # gone meanwhile: counted as done
                continue
            self._pace()
            started = self.deps.clock()
            try:
                facts = self.deps.check(folder, record)
            except Exception as exc:  # noqa: BLE001 - one bad file never stops the job
                logger.debug("re-check failed for %s: %s", record.filename, exc)
                self._bump(errors=1)
                facts = None
            took = self.deps.clock() - started
            if facts is not None:
                answer = facts.get("acoustid") if isinstance(facts, dict) else None
                if isinstance(answer, dict) and answer.get("invalid_key"):
                    note_key_refused(self.deps.store)
                    self._save(status="key_refused")
                    logger.warning("[Quarantine re-check] AcoustID refused the key: stopped")
                    return
                decision = (answer or {}).get("decision")
                self._bump(confirmed=int(decision == "pass"), different=int(decision == "fail"),
                           no_match=int(decision == "skip"),
                           errors=int(decision not in ("pass", "fail", "skip")))
            if index < len(pending) - 1:
                # low priority: give way for as long as the file took
                self.deps.sleep(max(self.deps.min_pause, min(took, self.deps.max_pause)))
        if not self._cancelled():
            self._save(status="done")

    def _bump(self, **counts: int) -> None:
        with self._lock:
            state = self.deps.store.get()
            state["done"] = int(state.get("done") or 0) + 1
            for key, value in counts.items():
                state[key] = int(state.get(key) or 0) + value
            state["updated_at"] = _now()
            self.deps.store.set(state)


_shared: Optional[RecheckJob] = None
_shared_lock = threading.Lock()


def shared_job(config_manager: Any = None) -> RecheckJob:
    """The process's job, reading the shared quarantine snapshot."""
    global _shared
    with _shared_lock:
        if _shared is None:
            from core.imports.quarantine_index import quarantine_dir_for, shared_index

            def folder() -> str:
                if config_manager is not None:
                    return quarantine_dir_for(config_manager)
                from core.settings import config_manager as cm
                return quarantine_dir_for(cm)

            _shared = RecheckJob(RecheckDeps(
                records=lambda: list(shared_index().wait(folder()).records),
                quarantine_dir=folder,
            ))
        return _shared


def resume_if_interrupted(config_manager: Any = None, *, tries_left: int = 3,
                          schedule: Optional[Callable[[float, Callable[[], Any]], Any]] = None) -> bool:
    """Start again a job that was running when the server stopped.

    The stopped process's lease only goes stale LEASE_STALE seconds after its
    last heartbeat, so a quick restart can find it still held: try again once
    it has gone stale (a few times, then leave it to the page's Resume)."""
    job = shared_job(config_manager)
    state = job.deps.store.get()
    if state.get("status") != "running":
        return False
    result = job.start(resume=True)
    logger.info("[Quarantine re-check] resumed after a restart: %s", result)
    if result.get("reason") == "running_elsewhere" and tries_left > 0:
        def _again() -> None:
            try:
                resume_if_interrupted(config_manager, tries_left=tries_left - 1, schedule=schedule)
            except Exception as exc:  # noqa: BLE001 - the page's Resume still works
                logger.debug("re-check resume retry failed: %s", exc)
        if schedule is None:
            timer = threading.Timer(LEASE_STALE + 5, _again)
            timer.daemon = True
            timer.start()
        else:
            schedule(LEASE_STALE + 5, _again)
    return bool(result.get("started"))


__all__ = ["DECODE_SETTING", "INTERVAL", "DbLease", "LocalLease", "MAX_PAUSE", "MIN_PAUSE",
           "RecheckDeps", "RecheckJob", "check_one", "key_refused",
           "needs_recheck", "note_key_refused", "resume_if_interrupted", "shared_job"]
