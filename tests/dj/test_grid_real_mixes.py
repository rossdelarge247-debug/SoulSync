"""Grid v4 (Ross's report of 28 October, "couldn't beat-match: I Need the
Night has no steady beat" on every pair): house with a rolling bass as loud
as its kick was read as a break (the sixteenth check moved the grid off the
kick, and the beat was then "not found"), and a long drumless intro or
breakdown counted against the beat's confidence. Both are steady 4/4 music
that must be ready to mix."""

from __future__ import annotations

import pytest

from core.dj import grid
from core.dj.grid import BEAT_CONFIDENT, beatmatch_problem

from .grid_fixtures import SR, break_track, dance_track, rolling_bass_house

pytestmark = pytest.mark.gauntlet


@pytest.mark.parametrize("seed,bass,bars", [(2, 2.0, 24), (3, 2.0, 64), (4, 1.5, 64), (1, 2.0, 64), (3, 2.0, 24)])
def test_house_with_a_rolling_bass_stays_on_its_kick_and_is_ready_to_mix(seed, bass, bars):
    # all of these were "no beat" or a break under 0.5 before grid v4
    bpm = 122.0 + seed % 3
    y, truth = rolling_bass_house(bpm, bars, bass=bass, seed=seed)
    r = grid.analyze_audio(y, SR, bpm_hint=bpm)
    assert r["status"] == "done", r.get("reason")
    assert r["bpm"] == pytest.approx(bpm, abs=0.1)
    assert r["kind"] == "constant"
    assert beatmatch_problem(r["beat_confidence"], r["meter"]) is None, r["beat_confidence"]
    # on the kick, not a sixteenth off it
    period = 60.0 / bpm
    off = (r["first_beat"] - truth["beats"][0]) % period
    assert min(off, period - off) < 0.02


def test_a_drumless_intro_doesnt_sink_the_beat_confidence():
    y, _ = rolling_bass_house(122.0, 48, bass=0.6, drumless_bars=8, seed=5)
    r = grid.analyze_audio(y, SR, bpm_hint=122.0)
    assert r["status"] == "done" and r["beat_confidence"] >= 0.8


def test_a_break_is_still_a_break():
    # an Amen break's kick is on some beats only: not four on the floor, so
    # its grid stays under the bar for beat-matching (it echoes out)
    import numpy as np

    y, truth = break_track(170.0, bars=48, pattern="amen")
    feat = grid._features(y)
    assert not grid.four_on_the_floor(feat, np.asarray(truth["beats"]))
    r = grid.beat_grid(feat, 170.0)
    assert r["sixteenth"] != 0 and r["confidence"] <= grid.BREAK_CONFIDENCE
    house, h = rolling_bass_house(122.0, 24, bass=2.0, seed=2)
    assert grid.four_on_the_floor(grid._features(house), np.asarray(h["beats"]))


def test_noise_and_a_pad_still_have_no_beat():
    import numpy as np

    noise = (np.random.RandomState(1).randn(SR * 40) * 0.3).astype("float32")
    assert grid.analyze_audio(noise, SR)["status"] == "none"
    pad, _ = dance_track(120.0, (("pad", 24),))
    r = grid.analyze_audio(pad, SR, bpm_hint=120.0)
    assert r["status"] == "none" or r["beat_confidence"] < BEAT_CONFIDENT
