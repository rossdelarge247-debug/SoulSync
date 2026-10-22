"""paused_at on automations: when one was turned off, None while it's on.

Stamped by the toggle, the bulk toggle and update_automation(enabled=...),
cleared when it comes back on, kept while it stays off, and part of what
GET /api/automations and GET /api/automations/<id> return.
"""

from __future__ import annotations

import json
import sqlite3

import pytest
from flask import Flask

import api.automations as automations_api


@pytest.fixture
def db(tmp_path):
    from database.music_database import MusicDatabase
    return MusicDatabase(database_path=str(tmp_path / "paused.db"))


def _make(db, name="Fill Wanted", enabled=True, system=False):
    return db.create_automation(name, "schedule", json.dumps({"interval": 6, "unit": "hours"}),
                                "process_wishlist", "{}", profile_id=1, is_system=system,
                                enabled=enabled)


def _set_paused_at(db, aid, value):
    with db._get_connection() as conn:
        conn.execute("UPDATE automations SET paused_at = ? WHERE id = ?", (value, aid))
        conn.commit()


def test_a_new_automation_that_is_on_has_no_paused_at(db):
    aid = _make(db)
    assert db.get_automation(aid)["paused_at"] is None


def test_one_created_off_is_paused_from_the_start(db):
    aid = _make(db, enabled=False)
    assert db.get_automation(aid)["paused_at"] is not None


def test_toggling_off_stamps_it_and_on_clears_it(db):
    aid = _make(db)
    assert db.toggle_automation(aid)
    row = db.get_automation(aid)
    assert row["enabled"] == 0 and row["paused_at"] is not None
    assert db.toggle_automation(aid)
    row = db.get_automation(aid)
    assert row["enabled"] == 1 and row["paused_at"] is None


def test_bulk_pausing_keeps_an_older_pause_date(db):
    on = _make(db, "On")
    off = _make(db, "Off")
    db.toggle_automation(off)
    _set_paused_at(db, off, "2026-09-01 10:00:00")
    assert db.bulk_set_enabled([on, off], False) == 2
    assert db.get_automation(off)["paused_at"] == "2026-09-01 10:00:00"
    assert db.get_automation(on)["paused_at"] is not None
    assert db.bulk_set_enabled([on, off], True) == 2
    assert db.get_automation(on)["paused_at"] is None and db.get_automation(off)["paused_at"] is None


def test_update_with_enabled_follows_the_same_rule(db):
    aid = _make(db)
    db.update_automation(aid, enabled=0)
    first = db.get_automation(aid)["paused_at"]
    assert first is not None
    _set_paused_at(db, aid, "2026-09-01 10:00:00")
    db.update_automation(aid, enabled=0)          # still off: the date stays
    assert db.get_automation(aid)["paused_at"] == "2026-09-01 10:00:00"
    db.update_automation(aid, name="Renamed")     # an edit doesn't touch it
    assert db.get_automation(aid)["paused_at"] == "2026-09-01 10:00:00"
    db.update_automation(aid, enabled=1)
    assert db.get_automation(aid)["paused_at"] is None


def test_the_migration_backfills_rows_already_off(tmp_path):
    """An install from before the column: rows already paused get their
    updated_at, rows that are on stay None."""
    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.execute("""
        CREATE TABLE automations (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, enabled INTEGER DEFAULT 1,
            trigger_type TEXT NOT NULL, trigger_config TEXT DEFAULT '{}', action_type TEXT NOT NULL,
            action_config TEXT DEFAULT '{}', last_run TIMESTAMP, next_run TIMESTAMP,
            run_count INTEGER DEFAULT 0, last_error TEXT, profile_id INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)
    """)
    conn.execute("INSERT INTO automations (name, enabled, trigger_type, action_type, updated_at) "
                 "VALUES ('Off', 0, 'schedule', 'scan_library', '2026-09-20 08:00:00')")
    conn.execute("INSERT INTO automations (name, enabled, trigger_type, action_type, updated_at) "
                 "VALUES ('On', 1, 'schedule', 'scan_library', '2026-09-21 08:00:00')")
    conn.commit()
    conn.close()
    from database.music_database import MusicDatabase
    db = MusicDatabase(database_path=str(path))
    rows = {a["name"]: a for a in db.get_all_automations()}
    assert rows["Off"]["paused_at"] == "2026-09-20 08:00:00"
    assert rows["On"]["paused_at"] is None


@pytest.fixture
def client(db, monkeypatch):
    monkeypatch.setattr(automations_api, "get_database", lambda: db)
    monkeypatch.setattr(automations_api, "automation_engine", None)
    app = Flask(__name__)
    app.secret_key = "test"
    app.register_blueprint(automations_api.bp)
    return app.test_client()


def test_the_api_returns_paused_at(client, db):
    aid = _make(db)
    assert client.post(f"/api/automations/{aid}/toggle").get_json() == {"success": True}
    listed = next(a for a in client.get("/api/automations").get_json() if a["id"] == aid)
    assert listed["paused_at"]
    assert client.get(f"/api/automations/{aid}").get_json()["paused_at"] == listed["paused_at"]
    client.post(f"/api/automations/{aid}/toggle")
    assert client.get(f"/api/automations/{aid}").get_json()["paused_at"] is None
