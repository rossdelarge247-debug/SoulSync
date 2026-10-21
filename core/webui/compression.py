"""gzip / brotli compression for the web UI's HTML, JS, CSS, JSON and SVG.

Flask-Compress does the Accept-Encoding negotiation and the encoding. The policy
of what may be compressed lives here, because its default after_request hook
would also touch responses that must go out exactly as produced:

* Partial content (206) and anything with a Content-Range, e.g. audio seeking
  on /stream/audio. Content-Range counts bytes of the identity body.
* Streamed responses (generators): SSE, NDJSON progress feeds, proxied audio.
  An encoder buffers them, so events would stop arriving as they happen. The
  only streamed bodies compressed are finite files from the static endpoints,
  which are read into memory first.
* Audio, images, fonts and anything else not in COMPRESSIBLE_MIMETYPES.

Socket.IO never reaches Flask's after_request (engine.io answers it in WSGI
middleware), so it is not affected either way.

The page shell and static files are the same bytes for every visitor, so their
compressed bodies are cached in memory, keyed by a digest of the uncompressed
body (a changed body can never be answered from the cache). API JSON is
compressed per response and not cached.

Set SOULSYNC_COMPRESSION=0 to switch it off, e.g. behind a reverse proxy that
already compresses. A proxy that compresses leaves responses that already carry
a Content-Encoding alone, so leaving it on there costs only the server's CPU.
"""

from __future__ import annotations

import hashlib
import os
import threading
from collections import OrderedDict

from flask import Flask, Request, Response, g, request

from utils.logging_config import get_logger

logger = get_logger("webui.compression")

COMPRESSION_ENV = "SOULSYNC_COMPRESSION"

COMPRESSIBLE_MIMETYPES = frozenset({
    "text/html",
    "text/css",
    "text/javascript",
    "application/javascript",
    "application/json",
    "application/manifest+json",
    "image/svg+xml",
})

# Endpoints that answer with a file from disk (send_file). Their bodies are
# streamed file wrappers, but finite, so they can be read and compressed whole.
FILE_ENDPOINTS = frozenset({"static", "service_worker"})

# Below this the encoding overhead outweighs the saving.
MIN_SIZE = 1024
# Never read a file bigger than this into memory to compress it.
MAX_FILE_BYTES = 16 * 1024 * 1024
# Upper bound on the compressed bodies kept in memory.
CACHE_MAX_BYTES = 48 * 1024 * 1024

_CACHE_KEY_ATTR = "_soulsync_compress_cache_key"


class CompressedBodyCache:
    """Bounded LRU of compressed bodies, used as Flask-Compress's cache backend.

    Flask-Compress looks entries up as ``"<algorithm>;<COMPRESS_CACHE_KEY>"``.
    Responses that should not be cached get an empty key, and such keys are
    neither looked up nor stored.
    """

    def __init__(self, max_bytes: int = CACHE_MAX_BYTES):
        self.max_bytes = max_bytes
        self.size = 0
        self.hits = 0
        self.misses = 0
        self._entries: OrderedDict[str, bytes] = OrderedDict()
        self._lock = threading.Lock()

    @staticmethod
    def _cacheable(key: str) -> bool:
        return not key.endswith(";")

    def get(self, key: str) -> bytes | None:
        if not self._cacheable(key):
            return None
        with self._lock:
            value = self._entries.get(key)
            if value is None:
                self.misses += 1
                return None
            self._entries.move_to_end(key)
            self.hits += 1
            return value

    def set(self, key: str, value: bytes) -> None:
        if not self._cacheable(key) or len(value) > self.max_bytes:
            return
        with self._lock:
            old = self._entries.pop(key, None)
            if old is not None:
                self.size -= len(old)
            self._entries[key] = value
            self.size += len(value)
            while self.size > self.max_bytes:
                _, evicted = self._entries.popitem(last=False)
                self.size -= len(evicted)


def _cache_key(_request: Request) -> str:
    return g.pop(_CACHE_KEY_ATTR, "")


def is_compressible(req: Request, response: Response) -> bool:
    """Whether ``response`` may be compressed (before the client is asked)."""
    if req.method not in ("GET", "HEAD"):
        return False
    # 206 partials, 304s, redirects and errors go out as they are.
    if response.status_code != 200:
        return False
    if "Content-Encoding" in response.headers or "Content-Range" in response.headers:
        return False
    if response.mimetype not in COMPRESSIBLE_MIMETYPES:
        return False
    if response.is_streamed:
        if req.endpoint not in FILE_ENDPOINTS:
            return False
        length = response.content_length
        if length is None or length > MAX_FILE_BYTES:
            return False
    return True


def compression_enabled() -> bool:
    value = os.environ.get(COMPRESSION_ENV, "1").strip().lower()
    return value not in ("0", "false", "no", "off")


def init_compression(app: Flask, *, enabled: bool | None = None):
    """Register response compression on ``app``. Returns the Compress instance,
    or None when it is switched off or Flask-Compress is not installed.

    Call it right after creating the app: Flask runs after_request hooks in
    reverse order of registration, so registering first means this runs last,
    after every hook that still reads or rewrites the body (the URL-base
    rewrite of the page shell, for one).
    """
    if enabled is None:
        enabled = compression_enabled()
    if not enabled:
        logger.info("Response compression is off (%s)", COMPRESSION_ENV)
        return None
    try:
        from flask_compress import Compress
    except ImportError:
        # an in-place upgrade that skipped `pip install -r requirements.txt`
        # still starts; it just serves everything uncompressed
        logger.warning("Flask-Compress is not installed; responses will not be compressed")
        return None

    app.config.update(
        COMPRESS_REGISTER=False,  # our hook below applies the policy, then calls it
        COMPRESS_MIMETYPES=sorted(COMPRESSIBLE_MIMETYPES),
        COMPRESS_ALGORITHM=["br", "gzip"],
        COMPRESS_STREAMS=False,
        COMPRESS_MIN_SIZE=MIN_SIZE,
        COMPRESS_CACHE_BACKEND=CompressedBodyCache,
        COMPRESS_CACHE_KEY=_cache_key,
    )
    compress = Compress(app)
    app.extensions["soulsync_compress"] = compress

    @app.after_request
    def _compress_response(response: Response) -> Response:
        if not is_compressible(request, response):
            return response
        if response.is_streamed:
            # a file wrapper from a FILE_ENDPOINT: read it so it can be encoded whole
            response.direct_passthrough = False
            response.make_sequence()
        if request.endpoint in FILE_ENDPOINTS or response.mimetype == "text/html":
            body = response.get_data()
            if len(body) >= MIN_SIZE:
                setattr(g, _CACHE_KEY_ATTR, hashlib.blake2b(body, digest_size=16).hexdigest())
        response = compress.after_request(response)
        g.pop(_CACHE_KEY_ATTR, None)
        if "Content-Encoding" in response.headers:
            # byte ranges would address the identity file, not this encoding
            response.headers.pop("Accept-Ranges", None)
        return response

    return compress


__all__ = [
    "COMPRESSIBLE_MIMETYPES",
    "COMPRESSION_ENV",
    "CompressedBodyCache",
    "FILE_ENDPOINTS",
    "init_compression",
    "is_compressible",
]
