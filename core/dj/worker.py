"""Work out BPM, key and energy for every library track, in the background.

One job for the install, on its own thread, one track at a time, using Sample
Studio's analyzer (core/sample/analyze.py ``analyze_track``: one decode at
22050 Hz gives BPM, key and energy) and sharing its ``sample_analysis`` row
both ways: a track already analysed in Sample Studio isn't decoded again,
and one the job analyses opens in Sample Studio straight away.

Gentle on a laptop:

* the thread lowers its own CPU priority (nice 10 on Linux, where Docker on a
  Mac runs it; ffmpeg decodes it starts inherit that);
* after each track it rests at least as long as the track took (so it uses
  at most about half of one core) and never less than ``MIN_REST_SECONDS``;
* tracks over 30 minutes or 400 MB are skipped as "too long to analyse", and
  of the rest only the first 10 minutes are decoded (mono at 22050 Hz, about
  53 MB at most); a provisional ``analyzing`` row is written before each
  decode, so a track that took the process down is skipped with that reason
  at the next start instead of crashing every boot;
* it waits while a drive move copies or switches (``core.drives.holds``, and
  the move pauses it), while the Write Tags batch runs (a hook the web server
  registers), while a download batch or an auto-import is running, and while the
  library's drive isn't connected (``core.drives.markers.library_away``),
  saying so in Activity.

Resumable and versioned: every finished track is its own ``track_dj`` row at
``dj_analyzer_version`` (Sample Studio's ``ANALYZER_VERSION``), so a restart
carries on where it stopped and a new analyzer version redoes the library. A
file that isn't there (an unplugged drive, a moved folder) is marked
``unreachable``, not failed, and asked again a day later.

Each sweep is a ``library_jobs`` row (kind ``dj_analysis``), which Activity
shows with progress and Stop, like "Look for releases you don't have". The
scheduler starts a sweep a couple of minutes after boot and then looks for
new tracks every ``SWEEP_INTERVAL_SECONDS``; a sweep only gets a row when it
has tracks to do. Stop ends the sweep and holds the automatic ones until
SYNCHRO.S restarts or someone starts it again (Library → Tracks or Settings).
"""

from __future__ import annotations

import os
import sys
import threading
import time
from contextlib import closing
from typing import Any, Callable, Dict, List, Optional

from utils.logging_config import get_logger

logger = get_logger("dj.worker")

KIND = "dj_analysis"
#: the first automatic sweep waits this long after boot
FIRST_SWEEP_DELAY_SECONDS = 120.0
#: then new tracks are looked for this often
SWEEP_INTERVAL_SECONDS = 30 * 60.0
#: rest after each track: at least this, and at least as long as it took
MIN_REST_SECONDS = 0.5
REST_FACTOR = 1.0
#: how often a wait (download, import, drive away) looks again
WAIT_STEP_SECONDS = 15.0
#: files that weren't there are asked again after this long
UNREACHABLE_RETRY_SECONDS = 24 * 3600.0
#: a finished sweep's result stays in the Tracks header this long
RECENT_SECONDS = 24 * 3600
#: this many failures in a row (not missing files) and the sweep stops
MAX_ERRORS_IN_A_ROW = 25
#: tracks longer than this, or files bigger than this, are skipped as "too
#: long to analyse" (a DJ mix or a whole-album rip): a set's tracks are
#: minutes long, and decoding hours of audio on a laptop is all cost
MAX_SECONDS = 30 * 60.0
MAX_BYTES = 400 * 1024 * 1024
#: and of the tracks it does analyse, only the first 10 minutes are decoded
#: (mono at 22050 Hz: about 53 MB at most)
DECODE_SECONDS = 600.0
TOO_LONG = "too long to analyse"

SETTING_ANALYZE = "library.dj_analysis"
SETTING_WRITE_TAGS = "library.dj_write_tags"
SETTING_OVERWRITE_TAGS = "library.dj_overwrite_tags"


class JobRunning(RuntimeError):
    """A sweep is already going."""


class _Abort(RuntimeError):
    """Something every track would hit (librosa missing): end the sweep."""


def _now() -> int:
    return int(time.time())


def analyzer_version() -> int:
    from core.sample.analyze import ANALYZER_VERSION

    return int(ANALYZER_VERSION)


def _setting(key: str, default: bool) -> bool:
    try:
        from core.settings import config_manager

        value = config_manager.get(key, default)
    except Exception:  # noqa: BLE001 - no config: the default
        return default
    return default if value is None else bool(value)


def settings_state() -> Dict[str, bool]:
    return {"analyze": _setting(SETTING_ANALYZE, True), "write_tags": _setting(SETTING_WRITE_TAGS, False),
            "overwrite_tags": _setting(SETTING_OVERWRITE_TAGS, False)}


# ── what makes it wait ───────────────────────────────────────────────────────

def library_away() -> bool:
    """True while the library's drive isn't connected: the drive watch's last
    look (core.drives.markers). The sweep waits rather than marking every
    file unreachable."""
    from core.drives.markers import library_away as away

    return away()


#: more things the sweep waits for, registered by the web server: each
#: returns a reason word ("tag_write" while the Write Tags batch runs) or None
_busy_hooks: List[Callable[[], Optional[str]]] = []


def register_busy(hook: Callable[[], Optional[str]]) -> None:
    if hook not in _busy_hooks:
        _busy_hooks.append(hook)


def busy_reason(database) -> Optional[str]:
    """``"download"`` while a download batch runs, ``"import"`` while an
    auto-import is processing, a registered hook's word (``"tag_write"``),
    else None."""
    for hook in list(_busy_hooks):
        try:
            word = hook()
        except Exception as exc:  # noqa: BLE001 - unknown: don't wait on it
            logger.debug("busy hook failed: %s", exc)
            word = None
        if word:
            return word
    try:
        from core.activity.feed import snapshot_live_batches

        if snapshot_live_batches():
            return "download"
    except Exception as exc:  # noqa: BLE001 - unknown: don't wait on it
        logger.debug("download state unreadable: %s", exc)
    try:
        cutoff = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(time.time() - 30 * 60))
        with closing(database._get_connection()) as conn:
            row = conn.execute(
                "SELECT 1 FROM auto_import_history WHERE status IN ('processing', 'scanning') "
                "AND created_at >= ? LIMIT 1", (cutoff,)).fetchone()
        if row:
            return "import"
    except Exception as exc:  # noqa: BLE001
        logger.debug("import state unreadable: %s", exc)
    return None


def lower_priority() -> None:
    """Nice this thread (Linux: per thread; elsewhere nothing)."""
    if not sys.platform.startswith("linux"):
        return
    try:
        tid = threading.get_native_id()
        current = os.getpriority(os.PRIO_PROCESS, tid)
        if current < 10:
            os.setpriority(os.PRIO_PROCESS, tid, 10)
    except Exception as exc:  # noqa: BLE001 - not allowed: run at normal priority
        logger.debug("couldn't lower the DJ analysis priority: %s", exc)


# ── one track ────────────────────────────────────────────────────────────────

def _default_resolve(stored: str) -> Optional[str]:
    from core.sample.worker import resolve_track_file

    return resolve_track_file(stored)


def _default_analyze(path: str) -> Dict[str, Any]:
    from core.sample.analyze import analyze_track

    return analyze_track(path, max_seconds=DECODE_SECONDS)


def _too_long(path: str) -> bool:
    """Over the size cap, or over the length cap by the file's own header
    (mutagen reads it without decoding)."""
    try:
        if os.path.getsize(path) > MAX_BYTES:
            return True
    except OSError:
        return False
    try:
        from mutagen import File as MutagenFile

        audio = MutagenFile(path)
        length = float(getattr(getattr(audio, "info", None), "length", 0) or 0)
    except Exception:  # noqa: BLE001 - unreadable header: let the bounded decode try
        return False
    return length > MAX_SECONDS


def library_roots() -> List[str]:
    """The configured library folders a tag write may land in: the library
    (``soulseek.transfer_path``) and ``library.music_paths``."""
    roots: List[str] = []
    try:
        from core.imports.paths import docker_resolve_path
        from core.settings import config_manager

        for raw in [config_manager.get("soulseek.transfer_path", "")] + list(
                config_manager.get("library.music_paths", []) or []):
            if isinstance(raw, dict):
                raw = raw.get("path") or ""
            if raw:
                roots.append(docker_resolve_path(str(raw)))
    except Exception as exc:  # noqa: BLE001 - no config: nowhere is allowed
        logger.debug("library folders unreadable: %s", exc)
    return roots


def write_allowed(stored: str, path: str, roots: List[str]) -> bool:
    """A tag write lands only on the library's own file: the stored path as it
    is, or a resolved path inside a configured library folder, never a copy
    the resolver found in downloads or staging."""
    try:
        real = os.path.realpath(path)
        if stored and os.path.isfile(stored) and os.path.realpath(stored) == real:
            return True
        for root in roots:
            base = os.path.realpath(root)
            if base and (real == base or real.startswith(base.rstrip(os.sep) + os.sep)):
                return True
    except Exception:  # noqa: BLE001
        return False
    return False


def _notify_rescan(count: int) -> None:
    try:
        from core.slskd_share_rescan import notify_library_import

        notify_library_import(count)
    except Exception as exc:  # noqa: BLE001 - sharing catches up on the next import
        logger.debug("slskd rescan note failed: %s", exc)


def _reuse_sample_analysis(track_id: str, sig: Optional[str], version: int) -> Optional[Dict[str, Any]]:
    """Sample Studio's row for this file at this analyzer version, if any."""
    try:
        from core.sample import store as sample_store

        row = sample_store.get_analysis(track_id)
    except Exception:  # noqa: BLE001 - no row
        return None
    if not row or int(row.get("analyzer_version") or 0) < version or row.get("energy") is None:
        return None
    if sig is not None and row.get("source_sig") != sig:
        return None
    return row


def _share_with_sample_studio(track_id: str, result: Dict[str, Any], sig: Optional[str]) -> None:
    try:
        from core.sample import store as sample_store

        sample_store.save_analysis(track_id, result, source_sig=sig)
    except Exception as exc:  # noqa: BLE001 - the DJ row is what matters here
        logger.debug("couldn't share the analysis with Sample Studio: %s", exc)


def process_track(database, track_id: str, *, resolve: Callable[[str], Optional[str]] = _default_resolve,
                  analyze: Callable[[str], Dict[str, Any]] = _default_analyze,
                  write_tags: bool = False, overwrite_tags: bool = False,
                  notify: Callable[[int], None] = _notify_rescan,
                  may_write: Callable[[], bool] = lambda: True,
                  library_roots: Callable[[], List[str]] = library_roots) -> str:
    """Analyse one library track and keep its DJ data. Returns ``done``
    (``tagged`` when BPM or key went into the file too), ``unreachable``,
    ``skipped`` (too long), ``error``, ``deferred`` (a drive move or a tag
    write started before the file could be written: back in the queue) or
    ``stale`` (the file changed during the analysis: back in the queue);
    raises _Abort when analysis can't run at all."""
    from core.dj import store
    from core.dj.tags import read_dj_tags, write_dj_tags
    from core.sample.store import source_signature

    version = analyzer_version()
    row = store.track_row(database, track_id)
    if not row or not row.get("file_path"):
        store.mark(database, track_id, "error", "the track has no file", version)
        return "error"
    stored = str(row["file_path"])
    path = resolve(stored)
    if not path or not os.path.isfile(path):
        store.mark(database, track_id, "unreachable", f"SYNCHRO.S can't open {stored}", version)
        return "unreachable"
    if _too_long(path):
        store.mark(database, track_id, "skipped", TOO_LONG, version)
        return "skipped"
    sig = source_signature(path)
    tags = read_dj_tags(path)
    analysis = _reuse_sample_analysis(track_id, sig, version)
    if analysis is None:
        # written before the decode: a crash inside it is known at the next start
        store.mark(database, track_id, "analyzing", None, version)
        try:
            analysis = analyze(path)
        except ImportError as exc:
            store.requeue(database, track_id, "analysis isn't available")
            raise _Abort(str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - one bad file never stops the sweep
            logger.info("DJ analysis failed for track %s: %s", track_id, exc)
            store.mark(database, track_id, "error", str(exc), version)
            return "error"
        if not analysis.get("truncated"):
            # a whole-file result is Sample Studio's too; a partial one isn't
            _share_with_sample_studio(track_id, analysis, sig)

    if overwrite_tags and write_tags:
        values = store.decide(enrichment_bpm=row.get("bpm"), analysis=analysis)
    else:
        values = store.decide(tag_bpm=tags.get("bpm"), tag_key=tags.get("key"), enrichment_bpm=row.get("bpm"),
                              analysis=analysis)

    written: List[str] = []
    if write_tags and write_allowed(stored, path, library_roots()):
        if not may_write():
            store.requeue(database, track_id, "waited for a drive move or a tag write")
            return "deferred"
        if source_signature(path) != sig:
            # replaced while it was analysed: the values are the old file's
            store.requeue(database, track_id, "the file changed while it was analysed")
            return "stale"
        # an uncertain key is shown with "key uncertain" but never written
        # into a file, where DJ software would trust it
        confident = values["key_source"] != "analysis" or (values["key_confidence"] or 0) >= store.KEY_CONFIDENT
        result = write_dj_tags(path, bpm=values["bpm"], key_name=values["key_name"] if confident else None,
                               overwrite=overwrite_tags)
        written = list(result.get("written") or [])
        if result.get("error") and not written:
            logger.info("BPM and key not written into %s: %s", path, result["error"])
        if written:
            new_sig = source_signature(path)
            # only the tags changed, in this write: Sample Studio's analysis and
            # stems made from the file as it was just before move on with it
            try:
                from core.sample import store as sample_store

                sample_store.update_source_sig(track_id, new_sig, old_sig=sig)
            except Exception as exc:  # noqa: BLE001
                logger.debug("couldn't refresh Sample Studio's signature: %s", exc)
            sig = new_sig
            notify(1)

    values.update(status="done", error=None, dj_analyzer_version=version, dj_analyzed_at=time.time(),
                  source_sig=sig)
    if written:
        values.update(tags_written=",".join(written), tags_written_at=time.time())
    store.save(database, track_id, values)
    return "tagged" if written else "done"


# ── the sweep ────────────────────────────────────────────────────────────────

def _ensure_table(conn) -> None:
    from core.library.missing_releases import ensure_table

    ensure_table(conn)


def _move_holds_writes() -> bool:
    """A drive move is copying or switching (core.drives.holds)."""
    try:
        from core.drives import holds
    except Exception:  # noqa: BLE001 - no drive move on this build
        return False
    return holds.held_by() is not None or bool(holds.move_in_progress())


class DjAnalysisJob:
    """The one sweep at a time. Everything that touches the outside is
    injectable for tests."""

    def __init__(self, *, process: Optional[Callable[..., str]] = None,
                 busy: Optional[Callable[[Any], Optional[str]]] = None,
                 away: Optional[Callable[[], bool]] = None,
                 held: Optional[Callable[[], bool]] = None,
                 settings: Optional[Callable[[], Dict[str, bool]]] = None,
                 sleep_floor: float = MIN_REST_SECONDS, rest_factor: float = REST_FACTOR,
                 wait_step: float = WAIT_STEP_SECONDS) -> None:
        self._process = process or process_track
        self._busy = busy or busy_reason
        self._away = away or library_away
        self._held_fn = held or _move_holds_writes
        #: the drive move paused the job (its pause_workers hook)
        self._paused_for_move = threading.Event()
        #: set while a track is being analysed or written, for the move's busy check
        self._in_track = threading.Event()
        self._settings = settings or settings_state
        self._sleep_floor = sleep_floor
        self._rest_factor = rest_factor
        self._wait_step = wait_step
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._state: Optional[Dict[str, Any]] = None
        #: a person pressed Stop: automatic sweeps wait for a restart or a Start
        self.held = False

    # -- reading --

    def live(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            if self._state and self._state.get("status") == "running":
                return dict(self._state)
            return None

    def running(self) -> bool:
        return self.live() is not None

    # -- the drive move --

    def _held(self) -> bool:
        """True while a drive move copies or switches (its hold), or paused it."""
        if self._paused_for_move.is_set():
            return True
        try:
            return bool(self._held_fn())
        except Exception:  # noqa: BLE001 - unknown: don't hold
            return False

    def pause_for_move(self) -> None:
        """The move's pause_workers: no new track, no write, until resumed."""
        self._paused_for_move.set()

    def resume_after_move(self) -> None:
        self._paused_for_move.clear()

    def busy_words(self) -> List[str]:
        """For the move's "waiting for …": a track mid-analysis or mid-write."""
        return ["BPM/key analysis"] if self._in_track.is_set() else []

    # -- starting and stopping --

    def start(self, database, profile_id: int = 1, *, manual: bool = True,
              background: bool = True) -> Optional[Dict[str, Any]]:
        """Start a sweep over every track that needs DJ data. None when
        there's nothing to do (no row is written then)."""
        from core.dj import store

        with self._lock:
            if self._state and self._state.get("status") == "running":
                raise JobRunning("Already working out BPM, key and energy.")
            if manual:
                self.held = False
            retry = time.time() - (0 if manual else UNREACHABLE_RETRY_SECONDS)
            ids = store.pending_ids(database, analyzer_version(), retry_unreachable_before=retry)
            store.fail_leftover_analyzing(database)
            if not ids:
                return None
            self._stop.clear()
            started = _now()
            with closing(database._get_connection()) as conn:
                _ensure_table(conn)
                conn.execute("UPDATE library_jobs SET status = 'stopped', finished_at = ?, note = 'restart' "
                             "WHERE kind = ? AND status = 'running'", (started, KIND))
                cur = conn.execute(
                    "INSERT INTO library_jobs (kind, profile_id, status, total, started_at) "
                    "VALUES (?, ?, 'running', ?, ?)", (KIND, int(profile_id), len(ids), started))
                conn.commit()
                run_id = int(cur.lastrowid)
            self._state = {"id": run_id, "status": "running", "profile_id": int(profile_id), "total": len(ids),
                           "done": 0, "failed": 0, "unreachable": 0, "skipped": 0, "tags_written": 0, "started_at": started,
                           "waiting": None, "current": None, "manual": bool(manual)}
            state = dict(self._state)
        if background:
            self._thread = threading.Thread(target=self._run, args=(database, ids), name="DjAnalysis", daemon=True)
            self._thread.start()
        else:
            self._run(database, ids)
        return state

    def stop(self, *, by_person: bool = True) -> bool:
        with self._lock:
            if not self._state or self._state.get("status") != "running":
                return False
            if by_person:
                self.held = True
        self._stop.set()
        return True

    def join(self, timeout: Optional[float] = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout)

    # -- the loop --

    def _update(self, **fields) -> None:
        with self._lock:
            if self._state is not None:
                self._state.update(fields)

    def _bump(self, field: str) -> None:
        with self._lock:
            if self._state is not None:
                self._state[field] = int(self._state.get(field) or 0) + 1

    def _save(self, database, *, final: bool = False) -> None:
        with self._lock:
            state = dict(self._state or {})
        if not state:
            return
        try:
            with closing(database._get_connection()) as conn:
                # found_releases / found_artists are the missing-releases job's;
                # here they carry files tagged and files that weren't there
                conn.execute(
                    "UPDATE library_jobs SET status = ?, done = ?, failed = ?, found_releases = ?, "
                    "found_artists = ?, finished_at = ?, note = ? WHERE id = ?",
                    (state["status"], state["done"], state["failed"], state.get("tags_written", 0),
                     state.get("unreachable", 0), state.get("finished_at") if final else None,
                     state.get("note"), state["id"]))
                conn.commit()
        except Exception as exc:  # noqa: BLE001 - Activity reads the live state meanwhile
            logger.warning("couldn't save the DJ analysis run: %s", exc)

    def _wait_reason(self, database) -> Optional[str]:
        if self._away():
            return "drive_away"
        if self._held():
            return "drive_move"
        return self._busy(database)

    def _wait_while_busy(self, database) -> bool:
        """Wait out a download, an import or an unplugged drive. False when
        stopped while waiting."""
        while not self._stop.is_set():
            reason = self._wait_reason(database)
            if reason is None:
                self._update(waiting=None)
                return True
            self._update(waiting=reason)
            if self._stop.wait(self._wait_step):
                break
        self._update(waiting=None)
        return False

    def _run(self, database, ids: List[str]) -> None:
        lower_priority()
        status, note = "done", None
        errors_in_a_row = 0
        try:
            for track_id in ids:
                if self._stop.is_set() or not self._settings().get("analyze", True):
                    status = "stopped"
                    break
                if not self._wait_while_busy(database):
                    status = "stopped"
                    break
                prefs = self._settings()
                self._update(current=track_id)
                started = time.monotonic()
                self._in_track.set()
                try:
                    outcome = self._process(database, track_id, write_tags=prefs.get("write_tags", False),
                                            overwrite_tags=prefs.get("overwrite_tags", False),
                                            may_write=lambda: self._wait_reason(database) is None)
                finally:
                    self._in_track.clear()
                took = time.monotonic() - started
                if outcome in ("done", "tagged"):
                    errors_in_a_row = 0
                    self._bump("done")
                    if outcome == "tagged":
                        self._bump("tags_written")
                elif outcome == "unreachable":
                    self._bump("unreachable")
                elif outcome == "skipped":
                    self._bump("skipped")
                elif outcome in ("deferred", "stale"):
                    pass  # back in the queue for the next sweep
                else:
                    errors_in_a_row += 1
                    self._bump("failed")
                    if errors_in_a_row >= MAX_ERRORS_IN_A_ROW:
                        status, note = "failed", f"{MAX_ERRORS_IN_A_ROW} tracks in a row couldn't be analysed"
                        break
                self._save(database)
                if self._stop.wait(max(self._sleep_floor, took * self._rest_factor)):
                    status = "stopped"
                    break
        except _Abort as exc:
            logger.error("DJ analysis can't run: %s", exc)
            status, note = "failed", str(exc)[:300]
        except Exception as exc:  # noqa: BLE001 - a broken sweep says so in Activity
            logger.error("DJ analysis sweep failed: %s", exc, exc_info=True)
            status, note = "failed", "Something went wrong; the log has the details."
        self._update(status=status, note=note, finished_at=_now(), current=None, waiting=None)
        self._save(database, final=True)
        with self._lock:
            state = dict(self._state or {})
        logger.info("[Library] DJ analysis %s: %s done, %s failed, %s unreachable, %s tagged", status,
                    state.get("done"), state.get("failed"), state.get("unreachable"), state.get("tags_written"))


JOB = DjAnalysisJob()


# ── the scheduler ────────────────────────────────────────────────────────────

_scheduler: Optional[threading.Thread] = None
_scheduler_stop = threading.Event()


def _scheduler_loop(get_database: Callable[[], Any], first_delay: float, interval: float) -> None:
    if _scheduler_stop.wait(first_delay):
        return
    while not _scheduler_stop.is_set():
        try:
            if settings_state()["analyze"] and not JOB.held and not JOB.running():
                JOB.start(get_database(), 1, manual=False)
        except JobRunning:
            pass
        except Exception as exc:  # noqa: BLE001 - try again next interval
            logger.warning("couldn't start the DJ analysis sweep: %s", exc)
        if _scheduler_stop.wait(interval):
            return


def start_scheduler(get_database: Callable[[], Any], *, first_delay: float = FIRST_SWEEP_DELAY_SECONDS,
                    interval: float = SWEEP_INTERVAL_SECONDS) -> bool:
    """Start the automatic sweeps (start_runtime_services). Idempotent."""
    global _scheduler
    if _scheduler is not None and _scheduler.is_alive():
        return False
    _scheduler_stop.clear()
    _scheduler = threading.Thread(target=_scheduler_loop, args=(get_database, first_delay, interval),
                                  name="DjAnalysisScheduler", daemon=True)
    _scheduler.start()
    return True


def stop_scheduler() -> None:
    _scheduler_stop.set()


# ── reading for the routes and Activity ──────────────────────────────────────

def last_run(database) -> Optional[Dict[str, Any]]:
    try:
        with closing(database._get_connection()) as conn:
            _ensure_table(conn)
            row = conn.execute("SELECT * FROM library_jobs WHERE kind = ? ORDER BY id DESC LIMIT 1",
                               (KIND,)).fetchone()
    except Exception as exc:  # noqa: BLE001
        logger.debug("library jobs unreadable: %s", exc)
        return None
    return dict(row) if row else None


def public_state(database, job: DjAnalysisJob = JOB, *, now: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """The running sweep, else the last one (``recent`` within a day)."""
    live = job.live()
    if live:
        return {k: live.get(k) for k in ("id", "status", "total", "done", "failed", "unreachable", "skipped",
                                         "tags_written", "started_at", "waiting", "current")} | {"recent": True}
    row = last_run(database)
    if not row:
        return None
    if row["status"] == "running":
        row = {**row, "status": "stopped", "note": "restart"}
    t = int(now if now is not None else _now())
    return {"id": row["id"], "status": row["status"], "total": row["total"], "done": row["done"],
            "failed": row["failed"], "tags_written": row.get("found_releases") or 0,
            "unreachable": row.get("found_artists") or 0, "started_at": row["started_at"],
            "finished_at": row.get("finished_at"), "note": row.get("note"),
            "recent": bool(row.get("finished_at")) and t - int(row.get("finished_at") or 0) < RECENT_SECONDS}


__all__ = ["DECODE_SECONDS", "JOB", "JobRunning", "KIND", "MAX_BYTES", "MAX_SECONDS", "DjAnalysisJob", "busy_reason",
           "library_away", "library_roots", "process_track", "public_state", "register_busy", "settings_state",
           "start_scheduler", "stop_scheduler", "write_allowed"]
