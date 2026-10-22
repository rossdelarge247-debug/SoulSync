"""Passing a station's audio on to the browser, and checking a stream link.

The relay fetches only what a listening session already resolved on the
server (a built-in station, a directory station looked up by its uuid, or an
admin's link), through the outbound guard: public addresses only, checked
after DNS and on every redirect, at most three redirects. It passes on audio
and nothing else (:func:`audio_type`), with none of the station's headers or
cookies, and ``X-Content-Type-Options: nosniff``.

While it relays it reads the stream's titles (ICY metadata, stripped from what
the browser gets) and, when the hub asks, keeps a few seconds of audio for a
fingerprint. It stops when the listener goes, when the session is stopped,
when the station sends nothing for :data:`IDLE_SECONDS`, or after
:data:`MAX_SECONDS` in all.
"""

from __future__ import annotations

import time
from typing import Dict, Iterator, Optional, Tuple

from core.internet_radio.hub import STREAM_HEAD_BYTES, RadioHub, Session
from core.internet_radio.icy import IcyReader
from core.internet_radio.net import USER_AGENT
from core.security.outbound import OutboundBlocked, guarded_request
from utils.logging_config import get_logger

logger = get_logger("internet_radio.relay")

CONNECT_TIMEOUT = 6
IDLE_SECONDS = 20          # read timeout: a station silent this long has gone
MAX_SECONDS = 6 * 3600     # a relay never runs longer than this
CHUNK = 16 * 1024
CLIP_SECONDS = 12
CLIP_MIN_BYTES = 96 * 1024
CLIP_MAX_BYTES = 2 * 1024 * 1024
CHECK_SECONDS = 4           # how long a link check listens for

# audio types that aren't audio: playlists the directory should have resolved
_PLAYLIST_TYPES = {"audio/x-mpegurl", "audio/mpegurl", "audio/x-scpls", "audio/scpls", "audio/x-ms-asx",
                   "audio/x-ms-wax", "audio/x-pn-realaudio-plugin"}
_EXTRA_AUDIO = {"application/ogg", "application/x-ogg"}

RESPONSE_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
}


def audio_type(content_type: Optional[str]) -> Optional[str]:
    """The media type to pass on, or None when it isn't an audio stream.

    ``audio/*`` (but not playlists) and Ogg. HTML, SVG, JSON, text, images,
    video and anything unlabelled are refused.
    """
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    if not mime or mime in _PLAYLIST_TYPES:
        return None
    if mime in _EXTRA_AUDIO:
        return "application/ogg"
    if mime.startswith("audio/") and all(c.isalnum() or c in "-+._/" for c in mime):
        return mime
    return None


def _metaint(headers) -> Optional[int]:
    try:
        value = int(str(headers.get("icy-metaint") or "").strip())
    except ValueError:
        return None
    return value if 0 < value <= 1024 * 1024 else None


def open_stream(url: str, *, want_titles: bool = True, read_timeout: float = IDLE_SECONDS):
    """``(response, audio_type)`` for a stream address, or raises
    :class:`StreamError` with a sentence to show."""
    headers = {"User-Agent": USER_AGENT, "Accept": "audio/*, application/ogg;q=0.9", "Icy-MetaData": "1" if want_titles else "0"}
    try:
        resp, _final = guarded_request("GET", url, headers=headers, timeout=(CONNECT_TIMEOUT, read_timeout), stream=True)
    except OutboundBlocked as exc:
        raise StreamError(str(exc)) from None
    except Exception as exc:  # noqa: BLE001 - every network failure reads the same
        raise StreamError("The stream didn't answer.") from exc
    if resp.status_code != 200:
        resp.close()
        raise StreamError(f"The stream answered {resp.status_code}.")
    kind = audio_type(resp.headers.get("content-type"))
    if kind is None:
        ctype = (resp.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
        resp.close()
        if "html" in ctype:
            raise StreamError("This link isn't an audio stream. The address answered with a web page.")
        if ctype in _PLAYLIST_TYPES:
            raise StreamError("This link is a playlist, not a stream. Use the stream address inside it.")
        raise StreamError("This link isn't an audio stream.")
    return resp, kind


class StreamError(Exception):
    """A stream couldn't be opened or isn't audio; ``str()`` is safe to show."""


def relay_chunks(hub: RadioHub, session: Session, resp, kind: str, *, clock=time.monotonic) -> Iterator[bytes]:
    """The audio, without titles, until the listener or the station goes.

    Always closes the upstream response and hands the slot back.
    """
    station_id = session.station_id
    started = clock()
    reader = IcyReader(_metaint(resp.headers), on_title=lambda t: hub.on_stream_title(station_id, t))
    if reader.metaint is None:
        hub.stream_has_no_titles(station_id)
    clip: Optional[bytearray] = None
    clip_target = 0
    next_clip_check = started + 5
    head = bytearray()
    session.audio_kind = kind
    try:
        for raw in resp.iter_content(chunk_size=CHUNK):
            if session.stop.is_set() or clock() - started > MAX_SECONDS:
                break
            if not raw:
                continue
            audio = reader.feed(raw)
            if not audio:
                continue
            if len(head) < STREAM_HEAD_BYTES:
                head += audio[: STREAM_HEAD_BYTES - len(head)]
                session.head = bytes(head)
            hub.feed_taps(station_id, audio)  # Scan now's capture: a copy, nothing more
            if clip is not None:
                clip += audio
                if len(clip) >= clip_target:
                    hub.submit_clip(station_id, bytes(clip[:CLIP_MAX_BYTES]), kind)
                    clip = None
            elif clock() >= next_clip_check:
                next_clip_check = clock() + 5
                if hub.wants_clip(station_id):
                    kbps = session.stream.bitrate_kbps or 128
                    clip_target = min(CLIP_MAX_BYTES, max(CLIP_MIN_BYTES, kbps * 1000 // 8 * CLIP_SECONDS))
                    clip = bytearray()
            yield audio
    except Exception as exc:  # noqa: BLE001 - the station dropped; the listener's player says so
        logger.info("relay for %s ended: %s", station_id, exc)
    finally:
        if clip is not None:
            hub.clip_failed(station_id)
        try:
            resp.close()
        except Exception:  # noqa: BLE001,S110 - closing is best effort
            pass
        hub.relay_closed(session.id)


def check_link(url: str, *, clock=time.monotonic) -> Dict[str, object]:
    """Listen to a stream link for a few seconds from this server.

    ``{ok, codec, bitrate_kbps, sends_titles, allows_direct, answered_in_s, error}``.
    """
    started = clock()
    try:
        resp, kind = open_stream(url, read_timeout=8)
    except StreamError as exc:
        return {"ok": False, "error": str(exc), "codec": "", "bitrate_kbps": 0, "sends_titles": False,
                "allows_direct": False, "answered_in_s": None}
    answered = round(clock() - started, 1)
    try:
        headers = resp.headers
        codec = {"audio/mpeg": "MP3", "audio/mp3": "MP3", "audio/aac": "AAC", "audio/aacp": "AAC",
                 "audio/x-aac": "AAC", "audio/mp4": "AAC", "audio/ogg": "OGG", "application/ogg": "OGG",
                 "audio/opus": "OPUS", "audio/flac": "FLAC", "audio/x-flac": "FLAC"}.get(kind, kind.split("/")[-1].upper())
        try:
            bitrate = int(str(headers.get("icy-br") or "0").split(",")[0])
        except ValueError:
            bitrate = 0
        titles: list = []
        reader = IcyReader(_metaint(headers), on_title=titles.append)
        got = 0
        for raw in resp.iter_content(chunk_size=CHUNK):
            got += len(reader.feed(raw or b""))
            if titles or clock() - started > CHECK_SECONDS or got > 512 * 1024:
                break
        if got == 0:
            return {"ok": False, "error": "The stream answered but sent no audio.", "codec": codec,
                    "bitrate_kbps": bitrate, "sends_titles": False, "allows_direct": False, "answered_in_s": answered}
        allows_direct = url.lower().startswith("https://") and \
            (headers.get("access-control-allow-origin") or "").strip() == "*"
        return {"ok": True, "error": None, "codec": codec, "bitrate_kbps": bitrate,
                "sends_titles": bool(reader.metaint), "allows_direct": allows_direct, "answered_in_s": answered}
    finally:
        resp.close()


__all__ = ["audio_type", "open_stream", "relay_chunks", "check_link", "StreamError", "RESPONSE_HEADERS",
           "IDLE_SECONDS", "MAX_SECONDS"]
