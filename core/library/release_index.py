"""The library's release index: every album you have, every album of your
artists you don't, and what each one's state is. Library → Albums, Genres and
Artists (boards 7a–7g) read it.

One build reads, in a handful of set-based queries (never one per album):

* **Your albums** in the caller's library (active media server, the profile's
  library scope): title, year, art, genres, the tracks that have a file, the
  expected track total a metadata source reported (``albums.api_track_count``),
  how many tracks are below the quality target (the same extension + stored
  bitrate rules as ``core.quality.presets``) and the format most of them are.
* **Albums you don't have**: the releases a metadata service listed for an
  artist in your library, from SYNCHRO.S's metadata cache
  (``metadata_cache_entities``, filled whenever an artist's discography is
  fetched: the Artist page, a followed-artist scan, enrichment). Albums and
  EPs only; singles and compilations are left out. Matched to the library
  artist by the source's artist id where the library has one, by name
  otherwise; a release whose title matches one you have (editions folded) is
  yours, not missing.
* **Wanted**: the profile's Wanted rows, grouped by album, which mark a
  release "Wanted · searching" / "Wanted · not found" (3+ tries, as the Wanted
  page says) and add albums that are on Wanted but in neither list above.

**Genre** comes from the album's own ``genres`` (what the media server read
from the files' tags, filled in by SYNCHRO.S's enrichment from Deezer,
Last.fm, Discogs, Qobuz, AudioDB or Bandcamp where the tags had none); an
album with none takes its artist's genres. A release you don't have takes the
genres the metadata service gave it, else its artist's. An album with several
genres counts in each.

The build is cached per (profile, library scope, media server) for a few
seconds, so paging, facets and a bulk add's "select all" share one read;
anything that changes Wanted or the library through these routes clears it.
"""

from __future__ import annotations

import json
import re
import threading
import time
import unicodedata
from contextlib import closing
from functools import lru_cache
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from utils.logging_config import get_logger

logger = get_logger("library.release_index")

CACHE_TTL_SECONDS = 8.0
NOT_FOUND_TRIES = 3

ALBUM_SHOWS = ("all", "library", "missing", "below")
ALBUM_SORTS = ("recent", "artist", "title", "year", "genre")
ARTIST_SHOWS = ("all", "following", "incomplete")
ARTIST_SORTS = ("name", "recent", "missing")
GENRE_SHOWS = ("all", "gaps")
GENRE_SORTS = ("albums", "name")

# release types a library grid lists; singles and compilations are not albums
_GRID_TYPES = {"album", "ep"}
# sources whose cached albums carry an artist id the library stores
_ARTIST_ID_COLUMNS = {
    "spotify": "spotify_artist_id",
    "deezer": "deezer_id",
    "itunes": "itunes_artist_id",
    "discogs": "discogs_id",
}
# order a release you don't have is described from when several sources list it
_SOURCE_ORDER = ("spotify", "deezer", "itunes", "discogs", "musicbrainz", "jiosaavn", "beatport")
_PLACEHOLDER_ARTISTS = {"various artists", "unknown artist", "various", "va", ""}

_BRACKETS = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]\s*")
_TRAILING_QUALIFIER = re.compile(
    r"\s+-\s+(?:single|ep|deluxe(?: edition| version)?|remaster(?:ed)?(?: \d{4})?|"
    r"\d{4} remaster(?:ed)?|expanded(?: edition)?|bonus track version|special edition|"
    r"anniversary edition|live)\s*$",
    re.IGNORECASE,
)
_NON_WORD = re.compile(r"[^\w ]+", re.UNICODE)
_SPACES = re.compile(r"\s+")


@lru_cache(maxsize=65536)
def _norm_title(text: str) -> str:
    if not text.isascii():
        text = unicodedata.normalize("NFKC", text)
    text = _TRAILING_QUALIFIER.sub(" ", text)
    folded = _BRACKETS.sub(" ", text)
    # a title that is only a bracketed group keeps it rather than becoming ""
    if folded.strip():
        text = folded
    text = _NON_WORD.sub(" ", text.casefold())
    return _SPACES.sub(" ", text).strip()


def norm_title(title: Any) -> str:
    """A title folded for "is this the same release": editions, brackets,
    punctuation and case dropped. Comparison only, never shown."""
    return _norm_title(str(title or ""))


def norm_name(name: Any) -> str:
    return _SPACES.sub(" ", unicodedata.normalize("NFKC", str(name or "")).casefold()).strip()


def parse_genres(raw: Any) -> List[str]:
    """``genres`` as stored (a JSON array, or a legacy comma list) -> names."""
    if raw is None:
        return []
    if isinstance(raw, list):
        return list(_clean_genres(tuple(str(i.get("name") or i.get("tag") or "") if isinstance(i, dict) else i
                                        for i in raw)))
    text = str(raw).strip()
    if not text or text == "[]":
        return []
    return list(_parse_genre_text(text))


@lru_cache(maxsize=8192)
def _parse_genre_text(text: str) -> Tuple[str, ...]:
    try:
        parsed = json.loads(text)
        items = parsed if isinstance(parsed, list) else [parsed]
    except (TypeError, ValueError):
        items = text.split(",")
    return _clean_genres(tuple(str(i.get("name") or i.get("tag") or "") if isinstance(i, dict) else i
                               for i in items))


def _clean_genres(items: Tuple[Any, ...]) -> Tuple[str, ...]:
    out: List[str] = []
    seen = set()
    for item in items:
        name = str(item or "").strip()
        key = name.casefold()
        if name and key not in seen:
            seen.add(key)
            out.append(name)
    return tuple(out)


def _year(value: Any) -> Optional[int]:
    if value is None:
        return None
    text = str(value).strip()
    try:
        year = int(text[:4])
    except (TypeError, ValueError):
        return None
    return year if 1000 <= year <= 3000 else None


def _album_type(value: Any) -> str:
    t = str(value or "").strip().lower()
    if t in ("ep", "eps"):
        return "ep"
    if t in ("single", "singles"):
        return "single"
    if t in ("compilation", "compilations", "appears_on"):
        return "compilation"
    return "album"


def _int(value: Any) -> Optional[int]:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n


# ── the build ────────────────────────────────────────────────────────────────


class ReleaseIndex:
    """What one build read. ``releases`` in no particular order; ``artists`` by
    the canonical library artist id (the lowest id of a name in this library)."""

    def __init__(self) -> None:
        self.releases: List[Dict[str, Any]] = []
        self.by_id: Dict[str, Dict[str, Any]] = {}
        self.artists: Dict[Any, Dict[str, Any]] = {}
        self.genre_names: Dict[str, str] = {}
        self.target: Dict[str, Any] = {}
        self.built_ms: float = 0.0
        self.built_at: float = 0.0

    def add(self, release: Dict[str, Any]) -> None:
        self.releases.append(release)
        self.by_id[release["id"]] = release


_cache: Dict[Tuple, ReleaseIndex] = {}
_cache_lock = threading.Lock()


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


def _scope_key(database) -> Any:
    try:
        from core.library_scope import current_library_scope
        scope = current_library_scope()
        return repr(scope)
    except Exception:  # noqa: BLE001 - no scope resolver: the shared library
        return None


def _active_server() -> Optional[str]:
    try:
        from core.settings import config_manager
        return config_manager.get_active_media_server()
    except Exception:  # noqa: BLE001
        return None


def get_index(database, profile_id: int, *, fix_art=None, server: Optional[str] = None) -> ReleaseIndex:
    """The cached build for this profile and library, rebuilt after
    ``CACHE_TTL_SECONDS``. ``fix_art`` turns a stored art path into one a
    browser can load (media-server art is stored relative)."""
    server = server if server is not None else _active_server()
    key = (int(profile_id or 1), _scope_key(database), server)
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit is not None and now - hit.built_at < CACHE_TTL_SECONDS:
            return hit
    index = build_index(database, int(profile_id or 1), fix_art=fix_art, server=server)
    index.built_at = time.monotonic()
    with _cache_lock:
        if len(_cache) > 16:
            _cache.clear()
        _cache[key] = index
    return index


def build_index(database, profile_id: int, *, fix_art=None, server: Optional[str] = None) -> ReleaseIndex:
    started = time.perf_counter()
    index = ReleaseIndex()
    fix = fix_art or (lambda url: url)

    def _where(alias: str) -> Tuple[str, List[Any]]:
        clauses: List[str] = []
        values: List[Any] = []
        if server is not None:
            clauses.append(f"{alias}.server_source = ?")
            values.append(server)
        scope_sql, scope_params = database._current_scope_sql(f"{alias}.owner_profile_id")
        clauses.append(scope_sql)
        values.extend(scope_params)
        return " AND ".join(clauses) or "1=1", values

    artist_where, params = _where("a")
    album_where, album_params = _where("al")

    with closing(database._get_connection()) as conn:
        cur = conn.cursor()

        # artists of this library, folded by name like the old library grid
        cur.execute(
            f"SELECT a.id, a.name, a.thumb_url, a.genres, a.created_at, a.spotify_artist_id, "
            f"a.deezer_id, a.itunes_artist_id, a.discogs_id FROM artists a WHERE {artist_where} "
            f"ORDER BY a.id", params)
        canonical_of: Dict[Any, Any] = {}
        by_name: Dict[str, Any] = {}
        provider_ids: Dict[Tuple[str, str], Any] = {}
        provider_of_artist: Dict[Any, Dict[str, str]] = {}
        for row in cur.fetchall():
            key = norm_name(row["name"])
            if key in _PLACEHOLDER_ARTISTS:
                continue
            cid = by_name.get(key)
            if cid is None:
                cid = row["id"]
                by_name[key] = cid
                index.artists[cid] = {
                    "id": cid, "name": row["name"] or "", "image_url": fix(row["thumb_url"]) if row["thumb_url"] else None,
                    "genres": parse_genres(row["genres"]), "added_at": row["created_at"],
                    "_ids": [],
                }
            else:
                artist = index.artists[cid]
                if not artist["image_url"] and row["thumb_url"]:
                    artist["image_url"] = fix(row["thumb_url"])
                if not artist["genres"]:
                    artist["genres"] = parse_genres(row["genres"])
            canonical_of[row["id"]] = cid
            index.artists[cid]["_ids"].append(row["id"])
            for source, column in _ARTIST_ID_COLUMNS.items():
                value = row[column]
                if value not in (None, ""):
                    provider_ids[(source, str(value))] = cid
                    provider_of_artist.setdefault(cid, {}).setdefault(source, str(value))

        # your albums: one row each, track counts off the tracks index
        cur.execute(
            f"SELECT al.id, al.artist_id, al.title, al.year, al.release_date, al.thumb_url, al.genres, "
            f"al.api_track_count, al.record_type, al.created_at, al.spotify_album_id, al.deezer_id, "
            f"al.itunes_album_id, al.discogs_id, al.musicbrainz_release_id "
            f"FROM albums al WHERE {album_where}", album_params)
        album_rows = cur.fetchall()

        # tracks with a file, per album and audio quality (one grouped pass)
        cur.execute(
            f"SELECT t.album_id AS album_id, "
            f"CASE WHEN substr(t.file_path, -4, 1) = '.' THEN lower(substr(t.file_path, -3)) "
            f"WHEN substr(t.file_path, -5, 1) = '.' THEN lower(substr(t.file_path, -4)) ELSE '' END AS ext, "
            f"COALESCE(t.bitrate, 0) AS br, MAX(COALESCE(t.bit_depth, 0)) AS depth, "
            f"MAX(COALESCE(t.sample_rate, 0)) AS rate, COUNT(*) AS n, SUM(COALESCE(t.play_count, 0)) AS plays "
            f"FROM tracks t JOIN albums al ON al.id = t.album_id "
            f"WHERE t.file_path IS NOT NULL AND t.file_path != '' AND {album_where} "
            f"GROUP BY t.album_id, ext, br", album_params)
        quality_rows = cur.fetchall()

        # the profile's Wanted rows
        wanted_rows = []
        try:
            cur.execute(
                "SELECT spotify_track_id, spotify_data, retry_count, date_added, source_type "
                "FROM wishlist_tracks WHERE profile_id = ?", (int(profile_id),))
            wanted_rows = cur.fetchall()
        except Exception as exc:  # noqa: BLE001 - no Wanted table: nothing wanted
            logger.debug("release index: wanted read skipped: %s", exc)

        # releases the metadata services listed, for artists in this library
        cached_rows = []
        try:
            cur.execute(
                "SELECT source, entity_id, name, image_url, genres, artist_name, artist_id, release_date, "
                "total_tracks, album_type, created_at FROM metadata_cache_entities "
                "WHERE entity_type = 'album'")
            cached_rows = cur.fetchall()
        except Exception as exc:  # noqa: BLE001 - no cache table yet
            logger.debug("release index: metadata cache read skipped: %s", exc)

    # ── quality per album ──
    from core.quality import presets as _presets
    current = _presets.current_target(database)
    targets = current.get("targets") or []
    index.target = {k: current.get(k) for k in ("name", "preset", "quality_profile_id", "quality_profile_name")}
    per_album: Dict[Any, Dict[str, Any]] = {}
    judged: Dict[Tuple[str, int], Tuple[bool, str]] = {}
    for row in quality_rows:
        acc = per_album.setdefault(row["album_id"], {"tracks": 0, "below": 0, "plays": 0, "formats": {},
                                                      "depth": 0, "rate": 0})
        n = int(row["n"] or 0)
        qkey = (row["ext"] or "", int(row["br"] or 0))
        verdict = judged.get(qkey)
        if verdict is None:
            aq = _presets.audio_quality(*qkey)
            verdict = (bool(targets) and not _presets.meets_targets(aq, targets), _presets.quality_label(aq))
            judged[qkey] = verdict
        acc["tracks"] += n
        acc["plays"] += int(row["plays"] or 0)
        if verdict[0]:
            acc["below"] += n
        label = verdict[1]
        acc["formats"][label] = acc["formats"].get(label, 0) + n
        acc["depth"] = max(acc["depth"], int(row["depth"] or 0))
        acc["rate"] = max(acc["rate"], int(row["rate"] or 0))

    def _format(acc: Dict[str, Any]) -> Optional[str]:
        if not acc or not acc["formats"]:
            return None
        label = sorted(acc["formats"].items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
        if label == "FLAC" and acc["depth"] > 16 and acc["rate"]:
            rate = acc["rate"] / 1000
            return f"FLAC {acc['depth']}/{rate:g}"
        return label

    # ── your albums ──
    owned_keys: Dict[Tuple[Any, str], Dict[str, Any]] = {}
    for row in album_rows:
        cid = canonical_of.get(row["artist_id"])
        artist = index.artists.get(cid) if cid is not None else None
        acc = per_album.get(row["id"])
        owned = acc["tracks"] if acc else 0
        if owned <= 0:
            # an album row with no file on disk isn't something you have
            continue
        expected = _int(row["api_track_count"])
        genres = parse_genres(row["genres"]) or (list(artist["genres"]) if artist else [])
        below = acc["below"] if acc else 0
        partial = bool(expected and owned < expected)
        release = {
            "id": f"album:{row['id']}",
            "kind": "library",
            "album_id": row["id"],
            "title": row["title"] or "",
            "artist_id": cid,
            "artist_name": artist["name"] if artist else "",
            "year": _year(row["year"]) or _year(row["release_date"]),
            "art_url": fix(row["thumb_url"]) if row["thumb_url"] else None,
            "genres": genres,
            "album_type": _album_type(row["record_type"]),
            "tracks_total": expected if partial else owned,
            "tracks_owned": owned,
            "below_target": below,
            "format": _format(acc),
            "state": "partial" if partial else ("below_target" if below else "owned"),
            "wanted": None,
            "added_at": row["created_at"],
            "plays": acc["plays"] if acc else 0,
            "source": None,
            "source_id": None,
            "_provider": [(s, str(v)) for s, v in (("spotify", row["spotify_album_id"]), ("deezer", row["deezer_id"]),
                                                   ("itunes", row["itunes_album_id"]), ("discogs", row["discogs_id"]))
                          if v not in (None, "")],
        }
        index.add(release)
        if cid is not None:
            owned_keys.setdefault((cid, norm_title(release["title"])), release)

    # ── releases you don't have, from the metadata cache ──
    missing_keys: Dict[Tuple[Any, str], Dict[str, Any]] = {}
    rank = {s: i for i, s in enumerate(_SOURCE_ORDER)}
    for row in cached_rows:
        atype = _album_type(row["album_type"])
        if atype not in _GRID_TYPES:
            continue
        source = (row["source"] or "").lower()
        cid = None
        if row["artist_id"] not in (None, "") and source in _ARTIST_ID_COLUMNS:
            cid = provider_ids.get((source, str(row["artist_id"])))
            if cid is None:
                # the library knows this artist on that source by another id:
                # it's a namesake, not them
                named = by_name.get(norm_name(row["artist_name"]))
                if named is not None and source in provider_of_artist.get(named, {}):
                    continue
                cid = named
        else:
            cid = by_name.get(norm_name(row["artist_name"]))
        if cid is None:
            continue
        title = row["name"] or ""
        tkey = norm_title(title)
        if not tkey or (cid, tkey) in owned_keys:
            continue
        existing = missing_keys.get((cid, tkey))
        if existing is not None and rank.get(existing["source"], 99) <= rank.get(source, 99):
            if not existing["art_url"] and row["image_url"]:
                existing["art_url"] = row["image_url"]
            if not existing["genres"]:
                existing["genres"] = parse_genres(row["genres"])
            continue
        artist = index.artists[cid]
        release = {
            "id": f"release:{source}:{row['entity_id']}",
            "kind": "missing",
            "album_id": None,
            "title": title,
            "artist_id": cid,
            "artist_name": artist["name"],
            "year": _year(row["release_date"]),
            "art_url": row["image_url"] or (existing or {}).get("art_url"),
            "genres": parse_genres(row["genres"]) or list(artist["genres"]),
            "album_type": atype,
            "tracks_total": _int(row["total_tracks"]) or None,
            "tracks_owned": 0,
            "below_target": 0,
            "format": None,
            "state": "missing",
            "wanted": None,
            "added_at": row["created_at"],
            "plays": 0,
            "source": source,
            "source_id": str(row["entity_id"]),
            "_provider": [(source, str(row["entity_id"]))],
        }
        missing_keys[(cid, tkey)] = release

    for release in missing_keys.values():
        index.add(release)

    # ── Wanted, grouped by album ──
    groups: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for row in wanted_rows:
        try:
            data = json.loads(row["spotify_data"] or "{}")
        except (TypeError, ValueError):
            continue
        album = data.get("album") if isinstance(data.get("album"), dict) else {}
        title = album.get("name") or ""
        if not title:
            continue
        artists = album.get("artists") or data.get("artists") or []
        first = artists[0] if artists else {}
        artist_name = first.get("name") if isinstance(first, dict) else str(first or "")
        key = (norm_name(artist_name), norm_title(title))
        group = groups.setdefault(key, {
            "title": title, "artist_name": artist_name or "", "tracks": 0, "tries": 0,
            "album_type": _album_type(album.get("album_type")), "album_id": str(album.get("id") or ""),
            "source": str(data.get("_source") or "") or None, "release_date": album.get("release_date"),
            "total": _int(album.get("total_tracks")), "added_at": row["date_added"],
            "art": ((album.get("images") or [{}])[0] or {}).get("url") if album.get("images") else None,
        })
        group["tracks"] += 1
        group["tries"] = max(group["tries"], int(row["retry_count"] or 0))
        if row["date_added"] and (not group["added_at"] or str(row["date_added"]) > str(group["added_at"])):
            group["added_at"] = row["date_added"]

    for (artist_key, tkey), group in groups.items():
        state = {"status": "not_found" if group["tries"] >= NOT_FOUND_TRIES else "searching",
                 "tracks": group["tracks"]}
        cid = by_name.get(artist_key)
        target = None
        if cid is not None:
            target = owned_keys.get((cid, tkey)) or missing_keys.get((cid, tkey))
        if target is not None:
            if target["kind"] == "missing" or target["state"] == "partial":
                target["wanted"] = state
            continue
        if group["album_type"] not in _GRID_TYPES or cid is None:
            # an artist outside the library, or a single: Wanted lists it, the
            # library grid doesn't
            continue
        artist = index.artists[cid]
        release = {
            "id": f"wanted:{group['source'] or 'unknown'}:{group['album_id'] or tkey}",
            "kind": "missing",
            "album_id": None,
            "title": group["title"],
            "artist_id": cid,
            "artist_name": artist["name"],
            "year": _year(group["release_date"]),
            "art_url": group["art"],
            "genres": list(artist["genres"]),
            "album_type": group["album_type"],
            "tracks_total": group["total"] or group["tracks"],
            "tracks_owned": 0,
            "below_target": 0,
            "format": None,
            "state": "missing",
            "wanted": state,
            "added_at": group["added_at"],
            "plays": 0,
            "source": group["source"],
            "source_id": group["album_id"] or None,
            "_provider": [(group["source"], group["album_id"])] if group["source"] and group["album_id"] else [],
        }
        missing_keys[(cid, tkey)] = release
        index.add(release)

    # ── per release: search text and genre keys; per artist: counts ──
    for release in index.releases:
        keys = []
        for name in release["genres"]:
            k = name.casefold()
            keys.append(k)
            index.genre_names.setdefault(k, _display_genre(name))
        release["_genre_keys"] = keys
        release["_search"] = " ".join([release["title"], release["artist_name"], *release["genres"]]).casefold()
        artist = index.artists.get(release["artist_id"])
        if artist is not None:
            stats = artist.setdefault("_stats", {"library": 0, "missing": 0, "wanted": 0})
            if release["kind"] == "library":
                stats["library"] += 1
            else:
                stats["missing"] += 1
                if release["wanted"]:
                    stats["wanted"] += 1

    _attach_following(database, index, profile_id, provider_of_artist)
    index.built_ms = round((time.perf_counter() - started) * 1000, 1)
    return index


def _display_genre(name: str) -> str:
    # "ambient" from a tag reads "Ambient"; "IDM" and "Post-rock" stay as written
    return name[:1].upper() + name[1:] if name and name == name.lower() else name


def _attach_following(database, index: ReleaseIndex, profile_id: int,
                      provider_of_artist: Dict[Any, Dict[str, str]]) -> None:
    """Which library artists this profile follows, matched like the old
    library grid (Spotify, iTunes or Deezer id, else the name)."""
    try:
        with closing(database._get_connection()) as conn:
            rows = conn.execute(
                "SELECT spotify_artist_id, itunes_artist_id, deezer_artist_id, LOWER(artist_name) AS name "
                "FROM watchlist_artists WHERE profile_id = ?", (int(profile_id),)).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.debug("release index: following read skipped: %s", exc)
        rows = []
    spotify = {r["spotify_artist_id"] for r in rows if r["spotify_artist_id"]}
    itunes = {r["itunes_artist_id"] for r in rows if r["itunes_artist_id"]}
    deezer = {r["deezer_artist_id"] for r in rows if r["deezer_artist_id"]}
    names = {norm_name(r["name"]) for r in rows if r["name"]}
    for cid, artist in index.artists.items():
        ids = provider_of_artist.get(cid, {})
        artist["following"] = bool(
            (ids.get("spotify") and ids["spotify"] in spotify)
            or (ids.get("itunes") and ids["itunes"] in itunes)
            or (ids.get("deezer") and ids["deezer"] in deezer)
            or norm_name(artist["name"]) in names)
        artist.setdefault("_stats", {"library": 0, "missing": 0, "wanted": 0})


# ── reading it ───────────────────────────────────────────────────────────────


def _public(release: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in release.items() if not k.startswith("_") and k != "plays"}


def _matches_show(release: Dict[str, Any], show: str) -> bool:
    if show == "library":
        return release["kind"] == "library"
    if show == "missing":
        return release["kind"] == "missing"
    if show == "below":
        return release["below_target"] > 0
    return True


def _matches_q(release: Dict[str, Any], q: str) -> bool:
    return not q or q in release["_search"]


def _matches_genres(release: Dict[str, Any], genres: Sequence[str]) -> bool:
    if not genres:
        return True
    keys = release["_genre_keys"]
    return any(g in keys for g in genres)


def _added_key(release: Dict[str, Any]) -> str:
    return str(release.get("added_at") or "")


def _sort_releases(releases: List[Dict[str, Any]], sort: str, genre: str = "") -> List[Dict[str, Any]]:
    def title_key(r):
        return (r["title"].casefold().lstrip("\"'([*#.!¡¿ "), r["artist_name"].casefold())

    if sort == "artist":
        return sorted(releases, key=lambda r: (r["artist_name"].casefold(), -(r["year"] or 0), r["title"].casefold()))
    if sort == "title":
        return sorted(releases, key=title_key)
    if sort == "year":
        return sorted(releases, key=lambda r: (r["year"] is None, -(r["year"] or 0), title_key(r)))
    if sort == "genre":
        return sorted(releases, key=lambda r: (primary_genre(r, genre) == "", primary_genre(r, genre).casefold(),
                                               r["artist_name"].casefold(), r["title"].casefold()))
    # recently added: newest first; ties by title so a page never reshuffles
    return sorted(releases, key=lambda r: (_added_key(r), r["id"]), reverse=True)


def primary_genre(release: Dict[str, Any], picked: str = "") -> str:
    """The heading an album files under when the grid is grouped by genre:
    the picked genre when there is one, else its first."""
    if picked:
        for name in release["genres"]:
            if name.casefold() == picked:
                return name
    return release["genres"][0] if release["genres"] else ""


def _clean(value: Any, allowed: Sequence[str], default: str) -> str:
    text = str(value or "").strip().lower()
    return text if text in allowed else default


def _summary(releases: Iterable[Dict[str, Any]], sample: int = 4) -> Dict[str, Any]:
    """What adding these to Wanted would be: how many, how many tracks, by
    whom, the first few."""
    items = list(releases)
    tracks = 0
    artists: Dict[Any, str] = {}
    for r in items:
        tracks += max(0, (r["tracks_total"] or 0) - (r["tracks_owned"] or 0))
        if r["artist_id"] is not None:
            artists[r["artist_id"]] = r["artist_name"]
    return {
        "count": len(items),
        "tracks": tracks,
        "artists": [{"id": k, "name": v} for k, v in artists.items()],
        "sample": [_public(r) for r in items[:sample]],
    }


def wantable(release: Dict[str, Any]) -> bool:
    """Something to add when picked by hand: you don't have all of it and it
    isn't on Wanted (an album you have part of counts)."""
    if release["wanted"]:
        return False
    return release["kind"] == "missing" or release["state"] == "partial"


def addable_missing(release: Dict[str, Any]) -> bool:
    """What the "missing" buttons add ("Select all N missing", the genre
    line's "Add the 17 missing", a genre or artist tile's hover): releases
    you don't have at all that aren't on Wanted yet. An album you have part
    of is picked by hand."""
    return release["kind"] == "missing" and not release["wanted"]


def album_page(index: ReleaseIndex, *, show: Any = "all", genre: Any = "", q: Any = "", sort: Any = "recent",
               page: Any = 1, limit: Any = 50) -> Dict[str, Any]:
    show = _clean(show, ALBUM_SHOWS, "all")
    sort = _clean(sort, ALBUM_SORTS, "recent")
    genre_key = str(genre or "").strip().casefold()
    query = str(q or "").strip().casefold()
    page_n = max(1, _int(page) or 1)
    limit_n = min(200, max(1, _int(limit) or 50))

    texted = [r for r in index.releases if _matches_q(r, query)]
    in_genre = [r for r in texted if _matches_genres(r, [genre_key] if genre_key else [])]
    show_counts = {s: sum(1 for r in in_genre if _matches_show(r, s)) for s in ALBUM_SHOWS}
    shown = [r for r in texted if _matches_show(r, show)]
    genre_counts: Dict[str, int] = {}
    for r in shown:
        for k in r["_genre_keys"]:
            genre_counts[k] = genre_counts.get(k, 0) + 1
    matching = [r for r in in_genre if _matches_show(r, show)]
    ordered = _sort_releases(matching, sort, genre_key)
    start = (page_n - 1) * limit_n
    window = ordered[start:start + limit_n]
    out = []
    for r in window:
        item = _public(r)
        if sort == "genre":
            item["group"] = primary_genre(r, genre_key) or "No genre"
        out.append(item)

    body: Dict[str, Any] = {
        "releases": out,
        "total": len(matching),
        "page": page_n,
        "limit": limit_n,
        "has_more": start + limit_n < len(matching),
        "show": show,
        "sort": sort,
        "genre": index.genre_names.get(genre_key, genre or "") if genre_key else "",
        "show_counts": show_counts,
        # the "All" chip: this show and text, any genre
        "genre_total": len(shown),
        "genres": [{"key": k, "name": index.genre_names.get(k, k), "count": n}
                   for k, n in sorted(genre_counts.items(), key=lambda kv: (-kv[1], index.genre_names.get(kv[0], kv[0]).casefold()))],
        "totals": totals(index),
        "missing_summary": _summary(r for r in ordered if addable_missing(r)),
        "target": index.target,
    }
    if genre_key:
        whole = [r for r in index.releases if genre_key in r["_genre_keys"]]
        body["genre_summary"] = {
            "name": index.genre_names.get(genre_key, genre),
            "albums": len(whole),
            "library": sum(1 for r in whole if r["kind"] == "library"),
            "missing": sum(1 for r in whole if r["kind"] == "missing"),
            "below": sum(1 for r in whole if r["below_target"] > 0),
            "wantable": _summary(_sort_releases([r for r in whole if addable_missing(r)], sort, genre_key)),
            "below_album_ids": [r["album_id"] for r in whole if r["below_target"] > 0 and r["album_id"] is not None],
        }
    return body


def totals(index: ReleaseIndex) -> Dict[str, int]:
    return {
        "albums": len(index.releases),
        "library": sum(1 for r in index.releases if r["kind"] == "library"),
        "missing": sum(1 for r in index.releases if r["kind"] == "missing"),
        "below": sum(1 for r in index.releases if r["below_target"] > 0),
        "tracks": sum(r["tracks_owned"] for r in index.releases),
        "genres": len(index.genre_names),
        "artists": len(index.artists),
        "following": sum(1 for a in index.artists.values() if a.get("following")),
        "incomplete": sum(1 for a in index.artists.values() if a.get("_stats", {}).get("missing")),
    }


def genre_tiles(index: ReleaseIndex, *, show: Any = "all", sort: Any = "albums", q: Any = "") -> Dict[str, Any]:
    show = _clean(show, GENRE_SHOWS, "all")
    sort = _clean(sort, GENRE_SORTS, "albums")
    query = str(q or "").strip().casefold()
    tiles: Dict[str, Dict[str, Any]] = {}
    for r in index.releases:
        for k in r["_genre_keys"]:
            tile = tiles.setdefault(k, {"key": k, "name": index.genre_names.get(k, k), "albums": 0, "library": 0,
                                        "missing": 0, "wantable": 0, "below": 0, "_covers": []})
            tile["albums"] += 1
            if r["kind"] == "library":
                tile["library"] += 1
                if r["art_url"]:
                    tile["_covers"].append((r.get("plays") or 0, _added_key(r), r["art_url"]))
            else:
                tile["missing"] += 1
            if addable_missing(r):
                tile["wantable"] += 1
            if r["below_target"] > 0:
                tile["below"] += 1
    all_tiles = list(tiles.values())
    with_gaps = sum(1 for t in all_tiles if t["missing"])
    chosen = [t for t in all_tiles if (show != "gaps" or t["missing"]) and (not query or query in t["key"])]
    if sort == "name":
        chosen.sort(key=lambda t: t["name"].casefold())
    else:
        chosen.sort(key=lambda t: (-t["albums"], t["name"].casefold()))
    out = []
    for t in chosen:
        covers = [c[2] for c in sorted(t.pop("_covers"), key=lambda c: (c[0], c[1]), reverse=True)[:4]]
        out.append({**t, "covers": covers})
    return {"genres": out, "total": len(chosen), "show_counts": {"all": len(all_tiles), "gaps": with_gaps},
            "totals": totals(index), "target": index.target}


def artist_page(index: ReleaseIndex, *, show: Any = "all", genre: Any = "", q: Any = "", sort: Any = "name",
                page: Any = 1, limit: Any = 50) -> Dict[str, Any]:
    show = _clean(show, ARTIST_SHOWS, "all")
    sort = _clean(sort, ARTIST_SORTS, "name")
    genre_key = str(genre or "").strip().casefold()
    query = str(q or "").strip().casefold()
    page_n = max(1, _int(page) or 1)
    limit_n = min(200, max(1, _int(limit) or 50))

    rows = []
    for artist in index.artists.values():
        stats = artist.get("_stats") or {"library": 0, "missing": 0, "wanted": 0}
        genres = artist["genres"]
        keys = [g.casefold() for g in genres]
        rows.append((artist, stats, keys))

    def text_ok(artist, keys):
        return not query or query in artist["name"].casefold() or any(query in k for k in keys)

    def show_ok(artist, stats, s):
        if s == "following":
            return bool(artist.get("following"))
        if s == "incomplete":
            return stats["missing"] > 0
        return True

    texted = [row for row in rows if text_ok(row[0], row[2])]
    in_genre = [row for row in texted if not genre_key or genre_key in row[2]]
    show_counts = {s: sum(1 for a, st, _k in in_genre if show_ok(a, st, s)) for s in ARTIST_SHOWS}
    genre_counts: Dict[str, int] = {}
    names: Dict[str, str] = {}
    for a, st, keys in texted:
        if not show_ok(a, st, show):
            continue
        for g, k in zip(a["genres"], keys, strict=True):
            genre_counts[k] = genre_counts.get(k, 0) + 1
            names.setdefault(k, index.genre_names.get(k) or _display_genre(g))
    matching = [row for row in in_genre if show_ok(row[0], row[1], show)]
    if sort == "recent":
        matching.sort(key=lambda row: (str(row[0].get("added_at") or ""), str(row[0]["id"])), reverse=True)
    elif sort == "missing":
        matching.sort(key=lambda row: (-row[1]["missing"], row[0]["name"].casefold()))
    else:
        matching.sort(key=lambda row: row[0]["name"].casefold().lstrip("\"'([*#.!¡¿ "))
    start = (page_n - 1) * limit_n
    out = []
    for artist, stats, _keys in matching[start:start + limit_n]:
        out.append({
            "id": artist["id"],
            "name": artist["name"],
            "image_url": artist["image_url"],
            "genres": artist["genres"],
            "following": bool(artist.get("following")),
            "releases": stats["library"] + stats["missing"],
            "in_library": stats["library"],
            "missing": stats["missing"],
            "wanted": stats["wanted"],
            "wantable": stats["missing"] - stats["wanted"],
        })
    return {
        "artists": out,
        "total": len(matching),
        "page": page_n,
        "limit": limit_n,
        "has_more": start + limit_n < len(matching),
        "show": show,
        "sort": sort,
        "genre": names.get(genre_key) or index.genre_names.get(genre_key, genre or "") if genre_key else "",
        "show_counts": show_counts,
        "genre_total": sum(1 for a, st, _k in texted if show_ok(a, st, show)),
        "genres": [{"key": k, "name": names.get(k, k), "count": n}
                   for k, n in sorted(genre_counts.items(), key=lambda kv: (-kv[1], names.get(kv[0], kv[0]).casefold()))],
        "totals": totals(index),
    }


# ── a selection, as the bulk routes take it ──────────────────────────────────

MAX_SELECTION = 500


def resolve_selection(index: ReleaseIndex, body: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[str]]:
    """``release_ids`` plus, optionally, ``filter`` (everything matching it,
    less ``exclude_ids``): what a selection means. ``filter`` takes ``show``,
    ``genre`` / ``genres`` (any of them), ``q`` and ``artist_ids``; a filter
    selects only releases you don't have that aren't on Wanted
    (``addable_missing``), which is what "Select all N missing" and the genre
    line's button mean.

    Returns ``(releases, unknown_ids)``; order is the filter's (recently added)
    then the ids'."""
    chosen: List[Dict[str, Any]] = []
    seen = set()
    unknown: List[str] = []
    flt = body.get("filter") if isinstance(body.get("filter"), dict) else None
    if flt is not None:
        show = _clean(flt.get("show"), ALBUM_SHOWS, "all")
        genres = flt.get("genres") if isinstance(flt.get("genres"), list) else []
        if flt.get("genre"):
            genres = [*genres, flt.get("genre")]
        genre_keys = [str(g).strip().casefold() for g in genres if str(g or "").strip()]
        query = str(flt.get("q") or "").strip().casefold()
        artist_ids = {str(a) for a in flt.get("artist_ids") or [] if a not in (None, "")}
        exclude = {str(i) for i in body.get("exclude_ids") or []}
        for r in _sort_releases(index.releases, "recent"):
            if r["id"] in exclude or not addable_missing(r):
                continue
            if artist_ids and str(r["artist_id"]) not in artist_ids:
                continue
            if _matches_show(r, show) and _matches_q(r, query) and _matches_genres(r, genre_keys):
                chosen.append(r)
                seen.add(r["id"])
    for rid in body.get("release_ids") or []:
        rid = str(rid)
        if rid in seen:
            continue
        release = index.by_id.get(rid)
        if release is None:
            unknown.append(rid)
            continue
        seen.add(rid)
        chosen.append(release)
    return chosen, unknown


def selection_summary(index: ReleaseIndex, releases: List[Dict[str, Any]], *, sample: int = 4) -> Dict[str, Any]:
    """The confirm's numbers (7d): what would be added, what's already there,
    and the first ``sample`` of them."""
    to_add = [r for r in releases if wantable(r)]
    summary = _summary(to_add, sample=sample)
    summary.update({
        "selected": len(releases),
        "already_have": sum(1 for r in releases if r["kind"] == "library" and r["state"] != "partial"),
        "already_wanted": sum(1 for r in releases if r["wanted"]),
        "types": {t: sum(1 for r in to_add if r["album_type"] == t) for t in sorted({r["album_type"] for r in to_add})},
        "target": index.target,
        "following": [a["id"] for a in summary["artists"] if index.artists.get(a["id"], {}).get("following")],
    })
    return summary


__all__ = [
    "ALBUM_SHOWS", "ALBUM_SORTS", "ARTIST_SHOWS", "ARTIST_SORTS", "GENRE_SHOWS", "GENRE_SORTS",
    "MAX_SELECTION", "ReleaseIndex", "addable_missing", "album_page", "artist_page", "build_index", "clear_cache",
    "genre_tiles", "get_index", "norm_name", "norm_title", "parse_genres", "primary_genre",
    "resolve_selection", "selection_summary", "totals", "wantable",
]
