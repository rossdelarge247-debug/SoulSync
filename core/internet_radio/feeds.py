"""Stations' own now-playing feeds and tracklists: the most accurate names.

Each feed type is one small reader that turns the station's JSON into a
:class:`FeedResult`. A feed that answers with something unexpected gives
``None`` (not a guess), and identification moves on to stream titles and
fingerprints. Feeds are polled modestly (``FEED_POLL_SECONDS``) and cached, so
any number of listeners costs the station one request.

Tracklists (shows after broadcast) come from KEXP's show API and NTS's
episode tracklists.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional

from core.internet_radio import net
from utils.logging_config import get_logger

logger = get_logger("internet_radio.feeds")

FEED_POLL_SECONDS = 20
FEED_TTL = 15
SHOWS_TTL = 600
TYPES = ("somafm", "radioparadise", "kexp", "nts", "radiofrance")


@dataclass
class FeedResult:
    """What the feed says is on now. ``is_track`` False means a show, a
    break or talk; ``reason`` then says so in words."""

    is_track: bool
    artist: str = ""
    title: str = ""
    release: str = ""
    art_url: str = ""
    started_at: Optional[float] = None
    reason: Optional[str] = None
    show: Optional[Dict[str, Any]] = None
    extra: Dict[str, Any] = field(default_factory=dict)


def _s(value: Any) -> str:
    return str(value or "").strip()


def _ts(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        pass
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _https(url: str) -> str:
    url = _s(url)
    return url if url.startswith("https://") else ""


# ── readers (pure: JSON in, FeedResult out) ──────────────────────────────────

def read_somafm(data: Any) -> Optional[FeedResult]:
    songs = (data or {}).get("songs") if isinstance(data, dict) else None
    if not isinstance(songs, list) or not songs or not isinstance(songs[0], dict):
        return None
    song = songs[0]
    artist, title = _s(song.get("artist")), _s(song.get("title"))
    if not artist or not title:
        return FeedResult(False, reason="SomaFM isn't saying what's playing right now.")
    return FeedResult(True, artist=artist, title=title, release=_s(song.get("album")),
                      started_at=_ts(song.get("date")))


def read_radioparadise(data: Any) -> Optional[FeedResult]:
    if not isinstance(data, dict):
        return None
    artist, title = _s(data.get("artist")), _s(data.get("title"))
    if not artist or not title:
        return None
    if artist.lower() == "commercial-free" or "radio paradise" in artist.lower():
        return FeedResult(False, reason="A Radio Paradise break, not a track.")
    return FeedResult(True, artist=artist, title=title, release=_s(data.get("album")),
                      art_url=_https(data.get("cover")))


def read_kexp(data: Any) -> Optional[FeedResult]:
    results = (data or {}).get("results") if isinstance(data, dict) else None
    if not isinstance(results, list) or not results or not isinstance(results[0], dict):
        return None
    play = results[0]
    show = {"id": f"kexp:{play.get('show')}", "kexp_show": play.get("show")} if play.get("show") else None
    if play.get("play_type") != "trackplay":
        return FeedResult(False, reason="The DJ is talking between tracks.", show=show,
                          started_at=_ts(play.get("airdate")))
    artist, title = _s(play.get("artist")), _s(play.get("song"))
    if not artist or not title:
        return FeedResult(False, reason="KEXP hasn't named this track.", show=show)
    return FeedResult(True, artist=artist, title=title, release=_s(play.get("album")),
                      art_url=_https(play.get("thumbnail_uri") or play.get("image_uri")),
                      started_at=_ts(play.get("airdate")), show=show)


def read_nts(data: Any, channel: str) -> Optional[FeedResult]:
    results = (data or {}).get("results") if isinstance(data, dict) else None
    if not isinstance(results, list):
        return None
    for entry in results:
        if not isinstance(entry, dict) or _s(entry.get("channel_name")) != str(channel):
            continue
        now = entry.get("now") or {}
        title = _s(now.get("broadcast_title"))
        details = ((now.get("embeds") or {}).get("details") or {}) if isinstance(now, dict) else {}
        show_alias, episode_alias = _s(details.get("show_alias")), _s(details.get("episode_alias"))
        show = None
        if show_alias and episode_alias:
            show = {"id": f"nts:{show_alias}/{episode_alias}", "show_alias": show_alias,
                    "episode_alias": episode_alias, "title": title,
                    "aired_at": _ts(now.get("start_timestamp")), "ended_at": _ts(now.get("end_timestamp"))}
        reason = (f"This is a show ({title}). NTS publishes its tracklist after the show."
                  if title else "NTS doesn't say what's playing during shows.")
        return FeedResult(False, reason=reason, show=show, started_at=_ts(now.get("start_timestamp")))
    return None


def read_radiofrance(data: Any) -> Optional[FeedResult]:
    """radiofrance.fr's live API isn't documented; read only what's clearly a song."""
    if not isinstance(data, dict):
        return None
    now = data.get("now") if isinstance(data.get("now"), dict) else None
    if not now:
        return None
    song = now.get("song")
    first = _s((now.get("firstLine") or {}).get("title"))
    second = _s((now.get("secondLine") or {}).get("title"))
    if not song or not first or not second:
        return FeedResult(False, reason="FIP is between songs or presenting a programme.")
    release = _s(((song or {}).get("release") or {}).get("title")) if isinstance(song, dict) else ""
    cover = _https(((now.get("visuals") or {}).get("card") or {}).get("src")) if isinstance(now.get("visuals"), dict) else ""
    return FeedResult(True, artist=second, title=first, release=release, art_url=cover)


# ── fetching ─────────────────────────────────────────────────────────────────

def fetch_now_playing(feed: Optional[Dict[str, Any]]) -> Optional[FeedResult]:
    """Ask a station's feed what's on. Raises net.FetchError when it can't."""
    if not feed:
        return None
    kind = feed.get("type")
    if kind == "somafm":
        ch = _s(feed.get("channel"))
        data = net.cached_json(f"feed:somafm:{ch}", FEED_TTL, f"https://somafm.com/songs/{ch}.json")
        return read_somafm(data)
    if kind == "radioparadise":
        ch = int(feed.get("channel") or 0)
        data = net.cached_json(f"feed:rp:{ch}", FEED_TTL, "https://api.radioparadise.com/api/now_playing",
                               params={"chan": ch})
        return read_radioparadise(data)
    if kind == "kexp":
        data = net.cached_json("feed:kexp", FEED_TTL, "https://api.kexp.org/v2/plays/",
                               params={"format": "json", "limit": 1, "ordering": "-airdate"})
        return read_kexp(data)
    if kind == "nts":
        data = net.cached_json("feed:nts", FEED_TTL, "https://www.nts.live/api/v2/live")
        return read_nts(data, _s(feed.get("channel")) or "1")
    if kind == "radiofrance":
        st = _s(feed.get("station")) or "fip"
        data = net.cached_json(f"feed:rf:{st}", FEED_TTL, "https://www.radiofrance.fr/fip/api/live",
                               params={"webradio": st})
        return read_radiofrance(data)
    return None


# ── tracklists ───────────────────────────────────────────────────────────────

def read_kexp_shows(data: Any) -> List[Dict[str, Any]]:
    out = []
    for show in (data or {}).get("results") or [] if isinstance(data, dict) else []:
        if not isinstance(show, dict) or not show.get("id"):
            continue
        hosts = ", ".join(_s(h) for h in show.get("host_names") or [] if _s(h))
        name = _s(show.get("program_name")) or "KEXP"
        out.append({"id": f"kexp:{show['id']}", "title": f"{name} with {hosts}" if hosts else name,
                    "aired_at": _ts(show.get("start_time")), "ref": {"kexp_show": show["id"]}})
    return out


def read_kexp_tracks(data: Any) -> List[Dict[str, Any]]:
    tracks = []
    for play in (data or {}).get("results") or [] if isinstance(data, dict) else []:
        if not isinstance(play, dict) or play.get("play_type") != "trackplay":
            continue
        tracks.append({"time": _ts(play.get("airdate")), "artist": _s(play.get("artist")),
                       "title": _s(play.get("song")), "release": _s(play.get("album")),
                       "art_url": _https(play.get("thumbnail_uri"))})
    tracks.sort(key=lambda t: t["time"] or 0)
    return tracks


def read_nts_tracks(data: Any, aired_at: Optional[float]) -> List[Dict[str, Any]]:
    tracks = []
    for row in (data or {}).get("results") or [] if isinstance(data, dict) else []:
        if not isinstance(row, dict):
            continue
        offset = row.get("offset") if row.get("offset") is not None else row.get("offset_estimate")
        when = (aired_at + float(offset)) if aired_at and isinstance(offset, (int, float)) else None
        tracks.append({"time": when, "artist": _s(row.get("artist")), "title": _s(row.get("title")),
                       "release": "", "art_url": ""})
    return tracks


def fetch_kexp_shows(limit: int = 6) -> List[Dict[str, Any]]:
    data = net.cached_json("shows:kexp", SHOWS_TTL, "https://api.kexp.org/v2/shows/",
                           params={"format": "json", "limit": limit, "ordering": "-start_time"})
    return read_kexp_shows(data)


def fetch_tracks(show: Dict[str, Any]) -> List[Dict[str, Any]]:
    ref = show.get("ref") or {}
    if ref.get("kexp_show"):
        sid = int(ref["kexp_show"])
        data = net.cached_json(f"tracks:kexp:{sid}", SHOWS_TTL, "https://api.kexp.org/v2/plays/",
                               params={"format": "json", "show_ids": sid, "limit": 200, "ordering": "airdate"})
        return read_kexp_tracks(data)
    if ref.get("show_alias") and ref.get("episode_alias"):
        show_alias, episode = _s(ref["show_alias"]), _s(ref["episode_alias"])
        if not all(c.isalnum() or c in "-_" for c in show_alias + episode):
            return []
        data = net.cached_json(f"tracks:nts:{show_alias}/{episode}", SHOWS_TTL,
                               f"https://www.nts.live/api/v2/shows/{show_alias}/episodes/{episode}/tracklist")
        return read_nts_tracks(data, show.get("aired_at"))
    return []


def now() -> float:
    return time.time()


__all__ = ["FeedResult", "fetch_now_playing", "fetch_kexp_shows", "fetch_tracks", "read_somafm",
           "read_radioparadise", "read_kexp", "read_nts", "read_radiofrance", "read_kexp_shows",
           "read_kexp_tracks", "read_nts_tracks", "FEED_POLL_SECONDS", "TYPES"]
