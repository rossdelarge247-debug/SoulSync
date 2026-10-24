"""Small generated audio for the DJ tests: a kick on every beat at a known
BPM, off-beat hats, and a i–iv–V–i (or I–IV–V–I) chord loop in a known key.
No real music; every file is a few seconds and made in the test's tmp dir."""

from __future__ import annotations

import numpy as np
import soundfile as sf

SR = 22050
NOTES = ("C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B")


def _freq(pc: int, octave: int) -> float:
    return 440.0 * 2 ** ((pc - 9) / 12 + (octave - 4))


def _tone(freq: float, n: int) -> np.ndarray:
    t = np.arange(n) / SR
    return sum((0.6 ** h) * np.sin(2 * np.pi * freq * (h + 1) * t) for h in range(4))


def dj_track(bpm: float, root: int, minor: bool, seconds: float = 12.0, level: float = 0.9,
             drums: bool = True) -> np.ndarray:
    """Mono float32 at SR. ``root`` is a pitch class (C = 0)."""
    n = int(seconds * SR)
    y = np.zeros(n)
    beat = 60.0 / bpm
    bar = int(4 * beat * SR)
    for start in range(0, n, bar):
        degree = (0, 5, 7, 0)[(start // bar) % 4]
        r = (root + degree) % 12
        third = 3 if (minor and degree != 7) else 4  # harmonic minor: a major V
        seg = min(bar, n - start)
        chord = (_tone(_freq(r, 3), seg) + 0.8 * _tone(_freq((r + third) % 12, 4), seg)
                 + 0.8 * _tone(_freq((r + 7) % 12, 4), seg) + 0.5 * _tone(_freq(r, 2), seg))
        y[start:start + seg] += 0.15 * chord
    if drums:
        k = int(0.03 * SR)
        kick = np.exp(-np.arange(k) / (0.005 * SR)) * np.sin(2 * np.pi * 60 * np.arange(k) / SR)
        rng = np.random.RandomState(7)
        b = 0.0
        while b < seconds - 0.05:
            i = int(b * SR)
            m = max(0, min(k, n - i))
            y[i:i + m] += kick[:m]
            j = int((b + beat / 2) * SR)
            if j + 200 < n:
                y[j:j + 200] += 0.3 * rng.randn(200) * np.exp(-np.arange(200) / 40)
            b += beat
    return (y / np.max(np.abs(y)) * level).astype(np.float32)


def write_wav(path, y) -> str:
    sf.write(str(path), y, SR, subtype="PCM_16")
    return str(path)


def write_flac(path, y) -> str:
    sf.write(str(path), y, SR, format="FLAC", subtype="PCM_16")
    return str(path)


def write_ogg(path, y) -> str:
    sf.write(str(path), y, SR, format="OGG", subtype="VORBIS")
    return str(path)


def write_with_ffmpeg(path, y, codec_args) -> str:
    """mp3 / m4a through ffmpeg (a SoulSync dependency); the caller skips when
    ffmpeg isn't there."""
    import subprocess
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        sf.write(tmp.name, y, SR, subtype="PCM_16")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", tmp.name, *codec_args, str(path)], check=True)
    import os
    os.unlink(tmp.name)
    return str(path)
