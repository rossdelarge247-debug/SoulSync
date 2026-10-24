"""Musical keys in Camelot notation, and which keys and tempos mix well.

The canonical form kept with a track is two values: the Camelot code
(``"8A"``) and the short musical name the TKEY / INITIALKEY tags use
(``"Am"``). Readers accept what analysis, Beatport and other DJ software
write: "A minor", "Am", "A min", "8A", "08A", Open Key ("1m", "1d", the
notation Traktor can display), and sharps or flats ("G#m" or "Abm").

The wheel: number 1–12, A = minor, B = major. Neighbours on the wheel (same
letter, number ±1) and the relative major/minor (same number, other letter)
mix harmonically with a key, as does the key itself.
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple

# pitch class -> the spelling the tags use (Sample Studio's NOTE_NAMES)
NOTE_NAMES = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")
_LONG_NOTE = {"C#": "C♯", "Eb": "E♭", "F#": "F♯", "Ab": "A♭", "Bb": "B♭"}

_PITCH = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

_CAMELOT_RE = re.compile(r"^\s*0?([1-9]|1[0-2])\s*([AaBb])\s*$")
_OPENKEY_RE = re.compile(r"^\s*0?([1-9]|1[0-2])\s*([mMdD])\s*$")
_MUSICAL_RE = re.compile(
    r"^\s*([A-Ga-g])\s*([#♯b♭]?)\s*((?i:major|minor|maj|min)|m|M|-)?\s*$")


def camelot_number(pitch: int, minor: bool) -> int:
    """1–12 for a root pitch class (C = 0). A minor key shares its number
    with its relative major, three semitones up."""
    major_root = (pitch + 3) % 12 if minor else pitch % 12
    return (7 * major_root + 7) % 12 + 1


def _from_camelot(number: int, letter: str) -> Tuple[int, bool]:
    minor = letter.upper() == "A"
    major_root = (7 * (number - 8)) % 12  # 7 is its own inverse mod 12
    return ((major_root - 3) % 12 if minor else major_root), minor


def short_name(pitch: int, minor: bool) -> str:
    return f"{NOTE_NAMES[pitch % 12]}{'m' if minor else ''}"


def long_name(pitch: int, minor: bool) -> str:
    """'A minor', 'F♯ major': the musical name shown as the key's title."""
    note = NOTE_NAMES[pitch % 12]
    return f"{_LONG_NOTE.get(note, note)} {'minor' if minor else 'major'}"


def parse_key(value) -> Optional[Dict[str, object]]:
    """``{"camelot": "8A", "name": "Am", "long": "A minor", "pitch": 9,
    "minor": True}`` from any key spelling, or None when it isn't one."""
    if value is None:
        return None
    text = str(value).strip()
    if not text or len(text) > 16:
        return None
    m = _CAMELOT_RE.match(text)
    if m:
        pitch, minor = _from_camelot(int(m.group(1)), m.group(2))
        return _key(pitch, minor)
    m = _OPENKEY_RE.match(text)
    if m:
        # Open Key: 1d = C major = Camelot 8B, so the number shifts by seven
        number = (int(m.group(1)) + 6) % 12 + 1
        pitch, minor = _from_camelot(number, "A" if m.group(2).lower() == "m" else "B")
        return _key(pitch, minor)
    m = _MUSICAL_RE.match(text)
    if not m:
        return None
    pitch = _PITCH[m.group(1).upper()]
    accidental = m.group(2)
    if accidental in ("#", "♯"):
        pitch += 1
    elif accidental in ("b", "♭"):
        pitch -= 1
    mode = m.group(3) or ""
    # "m", "min", "minor" and "-" (some taggers) are minor; a capital "M" or
    # "maj"/"major" is major, as is a bare note
    minor = mode in ("m", "-") or mode.lower() in ("min", "minor")
    return _key(pitch % 12, minor)


def _key(pitch: int, minor: bool) -> Dict[str, object]:
    number = camelot_number(pitch, minor)
    return {"camelot": f"{number}{'A' if minor else 'B'}", "name": short_name(pitch, minor),
            "long": long_name(pitch, minor), "pitch": pitch, "minor": minor}


def camelot_parts(code: str) -> Optional[Tuple[int, str]]:
    m = _CAMELOT_RE.match(str(code or ""))
    return (int(m.group(1)), m.group(2).upper()) if m else None


def compatible_keys(code: str) -> Dict[str, str]:
    """The Camelot codes that mix with ``code``, each with how:
    ``same``, ``up`` (+1), ``down`` (−1) or ``relative`` (major/minor swap)."""
    parts = camelot_parts(code)
    if not parts:
        return {}
    number, letter = parts
    up = number % 12 + 1
    down = (number - 2) % 12 + 1
    other = "B" if letter == "A" else "A"
    return {f"{number}{letter}": "same", f"{up}{letter}": "up", f"{down}{letter}": "down",
            f"{number}{other}": "relative"}


# ── tempo ─────────────────────────────────────────────────────────────────────

#: a match is within this fraction of the track's tempo (DJ pitch faders go ±6–8%)
BPM_TOLERANCE = 0.06


def bpm_relation(bpm: float, other: float, tolerance: float = BPM_TOLERANCE) -> Optional[Tuple[str, float]]:
    """How ``other`` sits against ``bpm``: ``("same" | "half" | "double", diff)``
    where diff is the signed fraction after halving or doubling, or None when
    it's out of range. "half" means the other track runs at half the tempo
    (it plays as double-time against this one)."""
    try:
        a, b = float(bpm), float(other)
    except (TypeError, ValueError):
        return None
    if a <= 0 or b <= 0:
        return None
    best: Optional[Tuple[str, float]] = None
    for relation, factor in (("same", 1.0), ("half", 2.0), ("double", 0.5)):
        diff = (b * factor - a) / a
        if abs(diff) <= tolerance + 1e-9 and (best is None or abs(diff) < abs(best[1])):
            best = (relation, diff)
    return best


def bpm_windows(bpm: float, tolerance: float = BPM_TOLERANCE) -> List[Tuple[float, float]]:
    """The BPM ranges a match can sit in (same, half and double), for SQL."""
    a = float(bpm)
    return [(a * (1 - tolerance), a * (1 + tolerance)),
            (a / 2 * (1 - tolerance), a / 2 * (1 + tolerance)),
            (a * 2 * (1 - tolerance), a * 2 * (1 + tolerance))]


def fold_bpm(bpm) -> Optional[float]:
    """An analysed tempo into the range DJ software uses: halved above 200,
    doubled under 60 (beat trackers lock onto half or double the beat). None
    for no tempo."""
    try:
        value = float(bpm)
    except (TypeError, ValueError):
        return None
    if value <= 0:
        return None
    while value > 200:
        value /= 2
    while value < 60:
        value *= 2
    return round(value, 1)


__all__ = ["BPM_TOLERANCE", "NOTE_NAMES", "bpm_relation", "bpm_windows", "camelot_number", "camelot_parts",
           "compatible_keys", "fold_bpm", "long_name", "parse_key", "short_name"]
