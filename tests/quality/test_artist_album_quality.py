"""One library artist's albums against the quality target
(core/quality/presets.artist_album_quality, GET /api/quality/artist/<id>):
the artist page's "Below quality target" tag. Judged from each track's
extension and stored bitrate by the same rules as the presets, in the
caller's library scope, without reading files."""

from __future__ import annotations

import json

import pytest
from flask import Flask

from core.quality import presets


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase
    presets.clear_cache()
    database = MusicDatabase(database_path=str(tmp_path / "artist-quality.db"))
    _sql(database, "INSERT INTO artists (id, name) VALUES (1, 'Pale Harbour')")
    _sql(database, "INSERT INTO artists (id, name) VALUES (2, 'Saltmarsh')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES (10, 1, 'Night Ferry')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES (11, 1, 'Low Light')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES (12, 1, 'Harbour Light')")
    _sql(database, "INSERT INTO albums (id, artist_id, title) VALUES (20, 2, 'Lantern')")
    return database


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


def _tracks(db, album, files, artist=1, owner=None):
    for i, (path, kbps) in enumerate(files):
        _sql(db, "INSERT INTO tracks (album_id, artist_id, title, file_path, bitrate, owner_profile_id) "
                 "VALUES (?, ?, ?, ?, ?, ?)", (album, artist, f"{album}-{i}", path, kbps, owner))


def _flac_target(db):
    _sql(db, "UPDATE quality_profiles SET ranked_targets = ?, upgrade_policy = 'acceptable' WHERE is_default = 1",
         (json.dumps([{"label": "FLAC 16-bit", "format": "flac", "bit_depth": 16}]),))


def _by_title(body):
    return {a["title"]: a for a in body["albums"]}


def test_each_album_counts_its_tracks_below_the_target(db):
    _flac_target(db)
    _tracks(db, 10, [("/m/a.flac", 900), ("/m/b.flac", 1000)])
    _tracks(db, 11, [("/m/c.mp3", 320), ("/m/d.mp3", 320), ("/m/e.mp3", 192)])
    _tracks(db, 12, [("/m/f.flac", 900), ("/m/g.mp3", 320)])
    body = presets.artist_album_quality(db, 1)
    albums = _by_title(body)
    assert (albums["Night Ferry"]["tracks"], albums["Night Ferry"]["below_target"]) == (2, 0)
    assert (albums["Low Light"]["tracks"], albums["Low Light"]["below_target"]) == (3, 3)
    assert (albums["Harbour Light"]["tracks"], albums["Harbour Light"]["below_target"]) == (2, 1)
    assert body["tracks"] == 7 and body["below_target"] == 4
    assert body["target"]["name"] == "FLAC or better" and body["target"]["preset"] == "flac"
    # ids are the library's own (text: media servers use string keys)
    assert str(body["artist_id"]) == "1"


def test_formats_are_named_most_tracks_first(db):
    _tracks(db, 11, [("/m/c.mp3", 320), ("/m/d.mp3", 320), ("/m/e.mp3", 192)])
    _tracks(db, 10, [("/m/a.flac", 900), ("/m/b.m4a", 800), ("/m/c.m4a", 256)])
    albums = _by_title(presets.artist_album_quality(db, 1))
    assert albums["Low Light"]["formats"] == ["MP3 320", "MP3 192"]
    # an m4a at 500 kbps or more is ALAC, lossless formats carry no bitrate
    assert albums["Night Ferry"]["formats"] == ["AAC 256", "ALAC", "FLAC"]


def test_only_this_artists_albums_with_files_in_the_callers_library(db):
    _tracks(db, 10, [("/m/a.flac", 900)])
    _tracks(db, 20, [("/m/z.flac", 900)], artist=2)
    _tracks(db, 11, [("/own/x.mp3", 128)], owner=5)
    _sql(db, "INSERT INTO tracks (album_id, artist_id, title, file_path) VALUES (12, 1, 'no file', NULL)")
    body = presets.artist_album_quality(db, 1)
    assert [a["title"] for a in body["albums"]] == ["Night Ferry"]
    assert body["tracks"] == 1


def test_an_artist_with_nothing_on_disk_has_no_albums(db):
    body = presets.artist_album_quality(db, 1)
    assert body["albums"] == [] and body["tracks"] == 0 and body["below_target"] == 0


def test_an_unknown_artist_is_none(db):
    assert presets.artist_album_quality(db, 999) is None


def test_a_profile_without_targets_puts_nothing_below(db):
    _sql(db, "UPDATE quality_profiles SET ranked_targets = '[]' WHERE is_default = 1")
    _tracks(db, 11, [("/m/c.mp3", 128)])
    body = presets.artist_album_quality(db, 1)
    # a profile with no targets imposes nothing, so no file is below it
    assert body["albums"][0]["below_target"] == 0
    assert body["albums"][0]["tracks"] == 1


# ── the endpoint ──────────────────────────────────────────────────────────────

@pytest.fixture
def client(db, monkeypatch):
    import api.targets as targets_api
    who = {"pid": 1}
    monkeypatch.setattr(targets_api, "get_current_profile_id", lambda: who["pid"])
    monkeypatch.setattr(targets_api, "get_database", lambda: db)
    app = Flask(__name__)
    app.register_blueprint(targets_api.bp)
    c = app.test_client()
    c.who = who
    return c


def test_the_endpoint(client, db):
    _flac_target(db)
    _tracks(db, 11, [("/m/c.mp3", 320)])
    r = client.get("/api/quality/artist/1")
    assert r.status_code == 200
    body = r.get_json()
    assert body["success"] is True
    assert body["albums"] == [{"id": "11", "title": "Low Light", "tracks": 1, "below_target": 1,
                               "formats": ["MP3 320"]}]
    assert body["target"]["name"] == "FLAC or better"


def test_the_endpoint_needs_a_profile(client):
    client.who["pid"] = None
    assert client.get("/api/quality/artist/1").status_code == 401


def test_any_profile_may_read_it(client, db):
    # the library is shared reading, like the artist page itself: a member
    # profile (not an admin) gets the same answer
    pid = db.create_profile(name="member")
    client.who["pid"] = pid
    assert client.get("/api/quality/artist/1").status_code == 200


def test_an_artist_not_in_the_library_is_404(client):
    r = client.get("/api/quality/artist/999")
    assert r.status_code == 404 and r.get_json()["success"] is False
