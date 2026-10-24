"""Every path a person picks is checked (core/drives/paths.py); every route is
admins only except the drive state and the token-guarded helper
(api/drives.py); a stale Settings page can't undo a move
(core/drives/settings_guard.py); and Activity's Library jobs (answer 90)."""

from __future__ import annotations

import os

import pytest
from flask import Flask, g

from core.drives import helper, markers
from core.drives.paths import PathRefused, safe_join, validate_target


# ── paths ────────────────────────────────────────────────────────────────────

@pytest.fixture
def drives(tmp_path):
    root = tmp_path / "Volumes"
    (root / "Music HD" / "SYNCHRO.S").mkdir(parents=True)
    (root / "Other").mkdir()
    (tmp_path / "app" / "config").mkdir(parents=True)
    os.symlink(str(tmp_path / "app"), str(root / "Music HD" / "sneaky"))
    os.symlink(str(root / "Other"), str(root / "Music HD" / "hop"))
    return {"root": str(root), "tmp": tmp_path}


def test_a_folder_on_a_drive_is_fine_and_may_not_exist_yet(drives):
    out = validate_target(os.path.join(drives["root"], "Music HD", "SYNCHRO.S", "New"), roots=[drives["root"]])
    assert out.endswith("/Music HD/SYNCHRO.S/New")


@pytest.mark.parametrize("raw,words", [
    ("", "Choose a folder"),
    ("relative/path", "full path"),
    ("/Volumes/Music HD/../../etc", "“..”"),
    ("/etc", "isn't on a drive"),
    ("/x\x00y", "characters"),
])
def test_bad_paths_are_refused_with_a_sentence(drives, raw, words):
    raw = raw.replace("/Volumes", drives["root"])
    with pytest.raises(PathRefused, match=words):
        validate_target(raw, roots=[drives["root"]])


def test_the_drives_folder_itself_isnt_a_target(drives):
    with pytest.raises(PathRefused, match="Choose a drive"):
        validate_target(drives["root"], roots=[drives["root"]])


def test_a_link_out_of_the_drives_folder_is_refused(drives):
    with pytest.raises(PathRefused):
        validate_target(os.path.join(drives["root"], "Music HD", "sneaky", "config"), roots=[drives["root"]])


def test_a_link_to_another_drive_is_refused(drives):
    with pytest.raises(PathRefused, match="through a link"):
        validate_target(os.path.join(drives["root"], "Music HD", "hop", "x"), roots=[drives["root"]])


def test_the_apps_own_folders_and_the_moving_folders_are_refused(drives):
    app_like = os.path.join(drives["root"], "Music HD", "SYNCHRO.S")
    with pytest.raises(PathRefused, match="its own files"):
        validate_target(os.path.join(app_like, "x"), roots=[drives["root"]], protected=[app_like])
    with pytest.raises(PathRefused, match="inside one of the folders being moved"):
        validate_target(os.path.join(app_like, "x"), roots=[drives["root"]], moving=[app_like])
    with pytest.raises(PathRefused, match="is inside that folder"):
        validate_target(os.path.join(drives["root"], "Music HD"), roots=[drives["root"]], moving=[app_like])


@pytest.mark.parametrize("rel,ok", [("a/b.flac", True), ("../x", False), ("/abs", False), ("a//b", False),
                                    ("a/./b", False), ("", False)])
def test_safe_join(rel, ok):
    assert (safe_join("/root", rel) is not None) == ok


# ── routes ───────────────────────────────────────────────────────────────────

@pytest.fixture
def routes(install, monkeypatch):
    import api.drives as drives_api
    from core.drives import move as M
    monkeypatch.setattr(M, "TEST_WRITE_BYTES", 64 * 1024)
    watch = markers.DriveWatch(config_getter=lambda: install["config"], database_getter=lambda: install["db"])
    markers.set_watch(watch)
    drives_api.configure(get_database_=lambda: install["db"], config_manager_=install["config"],
                         media_label_=lambda: "Plex", slskd_configured_=lambda: True)
    state = {"profile": 1, "admin": True}
    monkeypatch.setattr(drives_api, "is_admin_request", lambda: state["admin"])
    import core.profile_context as pc
    monkeypatch.setattr(pc, "is_admin_request", lambda: state["admin"])
    app = Flask(__name__)

    @app.before_request
    def _profile():
        g.profile_id = state["profile"]
        g.is_admin = state["admin"]

    app.register_blueprint(drives_api.create_blueprint())
    app.config["TESTING"] = True
    return {"client": app.test_client(), "state": state, **install}


ADMIN_ROUTES = [
    ("post", "/api/drives/status/check"), ("get", "/api/drives/folders"), ("get", "/api/drives/docker"),
    ("post", "/api/drives/docker/command"), ("get", "/api/drives/docker/check"), ("get", "/api/drives/browse"),
    ("get", "/api/drives/move"), ("post", "/api/drives/move"), ("put", "/api/drives/move/1/choice"),
    ("post", "/api/drives/move/1/check"), ("post", "/api/drives/move/1/slskd-session"),
    ("post", "/api/drives/move/1/plan"), ("post", "/api/drives/move/1/start"), ("post", "/api/drives/move/stop"),
    ("post", "/api/drives/move/1/resume"), ("post", "/api/drives/move/1/remove-preview"),
    ("post", "/api/drives/move/1/remove"), ("post", "/api/drives/move/1/switch-back"),
    ("post", "/api/drives/move/1/leave"), ("get", "/api/drives/plan-list/abc"),
]


@pytest.mark.parametrize("method,path", ADMIN_ROUTES)
def test_members_are_refused_everything_but_the_state(routes, method, path):
    routes["state"]["admin"] = False
    r = getattr(routes["client"], method)(path, json={})
    assert r.status_code == 403, (path, r.status_code)


def test_members_read_the_state_without_paths_or_check_again(routes):
    routes["state"]["admin"] = False
    body = routes["client"].get("/api/drives/status").get_json()
    assert body["success"] and body["library_away"] is False and body["can_check"] is False
    assert "path" not in body["folders"]["library"] and "move" not in body
    assert body["interval"] == 30


def test_admins_read_paths_and_the_away_state(routes):
    os.rename(routes["roots"]["library"], routes["roots"]["library"] + "-x")
    body = routes["client"].post("/api/drives/status/check", json={}).get_json()
    assert body["library_away"] is True and body["away"] == ["library"]
    assert body["folders"]["library"]["path"] == routes["roots"]["library"]
    assert body["folders"]["library"]["drive"] == "Macintosh HD"


def test_the_folders_card(routes, monkeypatch):
    from core.drives import disks
    monkeypatch.setattr(disks, "usage", lambda p: {"total": 494 * 10**9, "free": 41 * 10**9, "used": 0})
    body = routes["client"].get("/api/drives/folders").get_json()
    assert [f["label"] for f in body["folders"]] == ["Library", "Downloads", "Staging"]
    assert body["folders"][0]["holds"] == "Your music. Library and Plex read it; slskd shares it."
    assert body["drive"] == {"label": "Macintosh HD", "free": 41 * 10**9, "total": 494 * 10**9, "percent": 91.7,
                             "tone": "warning"}
    monkeypatch.setattr(disks, "usage", lambda p: {"total": 100, "free": 1, "used": 99})
    assert routes["client"].get("/api/drives/folders").get_json()["drive"]["tone"] == "danger"


def test_the_docker_step_mints_a_one_use_command(routes):
    c = routes["client"]
    body = c.get("/api/drives/docker").get_json()
    assert body["compose_folder"] == "~/SoulSync" and body["platform"] == "mac"
    assert body["lines"]["mounts"] == ["/Volumes:/Volumes"]
    bad = c.post("/api/drives/docker/command", json={"folder": "~/x; rm -rf ~"})
    assert bad.status_code == 400 and bad.get_json()["field"] == "folder"
    made = c.post("/api/drives/docker/command", json={"folder": "~/synchros", "platform": "mac"}).get_json()
    assert made["command"].startswith("cd ~/synchros && curl -fsSL 'http://localhost/api/drives/helper.sh?t=")
    token = made["command"].split("?t=")[1].split("'")[0]
    assert f"echo '{helper.script_sha256()}  drives-helper.sh' | shasum -a 256 -c - && sh drives-helper.sh" \
        in made["command"]
    assert routes["config"].get("drives.compose_folder") == "~/synchros"
    # curl has no session: the token is the credential, once
    routes["state"]["profile"] = None
    first = c.get(f"/api/drives/helper.sh?t={token}")
    assert first.status_code == 200 and first.data.startswith(b"#!/bin/sh")
    assert first.headers["Cache-Control"] == "no-store"
    again = c.get(f"/api/drives/helper.sh?t={token}")
    assert again.status_code == 403 and b"expired or was used" in again.data
    assert c.get("/api/drives/helper.sh").status_code == 403
    routes["state"]["profile"] = 1
    assert c.get("/api/drives/docker/check").get_json()["token"] == {"state": "used"}


def test_the_helper_route_is_open_through_every_gate():
    from core.security.login_gate import login_request_is_blocked
    from core.security.session_profile import is_open_profile_path
    assert is_open_profile_path("/api/drives/helper.sh", "GET") is True
    assert is_open_profile_path("/api/drives/helper.sh", "POST") is False
    assert is_open_profile_path("/api/drives/docker/command", "POST") is False
    assert login_request_is_blocked("/api/drives/helper.sh", "GET", require_login=True, authenticated=False) is False
    assert login_request_is_blocked("/api/drives/move", "GET", require_login=True, authenticated=False) is True


def test_check_again_tells_a_restart_and_the_drives(routes):
    import api.drives as drives_api
    body = routes["client"].get("/api/drives/docker/check").get_json()
    assert body["boot_id"] == drives_api.BOOT_ID
    assert [d["name"] for d in body["drives"]] == ["Music HD"] and body["visible"] is True


def test_browse_lists_folders_on_a_drive_only(routes, tmp_path):
    c = routes["client"]
    (routes["drive"] / "Music").mkdir()
    (routes["drive"] / ".hidden").mkdir()
    os.symlink(str(tmp_path), str(routes["drive"] / "link"))
    top = c.get("/api/drives/browse").get_json()
    assert [f["name"] for f in top["folders"]] == ["Music HD"]
    inside = c.get("/api/drives/browse", query_string={"path": str(routes["drive"])}).get_json()
    assert [f["name"] for f in inside["folders"]] == ["Music"]
    assert c.get("/api/drives/browse", query_string={"path": "/etc"}).status_code == 400
    assert c.get("/api/drives/browse", query_string={"path": str(routes["drive"]) + "/../.."}).status_code == 400


def _settled(c, path="/api/drives/move", until=lambda body: True):
    import time
    for _ in range(200):
        body = c.get(path).get_json()
        if until(body):
            return body
        time.sleep(0.05)
    raise AssertionError("never settled")


def test_the_move_through_the_routes(routes):
    c = routes["client"]
    draft = c.post("/api/drives/move", json={}).get_json()
    move_id = draft["move"]["id"]
    assert draft["move"]["promise"]["words"] == "Nothing has changed yet"
    # the folder sizes are measured in the background; the page asks again
    overview = _settled(c, until=lambda b: not b["overview"]["measuring"])["overview"]
    assert [f["role"] for f in overview["folders"]] == ["library", "downloads", "staging"]
    assert overview["folders"][0]["files"] == 4 and overview["folders"][0]["albums"] == 2
    assert overview["drives"][0]["name"] == "Music HD" and overview["home_label"] == "Macintosh HD"
    target = str(routes["drive"] / "SYNCHRO.S")
    r = c.put(f"/api/drives/move/{move_id}/choice", json={"target": target,
                                                          "roles": {"library": True, "downloads": False,
                                                                    "staging": True}})
    assert r.status_code == 200
    first = c.post(f"/api/drives/move/{move_id}/check", json={}).get_json()["move"]
    assert first["checks"]["running"] is True  # the write test and the walks run in the background
    import api.drives as drives_api
    drives_api.JOB.join_check(30)
    checked = c.get("/api/drives/move").get_json()["move"]
    assert checked["checks"]["ok"] is True
    planned = c.post(f"/api/drives/move/{move_id}/plan", json={}).get_json()["move"]
    assert planned["plan"]["order"] == ["staging", "library"]
    started = c.post(f"/api/drives/move/{move_id}/start", json={"checksum": True}).get_json()
    assert started["success"]
    drives_api.JOB.join(30)
    after = c.get("/api/drives/move").get_json()["move"]
    assert after["status"] == "switched"
    assert after["promise"]["words"] == "Switched to Music HD · the old copies are kept"
    assert "config_before" not in (after["result"].get("slskd") or {})
    preview = c.post(f"/api/drives/move/{move_id}/remove-preview", json={}).get_json()
    assert preview["total"] == 6 and preview["sample"][0]["action"] == "delete"
    listing = c.get(f"/api/drives/plan-list/{preview['plan_id']}")
    assert listing.status_code == 200 and listing.data.count(b"\n") == 6
    refused = c.post(f"/api/drives/move/{move_id}/remove", json={"plan_id": "nope"})
    assert refused.status_code == 409 and refused.get_json()["code"] == "plan_unknown"
    done = c.post(f"/api/drives/move/{move_id}/remove", json={"plan_id": preview["plan_id"]}).get_json()
    assert done["deleted"] == 6


def test_a_refusal_is_a_sentence_not_a_crash(routes):
    c = routes["client"]
    move_id = c.post("/api/drives/move", json={}).get_json()["move"]["id"]
    r = c.post(f"/api/drives/move/{move_id}/plan", json={})
    assert r.status_code == 409 and r.get_json()["error"] == "Check the drive first."
    assert c.post("/api/drives/move/999/check", json={}).status_code == 404


def test_changes_need_json_from_the_apps_own_pages(routes):
    c = routes["client"]
    assert c.post("/api/drives/move").status_code == 415
    assert c.post("/api/drives/move", data="{}", content_type="text/plain").status_code == 415
    assert c.post("/api/drives/move", json={}, headers={"Origin": "https://evil.example"}).status_code == 403
    assert c.post("/api/drives/move", json={}, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert c.post("/api/drives/move", json={}, headers={"Origin": "null"}).status_code == 403
    ok = c.post("/api/drives/move", json={}, headers={"Origin": "http://localhost",
                                                      "Sec-Fetch-Site": "same-origin"})
    assert ok.status_code == 200
    # reads and the token-guarded script are untouched
    assert c.get("/api/drives/move", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 200


def test_the_command_refuses_an_address_that_isnt_a_plain_url(routes):
    c = routes["client"]
    r = c.post("/api/drives/docker/command", json={"folder": "~/SoulSync", "platform": "linux"},
               base_url='http://x"$(id)"')
    assert r.status_code == 400
    assert helper.TOKENS.state() == {"state": "none"}
    made = c.post("/api/drives/docker/command", json={"folder": "~/SoulSync", "platform": "linux"}).get_json()
    assert "| sha256sum -c - && sh drives-helper.sh" in made["command"]


# ── the Settings page can't undo a move ──────────────────────────────────────

def test_a_stale_settings_page_keeps_the_moved_folders(install):
    from core.drives.settings_guard import filter_folder_settings
    config = install["config"]
    old_lib, new_lib = install["roots"]["library"], "/Volumes/Music HD/SYNCHRO.S/Library"
    config.set("soulseek.transfer_path", new_lib)
    move = {"status": "switched", "result": {"switched_paths": {"old": {"library": old_lib},
                                                                "new": {"library": new_lib}}}}
    posted = {"soulseek": {"transfer_path": old_lib, "download_path": install["roots"]["downloads"]},
              "import": {"staging_path": "/elsewhere"}}
    assert filter_folder_settings(posted, config, move) == ["library"]
    assert "transfer_path" not in posted["soulseek"] and posted["import"]["staging_path"] == "/elsewhere"
    # while copying nothing moves the folders
    copying = {"status": "copying"}
    posted = {"soulseek": {"transfer_path": "/somewhere"}}
    assert filter_folder_settings(posted, config, copying) == ["library"]
    # no move: nothing is touched
    posted = {"soulseek": {"transfer_path": "/somewhere"}}
    assert filter_folder_settings(posted, config, None) == []


# ── Activity: Library jobs (answer 90) ───────────────────────────────────────

def test_library_jobs_have_their_own_filter_with_the_move_and_its_stop(install, monkeypatch):
    from core.activity import feed
    from core.drives import move as M
    import api.drives as drives_api

    from database.music_database import MusicDatabase
    db = MusicDatabase(database_path=str(install["tmp"] / "feed.db"))
    deps = M.Deps(database=lambda: db, config=lambda: install["config"])
    job = M.MoveJob(deps)
    move_id = job.draft(1)["id"]
    move = job.store.row(move_id)
    job.store.update(move_id, status="copying", plan={"target_label": "Music HD", "source_label": "Macintosh HD",
                                                      "total_bytes": 93_200_000_000},
                     progress={"copied_bytes": 41_200_000_000})
    job.store.job_row(move, "running", total=3671, done=1602, note="copying")
    conn = db._get_connection()
    conn.execute("INSERT INTO library_jobs (kind, profile_id, status, total, done, found_releases, "
                 "found_artists, started_at, finished_at) VALUES ('missing_releases', 1, 'done', 12, 12, 3, 2, "
                 "strftime('%s','now'), strftime('%s','now'))")
    conn.commit()
    conn.close()

    class Running:
        def running(self):
            return True

    monkeypatch.setattr(drives_api, "JOB", Running())
    out = feed.build_feed(db, feed.Viewer(profile_id=1, is_admin=True), kind="library", live_batches={},
                          running_automations={})
    titles = {i["title"]: i for i in out["items"]}
    item = titles["Moving your music to Music HD"]
    assert item["kind"] == "library" and item["status"] == "running" and item["link"] == "/move"
    assert item["ref"]["stop_path"] == "drives/move/stop"
    assert "41.2 GB of 93.2 GB" in item["detail"] and "still on Macintosh HD" in item["detail"]
    assert titles["Looked for releases you don't have"]["kind"] == "library"
    assert out["counts"]["library"] == 2
    autos = feed.build_feed(db, feed.Viewer(profile_id=1, is_admin=True), kind="automation", live_batches={},
                            running_automations={})
    assert not [i for i in autos["items"] if i["id"].startswith("library-job:")]
    member = feed.build_feed(db, feed.Viewer(profile_id=5, is_admin=False), kind="library", live_batches={},
                             running_automations={})
    assert member["items"] == []


class _Slskd:
    """slskd as the routes see it: set up, its settings file reachable."""

    def __init__(self, folder):
        self.folder = folder
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "slskd.yml"), "w") as f:
            f.write("soulseek:\n  username: ross\n")

    def configured(self):
        return True

    def can_edit(self):
        return True

    def read_config(self):
        with open(os.path.join(self.folder, "slskd.yml")) as f:
            return f.read()

    def shared_directories(self):
        return ["/music"]

    def sign_in(self, username, password):
        from core.drives.services import ServiceRefused
        if password != "right-password":
            raise ServiceRefused("slskd didn't accept that user name and password.")
        return "session-from-slskd"


def test_slskds_choice_through_the_routes_never_returns_the_secret(routes, tmp_path):
    import api.drives as drives_api
    slskd = _Slskd(str(tmp_path / "slskd-config"))
    drives_api.configure(get_database_=lambda: routes["db"], config_manager_=routes["config"],
                         media_label_=lambda: "Plex", slskd_configured_=lambda: True, slskd_=lambda: slskd)
    c = routes["client"]
    move_id = c.post("/api/drives/move", json={}).get_json()["move"]["id"]
    c.put(f"/api/drives/move/{move_id}/choice", json={"target": str(routes["drive"] / "SYNCHRO.S")})
    c.post(f"/api/drives/move/{move_id}/check", json={})
    drives_api.JOB.join_check(30)
    row = next(r for r in c.get("/api/drives/move").get_json()["move"]["checks"]["rows"] if r["key"] == "slskd")
    assert row["tag"] == "Needs your choice" and row["sign_in"]
    # a refused sign-in is an answer for the Password field, and keeps nothing
    refused = c.post(f"/api/drives/move/{move_id}/slskd-session",
                     json={"username": "slskd", "password": "wrong-password"})
    assert refused.status_code == 400 and refused.get_json()["code"] == "slskd_refused"
    assert b"wrong-password" not in refused.data
    ok = c.post(f"/api/drives/move/{move_id}/slskd-session",
                json={"username": "slskd", "password": "right-password"})
    assert ok.status_code == 200
    drives_api.JOB.join_check(30)
    body = c.get("/api/drives/move")
    assert b"right-password" not in ok.data + body.data
    assert b"session-from-slskd" not in ok.data + body.data
    move = body.get_json()["move"]
    assert move["has_slskd_session"] is True
    row = next(r for r in move["checks"]["rows"] if r["key"] == "slskd")
    assert row["tag"] == "Signed in as slskd"
    # leaving Downloads on the computer forgets the session
    left = c.put(f"/api/drives/move/{move_id}/choice", json={"downloads_left": True}).get_json()["move"]
    assert left["has_slskd_session"] is False and left["choice"]["roles"]["downloads"] is False
