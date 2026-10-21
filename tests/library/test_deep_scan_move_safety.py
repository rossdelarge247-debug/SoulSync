"""SoulSync standalone Deep Scan: the untracked → Staging move is planned,
previewed and confirmed, never automatic (#904: an empty database made the
scan move a 1,500-track library into Staging).

Drives the real ``_run_soulsync_deep_scan`` / ``build_soulsync_deep_scan_preview``
against tmp Transfer/Staging folders and an in-memory tracks table.
"""

from __future__ import annotations

import os
import sqlite3
import threading

import pytest

import api.database_admin as da
from core.library.action_plans import plan_store
from core.library.standalone_scan import BLOCK_DESYNC, BLOCK_EMPTY_DB, BLOCK_LARGE_MOVE


class _Cfg:
    def __init__(self, values):
        self.values = values

    def get(self, key, default=None):
        return self.values.get(key, default)


class _DB:
    def __init__(self, conn):
        self.conn = conn

    def _get_connection(self):
        return self.conn


def _write(path, payload=b"audio"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(payload)
    return path


@pytest.fixture()
def scan(tmp_path, monkeypatch):
    transfer = str(tmp_path / "Transfer")
    staging = str(tmp_path / "Staging")
    os.makedirs(transfer)
    os.makedirs(staging)
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE tracks (id INTEGER PRIMARY KEY, file_path TEXT, server_source TEXT, album_id TEXT)")
    conn.execute("CREATE TABLE albums (id TEXT PRIMARY KEY, artist_id TEXT, server_source TEXT)")
    conn.execute("CREATE TABLE artists (id TEXT PRIMARY KEY, server_source TEXT)")
    cfg = {
        "soulseek.transfer_path": transfer,
        "import.staging_path": staging,
        "import.transfer_is_permanent": False,   # the user opted in to moves
    }
    state = {}
    activity = []
    errors = []
    monkeypatch.setattr(da, "config_manager", _Cfg(cfg))
    monkeypatch.setattr(da, "docker_resolve_path", lambda p: p)
    monkeypatch.setattr(da, "get_database", lambda: _DB(conn))
    monkeypatch.setattr(da, "db_update_state", state)
    monkeypatch.setattr(da, "db_update_lock", threading.Lock())
    monkeypatch.setattr(da, "_db_update_phase_callback", lambda *a: None)
    monkeypatch.setattr(da, "_db_update_error_callback", errors.append)
    monkeypatch.setattr(da, "_db_update_finished_callback", lambda *a: None)
    monkeypatch.setattr(da, "add_activity_item", lambda *a: activity.append(a[1:3]))
    plan_store.clear()

    def library(n_known, n_new):
        known = [_write(os.path.join(transfer, "Known", f"k{i}.flac")) for i in range(n_known)]
        new = [_write(os.path.join(transfer, "New", f"n{i}.flac")) for i in range(n_new)]
        conn.executemany("INSERT INTO tracks (file_path, server_source) VALUES (?, 'soulsync')",
                         [(p,) for p in known])
        conn.commit()
        return known, new

    yield {"transfer": transfer, "staging": staging, "cfg": cfg, "state": state,
           "activity": activity, "errors": errors, "library": library, "conn": conn}
    plan_store.clear()


def _snapshot(root):
    return sorted(os.path.relpath(os.path.join(d, f), root)
                  for d, _dirs, files in os.walk(root) for f in files)


def _in_staging(scan, path):
    return os.path.isfile(os.path.join(scan["staging"], os.path.relpath(path, scan["transfer"])))


# ── default: moves are off ──────────────────────────────────────────────────


def test_moving_is_off_by_default(scan):
    _known, new = scan["library"](20, 3)
    del scan["cfg"]["import.transfer_is_permanent"]   # a user who never touched it
    before = _snapshot(scan["transfer"])

    da._run_soulsync_deep_scan(confirm_moves=True)

    assert _snapshot(scan["transfer"]) == before
    assert scan["state"]["deep_scan_moves"]["block_reason"] == "transfer_permanent"


def test_the_shipped_default_keeps_the_library_permanent():
    from core.settings import ConfigManager
    defaults = ConfigManager.__new__(ConfigManager)._get_default_config()
    assert defaults["import"]["transfer_is_permanent"] is True
    assert defaults["library"]["recycle_deletes"] is True
    assert defaults["library"]["deep_scan_max_move_percent"] == 25


# ── plan mode ──────────────────────────────────────────────────────────────


def test_an_unconfirmed_scan_previews_and_moves_nothing(scan):
    _known, new = scan["library"](20, 3)
    before = _snapshot(scan["transfer"])

    da._run_soulsync_deep_scan()

    assert _snapshot(scan["transfer"]) == before
    assert _snapshot(scan["staging"]) == []
    report = scan["state"]["deep_scan_moves"]
    assert report["mode"] == "preview"
    assert report["would_move"] == 3
    assert report["moved"] == 0
    assert report["plan_id"]
    assert sorted(i["path"] for i in report["sample"]) == sorted(new)
    assert all(i["reason"] == "no database record for this file" for i in report["sample"])
    assert any("Nothing was moved" in text for _title, text in scan["activity"])


def test_preview_reports_accurate_counts(scan):
    scan["library"](20, 3)
    preview = da.build_soulsync_deep_scan_preview()
    assert preview["library_files"] == 23
    assert preview["database_tracks"] == 20
    assert preview["untracked"] == 3
    assert preview["would_move"] == 3
    assert preview["counts"] == {"move_to_staging": 3}
    assert preview["needs_confirmation"] is False
    assert preview["plan_id"]
    assert _snapshot(scan["staging"]) == []


def test_preview_says_when_it_stops_working_and_what_the_limit_is(scan):
    """The confirm screen shows when the preview was made, when it expires,
    where the files go and the ratio limit its warning names."""
    scan["library"](20, 3)
    preview = da.build_soulsync_deep_scan_preview()
    stored = plan_store.peek(preview["plan_id"], "deep_scan")
    assert preview["created_at"] == stored.created_at
    assert preview["expires_at"] == stored.expires_at
    assert preview["max_move_percent"] == 25
    assert preview["staging_path"] == scan["staging"]


def test_a_preview_with_nothing_to_confirm_has_no_expiry(scan):
    scan["library"](20, 0)
    preview = da.build_soulsync_deep_scan_preview()
    assert preview["mode"] == "clean"
    assert preview["plan_id"] is None
    assert preview["created_at"] is None and preview["expires_at"] is None


# ── confirmed plan ─────────────────────────────────────────────────────────


def test_a_confirmed_preview_moves_exactly_its_files(scan):
    _known, new = scan["library"](20, 3)
    preview = da.build_soulsync_deep_scan_preview()
    late = _write(os.path.join(scan["transfer"], "New", "late.flac"))   # after the preview

    da._run_soulsync_deep_scan(preview["plan_id"])

    assert all(_in_staging(scan, p) and not os.path.exists(p) for p in new)
    assert os.path.isfile(late)          # never previewed, never moved
    assert scan["state"]["deep_scan_moves"]["moved"] == 3


def test_acting_with_a_stale_plan_is_refused(scan):
    _known, new = scan["library"](20, 3)
    preview = da.build_soulsync_deep_scan_preview()
    da._run_soulsync_deep_scan(preview["plan_id"])
    _write(os.path.join(scan["transfer"], "New", "n0.flac"))    # same name, back again
    before = _snapshot(scan["transfer"])

    da._run_soulsync_deep_scan(preview["plan_id"])              # replayed

    assert _snapshot(scan["transfer"]) == before
    assert any("move not confirmed" in title for title, _text in scan["activity"])


def test_an_automation_set_to_act_moves_a_normal_batch(scan):
    _known, new = scan["library"](20, 3)
    da._run_soulsync_deep_scan(confirm_moves=True)
    assert all(_in_staging(scan, p) for p in new)


# ── guards ─────────────────────────────────────────────────────────────────


def test_empty_database_guard_holds_even_for_an_automation_set_to_act(scan):
    _known, new = scan["library"](0, 5)

    da._run_soulsync_deep_scan(confirm_moves=True)

    assert all(os.path.isfile(p) for p in new)
    report = scan["state"]["deep_scan_moves"]
    assert report["block_reason"] == BLOCK_EMPTY_DB
    assert report["needs_confirmation"] is True
    assert report["plan_id"]                     # reviewable / confirmable


def test_empty_database_moves_only_with_preview_plus_large_move_confirmation(scan):
    _known, new = scan["library"](0, 5)
    preview = da.build_soulsync_deep_scan_preview()
    assert preview["block_reason"] == BLOCK_EMPTY_DB

    da._run_soulsync_deep_scan(preview["plan_id"], allow_large_move=True)

    assert all(_in_staging(scan, p) for p in new)


def test_regression_904_full_library_with_empty_db_never_moves(scan):
    _known, new = scan["library"](0, 40)
    preview = da.build_soulsync_deep_scan_preview()
    assert preview["block_reason"] == BLOCK_DESYNC
    assert preview["plan_id"] is None            # nothing can be confirmed

    da._run_soulsync_deep_scan(confirm_moves=True, allow_large_move=True)

    assert all(os.path.isfile(p) for p in new)
    assert _snapshot(scan["staging"]) == []


def test_ratio_guard_blocks_a_large_move_for_an_automation(scan):
    _known, new = scan["library"](30, 15)        # 33% of the library

    da._run_soulsync_deep_scan(confirm_moves=True)

    assert all(os.path.isfile(p) for p in new)
    assert scan["state"]["deep_scan_moves"]["block_reason"] == BLOCK_LARGE_MOVE


def test_ratio_guard_lifts_only_for_a_confirmed_large_move(scan):
    _known, new = scan["library"](30, 15)
    preview = da.build_soulsync_deep_scan_preview()
    assert preview["needs_confirmation"] is True

    # confirmation flag without a plan does nothing
    da._run_soulsync_deep_scan(allow_large_move=True)
    assert all(os.path.isfile(p) for p in new)

    da._run_soulsync_deep_scan(preview["plan_id"], allow_large_move=True)
    assert all(_in_staging(scan, p) for p in new)


def test_ratio_limit_comes_from_settings(scan):
    scan["cfg"]["library.deep_scan_max_move_percent"] = 50
    _known, new = scan["library"](30, 15)        # 33% < 50%
    da._run_soulsync_deep_scan(confirm_moves=True)
    assert all(_in_staging(scan, p) for p in new)


def test_the_recycle_bin_is_never_carried_back_into_staging(scan):
    scan["library"](20, 0)
    binned = _write(os.path.join(scan["transfer"], ".deleted", "Artist", "dupe.mp3"))

    da._run_soulsync_deep_scan(confirm_moves=True)

    assert os.path.isfile(binned)
    assert _snapshot(scan["staging"]) == []
