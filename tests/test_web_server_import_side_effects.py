"""Importing web_server must not start anything; start_runtime_services() does.

Every worker, monitor and loop used to start while web_server was being
imported, so each of the dozens of test modules (and any script or tool) that
imports it ran the enrichment workers, the repair worker and the download
monitors against whatever database it could reach. The starts now live in
start_runtime_services(), which wsgi.py and the direct launch call once.
"""

from __future__ import annotations

import ast
import json
import os
import re
import subprocess
import sys
import textwrap
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest

ROOT = Path(__file__).resolve().parent.parent
WEB_SERVER = ROOT / "web_server.py"

# Every start registered with @_deferred_start, in the order web_server.py
# defines them (which is the order they used to run during the import).
EXPECTED_DEFERRED_STARTS = [
    "video repair worker",
    "API request cleanup timer",
    "MusicBrainz worker",
    "AudioDB worker",
    "Discogs worker",
    "Deezer worker",
    "JioSaavn worker",
    "Amazon worker",
    "Similar Artists worker",
    "Spotify enrichment worker",
    "iTunes enrichment worker",
    "Last.fm worker",
    "Genius worker",
    "Bandcamp worker",
    "Tidal enrichment worker",
    "Qobuz enrichment worker",
    "Hydrabase worker",
    "discover warmer",
    "Hydrabase auto-connect",
    "SoulID worker",
    "Listening stats worker",
    "Repair worker",
    # registered with module="radio"; starts a thread only when a station is
    # already watched (auto-add on, or a radio automation's favourites)
    "Internet radio watcher",
    "auto-import worker",
    "audiobook download monitor",
    "video download monitor",
    "clients-tab match watcher",
    "popularity backfill autostart",
    # one-shot: once slskd answers, rescan if it shares 0 files (core/slskd_share_rescan.py)
    "slskd share check",
    # the library's BPM, key and energy, in the background (core/dj/worker.py)
    "DJ analysis",
]

# Start name -> the web_server global holding the worker it starts.
WORKER_GLOBALS = {
    "MusicBrainz worker": "mb_worker",
    "AudioDB worker": "audiodb_worker",
    "Discogs worker": "discogs_worker",
    "Deezer worker": "deezer_worker",
    "JioSaavn worker": "jiosaavn_worker",
    "Amazon worker": "amazon_worker",
    "Similar Artists worker": "similar_artists_worker",
    "Spotify enrichment worker": "spotify_enrichment_worker",
    "iTunes enrichment worker": "itunes_enrichment_worker",
    "Last.fm worker": "lastfm_worker",
    "Genius worker": "genius_worker",
    "Bandcamp worker": "bandcamp_worker",
    "Tidal enrichment worker": "tidal_enrichment_worker",
    "Qobuz enrichment worker": "qobuz_enrichment_worker",
    "Hydrabase worker": "hydrabase_worker",
    "SoulID worker": "soulid_worker",
    "Listening stats worker": "listening_stats_worker",
    "Repair worker": "repair_worker",
}

_IMPORT_PROBE = textwrap.dedent("""
    import json, os, signal, threading, time
    before = {t.ident for t in threading.enumerate()}
    handlers_before = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
    import web_server
    replaced = sorted(signal.Signals(s).name for s, h in handlers_before.items()
                      if signal.getsignal(s) is not h)
    # flask-limiter's memory storage fires a one-shot 10ms expiry timer when
    # the app registers it; give short-lived library timers time to finish.
    deadline = time.time() + 5
    while time.time() < deadline:
        new = [t for t in threading.enumerate() if t.ident not in before]
        if not new:
            break
        time.sleep(0.1)
    print("IMPORT-PROBE " + json.dumps({
        "threads": [
            {"name": t.name, "daemon": t.daemon, "target": repr(getattr(t, "_target", None))}
            for t in new
        ],
        "replaced_signal_handlers": replaced,
    }), flush=True)
    os._exit(0)
""")


def _subprocess_env(work_dir):
    """The environment for a fresh interpreter: its own throwaway databases,
    config and caches under work_dir (not this worker's), and the repo on
    the import path."""
    env = dict(os.environ)
    env.update({
        "DATABASE_PATH": str(work_dir / "music_library.db"),
        "VIDEO_DATABASE_PATH": str(work_dir / "video_library.db"),
        "AUDIOBOOK_DATABASE_PATH": str(work_dir / "audiobooks.db"),
        "SOULSYNC_CONFIG_PATH": str(work_dir / "config.json"),
        "SOULSYNC_IMAGE_CACHE_DIR": str(work_dir / "image_cache"),
        "PYTHONPATH": os.pathsep.join(filter(None, [str(ROOT), env.get("PYTHONPATH")])),
        "PYTHONDONTWRITEBYTECODE": "1",
    })
    return env


@pytest.fixture(scope="module")
def import_probe(tmp_path_factory):
    """Import web_server in a fresh interpreter."""
    cwd = tmp_path_factory.mktemp("import-probe")
    proc = subprocess.run(
        [sys.executable, "-c", _IMPORT_PROBE],
        cwd=str(cwd), env=_subprocess_env(cwd), capture_output=True, text=True, timeout=300,
    )
    output = proc.stdout + proc.stderr
    lines = [line for line in proc.stdout.splitlines() if line.startswith("IMPORT-PROBE ")]
    assert proc.returncode == 0 and lines, f"importing web_server failed:\n{output[-4000:]}"
    return json.loads(lines[-1][len("IMPORT-PROBE "):]), output


def test_importing_web_server_starts_no_threads(import_probe):
    result, _output = import_probe
    assert result["threads"] == [], (
        "importing web_server left threads running; start them from "
        f"start_runtime_services() (@_deferred_start) instead: {result['threads']}"
    )


def test_importing_web_server_logs_no_worker_starts(import_probe):
    _result, output = import_probe
    started = [
        line for line in output.splitlines()
        if re.search(r"(?i)\b(worker|monitor|thread|timer|watcher|sweeper)\b.*\bstarted\b", line)
    ]
    assert started == [], "worker start log lines during import:\n" + "\n".join(started)


def test_importing_web_server_leaves_signal_handlers_alone(import_probe):
    """Gunicorn installs its worker's SIGINT/SIGTERM handlers before loading
    the app; replacing them at import turned its graceful stop into an exit."""
    result, _output = import_probe
    assert result["replaced_signal_handlers"] == []


def test_no_module_level_thread_starts():
    """Static guard for paths the import probe can't reach (config-gated code)."""
    source = WEB_SERVER.read_text(encoding="utf-8")
    tree = ast.parse(source)
    offenders = []

    def visit(node):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
                continue
            if isinstance(child, ast.Call):
                func = child.func
                name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
                if name in {"start", "Thread", "Timer", "start_background_task"}:
                    offenders.append(f"line {child.lineno}: {ast.get_source_segment(source, child)}")
            visit(child)

    visit(tree)
    assert offenders == [], "module-level thread starts in web_server.py:\n" + "\n".join(offenders)


@pytest.fixture(scope="module")
def ws():
    import web_server
    return web_server


def test_every_former_import_time_start_is_registered_in_order(ws):
    assert [name for name, _fn in ws._deferred_starts] == EXPECTED_DEFERRED_STARTS


def test_deferred_worker_starts_start_their_workers(ws, monkeypatch):
    workers = {}
    for global_name in WORKER_GLOBALS.values():
        workers[global_name] = MagicMock(name=global_name)
        monkeypatch.setattr(ws, global_name, workers[global_name])
    starts = dict(ws._deferred_starts)
    for start_name, global_name in WORKER_GLOBALS.items():
        starts[start_name]()
        workers[global_name].start.assert_called_once_with()


def test_deferred_worker_start_restores_a_saved_pause(ws, monkeypatch):
    worker = MagicMock(name="mb_worker")
    monkeypatch.setattr(ws, "mb_worker", worker)
    real_get = ws.config_manager.get
    monkeypatch.setattr(
        ws.config_manager, "get",
        lambda key, default=None: True if key == "musicbrainz_enrichment_paused" else real_get(key, default),
    )
    dict(ws._deferred_starts)["MusicBrainz worker"]()
    assert [c[0] for c in worker.method_calls] == ["start", "pause"]


def test_deferred_worker_start_skips_a_worker_that_failed_to_build(ws, monkeypatch):
    monkeypatch.setattr(ws, "mb_worker", None)
    dict(ws._deferred_starts)["MusicBrainz worker"]()  # no AttributeError


class _FakeConfig:
    def get(self, key, default=None):
        # pretend the one-time album-cache purge already ran
        return True if key == "maintenance.album_cache_purge_v1" else default

    def set(self, key, value):
        raise AssertionError(f"unexpected config write {key}={value!r}")


@pytest.fixture
def quiet_runtime(ws, monkeypatch, tmp_path):
    """start_runtime_services() with every real start replaced by a recorder."""
    import core.downloads.atomic_recovery as atomic_recovery
    import core.downloads.lifecycle as lifecycle
    import core.repair_jobs.base as repair_base

    calls = []
    fakes = types.SimpleNamespace(calls=calls)
    monkeypatch.setattr(ws, "_runtime_started", False)
    monkeypatch.setattr(ws, "_deferred_starts", [
        ("first", lambda: calls.append("first")),
        ("second", lambda: calls.append("second")),
    ])
    monkeypatch.setattr(ws, "config_manager", _FakeConfig())
    for name in ("start_oauth_callback_servers", "start_batch_healing_timer",
                 "start_simple_background_monitor", "start_import_suggestions_cache",
                 "_register_automation_handlers", "add_activity_item"):
        mock = MagicMock(name=name)
        setattr(fakes, name, mock)
        monkeypatch.setattr(ws, name, mock)
    monkeypatch.setattr(ws, "check_and_recover_stuck_flags", MagicMock(return_value=False))
    monkeypatch.setattr(ws, "automation_engine", None)
    fakes.thread_cls = MagicMock(name="Thread")
    monkeypatch.setattr(ws, "threading", types.SimpleNamespace(Thread=fakes.thread_cls))
    fakes.background_task = MagicMock(name="start_background_task")
    monkeypatch.setattr(ws.socketio, "start_background_task", fakes.background_task)
    monkeypatch.setattr(lifecycle, "sweep_orphan_album_bundle_staging", MagicMock(return_value=0))
    monkeypatch.setattr(atomic_recovery, "recover_orphan_staging", MagicMock(return_value={}))
    monkeypatch.setattr(repair_base, "deleted_quarantine_root", MagicMock(return_value=str(tmp_path)))
    monkeypatch.setattr(ws.app, "start_time", None, raising=False)
    return fakes


def test_start_runtime_services_runs_each_start_once(ws, quiet_runtime):
    ws.start_runtime_services()

    assert quiet_runtime.calls == ["first", "second"]
    quiet_runtime.start_batch_healing_timer.assert_called_once_with()
    quiet_runtime.start_oauth_callback_servers.assert_called_once_with()
    loops_started = quiet_runtime.background_task.call_count
    assert loops_started > 0

    ws.start_runtime_services()

    assert quiet_runtime.calls == ["first", "second"]
    quiet_runtime.start_batch_healing_timer.assert_called_once_with()
    quiet_runtime.start_oauth_callback_servers.assert_called_once_with()
    assert quiet_runtime.background_task.call_count == loops_started
    assert quiet_runtime.thread_cls.call_count == 1  # the gc sweeper


def test_a_failing_start_does_not_stop_the_rest(ws, quiet_runtime, monkeypatch):
    def boom():
        raise RuntimeError("can't start new thread")

    monkeypatch.setattr(ws, "_deferred_starts", [
        ("broken", boom),
        ("after", lambda: quiet_runtime.calls.append("after")),
    ])
    ws.start_runtime_services()
    assert quiet_runtime.calls == ["after"]
    quiet_runtime.start_batch_healing_timer.assert_called_once_with()


_DIRECT_RUN_PROBE = textwrap.dedent("""
    import json, os, runpy, sys, threading
    import flask_socketio
    threading.Thread.start = lambda self: None                # start nothing for real
    flask_socketio.SocketIO.run = lambda self, *a, **k: None  # and don't serve
    namespace = runpy.run_path(os.path.join(sys.argv[1], "web_server.py"), run_name="__main__")
    import web_server
    print("DIRECT-RUN-PROBE " + json.dumps({"same_app": web_server.app is namespace["app"]}), flush=True)
    os._exit(0)
""")


def test_direct_run_serves_import_web_server_from_the_running_module(tmp_path):
    """`python web_server.py` runs the file as __main__; a later lazy
    `import web_server` must get that module, not execute the file again."""
    proc = subprocess.run(
        [sys.executable, "-c", _DIRECT_RUN_PROBE, str(ROOT)],
        cwd=str(tmp_path), env=_subprocess_env(tmp_path), capture_output=True, text=True, timeout=300,
    )
    lines = [line for line in proc.stdout.splitlines() if line.startswith("DIRECT-RUN-PROBE ")]
    assert proc.returncode == 0 and lines, (proc.stdout + proc.stderr)[-4000:]
    assert json.loads(lines[-1][len("DIRECT-RUN-PROBE "):]) == {"same_app": True}
