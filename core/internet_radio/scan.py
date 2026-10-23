"""Scan now: someone presses a button, the server listens to about ten seconds
of the station and asks the identification services what it is.

- **Capture, server-side, never a microphone.** When the station is already
  relayed for someone, the scan rides on that relay (a :class:`~core.internet_radio.hub.Tap`):
  the relay copies what it passes on into the scan's buffer, and no second
  connection is opened. Otherwise (a direct session, or a relay that ends
  mid-scan) the scan opens one short read of the station's own stream with
  :func:`~core.internet_radio.relay.open_stream`: the same stations only
  (built-in, directory, admin links, as resolved for the listening session),
  the same audio-only gate and outbound guard, capped at
  :data:`CAPTURE_MAX_BYTES` and :data:`CAPTURE_MAX_SECONDS`.
- **Decoding:** ffmpeg turns the capture into ten seconds of mono 16 kHz WAV
  in a temporary folder that's removed whatever happens. Ogg and FLAC streams
  carry their headers only at the start, so a tap prepends the first audio
  the relay passed on; if the clip still can't be decoded, one direct read is
  tried instead.
- **The chain:** AcoustID (fpcalc plus the free key; skipped without one),
  then AudD (when Settings → Radio has its token), then ACRCloud (host, key
  and secret). The first confident match wins (AcoustID's 0.7 rule, ACRCloud's
  score of 70; AudD's standard answer has no score). Paid services are used
  only here, on a press; the automatic identification never calls them.
- **What a match sets off:** a Heard row for the person who pressed (source
  ``scan_acoustid`` / ``scan_audd`` / ``scan_acrcloud``), the library, Wanted
  and quality target check, now playing for everyone on the station, and the
  ``radio_track_heard`` trigger. Not auto-add: that stays on the free,
  automatic sources.
- **Limits:** the server runs one gunicorn worker with 8 threads, so scans
  run on their own two worker threads (never a request's or a relay's), two
  at once across the server, one at a time per profile and
  :data:`PER_PROFILE_PER_MINUTE` a minute per profile.
"""

from __future__ import annotations

import os
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from core.internet_radio import scan_providers as providers
from core.internet_radio import settings as radio_settings
from core.internet_radio import store
from core.internet_radio.hub import RadioHub, Session
from core.internet_radio.stations import Station
from utils.logging_config import get_logger

logger = get_logger("internet_radio.scan")

CAPTURE_SECONDS = 11          # a little over the ten the services get
CLIP_SECONDS = 10
CAPTURE_MAX_SECONDS = 16      # a direct read never runs longer
CAPTURE_MIN_BYTES = 64 * 1024
CAPTURE_MAX_BYTES = 3 * 1024 * 1024
TAP_WAIT_SECONDS = CAPTURE_SECONDS + 8
MAX_RUNNING = 2               # across the server
PER_PROFILE_PER_MINUTE = 3
KEEP_SECONDS = 15 * 60        # finished scans are readable this long
NOT_FOUND_WORDS = "Couldn’t identify this — DJ mixes and talk often can’t be."
# streams whose decoder needs the headers sent at the start of the connection
_NEEDS_HEAD = {"application/ogg", "audio/ogg", "audio/opus", "audio/flac", "audio/x-flac"}
_EXT = {"audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/aac": ".aac", "audio/aacp": ".aac", "audio/x-aac": ".aac",
        "audio/ogg": ".ogg", "application/ogg": ".ogg", "audio/opus": ".opus", "audio/flac": ".flac",
        "audio/x-flac": ".flac", "audio/mp4": ".m4a"}


class ScanRefused(Exception):
    """Why a scan can't start: ``status`` (HTTP), ``code``, ``message``."""

    def __init__(self, status: int, code: str, message: str, retry_after: Optional[int] = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after


@dataclass
class Scan:
    id: str
    profile_id: int
    station_id: str
    station_name: str
    session_id: str
    created_at: float
    state: str = "listening"       # listening | identified | not_found | failed
    phase: str = "capturing"       # capturing | identifying (while listening)
    trying: Optional[str] = None   # the service being asked
    captured: int = 0
    target: int = 1
    finished_at: Optional[float] = None
    track: Optional[Dict[str, Any]] = None
    source: Optional[str] = None
    heard_id: Optional[int] = None
    library: Optional[Dict[str, Any]] = None
    on_wanted: bool = False
    reason: Optional[str] = None
    provider_error: Optional[Dict[str, str]] = None
    asked: List[str] = field(default_factory=list)
    via: str = ""                  # relay | direct: where the audio came from

    def public(self, now: float) -> Dict[str, Any]:
        progress = 1.0 if self.state != "listening" or self.phase != "capturing" else \
            max(0.0, min(1.0, self.captured / max(1, self.target)))
        return {"scan_id": self.id, "station_id": self.station_id, "state": self.state, "phase": self.phase,
                "trying": self.trying, "trying_label": providers.LABELS.get(self.trying or "", None),
                "progress": round(progress, 2), "capture_seconds": CLIP_SECONDS,
                "seconds_left": max(0, round(CLIP_SECONDS * (1 - progress))),
                "track": self.track, "source": self.source,
                "source_label": providers.LABELS.get((self.source or "").replace("scan_", ""), None),
                "heard_id": self.heard_id, "library": self.library, "on_wanted": self.on_wanted,
                "reason": self.reason, "provider_error": self.provider_error, "asked": list(self.asked),
                "started_at": self.created_at, "finished_at": self.finished_at, "now": now}


@dataclass
class ScanDeps:
    get_database: Callable[[], Any]
    config: Any
    find_fpcalc: Callable[[], Optional[str]]
    acoustid_refused: Callable[[], bool] = lambda: False
    find_ffmpeg: Callable[[], Optional[str]] = lambda: shutil.which("ffmpeg")
    # (url) -> (response, media type); the relay's guarded, audio-only open
    open_stream: Optional[Callable[[str], Tuple[Any, str]]] = None
    run: Callable[..., Any] = subprocess.run
    clock: Callable[[], float] = time.time


def available_services(config, *, fpcalc: Optional[str], acoustid_refused: bool = False) -> List[str]:
    """The services a scan would ask, in order."""
    out = []
    if radio_settings.acoustid_key(config) and fpcalc and not acoustid_refused:
        out.append("acoustid")
    if radio_settings.audd_token(config):
        out.append("audd")
    if radio_settings.acrcloud_credentials(config):
        out.append("acrcloud")
    return out


NO_SERVICE_WORDS = ("No identification service is set up for Scan now. An admin can add an AcoustID key, or AudD or "
                    "ACRCloud, in Settings → Radio.")


class ScanManager:
    def __init__(self, hub: RadioHub, deps: Optional[ScanDeps] = None):
        self.hub = hub
        self.deps = deps
        self._lock = threading.RLock()
        self._scans: Dict[str, Scan] = {}
        self._starts: Dict[int, List[float]] = {}
        self._pool = ThreadPoolExecutor(max_workers=MAX_RUNNING, thread_name_prefix="radio-scan")
        self._sync = False

    def configure(self, deps: ScanDeps) -> None:
        self.deps = deps

    def run_inline(self, on: bool = True) -> None:
        """Tests: run a scan on the calling thread."""
        self._sync = on

    def reset(self) -> None:
        with self._lock:
            self._scans.clear()
            self._starts.clear()

    def _now(self) -> float:
        return self.deps.clock() if self.deps else time.time()

    # ── availability ─────────────────────────────────────────────────────────

    def services(self) -> List[str]:
        if not self.deps:
            return []
        return available_services(self.deps.config, fpcalc=self.deps.find_fpcalc(),
                                  acoustid_refused=self.deps.acoustid_refused())

    def availability(self) -> Dict[str, Any]:
        """``{available, reason, services}`` for the button."""
        if not self.deps or not radio_settings.read(self.deps.config)["identification"]:
            return {"available": False, "reason": "Track identification is off in Settings → Radio.", "services": []}
        services = self.services()
        if not services:
            return {"available": False, "reason": NO_SERVICE_WORDS, "services": []}
        return {"available": True, "reason": None, "services": services}

    # ── starting and reading ─────────────────────────────────────────────────

    def _running(self) -> List[Scan]:
        return [s for s in self._scans.values() if s.state == "listening"]

    def _prune(self, now: float) -> None:
        for sid, s in list(self._scans.items()):
            if s.finished_at and now - s.finished_at > KEEP_SECONDS:
                self._scans.pop(sid, None)
        for pid, times in list(self._starts.items()):
            self._starts[pid] = [t for t in times if now - t < 60]
            if not self._starts[pid]:
                self._starts.pop(pid, None)

    def start(self, profile_id: int, session: Session, station: Station) -> Scan:
        """A new scan for a profile's listening session; raises
        :class:`ScanRefused`."""
        avail = self.availability()
        if not avail["available"]:
            code = "identification_off" if "off in Settings" in (avail["reason"] or "") else "no_scan_service"
            raise ScanRefused(409, code, avail["reason"])
        now = self._now()
        pid = int(profile_id)
        with self._lock:
            self._prune(now)
            if any(s.profile_id == pid for s in self._running()):
                raise ScanRefused(409, "scan_running", "A scan is already listening. Its answer is on its way.")
            recent = self._starts.get(pid, [])
            if len(recent) >= PER_PROFILE_PER_MINUTE:
                wait = int(60 - (now - min(recent))) + 1
                raise ScanRefused(429, "rate_limited",
                                  f"That's {PER_PROFILE_PER_MINUTE} scans in a minute. Try again in {wait} s.",
                                  retry_after=wait)
            if len(self._running()) >= MAX_RUNNING:
                raise ScanRefused(409, "busy", "Two scans are already listening on this server. Try again in a "
                                               "few seconds.", retry_after=10)
            scan = Scan(id=secrets.token_urlsafe(12), profile_id=pid, station_id=station.id,
                        station_name=station.name, session_id=session.id, created_at=now)
            kbps = session.stream.bitrate_kbps or 128
            scan.target = min(CAPTURE_MAX_BYTES, max(CAPTURE_MIN_BYTES, kbps * 1000 // 8 * CAPTURE_SECONDS))
            self._scans[scan.id] = scan
            self._starts.setdefault(pid, []).append(now)
        if self._sync:
            self._guarded(scan, session, station)
        else:
            self._pool.submit(self._guarded, scan, session, station)
        return scan

    def get(self, scan_id: str, profile_id: int) -> Optional[Scan]:
        with self._lock:
            scan = self._scans.get(str(scan_id or ""))
            return scan if scan is not None and scan.profile_id == int(profile_id) else None

    def running_count(self) -> int:
        with self._lock:
            return len(self._running())

    # ── the work (a scan thread) ─────────────────────────────────────────────

    def _guarded(self, scan: Scan, session: Session, station: Station) -> None:
        try:
            self._run(scan, session, station)
        except Exception:  # noqa: BLE001 - a scan that broke says so, it never takes the server down
            logger.exception("scan %s failed", scan.id)
            self._finish(scan, "failed", reason="The scan didn't finish. Try again.")

    def _finish(self, scan: Scan, state: str, **fields: Any) -> None:
        with self._lock:
            for k, v in fields.items():
                setattr(scan, k, v)
            scan.state = state
            scan.trying = None
            scan.finished_at = self._now()

    def _capture_tap(self, scan: Scan) -> Optional[Tuple[bytes, str]]:
        tap = self.hub.add_tap(scan.station_id, scan.target)
        if tap is None:
            return None
        deadline = time.monotonic() + TAP_WAIT_SECONDS
        try:
            while not tap.done.wait(0.5):
                scan.captured = len(tap.buf)
                if time.monotonic() > deadline:
                    break
        finally:
            self.hub.remove_tap(tap)
        if tap.failed or len(tap.buf) < CAPTURE_MIN_BYTES:
            return None
        data = bytes(tap.buf)
        if tap.kind in _NEEDS_HEAD and tap.head:
            data = tap.head + data
        scan.via = "relay"
        return data, tap.kind

    def _capture_direct(self, scan: Scan, session: Session) -> Tuple[Optional[Tuple[bytes, str]], Optional[str]]:
        opener = self.deps.open_stream if self.deps else None
        if opener is None:
            return None, "The station's audio couldn't be opened."
        try:
            resp, kind = opener(session.stream.url)
        except Exception as exc:  # noqa: BLE001 - StreamError's words are safe to show
            msg = str(exc) if exc.__class__.__name__ == "StreamError" else "The station didn't answer."
            return None, msg
        buf = bytearray()
        started = time.monotonic()
        try:
            for chunk in resp.iter_content(chunk_size=16 * 1024):
                if chunk:
                    buf += chunk[: CAPTURE_MAX_BYTES - len(buf)]
                    scan.captured = len(buf)
                if len(buf) >= min(scan.target, CAPTURE_MAX_BYTES) or time.monotonic() - started > CAPTURE_MAX_SECONDS:
                    break
        except Exception:  # noqa: BLE001,S110 - what arrived is used if it's enough
            pass
        finally:
            try:
                resp.close()
            except Exception:  # noqa: BLE001,S110
                pass
        if len(buf) < CAPTURE_MIN_BYTES:
            return None, "The station sent too little audio to scan."
        scan.via = "direct"
        return (bytes(buf), kind), None

    def _decode(self, raw: bytes, kind: str, folder: str) -> Optional[str]:
        """The clip the services get: mono 16 kHz WAV, or the capture as it
        came when ffmpeg isn't installed. None when ffmpeg can't read it."""
        src = os.path.join(folder, "capture" + _EXT.get(kind, ".mp3"))
        with open(src, "wb") as fh:
            fh.write(raw)
        ffmpeg = self.deps.find_ffmpeg() if self.deps else None
        if not ffmpeg:
            return src
        out = os.path.join(folder, "clip.wav")
        try:
            proc = self.deps.run([ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", src,
                                  "-t", str(CLIP_SECONDS), "-ac", "1", "-ar", "16000", "-sample_fmt", "s16",
                                  "-f", "wav", out], capture_output=True, timeout=30, check=False)
        except (OSError, subprocess.SubprocessError):
            return None
        if getattr(proc, "returncode", 1) != 0 or not os.path.exists(out) or os.path.getsize(out) < 16000:
            return None
        return out

    def _ask(self, service: str, clip: str) -> providers.ProviderResult:
        cfg = self.deps.config
        if service == "acoustid":
            return providers.acoustid(clip, radio_settings.acoustid_key(cfg), self.deps.find_fpcalc() or "fpcalc",
                                      run=self.deps.run)
        if service == "audd":
            return providers.audd(clip, radio_settings.audd_token(cfg))
        creds = radio_settings.acrcloud_credentials(cfg)
        if not creds:
            return providers.ProviderResult(provider="acrcloud", status="error", error="bad_key",
                                            message=providers.error_words("acrcloud", "bad_key"))
        return providers.acrcloud(clip, creds, now=self.deps.clock)

    def _run(self, scan: Scan, session: Session, station: Station) -> None:
        services = self.services()
        if not services:
            self._finish(scan, "failed", reason=NO_SERVICE_WORDS)
            return
        captured = self._capture_tap(scan)
        tried_direct = False
        problem = None
        if captured is None:
            captured, problem = self._capture_direct(scan, session)
            tried_direct = True
        if captured is None:
            self._finish(scan, "failed", reason=problem or "The station's audio couldn't be captured.")
            return
        folder = tempfile.mkdtemp(prefix="soulsync-scan-")
        try:
            clip = self._decode(captured[0], captured[1], folder)
            if clip is None and not tried_direct:
                again, problem = self._capture_direct(scan, session)
                if again is not None:
                    clip = self._decode(again[0], again[1], folder)
            if clip is None:
                self._finish(scan, "failed", reason=problem or "The captured audio couldn't be read.")
                return
            with self._lock:
                scan.phase = "identifying"
                scan.captured = scan.target
            self._chain(scan, station, services, clip)
        finally:
            shutil.rmtree(folder, ignore_errors=True)

    def _chain(self, scan: Scan, station: Station, services: List[str], clip: str) -> None:
        db = self.deps.get_database()
        errors: List[providers.ProviderResult] = []
        heard_nothing = False
        for service in services:
            with self._lock:
                scan.trying = service
                scan.asked.append(service)
            try:
                result = self._ask(service, clip)
            except Exception:  # noqa: BLE001 - a broken service is an error, the next one still gets asked
                logger.exception("scan service %s broke", service)
                result = providers.ProviderResult(provider=service, status="error", error="provider_error",
                                                  message=providers.error_words(service, "provider_error"))
            try:
                if result.status != "error" or result.error not in ("offline",):
                    store.bump_scan_usage(db, service, found=result.matched)
                # what the service said of its key, for Settings → Radio's tag
                store.record_scan_key_answer(db, service, key_state(result))
            except Exception as exc:  # noqa: BLE001 - usage is a count, not a reason to fail
                logger.debug("scan usage not counted: %s", exc)
            if result.matched:
                self._identified(scan, station, result)
                return
            if result.status == "no_match" or result.error == "bad_audio":
                heard_nothing = True
            else:
                logger.info("scan service %s: %s", service, result.error)  # the kind only, never a key
                errors.append(result)
        first = errors[0] if errors else None
        perr = {"provider": first.provider, "label": providers.LABELS[first.provider], "kind": first.error or "",
                "message": first.message} if first else None
        if heard_nothing:
            self._finish(scan, "not_found", reason=NOT_FOUND_WORDS, provider_error=perr)
        else:
            self._finish(scan, "failed", reason=first.message if first else "The scan didn't finish.",
                         provider_error=perr)

    def _identified(self, scan: Scan, station: Station, result: providers.ProviderResult) -> None:
        source = f"scan_{result.provider}"
        np = self.hub.on_scan(station, result.artist, result.title, release=result.release, source=source)
        db = self.deps.get_database()
        heard_id = None
        if np.key:
            heard_id = store.record_heard(db, profile_id=scan.profile_id, station_id=station.id,
                                          station_name=station.name, heard_at=int(self._now()), artist=result.artist,
                                          title=result.title, release=result.release, source=source,
                                          track_key=np.key)
            if heard_id is None:
                row = store.find_heard(db, scan.profile_id, station.id, np.key, int(self._now()) - 6 * 3600)
                heard_id = row["id"] if row else None
        lib = self.hub.library_state(scan.profile_id, result.artist, result.title, fresh=True)
        try:
            self.hub.fire_trigger(db, station, np)
        except Exception:  # noqa: BLE001 - the trigger failing doesn't undo the match
            logger.exception("radio trigger after a scan failed")
        self._finish(scan, "identified", source=source, heard_id=heard_id,
                     track={"artist": result.artist, "title": result.title, "release": result.release or None},
                     library={"in_library": lib["in_library"], "below_target": lib["below_target"],
                              "track_id": lib["track_id"]},
                     on_wanted=lib["on_wanted"])


def key_state(result: providers.ProviderResult) -> Optional[str]:
    """What an answer says about the service's key: ``ok`` when it answered
    (a match or not), ``bad_key`` or ``out_of_credit``; None for anything else
    (offline, too many requests, a clip it couldn't read)."""
    if result.status != "error":
        return "ok"
    if result.error in ("bad_key", "out_of_credit"):
        return result.error
    return None


def check_service(config, service: str, *, fpcalc: Optional[str] = None) -> Dict[str, Any]:
    """Settings → Radio's Test: ``{ok, state, message, spends}``."""
    if service == "acoustid":
        key = radio_settings.acoustid_key(config)
        if not key:
            return {"ok": False, "state": "missing", "message": "There's no AcoustID key to test.", "spends": False}
        result = providers.acoustid_test(key)
        spends = False
    elif service == "audd":
        token = radio_settings.audd_token(config)
        if not token:
            return {"ok": False, "state": "missing", "message": "There's no AudD token to test.", "spends": True}
        result = providers.audd_test(token)
        spends = True
    elif service == "acrcloud":
        creds = radio_settings.acrcloud_credentials(config)
        if not creds:
            return {"ok": False, "state": "missing",
                    "message": "ACRCloud needs its host, access key and access secret first.", "spends": True}
        result = providers.acrcloud_test(creds)
        spends = True
    else:
        raise ValueError(service)
    if result.status == "error":
        return {"ok": False, "state": result.error or "provider_error", "message": result.message, "spends": spends}
    return {"ok": True, "state": "ok", "message": result.message, "spends": spends}


__all__ = ["ScanManager", "ScanDeps", "Scan", "ScanRefused", "available_services", "check_service", "key_state",
           "NOT_FOUND_WORDS", "NO_SERVICE_WORDS", "MAX_RUNNING", "PER_PROFILE_PER_MINUTE", "CAPTURE_MAX_BYTES",
           "CAPTURE_MAX_SECONDS"]
