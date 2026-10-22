"""Stream titles (ICY metadata): reading them out of a stream, and reading them.

Icecast and Shoutcast servers send the title of what's playing inside the
audio when the client asks with ``Icy-MetaData: 1``: every ``icy-metaint``
bytes of audio comes one length byte (×16) and that many bytes of
``StreamTitle='…';StreamUrl='…';``. :class:`IcyReader` takes the metadata out
so only audio reaches the browser, and hands each new title on.

:func:`parse_stream_title` turns a title into an artist and a title, or says
why it isn't a track: many stations send the show's name, a jingle, an advert
break or their own name, and guessing an artist from those would fill Wanted
with nonsense. When in doubt it says "not identified".
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Iterable, Iterator, Optional

#: the biggest metadata block the protocol allows (255 × 16)
MAX_META_BYTES = 255 * 16

_TITLE_RE = re.compile(r"StreamTitle='(.*?)';", re.DOTALL)
# separators stations put between artist and title, most common first
_SEPARATORS = (" - ", " – ", " — ", " ~ ", " | ")
# words that mean the title is a programme, a break or the station, not a track
_NOT_A_TRACK = re.compile(
    r"\b(jingle|advert|advertisement|commercial break|sponsored by|station id|promo|news bulletin|"
    r"news update|weather report|traffic report|podcast|live (?:set|session|show) from|in session|"
    r"dj set|dj mix|mixtape|on air now|off air|listener[- ]supported|support (?:us|the station)|"
    r"stream (?:test|offline)|technical difficulties|breakfast show|drive ?time show|morning show)\b",
    re.IGNORECASE)
# "Charlie Bones with Flo", "Moxie presents" read like show titles
_SHOW_SHAPE = re.compile(r"\b(with|presents|w/|b2b|hosted by|show)\b", re.IGNORECASE)
_BRACKETS_ONLY = re.compile(r"^[\s\[\](){}<>*#._-]*$")


@dataclass(frozen=True)
class ParsedTitle:
    """What a stream title says. ``reason`` is set when it isn't a track."""

    artist: str = ""
    title: str = ""
    raw: str = ""
    reason: Optional[str] = None

    @property
    def is_track(self) -> bool:
        return self.reason is None and bool(self.artist) and bool(self.title)


def extract_stream_title(block: bytes) -> Optional[str]:
    """The StreamTitle in one metadata block, or None when there isn't one."""
    if not block:
        return None
    text = block.rstrip(b"\x00").decode("utf-8", errors="replace")
    if "�" in text:
        # many older servers send Latin-1
        text = block.rstrip(b"\x00").decode("latin-1", errors="replace")
    match = _TITLE_RE.search(text)
    if not match:
        return None
    return match.group(1).strip()


def _clean(part: str) -> str:
    part = re.sub(r"\s+", " ", part or "").strip(" \t\"'")
    return part


def parse_stream_title(raw: Optional[str], *, station_name: str = "") -> ParsedTitle:
    """Artist and title from a stream title, or a reason it isn't a track."""
    text = _clean(raw or "")
    if not text or _BRACKETS_ONLY.match(text):
        return ParsedTitle(raw=text, reason="The station isn't sending a track name right now.")
    station = _clean(station_name).lower()
    lowered = text.lower()
    if station and (lowered == station or lowered.startswith(station + " ")
                    or lowered.endswith(" " + station)):
        return ParsedTitle(raw=text, reason="The station is sending its own name, not the track's.")
    sep = next((s for s in _SEPARATORS if s in text), None)
    if sep is None:
        return ParsedTitle(raw=text, reason="This looks like a show or a break, not a track.")
    artist, _, title = text.partition(sep)
    artist, title = _clean(artist), _clean(title)
    # "Artist - Title - Album": the album is dropped
    for s in _SEPARATORS:
        if s in title:
            title = _clean(title.split(s, 1)[0])
    if not artist or not title:
        return ParsedTitle(raw=text, reason="The track name the station sent is incomplete.")
    if station and (artist.lower() == station or title.lower() == station):
        return ParsedTitle(raw=text, reason="The station is sending its own name, not the track's.")
    if _NOT_A_TRACK.search(text) or _SHOW_SHAPE.search(artist) and len(artist.split()) > 3:
        return ParsedTitle(raw=text, reason="This looks like a show or a break, not a track.")
    if artist.lower() in ("unknown", "unknown artist", "various", "various artists", "n/a", "-"):
        return ParsedTitle(raw=text, reason="The station didn't send an artist.")
    if len(artist) > 120 or len(title) > 200:
        return ParsedTitle(raw=text, reason="The track name the station sent is too long to trust.")
    return ParsedTitle(artist=artist, title=title, raw=text)


class IcyReader:
    """Strips ICY metadata out of a stream's bytes.

    Feed it the raw chunks with :meth:`feed`; it returns the audio bytes and
    calls ``on_title`` with each StreamTitle (also repeats, which the caller
    ignores). ``metaint`` is the server's ``icy-metaint`` header; without one
    the stream has no titles and every byte is audio.
    """

    def __init__(self, metaint: Optional[int], on_title: Optional[Callable[[str], None]] = None):
        self.metaint = metaint if metaint and metaint > 0 else None
        self.on_title = on_title
        self._audio_left = self.metaint or 0
        self._meta_len: Optional[int] = None
        self._meta = bytearray()

    def feed(self, chunk: bytes) -> bytes:
        if not self.metaint:
            return chunk
        out = bytearray()
        view = memoryview(chunk)
        i = 0
        n = len(view)
        while i < n:
            if self._audio_left > 0:
                take = min(self._audio_left, n - i)
                out += view[i:i + take]
                i += take
                self._audio_left -= take
                continue
            if self._meta_len is None:
                self._meta_len = view[i] * 16
                i += 1
                self._meta = bytearray()
                if self._meta_len == 0:
                    self._meta_len = None
                    self._audio_left = self.metaint
                continue
            need = self._meta_len - len(self._meta)
            take = min(need, n - i)
            self._meta += view[i:i + take]
            i += take
            if len(self._meta) >= self._meta_len:
                title = extract_stream_title(bytes(self._meta))
                self._meta_len = None
                self._meta = bytearray()
                self._audio_left = self.metaint
                if title is not None and self.on_title is not None:
                    try:
                        self.on_title(title)
                    except Exception:  # noqa: BLE001,S110 - a title callback never breaks the audio
                        pass
        return bytes(out)

    def iter_audio(self, chunks: Iterable[bytes]) -> Iterator[bytes]:
        for chunk in chunks:
            audio = self.feed(chunk)
            if audio:
                yield audio


__all__ = ["ParsedTitle", "IcyReader", "extract_stream_title", "parse_stream_title", "MAX_META_BYTES"]
