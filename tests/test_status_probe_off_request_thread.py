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
    while time.time() < deadline and any(e[0].is_alive() for e in list(ws._status_probes_running.values())):
        time.sleep(0.05)


class _Source:
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


class _Orchestrator:
    """The real ``check_connection_within`` over fake sources."""

    def __init__(self, delay=0.0, answer=True, mode="soulseek", sources=None):
        from core.download_orchestrator import DownloadOrchestrator
        self._within = DownloadOrchestrator.check_connection_within
        self.mode = mode
        self.sources = sources or {"soulseek": _Source(delay, answer)}
        self.hybrid_order = list(self.sources)
        self.registry = type("R", (), {"names": lambda _s: list(self.sources)})()

    def _client(self, name):
        return self.sources.get(name)

    @property
    def checks(self):
        return sum(src.checks for src in self.sources.values())

    async def check_connection_within(self, budget):
        return await self._within(self, budget)


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


def _wait_for_probe(ws, name="download_source"):
    deadline = time.time() + 5
    while time.time() < deadline and name in ws._status_probes_running:
        time.sleep(0.05)


def test_a_check_with_no_answer_keeps_what_was_known_and_asks_again_soon(ws, monkeypatch, stale_status):
    """gauntlet M3: a slskd check over its budget was cached as disconnected
    for the full 2 minutes, which switches off every slskd read."""
    orch = _Orchestrator(delay=5)
    monkeypatch.setattr(ws, "download_orchestrator", orch)
    monkeypatch.setattr(ws, "STATUS_PROBE_WAIT_SECONDS", 0.1)
    monkeypatch.setattr(ws, "STATUS_SLSKD_PROBE_SECONDS", 0.3)

    ws.app.test_client().get("/status")
    _wait_for_probe(ws)

    assert ws._status_cache["soulseek"]["connected"] is True          # as it was
    age_left = ws.STATUS_CACHE_TTL - (time.time() - ws._status_cache_timestamps["soulseek"])
    assert age_left <= ws.STATUS_RETRY_SECONDS + 1                     # asked again in ~15 s


def test_a_check_that_fails_is_asked_again_soon(ws, monkeypatch, stale_status):
    orch = _Orchestrator(delay=0.0, answer=False)
    monkeypatch.setattr(ws, "download_orchestrator", orch)

    body = ws.app.test_client().get("/status").get_json()

    assert body["soulseek"]["connected"] is False
    age_left = ws.STATUS_CACHE_TTL - (time.time() - ws._status_cache_timestamps["soulseek"])
    assert age_left <= ws.STATUS_RETRY_SECONDS + 1


def test_a_slow_torrent_client_does_not_use_up_slskds_time(ws, monkeypatch, stale_status):
    """In hybrid mode the sources used to be checked one after another inside
    one 15 s budget; now each has its own, side by side."""
    orch = _Orchestrator(mode="hybrid", sources={"torrent": _Source(5, True),
                                                  "soulseek": _Source(0.05, True)})
    monkeypatch.setattr(ws, "download_orchestrator", orch)
    monkeypatch.setattr(ws, "config_manager", _Config({"download_source.mode": "hybrid",
                                                       "download_source.hybrid_order": ["torrent", "soulseek"]}))
    monkeypatch.setattr(ws, "STATUS_SLSKD_PROBE_SECONDS", 0.5)
    ws._status_cache["soulseek"]["connected"] = False

    started = time.time()
    body = ws.app.test_client().get("/status").get_json()

    assert time.time() - started < 1.5
    assert body["soulseek"]["connected"] is True


def test_a_media_server_check_that_never_returns_is_reported_and_not_repeated(ws, monkeypatch, stale_status):
    """gauntlet L7: a check that hung kept /status on its last answer for good."""
    release = threading.Event()
    calls = []

    class _Engine:
        def is_connected(self):
            calls.append(1)
            release.wait(10)
            return True

    monkeypatch.setattr(ws, "download_orchestrator", _Orchestrator(delay=0.0))
    monkeypatch.setattr(ws, "media_server_engine", _Engine())
    monkeypatch.setattr(ws, "STATUS_PROBE_WAIT_SECONDS", 0.05)
    monkeypatch.setattr(ws, "STATUS_MEDIA_PROBE_SECONDS", 0.3)
    ws._status_cache["media_server"]["connected"] = True
    try:
        ws.app.test_client().get("/status")
        time.sleep(0.5)
        ws.app.test_client().get("/status")            # past its budget
        ws.app.test_client().get("/status")
        assert ws._status_cache["media_server"]["connected"] is False
        assert len(calls) == 1                          # no second thread on top
    finally:
        release.set()
    _wait_for_probe(ws, "media_server")
    assert ws._status_cache["media_server"]["connected"] is True   # its answer, once it came


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


# ── gauntlet review: the transfer cache, the completion checker, the dashboard

LIST = [{"username": "peer", "directories": [{"directory": "d", "files": [
    {"id": "1", "filename": "d\\01.flac", "state": "InProgress", "size": 10, "bytesTransferred": 5}]}]}]


class _Engine:
    def __init__(self, delay=0.0):
        self.delay = delay
        self.calls = []

    async def get_all_downloads(self, exclude=()):
        self.calls.append(tuple(exclude))
        await asyncio.sleep(self.delay)
        return []


class _Lists:
    """An orchestrator with slskd's list (as the shared copy hands it out)."""

    def __init__(self, delay=0.0, engine_delay=0.0):
        self.delay = delay
        self.engine = _Engine(engine_delay)
        self.reads = 0
        self.orchestrator_get_all = 0

    def client(self, name):
        return type("C", (), {"base_url": "http://slskd"})()

    async def get_soulseek_transfers(self, max_age=None, stale_ok=0.0):
        self.reads += 1
        await asyncio.sleep(self.delay)
        return LIST

    async def get_all_downloads(self):
        self.orchestrator_get_all += 1
        return []


@pytest.fixture
def slskd_up(ws, monkeypatch):
    monkeypatch.setattr(ws, "config_manager", _Config({"download_source.mode": "soulseek"}))
    monkeypatch.setitem(ws._status_cache, "soulseek", {"connected": True})
    monkeypatch.setitem(ws.transfer_data_cache, "last_update", 0)
    monkeypatch.setitem(ws.transfer_data_cache, "data", {})
    ws.app.config["TESTING"] = True


def test_l2_the_transfer_cache_leaves_the_shared_list_alone(ws, monkeypatch, slskd_up):
    monkeypatch.setattr(ws, "download_orchestrator", _Lists())

    lookup = ws.get_cached_transfer_data()

    assert [t["username"] for t in lookup.values()] == ["peer"]
    assert "username" not in LIST[0]["directories"][0]["files"][0]


def test_l4_callers_arriving_together_share_one_build(ws, monkeypatch, slskd_up):
    """gauntlet L4: each caller that found the cache old built it again
    (another engine pass each, no time limit), and a slower build could
    overwrite a newer one."""
    orch = _Lists(delay=0.3, engine_delay=0.1)
    monkeypatch.setattr(ws, "download_orchestrator", orch)
    out = []
    threads = [threading.Thread(target=lambda: out.append(ws.get_cached_transfer_data())) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)

    assert len(out) == 5 and all(len(o) == 1 for o in out)
    assert orch.reads == 1 and orch.engine.calls == [("soulseek",)]


def test_l4_the_other_clients_lists_are_waited_for_a_bounded_time(ws, monkeypatch, slskd_up):
    orch = _Lists(engine_delay=5)
    monkeypatch.setattr(ws, "download_orchestrator", orch)
    monkeypatch.setattr(ws, "DOWNLOAD_CLIENTS_WAIT_SECONDS", 0.3)

    started = time.time()
    lookup = ws.get_cached_transfer_data()

    assert time.time() - started < 2
    assert len(lookup) == 1                             # slskd's row still there


def test_m2_the_completion_checker_is_bounded_and_does_not_reread_slskd(ws, monkeypatch, slskd_up):
    """gauntlet M2: /api/downloads/status waited up to 15 s for the list,
    then read slskd again with no time limit through get_all_downloads,
    only to drop those rows."""
    orch = _Lists(delay=3)
    monkeypatch.setattr(ws, "download_orchestrator", orch)
    monkeypatch.setattr(ws, "SLSKD_LIST_REQUEST_WAIT_SECONDS", 0.3)

    started = time.time()
    body = ws.app.test_client().get("/api/downloads/status").get_json()

    assert time.time() - started < 2
    assert body == {"transfers": []}
    assert orch.orchestrator_get_all == 0
    assert orch.engine.calls == [("soulseek",)]


def test_m2_the_completion_checker_sees_slskds_rows(ws, monkeypatch, slskd_up):
    orch = _Lists()
    monkeypatch.setattr(ws, "download_orchestrator", orch)

    body = ws.app.test_client().get("/api/downloads/status").get_json()

    assert [t["filename"] for t in body["transfers"]] == ["d\\01.flac"]
    assert "username" not in LIST[0]["directories"][0]["files"][0]   # L2: a copy was changed


def test_l8_the_dashboard_speed_is_a_read_of_now(ws, monkeypatch, slskd_up):
    seen = []
    monkeypatch.setattr(ws, "_slskd_transfers", lambda **kw: seen.append(kw) or LIST)

    ws._build_system_stats()

    assert seen and seen[0].get("stale_ok", 0) == 0 and seen[0]["timeout"] == 3
