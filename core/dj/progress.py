"""Where one track's DJ analysis is: the step it's on and how far that is.

The sweep (core/dj/worker.py) binds a reporter to its own thread while it
works on a track; the analysis code calls ``step()`` at real points in the
work (before the decode, before the tempo, the key, the energy, the tag
write, the beat grid, the phrases), and the job keeps the latest one in its
state for the progress route (core/dj/ondemand.py). Nothing is timed or
guessed: a step is reported when the code reaches it. On any other thread
(Sample Studio's own analysis, a test) ``step()`` does nothing.

The percentages are fixed points per step, in the order the sweep reaches
them. A full analysis decodes once for BPM, key, energy and the grid; a
track whose BPM, key and energy are already known (the grid top-up, or
Sample Studio's analysis reused) only decodes for its grid, so it has its
own, shorter scale.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from typing import Callable, Dict, Iterator, Optional, Tuple

from utils.logging_config import get_logger

logger = get_logger("dj.progress")

#: the steps, in the order a full analysis reaches them
STEPS: Tuple[str, ...] = ("read", "tempo", "key", "energy", "tags", "grid", "phrases")

#: a full analysis: one decode for everything
FULL: Dict[str, int] = {"read": 5, "tempo": 20, "key": 35, "energy": 45, "tags": 50, "grid": 60, "phrases": 85}
#: only the beat grid is due (BPM, key and energy are known)
GRID_ONLY: Dict[str, int] = {"read": 5, "grid": 40, "phrases": 80}

MODES = {"full": FULL, "grid": GRID_ONLY}

_local = threading.local()


def percent(mode: Optional[str], step: Optional[str]) -> Optional[int]:
    """How far a track is at ``step`` (0–100), or None for no step."""
    if not step:
        return None
    scale = MODES.get(mode or "full", FULL)
    if step in scale:
        return scale[step]
    return FULL.get(step)


@contextmanager
def reporting(callback: Callable[[str, str], None]) -> Iterator[None]:
    """Report this thread's steps to ``callback(mode, step)`` while inside."""
    previous = getattr(_local, "callback", None)
    _local.callback = callback
    _local.mode = "full"
    try:
        yield
    finally:
        _local.callback = previous
        _local.mode = "full"


def mode(name: str) -> None:
    """Which scale this track's steps are on: ``full`` or ``grid``."""
    if name in MODES:
        _local.mode = name


def step(name: str) -> None:
    """The analysis reached ``name`` (one of ``STEPS``)."""
    callback = getattr(_local, "callback", None)
    if callback is None or name not in STEPS:
        return
    try:
        callback(getattr(_local, "mode", "full"), name)
    except Exception as exc:  # noqa: BLE001 - progress is a nicety; the analysis goes on
        logger.debug("progress step %s not kept: %s", name, exc)


__all__ = ["FULL", "GRID_ONLY", "MODES", "STEPS", "mode", "percent", "reporting", "step"]
