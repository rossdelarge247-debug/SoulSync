"""a playlist sync reads every sync_match_cache row and cached library row its
matcher will need in a few queries up front (core.sync.match_prefetch)
instead of ~3 connections and a commit per track.

contract: the matcher picks exactly the same tracks with the same confidence,
and the cache ends up exactly as before (rows dropped and saved, use counts
bumped once per hit the matcher actually used).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

import services.sync_service as sync_service
from core.library_scope import reset_library_scope, set_library_scope
from core.sync.match_prefetch import SyncMatchPrefetch
from database.music_database import MusicDatabase


SERVER = 'navidrome'


def _db(tmp_path, name='music.db'):
    db = MusicDatabase(str(tmp_path / name))
    with db._get_connection() as conn:
        conn.execute("INSERT INTO artists (id, name, server_source) VALUES ('a-ts', 'Taylor Swift', ?)", (SERVER,))
        conn.execute("INSERT INTO artists (id, name, server_source) VALUES ('a-met', 'Metallica', ?)", (SERVER,))
        conn.execute("INSERT INTO artists (id, name, server_source) VALUES ('a-po', 'Portishead', ?)", (SERVER,))
        conn.execute("INSERT INTO albums (id, artist_id, title, server_source) VALUES ('al-ts', 'a-ts', '1989', ?)", (SERVER,))
        conn.execute("INSERT INTO albums (id, artist_id, title, server_source) VALUES ('al-gh', 'a-met', 'Greatest Hits', ?)", (SERVER,))
        conn.execute("INSERT INTO albums (id, artist_id, title, server_source) VALUES ('al-du', 'a-po', 'Dummy', ?)", (SERVER,))
        for tid, album, artist, title in (
                ('t-style', 'al-ts', 'a-ts', 'Style'), ('t-blank', 'al-ts', 'a-ts', 'Blank Space'),
                ('t-sky', 'al-ts', 'a-ts', 'Blue Sky'), ('t-met', 'al-gh', 'a-met', 'Blue Sky'),
                ('t-sour', 'al-du', 'a-po', 'Sour Times'), ('t-glory', 'al-du', 'a-po', 'Glory Box'),
                ('t-owned', 'al-du', 'a-po', 'Roads')):
            conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, server_source) VALUES (?, ?, ?, ?, ?)",
                         (tid, album, artist, title, SERVER))
        # another profile's own-library row
        conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, server_source, owner_profile_id) "
                     "VALUES ('t-own5', 'al-du', 'a-po', 'Numb', ?, 5)", (SERVER,))
        conn.commit()
    db.ensure_norm_backfilled()
    # the cache a previous sync left behind
    db.save_sync_match_cache('sp-style', 'style', 'taylor swift', SERVER, 't-style', 'Style', 0.95)
    db.save_sync_match_cache('sp-blank', 'blank space', 'taylor swift', SERVER, 't-blank', 'Blank Space', 1.0)
    db.save_sync_match_cache('sp-gone', 'wildest dreams', 'taylor swift', SERVER, 't-deleted', 'Wildest Dreams', 1.0)
    db.save_sync_match_cache('sp-poison', 'blue sky', 'taylor swift', SERVER, 't-met', 'Blue Sky', 1.0)  # #1721 shape
    db.save_sync_match_cache('src-sour', 'sour times', 'portishead', SERVER, 't-sour', 'Sour Times', 0.9)  # second id
    db.save_sync_match_cache('sp-style', 'style', 'taylor swift', 'plex', 'p-style', 'Style', 0.8)  # other server
    return db


def _tracks():
    from core.spotify_client import Track as SpotifyTrack

    def t(sid, name, artist, album='', source=None):
        return SpotifyTrack(id=sid, name=name, artists=[artist], album=album, duration_ms=0, popularity=0,
                            source_track_id=source)

    return [
        t('sp-style', 'Style', 'Taylor Swift', '1989'),              # cache hit
        t('sp-blank', 'Blank Space', 'Taylor Swift', '1989'),        # cache hit
        t('sp-gone', 'Wildest Dreams', 'Taylor Swift', '1989'),      # cached track deleted: falls through
        t('sp-poison', 'Blue Sky', 'Taylor Swift', 'Greatest Hits'),  # stale: dropped, matched afresh, saved
        t('sp-new-sour', 'Sour Times', 'Portishead', 'Dummy', source='src-sour'),  # hit on the second id
        t('sp-glory', 'Glory Box', 'Portishead', 'Dummy'),           # miss: matched, saved
        t('sp-glory', 'Glory Box', 'Portishead', 'Dummy'),           # repeat: hits what the first saved
        t('sp-style', 'Style', 'Taylor Swift', '1989'),              # repeat hit: two bumps
        t('sp-none', 'Not In The Library', 'Nobody'),                # miss, no match
    ]


def _same_db(db):
    class _SameDB(type(db)):
        def __new__(cls, *a, **k):
            return db
    return _SameDB


def _config():
    cm = MagicMock()
    cm.get_active_media_server.return_value = SERVER
    cm.get.side_effect = lambda key, default=None: default
    return cm


def _service():
    svc = sync_service.PlaylistSyncService(spotify_client=MagicMock(), download_orchestrator=MagicMock(),
                                           media_server_engine=MagicMock())
    client = MagicMock()
    client.is_connected.return_value = True
    svc._get_active_media_client = lambda *a, **k: (client, SERVER)
    svc._cancelled = False
    return svc


def _cache(db):
    with db._get_connection() as conn:
        return [tuple(r) for r in conn.execute(
            "SELECT spotify_track_id, server_source, server_track_id, server_track_title, confidence, use_count "
            "FROM sync_match_cache ORDER BY spotify_track_id, server_source")]


def _match_all(db, *, prefetched):
    """the sync loop's matching pass, with or without the read-ahead"""
    svc = _service()
    tracks = _tracks()
    with patch('database.music_database.MusicDatabase', _same_db(db)), \
         patch('core.settings.config_manager', _config()), \
         patch('core.artists.map.get_current_profile_id', return_value=1):
        prefetch = sync_service._load_match_prefetch(tracks) if prefetched else None
        assert (prefetch is not None) == prefetched
        token = sync_service._sync_match_prefetch.set(prefetch)
        try:
            pool = {}
            results = []
            for track in tracks:
                found, confidence = asyncio.run(svc._find_track_in_media_server(track, candidate_pool=pool))
                results.append((getattr(found, 'ratingKey', None), confidence))
        finally:
            sync_service._sync_match_prefetch.reset(token)
        if prefetch is not None:
            sync_service._flush_match_prefetch(prefetch)
    return results


def test_the_matcher_picks_and_caches_exactly_as_without_the_read_ahead(tmp_path):
    plain_db = _db(tmp_path, 'plain.db')
    fast_db = _db(tmp_path, 'fast.db')

    plain = _match_all(plain_db, prefetched=False)
    fast = _match_all(fast_db, prefetched=True)

    assert fast == plain
    assert [tid for tid, _c in plain] == ['t-style', 't-blank', None, 't-sky', 't-sour', 't-glory', 't-glory',
                                          't-style', None]
    assert _cache(fast_db) == _cache(plain_db)
    rows = {(row[0], row[1]): row for row in _cache(fast_db)}
    assert rows[('sp-style', SERVER)][5] == 3        # saved with 1, hit twice
    assert rows[('sp-style', 'plex')][5] == 1        # other server untouched
    assert rows[('sp-poison', SERVER)][2] == 't-sky'  # the poisoned pairing replaced
    assert rows[('sp-glory', SERVER)][5] == 2        # saved, then hit by the repeat


def test_a_warm_resync_reads_the_cache_without_a_connection_per_track(tmp_path, monkeypatch):
    db = _db(tmp_path)
    tracks = _tracks()[:2] * 20      # 40 cached tracks
    opened = []
    real = MusicDatabase._get_connection
    monkeypatch.setattr(MusicDatabase, '_get_connection', lambda self: opened.append(1) or real(self))
    svc = _service()
    with patch('database.music_database.MusicDatabase', _same_db(db)), \
         patch('core.settings.config_manager', _config()), \
         patch('core.artists.map.get_current_profile_id', return_value=1):
        for prefetched in (False, True):
            opened.clear()
            prefetch = sync_service._load_match_prefetch(tracks) if prefetched else None
            token = sync_service._sync_match_prefetch.set(prefetch)
            try:
                for track in tracks:
                    asyncio.run(svc._find_track_in_media_server(track, candidate_pool={}))
            finally:
                sync_service._sync_match_prefetch.reset(token)
            if prefetch is not None:
                sync_service._flush_match_prefetch(prefetch)
            if prefetched:
                assert len(opened) <= 3          # cache rows, library rows, the bumps
            else:
                assert len(opened) >= 3 * len(tracks)


def test_the_sync_loop_reads_ahead_and_flushes(tmp_path, monkeypatch):
    """end to end through sync_playlist: the loop builds the read-ahead, the
    matcher uses it, the uses are recorded once the loop is done"""
    db = _db(tmp_path)
    loads = []
    real_load = sync_service._load_match_prefetch
    monkeypatch.setattr(sync_service, '_load_match_prefetch', lambda tracks: loads.append(len(tracks)) or real_load(tracks))
    import core.wishlist_service as wishlist_module
    monkeypatch.setattr(wishlist_module, 'get_wishlist_service', lambda: MagicMock())
    svc = _service()
    svc._update_progress = MagicMock()
    svc._get_active_media_client = lambda *a, **k: (MagicMock(), 'soulsync')
    tracks = _tracks()[:2]
    playlist = SimpleNamespace(id='playlist-1', name='P', tracks=tracks)
    cm = _config()
    with patch('database.music_database.MusicDatabase', _same_db(db)), \
         patch('core.settings.config_manager', cm), \
         patch('core.artists.map.get_current_profile_id', return_value=1):
        result = asyncio.run(svc.sync_playlist(playlist))
    assert loads == [2]
    assert result.matched_tracks == 2
    use = {(row[0], row[1]): row[5] for row in _cache(db)}
    assert use[('sp-style', SERVER)] == 2 and use[('sp-blank', SERVER)] == 2
    assert sync_service._sync_match_prefetch.get() is None


# ── the pieces ──────────────────────────────────────────────────────────────

def test_peek_returns_the_single_reads_rows_without_bumping(tmp_path):
    db = _db(tmp_path)
    ids = ['sp-style', 'sp-blank', 'sp-gone', 'nope', 'src-sour', 'sp-style']
    before = _cache(db)
    peeked = db.peek_sync_match_cache_bulk(ids, SERVER)
    assert _cache(db) == before
    for sid in set(ids):
        assert peeked.get(sid) == db.read_sync_match_cache(sid, SERVER)
    assert db.peek_sync_match_cache_bulk([], SERVER) == {}


def test_peek_raises_instead_of_reading_as_a_miss(tmp_path, monkeypatch):
    db = _db(tmp_path)

    def broken(self):
        raise RuntimeError("unable to open database file")

    monkeypatch.setattr(MusicDatabase, '_get_connection', broken)
    with pytest.raises(RuntimeError):
        db.peek_sync_match_cache_bulk(['sp-style'], SERVER)


def test_recorded_uses_bump_like_single_reads(tmp_path):
    single = _db(tmp_path, 'single.db')
    batched = _db(tmp_path, 'batched.db')
    for sid in ('sp-style', 'sp-style', 'sp-blank', 'nope'):
        single.read_sync_match_cache(sid, SERVER)
    batched.bump_sync_match_cache_uses({'sp-style': 2, 'sp-blank': 1, 'nope': 1, 'src-sour': 0}, SERVER)
    assert _cache(batched) == _cache(single)


@pytest.mark.parametrize('scope', [None, 'shared', 5, 'unset'])
@pytest.mark.parametrize('chunk', [1, 500])
def test_get_track_by_id_many_matches_get_track_by_id(tmp_path, monkeypatch, scope, chunk):
    db = _db(tmp_path)
    monkeypatch.setattr(MusicDatabase, '_ID_LOOKUP_CHUNK', chunk)
    ids = ['t-style', 't-met', 't-deleted', 't-own5', 't-style', 'nope']
    token = set_library_scope(scope) if scope != 'unset' else None
    try:
        expected = {str(i): db.get_track_by_id(i) for i in ids}
        assert db.get_track_by_id_many(ids) == expected
    finally:
        if token is not None:
            reset_library_scope(token)
    assert db.get_track_by_id_many([]) == {}


def test_the_prefetch_answers_from_memory_and_goes_live_when_it_should(tmp_path, monkeypatch):
    db = _db(tmp_path)
    prefetch = SyncMatchPrefetch.load(db, SERVER, ['sp-style', 'sp-blank', 'sp-nothing'])
    calls = []
    for name in ('read_sync_match_cache', 'get_track_by_id'):
        real = getattr(MusicDatabase, name)
        monkeypatch.setattr(MusicDatabase, name, lambda self, *a, real=real, name=name: calls.append(name) or real(self, *a))

    assert prefetch.read_sync_match_cache(db, 'sp-style', SERVER)['server_track_id'] == 't-style'
    assert prefetch.read_sync_match_cache(db, 'sp-nothing', SERVER) is None
    assert prefetch.get_track_by_id(db, 't-style').title == 'Style'
    assert calls == []                                           # all from memory

    assert prefetch.read_sync_match_cache(db, 'sp-style', 'plex')['server_track_id'] == 'p-style'
    assert prefetch.read_sync_match_cache(db, 'sp-gone', SERVER)['server_track_id'] == 't-deleted'  # not loaded
    assert prefetch.get_track_by_id(db, 't-glory').title == 'Glory Box'                           # not loaded
    assert calls == ['read_sync_match_cache', 'read_sync_match_cache', 'get_track_by_id']

    prefetch.rewrote('sp-style')
    calls.clear()
    prefetch.read_sync_match_cache(db, 'sp-style', SERVER)
    assert calls == ['read_sync_match_cache']                   # rewritten: live again
    prefetch.flush(db)
    use = {(row[0], row[1]): row[5] for row in _cache(db)}
    # sp-style's in-memory use was dropped with the rewrite; its live read and
    # the plex read bumped by themselves
    assert use[('sp-style', SERVER)] == 2 and use[('sp-style', 'plex')] == 2
