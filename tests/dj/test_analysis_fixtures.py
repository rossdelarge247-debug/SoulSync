"""Sample Studio's analyzer gives the library's DJ data: BPM, key and energy
on generated tracks at known tempos and keys (no real music)."""

from __future__ import annotations

import numpy as np
import pytest

from core.dj.camelot import parse_key
from core.sample import analyze
from core.sample.energy import energy_score, loudness_db

from .audio_fixtures import SR, dj_track, write_wav

# (bpm, root pitch class, minor): a spread of tempos and keys, sharps and flats
CASES = [(90, 9, True), (120, 0, False), (128, 6, True), (174, 3, False), (140, 2, True)]


@pytest.mark.parametrize("bpm,root,minor", CASES)
def test_bpm_and_key_on_generated_tracks(tmp_path, bpm, root, minor):
    path = write_wav(tmp_path / f"t{bpm}.wav", dj_track(bpm, root, minor))
    result = analyze.analyze_track(path)
    assert result["analyzer_version"] == analyze.ANALYZER_VERSION >= 4
    assert abs(result["bpm"] - bpm) / bpm < 0.03, result["bpm"]
    expected = parse_key(f"{['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'][root]}"
                         f"{'m' if minor else ''}")
    got = parse_key(result["key"]["name"])
    assert got["camelot"] == expected["camelot"], result["key"]
    assert result["key"]["confidence"] >= 0.5
    assert 1 <= result["energy"] <= 10


def test_energy_orders_quiet_and_sparse_below_loud_and_busy(tmp_path):
    loud = analyze.analyze_track(write_wav(tmp_path / "loud.wav", dj_track(128, 9, True, level=0.95)))
    pad = analyze.analyze_track(write_wav(tmp_path / "pad.wav", dj_track(128, 9, True, level=0.08, drums=False)))
    n = SR * 6
    hum = (0.02 * np.sin(2 * np.pi * 220 * np.arange(n) / SR)).astype(np.float32)
    quiet = analyze.analyze_track(write_wav(tmp_path / "quiet.wav", hum))
    assert quiet["energy"] <= 2
    assert quiet["energy"] <= pad["energy"] < loud["energy"]
    assert loud["energy"] >= 6


def test_energy_score_scale():
    assert energy_score(-60, 0) == 1
    assert energy_score(-5, 12) == 10
    assert energy_score(-19, 4) == 5  # half loud, half busy
    # loudness weighs more than density
    assert energy_score(-8, 0) > energy_score(-30, 8)


def test_loudness_ignores_silence_and_quiet_intros():
    n = SR * 4
    tone = 0.5 * np.sin(2 * np.pi * 440 * np.arange(n) / SR)
    with_intro = np.concatenate([np.zeros(n), tone]).astype(np.float32)
    assert loudness_db(with_intro) == pytest.approx(loudness_db(tone.astype(np.float32)), abs=0.5)
    assert loudness_db(np.zeros(n, dtype=np.float32)) is None


def test_energy_is_none_for_too_short_audio():
    from core.sample.energy import detect_energy

    assert detect_energy(np.zeros(100, dtype=np.float32), SR, 0) is None
