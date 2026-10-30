"""The readout's audio facts (core/playback/audio_details.py): read once from
the file with mutagen, kept on the track, read again when the file changes."""

from __future__ import annotations

import shutil
import sqlite3
import subprocess

import numpy as np
import pytest
import soundfile as sf

from core.playback import audio_details as D


def _write(path, sr=96000, subtype="PCM_24", seconds=1.0):
    t = np.arange(int(seconds * sr)) / sr
    sf.write(str(path), (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32), sr, subtype=subtype)


def test_probe_reads_bit_depth_and_rate_from_a_hires_flac(tmp_path):
    song = tmp_path / "a.flac"
    _write(song)
    facts = D.probe(str(song))
    assert facts["format"] == "flac"
    assert facts["bit_depth"] == 24
    assert facts["sample_rate"] == 96000
    assert abs(facts["duration_s"] - 1.0) < 0.01


def test_probe_reads_a_cd_quality_wav(tmp_path):
    song = tmp_path / "a.wav"
    _write(song, sr=44100, subtype="PCM_16")
    facts = D.probe(str(song))
    assert (facts["format"], facts["bit_depth"], facts["sample_rate"]) == ("wav", 16, 44100)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg")
def test_lossy_files_have_no_bit_depth(tmp_path):
    wav = tmp_path / "a.wav"
    _write(wav, sr=44100, subtype="PCM_16")
    for ext, args in ((".mp3", ["-b:a", "192k"]), (".m4a", ["-c:a", "aac", "-b:a", "128k"])):
        out = tmp_path / f"a{ext}"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(wav), *args, str(out)], check=True)
        facts = D.probe(str(out))
        assert facts["bit_depth"] is None, ext
        assert facts["sample_rate"] == 44100, ext
        assert facts["bitrate_kbps"], ext
    assert D.probe(str(tmp_path / "a.m4a"))["format"] == "aac"


def test_probe_never_raises_on_junk(tmp_path):
    junk = tmp_path / "x.flac"
    junk.write_bytes(b"\x00" * 100)
    facts = D.probe(str(junk))
    assert facts["bit_depth"] is None and facts["sample_rate"] is None
    assert facts["format"] == "flac"


def test_format_keys_and_labels():
    assert D.format_key("/m/A/b.FLAC") == "flac"
    assert D.format_key("x.m4a") == "aac"
    assert D.format_key("x.txt") is None
    assert D.format_label("flac") == "FLAC"
    assert D.format_label("opus") == "Opus"
    assert D.format_label(None) is None


class _Db:
    def __init__(self, path):
        self.path = str(path)
        conn = sqlite3.connect(self.path)
        conn.execute("CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT, file_path TEXT, bitrate INTEGER)")
        D.ensure_track_columns(conn.cursor())
        D.ensure_track_columns(conn.cursor())  # repeatable
        conn.commit()
        conn.close()

    def _get_connection(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def row(self, track_id):
        conn = self._get_connection()
        try:
            return dict(conn.execute("SELECT * FROM tracks WHERE id = ?", (track_id,)).fetchone())
        finally:
            conn.close()


def test_details_reads_once_and_keeps_the_facts_on_the_track(tmp_path, monkeypatch):
    db = _Db(tmp_path / "m.db")
    song = tmp_path / "a.flac"
    _write(song)
    conn = db._get_connection()
    conn.execute("INSERT INTO tracks (id, title, file_path, bitrate) VALUES ('t1', 'A', ?, 2304)", (str(song),))
    conn.commit()
    conn.close()

    out = D.details_for(db, db.row("t1"), str(song))
    assert out["format"] == "FLAC"
    assert (out["bit_depth"], out["sample_rate"], out["bitrate_kbps"]) == (24, 96000, 2304)
    assert out["path_label"] == "Library"
    stored = db.row("t1")
    assert (stored["bit_depth"], stored["sample_rate"]) == (24, 96000)
    assert stored["audio_probe_sig"]

    # the second ask doesn't open the file
    monkeypatch.setattr(D, "probe", lambda path: pytest.fail("probed twice"))
    again = D.details_for(db, db.row("t1"), str(song))
    assert (again["bit_depth"], again["sample_rate"]) == (24, 96000)


def test_a_replaced_file_is_read_again(tmp_path):
    db = _Db(tmp_path / "m.db")
    song = tmp_path / "a.flac"
    _write(song)
    conn = db._get_connection()
    conn.execute("INSERT INTO tracks (id, title, file_path) VALUES ('t1', 'A', ?)", (str(song),))
    conn.commit()
    conn.close()
    D.details_for(db, db.row("t1"), str(song))
    _write(song, sr=44100, subtype="PCM_16", seconds=2.0)
    out = D.details_for(db, db.row("t1"), str(song))
    assert (out["bit_depth"], out["sample_rate"]) == (16, 44100)
    # no stored bitrate: mutagen's average fills it in
    assert out["bitrate_kbps"]


def test_a_file_that_isnt_here_says_where_it_streams_from(tmp_path):
    db = _Db(tmp_path / "m.db")
    conn = db._get_connection()
    conn.execute("INSERT INTO tracks (id, title, file_path, bitrate) VALUES ('t1', 'A', '/music/A/a.flac', 900)")
    conn.commit()
    conn.close()
    out = D.details_for(db, db.row("t1"), None, streamed_from="Navidrome")
    assert out["path_label"] == "Library (streamed from Navidrome)"
    assert out["format"] == "FLAC"
    assert out["bitrate_kbps"] == 900
    assert out["bit_depth"] is None and out["on_disk"] is False


def _write_stereo(path, sr=44100, subtype="PCM_16", seconds=1.0):
    t = np.arange(int(seconds * sr)) / sr
    tone = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    sf.write(str(path), np.stack([tone, -tone], axis=1), sr, subtype=subtype)


def test_probe_reads_the_channels(tmp_path):
    mono, stereo = tmp_path / "m.flac", tmp_path / "s.flac"
    _write(mono, sr=44100, subtype="PCM_16")
    _write_stereo(stereo)
    assert D.probe(str(mono))["channels"] == 1
    assert D.probe(str(stereo))["channels"] == 2
    junk = tmp_path / "x.flac"
    junk.write_bytes(b"\x00" * 100)
    assert D.probe(str(junk))["channels"] is None


def test_details_say_the_channels_and_the_bitrate_on_disk(tmp_path):
    """The Data readout (30i): channels from the file, kept with the other
    facts; on disk is the file's size over its length."""
    import os

    db = _Db(tmp_path / "m.db")
    song = tmp_path / "s.flac"
    _write_stereo(song, seconds=2.0)
    conn = db._get_connection()
    conn.execute("INSERT INTO tracks (id, title, file_path) VALUES ('t1', 'A', ?)", (str(song),))
    conn.commit()
    conn.close()
    out = D.details_for(db, db.row("t1"), str(song))
    assert out["channels"] == 2
    assert db.row("t1")["channels"] == 2
    expected = round(os.path.getsize(song) * 8 / out["duration_s"] / 1000)
    assert out["on_disk_kbps"] == expected


def test_a_row_kept_before_the_channels_is_read_once_more(tmp_path, monkeypatch):
    db = _Db(tmp_path / "m.db")
    song = tmp_path / "s.flac"
    _write_stereo(song)
    conn = db._get_connection()
    conn.execute("INSERT INTO tracks (id, title, file_path) VALUES ('t1', 'A', ?)", (str(song),))
    conn.commit()
    conn.close()
    D.details_for(db, db.row("t1"), str(song))
    # as an older build left it: the facts kept, the channels not
    conn = db._get_connection()
    conn.execute("UPDATE tracks SET channels = NULL WHERE id = 't1'")
    conn.commit()
    conn.close()
    assert D.details_for(db, db.row("t1"), str(song))["channels"] == 2
    # kept now: the next ask is a row read
    monkeypatch.setattr(D, "probe", lambda path: pytest.fail("probed again"))
    assert D.details_for(db, db.row("t1"), str(song))["channels"] == 2


def test_unknown_channels_are_kept_as_known_unknown(tmp_path, monkeypatch):
    db = _Db(tmp_path / "m.db")
    junk = tmp_path / "x.flac"
    junk.write_bytes(b"\x00" * 100)
    conn = db._get_connection()
    conn.execute("INSERT INTO tracks (id, title, file_path) VALUES ('t1', 'A', ?)", (str(junk),))
    conn.commit()
    conn.close()
    assert D.details_for(db, db.row("t1"), str(junk))["channels"] is None
    assert db.row("t1")["channels"] == 0
    monkeypatch.setattr(D, "probe", lambda path: pytest.fail("probed again"))
    assert D.details_for(db, db.row("t1"), str(junk))["channels"] is None


def test_a_streamed_file_has_no_bitrate_on_disk(tmp_path):
    db = _Db(tmp_path / "m.db")
    conn = db._get_connection()
    conn.execute("INSERT INTO tracks (id, title, file_path, bitrate) VALUES ('t1', 'A', '/x/a.flac', 900)")
    conn.commit()
    conn.close()
    out = D.details_for(db, db.row("t1"), None)
    assert out["on_disk_kbps"] is None and out["channels"] is None


def test_without_the_channels_column_a_request_never_probes_again(tmp_path, monkeypatch):
    """A database whose migration hasn't added `channels` reads it as
    known-unknown, so every request doesn't open the file only to fail to
    keep the answer (review L8)."""
    path = tmp_path / "old.db"
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT, file_path TEXT, bitrate INTEGER, "
                 "duration INTEGER, track_number INTEGER, album_id TEXT, artist_id TEXT, "
                 "bit_depth INTEGER, sample_rate INTEGER, audio_probe_sig TEXT)")
    conn.execute("CREATE TABLE albums (id TEXT, title TEXT, year INTEGER, thumb_url TEXT, track_count INTEGER)")
    conn.execute("CREATE TABLE artists (id TEXT, name TEXT)")
    song = tmp_path / "s.flac"
    _write_stereo(song)
    from core.playback.peaks import file_signature

    conn.execute("INSERT INTO tracks (id, title, file_path, bit_depth, sample_rate, audio_probe_sig) "
                 "VALUES ('t1', 'A', ?, 16, 44100, ?)", (str(song), file_signature(str(song))))
    conn.commit()
    conn.close()

    class Db(_Db):
        def __init__(self, p):
            self.path = str(p)

        def _current_scope_sql(self, _col):
            return "1=1", []

    db = Db(path)
    row = D.track_row(db, "t1")
    assert row["channels"] == 0
    monkeypatch.setattr(D, "probe", lambda p: pytest.fail("probed without the column"))
    out = D.details_for(db, row, str(song))
    assert out["channels"] is None and out["bit_depth"] == 16


def test_an_upgraded_database_gains_the_channels_column_cleanly(tmp_path):
    """A library made before `tracks.channels` opens with the column and no
    failed migration step (review L7)."""
    from database.music_database import MusicDatabase

    path = tmp_path / "music.db"
    db = MusicDatabase(str(path))
    conn = sqlite3.connect(str(path))
    conn.execute("ALTER TABLE tracks DROP COLUMN channels")
    conn.commit()
    assert "channels" not in {r[1] for r in conn.execute("PRAGMA table_info(tracks)")}
    conn.close()
    db._initialize_database()  # the next start
    conn = sqlite3.connect(str(path))
    try:
        assert "channels" in {r[1] for r in conn.execute("PRAGMA table_info(tracks)")}
    finally:
        conn.close()
    assert db.schema_health()["failed_steps"] == []


def test_without_the_channels_column_a_never_probed_track_keeps_its_signature(tmp_path, monkeypatch):
    """Before the channels migration, the first probe still keeps the facts
    and the signature it can, so the next request is a row read (re-review N3)."""
    path = tmp_path / "old.db"
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT, file_path TEXT, bitrate INTEGER, "
                 "duration INTEGER, track_number INTEGER, album_id TEXT, artist_id TEXT, "
                 "bit_depth INTEGER, sample_rate INTEGER, audio_probe_sig TEXT)")
    conn.execute("CREATE TABLE albums (id TEXT, title TEXT, year INTEGER, thumb_url TEXT, track_count INTEGER)")
    conn.execute("CREATE TABLE artists (id TEXT, name TEXT)")
    song = tmp_path / "s.flac"
    _write_stereo(song)
    conn.execute("INSERT INTO tracks (id, title, file_path) VALUES ('t1', 'A', ?)", (str(song),))
    conn.commit()
    conn.close()

    class Db(_Db):
        def __init__(self, p):
            self.path = str(p)

        def _current_scope_sql(self, _col):
            return "1=1", []

    db = Db(path)
    first = D.details_for(db, D.track_row(db, "t1"), str(song))
    assert (first["bit_depth"], first["sample_rate"], first["channels"]) == (16, 44100, 2)
    stored = db.row("t1")
    assert stored["audio_probe_sig"] and stored["bit_depth"] == 16
    monkeypatch.setattr(D, "probe", lambda p: pytest.fail("probed again"))
    again = D.details_for(db, D.track_row(db, "t1"), str(song))
    assert again["bit_depth"] == 16 and again["channels"] is None

