"""Setting the quality target from a preset (core/quality/presets.py
apply_preset, PUT /api/quality/target): each preset's ladder lands in the
default quality profile and reads back as that preset, the rest of the profile
is left alone, and a stale or unknown request changes nothing."""

from __future__ import annotations

import json

import pytest
from flask import Flask

from core.quality import presets


@pytest.fixture
def db(tmp_path, monkeypatch):
    from database.music_database import MusicDatabase

    class _Cfg:
        def __init__(self):
            self.values = {}

        def set(self, key, value):
            self.values[key] = value

        def get(self, key, default=None):
            return self.values.get(key, default)

    monkeypatch.setattr("core.settings.config_manager", _Cfg(), raising=False)
    presets.clear_cache()
    return MusicDatabase(database_path=str(tmp_path / "target.db"))


def _row(db):
    conn = db._get_connection()
    try:
        return dict(conn.execute("SELECT * FROM quality_profiles WHERE is_default = 1").fetchone())
    finally:
        conn.close()


def _sql(db, sql, params=()):
    conn = db._get_connection()
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


@pytest.mark.parametrize("key", ["mp3_320", "flac", "flac_24", "lossless"])
@pytest.mark.parametrize("upgrade", [True, False])
def test_each_preset_reads_back_as_itself(db, key, upgrade):
    body = presets.apply_preset(db, key, upgrade_existing=upgrade)
    assert body["current"]["preset"] == key
    assert body["current"]["upgrade_existing"] is upgrade
    assert body["current"]["name"] == next(p["target_name"] for p in presets.PRESETS if p["key"] == key)
    row = _row(db)
    assert json.loads(row["ranked_targets"]) == list(presets.PRESET_LADDERS[key])
    if upgrade:
        assert row["upgrade_policy"] == "until_cutoff"
        # the cutoff is the last target, so the bar is the whole preset
        assert row["upgrade_cutoff_index"] == len(presets.PRESET_LADDERS[key]) - 1
    else:
        assert row["upgrade_policy"] == "acceptable"


def test_the_rest_of_the_profile_is_left_alone(db):
    _sql(db, "UPDATE quality_profiles SET fallback_enabled = 0, search_mode = 'best_quality', "
             "lossy_copy_enabled = 1, lossy_copy_codec = 'opus', name = 'Mine' WHERE is_default = 1")
    before = _row(db)
    presets.apply_preset(db, "flac", upgrade_existing=False)
    after = _row(db)
    for column in ("id", "name", "fallback_enabled", "search_mode", "lossy_copy_enabled", "lossy_copy_codec",
                   "acoustid_required", "release_import_mode", "is_default"):
        assert after[column] == before[column], column
    assert presets.current_target(db)["fallback_enabled"] is False


def test_the_presets_payload_carries_the_bar_and_the_policy(db):
    presets.apply_preset(db, "flac_24", upgrade_existing=True)
    current = presets.preset_counts(db)["current"]
    assert [t["format"] for t in current["targets"]] == ["flac"] * 4
    assert all(t["bit_depth"] == 24 for t in current["targets"])
    assert current["upgrade_existing"] is True and current["fallback_enabled"] is True


def test_a_stale_read_changes_nothing(db):
    _sql(db, "UPDATE quality_profiles SET updated_at = '2026-03-14 09:00:00' WHERE is_default = 1")
    seen = presets.current_target(db)["updated_at"]
    _sql(db, "UPDATE quality_profiles SET updated_at = '2026-03-15 09:00:00' WHERE is_default = 1")
    before = _row(db)["ranked_targets"]
    with pytest.raises(presets.TargetChanged):
        presets.apply_preset(db, "lossless", upgrade_existing=False, based_on=seen)
    assert _row(db)["ranked_targets"] == before


def test_a_fresh_read_goes_through(db):
    _sql(db, "UPDATE quality_profiles SET updated_at = '2026-03-14 09:00:00' WHERE is_default = 1")
    seen = presets.current_target(db)["updated_at"]
    body = presets.apply_preset(db, "lossless", upgrade_existing=False, based_on=seen)
    assert body["current"]["preset"] == "lossless"


def test_an_unknown_preset_is_refused(db):
    with pytest.raises(KeyError):
        presets.apply_preset(db, "mp3_128", upgrade_existing=False)


# ── the endpoint ─────────────────────────────────────────────────────────────

@pytest.fixture
def client(db, monkeypatch):
    import api.targets as targets_api
    import core.profile_context as profile_context

    who = {"admin": True}
    monkeypatch.setattr(profile_context, "is_admin_request", lambda: who["admin"])
    monkeypatch.setattr(targets_api, "get_database", lambda: db)
    monkeypatch.setattr(targets_api, "get_current_profile_id", lambda: 1)
    app = Flask(__name__)
    app.register_blueprint(targets_api.bp)
    c = app.test_client()
    c.who = who
    return c


def test_put_sets_the_target(client, db):
    r = client.put("/api/quality/target", json={"preset": "flac", "upgrade_existing": True})
    assert r.status_code == 200
    body = r.get_json()
    assert body["success"] is True and body["current"]["preset"] == "flac"
    assert [p["key"] for p in body["presets"]] == ["mp3_320", "flac", "flac_24", "lossless"]
    assert _row(db)["upgrade_policy"] == "until_cutoff"


def test_put_refuses_a_member(client, db):
    client.who["admin"] = False
    before = _row(db)["ranked_targets"]
    r = client.put("/api/quality/target", json={"preset": "flac"})
    assert r.status_code == 403
    assert _row(db)["ranked_targets"] == before


def test_put_refuses_an_unknown_preset(client):
    r = client.put("/api/quality/target", json={"preset": "custom"})
    assert r.status_code == 400 and r.get_json()["error"] == "unknown_preset"


def test_put_answers_409_when_the_target_moved(client, db):
    _sql(db, "UPDATE quality_profiles SET updated_at = '2026-03-14 09:00:00' WHERE is_default = 1")
    seen = client.get("/api/quality/presets").get_json()["current"]["updated_at"]
    _sql(db, "UPDATE quality_profiles SET updated_at = '2026-03-20 09:00:00' WHERE is_default = 1")
    r = client.put("/api/quality/target", json={"preset": "flac", "based_on": seen})
    assert r.status_code == 409
    body = r.get_json()
    assert body["error"] == "target_changed" and "Nothing was saved" in body["message"]


def test_put_refuses_a_malformed_based_on(client):
    r = client.put("/api/quality/target", json={"preset": "flac", "based_on": "yesterday"})
    assert r.status_code == 400
