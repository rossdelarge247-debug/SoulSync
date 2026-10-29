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
    # an Amen break's kick is on some beats only: not four on the floor; the
    # sixteenth check moves its grid half a beat onto the beat, and since grid
    # v5 a grid moved half a beat is trusted (real breaks so moved were on the
    # beat 5 times in 6: HANDOFF, 29 October)
    import numpy as np

    y, truth = break_track(170.0, bars=48, pattern="amen")
    feat = grid._features(y)
    assert not grid.four_on_the_floor(feat, np.asarray(truth["beats"]))
    r = grid.beat_grid(feat, 170.0)
    assert r["sixteenth"] == 2 and r["confidence"] >= BEAT_CONFIDENT
    assert _phase_ms(r, truth["beats"], 170.0) < 15
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


#: the known limit of grid v5 (HANDOFF, 29 October): a generated bass louder
#: than a generated kick, with no clap or snare to tell them apart (the kick
#: has a click since the review round; it doesn't settle these).
#: Grid v4's phase follow-up held these by the kick's falling pitch and short
#: sub; on real tracks that test called 7 kicks in 16 a bass and held them,
#: and moved two real grids the wrong way, so it's gone. The independent
#: tracker hears the bass too, so these may be trusted on the bass: strict
#: xfails, so a fix shows
BASS_OVER_KICK = pytest.mark.xfail(strict=True, reason="grid v5 known limit: a bass louder than the kick")
OFF_BEAT_CASES = [
    # a bass-only intro: the agreement and the phase are taken only where
    # the drums play (grid v5's review, M2), so the intro no longer leads
    {"bass_level": 0.5, "drumless_bars": 40},
    {"bass_level": 0.5, "drumless_bars": 16},
    {"bass_level": 0.8},                                            # as loud as the kick in the low band
    pytest.param({"bass_level": 1.0}, marks=BASS_OVER_KICK),       # louder
    pytest.param({"bass_level": 1.5}, marks=BASS_OVER_KICK),       # much louder
]


@pytest.mark.parametrize("kw", [{"bass_level": 0.5, "drumless_bars": 40}, {"bass_level": 0.8}, {"bass_level": 1.5}])
def test_a_kick_and_an_off_beat_bass_put_the_grid_on_one_of_them(kw):
    # whichever line the grid takes, it's a whole line: the bars, phrases and
    # cuts land on the kick or half a beat from it, never between
    y, beats = pattern_track(124.0, 64, FOUR, bass=OFF_BEAT_BASS, **kw)
    g = _grid(y, 124.0)
    assert g["kind"] == "constant"
    half = 1000 * 30.0 / 124.0
    assert min(_phase_ms(g, beats, 124.0), abs(_phase_ms(g, beats, 124.0) - half)) < 20


@pytest.mark.parametrize("kw", OFF_BEAT_CASES)
def test_a_kick_and_an_off_beat_bass_with_no_backbeat_are_never_trusted_on_the_bass(kw):
    # M1: a grid on the bass may be kept (cuts and the bars still use it) but
    # only under the bar
    y, beats = pattern_track(124.0, 64, FOUR, bass=OFF_BEAT_BASS, **kw)
    g = _grid(y, 124.0)
    assert g["kind"] == "constant"
    if _phase_ms(g, beats, 124.0) > 20:
        assert g["confidence"] < BEAT_CONFIDENT


@pytest.mark.parametrize("pattern,bpm,kw", [
    (DNB, 174.0, {}),
    (DNB, 174.0, {"bass": OFF_BEAT_BASS, "bass_level": 0.4}),
    (HALF_TIME, 140.0, {"bass": OFF_BEAT_BASS, "bass_level": 0.5, "snare_low": 1.5}),
])
def test_breaks_drum_and_bass_and_half_time_are_on_the_beat_and_ready(pattern, bpm, kw):
    # not four on the floor, on the beat; a half-beat move no longer caps
    # them under the bar (grid v5)
    y, beats = pattern_track(bpm, 64, pattern, **kw)
    g = _grid(y, bpm)
    assert not g["four_on_the_floor"]
    assert _phase_ms(g, beats, bpm) < 15
    assert g["confidence"] >= BEAT_CONFIDENT


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


@pytest.mark.parametrize("bpm,level,kick", [pytest.param(126.0, 1.0, 0.9, marks=BASS_OVER_KICK),
                                            pytest.param(128.0, 1.2, 0.9, marks=BASS_OVER_KICK),
                                            pytest.param(128.0, 1.0, 0.5, marks=BASS_OVER_KICK)])
def test_a_rolling_bass_with_no_backbeat_is_never_trusted_to_beat_match(bpm, level, kick):
    # the low band is busy on every sixteenth: the comb's line was a bass note
    # a sixteenth off the kick, at 0.98-0.99. A grid off the kick must stay
    # under the bar (these don't: the known limit above)
    y, beats = pattern_track(bpm, 48, FOUR, bass=ROLLING_316, bass_level=level, kick=kick)
    g = _grid(y, bpm)
    assert g["kind"] == "constant"
    if _phase_ms(g, beats, bpm) > 20:
        assert g["confidence"] < BEAT_CONFIDENT


@pytest.mark.parametrize("bpm,kick", [(118.0, 0.5), (126.0, 0.5), (134.0, 0.5), (140.0, 0.5), (134.0, 0.9)])
def test_a_rolling_pluck_bass_is_held_because_its_tempo_is_unsure(bpm, kick):
    # the second review: a pluck bass (its pitch drops like a kick's) on the
    # three sixteenths between the kicks. The grid lands on a pluck, a
    # sixteenth off the kick, and the agreement can't tell (its low band
    # follows the plucks, its upper band the kick's click: 0.5). What holds
    # it is real and said here (grid v5's review, L4): with an onset as
    # strong on every sixteenth, a grid every three sixteenths (4/3 of the
    # tempo) fits the onsets as well, so the tempo isn't sure (TEMPO_TIE)
    y, beats = pattern_track(bpm, 48, FOUR, bass=ROLLING_316, bass_level=1.0, kick=kick, bass_kind="pluck")
    g = _grid(y, bpm)
    assert g["kind"] == "constant"
    assert g["unsure_tempo"] and g["confidence"] < BEAT_CONFIDENT


@pytest.mark.parametrize("kw", [{}, {"bass": OFF_BEAT_BASS, "bass_level": 0.4},
                                {"bass": OFF_BEAT_BASS, "bass_level": 0.6},
                                {"bass": ROLLING_316, "bass_level": 1.0, "claps": True},
                                # the follow-up's review: low percussion and a quiet rolling bass
                                {"toms": (1, 2, 3), "tom_level": 0.3},
                                {"toms": (1, 2, 3), "tom_level": 0.15, "bass": OFF_BEAT_BASS, "bass_level": 0.4},
                                {"bass": ROLLING_316, "bass_level": 0.25},
                                # the second review: a pluck bass off the beat
                                {"bass": OFF_BEAT_BASS, "bass_level": 0.9, "bass_kind": "pluck"},
                                {"bass": OFF_BEAT_BASS, "bass_level": 1.5, "bass_kind": "pluck"}])
def test_ordinary_four_on_the_floor_is_still_ready(kw):
    # a kick alone, an off-beat bass under it, a rolling bass with a clap,
    # toms on the sixteenths between, a quiet rolling bass with no clap
    y, beats = pattern_track(126.0, 48, FOUR, **kw)
    g = _grid(y, 126.0)
    assert g["confidence"] >= BEAT_CONFIDENT
    assert _phase_ms(g, beats, 126.0) < 20


@pytest.mark.parametrize("kw", [{"rumble": 0.08},
                                {"rumble": 0.05, "bass": OFF_BEAT_BASS, "bass_level": 0.5},
                                {"toms": (1, 3), "tom_level": 0.3},
                                pytest.param({"bass": (2, 3, 6, 7, 10, 11, 14, 15), "bass_level": 0.5},
                                             marks=BASS_OVER_KICK)])
def test_never_confidently_on_the_wrong_line(kw):
    # a kick's low reverb rumble, toms on the off-sixteenths, a "donk" bass:
    # a grid off the kick is never trusted (a donk louder than the clickless
    # kick is the known limit)
    for bpm in (124.0, 130.0):
        y, beats = pattern_track(bpm, 48, FOUR, seed=1, **kw)
        g = _grid(y, bpm)
        if _phase_ms(g, beats, bpm) > 20:
            assert g["confidence"] < BEAT_CONFIDENT, (kw, bpm)


def test_the_agreement_tells_the_kick_from_an_off_beat_bass_under_it():
    # an independent tracker agrees with a grid on the kick, not with one on
    # a quieter off-beat bass (grid v5's phase check, in place of the kick's
    # onset shape)
    import numpy as np

    y, beats = pattern_track(126.0, 48, FOUR, bass=OFF_BEAT_BASS, bass_level=0.5)
    feat = grid._features(y)
    period = 60.0 / 126.0
    assert grid._agreement(feat, np.asarray(beats), period) >= 0.8
    assert grid._agreement(feat, np.asarray(beats) + period / 2.0, period) <= 0.2
