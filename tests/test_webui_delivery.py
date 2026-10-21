"""How the real app delivers the web UI: compression on the page shell and
static files, none on audio ranges or event streams, and static URL versions
that are computed once instead of on every render.

The policy itself is unit-tested in tests/webui/test_compression.py and
tests/webui/test_static_version.py; these check the wiring in web_server.py.
"""

from __future__ import annotations

import gzip
import json
import os
import pathlib
import re
import tempfile
import threading

import pytest

_TMP = tempfile.mkdtemp(prefix='soulsync-testdb-delivery-')
os.environ['DATABASE_PATH'] = os.path.join(_TMP, 'delivery.db')
os.environ['SOULSYNC_TEST_DB_READY'] = '1'

pytest.importorskip('flask_compress')
web_server = pytest.importorskip('web_server')

import brotli  # noqa: E402
from flask import Response  # noqa: E402

from core.webui import static_version  # noqa: E402
from core.webui.compression import CompressedBodyCache  # noqa: E402

BR = {'Accept-Encoding': 'gzip, deflate, br, zstd'}
GZIP = {'Accept-Encoding': 'gzip, deflate'}
STATIC = pathlib.Path(web_server.app.static_folder)


@pytest.fixture
def client():
    client = web_server.app.test_client()
    with client.session_transaction() as sess:
        sess['profile_id'] = 1
    return client


def _decode(response):
    encoding = response.headers.get('Content-Encoding')
    if encoding == 'br':
        return brotli.decompress(response.data)
    if encoding == 'gzip':
        return gzip.decompress(response.data)
    return response.data


def test_compression_runs_after_every_other_after_request_hook():
    """Flask runs after_request hooks last-registered first, so the compression
    hook has to be the first one registered: the URL-base rewrite of the page
    shell and the JS content-type fix must see the plain body."""
    names = [getattr(hook, '__name__', None) for hook in web_server.app.after_request_funcs[None]]
    assert names[0] == '_compress_response'
    assert names.count('_compress_response') == 1


def test_page_shell_is_compressed(client):
    plain = client.get('/')
    response = client.get('/', headers=BR)

    assert response.status_code == 200
    assert response.headers['Content-Encoding'] == 'br'
    assert 'Accept-Encoding' in response.headers['Vary']
    assert len(response.data) < len(plain.data) / 4
    assert brotli.decompress(response.data) == plain.data


def test_page_shell_gzip_matches_the_identity_body(client):
    plain = client.get('/')
    response = client.get('/', headers=GZIP)

    assert response.headers['Content-Encoding'] == 'gzip'
    assert gzip.decompress(response.data) == plain.data


def test_static_js_is_compressed_and_cached(client):
    cache = web_server.app.extensions['soulsync_compress'].cache
    assert isinstance(cache, CompressedBodyCache)

    first = client.get('/static/core.js', headers=GZIP)
    hits = cache.hits
    second = client.get('/static/core.js', headers=GZIP)

    assert first.headers['Content-Encoding'] == 'gzip'
    assert first.headers['Cache-Control'] == 'public, max-age=31536000'
    assert gzip.decompress(first.data) == (STATIC / 'core.js').read_bytes()
    assert second.data == first.data
    assert cache.hits == hits + 1


def test_static_range_request_is_not_compressed(client):
    response = client.get('/static/core.js', headers={**BR, 'Range': 'bytes=0-15'})

    assert response.status_code == 206
    assert 'Content-Encoding' not in response.headers
    assert response.data == (STATIC / 'core.js').read_bytes()[:16]


def test_audio_stream_range_is_not_compressed(client, monkeypatch, tmp_path):
    audio = tmp_path / 'song.flac'
    audio.write_bytes(b'fLaC' + bytes(range(256)) * 512)

    class _Session(dict):
        lock = threading.Lock()

    session = _Session(status='ready', file_path=str(audio), stream_url=None)
    monkeypatch.setattr(web_server, '_current_stream_state', lambda: session)

    ranged = client.get('/stream/audio', headers={**BR, 'Range': 'bytes=100-4195'})
    assert ranged.status_code == 206
    assert 'Content-Encoding' not in ranged.headers
    assert ranged.headers['Content-Range'] == f'bytes 100-4195/{audio.stat().st_size}'
    assert ranged.data == audio.read_bytes()[100:4196]

    whole = client.get('/stream/audio', headers=BR)
    assert whole.status_code == 200
    assert 'Content-Encoding' not in whole.headers
    assert whole.data == audio.read_bytes()


def test_event_stream_passes_through_every_hook_unbuffered():
    def generate():
        for n in range(100):
            yield f"data: {json.dumps({'n': n, 'pad': 'x' * 40})}\n\n"

    with web_server.app.test_request_context('/api/library/completion-stream', headers=BR):
        response = web_server.app.process_response(
            Response(generate(), content_type='text/event-stream'))

        assert 'Content-Encoding' not in response.headers
        assert response.is_streamed
        assert next(response.iter_encoded()).startswith(b'data: ')


def test_static_urls_carry_a_version_per_file(client):
    html = _decode(client.get('/', headers=BR)).decode()

    versions = dict(re.findall(r'/static/([\w./-]+\.(?:js|css))\?v=([0-9a-f]+)', html))
    assert versions['core.js'] == static_version._file_digest(str(STATIC / 'core.js'))
    assert versions['style.css'] == static_version._file_digest(str(STATIC / 'style.css'))
    assert versions['core.js'] != versions['style.css']
    assert 'v=&' not in html and '?v="' not in html


def test_rendering_the_page_does_not_walk_or_hash_the_static_folder(client, monkeypatch):
    client.get('/')  # first render hashes whatever this process hasn't yet

    calls = []
    request_thread = threading.get_ident()  # the test client renders in this thread

    def walk_guard(name, real):
        def guard(*args, **kwargs):
            if threading.get_ident() != request_thread:
                return real(*args, **kwargs)  # some other worker's business
            calls.append(name)
            raise AssertionError(f'{name} during a page render')
        return guard

    monkeypatch.setattr(pathlib.Path, 'rglob', walk_guard('rglob', pathlib.Path.rglob))
    monkeypatch.setattr(os, 'walk', walk_guard('os.walk', os.walk))
    monkeypatch.setattr(static_version, '_file_digest', walk_guard('hash', static_version._file_digest))

    for _ in range(3):
        assert client.get('/').status_code == 200
    assert calls == []
