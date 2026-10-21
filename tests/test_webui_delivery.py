"""How the real app delivers the web UI: static URL versions that are computed
once instead of on every render.

The policy itself is unit-tested in tests/webui/test_static_version.py; these
check the wiring in web_server.py.
"""

from __future__ import annotations

import os
import pathlib
import re
import tempfile

import pytest

_TMP = tempfile.mkdtemp(prefix='soulsync-testdb-delivery-')
os.environ['DATABASE_PATH'] = os.path.join(_TMP, 'delivery.db')
os.environ['SOULSYNC_TEST_DB_READY'] = '1'

web_server = pytest.importorskip('web_server')

from core.webui import static_version  # noqa: E402

STATIC = pathlib.Path(web_server.app.static_folder)


@pytest.fixture
def client():
    client = web_server.app.test_client()
    with client.session_transaction() as sess:
        sess['profile_id'] = 1
    return client


def test_static_urls_carry_a_version_per_file(client):
    html = client.get('/').get_data(as_text=True)

    versions = dict(re.findall(r'/static/([\w./-]+\.(?:js|css))\?v=([0-9a-f]+)', html))
    assert versions['core.js'] == static_version._file_digest(str(STATIC / 'core.js'))
    assert versions['style.css'] == static_version._file_digest(str(STATIC / 'style.css'))
    assert versions['core.js'] != versions['style.css']
    assert 'v=&' not in html and '?v="' not in html


def test_rendering_the_page_does_not_walk_or_hash_the_static_folder(client, monkeypatch):
    client.get('/')  # first render hashes whatever this process hasn't yet

    calls = []

    def walk_guard(name):
        def guard(*_args, **_kwargs):
            calls.append(name)
            raise AssertionError(f'{name} during a page render')
        return guard

    monkeypatch.setattr(pathlib.Path, 'rglob', walk_guard('rglob'))
    monkeypatch.setattr(os, 'walk', walk_guard('os.walk'))
    monkeypatch.setattr(static_version, '_file_digest', walk_guard('hash'))

    for _ in range(3):
        assert client.get('/').status_code == 200
    assert calls == []
