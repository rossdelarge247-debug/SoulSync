"""BPM and key into the files' tags (core/dj/tags.py): the frames DJ
software reads, only filling gaps, atomic saves that leave the audio alone."""

from __future__ import annotations

import shutil

import numpy as np
import pytest
import soundfile as sf

from core.dj.tags import MP4_KEY, read_dj_tags, write_dj_tags

from .audio_fixtures import dj_track, write_flac, write_ogg, write_wav, write_with_ffmpeg

HAS_FFMPEG = shutil.which("ffmpeg") is not None


def _audio(seconds=3.0):
    return dj_track(124, 9, True, seconds=seconds)


def _flac(tmp_path):
    return write_flac(tmp_path / "t.flac", _audio())


def _mp3(tmp_path):
    return write_with_ffmpeg(tmp_path / "t.mp3", _audio(), ["-c:a", "libmp3lame", "-b:a", "128k"])


def _m4a(tmp_path):
    return write_with_ffmpeg(tmp_path / "t.m4a", _audio(), ["-c:a", "aac", "-b:a", "128k"])


def test_flac_gets_bpm_and_initialkey(tmp_path):
    path = _flac(tmp_path)
    before, _ = sf.read(path)
    assert read_dj_tags(path) == {"bpm": None, "key": None, "format": "vorbis"}
    result = write_dj_tags(path, bpm=123.6, key_name="Am")
    assert result == {"written": ["bpm", "key"], "error": None}
    from mutagen.flac import FLAC

    tags = FLAC(path)
    assert tags["BPM"] == ["124"] and tags["INITIALKEY"] == ["Am"]
    assert read_dj_tags(path) == {"bpm": 124.0, "key": "Am", "format": "vorbis"}
    after, _ = sf.read(path)
    assert np.array_equal(before, after)  # only the tags changed
    assert not list(tmp_path.glob("*.sstmp"))  # the atomic save's temp is gone


def test_ogg_uses_the_vorbis_fields(tmp_path):
    path = write_ogg(tmp_path / "t.ogg", _audio())
    assert write_dj_tags(path, bpm=128, key_name="F#m")["written"] == ["bpm", "key"]
    from mutagen.oggvorbis import OggVorbis

    tags = OggVorbis(path)
    assert tags["BPM"] == ["128"] and tags["INITIALKEY"] == ["F#m"]


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg makes the mp3")
def test_mp3_gets_tbpm_and_tkey(tmp_path):
    path = _mp3(tmp_path)
    assert write_dj_tags(path, bpm=87.4, key_name="Ebm")["written"] == ["bpm", "key"]
    from mutagen.id3 import ID3

    tags = ID3(path)
    assert tags["TBPM"].text == ["87"] and tags["TKEY"].text == ["Ebm"]
    assert read_dj_tags(path)["format"] == "id3"


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg makes the m4a")
def test_m4a_gets_tmpo_and_a_freeform_key(tmp_path):
    path = _m4a(tmp_path)
    assert write_dj_tags(path, bpm=174.2, key_name="Eb")["written"] == ["bpm", "key"]
    from mutagen.mp4 import MP4

    tags = MP4(path)
    assert tags["tmpo"] == [174]
    assert bytes(tags[MP4_KEY][0]) == b"Eb"
    assert read_dj_tags(path) == {"bpm": 174.0, "key": "Eb", "format": "mp4"}


def test_values_already_in_the_file_stay(tmp_path):
    path = _flac(tmp_path)
    from mutagen.flac import FLAC

    f = FLAC(path)
    f["BPM"] = ["126"]
    f.save()
    result = write_dj_tags(path, bpm=124, key_name="Am")
    assert result["written"] == ["key"]
    assert FLAC(path)["BPM"] == ["126"]
    # nothing left to fill: the file isn't touched at all
    mtime = (tmp_path / "t.flac").stat().st_mtime_ns
    assert write_dj_tags(path, bpm=124, key_name="Cm") == {"written": [], "error": None}
    assert (tmp_path / "t.flac").stat().st_mtime_ns == mtime
    assert FLAC(path)["INITIALKEY"] == ["Am"]


def test_overwrite_replaces_when_asked(tmp_path):
    path = _flac(tmp_path)
    write_dj_tags(path, bpm=100, key_name="C")
    assert write_dj_tags(path, bpm=124, key_name="Am", overwrite=True)["written"] == ["bpm", "key"]
    assert read_dj_tags(path)["bpm"] == 124.0 and read_dj_tags(path)["key"] == "Am"


def test_reads_other_spellings_other_apps_wrote(tmp_path):
    path = _flac(tmp_path)
    from mutagen.flac import FLAC

    f = FLAC(path)
    f["bpm"] = ["127,5"]
    f["KEY"] = ["8A"]
    f.save()
    assert read_dj_tags(path) == {"bpm": 127.5, "key": "8A", "format": "vorbis"}


def test_unsupported_and_missing_files(tmp_path):
    wav = write_wav(tmp_path / "t.wav", _audio(1.0))
    assert write_dj_tags(wav, bpm=120)["error"]
    assert read_dj_tags(str(tmp_path / "gone.flac"))["bpm"] is None
    assert write_dj_tags(str(tmp_path / "gone.flac"), bpm=120)["error"]


def test_a_write_that_would_damage_the_audio_is_refused(tmp_path, monkeypatch):
    path = _flac(tmp_path)
    import core.metadata.common as common

    monkeypatch.setattr(common, "save_audio_file", lambda audio, symbols: False)
    result = write_dj_tags(path, bpm=120, key_name="Am")
    assert result["written"] == [] and "left as it was" in result["error"]
    assert read_dj_tags(path)["bpm"] is None
