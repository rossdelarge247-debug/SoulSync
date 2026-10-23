"""A radio automation (the radio_track_heard trigger) saved or turned on after
boot starts the radio watcher straight away (core/automation/api.py), instead
of waiting for the next play, favourite, Radio page visit or restart."""

from __future__ import annotations

import json

import pytest

import api.radio as radio_api
import core.automation.api as auto_api
from core import modules
from core.internet_radio.hub import hub
from core.internet_radio.watcher import Watcher


class Rows:
    """An automations table, enough for the save paths."""

    def __init__(self):
        self.rows = {}
        self.reads = 0
        self._next = 1

    def create_automation(self, name, trigger_type, trigger_config, action_type, action_config, profile_id,
                          notify_type=None, notify_config='{}', then_actions='[]', group_name=None, owned_by=None):
        aid = self._next
        self._next += 1
        self.rows[aid] = {"id": aid, "name": name, "trigger_type": trigger_type, "trigger_config": trigger_config,
                          "action_type": action_type, "action_config": action_config, "profile_id": profile_id,
                          "enabled": 1, "is_system": 0, "notify_type": notify_type, "notify_config": notify_config,
                          "then_actions": then_actions, "group_name": group_name}
        return aid

    def get_automation(self, aid):
        self.reads += 1
        row = self.rows.get(aid)
        return dict(row) if row else None

    def update_automation(self, aid, **fields):
        if aid not in self.rows:
            return False
        self.rows[aid].update(fields)
        return True

    def toggle_automation(self, aid):
        if aid not in self.rows:
            return False
        self.rows[aid]["enabled"] = 0 if self.rows[aid]["enabled"] else 1
        return True

    def bulk_set_enabled(self, ids, enabled):
        n = 0
        for aid in ids:
            if aid in self.rows:
                self.rows[aid]["enabled"] = 1 if enabled else 0
                n += 1
        return n


class Engine:
    def __init__(self):
        self.scheduled, self.cancelled = [], []

    def schedule_automation(self, aid):
        self.scheduled.append(aid)

    def cancel_automation(self, aid):
        self.cancelled.append(aid)

    def get_signal_graph(self, *a, **k):  # the cycle check reads none for these triggers
        return {}


RADIO = {"name": "Heard on NTS", "trigger_type": "radio_track_heard", "trigger_config": {},
         "action_type": "add_to_wishlist", "action_config": {}}
SCHEDULE = {"name": "Nightly", "trigger_type": "schedule", "trigger_config": {"interval": 1, "unit": "hours"},
            "action_type": "process_wishlist", "action_config": {}}


@pytest.fixture
def woken(monkeypatch):
    calls = []
    monkeypatch.setattr(auto_api, "_radio_watcher_wake", lambda: calls.append(1))
    return calls


@pytest.fixture
def radio_on(monkeypatch):
    state = {"radio": True}
    monkeypatch.setattr(modules, "is_enabled", lambda name, config=None: state.get(name, True))
    return state


def test_creating_a_radio_automation_wakes_the_watcher(woken, radio_on):
    db, engine = Rows(), Engine()
    body, status = auto_api.create_automation(db, engine, 1, dict(RADIO))
    assert status == 200 and woken == [1]
    body, status = auto_api.create_automation(db, engine, 1, dict(SCHEDULE))
    assert status == 200 and woken == [1]  # other triggers don't


def test_turning_one_on_wakes_it_and_turning_it_off_doesnt(woken, radio_on):
    db, engine = Rows(), Engine()
    aid = db.create_automation("r", "radio_track_heard", "{}", "add_to_wishlist", "{}", 1)
    db.rows[aid]["enabled"] = 0
    auto_api.toggle_automation(db, engine, aid)  # on
    assert woken == [1]
    auto_api.toggle_automation(db, engine, aid)  # off
    assert woken == [1]


def test_bulk_enable_and_update_and_duplicate(woken, radio_on):
    db, engine = Rows(), Engine()
    other = db.create_automation("s", "schedule", "{}", "process_wishlist", "{}", 1)
    radio = db.create_automation("r", "radio_track_heard", "{}", "add_to_wishlist", "{}", 1)
    db.rows[radio]["enabled"] = 0
    auto_api.bulk_toggle(db, engine, [other, radio], False)
    assert woken == []
    auto_api.bulk_toggle(db, engine, [other, radio], True)
    assert woken == [1]
    # an existing automation switched to the radio trigger
    auto_api.update_automation(db, engine, other, {"trigger_type": "radio_track_heard"})
    assert woken == [1, 1]
    auto_api.duplicate_automation(db, engine, 1, radio)
    assert woken == [1, 1, 1]


def test_nothing_happens_while_the_radio_module_is_off(woken, radio_on):
    radio_on["radio"] = False
    db, engine = Rows(), Engine()
    auto_api.create_automation(db, engine, 1, dict(RADIO))
    reads = db.reads
    aid = next(iter(db.rows))
    db.rows[aid]["enabled"] = 0
    auto_api.toggle_automation(db, engine, aid)
    assert woken == []
    # cheap: the wake check didn't read the row again (the engine's own reschedule read is the one)
    assert db.reads == reads + 1


def test_a_failing_wake_never_fails_the_save(monkeypatch, radio_on):
    def boom():
        raise RuntimeError("watcher broke")
    monkeypatch.setattr(auto_api, "_radio_watcher_wake", boom)
    body, status = auto_api.create_automation(Rows(), Engine(), 1, dict(RADIO))
    assert status == 200 and body["success"] is True


def test_without_the_radio_api_wired_nothing_is_asked(monkeypatch, radio_on):
    monkeypatch.setattr(auto_api, "_radio_watcher_wake", None)
    db = Rows()
    assert auto_api.create_automation(db, Engine(), 1, dict(RADIO))[1] == 200
    assert auto_api.wake_radio_watcher(db, [1]) is False


# ── wired for real: the radio API's watcher starts ───────────────────────────

def test_configure_wires_the_real_watcher(app, db, monkeypatch, radio_on):
    """After api.radio.configure(), saving a radio automation runs the radio
    watcher's ensure(): with a favourite to watch, the thread starts."""
    real = Watcher(hub)
    monkeypatch.setattr(radio_api, "watcher", real)
    started = []
    monkeypatch.setattr(real, "_start_locked", lambda: started.append(1))
    monkeypatch.setattr(hub, "has_work", lambda: True)
    with db._get_connection() as conn:
        cur = conn.execute(
            "INSERT INTO automations (name, trigger_type, trigger_config, action_type, action_config, profile_id, "
            "enabled) VALUES (?, ?, ?, ?, ?, ?, 0)",
            ("Heard", "radio_track_heard", json.dumps({}), "add_to_wishlist", json.dumps({}), 1))
        conn.commit()
        aid = cur.lastrowid
    auto_api.toggle_automation(db, None, aid)
    assert started == [1]
    # off: ensure() won't start it (stop() is what the module switch calls)
    real.stop()
    auto_api.toggle_automation(db, None, aid)  # off
    auto_api.toggle_automation(db, None, aid)  # on again, but the watcher is stopped
    assert started == [1]
