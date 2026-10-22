"""Small HTTP reads for radio: now-playing feeds, the directory, tracklists.

Every read goes through the outbound guard (``core/security/outbound.py``):
public addresses only, checked again after DNS and on every redirect. Bodies
are capped, JSON only, and answers are cached briefly so a page full of
listeners never multiplies the requests a station sees.
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any, Dict, Optional, Tuple

from core.security.outbound import OutboundBlocked, guarded_request
from utils.logging_config import get_logger

logger = get_logger("internet_radio.net")

USER_AGENT = "SoulSync-InternetRadio/1.0 (+https://github.com/Nezreka/SoulSync)"
MAX_JSON_BYTES = 2 * 1024 * 1024


class FetchError(Exception):
    """A read failed; ``str()`` is safe to show."""


def _read_capped(resp, limit: int) -> bytes:
    chunks = []
    total = 0
    for chunk in resp.iter_content(chunk_size=32 * 1024):
        if not chunk:
            continue
        total += len(chunk)
        if total > limit:
            raise FetchError("The answer was too big.")
        chunks.append(chunk)
    return b"".join(chunks)


# injectable for tests: (url, params, headers, timeout) -> parsed JSON
_fetcher = None


def set_fetcher(fn) -> None:
    """Tests replace the network with a function; None puts it back."""
    global _fetcher
    _fetcher = fn
    _cache.clear()


def get_json(url: str, *, params: Optional[Dict[str, Any]] = None, timeout: Tuple[float, float] = (4, 8),
             headers: Optional[Dict[str, str]] = None) -> Any:
    if _fetcher is not None:
        return _fetcher(url, params or {}, headers or {}, timeout)
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    hdrs.update(headers or {})
    try:
        resp, _final = guarded_request("GET", url, headers=hdrs, params=params, timeout=timeout, stream=True)
    except OutboundBlocked as exc:
        raise FetchError(str(exc)) from None
    except Exception as exc:  # noqa: BLE001 - every network failure reads the same
        raise FetchError("The station's server didn't answer.") from exc
    try:
        if resp.status_code != 200:
            raise FetchError(f"The server answered {resp.status_code}.")
        ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
        if ctype and "json" not in ctype and ctype != "text/plain":
            raise FetchError("The server didn't answer with data.")
        body = _read_capped(resp, MAX_JSON_BYTES)
    finally:
        resp.close()
    try:
        return json.loads(body.decode("utf-8", errors="replace"))
    except ValueError as exc:
        raise FetchError("The server's answer couldn't be read.") from exc


_cache: Dict[str, Tuple[float, Any]] = {}
_cache_lock = threading.Lock()
_CACHE_MAX = 512


def cached_json(key: str, ttl: float, url: str, **kwargs) -> Any:
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]
    value = get_json(url, **kwargs)
    with _cache_lock:
        if len(_cache) >= _CACHE_MAX:
            for k in sorted(_cache, key=lambda k: _cache[k][0])[: _CACHE_MAX // 4]:
                _cache.pop(k, None)
        _cache[key] = (now, value)
    return value


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


__all__ = ["USER_AGENT", "FetchError", "get_json", "cached_json", "clear_cache", "set_fetcher"]
