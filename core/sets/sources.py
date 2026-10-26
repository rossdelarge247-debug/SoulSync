"""Where famous mixes' tracklists come from (board 22f; states 22r, 22s):
MixesDB through its MediaWiki API, MusicBrainz's DJ-mix releases through the
app's MusicBrainz client (its rate limit and User-Agent), and Discogs with
the token from Settings → Connections.

Outbound rules (docs/GAUNTLET.md, "Outbound HTTP"):

* **Fixed hosts only.** Every request goes to a URL built here from a
  constant base; nothing a person typed is ever fetched. A pasted MixesDB
  link is read for its page title (``tracklist.page_title_from_link``) and
  the title goes to the API as a parameter. Redirects aren't followed.
* **Bounded.** A 5 s connect and 10 s read timeout, 20 s for the whole
  answer, at most 2 MB read from any answer (streamed, so a bigger one is
  cut off, not downloaded), and one request at a time per source (a lock
  held for the whole request) with 1 s between them; a request that waits
  over 25 s for its turn is a source down.
* **Discogs' token is the admin's** (Settings → Connections, shared by every
  profile), so each profile may start 20 uncached Discogs searches a
  minute, and a 429 from Discogs pauses it for a minute (``limited``).
* **Cached.** Searches for 10 minutes and tracklists for 6 hours, in memory,
  so a page reload or a second look costs nothing.
* **Said, not hidden.** Each search answers every source's state: ``ok``,
  ``down`` (it didn't answer: 22r's Notice), ``off`` (not set up, with
  why: Discogs without a token, MixesDB until an admin turns it on),
  ``limited`` (why: ``rate_limited`` or ``profile``).

Answers are data: titles and names are cut to sane lengths and nothing in
them is followed.
"""

from __future__ import annotations

import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional, Tuple

import requests

from core.sets.tracklist import MAX_LINES, page_title_from_link, read_line, wikitext_lines
from utils.logging_config import get_logger

logger = get_logger("sets.sources")

#: MixesDB's MediaWiki API: the only MixesDB address SYNCHRO.S requests
MIXESDB_API = "https://www.mixesdb.com/db/api.php"
#: links to these hosts are read for a page title (MixesDB moved to Mixes.wiki
#: in 2024; links to either name a page)
MIXESDB_LINK_HOSTS = ("www.mixesdb.com", "mixesdb.com", "www.mixes.wiki", "mixes.wiki")
MIXESDB_PAGE = "https://www.mixesdb.com/w/"
#: Discogs' API
DISCOGS_API = "https://api.discogs.com"

CONNECT_TIMEOUT = 5.0
READ_TIMEOUT = 10.0
#: the most bytes read from any one answer
MAX_BYTES = 2 * 1024 * 1024
#: the pause between two requests to the same source
MIN_INTERVAL = {"mixesdb": 1.0, "discogs": 1.0}
SEARCH_TTL = 600.0
TRACKLIST_TTL = 6 * 3600.0
MAX_CACHE = 256
MAX_RESULTS = 8
MAX_QUERY = 200

SOURCES = ("mixesdb", "musicbrainz", "discogs")
SOURCE_NAMES = {"mixesdb": "MixesDB", "musicbrainz": "MusicBrainz", "discogs": "Discogs"}

#: config: MixesDB is searched only once an admin turns it on (HANDOFF 240:
#: its terms couldn't be confirmed when Sets 1 was built)
SETTING_MIXESDB = "sets.mixesdb_enabled"


class SourceDown(Exception):
    """The source didn't answer, or answered with something unusable."""


#: who's asking, with a way to reach the project (as the other clients send)
USER_AGENT = "SoulSync/2.2 Sets (+https://github.com/Nezreka/SoulSync)"


def user_agent() -> str:
    return USER_AGENT


# ── the cache and the pacing ──────────────────────────────────────────────────

_cache: Dict[Tuple, Tuple[float, Any]] = {}
_cache_lock = threading.Lock()
_pace_locks = {name: threading.Lock() for name in MIN_INTERVAL}
_last_call: Dict[str, float] = {}


def _cached(key: Tuple, ttl: float, load: Callable[[], Any]) -> Any:
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    value = load()  # a failure raises and isn't cached, so Try again asks again
    with _cache_lock:
        if len(_cache) >= MAX_CACHE:
            for old in sorted(_cache, key=lambda k: _cache[k][0])[:MAX_CACHE // 4]:
                _cache.pop(old, None)
        _cache[key] = (now + ttl, value)
    return value


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _cache_has(key: Tuple) -> bool:
    with _cache_lock:
        hit = _cache.get(key)
        return bool(hit and hit[0] > time.monotonic())


#: how long a request waits for its source's turn before it gives up
LOCK_WAIT = 25.0
#: the whole request, connect to last byte, ends by this many seconds
TOTAL_DEADLINE = 20.0
#: after Discogs says "too many requests" (429), it isn't asked for this long
DISCOGS_BACKOFF = 60.0
#: uncached Discogs searches one profile may start in a minute (the token is
#: the admin's, shared by every profile)
DISCOGS_PER_PROFILE = 20

_discogs_until = 0.0
_discogs_asks: Dict[Any, List[float]] = {}
_discogs_lock = threading.Lock()


class SourceBusy(SourceDown):
    """The source asked us to slow down (429), or this profile has asked it
    often enough for now. ``why`` is "rate_limited" or "profile"."""

    def __init__(self, message: str, why: str):
        super().__init__(message)
        self.why = why


def _turn(source: str):
    """One request at a time per source, at least MIN_INTERVAL apart: the
    lock is held for the whole request, so the pause holds across threads."""
    lock = _pace_locks[source]
    if not lock.acquire(timeout=LOCK_WAIT):
        raise SourceDown(f"{SOURCE_NAMES[source]} is busy with other requests")
    wait = _last_call.get(source, 0.0) + MIN_INTERVAL[source] - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    return lock


# ── one request ───────────────────────────────────────────────────────────────

#: the requests session's get; tests replace it
_http_get: Callable[..., Any] = requests.get


def _get_json(source: str, url: str, params: Dict[str, Any], headers: Optional[Dict[str, str]] = None) -> Any:
    """GET a fixed URL with ``params``: JSON, or SourceDown. ``url`` is one of
    this module's constants plus a fixed path, never anything from outside.
    Bounded three ways: 5 s to connect and 10 s between bytes, TOTAL_DEADLINE
    for the whole answer, and MAX_BYTES."""
    global _discogs_until
    if not (url.startswith(MIXESDB_API) or url.startswith(DISCOGS_API + "/")):
        raise ValueError("not a Sets source address")
    if source == "discogs" and time.monotonic() < _discogs_until:
        raise SourceBusy("Discogs asked SYNCHRO.S to slow down", "rate_limited")
    lock = _turn(source)
    try:
        started = time.monotonic()
        sent = {"User-Agent": user_agent(), "Accept": "application/json", **(headers or {})}
        try:
            response = _http_get(url, params=params, headers=sent, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
                                 allow_redirects=False, stream=True)
        except requests.RequestException as exc:
            raise SourceDown(f"{SOURCE_NAMES[source]} didn't answer") from exc
        try:
            if response.status_code == 429 and source == "discogs":
                _discogs_until = time.monotonic() + DISCOGS_BACKOFF
                raise SourceBusy("Discogs asked SYNCHRO.S to slow down", "rate_limited")
            if response.status_code != 200:
                raise SourceDown(f"{SOURCE_NAMES[source]} answered {response.status_code}")
            body = bytearray()
            for chunk in response.iter_content(64 * 1024):
                body += chunk
                if len(body) > MAX_BYTES:
                    raise SourceDown(f"{SOURCE_NAMES[source]}'s answer was too big")
                if time.monotonic() - started > TOTAL_DEADLINE:
                    raise SourceDown(f"{SOURCE_NAMES[source]} took too long to answer")
        except requests.RequestException as exc:
            raise SourceDown(f"{SOURCE_NAMES[source]} stopped answering") from exc
        finally:
            response.close()
    finally:
        _last_call[source] = time.monotonic()
        lock.release()
    try:
        return json.loads(body.decode("utf-8", errors="replace"))
    except ValueError as exc:
        raise SourceDown(f"{SOURCE_NAMES[source]} didn't send JSON") from exc


def _discogs_allowed(profile_id: Any) -> bool:
    """Whether this profile may start another uncached Discogs search now
    (DISCOGS_PER_PROFILE a minute); counts it when it may."""
    now = time.monotonic()
    with _discogs_lock:
        asks = [t for t in _discogs_asks.get(profile_id, []) if now - t < 60.0]
        if len(asks) >= DISCOGS_PER_PROFILE:
            _discogs_asks[profile_id] = asks
            return False
        asks.append(now)
        _discogs_asks[profile_id] = asks
        if len(_discogs_asks) > 1000:
            for key in [k for k, v in _discogs_asks.items() if not v or now - v[-1] >= 60.0]:
                _discogs_asks.pop(key, None)
        return True


def reset_limits() -> None:
    """Tests: forget the Discogs back-off and the per-profile counts."""
    global _discogs_until
    with _discogs_lock:
        _discogs_asks.clear()
    _discogs_until = 0.0


def _text(value: Any, limit: int = 300) -> str:
    return " ".join(str(value or "").split())[:limit]


# ── MixesDB ───────────────────────────────────────────────────────────────────

def mixesdb_enabled() -> bool:
    try:
        from core.settings import config_manager

        return bool(config_manager.get(SETTING_MIXESDB, False))
    except Exception:  # noqa: BLE001
        return False


def _mixesdb_search(query: str) -> List[Dict[str, Any]]:
    data = _get_json("mixesdb", MIXESDB_API, {
        "action": "query", "list": "search", "srsearch": query, "srnamespace": 0,
        "srlimit": MAX_RESULTS, "srprop": "timestamp|wordcount", "format": "json", "formatversion": 2})
    hits = ((data or {}).get("query") or {}).get("search") or []
    out = []
    for hit in hits[:MAX_RESULTS]:
        title = _text(hit.get("title"), 255)
        if not title or title.startswith("Category:"):
            continue
        out.append({"source": "mixesdb", "id": title, "title": _mix_title(title),
                    "date": _mix_date(title), "edited": _text(hit.get("timestamp"), 40) or None,
                    "tracks": None, "kind": "mix"})
    return out


def _mix_date(page: str) -> Optional[str]:
    head = page[:10]
    return head if len(head) == 10 and head[4] == "-" and head[7] == "-" and head.replace("-", "").isdigit() else None


def _mix_title(page: str) -> str:
    """"2019-05-12 - Saltmarsh - Essential Mix" -> "Saltmarsh - Essential Mix"."""
    return page[13:].strip() if _mix_date(page) and page[10:13] == " - " else page


def _mixesdb_open(page: str) -> Dict[str, Any]:
    data = _get_json("mixesdb", MIXESDB_API, {
        "action": "query", "prop": "revisions", "titles": page, "rvprop": "timestamp|content",
        "rvslots": "main", "format": "json", "formatversion": 2})
    pages = ((data or {}).get("query") or {}).get("pages") or []
    if not pages or pages[0].get("missing"):
        return {"found": False}
    revision = (pages[0].get("revisions") or [{}])[0]
    wikitext = ((revision.get("slots") or {}).get("main") or {}).get("content") or revision.get("content") or ""
    lines = [line for line in (read_line(raw) for raw in wikitext_lines(wikitext)) if line]
    title = _text(pages[0].get("title"), 255) or page
    from urllib.parse import quote

    return {"found": True, "source": "mixesdb", "id": title, "title": _mix_title(title), "date": _mix_date(title),
            "edited": _text(revision.get("timestamp"), 40) or None,
            "url": MIXESDB_PAGE + quote(title.replace(" ", "_")), "lines": lines[:MAX_LINES]}


# ── MusicBrainz: released DJ mixes ────────────────────────────────────────────

_mb_client = None


def _musicbrainz():
    global _mb_client
    if _mb_client is None:
        from core.musicbrainz_client import MusicBrainzClient

        _mb_client = MusicBrainzClient()
    return _mb_client


def _credit(credits: Any) -> str:
    parts = []
    for credit in credits or []:
        if isinstance(credit, dict):
            parts.append(_text(credit.get("name") or (credit.get("artist") or {}).get("name"), 200))
            parts.append(str(credit.get("joinphrase") or ""))
    return _text("".join(parts), 300)


def _musicbrainz_search(query: str) -> List[Dict[str, Any]]:
    try:
        releases = _musicbrainz().search_dj_mixes(query, limit=MAX_RESULTS)
    except Exception as exc:  # noqa: BLE001 - every failure is "didn't answer"
        raise SourceDown("MusicBrainz didn't answer") from exc
    out = []
    for release in releases[:MAX_RESULTS]:
        mbid = _text(release.get("id"), 40)
        if not mbid:
            continue
        tracks = sum(int(m.get("track-count") or 0) for m in release.get("media") or [] if isinstance(m, dict))
        out.append({"source": "musicbrainz", "id": mbid, "title": _text(release.get("title"), 255),
                    "artist": _credit(release.get("artist-credit")), "date": _text(release.get("date"), 10) or None,
                    "tracks": tracks or None, "kind": "cd", "edited": None})
    return out


def _clock(ms: int) -> str:
    seconds = ms // 1000
    hours, rest = divmod(seconds, 3600)
    return f"{hours}:{rest // 60:02d}:{rest % 60:02d}" if hours else f"{rest // 60:02d}:{rest % 60:02d}"


def _musicbrainz_open(mbid: str) -> Dict[str, Any]:
    try:
        release = _musicbrainz().get_dj_mix_release(mbid)
    except Exception as exc:  # noqa: BLE001
        raise SourceDown("MusicBrainz didn't answer") from exc
    if not release:
        return {"found": False}
    lines: List[Dict[str, Any]] = []
    elapsed = 0
    for medium in release.get("media") or []:
        for track in (medium or {}).get("tracks") or []:
            recording = track.get("recording") or {}
            artist = _credit(track.get("artist-credit") or recording.get("artist-credit"))
            title = _text(track.get("title") or recording.get("title"), 300)
            at = _clock(elapsed)
            elapsed += int(track.get("length") or recording.get("length") or 0)
            if not title:
                continue
            lines.append({"kind": "track", "artist": artist, "title": title, "at": at, "note": "",
                          "mbid": _text(recording.get("id"), 40) or None, "raw": None})
            if len(lines) >= MAX_LINES:
                break
    return {"found": True, "source": "musicbrainz", "id": _text(release.get("id"), 40), "kind": "cd",
            "title": _text(release.get("title"), 255), "artist": _credit(release.get("artist-credit")),
            "date": _text(release.get("date"), 10) or None, "edited": None,
            "url": f"https://musicbrainz.org/release/{_text(release.get('id'), 40)}", "lines": lines,
            "seconds": elapsed // 1000 or None}


# ── Discogs ───────────────────────────────────────────────────────────────────

def discogs_token() -> str:
    try:
        from core.settings import config_manager

        return str(config_manager.get("discogs.token", "") or "")
    except Exception:  # noqa: BLE001
        return ""


def _discogs_headers() -> Dict[str, str]:
    return {"Authorization": f"Discogs token={discogs_token()}"}


def _discogs_search(query: str) -> List[Dict[str, Any]]:
    data = _get_json("discogs", f"{DISCOGS_API}/database/search", {
        "q": query, "type": "release", "format": "Mixed", "per_page": MAX_RESULTS}, _discogs_headers())
    out = []
    for hit in ((data or {}).get("results") or [])[:MAX_RESULTS]:
        rid = hit.get("id")
        if not isinstance(rid, int):
            continue
        out.append({"source": "discogs", "id": str(rid), "title": _text(hit.get("title"), 255),
                    "date": _text(hit.get("year"), 10) or None, "tracks": None, "kind": "cd", "edited": None})
    return out


def _discogs_open(release_id: str) -> Dict[str, Any]:
    if not re.fullmatch(r"[0-9]{1,12}", release_id):
        return {"found": False}
    data = _get_json("discogs", f"{DISCOGS_API}/releases/{int(release_id)}", {}, _discogs_headers())
    if not isinstance(data, dict) or not data.get("id"):
        return {"found": False}
    release_artist = ", ".join(_text(a.get("name"), 200) for a in data.get("artists") or [] if isinstance(a, dict))
    lines = []
    for track in data.get("tracklist") or []:
        if not isinstance(track, dict) or (track.get("type_") or "track") != "track":
            continue
        artists = track.get("artists") or []
        artist = "".join(f"{_text(a.get('name'), 200)}{' ' + a['join'] + ' ' if a.get('join') else ''}"
                         for a in artists if isinstance(a, dict)).strip() or release_artist
        title = _text(track.get("title"), 300)
        if title:
            lines.append({"kind": "track", "artist": _text(artist), "title": title, "at": "", "note": "",
                          "mbid": None, "raw": None})
        if len(lines) >= MAX_LINES:
            break
    return {"found": True, "source": "discogs", "id": str(data["id"]), "kind": "cd",
            "title": _text(data.get("title"), 255), "artist": _text(release_artist),
            "date": _text(data.get("year"), 10) or None, "edited": None,
            "url": f"https://www.discogs.com/release/{int(data['id'])}", "lines": lines}


# ── what the routes call ──────────────────────────────────────────────────────

def states() -> Dict[str, Dict[str, str]]:
    """Each source's set-up state before any search: ``ok`` or ``off``
    with why."""
    out = {"mixesdb": {"state": "ok"}, "musicbrainz": {"state": "ok"}, "discogs": {"state": "ok"}}
    if not mixesdb_enabled():
        out["mixesdb"] = {"state": "off", "why": "terms"}
    if not discogs_token():
        out["discogs"] = {"state": "off", "why": "token"}
    return out


_SEARCHERS = {"mixesdb": _mixesdb_search, "musicbrainz": _musicbrainz_search, "discogs": _discogs_search}
_OPENERS = {"mixesdb": _mixesdb_open, "musicbrainz": _musicbrainz_open, "discogs": _discogs_open}


def search(query: str, *, only: Optional[str] = None, profile_id: Any = None) -> Dict[str, Any]:
    """Search every source that's set up, together. ``{"results": [...],
    "sources": {name: {"state", "why"?}}}``; a source that fails is
    ``down`` and the others still answer. A pasted MixesDB link becomes
    that page."""
    text = " ".join(str(query or "").split())[:MAX_QUERY]
    found = states()
    if not text:
        return {"results": [], "sources": found}
    page = page_title_from_link(text, MIXESDB_LINK_HOSTS)
    if page:
        if found["mixesdb"]["state"] != "ok":
            return {"results": [], "sources": found}
        try:
            opened = _cached(("open", "mixesdb", page), TRACKLIST_TTL, lambda: _mixesdb_open(page))
        except SourceDown:
            found["mixesdb"] = {"state": "down"}
            return {"results": [], "sources": found}
        results = [] if not opened.get("found") else [{
            "source": "mixesdb", "id": opened["id"], "title": opened["title"], "date": opened["date"],
            "edited": opened["edited"], "tracks": len(opened["lines"]), "kind": "mix"}]
        return {"results": results, "sources": found}
    wanted = [name for name in SOURCES if found[name]["state"] == "ok" and (only is None or only == name)]

    def one(name: str):
        key = ("search", name, text.lower())
        try:
            if name == "discogs" and not _cache_has(key) and not _discogs_allowed(profile_id):
                return name, [], "limited:profile"
            return name, _cached(key, SEARCH_TTL, lambda: _SEARCHERS[name](text)), None
        except SourceBusy as exc:
            logger.info("Sets: %s", exc)
            return name, [], f"limited:{exc.why}"
        except SourceDown as exc:
            logger.info("Sets: %s", exc)
            return name, [], "down"
        except Exception as exc:  # noqa: BLE001 - one broken source never takes the others down
            logger.warning("Sets: %s search failed: %s", name, exc)
            return name, [], "down"

    results: List[Dict[str, Any]] = []
    if wanted:
        with ThreadPoolExecutor(max_workers=len(wanted)) as pool:
            for name, rows, state in pool.map(one, wanted):
                if state and state.startswith("limited:"):
                    found[name] = {"state": "limited", "why": state.split(":", 1)[1]}
                elif state:
                    found[name] = {"state": state}
                results.extend(rows)
    return {"results": results, "sources": found}


def open_mix(source: str, mix_id: str) -> Dict[str, Any]:
    """One mix's tracklist: ``{"found": True, "lines": [...], ...}``,
    ``{"found": False}``, or SourceDown. ``state`` "off" sources raise
    LookupError."""
    if source not in _OPENERS:
        raise LookupError("unknown source")
    if states()[source]["state"] != "ok":
        raise LookupError("source off")
    key = str(mix_id or "").strip()[:255]
    if not key:
        return {"found": False}
    return _cached(("open", source, key), TRACKLIST_TTL, lambda: _OPENERS[source](key))


__all__ = ["DISCOGS_API", "MAX_BYTES", "MIXESDB_API", "MIXESDB_LINK_HOSTS", "SETTING_MIXESDB", "SOURCES",
           "SOURCE_NAMES", "SourceBusy", "SourceDown", "clear_cache", "open_mix", "reset_limits", "search",
           "states"]
