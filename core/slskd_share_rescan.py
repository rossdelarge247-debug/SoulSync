"""Ask slskd to rescan its shares after imports put new files in the library.

slskd scans its shared folders once, at start, and never again by itself. On a
fresh install the library is empty at that moment, so slskd keeps sharing 0
files however much SYNCHRO.S imports afterwards, and the Soulseek network blocks
people who share nothing. This module closes that gap:

* ``notify_import()`` is called by the import pipeline each time files land in
  the library. It only records the time; it never touches the network and never
  blocks the import.
* ONE background thread coalesces those notes: it rescans ``QUIET_SECONDS``
  after the last import in a burst, but never later than ``CEILING_SECONDS``
  after the first, so a long Wanted run still rescans every ten minutes.
* Before rescanning it reads slskd's state; a scan already running is not
  doubled up, the request just waits ``BUSY_RETRY_SECONDS`` and tries again.
* ``run_startup_check()`` fixes existing installs: once slskd answers, if it
  shares 0 files while the library holds some, one rescan is requested.

slskd's API (src/slskd/Shares/API/Controllers/SharesController.cs):
``PUT /api/v0/shares`` starts a scan, ``GET /api/v0/shares`` lists the shares
with their file counts, ``DELETE /api/v0/shares`` cancels. ``GET
/api/v0/application`` carries the share state summary (``shares.scanning``,
``shares.files``). slskd starts the scan in the background, so PUT answers 200
even when a scan is running; that is why the state is read first. Requests go
through the existing ``SoulseekClient._make_request`` (its URL, API key and
timeout); nothing here builds its own HTTP path.

Setting: ``soulseek.rescan_shares_after_import`` (on by default).
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
from typing import Any, Callable, Optional

from utils.logging_config import get_logger

logger = get_logger("slskd_share_rescan")

SETTING_KEY = "soulseek.rescan_shares_after_import"

QUIET_SECONDS = 120.0       # rescan 2 minutes after the last import in a burst
CEILING_SECONDS = 600.0     # ...but at most 10 minutes after the first one
BUSY_RETRY_SECONDS = 30.0   # slskd already scanning: look again this much later
FAILURE_RETRY_SECONDS = 600.0  # slskd down / refused: try again later, quietly

STARTUP_POLL_SECONDS = 30.0
STARTUP_MAX_ATTEMPTS = 20   # ~10 minutes of waiting for slskd to come up

_AUDIO_EXTS = {
    ".flac", ".mp3", ".m4a", ".mp4", ".ogg", ".oga", ".opus", ".wav", ".aac",
    ".aiff", ".aif", ".wma", ".alac", ".ape", ".wv", ".dsf",
}


def _default_client():
    from core.soulseek_client import get_shared_soulseek_client
    return get_shared_soulseek_client()


def _default_setting_enabled() -> bool:
    try:
        from core.settings import config_manager
        value = config_manager.get(SETTING_KEY, True)
    except Exception:  # noqa: BLE001 - a settings hiccup must not stop imports
        return True
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no", "off", ""}
    return value is not False and value is not None


def _default_activity(title: str, subtitle: str) -> None:
    from core.runtime_state import add_activity_item
    add_activity_item("", title, subtitle, "Now", show_toast=False)


def _run_coro(coro):
    """Run one client coroutine from a plain thread (the worker has no loop)."""
    return asyncio.run(coro)


def _share_summary(state: Any) -> Optional[dict]:
    """``{'files': int|None, 'scanning': bool}`` from ``GET application``."""
    if not isinstance(state, dict):
        return None
    shares = state.get("shares") or state.get("Shares")
    if not isinstance(shares, dict):
        return None
    files = shares.get("files", shares.get("Files"))
    scanning = bool(shares.get("scanning") or shares.get("Scanning"))
    try:
        files = int(files) if files is not None else None
    except (TypeError, ValueError):
        files = None
    return {"files": files, "scanning": scanning}


def _files_from_share_list(listing: Any) -> Optional[int]:
    """Sum the per-share ``files`` from ``GET shares`` (``{host: [share]}``)."""
    if not isinstance(listing, dict):
        return None
    total = 0
    seen = False
    for shares in listing.values():
        if not isinstance(shares, list):
            continue
        for share in shares:
            if not isinstance(share, dict) or share.get("isExcluded"):
                continue
            count = share.get("files", share.get("Files"))
            if count is None:
                continue
            try:
                total += int(count)
                seen = True
            except (TypeError, ValueError):
                continue
    return total if seen else None


def library_has_audio_files(root: Optional[str], limit_dirs: int = 2000) -> bool:
    """True as soon as one audio file is found under ``root``.

    Stops at the first hit, skips dot-folders (atomic staging, quarantine) and
    gives up after ``limit_dirs`` folders, so it stays cheap on a big library.
    """
    if not root or not os.path.isdir(root):
        return False
    stack = [root]
    visited = 0
    while stack and visited < limit_dirs:
        current = stack.pop()
        visited += 1
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    if entry.name.startswith("."):
                        continue
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        elif os.path.splitext(entry.name)[1].lower() in _AUDIO_EXTS:
                            return True
                    except OSError:
                        continue
        except OSError:
            continue
    return False


def _default_library_root() -> Optional[str]:
    try:
        from core.imports.paths import shared_transfer_root
        return shared_transfer_root()
    except Exception:  # noqa: BLE001
        return None


class SlskdShareRescanner:
    """Debounced "rescan your shares" requests to slskd.

    Every collaborator is injectable so tests run on a fake clock with a fake
    client: ``clock`` (monotonic seconds), ``client_factory`` (returns an object
    with ``is_configured()`` and async ``_make_request``), ``enabled`` (the
    setting), ``activity`` and ``run_coro``. ``start_worker=False`` keeps the
    background thread off so a test drives ``tick()`` itself.
    """

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        client_factory: Callable[[], Any] = _default_client,
        enabled: Callable[[], bool] = _default_setting_enabled,
        activity: Optional[Callable[[str, str], None]] = _default_activity,
        run_coro: Callable[[Any], Any] = _run_coro,
        quiet_seconds: float = QUIET_SECONDS,
        ceiling_seconds: float = CEILING_SECONDS,
        busy_retry_seconds: float = BUSY_RETRY_SECONDS,
        failure_retry_seconds: float = FAILURE_RETRY_SECONDS,
        start_worker: bool = True,
    ) -> None:
        self._clock = clock
        self._client_factory = client_factory
        self._enabled = enabled
        self._activity = activity
        self._run_coro = run_coro
        self.quiet_seconds = float(quiet_seconds)
        self.ceiling_seconds = float(ceiling_seconds)
        self.busy_retry_seconds = float(busy_retry_seconds)
        self.failure_retry_seconds = float(failure_retry_seconds)
        self._start_worker = start_worker

        self._cond = threading.Condition()
        self._first_at: Optional[float] = None   # first import of the pending burst
        self._last_at: Optional[float] = None    # latest import of the pending burst
        self._retry_at: Optional[float] = None   # set while waiting out a busy slskd
        self._reasons = 0
        self._thread: Optional[threading.Thread] = None
        self._stopped = False
        self._warned = False                     # one warning per outage
        self.rescans_requested = 0

    # -- the import side: cheap, never raises, never blocks -----------------

    def notify_import(self, count: int = 1) -> None:
        """Note that files just landed in the library."""
        try:
            if not self._enabled():
                return
            now = self._clock()
            with self._cond:
                if self._stopped:
                    return
                if self._first_at is None:
                    self._first_at = now
                self._last_at = now
                self._reasons += max(1, int(count or 1))
                self._ensure_worker_locked()
                self._cond.notify()
        except Exception as exc:  # noqa: BLE001 - must never fail an import
            logger.debug("slskd rescan note failed: %s", exc)

    # -- scheduling ---------------------------------------------------------

    def due_at(self) -> Optional[float]:
        """When the pending burst should be rescanned, or None if idle."""
        with self._cond:
            return self._due_at_locked()

    def _due_at_locked(self) -> Optional[float]:
        if self._first_at is None or self._last_at is None:
            return None
        due = min(self._last_at + self.quiet_seconds, self._first_at + self.ceiling_seconds)
        if self._retry_at is not None:
            due = max(due, self._retry_at)
        return due

    def tick(self, now: Optional[float] = None) -> bool:
        """Rescan if the pending burst is due. Returns True if a rescan was sent."""
        now = self._clock() if now is None else now
        with self._cond:
            due = self._due_at_locked()
            if due is None or now < due:
                return False
            # Take the burst; imports that arrive during the request start a
            # new one instead of being swallowed by this rescan.
            first, last, reasons = self._first_at, self._last_at, self._reasons
            self._first_at = self._last_at = self._retry_at = None
            self._reasons = 0
        outcome = self._attempt(now)
        if outcome in ("busy", "failed"):
            delay = self.busy_retry_seconds if outcome == "busy" else self.failure_retry_seconds
            with self._cond:
                # Put the burst back, merged with any newer one that started meanwhile.
                if self._first_at is None:
                    self._first_at, self._last_at = first, last
                else:
                    self._first_at = min(self._first_at, first)
                self._reasons += reasons
                self._retry_at = now + delay
        return outcome == "requested"

    def _ensure_worker_locked(self) -> None:
        if not self._start_worker or (self._thread and self._thread.is_alive()):
            return
        self._thread = threading.Thread(
            target=self._worker, name="SlskdShareRescan", daemon=True)
        self._thread.start()

    def _worker(self) -> None:
        while True:
            with self._cond:
                if self._stopped:
                    return
                due = self._due_at_locked()
                if due is None:
                    self._cond.wait()
                    continue
                wait = due - self._clock()
                if wait > 0:
                    self._cond.wait(timeout=wait)
                    continue
            try:
                self.tick()
            except Exception as exc:  # noqa: BLE001 - keep the worker alive
                logger.debug("slskd rescan tick failed: %s", type(exc).__name__)

    def stop(self) -> None:
        with self._cond:
            self._stopped = True
            self._cond.notify_all()

    # -- talking to slskd ---------------------------------------------------

    def _client(self):
        try:
            client = self._client_factory()
        except Exception as exc:  # noqa: BLE001
            logger.debug("no slskd client for share rescan: %s", exc)
            return None
        if client is None:
            return None
        try:
            if not client.is_configured():
                return None
        except Exception:  # noqa: BLE001
            return None
        return client

    def _attempt(self, now: float) -> str:
        """One rescan attempt: 'requested', 'busy', 'skipped' or 'failed'."""
        if not self._enabled():
            return "skipped"
        client = self._client()
        if client is None:
            logger.debug("slskd not configured; share rescan skipped")
            return "skipped"
        try:
            state = self._run_coro(client._make_request("GET", "application"))
            summary = _share_summary(state)
            if summary and summary["scanning"]:
                logger.info("slskd is already scanning its shares; will look again shortly")
                return "busy"
            result = self._run_coro(client._make_request("PUT", "shares"))
        except Exception as exc:  # noqa: BLE001
            self._warn_once(f"{type(exc).__name__}")
            return "failed"
        if result is None:
            # _make_request already logged the HTTP/connection detail (never the key)
            self._warn_once("no answer from slskd")
            return "failed"
        self._warned = False
        self.rescans_requested += 1
        logger.info("Asked slskd to rescan its shares so new library files are shared on Soulseek")
        if self._activity:
            try:
                self._activity("Soulseek shares updating",
                               "Asked slskd to rescan, so new music in your library is shared")
            except Exception as exc:  # noqa: BLE001
                logger.debug("activity item for slskd rescan failed: %s", exc)
        return "requested"

    def _fire(self, now: float) -> bool:
        return self._attempt(now) == "requested"

    def _warn_once(self, detail: str) -> None:
        if self._warned:
            logger.debug("slskd share rescan still failing: %s", detail)
            return
        self._warned = True
        logger.warning(
            "Couldn't ask slskd to rescan its shares (%s). Imports carry on; "
            "SYNCHRO.S will try again later.", detail)

    # -- startup ------------------------------------------------------------

    def read_shared_file_count(self, client) -> tuple[Optional[int], bool, bool]:
        """``(files, scanning, reachable)`` from slskd."""
        state = self._run_coro(client._make_request("GET", "application"))
        summary = _share_summary(state)
        if summary is not None and summary["files"] is not None:
            return summary["files"], summary["scanning"], True
        listing = self._run_coro(client._make_request("GET", "shares"))
        if listing is None and state is None:
            return None, False, False
        files = _files_from_share_list(listing)
        scanning = bool(summary and summary["scanning"])
        return files, scanning, True

    def run_startup_check(
        self,
        *,
        library_root: Optional[str] = None,
        library_has_files: Callable[[Optional[str]], bool] = library_has_audio_files,
        sleep: Callable[[float], None] = time.sleep,
        poll_seconds: float = STARTUP_POLL_SECONDS,
        max_attempts: int = STARTUP_MAX_ATTEMPTS,
        should_stop: Callable[[], bool] = lambda: False,
    ) -> str:
        """One-shot: rescan if slskd shares nothing while the library has files.

        Returns what happened ('disabled', 'unconfigured', 'unreachable',
        'scanning', 'sharing', 'empty_library', 'requested', 'failed').
        """
        try:
            if not self._enabled():
                return "disabled"
            client = self._client()
            if client is None:
                return "unconfigured"
            for attempt in range(max(1, int(max_attempts))):
                if should_stop():
                    return "unreachable"
                files, scanning, reachable = self.read_shared_file_count(client)
                if reachable:
                    break
                if attempt + 1 < max_attempts:
                    sleep(poll_seconds)
            else:
                logger.info("slskd didn't answer at startup; skipped the shared-files check")
                return "unreachable"
            if scanning:
                return "scanning"
            if files is None or files > 0:
                return "sharing"
            root = library_root if library_root is not None else _default_library_root()
            if not library_has_files(root):
                return "empty_library"
            logger.info("slskd shares 0 files but the library has music; asking slskd to rescan")
            return "requested" if self._fire(self._clock()) else "failed"
        except Exception as exc:  # noqa: BLE001 - never break startup
            logger.debug("slskd startup share check failed: %s", type(exc).__name__)
            return "failed"


_INSTANCE: Optional[SlskdShareRescanner] = None
_INSTANCE_LOCK = threading.Lock()


def get_share_rescanner() -> SlskdShareRescanner:
    global _INSTANCE
    with _INSTANCE_LOCK:
        if _INSTANCE is None:
            _INSTANCE = SlskdShareRescanner()
        return _INSTANCE


def notify_library_import(count: int = 1) -> None:
    """Import-pipeline hook: files landed in the library. Never raises."""
    try:
        get_share_rescanner().notify_import(count)
    except Exception as exc:  # noqa: BLE001
        logger.debug("slskd rescan hook failed: %s", exc)


def stop_share_rescanner() -> None:
    with _INSTANCE_LOCK:
        if _INSTANCE is not None:
            _INSTANCE.stop()


__all__ = [
    "SETTING_KEY", "QUIET_SECONDS", "CEILING_SECONDS", "BUSY_RETRY_SECONDS",
    "SlskdShareRescanner", "get_share_rescanner", "notify_library_import",
    "stop_share_rescanner", "library_has_audio_files",
]
