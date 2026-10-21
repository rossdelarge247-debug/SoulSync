"""Module switches in the running app (web_server.py + api/modules.py):

- the API gate: a turned-off module's routes answer 409 module_disabled;
- GET/PUT /api/modules;
- deferred starts skip a turned-off module's workers;
- turning a module off/on stops/starts its workers, or reports restart_required;
- the socket loops and the clients tab leave a turned-off module alone.
"""

from __future__ import annotations

import json
import os
import re
import threading
from unittest.mock import MagicMock

import pytest

from core import modules

web_server = pytest.importorskip("web_server")


class _Overlay:
    """core.modules reads/writes this instead of the shared test config, so a
    switch flipped here never leaks into another test."""

    def __init__(self):
        self.data = {}

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value


@pytest.fixture
def switches(monkeypatch):
    overlay = _Overlay()
    monkeypatch.setattr(modules, "_config", lambda: overlay)
    monkeypatch.setattr(modules, "_restart_reasons", {})
    return overlay


def _off(overlay, *names):
    for name in names:
        overlay.set(f"modules.{name}.enabled", False)


@pytest.fixture
def client():
    c = web_server.app.test_client()
    with c.session_transaction() as sess:
        sess["profile_id"] = 1
    return c


# ── API gate ─────────────────────────────────────────────────────────────────

GATED = [
    ("video", "GET", "/api/video/health"),
    ("video", "POST", "/api/video/downloads/grab"),
    ("podcasts", "GET", "/api/podcasts/search?q=x"),
    ("podcasts", "POST", "/api/podcasts/watchlist/add"),
    ("audiobooks", "GET", "/api/audiobooks/wishlist"),
    ("audiobooks", "POST", "/api/audiobooks/grab"),
    ("chat", "GET", "/api/chat/status"),
    ("chat", "GET", "/api/chat/arcade/bank"),
    ("chat", "POST", "/api/chat/room/message"),
    ("sample_studio", "GET", "/api/sample/folders"),
    ("sample_studio", "POST", "/api/sample/stems"),
    ("sample_studio", "GET", "/api/library/tracks?q=x"),
    ("sample_studio", "GET", "/api/library/tracks/recent"),
]


@pytest.mark.parametrize("module,method,path", GATED)
def test_a_disabled_modules_routes_answer_module_disabled(client, switches, module, method, path):
    _off(switches, module)
    resp = client.open(path, method=method, json={})
    assert resp.status_code == 409
    body = resp.get_json()
    assert body["error"] == "module_disabled"
    assert body["module"] == module
    assert body["message"]


@pytest.mark.parametrize("module,path", [
    ("video", "/api/v1/video/stats"),
    ("sample_studio", "/api/v1/sample/folders"),
])
def test_v1_routes_answer_in_the_v1_envelope(client, switches, module, path):
    _off(switches, module)
    resp = client.get(path)
    assert resp.status_code == 409
    body = resp.get_json()
    assert body["success"] is False
    assert body["error"]["code"] == "MODULE_DISABLED"
    assert body["error"]["module"] == module


@pytest.mark.parametrize("module,path", [
    ("video", "/api/video/no-such-route"),
    ("podcasts", "/api/podcasts/no-such-route"),
    ("audiobooks", "/api/audiobooks/no-such-route"),
    ("chat", "/api/chat/no-such-route"),
    ("sample_studio", "/api/sample/no-such-route"),
])
def test_enabled_modules_pass_through_the_gate(client, switches, module, path):
    # an unknown sub-route still reaches routing (404) when the module is on…
    assert client.get(path).status_code == 404
    # …and is stopped at the gate when it is off
    _off(switches, module)
    assert client.get(path).status_code == 409


def test_one_module_off_leaves_the_others_and_music_alone(client, switches):
    _off(switches, "video")
    assert client.get("/api/podcasts/no-such-route").status_code == 404
    assert client.get("/api/modules").status_code == 200
    assert client.get("/api/automations/blocks").status_code != 409


# ── /api/modules ─────────────────────────────────────────────────────────────

def test_get_modules_lists_every_module_on_by_default(client, switches):
    resp = client.get("/api/modules")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["success"] is True
    assert [m["name"] for m in data["modules"]] == list(modules.MODULES)
    for m in data["modules"]:
        assert m["enabled"] is True
        assert m["restart_required"] is False
        assert {"display_name", "description", "restart_reason", "pages"} <= set(m)


def test_get_modules_reports_a_disabled_module(client, switches):
    _off(switches, "chat")
    data = client.get("/api/modules").get_json()
    state = {m["name"]: m["enabled"] for m in data["modules"]}
    assert state["chat"] is False
    assert state["video"] is True


def test_admin_puts_a_module_off_and_on(client, switches):
    resp = client.put("/api/modules/podcasts", json={"enabled": False})
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["module"]["name"] == "podcasts"
    assert body["module"]["enabled"] is False
    assert body["module"]["restart_required"] is False
    assert switches.data["modules.podcasts.enabled"] is False
    assert client.get("/api/podcasts/search?q=x").status_code == 409

    resp = client.put("/api/modules/podcasts", json={"enabled": True})
    assert resp.get_json()["module"]["enabled"] is True
    assert client.get("/api/podcasts/no-such-route").status_code == 404


@pytest.mark.parametrize("payload", [{}, {"enabled": "false"}, {"enabled": 0}, None])
def test_put_needs_a_boolean(client, switches, payload):
    resp = client.put("/api/modules/podcasts", json=payload)
    assert resp.status_code == 400
    assert "modules.podcasts.enabled" not in switches.data


def test_put_unknown_module_is_404(client, switches):
    assert client.put("/api/modules/vidoe", json={"enabled": False}).status_code == 404


def test_non_admin_can_read_but_not_change_modules(switches):
    pid = web_server.get_database().create_profile(name=f"member_{os.urandom(3).hex()}")
    member = web_server.app.test_client()
    with member.session_transaction() as sess:
        sess["profile_id"] = pid
    assert member.get("/api/modules").status_code == 200
    assert member.put("/api/modules/video", json={"enabled": False}).status_code == 403
    assert "modules.video.enabled" not in switches.data


def test_the_page_shell_renders_the_switches_for_the_sidebar(client, switches):
    """index.html hides a turned-off module's nav entries before first paint
    from window.SOULSYNC_MODULES, so the page has to carry the states."""
    _off(switches, "podcasts")
    page = client.get("/").get_data(as_text=True)
    found = re.search(r"window\.SOULSYNC_MODULES = (\[.*?\]);\n", page)
    assert found, "the page shell lost window.SOULSYNC_MODULES"
    rendered = {m["name"]: m for m in json.loads(found.group(1))}
    assert list(rendered) == list(modules.MODULES)
    assert rendered["podcasts"] == {"name": "podcasts", "display_name": "Podcasts",
                                    "enabled": False, "pages": ["podcasts"]}
    assert rendered["video"]["enabled"] is True
    # the page renders before sign-in: no descriptions or restart reasons
    assert all(set(m) == {"name", "display_name", "enabled", "pages"} for m in rendered.values())


# ── deferred starts ──────────────────────────────────────────────────────────

def test_module_workers_are_tagged_with_their_module():
    assert web_server._deferred_start_modules == {
        "video repair worker": "video",
        "audiobook download monitor": "audiobooks",
        "video download monitor": "video",
    }


@pytest.fixture
def recorded_starts(monkeypatch):
    calls = []
    starts = [
        ("video repair worker", lambda: calls.append("video repair worker")),
        ("MusicBrainz worker", lambda: calls.append("MusicBrainz worker")),
        ("audiobook download monitor", lambda: calls.append("audiobook download monitor")),
        ("video download monitor", lambda: calls.append("video download monitor")),
    ]
    monkeypatch.setattr(web_server, "_deferred_starts", starts)
    monkeypatch.setattr(web_server, "_deferred_start_modules", {
        "video repair worker": "video",
        "audiobook download monitor": "audiobooks",
        "video download monitor": "video",
    })
    return calls


def test_defaults_run_every_deferred_start(switches, recorded_starts):
    assert web_server._run_deferred_starts() == []
    assert recorded_starts == ["video repair worker", "MusicBrainz worker",
                               "audiobook download monitor", "video download monitor"]


def test_disabled_modules_starts_are_skipped(switches, recorded_starts):
    _off(switches, "video")
    web_server._run_deferred_starts()
    assert recorded_starts == ["MusicBrainz worker", "audiobook download monitor"]


def test_disabled_audiobooks_start_is_skipped(switches, recorded_starts):
    _off(switches, "audiobooks")
    web_server._run_deferred_starts()
    assert "audiobook download monitor" not in recorded_starts
    assert "video repair worker" in recorded_starts


def test_turning_a_module_on_runs_only_its_starts_once_the_runtime_is_up(
        switches, recorded_starts, monkeypatch):
    monkeypatch.setattr(web_server, "_runtime_started", False)
    assert web_server._start_module_workers("video") is None
    assert recorded_starts == []          # start_runtime_services() will read the switch
    monkeypatch.setattr(web_server, "_runtime_started", True)
    assert web_server._start_module_workers("video") is None
    assert recorded_starts == ["video repair worker", "video download monitor"]


def test_a_start_that_fails_on_enable_asks_for_a_restart(switches, monkeypatch):
    def boom():
        raise RuntimeError("no thread for you")
    monkeypatch.setattr(web_server, "_deferred_starts", [("audiobook download monitor", boom)])
    monkeypatch.setattr(web_server, "_deferred_start_modules",
                        {"audiobook download monitor": "audiobooks"})
    monkeypatch.setattr(web_server, "_runtime_started", True)
    reason = web_server._start_module_workers("audiobooks")
    assert reason and "audiobook download monitor" in reason


# ── stopping workers at runtime ──────────────────────────────────────────────

@pytest.fixture
def video_workers(monkeypatch):
    import core.video.download_monitor as monitor
    import core.video.enrichment.engine as engine
    repair = MagicMock(name="video repair worker")
    repair._thread = None
    monkeypatch.setattr(web_server, "_get_video_repair", lambda: repair)
    stop_engine = MagicMock(name="stop_video_enrichment_engine")
    monkeypatch.setattr(engine, "stop_video_enrichment_engine", stop_engine)
    monkeypatch.setattr(monitor, "_started", False)
    return repair, stop_engine, monitor


def test_turning_video_off_stops_its_workers(video_workers):
    repair, stop_engine, _monitor = video_workers
    assert web_server._stop_video_module() is None
    repair.stop.assert_called_once_with()
    stop_engine.assert_called_once_with()


def test_turning_video_off_with_the_download_monitor_running_needs_a_restart(
        switches, video_workers, monkeypatch):
    repair, _stop_engine, monitor = video_workers
    monkeypatch.setattr(monitor, "_started", True)
    state = modules.set_enabled("video", False)
    repair.stop.assert_called_once_with()
    assert state["enabled"] is False
    assert state["restart_required"] is True
    assert "download monitor" in state["restart_reason"]


def test_stop_video_engine_drops_the_running_engine(monkeypatch):
    import core.video.enrichment.engine as engine
    running = MagicMock(name="engine")
    monkeypatch.setattr(engine, "_engine", running)
    assert engine.stop_video_enrichment_engine() is True
    running.stop_all.assert_called_once_with()
    assert engine.peek_video_enrichment_engine() is None
    assert engine.stop_video_enrichment_engine() is False


def test_turning_audiobooks_off_stops_the_download_monitor(switches, monkeypatch):
    import core.audiobook_download_monitor as monitor
    fake = MagicMock(name="audiobook monitor")
    monkeypatch.setattr(monitor, "get_monitor", lambda: fake)
    state = modules.set_enabled("audiobooks", False)
    fake.stop.assert_called_once_with()
    assert state["restart_required"] is False


def test_turning_sample_studio_off_with_its_worker_running_needs_a_restart(switches, monkeypatch):
    import core.sample.stems_worker as stems
    import core.sample.worker as analysis
    monkeypatch.setattr(stems, "_threads", {})
    monkeypatch.setattr(analysis, "_thread", None)
    assert web_server._stop_sample_studio_module() is None

    alive = threading.Thread(target=lambda: None)
    alive.is_alive = lambda: True
    monkeypatch.setattr(analysis, "_thread", alive)
    state = modules.set_enabled("sample_studio", False)
    assert state["restart_required"] is True
    assert "analysis" in state["restart_reason"]


def test_turning_podcasts_and_chat_off_needs_no_restart(switches):
    for name in ("podcasts", "chat"):
        state = modules.set_enabled(name, False)
        assert state["enabled"] is False and state["restart_required"] is False


def test_web_server_registers_the_runtime_hooks():
    assert set(modules._hooks) == {"video", "audiobooks", "sample_studio"}


# ── socket loops + clients tab ───────────────────────────────────────────────

def _run_loop_twice(monkeypatch, loop):
    """Run a `while not IS_SHUTTING_DOWN` socket loop for two passes."""
    monkeypatch.setattr(web_server, "IS_SHUTTING_DOWN", False)
    passes = []

    def fake_sleep(_seconds):
        passes.append(1)
        if len(passes) >= 2:
            web_server.IS_SHUTTING_DOWN = True

    monkeypatch.setattr(web_server.socketio, "sleep", fake_sleep)
    loop()
    return len(passes)


def test_video_enrichment_loop_idles_while_video_is_off(switches, monkeypatch):
    import core.video.enrichment.engine as engine
    peek = MagicMock(return_value=None)
    monkeypatch.setattr(engine, "peek_video_enrichment_engine", peek)
    _off(switches, "video")
    _run_loop_twice(monkeypatch, web_server._emit_video_enrichment_status_loop)
    peek.assert_not_called()
    switches.set("modules.video.enabled", True)
    _run_loop_twice(monkeypatch, web_server._emit_video_enrichment_status_loop)
    assert peek.call_count == 2


def test_chat_push_loop_idles_while_chat_is_off(switches, monkeypatch):
    orchestrator = MagicMock(name="download_orchestrator")
    monkeypatch.setattr(web_server, "download_orchestrator", orchestrator)
    monkeypatch.setattr(web_server, "_has_connected_clients", lambda: True)
    _off(switches, "chat")
    _run_loop_twice(monkeypatch, web_server._emit_chat_push_loop)
    orchestrator.client.assert_not_called()
    switches.set("modules.chat.enabled", True)
    _run_loop_twice(monkeypatch, web_server._emit_chat_push_loop)
    assert orchestrator.client.call_count == 2


def test_clients_tab_skips_disabled_modules_rows(switches, monkeypatch):
    import core.client_match as client_match
    captured = {}
    monkeypatch.setattr(client_match, "compose_known", lambda **kw: captured.update(kw) or {})
    web_server._client_known_items()
    _off(switches, "video", "audiobooks")
    assert captured["video_rows"]() == []
    assert captured["audiobook_rows"]() == []
