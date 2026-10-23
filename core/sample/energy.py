"""Energy, 1–10: how loud and how busy a track is.

Two measures from the analysis Sample Studio already does, nothing new decoded:

* **Loudness:** the RMS level of the track's loudest half, in dBFS. Taking
  the louder frames ignores intros, breakdowns and silence, so a club track
  with a long quiet intro still reads as loud. -30 dBFS or quieter counts as
  0, -8 dBFS or louder as 1, linear in between (mastered dance music sits
  around -9 to -6 dBFS RMS, quiet acoustic recordings around -20 to -25).
* **Density:** onsets a second, from the same onset envelope the BPM comes
  from. 0 counts as 0, 8 or more a second as 1, linear in between.

``energy = 1 + round(9 * (0.6 * loudness + 0.4 * density))``, so 1 is quiet
and sparse, 10 loud and busy. Loudness leads because it's what a crowd hears;
density separates a loud ballad from a loud techno track. Like Mixed In Key's
energy level it is relative, for sorting and picking the next track, not a
measurement in any standard unit.
"""

from __future__ import annotations

from typing import Optional

LOUD_FLOOR_DB = -30.0
LOUD_CEILING_DB = -8.0
DENSITY_CEILING = 8.0  # onsets a second
LOUDNESS_WEIGHT = 0.6


def _unit(value: float, low: float, high: float) -> float:
    return max(0.0, min(1.0, (value - low) / (high - low)))


def energy_score(loud_db: float, onsets_per_s: float) -> int:
    """1–10 from the two measures above."""
    loud = _unit(float(loud_db), LOUD_FLOOR_DB, LOUD_CEILING_DB)
    dense = _unit(float(onsets_per_s), 0.0, DENSITY_CEILING)
    return int(1 + round(9 * (LOUDNESS_WEIGHT * loud + (1 - LOUDNESS_WEIGHT) * dense)))


def loudness_db(y) -> Optional[float]:
    """RMS level of the loudest half of the frames, in dBFS. None for silence."""
    import numpy as np

    y = np.asarray(y, dtype=np.float32)
    frame = 2048
    if y.size < frame:
        return None
    usable = y[: (y.size // frame) * frame].reshape(-1, frame)
    rms = np.sqrt(np.mean(usable.astype(np.float64) ** 2, axis=1))
    rms = rms[rms > 1e-6]
    if rms.size == 0:
        return None
    loud = np.sort(rms)[rms.size // 2:]
    return float(20 * np.log10(np.sqrt(np.mean(loud ** 2))))


def detect_energy(y, sr: int, onset_count: int) -> Optional[int]:
    """Energy of a mono signal given how many onsets it has. Never raises."""
    try:
        duration = len(y) / float(sr)
        if duration < 1.0:
            return None
        loud = loudness_db(y)
        if loud is None:
            return None
        return energy_score(loud, onset_count / duration)
    except Exception:
        return None


__all__ = ["detect_energy", "energy_score", "loudness_db"]
