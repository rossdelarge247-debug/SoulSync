"""A drive that's away is never an empty library (core/drives/markers.py) and
the jobs that would act on "missing" files skip the run (14k, 14t)."""

from __future__ import annotations

import os

import pytest

from core.drives import holds, markers


class Config:
    def __init__(self, data):
        self.data = data

    def get(self, key, default=None):
        return self.data.get(key, default)


def _watch(install, **kw):
    clock = kw.pop("clock", None)
    w = markers.DriveWatch(config_getter=lambda: install["config"], database_getter=lambda: install["db"],
                           **({"clock": clock} if clock else {}), **kw)
    markers.set_watch(w)
    return w


@pytest.mark.parametrize("setup,wrote,expects,connected,reason,write", [
    ("missing", False, False, False, "missing", False),
    ("marker", False, True, True, "marker", False),
    ("content", False, True, True, "content", True),
    ("empty", True, False, False, "empty", False),
    ("empty", False, True, False, "empty", False),
    ("empty", False, False, True, "fresh", True),
])
def test_the_rules(tmp_path, setup, wrote, expects, connected, reason, write):
    path = tmp_path / "folder"
    if setup != "missing":
        path.mkdir()
    if setup == "marker":
        markers.write_marker(str(path), "library")
    if setup == "content":
        (path / "a.flac").write_bytes(b"x")
    out = markers.probe(str(path), wrote_here_before=wrote, expects_content=expects)
    assert (out["connected"], out["reason"], out["write"]) == (connected, reason, write)


def test_every_install_gets_its_markers_on_the_first_look(install):
    state = _watch(install).check_now()
    assert state["away"] == [] and state["library_away"] is False
    for role, path in install["roots"].items():
        assert markers.has_marker(path), role
        assert state["folders"][role]["last_seen"] == state["checked_at"]


def test_an_empty_mount_reads_as_away_never_as_empty(install):
    w = _watch(install)
    w.check_now()
    lib = install["roots"]["library"]
    # the drive is unplugged: Docker leaves the mount point, empty
    for name in os.listdir(lib):
        p = os.path.join(lib, name)
        if os.path.isdir(p):
            import shutil
            shutil.rmtree(p)
        else:
            os.unlink(p)
    state = w.check_now()
    assert state["library_away"] is True and state["away"] == ["library"]
    assert state["folders"]["library"]["reason"] == "empty"
    # and it never writes a marker into the empty mount
    assert not markers.has_marker(lib)
    assert markers.library_away() is True


def test_a_missing_folder_is_away_and_last_seen_is_kept(install):
    t = [1000]
    w = _watch(install, clock=lambda: t[0])
    w.check_now()
    t[0] = 5000
    os.rename(install["roots"]["staging"], install["roots"]["staging"] + "-gone")
    state = w.check_now()
    assert state["away"] == ["staging"] and state["library_away"] is False
    assert state["folders"]["staging"]["last_seen"] == 1000
    # a fresh watch (a restart) reads "last seen" back from the database
    w2 = _watch(install, clock=lambda: 6000)
    assert w2.check_now()["folders"]["staging"]["last_seen"] == 1000


def test_an_empty_library_folder_with_tracks_stored_under_it_is_away(install):
    lib = install["roots"]["library"]
    import shutil
    shutil.rmtree(lib)
    os.mkdir(lib)
    state = _watch(install).check_now()
    assert state["library_away"] is True
    assert not markers.has_marker(lib)


def test_a_fresh_install_with_nothing_yet_is_connected(tmp_path):
    folders = {k: str(tmp_path / k) for k in ("lib", "dl", "st")}
    for p in folders.values():
        os.mkdir(p)
    config = Config({"soulseek.transfer_path": folders["lib"], "soulseek.download_path": folders["dl"],
                     "import.staging_path": folders["st"]})

    class Db:
        import sqlite3 as _s

        def _get_connection(self):
            conn = self._s.connect(str(tmp_path / "db.sqlite"))
            conn.row_factory = self._s.Row
            conn.execute("CREATE TABLE IF NOT EXISTS tracks (file_path TEXT)")
            return conn

    w = markers.DriveWatch(config_getter=lambda: config, database_getter=Db)
    state = w.check_now()
    assert state["away"] == []
    assert all(markers.has_marker(p) for p in folders.values())


def test_listeners_hear_a_change(install):
    w = _watch(install)
    heard = []
    w.on_change(lambda s: heard.append(list(s["away"])))
    w.check_now()
    os.rename(install["roots"]["downloads"], install["roots"]["downloads"] + "-x")
    w.check_now()
    assert heard == [["downloads"]]


def test_writes_wait_while_a_music_drive_is_away(install):
    w = _watch(install)
    w.check_now()
    assert holds.writes_held() is None
    os.rename(install["roots"]["downloads"], install["roots"]["downloads"] + "-x")
    w.check_now()
    assert holds.writes_held() == "your downloads drive isn't connected"
    assert "Download waits" in holds.download_refusal()
    assert holds.automation_hold_reason("process_wishlist") == "your downloads drive isn't connected"
    assert holds.automation_hold_reason("backup_database") is None


def test_maintenance_jobs_skip_while_the_library_is_away(install):
    from core import repair_worker as rw

    class Job:
        writes_library_files = False

    w = _watch(install)
    w.check_now()
    assert rw._skips_while_drive_away(Job(), "dead_file_cleaner") is False
    os.rename(install["roots"]["library"], install["roots"]["library"] + "-x")
    w.check_now()
    assert rw._skips_while_drive_away(Job(), "dead_file_cleaner") is True
    assert rw._skips_while_drive_away(Job(), "orphan_file_detector") is True
    assert rw._skips_while_drive_away(Job(), "genre_enrichment") is False
    moving = Job()
    moving.writes_library_files = True
    assert rw._skips_while_drive_away(moving, "anything_that_moves") is True


def test_the_deep_scan_keeps_stale_rows_while_the_library_is_away(install):
    from api import database_admin
    w = _watch(install)
    w.check_now()
    assert database_admin._library_drive_away() is False
    os.rename(install["roots"]["library"], install["roots"]["library"] + "-x")
    w.check_now()
    assert database_admin._library_drive_away() is True


def test_auto_import_waits(install):
    from core import auto_import_worker
    w = _watch(install)
    w.check_now()
    assert auto_import_worker._drive_writes_held() is False
    holds.hold(7)
    try:
        assert auto_import_worker._drive_writes_held() is True
    finally:
        holds.release(7)


def test_the_automation_engine_skips_held_actions(install):
    from core.automation_engine import AutomationEngine
    assert AutomationEngine.drive_hold_result("library_cleanup") is None
    holds.hold(3)
    try:
        assert AutomationEngine.drive_hold_result("library_cleanup") == {
            "status": "skipped", "reason": holds.HOLD_WORDS}
        assert AutomationEngine.drive_hold_result("notify_only") is None
    finally:
        holds.release(3)


def test_downloads_are_refused_while_held():
    import asyncio

    from core.download_orchestrator import DownloadOrchestrator
    holds.hold(4)
    try:
        orch = DownloadOrchestrator.__new__(DownloadOrchestrator)
        with pytest.raises(RuntimeError, match="Download waits"):
            asyncio.run(orch.download("peer", "file.flac", 1))
    finally:
        holds.release(4)
