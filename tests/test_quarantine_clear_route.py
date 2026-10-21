"""POST /api/quarantine/clear-preview and /api/quarantine/clear.

Clearing the quarantine deletes files for good, so the route only does it
against a preview plan: clear-preview lists every entry (count, size, oldest
and newest date, a sample of the downloads) and deletes nothing; clear
deletes exactly that plan's entries, given its fresh plan_id, and refuses
(409) without one. A bad entry is logged and skipped, the rest still go.
"""

from __future__ import annotations

import os

import pytest
from flask import Flask

import api.quarantine as q_api
from core.library.action_plans import plan_store


class _FakeConfig:
    def __init__(self, download_path):
        self.values = {'soulseek.download_path': download_path}

    def get(self, key, default=None):
        return self.values.get(key, default)


@pytest.fixture
def client(tmp_path):
    q_api.configure(
        config_manager_=_FakeConfig(str(tmp_path)),
        docker_resolve_path_=lambda p: p,
        serve_audio_file_with_range=None,
        audio_mime_types={},
        post_process_matched_download=None,
        post_process_matched_download_with_verification=None,
        download_orchestrator_getter=lambda: None,
        matching_engine_getter=lambda: None,
    )
    app = Flask(__name__)
    app.register_blueprint(q_api.bp)
    app.config['TESTING'] = True
    c = app.test_client()
    c.quarantine_dir = os.path.join(str(tmp_path), 'ss_quarantine')
    plan_store.clear()
    yield c
    plan_store.clear()


def _put(client, name, payload=b''):
    os.makedirs(client.quarantine_dir, exist_ok=True)
    path = os.path.join(client.quarantine_dir, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(payload)
    return path


def _entry(client, stem, mtime, payload=b'audio'):
    _put(client, f'{stem}.flac.quarantined', payload)
    sidecar = _put(client, f'{stem}.json', b'{}')
    os.utime(sidecar, (mtime, mtime))


def _preview(client):
    r = client.post('/api/quarantine/clear-preview')
    assert r.status_code == 200
    return r.get_json()


def test_a_missing_folder_previews_nothing_to_confirm(client):
    body = _preview(client)
    assert body['success'] is True and body['plan_id'] is None and body['files'] == 0


def test_preview_counts_files_size_and_dates_and_deletes_nothing(client):
    _entry(client, '20260101_a', 1767225600, b'12345')       # 2026-01-01
    _entry(client, '20260301_b', 1772323200, b'123')         # 2026-03-01

    body = _preview(client)

    assert body['plan_id'] and body['total'] == 4             # two downloads, two sidecars
    assert body['files'] == 2 and body['info_files'] == 2
    assert body['total_bytes'] == 5 + 3 + 2 + 2
    assert body['oldest'].startswith('2026-01-01')
    assert body['newest'].startswith('2026-03-01')
    assert sorted(i['name'] for i in body['sample']) == [
        '20260101_a.flac.quarantined', '20260301_b.flac.quarantined']
    assert len(os.listdir(client.quarantine_dir)) == 4


@pytest.mark.parametrize('body,code', [
    (None, 'plan_required'),
    ({}, 'plan_required'),
    ({'plan_id': 'nope'}, 'plan_unknown'),
])
def test_clear_without_a_usable_plan_deletes_nothing(client, body, code):
    _put(client, 'a.flac')
    r = client.post('/api/quarantine/clear', json=body) if body is not None \
        else client.post('/api/quarantine/clear')
    assert r.status_code == 409
    assert r.get_json()['code'] == code
    assert os.listdir(client.quarantine_dir) == ['a.flac']


def test_clear_deletes_exactly_the_previewed_entries(client):
    _entry(client, '20260101_a', 1767225600)
    os.makedirs(os.path.join(client.quarantine_dir, 'album'))
    _put(client, 'album/b.flac')
    plan = _preview(client)
    _put(client, '20260401_late.flac.quarantined')            # quarantined after the preview

    r = client.post('/api/quarantine/clear', json={'plan_id': plan['plan_id']})

    assert r.status_code == 200
    body = r.get_json()
    assert body['removed'] == 3 and body['files_removed'] == 2
    assert body['message'] == 'Deleted 2 quarantined files.'
    assert os.listdir(client.quarantine_dir) == ['20260401_late.flac.quarantined']


def test_a_clear_plan_is_single_use(client):
    _put(client, 'a.flac')
    plan = _preview(client)
    assert client.post('/api/quarantine/clear', json={'plan_id': plan['plan_id']}).status_code == 200
    again = client.post('/api/quarantine/clear', json={'plan_id': plan['plan_id']})
    assert again.status_code == 409 and again.get_json()['code'] == 'plan_unknown'


def test_one_item_reads_singular(client):
    _put(client, 'a.flac')
    plan = _preview(client)
    assert client.post('/api/quarantine/clear', json={'plan_id': plan['plan_id']}).get_json()["message"] == \
        "Deleted 1 quarantined file."


def test_a_bad_entry_is_skipped_and_the_rest_go(client, monkeypatch):
    from core.library import cleanup
    for n in ('a.flac', 'b.flac'):
        _put(client, n)
    plan = _preview(client)
    real_remove = os.remove

    def _remove(p):
        if p.endswith('a.flac'):
            raise PermissionError('locked')
        real_remove(p)
    monkeypatch.setattr(cleanup.os, 'remove', _remove)
    r = client.post('/api/quarantine/clear', json={'plan_id': plan['plan_id']})
    assert r.status_code == 200
    body = r.get_json()
    assert body["message"] == "Deleted 1 quarantined file. 1 could not be deleted."
    assert body["errors"][0]["entry"] == "a.flac"
    assert os.listdir(client.quarantine_dir) == ['a.flac']
