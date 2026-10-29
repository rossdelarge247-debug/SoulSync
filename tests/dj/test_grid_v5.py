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

from .grid_fixtures import DNB, FOUR, OFF_BEAT_BASS, SR, dance_track, pattern_track

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


def test_a_slow_hint_in_drum_and_bass_s_half_needs_drum_and_bass_to_double(dnb, monkeypatch):
    # Andy C's Heartbeat Loud read 87 under a hint of 87. Doubling any hint at
    # 82-89 that the scan read at twice made boom bap and hip hop at 85 into
    # 170 (grid v5's review, H2): the scan's double alone isn't enough.
    # Drum and bass's drums at the double (``drum_and_bass_beats``; the
    # backbeat vote said "slow" on real drum and bass: its second review) or
    # a drum and bass genre is
    from core.sample import tempo

    # (the generated track's backbeat votes "fast"; real drum and bass's said "slow")
    monkeypatch.setattr(tempo, "backbeat", lambda *a, **k: {"vote": "slow", "fast": 0.2, "slow": 0.72})
    scan = grid._scan_tempo
    monkeypatch.setattr(grid, "_scan_tempo", lambda t, w: (172.1, scan(t, w)[1]))
    monkeypatch.setattr(grid, "drum_and_bass_beats", lambda *a, **k: False)
    assert grid.beat_grid(dnb, 86.0)["bpm"] == pytest.approx(86.0, abs=0.2)
    assert grid.beat_grid(dnb, 86.0, ["Drum And Bass"])["bpm"] == pytest.approx(172.0, abs=0.2)
    monkeypatch.setattr(grid, "drum_and_bass_beats", lambda *a, **k: True)
    assert grid.beat_grid(dnb, 86.0)["bpm"] == pytest.approx(172.0, abs=0.2)
    assert grid.beat_grid(dnb, 86.0, ["Hip Hop"])["bpm"] == pytest.approx(86.0, abs=0.2)
    # outside drum and bass's half (82-89), a slow hint stands: boom bap at 76
    monkeypatch.setattr(grid, "drum_and_bass_beats", lambda *a, **k: False)
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


# ── grid v5's review round ───────────────────────────────────────────────────

def test_a_grid_at_an_octave_of_the_raw_hint_is_held_with_no_genre(dnb):
    # H1: the hint said 70 and the grid reads 140 (or the reverse): which is
    # the beat isn't settled, so it waits (Groove hip hop at 70 read at 140)
    beats = np.arange(0, 60, 60 / 140.0)
    assert grid._octave_unsure(dnb, beats, 140.0, None, 70.0)
    assert grid._octave_unsure(dnb, beats, 140.0, None, 280.0)
    assert not grid._octave_unsure(dnb, beats, 140.0, None, 141.0)
    # a genre says which octave it is
    assert not grid._octave_unsure(dnb, beats, 140.0, "fast", 70.0)


def test_a_slow_genre_halves_a_fast_grid_and_says_nothing_about_a_slow_one():
    assert grid._genre_octave(168.0, "slow") == pytest.approx(84.0)
    assert grid._genre_octave(140.0, "slow") == 140.0
    assert grid._genre_octave(168.0, "fast") == 168.0 and grid._genre_octave(168.0, None) == 168.0


def test_hits_alone_dont_make_a_grid_ready(dnb, monkeypatch):
    # M1: a tracker that doesn't agree (under AGREE_READY) holds the grid
    # however many beats have a hit
    g = grid.beat_grid(dnb, 174.0, ["Drum & Bass"])
    assert g["confidence"] >= grid.BEAT_CONFIDENT
    monkeypatch.setattr(grid, "_agreement_bands", lambda *a, **k: (grid.AGREE_READY - 0.01, 1.0))
    held = grid.beat_grid(dnb, 174.0, ["Drum & Bass"])
    assert held["confidence"] < grid.BEAT_CONFIDENT and held["hits"] >= 0.5
    # M-a: the attack band disagreeing outright holds it too
    monkeypatch.setattr(grid, "_agreement_bands", lambda *a, **k: (0.5, 0.0))
    held = grid.beat_grid(dnb, 174.0, ["Drum & Bass"])
    assert held["confidence"] < grid.BEAT_CONFIDENT


def test_the_agreement_counts_in_full_only_with_hits():
    assert grid._confidence(1.0, 1.0) == pytest.approx(1.0)
    assert grid._confidence(0.25, 1.0) < grid._confidence(0.5, 1.0)
    assert grid._confidence(0.0, 1.0) == pytest.approx(0.0)


def test_the_drums_mask_leaves_out_a_bass_only_intro():
    # M2: the agreement and the phase are taken where the drums play
    y, beats = pattern_track(124.0, 64, FOUR, bass=(2, 6, 10, 14), bass_level=0.5, drumless_bars=16)
    feat = grid._features(y)
    drums = grid._drum_frames(feat)
    assert drums is not None
    intro_end = int(grid._t2f(16 * 4 * 60 / 124.0))
    assert drums[:intro_end - int(grid._t2f(4.0))].mean() < 0.1
    assert drums[intro_end + int(grid._t2f(4.0)):].mean() > 0.9


@pytest.mark.parametrize("kind", ["sine", "chords"])
def test_a_pad_with_no_drums_is_never_ready(kind):
    # M5: a sine pad's tiny flux was scaled up to look like onsets
    sr = SR
    t = np.arange(int(90 * sr)) / sr
    if kind == "sine":
        y = 0.3 * np.sin(2 * np.pi * 220.0 * t)
    else:
        y = sum(0.1 * np.sin(2 * np.pi * f * t) * (1 + 0.5 * np.sin(2 * np.pi * 0.25 * t)) for f in (220, 277, 330))
    r = grid.analyze_audio(y.astype(np.float32), sr)
    assert r["status"] == "none" or r["beat_confidence"] < grid.BEAT_CONFIDENT


def test_a_close_second_phase_caps_the_downbeat_confidence(monkeypatch):
    # M4: a downbeat the second phase nearly matches isn't trusted
    y, truth = dance_track(124.0)
    feat = grid._features(y)
    beats = np.asarray(truth["beats"])
    sure = grid.downbeats(feat, beats)
    assert sure["confidence"] >= 0.5
    monkeypatch.setattr(grid, "_phase_strength", lambda s, n: (sure["phase"], grid.DOWNBEAT_MIN_SEPARATION - 0.1))
    assert grid.downbeats(feat, beats)["confidence"] < 0.3


def test_half_parity_is_the_louder_one_on_a_grid_at_twice_the_tempo():
    # L6: a grid at double tempo has the beats on one parity, hats between
    # (a kick and a clap on the beats, a bass between)
    y, beats = pattern_track(90.0, 48, FOUR, bass=OFF_BEAT_BASS, bass_level=0.8, claps=True)
    feat = grid._features(y)
    beats = np.asarray(beats)
    doubled = np.sort(np.concatenate([beats, beats + 30.0 / 90.0]))
    assert grid.half_parity(feat, doubled) == 0
    assert grid.half_parity(feat, doubled[1:]) == 1
    # nearly an even split (the generated club track's hats and bass between
    # its kicks): None, and halving keeps the downbeat's beats
    y, truth = dance_track(100.0)
    beats = np.asarray(truth["beats"])
    assert grid.half_parity(grid._features(y), np.sort(np.concatenate([beats, beats + 0.3]))) in (None, 0)


def test_the_worker_falls_back_on_enrichments_genres(tmp_path, monkeypatch):
    # L3: a file with no genre tag takes the album's genres, then the artist's
    import sqlite3

    from core.dj import worker
    from core.sample import tempo

    path = tmp_path / "g.db"
    conn = sqlite3.connect(str(path))
    conn.executescript("CREATE TABLE artists (id TEXT, genres TEXT); CREATE TABLE albums (id TEXT, genres TEXT);"
                       "CREATE TABLE tracks (id TEXT, album_id TEXT, artist_id TEXT);"
                       "INSERT INTO artists VALUES ('a', '[\"Drum & Bass\"]'); INSERT INTO albums VALUES ('b', NULL);"
                       "INSERT INTO tracks VALUES ('1', 'b', 'a'); INSERT INTO tracks VALUES ('2', 'x', 'y');")
    conn.commit()
    conn.close()

    class Db:
        def _get_connection(self):
            c = sqlite3.connect(str(path))
            c.row_factory = sqlite3.Row
            return c

    assert worker._library_genres(Db(), "1") == ["Drum & Bass"]
    assert worker._library_genres(Db(), "2") == []
    # the second review (M-c): album and artist merged, generic genres left out
    c = sqlite3.connect(str(path))
    c.executescript("UPDATE albums SET genres = '[\"Electronic\", \"Soul\"]' WHERE id = 'b';")
    c.commit()
    c.close()
    assert worker._library_genres(Db(), "1") == ["Soul", "Drum & Bass"]
    seen = {}
    monkeypatch.setattr(tempo, "file_genres", lambda p: [])
    monkeypatch.setattr("core.dj.grid.analyze_audio", lambda y, rate, **kw: seen.update(kw) or {"status": "none"})
    worker._default_grid(str(tmp_path / "x.flac"), audio=(np.zeros(SR * 30, np.float32), SR), genres=["Hip Hop"])
    assert seen["genres"] == ["Hip Hop"]
    monkeypatch.setattr(tempo, "file_genres", lambda p: ["Drum & Bass"])
    worker._default_grid(str(tmp_path / "x.flac"), audio=(np.zeros(SR * 30, np.float32), SR), genres=["Hip Hop"])
    assert seen["genres"] == ["Drum & Bass"]  # the file's own tag first



# ── grid v5's second review ──────────────────────────────────────────────────

BOOM_BAP = {0: "K", 8: "S", 10: "K"}


def _doubled(beats):
    beats = np.asarray(beats)
    return np.sort(np.concatenate([beats, beats[:-1] + np.diff(beats) / 2.0]))


def test_drum_and_bass_s_drums_say_it_s_fast_and_a_doubled_groove_s_dont():
    # H-new 3: the snare's crack on two and four of the fast bar, against
    # the beat opposite the kick, and the two-step's second kick half a beat
    # after it (Heartbeat Loud 0.46 and 0.79 on real audio)
    y, beats = pattern_track(174.0, 64, DNB)
    assert grid.drum_and_bass_beats(grid._features(y), np.asarray(beats))
    y, beats = pattern_track(87.0, 64, BOOM_BAP)
    assert not grid.drum_and_bass_beats(grid._features(y), _doubled(beats))
    y, beats = pattern_track(87.0, 64, FOUR, claps=True)
    assert not grid.drum_and_bass_beats(grid._features(y), _doubled(beats))


def test_drum_and_bass_s_drums_settle_the_octave_whatever_a_hint_at_half_says(monkeypatch):
    y, beats = pattern_track(174.0, 64, DNB)
    feat = grid._features(y)
    beats = np.asarray(beats)
    assert not grid._octave_unsure(feat, beats, 174.0, None, 87.0)
    monkeypatch.setattr(grid, "drum_and_bass_beats", lambda *a, **k: False)
    assert grid._octave_unsure(feat, beats, 174.0, None, 87.0)


def test_a_tag_or_enrichment_bpm_at_the_grid_s_octave_settles_it(monkeypatch):
    # H-new 2: the DJ data's BPM from a tag or enrichment (not the analysis)
    monkeypatch.setattr(grid, "drum_and_bass_beats", lambda *a, **k: False)
    y, beats = pattern_track(174.0, 64, DNB)
    feat = grid._features(y)
    beats = np.asarray(beats)
    assert grid._octave_unsure(feat, beats, 174.0, None)
    assert not grid._octave_unsure(feat, beats, 174.0, None, None, 174.0)
    assert not grid._octave_unsure(feat, beats, 174.0, None, 174.0, 173.0)
    # at the other octave it's no evidence for this one
    assert grid._octave_unsure(feat, beats, 174.0, None, None, 87.0)
    y, b = pattern_track(87.0, 64, BOOM_BAP)
    slow = grid._features(y)
    assert grid._octave_unsure(slow, np.asarray(b), 87.0, None, None, 174.0)
    assert not grid._octave_unsure(slow, np.asarray(b), 87.0, None, None, 87.0)


def test_a_slow_genre_halves_a_fast_grid_only_without_drum_and_bass_s_drums():
    # L-c: ambient jungle at 170 tagged "Ambient" isn't 85; held instead
    assert grid._genre_octave(170.0, "slow", lambda bpm: True) == 170.0
    assert grid._genre_octave(170.0, "slow", lambda bpm: False) == pytest.approx(85.0)
    beats = np.arange(0, 60, 60 / 170.0)
    assert grid._octave_unsure({}, beats, 170.0, "slow")


def test_a_fast_family_wins_for_a_fast_reading():
    # M-c: liquid drum and bass is often tagged Soul too
    assert grid._family_at({"fast", "slow"}, 174.0) == "fast"
    assert grid._family_at({"fast", "slow"}, 87.0) is None
    assert grid._family_at({"slow"}, 87.0) == "slow"
    assert grid._family_at(set(), 174.0) is None


def test_the_analysis_keeps_each_octaves_confidence(dnb):
    y, beats = pattern_track(174.0, 48, DNB)
    r = grid.analyze_audio(y, SR, bpm_hint=87.0)
    octave = r["octave_confidence"]
    assert set(octave) >= {"1"} and octave["1"] >= r["beat_confidence"]
    assert all(0.0 <= v <= 1.0 for v in octave.values())
