"""What's on each station, who's listening, and what happens when a track is named.

One :class:`RadioHub` per process (the app runs one gunicorn worker). It holds:

- **listening sessions**: ``POST /api/radio/play`` makes one per listener,
  ``direct`` (the browser plays the station itself) or ``relay`` (the server
  passes the audio on). A relay holds one of the server's threads, so at most
  :data:`MAX_RELAYS` exist at once, counting ones that are waiting for the
  browser to connect; a direct session lasts while the page keeps asking
  what's playing.
- **a monitor per station**: what's on now, from (in this order) the station's
  own now-playing feed, the stream's titles (read inside the relay), and a
  fingerprint of a short clip from the relay when neither names the track.
- **what a new track sets off**: a Heard row for each profile listening (and
  each profile with auto-add on for the station), auto-add, and the
  ``radio_track_heard`` automation trigger. That work runs on one background
  thread, never on a relay's thread.

Everything outside (the database, the library check, adding to Wanted, the
automation engine, the fingerprinter) comes in through :class:`HubDeps`, so
the hub is tested without the app.
"""

from __future__ import annotations

import os
import secrets
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from core.internet_radio import settings as radio_settings
from core.internet_radio import store
from core.internet_radio.feeds import FeedResult
from core.internet_radio.icy import parse_stream_title
from core.internet_radio.stations import Station, Stream
from utils.logging_config import get_logger

logger = get_logger("internet_radio.hub")

MAX_RELAYS = 2
PENDING_RELAY_SECONDS = 45      # a relay the browser never connects to is dropped
DIRECT_IDLE_SECONDS = 90        # a direct listener that stopped asking has gone
LISTENING_GRACE_SECONDS = 60    # "Listening…" before a station has said anything
FEED_HEALTHY_SECONDS = 90       # a feed that answered this recently is trusted over titles
FINGERPRINT_AFTER_SECONDS = 25  # let the feed and the titles try first
FINGERPRINT_STATION_GAP = 150   # one fingerprint per station this often at most
FINGERPRINT_GLOBAL_GAP = 20     # and one across all stations this often at most
NOT_IDENTIFIED_ROW_SECONDS = 90  # an unnamed stretch this long goes into Heard
LIBRARY_CACHE_SECONDS = 120


def track_key(artist: str, title: str) -> str:
    from core.text.normalize import normalize_key
    a, t = normalize_key(artist or ""), normalize_key(title or "")
    return f"{a}|{t}" if a and t else ""


def judge_quality(database, file_path: str, bitrate: Any) -> Optional[bool]:
    """True when the copy you have is below the quality target, None when unknown."""
    try:
        from core.quality import presets
        ext = file_path.rsplit(".", 1)[-1].lower() if file_path and "." in file_path else ""
        targets = presets.current_target(database).get("targets") or []
        if not ext or not targets:
            return None
        aq = presets.audio_quality(ext, int(bitrate or 0))
        if aq.format == "unknown":
            return None
        return not presets.meets_targets(aq, targets)
    except Exception as exc:  # noqa: BLE001 - no judgement beats a wrong one
        logger.debug("quality judgement failed: %s", exc)
        return None


@dataclass
class HubDeps:
    get_database: Callable[[], Any]
    config: Any
    # (profile_id, artist, title) -> {"in_library", "in_wishlist", "track_id", "file_path", "bitrate"}
    library_check: Callable[[int, str, str], Dict[str, Any]]
    # (profile_id, {"artist","title","release","station_id","station_name","auto"}) -> {"ok","skipped","message"}
    add_to_wanted: Callable[[int, Dict[str, Any]], Dict[str, Any]]
    emit_event: Callable[[str, Dict[str, Any]], None] = lambda _t, _d: None
    can_download: Callable[[int], bool] = lambda _pid: True
    # path -> {"status": "ok"|"no_match"|"error"|"unavailable", "artist", "title", "release", "error"}
    fingerprint: Optional[Callable[[str], Dict[str, Any]]] = None
    # () -> (available, reason)
    fingerprint_available: Callable[[], Tuple[bool, str]] = lambda: (False, "Fingerprints aren't set up.")
    # profiles that own an enabled radio_track_heard automation
    radio_automation_profiles: Callable[[], List[int]] = lambda: []
    resolve_station: Callable[[str], Optional[Station]] = lambda _sid: None
    clock: Callable[[], float] = time.time


@dataclass
class Session:
    id: str
    profile_id: int
    station_id: str
    station_name: str
    stream: Stream
    mode: str  # "direct" | "relay"
    created_at: float
    last_seen: float
    connected: bool = False
    ended: bool = False
    stop: threading.Event = field(default_factory=threading.Event)


@dataclass
class NowPlaying:
    state: str = "listening"  # identified | listening | not_identified | off | unavailable
    artist: str = ""
    title: str = ""
    release: str = ""
    art_url: str = ""
    source: Optional[str] = None  # station_feed | stream_titles | fingerprint
    identified_at: Optional[float] = None
    started_at: float = 0.0
    reason: Optional[str] = None
    key: str = ""
    previous_title: str = ""


@dataclass
class Monitor:
    station: Station
    now: NowPlaying
    created_at: float
    feed_ok_at: Optional[float] = None
    feed_error: Optional[str] = None
    feed_last_poll: float = 0.0
    feed_says_track: Optional[bool] = None
    has_titles: Optional[bool] = None  # does the stream send titles (known once relayed)
    last_title_raw: Optional[str] = None
    fp_last_at: float = 0.0
    fp_pending: bool = False
    fp_error: Optional[str] = None
    unnamed_since: Optional[float] = None


class Busy(Exception):
    """Two relays are already running."""


class RadioHub:
    def __init__(self, deps: Optional[HubDeps] = None):
        self.deps = deps
        self._lock = threading.RLock()
        self._sessions: Dict[str, Session] = {}
        self._monitors: Dict[str, Monitor] = {}
        self._lib_cache: Dict[Tuple[int, str], Tuple[float, Dict[str, Any]]] = {}
        self._fp_global_at = 0.0
        self._work = ThreadPoolExecutor(max_workers=1, thread_name_prefix="radio-work")
        self._fp_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="radio-fingerprint")
        self._sync = False  # tests run the background work inline

    # ── wiring ───────────────────────────────────────────────────────────────

    def configure(self, deps: HubDeps) -> None:
        self.deps = deps

    def run_inline(self, on: bool = True) -> None:
        """Tests: do the background work on the calling thread."""
        self._sync = on

    def _submit(self, pool: ThreadPoolExecutor, fn, *args) -> None:
        if self._sync:
            fn(*args)
        else:
            pool.submit(self._guarded, fn, *args)

    @staticmethod
    def _guarded(fn, *args) -> None:
        try:
            fn(*args)
        except Exception:  # noqa: BLE001 - background work logs and carries on
            logger.exception("radio background work failed")

    def _now(self) -> float:
        return self.deps.clock() if self.deps else time.time()

    def _settings(self) -> Dict[str, Any]:
        return radio_settings.read(self.deps.config) if self.deps else dict(radio_settings.DEFAULTS)

    def identification_on(self) -> bool:
        return bool(self._settings()["identification"])

    def reset(self) -> None:
        with self._lock:
            for s in self._sessions.values():
                s.ended = True
                s.stop.set()
            self._sessions.clear()
            self._monitors.clear()
            self._lib_cache.clear()
            self._fp_global_at = 0.0

    # ── sessions ─────────────────────────────────────────────────────────────

    def _live_relays(self, now: float) -> List[Session]:
        return [s for s in self._sessions.values() if s.mode == "relay" and not s.ended
                and (s.connected or now - s.created_at < PENDING_RELAY_SECONDS)]

    def relay_count(self) -> int:
        with self._lock:
            return len(self._live_relays(self._now()))

    def start_session(self, profile_id: int, station: Station, stream: Stream, mode: str) -> Session:
        """A new listening session. Ends this profile's other sessions (one
        station at a time per profile). Raises :class:`Busy` for a third relay."""
        now = self._now()
        with self._lock:
            for s in list(self._sessions.values()):
                if s.profile_id == int(profile_id) and not s.ended:
                    self._end(s)
            if mode == "relay" and len(self._live_relays(now)) >= MAX_RELAYS:
                raise Busy()
            sess = Session(id=secrets.token_urlsafe(18), profile_id=int(profile_id), station_id=station.id,
                           station_name=station.name, stream=stream, mode=mode, created_at=now, last_seen=now)
            self._sessions[sess.id] = sess
            self._monitor(station)
            return sess

    def get_session(self, session_id: str, profile_id: Optional[int] = None) -> Optional[Session]:
        with self._lock:
            sess = self._sessions.get(str(session_id or ""))
            if sess is None or sess.ended:
                return None
            if profile_id is not None and sess.profile_id != int(profile_id):
                return None
            return sess

    def touch(self, session_id: str, profile_id: int) -> bool:
        with self._lock:
            sess = self.get_session(session_id, profile_id)
            if sess is None:
                return False
            sess.last_seen = self._now()
            return True

    def _end(self, sess: Session) -> None:
        sess.ended = True
        sess.stop.set()
        self._sessions.pop(sess.id, None)

    def end_session(self, session_id: str, profile_id: int) -> bool:
        with self._lock:
            sess = self.get_session(session_id, profile_id)
            if sess is None:
                return False
            self._end(sess)
            return True

    def claim_relay(self, session_id: str, profile_id: int) -> Optional[Session]:
        """The relay route connecting: the session, marked connected, or None."""
        with self._lock:
            sess = self.get_session(session_id, profile_id)
            if sess is None or sess.mode != "relay" or sess.connected:
                return None
            if self._now() - sess.created_at > PENDING_RELAY_SECONDS:
                self._end(sess)
                return None
            sess.connected = True
            sess.last_seen = self._now()
            return sess

    def relay_closed(self, session_id: str) -> None:
        with self._lock:
            sess = self._sessions.get(session_id)
            if sess is not None:
                self._end(sess)

    def expire(self) -> None:
        now = self._now()
        with self._lock:
            for s in list(self._sessions.values()):
                if s.mode == "relay" and not s.connected and now - s.created_at > PENDING_RELAY_SECONDS:
                    self._end(s)
                elif s.mode == "direct" and now - s.last_seen > DIRECT_IDLE_SECONDS:
                    self._end(s)
            listened = {s.station_id for s in self._sessions.values()}
            keep = listened | set(self._watched_station_ids())
            for sid in list(self._monitors):
                if sid not in keep:
                    self._monitors.pop(sid, None)
            for k, (t, _v) in list(self._lib_cache.items()):
                if now - t > LIBRARY_CACHE_SECONDS:
                    self._lib_cache.pop(k, None)

    def listener_profiles(self, station_id: str) -> Set[int]:
        with self._lock:
            return {s.profile_id for s in self._sessions.values() if s.station_id == station_id and not s.ended}

    def sessions_for(self, station_id: str) -> List[Session]:
        with self._lock:
            return [s for s in self._sessions.values() if s.station_id == station_id and not s.ended]

    # ── which stations to watch without audio ────────────────────────────────

    def _watched_station_ids(self) -> List[str]:
        """Stations polled by feed alone: auto-add on, or a favourite of a
        profile with a radio automation. Never opens audio."""
        if not self.deps:
            return []
        try:
            db = self.deps.get_database()
            ids = set(store.auto_add_station_ids(db))
            owners = self.deps.radio_automation_profiles() or []
            ids |= set(store.all_favourite_station_ids(db, owners))
            return sorted(ids)
        except Exception as exc:  # noqa: BLE001
            logger.debug("watched stations unreadable: %s", exc)
            return []

    def has_work(self) -> bool:
        """True while the watcher has something to do: a listening session,
        or a station watched by feed alone (auto-add on, or a favourite of a
        profile with a radio automation)."""
        if not self.deps:
            return False
        with self._lock:
            if any(not s.ended for s in self._sessions.values()):
                return True
        return bool(self._watched_station_ids())

    def stations_to_poll(self) -> List[Station]:
        """Every station with a now-playing feed that someone is listening
        to, that has auto-add on, or that a radio automation watches."""
        if not self.deps:
            return []
        with self._lock:
            ids = {s.station_id for s in self._sessions.values() if not s.ended}
        ids |= set(self._watched_station_ids())
        out = []
        for sid in sorted(ids):
            with self._lock:
                mon = self._monitors.get(sid)
            station = mon.station if mon else self.deps.resolve_station(sid)
            if station is not None and station.has_now_playing:
                out.append(station)
        return out

    def feed_due(self, station_id: str, every: float) -> bool:
        with self._lock:
            mon = self._monitors.get(station_id)
            return mon is None or self._now() - mon.feed_last_poll >= every

    # ── monitors ─────────────────────────────────────────────────────────────

    def _monitor(self, station: Station) -> Monitor:
        with self._lock:
            mon = self._monitors.get(station.id)
            if mon is None:
                now = self._now()
                mon = Monitor(station=station, now=NowPlaying(state="listening", started_at=now), created_at=now)
                self._monitors[station.id] = mon
            return mon

    def monitor(self, station_id: str) -> Optional[Monitor]:
        with self._lock:
            return self._monitors.get(station_id)

    # ── what the sources say ─────────────────────────────────────────────────

    def on_feed(self, station: Station, result: Optional[FeedResult]) -> None:
        mon = self._monitor(station)
        now = self._now()
        with self._lock:
            mon.feed_last_poll = now
            if result is None:
                mon.feed_error = "The station's feed answered with something unexpected."
                return
            mon.feed_ok_at = now
            mon.feed_error = None
            mon.feed_says_track = result.is_track
        if result.show:
            self._remember_show(station, result.show)
        if not self.identification_on():
            return
        if result.is_track:
            self._identified(mon, result.artist, result.title, release=result.release, art_url=result.art_url,
                             source="station_feed")
        else:
            # a show or a break; the stream's titles may still name the track
            titles = parse_stream_title(mon.last_title_raw, station_name=station.name) if mon.last_title_raw else None
            if titles is not None and titles.is_track:
                self._identified(mon, titles.artist, titles.title, source="stream_titles")
            else:
                self._unnamed(mon, result.reason or "The station isn't naming the track right now.")

    def on_feed_error(self, station: Station, message: str) -> None:
        mon = self._monitor(station)
        with self._lock:
            mon.feed_last_poll = self._now()
            mon.feed_error = message

    def _feed_healthy(self, mon: Monitor) -> bool:
        return bool(mon.feed_ok_at and self._now() - mon.feed_ok_at < FEED_HEALTHY_SECONDS)

    def on_stream_title(self, station_id: str, raw: str) -> None:
        """A StreamTitle from the relay (repeats are ignored)."""
        with self._lock:
            mon = self._monitors.get(station_id)
            if mon is None:
                return
            mon.has_titles = True
            if raw == mon.last_title_raw:
                return
            mon.last_title_raw = raw
            feed_track = self._feed_healthy(mon) and mon.feed_says_track
        if not self.identification_on() or feed_track:
            return  # the station's own feed is the better source while it names tracks
        parsed = parse_stream_title(raw, station_name=mon.station.name)
        if parsed.is_track:
            self._identified(mon, parsed.artist, parsed.title, source="stream_titles")
        else:
            self._unnamed(mon, parsed.reason or "This isn't a track.")

    def stream_has_no_titles(self, station_id: str) -> None:
        with self._lock:
            mon = self._monitors.get(station_id)
            if mon is not None and mon.has_titles is None:
                mon.has_titles = False

    # ── fingerprints ─────────────────────────────────────────────────────────

    def wants_clip(self, station_id: str) -> bool:
        """Should the relay capture a clip for a fingerprint now?"""
        if not self.deps or self.deps.fingerprint is None or not self.identification_on():
            return False
        now = self._now()
        with self._lock:
            mon = self._monitors.get(station_id)
            if mon is None or mon.fp_pending:
                return False
            if mon.now.state == "identified":
                return False
            since = mon.unnamed_since if mon.unnamed_since is not None else mon.created_at
            if now - since < FINGERPRINT_AFTER_SECONDS:
                return False
            if now - mon.fp_last_at < FINGERPRINT_STATION_GAP or now - self._fp_global_at < FINGERPRINT_GLOBAL_GAP:
                return False
        ok, _reason = self.deps.fingerprint_available()
        if not ok:
            return False
        with self._lock:
            mon.fp_pending = True
            mon.fp_last_at = now
            self._fp_global_at = now
        return True

    def submit_clip(self, station_id: str, data: bytes, content_type: str) -> None:
        self._submit(self._fp_pool, self._run_fingerprint, station_id, bytes(data), content_type)

    def clip_failed(self, station_id: str) -> None:
        with self._lock:
            mon = self._monitors.get(station_id)
            if mon is not None:
                mon.fp_pending = False

    def _run_fingerprint(self, station_id: str, data: bytes, content_type: str) -> None:
        ext = {"audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/aac": ".aac", "audio/aacp": ".aac",
               "audio/x-aac": ".aac", "audio/ogg": ".ogg", "application/ogg": ".ogg", "audio/opus": ".opus",
               "audio/flac": ".flac", "audio/x-flac": ".flac", "audio/mp4": ".m4a"}.get(content_type, ".mp3")
        path = None
        result: Dict[str, Any]
        try:
            fd, path = tempfile.mkstemp(prefix="soulsync-radio-", suffix=ext)
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
            result = self.deps.fingerprint(path) if self.deps and self.deps.fingerprint else {"status": "unavailable"}
        except Exception as exc:  # noqa: BLE001 - a failed fingerprint is a reason, not a crash
            result = {"status": "error", "error": str(exc)}
        finally:
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass
        self.on_fingerprint(station_id, result or {})

    def on_fingerprint(self, station_id: str, result: Dict[str, Any]) -> None:
        with self._lock:
            mon = self._monitors.get(station_id)
            if mon is None:
                return
            mon.fp_pending = False
            status = result.get("status")
            mon.fp_error = None if status in ("ok", "no_match") else (result.get("error") or "The fingerprint service didn't answer.")
        if status == "ok" and result.get("artist") and result.get("title"):
            self._identified(mon, str(result["artist"]), str(result["title"]), release=str(result.get("release") or ""),
                             source="fingerprint")
        elif status == "no_match":
            self._unnamed(mon, "The station doesn't publish what's playing and the fingerprint service didn't "
                               "recognise it. Mixes, talk and live sessions often can't be identified.")

    # ── state changes ────────────────────────────────────────────────────────

    def _unnamed(self, mon: Monitor, reason: str) -> None:
        now = self._now()
        with self._lock:
            cur = mon.now
            if cur.state == "identified":
                mon.now = NowPlaying(state="not_identified", started_at=now, reason=reason,
                                     previous_title=cur.title)
                mon.unnamed_since = now
            elif cur.state in ("listening", "not_identified"):
                cur.state = "not_identified"
                cur.reason = reason
                if mon.unnamed_since is None:
                    mon.unnamed_since = cur.started_at or now

    def _identified(self, mon: Monitor, artist: str, title: str, *, release: str = "", art_url: str = "",
                    source: str) -> None:
        key = track_key(artist, title)
        if not key:
            self._unnamed(mon, "The track name couldn't be read.")
            return
        now = self._now()
        with self._lock:
            cur = mon.now
            if cur.state == "identified" and cur.key == key:
                # same track; a better source may fill in the release or the art
                if release and not cur.release:
                    cur.release = release
                if art_url and not cur.art_url:
                    cur.art_url = art_url
                return
            stretch = None
            if mon.unnamed_since is not None and cur.state != "identified":
                stretch = (mon.unnamed_since, now - mon.unnamed_since, cur.reason)
            mon.unnamed_since = None
            mon.now = NowPlaying(state="identified", artist=artist, title=title, release=release, art_url=art_url,
                                 source=source, identified_at=now, started_at=now, key=key,
                                 previous_title=cur.title if cur.state == "identified" else cur.previous_title)
            snapshot = mon.now
        self._submit(self._work, self._after_new_track, mon.station, snapshot, stretch)

    # ── what a new track sets off (background thread) ────────────────────────

    def _after_new_track(self, station: Station, np: NowPlaying, stretch) -> None:
        if not self.deps:
            return
        db = self.deps.get_database()
        listeners = self.listener_profiles(station.id)
        auto = set(store.auto_add_profiles(db, station.id))
        heard_ids: Dict[int, Optional[int]] = {}
        for pid in sorted(listeners | auto):
            if stretch and stretch[1] >= NOT_IDENTIFIED_ROW_SECONDS:
                store.record_heard(db, profile_id=pid, station_id=station.id, station_name=station.name,
                                   heard_at=int(stretch[0]), identified=False, duration_s=int(stretch[1]),
                                   reason=stretch[2])
            heard_ids[pid] = store.record_heard(
                db, profile_id=pid, station_id=station.id, station_name=station.name,
                heard_at=int(np.identified_at or self._now()), artist=np.artist, title=np.title,
                release=np.release, art_url=np.art_url, source=np.source, track_key=np.key)
        for pid in sorted(auto):
            try:
                self._auto_add(db, pid, station, np, heard_ids.get(pid))
            except Exception:  # noqa: BLE001 - one profile's failure doesn't stop the next
                logger.exception("auto-add failed for profile %s", pid)
        self._fire_trigger(db, station, np)

    def library_state(self, profile_id: int, artist: str, title: str, *, fresh: bool = False) -> Dict[str, Any]:
        key = (int(profile_id), track_key(artist, title))
        now = self._now()
        with self._lock:
            hit = self._lib_cache.get(key)
        if hit and not fresh and now - hit[0] < LIBRARY_CACHE_SECONDS:
            return hit[1]
        out = {"in_library": False, "below_target": None, "track_id": None, "on_wanted": False}
        if self.deps:
            try:
                res = self.deps.library_check(int(profile_id), artist, title) or {}
                out["in_library"] = bool(res.get("in_library"))
                out["on_wanted"] = bool(res.get("in_wishlist"))
                out["track_id"] = res.get("track_id")
                if out["in_library"]:
                    out["below_target"] = judge_quality(self.deps.get_database(), str(res.get("file_path") or ""),
                                                        res.get("bitrate"))
            except Exception as exc:  # noqa: BLE001 - an unknown answer reads as "not in your library"
                logger.debug("radio library check failed: %s", exc)
        with self._lock:
            self._lib_cache[key] = (now, out)
        return out

    def forget_library(self, profile_id: int, artist: str, title: str) -> None:
        with self._lock:
            self._lib_cache.pop((int(profile_id), track_key(artist, title)), None)

    def _auto_add(self, db, profile_id: int, station: Station, np: NowPlaying, heard_id: Optional[int]) -> str:
        """Guards, in order: download rights, in the library or on Wanted,
        added before, the daily limit. Returns what happened."""
        if not self.deps.can_download(profile_id):
            return "no_rights"
        lib = self.library_state(profile_id, np.artist, np.title, fresh=True)
        if lib["in_library"]:
            return "in_library"
        if lib["on_wanted"]:
            return "on_wanted"
        limit = self._settings()["daily_limit"]
        claim = store.claim_auto_add(db, profile_id, np.key, station.id, daily_limit=limit,
                                     day_since=store.day_start(self._now()), now=self._now())
        if claim != "ok":
            return claim
        result = self.deps.add_to_wanted(profile_id, {"artist": np.artist, "title": np.title, "release": np.release,
                                                      "station_id": station.id, "station_name": station.name,
                                                      "auto": True}) or {}
        if not result.get("ok") or result.get("skipped"):
            store.release_auto_add(db, profile_id, np.key)
            return "skipped" if result.get("skipped") else "failed"
        if heard_id:
            store.mark_heard_added(db, heard_id, auto=True)
        store.record_activity(db, profile_id=profile_id, station_id=station.id, station_name=station.name,
                              title=f"{np.artist} – {np.title}", now=self._now())
        self.forget_library(profile_id, np.artist, np.title)
        return "added"

    def _fire_trigger(self, db, station: Station, np: NowPlaying) -> None:
        owners = [int(p) for p in (self.deps.radio_automation_profiles() or [])]
        if not owners:
            return
        missing = [p for p in owners if not self.library_state(p, np.artist, np.title)["in_library"]]
        if not missing:
            return
        self.deps.emit_event("radio_track_heard", {
            "station_id": station.id, "station": station.name, "artist": np.artist, "title": np.title,
            "release": np.release, "source": np.source or "",
            "_missing_for": missing, "_favourite_of": store.profiles_favouriting(db, station.id),
        })

    def _remember_show(self, station: Station, show: Dict[str, Any]) -> None:
        if not self.deps or not show.get("id") or not str(show["id"]).startswith("nts:"):
            return
        try:
            store.upsert_show(self.deps.get_database(), show_id=str(show["id"]), station_id=station.id,
                              title=str(show.get("title") or station.name),
                              aired_at=int(show["aired_at"]) if show.get("aired_at") else None,
                              ended_at=int(show["ended_at"]) if show.get("ended_at") else None,
                              ref={"show_alias": show.get("show_alias"), "episode_alias": show.get("episode_alias")})
        except Exception as exc:  # noqa: BLE001
            logger.debug("show not remembered: %s", exc)

    # ── what the page and the player read ────────────────────────────────────

    def now_playing(self, station: Station, profile_id: int) -> Dict[str, Any]:
        now = self._now()
        mon = self.monitor(station.id)
        base: Dict[str, Any] = {"station_id": station.id, "state": "listening", "track": None, "source": None,
                                "identified_at": None, "started_at": None, "reason": None, "library": None,
                                "on_wanted": False, "previous_title": None, "now": now,
                                "playing": bool(self.listener_profiles(station.id))}
        if not self.identification_on():
            base.update(state="off", reason="Track identification is off in Settings → Radio.")
            return base
        if mon is None:
            base.update(state="listening", reason=None, playing=False)
            return base
        with self._lock:
            np = NowPlaying(**{k: getattr(mon.now, k) for k in mon.now.__dataclass_fields__})
            feed_ok = self._feed_healthy(mon)
            has_titles = mon.has_titles
            fp_error = mon.fp_error
            unnamed_since = mon.unnamed_since
        base["started_at"] = np.started_at or None
        base["previous_title"] = np.previous_title or None
        if np.state == "identified":
            lib = self.library_state(profile_id, np.artist, np.title)
            base.update(state="identified", source=np.source, identified_at=np.identified_at,
                        track={"artist": np.artist, "title": np.title, "release": np.release or None,
                               "art_url": np.art_url or None},
                        library={"in_library": lib["in_library"], "below_target": lib["below_target"],
                                 "track_id": lib["track_id"]},
                        on_wanted=lib["on_wanted"])
            return base
        fp_ok, fp_reason = self.deps.fingerprint_available() if self.deps else (False, "")
        no_feed = not station.has_now_playing or (not feed_ok and mon.feed_error)
        if no_feed and has_titles is False and (not fp_ok or fp_error):
            parts = []
            parts.append("It has no now-playing feed" if not station.has_now_playing
                         else "Its now-playing feed isn't answering")
            parts.append("sends no track names")
            why = fp_error or fp_reason or "the fingerprint fallback isn't set up"
            base.update(state="unavailable",
                        reason=f"{parts[0]} and {parts[1]}, and {why[0].lower() + why[1:] if why else ''}".rstrip(". ")
                        + ".")
            return base
        if np.state == "not_identified":
            base.update(state="not_identified", reason=np.reason,
                        started_at=unnamed_since or np.started_at)
            return base
        if now - (np.started_at or now) > LISTENING_GRACE_SECONDS and not station.has_now_playing and has_titles is False:
            base.update(state="not_identified",
                        reason="The station doesn't send track names. A fingerprint is tried every few minutes.")
            return base
        base.update(state="listening",
                    reason="Its name usually arrives within a minute.")
        return base


hub = RadioHub()

__all__ = ["RadioHub", "HubDeps", "Session", "NowPlaying", "Busy", "hub", "track_key", "judge_quality",
           "MAX_RELAYS"]
