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

Never written: cue points, beat grids (``CUE_V2``), ratings, ``LOCK``.

Mac paths
=========

Traktor needs the path the Mac sees, not the container's. ``mac_path_for``
asks the drive helper's host map first (``core.drives.host_paths.to_host``
once it lands; swapping to it is the one import in ``_load_to_host``), then
the Traktor card's "Your music on the Mac" setting, which names where the
library folder (``soulseek.transfer_path``, ``/app/Transfer``) is on the
Mac. A track neither can place is left out, with the reason.
"""

from __future__ import annotations

import errno
import os
import posixpath
import re
import tempfile
import unicodedata
import uuid
import xml.etree.ElementTree as ET  # nosec B405 - builds XML, never parses untrusted input
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


def safe_filename(name: Any, suffix: str = ".nml") -> str:
    """A file name from a playlist's name: no folders, no control or reserved
    characters, no leading dots, at most 80 characters before the suffix."""
    text = unicodedata.normalize("NFC", xml_text(name, 400))
    text = _UNSAFE_NAME.sub(" ", text)
    text = re.sub(r"\s+", " ", text).strip().lstrip(". ")
    text = text[:80].rstrip(" .")
    return f"{text or 'Traktor export'}{suffix}"


def ascii_filename(name: str) -> str:
    """The plain-ASCII fallback of a file name for Content-Disposition."""
    stem = name[:-4] if name.lower().endswith(".nml") else name
    text = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode("ascii")
    text = re.sub(r'[^A-Za-z0-9 ._()\-]+', "", text).strip().lstrip(". ")
    return f"{text}.nml" if text else "Traktor export.nml"


# ── Mac paths ─────────────────────────────────────────────────────────────────

def _load_to_host() -> Optional[Callable[[str], Optional[str]]]:
    """The drive helper's map from a container path to the Mac's
    (``feat/host-paths``). Until it lands this is None and the setting is used."""
    try:
        from core.drives.host_paths import to_host  # type: ignore[import-not-found]
    except Exception:  # noqa: BLE001 - not there yet: the card's setting stands alone
        return None
    return to_host


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
                 resolve: Optional[Callable[[str], Optional[str]]] = None):
        self.library_root = _norm(library_root)
        self.mac_root = valid_mac_path(mac_root) if mac_root else None
        self.to_host = to_host
        self.resolve = resolve

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
        if self.resolve is not None:
            try:
                on_disk = self.resolve(str(stored))
            except Exception as exc:  # noqa: BLE001 - unreadable: say so below
                logger.debug("resolve failed for a stored path: %s", exc)
                on_disk = None
            if on_disk and _norm(on_disk) != path:
                found = self._place(_norm(on_disk))
                if found:
                    return found, None
        if not self.mac_root and self.to_host is None:
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

def _entry(track: Dict[str, Any], location: Dict[str, str]) -> ET.Element:
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


def build_nml(name: str, entries: Sequence[Dict[str, Any]]) -> bytes:
    """The playlist file: every entry once in COLLECTION, the playlist in
    order (a track twice is listed twice). Built with ElementTree, so every
    name and path is escaped; characters XML can't hold are dropped first."""
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
        collection.append(_entry(e["track"], e["location"]))
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


def check_export_folder(folder: Optional[str], roots: Optional[Sequence[str]] = None) -> Tuple[Optional[str], str]:
    """``(real_folder, "ok")`` when ``folder`` is a directory SYNCHRO.S can
    write, inside one of the configured folders once every link is followed;
    else ``(None, state)``: ``unset``, ``invalid``, ``outside``, ``missing`` or
    ``not_writable``."""
    if not folder:
        return None, "unset"
    if not isinstance(folder, str) or "\x00" in folder or len(folder) > 1000 or not os.path.isabs(folder):
        return None, "invalid"
    roots = export_roots() if roots is None else list(roots)
    try:
        real = os.path.realpath(folder)
    except (OSError, ValueError):
        return None, "invalid"
    inside = False
    for root in roots:
        if not root:
            continue
        base = os.path.realpath(root)
        if not os.path.isdir(base):
            continue  # an unmounted folder holds nothing
        if real == base or real.startswith(base.rstrip(os.sep) + os.sep):
            inside = True
            break
    if not inside:
        return None, "outside"
    if not os.path.isdir(real):
        return None, "missing"
    if not os.access(real, os.W_OK | os.X_OK):
        return None, "not_writable"
    return real, "ok"


class ExportFolderError(RuntimeError):
    def __init__(self, state: str):
        super().__init__(state)
        self.state = state


def save_to_folder(folder: str, filename: str, data: bytes, *, overwrite: bool = False,
                   roots: Optional[Sequence[str]] = None) -> str:
    """Write ``data`` as ``filename`` in the export folder; returns the path.

    The folder is checked again here (inside a configured folder once links
    are followed, a writable directory). The file is written to a temporary
    name made by ``mkstemp`` in that folder, then linked into place, which
    fails when the name exists (``FileExistsError``) unless ``overwrite``,
    when it's renamed over it. Nothing is ever written outside the folder."""
    real, state = check_export_folder(folder, roots)
    if real is None:
        raise ExportFolderError(state)
    stem = filename[:-4] if isinstance(filename, str) and filename.endswith(".nml") else None
    if not stem or "/" in filename or "\\" in filename or "\x00" in filename or filename != safe_filename(stem):
        raise ValueError("unsafe file name")
    final = os.path.join(real, filename)
    if os.path.realpath(os.path.dirname(final)) != real:
        raise ExportFolderError("outside")
    if os.path.isdir(final) and not os.path.islink(final):
        raise FileExistsError(final)
    if os.path.lexists(final) and not overwrite:
        raise FileExistsError(final)
    fd, tmp = tempfile.mkstemp(prefix=".synchros-traktor-", suffix=".tmp", dir=real)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if overwrite:
            os.replace(tmp, final)
        else:
            _link_new(tmp, final, data)
    finally:
        if os.path.lexists(tmp):
            try:
                os.unlink(tmp)
            except OSError as exc:
                logger.warning("couldn't remove the temporary export file: %s", exc)
    return final


def _link_new(tmp: str, final: str, data: bytes) -> None:
    """Put ``tmp`` at ``final`` only if nothing is there: a hard link (atomic,
    refused when the name exists, a dangling link included); on a file system
    without links, an exclusive create (``O_EXCL`` refuses an existing name or
    link too)."""
    try:
        os.link(tmp, final)
        return
    except FileExistsError:
        raise
    except OSError as exc:
        if exc.errno not in (errno.EPERM, errno.ENOTSUP, errno.EOPNOTSUPP, errno.EXDEV, errno.EMLINK,
                             errno.ENOSYS, errno.EACCES):
            raise
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(final, flags, 0o644)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        try:
            os.unlink(final)
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
           "confident_key", "export_roots", "library_root", "mixes_tracks", "nml_location", "open_key", "plan",
           "playlist_tracks", "primary_key", "safe_filename", "save_to_folder", "settings_state",
           "traktor_key_value", "tracks_by_ids", "valid_mac_path", "xml_text"]
