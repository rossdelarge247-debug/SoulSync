"""Module switches (core/modules.py): the registry, the config switch, the
runtime hooks, and the automation engine skipping a turned-off module's
automations. The web side (API gate, /api/modules, deferred starts, worker
stop hooks, socket loops) is in test_module_switches_web.py.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from core import modules
from core.automation_engine import AutomationEngine

ALL = ["video", "podcasts", "audiobooks", "chat", "sample_studio", "radio"]


class _Config:
    """Dot-key config double (the real ConfigManager.get/set shape)."""

    def __init__(self, data=None):
        self.data = dict(data or {})

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value


@pytest.fixture
def cfg(monkeypatch):
    """Every core.modules read/write goes to a throwaway config; runtime hooks
    and restart reasons are restored afterwards."""
    config = _Config()
    monkeypatch.setattr(modules, "_config", lambda: config)
    monkeypatch.setattr(modules, "_hooks", {})
    monkeypatch.setattr(modules, "_restart_reasons", {})
    return config


def _off(config, *names):
    for name in names:
        config.set(f"modules.{name}.enabled", False)


# ── registry + defaults ──────────────────────────────────────────────────────

def test_defaults_leave_every_module_on(cfg):
    assert list(modules.MODULES) == ALL
    assert all(modules.is_enabled(name) for name in ALL)
    states = modules.list_modules()
    assert [s["name"] for s in states] == ALL
    for state in states:
        assert state["enabled"] is True
        assert state["default_enabled"] is True
        assert state["restart_required"] is False
        assert state["restart_reason"] is None
        assert state["display_name"] and state["description"]
        assert state["pages"]


def test_default_config_ships_every_module_on():
    from core.settings import ConfigManager
    defaults = ConfigManager.__new__(ConfigManager)._get_default_config()
    assert defaults["modules"] == {name: {"enabled": True} for name in ALL}


@pytest.mark.parametrize("value", [False, "false", "False", "0", "off", "no", 0])
def test_switch_values_that_turn_a_module_off(cfg, value):
    cfg.set("modules.video.enabled", value)
    assert modules.is_enabled("video") is False


@pytest.mark.parametrize("value", [True, "true", "1", "on", None, "garbage", {}])
def test_switch_values_that_leave_a_module_on(cfg, value):
    cfg.set("modules.video.enabled", value)
    assert modules.is_enabled("video") is True


def test_an_unreadable_config_never_turns_a_module_off():
    class Broken:
        def get(self, key, default=None):
            raise RuntimeError("database is locked")
    assert modules.is_enabled("video", config=Broken()) is True


def test_unknown_module_is_an_error(cfg):
    with pytest.raises(KeyError):
        modules.is_enabled("vidoe")
    with pytest.raises(KeyError):
        modules.set_enabled("vidoe", False)


# ── what belongs to which module ─────────────────────────────────────────────

@pytest.mark.parametrize("path,module", [
    ("/api/video", "video"),
    ("/api/video/downloads/grab", "video"),
    ("/api/v1/video/stats", "video"),
    ("/api/podcasts/search", "podcasts"),
    ("/api/audiobooks/wishlist/B0001", "audiobooks"),
    ("/api/chat/room/message", "chat"),
    ("/api/chat/arcade/bank", "chat"),
    ("/api/sample/stems/status", "sample_studio"),
    ("/api/v1/sample/folders", "sample_studio"),
    ("/api/library/tracks", "sample_studio"),
    ("/api/library/tracks/recent", "sample_studio"),
    # not a module's
    ("/api/videos", None),
    ("/api/music-video/download", None),
    ("/api/library/tracks/batch", None),
    ("/api/library/tracks/delete-batch", None),
    ("/api/audiobook-routes", None),
    ("/api/modules", None),
    ("/api/modules/video", None),
    ("/api/automations", None),
    ("/", None),
    ("", None),
])
def test_api_paths_map_to_their_module(path, module):
    assert modules.module_for_path(path) == module


def test_disabled_module_for_path_follows_the_switch(cfg):
    assert modules.disabled_module_for_path("/api/podcasts/search") is None
    _off(cfg, "podcasts")
    assert modules.disabled_module_for_path("/api/podcasts/search") == "podcasts"
    assert modules.disabled_module_for_path("/api/audiobooks/home") is None


@pytest.mark.parametrize("auto,expected", [
    ({"action_type": "video_rss_sync", "trigger_type": "schedule"}, ["video"]),
    ({"action_type": "notify_only", "trigger_type": "video_batch_complete"}, ["video"]),
    ({"action_type": "run_script", "trigger_type": "schedule", "owned_by": "video"}, ["video"]),
    ({"action_type": "audiobook_process_wishlist", "trigger_type": "schedule"}, ["audiobooks"]),
    ({"action_type": "notify_only", "trigger_type": "audiobook_new_release"}, ["audiobooks"]),
    ({"action_type": "scan_watchlist_podcasts", "trigger_type": "schedule"}, ["podcasts"]),
    ({"action_type": "audiobook_scan_library", "trigger_type": "video_batch_complete"},
     ["video", "audiobooks"]),
    ({"action_type": "process_wishlist", "trigger_type": "schedule"}, []),
    ({"action_type": "scan_watchlist", "trigger_type": "batch_complete"}, []),
    ({}, []),
    (None, []),
])
def test_automations_map_to_their_modules(auto, expected):
    assert modules.modules_for_automation(auto) == expected


def test_disabled_payload_names_the_module():
    body = modules.disabled_payload("sample_studio")
    assert body["success"] is False
    assert body["error"] == "module_disabled"
    assert body["module"] == "sample_studio"
    assert "Sample Studio" in body["message"]


# ── switching at runtime ─────────────────────────────────────────────────────

def test_set_enabled_saves_the_switch_and_runs_the_hooks(cfg):
    calls = []
    modules.register_runtime_hooks("audiobooks", on_enable=lambda: calls.append("on"),
                                   on_disable=lambda: calls.append("off"))
    state = modules.set_enabled("audiobooks", False)
    assert cfg.data["modules.audiobooks.enabled"] is False
    assert state["enabled"] is False and state["restart_required"] is False
    assert calls == ["off"]
    state = modules.set_enabled("audiobooks", True)
    assert state["enabled"] is True
    assert calls == ["off", "on"]


def test_resaving_the_same_value_does_not_rerun_hooks(cfg):
    calls = []
    modules.register_runtime_hooks("video", on_disable=lambda: calls.append("off"))
    modules.set_enabled("video", True)        # already on (default)
    assert calls == []
    modules.set_enabled("video", False)
    modules.set_enabled("video", False)
    assert calls == ["off"]


def test_a_worker_without_a_stop_switch_reports_restart_required(cfg):
    modules.register_runtime_hooks("video", on_disable=lambda: "monitor has no stop switch")
    state = modules.set_enabled("video", False)
    assert state["enabled"] is False
    assert state["restart_required"] is True
    assert state["restart_reason"] == "monitor has no stop switch"
    # turning it back on means the leftover worker is wanted again
    state = modules.set_enabled("video", True)
    assert state["restart_required"] is False
    assert state["restart_reason"] is None


def test_a_failing_hook_still_saves_the_switch_and_asks_for_a_restart(cfg):
    def boom():
        raise RuntimeError("can't stop")
    modules.register_runtime_hooks("audiobooks", on_disable=boom)
    state = modules.set_enabled("audiobooks", False)
    assert cfg.data["modules.audiobooks.enabled"] is False
    assert state["restart_required"] is True
    assert "can't stop" in state["restart_reason"]


def test_a_hook_returning_false_gets_a_generic_reason(cfg):
    modules.register_runtime_hooks("chat", on_disable=lambda: False)
    state = modules.set_enabled("chat", False)
    assert state["restart_required"] is True and state["restart_reason"]


# ── automation engine ────────────────────────────────────────────────────────

_VIDEO_KEY = AutomationEngine.MASTER_KEYS["video"]
_MUSIC_KEY = AutomationEngine.MASTER_KEYS["music"]


def _engine(auto, masters=None):
    masters = {_MUSIC_KEY: "1", _VIDEO_KEY: "1", **(masters or {})}
    db = MagicMock()
    db.get_automation.return_value = auto
    db.update_automation_run = MagicMock(return_value=True)
    db.get_metadata.side_effect = lambda key: masters.get(key)
    eng = AutomationEngine(db)
    eng._running = True
    eng.schedule_automation = MagicMock()
    calls = []
    eng._action_handlers[auto["action_type"]] = {
        "handler": lambda config: calls.append(config) or {"status": "completed"},
        "guard": None,
    }
    return eng, db, calls


def _auto(aid, action, trigger="schedule", **extra):
    return {"id": aid, "name": f"auto {aid}", "enabled": True, "action_type": action,
            "action_config": "{}", "trigger_type": trigger,
            "trigger_config": '{"interval": 1}', "profile_id": 1, **extra}


_VIDEO_AUTO = _auto(1, "video_process_episode_wishlist", owned_by="video")
_AUDIOBOOK_AUTO = _auto(2, "audiobook_process_wishlist")
_PODCAST_AUTO = _auto(3, "scan_watchlist_podcasts")
_MUSIC_AUTO = _auto(4, "process_wishlist")


def _recorded_result(db):
    kwargs = db.update_automation_run.call_args.kwargs
    return kwargs.get("error"), json.loads(kwargs["last_result"])


@pytest.mark.parametrize("auto", [_VIDEO_AUTO, _AUDIOBOOK_AUTO, _PODCAST_AUTO, _MUSIC_AUTO])
def test_defaults_run_every_modules_automations(cfg, auto):
    eng, _db, calls = _engine(auto)
    eng.run_automation(auto["id"], skip_delay=False)
    assert len(calls) == 1


@pytest.mark.parametrize("auto,module", [
    (_VIDEO_AUTO, "video"), (_AUDIOBOOK_AUTO, "audiobooks"), (_PODCAST_AUTO, "podcasts"),
])
def test_scheduled_run_of_a_disabled_module_is_skipped_not_failed(cfg, auto, module):
    _off(cfg, module)
    eng, db, calls = _engine(auto)
    eng.run_automation(auto["id"], skip_delay=False)
    assert calls == []
    error, result = _recorded_result(db)
    assert error is None
    assert result["status"] == "skipped" and result["module"] == module
    eng.schedule_automation.assert_called_once_with(auto["id"])   # schedule stays alive


def test_run_now_of_a_disabled_module_is_skipped_too(cfg):
    _off(cfg, "video")
    eng, db, calls = _engine(_VIDEO_AUTO)
    eng.run_automation(1, skip_delay=True)
    assert calls == []
    assert _recorded_result(db)[1]["status"] == "skipped"


def test_only_the_disabled_modules_automations_skip(cfg):
    _off(cfg, "video")
    eng, _db, calls = _engine(_AUDIOBOOK_AUTO)
    eng.run_automation(2, skip_delay=False)
    assert len(calls) == 1
    eng, _db, calls = _engine(_MUSIC_AUTO)
    eng.run_automation(4, skip_delay=False)
    assert len(calls) == 1


def test_event_automation_of_a_disabled_module_is_recorded_as_skipped(cfg):
    _off(cfg, "audiobooks")
    auto = _auto(5, "audiobook_scan_library", trigger="batch_complete", trigger_config="{}")
    eng, db, calls = _engine(auto)
    history = MagicMock()
    eng.register_progress_callbacks(MagicMock(), MagicMock(), history_fn=history)
    eng._run_event_automation(auto, 5, {"playlist_name": "x"})
    assert calls == []
    error, result = _recorded_result(db)
    assert error is None and result["status"] == "skipped" and result["module"] == "audiobooks"
    history.assert_called_once()
    assert history.call_args.args[1]["status"] == "skipped"


def test_event_automation_runs_when_its_module_is_on(cfg):
    auto = _auto(5, "audiobook_scan_library", trigger="batch_complete", trigger_config="{}")
    eng, _db, calls = _engine(auto)
    eng._run_event_automation(auto, 5, {})
    assert len(calls) == 1


def test_direct_effect_callers_see_a_disabled_module_as_off(cfg):
    auto = _auto(6, "video_scan_library", trigger="video_batch_complete")
    db = MagicMock()
    db.get_all_automations.return_value = [auto]
    db.get_automation.return_value = auto
    db.get_metadata.return_value = "1"
    eng = AutomationEngine(db)
    assert eng.is_event_action_enabled("video_batch_complete", "video_scan_library") is True
    _off(cfg, "video")
    assert eng.is_event_action_enabled("video_batch_complete", "video_scan_library") is False


def test_run_endpoint_answers_module_disabled(cfg):
    from core.automation import api as auto_api
    _off(cfg, "podcasts")
    engine = MagicMock()
    engine.db.get_automation.return_value = _PODCAST_AUTO
    body, status = auto_api.run_automation(engine, 3, 1)
    assert status == 409
    assert body["error"] == "module_disabled" and body["module"] == "podcasts"
    engine.run_now.assert_not_called()


def test_run_endpoint_still_runs_when_the_module_is_on(cfg):
    from core.automation import api as auto_api
    engine = MagicMock()
    engine.db.get_automation.return_value = _PODCAST_AUTO
    engine.run_now.return_value = True
    assert auto_api.run_automation(engine, 3, 1) == ({"success": True}, 200)


def test_builder_blocks_name_their_module():
    from core.automation.blocks import blocks_for_scope
    music = blocks_for_scope("music")
    by_type = {b["type"]: b for b in music["actions"] + music["triggers"]}
    assert by_type["scan_watchlist_podcasts"]["module"] == "podcasts"
    assert by_type["audiobook_scan_library"]["module"] == "audiobooks"
    assert by_type["audiobook_new_release"]["module"] == "audiobooks"
    assert by_type["process_wishlist"]["module"] is None
    video = blocks_for_scope("video")
    assert {b["module"] for b in video["actions"] if b["type"].startswith("video_")} == {"video"}


# ── Sample Studio import hook ────────────────────────────────────────────────

def test_import_does_not_queue_sample_analysis_while_sample_studio_is_off(cfg, monkeypatch):
    from core.imports import side_effects
    queued = []
    monkeypatch.setattr("core.sample.worker.enqueue_analysis", queued.append)
    assert side_effects.queue_sample_analysis("t1") is True
    _off(cfg, "sample_studio")
    assert side_effects.queue_sample_analysis("t2") is False
    assert queued == ["t1"]
