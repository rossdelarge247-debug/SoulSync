"""Per-file cache-busting versions for ``/static`` URLs.

Static files are served with a one-year ``max-age``, so every URL carries a
``?v=`` that must change whenever the file's bytes do. The version used to be
the newest mtime under ``webui/static``, recomputed by walking the whole folder
on every page render, and one shared value meant that touching any file
invalidated the browser's copy of all of them.

``StaticVersioner`` hashes each file's contents the first time a URL for it is
built and remembers the result for the life of the process. An upgrade starts a
new process, so changed files get new URLs and unchanged files keep theirs
(content hashes do not depend on mtimes, which image builds and copies do not
always preserve). With ``watch=True`` (the dev no-cache mode) the cache is keyed
by mtime and size as well, so files edited while the server runs get a new
version on the next render.
"""

from __future__ import annotations

import hashlib
import os
import threading

from werkzeug.security import safe_join

_DIGEST_SIZE = 6  # 12 hex characters: plenty to tell two versions of one file apart
_CHUNK = 1 << 20


def _file_digest(path: str) -> str:
    digest = hashlib.blake2b(digest_size=_DIGEST_SIZE)
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


class StaticVersioner:
    """Content-hash versions for files under one static folder."""

    def __init__(self, static_folder: str | os.PathLike[str], *, fallback: str, watch: bool = False):
        self.static_folder = os.fspath(static_folder)
        self.fallback = fallback
        self.watch = watch
        self._versions: dict[str, tuple[tuple[int, int] | None, str]] = {}
        self._lock = threading.Lock()

    def version(self, filename: str) -> str:
        """The version for ``filename`` (relative to the static folder).

        Files that do not exist, or that resolve outside the folder, get the
        fallback, so building a URL never raises.
        """
        cached = self._versions.get(filename)
        if cached is not None and not self.watch:
            return cached[1]

        path = safe_join(self.static_folder, filename)
        if path is None:
            return self.fallback
        try:
            stat = os.stat(path)
        except OSError:
            return self.fallback
        signature = (stat.st_mtime_ns, stat.st_size) if self.watch else None
        if cached is not None and cached[0] == signature:
            return cached[1]

        try:
            version = _file_digest(path)
        except OSError:
            return self.fallback
        with self._lock:
            self._versions[filename] = (signature, version)
        return version

    def url_defaults(self, endpoint: str, values: dict) -> None:
        """Flask ``url_defaults`` hook: add ``v`` to ``url_for('static', ...)``.

        A ``v`` the caller passes explicitly is left alone.
        """
        if endpoint != "static" or "v" in values:
            return
        filename = values.get("filename")
        if filename:
            values["v"] = self.version(str(filename))


__all__ = ["StaticVersioner"]
