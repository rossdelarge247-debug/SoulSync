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
* **Low priority.** One file at a time, on one thread, with a pause between
  files; it never imports, moves or deletes anything.
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
    os.replace(tmp, path)
    shared_index().replace(quarantine_dir, filename, sidecar)
    return sidecar


def check_one(quarantine_dir: str, record: Any, *, verifier: Any = None,
              probe: Optional[Callable[[str], float]] = None) -> Dict[str, Any]:
    """Listen to one held file: its facts (AcoustID's answer included, when
    it gave one), written into its sidecar."""
    from core.imports.quarantine_facts import acoustid_facts, audio_facts

    path = os.path.join(quarantine_dir, record.filename)
    facts = audio_facts(path, probe=probe)
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
        if self._thread is not None and self._thread.is_alive():
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

    def _run(self, pending: List[Any]) -> None:
        folder = self.deps.quarantine_dir()
        for record in pending:
            while self._pause.is_set() and not self._cancel.is_set():
                self.deps.sleep(0.2)
            if self._cancel.is_set():
                return
            if not os.path.exists(os.path.join(folder, record.filename)):
                self._bump(errors=0)  # gone meanwhile: counted as done
                continue
            self._pace()
            try:
                facts = self.deps.check(folder, record)
            except Exception as exc:  # noqa: BLE001 - one bad file never stops the job
                logger.debug("re-check failed for %s: %s", record.filename, exc)
                self._bump(errors=1)
                continue
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
        if not self._cancel.is_set():
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


def resume_if_interrupted(config_manager: Any = None) -> bool:
    """Start again a job that was running when the server stopped."""
    job = shared_job(config_manager)
    state = job.deps.store.get()
    if state.get("status") != "running":
        return False
    result = job.start(resume=True)
    logger.info("[Quarantine re-check] resumed after a restart: %s", result)
    return bool(result.get("started"))


__all__ = ["INTERVAL", "RecheckDeps", "RecheckJob", "check_one", "key_refused",
           "needs_recheck", "note_key_refused", "resume_if_interrupted", "shared_job"]
