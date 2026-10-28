"""Generated tracks for the tempo-octave tests (core/sample/tempo.py): drum
and bass at 172–176 in several shapes, a chopped Amen-style break, liquid
drum and bass with soft hats, and the tempos that must stay where they are
(house at 124, hip-hop at 90, dubstep at 140 in half time, a 100 BPM track).

No real music: drums, a bass and a chord pad from the grid tests' sounds
(tests/dj/grid_fixtures.py), on a sixteenth-note grid. Deterministic (fixed
seeds) and made in memory at test time; each is about half a minute.

A pattern is one dict per bar (cycled), sixteenth step (0–15) to a hit:
``K`` kick, ``S`` snare, ``s`` ghost snare, ``C`` clap. Hats are separate:
``hats`` is ``16`` (every sixteenth, the eighths louder), ``8`` (every
eighth), ``off`` (the off-beat eighths, house's open hat) or ``none``."""

from __future__ import annotations

from typing import Dict, List, Sequence, Tuple

import numpy as np

from .grid_fixtures import SR, _add, _kick, _noise, _snare, _tone, break_track

Pattern = Sequence[Dict[int, str]]


def _clap(level: float, seed: int) -> np.ndarray:
    """Three quick noise bursts, mostly above the snare's body."""
    n = int(0.12 * SR)
    out = np.zeros(n)
    for k, at in enumerate((0, int(0.008 * SR), int(0.016 * SR))):
        burst = _noise(n - at, 0.03 if k == 2 else 0.006, seed + k, 1.0, highpass=True)
        out[at:] += burst
    return level * out


def _bass_note(midi: float, seconds: float, level: float, detune: float = 0.0) -> np.ndarray:
    """A low saw-ish note (a reese when ``detune`` is set): enough harmonics
    to reach the snare's band, as a real bass does."""
    n = int(seconds * SR)
    t = np.arange(n) / SR
    f = 440.0 * 2 ** ((midi - 69) / 12)
    wave = np.zeros(n)
    for h in range(1, 9):
        wave += np.sin(2 * np.pi * f * h * t) / h
        if detune:
            wave += np.sin(2 * np.pi * f * (1 + detune) * h * t) / h
    env = np.minimum(1.0, t / 0.01) * np.minimum(1.0, (seconds - t) / 0.03)
    return level * wave * np.clip(env, 0, 1) / (2.0 if detune else 1.0)


def drum_track(bpm: float, bars: int, pattern: Pattern, *, hats: str = "16", hat_level: float = 0.12,
               snare_level: float = 0.8, kick_level: float = 0.9, bass: str = "none", pad: float = 0.0,
               swing: float = 0.0, root: int = 45, seed: int = 11) -> Tuple[np.ndarray, Dict[str, object]]:
    """``(y, truth)``: mono float32 at SR and ``{"bpm", "bars"}``."""
    beat = 60.0 / bpm
    six = beat / 4
    bar_s = 4 * beat
    y = np.zeros(int((bars * bar_s + 1.0) * SR))
    rng = np.random.RandomState(seed)
    progression = (0, -4, 3, -2)
    for b in range(bars):
        start = b * bar_s
        chord = root + progression[b % 4]
        if pad:
            for interval in (12, 15, 19):
                _add(y, start, _tone(chord + interval, bar_s, 0.05 * pad, attack=0.05))
        if bass == "reese":
            _add(y, start, _bass_note(chord - 12, 6 * six, 0.22, detune=0.007))
            _add(y, start + 10 * six, _bass_note(chord - 12, 5 * six, 0.18, detune=0.007))
        elif bass == "sub":
            _add(y, start, _tone(chord - 12, 2 * beat, 0.3, harmonics=2, attack=0.01))
            _add(y, start + 2.5 * beat, _tone(chord - 12, 1.5 * beat, 0.25, harmonics=2, attack=0.01))
        elif bass == "wobble":
            note = _bass_note(chord - 12, bar_s, 0.3)
            t = np.arange(len(note)) / SR
            # a wobble at the eighth-note triplet of the half-time feel
            note *= 0.55 + 0.45 * np.sin(2 * np.pi * t * (bpm / 60.0) * 1.5)
            _add(y, start, note)
        elif bass == "boom":
            _add(y, start, _tone(chord - 12, 1.5 * beat, 0.3, harmonics=3, attack=0.01))
            _add(y, start + 2.75 * beat, _tone(chord - 10, beat, 0.25, harmonics=3, attack=0.01))
        hits = pattern[b % len(pattern)]
        for step in range(16):
            at = start + step * six + (swing * six if step % 2 else 0.0)
            if hats == "16":
                _add(y, at, _noise(int(0.04 * SR), 0.008, int(rng.randint(1e6)),
                                   hat_level if step % 2 == 0 else 0.55 * hat_level))
            elif hats == "8" and step % 2 == 0:
                _add(y, at, _noise(int(0.04 * SR), 0.01, int(rng.randint(1e6)), hat_level))
            elif hats == "off" and step % 4 == 2:
                _add(y, at, _noise(int(0.12 * SR), 0.04, int(rng.randint(1e6)), hat_level))
            kind = hits.get(step)
            if kind == "K":
                _add(y, at, _kick(kick_level))
            elif kind == "S":
                _add(y, at, _snare(snare_level, int(rng.randint(1e6))))
            elif kind == "s":
                _add(y, at, _snare(0.45 * snare_level, int(rng.randint(1e6))))
            elif kind == "C":
                _add(y, at, _clap(0.7, int(rng.randint(1e6))))
    y = y / max(1e-9, float(np.max(np.abs(y)))) * 0.9
    return y.astype(np.float32), {"bpm": bpm, "bars": bars}


#: the snare on two and four (steps 4 and 12) of the drum-and-bass pulse
DNB_TWO_STEP_AND2 = ({0: "K", 4: "S", 6: "K", 12: "S"},)
DNB_TWO_STEP = ({0: "K", 4: "S", 10: "K", 12: "S"}, {0: "K", 4: "S", 10: "K", 11: "K", 12: "S", 14: "s"})
DNB_ROLLER = ({0: "K", 4: "S", 7: "K", 10: "K", 12: "S", 15: "s"}, {0: "K", 2: "K", 4: "S", 10: "K", 12: "S"})
LIQUID = ({0: "K", 4: "S", 10: "K", 12: "S"}, {0: "K", 4: "S", 9: "K", 12: "S"})
#: chopped Amen-style slices, re-ordered as a jungle producer would
AMEN_CHOP = (
    {0: "K", 2: "K", 4: "S", 7: "s", 9: "s", 10: "K", 12: "S", 15: "s"},
    {0: "K", 3: "s", 4: "S", 6: "K", 10: "K", 11: "K", 12: "S", 14: "s"},
    {0: "K", 2: "K", 4: "S", 5: "s", 7: "s", 10: "K", 12: "S", 13: "s", 15: "S"},
    {0: "K", 4: "S", 6: "s", 8: "K", 9: "s", 12: "S", 14: "S", 15: "s"},
)
BOOM_BAP = ({0: "K", 4: "S", 7: "K", 10: "K", 12: "S"}, {0: "K", 3: "K", 4: "S", 10: "K", 12: "S", 15: "s"})
#: half-time drum and bass: the snare on three of the 174 bar (its backbeat
#: really is at 87; only the genre or a person says 174)
DNB_HALFTIME = ({0: "K", 8: "S"}, {0: "K", 6: "K", 8: "S", 14: "s"})
#: dubstep's half time: the kick on one, the snare on three of the 140 bar
DUBSTEP = ({0: "K", 8: "S"}, {0: "K", 3: "K", 8: "S", 14: "K"})
STRAIGHT_100 = ({0: "K", 4: "S", 8: "K", 12: "S"}, {0: "K", 4: "S", 8: "K", 10: "K", 12: "S"})


def _house(bpm: float, bars: int) -> Tuple[np.ndarray, Dict[str, object]]:
    """Four on the floor with a clap on two and four and an off-beat open hat."""
    kick = drum_track(bpm, bars, ({0: "K", 4: "K", 8: "K", 12: "K"},), hats="off", hat_level=0.25, bass="sub",
                      pad=0.8, seed=21)[0]
    claps = drum_track(bpm, bars, ({4: "C", 12: "C"},), hats="none", seed=22)[0]
    y = kick + 0.6 * claps
    y = y / max(1e-9, float(np.max(np.abs(y)))) * 0.9
    return y.astype(np.float32), {"bpm": bpm, "bars": bars}


def fixtures(seconds: float = 30.0) -> List[Tuple[str, float, str, np.ndarray]]:
    """Every fixture as ``(name, true BPM, genre, y)``: the genre is what a
    file's tag would say, for the tests that read it ("" for none)."""
    def bars(bpm: float) -> int:
        return max(8, int(seconds * bpm / 240.0))

    out: List[Tuple[str, float, str, np.ndarray]] = []

    def add(name: str, bpm: float, genre: str, made) -> None:
        out.append((name, bpm, genre, made[0]))

    add("dnb_174", 174.0, "", drum_track(174.0, bars(174), DNB_TWO_STEP_AND2, hats="16", bass="reese", pad=0.5))
    add("dnb_172_two_step", 172.0, "", drum_track(172.0, bars(172), DNB_TWO_STEP, hats="8", bass="reese", seed=12))
    add("dnb_176_roller", 176.0, "", drum_track(176.0, bars(176), DNB_ROLLER, hats="16", swing=0.12,
                                                bass="sub", seed=13))
    add("amen_170", 170.0, "", break_track(170.0, bars=bars(170), pattern="amen"))
    add("amen_chopped_172", 172.0, "", drum_track(172.0, bars(172), AMEN_CHOP, hats="8", hat_level=0.1,
                                                  bass="sub", seed=14))
    add("liquid_174", 174.0, "", drum_track(174.0, bars(174), LIQUID, hats="16", hat_level=0.035, snare_level=0.55,
                                            bass="sub", pad=1.0, seed=15))
    add("house_124", 124.0, "", _house(124.0, bars(124)))
    add("hiphop_90", 90.0, "", drum_track(90.0, bars(90), BOOM_BAP, hats="16", swing=0.1, bass="boom", pad=0.4,
                                          seed=16))
    add("hiphop_90_eighths", 90.0, "", drum_track(90.0, bars(90), BOOM_BAP, hats="8", bass="boom", seed=17))
    add("dubstep_140", 140.0, "", drum_track(140.0, bars(140), DUBSTEP, hats="8", bass="wobble", seed=18))
    add("track_100", 100.0, "", drum_track(100.0, bars(100), STRAIGHT_100, hats="8", bass="boom", pad=0.5, seed=19))
    add("dnb_halftime_174", 174.0, "Drum & Bass", drum_track(174.0, bars(174), DNB_HALFTIME, hats="16",
                                                             bass="reese", seed=20))
    return out


__all__ = ["drum_track", "fixtures"]
