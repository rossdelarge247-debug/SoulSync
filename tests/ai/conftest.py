"""Shared pieces for the Assistant's tests: a real music database in a temp
folder, a ConfigManager without its database (the guards in set() are the
real ones), a scripted provider that never calls the network, and a Flask
app with the AI and automation blueprints."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

import pytest
from flask import Flask

import api.ai as ai_api
import api.automations as automations_api
from core.ai import assistant as ai_assistant
from core.ai.provider import Final, ProviderError, ToolCall
from core.settings import ConfigManager


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase
    return MusicDatabase(database_path=str(tmp_path / "ai.db"))


@pytest.fixture
def config():
    cm = ConfigManager.__new__(ConfigManager)
    cm.config_data = {}
    cm._save_config = lambda: None
    return cm


class FakeStream:
    """Plays a script: ("text", "..."), ("tick", None), or an exception to
    raise; then ``final``."""

    def __init__(self, provider, script, final):
        self.provider = provider
        self.script = script
        self._final = final
        self.closed = False
        self.consumed = 0

    def __iter__(self):
        for item in self.script:
            if isinstance(item, BaseException):
                raise item
            self.consumed += 1
            yield item
        self._done = True

    def final(self):
        return self._final if getattr(self, "_done", False) else None

    def usage_so_far(self):
        return dict(self._final.usage) if self._final else {"input_tokens": 100}

    def close(self):
        self.closed = True


class FakeProvider:
    def __init__(self):
        self.calls: List[Dict[str, Any]] = []
        self.streams: List[FakeStream] = []
        self.script: List[Any] = [("text", "Here is a draft.")]
        self.final = Final(stop_reason="end_turn", tool_calls=[],
                           usage={"input_tokens": 1200, "output_tokens": 300}, model="claude-sonnet-5-5")
        self.test_result = (True, "Key works.")
        self.keys: List[str] = []

    def factory(self, api_key, model):
        self.keys.append(api_key)
        self.model = model
        return self

    def open_stream(self, *, system, messages, tools, max_tokens=16000):
        self.calls.append({"system": system, "messages": messages, "tools": tools})
        stream = FakeStream(self, list(self.script), self.final)
        self.streams.append(stream)
        return stream

    def test_key(self):
        return self.test_result

    def draft_call(self, draft, name="propose_draft", **extra):
        return ToolCall(name=name, input={"summary": "Every day at 06:00, check your followed artists.",
                                          "why": "You follow 18 artists.", "facts": ["18 artists followed"],
                                          "draft": draft, **extra})


@pytest.fixture
def provider():
    return FakeProvider()


@pytest.fixture
def who():
    return {"pid": 1, "admin": True}


@pytest.fixture
def client(db, config, provider, who, monkeypatch, tmp_path):
    ai_assistant.reset_for_tests()
    for module in (ai_api, automations_api):
        monkeypatch.setattr(module, "get_current_profile_id", lambda: who["pid"])
        monkeypatch.setattr(module, "is_admin_request", lambda: who["admin"])
        monkeypatch.setattr(module, "get_database", lambda: db)
        monkeypatch.setattr(module, "config_manager", config)
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: who["admin"])
    monkeypatch.setattr(automations_api, "docker_resolve_path", lambda p: p)
    monkeypatch.setattr(automations_api, "spotify_ready", None)
    monkeypatch.setattr(automations_api, "automation_engine", None)
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "tidy.sh").write_text("#!/bin/sh\n")
    config.config_data.setdefault("scripts", {})["path"] = str(scripts)
    monkeypatch.setattr(ai_api, "docker_resolve_path", lambda p: p)
    monkeypatch.setattr(ai_api, "provider_factory", provider.factory)
    app = Flask(__name__)
    app.secret_key = "test"
    app.register_blueprint(ai_api.bp)
    app.register_blueprint(automations_api.bp)
    c = app.test_client()
    c.who = who
    yield c
    ai_assistant.reset_for_tests()


def set_key(config, key="sk-ant-api03-SECRETVALUE123", **more):
    config.set("ai.anthropic_api_key", key)
    for path, value in more.items():
        config.set(f"ai.{path}", value)


def events(response) -> List[tuple]:
    """Parse an SSE body into (event, data) pairs."""
    out = []
    for chunk in response.get_data(as_text=True).split("\n\n"):
        name, data = None, None
        for line in chunk.splitlines():
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        if name:
            out.append((name, data))
    return out


def automation(db, name="Fill Wanted", action="process_wishlist", profile_id=1, system=False, then=None,
               enabled=True, trigger="schedule", trigger_config=None):
    return db.create_automation(name, trigger, json.dumps(trigger_config or {"interval": 6, "unit": "hours"}),
                                action, "{}", profile_id=profile_id, then_actions=json.dumps(then or []),
                                is_system=system, enabled=enabled)


def run_row(db, aid, status="completed", started="2026-10-20T21:15:00+00:00", log=None, summary="Done"):
    return db.insert_automation_run_history(aid, started, started, 30, status, summary, None,
                                            json.dumps(log or []))


__all__ = ["FakeProvider", "FakeStream", "set_key", "events", "automation", "run_row", "ProviderError",
           "ToolCall", "Final"]
