"""MilkDrop's preset index (board 10a; docs/design/CONTRACTS.md, "Visuals").

Two sources, one list:

- **Bundled:** the presets of the ``butterchurn-presets`` npm package (MIT
  packaging of the community's converted ``.milk`` presets). ``npm run build``
  copies them out of ``node_modules`` into ``static/dist/visuals/milkdrop/``
  (``webui/scripts/milkdrop-presets.mjs``): an ``index.json`` of
  ``{key, name, size}`` and one ``<key>.json`` per preset. Nothing is kept in
  the repository; an install without a build has no bundled presets.
- **Your own:** an admin-chosen folder of ``.milk`` files
  (``visuals.own_presets_dir``). The browser converts each one when it's
  picked; the server only lists them and hands one back by key.

A preset's name is "Author - Title": the author is what comes before the first
" - " (leading underscores and the like dropped: MilkDrop packs used them to
sort), the title the rest. A name without " - " has no author.

Keys are opaque: ``md-`` + 16 hex for a bundled preset (made by the build
from its name), ``own-`` + 16 hex for one of yours (from its path inside the
folder). A request names a key, never a path; an own preset's key is looked up
in a fresh listing of the folder, and the file it names is checked again
(inside the folder, ``.milk``, a regular file, under the size cap) before it's
read.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

FAMILY_MILKDROP = "milkdrop"
FAMILIES = (FAMILY_MILKDROP,)

BUNDLED_KEY_RE = re.compile(r"^md-[0-9a-f]{16}$")
OWN_KEY_RE = re.compile(r"^own-[0-9a-f]{16}$")

# a .milk file is a few KB; the biggest community presets are under 100 KB
OWN_MAX_BYTES = 512 * 1024
# a folder with more than this many presets is listed up to it
OWN_MAX_FILES = 5000
# how deep the folder is walked (the folder itself is depth 0)
OWN_MAX_DEPTH = 3
# a listing is reused for this long, so typing in the search doesn't walk the disk
OWN_CACHE_SECONDS = 30.0

_LEADING_JUNK = re.compile(r"^[\s_!.\-]+")


def split_name(name: str) -> Tuple[Optional[str], str]:
    """("Author", "Title") from "Author - Title"; (None, name) without " - "."""
    text = str(name or "").strip()
    if " - " not in text:
        return None, text
    author, title = text.split(" - ", 1)
    author = _LEADING_JUNK.sub("", author).strip()
    title = title.strip()
    if not author or not title:
        return None, text
    return author, title


def author_key(author: Optional[str]) -> str:
    return (author or "").casefold()


def bundled_key(name: str) -> str:
    """What the build names a bundled preset's file (kept in step with
    webui/scripts/milkdrop-presets.mjs)."""
    return "md-" + hashlib.sha1(str(name).encode("utf-8")).hexdigest()[:16]


def own_key(relpath: str) -> str:
    rel = str(relpath).replace(os.sep, "/")
    return "own-" + hashlib.sha1(rel.encode("utf-8")).hexdigest()[:16]


def _entry(key: str, full_name: str, size: int, source: str) -> Dict[str, Any]:
    author, title = split_name(full_name)
    return {
        "key": key,
        "name": title,
        "author": author,
        "full_name": full_name,
        "size": int(size),
        "source": source,
    }


# ── bundled ─────────────────────────────────────────────────────────────────

_bundled_lock = threading.Lock()
_bundled_cache: Dict[str, Any] = {"path": None, "mtime": None, "entries": []}


def bundled_dir(static_dir: str) -> str:
    return os.path.join(static_dir, "dist", "visuals", "milkdrop")


def bundled_entries(static_dir: str) -> List[Dict[str, Any]]:
    """The build's index, read once per change of the file. Missing or broken
    reads as no bundled presets."""
    index_path = os.path.join(bundled_dir(static_dir), "index.json")
    try:
        mtime = os.stat(index_path).st_mtime_ns
    except OSError:
        return []
    with _bundled_lock:
        if _bundled_cache["path"] == index_path and _bundled_cache["mtime"] == mtime:
            return _bundled_cache["entries"]
        try:
            with open(index_path, "r", encoding="utf-8") as fh:
                raw = json.load(fh)
        except (OSError, ValueError):
            return []
        entries: List[Dict[str, Any]] = []
        for item in raw.get("presets", []) if isinstance(raw, dict) else []:
            if not isinstance(item, dict):
                continue
            key, name = item.get("key"), item.get("name")
            if not isinstance(key, str) or not BUNDLED_KEY_RE.match(key) or not isinstance(name, str):
                continue
            size = item.get("size") if isinstance(item.get("size"), int) else 0
            entries.append(_entry(key, name, size, "bundled"))
        _bundled_cache.update(path=index_path, mtime=mtime, entries=entries)
        return entries


def bundled_file(static_dir: str, key: str) -> Optional[str]:
    """The path of a bundled preset's JSON, or None for a bad or unknown key."""
    if not isinstance(key, str) or not BUNDLED_KEY_RE.match(key):
        return None
    path = os.path.join(bundled_dir(static_dir), key + ".json")
    return path if os.path.isfile(path) else None


# ── your own ────────────────────────────────────────────────────────────────

_own_lock = threading.Lock()
_own_cache: Dict[str, Any] = {"folder": None, "at": 0.0, "listing": None}


class OwnListing:
    """A walk of the own-presets folder: entries for the index, and the key →
    relative path map that reading one goes through."""

    def __init__(self, folder: str, entries: List[Dict[str, Any]], paths: Dict[str, str],
                 problem: Optional[str], truncated: bool):
        self.folder = folder
        self.entries = entries
        self.paths = paths
        self.problem = problem
        self.truncated = truncated


def _contained(root_real: str, path: str) -> Optional[str]:
    """The real path of ``path`` when it stays inside ``root_real``."""
    try:
        real = os.path.realpath(path)
    except (OSError, ValueError):
        return None
    try:
        if os.path.commonpath([root_real, real]) != root_real:
            return None
    except ValueError:
        return None
    return real


def _walk_own(folder: str) -> OwnListing:
    if not folder:
        return OwnListing("", [], {}, None, False)
    try:
        root_real = os.path.realpath(folder)
    except (OSError, ValueError):
        return OwnListing(folder, [], {}, "unreadable", False)
    if not os.path.isdir(root_real):
        return OwnListing(folder, [], {}, "missing", False)
    entries: List[Dict[str, Any]] = []
    paths: Dict[str, str] = {}
    truncated = False
    stack: List[Tuple[str, int]] = [(root_real, 0)]
    try:
        while stack:
            current, depth = stack.pop()
            try:
                with os.scandir(current) as it:
                    items = sorted(it, key=lambda e: e.name)
            except OSError:
                if current == root_real:
                    return OwnListing(folder, [], {}, "unreadable", False)
                continue
            for item in items:
                if item.name.startswith("."):
                    continue
                real = _contained(root_real, item.path)
                if real is None:
                    continue  # a link out of the folder
                try:
                    if item.is_dir():
                        if depth + 1 <= OWN_MAX_DEPTH:
                            stack.append((real, depth + 1))
                        continue
                    if not item.name.lower().endswith(".milk") or not os.path.isfile(real):
                        continue
                    size = os.stat(real).st_size
                except OSError:
                    continue
                if size <= 0 or size > OWN_MAX_BYTES:
                    continue
                rel = os.path.relpath(real, root_real).replace(os.sep, "/")
                key = own_key(rel)
                if key in paths:
                    continue
                if len(entries) >= OWN_MAX_FILES:
                    truncated = True
                    stack.clear()
                    break
                stem = os.path.splitext(os.path.basename(rel))[0]
                paths[key] = rel
                entries.append(_entry(key, stem, size, "own"))
    except OSError:
        return OwnListing(folder, entries, paths, "unreadable", truncated)
    return OwnListing(folder, entries, paths, None, truncated)


def own_listing(folder: Optional[str], *, fresh: bool = False,
                now: Optional[float] = None) -> OwnListing:
    folder = str(folder or "").strip()
    t = time.monotonic() if now is None else now
    with _own_lock:
        cached = _own_cache["listing"]
        if (not fresh and cached is not None and _own_cache["folder"] == folder
                and t - _own_cache["at"] < OWN_CACHE_SECONDS):
            return cached
    listing = _walk_own(folder)
    with _own_lock:
        _own_cache.update(folder=folder, at=t, listing=listing)
    return listing


def clear_caches() -> None:
    with _own_lock:
        _own_cache.update(folder=None, at=0.0, listing=None)
    with _bundled_lock:
        _bundled_cache.update(path=None, mtime=None, entries=[])


def read_own(folder: Optional[str], key: str) -> Optional[str]:
    """The text of one of your own presets by key, or None. The key is looked
    up in the folder's listing; the file it names is checked again before it's
    read (still inside the folder, .milk, a regular file, under the cap)."""
    if not isinstance(key, str) or not OWN_KEY_RE.match(key):
        return None
    listing = own_listing(folder)
    rel = listing.paths.get(key)
    if rel is None:
        listing = own_listing(folder, fresh=True)
        rel = listing.paths.get(key)
    if rel is None or not listing.folder:
        return None
    try:
        root_real = os.path.realpath(listing.folder)
    except (OSError, ValueError):
        return None
    real = _contained(root_real, os.path.join(root_real, rel))
    if real is None or not real.lower().endswith(".milk"):
        return None
    try:
        if not os.path.isfile(real) or os.path.getsize(real) > OWN_MAX_BYTES:
            return None
        with open(real, "rb") as fh:
            data = fh.read(OWN_MAX_BYTES + 1)
    except OSError:
        return None
    if len(data) > OWN_MAX_BYTES:
        return None
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("latin-1")


# ── the index ───────────────────────────────────────────────────────────────

def _sort_key(entry: Dict[str, Any]) -> Tuple[str, str]:
    return (str(entry.get("name") or "").casefold(), author_key(entry.get("author")))


def matches(entry: Dict[str, Any], terms: Iterable[str]) -> bool:
    hay = f"{entry.get('name') or ''} {entry.get('author') or ''}".casefold()
    return all(t in hay for t in terms)


def authors_of(entries: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Each author once (case folded together, the commonest spelling shown),
    with how many presets, A–Z. Presets without an author aren't counted."""
    groups: Dict[str, Dict[str, int]] = {}
    for e in entries:
        a = e.get("author")
        if not a:
            continue
        spellings = groups.setdefault(author_key(a), {})
        spellings[a] = spellings.get(a, 0) + 1
    out = []
    for k, spellings in groups.items():
        shown = max(spellings.items(), key=lambda kv: (kv[1], kv[0][:1].isupper(), kv[0]))[0]
        out.append({"name": shown, "key": k, "count": sum(spellings.values())})
    out.sort(key=lambda a: a["key"])
    return out


def build_index(static_dir: str, own_folder: Optional[str], *, q: str = "",
                author: str = "") -> Dict[str, Any]:
    bundled = bundled_entries(static_dir)
    own = own_listing(own_folder)
    every = sorted(list(bundled) + list(own.entries), key=_sort_key)
    terms = [t for t in str(q or "").casefold().split() if t]
    wanted_author = author_key(str(author or "").strip()) if author else ""
    presets = [
        e for e in every
        if (not terms or matches(e, terms))
        and (not wanted_author or author_key(e.get("author")) == wanted_author)
    ]
    return {
        "family": FAMILY_MILKDROP,
        "total": len(every),
        "count": len(presets),
        "presets": presets,
        "authors": authors_of(every),
        "own": {
            "configured": bool(str(own_folder or "").strip()),
            "count": len(own.entries),
            "problem": own.problem,
            "truncated": own.truncated,
        },
        "bundled": len(bundled),
    }


__all__ = [
    "FAMILIES", "FAMILY_MILKDROP", "OWN_MAX_BYTES", "OWN_MAX_FILES",
    "author_key", "authors_of", "build_index", "bundled_entries", "bundled_file",
    "bundled_key", "clear_caches", "matches", "own_key", "own_listing", "read_own",
    "split_name",
]
