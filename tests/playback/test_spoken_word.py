"""Podcast and audiobook progress and plays (HANDOFF 46).

Where each profile got to in an episode or an audiobook, and its plays of
them, kept per profile (core/playback/spoken.py) and apart from
listening_history, which stays music only for Stats and scrobbling. The routes
(api/player.py) always use the session's own profile.
"""

from __future__ import annotations

import os
import tempfile

import pytest

from core.playback import spoken

_TMP = tempfile.mkdtemp(prefix='soulsync-testdb-spoken-')
os.environ['DATABASE_PATH'] = os.path.join(_TMP, 'spoken.db')
os.environ['SOULSYNC_TEST_DB_READY'] = '1'


@pytest.fixture
def mdb(tmp_path):
    from database.music_database import MusicDatabase

    return MusicDatabase(str(tmp_path / 'm.db'))


# ── the rules ──

def test_finished_means_near_the_end():
    assert spoken.finish_margin(1800) == 60       # 5% capped at a minute
    assert spoken.finish_margin(100) == 10        # at least 10 s
    assert spoken.is_finished(1750, 1800)
    assert not spoken.is_finished(1700, 1800)
    assert not spoken.is_finished(50, None)


def test_resume_point():
    assert spoken.resume_at({'position_s': 754.3, 'finished': False}) == 754.3
    assert spoken.resume_at({'position_s': 1790, 'finished': True}) == 0
    assert spoken.resume_at({'position_s': 3, 'finished': False}) == 0
    assert spoken.resume_at(None) == 0


def test_addresses_kept_for_play_again():
    assert spoken.clean_src('https://cdn.example/ep.mp3') == 'https://cdn.example/ep.mp3'
    assert spoken.clean_src('/api/audiobooks/sample-proxy?url=https%3A%2F%2Fx').startswith('/api/audiobooks/')
    for bad in ('javascript:alert(1)', '/api/settings', '//evil.example/x.mp3', 'data:audio/mp3;base64,AA',
                'https://x/a b', '/api/podcasts/audio-proxy?x="><script>'):
        assert spoken.clean_src(bad) is None, bad
    assert spoken.clean_art('https://cdn.example/a.jpg') == 'https://cdn.example/a.jpg'
    assert spoken.clean_art('javascript:alert(1)') is None
    assert spoken.clean_art('"/><img onerror=x>') is None


def test_bad_requests():
    with pytest.raises(spoken.SpokenError):
        spoken.check_kind('music')
    with pytest.raises(spoken.SpokenError):
        spoken.check_media_id('x' * 600)
    with pytest.raises(spoken.SpokenError):
        spoken.check_media_id('')


# ── the store ──

def test_progress_is_kept_per_profile(mdb):
    kim = mdb.create_profile(name='kim')
    p = spoken.save_progress(mdb, kim, 'podcast', 'guid-1', 754.32, 1800, now=1000)
    assert p == {'position_s': 754.3, 'duration_s': 1800.0, 'finished': False, 'updated_at': 1000,
                 'resume_at': 754.3}
    assert spoken.get_progress(mdb, 1, 'podcast', ['guid-1']) == {}
    assert spoken.get_progress(mdb, kim, 'audiobook', ['guid-1']) == {}
    assert spoken.get_progress(mdb, kim, 'podcast', ['guid-1'])['guid-1']['position_s'] == 754.3
    # near the end is finished, and starts from the top next time
    p = spoken.save_progress(mdb, kim, 'podcast', 'guid-1', 1770, 1800)
    assert p['finished'] is True and p['resume_at'] == 0
    # starting it again from the top makes it unfinished
    p = spoken.save_progress(mdb, kim, 'podcast', 'guid-1', 30, None)
    assert p['finished'] is False and p['duration_s'] == 1800.0
    # the player's own end
    p = spoken.save_progress(mdb, kim, 'audiobook', 'B0ASIN', 290, 300, ended=True)
    assert p['finished'] is True
    with pytest.raises(spoken.SpokenError):
        spoken.save_progress(mdb, kim, 'podcast', 'guid-1', 'soon')
    with pytest.raises(spoken.SpokenError):
        spoken.save_progress(mdb, kim, 'podcast', 'guid-1', -5)


def test_plays_are_per_profile_and_a_resume_is_the_same_play(mdb):
    kim = mdb.create_profile(name='kim')
    item = {'kind': 'podcast', 'media_id': 'guid-1', 'title': 'Episode 1', 'subtitle': 'Quiet Rooms',
            'src': 'https://cdn.example/1.mp3', 'art_url': 'javascript:alert(1)', 'duration_s': 1800}
    first = spoken.log_play(mdb, kim, item, now=1_000_000)
    assert spoken.log_play(mdb, kim, item, now=1_000_000 + 600) == first   # 10 min later: same play
    second = spoken.log_play(mdb, kim, item, now=1_000_000 + 3 * 3600)
    assert second != first
    spoken.log_play(mdb, kim, {**item, 'kind': 'audiobook', 'media_id': 'B0A', 'title': 'Book'},
                    now=1_000_000 + 4 * 3600)
    spoken.save_progress(mdb, kim, 'podcast', 'guid-1', 420, 1800)
    rows = spoken.recent_plays(mdb, kim, ['podcast'])
    assert [r['play_id'] for r in rows] == [second, first]
    assert rows[0]['position_s'] == 420 and rows[0]['image_url'] is None
    assert rows[0]['src'] == 'https://cdn.example/1.mp3'
    assert [r['kind'] for r in spoken.recent_plays(mdb, kim)] == ['audiobook', 'podcast', 'podcast']
    assert spoken.recent_plays(mdb, 1) == []
    with pytest.raises(spoken.SpokenError):
        spoken.log_play(mdb, kim, {**item, 'title': '   '})


def test_plays_never_reach_listening_history(mdb):
    kim = mdb.create_profile(name='kim')
    spoken.log_play(mdb, kim, {'kind': 'podcast', 'media_id': 'g', 'title': 'Episode'})
    with mdb._get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM listening_history').fetchone()[0] == 0


def test_deleting_a_profile_takes_its_progress_and_plays(mdb):
    kim = mdb.create_profile(name='kim')
    spoken.save_progress(mdb, kim, 'podcast', 'g', 100, 1800)
    spoken.log_play(mdb, kim, {'kind': 'podcast', 'media_id': 'g', 'title': 'Episode'})
    assert mdb.delete_profile(kim)
    with mdb._get_connection() as conn:
        assert conn.execute('SELECT COUNT(*) FROM media_progress').fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM media_plays').fetchone()[0] == 0


# ── the routes (the real app) ──

web_server = pytest.importorskip('web_server')


@pytest.fixture
def client():
    return web_server.app.test_client()


@pytest.fixture
def db():
    return web_server.get_database()


def _as(client, pid):
    with client.session_transaction() as sess:
        sess['profile_id'] = pid


def _member(db):
    return db.create_profile(name=f'm_{os.urandom(3).hex()}')


def test_a_member_saves_and_reads_their_own_progress(client, db):
    kim = _member(db)
    _as(client, kim)
    gid = f'guid-{os.urandom(3).hex()}'
    r = client.put('/api/player/progress', json={'kind': 'podcast', 'media_id': gid, 'position_s': 600,
                                                 'duration_s': 1800})
    assert r.status_code == 200 and r.get_json()['progress']['position_s'] == 600
    one = client.get(f'/api/player/progress?kind=podcast&id={gid}').get_json()
    assert one['items'][gid]['resume_at'] == 600
    many = client.post('/api/player/progress/lookup', json={'kind': 'podcast', 'ids': [gid, 'nope']}).get_json()
    assert list(many['items']) == [gid]
    # the page-closing beacon posts the same body
    r = client.post('/api/player/progress', data=f'{{"kind":"podcast","media_id":"{gid}","position_s":700}}',
                    content_type='text/plain')
    assert r.status_code == 200 and r.get_json()['progress']['position_s'] == 700


def test_nobody_reads_or_writes_another_profiles_progress(client, db):
    kim = _member(db)
    bob = _member(db)
    gid = f'guid-{os.urandom(3).hex()}'
    spoken.save_progress(db, bob, 'podcast', gid, 900, 1800)
    _as(client, kim)
    hdr = {'X-Profile-Id': str(bob)}
    got = client.post(f'/api/player/progress/lookup?profile_id={bob}', headers=hdr,
                      json={'kind': 'podcast', 'ids': [gid], 'profile_id': bob}).get_json()
    assert got['items'] == {}
    client.put('/api/player/progress', headers=hdr,
               json={'kind': 'podcast', 'media_id': gid, 'position_s': 5, 'profile_id': bob})
    assert spoken.get_progress(db, bob, 'podcast', [gid])[gid]['position_s'] == 900
    spoken.log_play(db, bob, {'kind': 'podcast', 'media_id': gid, 'title': 'Bob’s episode'})
    plays = client.get(f'/api/player/plays?kind=podcast&profile_id={bob}', headers=hdr).get_json()['items']
    assert all(p['title'] != 'Bob’s episode' for p in plays)
    recent = client.get('/api/player/recent', headers=hdr).get_json()['items']
    assert all(p.get('title') != 'Bob’s episode' for p in recent)


def test_bad_bodies_are_400(client, db):
    _as(client, _member(db))
    assert client.put('/api/player/progress', json={'kind': 'music', 'media_id': 'x',
                                                    'position_s': 1}).status_code == 400
    assert client.put('/api/player/progress', json={'kind': 'podcast', 'media_id': '',
                                                    'position_s': 1}).status_code == 400
    assert client.post('/api/player/progress/lookup', json={'kind': 'podcast',
                                                            'ids': [str(i) for i in range(101)]}).status_code == 400
    assert client.post('/api/player/plays', json={'kind': 'podcast', 'media_id': 'x'}).status_code == 400
    assert client.get('/api/player/plays?kind=music').status_code == 400


def test_plays_show_in_recent_with_their_kind_and_in_listening_history(client, db):
    kim = _member(db)
    _as(client, kim)
    gid = f'guid-{os.urandom(3).hex()}'
    r = client.post('/api/player/plays', json={'kind': 'podcast', 'media_id': gid, 'title': 'Episode 12',
                                               'subtitle': 'Quiet Rooms', 'src': 'https://cdn.example/12.mp3',
                                               'duration_s': 1800})
    assert r.status_code == 200 and r.get_json()['play_id']
    client.post('/api/library/log-play', json={'track': {'title': 'Harbour Light', 'artist': 'Pale Harbour'},
                                               'duration_ms': 1000})
    recent = client.get('/api/player/recent').get_json()['items']
    kinds = {i['title']: i['kind'] for i in recent}
    assert kinds.get('Episode 12') == 'podcast'
    assert kinds.get('Harbour Light') == 'music'
    plays = client.get('/api/player/plays?kind=podcast').get_json()['items']
    assert plays[0]['title'] == 'Episode 12' and plays[0]['src'] == 'https://cdn.example/12.mp3'
    assert client.get('/api/player/plays?kind=audiobook').get_json()['items'] == []
    # Stats stay music only: the episode isn't a listening_history row
    with db._get_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM listening_history WHERE title = 'Episode 12'").fetchone()[0] == 0
