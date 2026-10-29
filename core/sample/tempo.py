"""Which octave a tempo is in: 87 or 174, 70 or 140.

A beat tracker hears a tempo up to halving or doubling, and leans towards
the middle of the dance range: librosa's ``beat_track`` and the beat grid's
own scan (core/dj/grid.py) both favour about 120 BPM, so drum and bass at
174 comes out at 87 (half time) about as often as not. This module decides
the octave from evidence instead of that fixed lean. It's used by the
analysis (core/sample/analyze.py ``analyze_track``, which gives Sample
Studio and the DJ data their BPM) and by the beat grid.

The rule, in order:

1. **Only an ambiguous reading is looked at:** a slow reading in
   ``SLOW_BAND`` (70–100), whose double (140–200) is as plausible, or a fast
   one (140–200). Anything in 100–140 is never changed: neither its half nor
   its double is a dance tempo. (So a track analysed at 100–140 needs no new
   analysis when this rule changes: database/music_database.py promotes
   those rows without decoding them again.)
2. **A fast reading is kept** unless the genre says the track is slow (hip
   hop read at 180 is 90). A tracker that leans towards 120 and still says
   174 has heard the fast pulse; the known failure is the other way round.
3. **A slow reading is doubled when:**

   * the genre (the file's tag) is one that sits at 160–190 (drum and
     bass, jungle, neurofunk, liquid, breakcore, footwork, juke …), or one
     read at 140 rather than 70 (dubstep, trap, grime, drill) when its
     double lands at 125–160; a slow genre (hip hop, R&B, reggae …) keeps
     it slow;
   * it's under ``PREFER_MIN`` (78): like DJ software's BPM range, a 70 is
     read as 140 (dubstep's half time). Not for the beat grid's hint, which
     has already been through this rule (or is a tag);
   * **the backbeat is at the fast tempo** (``backbeat``): the snare (or
     clap) falls on every other beat of the fast tempo (two and four of a
     174 bar) rather than every other beat of the slow one (two and four of
     an 87 bar). This is what tells drum and bass from hip hop: at 87, a
     drum and bass snare falls on *every* beat; at 180, a hip-hop snare
     falls on every fourth.

Measured on the generated fixtures (tests/dj/test_tempo_octave.py), at 30
seconds and repeated to 10 minutes, the fast backbeat leads the slow one by
2.76–13.3 times for drum and bass, and by at most 0.79 for everything else:
hip hop 0.47–0.51, a 100 BPM track 0.64–0.65, a kick on every beat under
off-beat hats 0.67–0.79. ``BACKBEAT_LEAD`` (1.5) sits between.

Cost: the analysis passes the mel spectrogram it makes for its onset
envelope (``snare_envelope(mel=...)``), so the check adds about 0.05 s of
CPU for 10 minutes of audio (its own spectrum was about 0.8 s).

What doesn't decide it, and why: how many hats there are (hip hop's
sixteenths at 90 are drum and bass's eighths at 180), the high band at all
(off-beat hats over a kick on every beat look like a backbeat at double the
tempo, so the snare is read in the mids only), and how well the onsets line
up on a tempo (at twice the tempo there are twice the grid lines, so more
onsets fit whatever the music).

Left as it is: half-time drum and bass (the snare on three of a 174 bar)
read at 87 without a genre tag stays at 87, as its backbeat really is
there; a tag or analysis that says 174 is never halved. The person's ×2
fixes it for good (core/dj/store.py ``set_tempo``).
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, Optional, Sequence, Tuple

#: a slow reading in this band has a plausible double; its double is the
#: fast band, [140, 200)
SLOW_BAND = (70.0, 100.0)
FAST_BAND = (140.0, 200.0)
#: a slow reading under this is read at double (DJ software's range)
PREFER_MIN = 78.0
#: the backbeat must lead by this much (a ratio), and be at least this big
#: (a share of the loudest beat position), to double a reading
BACKBEAT_LEAD = 1.5
BACKBEAT_MIN = 0.45
#: the beats the backbeat is measured over (a few bars at least)
MIN_BEATS = 32
#: how far from a beat an onset still counts as on it (seconds)
RADIUS_S = 0.035

#: genres by where their tempo sits (matched as whole words, any case;
#: "&", "'n'" and "n" between words read as "and")
FAST_GENRES = ("drum and bass", "drumandbass", "drumnbass", "dnb", "d and b", "jungle", "neurofunk",
               "liquid funk", "liquid dnb", "liquid drum and bass", "liquid", "breakcore", "footwork", "juke",
               "jump up", "darkstep", "techstep", "drumstep", "halftime", "happy hardcore", "ragga jungle")
HALF_GENRES = ("dubstep", "brostep", "riddim", "trap", "grime", "drill", "uk drill")
SLOW_GENRES = ("hip hop", "hiphop", "rap", "boom bap", "r and b", "rnb", "trip hop", "downtempo", "lo fi", "lofi",
               "reggae", "dub", "soul", "neo soul", "chillhop", "g funk", "chillout", "chill out", "lounge",
               "ambient", "dancehall", "downbeat", "reggaeton")

_FAMILIES = (("fast", FAST_GENRES), ("half", HALF_GENRES), ("slow", SLOW_GENRES))


def _normal(text: str) -> str:
    text = str(text).lower()
    # punctuation first, so "drum-n-bass" and "Drum_n_Bass" read as words
    text = re.sub(r"[-_/.,;:+()\[\]]", " ", text)
    text = re.sub(r"\s*&\s*|\s+'?n'?\s+|'n'", " and ", text)
    return " " + re.sub(r"\s+", " ", text).strip() + " "


def genre_family(genres: Optional[Iterable[Any]]) -> Optional[str]:
    """``fast`` (drum and bass and its cousins), ``half`` (dubstep, trap:
    140 read in half time), ``slow`` (hip hop and its cousins) or None. A
    list naming more than one family says nothing."""
    if not genres:
        return None
    if isinstance(genres, str):
        genres = [genres]
    # "Drum And Bass, Dance, Jazz" is three genres: each is read on its own
    genres = [part for genre in genres if genre is not None for part in re.split(r"[,;|]", str(genre))]
    found = set()
    for genre in genres:
        if not genre.strip():
            continue
        text = _normal(genre)
        for family, words in _FAMILIES:
            if any(f" {w} " in text for w in words):
                found.add(family)
                break  # the first family a genre names (drum and bass before dub)
    return found.pop() if len(found) == 1 else None


def _fold(bpm) -> Optional[float]:
    """Into the range DJ software uses, as the DJ data keeps it
    (core/dj/camelot.py ``fold_bpm``): halved above 200, doubled under 60."""
    try:
        value = float(bpm)
    except (TypeError, ValueError):
        return None
    if not value > 0 or value == float("inf"):
        return None
    while value > 200:
        value /= 2
    while value < 60:
        value *= 2
    return round(value, 1)


def is_slow(bpm: float) -> bool:
    return SLOW_BAND[0] <= bpm < SLOW_BAND[1]


def is_fast(bpm: float) -> bool:
    return FAST_BAND[0] <= bpm < FAST_BAND[1]


def ambiguous(bpm: Optional[float]) -> bool:
    """A reading this rule can change (the re-analysis redoes only these)."""
    try:
        value = float(bpm)
    except (TypeError, ValueError):
        return False
    return is_slow(value) or is_fast(value)


def _profile(env, fps: float, times, radius_s: float = RADIUS_S):
    """The envelope's peak within ±radius of each time."""
    import numpy as np

    env = np.asarray(env, dtype=np.float64)
    r = max(1, int(round(radius_s * fps)))
    centre = np.round(np.asarray(times, dtype=np.float64) * fps).astype(int)
    idx = np.clip(centre[:, None] + np.arange(-r, r + 1)[None, :], 0, len(env) - 1)
    return env[idx].max(axis=1)


#: the backbeat is measured over windows of this many fast beats (four
#: cycles), a window at a time: a tracker that skips a beat, a pickup or an
#: odd bar swaps the positions, so one fold over the whole track would wash
#: out the slow backbeat and leave the fast one
WINDOW_BEATS = 16


def backbeat(snare_env, fps: float, fast_beats: Sequence[float]) -> Dict[str, Any]:
    """Where the backbeat is, given the beats at the *fast* reading and an
    onset envelope of the snare's band (the mids, 160–2500 Hz: a snare's
    body, a clap; not the hats above them).

    Each fast beat's snare level is folded onto four positions (the beats
    of a fast bar, or two of a slow one), sixteen beats at a time. A
    backbeat at the fast tempo alternates every beat (1 and 3 against 2 and
    4); one at the slow tempo alternates every other beat (position 0
    against 2, or 1 against 3). Each window scores both (as a share of its
    loudest position), and the medians over the track decide. Measured on
    the beats or, in case the grid sits on the off-beats, half a beat later,
    whichever the snares are louder on.

    ``{"vote": "fast" | "slow" | None, "fast": score, "slow": score}``."""
    import numpy as np

    beats = np.asarray(fast_beats, dtype=np.float64)
    beats = beats[beats >= 0]
    nothing = {"vote": None, "fast": 0.0, "slow": 0.0}
    if beats.size < MIN_BEATS or snare_env is None or len(snare_env) < 16:
        return nothing
    period = float(np.median(np.diff(beats)))
    radius = min(RADIUS_S, 0.12 * period)
    levels = None
    for offset in (0.0, 0.5):
        found = _profile(snare_env, fps, beats + offset * period, radius)
        if levels is None or np.percentile(found, 90) > np.percentile(levels, 90):
            levels = found
    fasts, slows = [], []
    for start in range(0, levels.size - WINDOW_BEATS + 1, WINDOW_BEATS // 2):
        m = levels[start:start + WINDOW_BEATS].reshape(-1, 4).mean(axis=0)
        scale = float(m.max())
        if not scale > 0:
            continue
        m = m / scale
        fasts.append(abs((m[0] + m[2]) - (m[1] + m[3])) / 2.0)
        slows.append(max(abs(m[0] - m[2]), abs(m[1] - m[3])))
    if not fasts:
        return nothing
    fast, slow = float(np.median(fasts)), float(np.median(slows))
    vote = None
    if fast >= BACKBEAT_MIN and fast >= BACKBEAT_LEAD * slow:
        vote = "fast"
    elif slow >= BACKBEAT_MIN and slow >= BACKBEAT_LEAD * fast:
        vote = "slow"
    return {"vote": vote, "fast": round(fast, 3), "slow": round(slow, 3)}


def choose(bpm: float, *, evidence: Optional[Dict[str, Any]] = None, genres: Optional[Iterable[Any]] = None,
           use_range: bool = True) -> Tuple[float, str]:
    """The tempo in its octave and why: ``(bpm, reason)``, the reason one of
    ``unambiguous``, ``kept``, ``genre``, ``range`` or ``backbeat``.
    ``evidence`` is ``backbeat``'s answer (or None); ``use_range`` False for
    a reading that has already been through this rule (the grid's hint).

    Only ``genre`` and ``backbeat`` on a fast result are evidence that the
    track is fast (``EVIDENCE``); ``kept`` (the tracker said so) and
    ``range`` (under 78) aren't, so a tag at half such a reading stands
    (core/dj/store.py ``decide``)."""
    value = float(bpm)
    family = genre_family(genres)
    if is_fast(value):
        fast_vote = bool(evidence) and evidence.get("vote") == "fast"
        if family == "slow" and is_slow(value / 2):
            # a slow genre halves it, unless the backbeat says it's fast
            # (soul or reggae at 150 with a snare on two and four)
            return (value, "backbeat") if fast_vote else (value / 2, "genre")
        if family == "fast" or (family == "half" and 125.0 <= value < 160.0):
            return value, "genre"
        return (value, "backbeat") if fast_vote else (value, "kept")
    if not is_slow(value):
        return value, "unambiguous"
    double = value * 2
    if family == "slow":
        # a slow genre keeps it slow, unless the backbeat is at the double
        # (reggae or rap at 160 with a snare on two and four)
        if evidence and evidence.get("vote") == "fast":
            return double, "backbeat"
        return value, "genre"
    if family == "fast":
        return double, "genre"
    if family == "half" and 125.0 <= double < 160.0:
        return double, "genre"
    if use_range and value < PREFER_MIN:
        return double, "range"
    if evidence and evidence.get("vote") == "fast":
        return double, "backbeat"
    return value, "kept"


# ── the analysis's side: genre from the file, bands from the audio ────────────

def file_genres(path: Optional[str]) -> list:
    """The file's own genre tag(s) (any format mutagen reads), or []. Never
    raises."""
    if not path:
        return []
    try:
        import mutagen

        audio = mutagen.File(path, easy=True)
        if audio is None or not audio.tags:
            return []
        found = audio.tags.get("genre") or []
        return [str(g) for g in found if g][:8]
    except Exception:  # noqa: BLE001 - no genre is fine
        return []


def snare_envelope(y, sr: int, hop: int = 512, *, mel=None):
    """The onset envelope of the mids (160–2500 Hz: a snare's body, a clap),
    detrended, at ``sr / hop`` frames a second. Not the highs: off-beat hats
    there would read as a backbeat at double the tempo of a track with a
    kick on every beat.

    ``mel`` is a power mel spectrogram of ``y`` already made (librosa's
    defaults: 0 Hz to ``sr / 2``, any number of bands), as the analysis has
    for its onset envelope: then no spectrum is computed again."""
    import librosa
    import numpy as np

    if mel is None:
        mel = librosa.feature.melspectrogram(y=y, sr=sr, n_fft=2048, hop_length=hop)
    freqs = librosa.mel_frequencies(n_mels=mel.shape[0], fmin=0.0, fmax=sr / 2.0)
    comp = np.log1p(10.0 * np.sqrt(mel[(freqs >= 160.0) & (freqs < 2500.0)]))
    flux = np.maximum(0.0, np.diff(comp, axis=1, prepend=comp[:, :1])).mean(axis=0)
    width = int(0.5 * sr / hop) | 1
    local = np.convolve(flux, np.ones(width) / width, mode="same")
    return np.maximum(0.0, flux - local)


#: the reasons that are evidence a fast result really is fast
EVIDENCE = ("genre", "backbeat")


def analysis_tempo(path: Optional[str], y, sr: int, bpm: float, beat_frames, hop: int = 512, *,
                   mel=None) -> Tuple[float, str]:
    """The analysis's tempo (librosa's reading ``bpm`` and its tracked beats,
    as frames of ``hop`` samples) in its octave, and why (``choose``'s
    reason): the genre from the file's tag and the range first, then the
    backbeat, measured only when they haven't decided (and for a fast
    reading, so a fast result says whether the backbeat confirmed it). A
    reading at 100–140 comes back exactly as it went in."""
    import numpy as np

    folded = _fold(bpm)
    if folded is None or not ambiguous(folded):
        return bpm, "unambiguous"
    genres = file_genres(path)
    chosen, why = choose(folded, genres=genres)
    # a slow genre asks the backbeat too: it decides only when that agrees
    slow_genre = why == "genre" and genre_family(genres) == "slow"
    if why != "kept" and not slow_genre:
        return round(chosen, 1), why
    if beat_frames is None:
        return round(chosen, 1), why
    beats = np.asarray(beat_frames, dtype=np.float64) * hop / float(sr)
    if beats.size < MIN_BEATS // 2:
        return round(chosen, 1), why
    # the beats at the fast reading: as tracked, or with the halfway points
    fast = beats if is_fast(folded) else np.sort(np.concatenate([beats, (beats[:-1] + beats[1:]) / 2.0]))
    evidence = backbeat(snare_envelope(y, sr, hop, mel=mel), sr / hop, fast)
    chosen, why = choose(folded, evidence=evidence, genres=genres)
    return round(chosen, 1), why


__all__ = ["BACKBEAT_LEAD", "BACKBEAT_MIN", "EVIDENCE", "FAST_BAND", "PREFER_MIN", "SLOW_BAND", "ambiguous", "analysis_tempo",
           "backbeat", "choose", "file_genres", "genre_family", "is_fast", "is_slow", "snare_envelope"]
