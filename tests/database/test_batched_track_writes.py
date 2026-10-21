"""the library scans write tracks through insert_or_update_media_tracks, the
batch form of insert_or_update_media_track: one connection, one transaction
per batch, a savepoint per track.

the contract is that a batch is indistinguishable from looping the single
method: the same rows, credits, provenance backfill, manual locks, library
history and return values. every test here builds two identical databases,
writes the same tracks one way into each, and compares everything.
"""

from __future__ import annotations

import logging

import pytest

from database.music_database import MusicDatabase


class _Track:
    """what a media server wrapper hands the scan (navidrome/jellyfin shape)"""

    def __init__(self, track_id, title, path=None, number=1, **extra):
        self.ratingKey = track_id
        self.title = title
        self.trackNumber = number
        self.duration = 200_000
        self.path = path
        self.bitRate = 320
        for key, value in extra.items():
            setattr(self, key, value)


class _Unreadable(_Track):
    """a track object that fails while its fields are read (a plexapi object
    reloading a missing attribute from a server that went away)"""

    @property
    def trackNumber(self):
        raise RuntimeError("server dropped the connection")

    @trackNumber.setter
    def trackNumber(self, _value):
        pass


def _seed(db, tmp_path):
    with db._get_connection() as conn:
        conn.execute("INSERT INTO artists (id, name, server_source) VALUES ('ar', 'Radiohead', 'navidrome')")
        conn.execute("INSERT INTO artists (id, name, server_source) VALUES ('ar2', 'Portishead', 'navidrome')")
        for album, artist, title in (('al1', 'ar', 'OK Computer'), ('al2', 'ar', 'Kid A'), ('al3', 'ar2', 'Dummy')):
            conn.execute("INSERT INTO albums (id, artist_id, title, server_source, thumb_url) VALUES (?, ?, ?, 'navidrome', ?)",
                         (album, artist, title, f"http://img/{album}"))
        # rows from an earlier scan: one plain, one whose server path is
        # unreachable but whose earlier local copy is still on disk
        conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, server_source, file_path) "
                     "VALUES ('old-1', 'al1', 'ar', 'Airbag (old title)', 'navidrome', '/m/old-1.flac')")
        local_copy = tmp_path / "old-2-local.flac"
        local_copy.write_bytes(b"x")
        conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, server_source, file_path) "
                     "VALUES ('old-2', 'al1', 'ar', 'Paranoid Android', 'navidrome', ?)", (str(local_copy),))
        # another library owner's row: the scan must refuse to take it over
        conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, server_source, owner_profile_id) "
                     "VALUES ('theirs', 'al1', 'ar', 'Not Yours', 'navidrome', 7)")
        # provenance for two scanned files: exact path, and basename only
        conn.execute("INSERT INTO track_downloads (file_path, source_service, track_title, status, spotify_track_id, isrc) "
                     "VALUES ('/m/new-1.flac', 'soulseek', 'x', 'completed', 'sp-new-1', 'ISRC-1')")
        conn.execute("INSERT INTO track_downloads (file_path, source_service, track_title, status, deezer_track_id, "
                     "musicbrainz_recording_id, recording_disambiguation) "
                     "VALUES ('C:\\dl\\old-1.flac', 'soulseek', 'x', 'completed', 'dz-old-1', 'mb-1', 'live')")
        conn.commit()
    # a file the user tagged by hand
    db.record_manual_metadata_file('/m/new-2.flac', album_title='Kid A', album_artist='Radiohead')


def _items():
    return [
        (_Track('new-1', 'Everything In Its Right Place', '/m/new-1.flac', 1), 'al2', 'ar'),
        (_Track('old-1', 'Airbag', '/m/old-1.flac', 1, musicBrainzId='mb-1'), 'al1', 'ar'),
        (_Track('new-2', 'Kid A', '/m/new-2.flac', 2, _tags={'artist': 'Radiohead'}), 'al2', 'ar'),
        (_Track('theirs', 'Not Yours', '/m/theirs.flac'), 'al1', 'ar'),
        (_Track('old-2', 'Paranoid Android', '/unreachable/old-2.flac', 2), 'al1', 'ar'),
        (_Track('new-3', 'Sour Times', '/m/new-3.flac', 3,
                _data={'ArtistItems': [{'Name': 'Portishead'}, {'Name': 'Isaac Hayes'}],
                       'AlbumArtists': [{'Name': 'Portishead'}]}), 'al3', 'ar2'),
        (_Unreadable('broken', 'x'), 'al2', 'ar'),
        (_Track('new-4', 'Glory Box', None, 4, _tags={'artist': 'Beth Gibbons'}), 'al3', 'ar2'),
        # the same server id twice: the repeat sees the first one's row
        (_Track('new-1', 'Everything In Its Right Place (2)', '/m/new-1.flac', 1), 'al2', 'ar'),
        (_Track('new-5', 'Idioteque', '/m/new-5.flac', 8), 'al2', 'ar'),
    ]


def _dump(db):
    out = {}
    with db._get_connection() as conn:
        for table, order in (('tracks', 'id'), ('albums', 'id'), ('track_credits', 'track_id, name_norm'),
                             ('library_history', 'id')):
            skip = {'created_at', 'updated_at', 'timestamp', 'id' if table == 'library_history' else ''}
            cols = [c[1] for c in conn.execute(f"PRAGMA table_info({table})") if c[1] not in skip]
            out[table] = [tuple(r) for r in conn.execute(f"SELECT {', '.join(cols)} FROM {table} ORDER BY {order}")]
    return out


@pytest.fixture()
def pair(tmp_path):
    """two identical databases: one written track by track, one in batches"""
    dbs = []
    for name in ('loop', 'batch'):
        db = MusicDatabase(database_path=str(tmp_path / f"{name}.db"))
        _seed(db, tmp_path)
        dbs.append(db)
    return dbs


def _loop(db, items, server='navidrome'):
    return [db.insert_or_update_media_track(t, al, ar, server_source=server) for t, al, ar in items]


@pytest.mark.parametrize('batch_size', [1, 2, 3, 250])
def test_a_batch_writes_exactly_what_the_loop_writes(pair, monkeypatch, batch_size):
    loop_db, batch_db = pair
    monkeypatch.setattr(MusicDatabase, 'MEDIA_TRACK_WRITE_BATCH', batch_size)

    expected = _loop(loop_db, _items())
    got = batch_db.insert_or_update_media_tracks(_items(), server_source='navidrome')

    assert got == expected
    assert expected == ['inserted', 'updated', 'inserted', False, 'updated', 'inserted', False,
                        'inserted', 'updated', 'inserted']
    assert _dump(batch_db) == _dump(loop_db)


def test_the_comparison_sees_every_follow_up(pair):
    """guard for the test above: the scenario really exercises each step"""
    loop_db, _ = pair
    _loop(loop_db, _items())
    with loop_db._get_connection() as conn:
        row = conn.execute("SELECT spotify_track_id, isrc FROM tracks WHERE id = 'new-1'").fetchone()
        assert tuple(row) == ('sp-new-1', 'ISRC-1')
        row = conn.execute("SELECT deezer_id, recording_disambiguation FROM tracks WHERE id = 'old-1'").fetchone()
        assert tuple(row) == ('dz-old-1', 'live')
        assert conn.execute("SELECT metadata_locked FROM tracks WHERE id = 'new-2'").fetchone()[0] == 1
        assert conn.execute("SELECT metadata_locked FROM albums WHERE id = 'al2'").fetchone()[0] == 1
        assert conn.execute("SELECT file_path FROM tracks WHERE id = 'old-2'").fetchone()[0].endswith('-local.flac')
        assert conn.execute("SELECT track_artist FROM tracks WHERE id = 'new-4'").fetchone()[0] == 'Beth Gibbons'
        assert conn.execute("SELECT owner_profile_id FROM tracks WHERE id = 'theirs'").fetchone()[0] == 7
        titles = [r[0] for r in conn.execute("SELECT title FROM library_history WHERE event_type = 'import' ORDER BY id")]
        assert titles == ['Everything In Its Right Place', 'Kid A', 'Sour Times', 'Glory Box', 'Idioteque']


@pytest.mark.parametrize('count', [0, 1, 3, 4, 7])
def test_chunk_boundaries(tmp_path, monkeypatch, count):
    monkeypatch.setattr(MusicDatabase, 'MEDIA_TRACK_WRITE_BATCH', 3)
    dbs = []
    for name in ('loop', 'batch'):
        db = MusicDatabase(database_path=str(tmp_path / f"{name}.db"))
        _seed(db, tmp_path)
        dbs.append(db)
    items = [(_Track(f"t{n}", f"Song {n}", f"/m/t{n}.flac", n), 'al1', 'ar') for n in range(count)]

    assert dbs[1].insert_or_update_media_tracks(items, server_source='navidrome') == _loop(dbs[0], items)
    assert _dump(dbs[1]) == _dump(dbs[0])


def test_empty_input():
    db = MusicDatabase.__new__(MusicDatabase)  # never touches a database
    assert db.insert_or_update_media_tracks([], server_source='plex') == []


def test_an_unreadable_track_is_reported_like_the_single_path(pair, caplog):
    loop_db, batch_db = pair
    def errors():
        return [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]

    caplog.clear()
    with caplog.at_level(logging.ERROR):
        assert loop_db.insert_or_update_media_track(_Unreadable('broken', 'x'), 'al1', 'ar', server_source='navidrome') is False
    single_lines = errors()
    caplog.clear()
    with caplog.at_level(logging.ERROR):
        assert batch_db.insert_or_update_media_tracks([(_Unreadable('broken', 'x'), 'al1', 'ar')],
                                                      server_source='navidrome') == [False]
    assert errors() == single_lines == ["Error inserting/updating navidrome track x: server dropped the connection"]


# ── one bad track never costs its batch-mates ────────────────────────────────

def _fail_for(monkeypatch, bad_ids, times=None):
    """make _write_media_track_row raise for some ids. inside a batch it
    raises after writing, so the savepoint has something to undo; on the
    single path it raises before writing, because that path keeps its
    connection's transaction open after an error that follows a write (until
    the garbage collector closes it), which would lock everything after it.
    ``times`` limits how often it fails."""
    real = MusicDatabase._write_media_track_row
    calls = {'n': 0}

    def flaky(self, cursor, fields, *args, **kwargs):
        if fields['track_id'] in bad_ids and (times is None or calls['n'] < times):
            calls['n'] += 1
            if cursor.connection.in_transaction:   # the batch: BEGIN IMMEDIATE is open
                real(self, cursor, fields, *args, **kwargs)
            raise RuntimeError("disk I/O error")
        return real(self, cursor, fields, *args, **kwargs)

    monkeypatch.setattr(MusicDatabase, '_write_media_track_row', flaky)
    return calls


def test_a_failing_track_rolls_back_alone_and_its_batch_mates_are_kept(pair, monkeypatch, caplog):
    loop_db, batch_db = pair
    _fail_for(monkeypatch, {'new-3'})

    expected = _loop(loop_db, _items())
    with caplog.at_level(logging.ERROR):
        got = batch_db.insert_or_update_media_tracks(_items(), server_source='navidrome')

    assert got == expected
    assert got[5] is False                     # new-3 failed on its own retry too
    assert _dump(batch_db) == _dump(loop_db)
    with batch_db._get_connection() as conn:
        ids = {r[0] for r in conn.execute("SELECT id FROM tracks")}
    assert 'new-3' not in ids                  # its half-done write was undone
    assert {'new-1', 'new-2', 'new-4', 'new-5'} <= ids
    # and it was reported exactly as the single path reports it
    assert any("Error inserting/updating navidrome track Sour Times" in r.getMessage() for r in caplog.records)


def test_a_track_that_fails_once_in_the_batch_is_written_alone(pair, monkeypatch):
    loop_db, batch_db = pair
    expected = _loop(loop_db, _items())

    calls = _fail_for(monkeypatch, {'new-3'}, times=1)
    got = batch_db.insert_or_update_media_tracks(_items(), server_source='navidrome')

    assert calls['n'] == 1
    assert got == expected
    assert _dump(batch_db) == _dump(loop_db)


def test_an_error_that_ends_the_transaction_sends_the_batch_one_by_one(pair, monkeypatch):
    """some sqlite errors roll back the whole transaction, not the statement:
    the savepoint is gone and nothing of the batch survived, so every track
    gets its own write."""
    loop_db, batch_db = pair
    expected = _loop(loop_db, _items())

    real = MusicDatabase._write_media_track_row
    state = {'done': False}

    def kills_the_transaction(self, cursor, fields, *args, **kwargs):
        if fields['track_id'] == 'new-3' and not state['done']:
            state['done'] = True
            cursor.execute("ROLLBACK")
            raise RuntimeError("database disk image is malformed")
        return real(self, cursor, fields, *args, **kwargs)

    monkeypatch.setattr(MusicDatabase, '_write_media_track_row', kills_the_transaction)
    got = batch_db.insert_or_update_media_tracks(_items(), server_source='navidrome')

    assert state['done']
    assert got == expected
    assert _dump(batch_db) == _dump(loop_db)


def test_a_batch_that_cannot_start_goes_one_by_one(pair, monkeypatch):
    loop_db, batch_db = pair
    expected = _loop(loop_db, _items())

    def locked(*_args, **_kwargs):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(MusicDatabase, '_write_media_track_chunk', locked)
    assert batch_db.insert_or_update_media_tracks(_items(), server_source='navidrome') == expected
    assert _dump(batch_db) == _dump(loop_db)


def test_follow_ups_that_fail_as_a_whole_run_per_track(pair, monkeypatch):
    loop_db, batch_db = pair
    real_lock = MusicDatabase._apply_manual_lock_for_track
    state = {'killed': False}

    def lock_that_kills_the_batch(self, cursor, track_id, album_id, file_path):
        if cursor.connection.in_transaction and not state['killed'] and track_id == 'new-2':
            state['killed'] = True
            cursor.execute("ROLLBACK")
            raise RuntimeError("disk I/O error")
        return real_lock(self, cursor, track_id, album_id, file_path)

    expected = _loop(loop_db, _items())
    monkeypatch.setattr(MusicDatabase, '_apply_manual_lock_for_track', lock_that_kills_the_batch)
    got = batch_db.insert_or_update_media_tracks(_items(), server_source='navidrome')

    assert state['killed']
    assert got == expected
    assert _dump(batch_db) == _dump(loop_db)


def test_a_failing_follow_up_step_costs_only_itself(pair, monkeypatch):
    loop_db, batch_db = pair
    real = MusicDatabase._insert_library_history_row

    def history_fails_for_kid_a(cursor, *args, **kwargs):
        if kwargs.get('title') == 'Kid A' or (len(args) > 1 and args[1] == 'Kid A'):
            raise RuntimeError("constraint failed")
        return real(cursor, *args, **kwargs)

    monkeypatch.setattr(MusicDatabase, '_insert_library_history_row', staticmethod(history_fails_for_kid_a))
    expected = _loop(loop_db, _items())
    got = batch_db.insert_or_update_media_tracks(_items(), server_source='navidrome')

    assert got == expected
    assert _dump(batch_db) == _dump(loop_db)
    with batch_db._get_connection() as conn:
        titles = [r[0] for r in conn.execute("SELECT title FROM library_history ORDER BY id")]
    assert 'Kid A' not in titles and 'Idioteque' in titles


def test_one_connection_serves_the_whole_batch(pair, monkeypatch):
    _, batch_db = pair
    opened = []
    real = MusicDatabase._get_connection

    def counting(self):
        opened.append(1)
        return real(self)

    monkeypatch.setattr(MusicDatabase, '_get_connection', counting)
    items = [(_Track(f"t{n}", f"Song {n}", f"/m/t{n}.flac", n), 'al1', 'ar') for n in range(40)]
    assert batch_db.insert_or_update_media_tracks(items, server_source='navidrome') == ['inserted'] * 40
    assert len(opened) == 1


# ── album existence (the artist pass's flush rule) ───────────────────────────

@pytest.mark.parametrize('chunk', [1, 2, 500])
def test_existing_album_ids(pair, monkeypatch, chunk):
    db, _ = pair
    monkeypatch.setattr(MusicDatabase, '_ID_LOOKUP_CHUNK', chunk)
    assert db.existing_album_ids(['al1', 'al3', 'nope', 'al1']) == {'al1', 'al3'}
    assert db.existing_album_ids([]) == set()


def test_a_repeated_id_starts_a_new_batch(pair, monkeypatch):
    """the repeat must see its predecessor's follow-ups, as one by one"""
    _, batch_db = pair
    real = MusicDatabase._write_media_track_chunk
    batches = []

    def recording(self, conn, chunk, *args, **kwargs):
        batches.append([fields['track_id'] for _i, fields in chunk])
        return real(self, conn, chunk, *args, **kwargs)

    monkeypatch.setattr(MusicDatabase, '_write_media_track_chunk', recording)
    items = [(_Track(tid, tid, f"/m/{tid}.flac"), 'al1', 'ar') for tid in ('a', 'b', 'a', 'c')]
    assert batch_db.insert_or_update_media_tracks(items, server_source='navidrome') == ['inserted', 'inserted', 'updated', 'inserted']
    assert batches == [['a', 'b'], ['a', 'c']]
