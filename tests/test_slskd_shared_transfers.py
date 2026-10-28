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


# ── gauntlet review ──────────────────────────────────────────────────────────

def test_h1_reads_on_throwaway_loops_leave_nothing_behind():
    """gauntlet H1 (the reviewer's leak_mem.py): the in-flight table kept one
    entry per event loop, and the finished task in it held its loop and its
    whole list; the Clients tab (asyncio.run every 10 s), audiobooks and
    streaming prepare each made a new loop per read. ~4.5 MB a call."""
    import gc
    import json
    import tracemalloc

    files = [{"id": "%032x" % i, "filename": "Music\\Artist %d\\Album\\%02d - Track.flac" % (i, i % 20),
              "state": "Completed, Succeeded", "size": 30_000_000, "bytesTransferred": 30_000_000}
             for i in range(3000)]
    payload = json.dumps([{"username": "u", "directories": [{"directory": "d", "files": files}]}])
    client = _client()

    async def fake(method, endpoint, **kw):
        return json.loads(payload)

    client._make_request = fake
    state = client._transfers_state()

    for _ in range(3):                                 # warm up
        client.invalidate_transfers_snapshot()
        asyncio.run(client.get_transfers_snapshot())
    gc.collect()
    tracemalloc.start()
    before = tracemalloc.get_traced_memory()[0]
    for _ in range(40):
        client.invalidate_transfers_snapshot()      # as when the copy is over 2 s old
        asyncio.run(client.get_transfers_snapshot())
    gc.collect()
    grown = tracemalloc.get_traced_memory()[0] - before
    tracemalloc.stop()

    assert state["reads"] == {}
    # one list is ~1.2 MB here; forty kept would be ~50 MB
    assert grown < 5_000_000, grown


def test_h1_a_stale_read_left_running_on_a_closing_loop_leaves_no_entry():
    client, slskd = _client(), _Slskd(delay=0.5)
    client._make_request = slskd
    run_async(client.get_transfers_snapshot())
    time.sleep(0.05)

    async def stale_reader():
        return await client.get_transfers_snapshot(max_age=0.01, stale_ok=30)

    assert asyncio.run(stale_reader()) == LIST         # the loop closes with its read pending
    assert client._transfers_state()["reads"] == {} or all(
        task.done() for _, task in client._transfers_state()["reads"].values())
    run_async(client.get_transfers_snapshot(max_age=5))
    assert all(not task.done() for _, task in client._transfers_state()["reads"].values())


def test_m1_a_reader_after_a_change_does_not_join_the_read_before_it():
    """gauntlet M1 (the reviewer's probe_snapshot.py): a 1 s read starts, an
    enqueue lands at 0.2 s, a reader starting after the enqueue must get the
    list with the new transfer, not join the read that started before it."""
    client = _client()
    server = {"files": ["old"]}
    reads = {"n": 0}

    async def fake(method, endpoint, **kw):
        if method == "GET":
            reads["n"] += 1
            seen = list(server["files"])            # slskd builds it as asked
            await asyncio.sleep(1.0)
            return [{"username": "u", "directories": [{"files": [{"filename": f} for f in seen]}]}]
        server["files"] = server["files"] + ["new"]
        client.invalidate_transfers_snapshot()
        return {}

    client._make_request = fake
    got = {}
    first = threading.Thread(target=lambda: got.setdefault("a", run_async(client.get_transfers_snapshot())))
    first.start()
    time.sleep(0.2)
    run_async(client._make_request("POST", "transfers/downloads/u"))
    got["b"] = run_async(client.get_transfers_snapshot())
    first.join(5)

    def names(d):
        return [f["filename"] for f in d[0]["directories"][0]["files"]]

    assert names(got["b"]) == ["old", "new"]
    assert names(got["a"]) == ["old"]
    assert reads["n"] == 2


@pytest.mark.parametrize("method, endpoint, drops", [
    ("POST", "transfers/downloads/peer", True),
    ("DELETE", "transfers/downloads/peer/abc", True),
    ("POST", "transfers/peer/enqueue", True),
    ("POST", "users/peer/downloads", True),
    ("POST", "users/peer/enqueue", True),
    ("POST", "users/peer/directory", False),           # a folder browse changes nothing
    ("POST", "searches", False),
    ("GET", "transfers/downloads", False),
])
def test_l5_which_requests_drop_the_copy(method, endpoint, drops):
    assert sc._changes_transfers(method, endpoint) is drops


def test_l5_a_post_that_times_out_still_drops_the_copy():
    """slskd may have taken the enqueue even though its answer never came."""
    client, slskd = _client(), _Slskd()
    client._make_request = slskd
    run_async(client.get_transfers_snapshot())

    class _Session:
        def request(self, *a, **kw):
            class _Cm:
                async def __aenter__(self):
                    raise asyncio.TimeoutError("slskd hung")

                async def __aexit__(self, *a):
                    return None
            return _Cm()

        async def close(self):
            return None

    with patch("aiohttp.ClientSession", return_value=_Session()):
        assert run_async(sc.SoulseekClient._make_request(
            client, "POST", "users/peer/enqueue", json=[{"filename": "x"}])) is None
    run_async(client.get_transfers_snapshot())
    assert slskd.reads == 2


def test_l5_the_video_downloader_drops_the_music_sides_copy(monkeypatch):
    from core.video import slskd_download as vd

    client, slskd = _client(), _Slskd()
    client._make_request = slskd
    run_async(client.get_transfers_snapshot())
    monkeypatch.setattr(vd, "_conn", lambda: ("http://slskd", {}))

    class _Ok:
        def raise_for_status(self):
            return None

    monkeypatch.setattr(vd.requests, "post", lambda *a, **kw: _Ok())
    assert vd.start_download("peer", "a.mkv", 10) == {"ok": True}

    run_async(client.get_transfers_snapshot())
    assert slskd.reads == 2


def test_l3_the_album_cancel_confirmation_reads_slskd_each_time(monkeypatch):
    """gauntlet L3: the confirm loop re-read the copy from before the cancel
    (under 2 s old), so a transfer that had stopped still looked active and
    the album was given up."""
    from unittest.mock import AsyncMock

    client = _client()
    states = iter(["InProgress", "Completed, Cancelled"])

    async def fake(method, endpoint, **kw):
        assert method == "GET"
        return [{"username": "peer", "directories": [{"files": [
            {"id": "1", "filename": "d\\a.flac", "state": next(states, "Completed, Cancelled")}]}]}]

    client._make_request = fake
    monkeypatch.setattr(sc, "get_poll_interval", lambda: 0.01)
    key = ("peer", "d\\a.flac")
    with patch.object(client, "cancel_download", AsyncMock(return_value=True)):
        assert client._cancel_album_pending([key], {key: type("T", (), {"filename": "a.flac"})()}) is True


# ── the monitor ──────────────────────────────────────────────────────────────

class _Orch:
    def __init__(self, answers, unreachable=False):
        self.answers = list(answers)
        self.slsk = type("S", (), {"base_url": "http://slskd",
                                   "unreachable_backoff_active": lambda _s: unreachable})()
        self.engine = type("E", (), {"get_all_downloads": self._none})()

    async def _none(self, exclude=()):
        return []

    def client(self, name):
        return self.slsk

    async def get_soulseek_transfers(self, *a, **kw):
        return self.answers.pop(0)


def _monitor(monkeypatch, orch):
    from core.downloads import monitor as dm
    monkeypatch.setattr(dm.config_manager, "get", lambda key, default=None:
                        "soulseek" if key == "download_source.mode" else default)
    monkeypatch.setattr(dm, "download_orchestrator", orch)
    mon = dm.WebUIDownloadMonitor()
    mon.monitoring = True
    return dm, mon


def test_monitor_reads_no_answer_from_slskd_as_unknown_for_a_while(monkeypatch):
    """A busy slskd that doesn't answer its list isn't "no transfers": the
    tick is skipped (every download over 90 s used to be restarted as stuck,
    its peer blacklisted), up to SLSKD_UNANSWERED_GRACE_SECONDS."""
    dm, mon = _monitor(monkeypatch, _Orch([None, None, LIST]))

    assert mon._get_live_transfers() is dm._LIVE_TRANSFERS_FETCH_FAILED
    mon._slskd_unanswered_since -= dm.SLSKD_UNANSWERED_GRACE_SECONDS + 1
    assert mon._get_live_transfers() == {}             # past the grace: as before
    assert mon._get_live_transfers() != {}             # slskd answers again
    assert mon._slskd_unanswered_since is None


def test_monitor_handles_slskd_refusing_connections_as_before(monkeypatch):
    dm, mon = _monitor(monkeypatch, _Orch([None], unreachable=True))
    assert mon._get_live_transfers() == {}


def test_monitor_empty_list_is_not_a_failure(monkeypatch):
    dm, mon = _monitor(monkeypatch, _Orch([[]]))
    assert mon._get_live_transfers() == {}
