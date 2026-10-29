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


# ── the gauntlet review of 28 October (H2, M1, L4): an off-beat bass ─────────

from .grid_fixtures import DNB, FOUR, HALF_TIME, OFF_BEAT_BASS, pattern_track  # noqa: E402


def _grid(y, bpm):
    return grid.beat_grid(grid._features(y), bpm)


def _phase_ms(g, beats, bpm):
    period = 60.0 / bpm
    off = (g["first_beat"] - float(beats[0])) % period
    return 1000 * min(off, period - off)


@pytest.mark.parametrize("level", [0.8, 1.5])
def test_house_with_an_off_beat_bass_and_a_clap_is_ready_on_its_kick(level):
    # H2: the most common house bassline, on the "and", as loud as the kick or
    # louder; the clap on two and four says which line is the beat
    y, beats = pattern_track(124.0, 64, FOUR, bass=OFF_BEAT_BASS, bass_level=level, claps=True)
    g = _grid(y, 124.0)
    assert g["kind"] == "constant" and g["four_on_the_floor"] and g["backbeat"]
    assert g["confidence"] >= BEAT_CONFIDENT
    assert _phase_ms(g, beats, 124.0) < 15


@pytest.mark.parametrize("kw", [
    {"bass_level": 0.5, "drumless_bars": 40},  # a long bass-only intro: the comb took the bass, at 0.98
    {"bass_level": 0.5, "drumless_bars": 16},
    {"bass_level": 0.8},                       # as loud as the kick in the low band
    {"bass_level": 1.0},                       # louder: the comb took it, at 0.53
    {"bass_level": 1.5},                       # much louder: at 1.00, an eighth off
])
def test_a_kick_and_an_off_beat_bass_with_no_backbeat_are_never_trusted_on_the_bass(kw):
    # M1 and the phase follow-up: with no clap or snare to tell the kick from
    # an off-beat bass, the beat's own onsets do (a kick's pitch falls and its
    # sub is short; a bass note holds): a grid on the bass is kept (cuts and
    # the bars still use it) but under the bar; one on the kick is trusted
    y, beats = pattern_track(124.0, 64, FOUR, bass=OFF_BEAT_BASS, **kw)
    g = _grid(y, 124.0)
    assert g["kind"] == "constant"
    if _phase_ms(g, beats, 124.0) > 20:
        assert g["unsure_phase"] and g["confidence"] < BEAT_CONFIDENT
    else:
        assert not g["unsure_phase"]


@pytest.mark.parametrize("pattern,bpm,kw,most", [
    (DNB, 174.0, {}, None),
    (DNB, 174.0, {"bass": OFF_BEAT_BASS, "bass_level": 0.4}, grid.BREAK_CONFIDENCE),
    (HALF_TIME, 140.0, {"bass": OFF_BEAT_BASS, "bass_level": 0.5, "snare_low": 1.5}, grid.BREAK_CONFIDENCE),
])
def test_breaks_drum_and_bass_and_half_time_are_as_they_were(pattern, bpm, kw, most):
    y, beats = pattern_track(bpm, 64, pattern, **kw)
    g = _grid(y, bpm)
    assert not g["four_on_the_floor"] and not g["unsure_phase"]
    assert _phase_ms(g, beats, bpm) < 15
    if most is not None:
        assert g["confidence"] <= most


def test_drum_and_bass_with_a_bass_on_every_beat_isnt_four_on_the_floor():
    # L4: the bass makes every beat even in the low band; the snare on every
    # other beat says it's drum and bass
    import numpy as np

    y, beats = pattern_track(174.0, 64, DNB, bass=(0, 4, 8, 12), bass_level=0.3)
    feat = grid._features(y)
    assert grid._low_line(feat, np.asarray(beats))[0] >= grid.FLOOR_EVENNESS
    assert not grid.four_on_the_floor(feat, np.asarray(beats))
    g = grid.beat_grid(feat, 174.0)
    assert g["confidence"] >= BEAT_CONFIDENT and _phase_ms(g, beats, 174.0) < 15


# ── the phase follow-up of 29 October: a rolling bass under the kick ─────────

ROLLING_316 = (1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15)


@pytest.mark.parametrize("bpm,level,kick", [(126.0, 1.0, 0.9), (128.0, 1.2, 0.9), (128.0, 1.0, 0.5)])
def test_a_rolling_bass_with_no_backbeat_is_never_trusted_to_beat_match(bpm, level, kick):
    # the low band is busy on every sixteenth: the comb's line was a bass note
    # a sixteenth off the kick, at 0.98-0.99; it's held under the bar now
    y, _ = pattern_track(bpm, 48, FOUR, bass=ROLLING_316, bass_level=level, kick=kick)
    g = _grid(y, bpm)
    assert g["kind"] == "constant" and g["unsure_phase"]
    assert g["confidence"] < BEAT_CONFIDENT


@pytest.mark.parametrize("kw", [{}, {"bass": OFF_BEAT_BASS, "bass_level": 0.4},
                                {"bass": OFF_BEAT_BASS, "bass_level": 0.6},
                                {"bass": ROLLING_316, "bass_level": 1.0, "claps": True},
                                # the follow-up's review: low percussion and a quiet rolling bass
                                {"toms": (1, 2, 3), "tom_level": 0.3},
                                {"toms": (1, 2, 3), "tom_level": 0.15, "bass": OFF_BEAT_BASS, "bass_level": 0.4},
                                {"bass": ROLLING_316, "bass_level": 0.25}])
def test_ordinary_four_on_the_floor_is_still_ready(kw):
    # a kick alone, an off-beat bass under it, a rolling bass with a clap,
    # toms on the sixteenths between, a quiet rolling bass with no clap
    y, beats = pattern_track(126.0, 48, FOUR, **kw)
    g = _grid(y, 126.0)
    assert not g["unsure_phase"] and g["confidence"] >= BEAT_CONFIDENT
    assert _phase_ms(g, beats, 126.0) < 20


@pytest.mark.parametrize("kw", [{"rumble": 0.08}, {"rumble": 0.05, "bass": OFF_BEAT_BASS, "bass_level": 0.5},
                                {"toms": (1, 3), "tom_level": 0.3},
                                {"bass": (2, 3, 6, 7, 10, 11, 14, 15), "bass_level": 0.5}])
def test_never_confidently_on_the_wrong_line(kw):
    # a kick's low reverb rumble, toms on the off-sixteenths, a "donk" bass:
    # a grid off the kick is never trusted. (A rumble still holds some grids
    # that are on the kick: the reverb smears the kick's falling pitch; the
    # HANDOFF has the numbers)
    for bpm in (124.0, 130.0):
        y, beats = pattern_track(bpm, 48, FOUR, seed=1, **kw)
        g = _grid(y, bpm)
        if _phase_ms(g, beats, bpm) > 20:
            assert g["confidence"] < BEAT_CONFIDENT, (kw, bpm)


def test_the_kicks_onsets_are_told_from_a_bass_notes():
    import numpy as np

    y, beats = pattern_track(126.0, 48, FOUR, bass=OFF_BEAT_BASS, bass_level=0.5)
    feat = grid._features(y)
    period = 60.0 / 126.0
    assert grid.kick_onsets(feat, np.asarray(beats))
    assert not grid.kick_onsets(feat, np.asarray(beats) + period / 2.0)  # on the bass
