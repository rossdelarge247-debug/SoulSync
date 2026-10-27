"""Generated dance tracks with a known beat grid, bars and sections, for the
beat grid and phrase tests (core/dj/grid.py). No real music: a kick on every
beat with an accent on the one, off-beat hats, a bass line, a chord pad that
changes on the bar, a crash on each section's first downbeat, and sections
that differ the way dance tracks do (an intro and outro of drums only, a
breakdown without the kick, a drop that brings everything back).

``dance_track`` returns the mono signal and the truth: every beat time, the
downbeats, and each section's first bar."""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

SR = 22050

#: what plays in each kind of section
PARTS = {
    "intro": {"kick": 1.0, "hats": 0.6, "bass": 0.0, "pad": 0.0, "lead": 0.0},
    "groove": {"kick": 1.0, "hats": 0.8, "bass": 0.8, "pad": 0.5, "lead": 0.0},
    "breakdown": {"kick": 0.0, "hats": 0.0, "bass": 0.0, "pad": 0.9, "lead": 0.4},
    "drop": {"kick": 1.0, "hats": 1.0, "bass": 1.0, "pad": 0.7, "lead": 0.7},
    "outro": {"kick": 1.0, "hats": 0.6, "bass": 0.0, "pad": 0.0, "lead": 0.0},
    "pad": {"kick": 0.0, "hats": 0.0, "bass": 0.0, "pad": 1.0, "lead": 0.0},
}

#: a typical club track: 16 bars of drums, a groove, a breakdown, the drop, 16 bars out
CLUB = (("intro", 16), ("groove", 32), ("breakdown", 16), ("drop", 32), ("outro", 16))


def _freq(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def _beat_times(n_beats: int, bpm: float, start: float, end_bpm: Optional[float]) -> np.ndarray:
    """Beat times; with ``end_bpm`` the tempo moves linearly from ``bpm`` to it."""
    if end_bpm is None:
        return start + np.arange(n_beats) * 60.0 / bpm
    times = [start]
    for i in range(1, n_beats):
        tempo = bpm + (end_bpm - bpm) * (i / max(1, n_beats - 1))
        times.append(times[-1] + 60.0 / tempo)
    return np.asarray(times)


def _add(y: np.ndarray, at: float, sound: np.ndarray) -> None:
    i = int(round(at * SR))
    if i >= len(y) or i + len(sound) <= 0:
        return
    j = min(len(y), i + len(sound))
    y[i:j] += sound[:j - i]


def _kick(level: float) -> np.ndarray:
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    sweep = 50 + 90 * np.exp(-t / 0.03)
    phase = 2 * np.pi * np.cumsum(sweep) / SR
    return level * np.exp(-t / 0.09) * np.sin(phase)


def _noise(n: int, decay: float, seed: int, level: float, highpass: bool = True) -> np.ndarray:
    rng = np.random.RandomState(seed)
    x = rng.randn(n)
    if highpass:
        x = np.diff(np.concatenate([[0.0], x]))
    return level * x * np.exp(-np.arange(n) / (decay * SR))


def _tone(midi: float, seconds: float, level: float, harmonics: int = 4, attack: float = 0.01) -> np.ndarray:
    n = int(seconds * SR)
    t = np.arange(n) / SR
    f = _freq(midi)
    wave = sum((0.55 ** h) * np.sin(2 * np.pi * f * (h + 1) * t) for h in range(harmonics))
    env = np.minimum(1.0, t / attack) * np.minimum(1.0, (seconds - t) / 0.02)
    return level * wave * np.clip(env, 0, 1)


def dance_track(bpm: float = 124.0, sections: Sequence[Tuple[str, int]] = CLUB, *, lead_in: float = 0.0,
                end_bpm: Optional[float] = None, tail: float = 1.0, root: int = 57,
                accent: bool = True, seed: int = 3, beats_per_bar: int = 4) -> Tuple[np.ndarray, Dict[str, object]]:
    """``(y, truth)``: mono float32 at SR, and ``{"beats", "downbeats",
    "section_bars", "bars", "bpm"}``. ``lead_in`` seconds of silence come
    first; ``end_bpm`` makes the tempo drift; ``root`` is the key's MIDI root;
    ``beats_per_bar`` 3 makes a waltz."""
    bpb = int(beats_per_bar)
    total_bars = sum(b for _, b in sections)
    beats = _beat_times(total_bars * bpb, bpm, lead_in, end_bpm)
    last = beats[-1] + 60.0 / (end_bpm or bpm)
    y = np.zeros(int((last + tail) * SR))
    # i–VI–III–VII over four bars, a chord a bar, so the harmony turns on the one
    progression = (0, -4, 3, -2)
    bar = 0
    section_bars: List[int] = []
    rng = np.random.RandomState(seed)
    for kind, n_bars in sections:
        parts = PARTS[kind]
        section_bars.append(bar)
        for b in range(bar, bar + n_bars):
            first = beats[b * bpb]
            nxt = beats[b * bpb + bpb] if b * bpb + bpb < len(beats) else last
            bar_len = nxt - first
            chord_root = root + progression[b % 4]
            if b == bar and kind != "pad":
                _add(y, first, _noise(int(1.2 * SR), 0.35, seed + b, 0.35))  # the crash on a section's one
            if parts["pad"]:
                for interval in (0, 3, 7):
                    _add(y, first, _tone(chord_root + interval, bar_len, 0.06 * parts["pad"], attack=0.03))
            for k in range(bpb):
                bt = beats[b * bpb + k]
                beat_len = (beats[b * bpb + k + 1] if b * bpb + k + 1 < len(beats) else last) - bt
                if parts["kick"]:
                    _add(y, bt, _kick(parts["kick"] * (1.0 if (k == 0 and accent) else 0.7)))
                    if k == 0 and accent:
                        _add(y, bt, _tone(96, 0.03, 0.12, harmonics=1, attack=0.001))
                if parts["hats"]:
                    _add(y, bt + beat_len / 2, _noise(int(0.05 * SR), 0.012, int(rng.randint(1e6)),
                                                      0.25 * parts["hats"]))
                if parts["bass"]:
                    _add(y, bt + beat_len / 2, _tone(chord_root - 24, beat_len / 2 * 0.9, 0.35 * parts["bass"],
                                                     harmonics=3, attack=0.004))
                if parts["lead"] and k in (0, 2):
                    _add(y, bt, _tone(chord_root + 12 + (7 if k == 2 else 0), beat_len * 1.5, 0.05 * parts["lead"]))
        bar += n_bars
    y = y / max(1e-9, float(np.max(np.abs(y)))) * 0.9
    return y.astype(np.float32), {"beats": beats, "downbeats": beats[::bpb], "section_bars": section_bars,
                                  "bars": total_bars, "bpm": bpm}


def write_wav(path, y) -> str:
    import soundfile as sf

    sf.write(str(path), y, SR, subtype="PCM_16")
    return str(path)


def _snare(level: float, seed: int) -> np.ndarray:
    """A snare: a short body tone and a burst of noise."""
    n = int(0.18 * SR)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * 190.0 * t) * np.exp(-t / 0.04)
    return level * (0.6 * body + _noise(n, 0.05, seed, 1.0, highpass=False) * 0.7)


#: drum patterns on a grid of sixteenths (0–15 in a bar; two bars where the
#: pattern takes two): "K" kick, "S" snare (loud), "s" ghost snare, "h" a
#: closed hat or ride. An Amen-style break (the kick on the one and the "and"
#: of one, and on the "and" and "a" of three; the snare on two and four with
#: the syncopated ones between) and a two-step garage beat (the kick on the
#: one and the "a" of two, the snare on two and four, shuffled hats).
PATTERNS = {
    "amen": (
        {0: "K", 2: "K", 4: "S", 7: "s", 9: "s", 10: "K", 11: "K", 12: "S", 15: "s"},
        {0: "K", 2: "K", 4: "S", 7: "s", 9: "s", 10: "K", 11: "K", 12: "S", 15: "s"},
        {0: "K", 2: "K", 4: "S", 7: "s", 9: "s", 10: "K", 14: "S"},
        {1: "s", 2: "K", 3: "K", 4: "S", 7: "s", 9: "s", 10: "K", 14: "S"},
    ),
    "two_step": (
        {0: "K", 4: "S", 7: "K", 10: "K", 12: "S"},
        {0: "K", 4: "S", 11: "K", 12: "S", 14: "s"},
    ),
}


def break_track(bpm: float = 165.0, bars: int = 64, *, pattern: str = "amen", lead_in: float = 0.0,
                tail: float = 1.0, root: int = 57, seed: int = 5,
                swing: float = 0.0) -> Tuple[np.ndarray, Dict[str, object]]:
    """A syncopated drum track with a bass and a chord a bar: ``(y, truth)``
    as dance_track's. ``swing`` delays the off sixteenths by that share of a
    sixteenth (two-step's shuffle)."""
    bars = int(bars)
    beat = 60.0 / bpm
    beats = lead_in + np.arange(bars * 4) * beat
    last = beats[-1] + beat
    y = np.zeros(int((last + tail) * SR))
    rng = np.random.RandomState(seed)
    progression = (0, -4, 3, -2)
    six = beat / 4
    for b in range(bars):
        start = beats[b * 4]
        chord_root = root + progression[b % 4]
        for interval in (0, 3, 7):
            _add(y, start, _tone(chord_root + interval, 4 * beat, 0.04, attack=0.03))
        _add(y, start, _tone(chord_root - 24, 2 * beat, 0.2, harmonics=3, attack=0.004))
        hits = PATTERNS[pattern][b % len(PATTERNS[pattern])]
        for step in range(16):
            at = start + step * six + (swing * six if step % 2 else 0.0)
            # a ride on every eighth, a softer hat on the sixteenths between
            _add(y, at, _noise(int(0.04 * SR), 0.01, int(rng.randint(1e6)), 0.12 if step % 2 == 0 else 0.05))
            kind = hits.get(step)
            if kind == "K":
                _add(y, at, _kick(0.9))
            elif kind == "S":
                _add(y, at, _snare(0.8, int(rng.randint(1e6))))
            elif kind == "s":
                _add(y, at, _snare(0.55, int(rng.randint(1e6))))
    y = y / max(1e-9, float(np.max(np.abs(y)))) * 0.9
    return y.astype(np.float32), {"beats": beats, "downbeats": beats[::4], "section_bars": [0], "bars": bars,
                                  "bpm": bpm}
