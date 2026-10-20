"""Graceful shutdown under gunicorn runs from worker hooks, not signal handlers.

web_server installs no SIGINT/SIGTERM handlers under gunicorn (the worker's
own handlers do a graceful stop), so the app's cleanup runs from the hooks in
utils/gunicorn_hooks.py, wired into both gunicorn configs.
"""

from __future__ import annotations

import os
import runpy
import sys
import threading
import time
import types
from pathlib import Path

import pytest

from utils import gunicorn_hooks

ROOT = Path(__file__).resolve().parent.parent


class _FakeWebServer(types.ModuleType):
    def __init__(self):
        super().__init__("web_server")
        self.shutdowns = 0

    def shutdown_runtime_services(self):
        self.shutdowns += 1


@pytest.fixture
def fake_web_server(monkeypatch):
    module = _FakeWebServer()
    monkeypatch.setitem(sys.modules, "web_server", module)
    return module


def _worker(pid=None, alive=True):
    return types.SimpleNamespace(pid=os.getpid() if pid is None else pid, alive=alive)


@pytest.mark.parametrize("config", ["gunicorn.conf.py", "gunicorn.dev.conf.py"])
def test_both_gunicorn_configs_use_the_hooks(config, monkeypatch):
    from gunicorn.config import Config

    monkeypatch.chdir(ROOT)
    settings = runpy.run_path(str(ROOT / config))
    assert settings["worker_exit"] is gunicorn_hooks.worker_exit
    assert settings["post_worker_init"] is gunicorn_hooks.post_worker_init
    # gunicorn validates hook signatures when it loads the config
    cfg = Config()
    cfg.set("worker_exit", settings["worker_exit"])
    cfg.set("post_worker_init", settings["post_worker_init"])


def test_worker_exit_shuts_the_app_down(fake_web_server):
    gunicorn_hooks.worker_exit(server=None, worker=_worker())
    assert fake_web_server.shutdowns == 1


def test_worker_exit_in_the_master_does_nothing(fake_web_server):
    # the master calls worker_exit when it reaps a dead worker
    gunicorn_hooks.worker_exit(server=None, worker=_worker(pid=os.getpid() + 1))
    assert fake_web_server.shutdowns == 0


def test_worker_exit_never_imports_the_app(monkeypatch):
    monkeypatch.delitem(sys.modules, "web_server", raising=False)
    gunicorn_hooks.worker_exit(server=None, worker=_worker())
    assert "web_server" not in sys.modules


def test_shutdown_starts_as_soon_as_the_worker_is_told_to_stop(fake_web_server, monkeypatch):
    """An open Socket.IO connection keeps a stopping worker draining until
    graceful_timeout, when the master kills it; the cleanup can't wait for
    the worker to exit."""
    monkeypatch.setattr(gunicorn_hooks, "_STOP_POLL_SECONDS", 0.01)
    worker = _worker()
    gunicorn_hooks.post_worker_init(worker)
    time.sleep(0.1)
    assert fake_web_server.shutdowns == 0

    worker.alive = False  # what the worker's SIGTERM handler does
    deadline = time.time() + 5
    while fake_web_server.shutdowns == 0 and time.time() < deadline:
        time.sleep(0.01)
    assert fake_web_server.shutdowns == 1


@pytest.fixture(scope="module")
def ws():
    import web_server
    return web_server


def test_shutdown_runtime_services_waits_for_one_in_progress(ws, monkeypatch):
    """The stop watcher and worker_exit can both call it; the worker must not
    exit while the watcher is halfway through the cleanup."""
    started, release, finished = threading.Event(), threading.Event(), []

    def slow_shutdown():
        if started.is_set():
            return  # IS_SHUTTING_DOWN already set: the real one returns early
        started.set()
        release.wait(5)
        finished.append("cleanup")

    monkeypatch.setattr(ws, "_shutdown_runtime_components", slow_shutdown)
    watcher = threading.Thread(target=ws.shutdown_runtime_services)
    watcher.start()
    assert started.wait(5)

    second = threading.Thread(target=lambda: (ws.shutdown_runtime_services(), finished.append("second")))
    second.start()
    time.sleep(0.1)
    assert finished == []  # still waiting on the first call

    release.set()
    watcher.join(5)
    second.join(5)
    assert finished == ["cleanup", "second"]
