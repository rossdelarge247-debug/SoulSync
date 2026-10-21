"""the scans ask "which of these tracks are already in the library?" once per
album or page (track_exists_by_server_many) instead of opening a connection
per track (track_exists_by_server).

the batch lookup must answer exactly what looping the single lookup answers,
and the incremental scans must pick exactly the same artists and tracks with
it as they did asking track by track.
"""

from __future__ import annotations

import logging
from types import SimpleNamespace

import pytest

from core.database_update_worker import DatabaseUpdateWorker
from database.music_database import MusicDatabase


class _OneByOne:
    """the database without its batch lookup: the scans ask track by track"""

    def __init__(self, db):
        self._db = db

    def __getattr__(self, name):
        if name == 'track_exists_by_server_many':
            raise AttributeError(name)
        return getattr(self._db, name)


def _track(track_id, number):
    return SimpleNamespace(ratingKey=track_id, title=f"Song {track_id}", trackNumber=number)


def _worker(tmp_path, name, *, batched, seed, server):
    db = MusicDatabase(database_path=str(tmp_path / f"{name}.db"))
    seed(db)
    w = DatabaseUpdateWorker(None, database_path=str(tmp_path / f"{name}.db"), server_type=server,
                             force_sequential=True)
    w.database = db if batched else _OneByOne(db)
    return w, db


@pytest.fixture()
def db(tmp_path):
    db = MusicDatabase(database_path=str(tmp_path / "lookups.db"))
    with db._get_connection() as conn:
        conn.execute("INSERT INTO artists (id, name) VALUES ('ar', 'x')")
        conn.execute("INSERT INTO albums (id, artist_id, title) VALUES ('al', 'ar', 'x')")
        for tid, server, owner in (('old-1', 'navidrome', None), ('old-2', 'navidrome', None),
                                   ('theirs', 'navidrome', 7), ('123', 'plex', None)):
            conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, server_source, owner_profile_id) "
                         "VALUES (?, 'al', 'ar', 'x', ?, ?)", (tid, server, owner))
        conn.commit()
    return db


@pytest.mark.parametrize('chunk', [1, 2, 500])
def test_track_exists_by_server_many_matches_the_single_lookup(db, monkeypatch, chunk):
    monkeypatch.setattr(MusicDatabase, '_ID_LOOKUP_CHUNK', chunk)
    ids = ['old-1', 'old-2', 'theirs', 'nope', 'old-1', 123, '123', 'nope-2']
    for server in ('navidrome', 'plex', 'jellyfin'):
        expected = {str(i) for i in ids if db.track_exists_by_server(i, server)}
        assert db.track_exists_by_server_many(ids, server) == expected
    assert db.track_exists_by_server_many(ids, 'navidrome') == {'old-1', 'old-2', 'theirs'}
    assert db.track_exists_by_server_many(ids, 'plex') == {'123'}
    assert db.track_exists_by_server_many([], 'plex') == set()


def test_track_exists_by_server_many_reads_as_missing_on_error(db, monkeypatch, caplog):
    def broken(self):
        raise RuntimeError("unable to open database file")

    monkeypatch.setattr(MusicDatabase, '_get_connection', broken)
    with caplog.at_level(logging.ERROR):
        assert db.track_exists_by_server_many(['old-1'], 'navidrome') == set()
    assert db.track_exists_by_server('old-1', 'navidrome') is False


# ── the incremental scans ────────────────────────────────────────────────────

def _count_single_lookups(monkeypatch):
    calls = []
    real = MusicDatabase.track_exists_by_server
    monkeypatch.setattr(MusicDatabase, 'track_exists_by_server',
                        lambda self, tid, server: calls.append(tid) or real(self, tid, server))
    return calls


def test_navidrome_incremental_finds_the_same_artists(tmp_path, monkeypatch):
    albums = [SimpleNamespace(ratingKey=f"al{n}", title=f"A{n}", addedAt=100 - n,
                              tracks=lambda n=n: [_track(f"t{n}-{k}", k) for k in range(5)],
                              artist=lambda n=n: SimpleNamespace(ratingKey=f"ar{n % 3}", title=f"Artist {n % 3}"))
               for n in range(40)]

    def seed(db):
        with db._get_connection() as conn:
            conn.execute("INSERT INTO artists (id, name) VALUES ('ar', 'x')")
            conn.execute("INSERT INTO albums (id, artist_id, title) VALUES ('al', 'ar', 'x')")
            # albums 0-2 are missing a track; 3-39 are complete
            for n in range(40):
                for k in range(5):
                    if n < 3 and k == 4:
                        continue
                    conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, server_source) "
                                 "VALUES (?, 'al', 'ar', 'x', 'navidrome')", (f"t{n}-{k}",))
            conn.commit()

    calls = _count_single_lookups(monkeypatch)
    found = {}
    for batched in (False, True):
        w, _db = _worker(tmp_path, f"n{int(batched)}", batched=batched, seed=seed, server='navidrome')
        w._get_recent_albums_for_server = lambda: list(albums)
        calls.clear()
        found[batched] = [a.ratingKey for a in w._get_artists_for_navidrome_incremental_update()]
        found[(batched, 'lookups')] = len(calls)

    assert found[True] == found[False] == ['ar0', 'ar1', 'ar2']
    assert found[(False, 'lookups')] > 100      # stopped after 25 complete albums
    assert found[(True, 'lookups')] == 0


def test_jellyfin_incremental_finds_the_same_new_tracks_across_lookup_windows(tmp_path, monkeypatch):
    monkeypatch.setattr(DatabaseUpdateWorker, '_EXISTS_LOOKUP_WINDOW', 7)

    def mk(n):
        return SimpleNamespace(ratingKey=f"j{n}", title=f"J{n}",
                               artist=lambda n=n: SimpleNamespace(ratingKey=f"ar{n % 4}", title=f"Artist {n % 4}"))

    recent = [mk(n) for n in range(300)]
    new_ids = {f"j{n}" for n in (0, 5, 6, 13, 40, 41, 150)}

    def seed(db):
        with db._get_connection() as conn:
            conn.execute("INSERT INTO artists (id, name) VALUES ('ar', 'x')")
            conn.execute("INSERT INTO albums (id, artist_id, title) VALUES ('al', 'ar', 'x')")
            for t in recent:
                if t.ratingKey not in new_ids:
                    conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, server_source) "
                                 "VALUES (?, 'al', 'ar', 'x', 'jellyfin')", (t.ratingKey,))
            conn.commit()

    calls = _count_single_lookups(monkeypatch)
    results = {}
    for batched in (False, True):
        w, _db = _worker(tmp_path, f"j{int(batched)}", batched=batched, seed=seed, server='jellyfin')
        w.media_client = SimpleNamespace(get_recently_added_tracks=lambda limit: recent[:200],
                                         get_recently_updated_tracks=lambda limit: recent[150:])
        calls.clear()
        artists = [a.ratingKey for a in w._get_artists_for_jellyfin_track_incremental_update()]
        results[batched] = (artists, [t.ratingKey for t in w._jellyfin_new_tracks])
        results[(batched, 'lookups')] = len(calls)

    assert results[True] == results[False]
    # j150 sits past the 100-existing early stop, so it is never reached
    assert results[True][1] == ['j0', 'j5', 'j6', 'j13', 'j40', 'j41']
    assert results[(True, 'lookups')] == 0


def test_plex_incremental_finds_the_same_artists(tmp_path, monkeypatch):
    def album(n, artist_id):
        return SimpleNamespace(ratingKey=f"p{n}", title=f"P{n}", addedAt=1000 - n,
                               tracks=lambda n=n: [_track(f"p{n}-{k}", k) for k in range(4)],
                               artist=lambda: SimpleNamespace(ratingKey=artist_id, title=artist_id))

    albums = [album(n, f"ar{n % 5}") for n in range(60)]

    def seed(db):
        with db._get_connection() as conn:
            conn.execute("INSERT INTO artists (id, name) VALUES ('ar', 'x')")
            conn.execute("INSERT INTO albums (id, artist_id, title) VALUES ('al', 'ar', 'x')")
            for n in range(60):
                for k in range(4):
                    if (n, k) in ((2, 1), (7, 3)):
                        continue
                    conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, server_source) "
                                 "VALUES (?, 'al', 'ar', 'x', 'plex')", (f"p{n}-{k}",))
            conn.commit()

    calls = _count_single_lookups(monkeypatch)
    found = {}
    for batched in (False, True):
        w, _db = _worker(tmp_path, f"p{int(batched)}", batched=batched, seed=seed, server='plex')
        w.media_client = SimpleNamespace(ensure_connection=lambda: True, is_fully_configured=lambda: True)
        w._get_recent_albums_for_server = lambda: list(albums)
        w._check_for_metadata_changes = lambda tracks: False
        calls.clear()
        found[batched] = [a.ratingKey for a in w._get_artists_for_incremental_update()]
        found[(batched, 'lookups')] = len(calls)

    assert found[True] == found[False] == ['ar2']
    assert found[(False, 'lookups')] > 0
    assert found[(True, 'lookups')] == 0
