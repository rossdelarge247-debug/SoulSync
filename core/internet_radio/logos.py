"""Station logos, fetched by the server and served from our own origin
(HANDOFF 55).

The browser never loads a logo from the station's host. The page gets
``/api/radio/stations/<id>/logo`` (stations.public_station), and that route
asks this module for the logo of a station the server resolved itself: a
built-in pick's ``logo_url`` (stations.json), a directory station's favicon
as Radio Browser lists it (looked up again by uuid), or the logo address an
admin gave a stream link. No address ever comes from the request, so this
is no open image proxy.

What's fetched is held to:

- the outbound guard (core/security/outbound.py): http(s) only, public
  addresses only, every redirect checked again, no proxies from the
  environment;
- raster images only, told by their first bytes, never by what the host says:
  PNG, JPEG, GIF, WebP and ICO. SVG (which can carry script) and everything
  else is refused;
- 512 KB per logo, 4096 px a side when Pillow can read the size;
- a disk cache of 16 MB in all (oldest out first) under storage/radio_logos,
  kept a week; a logo that couldn't be fetched isn't asked for again for six
  hours (the page shows the station's letters meanwhile);
- two fetches at once across the server, one per logo.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple
from urllib.parse import urlparse

from core.internet_radio.net import USER_AGENT
from utils.logging_config import get_logger

logger = get_logger("internet_radio.logos")

MAX_BYTES = 512 * 1024
MAX_SIDE = 4096
CACHE_MAX_BYTES = 16 * 1024 * 1024
OK_TTL = 7 * 24 * 3600
FAIL_TTL = 6 * 3600
FETCH_TIMEOUT = (4, 8)
MAX_URL = 2000
ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/x-icon;q=0.9"

#: what the first bytes say -> the type we serve it as
MIME_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
            "image/x-icon": ".ico"}

_slots = threading.BoundedSemaphore(2)
_locks: Dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_failed: Dict[str, float] = {}


class LogoError(Exception):
    """The logo couldn't be used; ``str()`` is safe to show an admin."""


def sniff(data: bytes) -> Optional[str]:
    """The raster type these bytes start with, or None (SVG, HTML, anything else)."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if len(data) >= 6 and data[:4] == b"\x00\x00\x01\x00" and data[4:6] != b"\x00\x00":
        return "image/x-icon"
    return None


def check_source(url: Any) -> Tuple[bool, str]:
    """(ok, reason) for a logo address before anything is fetched: http or
    https, no user name or password, not too long. The outbound guard checks
    the host when it's fetched."""
    raw = str(url or "").strip()
    if not raw:
        return False, "No logo address was given."
    if len(raw) > MAX_URL or any(c.isspace() for c in raw):
        return False, "That logo address is too long or has spaces in it."
    try:
        parsed = urlparse(raw)
    except ValueError:
        return False, "That isn't a link."
    if parsed.scheme.lower() not in ("http", "https") or not parsed.hostname:
        return False, "A logo address starts with https:// (or http://)."
    if parsed.username or parsed.password:
        return False, "Links with a user name or password in them can't be used."
    return True, ""


def _too_big(data: bytes) -> bool:
    """Pillow reads the size from the header without decoding the image."""
    try:
        from PIL import Image
    except Exception:  # noqa: BLE001 - without Pillow the byte cap is the guard
        return False
    try:
        with Image.open(io.BytesIO(data)) as img:
            w, h = img.size
    except Exception:  # noqa: BLE001 - a header Pillow can't read
        raise LogoError("That logo isn't an image the server can read.") from None
    return w > MAX_SIDE or h > MAX_SIDE or w < 1 or h < 1


def fetch(url: str, *, request: Optional[Callable[..., Any]] = None) -> Tuple[bytes, str]:
    """``(bytes, mime)`` for a logo address, or :class:`LogoError`."""
    ok, reason = check_source(url)
    if not ok:
        raise LogoError(reason)
    if request is None:
        from core.security.outbound import guarded_request as request
    from core.security.outbound import OutboundBlocked

    try:
        resp, _final = request("GET", url, headers={"User-Agent": USER_AGENT, "Accept": ACCEPT},
                               timeout=FETCH_TIMEOUT, stream=True)
    except OutboundBlocked as exc:
        raise LogoError(str(exc)) from None
    except Exception as exc:  # noqa: BLE001 - network trouble is "couldn't fetch"
        raise LogoError("The logo's address didn't answer.") from exc
    try:
        if resp.status_code != 200:
            raise LogoError(f"The logo's address answered {resp.status_code}.")
        declared = (resp.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if declared and not declared.startswith("image/") and declared not in (
                "application/octet-stream", "binary/octet-stream"):
            raise LogoError("That address isn't an image.")
        if "svg" in declared:
            raise LogoError("SVG logos can't be used: PNG, JPEG, GIF, WebP or ICO only.")
        length = resp.headers.get("Content-Length")
        if length and length.isdigit() and int(length) > MAX_BYTES:
            raise LogoError("That logo is bigger than 512 KB.")
        buf = bytearray()
        for chunk in resp.iter_content(16384):
            if not chunk:
                continue
            buf.extend(chunk)
            if len(buf) > MAX_BYTES:
                raise LogoError("That logo is bigger than 512 KB.")
    finally:
        try:
            resp.close()
        except Exception:  # noqa: BLE001, S110 - closing is best effort
            pass
    data = bytes(buf)
    mime = sniff(data)
    if mime is None:
        raise LogoError("That isn't a PNG, JPEG, GIF, WebP or ICO image (SVG can't be used).")
    if mime != "image/x-icon" and _too_big(data):
        raise LogoError("That logo is more than 4096 pixels a side.")
    return data, mime


# ── the disk cache ───────────────────────────────────────────────────────────

def cache_dir() -> Path:
    override = os.environ.get("SOULSYNC_RADIO_LOGO_DIR")
    if override:
        return Path(override)
    try:
        from core.settings import config_manager
        base = Path(getattr(config_manager, "base_dir", None) or ".")
    except Exception:  # noqa: BLE001
        base = Path(".")
    return base / "storage" / "radio_logos"


def cache_key(url: str) -> str:
    return hashlib.sha256(str(url).encode("utf-8")).hexdigest()


def version(url: str) -> str:
    """A short tag for the page's address, so a new logo isn't the old one from the browser's cache."""
    return cache_key(url)[:10]


def _paths(key: str) -> Tuple[Path, Path]:
    root = cache_dir()
    return root / f"{key}.img", root / f"{key}.json"


def cached(url: str, *, now: Optional[float] = None) -> Optional[Tuple[Path, str]]:
    """``(file, mime)`` when the logo is on disk and fresh."""
    img, meta = _paths(cache_key(url))
    try:
        info = json.loads(meta.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    mime = info.get("mime")
    if mime not in MIME_EXT or info.get("url") != url or not img.is_file():
        return None
    if (now or time.time()) - float(info.get("fetched_at") or 0) > OK_TTL:
        return None
    try:
        os.utime(img)  # served: the last to go when the cache is pruned
    except OSError:
        pass
    return img, mime


def _store(url: str, data: bytes, mime: str) -> Tuple[Path, str]:
    root = cache_dir()
    root.mkdir(parents=True, exist_ok=True)
    img, meta = _paths(cache_key(url))
    tmp = img.with_suffix(".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, img)
    meta.write_text(json.dumps({"url": url, "mime": mime, "fetched_at": time.time(), "size": len(data)}),
                    encoding="utf-8")
    prune()
    return img, mime


def prune(limit: int = CACHE_MAX_BYTES) -> int:
    """Keep the cache under ``limit`` bytes, oldest first. Returns files removed."""
    root = cache_dir()
    try:
        files = [(p.stat().st_mtime, p.stat().st_size, p) for p in root.glob("*.img")]
    except OSError:
        return 0
    total = sum(size for _, size, _ in files)
    removed = 0
    for _mtime, size, path in sorted(files):
        if total <= limit:
            break
        for victim in (path, path.with_suffix(".json")):
            try:
                victim.unlink()
            except OSError:
                pass
        total -= size
        removed += 1
    return removed


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        lock = _locks.get(key)
        if lock is None:
            lock = _locks[key] = threading.Lock()
            if len(_locks) > 512:  # forget idle ones; a held lock is still referenced by its holder
                for k in list(_locks)[:256]:
                    if k != key and not _locks[k].locked():
                        _locks.pop(k, None)
        return lock


def logo_for(url: str, *, request: Optional[Callable[..., Any]] = None,
             now: Optional[float] = None) -> Optional[Tuple[Path, str]]:
    """The logo of a station the server resolved: from the cache, or fetched
    now (one per logo, two at a time). None when there's none to show."""
    if not url:
        return None
    hit = cached(url, now=now)
    if hit:
        return hit
    key = cache_key(url)
    t = now or time.time()
    if t - _failed.get(key, 0) < FAIL_TTL:
        return None
    with _lock_for(key):
        hit = cached(url, now=now)
        if hit:
            return hit
        if not _slots.acquire(timeout=10):
            return None  # busy: letters this time, the next visit tries again
        try:
            data, mime = fetch(url, request=request)
        except LogoError as exc:
            _failed[key] = time.time()
            logger.debug("station logo %s not used: %s", url, exc)
            return None
        finally:
            _slots.release()
        try:
            return _store(url, data, mime)
        except OSError as exc:
            logger.warning("Couldn't keep a station logo on disk: %s", exc)
            return None


def reset_for_tests() -> None:
    _failed.clear()
    with _locks_guard:
        _locks.clear()


__all__ = ["LogoError", "sniff", "check_source", "fetch", "logo_for", "cached", "prune", "cache_dir",
           "version", "MAX_BYTES", "CACHE_MAX_BYTES", "MIME_EXT"]
