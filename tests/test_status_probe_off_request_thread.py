"""/status and the Downloads page don't wait on slskd (UI latency of 27
October, docs/design/HANDOFF.md).

Measured with slskd accepting connections but not answering: every /status
request ran its own check_connection (up to 120 s, three endpoints over), seven
of the eight request threads were found waiting there, and every page load
(which asks /status) took over a minute. The checks now run on a thread of their
own, one at a time; the request that starts one waits at most two seconds.
"""

from __future__ import annotations

import asyncio
import threading
import time

import pytest


class _Config:
    def __init__(self, values=None):
        self.values = dict(values or {})

    def get_active_media_server(self):
        return "plex"

    def get(self, key, default=None):
        return self.values.get(key, default)


@pytest.fixture(scope="module")
def ws():
    import web_server
    return web_server


@pytest.fixture
def stale_status(ws, monkeypatch):
    """A /status cache that's due for both checks."""
    monkeypatch.setitem(ws._status_cache, "media_server", {"connected": False, "response_time": 0, "type": "plex"})
    monkeypatch.setitem(ws._status_cache, "soulseek", {"connected": True, "response_time": 0,
                                                       "source_cache_key": "soulseek:"})
    monkeypatch.setitem(ws._status_cache_timestamps, "media_server", 0)
    monkeypatch.setitem(ws._status_cache_timestamps, "soulseek", 0)
    monkeypatch.setattr(ws, "config_manager", _Config({"download_source.mode": "soulseek",
                                                       "download_source.hybrid_order": []}))
    monkeypatch.setattr(ws, "media_server_engine", None)
    ws.app.config["TESTING"] = True
    yield
    # let probe threads started by the test finish before the next test
    deadline = time.time() + 10
    while time.time() < deadline and any(t.is_alive() for t in list(ws._status_probes_running.values())):
        time.sleep(0.05)


class _Orchestrator:
    def __init__(self, delay, answer=True):
        self.delay = delay
        self.answer = answer
        self.checks = 0
        self.lock = threading.Lock()

    async def check_connection(self):
        with self.lock:
            self.checks += 1
        await asyncio.sleep(self.delay)
        return self.answer


def _get_status(ws, out, i):
    started = time.time()
    body = ws.app.test_client().get("/status").get_json()
    out[i] = (time.time() - started, body)


def test_a_hung_slskd_does_not_hold_status_requests(ws, monkeypatch, stale_status):
    orch = _Orchestrator(delay=6)
    monkeypatch.setattr(ws, "download_orchestrator", orch)
    monkeypatch.setattr(ws, "STATUS_PROBE_WAIT_SECONDS", 0.5)

    out = {}
    threads = [threading.Thread(target=_get_status, args=(ws, out, i)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)

    took = sorted(v[0] for v in out.values())
    assert len(took) == 6
    assert took[-1] < 3, took                           # was 6 s each (120 s with a real slskd)
    assert orch.checks == 1                             # one check for all six
    assert all(v[1]["soulseek"]["connected"] is True for v in out.values())   # the cached answer


def test_a_quick_check_is_answered_in_the_same_request(ws, monkeypatch, stale_status):
    orch = _Orchestrator(delay=0.05, answer=False)
    monkeypatch.setattr(ws, "download_orchestrator", orch)

    body = ws.app.test_client().get("/status").get_json()

    assert body["soulseek"]["connected"] is False
    assert orch.checks == 1


def test_a_check_longer_than_its_budget_counts_as_disconnected(ws, monkeypatch, stale_status):
    orch = _Orchestrator(delay=5)
    monkeypatch.setattr(ws, "download_orchestrator", orch)
    monkeypatch.setattr(ws, "STATUS_PROBE_WAIT_SECONDS", 0.1)
    monkeypatch.setattr(ws, "STATUS_SLSKD_PROBE_SECONDS", 0.3)

    ws.app.test_client().get("/status")
    deadline = time.time() + 3
    while time.time() < deadline and ws._status_cache["soulseek"].get("connected") is not False:
        time.sleep(0.05)

    assert ws._status_cache["soulseek"]["connected"] is False


def test_transfer_cache_gives_up_on_a_slow_slskd_and_holds_no_lock(ws, monkeypatch):
    """get_cached_transfer_data held its lock across the slskd read: with slskd
    slow every caller queued behind it, the Downloads page's 2 s poll too."""

    class _Slow:
        engine = None

        def client(self, name):
            return type("C", (), {"base_url": "http://slskd"})()

        async def get_soulseek_transfers(self, max_age=None, stale_ok=0.0):
            await asyncio.sleep(3)
            return []

    monkeypatch.setattr(ws, "download_orchestrator", _Slow())
    monkeypatch.setattr(ws, "config_manager", _Config({"download_source.mode": "soulseek"}))
    monkeypatch.setitem(ws._status_cache, "soulseek", {"connected": True})
    monkeypatch.setitem(ws.transfer_data_cache, "last_update", 0)
    monkeypatch.setattr(ws, "SLSKD_LIST_REQUEST_WAIT_SECONDS", 0.3)

    out = {}

    def call(i):
        started = time.time()
        out[i] = (time.time() - started, ws.get_cached_transfer_data())
        out[i] = (time.time() - started, out[i][1])

    threads = [threading.Thread(target=call, args=(i,)) for i in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)

    assert all(v[1] == {} for v in out.values())
    # each gave up after its own 0.3 s; none queued behind another's wait
    assert max(v[0] for v in out.values()) < 0.9
