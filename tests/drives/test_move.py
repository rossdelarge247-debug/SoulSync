"""The drive move (core/drives/move.py): copy, check, then switch; never move
first. Run end to end on real folders with a real ConfigManager on a
temporary database, a fake slskd and a fake media server."""

from __future__ import annotations

import json
import os
import sqlite3
import threading

import pytest

from core.drives import holds, markers
from core.drives import move as M
from core.drives.services import ServiceRefused
from core.library.action_plans import PlanStore, PlanError



def write(path, data=b"x"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return path


class FakeSlskd:
    def __init__(self, folder, *, refuse_restart=False):
        self.folder = folder
        self.refuse_restart = refuse_restart
        self.restarts = []
        self.rescans = 0
        self.dirs = ["/music"]
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "slskd.yml"), "w") as f:
            f.write("# slskd's own settings\nsoulseek:\n  username: ross  # mine\n")

    def configured(self):
        return True

    def can_edit(self):
        return True

    def read_config(self):
        with open(os.path.join(self.folder, "slskd.yml")) as f:
            return f.read()

    def write_config(self, text):
        with open(os.path.join(self.folder, "slskd.yml"), "w") as f:
            f.write(text)

    def shared_directories(self):
        return list(self.dirs)

    def sign_in(self, username, password):
        if password != "pw":
            raise ServiceRefused("slskd didn't accept that user name and password.")
        return "jwt-token"

    def restart(self, token, wait=0):
        if self.refuse_restart:
            raise ServiceRefused("slskd refused to restart (HTTP 401).")
        self.restarts.append(token)

    def rescan(self):
        self.rescans += 1


class FakeMedia:
    name = "plex"
    label = "Plex"
    api = True

    def __init__(self, *, refuse=False, sees=True):
        self.refuse = refuse
        self.sees = sees
        self.locs = ["/data/music"]
        self.added, self.removed = [], []

    def can_see(self, path):
        return self.sees

    def locations(self):
        return list(self.locs)

    def add_location(self, path):
        if self.refuse:
            raise ServiceRefused("Plex didn't add the folder to its Music library (Unauthorized).")
        self.locs.append(path)
        self.added.append(path)

    def remove_location(self, path):
        self.locs.remove(path)
        self.removed.append(path)

    def rescan(self):
        pass


@pytest.fixture
def job(install, monkeypatch):
    monkeypatch.setattr(M, "TEST_WRITE_BYTES", 64 * 1024)
    slskd = FakeSlskd(str(install["tmp"] / "slskd-config"))
    media = FakeMedia()
    calls = {"pause": 0, "resume": 0, "after": 0}
    deps = M.Deps(database=lambda: install["db"], config=lambda: install["config"], platform=lambda: "mac",
                  slskd=lambda: slskd, media=lambda: media,
                  pause_workers=lambda: calls.__setitem__("pause", calls["pause"] + 1),
                  resume_workers=lambda: calls.__setitem__("resume", calls["resume"] + 1),
                  after_switch=lambda: calls.__setitem__("after", calls["after"] + 1),
                  encrypt=lambda s: "enc:" + s, decrypt=lambda s: s[4:])
    j = M.MoveJob(deps)
    return {"job": j, "slskd": slskd, "media": media, "calls": calls, **install}


def _target(job):
    return str(job["drive"] / "SYNCHRO.S")


def _ready(job, *, roles=None, checksum=False, sign_in=True):
    j = job["job"]
    move = j.draft(1)
    choice = {"target": _target(job), "checksum": checksum}
    if roles is not None:
        choice["roles"] = {r: r in roles for r in markers.ROLES}
    j.set_choice(move["id"], choice)
    if sign_in and (roles is None or "downloads" in roles):
        j.slskd_sign_in(move["id"], "slskd", "pw")
    moved = j.check(move["id"])
    assert moved["checks"]["ok"], moved["checks"]["rows"]
    j.plan(move["id"])
    return move["id"]


def _stored(job, sql, *args):
    conn = sqlite3.connect(job["db"].database_path)
    try:
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def _stored_config(job):
    [(blob,)] = _stored(job, "SELECT value FROM metadata WHERE key = 'app_config'")
    return json.loads(blob)


# ── Choose and Check ─────────────────────────────────────────────────────────

def test_a_draft_starts_with_every_folder_ticked_and_nothing_changed(job):
    move = job["job"].draft(1)
    assert move["status"] == "draft"
    assert move["choice"]["roles"] == {"library": True, "downloads": True, "staging": True}
    assert M.promise(move, "Macintosh HD") == {"tone": "success", "words": "Nothing has changed yet"}
    # one open move at a time: asking again answers the same one
    assert job["job"].draft(1)["id"] == move["id"]


def test_one_parent_folder_spells_out_the_three_paths(job):
    j = job["job"]
    move = j.draft(1)
    j.set_choice(move["id"], {"target": _target(job)})
    dests = j.destinations(j.store.row(move["id"])["choice"])
    assert dests == {r: os.path.join(_target(job), n) for r, n in M.FOLDER_NAMES.items()}


def test_a_target_outside_the_drives_or_inside_the_app_is_refused(job, tmp_path):
    j = job["job"]
    move = j.draft(1)
    j.set_choice(move["id"], {"target": str(tmp_path / "elsewhere")})
    with pytest.raises(M.MoveError, match="isn't on a drive"):
        j.check(move["id"])
    j.set_choice(move["id"], {"target": "/Volumes/../etc"})
    with pytest.raises(M.MoveError):
        j.check(move["id"])


def test_checks_pass_and_say_so(job):
    j = job["job"]
    move = j.draft(1)
    j.set_choice(move["id"], {"target": _target(job)})
    j.slskd_sign_in(move["id"], "slskd", "pw")
    checks = j.check(move["id"])["checks"]
    keys = {r["key"]: r for r in checks["rows"]}
    assert keys["space"]["tone"] == "success" and keys["space"]["tag"] == "Fine"
    assert keys["write"]["tone"] == "success" and "Made a test file" in keys["write"]["detail"]
    assert keys["slskd"]["tone"] == "success"
    assert checks["ok"] is True
    # the write test left nothing behind, not even the folder it made
    assert not os.path.exists(_target(job))


def test_not_enough_space_stops_with_the_numbers(job, monkeypatch):
    from core.drives import disks
    j = job["job"]
    move = j.draft(1)
    j.set_choice(move["id"], {"target": _target(job)})
    monkeypatch.setattr(disks, "usage", lambda p: {"total": 10**9, "free": 1000, "used": 0})
    checks = j.check(move["id"])["checks"]
    space = next(r for r in checks["rows"] if r["key"] == "space")
    assert space["tone"] == "danger" and space["tag"] == "Not enough space" and "Needs" in space["detail"]
    assert checks["ok"] is False
    with pytest.raises(M.MoveError):
        j.plan(move["id"])


def test_a_folder_that_isnt_empty_stops(job):
    write(os.path.join(_target(job), "Library", "someone else.mp3"))
    j = job["job"]
    move = j.draft(1)
    j.set_choice(move["id"], {"target": _target(job)})
    checks = j.check(move["id"])["checks"]
    row = next(r for r in checks["rows"] if r["key"] == "empty-library")
    assert row["tag"] == "The folder isn't empty" and "1 file SYNCHRO.S didn't put there" in row["detail"]
    assert checks["ok"] is False


def test_exfat_asks_for_a_choice_before_the_plan(job, monkeypatch):
    j = job["job"]
    monkeypatch.setattr(M.disks, "format_of", lambda path, table=None: "exFAT")
    move = j.draft(1)
    j.set_choice(move["id"], {"target": _target(job)})
    j.slskd_sign_in(move["id"], "slskd", "pw")
    checks = j.check(move["id"])["checks"]
    fmt = next(r for r in checks["rows"] if r["key"] == "format")
    assert fmt["tag"] == "Works, with a catch" and fmt["needs_choice"]
    assert checks["ok"] is False
    j.set_choice(move["id"], {"exfat": "carry_on"})
    assert j.check(move["id"])["checks"]["ok"] is True


def test_downloads_moving_needs_slskds_sign_in_once(job):
    j = job["job"]
    move = j.draft(1)
    j.set_choice(move["id"], {"target": _target(job)})
    row = next(r for r in j.check(move["id"])["checks"]["rows"] if r["key"] == "slskd")
    assert row["sign_in"] and row["tone"] == "danger"
    with pytest.raises(M.MoveError, match="didn't accept"):
        j.slskd_sign_in(move["id"], "slskd", "wrong")
    after = j.slskd_sign_in(move["id"], "slskd", "pw")
    assert next(r for r in after["checks"]["rows"] if r["key"] == "slskd")["tone"] == "success"
    # only the session, encrypted, is kept; never the password
    assert j.store.row(move["id"])["secret"] == "enc:jwt-token"


def test_media_server_that_cant_see_the_drive_is_a_warning(job):
    job["media"].sees = False
    j = job["job"]
    move = j.draft(1)
    j.set_choice(move["id"], {"target": _target(job), "roles": {"library": True, "downloads": False,
                                                                 "staging": False}})
    row = next(r for r in j.check(move["id"])["checks"]["rows"] if r["key"] == "media")
    assert row["tone"] == "warning" and row["tag"] == "Plex can't see it"


def test_the_plan_names_the_automations_that_wait(job):
    move_id = _ready(job)
    plan = job["job"].store.row(move_id)["plan"]
    assert plan["automations"] == ["Tidy new albums", "Apply quality upgrades"]
    assert plan["order"][-1] == "library"  # small folders first
    assert plan["total_files"] == 7 and plan["library_paths"] == 3


# ── copy, check, switch ──────────────────────────────────────────────────────

def test_copy_check_then_switch_in_one_transaction(job):
    j = job["job"]
    move_id = _ready(job)
    j.start(move_id, background=False)
    move = j.store.row(move_id)
    assert move["status"] == "switched", move["failure"]
    new = {r: os.path.join(_target(job), n) for r, n in M.FOLDER_NAMES.items()}
    # every file is at the new place, and still at the old one: never moved first
    for role, rels in job["files"].items():
        for rel in rels:
            assert os.path.isfile(os.path.join(new[role], rel))
            assert os.path.isfile(os.path.join(job["roots"][role], rel))
    # the settings and the stored paths changed together, in the database
    stored = _stored_config(job)
    assert stored["soulseek"]["transfer_path"] == new["library"]
    assert stored["soulseek"]["download_path"] == new["downloads"]
    assert stored["import"]["staging_path"] == new["staging"]
    assert job["config"].get("soulseek.transfer_path") == new["library"]
    paths = [p for (p,) in _stored(job, "SELECT file_path FROM tracks ORDER BY id")]
    assert paths[:3] == [os.path.join(new["library"], rel) for rel in job["files"]["library"][:3]]
    assert paths[3] == "/data/music/x.flac"  # a media server's own path isn't touched
    assert all(p.startswith(new["library"]) for (p,) in _stored(job, "SELECT file_path FROM library_history"))
    # markers at the new folders
    for path in new.values():
        assert markers.has_marker(path)
    # slskd shares the new library, downloads there after a restart, and rescans
    text = job["slskd"].read_config()
    assert "# slskd's own settings" in text and "username: ross  # mine" in text
    assert new["library"] in text and new["downloads"] in text
    assert job["slskd"].restarts == ["jwt-token"] and job["slskd"].rescans == 1
    # Plex gained the new folder and kept the old one
    assert job["media"].locs == ["/data/music", new["library"]]
    result = move["result"]
    assert result["media"]["old_location"] == "/data/music"
    assert [c["key"] for c in result["checks"]] == ["library", "slskd", "media", "restarted"]
    assert result["checks"][0]["title"] == "Library: 4 of 4 files found"
    # everything paused started again
    assert job["calls"]["pause"] == 1 and job["calls"]["resume"] == 1 and holds.held_by() is None
    assert M.promise(move, "Macintosh HD")["words"] == "Switched to Music HD · the old copies are kept"


def test_while_copying_writes_wait_and_then_carry_on(job):
    j = job["job"]
    move_id = _ready(job)
    seen = {}
    real_copy = M.copy_file

    def spy(*a, **k):
        seen["held"] = holds.writes_held()
        from core.drives.holds import automation_hold_reason, download_refusal
        seen["automation"] = automation_hold_reason("library_cleanup")
        seen["notify"] = automation_hold_reason("notify_only")
        seen["download"] = download_refusal()
        return real_copy(*a, **k)

    M.copy_file = spy
    try:
        j.start(move_id, background=False)
    finally:
        M.copy_file = real_copy
    assert seen["held"] == holds.HOLD_WORDS
    assert seen["automation"] == holds.HOLD_WORDS and seen["notify"] is None
    assert "Download waits" in seen["download"]
    assert holds.writes_held() is None


def test_symlinks_in_the_source_are_never_followed(job, tmp_path):
    secret = write(str(tmp_path / "outside" / "secret.txt"), b"secret")
    os.symlink(os.path.dirname(secret), os.path.join(job["roots"]["library"], "escape"))
    os.symlink(secret, os.path.join(job["roots"]["library"], "Saltmarsh", "link.flac"))
    j = job["job"]
    move_id = _ready(job)
    j.start(move_id, background=False)
    lib_new = os.path.join(_target(job), "Library")
    assert not os.path.lexists(os.path.join(lib_new, "escape"))
    assert not os.path.lexists(os.path.join(lib_new, "Saltmarsh", "link.flac"))
    rels = {r["rel"] for r in j.store.files(move_id)}
    assert not any("escape" in r or "link.flac" in r for r in rels)


def test_exfat_carry_on_leaves_appledouble_files_behind(job, monkeypatch):
    write(os.path.join(job["roots"]["library"], "Saltmarsh", "._01 Tide.flac"))
    monkeypatch.setattr(M.disks, "format_of", lambda path, table=None: "exFAT")
    j = job["job"]
    move = j.draft(1)
    j.set_choice(move["id"], {"target": _target(job), "exfat": "carry_on"})
    j.slskd_sign_in(move["id"], "slskd", "pw")
    j.check(move["id"])
    j.plan(move["id"])
    j.start(move["id"], background=False)
    assert not os.path.exists(os.path.join(_target(job), "Library", "Saltmarsh", "._01 Tide.flac"))
    assert r"/\._[^/]*$" in job["slskd"].read_config()


def test_checksum_finds_a_damaged_copy_and_copy_them_again_fixes_it(job, monkeypatch):
    j = job["job"]
    move_id = _ready(job, checksum=True)
    real_copy = M.copy_file

    def damaging(src, dst, root, **k):
        real_copy(src, dst, root, **k)
        if dst.endswith("02 Static Bloom.flac"):
            with open(dst, "r+b") as f:
                f.write(b"\0\0\0")  # same size, different contents

    monkeypatch.setattr(M, "copy_file", damaging)
    j.start(move_id, background=False)
    move = j.store.row(move_id)
    assert move["status"] == "failed"
    assert move["failure"]["kind"] == "mismatch" and move["failure"]["count"] == 1
    assert move["failure"]["files"][0]["why"] == "different contents"
    # nothing switched; the settings still point at the old folders
    assert job["config"].get("soulseek.transfer_path") == job["roots"]["library"]
    assert M.promise(move, "Macintosh HD")["words"] == "Nothing switched · your music is on Macintosh HD"
    monkeypatch.setattr(M, "copy_file", real_copy)
    j.recopy(move_id, background=False)
    assert j.store.row(move_id)["status"] == "switched"


def test_the_drive_going_away_fails_and_carry_on_finishes(job, monkeypatch):
    j = job["job"]
    move_id = _ready(job)
    real_copy = M.copy_file
    state = {"n": 0}

    def flaky(src, dst, root, **k):
        state["n"] += 1
        if state["n"] == 3:
            raise OSError(5, "Input/output error")
        return real_copy(src, dst, root, **k)

    monkeypatch.setattr(M, "copy_file", flaky)
    j.start(move_id, background=False)
    move = j.store.row(move_id)
    assert move["status"] == "failed" and move["failure"]["kind"] == "drive_away"
    assert "Music HD disconnected" in move["failure"]["words"]
    assert holds.held_by() is None and job["calls"]["resume"] == 1
    monkeypatch.setattr(M, "copy_file", real_copy)
    j.resume(move_id, background=False)
    assert j.store.row(move_id)["status"] == "switched"


def test_an_unreadable_old_file_can_be_left_where_it_is(job, monkeypatch):
    j = job["job"]
    move_id = _ready(job)
    real_copy = M.copy_file

    def unreadable(src, dst, root, **k):
        if src.endswith("01 Glass.mp3"):
            raise M.SourceUnreadable("Input/output error")
        return real_copy(src, dst, root, **k)

    monkeypatch.setattr(M, "copy_file", unreadable)
    j.start(move_id, background=False)
    move = j.store.row(move_id)
    assert move["failure"]["kind"] == "unreadable" and move["failure"]["count"] == 1
    j.skip_unreadable(move_id, background=False)
    move = j.store.row(move_id)
    assert move["status"] == "switched"
    # the left-out file is never offered for deletion
    preview = j.remove_preview(move_id, PlanStore())
    assert all("01 Glass.mp3" not in i["path"] for i in preview["sample"])


def test_stop_and_undo_deletes_only_the_half_made_copy(job):
    j = job["job"]
    move_id = _ready(job)
    lib_new = os.path.join(_target(job), "Library")
    os.makedirs(lib_new)
    keep = write(os.path.join(_target(job), "Notes", "mine.txt"))
    real_copy = M.copy_file
    state = {"n": 0}

    def stop_midway(src, dst, root, **k):
        state["n"] += 1
        if state["n"] == 4:
            j._stop.set()
        return real_copy(src, dst, root, **k)

    M.copy_file = stop_midway
    try:
        j.start(move_id, background=False)
    finally:
        M.copy_file = real_copy
    move = j.store.row(move_id)
    assert move["status"] == "stopped"
    assert not os.path.exists(lib_new) and not os.path.exists(os.path.join(_target(job), "Staging"))
    assert os.path.isfile(keep)  # a file the move didn't make stays
    for role, rels in job["files"].items():
        for rel in rels:
            assert os.path.isfile(os.path.join(job["roots"][role], rel))
    assert job["config"].get("soulseek.transfer_path") == job["roots"]["library"]


def test_a_refused_service_switches_everything_back(job):
    job["media"].refuse = True
    j = job["job"]
    before_yaml = job["slskd"].read_config()
    move_id = _ready(job)
    j.start(move_id, background=False)
    move = j.store.row(move_id)
    assert move["status"] == "failed" and move["failure"]["kind"] == "refused"
    assert "switched back" in move["failure"]["words"] and "Plex didn't add" in move["failure"]["words"]
    # the database, the settings and slskd are as they were; the copy is kept
    assert _stored_config(job)["soulseek"]["transfer_path"] == job["roots"]["library"]
    assert job["config"].get("soulseek.transfer_path") == job["roots"]["library"]
    paths = [p for (p,) in _stored(job, "SELECT file_path FROM tracks WHERE id < 99 ORDER BY id")]
    assert all(p.startswith(job["roots"]["library"]) for p in paths)
    assert job["slskd"].read_config() == before_yaml
    assert os.path.isfile(os.path.join(_target(job), "Library", "cover.jpg"))
    # try the switch again once the service takes it
    job["media"].refuse = False
    j.resume(move_id, background=False)
    assert j.store.row(move_id)["status"] == "switched"


def test_slskd_refusing_to_restart_switches_back(job):
    job["slskd"].refuse_restart = True
    j = job["job"]
    move_id = _ready(job)
    j.start(move_id, background=False)
    move = j.store.row(move_id)
    assert move["failure"]["kind"] == "refused" and "slskd refused to restart" in move["failure"]["words"]
    assert job["config"].get("soulseek.download_path") == job["roots"]["downloads"]


def test_a_restart_mid_copy_reads_as_stopped_and_can_carry_on(job):
    j = job["job"]
    move_id = _ready(job)
    move = j.store.row(move_id)
    j.store.update(move_id, status="copying", progress={"copied_bytes": 2000, "total_bytes": 9000})
    j.recover_after_restart()
    move = j.store.row(move_id)
    assert move["status"] == "failed" and move["failure"]["kind"] == "restart"
    assert move["failure"]["words"] == "Stopped after 2.0 KB when SYNCHRO.S restarted."
    # the manifest wasn't made yet in this test: carrying on needs the start's manifest
    j.store.update(move_id, status="draft", failure=None)
    j.start(move_id, background=False)
    assert j.store.row(move_id)["status"] == "switched"


# ── Done: remove the old copies, switch back, the reminder ───────────────────

def test_remove_the_old_copies_deletes_exactly_the_checked_files(job):
    j = job["job"]
    move_id = _ready(job)
    j.start(move_id, background=False)
    late = write(os.path.join(job["roots"]["library"], "late.flac"))  # never in the manifest
    plans = PlanStore()
    preview = j.remove_preview(move_id, plans)
    assert preview["total"] == 7
    assert preview["sample"][0]["action"] == "delete"
    # a file swapped since the preview isn't deleted
    swapped = os.path.join(job["roots"]["library"], "cover.jpg")
    with open(swapped, "ab") as f:
        f.write(b"more")
    out = j.remove_confirm(move_id, preview["plan_id"], plans)
    assert out["deleted"] == 6 and out["skipped"] == 1
    assert os.path.isfile(late) and os.path.isfile(swapped)
    assert not os.path.exists(os.path.join(job["roots"]["library"], "Saltmarsh"))
    # the copies are all still there
    for rel in job["files"]["library"]:
        assert os.path.isfile(os.path.join(_target(job), "Library", rel))
    move = j.store.row(move_id)
    assert move["status"] == "removed"
    assert job["media"].removed == ["/data/music"]
    with pytest.raises((PlanError, M.MoveError)):
        j.remove_confirm(move_id, preview["plan_id"], plans)


def test_a_copy_that_went_missing_keeps_its_old_file(job):
    j = job["job"]
    move_id = _ready(job)
    j.start(move_id, background=False)
    plans = PlanStore()
    preview = j.remove_preview(move_id, plans)
    os.unlink(os.path.join(_target(job), "Library", "cover.jpg"))
    out = j.remove_confirm(move_id, preview["plan_id"], plans)
    assert os.path.isfile(os.path.join(job["roots"]["library"], "cover.jpg"))
    assert out["skipped"] == 1


def test_switch_back_brings_new_files_home_and_reverts_everything(job):
    j = job["job"]
    move_id = _ready(job)
    j.start(move_id, background=False)
    lib_new = os.path.join(_target(job), "Library")
    write(os.path.join(lib_new, "New Artist", "new.flac"), b"new")
    j.switch_back(move_id)
    move = j.store.row(move_id)
    assert move["status"] == "switched_back"
    assert os.path.isfile(os.path.join(job["roots"]["library"], "New Artist", "new.flac"))
    assert job["config"].get("soulseek.transfer_path") == job["roots"]["library"]
    assert _stored_config(job)["soulseek"]["transfer_path"] == job["roots"]["library"]
    paths = [p for (p,) in _stored(job, "SELECT file_path FROM tracks WHERE id < 99")]
    assert all(p.startswith(job["roots"]["library"]) for p in paths)
    assert job["slskd"].read_config().startswith("# slskd's own settings")
    assert lib_new not in job["slskd"].read_config()
    assert job["media"].locs == ["/data/music"]


def test_home_reminds_after_seven_days(job):
    j = job["job"]
    move_id = _ready(job)
    j.start(move_id, background=False)
    switched = j.store.row(move_id)["switched_at"]
    assert j.reminder(now=switched + 6 * 86400) is None
    nudge = j.reminder(now=switched + 7 * 86400)
    assert nudge["move_id"] == move_id and nudge["source_label"] == "Macintosh HD"
    assert nudge["target_label"] == "Music HD"


def test_server_side_state_reads_the_same_from_a_second_device(job):
    j = job["job"]
    move_id = _ready(job)
    other = M.MoveJob(j.deps)  # a fresh process, or another browser
    assert other.store.current()["id"] == move_id
    assert other.store.current()["plan"] == j.store.row(move_id)["plan"]
    payload = M.public(other, other.store.current(), admin=False)
    assert all("source" not in f for f in payload["folders"])


def test_the_background_thread_runs_the_same_flow(job):
    j = job["job"]
    move_id = _ready(job)
    j.start(move_id)
    j.join(30)
    assert j.store.row(move_id)["status"] == "switched"
    assert not j.running()


# ── the pieces ───────────────────────────────────────────────────────────────

def test_rewrite_paths_only_touches_paths_under_the_folder(tmp_path):
    conn = sqlite3.connect(str(tmp_path / "x.db"))
    conn.execute("CREATE TABLE tracks (file_path TEXT)")
    conn.executemany("INSERT INTO tracks VALUES (?)", [("/app/Transfer/a.flac",), ("/app/Transfer",),
                                                      ("/app/TransferOld/b.flac",), ("/app/Transfer%/c",), (None,)])
    assert M.rewrite_paths(conn, "/app/Transfer", "/Volumes/X/Library") == 2
    assert [r[0] for r in conn.execute("SELECT file_path FROM tracks")] == [
        "/Volumes/X/Library/a.flac", "/Volumes/X/Library", "/app/TransferOld/b.flac", "/app/Transfer%/c", None]


def test_copy_file_refuses_links_at_either_end(tmp_path):
    src = write(str(tmp_path / "a" / "x.flac"), b"music")
    link = str(tmp_path / "a" / "link.flac")
    os.symlink(src, link)
    with pytest.raises(M.SourceUnreadable):
        M.copy_file(link, str(tmp_path / "b" / "y.flac"), str(tmp_path / "b"), on_bytes=lambda n: None,
                    stop=threading.Event())
    out_root = tmp_path / "b"
    out_root.mkdir()
    os.symlink(str(tmp_path / "elsewhere"), str(out_root / "z.flac"))
    with pytest.raises(OSError):
        M.copy_file(src, str(out_root / "z.flac"), str(out_root), on_bytes=lambda n: None, stop=threading.Event())
    assert not os.path.exists(tmp_path / "elsewhere")
