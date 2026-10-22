"""The now-playing watcher: one light background thread, no audio.

Every few seconds it expires listening sessions nobody uses any more, then
asks the now-playing feed of each station that needs one: stations someone is
listening to, stations with auto-add on, and favourites of profiles with a
radio automation. Each feed is asked at most every
:data:`~core.internet_radio.feeds.FEED_POLL_SECONDS`, and answers are cached.

It never opens a station's audio and never holds one of the server's request
threads, so auto-add and the radio trigger work without anyone listening on
stations that publish a feed. A station without a feed is identified only
from its stream (titles and fingerprints), which means only while someone is
listening through the relay.

It only runs while it has work. :meth:`Watcher.ensure` starts it when
something needs it (a station is played, auto-add is turned on, a favourite
is added, the module is turned on, or at boot when a station is already
watched), and it stops itself once it has had nothing to do for
:data:`IDLE_STOP_SECONDS`.

While running it drops Heard rows older than Settings → Radio's days, at
most every :data:`PRUNE_EVERY` seconds.
"""

from __future__ import annotations

import threading
import time
from typing import Optional

from core.internet_radio import feeds, net, store
from core.internet_radio import settings as radio_settings
from core.internet_radio.hub import RadioHub
from utils.logging_config import get_logger

logger = get_logger("internet_radio.watcher")

TICK_SECONDS = 5
PRUNE_EVERY = 6 * 3600
#: the watcher stops after this long with nothing to watch
IDLE_STOP_SECONDS = 60


class Watcher:
    def __init__(self, hub: RadioHub):
        self.hub = hub
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._last_prune = 0.0
        self._lock = threading.Lock()
        self._enabled = True

    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self) -> None:
        """Start the thread now, whether or not there's work yet."""
        with self._lock:
            self._enabled = True
            self._start_locked()

    def ensure(self) -> bool:
        """Start the thread if something needs it; True when it's running."""
        with self._lock:
            if not self._enabled:
                return False
            if self.running():
                return True
            try:
                needed = self.hub.has_work()
            except Exception as exc:  # noqa: BLE001
                logger.debug("radio watcher work check failed: %s", exc)
                needed = False
            if needed:
                self._start_locked()
            return needed

    def _start_locked(self) -> None:
        if self.running():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="radio-watcher", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop for good (the module was turned off); ensure() won't restart it."""
        with self._lock:
            self._enabled = False
            self._stop.set()

    def enable(self) -> None:
        """Allow ensure() again (the module was turned back on)."""
        with self._lock:
            self._enabled = True

    def _loop(self) -> None:
        idle_since: Optional[float] = None
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - the watcher never dies of one bad tick
                logger.exception("radio watcher tick failed")
            try:
                busy = self.hub.has_work()
            except Exception:  # noqa: BLE001
                busy = True
            if busy:
                idle_since = None
            else:
                now = time.monotonic()
                idle_since = idle_since if idle_since is not None else now
                if now - idle_since >= IDLE_STOP_SECONDS:
                    with self._lock:
                        # re-check under the lock so a concurrent ensure()
                        # either sees this thread running or starts a new one
                        if not self.hub.has_work():
                            self._thread = None
                            logger.debug("radio watcher stopping: nothing to watch")
                            return
                    idle_since = None
            self._stop.wait(TICK_SECONDS)

    def tick(self) -> None:
        hub = self.hub
        hub.expire()
        if hub.deps is None:
            return
        if hub.identification_on():
            for station in hub.stations_to_poll():
                if self._stop.is_set():
                    return
                if not hub.feed_due(station.id, feeds.FEED_POLL_SECONDS):
                    continue
                try:
                    hub.on_feed(station, feeds.fetch_now_playing(station.now_playing))
                except net.FetchError as exc:
                    hub.on_feed_error(station, str(exc))
                except Exception as exc:  # noqa: BLE001
                    logger.debug("feed for %s failed: %s", station.id, exc)
                    hub.on_feed_error(station, "The station's feed couldn't be read.")
        now = time.time()
        if now - self._last_prune > PRUNE_EVERY:
            self._last_prune = now
            try:
                keep = radio_settings.read(hub.deps.config)["keep_heard_days"]
                store.prune_heard(hub.deps.get_database(), keep, now)
            except Exception as exc:  # noqa: BLE001
                logger.debug("pruning Heard failed: %s", exc)


__all__ = ["Watcher", "TICK_SECONDS", "IDLE_STOP_SECONDS"]
