"""Each profile picks its own accent (HANDOFF 35).

``profiles.accent_color`` holds a profile's own pick (NULL follows the
install's accent, which every profile has after an upgrade, so nobody's
colour changes). ``GET``/``PUT /api/profiles/me/appearance`` read and write
the signed-in profile's pick only, and the page shell paints the viewing
profile's accent before anything loads.
"""

from __future__ import annotations

import os
import re
import sqlite3
import tempfile

import pytest

from core.ui_appearance import (
    DEFAULT_ACCENT,
    accent_light,
    accent_passes,
    effective_accent,
    install_accent,
    normalise_hex,
)

_TMP = tempfile.mkdtemp(prefix='soulsync-testdb-accent-')
os.environ['DATABASE_PATH'] = os.path.join(_TMP, 'accent.db')
os.environ['SOULSYNC_TEST_DB_READY'] = '1'

PRESETS = ('#8b5cf6', '#1db954', '#1d8ab9', '#a78bfa', '#f59e0b', '#f43f5e', '#14b8a6')


# ── the sums, as webui/src/features/settings/accent.ts does them ──

def test_normalise_hex():
    assert normalise_hex('#8B5CF6') == '#8b5cf6'
    assert normalise_hex('8b5cf6') == '#8b5cf6'
    assert normalise_hex('#85f') == '#8855ff'
    for bad in ('', 'nope', '#12345', '#1234567', None, 12, 'javascript:alert(1)', '#8b5cf6;x'):
        assert normalise_hex(bad) is None


def test_light_shade_matches_the_web_app():
    assert accent_light('#8b5cf6') == '#c2a9fa'
    assert accent_light('#1db954') == '#46e27d'
    assert accent_light('#1e3a8a') == '#2d56cd'


def test_every_preset_passes_and_a_dark_blue_fails():
    assert all(accent_passes(p) for p in PRESETS)
    assert not accent_passes('#1e3a8a')
    assert not accent_passes('nope')


def test_install_and_effective_accent():
    def get_from(saved):
        return lambda key, default=None: saved.get(key, default)

    assert install_accent(get_from({})) == DEFAULT_ACCENT
    assert install_accent(get_from({'ui_appearance.accent_preset': '#1D8AB9'})) == '#1d8ab9'
    assert install_accent(get_from({'ui_appearance.accent_preset': 'custom',
                                    'ui_appearance.accent_color': '#3b82f6'})) == '#3b82f6'
    assert install_accent(get_from({'ui_appearance.accent_preset': 'custom',
                                    'ui_appearance.accent_color': 'nope'})) == DEFAULT_ACCENT
    assert effective_accent(None, '#1d8ab9') == '#1d8ab9'
    assert effective_accent('#f43f5e', '#1d8ab9') == '#f43f5e'


# ── the column ──

def test_the_column_is_added_and_existing_profiles_keep_the_install_accent(tmp_path):
    """An install from before the column: the profiles it had read as no pick."""
    from database.music_database import MusicDatabase

    path = tmp_path / 'm.db'
    db = MusicDatabase(str(path))
    pid = db.create_profile(name='kim')
    with sqlite3.connect(path) as conn:
        cols = {r[1] for r in conn.execute('PRAGMA table_info(profiles)')}
    assert 'accent_color' in cols
    assert db.get_profile_accent(1) is None
    assert db.get_profile_accent(pid) is None
    # boots again without trouble (the step is idempotent)
    MusicDatabase(str(path))
    assert db.set_profile_accent(pid, '#14b8a6') is True
    assert db.get_profile_accent(pid) == '#14b8a6'
    assert db.get_profile_accent(1) is None
    with pytest.raises(ValueError):
        db.set_profile_accent(pid, 'red; background:url(x)')
    assert db.set_profile_accent(pid, None) is True
    assert db.get_profile_accent(pid) is None
    assert db.set_profile_accent(99999, '#14b8a6') is False


def test_get_profile_does_not_carry_the_accent(tmp_path):
    """GET /api/profiles lists every profile for the picker: one profile's
    pick isn't in it."""
    from database.music_database import MusicDatabase

    db = MusicDatabase(str(tmp_path / 'm.db'))
    pid = db.create_profile(name='kim')
    db.set_profile_accent(pid, '#14b8a6')
    assert 'accent_color' not in (db.get_profile(pid) or {})
    assert all('accent_color' not in p for p in db.get_all_profiles())


# ── the routes and the page shell (the real app) ──

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


def test_no_profile_is_401(client, monkeypatch):
    """Signed out (login mode): get_current_profile_id says None."""
    import api.user_profiles as up

    monkeypatch.setattr(up, 'get_current_profile_id', lambda: None)
    assert client.get('/api/profiles/me/appearance').status_code == 401
    assert client.put('/api/profiles/me/appearance', json={'accent': '#14b8a6'}).status_code == 401


def test_a_member_reads_and_writes_their_own_pick(client, db):
    kim = _member(db)
    _as(client, kim)
    body = client.get('/api/profiles/me/appearance').get_json()
    assert body['accent'] is None
    assert body['effective_accent'] == body['install_accent']
    assert body['is_admin'] is False

    r = client.put('/api/profiles/me/appearance', json={'accent': '#F43F5E'})
    assert r.status_code == 200, r.get_json()
    assert r.get_json()['accent'] == '#f43f5e'
    assert r.get_json()['effective_accent'] == '#f43f5e'
    assert db.get_profile_accent(kim) == '#f43f5e'

    r = client.put('/api/profiles/me/appearance', json={'accent': None})
    assert r.get_json()['accent'] is None
    assert db.get_profile_accent(kim) is None


def test_bad_and_failing_colours_are_refused(client, db):
    kim = _member(db)
    _as(client, kim)
    for bad in ('red', '#12', 'url(javascript:1)', 12):
        r = client.put('/api/profiles/me/appearance', json={'accent': bad})
        assert r.status_code == 400, bad
    r = client.put('/api/profiles/me/appearance', json={'accent': '#1e3a8a'})
    assert r.status_code == 400
    assert 'too dark' in r.get_json()['error']
    assert client.put('/api/profiles/me/appearance', json={}).status_code == 400
    assert client.put('/api/profiles/me/appearance', data='x', content_type='text/plain').status_code == 400
    assert db.get_profile_accent(kim) is None


def test_a_member_cannot_touch_another_profiles_pick(client, db):
    kim = _member(db)
    bob = _member(db)
    db.set_profile_accent(bob, '#1db954')
    _as(client, kim)
    # naming another profile, by header, query or body, changes nothing but your own
    r = client.put(f'/api/profiles/me/appearance?profile_id={bob}', json={'accent': '#14b8a6', 'profile_id': bob},
                   headers={'X-Profile-Id': str(bob)})
    assert r.status_code == 200
    assert db.get_profile_accent(bob) == '#1db954'
    assert db.get_profile_accent(kim) == '#14b8a6'
    read = client.get('/api/profiles/me/appearance', headers={'X-Profile-Id': str(bob)}).get_json()
    assert read['accent'] == '#14b8a6'


def test_an_admin_sets_their_own_pick_not_the_install_accent(client, db):
    _as(client, 1)
    before = web_server.config_manager.get('ui_appearance.accent_preset', DEFAULT_ACCENT)
    r = client.put('/api/profiles/me/appearance', json={'accent': '#f59e0b'})
    assert r.status_code == 200 and r.get_json()['is_admin'] is True
    assert db.get_profile_accent(1) == '#f59e0b'
    assert web_server.config_manager.get('ui_appearance.accent_preset', DEFAULT_ACCENT) == before
    db.set_profile_accent(1, None)


def _shell_accent(client):
    body = client.get('/').get_data(as_text=True)
    m = re.search(r'window\._initialAccent = "(#[0-9a-f]{6})"', body)
    rgb = re.search(r'--accent-rgb:\s*([^;]+);', body)
    return (m.group(1) if m else None), rgb.group(1).strip() if rgb else None


def test_the_page_shell_paints_the_viewing_profiles_accent(client, db, monkeypatch):
    install = install_accent(web_server.config_manager.get)
    kim = _member(db)
    bob = _member(db)
    db.set_profile_accent(kim, '#14b8a6')

    _as(client, kim)
    assert _shell_accent(client) == ('#14b8a6', '20, 184, 166')
    # a profile without a pick gets the install's accent
    _as(client, bob)
    hex_, _rgb = _shell_accent(client)
    assert hex_ == install
    # no profile chosen yet (the picker): the install's, never someone's pick
    with client.session_transaction() as sess:
        sess.clear()
    assert _shell_accent(client)[0] == install
