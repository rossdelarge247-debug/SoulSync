"""AcoustID's lookup API: the one way SYNCHRO.S asks it about a fingerprint.

The download identifier (``core/acoustid_client.py``, through it the library
scanner, auto-import and the radio's automatic fingerprint) and Scan now
(``core/internet_radio/scan_providers.py``) both send their lookups here.
Fingerprinting stays where it is (pyacoustid's Chromaprint or fpcalc on the
caller's side); only the request is made here.

Every request goes through the outbound guard (``core/security/outbound.py``):
the fixed host ``api.acoustid.org`` over TLS (verified), public addresses
only, no redirects (the key is in the body), timeouts on connect and read,
the answer capped. Requests are paced to AcoustID's three a second, as
pyacoustid did.

The key goes in the request body only and is never logged.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable, Dict, Optional, Tuple

from core.security.outbound import RequestFailed, guarded_json

ACOUSTID_HOST = "api.acoustid.org"
ACOUSTID_URL = f"https://{ACOUSTID_HOST}/v2/lookup"
TIMEOUT = (5, 25)            # connect, read
MAX_ANSWER_BYTES = 512 * 1024
REQUEST_INTERVAL = 0.34      # seconds between requests: AcoustID allows three a second

_pace_lock = threading.Lock()
_last_request = 0.0


def _pace(sleep: Callable[[float], None] = time.sleep) -> None:
    global _last_request
    with _pace_lock:
        wait = REQUEST_INTERVAL - (time.monotonic() - _last_request)
        if wait > 0:
            sleep(wait)
        _last_request = time.monotonic()


def lookup(key: str, duration: int, fingerprint: str, *, meta: str = "recordings", timeout=TIMEOUT,
           headers: Optional[Dict[str, str]] = None,
           request: Optional[Callable[..., Any]] = None) -> Tuple[int, Any]:
    """``(HTTP status, parsed JSON or None)`` for one lookup.

    ``duration`` is whole seconds (the caller rounds as it always has).
    Raises :class:`core.security.outbound.RequestFailed` when there's no
    answer to read. ``request`` stands in for the guarded request (a test,
    or Scan now passing its own module's reference).
    """
    if isinstance(fingerprint, bytes):
        fingerprint = fingerprint.decode("ascii", errors="replace")
    data = {"client": key, "duration": str(int(duration)), "fingerprint": fingerprint, "meta": meta,
            "format": "json"}
    hdrs = {"Accept": "application/json"}
    hdrs.update(headers or {})
    _pace()
    return guarded_json("POST", ACOUSTID_URL, data=data, headers=hdrs, timeout=timeout,
                        max_bytes=MAX_ANSWER_BYTES, max_redirects=0, request=request)


__all__ = ["ACOUSTID_HOST", "ACOUSTID_URL", "TIMEOUT", "MAX_ANSWER_BYTES", "RequestFailed", "lookup"]
