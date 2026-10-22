"""The Lossy Converter's Convert previews first when it would delete originals.

A quality profile set to "keep lossy output only" makes Convert delete each
lossless original after converting it. A bulk Convert over such findings is
refused without a plan (the preview comes back attached, with the files to
convert, the originals that go and the space that frees); a confirmed plan
converts exactly the previewed findings, and deletes an original only where
the preview said it would. Without a plan no bulk run deletes an original.
Converting while keeping the originals still runs straight away.
"""

from __future__ import annotations

import os
import subprocess
import time
from types import SimpleNamespace

import pytest
from flask import Flask

import api.repair as repair_api
from core.library.action_plans import plan_store
from core.library.deleted_quarantine import list_entries
from core.repair_worker import REPAIR_BULK_FIX_TOOL, RepairWorker
from database.music_database import MusicDatabase

PROFILE = {"lossy_copy_enabled": True, "lossy_copy_codec": "mp3", "lossy_copy_bitrate": "320",
           "lossy_copy_delete_original": True}


@pytest.fixture()
def env(tmp_path, monkeypatch):
    db = MusicDatabase(str(tmp_path / "m.db"))
    worker = RepairWorker(database=db)
    worker._config_manager = None
    worker.transfer_folder = str(tmp_path / "Transfer")
    os.makedirs(worker.transfer_folder)
    profile = dict(PROFILE)
    monkeypatch.setattr("core.quality.selection.load_profile_by_id", lambda _pid: dict(profile))
    # ffmpeg, tagging and probing stubbed: the conversion "writes" the copy
    import shutil

    real_which = shutil.which
    monkeypatch.setattr(shutil, "which", lambda name: "/fake/ffmpeg" if name == "ffmpeg" else real_which(name))

    def _fake_run(cmd, **_kw):
        with open(cmd[-1], "wb") as fh:
            fh.write(b"MP3")
        return SimpleNamespace(returncode=0, stderr="", stdout="")

    monkeypatch.setattr(subprocess, "run", _fake_run)
    monkeypatch.setattr("core.metadata.lossy_tags.carry_tags_to_lossy_copy", lambda *a, **k: None)
    monkeypatch.setattr("core.imports.file_ops.probe_audio_quality", lambda _p: None)
    monkeypatch.setattr("core.imports.file_ops.lossy_copy_verified", lambda _s, _o: True)
    app = Flask(__name__)
    repair_api.configure(worker_getter=lambda: worker, image_url_fixer=lambda u: u, metadata_cache=lambda: None)
    app.register_blueprint(repair_api.create_blueprint())
    plan_store.clear()
    yield SimpleNamespace(db=db, worker=worker, client=app.test_client(), profile=profile, tmp=tmp_path)
    plan_store.clear()


def _lossy(env, n, size=1000, duration_ms=10_000):
    """A lossless track on disk with its Lossy Converter finding."""
    path = os.path.join(env.worker.transfer_folder, "Artist", "Album", f"{n:02d} Song.flac")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(b"F" * size)
    import json
    with env.db._get_connection() as conn:
        conn.execute("INSERT OR IGNORE INTO artists (id, name, server_source) VALUES (1, 'Artist', 'test')")
        conn.execute("INSERT OR IGNORE INTO albums (id, artist_id, title, server_source) VALUES (1, 1, 'Album', 'test')")
        conn.execute("INSERT INTO tracks (id, album_id, artist_id, title, duration, file_path, server_source) "
                     "VALUES (?, 1, 1, ?, ?, ?, 'test')", (n, f"Song {n}", duration_ms, path))
        cur = conn.execute(
            "INSERT INTO repair_findings (job_id, finding_type, severity, status, entity_type, entity_id, "
            "file_path, title, details_json) VALUES ('lossy_converter', 'missing_lossy_copy', 'info', "
            "'pending', 'track', ?, ?, ?, ?)",
            (str(n), path, f"No MP3-320 copy: Song {n}",
             json.dumps({"track_id": n, "resolved_path": path, "file_size": size,
                         "quality_profile_id": None})))
        conn.commit()
        return cur.lastrowid, path


def _wait(worker):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if not worker.get_bulk_fix_status().get("running"):
            return worker.get_bulk_fix_status()
        time.sleep(0.02)
    raise AssertionError("bulk fix did not finish")


def _mp3(path):
    return os.path.splitext(path)[0] + ".mp3"


def test_convert_all_without_a_plan_is_refused_when_originals_would_go(env):
    a, pa = _lossy(env, 1)
    b, pb = _lossy(env, 2)

    res = env.client.post("/api/repair/findings/bulk-fix-start", json={"finding_type": "missing_lossy_copy"})

    assert res.status_code == 409
    body = res.get_json()
    assert body["code"] == "plan_required"
    plan = body["plan"]
    assert plan["total"] == 2 and plan["destructive"] == 2
    assert plan["by_effect"] == {"recycle": 2}
    assert plan["lossy"]["convert"] == 2 and plan["lossy"]["delete_originals"] == 2
    assert plan["lossy"]["originals_bytes"] == 2000
    # 10 s at 320 kbps is 400,000 bytes per copy, more than these tiny originals
    assert plan["lossy"]["estimated_freed_bytes"] == 0
    assert plan["lossy"]["labels"] == ["MP3-320"] and plan["lossy"]["recycle"] is True
    assert plan["sample"][0]["effect"] == "Converts to MP3-320, then moves the lossless original to the recycle bin"
    assert os.path.isfile(pa) and os.path.isfile(pb)
    assert not os.path.exists(_mp3(pa))                            # nothing converted


def test_the_space_freed_estimate_uses_duration_and_bitrate(env):
    _lossy(env, 1, size=30_000_000, duration_ms=200_000)          # 200 s at 320 kbps ~ 8 MB
    plan = env.client.post("/api/repair/findings/bulk-fix-preview",
                           json={"finding_type": "missing_lossy_copy"}).get_json()
    assert plan["lossy"]["estimated_freed_bytes"] == 30_000_000 - 200_000 * 320 // 8
    assert plan["total_bytes"] == 30_000_000


def test_with_recycling_off_the_preview_says_permanently(env):
    env.worker._config_manager = SimpleNamespace(get=lambda k, d=None: False if k == "library.recycle_deletes" else d)
    _lossy(env, 1)
    plan = env.client.post("/api/repair/findings/bulk-fix-preview",
                           json={"finding_type": "missing_lossy_copy"}).get_json()
    assert plan["by_effect"] == {"delete": 1} and plan["lossy"]["recycle"] is False
    assert plan["sample"][0]["effect"].endswith("deletes the lossless original permanently")


def test_a_confirmed_plan_converts_exactly_its_findings_and_recycles_their_originals(env):
    a, pa = _lossy(env, 1)
    b, pb = _lossy(env, 2)
    plan = env.client.post("/api/repair/findings/bulk-fix-preview",
                           json={"finding_type": "missing_lossy_copy"}).get_json()
    late, plate = _lossy(env, 3)

    res = env.client.post("/api/repair/findings/bulk-fix-start", json={"plan_id": plan["plan_id"]})

    assert res.status_code == 200 and res.get_json()["started"] is True
    assert _wait(env.worker)["fixed"] == 2
    for path in (pa, pb):
        assert not os.path.exists(path) and os.path.isfile(_mp3(path))
    assert list_entries(env.worker.transfer_folder)["count"] == 2  # recycle bin, not unlinked
    assert os.path.isfile(plate) and not os.path.exists(_mp3(plate))


def test_an_original_the_preview_kept_is_never_deleted_by_its_plan(env):
    env.profile["lossy_copy_delete_original"] = False
    a, pa = _lossy(env, 1)
    plan = env.client.post("/api/repair/findings/bulk-fix-preview", json={"ids": [a]}).get_json()
    assert plan["destructive"] == 0
    assert plan["sample"][0]["effect"] == "Converts to MP3-320. The lossless file stays"
    env.profile["lossy_copy_delete_original"] = True                # switched on after the preview

    res = env.client.post("/api/repair/findings/bulk-fix", json={"plan_id": plan["plan_id"]})

    assert res.status_code == 200 and res.get_json()["fixed"] == 1
    assert os.path.isfile(pa) and os.path.isfile(_mp3(pa))


def test_converting_and_keeping_the_originals_runs_straight_away(env):
    env.profile["lossy_copy_delete_original"] = False
    a, pa = _lossy(env, 1)
    res = env.client.post("/api/repair/findings/bulk-fix", json={"ids": [a]})
    assert res.status_code == 200 and res.get_json()["fixed"] == 1
    assert os.path.isfile(pa) and os.path.isfile(_mp3(pa))


def test_a_bulk_run_without_a_plan_never_deletes_an_original(env):
    """The automation path (bulk_fix_findings called directly) has no plan."""
    a, pa = _lossy(env, 1)
    result = env.worker.bulk_fix_findings(finding_ids=[a])
    assert result["fixed"] == 1
    assert os.path.isfile(pa) and os.path.isfile(_mp3(pa))


def test_fix_all_safe_leaves_out_converts_that_delete_originals(env):
    _lossy(env, 1)
    assert env.worker._pending_fixable_ids(safe_only=True) == []
    env.profile["lossy_copy_delete_original"] = False
    assert len(env.worker._pending_fixable_ids(safe_only=True)) == 1


def test_the_finding_types_say_convert_moves_files_while_a_profile_deletes(env):
    def destructive():
        return next(t for t in env.worker.get_finding_type_catalog() if t["type"] == "missing_lossy_copy")["destructive"]
    assert destructive() is False                                  # no profile row says so yet
    with env.db._get_connection() as conn:
        conn.execute("UPDATE quality_profiles SET lossy_copy_enabled = 1, lossy_copy_delete_original = 1")
        conn.commit()
    assert destructive() is True


def test_a_copy_that_cannot_be_checked_keeps_its_original(env, monkeypatch):
    monkeypatch.setattr("core.imports.file_ops.lossy_copy_verified", lambda _s, _o: False)
    a, pa = _lossy(env, 1)
    plan = env.client.post("/api/repair/findings/bulk-fix-preview", json={"ids": [a]}).get_json()
    res = env.client.post("/api/repair/findings/bulk-fix", json={"plan_id": plan["plan_id"]})
    assert res.get_json()["fixed"] == 1
    assert os.path.isfile(pa)


def test_the_single_convert_still_follows_the_profile(env):
    """One click on one finding is not a bulk run (the music rule)."""
    a, pa = _lossy(env, 1)
    result = env.worker.fix_finding(a)
    assert result["success"] and result["action"] == "converted_and_deleted"
    assert "recycle bin" in result["message"]
    assert not os.path.exists(pa)


def test_lossy_plans_are_single_use_and_refuse_when_stale(env):
    a, pa = _lossy(env, 1)
    url = "/api/repair/findings/bulk-fix"
    plan = env.client.post("/api/repair/findings/bulk-fix-preview", json={"ids": [a]}).get_json()
    plan_store.peek(plan["plan_id"], REPAIR_BULK_FIX_TOOL).expires_at = time.time() - 1
    expired = env.client.post(url, json={"plan_id": plan["plan_id"]})
    assert expired.status_code == 409 and expired.get_json()["code"] == "plan_expired"
    other = plan_store.create("video_repair_bulk_fix", [{"finding_id": a}], meta={"ids": [a]})
    wrong = env.client.post(url, json={"plan_id": other.plan_id})
    assert wrong.status_code == 409 and wrong.get_json()["code"] == "plan_wrong_tool"
    assert os.path.isfile(pa) and not os.path.exists(_mp3(pa))

    plan = env.client.post("/api/repair/findings/bulk-fix-preview", json={"ids": [a]}).get_json()
    assert env.client.post(url, json={"plan_id": plan["plan_id"]}).status_code == 200
    again = env.client.post(url, json={"plan_id": plan["plan_id"]})
    assert again.status_code == 409 and again.get_json()["code"] == "plan_unknown"
