"""The streamed basic search (core/search/basic.py stream_basic_search and
POST /api/search/stream): progress lines while the source reports, then one
done line with the same results /api/search would give, or an error line."""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time

import pytest

from core.search import basic


class _Track:
    def __init__(self, title, quality_score=0.5, **extra):
        self.__dict__.update({'title': title, 'quality_score': quality_score, **extra})


class _Album:
    def __init__(self, title, tracks, quality_score=0.9, **extra):
        self.__dict__.update({'album_title': title, 'tracks': tracks, 'quality_score': quality_score, **extra})


def _run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _StreamingSoulseek:
    """Reports two snapshots, like slskd's polls, then answers."""

    def __init__(self, snapshots, final, pause=0.05):
        self.snapshots = snapshots
        self.final = final
        self.pause = pause

    async def search(self, query, timeout=None, progress_callback=None):
        for tracks, albums, users in self.snapshots:
            if progress_callback:
                progress_callback(tracks, albums, users)
            await asyncio.sleep(self.pause)
        return self.final


class _Quiet:
    """A source that can't report progress (no progress_callback)."""

    def __init__(self, final):
        self.final = final

    async def search(self, query):
        return self.final


class _Broken:
    async def search(self, query, timeout=None, progress_callback=None):
        raise RuntimeError('slskd exploded')


def _events(client, **kwargs):
    kwargs.setdefault('min_interval', 0)
    kwargs.setdefault('poll', 0.01)
    return list(basic.stream_basic_search('pale harbour', client, _run_async, **kwargs))


def test_progress_lines_then_done():
    folder = _Album('Tidewater', [_Track('01'), _Track('02')], username='harbourmaster')
    lone = _Track('Harbour Light', username='slackwater88')
    client = _StreamingSoulseek(
        snapshots=[([lone], [], 1), ([lone], [folder], 2)],
        final=([lone], [folder]),
    )
    events = _events(client)
    kinds = [e['type'] for e in events]
    assert kinds[-1] == 'done' and kinds.count('done') == 1
    progress = [e for e in events if e['type'] == 'progress']
    assert progress, 'the snapshots should reach the browser before the end'
    assert progress[0]['files'] == 1 and progress[0]['users'] == 1
    done = events[-1]
    # a folder's own tracks count as files
    assert done['files'] == 3 and done['users'] == 2
    assert [r['result_type'] for r in done['results']] == ['album', 'track']
    assert done['results'][0]['tracks'][0]['title'] == '01'


def test_done_matches_the_plain_search():
    final = ([_Track('a', 0.2)], [_Album('b', [_Track('b1')], 0.8)])
    client = _StreamingSoulseek(snapshots=[], final=final)
    done = _events(client)[-1]
    assert done['results'] == basic.run_basic_search('pale harbour', _Quiet(final), _run_async)


def test_a_source_that_cannot_report_answers_once():
    client = _Quiet(([_Track('only')], []))
    events = _events(client)
    assert [e['type'] for e in events] == ['done']
    assert events[0]['files'] == 1 and events[0]['users'] is None


def test_progress_is_throttled():
    snaps = [([_Track(str(i))], [], i) for i in range(1, 6)]
    client = _StreamingSoulseek(snapshots=snaps, final=(snaps[-1][0], []), pause=0.01)
    events = _events(client, min_interval=10)
    # at most one progress line inside the interval, then the answer
    assert sum(e['type'] == 'progress' for e in events) <= 1
    assert events[-1]['type'] == 'done'


def test_a_failure_is_one_error_line_without_the_internals():
    events = _events(_Broken())
    assert events == [{'type': 'error', 'error': 'The search failed.'}]


def test_a_soundcloud_link_without_soundcloud_says_why():
    class _Orch:
        def client(self, name):
            return None

        async def search(self, query):
            return [], []

    events = list(basic.stream_basic_search(
        'https://soundcloud.com/someone/a-track', _Orch(), _run_async, min_interval=0, poll=0.01))
    assert events[0]['type'] == 'error'
    assert 'SoundCloud' in events[0]['error']


def test_a_named_source_is_searched_directly():
    class _Orch:
        def __init__(self):
            self.asked = []

        def client(self, name):
            self.asked.append(name)
            return _Quiet(([_Track('from tidal')], []))

        async def search(self, query):
            raise AssertionError('the chain should not be used')

    orch = _Orch()
    events = list(basic.stream_basic_search('q', orch, _run_async, source='tidal', min_interval=0, poll=0.01))
    assert orch.asked == ['tidal']
    assert events[-1]['results'][0]['title'] == 'from tidal'


class _Stalled:
    """A search that hasn't heard from anyone yet and won't end until told to."""

    def __init__(self):
        self.release = threading.Event()

    async def search(self, query, timeout=None, progress_callback=None):
        while not self.release.is_set():
            await asyncio.sleep(0.01)
        return [], []


def test_a_quiet_search_says_it_is_still_waiting():
    client = _Stalled()
    stream = basic.stream_basic_search('pale harbour', client, _run_async,
                                       min_interval=0, poll=0.01, keepalive=0.05)
    try:
        assert [next(stream)['type'] for _ in range(3)] == ['waiting', 'waiting', 'waiting']
    finally:
        client.release.set()
    assert [e['type'] for e in stream][-1] == 'done'


def test_closing_the_stream_mid_search_ends_it():
    # what the server does when the browser has gone: the keep-alive write
    # fails and the generator is closed, freeing the request's thread
    client = _Stalled()
    stream = basic.stream_basic_search('pale harbour', client, _run_async,
                                       min_interval=0, poll=0.01, keepalive=0.05)
    try:
        assert next(stream)['type'] == 'waiting'
        started = time.monotonic()
        stream.close()
        assert time.monotonic() - started < 1
        with pytest.raises(StopIteration):
            next(stream)
    finally:
        client.release.set()


# ── the endpoint ─────────────────────────────────────────────────────────────

@pytest.fixture(scope='module')
def web_server(tmp_path_factory):
    tmp = tmp_path_factory.mktemp('stream-db')
    os.environ.setdefault('DATABASE_PATH', os.path.join(tmp, 'stream.db'))
    os.environ['SOULSYNC_TEST_DB_READY'] = '1'
    return pytest.importorskip('web_server')


def test_the_endpoint_streams_ndjson(web_server, monkeypatch):
    folder = _Album('Tidewater', [_Track('01')], username='harbourmaster')
    fake = _StreamingSoulseek(snapshots=[([], [folder], 1)], final=([], [folder]), pause=0.02)
    monkeypatch.setattr(web_server, 'download_orchestrator', fake)
    monkeypatch.setattr(web_server, 'run_async', _run_async)
    recorded = []
    monkeypatch.setattr(web_server, 'add_activity_item',
                        lambda *args, **kwargs: recorded.append((args, kwargs)))
    client = web_server.app.test_client()
    started = time.monotonic()
    response = client.post('/api/search/stream', json={'query': 'pale harbour'})
    assert response.status_code == 200
    assert response.mimetype == 'application/x-ndjson'
    lines = [json.loads(line) for line in response.get_data(as_text=True).splitlines() if line.strip()]
    assert lines[-1]['type'] == 'done' and lines[-1]['files'] == 1
    assert time.monotonic() - started < 30
    # searching as you type shouldn't toast: one quiet "Search Complete"
    assert [(args[1], kwargs.get('show_toast')) for args, kwargs in recorded] == [('Search Complete', False)]


def test_the_endpoint_needs_a_query(web_server):
    response = web_server.app.test_client().post('/api/search/stream', json={'query': '  '})
    assert response.status_code == 400
