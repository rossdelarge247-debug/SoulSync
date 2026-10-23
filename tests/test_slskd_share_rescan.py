"""slskd share rescans after imports (core/slskd_share_rescan.py).

Fake clock, fake slskd client (its async ``_make_request`` is the only HTTP
seam), no real waiting beyond a fraction of a second for the one thread test.
"""

from __future__ import annotations

import logging
import threading
import time

import pytest

from core import slskd_share_rescan as mod
from core.slskd_share_rescan import SlskdShareRescanner, library_has_audio_files

SECRET = "sk-very-secret-api-key-123"


class FakeClock:
    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


class FakeClient:
    """Answers like slskd. ``responses`` maps (method, endpoint) to a value,
    an exception instance, or a callable returning one."""

    def __init__(self, *, configured=True, files=0, scanning=False, responses=None):
        self.base_url = "http://slskd:5030" if configured else None
        self.api_key = SECRET
        self.calls: list[tuple[str, str]] = []
        self.responses = {
            ("GET", "application"): {"shares": {"files": files, "scanning": scanning}},
            ("PUT", "shares"): {},
        }
        self.responses.update(responses or {})

    def is_configured(self) -> bool:
        return self.base_url is not None

    async def _make_request(self, method, endpoint, **kwargs):
        self.calls.append((method, endpoint))
        value = self.responses.get((method, endpoint))
        if callable(value):
            value = value()
        if isinstance(value, BaseException):
            raise value
        return value

    def puts(self) -> int:
        return sum(1 for c in self.calls if c == ("PUT", "shares"))


def make(client=None, *, enabled=True, clock=None, activity=None, **kw):
    clock = clock or FakeClock()
    client = client if client is not None else FakeClient()
    flag = {"on": enabled}
    r = SlskdShareRescanner(
        clock=clock,
        client_factory=lambda: client,
        enabled=lambda: flag["on"],
        activity=activity,
        start_worker=False,
        **kw,
    )
    return r, client, clock, flag


# -- debounce ---------------------------------------------------------------

def test_burst_coalesces_into_one_rescan_after_quiet_period():
    r, client, clock, _ = make()
    for _ in range(12):            # an album, a track every 5 s
        r.notify_import()
        clock.advance(5)
    assert r.tick() is False       # 5 s after the last import: not yet
    assert client.calls == []
    clock.advance(mod.QUIET_SECONDS - 5 - 1)
    assert r.tick() is False
    clock.advance(1)
    assert r.tick() is True
    assert client.puts() == 1
    assert r.tick() is False       # nothing pending any more
    assert client.puts() == 1


def test_default_numbers():
    assert mod.QUIET_SECONDS == 120
    assert mod.CEILING_SECONDS == 600
    assert mod.SETTING_KEY == "soulseek.rescan_shares_after_import"


def test_ceiling_forces_rescan_during_a_long_run():
    r, client, clock, _ = make()
    start = clock()
    fired_at = []
    # an import every 60 s for 25 minutes: the quiet period never elapses
    for _ in range(25):
        r.notify_import()
        for _ in range(6):
            clock.advance(10)
            if r.tick():
                fired_at.append(clock() - start)
    assert len(fired_at) == 2
    assert fired_at[0] == pytest.approx(mod.CEILING_SECONDS)
    assert fired_at[1] - fired_at[0] <= mod.CEILING_SECONDS + 60
    # and the trailing burst still gets its rescan after the quiet period
    clock.advance(mod.QUIET_SECONDS)
    assert r.tick() is True
    assert client.puts() == 3


def test_due_at_is_min_of_quiet_and_ceiling():
    r, _, clock, _ = make()
    assert r.due_at() is None
    t0 = clock()
    r.notify_import()
    assert r.due_at() == t0 + mod.QUIET_SECONDS
    clock.advance(550)
    r.notify_import()
    assert r.due_at() == t0 + mod.CEILING_SECONDS


def test_scan_in_progress_is_not_doubled_and_retries_later():
    client = FakeClient(scanning=True)
    r, client, clock, _ = make(client)
    r.notify_import()
    clock.advance(mod.QUIET_SECONDS)
    assert r.tick() is False
    assert client.puts() == 0
    assert r.due_at() == clock() + mod.BUSY_RETRY_SECONDS
    clock.advance(mod.BUSY_RETRY_SECONDS - 1)
    assert r.tick() is False
    client.responses[("GET", "application")] = {"shares": {"files": 10, "scanning": False}}
    clock.advance(1)
    assert r.tick() is True
    assert client.puts() == 1


def test_single_worker_thread_and_real_fire():
    client = FakeClient()
    r = SlskdShareRescanner(
        client_factory=lambda: client, enabled=lambda: True, activity=None,
        quiet_seconds=0.05, ceiling_seconds=0.2, start_worker=True,
    )
    before = {t.name for t in threading.enumerate()}
    try:
        for _ in range(30):
            r.notify_import()
        workers = [t for t in threading.enumerate() if t.name == "SlskdShareRescan"]
        assert len(workers) == 1
        deadline = time.monotonic() + 2
        while client.puts() < 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert client.puts() == 1
        time.sleep(0.1)
        assert client.puts() == 1
    finally:
        r.stop()
    assert "SlskdShareRescan" not in before


def test_notify_is_cheap_and_never_touches_slskd():
    r, client, _, _ = make()
    r.notify_import()
    assert client.calls == []


def test_activity_line_recorded_on_rescan():
    seen = []
    r, client, clock, _ = make(activity=lambda title, sub: seen.append((title, sub)))
    r.notify_import()
    clock.advance(mod.QUIET_SECONDS)
    assert r.tick()
    assert len(seen) == 1
    assert "SoulSync" not in " ".join(seen[0])


# -- disabled / unconfigured ------------------------------------------------

def test_disabled_setting_makes_no_calls():
    r, client, clock, flag = make(enabled=False)
    r.notify_import()
    clock.advance(mod.CEILING_SECONDS * 2)
    assert r.tick() is False
    assert client.calls == []
    assert r.due_at() is None


def test_disabled_between_note_and_fire_makes_no_calls():
    r, client, clock, flag = make()
    r.notify_import()
    flag["on"] = False
    clock.advance(mod.QUIET_SECONDS)
    assert r.tick() is False
    assert client.calls == []
    assert r.due_at() is None


def test_unconfigured_slskd_makes_no_calls():
    r, client, clock, _ = make(FakeClient(configured=False))
    r.notify_import()
    clock.advance(mod.QUIET_SECONDS)
    assert r.tick() is False
    assert client.calls == []
    assert r.due_at() is None


def test_no_client_at_all():
    r = SlskdShareRescanner(client_factory=lambda: None, enabled=lambda: True,
                            activity=None, start_worker=False, clock=FakeClock())
    r.notify_import()
    assert r.tick(now=10**9) is False
    assert r.run_startup_check(library_root="/x", library_has_files=lambda _: True) == "unconfigured"


def test_real_setting_default_is_on():
    from core.settings import config_manager
    assert config_manager.get(mod.SETTING_KEY, True) is not False


# -- startup check ----------------------------------------------------------

def _startup(client, *, has_files=True, **kw):
    r, client, clock, flag = make(client, **kw)
    sleeps = []
    result = r.run_startup_check(
        library_root="/music", library_has_files=lambda root: has_files,
        sleep=sleeps.append, poll_seconds=30, max_attempts=3)
    return result, client, sleeps


def test_startup_rescans_when_slskd_shares_zero_and_library_has_files():
    result, client, _ = _startup(FakeClient(files=0))
    assert result == "requested"
    assert client.puts() == 1


def test_startup_leaves_sharing_slskd_alone():
    result, client, _ = _startup(FakeClient(files=3627))
    assert result == "sharing"
    assert client.puts() == 0


def test_startup_empty_library_no_rescan():
    result, client, _ = _startup(FakeClient(files=0), has_files=False)
    assert result == "empty_library"
    assert client.puts() == 0


def test_startup_scan_already_running():
    result, client, _ = _startup(FakeClient(files=0, scanning=True))
    assert result == "scanning"
    assert client.puts() == 0


def test_startup_disabled_or_unconfigured():
    assert _startup(FakeClient(), enabled=False)[0] == "disabled"
    result, client, _ = _startup(FakeClient(configured=False))
    assert result == "unconfigured"
    assert client.calls == []


def test_startup_waits_for_slskd_then_checks():
    answers = [None, None]
    client = FakeClient(responses={
        ("GET", "application"): lambda: (answers.pop(0) if answers
                                         else {"shares": {"files": 0, "scanning": False}}),
        ("GET", "shares"): None,
    })
    result, client, sleeps = _startup(client)
    assert result == "requested"
    assert sleeps == [30, 30]


def test_startup_gives_up_when_slskd_never_answers():
    client = FakeClient(responses={("GET", "application"): None, ("GET", "shares"): None})
    result, client, sleeps = _startup(client)
    assert result == "unreachable"
    assert client.puts() == 0
    assert len(sleeps) == 2


def test_startup_falls_back_to_share_listing():
    client = FakeClient(responses={
        ("GET", "application"): {"version": {}},
        ("GET", "shares"): {"local": [{"id": "music", "files": 0, "isExcluded": False}]},
    })
    result, client, _ = _startup(client)
    assert result == "requested"
    client2 = FakeClient(responses={
        ("GET", "application"): {"version": {}},
        ("GET", "shares"): {"local": [{"id": "music", "files": 12}]},
    })
    assert _startup(client2)[0] == "sharing"


def test_library_has_audio_files(tmp_path):
    assert library_has_audio_files(str(tmp_path)) is False
    (tmp_path / ".soulsync_atomic_staging" / "A").mkdir(parents=True)
    (tmp_path / ".soulsync_atomic_staging" / "A" / "x.flac").write_bytes(b"")
    (tmp_path / "Artist" / "Album").mkdir(parents=True)
    (tmp_path / "Artist" / "Album" / "cover.jpg").write_bytes(b"")
    assert library_has_audio_files(str(tmp_path)) is False
    (tmp_path / "Artist" / "Album" / "01.FLAC").write_bytes(b"")
    assert library_has_audio_files(str(tmp_path)) is True
    assert library_has_audio_files(str(tmp_path / "missing")) is False
    assert library_has_audio_files(None) is False


# -- failures ---------------------------------------------------------------

def test_errors_are_swallowed_logged_once_without_the_key(caplog):
    client = FakeClient(responses={("PUT", "shares"): None})   # slskd refused / down
    r, client, clock, _ = make(client)
    with caplog.at_level(logging.DEBUG):
        for _ in range(3):
            r.notify_import()
            clock.advance(mod.FAILURE_RETRY_SECONDS)
            assert r.tick() is False
    warnings = [rec for rec in caplog.records
                if rec.levelno >= logging.WARNING and rec.name.endswith("slskd_share_rescan")]
    assert len(warnings) == 1
    assert all(rec.levelno < logging.ERROR for rec in warnings)
    assert SECRET not in caplog.text
    # the burst is kept and goes through once slskd answers
    client.responses[("PUT", "shares")] = {}
    clock.advance(mod.FAILURE_RETRY_SECONDS)
    assert r.tick() is True


def test_exceptions_from_client_never_escape(caplog):
    client = FakeClient(responses={("GET", "application"): RuntimeError(f"boom {SECRET}")})
    r, client, clock, _ = make(client)
    with caplog.at_level(logging.DEBUG):
        r.notify_import()
        clock.advance(mod.QUIET_SECONDS)
        assert r.tick() is False
        assert r.run_startup_check(library_root="/m", library_has_files=lambda _: True,
                                   sleep=lambda _: None, max_attempts=1) == "failed"
    assert SECRET not in caplog.text


def test_notify_never_raises_even_when_setting_read_explodes():
    def bad():
        raise RuntimeError("settings broke")
    r = SlskdShareRescanner(enabled=bad, client_factory=lambda: None, activity=None,
                            start_worker=False)
    r.notify_import()   # no exception


def test_module_hook_never_raises(monkeypatch):
    def boom():
        raise RuntimeError("x")
    monkeypatch.setattr(mod, "get_share_rescanner", boom)
    mod.notify_library_import()   # no exception


# -- the real client: requests go through its helper, key never logged -----

def test_real_client_uses_make_request_and_never_logs_key(monkeypatch, caplog):
    from core.soulseek_client import SoulseekClient
    client = SoulseekClient.__new__(SoulseekClient)
    client.base_url = "http://slskd:5030"
    client.api_key = SECRET
    seen = []

    async def fake(method, endpoint, **kw):
        seen.append((method, endpoint, client._get_headers().get("X-API-Key")))
        return {"shares": {"files": 0, "scanning": False}} if endpoint == "application" else {}

    monkeypatch.setattr(client, "_make_request", fake)
    r, _, clock, _ = make(client)
    with caplog.at_level(logging.DEBUG):
        r.notify_import()
        clock.advance(mod.QUIET_SECONDS)
        assert r.tick() is True
    assert [(m, e) for m, e, _ in seen] == [("GET", "application"), ("PUT", "shares")]
    assert seen[-1][2] == SECRET          # configured key used for auth
    assert SECRET not in caplog.text


def test_run_coro_runs_without_a_loop():
    async def f():
        return 5
    assert mod._run_coro(f()) == 5


# -- wiring -----------------------------------------------------------------

def test_import_pipeline_and_atomic_publish_call_the_hook():
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    pipeline = (root / "core/imports/pipeline.py").read_text()
    assert pipeline.count("notify_library_import()") == 2
    lifecycle = (root / "core/downloads/lifecycle.py").read_text()
    assert "notify_library_import(len(result['published']))" in lifecycle
    web = (root / "web_server.py").read_text()
    assert '@_deferred_start("slskd share check")' in web


def test_setting_is_rendered_and_saved():
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    html = (root / "webui/index.html").read_text()
    assert 'id="soulseek-rescan-shares-after-import"' in html
    assert "Rescan slskd's shares after imports" in html
    js = (root / "webui/static/settings.js").read_text()
    assert "rescan_shares_after_import: _cfgBool('soulseek-rescan-shares-after-import')" in js
    assert "settings.soulseek?.rescan_shares_after_import !== false" in js
