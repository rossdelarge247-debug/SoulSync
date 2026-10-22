"""The Radio Browser directory (api.radio-browser.info): free, no key.

About 50,000 community-listed stations, searched by name or genre with
codec, minimum bitrate and country. Answers are cached for a few minutes, and
every request says who's asking (the directory asks clients to set a
descriptive User-Agent). A station from here is known by its uuid; playing it
looks the uuid up again rather than trusting an address from the browser.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from core.internet_radio import net
from core.internet_radio.stations import Station, make_stream
from utils.logging_config import get_logger

logger = get_logger("internet_radio.directory")

# the directory's mirrors, tried in order
SERVERS = ("https://de1.api.radio-browser.info", "https://nl1.api.radio-browser.info",
           "https://at1.api.radio-browser.info")
SEARCH_TTL = 300
LOOKUP_TTL = 3600
COUNTRIES_TTL = 86400
PAGE_SIZE = 20
CODECS = ("FLAC", "AAC", "MP3", "OGG")
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_CC_RE = re.compile(r"^[A-Z]{2}$")

_KIND_TAGS = (
    ("jazz_soul_funk", ("jazz", "soul", "funk", "blues", "r&b", "rnb", "gospel", "swing")),
    ("electronic", ("electronic", "house", "techno", "ambient", "downtempo", "chillout", "chill", "trance",
                    "drum and bass", "dnb", "idm", "electro", "lounge", "dance", "edm", "dub")),
    ("world", ("world", "african", "afro", "latin", "reggae", "caribbean", "asian", "bollywood", "celtic",
               "folk", "brazil", "cumbia", "salsa")),
)


class DirectoryError(Exception):
    """The directory couldn't be reached; ``str()`` is safe to show."""


def _get(path: str, params: Dict[str, Any], ttl: int, key: str) -> Any:
    last: Optional[Exception] = None
    for server in SERVERS:
        try:
            return net.cached_json(f"rb:{key}", ttl, server + path, params=params, timeout=(4, 8))
        except net.FetchError as exc:
            last = exc
            continue
    raise DirectoryError("The Radio Browser directory didn't answer. Try again in a minute.") from last


def is_directory_id(station_id: str) -> bool:
    return str(station_id or "").startswith("rb-") and bool(_UUID_RE.match(str(station_id)[3:]))


def _kind_for(tags: List[str]) -> str:
    joined = " ".join(tags).lower()
    for kind, words in _KIND_TAGS:
        if any(w in joined for w in words):
            return kind
    return "eclectic"


def _codec(raw: str) -> str:
    value = (raw or "").strip().upper()
    if value in ("AAC+", "AACP", "HE-AAC"):
        return "AAC"
    if value in ("OGG", "VORBIS", "OPUS"):
        return "OGG" if value != "OPUS" else "OPUS"
    return value


def station_from_entry(entry: Dict[str, Any]) -> Optional[Station]:
    uuid = str(entry.get("stationuuid") or "").lower()
    if not _UUID_RE.match(uuid):
        return None
    if int(entry.get("hls") or 0):
        return None  # HLS playlists aren't a stream the relay can pass on
    url = str(entry.get("url_resolved") or entry.get("url") or "").strip()
    stream = make_stream({"id": "main", "url": url, "codec": _codec(str(entry.get("codec") or "")),
                          "bitrate_kbps": entry.get("bitrate") or 0})
    if stream is None:
        return None
    tags = [t.strip() for t in str(entry.get("tags") or "").split(",") if t.strip()][:8]
    return Station(
        id=f"rb-{uuid}", name=str(entry.get("name") or "Untitled station").strip()[:120] or "Untitled station",
        kind=_kind_for(tags), source="directory", streams=[stream], genre=", ".join(tags[:3]),
        country=str(entry.get("country") or "").strip(), homepage=str(entry.get("homepage") or "").strip(),
        logo_url="", tags=tags,
        note=f"Radio Browser, {int(entry.get('clickcount') or 0)} listens in the directory")


def search(q: str = "", *, codec: str = "", min_bitrate: int = 0, country: str = "",
           page: int = 1) -> Tuple[List[Station], bool]:
    """(stations, more): one page, sorted by listeners in the directory."""
    q = (q or "").strip()[:80]
    codec = (codec or "").strip().upper()
    if codec not in CODECS:
        codec = ""
    country = (country or "").strip().upper()
    if not _CC_RE.match(country):
        country = ""
    min_bitrate = max(0, min(int(min_bitrate or 0), 2000))
    page = max(1, min(int(page or 1), 50))
    base: Dict[str, Any] = {"hidebroken": "true", "order": "clickcount", "reverse": "true",
                            "limit": PAGE_SIZE + 1, "offset": (page - 1) * PAGE_SIZE}
    if codec:
        base["codec"] = codec.lower()
    if min_bitrate:
        base["bitrateMin"] = min_bitrate
    if country:
        base["countrycode"] = country
    found: Dict[str, Station] = {}
    order: List[str] = []
    queries = [dict(base, name=q), dict(base, tag=q.lower())] if q else [base]
    for params in queries:
        key = "search:" + "&".join(f"{k}={params[k]}" for k in sorted(params))
        for entry in _get("/json/stations/search", params, SEARCH_TTL, key) or []:
            if not isinstance(entry, dict):
                continue
            st = station_from_entry(entry)
            if st is None or st.id in found:
                continue
            if codec and st.streams[0].codec != codec:
                continue
            if min_bitrate and st.streams[0].bitrate_kbps and st.streams[0].bitrate_kbps < min_bitrate:
                continue
            found[st.id] = st
            order.append(st.id)
    stations = [found[i] for i in order]
    return stations[:PAGE_SIZE], len(stations) > PAGE_SIZE


def lookup(station_id: str) -> Optional[Station]:
    """One directory station by its id, looked up again (cached for an hour)."""
    if not is_directory_id(station_id):
        return None
    uuid = station_id[3:]
    rows = _get("/json/stations/byuuid", {"uuids": uuid}, LOOKUP_TTL, f"uuid:{uuid}") or []
    for entry in rows:
        if isinstance(entry, dict) and str(entry.get("stationuuid") or "").lower() == uuid:
            return station_from_entry(entry)
    return None


def countries() -> List[Dict[str, Any]]:
    rows = _get("/json/countries", {"order": "stationcount", "reverse": "true", "hidebroken": "true"},
                COUNTRIES_TTL, "countries") or []
    out = []
    for r in rows:
        code = str((r or {}).get("iso_3166_1") or "").upper()
        if _CC_RE.match(code) and int(r.get("stationcount") or 0) >= 20:
            out.append({"code": code, "name": str(r.get("name") or code), "stations": int(r["stationcount"])})
    return out[:120]


__all__ = ["DirectoryError", "search", "lookup", "countries", "is_directory_id", "station_from_entry",
           "CODECS", "PAGE_SIZE"]
