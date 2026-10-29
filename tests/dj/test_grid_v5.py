"""Grid v5 (HANDOFF, "Dev, beat grids on real audio of 29 October"): measured
on real tracks, the beat's confidence is the hit rate with an independent
tracker's agreement, the BPM hint is a prior rather than a fence, a slow
hint on drum and bass is doubled, and the downbeat follows the kick. The
real-audio bench itself runs on local files (scripts/grid_bench.py); these
are its rules on generated audio."""

from __future__ import annotations

import numpy as np
import pytest

from core.dj import grid, planner

from .grid_fixtures import FOUR, OFF_BEAT_BASS, SR, dance_track, pattern_track

pytestmark = pytest.mark.gauntlet


# ── the confidence ───────────────────────────────────────────────────────────

def test_a_grid_no_tracker_agrees_with_is_never_ready():
    # every onset on a beat and no agreement: under the bar
    assert grid._confidence(1.0, 0.0) < grid.BEAT_CONFIDENT
    assert grid._confidence(1.0, 1.0) == pytest.approx(1.0)
    # real tracks' grids on the beat (hits 0.58-0.84, agreement 0.72-1.0) are ready
    assert grid._confidence(0.58, 0.72) >= grid.BEAT_CONFIDENT


def test_the_agreement_counts_for_little_where_the_beats_have_no_onsets():
    # a tracker held to a tempo lays even beats over a pad: that's no evidence
    assert grid._confidence(0.26, 0.6) < grid.MIN_BEAT_CONFIDENCE
    full = grid.HIT_WEIGHT * 0.26 + (1 - grid.HIT_WEIGHT) * 0.6
    assert grid._confidence(0.26, 0.6) < full - 0.1


def test_the_agreement_hears_a_grid_a_sixteenth_or_half_a_beat_off():
    y, beats = pattern_track(126.0, 48, FOUR, bass=OFF_BEAT_BASS, bass_level=0.4)
    feat = grid._features(y)
    beats = np.asarray(beats)
    period = 60.0 / 126.0
    assert grid._agreement(feat, beats, period) >= 0.8
    for shift in (period / 4.0, period / 2.0, 3 * period / 4.0):
        assert grid._agreement(feat, beats + shift, period) <= 0.2, shift


def test_the_agreement_doesnt_lean_towards_the_grid_it_checks():
    # its windows are at fixed times: a grid shifted by a fraction of a beat
    # isn't agreed with because the tracker started on it
    y, beats = pattern_track(124.0, 48, FOUR)
    feat = grid._features(y)
    period = 60.0 / 124.0
    found = [grid._agreement(feat, np.asarray(beats) + k * period / 8.0, period) for k in range(8)]
    assert found[0] >= 0.8 and max(found[2:7]) <= 0.2, found


def test_a_steady_house_track_says_why_it_is_sure():
    y, _ = pattern_track(124.0, 48, FOUR, claps=True)
    g = grid.beat_grid(grid._features(y), 124.0)
    assert g["hits"] >= 0.9 and g["agreement"] >= 0.8 and g["confidence"] >= 0.9
    assert not g["unsure_tempo"]


# ── the tempo: the hint is a prior ───────────────────────────────────────────

@pytest.mark.parametrize("hint", [93.0, 165.3, 186.0, 82.7])  # 3/4, 4/3, 3/2 and 2/3 of 124
def test_a_hint_at_a_related_tempo_doesnt_fence_the_grid_in(hint):
    # a hint 4/3 or 2/3 off used to keep the grid within 4% of itself, where
    # no beat was found (real tracks of 29 October: Springtime, Mecha-Tribe)
    y, truth = dance_track(124.0)
    r = grid.analyze_audio(y, SR, bpm_hint=hint)
    assert r["status"] == "done" and r["bpm"] == pytest.approx(124.0, abs=0.05), (hint, r.get("bpm"))


def test_a_right_hint_stands():
    y, _ = dance_track(124.0)
    assert grid.analyze_audio(y, SR, bpm_hint=124.0)["bpm"] == pytest.approx(124.0, abs=0.02)


def test_a_tempo_that_ties_with_a_related_one_isnt_sure():
    # onsets on every sixteenth: a grid at 3/4 of the period (4/3 the tempo)
    # catches as many as the beat's
    period = 60.0 / 120.0
    times = np.arange(16, 960) * period / 4.0
    weights = np.ones_like(times)
    assert grid._tempo_unsure(times, weights, period)
    # the kick on every beat, louder than the hats between: sure
    weights = np.where(np.arange(16, 960) % 4 == 0, 1.0, 0.15)
    assert not grid._tempo_unsure(times, weights, period)


# ── drum and bass under a slow hint ──────────────────────────────────────────

@pytest.fixture(scope="module")
def dnb():
    from .tempo_fixtures import DNB_TWO_STEP, drum_track

    y, _ = drum_track(172.0, 48, DNB_TWO_STEP, hats="8", bass="reese", seed=12)
    return grid._features(y)


def test_a_slow_hint_on_drum_and_bass_is_doubled_whatever_the_backbeat_vote(dnb, monkeypatch):
    # Andy C's Heartbeat Loud read 87 under a hint of 87: the backbeat vote
    # said "slow", while the grid's own scan read 174. A hint at 82-89 is
    # doubled when the scan reads the double, whatever the vote (on these
    # generated tracks the scan reads 129, so it's set as the real one read)
    from core.sample import tempo

    monkeypatch.setattr(tempo, "backbeat", lambda *a, **k: {"vote": "slow", "fast": 0.2, "slow": 0.72})
    scan = grid._scan_tempo
    monkeypatch.setattr(grid, "_scan_tempo", lambda t, w: (172.1, scan(t, w)[1]))
    assert grid.beat_grid(dnb, 86.0)["bpm"] == pytest.approx(172.0, abs=0.2)
    assert grid.beat_grid(dnb, 86.0, ["Hip Hop"])["bpm"] == pytest.approx(86.0, abs=0.2)
    # outside drum and bass's half (82-89), a slow hint stands: boom bap at 76
    monkeypatch.setattr(grid, "_scan_tempo", lambda t, w: (152.0, scan(t, w)[1]))
    assert grid._pick_tempo(dnb, grid.beat_envelope(dnb), *grid._onsets(grid.beat_envelope(dnb)), 76.0) != 152.0


def test_a_slow_genre_keeps_a_slow_hint_and_a_fast_one_doubles_it(dnb):
    assert grid.beat_grid(dnb, 86.0, ["Hip Hop"])["bpm"] == pytest.approx(86.0, abs=0.2)
    assert grid.beat_grid(dnb, 86.0, ["Drum & Bass"])["bpm"] == pytest.approx(172.0, abs=0.2)


def test_the_worker_gives_the_grid_the_files_genre(tmp_path, monkeypatch):
    from core.dj import worker
    from core.sample import tempo

    seen = {}
    monkeypatch.setattr(tempo, "file_genres", lambda path: ["Drum & Bass"])

    def fake(y, rate, **kw):
        seen.update(kw)
        return {"status": "none", "reason": "no_beat"}

    monkeypatch.setattr("core.dj.grid.analyze_audio", fake)
    worker._default_grid(str(tmp_path / "x.flac"), audio=(np.zeros(SR * 30, np.float32), SR), bpm_hint=87.0)
    assert seen["genres"] == ["Drum & Bass"] and seen["bpm_hint"] == 87.0


# ── downbeats ────────────────────────────────────────────────────────────────

def test_the_downbeat_follows_the_kick_then_the_harmony():
    # a kick as loud on every beat: the one is where the chord turns (grid
    # v4's salience also counted the whole spectrum's attack and the timbre's
    # change, which on real tracks follow the clap on two and four: it agreed
    # with an independent tracker on 12 of 39, the kick and harmony on 26)
    y, beats = pattern_track(124.0, 48, FOUR)
    down = grid.downbeats(grid._features(y), np.asarray(beats))
    assert down["phase"] == 0 and down["meter"] == "4/4"
    assert down["confidence"] >= 0.6
    # an accented kick on the one (the generated club track) says it too
    y, truth = dance_track(124.0)
    r = grid.analyze_audio(y, SR)
    assert r["first_downbeat"] == pytest.approx(truth["downbeats"][0], abs=0.005)


def test_the_downbeats_confidence_is_how_steadily_the_bars_agree():
    rng = np.random.default_rng(0)
    steady = np.tile([2.0, 0.0, 0.3, 0.0], 64) + rng.normal(0, 0.2, 256)
    assert grid._window_agreement(steady, 0) == pytest.approx(1.0)
    assert grid._window_agreement(steady, 1) == 0.0
    noise = rng.normal(0, 1, 256)
    assert grid._window_agreement(noise, int(np.argmax([noise[p::4].mean() for p in range(4)]))) < 0.6


def test_an_unsure_downbeat_never_stops_a_beat_match():
    # the downbeat only places the bars and phrases (the plan says so), the
    # beat's confidence alone decides the beat-match
    from .test_planner import _row, _track

    assert grid.beatmatch_problem(0.9, "4/4") is None
    out = _track(_row(124.0, dconf=0.0))
    incoming = _track(_row(124.0, dconf=0.0), title="Second", tid="2")
    p = planner.plan(out, incoming, style="long_blend")
    assert p["status"] == "ok" and p["beatmatch"] and p["unsure_bars"]
