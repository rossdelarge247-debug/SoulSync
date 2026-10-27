"""A stretch of one library track as PCM, for the browser's two-deck engine
(auto-mix stage B, ``webui/src/features/engine``).

The engine plays each deck from a decoded buffer so it knows, to the sample,
where in the track it is: that's what lets it put the incoming downbeat on
the outgoing phrase and keep the two beats together. Buffering whole tracks
in the browser would cost 100-200 MB a deck, so it asks for the stretch a
transition needs (a minute or two) instead.

The stretch is decoded by ffmpeg, as the analysis decodes the track, and from
the file's start (``-ss`` as an output option, so ffmpeg decodes and drops
what comes before rather than seeking): the beat grid's seconds and the
window's samples come from the same decoder and the same timeline, whatever
the format (an MP3's encoder delay is handled the same way in both). The
browser's own decoder never has to agree with the grid.

Bounds: a window is at most ``MAX_SECONDS`` long and ends by ``MAX_END``
(longer tracks are never analysed); at most ``MAX_RUNNING`` decode at once
(the next caller is told to wait); each decode has a deadline. 16-bit PCM,
two channels, at 44.1 or 48 kHz (the browser's rate, so it isn't resampled
twice): about 11 MB a minute.
"""

from __future__ import annotations

import math
import os
import struct
import subprocess
import threading
from typing import Optional, Tuple

from utils.logging_config import get_logger

logger = get_logger("dj.window")

#: the longest window: a 32-bar blend at 90 BPM with its run-up and settle
MAX_SECONDS = 180.0
#: windows end by here: tracks over 30 minutes are never analysed or mixed
MAX_END = 33 * 60.0
#: sample rates a window comes at (the browser's)
RATES = (44100, 48000)
#: decodes at once, across the server
MAX_RUNNING = 2
#: a decode's deadline (seconds): a stuck ffmpeg never holds a slot for long
TIMEOUT_S = 60.0
CHANNELS = 2

_slots = threading.BoundedSemaphore(MAX_RUNNING)


class Busy(RuntimeError):
    """Every decode slot is taken."""


class WindowError(RuntimeError):
    """The file couldn't be decoded."""


def parse_args(start_raw: Optional[str], dur_raw: Optional[str], rate_raw: Optional[str]) -> Tuple[float, float, int]:
    """``(start, dur, rate)`` from the query, or ValueError with words.
    Plain decimal numbers only (no nan, inf or exponents)."""

    def number(raw: Optional[str], name: str) -> float:
        text = (raw or "").strip()
        if not text or len(text) > 16 or not all(c in "0123456789." for c in text) or text.count(".") > 1:
            raise ValueError(f"{name} must be a number of seconds")
        value = float(text)
        if not math.isfinite(value):
            raise ValueError(f"{name} must be a number of seconds")
        return value

    start = number(start_raw, "start")
    dur = number(dur_raw, "dur")
    if dur <= 0 or dur > MAX_SECONDS:
        raise ValueError(f"dur must be more than 0 and at most {MAX_SECONDS:g} seconds")
    if start + dur > MAX_END:
        raise ValueError(f"a window must end by {MAX_END:g} seconds")
    rate_text = (rate_raw or "48000").strip()
    if rate_text not in {str(r) for r in RATES}:
        raise ValueError("rate must be 44100 or 48000")
    return start, dur, int(rate_text)


def wav_bytes(pcm: bytes, rate: int, channels: int = CHANNELS) -> bytes:
    """A complete WAV file around 16-bit little-endian PCM (ffmpeg writing a
    WAV to a pipe can't go back to fill in the sizes)."""
    block = channels * 2
    pcm = pcm[: len(pcm) - len(pcm) % block]
    header = struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + len(pcm), b"WAVE", b"fmt ", 16, 1, channels, rate,
                         rate * block, block, 16, b"data", len(pcm))
    return header + pcm


def decode(path: str, start: float, dur: float, rate: int) -> bytes:
    """The window as a WAV file's bytes. Raises Busy when every slot is
    taken, WindowError when ffmpeg can't decode it, FileNotFoundError."""
    from core.sample.analyze import ffmpeg_bin

    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    if not _slots.acquire(blocking=False):
        raise Busy("two windows are being decoded already")
    try:
        try:
            proc = subprocess.run(
                [ffmpeg_bin(), "-nostdin", "-v", "error", "-i", path, "-ss", f"{start:.6f}", "-t", f"{dur:.6f}",
                 "-map", "0:a:0", "-ac", str(CHANNELS), "-ar", str(rate), "-f", "s16le", "-acodec", "pcm_s16le", "-"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=TIMEOUT_S)
        except subprocess.TimeoutExpired as exc:
            raise WindowError("decoding took too long") from exc
        except RuntimeError as exc:  # no ffmpeg
            raise WindowError(str(exc)) from exc
        if proc.returncode != 0:
            logger.info("window decode failed for %s: %s", path, proc.stderr.decode(errors="replace")[:300])
            raise WindowError("ffmpeg couldn't decode the file")
        cap = int(math.ceil(dur * rate)) * CHANNELS * 2
        return wav_bytes(proc.stdout[:cap], rate)
    finally:
        _slots.release()


__all__ = ["CHANNELS", "MAX_END", "MAX_RUNNING", "MAX_SECONDS", "RATES", "Busy", "WindowError", "decode", "parse_args",
           "wav_bytes"]
