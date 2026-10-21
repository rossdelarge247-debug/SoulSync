"""the library scans hand an artist's tracks to the database in batches
(insert_or_update_media_tracks) and ask "which of these exist?" once per album
or page (track_exists_by_server_many), instead of a connection per track.

every test runs the real worker twice over the same server content: once
against the database, once against the same database with the batch methods
hidden, which is exactly the one-call-per-track code that ran before. the
counts, the run ledgers and every row must come out the same.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from core.database_update_worker import DatabaseUpdateWorker
from database.music_database import MusicDatabase


class _OneByOne:
    """the database without its batch methods: the worker falls back to
    asking and writing track by track"""

    _HIDDEN = {'insert_or_update_media_tracks', 'track_exists_by_server_many', 'existing_album_ids'}

    def __init__(self, db):
        self._db = db

    def __getattr__(self, name):
        if name in self._HIDDEN:
            raise AttributeError(name)
        return getattr(self._db, name)


def _track(track_id, number, title=None, path=True):
    return SimpleNamespace(ratingKey=track_id, title=title or f"Song {track_id}", trackNumber=number,
                           duration=180_000, path=f"/m/{track_id}.flac" if path else None, bitRate=320)


def _album(album_id, title, tracks):
    return SimpleNamespace(ratingKey=album_id, title=title, tracks=lambda: list(tracks))


def _artist(artist_id, name, albums):
    return SimpleNamespace(ratingKey=artist_id, title=name, albums=lambda: list(albums))


def _seed(db):
    """an earlier scan: some albums and tracks are already there"""
    with db._get_connection() as conn:
        conn.execute("INSERT INTO artists (id, name, server_source) VALUES ('ar1', 'Massive Attack', 'navidrome')")
        conn.execute("INSERT INTO albums (id, artist_id, title, server_source) VALUES ('al1', 'ar1', 'Mezzanine', 'navidrome')")
        conn.execute("INSERT INTO albums (id, artist_id, title, server_source) VALUES ('al2', 'ar1', 'Protection', 'navidrome')")
        for tid, album in (('t1', 'al1'), ('t2', 'al1'), ('t6', 'al2')):
            conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, server_source, file_path) "
                         "VALUES (?, ?, 'ar1', 'old', 'navidrome', ?)", (tid, album, f"/m/{tid}.flac"))
        # same id, other server: exists, but not "for this server"
        conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, server_source) "
                     "VALUES ('t7', 'al2', 'ar1', 'old', 'plex')")
        # another owner's row: the write is refused, the scan carries on
        conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, server_source, owner_profile_id) "
                     "VALUES ('t9', 'al2', 'ar1', 'old', 'navidrome', 3)")
        conn.commit()


def _server():
    return [
        _artist('ar1', 'Massive Attack', [
            _album('al1', 'Mezzanine', [_track('t1', 1), _track('t2', 2), _track('t3', 3), _track('t4', 4)]),
            _album('al2', 'Protection', [_track('t6', 1), _track('t7', 2), _track('t8', 3), _track('t9', 4),
                                         _track('t6', 1, title='Song t6 again')]),
            _album('al3', 'Blue Lines', [_track('t10', 1), _track('t11', 2, path=False)]),
            _album('al4', 'Heligoland', []),
        ]),
        _artist('ar2', 'Tricky', [
            # a new track listed twice: the repeat finds the first one's row
            _album('al5', 'Maxinquaye', [_track(f"m{n}", n) for n in range(1, 8)] + [_track('m1', 1, title='m1 again')]),
        ]),
    ]


def _dump(db):
    out = {}
    with db._get_connection() as conn:
        for table, order in (('artists', 'id'), ('albums', 'id'), ('tracks', 'id'),
                             ('track_credits', 'track_id, name_norm'), ('library_history', 'id')):
            skip = {'created_at', 'updated_at', 'timestamp', 'id' if table == 'library_history' else ''}
            cols = [c[1] for c in conn.execute(f"PRAGMA table_info({table})") if c[1] not in skip]
            out[table] = [tuple(r) for r in conn.execute(f"SELECT {', '.join(cols)} FROM {table} ORDER BY {order}")]
    return out


def _worker(tmp_path, name, *, batched, seed=_seed):
    db = MusicDatabase(database_path=str(tmp_path / f"{name}.db"))
    seed(db)
    w = DatabaseUpdateWorker(None, database_path=str(tmp_path / f"{name}.db"), server_type='navidrome',
                             force_sequential=True)
    w.database = db if batched else _OneByOne(db)
    return w, db


def _ledger(w):
    return (w._new_track_ids, w._seen_track_ids, w._touched_artist_ids, w._touched_album_ids,
            w._unverified_artist_ids, w._unverified_album_ids)


@pytest.mark.parametrize('flush_every', [1, 3, 250])
@pytest.mark.parametrize('deep', [True, False], ids=['deep-scan', 'refresh'])
def test_the_artist_pass_writes_and_counts_exactly_as_one_by_one(tmp_path, monkeypatch, flush_every, deep):
    monkeypatch.setattr(DatabaseUpdateWorker, '_TRACK_WRITE_BATCH', flush_every)
    monkeypatch.setattr(MusicDatabase, 'MEDIA_TRACK_WRITE_BATCH', 2)
    runs = {}
    for batched in (False, True):
        w, db = _worker(tmp_path, f"b{int(batched)}", batched=batched)
        seen = set() if deep else None
        returned = [w._process_artist_with_content(a, skip_existing_tracks=deep, seen_track_ids=seen)
                    for a in _server()]
        runs[batched] = (returned, seen, _ledger(w), _dump(db))

    assert runs[True] == runs[False]
    returned = runs[True][0]
    if deep:
        # t1, t2, t6, its repeat and t9 (refused, but there) existed for
        # navidrome; t7 only for plex, so its update counts with the new ones
        assert returned[0] == (True, "4 albums, 6 new tracks (5 existing updated)", 4, 6)
        assert returned[1] == (True, "1 albums, 7 new tracks (1 existing updated)", 1, 7)
    else:
        # everything but the refused t9
        assert returned[0] == (True, "Updated with 4 albums, 10 tracks", 4, 10)


def test_tracks_waiting_for_an_album_that_gets_rekeyed_are_written_first(tmp_path):
    """a new album id with an existing album's title takes that album over
    (ratingKey change): it moves the old album's tracks and deletes it. the
    old album's own tracks from this pass must already be in by then, or they
    point at an album that no longer exists."""
    def seed(db):
        with db._get_connection() as conn:
            conn.execute("INSERT INTO artists (id, name, server_source) VALUES ('ar1', 'Air', 'navidrome')")
            conn.execute("INSERT INTO albums (id, artist_id, title, server_source) VALUES ('old', 'ar1', 'Moon Safari', 'navidrome')")
            conn.commit()

    server = _artist('ar1', 'Air', [
        _album('old', 'Moon Safari', [_track('a1', 1), _track('a2', 2)]),
        _album('new', 'Moon Safari', [_track('b1', 1)]),
    ])
    dumps = {}
    for batched in (False, True):
        w, db = _worker(tmp_path, f"r{int(batched)}", batched=batched, seed=seed)
        result = w._process_artist_with_content(server, skip_existing_tracks=True, seen_track_ids=set())
        dumps[batched] = (result, _ledger(w), _dump(db))

    assert dumps[True] == dumps[False]
    tracks = {row[0]: row[1] for row in dumps[True][2]['tracks']}
    assert tracks == {'a1': 'new', 'a2': 'new', 'b1': 'new'}


class _BreaksAfterFirstAlbum(DatabaseUpdateWorker):
    """worker state that fails outside the per-album guard once the first
    album's tracks are collected: the artist pass ends in its error handler"""

    @property
    def should_stop(self):
        if len(getattr(self, '_seen_track_ids', ())) >= 2:
            raise RuntimeError("worker state broke")
        return False

    @should_stop.setter
    def should_stop(self, _value):
        pass


@pytest.mark.parametrize('batched', [True, False])
def test_an_artist_error_still_writes_what_was_collected(tmp_path, batched):
    """tracks used to be written the moment they were read, so an error later
    in the artist never cost them. collected tracks must keep that."""
    db = MusicDatabase(database_path=str(tmp_path / "e.db"))
    _seed(db)
    w = _BreaksAfterFirstAlbum(None, database_path=str(tmp_path / "e.db"), server_type='navidrome',
                               force_sequential=True)
    w.database = db if batched else _OneByOne(db)
    artist = _artist('ar1', 'Massive Attack', [
        _album('al1', 'Mezzanine', [_track('t1', 1), _track('t3', 3)]),
        _album('al2', 'Protection', [_track('t8', 3)]),
    ])

    result = w._process_artist_with_content(artist, skip_existing_tracks=True, seen_track_ids=set())

    assert result == (False, "Processing error: worker state broke", 0, 0)
    with db._get_connection() as conn:
        written = {r[0]: r[1] for r in conn.execute("SELECT id, title FROM tracks WHERE id IN ('t1', 't3', 't8')")}
    assert written == {'t1': 'Song t1', 't3': 'Song t3'}
    assert w._new_track_ids == {'t3'}


def test_a_full_artist_pass_uses_a_handful_of_connections(tmp_path, monkeypatch):
    opened = []
    real = MusicDatabase._get_connection
    monkeypatch.setattr(MusicDatabase, '_get_connection', lambda self: opened.append(1) or real(self))
    counts = {}
    for batched in (False, True):
        w, _db = _worker(tmp_path, f"c{int(batched)}", batched=batched)
        opened.clear()
        w._process_artist_with_content(_server()[1], skip_existing_tracks=True, seen_track_ids=set())
        counts[batched] = len(opened)
    # one-by-one: artist + album + 8 x (exists, write, provenance) + 7 x history
    assert counts[False] >= 30
    # batched: artist, album-existence, album, exists + one write connection
    assert counts[True] <= 6
