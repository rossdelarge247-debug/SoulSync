"""slskd's downloads list is read once for every poller (UI latency of 27
October, docs/design/HANDOFF.md).

With one tab open and three downloads running, SYNCHRO.S read slskd's whole
``transfers/downloads`` list about 190 times a minute: the download monitor,
the completion checker (twice a tick), the socket's batch push, the dashboard
and the Downloads page each read it on their own. On a busy slskd that list is
megabytes and slskd builds it from its database each time, which is what made
slskd's own web page slow. ``SoulseekClient.get_transfers_snapshot`` is the one
copy they share now: a read younger than two seconds is reused, and readers
that arrive while a read is in flight wait for that one.
"""

from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from core import soulseek_client as sc
from core.downloads import status as st
from core.runtime_state import download_batches, download_tasks, tasks_lock
from utils.async_helpers import AsyncCallTimeout, run_async

LIST = [{"username": "peer", "directories": [{"directory": "d", "files": [
    {"id": "1", "filename": "d\\01 - Song.flac", "state": "InProgress", "size": 10,
     "bytesTransferred": 5, "averageSpeed": 100.0, "percentComplete": 50.0}]}]}]


def _client():
    client = sc.SoulseekClient.__new__(sc.SoulseekClient)
    client.base_url = "http://localhost:5030"
    client.api_key = "k"
    client.download_path = Path("./test_downloads")
    return client


class _Slskd:
    """Stands in for ``_make_request``: counts reads of the list, each taking
    ``delay`` seconds and answering ``answer``."""

    def __init__(self, answer=LIST, delay=0.0):
        self.answer = answer
        self.delay = delay
        self.reads = 0

    async def __call__(self, method, endpoint, **kwargs):
        assert (method, endpoint) == ("GET", "transfers/downloads")
        self.reads += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.answer


def test_readers_arriving_together_share_one_read():
    client, slskd = _client(), _Slskd(delay=0.2)
    client._make_request = slskd

    async def five_pollers():
        return await asyncio.gather(*(client.get_transfers_snapshot() for _ in range(5)))

    results = run_async(five_pollers())

    assert slskd.reads == 1
    assert all(r == LIST for r in results)


def test_a_read_is_reused_while_fresh_and_redone_after():
    client, slskd = _client(), _Slskd()
    client._make_request = slskd

    assert run_async(client.get_transfers_snapshot()) == LIST
    assert run_async(client.get_transfers_snapshot()) == LIST
    assert slskd.reads == 1
    # older than max_age: asked again
    time.sleep(0.05)
    assert run_async(client.get_transfers_snapshot(max_age=0.01)) == LIST
    assert slskd.reads == 2


def test_get_all_downloads_reads_the_shared_copy():
    client, slskd = _client(), _Slskd()
    client._make_request = slskd

    first = run_async(client.get_all_downloads())
    second = run_async(client.get_all_downloads())

    assert slskd.reads == 1
    assert [d.filename for d in first] == [d.filename for d in second] == ["d\\01 - Song.flac"]


def test_a_failed_read_is_not_kept():
    client, slskd = _client(), _Slskd(answer=None)
    client._make_request = slskd

    assert run_async(client.get_transfers_snapshot()) is None
    slskd.answer = LIST
    assert run_async(client.get_transfers_snapshot()) == LIST
    assert slskd.reads == 2


def test_stale_ok_answers_at_once_while_slskd_is_slow():
    """A request thread takes the last copy instead of waiting on slskd; the
    read it started refreshes the copy for the next one."""
    client, slskd = _client(), _Slskd()
    client._make_request = slskd
    run_async(client.get_transfers_snapshot())
    newer = [dict(LIST[0], username="newer")]
    slskd.answer, slskd.delay = newer, 0.5
    time.sleep(0.05)

    started = time.monotonic()
    got = run_async(client.get_transfers_snapshot(max_age=0.01, stale_ok=30))
    assert time.monotonic() - started < 0.3
    assert got == LIST                                  # the old copy, straight away

    # the refresh it started lands, and is what the next reader gets
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and run_async(
            client.get_transfers_snapshot(max_age=5)) != newer:
        time.sleep(0.05)
    assert run_async(client.get_transfers_snapshot(max_age=5)) == newer
    assert slskd.reads == 2


def test_a_caller_giving_up_does_not_cancel_the_read_for_the_others():
    client, slskd = _client(), _Slskd(delay=0.6)
    client._make_request = slskd

    results = {}

    def patient():
        results["patient"] = run_async(client.get_transfers_snapshot())

    with pytest.raises(AsyncCallTimeout):
        run_async(client.get_transfers_snapshot(), timeout=0.1)
    waiter = threading.Thread(target=patient)
    waiter.start()
    waiter.join(5)

    assert results["patient"] == LIST
    assert slskd.reads == 1


def test_changing_slskd_transfers_drops_the_copy():
    """An enqueue or a cancel through ``_make_request`` invalidates the copy,
    so the monitor doesn't miss a download it just started."""
    client, slskd = _client(), _Slskd()
    client._make_request = slskd
    run_async(client.get_transfers_snapshot())

    class _Response:
        status = 201
        headers = {}
        reason = "Created"

        async def text(self):
            return ""

    class _Cm:
        async def __aenter__(self):
            return _Response()

        async def __aexit__(self, *a):
            return None

    class _Session:
        def request(self, *a, **kw):
            return _Cm()

        async def close(self):
            return None

    with patch("aiohttp.ClientSession", return_value=_Session()):
        assert run_async(sc.SoulseekClient._make_request(
            client, "POST", "transfers/downloads/peer", json=[{"filename": "x", "size": 1}])) == {}
    assert run_async(client.get_transfers_snapshot()) == LIST
    assert slskd.reads == 2


def test_a_read_in_flight_during_a_change_is_not_kept():
    client, slskd = _client(), _Slskd(delay=0.3)
    client._make_request = slskd

    async def read_then_change():
        reading = asyncio.ensure_future(client.get_transfers_snapshot())
        await asyncio.sleep(0.05)
        client.invalidate_transfers_snapshot()
        return await reading

    assert run_async(read_then_change()) == LIST       # its own caller still gets it
    run_async(client.get_transfers_snapshot())
    assert slskd.reads == 2                             # but it wasn't kept


# ── the Downloads page's poll ────────────────────────────────────────────────

@pytest.fixture
def clean_tasks():
    download_tasks.clear()
    download_batches.clear()
    yield
    download_tasks.clear()
    download_batches.clear()


def _deps(cached):
    return st.StatusDeps(
        config_manager=None, docker_resolve_path=lambda p: p,
        find_completed_file=lambda *a, **k: (None, None),
        make_context_key=lambda u, f: f"{u}::{f}",
        submit_post_processing=lambda *a: None,
        get_cached_transfer_data=cached, download_orchestrator=None, run_async=None,
    )


def test_downloads_page_reads_the_list_once_and_outside_tasks_lock(clean_tasks):
    """/api/downloads/all read slskd's list once per downloading row, with
    tasks_lock held: a slow slskd stopped the monitor, every worker and
    /status behind it."""
    calls = []

    def cached():
        calls.append(tasks_lock.locked())
        return {"peer::a.flac": {"percentComplete": 40.0}, "peer::b.flac": {"percentComplete": 70.0}}

    for i, name in enumerate(("a", "b", "c")):
        download_tasks[name] = {"track_index": i, "status": "downloading",
                                "track_info": {"name": name}, "username": "peer",
                                "filename": f"{name}.flac"}

    out = st.build_unified_downloads_response(100, _deps(cached))

    assert calls == [False]
    progress = {row["title"]: row["progress"] for row in out["downloads"]}
    assert progress["a"] == 40.0 and progress["b"] == 70.0


def test_downloads_page_without_live_rows_does_not_read_the_list(clean_tasks):
    calls = []
    download_tasks["done"] = {"track_index": 0, "status": "completed", "track_info": {"name": "x"}}

    st.build_unified_downloads_response(100, _deps(lambda: calls.append(1) or {}))

    assert calls == []
