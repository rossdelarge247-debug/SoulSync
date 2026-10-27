"""The one gate every Spotify Web API request passes (Spotify throttling, 27 October).

Pure pieces, no I/O, so they can be tested with a fake clock:

- ``TokenBucket``: the process-wide request budget. It refills at the
  configured pace (one request a second by default) up to ``capacity``. A
  person's own request may take any token; background work leaves the last
  ``reserve`` tokens for people, so a scan never makes a click wait.
- ``RollingCounter``: background requests in the last hour, so a backlog
  (enrichment, scans, auto-sync) can't spend more than its hourly share
  however long it runs. Spotify's long waits (hours, not seconds) come from
  sustained volume, not from one burst.
- ``redirect_uri_problem``: Spotify's 2025 redirect-URI rules, so Settings
  and the Authenticate button can say what's wrong before Spotify refuses.
- ``RefreshBackoff``: a failed token refresh is not retried on every call;
  a refresh token Spotify has revoked or expired (``invalid_grant``) is not
  retried at all until a new sign-in saves a new one.

``core/spotify_client.py`` wires these into the requests session spotipy
uses (``GatedSpotifySession``), so every request, pages included, goes
through the same gate, whichever feature or route makes it.
"""

from __future__ import annotations

import hashlib
import ipaddress
import threading
from collections import deque
from typing import Callable, Deque, Dict, Optional
from urllib.parse import urlparse

#: tokens a person's request may wait for before it gives up and answers
#: (a page must never hang on Spotify)
INTERACTIVE_MAX_WAIT = 2.0
#: background work waits as long as it needs, in steps of at most this
BACKGROUND_WAIT_STEP = 5.0
#: the bucket's size: a page's handful of calls goes at once
DEFAULT_CAPACITY = 15
#: the last tokens are a person's: background work never takes them
DEFAULT_RESERVE = 5
#: background requests a rolling hour may spend (about 20 a minute on average)
DEFAULT_BACKGROUND_PER_HOUR = 1200


class TokenBucket:
    """Requests per second with a burst, shared by every thread.

    ``rate`` is a callable so the pace can change while it runs (slower while
    easing back in after a pause). Thread-safe; never sleeps itself: ``take``
    answers 0 when a token was taken, else how long until one would be.
    """

    def __init__(self, rate: Callable[[], float], now: Callable[[], float],
                 capacity: int = DEFAULT_CAPACITY, reserve: int = DEFAULT_RESERVE,
                 start: Optional[float] = None):
        self._rate = rate
        self._now = now
        self.capacity = float(capacity)
        self.reserve = float(min(reserve, max(0, capacity - 1)))
        # Start at the reserve, not full, so a restart doesn't open with a burst.
        self._tokens = float(self.reserve if start is None else start)
        self._stamp: Optional[float] = None
        self._lock = threading.Lock()

    def _refill_locked(self, now: float) -> float:
        rate = max(0.001, float(self._rate()))
        if self._stamp is None:
            self._stamp = now
        elapsed = max(0.0, now - self._stamp)
        self._tokens = min(self.capacity, self._tokens + elapsed * rate)
        self._stamp = now
        return rate

    def take(self, interactive: bool) -> float:
        with self._lock:
            now = self._now()
            rate = self._refill_locked(now)
            floor = 0.0 if interactive else self.reserve
            if self._tokens - 1.0 >= floor - 1e-9:
                self._tokens -= 1.0
                return 0.0
            return max(0.001, (floor + 1.0 - self._tokens) / rate)

    def drain(self) -> None:
        """Empty the bucket (a 429 arrived): what's left in it was a guess."""
        with self._lock:
            self._tokens = 0.0
            self._stamp = self._now()

    @property
    def tokens(self) -> float:
        with self._lock:
            self._refill_locked(self._now())
            return self._tokens


class RollingCounter:
    """Events in the last ``window`` seconds. Thread-safe."""

    def __init__(self, now: Callable[[], float], window: float = 3600.0):
        self._now = now
        self.window = float(window)
        self._events: Deque[float] = deque()
        self._lock = threading.Lock()

    def _trim_locked(self, now: float) -> None:
        while self._events and now - self._events[0] >= self.window:
            self._events.popleft()

    def count(self) -> int:
        with self._lock:
            self._trim_locked(self._now())
            return len(self._events)

    def add(self) -> None:
        with self._lock:
            now = self._now()
            self._trim_locked(now)
            self._events.append(now)

    def seconds_until_below(self, limit: int) -> float:
        """0 when fewer than ``limit`` events are in the window, else how long
        until the oldest that matters falls out."""
        with self._lock:
            now = self._now()
            self._trim_locked(now)
            if len(self._events) < max(1, limit):
                return 0.0
            oldest = self._events[len(self._events) - max(1, limit)]
            return max(0.001, self.window - (now - oldest))


# ── redirect URIs ─────────────────────────────────────────────────────────

#: what to register when SYNCHRO.S and the browser are on the same computer
#: (Docker Desktop on a Mac publishes the callback port on the Mac's loopback)
LOOPBACK_REDIRECT_URI = "http://127.0.0.1:8888/callback"


def _loopback_ip(host: str) -> bool:
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def redirect_uri_problem(uri: Optional[str]) -> Optional[str]:
    """Why Spotify would refuse this redirect URI, in a sentence, or None.

    Spotify's rules since 2025: HTTPS, except a loopback address written as
    an IP literal (``http://127.0.0.1:PORT/...`` or ``http://[::1]:PORT/...``);
    ``localhost`` isn't accepted. Pure.
    """
    text = (uri or "").strip()
    if not text:
        return f"No redirect URI is set. Use {LOOPBACK_REDIRECT_URI}."
    try:
        parsed = urlparse(text)
    except ValueError:
        return "The redirect URI isn't a valid address."
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not host:
        return "The redirect URI must start with http:// or https:// and name a host."
    if host == "localhost" or host.endswith(".localhost"):
        port = f":{parsed.port}" if parsed.port else ""
        fixed = f"{parsed.scheme}://127.0.0.1{port}{parsed.path or '/callback'}"
        return (f"Spotify no longer accepts “localhost” in a redirect URI. Use {fixed} "
                f"here and in your Spotify app's settings.")
    if parsed.scheme == "http" and not _loopback_ip(host):
        return ("Spotify only accepts http:// for 127.0.0.1 (this computer). For another "
                "address, use an https:// address (a reverse proxy or Tailscale), or open "
                f"SYNCHRO.S on this computer and use {LOOPBACK_REDIRECT_URI}.")
    return None


def is_loopback_host(host: Optional[str]) -> bool:
    """A browser on the same computer as the server: 127.0.0.1, ::1, localhost."""
    h = (host or "").strip().lower()
    if h.startswith("[") and "]" in h:
        h = h[1:h.index("]")]
    elif h.count(":") == 1:
        h = h.split(":", 1)[0]
    return h == "localhost" or _loopback_ip(h)


# ── token refresh ─────────────────────────────────────────────────────────

REFRESH_BACKOFF_FIRST = 60.0
REFRESH_BACKOFF_MAX = 3600.0


def _key(refresh_token: Optional[str]) -> str:
    return hashlib.sha256((refresh_token or "").encode("utf-8")).hexdigest()[:16]


class RefreshBackoff:
    """Remembers failed refreshes, by refresh token (hashed, never logged).

    ``wait(token)``: seconds before this token may be tried again (0 = now).
    ``dead(token)``: Spotify said the token is no good (``invalid_grant``);
    it's never tried again; a new sign-in brings a new token.
    """

    def __init__(self, now: Callable[[], float]):
        self._now = now
        self._lock = threading.Lock()
        self._state: Dict[str, Dict[str, float]] = {}

    def wait(self, refresh_token: Optional[str]) -> float:
        with self._lock:
            st = self._state.get(_key(refresh_token))
            if not st:
                return 0.0
            if st.get("dead"):
                return float("inf")
            return max(0.0, st["until"] - self._now())

    def is_dead(self, refresh_token: Optional[str]) -> bool:
        with self._lock:
            return bool((self._state.get(_key(refresh_token)) or {}).get("dead"))

    def failed(self, refresh_token: Optional[str], dead: bool = False) -> float:
        with self._lock:
            k = _key(refresh_token)
            st = self._state.get(k) or {"step": 0.0, "until": 0.0}
            st["step"] = st["step"] + 1
            delay = min(REFRESH_BACKOFF_MAX, REFRESH_BACKOFF_FIRST * (2 ** (st["step"] - 1)))
            st["until"] = self._now() + delay
            if dead:
                st["dead"] = 1.0
            self._state[k] = st
            return delay

    def succeeded(self, refresh_token: Optional[str]) -> None:
        with self._lock:
            self._state.pop(_key(refresh_token), None)

    def clear(self) -> None:
        with self._lock:
            self._state.clear()
