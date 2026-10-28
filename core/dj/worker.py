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

Auto-mix stage A: the same decode also gives each track's beat grid,
downbeats, phrases, sections and mix regions (core/dj/grid.py, kept in
``track_grid`` by core/dj/grid_store.py). A track whose BPM, key and energy
are already done at this version isn't analysed again: the sweep only decodes
it for the grid (the "top-up", for tracks analysed before grids existed or
before a new ``GRID_VERSION``), using its BPM as the tempo to look near. A
grid that fails or finds no beat never costs the track its DJ data.

Each sweep is a ``library_jobs`` row (kind ``dj_analysis``), which Activity
shows with progress and Stop, like "Look for releases you don't have". The
scheduler starts a sweep a couple of minutes after boot and then looks for
new tracks every ``SWEEP_INTERVAL_SECONDS``; a sweep only gets a row when it
has tracks to do. Stop ends the sweep and holds the automatic ones until
SYNCHRO.S restarts or someone starts it again (Library → Tracks or Settings).
"""

from __future__ import annotations

import os
import re
import sys
import threading
import time
from contextlib import closing
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

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
#: this many beat grids failing in a row and the sweep stops looking for
#: grids (BPM, key and energy carry on); the next sweep looks again
MAX_GRID_ERRORS_IN_A_ROW = 25
#: a finished run's grid failures are kept in its note (library_jobs has no
#: column for them): "grids:<failed>", or "grids_paused:<failed>" when it
#: stopped looking for grids. A run from before this has none to read
GRIDS_NOTE = "grids"
GRIDS_PAUSED = "grids_paused"
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


class Held(RuntimeError):
    """A person's Stop holds the sweeps: an automatic ask waits for a Start."""


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
    from core.dj import progress
    from core.sample.analyze import analyze_track

    # the decoded audio comes back too, for the beat grid: one decode a track;
    # each step it starts is the track's progress (core/dj/progress.py)
    return analyze_track(path, max_seconds=DECODE_SECONDS, keep_audio=True, on_step=progress.step)


def _default_grid(path: str, *, audio=None, bpm_hint: Optional[float] = None) -> Dict[str, Any]:
    """The beat grid, phrases and sections (core/dj/grid.py) from the audio
    the analysis decoded, or from a decode of its own (the same 10 minutes)
    when the DJ data came from Sample Studio or is already done."""
    from core.dj import progress
    from core.dj.grid import SR, analyze_audio

    if audio is None:
        from core.sample.analyze import decode_mono_at

        progress.step("read")
        audio = decode_mono_at(path, SR, max_seconds=DECODE_SECONDS)
    progress.step("grid")
    y, rate = audio
    truncated = len(y) / float(rate) >= DECODE_SECONDS - 0.05
    return analyze_audio(y, rate, bpm_hint=bpm_hint, truncated=truncated, on_step=progress.step)


def _replaygain_db(path: str) -> Optional[float]:
    """The file's ReplayGain track gain in dB, when it has one."""
    try:
        from core.replaygain import read_replaygain_tags

        raw = read_replaygain_tags(path).get("track_gain")
    except Exception:  # noqa: BLE001 - no tag is fine
        return None
    if not raw:
        return None
    try:
        value = float(str(raw).lower().replace("db", "").strip())
    except ValueError:
        return None
    return round(value, 2) if -60.0 < value < 60.0 else None


def _mark_both(database, track_id: str, status: str, reason: str, version: int, *,
               source_sig: Optional[str] = None) -> None:
    """A track that couldn't be analysed (``error``, ``unreachable``,
    ``skipped``) has no grid for the same reason: its grid row says so, so
    the planner falls back with that reason instead of waiting for a grid
    that will never come (gauntlet M1)."""
    from core.dj import grid_store, store

    store.mark(database, track_id, status, reason, version)
    grid_store.mark(database, track_id, status, reason, source_sig=source_sig)


def _find_grid(database, track_id: str, path: str, sig: Optional[str], *, audio, bpm_hint,
               analyze_grid: Callable[..., Dict[str, Any]]) -> str:
    """Find and keep one track's grid: ``done`` (whatever it found, a grid or
    ``none``) or ``error``. A provisional ``analyzing`` row goes first, so a
    decode that takes the process down is skipped at the next start."""
    from core.dj import grid_store

    grid_store.mark(database, track_id, "analyzing", None, source_sig=sig)
    try:
        result = analyze_grid(path, audio=audio, bpm_hint=bpm_hint)
    except ImportError as exc:
        grid_store.mark(database, track_id, "stale", "analysis isn't available", version=0)
        raise _Abort(str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - one bad file never stops the sweep
        logger.info("Beat grid failed for track %s: %s", track_id, exc)
        grid_store.mark(database, track_id, "error", str(exc), source_sig=sig)
        return "error"
    grid_store.save_result(database, track_id, result, source_sig=sig, replaygain_db=_replaygain_db(path))
    return "done"


def _grid_due(row: Optional[Dict[str, Any]], sig: Optional[str]) -> bool:
    """After a full analysis: the grid is looked for unless it's this file's
    at this version. A failed one is looked for again at once (the audio is
    already decoded), unless a crash left it: a grid error stamped by a
    failed decode before L1 would otherwise wait a week."""
    from core.dj import grid_store

    if not grid_store.current(row, sig):
        return True
    return bool(row and row.get("status") == "error"
                and not str(row.get("reason") or "").startswith("SYNCHRO.S stopped"))


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
                  library_roots: Callable[[], List[str]] = library_roots,
                  analyze_grid: Callable[..., Dict[str, Any]] = _default_grid,
                  find_grid: bool = True) -> str:
    """Analyse one library track and keep its DJ data and its beat grid
    (a track whose DJ data is already done for this file only gets its grid:
    the top-up). ``grid_error``, ``done_grid_error`` or ``tagged_grid_error``
    when the grid failed (the DJ data is kept). With ``find_grid`` False
    (the sweep stopped looking for grids) no grid is looked for, and a
    top-up is ``grid_paused``. Returns ``done``
    (``tagged`` when BPM or key went into the file too), ``unreachable``,
    ``skipped`` (too long), ``error``, ``deferred`` (a drive move or a tag
    write started before the file could be written: back in the queue) or
    ``stale`` (the file changed during the analysis: back in the queue);
    raises _Abort when analysis can't run at all."""
    from core.dj import grid_store, progress, store
    from core.dj.tags import read_dj_tags, write_dj_tags
    from core.sample.store import source_signature

    version = analyzer_version()
    row = store.track_row(database, track_id)
    if not row or not row.get("file_path"):
        _mark_both(database, track_id, "error", "the track has no file", version)
        return "error"
    dj_row = store.get(database, track_id)
    # BPM, key and energy already done at this version: only the grid is due
    top_up = bool(dj_row and dj_row.get("status") == "done"
                  and int(dj_row.get("dj_analyzer_version") or 0) >= version)
    stored = str(row["file_path"])
    path = resolve(stored)
    if not path or not os.path.isfile(path):
        if top_up:
            grid_store.mark(database, track_id, "unreachable", f"SYNCHRO.S can't open {stored}")
        else:
            _mark_both(database, track_id, "unreachable", f"SYNCHRO.S can't open {stored}", version)
        return "unreachable"
    if _too_long(path):
        if top_up:
            grid_store.mark(database, track_id, "skipped", TOO_LONG)
        else:
            _mark_both(database, track_id, "skipped", TOO_LONG, version)
        return "skipped"
    sig = source_signature(path)
    if top_up and dj_row.get("source_sig") == sig:
        if not grid_store.current(grid_store.get(database, track_id), sig):
            if not find_grid:
                return "grid_paused"
            # only the grid is due: one decode for it alone (its steps: read,
            # grid, phrases, from _default_grid and the grid's analysis)
            progress.mode("grid")
            progress.step("read")
            found = _find_grid(database, track_id, path, sig, audio=None, bpm_hint=dj_row.get("bpm"),
                               analyze_grid=analyze_grid)
            if found == "error":
                return "grid_error"
        return "done"
    tags = read_dj_tags(path)
    analysis = _reuse_sample_analysis(track_id, sig, version)
    if analysis is None:
        progress.mode("full")
        progress.step("read")
        # written before the decode: a crash inside it is known at the next start
        store.mark(database, track_id, "analyzing", None, version)
        try:
            analysis = analyze(path)
        except ImportError as exc:
            store.requeue(database, track_id, "analysis isn't available")
            raise _Abort(str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - one bad file never stops the sweep
            logger.info("DJ analysis failed for track %s: %s", track_id, exc)
            # the grid's row isn't stamped with the file: the grid wasn't
            # looked for, so a later analysis that works finds it at once
            # rather than a week on (stage A re-review, L1)
            _mark_both(database, track_id, "error", str(exc), version)
            return "error"
        audio = analysis.pop("audio", None)
        if not analysis.get("truncated"):
            # a whole-file result is Sample Studio's too; a partial one isn't
            _share_with_sample_studio(track_id, analysis, sig)
    else:
        # Sample Studio's analysis is reused: only the grid's decode is left
        progress.mode("grid")
        audio = None

    tag_bpm = tags.get("bpm")
    ours = (dj_row or {}).get("bpm_tag_written")
    if tag_bpm and ours and int(round(float(tag_bpm))) == int(round(float(ours))):
        # the file's BPM is one SYNCHRO.S wrote from a person's Double / Halve
        # BPM, not the file's own: after "Use the measured BPM" it must not
        # come back as a tag (review N2)
        tag_bpm = None
    if overwrite_tags and write_tags:
        values = store.decide(enrichment_bpm=row.get("bpm"), analysis=analysis)
    else:
        values = store.decide(tag_bpm=tag_bpm, tag_key=tags.get("key"), enrichment_bpm=row.get("bpm"),
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
        progress.step("tags")
        # a person's Double / Halve BPM is the one written, never the measured
        # one under it (it's read now: one set during the analysis counts)
        override = (store.get(database, track_id) or {}).get("bpm_override")
        result = write_dj_tags(path, bpm=override or values["bpm"],
                               key_name=values["key_name"] if confident else None, overwrite=overwrite_tags)
        written = list(result.get("written") or [])
        if "bpm" in written:
            # remember a BPM written from a person's value (whole, as the tag
            # holds it), so a later analysis knows that tag is ours; one
            # written from the measured BPM is the file's own from now on
            values["bpm_tag_written"] = float(int(round(float(override)))) if override else None
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
    grid_failed = False
    if find_grid and _grid_due(grid_store.get(database, track_id), sig):
        # the audio decoded above goes straight to the grid; without it (Sample
        # Studio's analysis reused) the grid's own decode is the next step
        progress.step("grid" if audio is not None else "read")
        grid_failed = _find_grid(database, track_id, path, sig, audio=audio, bpm_hint=values.get("bpm"),
                                 analyze_grid=analyze_grid) == "error"
    del audio
    outcome = "tagged" if written else "done"
    # the DJ data is kept either way; a failed grid still counts as a failure
    # for the sweep (its run of failures, Activity's count)
    return f"{outcome}_grid_error" if grid_failed else outcome


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


#: waits a track a person asked for doesn't wait for: a download or an import
#: only slow the library down; a missing drive, a drive move or a tag write
#: are about the files themselves, so asked-for tracks wait for those too
SOFT_WAITS = ("download", "import")
#: how many tracks one profile may have waiting in the asked-for line at once
PRIORITY_PER_PROFILE = 200
#: while the sweep waits (a download), it looks this often for an asked-for
#: track, which doesn't wait
PRIORITY_LOOK_SECONDS = 0.5
#: how many tracks a profile's Up next can put first for its next
#: transition (``soon``; review L10): the next two with Auto mix on
SOON_PER_PROFILE = 2
#: why a track is in the asked-for line (Brief A, 31b; HANDOFF 325): a
#: person asked (Analyse these, Analyse now, Analyse mine, Try again), a set
#: (opened, or a track added to it or to the working set), Up next with Auto
#: mix on (or a set played as a mix), the Mix tab, the lab, DJ now (Brief E),
#: or a page that didn't say
SOURCES = ("asked", "set", "up_next", "mix", "lab", "dj_now", "page")


class DjAnalysisJob:
    """The one sweep at a time. Everything that touches the outside is
    injectable for tests.

    **The asked-for line** (analyse on demand): tracks a person needs now (in a
    mix set, Up next with DJ mix, the Mix tab, "Analyse these") go in a line
    of their own in front of the sweep's order, at most
    ``PRIORITY_PER_PROFILE`` a profile. They don't wait for downloads or
    imports (they still wait for the library's drive, a drive move and a tag
    write), and the rests after them are the usual ones. When no sweep runs,
    asking starts one for the asked-for tracks only, which doesn't lift a
    Stop's hold on the automatic sweeps. The line is kept in memory only: a
    restart empties it (the automatic sweeps still reach every track), and a
    person's Stop empties it too."""

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
        #: the asked-for line, in order, and who asked for each track
        self._priority: List[str] = []
        self._asked_by: Dict[str, set] = {}
        #: the line's order, by tier (``_tier_of``): an admin's Move up first,
        #: then what Up next needs for its next transition (``soon``), then
        #: what a person asked for themselves (Analyse mine, Analyse now, a
        #: lab pick), then what pages asked for; within a tier, first come
        #: first served (Brief A; HANDOFF 325; the review's L10)
        self._pinned: set = set()
        self._soon_by: Dict[int, List[str]] = {}
        self._explicit: set = set()
        #: each track's place in its tier: ``(tier, seq)``, the seq given when
        #: it entered that tier, so one that moves down a tier goes to the end
        #: of it, never ahead of what was there first (re-review N1)
        self._placed: Dict[str, Tuple[int, int]] = {}
        self._seq = 0
        #: why each track is in line, per profile that asked: (source, set id)
        self._why: Dict[str, Dict[int, Tuple[str, Optional[int]]]] = {}
        #: tracks an ask added to this run's total (not in its own order), so a
        #: Cancel takes back only what an ask put in (review L2)
        self._added_in_run: set = set()
        #: who pressed Stop (a profile id), while it holds
        self.held_by: Optional[int] = None
        #: the running sweep's tracks (counted in its total)
        self._queued: set = set()
        #: where the sweep is in its own order: each id's place, the next
        #: place, and every track it has taken
        self._sweep_pos: Dict[str, int] = {}
        self._index = 0
        self._seen: set = set()
        #: asked-for tracks taken once already in this run and let in again
        #: (one more try; a second ask is reported as ``taken``)
        self._retried: set = set()
        #: a run's thread is finishing (its row being saved): no new run starts
        #: until it has, and then it starts the next itself if tracks wait
        self._tail = False

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

    # -- the asked-for line --

    def _clear_line_locked(self) -> None:
        self._priority.clear()
        self._asked_by.clear()
        self._pinned.clear()
        self._soon_by.clear()
        self._explicit.clear()
        self._why.clear()
        self._placed.clear()

    def _forget_locked(self, track_id: str) -> None:
        """A track leaves the line (taken, or nobody asks for it any more)."""
        self._asked_by.pop(track_id, None)
        self._pinned.discard(track_id)
        self._explicit.discard(track_id)
        self._why.pop(track_id, None)
        self._placed.pop(track_id, None)
        for held in self._soon_by.values():
            if track_id in held:
                held.remove(track_id)

    def _tier_of(self, track_id: str) -> int:
        if track_id in self._pinned:
            return 0
        if any(track_id in held for held in self._soon_by.values()):
            return 1
        if track_id in self._explicit:
            return 2
        return 3

    def _stamp_locked(self, track_id: str, tier: int) -> None:
        self._seq += 1
        self._placed[track_id] = (tier, self._seq)

    def _resort_locked(self, first: Iterable[str] = ()) -> None:
        """Keep the line in tier order, first come first served within a
        tier: a track that changes tier (up or down) goes to the end of its
        new one, ``first`` (in its order) before the rest. Move up's tier
        is newest first. A few hundred tracks at most."""
        for track_id in list(first) + self._priority:
            if track_id not in self._asked_by:
                continue
            tier = self._tier_of(track_id)
            placed = self._placed.get(track_id)
            if placed is None or placed[0] != tier:
                self._stamp_locked(track_id, tier)

        def key(track_id: str) -> Tuple[int, int]:
            tier, seq = self._placed.get(track_id, (3, 0))
            return (tier, -seq if tier == 0 else seq)

        self._priority.sort(key=key)

    def front(self, track_id: str) -> bool:
        """In front of what pages asked for (shown in the popover)."""
        return self._tier_of(track_id) <= 2

    def _enqueue_locked(self, ids: List[str], profile_id: Optional[int], limit: Optional[int], *,
                        explicit: bool = False, source: Optional[str] = None,
                        set_id: Optional[int] = None, soon: bool = False) -> Dict[str, Any]:
        """Add ``ids`` to the asked-for line (the lock is held). A track
        already in it keeps its place, unless it moves up a tier: a person
        asks for it themselves (``explicit``), or Up next needs it for its
        next transition (``soon``: at most ``SOON_PER_PROFILE`` a profile,
        the newest). One this profile has no room for is ``over``."""
        pid = int(profile_id) if profile_id is not None else 0
        why = (source if source in SOURCES else ("asked" if explicit else "page"), set_id)
        mine = sum(1 for t in self._priority if pid in self._asked_by.get(t, ()))
        added: List[str] = []
        already = 0
        over = 0
        taken = 0
        running = bool(self._state and self._state.get("status") == "running")
        current = (self._state or {}).get("current") if running else None
        wanted: List[str] = []
        for track_id in ids:
            if running and track_id == current:
                # being worked out right now: already as good as asked for
                # (queued again it would run twice; re-review 5)
                already += 1
                continue
            if running and track_id in self._seen and track_id not in self._asked_by:
                # this run took it already and it still needs analysis (put
                # back, or it failed): one more try, then it's said, not queued
                if track_id in self._retried:
                    taken += 1
                    continue
                self._retried.add(track_id)
                self._seen.discard(track_id)
            asked = self._asked_by.get(track_id)
            if asked is not None and pid in asked:
                already += 1
                if explicit:
                    # asked again by a person: it moves up to their tier,
                    # keeping why it was first asked for (review L11)
                    self._explicit.add(track_id)
                wanted.append(track_id)
                continue
            if limit is not None and mine >= limit:
                over += 1
                continue
            mine += 1
            if asked is not None:
                asked.add(pid)
                self._why.setdefault(track_id, {})[pid] = why
                if explicit:
                    self._explicit.add(track_id)
                already += 1
                wanted.append(track_id)
                continue
            self._priority.append(track_id)
            self._asked_by[track_id] = {pid}
            self._why[track_id] = {pid: why}
            if explicit:
                self._explicit.add(track_id)
            added.append(track_id)
            wanted.append(track_id)
            if running and track_id not in self._queued:
                self._queued.add(track_id)
                self._added_in_run.add(track_id)
                self._state["total"] = int(self._state.get("total") or 0) + 1
        if soon:
            # what Up next needs for its next transition goes first; this
            # profile's earlier "soon" tracks go back to their own tier
            self._soon_by[pid] = [t for t in wanted if t in self._asked_by][-SOON_PER_PROFILE:]
        self._resort_locked(self._soon_by.get(pid, []) if soon else wanted)
        return {"added": added, "already": already, "over": over, "yours": mine, "taken": taken}

    def prioritise(self, track_id: str, profile_id: Optional[int] = None) -> bool:
        """"Analyse it now" or Move up (an admin's) while a sweep runs: the
        track goes next, before everything else in line, the last one moved
        first; it reads "you asked" for the admin. False when no sweep runs."""
        track_id = str(track_id)
        with self._lock:
            if not self._state or self._state.get("status") != "running":
                return False
            self._enqueue_locked([track_id], profile_id, None, explicit=True, source="asked")
            if track_id in self._asked_by:
                self._pinned.add(track_id)
                # the last one moved goes first
                self._stamp_locked(track_id, 0)
                self._resort_locked()
            return True

    def set_soon(self, profile_id: int, ids: List[str]) -> None:
        """Up next's next transition is now ``ids`` (tracks already in
        line, or none: a pair that needs nothing): this profile's earlier
        pair goes back to its own tier (re-review L10)."""
        pid = int(profile_id)
        with self._lock:
            keep = [t for t in dict.fromkeys(str(i) for i in ids)
                    if pid in self._asked_by.get(t, ())][-SOON_PER_PROFILE:]
            if keep:
                self._soon_by[pid] = keep
            else:
                self._soon_by.pop(pid, None)
            self._resort_locked(keep)

    def withdraw(self, ids: List[str], profile_id: int) -> Dict[str, int]:
        """Cancel: this profile's asks for ``ids`` leave the line; a track
        nobody else asked for leaves it too. ``{withdrawn}``."""
        pid = int(profile_id)
        out = 0
        with self._lock:
            for track_id in dict.fromkeys(str(i) for i in ids):
                askers = self._asked_by.get(track_id)
                if not askers or pid not in askers:
                    continue
                askers.discard(pid)
                (self._why.get(track_id) or {}).pop(pid, None)
                held = self._soon_by.get(pid)
                if held and track_id in held:
                    held.remove(track_id)
                out += 1
                if not askers:
                    self._priority.remove(track_id)
                    self._forget_locked(track_id)
                    running = bool(self._state and self._state.get("status") == "running")
                    if running and track_id in self._added_in_run and track_id not in self._seen:
                        # only what an ask added to this run comes off its
                        # total (a retried track was counted already; L2)
                        self._added_in_run.discard(track_id)
                        self._queued.discard(track_id)
                        self._state["total"] = max(0, int(self._state.get("total") or 0) - 1)
            self._resort_locked()
            return {"withdrawn": out}

    def promote(self, profile_id: int) -> Dict[str, int]:
        """Analyse mine: every track this profile asked for joins the people's
        tier, in the order they were asked; why each is in line stays
        ("you added it to Sunday Set"; review L11). ``{moved, yours}``."""
        pid = int(profile_id)
        moved = 0
        with self._lock:
            mine = [t for t in self._priority if pid in self._asked_by.get(t, ())]
            for track_id in mine:
                if self._tier_of(track_id) > 2:
                    moved += 1
                self._explicit.add(track_id)
            self._resort_locked()
            return {"moved": moved, "yours": len(mine)}

    def ask(self, database, ids: List[str], profile_id: int, *,
            limit: int = PRIORITY_PER_PROFILE, explicit: bool = True, source: Optional[str] = None,
            set_id: Optional[int] = None, soon: bool = False) -> Dict[str, Any]:
        """Analyse on demand: ``ids`` (tracks that need analysis, already
        checked to be in the caller's library) go in the asked-for line, and a
        sweep starts for them when none runs. ``{added, already, over,
        yours, limit, started, taken}``. While a person's Stop holds the
        sweeps, only a person's own ask (``explicit``: "Analyse these", a
        lab pick, Analyse now) goes in; an automatic one (a page asking for
        what it shows) raises ``Held``. A person's own ask goes to the front
        of the line, before what pages asked for; ``source`` and ``set_id``
        say why each track is there (``SOURCES``)."""
        clean = list(dict.fromkeys(str(i) for i in ids if i not in (None, "")))
        with self._lock:
            if self.held and not explicit:
                raise Held("Analysis is stopped: automatic asks wait for a Start.")
            result = self._enqueue_locked(clean, profile_id, limit, explicit=explicit, source=source,
                                          set_id=set_id, soon=soon)
            running = bool(self._state and self._state.get("status") == "running")
            want_start = bool(self._priority) and not running
        started = False
        if want_start:
            try:
                started = self.start(database, profile_id, manual=False, priority_only=True) is not None
            except JobRunning:
                started = False  # another request started it, with this line in it
        return {**result, "limit": limit, "started": started}

    def queue_snapshot(self, ids: List[str], profile_id: Optional[int] = None, *,
                       line: bool = False) -> Dict[str, Any]:
        """For the progress route: the running sweep (or None), and for each
        of ``ids`` its place in line, ``(position, asked_for, yours)``, while
        it's waiting to be analysed. Position 1 is the next track to be
        taken. With ``line`` the line in order with who asked and why (the
        progress route decides what each caller may see of it); without it
        nothing of the line is copied (review L11)."""
        pid = int(profile_id) if profile_id is not None else None
        with self._lock:
            live = dict(self._state) if self._state and self._state.get("status") == "running" else None
            ahead = {t: i for i, t in enumerate(self._priority)}
            in_line = len(self._priority)
            places: Dict[str, Tuple[int, bool, bool]] = {}
            for track_id in ids:
                if track_id in ahead:
                    places[track_id] = (ahead[track_id] + 1, True, pid in self._asked_by.get(track_id, ()))
                elif live is not None and track_id not in self._seen:
                    pos = self._sweep_pos.get(track_id)
                    if pos is not None and pos >= self._index:
                        places[track_id] = (in_line + pos - self._index + 1, False, False)
            mine = [i for i, t in enumerate(self._priority, start=1) if pid in self._asked_by.get(t, ())] \
                if pid is not None else []
            out_line = [(t, self._tier_of(t) <= 2, dict(self._why.get(t) or {})) for t in self._priority] \
                if line else None
            left = 0
            if live is not None:
                # a track put back (a drive move, a tag write, a file that
                # changed) is done with for this run too (review L3)
                finished = sum(int(live.get(k) or 0)
                               for k in ("done", "failed", "unreachable", "skipped", "requeued"))
                left = max(0, int(live.get("total") or 0) - finished - in_line - (1 if live.get("current") else 0))
            return {"live": live, "places": places, "in_line": in_line, "yours": len(mine),
                    "yours_first": bool(mine) and mine == list(range(1, len(mine) + 1)),
                    "held": self.held, "held_by": self.held_by if self.held else None, "line": out_line,
                    "left": left}

    def _next(self, ids: List[str], *, peek: bool = False) -> Optional[Tuple[str, bool]]:
        """The next track: the asked-for line first, then the sweep's order,
        each once. ``(track_id, asked_for)``, or None when there's none (and,
        unless peeking, the sweep is closing: a track asked for from now on
        starts the next one)."""
        with self._lock:
            while self._priority:
                first = self._priority[0]
                if first in self._seen:
                    self._priority.pop(0)
                    self._forget_locked(first)
                    continue
                if not peek:
                    self._priority.pop(0)
                    self._seen.add(first)
                    self._forget_locked(first)
                    # taken: a Cancel after a retry doesn't take it off the
                    # total again (re-review L2)
                    self._added_in_run.discard(first)
                    self._taking_locked(first)
                return first, True
            while self._index < len(ids):
                track_id = ids[self._index]
                if track_id in self._seen:
                    self._index += 1
                    continue
                if not peek:
                    self._index += 1
                    self._seen.add(track_id)
                    self._taking_locked(track_id)
                return track_id, False
            return None

    def _taking_locked(self, track_id: str) -> None:
        """The track just taken is the current one from this moment (the lock
        is held), so an ask for it in between isn't queued again."""
        if self._state is not None:
            self._state["current"] = track_id

    def _ordered(self, ids: List[str]):
        """The sweep's tracks, with any asked-for track taken first, once each."""
        with self._lock:
            self._seen = set()
            self._index = 0
        while True:
            found = self._next(ids)
            if found is None:
                return
            yield found[0]

    def has_priority(self) -> bool:
        with self._lock:
            return bool(self._priority)

    # -- starting and stopping --

    def start(self, database, profile_id: int = 1, *, manual: bool = True,
              background: bool = True, first: Optional[str] = None,
              priority_only: bool = False) -> Optional[Dict[str, Any]]:
        """Start a sweep over every track that needs DJ data (``first``, a
        track a person asked for, goes first), or with ``priority_only`` over
        the asked-for line alone. None when there's nothing to do (no row is
        written then).

        The library's work list is read before the lock is taken (it can be
        a long query), and whether a run is going is checked again after."""
        from core.dj import grid_store, store

        def busy() -> bool:
            if self._state and self._state.get("status") == "running":
                return True
            # a run's thread still saving its end: it starts the next itself
            return self._tail and threading.current_thread() is not self._thread

        with self._lock:
            if busy():
                raise JobRunning("Already working out BPM, key and energy.")
        ids: List[str] = []
        if not priority_only:
            retry = time.time() - (0 if manual else UNREACHABLE_RETRY_SECONDS)
            ids = store.pending_ids(database, analyzer_version(), retry_unreachable_before=retry)
            # then the top-up: tracks with their DJ data but no grid yet
            have = set(ids)
            ids += [i for i in grid_store.pending_ids(database, analyzer_version(),
                                                      retry_unreachable_before=retry)
                    if i not in have]
        with self._lock:
            if busy():
                raise JobRunning("Already working out BPM, key and energy.")
            if not manual and not priority_only and self.held:
                # a person's Stop came while the library was read: the
                # automatic sweep waits for a Start (re-review 6)
                return None
            if manual:
                self.held = False
                self.held_by = None
            if first is not None and str(first) in ids:
                ids.remove(str(first))
                ids.insert(0, str(first))
            # a track a crash left mid-analysis is an error, whatever happens next
            store.fail_leftover_analyzing(database)
            grid_store.fail_leftover_analyzing(database)
            work = set(ids) | set(self._priority)
            if not work:
                return None
            self._queued = set(work)
            self._sweep_pos = {t: i for i, t in enumerate(ids)}
            self._index = 0
            self._seen = set()
            self._retried = set()
            self._added_in_run = set()
            self._stop.clear()
            started = _now()
            with closing(database._get_connection()) as conn:
                _ensure_table(conn)
                conn.execute("UPDATE library_jobs SET status = 'stopped', finished_at = ?, note = 'restart' "
                             "WHERE kind = ? AND status = 'running'", (started, KIND))
                cur = conn.execute(
                    "INSERT INTO library_jobs (kind, profile_id, status, total, started_at) "
                    "VALUES (?, ?, 'running', ?, ?)", (KIND, int(profile_id), len(work), started))
                conn.commit()
                run_id = int(cur.lastrowid)
            self._state = {"id": run_id, "status": "running", "profile_id": int(profile_id), "total": len(work),
                           "done": 0, "failed": 0, "unreachable": 0, "skipped": 0, "tags_written": 0, "started_at": started,
                           "grid_failed": 0, "grids_paused": False, "grids_waiting": 0,
                           "waiting": None, "current": None, "manual": bool(manual),
                           "step": None, "step_mode": None, "asked_for": False, "priority_only": bool(priority_only)}
            state = dict(self._state)
        if background:
            self._thread = threading.Thread(target=self._run, args=(database, ids), name="DjAnalysis", daemon=True)
            self._thread.start()
        else:
            self._run(database, ids)
        return state

    def stop(self, *, by_person: bool = True, profile_id: Optional[int] = None) -> bool:
        with self._lock:
            if not self._state or self._state.get("status") != "running":
                return False
            if by_person:
                self.held = True
                # who stopped it, for "Analysis stopped by Ross" (31a, state 7)
                self.held_by = int(profile_id) if profile_id is not None else None
                # Stop means stop: the asked-for line goes too
                self._clear_line_locked()
        self._stop.set()
        return True

    def join(self, timeout: Optional[float] = None) -> None:
        deadline = None if timeout is None else time.monotonic() + timeout
        # a thread made but not started yet (a run's end starting the next):
        # joining it raises; it's waited for, but never for ever (a start
        # that failed leaves it unstarted; review L8)
        # the 5 s count from the first time this thread is found unstarted
        unstarted: Optional[Tuple[threading.Thread, float]] = None
        while True:
            thread = self._thread
            if thread is None:
                return
            try:
                thread.join(None if deadline is None else max(0.0, deadline - time.monotonic()))
            except RuntimeError:
                now = time.monotonic()
                if unstarted is None or unstarted[0] is not thread:
                    unstarted = (thread, now + 5.0)
                if now >= unstarted[1] or (deadline is not None and now >= deadline):
                    return
                time.sleep(0.005)
                continue
            # a run that ended with tracks asked for meanwhile starts the next
            if self._thread is thread or (deadline is not None and time.monotonic() >= deadline):
                return

    # -- the loop --

    def _update(self, **fields) -> None:
        with self._lock:
            if self._state is not None:
                self._state.update(fields)

    def _bump(self, field: str) -> None:
        with self._lock:
            if self._state is not None:
                self._state[field] = int(self._state.get(field) or 0) + 1
                # what's counted never passes the total (a sweep's percent
                # stays within 100; re-review 5)
                counted = sum(int(self._state.get(k) or 0) for k in ("done", "failed", "unreachable", "skipped"))
                if counted > int(self._state.get("total") or 0):
                    self._state["total"] = counted

    def _save(self, database, *, final: bool = False, state: Optional[Dict[str, Any]] = None) -> None:
        if state is None:
            with self._lock:
                state = dict(self._state or {})
        if not state:
            return
        try:
            with closing(database._get_connection()) as conn:
                # found_releases / found_artists are the missing-releases job's;
                # here they carry files tagged and files that weren't there
                conn.execute(
                    "UPDATE library_jobs SET status = ?, total = ?, done = ?, failed = ?, found_releases = ?, "
                    "found_artists = ?, finished_at = ?, note = ? WHERE id = ?",
                    (state["status"], state["total"], state["done"], state["failed"], state.get("tags_written", 0),
                     state.get("unreachable", 0), state.get("finished_at") if final else None,
                     state.get("note"), state["id"]))
                conn.commit()
        except Exception as exc:  # noqa: BLE001 - Activity reads the live state meanwhile
            logger.warning("couldn't save the DJ analysis run: %s", exc)

    def _wait_reason(self, database, *, asked_for: bool = False) -> Optional[str]:
        if self._away():
            return "drive_away"
        if self._held():
            return "drive_move"
        word = self._busy(database)
        if asked_for and word in SOFT_WAITS:
            return None
        return word

    def _wait_while_busy(self, database, ids: Optional[List[str]] = None) -> bool:
        """Wait out a download, an import or an unplugged drive before the
        next track (an asked-for track only waits for the drive, a move or a
        tag write). False when stopped while waiting."""
        while not self._stop.is_set():
            upcoming = self._next(ids, peek=True) if ids is not None else None
            if ids is not None and upcoming is None:
                self._update(waiting=None)
                return True  # nothing left: the loop ends
            asked_for = bool(upcoming and upcoming[1])
            reason = self._wait_reason(database, asked_for=asked_for)
            if reason is None:
                self._update(waiting=None)
                return True
            self._update(waiting=reason)
            # look often for a track asked for meanwhile, which may not wait
            waited = 0.0
            stopped = False
            while waited < self._wait_step:
                step = min(PRIORITY_LOOK_SECONDS, self._wait_step - waited)
                if self._stop.wait(step):
                    stopped = True
                    break
                waited += step
                if not asked_for and reason in SOFT_WAITS and self.has_priority():
                    break
            if stopped:
                break
        self._update(waiting=None)
        return False

    def _on_step(self, mode: str, step: str) -> None:
        # when each step started, for the popover's times (31b; HANDOFF 326):
        # one clock read a step, six or seven a track
        at = time.monotonic()
        with self._lock:
            if self._state is not None:
                self._state.update(step=step, step_mode=mode,
                                   steps=list(self._state.get("steps") or []) + [(step, at)])

    def _run(self, database, ids: List[str]) -> None:
        from core.dj import progress

        lower_priority()
        status, note = "done", None
        errors_in_a_row = 0
        # the beat grids fail on their own count: a run of them stops only
        # the looking for grids, never BPM, key and energy (re-review L3)
        grid_errors_in_a_row = 0
        find_grid = True
        try:
            while True:
                if self._stop.is_set() or not self._settings().get("analyze", True):
                    status = "stopped"
                    break
                if not self._wait_while_busy(database, ids):
                    status = "stopped"
                    break
                found = self._next(ids)
                if found is None:
                    break
                track_id, asked_for = found
                prefs = self._settings()
                started = time.monotonic()
                self._update(current=track_id, step=None, step_mode=None, asked_for=asked_for, steps=[],
                             track_started=started)
                self._in_track.set()
                try:
                    with progress.reporting(self._on_step):
                        outcome = self._process(database, track_id, write_tags=prefs.get("write_tags", False),
                                                overwrite_tags=prefs.get("overwrite_tags", False),
                                                may_write=lambda a=asked_for: self._wait_reason(
                                                    database, asked_for=a) is None,
                                                find_grid=find_grid)
                finally:
                    self._in_track.clear()
                took = time.monotonic() - started
                if outcome in ("grid_error", "done_grid_error", "tagged_grid_error"):
                    # the DJ data is kept (or was already there): the track is
                    # done, and its grid counts on its own
                    if outcome != "grid_error":
                        errors_in_a_row = 0
                    self._bump("done")
                    self._bump("grid_failed")
                    if outcome == "tagged_grid_error":
                        self._bump("tags_written")
                    grid_errors_in_a_row += 1
                    if grid_errors_in_a_row >= MAX_GRID_ERRORS_IN_A_ROW and find_grid:
                        find_grid = False
                        self._update(grids_paused=True)
                        logger.info("[Library] DJ analysis: %s beat grids in a row failed; grids wait for the next "
                                    "sweep", MAX_GRID_ERRORS_IN_A_ROW)
                elif outcome == "grid_paused":
                    # a top-up once grids have stopped: its BPM, key and energy
                    # are done and its grid waits for the next sweep. Nothing
                    # was decoded, so no rest and no save: a library of them
                    # goes by in moments instead of half a second each (review M1)
                    self._bump("done")
                    self._bump("grids_waiting")
                    self._update(current=None, step=None, step_mode=None, steps=[])
                    continue
                elif outcome in ("done", "tagged"):
                    errors_in_a_row = 0
                    grid_errors_in_a_row = 0
                    self._bump("done")
                    if outcome == "tagged":
                        self._bump("tags_written")
                elif outcome == "unreachable":
                    self._bump("unreachable")
                elif outcome == "skipped":
                    self._bump("skipped")
                elif outcome in ("deferred", "stale"):
                    # back in the queue for the next sweep: done with for this
                    # run (the sweep's tracks left, review L3)
                    self._bump("requeued")
                else:
                    errors_in_a_row += 1
                    self._bump("failed")
                    if errors_in_a_row >= MAX_ERRORS_IN_A_ROW:
                        status, note = "failed", f"{MAX_ERRORS_IN_A_ROW} tracks in a row couldn't be analysed"
                        break
                # the track is finished: nothing is "working" through the rest
                self._update(current=None, step=None, step_mode=None, asked_for=False, steps=[])
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
        with self._lock:
            paused = bool((self._state or {}).get("grids_paused"))
            grid_failed = int((self._state or {}).get("grid_failed") or 0)
        if note is None and (paused or grid_failed):
            note = f"{GRIDS_PAUSED if paused else GRIDS_NOTE}:{grid_failed}"
        try:
            switched_off = not self._settings().get("analyze", True)
        except Exception:  # noqa: BLE001 - unreadable settings: as if off
            switched_off = True
        with self._lock:
            if self._state is not None:
                self._state.update(status=status, note=note, finished_at=_now(), current=None, waiting=None,
                                   step=None, step_mode=None, asked_for=False)
            if status == "failed" or switched_off:
                # failed, or the setting turned off: the asked-for line isn't
                # kept waiting for a sweep that won't come. A person's Stop
                # emptied it already, and what a person asked for since (an
                # automatic ask is refused while held) runs next (re-review 4)
                self._clear_line_locked()
            # this run's own end, saved below even if a request lands meanwhile:
            # no new run starts until it's saved (``_tail``; review L1)
            final_state = dict(self._state or {})
            self._tail = True
        try:
            self._save(database, final=True, state=final_state)
        finally:
            with self._lock:
                self._tail = False
                # the line was emptied above unless the run was done: what's
                # in it now was asked for while the end was being saved
                again = list(self._priority)
                askers = sorted({p for t in again for p in self._asked_by.get(t, ()) if p})
        logger.info("[Library] DJ analysis %s: %s done, %s failed, %s unreachable, %s tagged", status,
                    final_state.get("done"), final_state.get("failed"), final_state.get("unreachable"),
                    final_state.get("tags_written"))
        if again:
            # tracks were asked for as this run ended: the next starts for them
            # (a run's own end, so the line never waits)
            try:
                self.start(database, askers[0] if askers else 1, manual=False, priority_only=True)
            except JobRunning:
                pass  # a request started it first
            except Exception as exc:  # noqa: BLE001 - the next request or sweep takes them
                logger.warning("couldn't start the DJ analysis for asked-for tracks: %s", exc)


JOB = DjAnalysisJob()


# ── the scheduler ────────────────────────────────────────────────────────────

_scheduler: Optional[threading.Thread] = None
_scheduler_stop = threading.Event()
#: when the scheduler looks next (wall clock), for "next sweep in about
#: 25 min" (31a, state 3); None while no scheduler runs
_next_sweep_at: Optional[float] = None


def next_sweep_in(now: Optional[float] = None) -> Optional[int]:
    """Seconds until the scheduler next starts a sweep, or None when it
    won't (no scheduler, or a Stop holds the sweeps)."""
    at = _next_sweep_at
    if at is None or JOB.held or _scheduler is None or not _scheduler.is_alive():
        return None
    return max(0, int(round(at - (time.time() if now is None else now))))


def _scheduler_loop(get_database: Callable[[], Any], first_delay: float, interval: float) -> None:
    global _next_sweep_at
    _next_sweep_at = time.time() + first_delay
    if _scheduler_stop.wait(first_delay):
        _next_sweep_at = None
        return
    while not _scheduler_stop.is_set():
        try:
            if settings_state()["analyze"] and not JOB.held and not JOB.running():
                JOB.start(get_database(), 1, manual=False)
        except JobRunning:
            pass
        except Exception as exc:  # noqa: BLE001 - try again next interval
            logger.warning("couldn't start the DJ analysis sweep: %s", exc)
        _next_sweep_at = time.time() + interval
        if _scheduler_stop.wait(interval):
            _next_sweep_at = None
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


def public_state(database, job: Optional[DjAnalysisJob] = None, *,
                 now: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """The running sweep, else the last one (``recent`` within a day)."""
    live = (job or JOB).live()
    if live:
        return {k: live.get(k) for k in ("id", "status", "total", "done", "failed", "unreachable", "skipped",
                                         "tags_written", "started_at", "waiting", "current", "grid_failed",
                                         "grids_paused", "grids_waiting")} | {"recent": True}
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
            **dict(zip(("grid_failed", "grids_paused"), grid_note(row.get("note")), strict=True)),
            "recent": bool(row.get("finished_at")) and t - int(row.get("finished_at") or 0) < RECENT_SECONDS}


def grid_note(note: Optional[str]) -> Tuple[int, bool]:
    """A finished run's grid failures and whether it stopped looking for
    grids, from its note; ``(0, False)`` for any other note."""
    m = re.fullmatch(r"(grids|grids_paused):(\d{1,9})", str(note or ""))
    if not m:
        return 0, False
    return int(m.group(2)), m.group(1) == GRIDS_PAUSED


__all__ = ["DECODE_SECONDS", "GRIDS_NOTE", "GRIDS_PAUSED", "JOB", "SOURCES", "next_sweep_in", "MAX_GRID_ERRORS_IN_A_ROW", "grid_note",
           "JobRunning", "KIND", "MAX_BYTES", "MAX_SECONDS", "DjAnalysisJob", "busy_reason",
           "library_away", "library_roots", "process_track", "public_state", "register_busy", "settings_state",
           "start_scheduler", "stop_scheduler", "write_allowed"]
