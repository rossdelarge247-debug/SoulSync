"""How much of the library meets each quality preset (core/quality/presets.py,
GET /api/quality/presets): extension + stored bitrate judged by the same
AudioQuality rules downloads use, and the current target named for the UI."""

from __future__ import annotations

import json

import pytest

from core.quality import presets
from core.quality.model import QualityTarget


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase
    presets.clear_cache()
    database = MusicDatabase(database_path=str(tmp_path / "presets.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES (1, 'Saltmarsh')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES (1, 1, 'Lantern')")
    return database


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _tracks(db, files, owner=None):
    for i, (path, kbps) in enumerate(files):
        _sql(db, "INSERT INTO tracks (album_id, artist_id, title, file_path, bitrate, owner_profile_id) "
                 "VALUES (1, 1, ?, ?, ?, ?)", (f"{path}{i}", path, kbps, owner))


def _profile(db, targets, policy="acceptable", cutoff=0):
    _sql(db, "UPDATE quality_profiles SET ranked_targets = ?, upgrade_policy = ?, upgrade_cutoff_index = ? "
             "WHERE is_default = 1", (json.dumps(targets), policy, cutoff))


LIBRARY = [
    ("/m/16bit.flac", 900),
    ("/m/hires.FLAC", 1600),     # extension case doesn't matter
    ("/m/no-bitrate.flac", None),
    ("/m/cbr.mp3", 320),
    ("/m/low.mp3", 192),
    ("/m/alac.m4a", 800),        # 500 kbps or more in an m4a: ALAC
    ("/m/aac.m4a", 256),
    ("/m/pcm.wav", 1411),
    ("/m/vorbis.ogg", 320),
    ("/m/odd.xyz", 900),         # not an audio format the model knows
]


def test_each_preset_counts_what_meets_it(db):
    _tracks(db, LIBRARY)
    body = presets.preset_counts(db)
    counts = {p["key"]: (p["meeting"], p["total"]) for p in body["presets"]}
    assert counts == {
        "mp3_320": (7, 10),    # 3 flac + alac + wav + mp3 320 + ogg 320
        "flac": (3, 10),
        "flac_24": (1, 10),    # only the 1600 kbps flac clears the 1450 kbps estimate
        "lossless": (5, 10),   # 3 flac + alac + wav
    }
    assert body["total"] == 10 and body["unknown_format"] == 1
    assert [p["estimated"] for p in body["presets"]] == [False, False, True, False]


def test_tracks_without_a_file_or_in_someone_elses_library_are_not_counted(db):
    _tracks(db, [("/m/a.flac", 900)])
    _tracks(db, [("/own/b.flac", 900)], owner=5)
    _sql(db, "INSERT INTO tracks (album_id, artist_id, title, file_path) VALUES (1, 1, 'no file', NULL)")
    assert presets.preset_counts(db)["total"] == 1


def test_counts_are_cached_until_cleared(db):
    _tracks(db, [("/m/a.flac", 900)])
    assert presets.preset_counts(db)["total"] == 1
    _tracks(db, [("/m/b.flac", 900)])
    assert presets.preset_counts(db)["total"] == 1
    presets.clear_cache()
    assert presets.preset_counts(db)["total"] == 2


@pytest.mark.parametrize("targets,policy,cutoff,preset,name", [
    ([{"format": "flac", "bit_depth": 24, "min_sample_rate": 96000}, {"format": "flac", "bit_depth": 16}],
     "acceptable", 0, "flac", "FLAC or better"),
    ([{"format": "flac", "bit_depth": 24, "min_sample_rate": 96000}, {"format": "flac", "bit_depth": 16}],
     "until_cutoff", 0, "flac_24", "FLAC 24-bit or better"),
    ([{"format": "flac"}, {"format": "alac"}, {"format": "wav"}], "acceptable", 0, "lossless", "Any lossless"),
    ([{"format": "flac", "bit_depth": 16}, {"label": "MP3 320kbps", "format": "mp3", "min_bitrate": 320}],
     "acceptable", 0, "mp3_320", "MP3 320 or better"),
    ([{"format": "flac", "bit_depth": 16}, {"label": "MP3 192kbps", "format": "mp3", "min_bitrate": 192}],
     "acceptable", 0, None, "MP3 192 or better"),
    ([{"format": "flac", "bit_depth": 16}, {"format": "ogg"}], "acceptable", 0, None, "OGG or better"),
])
def test_the_current_target_is_named_from_the_default_profile(db, targets, policy, cutoff, preset, name):
    _profile(db, targets, policy, cutoff)
    current = presets.preset_counts(db)["current"]
    assert current["preset"] == preset and current["name"] == name
    assert current["quality_profile_id"] is not None and isinstance(current["updated_at"], int)


def test_meeting_a_profile_uses_the_download_rules():
    flac_16 = QualityTarget(format="flac", bit_depth=16)
    assert presets.meets_targets(presets.audio_quality("flac", 0), [flac_16])
    assert not presets.meets_targets(presets.audio_quality("mp3", 320), [flac_16])
    assert presets.audio_quality("m4a", 499).format == "aac"
    assert presets.audio_quality("m4a", 500).format == "alac"
    assert presets.audio_quality("", 900).format == "unknown"
