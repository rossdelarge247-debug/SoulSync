"""A stretch of one library track as PCM, for the browser's two-deck engine
(auto-mix stage B, ``webui/src/features/engine``).

The engine plays each deck from a decoded buffer so it knows, to the sample,
where in the track it is: that's what lets it put the incoming downbeat on
the outgoing phrase and keep the two beats together. Buffering whole tracks
in the browser would cost 100-200 MB a deck, so it asks for the stretch a
transition needs (a minute or two) instead.

The stretch is decoded by ffmpeg, as the analysis decodes the track: a quick
seek to a few seconds before the window, then the rest decoded and dropped,
which puts every sample exactly where a decode from the file's start puts it
(the analysis's timeline, an MP3's encoder delay included) at a cost that
doesn't grow with where the window starts. The browser's own decoder never
has to agree with the grid.

Bounds: a window is at least ``MIN_SECONDS`` and at most ``MAX_SECONDS``
long and ends by ``MAX_END`` (longer tracks are never analysed); at most
``MAX_RUNNING`` decode at once across the server and one a profile (the next
caller is told to wait); ffmpeg runs niced, with a deadline. 16-bit PCM, two
channels, at 44.1 or 48 kHz (the browser's rate, so it isn't resampled
twice): about 11 MB a minute, read straight into the answer's one buffer.
"""

from __future__ import annotations

import math
import os
import re
import struct
import subprocess
import tempfile
import threading
from typing import Dict, Iterator, List, Optional, Tuple

from utils.logging_config import get_logger

logger = get_logger("dj.window")

#: the longest window: a 32-bar blend at 90 BPM with its run-up and settle
MAX_SECONDS = 180.0
#: and the shortest worth asking for
MIN_SECONDS = 0.05
#: windows end by here: tracks over 30 minutes are never analysed or mixed
MAX_END = 33 * 60.0
#: sample rates a window comes at (the browser's)
RATES = (44100, 48000)
#: decodes at once, across the server, and for one profile
MAX_RUNNING = 2
MAX_PER_PROFILE = 1
#: a decode's deadline (seconds). Seeking (below) keeps a decode's cost to
#: the window's length wherever it starts, so one deadline fits every window
TIMEOUT_S = 60.0
#: ffmpeg seeks (quickly) to this long before the window, then decodes and
#: drops the rest: the samples land exactly where a decode from the file's
#: start puts them (tested to the sample on FLAC, MP3 CBR and VBR, AAC,
#: Vorbis and Opus), at a fraction of the cost late in a long file
SEEK_LEAD_S = 5.0
#: ffmpeg runs at this niceness, under the web server
NICE = 10
CHANNELS = 2
HEADER_BYTES = 44
#: a window goes out in pieces this big
CHUNK = 1 << 20

_slots = threading.BoundedSemaphore(MAX_RUNNING)
_owners_lock = threading.Lock()
_owners: Dict[object, int] = {}


class Busy(RuntimeError):
    """Every decode slot is taken, or this profile's own."""


class WindowError(RuntimeError):
    """The file couldn't be decoded."""


_NUMBER = re.compile(r"[0-9]*\.?[0-9]*")


def parse_args(start_raw: Optional[str], dur_raw: Optional[str], rate_raw: Optional[str]) -> Tuple[float, float, int]:
    """``(start, dur, rate)`` from the query, or ValueError with words.
    Plain decimal numbers only: ASCII digits, at least one, and one dot at
    most (no signs, exponents, spaces, nan or inf)."""

    def number(raw: Optional[str], name: str) -> float:
        text = raw or ""
        if (not text or len(text) > 16 or not _NUMBER.fullmatch(text)
                or not any(c in "0123456789" for c in text)):
            raise ValueError(f"{name} must be a number of seconds")
        value = float(text)
        if not math.isfinite(value):
            raise ValueError(f"{name} must be a number of seconds")
        return value

    start = number(start_raw, "start")
    dur = number(dur_raw, "dur")
    if dur < MIN_SECONDS or dur > MAX_SECONDS:
        raise ValueError(f"dur must be at least {MIN_SECONDS:g} and at most {MAX_SECONDS:g} seconds")
    if start + dur > MAX_END:
        raise ValueError(f"a window must end by {MAX_END:g} seconds")
    rate_text = rate_raw or "48000"
    if rate_text not in {str(r) for r in RATES}:
        raise ValueError("rate must be 44100 or 48000")
    return start, dur, int(rate_text)


def wav_header(data_bytes: int, rate: int, channels: int = CHANNELS) -> bytes:
    """A WAV header for 16-bit little-endian PCM of that many bytes."""
    block = channels * 2
    return struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + data_bytes, b"WAVE", b"fmt ", 16, 1, channels, rate,
                       rate * block, block, 16, b"data", data_bytes)


def wav_bytes(pcm: bytes, rate: int, channels: int = CHANNELS) -> bytes:
    """A complete WAV file around 16-bit PCM (tests and small answers)."""
    block = channels * 2
    pcm = pcm[: len(pcm) - len(pcm) % block]
    return wav_header(len(pcm), rate, channels) + pcm


def chunks(data, size: int = CHUNK) -> Iterator[bytes]:
    """The window in pieces, so the response never holds a second copy."""
    view = memoryview(data)
    for at in range(0, len(view), size):
        yield bytes(view[at:at + size])


def _take(owner: object) -> None:
    """A place for this profile, then one of the server's: a request that
    can't have its own never holds a server-wide slot, even for a moment."""
    with _owners_lock:
        if owner is not None:
            if _owners.get(owner, 0) >= MAX_PER_PROFILE:
                raise Busy("a window of yours is being decoded already")
            _owners[owner] = _owners.get(owner, 0) + 1
    if not _slots.acquire(blocking=False):
        _drop(owner)
        raise Busy("two windows are being decoded already")


def _drop(owner: object) -> None:
    with _owners_lock:
        if owner is not None:
            left = _owners.get(owner, 0) - 1
            if left > 0:
                _owners[owner] = left
            else:
                _owners.pop(owner, None)


def _give(owner: object) -> None:
    _drop(owner)
    _slots.release()


def command(ffmpeg: str, path: str, start: float, dur: float, rate: int) -> List[str]:
    """ffmpeg's arguments: a quick seek to SEEK_LEAD_S before the window,
    then the rest decoded and dropped, so the timeline is exact. The file
    goes in as ``file:`` and its absolute path, so no name reads as one of
    ffmpeg's protocols."""
    lead = min(start, SEEK_LEAD_S)
    seek = start - lead
    # no input seek at all for a window in the first seconds: even a seek to
    # 0 makes ffmpeg drop an AAC file's priming frame, which a decode from
    # the start keeps (gauntlet re-review N3)
    quick = ["-ss", f"{seek:.6f}"] if seek > 0 else []
    return [ffmpeg, "-nostdin", "-v", "error", *quick, "-i", "file:" + os.path.abspath(path),
            "-ss", f"{lead:.6f}", "-t", f"{dur:.6f}", "-map", "0:a:0", "-ac", str(CHANNELS), "-ar", str(rate),
            "-f", "s16le", "-acodec", "pcm_s16le", "-"]


def decode(path: str, start: float, dur: float, rate: int, *, owner: object = None) -> bytearray:
    """The window as a WAV file, in one buffer (the header, then the PCM
    read straight into it). Raises Busy when every slot is taken or
    ``owner`` (a profile) already has one, WindowError when ffmpeg can't
    decode it, FileNotFoundError."""
    from core.sample.analyze import ffmpeg_bin

    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    _take(owner)
    try:
        try:
            args = command(ffmpeg_bin(), path, start, dur, rate)
        except RuntimeError as exc:  # no ffmpeg
            raise WindowError(str(exc)) from exc
        block = CHANNELS * 2
        cap = int(math.ceil(dur * rate)) * block
        out = bytearray(HEADER_BYTES + cap)
        # ffmpeg's complaints go to a file, not a pipe nobody reads while it
        # runs: a damaged file can print far more than a pipe holds, and
        # ffmpeg would stop until the deadline (gauntlet re-review N1)
        errors = tempfile.TemporaryFile()
        try:
            # an argument list, no shell: ffmpeg's own path, a library file's
            # path from the database (never from the request) and numbers
            # parse_args has already checked
            proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errors)  # nosemgrep: dangerous-subprocess-use-audit
        except OSError as exc:  # ffmpeg vanished or can't run
            errors.close()
            raise WindowError(f"ffmpeg couldn't start: {exc}") from exc
        try:
            os.setpriority(os.PRIO_PROCESS, proc.pid, NICE)
        except (AttributeError, OSError) as exc:  # not on this system, or it's gone already
            logger.debug("couldn't lower ffmpeg's priority: %s", exc)
        late = threading.Event()

        def deadline() -> None:
            late.set()
            proc.kill()

        timer = threading.Timer(TIMEOUT_S, deadline)
        timer.daemon = True
        timer.start()
        try:
            view = memoryview(out)
            got = HEADER_BYTES
            assert proc.stdout is not None
            while got < len(out):
                n = proc.stdout.readinto(view[got:])
                if not n:
                    break
                got += n
            view.release()  # the buffer can be trimmed once nothing points into it
            proc.stdout.read()  # anything past the window (a frame's rounding)
            code = proc.wait()
            errors.seek(0)
            err = errors.read(300)
        finally:
            timer.cancel()
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            if proc.stdout is not None:
                proc.stdout.close()
            errors.close()
        if late.is_set():
            raise WindowError("decoding took too long")
        if code != 0:
            logger.info("window decode failed for %s: %s", path, err.decode(errors="replace")[:300])
            raise WindowError("ffmpeg couldn't decode the file")
        data = got - HEADER_BYTES
        data -= data % block
        del out[HEADER_BYTES + data:]
        out[:HEADER_BYTES] = wav_header(data, rate)
        return out
    finally:
        _give(owner)


__all__ = ["CHANNELS", "MAX_END", "MAX_PER_PROFILE", "MAX_RUNNING", "MAX_SECONDS", "MIN_SECONDS", "RATES",
           "SEEK_LEAD_S", "Busy", "WindowError", "chunks", "command", "decode", "parse_args", "wav_bytes",
           "wav_header"]
