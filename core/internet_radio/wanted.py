"""Adding a track heard on the radio to Wanted, the way Search does.

Radio knows only an artist and a title. The metadata source is asked for the
track first (so Wanted gets a real release, its art and its position, like a
track added from Search); when it doesn't know it, the track is added as a
single under a stable id made from the names. Either way it goes through the
same add as Search's "Add to Wanted" window (``add_album_track_to_wishlist``):
the library check (``wishlist.allow_duplicate_tracks``), the ignore-list
rules, and the default quality profile, which is the quality target.
"""

from __future__ import annotations

import hashlib
from typing import Any, Callable, Dict, List, Optional

from utils.logging_config import get_logger

logger = get_logger("internet_radio.wanted")


def _norm(text: str) -> str:
    from core.text.normalize import normalize_key
    return normalize_key(text or "")


def _artist_names(value: Any) -> List[str]:
    if isinstance(value, list):
        out = []
        for a in value:
            name = a.get("name") if isinstance(a, dict) else a
            if name:
                out.append(str(name))
        return out
    return [str(value)] if value else []


def pick_match(results: List[Any], artist: str, title: str) -> Optional[Any]:
    """The first result whose artist and title match by key (no fuzzy guess)."""
    want_a, want_t = _norm(artist), _norm(title)
    for r in results or []:
        name = getattr(r, "name", None) or (r.get("name") if isinstance(r, dict) else None)
        artists = getattr(r, "artists", None) if not isinstance(r, dict) else r.get("artists")
        names = [_norm(a) for a in _artist_names(artists)]
        if name and _norm(name) == want_t and want_a in names:
            return r
    return None


def synthetic_id(artist: str, title: str) -> str:
    digest = hashlib.sha1(f"{_norm(artist)}|{_norm(title)}".encode()).hexdigest()[:20]
    return f"radio_{digest}"


def build_payload(artist: str, title: str, release: str = "", match: Any = None) -> Dict[str, Dict[str, Any]]:
    """The ``track``, ``artist`` and ``album`` Search's add window sends."""
    if match is not None:
        get = (lambda k, d=None: match.get(k, d)) if isinstance(match, dict) else (lambda k, d=None: getattr(match, k, d))
        artists = _artist_names(get("artists")) or [artist]
        album_name = get("album")
        if isinstance(album_name, dict):
            album_name = album_name.get("name")
        album_name = str(album_name or release or title)
        image = get("image_url")
        track = {"id": str(get("id")), "name": str(get("name") or title),
                 "artists": [{"name": a} for a in artists], "duration_ms": int(get("duration_ms") or 0),
                 "explicit": bool(get("explicit") or False), "external_urls": get("external_urls") or {}}
        album = {"id": f"radio_album_{_norm(artists[0])}_{_norm(album_name)}"[:120], "name": album_name,
                 "artists": [{"name": artists[0]}], "album_type": str(get("album_type") or "album"),
                 "release_date": str(get("release_date") or ""), "total_tracks": get("total_tracks"),
                 "images": [{"url": image}] if image else []}
        return {"track": track, "artist": {"id": None, "name": artists[0]}, "album": album}
    track = {"id": synthetic_id(artist, title), "name": title, "artists": [{"name": artist}],
             "duration_ms": 0, "explicit": False}
    album = {"id": f"radio_single_{synthetic_id(artist, title)}", "name": release or title,
             "artists": [{"name": artist}], "album_type": "album" if release else "single", "release_date": "",
             "total_tracks": None, "images": []}
    return {"track": track, "artist": {"id": None, "name": artist}, "album": album}


def make_adder(*, search_tracks: Callable[[str, int], List[Any]], runtime_for: Callable[[int], Any],
               add_track: Optional[Callable[..., Any]] = None) -> Callable[[int, Dict[str, Any]], Dict[str, Any]]:
    """``(profile_id, heard) -> {ok, skipped, message}`` over the app's pieces."""
    if add_track is None:
        from core.wishlist.routes import add_album_track_to_wishlist as add_track

    def add(profile_id: int, heard: Dict[str, Any]) -> Dict[str, Any]:
        artist, title = str(heard.get("artist") or "").strip(), str(heard.get("title") or "").strip()
        if not artist or not title:
            return {"ok": False, "skipped": False, "message": "There's no artist to search for."}
        match = None
        try:
            match = pick_match(search_tracks(f"{artist} {title}", 8) or [], artist, title)
        except Exception as exc:  # noqa: BLE001 - no metadata match still adds by name
            logger.debug("radio metadata lookup failed: %s", exc)
        payload = build_payload(artist, title, str(heard.get("release") or ""), match)
        context = {"source_page": "Radio", "radio_station_id": heard.get("station_id"),
                   "radio_station": heard.get("station_name"), "radio_auto_add": bool(heard.get("auto"))}
        body, _status = add_track(runtime_for(int(profile_id)), track=payload["track"], artist=payload["artist"],
                                  album=payload["album"], source_type="album", source_context=context,
                                  quality_profile_id=None)
        body = body or {}
        return {"ok": bool(body.get("success")), "skipped": bool(body.get("skipped")),
                "message": str(body.get("message") or body.get("error") or "")}

    return add


__all__ = ["make_adder", "build_payload", "pick_match", "synthetic_id"]
