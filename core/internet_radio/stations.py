"""Stations: the built-in list, directory stations and admins' links, in one shape.

A station the server may fetch comes from exactly one of three places, and its
id says which:

- a built-in pick from ``stations.json`` beside this file (id as written there);
- the Radio Browser directory (``rb-<stationuuid>``), looked up by its uuid,
  never by an address a request carries;
- a link an admin added and checked (``link-<n>``), in ``radio_links``.

:func:`public_station` is the shape the page gets (no stream addresses: the
browser is given an address only by ``POST /api/radio/play``).
"""

from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from utils.logging_config import get_logger

logger = get_logger("internet_radio.stations")

DATA_FILE = os.path.join(os.path.dirname(__file__), "stations.json")
KINDS = ("electronic", "world", "eclectic", "jazz_soul_funk")
KIND_LABELS = {"electronic": "Electronic", "world": "World", "eclectic": "Eclectic tastemakers",
               "jazz_soul_funk": "Jazz, soul and funk"}
SOURCES = ("built_in", "directory", "your_link")
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
LOSSLESS_CODECS = ("FLAC", "ALAC", "WAV")


@dataclass
class Stream:
    id: str
    url: str
    codec: str = ""
    bitrate_kbps: int = 0
    lossless: bool = False
    direct: bool = False

    def label(self) -> str:
        if self.lossless:
            return f"{self.codec or 'FLAC'} lossless"
        if self.codec and self.bitrate_kbps:
            return f"{self.codec} {self.bitrate_kbps} kbps"
        return self.codec or (f"{self.bitrate_kbps} kbps" if self.bitrate_kbps else "Stream")


@dataclass
class Station:
    id: str
    name: str
    kind: str
    source: str
    streams: List[Stream]
    genre: str = ""
    city: str = ""
    country: str = ""
    homepage: str = ""
    description: str = ""
    logo_url: str = ""
    now_playing: Optional[Dict[str, Any]] = None
    tracklists: Optional[Dict[str, Any]] = None
    tags: List[str] = field(default_factory=list)
    sends_titles: Optional[bool] = None
    added_by: str = ""
    note: str = ""

    @property
    def has_now_playing(self) -> bool:
        return bool(self.now_playing and self.now_playing.get("type"))

    @property
    def has_tracklists(self) -> bool:
        return bool(self.tracklists and self.tracklists.get("type"))


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def make_stream(raw: Dict[str, Any], index: int = 0) -> Optional[Stream]:
    url = str(raw.get("url") or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        return None
    codec = str(raw.get("codec") or "").strip().upper()
    if codec in ("OGG", "VORBIS"):
        codec = "OGG"
    lossless = bool(raw.get("lossless")) or codec in LOSSLESS_CODECS
    return Stream(id=str(raw.get("id") or f"s{index}"), url=url, codec=codec,
                  bitrate_kbps=max(0, _as_int(raw.get("bitrate_kbps"))), lossless=lossless,
                  direct=bool(raw.get("direct")) and url.lower().startswith("https://"))


def _load_file(path: str) -> Dict[str, Any]:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def parse_builtin(data: Dict[str, Any]) -> List[Station]:
    """The built-in list, checked: a bad entry is skipped with a log line, never fatal."""
    out: List[Station] = []
    seen = set()
    for raw in data.get("stations") or []:
        try:
            sid = str(raw.get("id") or "")
            kind = str(raw.get("kind") or "")
            if not _ID_RE.match(sid) or sid.startswith(("rb-", "link-")) or sid in seen:
                raise ValueError(f"bad or repeated id {sid!r}")
            if kind not in KINDS:
                raise ValueError(f"unknown kind {kind!r}")
            streams = [s for s in (make_stream(x, i) for i, x in enumerate(raw.get("streams") or [])) if s]
            if not streams:
                raise ValueError("no usable stream")
            seen.add(sid)
            out.append(Station(
                id=sid, name=str(raw.get("name") or sid), kind=kind, source="built_in", streams=streams,
                genre=str(raw.get("genre") or ""), city=str(raw.get("city") or ""),
                country=str(raw.get("country") or ""), homepage=str(raw.get("homepage") or ""),
                description=str(raw.get("description") or ""), logo_url=str(raw.get("logo_url") or ""),
                now_playing=raw.get("now_playing") or None, tracklists=raw.get("tracklists") or None,
                note=str(raw.get("source") or "")))
        except Exception as exc:  # noqa: BLE001 - one bad entry doesn't hide the rest
            logger.warning("Skipping built-in station %r: %s", raw.get("id") if isinstance(raw, dict) else raw, exc)
    return out


_lock = threading.Lock()
_builtin: Optional[List[Station]] = None


def builtin_stations(path: Optional[str] = None) -> List[Station]:
    global _builtin
    if path:
        return parse_builtin(_load_file(path))
    with _lock:
        if _builtin is None:
            try:
                _builtin = parse_builtin(_load_file(DATA_FILE))
            except Exception as exc:  # noqa: BLE001 - no list is an empty page, not a crash
                logger.error("Couldn't read the built-in station list: %s", exc)
                _builtin = []
        return list(_builtin)


def builtin_station(station_id: str) -> Optional[Station]:
    return next((s for s in builtin_stations() if s.id == station_id), None)


def reset_cache() -> None:
    global _builtin
    with _lock:
        _builtin = None


def ordered_streams(station: Station, prefer_lossless: bool = True) -> List[Stream]:
    """Best first. Preferring lossless puts FLAC first, then the highest
    bitrate; otherwise the lossless streams go last (they're heavy)."""
    streams = list(station.streams)
    if prefer_lossless:
        return sorted(streams, key=lambda s: (not s.lossless, -s.bitrate_kbps))
    return sorted(streams, key=lambda s: (s.lossless, -s.bitrate_kbps))


def pick_stream(station: Station, stream_id: Optional[str], prefer_lossless: bool = True) -> Optional[Stream]:
    streams = ordered_streams(station, prefer_lossless)
    if stream_id:
        return next((s for s in streams if s.id == stream_id), None)
    return streams[0] if streams else None


def quality_label(station: Station) -> str:
    """The card's declared quality: the best stream's codec and bitrate."""
    best = ordered_streams(station, True)
    return best[0].label() if best else ""


def public_station(station: Station, *, favourite: bool = False, auto_add: bool = False,
                   prefer_lossless: bool = True) -> Dict[str, Any]:
    streams = ordered_streams(station, prefer_lossless)
    out_streams = []
    for i, s in enumerate(streams):
        label = s.label() + (" (best offered)" if i == 0 and len(streams) > 1 else "")
        out_streams.append({"id": s.id, "codec": s.codec, "bitrate_kbps": s.bitrate_kbps,
                            "lossless": s.lossless, "label": label})
    best = ordered_streams(station, True)[0] if station.streams else None
    return {
        "id": station.id, "name": station.name, "kind": station.kind,
        "kind_label": KIND_LABELS.get(station.kind, ""), "genre": station.genre,
        "city": station.city, "country": station.country, "logo_url": station.logo_url,
        "homepage": station.homepage, "description": station.description, "source": station.source,
        "favourite": bool(favourite), "auto_add": bool(auto_add),
        "has_now_playing": station.has_now_playing, "has_tracklists": station.has_tracklists,
        "quality": {"codec": best.codec if best else "", "bitrate_kbps": best.bitrate_kbps if best else 0,
                    "lossless": bool(best and best.lossless), "label": best.label() if best else ""},
        "tags": list(station.tags[:6]), "sends_titles": station.sends_titles,
        "added_by": station.added_by or None,
        "streams": out_streams,
    }


def kinds_meta() -> List[Dict[str, str]]:
    try:
        data = _load_file(DATA_FILE)
        listed = {k.get("kind"): k for k in data.get("kinds") or [] if isinstance(k, dict)}
    except Exception:  # noqa: BLE001
        listed = {}
    return [{"kind": k, "label": KIND_LABELS[k], "blurb": str((listed.get(k) or {}).get("blurb") or "")}
            for k in KINDS]


__all__ = ["Station", "Stream", "KINDS", "KIND_LABELS", "SOURCES", "builtin_stations", "builtin_station",
           "parse_builtin", "make_stream", "ordered_streams", "pick_stream", "quality_label",
           "public_station", "kinds_meta", "reset_cache"]
