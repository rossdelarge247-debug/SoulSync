"""Export to Traktor Pro 3 (BACKLOG "DJ area", stage 2a; board 21a).

A set of library tracks becomes a Traktor playlist file (``.nml``) that the
person imports in Traktor (File → Import Playlist…, or right-click Playlists
→ Import Playlist). SYNCHRO.S never touches Traktor's own files here.

The file
========

An NML file is XML. What this module writes, and how sure we are of it
(HANDOFF, "DJ stage 2a"):

Confirmed (a real Traktor collection.nml, the open-source readers Mixxx
``traktorfeature.cpp``, trak2rek and dj-data-converter)::

    <NML VERSION="19">
      <HEAD COMPANY="www.native-instruments.com" PROGRAM="Traktor"/>
      <COLLECTION ENTRIES="n">
        <ENTRY TITLE=".." ARTIST="..">
          <LOCATION VOLUME="Music HD" DIR="/:SoulSync/:Transfer/:Artist/:" FILE="01 x.flac"/>
          <ALBUM TITLE=".."/>
          <INFO PLAYTIME="391" KEY="1m" .../>
          <TEMPO BPM="124.000000"/>
          <MUSICAL_KEY VALUE="21"/>
        </ENTRY>
      </COLLECTION>
      <PLAYLISTS>
        <NODE TYPE="FOLDER" NAME="$ROOT"><SUBNODES COUNT="1">
          <NODE TYPE="PLAYLIST" NAME="Sunday Set">
            <PLAYLIST ENTRIES="n" TYPE="LIST" UUID="..">
              <ENTRY><PRIMARYKEY TYPE="TRACK" KEY="Music HD/:SoulSync/:..../:01 x.flac"/></ENTRY>
            </PLAYLIST>
          </NODE>
        </SUBNODES></NODE>
      </PLAYLISTS>
    </NML>

* ``DIR`` is the folder with every ``/`` written ``/:`` and a trailing
  ``/:``; ``PRIMARYKEY KEY`` is ``VOLUME + DIR + FILE``.
* On a Mac ``VOLUME`` is the volume's name: ``/Volumes/Music HD/…`` is
  ``VOLUME="Music HD"`` with the rest as ``DIR`` (Mixxx rebuilds the path as
  ``/Volumes/<VOLUME><DIR><FILE>``).
* ``MUSICAL_KEY VALUE`` is 0–23: 0–11 the major keys from C upwards by
  semitone (0 C, 1 D♭, … 7 G, … 11 B), 12–23 the minor keys the same way (12
  Cm, … 21 Am, 23 Bm). A real file pairs ``VALUE="7"`` with ``KEY="2d"`` (G
  major in Open Key). ``INFO KEY`` is the key as text; Traktor writes Open
  Key there, so this does too.

Assumed (no Traktor here to try it on; Ross checks, see HANDOFF):

* a file under ``/Users/…`` sits on the start-up disk, named ``Macintosh
  HD`` (the macOS default) unless the drive helper names it;
* Traktor resolves ``LOCATION`` without ``VOLUMEID`` (it writes one, a
  volume's serial, which SYNCHRO.S can't know) and accepts a file without
  ``MODIFIED_DATE``, ``AUDIO_ID`` or ``BPM_QUALITY``;
* on import Traktor adds a track it doesn't have with this BPM and key and
  keeps its own values for a track it already has.

A track the person starred (core/stars) is written with Traktor's top
rating, ``INFO RANKING="255"`` (Traktor keeps a rating as 0–255 in steps of
51; 255 is five stars). Others carry no RANKING, so Traktor keeps its own.

Never written: cue points, beat grids (``CUE_V2``), ``LOCK``.

Mac paths
=========

Traktor needs the path the Mac sees, not the container's. ``mac_path_for``
asks the drive helper's host map first (``core.drives.host_paths.to_host``,
the names ``drives-helper.sh --names`` records), then the Traktor card's "Your music on the Mac" setting, which names where the
library folder (``soulseek.transfer_path``, ``/app/Transfer``) is on the
Mac. A track neither can place is left out, with the reason.
"""

from __future__ import annotations

import errno
import os
import posixpath
import re
import secrets
import stat
import threading
import time
import unicodedata
import uuid
# ElementTree only builds the file here; nothing is ever parsed, so there is no
# XXE to defuse (defusedxml has no builder).
import xml.etree.ElementTree as ET  # nosemgrep
from contextlib import closing
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from core.dj.camelot import parse_key
from core.dj.store import KEY_CONFIDENT, _scope, _shape_track, _track_select, mixes_with
from utils.logging_config import get_logger

logger = get_logger("dj.traktor")

SETTING_MAC_PATH = "library.traktor_mac_path"
SETTING_EXPORT_FOLDER = "library.traktor_export_folder"

#: the most tracks one export takes (ids in a request, rows of a playlist)
MAX_TRACKS = 1000
#: the start-up disk's name when nothing better is known (macOS's default)
BOOT_VOLUME = "Macintosh HD"
#: where Traktor Pro 3 keeps its collection, said on the card (step 2b reads it)
COLLECTION_HINT = "collection.nml in Documents/Native Instruments/Traktor 3.x"
NML_VERSION = "19"
#: the longest text kept in one attribute
MAX_TEXT = 1000

# ── keys ──────────────────────────────────────────────────────────────────────


def traktor_key_value(code: Any) -> Optional[int]:
    """Traktor's ``MUSICAL_KEY VALUE`` (0–23) for any key spelling: the root's
    pitch class (C = 0), plus 12 for a minor key. None when it isn't a key."""
    key = parse_key(code)
    if not key:
        return None
    return int(key["pitch"]) % 12 + (12 if key["minor"] else 0)


def open_key(code: Any) -> Optional[str]:
    """Open Key text ("1m", "2d"), what Traktor shows and writes in INFO KEY.
    Camelot 8A = 1m, 8B = 1d, so the number shifts by seven."""
    key = parse_key(code)
    if not key:
        return None
    number = int(str(key["camelot"])[:-1])
    return f"{(number - 8) % 12 + 1}{'m' if key['minor'] else 'd'}"


def confident_key(dj: Optional[Dict[str, Any]]) -> Optional[str]:
    """The Camelot code to write, only when SYNCHRO.S is sure of it: a key from
    the file's own tag, or analysis at or above Sample Studio's threshold."""
    dj = dj or {}
    code = dj.get("key")
    if not code or dj.get("key_uncertain"):
        return None
    source = dj.get("key_source")
    if source == "tag":
        return code
    conf = dj.get("key_confidence")
    try:
        return code if source == "analysis" and conf is not None and float(conf) >= KEY_CONFIDENT else None
    except (TypeError, ValueError):
        return None


# ── text ──────────────────────────────────────────────────────────────────────

# characters XML 1.0 can't carry at all, even escaped
_NOT_XML = re.compile("[^\u0009\u000a\u000d -퟿-�\U00010000-\U0010ffff]")


def xml_text(value: Any, limit: int = MAX_TEXT) -> str:
    """Untrusted text made safe to put in an attribute: characters XML can't
    hold are dropped (the library builds the escapes), and it's capped."""
    text = "" if value is None else str(value)
    return _NOT_XML.sub("", text)[:limit]


_UNSAFE_NAME = re.compile(r'[\x00-\x1f\x7f/\\:*?"<>|]+')


#: names Traktor keeps for its own files: an export never takes one
_TRAKTOR_OWN = {"collection"}


def safe_filename(name: Any, suffix: str = ".nml") -> str:
    """A file name from a playlist's name: no folders, no control, format
    (``Cf``: the right-to-left override, zero-width characters) or reserved
    characters, no leading dots, at most 80 characters before the suffix, and
    never Traktor's own ``collection.nml``."""
    text = unicodedata.normalize("NFC", xml_text(name, 400))
    text = "".join(c for c in text if unicodedata.category(c) != "Cf")
    text = _UNSAFE_NAME.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip().lstrip(". ")
    text = text[:80].rstrip(" .")
    if text.casefold() in _TRAKTOR_OWN:
        text = f"{text} (playlist)"
    return f"{text or 'Traktor export'}{suffix}"


def ascii_filename(name: str) -> str:
    """The plain-ASCII fallback of a file name for Content-Disposition."""
    stem = name[:-4] if name.lower().endswith(".nml") else name
    text = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r'[^A-Za-z0-9 ._()\-]+', "", text).strip().lstrip(". ")
    return f"{text}.nml" if text else "Traktor export.nml"


# ── Mac paths ─────────────────────────────────────────────────────────────────

def _load_to_host() -> Optional[Callable[[str], Optional[str]]]:
    """The drive helper's map from a container path to the Mac's; where it
    knows nothing (None), the card's setting is used."""
    from core.drives.host_paths import to_host
    return to_host


#: how many stored paths one export may look up on disk (each can ask the media
#: server where its music lives), and for how long
RESOLVE_BUDGET = 50
RESOLVE_SECONDS = 5.0
#: a stored path that resolved to nothing isn't looked up again for this long
MISS_TTL_SECONDS = 300.0
_MISS_CACHE_MAX = 5000
_misses: Dict[str, float] = {}
_misses_lock = threading.Lock()


def _missed_recently(stored: str) -> bool:
    with _misses_lock:
        until = _misses.get(stored)
        if until is None:
            return False
        if until < time.monotonic():
            _misses.pop(stored, None)
            return False
        return True


def _remember_miss(stored: str) -> None:
    with _misses_lock:
        if len(_misses) >= _MISS_CACHE_MAX:
            now = time.monotonic()
            for key in [k for k, v in _misses.items() if v < now][:_MISS_CACHE_MAX // 2] or list(_misses)[:100]:
                _misses.pop(key, None)
        _misses[stored] = time.monotonic() + MISS_TTL_SECONDS


def clear_resolve_misses() -> None:
    """Forget the remembered misses (tests; a library rescan)."""
    with _misses_lock:
        _misses.clear()


def _same_path_mounts() -> bool:
    """Whether this container sees ``/Volumes`` or ``/Users``: only then can a
    resolved path be the Mac's own without a Mac path set."""
    return os.path.isdir("/Volumes") or os.path.isdir("/Users")


def _norm(path: str) -> str:
    return posixpath.normpath(path) if path else ""


def _inside(path: str, root: str) -> Optional[str]:
    """``path`` relative to ``root`` (both normalised), or None when outside."""
    if not path or not root:
        return None
    if path == root:
        return ""
    base = root.rstrip("/") + "/"
    return path[len(base):] if path.startswith(base) else None


def valid_mac_path(value: Any) -> Optional[str]:
    """A Mac folder as typed on the card, tidied, or None when it isn't one: an
    absolute POSIX path without ``..``, control characters or a ``~``."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or len(text) > 500 or not text.startswith("/") or _NOT_XML.search(text):
        return None
    if any(ord(c) < 32 for c in text) or "\\" in text:
        return None
    parts = [p for p in text.split("/") if p]
    if any(p in (".", "..") for p in parts):
        return None
    return "/" + "/".join(parts) if parts else None


class MacPaths:
    """Works out the path the Mac sees for a library file.

    ``library_root`` is the library folder as SYNCHRO.S sees it
    (``/app/Transfer``); ``mac_root`` is the card's "Your music on the Mac"
    for it. ``to_host`` is the drive helper's map, asked first. ``resolve``
    finds a stored path's file on disk when the stored one isn't under the
    library folder (a media server's path)."""

    def __init__(self, library_root: str, mac_root: Optional[str], *,
                 to_host: Optional[Callable[[str], Optional[str]]] = None,
                 resolve: Optional[Callable[[str], Optional[str]]] = None,
                 resolve_budget: int = RESOLVE_BUDGET, resolve_seconds: float = RESOLVE_SECONDS,
                 same_path_mounts: Optional[bool] = None, clock: Callable[[], float] = time.monotonic):
        self.library_root = _norm(library_root)
        self.mac_root = valid_mac_path(mac_root) if mac_root else None
        self.to_host = to_host
        self.resolve = resolve
        # looking a path up on disk can only help when something can place the
        # result: a Mac path, the helper's map, or a /Volumes or /Users mount
        if self.mac_root is None and to_host is None:
            mounts = _same_path_mounts() if same_path_mounts is None else same_path_mounts
            if not mounts:
                self.resolve = None
        self.resolve_budget = max(0, int(resolve_budget))
        self.resolve_seconds = float(resolve_seconds)
        self._clock = clock
        self._started: Optional[float] = None
        self.resolved = 0

    def _place(self, path: str) -> Optional[str]:
        if self.to_host is not None:
            try:
                host = self.to_host(path)
            except Exception as exc:  # noqa: BLE001 - the helper's map is a hint
                logger.debug("host path lookup failed: %s", exc)
                host = None
            if host and valid_mac_path(host):
                return valid_mac_path(host)
        rel = _inside(path, self.library_root)
        if rel is not None and self.mac_root:
            return posixpath.join(self.mac_root, rel) if rel else self.mac_root
        # a /Volumes:/Volumes (or /Users) mount is the same path inside and out (HANDOFF 160)
        if path.startswith(("/Volumes/", "/Users/")):
            return valid_mac_path(path)
        return None

    def mac_path_for(self, stored: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
        """``(mac_path, None)`` or ``(None, reason)`` for a track's stored path."""
        if not stored:
            return None, "not_in_library"
        path = _norm(str(stored).replace("\\", "/"))
        found = self._place(path)
        if found:
            return found, None
        if self.resolve is not None and not _missed_recently(str(stored)):
            if self._started is None:
                self._started = self._clock()
            if (self.resolved >= self.resolve_budget
                    or self._clock() - self._started > self.resolve_seconds):
                return None, "lookup_limit"
            self.resolved += 1
            try:
                on_disk = self.resolve(str(stored))
            except Exception as exc:  # noqa: BLE001 - unreadable: say so below
                logger.debug("resolve failed for a stored path: %s", exc)
                on_disk = None
            if not on_disk:
                _remember_miss(str(stored))
            elif _norm(on_disk) != path:
                found = self._place(_norm(on_disk))
                if found:
                    return found, None
        if not self.mac_root:
            # neither the helper's names nor the card's setting place it
            return None, "no_mac_path"
        return None, "outside"

    @property
    def example_root(self) -> Optional[str]:
        return self.mac_root


def nml_location(mac_path: str, boot_volume: str = BOOT_VOLUME) -> Optional[Dict[str, str]]:
    """``{"VOLUME", "DIR", "FILE"}`` for a Mac path, or None when Traktor's
    ``/:`` notation can't spell it (a name that starts with a colon would read
    as a separator)."""
    path = valid_mac_path(mac_path)
    if not path:
        return None
    parts = path.split("/")[1:]
    if parts[0] == "Volumes" and len(parts) >= 3:
        volume, folders, name = parts[1], parts[2:-1], parts[-1]
    else:
        volume, folders, name = boot_volume, parts[:-1], parts[-1]
    if not name or any(p.startswith(":") for p in [volume, *folders, name]):
        return None
    folder = "".join(f"/:{p}" for p in folders) + "/:"
    return {"VOLUME": volume, "DIR": folder, "FILE": name}


def primary_key(location: Dict[str, str]) -> str:
    return f"{location['VOLUME']}{location['DIR']}{location['FILE']}"


# ── what goes in ──────────────────────────────────────────────────────────────

REASON_WORDS = {
    "not_in_library": "isn't a file in your library",
    "no_mac_path": "SYNCHRO.S doesn't know where your music is on the Mac yet",
    "outside": "is in a folder the Mac path doesn't cover",
    "bad_path": "has a path Traktor can't read",
    "too_many": "is past the 1,000 tracks one export takes",
    "lookup_limit": "wasn't looked for on disk: too many to look up in one export",
}


def _left(title: str, artist: str, reason: str) -> Dict[str, Any]:
    return {"title": title or "", "artist": artist or "", "reason": reason, "words": REASON_WORDS[reason]}


def tracks_by_ids(database, ids: Sequence[str], fix_art=None) -> List[Dict[str, Any]]:
    """Library tracks with a file, in the order asked, from the caller's
    library only (``store._scope``): an id from another profile's library
    isn't there."""
    wanted = [str(i) for i in ids if i not in (None, "")][:MAX_TRACKS]
    if not wanted:
        return []
    where, params = _scope(database)
    found: Dict[str, Dict[str, Any]] = {}
    with closing(database._get_connection()) as conn:
        for start in range(0, len(wanted), 250):
            chunk = wanted[start:start + 250]
            rows = conn.execute(
                f"{_track_select()} WHERE t.id IN ({','.join('?' * len(chunk))}) AND {where} "
                f"AND t.file_path IS NOT NULL AND t.file_path != ''", list(chunk) + list(params)).fetchall()
            for row in rows:
                shaped = _shape_track(row, fix_art)
                found[shaped["id"]] = shaped
    return [found[i] for i in wanted if i in found]


def _low(text: Any) -> str:
    return str(text or "").strip().lower()


def playlist_tracks(database, playlist_id: int, profile_id: Optional[int]) -> Optional[Dict[str, Any]]:
    """A playlist's rows matched to the caller's library by title and artist.
    ``profile_id`` None reads any playlist (an admin); a playlist that isn't
    the caller's reads as missing (None). Returns ``{"name", "rows": [(track
    or None, title, artist)], "over": n}``."""
    playlist = database.get_mirrored_playlist(int(playlist_id), profile_id=profile_id)
    if not playlist:
        return None
    try:
        from core.playlists.naming import effective_mirrored_name

        name = effective_mirrored_name(playlist)
    except Exception:  # noqa: BLE001 - its stored name will do
        name = playlist.get("name")
    rows = database.get_mirrored_playlist_tracks(int(playlist_id)) or []
    over = max(0, len(rows) - MAX_TRACKS)
    rows = rows[:MAX_TRACKS]
    titles = sorted({_low(r.get("track_name")) for r in rows} - {""})
    candidates: Dict[Tuple[str, str], Dict[str, Any]] = {}
    if titles:
        where, params = _scope(database)
        with closing(database._get_connection()) as conn:
            for start in range(0, len(titles), 250):
                chunk = titles[start:start + 250]
                found = conn.execute(
                    f"{_track_select()} WHERE {where} AND t.file_path IS NOT NULL AND t.file_path != '' "
                    f"AND LOWER(t.title) IN ({','.join('?' * len(chunk))}) ORDER BY t.id",
                    list(params) + list(chunk)).fetchall()
                for row in found:
                    shaped = _shape_track(row)
                    candidates.setdefault((_low(shaped["title"]), _low(shaped["artist_name"])), shaped)
    out = []
    for r in rows:
        title, artist = str(r.get("track_name") or ""), str(r.get("artist_name") or "")
        out.append((candidates.get((_low(title), _low(artist))), title, artist))
    return {"name": name or "Playlist", "rows": out, "over": over}


def mixes_tracks(database, track_id: str, *, tolerance: float) -> Optional[Dict[str, Any]]:
    """"Mixes well with…": the seed first, then up to 200 matches, in the
    panel's order."""
    result = mixes_with(database, str(track_id), limit=200, tolerance=tolerance)
    seed = result.get("track")
    if seed is None:
        return None
    return {"name": f"Mixes with {seed.get('title') or 'this track'}", "tracks": [seed, *result.get("matches", [])]}


def plan(items: Iterable[Tuple[Optional[Dict[str, Any]], str, str]], paths: MacPaths, *,
         over: int = 0) -> Dict[str, Any]:
    """Which tracks go in and why the rest are left out. ``items`` is
    ``(track or None, title, artist)`` in playlist order."""
    entries: List[Dict[str, Any]] = []
    left: List[Dict[str, Any]] = []
    total = 0
    for track, title, artist in items:
        total += 1
        if track is None:
            left.append(_left(title, artist, "not_in_library"))
            continue
        mac, reason = paths.mac_path_for(track.get("file_path"))
        if not mac:
            left.append(_left(track.get("title") or title, track.get("artist_name") or artist, reason or "outside"))
            continue
        location = nml_location(mac)
        if location is None:
            left.append(_left(track.get("title") or title, track.get("artist_name") or artist, "bad_path"))
            continue
        entries.append({"track": track, "mac_path": mac, "location": location})
    for _ in range(over):
        total += 1
        left.append(_left("", "", "too_many"))
    return {"entries": entries, "left_out": left, "counts": {"tracks": total, "found": len(entries),
                                                               "left_out": len(left)}}


# ── the file ──────────────────────────────────────────────────────────────────

#: Traktor's top rating (five stars), written for a starred track
STARRED_RANKING = "255"


def _entry(track: Dict[str, Any], location: Dict[str, str], *, starred: bool = False) -> ET.Element:
    attrs = {}
    if track.get("title"):
        attrs["TITLE"] = xml_text(track["title"])
    if track.get("artist_name"):
        attrs["ARTIST"] = xml_text(track["artist_name"])
    entry = ET.Element("ENTRY", attrs)
    ET.SubElement(entry, "LOCATION", {k: xml_text(location[k]) for k in ("DIR", "FILE", "VOLUME")})
    if track.get("album_title"):
        ET.SubElement(entry, "ALBUM", {"TITLE": xml_text(track["album_title"])})
    dj = track.get("dj") or {}
    info: Dict[str, str] = {}
    try:
        bitrate = int(track.get("bitrate") or 0)
    except (TypeError, ValueError):
        bitrate = 0
    if bitrate > 0:
        info["BITRATE"] = str(bitrate * 1000 if bitrate < 10000 else bitrate)
    key = confident_key(dj)
    if key:
        info["KEY"] = open_key(key) or ""
    try:
        ms = float(track.get("duration_ms") or 0)
    except (TypeError, ValueError):
        ms = 0
    if ms > 0:
        info["PLAYTIME"] = str(int(round(ms / 1000)))
        info["PLAYTIME_FLOAT"] = f"{ms / 1000:.6f}"
    if starred:
        info["RANKING"] = STARRED_RANKING
    if info:
        ET.SubElement(entry, "INFO", info)
    try:
        bpm = float(dj.get("bpm") or 0)
    except (TypeError, ValueError):
        bpm = 0
    if 20 <= bpm <= 400:
        ET.SubElement(entry, "TEMPO", {"BPM": f"{bpm:.6f}"})
    value = traktor_key_value(key) if key else None
    if value is not None:
        ET.SubElement(entry, "MUSICAL_KEY", {"VALUE": str(value)})
    return entry


def build_nml(name: str, entries: Sequence[Dict[str, Any]], *, starred: Optional[Iterable[Any]] = None) -> bytes:
    """The playlist file: every entry once in COLLECTION, the playlist in
    order (a track twice is listed twice). Built with ElementTree, so every
    name and path is escaped; characters XML can't hold are dropped first.
    A track whose id is in ``starred`` gets Traktor's top rating."""
    stars = {str(i) for i in (starred or ())}
    root = ET.Element("NML", {"VERSION": NML_VERSION})
    ET.SubElement(root, "HEAD", {"COMPANY": "www.native-instruments.com", "PROGRAM": "Traktor"})
    ET.SubElement(root, "MUSICFOLDERS")
    seen: Dict[str, bool] = {}
    unique = []
    for e in entries:
        k = primary_key(e["location"])
        if k not in seen:
            seen[k] = True
            unique.append(e)
    collection = ET.SubElement(root, "COLLECTION", {"ENTRIES": str(len(unique))})
    for e in unique:
        collection.append(_entry(e["track"], e["location"], starred=str(e["track"].get("id")) in stars))
    playlists = ET.SubElement(root, "PLAYLISTS")
    folder = ET.SubElement(playlists, "NODE", {"TYPE": "FOLDER", "NAME": "$ROOT"})
    subnodes = ET.SubElement(folder, "SUBNODES", {"COUNT": "1"})
    node = ET.SubElement(subnodes, "NODE", {"TYPE": "PLAYLIST", "NAME": xml_text(name, 200) or "SYNCHRO.S"})
    playlist = ET.SubElement(node, "PLAYLIST", {"ENTRIES": str(len(entries)), "TYPE": "LIST",
                                                "UUID": uuid.uuid4().hex})
    for e in entries:
        item = ET.SubElement(playlist, "ENTRY")
        ET.SubElement(item, "PRIMARYKEY", {"TYPE": "TRACK", "KEY": xml_text(primary_key(e["location"]), 4000)})
    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode", short_empty_elements=False)
    return ('<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n' + body + "\n").encode("utf-8")


# ── settings and the export folder ────────────────────────────────────────────

def _config():
    from core.settings import config_manager

    return config_manager


def library_root() -> str:
    """The library folder as SYNCHRO.S sees it (``/app/Transfer``)."""
    try:
        from core.imports.paths import shared_transfer_root

        return shared_transfer_root()
    except Exception as exc:  # noqa: BLE001 - no config: nothing maps
        logger.debug("library folder unreadable: %s", exc)
        return ""


def export_roots() -> List[str]:
    """The configured folders an export folder may sit inside: the library,
    the other music folders and Downloads."""
    roots: List[str] = []
    try:
        from core.imports.paths import docker_resolve_path

        cfg = _config()
        raw_list = [cfg.get("soulseek.transfer_path", ""), cfg.get("soulseek.download_path", "")]
        raw_list += list(cfg.get("library.music_paths", []) or [])
        for raw in raw_list:
            if isinstance(raw, dict):
                raw = raw.get("path") or ""
            if raw:
                roots.append(docker_resolve_path(str(raw)))
    except Exception as exc:  # noqa: BLE001 - no config: nowhere is allowed
        logger.debug("configured folders unreadable: %s", exc)
    return roots


def _check_folder(folder: Optional[str], roots: Optional[Sequence[str]] = None
                  ) -> Tuple[Optional[str], str, Optional[Tuple[int, int]], List[str]]:
    """``check_export_folder`` plus the folder's identity (device, inode) as it
    was checked and the real paths of the roots it was checked against."""
    if not folder:
        return None, "unset", None, []
    if not isinstance(folder, str) or "\x00" in folder or len(folder) > 1000 or not os.path.isabs(folder):
        return None, "invalid", None, []
    roots = export_roots() if roots is None else list(roots)
    try:
        real = os.path.realpath(folder)
    except (OSError, ValueError):
        return None, "invalid", None, []
    bases = []
    for root in roots:
        if not root:
            continue
        base = os.path.realpath(root)
        if os.path.isdir(base):  # an unmounted folder holds nothing
            bases.append(base)
    if not any(_within(real, base) for base in bases):
        return None, "outside", None, bases
    try:
        st = os.stat(real)
    except OSError:
        return None, "missing", None, bases
    if not stat.S_ISDIR(st.st_mode):
        return None, "missing", None, bases
    if not os.access(real, os.W_OK | os.X_OK):
        return None, "not_writable", None, bases
    return real, "ok", (st.st_dev, st.st_ino), bases


def _within(path: str, base: str) -> bool:
    return path == base or path.startswith(base.rstrip(os.sep) + os.sep)


def check_export_folder(folder: Optional[str], roots: Optional[Sequence[str]] = None) -> Tuple[Optional[str], str]:
    """``(real_folder, "ok")`` when ``folder`` is a directory SYNCHRO.S can
    write, inside one of the configured folders once every link is followed;
    else ``(None, state)``: ``unset``, ``invalid``, ``outside``, ``missing`` or
    ``not_writable``."""
    real, state, _ident, _bases = _check_folder(folder, roots)
    return real, state


class ExportFolderError(RuntimeError):
    def __init__(self, state: str):
        super().__init__(state)
        self.state = state


TEMP_PREFIX = ".synchros-traktor-"
TEMP_SUFFIX = ".tmp"
#: a temporary export file older than this was left by a save that died; it's removed
STALE_TEMP_SECONDS = 3600.0
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_DIRECTORY = getattr(os, "O_DIRECTORY", 0)


def _umask() -> int:
    """The process's umask without changing it (``os.umask`` sets it, which
    races other threads): Linux says it in /proc; else the usual 022."""
    try:
        with open("/proc/self/status", encoding="ascii", errors="ignore") as handle:
            for line in handle:
                if line.startswith("Umask:"):
                    return int(line.split()[1], 8)
    except (OSError, ValueError, IndexError):
        pass
    return 0o022


def _open_checked_folder(real: str, ident: Tuple[int, int], bases: Sequence[str]) -> int:
    """The export folder opened once, as a directory, without following a link
    at its name, and confirmed to be the very folder that was checked (same
    device and inode, and still inside a configured folder where the system
    can say where an open folder is). Every later step works relative to it."""
    try:
        dfd = os.open(real, os.O_RDONLY | _DIRECTORY | _NOFOLLOW)
    except OSError as exc:
        raise ExportFolderError("missing") from exc
    try:
        st = os.fstat(dfd)
        if not stat.S_ISDIR(st.st_mode) or (st.st_dev, st.st_ino) != ident:
            raise ExportFolderError("outside")
        try:
            where = os.readlink(f"/proc/self/fd/{dfd}")
        except OSError:
            where = None
        if where is not None and not any(_within(where, base) for base in bases):
            raise ExportFolderError("outside")
    except BaseException:
        os.close(dfd)
        raise
    return dfd


def _sweep_stale_temps(dfd: int, *, now: Optional[float] = None) -> int:
    """Remove temporary export files a save that died left behind (older than
    an hour), in the open export folder. Returns how many went."""
    now = time.time() if now is None else now
    removed = 0
    try:
        names = os.listdir(dfd)
    except OSError:
        return 0
    for name in names:
        if not (name.startswith(TEMP_PREFIX) and name.endswith(TEMP_SUFFIX)):
            continue
        try:
            st = os.lstat(name, dir_fd=dfd)
            if stat.S_ISREG(st.st_mode) and now - st.st_mtime > STALE_TEMP_SECONDS:
                os.unlink(name, dir_fd=dfd)
                removed += 1
        except OSError as exc:
            logger.debug("couldn't sweep an old temporary export file: %s", exc)
    return removed


def _safe_name(filename: object) -> bool:
    """Whether ``filename`` is an export's own name: ``<safe stem>.nml``, no
    separator or NUL."""
    stem = filename[:-4] if isinstance(filename, str) and filename.endswith(".nml") else None
    return bool(stem) and "/" not in filename and "\\" not in filename and "\x00" not in filename \
        and filename == safe_filename(stem)


def existing_export(folder: Optional[str], filename: str, *,
                    roots: Optional[Sequence[str]] = None) -> Optional[float]:
    """When something already has ``filename`` in the export folder (a file, a
    link or a folder): its modification time (``lstat``, a link isn't
    followed), for the export's "already there, from 22 October" (234);
    else ``None``. Read only: the folder is checked and opened as the save
    does, and nothing in it is written or followed."""
    real, _state, ident, bases = _check_folder(folder, roots)
    if real is None or ident is None or not _safe_name(filename):
        return None
    try:
        dfd = _open_checked_folder(real, ident, bases)
    except ExportFolderError:
        return None
    try:
        return os.lstat(filename, dir_fd=dfd).st_mtime
    except OSError:
        return None
    finally:
        os.close(dfd)


def save_to_folder(folder: str, filename: str, data: bytes, *, overwrite: bool = False,
                   roots: Optional[Sequence[str]] = None) -> str:
    """Write ``data`` as ``filename`` in the export folder; returns the path.

    The folder is checked again here (inside a configured folder once links
    are followed, a writable directory), then opened once and confirmed to be
    the folder checked; every step after that is relative to the open folder,
    so swapping a folder or a link in by name afterwards changes nothing. The
    file is written to a new temporary name (``O_EXCL | O_NOFOLLOW``), given
    the usual 0644 less the umask, then linked into place, which fails when the
    name exists (``FileExistsError``), unless ``overwrite``, when it's renamed
    over it. Temporary files older than an hour are swept first. Nothing is
    ever written outside the folder."""
    real, state, ident, bases = _check_folder(folder, roots)
    if real is None or ident is None:
        raise ExportFolderError(state)
    if not _safe_name(filename):
        raise ValueError("unsafe file name")
    dfd = _open_checked_folder(real, ident, bases)
    tmp: Optional[str] = None
    try:
        _sweep_stale_temps(dfd)
        try:
            st = os.lstat(filename, dir_fd=dfd)
        except FileNotFoundError:
            st = None
        if st is not None and (stat.S_ISDIR(st.st_mode) or not overwrite):
            raise FileExistsError(os.path.join(real, filename))
        tmp, fd = _new_temp(dfd)
        try:
            os.fchmod(fd, 0o644 & ~_umask())
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        if overwrite:
            os.replace(tmp, filename, src_dir_fd=dfd, dst_dir_fd=dfd)
            tmp = None
        else:
            _place_new(dfd, tmp, filename)
        try:
            os.fsync(dfd)
        except OSError:
            pass
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp, dir_fd=dfd)
            except FileNotFoundError:
                pass
            except OSError as exc:
                logger.warning("couldn't remove the temporary export file: %s", exc)
        os.close(dfd)
    return os.path.join(real, filename)


def _new_temp(dfd: int) -> Tuple[str, int]:
    """A new temporary file in the open folder: ``(name, fd)``."""
    for _ in range(20):
        name = f"{TEMP_PREFIX}{secrets.token_hex(8)}{TEMP_SUFFIX}"
        try:
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600, dir_fd=dfd)
        except FileExistsError:
            continue
        return name, fd
    raise FileExistsError("no free temporary name")


#: errors that mean "this file system has no hard links"
_NO_LINKS = (errno.EPERM, errno.ENOTSUP, errno.EOPNOTSUPP, errno.EXDEV, errno.EMLINK, errno.ENOSYS,
             errno.EACCES)


def _place_new(dfd: int, tmp: str, final: str) -> None:
    """Put ``tmp`` at ``final`` only if nothing is there. A hard link is atomic
    and refused when the name exists (a dangling link included); ``tmp`` then
    goes. On a file system without links: claim the name with an exclusive
    create (``O_EXCL | O_NOFOLLOW`` refuses an existing name or link), then
    rename the written file over that empty claim. That isn't atomic: for the
    moment between the two, the name holds an empty file; if anything fails the
    claim is removed."""
    try:
        os.link(tmp, final, src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)
    except FileExistsError:
        raise
    except OSError as exc:
        if exc.errno not in _NO_LINKS:
            raise
    else:
        os.unlink(tmp, dir_fd=dfd)
        return
    claim = os.open(final, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW, 0o600, dir_fd=dfd)
    os.close(claim)
    try:
        os.replace(tmp, final, src_dir_fd=dfd, dst_dir_fd=dfd)
    except BaseException:
        try:
            os.unlink(final, dir_fd=dfd)
        except OSError:
            pass
        raise


def settings_state(*, roots: Optional[Sequence[str]] = None) -> Dict[str, Any]:
    """What the Traktor card shows (21b)."""
    try:
        cfg = _config()
        mac = cfg.get(SETTING_MAC_PATH, "") or ""
        folder = cfg.get(SETTING_EXPORT_FOLDER, "") or ""
    except Exception:  # noqa: BLE001 - no config: nothing set
        mac, folder = "", ""
    lib = library_root()
    helper = _load_to_host()
    from_helper = None
    if helper is not None and lib:
        try:
            from_helper = valid_mac_path(helper(lib) or "")
        except Exception:  # noqa: BLE001 - the helper's map is a hint
            from_helper = None
    real, state = check_export_folder(folder or None, roots)
    paths = MacPaths(lib, valid_mac_path(mac), to_host=helper)
    folder_on_mac = paths.mac_path_for(real)[0] if real else None
    return {
        "mac_path": valid_mac_path(mac) or "",
        "mac_path_from_helper": from_helper,
        "library_folder": lib,
        "export_folder": folder,
        "export_folder_state": state,
        "export_folder_on_mac": folder_on_mac,
        "collection": COLLECTION_HINT,
    }


__all__ = ["BOOT_VOLUME", "COLLECTION_HINT", "ExportFolderError", "MAX_TRACKS", "MacPaths", "REASON_WORDS",
           "SETTING_EXPORT_FOLDER", "SETTING_MAC_PATH", "ascii_filename", "build_nml", "check_export_folder",
           "confident_key", "existing_export", "export_roots", "library_root", "mixes_tracks", "nml_location", "open_key", "plan",
           "playlist_tracks", "primary_key", "safe_filename", "save_to_folder", "settings_state",
           "traktor_key_value", "tracks_by_ids", "valid_mac_path", "xml_text"]
