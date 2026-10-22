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

Once a day it drops Heard rows older than Settings → Radio's days.
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


class Watcher:
    def __init__(self, hub: RadioHub):
        self.hub = hub
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._last_prune = 0.0

    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self) -> None:
        if self.running():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="radio-watcher", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self.hub.reset()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception:  # noqa: BLE001 - the watcher never dies of one bad tick
                logger.exception("radio watcher tick failed")
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


__all__ = ["Watcher", "TICK_SECONDS"]
