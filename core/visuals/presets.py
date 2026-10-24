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

The build marks each bundled preset ``curated`` when it's in one of the
packs the package curates (main, Extra, Extra 2, MD1; 395 presets). The index
lists those and your own by default (``set="curated"``); ``set="all"`` adds
the rest. A build from before the mark counts every bundled preset as
curated. In the curated set, presets the person kept (their favourites, and
the keys the browser names from Recent) come back separately as ``kept`` so
Favourites and Recent keep what's in them (HANDOFF 101).

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

SET_CURATED = "curated"
SET_ALL = "all"
SETS = (SET_CURATED, SET_ALL)

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
# a fresh walk (an unknown key asks for one) at most this often per folder
OWN_FRESH_SECONDS = 5.0
# how many folder entries one walk looks at, whatever they are, before it stops
OWN_MAX_SCAN = 50000

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


def _entry(key: str, full_name: str, size: int, source: str,
           curated: Optional[bool] = None) -> Dict[str, Any]:
    author, title = split_name(full_name)
    out = {
        "key": key,
        "name": title,
        "author": author,
        "full_name": full_name,
        "size": int(size),
        "source": source,
    }
    if curated is not None:
        out["curated"] = bool(curated)
    return out


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
            # an index built before the mark: every preset counts as curated
            curated = item.get("curated") if isinstance(item.get("curated"), bool) else True
            entries.append(_entry(key, name, size, "bundled", curated))
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
                 problem: Optional[str], truncated: bool, too_big: int = 0,
                 read_at: Optional[float] = None):
        self.folder = folder
        self.entries = entries
        self.paths = paths
        self.problem = problem
        self.truncated = truncated
        #: .milk files left out for being over OWN_MAX_BYTES (the settings line says so)
        self.too_big = too_big
        #: when the folder was read (seconds since the epoch), for "read 2 minutes ago"
        self.read_at = time.time() if read_at is None else read_at

    def summary(self) -> Dict[str, Any]:
        """What the panel and Player settings say about the folder."""
        return {
            "configured": bool(self.folder),
            "count": len(self.entries),
            "problem": self.problem,
            "truncated": self.truncated,
            "too_big": self.too_big,
            "read_at": int(self.read_at) if self.folder else None,
        }


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
    too_big = 0
    scanned = 0
    stack: List[Tuple[str, int]] = [(root_real, 0)]
    try:
        while stack:
            current, depth = stack.pop()
            try:
                with os.scandir(current) as it:
                    items = []
                    for entry in it:
                        scanned += 1
                        if scanned > OWN_MAX_SCAN:
                            truncated = True
                            break
                        items.append(entry)
                items.sort(key=lambda e: e.name)
            except OSError:
                if current == root_real:
                    return OwnListing(folder, [], {}, "unreadable", False)
                continue
            for item in items:
                if item.name.startswith("."):
                    continue
                try:
                    # the name first: only folders and .milk files are resolved
                    if not item.name.lower().endswith(".milk") and not item.is_dir():
                        continue
                except OSError:
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
                if size > OWN_MAX_BYTES:
                    too_big += 1
                    continue
                if size <= 0:
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
            if scanned > OWN_MAX_SCAN:
                stack.clear()
    except OSError:
        return OwnListing(folder, entries, paths, "unreadable", truncated, too_big)
    return OwnListing(folder, entries, paths, None, truncated, too_big)


_own_walks: Dict[str, threading.Event] = {}


def own_listing(folder: Optional[str], *, fresh: bool = False,
                now: Optional[float] = None) -> OwnListing:
    """The folder's listing, reused for 30 s. ``fresh`` walks again, but at
    most once every 5 s per folder; callers that arrive while a walk runs
    wait for it and share its answer."""
    folder = str(folder or "").strip()
    while True:
        t = time.monotonic() if now is None else now
        with _own_lock:
            cached = _own_cache["listing"]
            if cached is not None and _own_cache["folder"] == folder:
                age = t - _own_cache["at"]
                if age < (OWN_FRESH_SECONDS if fresh else OWN_CACHE_SECONDS):
                    return cached
            running = _own_walks.get(folder)
            if running is None:
                done = threading.Event()
                _own_walks[folder] = done
                break
        running.wait(60)
        with _own_lock:
            cached = _own_cache["listing"]
            if cached is not None and _own_cache["folder"] == folder:
                return cached
    try:
        listing = _walk_own(folder)
        with _own_lock:
            _own_cache.update(folder=folder, at=time.monotonic() if now is None else now, listing=listing)
        return listing
    finally:
        with _own_lock:
            _own_walks.pop(folder, None)
        done.set()


def clear_caches() -> None:
    """Forget the listings (a new folder was saved)."""
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
                author: str = "", set_name: str = SET_CURATED,
                keep: Iterable[str] = ()) -> Dict[str, Any]:
    """The list MilkDrop's browser shows. ``set_name`` "curated" lists the
    curated packs and your own; "all" every preset. ``keep`` names presets
    to hand back in ``kept`` when the set leaves them out (favourites and
    Recent), so the browser can still name and play them."""
    if set_name not in SETS:
        raise ValueError(f"unknown set: {set_name!r}")
    bundled = bundled_entries(static_dir)
    own = own_listing(own_folder)
    curated = [e for e in bundled if e.get("curated", True)]
    listed_bundled = bundled if set_name == SET_ALL else curated
    every = sorted(list(listed_bundled) + list(own.entries), key=_sort_key)
    terms = [t for t in str(q or "").casefold().split() if t]
    wanted_author = author_key(str(author or "").strip()) if author else ""
    presets = [
        e for e in every
        if (not terms or matches(e, terms))
        and (not wanted_author or author_key(e.get("author")) == wanted_author)
    ]
    kept: List[Dict[str, Any]] = []
    if set_name == SET_CURATED:
        wanted = {k for k in keep if isinstance(k, str) and BUNDLED_KEY_RE.match(k)}
        if wanted:
            kept = sorted((e for e in bundled if e["key"] in wanted and not e.get("curated", True)),
                          key=_sort_key)
    return {
        "family": FAMILY_MILKDROP,
        "set": set_name,
        "total": len(every),
        "count": len(presets),
        "presets": presets,
        "kept": kept,
        "authors": authors_of(every),
        "own": {**own.summary(), "configured": bool(str(own_folder or "").strip())},
        "bundled": len(bundled),
        "curated": len(curated),
        "uncurated": len(bundled) - len(curated),
    }


__all__ = [
    "FAMILIES", "FAMILY_MILKDROP", "OWN_MAX_BYTES", "OWN_MAX_FILES", "SETS", "SET_ALL", "SET_CURATED",
    "author_key", "authors_of", "build_index", "bundled_entries", "bundled_file",
    "bundled_key", "clear_caches", "matches", "own_key", "own_listing", "read_own",
    "split_name",
]
