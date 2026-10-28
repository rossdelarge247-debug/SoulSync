"""How well core/dj/grid.py finds the beat, the bars and the phrases, on
generated dance tracks with a known answer (tests/dj/grid_fixtures.py: a kick
on every beat, the one accented, off-beat hats and bass, chords that turn on
the bar, sections that change every 16 or 32 bars). No real music.

The tolerances are what the engine needs: every beat of a steady grid within
5 ms of the truth (a flam starts to be heard around 10 ms), a drifting
track's beats within 10 ms, the first downbeat on the right beat, and section
changes on the right bar."""

from __future__ import annotations

import numpy as np
import pytest

from core.dj import grid

from .grid_fixtures import SR, dance_track

STEADY = [
    dict(bpm=124.0),
    dict(bpm=128.0, lead_in=0.37),
    dict(bpm=100.5, lead_in=1.1),
    dict(bpm=174.0),
    dict(bpm=140.0, sections=(("intro", 8), ("groove", 16), ("breakdown", 8), ("drop", 16), ("outro", 8))),
]


def _grid_of(result):
    return grid.Grid(kind=result["kind"], period=result["period"], first_beat=result["first_beat"],
                     downbeat_index=result["downbeat_index"], beats=result["beats"])


def _beat_errors(result, truth_beats):
    g = _grid_of(result)
    est = np.array([g.beat(i) for i in range(-2, len(truth_beats) + 8)])
    return np.array([np.min(np.abs(est - b)) for b in truth_beats])


@pytest.mark.parametrize("case", STEADY, ids=[f"{c['bpm']}bpm" for c in STEADY])
def test_a_steady_track_is_a_constant_grid_on_every_beat(case):
    y, truth = dance_track(**case)
    r = grid.analyze_audio(y, SR)
    assert r["status"] == "done" and r["kind"] == "constant" and r["beats"] is None
    assert r["bpm"] == pytest.approx(case["bpm"], abs=0.02)
    errors = _beat_errors(r, truth["beats"])
    assert errors.max() < 0.005, f"worst beat {errors.max() * 1000:.1f} ms"
    assert r["first_downbeat"] == pytest.approx(truth["downbeats"][0], abs=0.005)
    assert r["beat_confidence"] >= 0.7 and r["downbeat_confidence"] >= 0.6 and r["meter"] == "4/4"
    assert r["bars"] == truth["bars"]


def test_the_stage_one_bpm_is_only_where_to_look():
    y, truth = dance_track(124.0)
    for hint in (124, 62, 127, 121.5):  # exact, half time, 2.4% and 2% out
        r = grid.analyze_audio(y, SR, bpm_hint=hint)
        assert r["bpm"] == pytest.approx(124.0, abs=0.02), hint
        assert _beat_errors(r, truth["beats"]).max() < 0.005


def test_a_wrong_tag_far_from_the_tempo_is_overruled():
    y, _truth = dance_track(124.0)
    assert grid.analyze_audio(y, SR, bpm_hint=100.0)["bpm"] == pytest.approx(124.0, abs=0.02)


@pytest.mark.parametrize("start,end", [(122.0, 127.0), (126.0, 124.0)])
def test_a_drifting_tempo_keeps_its_beats(start, end):
    y, truth = dance_track(start, end_bpm=end)
    r = grid.analyze_audio(y, SR)
    assert r["kind"] == "beats" and r["beats"]
    errors = _beat_errors(r, truth["beats"])
    # the breakdown has no kick: its beats are drawn between the ones around it
    assert errors.max() < 0.010, f"worst beat {errors.max() * 1000:.1f} ms"
    assert r["first_downbeat"] == pytest.approx(truth["downbeats"][0], abs=0.01)


def test_sections_phrases_and_mix_regions_of_a_club_track():
    y, truth = dance_track(124.0)
    r = grid.analyze_audio(y, SR)
    assert [c[0] for c in r["changes"]] == truth["section_bars"][1:] == [16, 48, 64, 96]
    assert [s[:3] for s in r["sections"]] == [["intro", 0, 16], ["main", 16, 48], ["breakdown", 48, 64],
                                             ["drop", 64, 96], ["outro", 96, 112]]
    assert all(0 < s[3] <= 1 for s in r["sections"])
    phrases = {p[0]: (p[1], p[2]) for p in r["phrases"]}
    assert sorted(phrases) == list(range(0, 112, 8))
    assert phrases[16] == (32, 1) and phrases[48] == (32, 1) and phrases[96] == (32, 1)
    assert phrases[32] == (16, 0) and phrases[24] == (8, 0) and phrases[0] == (16, 0)
    assert r["mix_in"][:2] == [0, 16] and r["mix_in"][3] == "intro" and r["mix_in"][2] >= 0.7
    assert r["mix_out"][:2] == [96, 112] and r["mix_out"][3] == "outro" and r["mix_out"][2] >= 0.7


def test_an_odd_length_section_restarts_the_phrases():
    y, truth = dance_track(126.0, sections=(("intro", 16), ("groove", 28), ("breakdown", 16), ("drop", 32),
                                            ("outro", 16)))
    r = grid.analyze_audio(y, SR)
    assert [c[0] for c in r["changes"]] == [16, 44, 60, 92]
    bars = [p[0] for p in r["phrases"]]
    assert 44 in bars and 52 in bars and 40 in bars and 48 not in bars


def test_a_track_that_opens_on_beat_two_still_finds_the_one():
    y, truth = dance_track(124.0, lead_in=0.2)
    cut = 0.2 + 60 / 124.0  # the first beat is cut away: the audio starts on beat two
    r = grid.analyze_audio(y[int(cut * SR):], SR)
    assert r["downbeat_index"] == 3
    assert r["first_downbeat"] == pytest.approx(truth["downbeats"][1] - cut, abs=0.005)
    # the sections are a bar earlier in this numbering, and stay there
    assert [c[0] for c in r["changes"]] == [15, 47, 63, 95]
    assert 7 in [p[0] for p in r["phrases"]]


def test_without_an_accent_the_harmony_still_finds_the_one():
    y, truth = dance_track(124.0, accent=False)
    r = grid.analyze_audio(y, SR)
    assert r["first_downbeat"] == pytest.approx(truth["downbeats"][0], abs=0.005)
    assert r["downbeat_confidence"] >= 0.5


def test_a_waltz_says_it_isnt_four_four():
    y, _truth = dance_track(150.0, sections=(("intro", 16), ("groove", 48), ("outro", 16)), beats_per_bar=3)
    r = grid.analyze_audio(y, SR)
    assert r["meter"] == "not_4_4" and r["downbeat_confidence"] <= 0.2


def test_a_pad_without_a_beat_has_no_grid():
    y, _truth = dance_track(120.0, sections=(("pad", 40),))
    r = grid.analyze_audio(y, SR)
    assert r["status"] == "none" and r["reason"] == "no_beat" and r["beat_confidence"] < grid.MIN_BEAT_CONFIDENCE


def test_too_short_and_silence():
    y, _truth = dance_track(124.0, sections=(("intro", 8),))
    assert grid.analyze_audio(y, SR)["reason"] == "too_short"
    assert grid.analyze_audio(np.zeros(SR * 40, dtype=np.float32), SR)["status"] == "none"


def test_only_the_start_analysed_has_no_outro():
    y, _truth = dance_track(124.0, sections=(("intro", 16), ("groove", 48), ("outro", 16)))
    r = grid.analyze_audio(y[:SR * 100], SR, truncated=True)
    assert r["truncated"] is True and r["mix_out"] is None
    assert all(s[0] != "outro" for s in r["sections"])
    assert r["mix_in"][3] == "intro"


def test_another_sample_rate_is_resampled():
    y, truth = dance_track(124.0, sections=(("intro", 16), ("groove", 16)))
    import librosa

    y44 = librosa.resample(y, orig_sr=SR, target_sr=44100)
    r = grid.analyze_audio(y44, 44100)
    assert r["bpm"] == pytest.approx(124.0, abs=0.02)
    assert _beat_errors(r, truth["beats"]).max() < 0.005


def test_the_grid_reads_back_as_times():
    g = grid.Grid(kind="constant", period=0.5, first_beat=0.25, downbeat_index=2)
    assert g.beat(0) == 0.25 and g.bar(0) == 1.25 and g.bar(2) == 5.25
    assert g.bar_at(5.25) == pytest.approx(2.0)
    drift = grid.Grid(kind="beats", period=0.5, first_beat=0.0, downbeat_index=0, beats=[0.0, 0.5, 1.1, 1.6])
    assert drift.beat(2) == 1.1 and drift.beat(2.5) == pytest.approx(1.35)
    assert drift.beat(5) == pytest.approx(2.6)  # carried on at the last gap
    assert drift.bar_at(1.1) == pytest.approx(0.5)


def test_phrases_count_back_from_the_first_change_and_skip_stubs():
    assert grid.phrases_from([], 20) == [[0, 32, 0], [8, 8, 0], [16, 16, 0]]
    assert grid.phrases_from([12], 30)[:3] == [[4, 8, 0], [12, 32, 1], [20, 8, 0]]
    # a phrase 2 bars before the next change isn't one
    assert [p[0] for p in grid.phrases_from([16, 26], 40)] == [0, 8, 16, 26, 34]


# ── noise gets no grid (gauntlet M2) ─────────────────────────────────────────

def _noise(kind: str, seed: int) -> np.ndarray:
    from scipy.signal import lfilter

    rng = np.random.default_rng(seed)
    white = rng.standard_normal(SR * 120)
    if kind == "white":
        y = white
    elif kind == "pink":  # Kellet's filter: -3 dB an octave
        y = lfilter([0.049922035, -0.095993537, 0.050612699, -0.004408786],
                    [1, -2.494956002, 2.017265875, -0.522189400], white)
    elif kind == "brown":
        y = np.cumsum(white)
    else:  # clicks at random times, about three a second
        y = np.zeros(SR * 120)
        y[rng.integers(0, len(y), 360)] = 1.0
    return (y / np.max(np.abs(y)) * 0.9).astype(np.float32)


@pytest.mark.gauntlet
@pytest.mark.parametrize("kind", ["white", "pink", "brown", "clicks"])
@pytest.mark.parametrize("seed", [0, 1, 2])
def test_noise_has_no_grid_to_mix_on(kind, seed):
    from core.dj import grid_store

    r = grid.analyze_audio(_noise(kind, seed), SR)
    assert r["status"] == "none" or r["beat_confidence"] < grid_store.BEAT_CONFIDENT, r


@pytest.mark.gauntlet
def test_noise_through_the_planner_falls_back():
    from core.dj import grid_store, planner

    from .test_planner import _row, _track

    r = grid.analyze_audio(_noise("pink", 4), SR)
    assert r["status"] == "none" and r["reason"] == "no_beat"
    row = {"grid_version": grid.GRID_VERSION, "status": "none", "reason": r["reason"],
           "beat_confidence": r.get("beat_confidence")}
    assert grid_store.public(row, "2")["reason"] == "no_beat"
    p = planner.plan(_track(_row(124.0)), _track(row, title="Static", tid="2"), style="long_blend")
    assert p["status"] == "cut" and p["fallback"]["reason"] == "Static has no steady beat"


@pytest.mark.gauntlet
def test_a_long_drift_still_keeps_its_beats_and_long_noise_still_has_none():
    """Over ten minutes a 122 → 127 BPM ramp fits no single tempo (its
    whole-track alignment is under noise's threshold), so the noise check
    is made half a minute at a time."""
    sections = (("intro", 16), ("groove", 96), ("breakdown", 16), ("drop", 160), ("outro", 16))
    y, truth = dance_track(122.0, sections, end_bpm=127.0)
    y = y[:SR * 600]
    r = grid.analyze_audio(y, SR, truncated=True)
    assert r["status"] == "done" and r["kind"] == "beats"
    beats = np.asarray(truth["beats"])
    assert _beat_errors(r, beats[beats < 599.0]).max() < 0.010
    noise = np.random.default_rng(0).standard_normal(SR * 600).astype(np.float32)
    assert grid.analyze_audio(noise, SR, truncated=True)["status"] == "none"


# ── syncopated breaks (stage A's re-review, L4) ──────────────────────────────

BREAKS = [dict(bpm=165.0), dict(bpm=136.0), dict(bpm=172.0, hint=False), dict(bpm=160.0, lead_in=0.5)]


@pytest.mark.parametrize("case", BREAKS, ids=[f"{c['bpm']}bpm" for c in BREAKS])
def test_an_amen_style_break_is_on_the_beat_not_on_the_kicks(case):
    """An Amen-style break puts more kicks on the "and"s than on the beat:
    the kick comb alone locked half a beat (or a sixteenth) off, at up to
    0.51 confidence, which the planner would have beat-matched. The
    backbeat (the snare on two and four) puts it back on the beat, and a
    break's grid stays under the planner's bar, so the pair echoes out."""
    from core.dj import grid_store

    from .grid_fixtures import break_track

    y, truth = break_track(case["bpm"], lead_in=case.get("lead_in", 0.0))
    r = grid.analyze_audio(y, SR, bpm_hint=None if case.get("hint") is False else case["bpm"])
    assert r["status"] == "done", r
    errors = _beat_errors(r, truth["beats"])
    assert np.median(errors) < 0.004 and errors.max() < 0.005, f"worst beat {errors.max() * 1000:.1f} ms"
    assert grid.MIN_BEAT_CONFIDENCE <= r["beat_confidence"] < grid_store.BEAT_CONFIDENT


def test_a_break_is_not_beat_matched_in_the_planner():
    from core.dj import planner

    from .grid_fixtures import break_track
    from .test_planner import _row, _track

    y, _ = break_track(165.0)
    r = grid.analyze_audio(y, SR, bpm_hint=165.0)
    incoming = _track(_row(165.0, first=r["first_downbeat"], conf=r["beat_confidence"]), title="Amen", tid="2")
    p = planner.plan(_track(_row(165.0)), incoming, style="long_blend")
    # held under 0.5 (311): not beat-matched; the outgoing track is ready, so 302's cut
    assert p["status"] == "cut" and p["fallback"]["code"] == "low_confidence"
    assert p["fallback"]["reason"] == "Amen has no steady beat"


@pytest.mark.parametrize("case", [dict(fn="dance", bpm=124.0), dict(fn="dance", bpm=128.0, lead_in=0.37),
                                  dict(fn="two_step", bpm=132.0), dict(fn="two_step", bpm=134.0, swing=0.25)],
                         ids=["house124", "house128", "two_step132", "two_step134_swung"])
def test_four_on_the_floor_and_two_step_stay_within_4_ms(case):
    """The sixteenth check never moves a grid that's on the beat: the kick
    on every beat (and two-step's kick on the one with the snare on two and
    four) scores far ahead of every other sixteenth."""
    from .grid_fixtures import break_track

    if case["fn"] == "dance":
        y, truth = dance_track(case["bpm"], lead_in=case.get("lead_in", 0.0))
    else:
        y, truth = break_track(case["bpm"], pattern="two_step", swing=case.get("swing", 0.0))
    r = grid.analyze_audio(y, SR, bpm_hint=case["bpm"])
    assert r["status"] == "done"
    assert _beat_errors(r, truth["beats"]).max() < 0.004


def test_the_sixteenth_check_scores():
    """On a club track the beat leads every other sixteenth by a wide
    margin; on a break the check moves the comb's grid half a beat."""
    from .grid_fixtures import break_track

    y, truth = dance_track(124.0)
    feat = grid._features(y)
    shift, margin = grid.sixteenth_check(feat, truth["beats"])
    assert shift == 0 and margin > 2.0
    y, truth = break_track(165.0)
    feat = grid._features(y)
    off = np.asarray(truth["beats"]) + 60.0 / 165.0 / 2  # the kicks' line, half a beat on
    shift, margin = grid.sixteenth_check(feat, off)
    assert shift == 2 and margin > grid.AMBIGUOUS_MARGIN
