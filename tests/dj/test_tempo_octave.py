"""The tempo's octave (core/sample/tempo.py): drum and bass and its cousins
come out at 160–185, not half that, in the analysis (Sample Studio's and
the DJ data's BPM) and in the beat grid, while house (124), hip hop (90),
dubstep (140) and a 100 BPM track stay where they are.

On generated tracks (tests/dj/tempo_fixtures.py), made in memory at test
time with fixed seeds. Before this rule the analysis read every drum and
bass fixture at 86–89 and the grid followed it (HANDOFF, "Dev, drum and bass
BPM (half-time) fix of 27 October", has the before/after table)."""

from __future__ import annotations

import numpy as np
import pytest

from core.dj import grid
from core.sample import analyze, tempo

from .grid_fixtures import write_wav
from .tempo_fixtures import drum_track, fixtures

DNB = ("dnb_174", "dnb_172_two_step", "dnb_176_roller", "amen_170", "amen_chopped_172", "liquid_174")
#: the analysis reads these at another ratio than an octave (4/5 and 2/3, a
#: tracker's own error this rule doesn't touch); the grid gets them right,
#: and its BPM is the one shown (HANDOFF 300)
NOT_AN_OCTAVE = ("amen_170", "dubstep_140", "dnb_halftime_174")


@pytest.fixture(scope="module")
def made(tmp_path_factory):
    """Each fixture analysed once: ``{name: (truth, analysis, y)}``."""
    folder = tmp_path_factory.mktemp("tempo")
    out = {}
    for name, truth, _genre, y in fixtures():
        result = analyze.analyze_track(write_wav(folder / f"{name}.wav", y), keep_audio=True)
        audio, _sr = result.pop("audio")
        out[name] = (truth, result, audio)
    return out


def _near(value, truth, within=0.03) -> bool:
    return value is not None and abs(float(value) - truth) / truth <= within


# ── the analysis ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", [n for n, *_ in fixtures() if n not in NOT_AN_OCTAVE])
def test_the_analysis_reads_each_fixture_at_its_tempo(made, name):
    truth, result, _ = made[name]
    assert _near(result["bpm"], truth), (name, result["bpm"])
    assert result["analyzer_version"] == analyze.ANALYZER_VERSION == 5


@pytest.mark.parametrize("name", NOT_AN_OCTAVE)
def test_another_ratio_is_never_turned_into_a_wrong_octave(made, name):
    truth, result, _ = made[name]
    # not half, not double: whatever the tracker heard, this rule left alone
    assert not _near(result["bpm"], truth / 2) and not _near(result["bpm"], truth * 2), result["bpm"]


def test_the_files_genre_decides_without_the_backbeat(made, tmp_path, monkeypatch):
    import soundfile as sf
    from mutagen.flac import FLAC

    # as if the backbeat said nothing (half-time drum and bass: its snare is on three)
    monkeypatch.setattr(tempo, "backbeat", lambda *_a, **_k: {"vote": None, "fast": 0.0, "slow": 0.0})
    truth, _result, y = made["dnb_174"]
    path = tmp_path / "dnb.flac"
    sf.write(str(path), y, 22050, format="FLAC", subtype="PCM_16")
    assert _near(analyze.analyze_track(str(path))["bpm"], truth / 2)  # librosa's half time stands
    tags = FLAC(str(path))
    tags["genre"] = "Drum & Bass"
    tags.save()
    assert _near(analyze.analyze_track(str(path))["bpm"], truth)


def test_a_slow_genre_keeps_a_slow_reading(tmp_path):
    import soundfile as sf
    from mutagen.flac import FLAC

    y, _ = drum_track(90.0, 16, ({0: "K", 4: "S", 8: "K", 12: "S"},), hats="8", seed=31)
    path = tmp_path / "hiphop.flac"
    sf.write(str(path), y, 22050, format="FLAC", subtype="PCM_16")
    tags = FLAC(str(path))
    tags["genre"] = "Hip-Hop"
    tags.save()
    assert tempo.file_genres(str(path)) == ["Hip-Hop"]
    assert _near(analyze.analyze_track(str(path))["bpm"], 90.0)


@pytest.mark.parametrize("name", ("hiphop_90_eighths", "dnb_172_two_step"))
def test_a_longer_track_with_splices_reads_the_same(made, tmp_path, name):
    # two minutes of the fixture end to end: the tracker slips a beat at
    # each join, as it does at a real track's pickups and odd bars
    truth, _result, y = made[name]
    long = np.tile(y, 5)[: 120 * 22050]
    assert _near(analyze.analyze_track(write_wav(tmp_path / "long.wav", long))["bpm"], truth)


def test_a_reading_at_100_to_140_comes_back_exactly(made):
    # what lets the re-analysis skip those tracks (database/music_database.py)
    y = made["house_124"][2]
    for raw in (100.0, 117.5, 123.0, 139.9, 215.3):
        assert tempo.analysis_tempo(None, y, 22050, raw, np.arange(200) * 20) == (raw, "unambiguous")


# ── the beat grid ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("name", [n for n, *_ in fixtures() if n != "dnb_halftime_174"])
def test_the_grid_finds_each_tempo_from_the_analysis_hint(made, name):
    truth, result, y = made[name]
    found = grid.analyze_audio(y, 22050, bpm_hint=result["bpm"])
    assert _near(found["bpm"], truth, 0.01), (name, found.get("bpm"))
    if name in DNB:
        assert found["status"] == "done" and found["beat_confidence"] >= 0.3
        # on the beat, not between: the first beat is a true beat (they start at 0)
        period = 60.0 / truth
        off = (found["first_beat"] + period / 2) % period - period / 2
        assert abs(off) < 0.012, off


@pytest.mark.parametrize("name", DNB)
def test_the_grid_tests_a_half_time_hint(made, name):
    # a tag or enrichment that says 87 (Deezer's often does) isn't trusted blindly
    truth, _result, y = made[name]
    found = grid.analyze_audio(y, 22050, bpm_hint=truth / 2)
    assert _near(found["bpm"], truth, 0.01), (name, found.get("bpm"))


@pytest.mark.parametrize("name", ("house_124", "track_100", "dubstep_140"))
def test_the_grid_leaves_the_others_where_they_are(made, name):
    truth, _result, y = made[name]
    assert _near(grid.analyze_audio(y, 22050, bpm_hint=truth)["bpm"], truth, 0.01)


def test_the_grid_never_halves_a_fast_hint(made):
    # half-time drum and bass tagged 174: its backbeat says 87, the tag stands
    truth, _result, y = made["dnb_halftime_174"]
    assert _near(grid.analyze_audio(y, 22050, bpm_hint=truth)["bpm"], truth, 0.01)


def test_grids_at_100_to_140_are_scored_as_before(made):
    # the grid's octave rule never reaches them, so their grids can't change
    y = made["house_124"][2]
    feat = grid._features(y)
    env = grid.beat_envelope(feat)
    times, weights = grid._onsets(env)
    for bpm in (100.0, 124.0, 139.0):
        assert grid._octave(feat, times, weights, bpm, hinted=True) == bpm
        assert grid._octave(feat, times, weights, bpm, hinted=False) == bpm
    beats = 0.1 + np.arange(64) * 60.0 / 124.0
    assert not grid._fast_backbeat(feat, beats)


# ── the rule itself ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("genres,family", [
    (["Drum & Bass"], "fast"), (["drum'n'bass"], "fast"), (["Drum n Bass"], "fast"), (["DnB"], "fast"),
    (["D&B"], "fast"), (["Jungle"], "fast"), (["Liquid Funk"], "fast"), (["Neurofunk"], "fast"),
    (["Footwork / Juke"], "fast"), (["Breakcore"], "fast"), (["Dubstep"], "half"), (["Trap"], "half"),
    (["drum-n-bass"], "fast"), (["Drum_n_Bass"], "fast"), (["Drum-and-Bass"], "fast"),  # review L1
    (["Hip-Hop"], "slow"), (["R&B"], "slow"), (["Dub"], "slow"), (["Electronic", "Drum & Bass"], "fast"),
    (["Hip-Hop", "Drum & Bass"], None), (["House"], None), (["Soulful House"], None), ([], None),
    ("Drum & Bass", "fast"), (None, None),
    # grid v5's review (L3): one tag naming two families says neither; the
    # slow family's new members
    (["Hip Hop, Drum & Bass"], None), (["Hip Hop; Jungle"], None), (["Drum And Bass, Electronic"], "fast"),
    (["Chillout"], "slow"), (["Lounge"], "slow"), (["Ambient"], "slow"), (["Dancehall"], "slow"),
    (["Downbeat"], "slow"), (["Reggaeton"], "slow"),
])
def test_genre_families(genres, family):
    assert tempo.genre_family(genres) == family


@pytest.mark.parametrize("bpm,kwargs,want", [
    (174.0, {}, (174.0, "kept")),                                       # a fast reading stands
    (180.0, {"genres": ["Hip Hop"]}, (90.0, "genre")),                  # unless the genre is slow
    (150.0, {"genres": ["Soul"], "evidence": {"vote": "fast"}}, (150.0, "backbeat")),  # and the backbeat agrees
    (174.0, {"evidence": {"vote": "fast"}}, (174.0, "backbeat")),       # evidence it's fast
    (174.0, {"genres": ["Drum & Bass"]}, (174.0, "genre")),
    (80.0, {"genres": ["Reggae"], "evidence": {"vote": "fast"}}, (160.0, "backbeat")),
    (80.0, {"genres": ["Reggae"], "evidence": {"vote": "slow"}}, (80.0, "genre")),
    (87.0, {"genres": ["Drum & Bass"]}, (174.0, "genre")),
    (70.0, {"genres": ["Dubstep"]}, (140.0, "genre")),
    (85.0, {"genres": ["Dubstep"]}, (85.0, "kept")),                    # 170 isn't a dubstep tempo
    (75.0, {"genres": ["Hip-Hop"]}, (75.0, "genre")),
    (72.0, {}, (144.0, "range")),                                       # DJ software's range
    (72.0, {"use_range": False}, (72.0, "kept")),                       # the grid's hint
    (88.0, {"evidence": {"vote": "fast"}}, (176.0, "backbeat")),
    (88.0, {"evidence": {"vote": "slow"}}, (88.0, "kept")),
    (124.0, {"genres": ["Drum & Bass"]}, (124.0, "unambiguous")),        # never outside the bands
    (60.0, {"genres": ["Drum & Bass"]}, (60.0, "unambiguous")),
])
def test_choose(bpm, kwargs, want):
    assert tempo.choose(bpm, **kwargs) == want


def test_the_backbeat_needs_enough_beats_and_a_clear_lead():
    fps = 100.0
    env = np.zeros(4000)
    beats = np.arange(40) * 0.35 + 0.5
    for i, b in enumerate(beats):
        env[int(round(b * fps))] = 1.0 if i % 2 else 0.1  # a snare on every other fast beat
    assert tempo.backbeat(env, fps, beats)["vote"] == "fast"
    assert tempo.backbeat(env, fps, beats[:20])["vote"] is None  # too few beats to say
    flat = np.zeros(4000)
    for b in beats:
        flat[int(round(b * fps))] = 1.0
    assert tempo.backbeat(flat, fps, beats)["vote"] is None  # every beat the same: no backbeat
    every_fourth = np.zeros(4000)
    for i, b in enumerate(beats):
        every_fourth[int(round(b * fps))] = 1.0 if i % 4 == 2 else 0.1
    assert tempo.backbeat(every_fourth, fps, beats)["vote"] != "fast"  # hip hop's snare, read at double


def test_a_skipped_beat_doesnt_turn_a_slow_backbeat_fast():
    # a tracker that skips a beat (or a pickup, an odd bar) swaps the four
    # positions from there on; folded over the whole track, hip hop's
    # backbeat washed out and read as drum and bass's (it doubled a
    # 10-minute hip-hop track to 178)
    fps = 100.0
    every = np.arange(129)  # the music's fast beats, a snare on every fourth (hip hop at double)
    times = 0.5 + every * 0.33
    env = np.zeros(int((times[-1] + 2) * fps))
    for k, t in zip(every, times, strict=True):
        env[int(round(t * fps))] = 1.0 if k % 4 == 2 else 0.1
    tracked = np.delete(times, 64)  # the tracker skipped one
    said = tempo.backbeat(env, fps, tracked)
    assert said["vote"] == "slow", said


# ── the independent review's cases (fix/dnb-bpm, round 2) ─────────────────────

def _analyse(tmp_path, name, y, genre=None):
    import soundfile as sf

    path = tmp_path / f"{name}.flac"
    sf.write(str(path), y, 22050, format="FLAC", subtype="PCM_16")
    if genre:
        from mutagen.flac import FLAC

        tags = FLAC(str(path))
        tags["genre"] = genre
        tags.save()
    return analyze.analyze_track(str(path))


SLOW_TAGGED = [  # (name, true BPM, pattern, hats, seed): read at double by librosa
    ("boombap_72", 72.0, "boombap", "16", 16), ("boombap_76", 76.0, "boombap", "8", 17),
    ("ballad_75_k1s3", 75.0, "k1s3", "8", 3),
]


@pytest.mark.parametrize("name,truth,pattern,hats,seed", SLOW_TAGGED)
def test_a_correct_slow_tag_stands_when_the_double_isnt_evidence(tmp_path, name, truth, pattern, hats, seed):
    # review H1: librosa reads these at 144-152 ("kept"); the tag at half must win
    from core.dj import grid, store

    from .tempo_fixtures import BOOM_BAP

    pat = BOOM_BAP if pattern == "boombap" else ({0: "K", 8: "S"},)
    y, _ = drum_track(truth, int(30 * truth / 240), pat, hats=hats, bass="boom", pad=0.4, seed=seed)
    result = _analyse(tmp_path, name, y)
    assert result["tempo_basis"] not in tempo.EVIDENCE, result
    kept = store.decide(tag_bpm=truth, analysis=result)
    assert (kept["bpm"], kept["bpm_source"]) == (truth, "tag")
    # the grid looks near the tag (the sweep's hint) and stays slow
    assert _near(grid.analyze_audio(y, 22050, bpm_hint=kept["bpm"])["bpm"], truth, 0.02)


def test_a_half_time_tag_takes_the_analysiss_octave_only_with_evidence(made):
    from core.dj import store

    truth, result, _ = made["dnb_174"]
    assert result["tempo_basis"] == "backbeat"
    taken = store.decide(enrichment_bpm=87.0, analysis=result)
    assert taken["bpm_source"] == "analysis" and _near(taken["bpm"], truth)
    assert taken["analyzed_bpm_basis"] == "backbeat"
    for basis in ("kept", "range", None):
        assert store.decide(tag_bpm=87.0, analysis={**result, "tempo_basis": basis})["bpm"] == 87.0


@pytest.mark.parametrize("bpm", (185.0, 195.0, 199.0))
def test_a_hint_at_180_to_200_is_kept_not_halved(bpm):
    # review M1: a hardcore or gabber tag (or Beatport's exact value) at 180-200
    from core.dj import grid

    from .tempo_fixtures import _house

    four, _ = _house(bpm, int(30 * bpm / 240))
    dnb, _ = drum_track(bpm, int(30 * bpm / 240), ({0: "K", 4: "S", 10: "K", 12: "S"},), hats="8", bass="reese",
                        seed=12)
    for y in (four, dnb):
        found = grid.analyze_audio(y, 22050, bpm_hint=bpm)
        assert found["status"] == "done" and _near(found["bpm"], bpm, 0.01), found.get("bpm")


@pytest.mark.parametrize("bpm,genre", ((150.0, "Soul"), (160.0, "Reggae"), (148.0, "Rap")))
def test_a_slow_genre_doesnt_halve_a_backbeat_at_the_fast_tempo(tmp_path, bpm, genre):
    # review M3: a straight backbeat at 148-160 tagged with a slow genre
    from core.dj import grid

    from .tempo_fixtures import STRAIGHT_100

    y, _ = drum_track(bpm, int(30 * bpm / 240), STRAIGHT_100, hats="8", bass="boom", pad=0.5, seed=19)
    result = _analyse(tmp_path, f"{genre}_{bpm:.0f}", y, genre)
    assert _near(result["bpm"], bpm) and result["tempo_basis"] == "backbeat", result
    # the analysis and the grid agree
    assert _near(grid.analyze_audio(y, 22050, bpm_hint=result["bpm"])["bpm"], bpm, 0.01)


def test_the_shared_spectrum_gives_librosas_own_onset_envelope(made):
    # review N3: the analysis makes one mel spectrogram for its onset envelope
    # and the octave check; the envelope (so the tempo, so every reading at
    # 100-140) is exactly what onset_strength(y=y) made before
    import librosa

    y = made["house_124"][2]
    mel = librosa.feature.melspectrogram(y=y, sr=22050)
    shared = librosa.onset.onset_strength(S=librosa.power_to_db(mel), sr=22050)
    assert np.array_equal(shared, librosa.onset.onset_strength(y=y, sr=22050))
    assert np.array_equal(tempo.snare_envelope(y, 22050, mel=mel), tempo.snare_envelope(y, 22050))


def test_the_octave_check_computes_no_spectrum_of_its_own(made, tmp_path, monkeypatch):
    import librosa

    calls = []
    real = librosa.feature.melspectrogram
    monkeypatch.setattr(librosa.feature, "melspectrogram", lambda *a, **k: calls.append(1) or real(*a, **k))
    result = analyze.analyze_track(write_wav(tmp_path / "dnb.wav", made["dnb_174"][2]))
    assert result["tempo_basis"] == "backbeat" and len(calls) == 1
