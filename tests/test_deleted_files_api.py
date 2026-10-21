"""http layer of the deleted-files manager. blueprint mounted on a bare
flask app with a fake config - no web_server import, no real db."""

import os

import pytest
from flask import Flask

import api.deleted_files as df_api


class _FakeConfig:
    def __init__(self, transfer):
        self.values = {'soulseek.transfer_path': transfer}

    def get(self, key, default=None):
        return self.values.get(key, default)

    def set(self, key, value):
        self.values[key] = value


@pytest.fixture
def client(tmp_path):
    cfg = _FakeConfig(str(tmp_path))
    df_api.configure(config_manager_=cfg, docker_resolve_path_=lambda p: p)
    app = Flask(__name__)
    app.register_blueprint(df_api.create_blueprint())
    app.config['TESTING'] = True
    c = app.test_client()
    c.cfg = cfg
    c.transfer = str(tmp_path)
    return c


def _quarantine(transfer, rel):
    from core.library.deleted_quarantine import record_deleted_entry
    root = os.path.join(transfer, '.deleted')
    dest = os.path.join(root, *rel.split('/'))
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, 'wb') as f:
        f.write(b'q')
    record_deleted_entry(root, dest, os.path.join(transfer, *rel.split('/')), 'repair')


def test_list_returns_entries_and_retention(client):
    _quarantine(client.transfer, 'Artist/song.flac')
    r = client.get('/api/deleted-files')
    assert r.status_code == 200
    data = r.get_json()
    assert data['success'] is True
    assert data['count'] == 1
    assert data['keep_days'] == 0
    assert data['entries'][0]['id'] == 'deleted:Artist/song.flac'


def test_restore_round_trips_a_file(client):
    _quarantine(client.transfer, 'a/b.flac')
    r = client.post('/api/deleted-files/restore', json={'ids': ['deleted:a/b.flac']})
    assert r.get_json()['restored'] == ['deleted:a/b.flac']
    assert os.path.isfile(os.path.join(client.transfer, 'a', 'b.flac'))


def test_restore_requires_ids(client):
    assert client.post('/api/deleted-files/restore', json={}).status_code == 400
    assert client.post('/api/deleted-files/restore', json={'ids': []}).status_code == 400


def _preview(client, body):
    r = client.post('/api/deleted-files/purge-preview', json=body)
    assert r.status_code == 200
    return r.get_json()


def test_purge_all_empties_the_bin_against_its_preview(client):
    _quarantine(client.transfer, 'x.mp3')
    _quarantine(client.transfer, 'y.mp3')
    plan = _preview(client, {'all': True})
    assert client.get('/api/deleted-files').get_json()['count'] == 2   # preview deleted nothing
    r = client.post('/api/deleted-files/purge', json={'plan_id': plan['plan_id']})
    assert r.status_code == 200
    assert len(r.get_json()['purged']) == 2
    assert client.get('/api/deleted-files').get_json()['count'] == 0


def test_purge_preview_says_how_many_how_big_and_from_when(client):
    from core.library import deleted_quarantine
    _quarantine(client.transfer, 'Old/a.flac')
    _quarantine(client.transfer, 'New/b.flac')
    root = os.path.join(client.transfer, '.deleted')
    manifest = deleted_quarantine._load_manifest(root)
    manifest['Old/a.flac']['deleted_at'] = '2026-01-02T03:04:05+00:00'
    manifest['New/b.flac']['deleted_at'] = '2026-09-10T11:12:13+00:00'
    deleted_quarantine._save_manifest(root, manifest)

    plan = _preview(client, {'all': True})

    assert plan['success'] is True and plan['plan_id']
    assert plan['files'] == 2 and plan['total'] == 2
    assert plan['total_bytes'] == 2
    assert plan['oldest'] == '2026-01-02T03:04:05+00:00'
    assert plan['newest'] == '2026-09-10T11:12:13+00:00'
    assert {i['name'] for i in plan['sample']} == {'a.flac', 'b.flac'}
    assert plan['expires_at'] > plan['created_at']


def test_purge_preview_of_selected_ids_lists_only_those(client):
    _quarantine(client.transfer, 'x.mp3')
    _quarantine(client.transfer, 'y.mp3')
    plan = _preview(client, {'ids': ['deleted:x.mp3']})
    assert plan['files'] == 1 and plan['sample'][0]['id'] == 'deleted:x.mp3'
    client.post('/api/deleted-files/purge', json={'plan_id': plan['plan_id']})
    assert [e['id'] for e in client.get('/api/deleted-files').get_json()['entries']] == ['deleted:y.mp3']


def test_an_empty_bin_previews_nothing_to_confirm(client):
    plan = _preview(client, {'all': True})
    assert plan['plan_id'] is None and plan['files'] == 0


@pytest.mark.parametrize('body,code', [
    ({'all': True}, 'plan_required'),
    ({'ids': ['deleted:x.mp3']}, 'plan_required'),
    ({}, 'plan_required'),
    ({'plan_id': 'nope'}, 'plan_unknown'),
])
def test_purge_without_a_usable_plan_deletes_nothing(client, body, code):
    _quarantine(client.transfer, 'x.mp3')
    r = client.post('/api/deleted-files/purge', json=body)
    assert r.status_code == 409
    assert r.get_json()['code'] == code
    assert client.get('/api/deleted-files').get_json()['count'] == 1


def test_a_purge_plan_is_spent_and_belongs_to_its_tool(client):
    from core.library.action_plans import plan_store
    _quarantine(client.transfer, 'x.mp3')
    plan = _preview(client, {'all': True})
    assert client.post('/api/deleted-files/purge', json={'plan_id': plan['plan_id']}).status_code == 200
    again = client.post('/api/deleted-files/purge', json={'plan_id': plan['plan_id']})
    assert again.status_code == 409 and again.get_json()['code'] == 'plan_unknown'
    other = plan_store.create('quarantine_clear', [{'name': 'x'}])
    wrong = client.post('/api/deleted-files/purge', json={'plan_id': other.plan_id})
    assert wrong.status_code == 409 and wrong.get_json()['code'] == 'plan_wrong_tool'


def test_a_purge_keeps_what_arrived_or_changed_after_the_preview(client):
    _quarantine(client.transfer, 'x.mp3')
    _quarantine(client.transfer, 'y.mp3')
    plan = _preview(client, {'all': True})
    _quarantine(client.transfer, 'late.mp3')
    with open(os.path.join(client.transfer, '.deleted', 'y.mp3'), 'wb') as f:
        f.write(b'a different, bigger file')

    r = client.post('/api/deleted-files/purge', json={'plan_id': plan['plan_id']}).get_json()

    assert r['purged'] == ['deleted:x.mp3']
    assert r['skipped'] == ['deleted:y.mp3']
    left = sorted(e['id'] for e in client.get('/api/deleted-files').get_json()['entries'])
    assert left == ['deleted:late.mp3', 'deleted:y.mp3']


def test_purge_preview_requires_ids_or_all(client):
    assert client.post('/api/deleted-files/purge-preview', json={}).status_code == 400
    assert client.post('/api/deleted-files/purge-preview', json={'ids': []}).status_code == 400


def test_retention_saves_and_validates(client):
    r = client.post('/api/deleted-files/retention', json={'days': 14})
    assert r.get_json() == {'success': True, 'keep_days': 14.0}
    assert client.cfg.get('library.deleted_keep_days') == 14.0
    assert client.post('/api/deleted-files/retention', json={'days': 'soon'}).status_code == 400
    assert client.post('/api/deleted-files/retention', json={'days': -1}).status_code == 400
    assert client.post('/api/deleted-files/retention', json={}).status_code == 400


def test_traversal_ids_bounce_off_the_http_layer_too(client):
    victim = os.path.join(client.transfer, 'victim.mp3')
    with open(victim, 'wb') as f:
        f.write(b'v')
    os.makedirs(os.path.join(client.transfer, '.deleted'), exist_ok=True)
    plan = _preview(client, {'ids': ['deleted:../victim.mp3']})
    assert plan['plan_id'] is None and plan['files'] == 0
    assert os.path.isfile(victim)


def test_retention_previews_what_the_keep_window_lets_go(client):
    """{retention: true}: what the Weekly Cleanup's recycle half would delete;
    the whole bin while it keeps files forever."""
    _quarantine(client.transfer, 'old.flac')
    _quarantine(client.transfer, 'new.flac')
    plan = _preview(client, {'retention': True})
    assert plan['total'] == 2 and plan['meta'] == {'scope': 'retention'}
    client.cfg.set('library.deleted_keep_days', 30)
    assert _preview(client, {'retention': True})['total'] == 0      # nothing is 30 days old yet
    assert client.get('/api/deleted-files').get_json()['count'] == 2


def test_purge_preview_still_needs_a_scope(client):
    r = client.post('/api/deleted-files/purge-preview', json={})
    assert r.status_code == 400 and r.get_json()['error'] == 'ids, all or retention required'
