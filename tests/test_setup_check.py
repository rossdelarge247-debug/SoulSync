"""Setup check (core/setup_check.py, GET /api/setup/check).

Every check is driven through SetupCheckContext with temp dirs and fake HTTP,
so no test needs a real slskd, media server, full disk or second container.
"""

from __future__ import annotations

import asyncio
import errno
import os
import time
from collections import namedtuple

import pytest
import requests
from flask import Flask

from core import setup_check as sc

Usage = namedtuple("Usage", "total used free")
GB = 1024 ** 3


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

class FakeResp:
    def __init__(self, status=200, data=None):
        self.status_code = status
        self._data = data
        self.content = b"x" if data is not None else b""

    def json(self):
        return self._data


class FakeHttp:
    """Routes GETs by URL suffix. A route value is a FakeResp, an exception
    instance to raise, or a callable(url, headers, params) -> either."""

    def __init__(self, routes=None):
        self.routes = dict(routes or {})
        self.calls = []

    def get(self, url, headers=None, params=None, timeout=None):
        self.calls.append((url, dict(headers or {}), params, timeout))
        assert timeout is not None, "every setup-check request must carry a timeout"
        for suffix, value in self.routes.items():
            if url.endswith(suffix):
                if callable(value) and not isinstance(value, FakeResp):
                    value = value(url, headers, params)
                if isinstance(value, BaseException):
                    raise value
                return value
        return FakeResp(404, {"error": "not found"})


def make_ctx(cfg=None, **kw):
    cfg = dict(cfg or {})
    kw.setdefault("http", FakeHttp())
    kw.setdefault("env", {})
    kw.setdefault("read_mountinfo", lambda: "")
    kw.setdefault("disk_usage", lambda p: Usage(100 * GB, 50 * GB, 50 * GB))
    kw.setdefault("resolve_path", lambda raw: os.path.abspath(raw) if raw else "")
    kw.setdefault("getuid", lambda: 1000)
    kw.setdefault("getgid", lambda: 1000)
    return sc.SetupCheckContext(get=lambda k, d=None: cfg.get(k, d), **kw)


def spec(path, role="transfer", **kw):
    titles = {"downloads": "Download folder", "transfer": "Music library folder", "staging": "Import folder",
              "music_extra": "Extra music folder"}
    return sc.FolderSpec(f"folder.{role}", titles.get(role, "Folder"), str(path), role, "Settings", **kw)


def by_id(report):
    return {c["id"]: c for c in report["checks"]}


@pytest.fixture
def dirs(tmp_path):
    out = {}
    for name in ("downloads", "library", "staging"):
        p = tmp_path / name
        p.mkdir()
        out[name] = p
    return out


# ---------------------------------------------------------------------------
# result shape
# ---------------------------------------------------------------------------

def test_result_shape_and_status_validation():
    r = sc.make_result("x", "X", sc.OK, "fine", category="c", path="/a", nothing=None)
    assert set(r) == {"id", "title", "status", "detail", "fix", "category", "data"}
    assert r["data"] == {"path": "/a"}
    with pytest.raises(ValueError):
        sc.make_result("x", "X", "bad", "?")


def test_worst_status_ignores_skipped():
    assert sc.worst_status([sc.SKIPPED, sc.SKIPPED]) == sc.OK
    assert sc.worst_status([sc.OK, sc.WARNING, sc.SKIPPED]) == sc.WARNING
    assert sc.worst_status([sc.WARNING, sc.ERROR, sc.OK]) == sc.ERROR


# ---------------------------------------------------------------------------
# folder checks
# ---------------------------------------------------------------------------

def test_folder_ok_and_write_test_leaves_nothing_behind(dirs):
    r = sc.check_folder(make_ctx(), spec(dirs["library"]))
    assert r["status"] == sc.OK
    assert "read and write" in r["detail"]
    assert r["data"]["free_gb"] == 50
    assert os.listdir(dirs["library"]) == []


def test_probe_write_creates_and_deletes(tmp_path):
    assert sc._probe_write(str(tmp_path)) == (True, True, None)
    assert os.listdir(tmp_path) == []


def test_missing_folder_native(tmp_path):
    r = sc.check_folder(make_ctx(), spec(tmp_path / "nope"))
    assert r["status"] == sc.ERROR
    assert "doesn't exist" in r["detail"]
    assert "Create the folder" in r["fix"]
    assert not (tmp_path / "nope").exists(), "the check must not create missing folders"


def test_missing_folder_in_container_points_at_compose(tmp_path):
    r = sc.check_folder(make_ctx(in_container=True), spec(tmp_path / "nope"))
    assert r["status"] == sc.ERROR
    assert "docker-compose" in r["fix"] and str(tmp_path / "nope") in r["fix"]


def test_missing_windows_drive_in_container(tmp_path):
    ctx = make_ctx(in_container=True, resolve_path=lambda raw: "/host/mnt/e/Music")
    r = sc.check_folder(ctx, spec("E:\\Music"))
    assert r["status"] == sc.ERROR
    assert "/host/mnt/e" in r["fix"] and "E:\\Music" in r["fix"]


def test_file_not_folder(tmp_path):
    f = tmp_path / "afile"
    f.write_text("x")
    r = sc.check_folder(make_ctx(), spec(f))
    assert r["status"] == sc.ERROR
    assert "is a file, not a folder" in r["detail"]


def test_required_folder_not_set_is_error_optional_is_skipped():
    assert sc.check_folder(make_ctx(), spec("", role="transfer"))["status"] == sc.ERROR
    assert sc.check_folder(make_ctx(), spec("", role="staging", required=False))["status"] == sc.SKIPPED


def test_unreadable_folder(dirs, monkeypatch):
    def deny(_p):
        raise PermissionError(errno.EACCES, "denied")
    monkeypatch.setattr(sc.os, "scandir", deny)
    r = sc.check_folder(make_ctx(), spec(dirs["library"]))
    assert r["status"] == sc.ERROR
    assert "isn't allowed to open" in r["detail"]
    assert "SoulSync runs as user 1000" in r["detail"]


def test_read_only_folder(dirs, monkeypatch):
    def ro(**_kw):
        raise OSError(errno.EROFS, "Read-only file system")
    monkeypatch.setattr(sc.tempfile, "mkstemp", ro)
    r = sc.check_folder(make_ctx(in_container=True), spec(dirs["library"]))
    assert r["status"] == sc.ERROR
    assert "read-only" in r["detail"]
    assert ":ro" in r["fix"]


def test_read_only_extra_music_folder_is_only_a_warning(dirs, monkeypatch):
    def ro(**_kw):
        raise OSError(errno.EROFS, "Read-only file system")
    monkeypatch.setattr(sc.tempfile, "mkstemp", ro)
    r = sc.check_folder(make_ctx(), spec(dirs["library"], role="music_extra", required=False, must_write=False))
    assert r["status"] == sc.WARNING


def test_permission_denied_names_owner_and_chown(dirs, monkeypatch):
    def denied(**_kw):
        raise PermissionError(errno.EACCES, "Permission denied")
    monkeypatch.setattr(sc.tempfile, "mkstemp", denied)
    r = sc.check_folder(make_ctx(in_container=True), spec(dirs["library"]))
    assert r["status"] == sc.ERROR
    assert "permission denied" in r["detail"]
    assert "belongs to user" in r["detail"]
    assert "chown -R 1000:1000" in r["fix"] and "PUID" in r["fix"]


def test_permission_denied_on_cifs_share_suggests_mount_options(dirs, monkeypatch):
    def denied(**_kw):
        raise PermissionError(errno.EACCES, "Permission denied")
    monkeypatch.setattr(sc.tempfile, "mkstemp", denied)
    path = os.path.realpath(dirs["library"])
    mountinfo = (
        "1 0 0:1 / / rw - overlay overlay rw\n"
        f"2 1 0:2 / {path} rw,relatime - cifs //nas/music rw,vers=3.0\n"
    )
    r = sc.check_folder(make_ctx(in_container=True, read_mountinfo=lambda: mountinfo), spec(dirs["library"]))
    assert r["status"] == sc.ERROR
    assert r["data"]["fstype"] == "cifs"
    assert "uid=1000,gid=1000" in r["fix"]
    assert "network share" in r["fix"]


def test_created_but_not_deleted_is_a_warning(dirs, monkeypatch):
    monkeypatch.setattr(sc, "_probe_write", lambda p: (True, False, OSError(errno.EPERM, "no")))
    r = sc.check_folder(make_ctx(), spec(dirs["library"]))
    assert r["status"] == sc.WARNING
    assert "can't delete" in r["detail"]


def test_disk_full_on_download_folder_is_error(dirs):
    ctx = make_ctx(disk_usage=lambda p: Usage(100 * GB, 99 * GB, 1 * GB))
    r = sc.check_folder(ctx, spec(dirs["downloads"], role="downloads", space_floor_gb=5.0))
    assert r["status"] == sc.ERROR
    assert "refusing new downloads" in r["detail"]
    assert r["data"]["free_gb"] == 1


def test_low_space_elsewhere_is_warning(dirs):
    ctx = make_ctx(disk_usage=lambda p: Usage(100 * GB, 99 * GB, 1 * GB))
    r = sc.check_folder(ctx, spec(dirs["library"]))
    assert r["status"] == sc.WARNING
    assert "1.0 GB is free" in r["detail"]


def test_free_space_unknown_does_not_fail(dirs):
    def boom(_p):
        raise OSError("no statvfs")
    r = sc.check_folder(make_ctx(disk_usage=boom), spec(dirs["library"]))
    assert r["status"] == sc.OK
    assert "free_gb" not in r["data"]


def test_folder_inside_container_not_mapped(dirs):
    mountinfo = "1 0 0:1 / / rw - overlay overlay rw\n"
    ctx = make_ctx(in_container=True, read_mountinfo=lambda: mountinfo)
    lib = sc.check_folder(ctx, spec(dirs["library"]))
    dl = sc.check_folder(ctx, spec(dirs["downloads"], role="downloads"))
    assert lib["status"] == sc.ERROR and "inside the SoulSync container" in lib["detail"]
    assert dl["status"] == sc.WARNING


def test_mapped_folder_in_container_is_fine(dirs):
    path = os.path.realpath(dirs["library"])
    mountinfo = f"1 0 0:1 / / rw - overlay overlay rw\n2 1 8:1 /srv/music {path} rw - ext4 /dev/sda1 rw\n"
    r = sc.check_folder(make_ctx(in_container=True, read_mountinfo=lambda: mountinfo), spec(dirs["library"]))
    assert r["status"] == sc.OK


def test_unmapped_volume_line_is_an_anonymous_volume(dirs):
    # the image declares VOLUME /app/Transfer: left unmapped, Docker mounts an
    # anonymous volume there, which is a real mount but not a host folder
    path = os.path.realpath(dirs["library"])
    anon = "a" * 64
    mountinfo = (f"1 0 0:1 / / rw - overlay overlay rw\n"
                 f"2 1 8:1 /var/lib/docker/volumes/{anon}/_data {path} rw - ext4 /dev/sda1 rw\n")
    r = sc.check_folder(make_ctx(in_container=True, read_mountinfo=lambda: mountinfo), spec(dirs["library"]))
    assert r["status"] == sc.ERROR and "unnamed Docker volume" in r["detail"]


def test_named_volume_is_fine(dirs):
    path = os.path.realpath(dirs["library"])
    mountinfo = (f"1 0 0:1 / / rw - overlay overlay rw\n"
                 f"2 1 8:1 /var/lib/docker/volumes/music_library/_data {path} rw - ext4 /dev/sda1 rw\n")
    r = sc.check_folder(make_ctx(in_container=True, read_mountinfo=lambda: mountinfo), spec(dirs["library"]))
    assert r["status"] == sc.OK


def test_native_default_transfer_path_warns(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "Transfer").mkdir()
    r = sc.check_folder(make_ctx(), spec("./Transfer"))
    assert r["status"] == sc.WARNING
    assert "still the default" in r["detail"]


def test_parse_mountinfo_unescapes_spaces():
    mounts = sc.parse_mountinfo("36 35 98:0 /x /mnt/my\\040music rw - nfs4 nas:/music rw\n")
    assert mounts == [("/mnt/my music", "nfs4", "nas:/music", "/x")]
    assert sc.mount_for("/mnt/my music/Artist", mounts)[1] == "nfs4"


# ---------------------------------------------------------------------------
# which folders get checked
# ---------------------------------------------------------------------------

def test_optional_features_skipped_unless_used(dirs):
    cfg = {"podcasts.download_path": "/app/podcasts", "library.audiobooks_path": "/app/audiobooks"}
    specs, skipped = sc.folder_specs(make_ctx(cfg))
    ids = {s.id for s in specs}
    assert "folder.podcasts" not in ids and "folder.audiobooks" not in ids
    assert {r["id"] for r in skipped} >= {"folder.podcasts", "folder.audiobooks", "folder.video"}

    used = make_ctx(cfg, feature_in_use=lambda name: name == "podcasts")
    specs, _ = sc.folder_specs(used)
    assert "folder.podcasts" in {s.id for s in specs}

    custom = make_ctx({"library.audiobooks_path": str(dirs["library"])})
    specs, _ = sc.folder_specs(custom)
    assert "folder.audiobooks" in {s.id for s in specs}


def test_video_and_extra_music_folders(dirs):
    ctx = make_ctx({"library.music_paths": [str(dirs["library"]), ""], "library.music_videos_path": str(dirs["staging"])},
                   video_paths=lambda: {"movies_path": "/media/movies", "tv_path": "", "youtube_path": "/media/yt"})
    specs, skipped = sc.folder_specs(ctx)
    ids = {s.id for s in specs}
    assert {"folder.music_extra.0", "folder.music_videos", "folder.video.movies", "folder.video.youtube"} <= ids
    assert "folder.video.tv" not in ids
    assert "folder.video" not in {r["id"] for r in skipped}
    extra = next(s for s in specs if s.id == "folder.music_extra.0")
    assert extra.must_write is False


def test_video_reader_failure_reads_as_not_set_up():
    def boom():
        raise RuntimeError("video.db locked")
    _, skipped = sc.folder_specs(make_ctx(video_paths=boom))
    assert "folder.video" in {r["id"] for r in skipped}


# ---------------------------------------------------------------------------
# folder layout
# ---------------------------------------------------------------------------

def layout(ctx, d, t, s=None, extra=()):
    specs = [spec(d, "downloads"), spec(t, "transfer")]
    if s is not None:
        specs.append(spec(s, "staging", required=False))
    specs.extend(extra)
    return sc.check_folder_layout(ctx, specs)


def test_layout_separate_is_ok(dirs):
    r = layout(make_ctx(), dirs["downloads"], dirs["library"], dirs["staging"])
    assert r["status"] == sc.OK


def test_layout_download_equals_library(dirs):
    r = layout(make_ctx(), dirs["library"], dirs["library"], dirs["staging"])
    assert r["status"] == sc.ERROR and "are the same folder" in r["detail"]


def test_layout_same_folder_through_symlink(dirs, tmp_path):
    link = tmp_path / "lib-link"
    link.symlink_to(dirs["library"])
    r = layout(make_ctx(), link, dirs["library"])
    assert r["status"] == sc.ERROR


def test_layout_library_inside_downloads(dirs):
    inner = dirs["downloads"] / "music"
    inner.mkdir()
    r = layout(make_ctx(), dirs["downloads"], inner)
    assert r["status"] == sc.ERROR and "inside the download folder" in r["detail"]


def test_layout_downloads_inside_library(dirs):
    inner = dirs["library"] / "incoming"
    inner.mkdir()
    r = layout(make_ctx(), inner, dirs["library"])
    assert r["status"] == sc.ERROR and "inside the music library folder" in r["detail"]


def test_layout_import_equals_library(dirs):
    r = layout(make_ctx(), dirs["downloads"], dirs["library"], dirs["library"])
    assert r["status"] == sc.ERROR and "work against each other" in r["detail"]


def test_layout_import_inside_library_is_warning(dirs):
    inner = dirs["library"] / "Staging"
    inner.mkdir()
    r = layout(make_ctx(), dirs["downloads"], dirs["library"], inner)
    assert r["status"] == sc.WARNING


def test_layout_library_inside_import(dirs):
    inner = dirs["staging"] / "lib"
    inner.mkdir()
    r = layout(make_ctx(), dirs["downloads"], inner, dirs["staging"])
    assert r["status"] == sc.ERROR and "import your whole library again" in r["detail"]


def test_layout_import_equals_downloads(dirs):
    r = layout(make_ctx(), dirs["downloads"], dirs["library"], dirs["downloads"])
    assert r["status"] == sc.ERROR and "still being written" in r["detail"]


def test_layout_downloads_inside_import(dirs):
    inner = dirs["staging"] / "dl"
    inner.mkdir()
    r = layout(make_ctx(), inner, dirs["library"], dirs["staging"])
    assert r["status"] == sc.ERROR


def test_layout_import_inside_downloads_is_allowed(dirs):
    # the Unraid single-share layout; the download sweeps protect it (#976)
    inner = dirs["downloads"] / "Staging"
    inner.mkdir()
    r = layout(make_ctx(), dirs["downloads"], dirs["library"], inner)
    assert r["status"] == sc.OK


def test_layout_audiobooks_inside_music_library(dirs):
    books = dirs["library"] / "Audiobooks"
    books.mkdir()
    extra = [sc.FolderSpec("folder.audiobooks", "Audiobooks folder", str(books), "audiobooks", "S", required=False)]
    r = layout(make_ctx(), dirs["downloads"], dirs["library"], dirs["staging"], extra)
    assert r["status"] == sc.WARNING and "audiobooks folder" in r["detail"]


def test_layout_skipped_without_both_core_folders(dirs):
    r = sc.check_folder_layout(make_ctx(), [spec(dirs["downloads"], "downloads")])
    assert r["status"] == sc.SKIPPED


# ---------------------------------------------------------------------------
# running user
# ---------------------------------------------------------------------------

def test_root_is_a_warning():
    r = sc.check_run_user(make_ctx(in_container=True, getuid=lambda: 0, getgid=lambda: 0, env={"PUID": "0"}))
    assert r["status"] == sc.WARNING and "root" in r["detail"] and "PUID" in r["fix"]


def test_puid_mismatch_in_container():
    r = sc.check_run_user(make_ctx(in_container=True, getuid=lambda: 1001, getgid=lambda: 1000,
                                   env={"PUID": "1000", "PGID": "1000"}))
    assert r["status"] == sc.WARNING and "PUID is 1000" in r["detail"]


def test_puid_match_is_ok():
    r = sc.check_run_user(make_ctx(in_container=True, env={"PUID": "1000", "PGID": "1000"}))
    assert r["status"] == sc.OK and "matching PUID/PGID" in r["detail"]


def test_no_user_ids_is_skipped():
    assert sc.check_run_user(make_ctx(getuid=None, getgid=None))["status"] == sc.SKIPPED


# ---------------------------------------------------------------------------
# slskd connection
# ---------------------------------------------------------------------------

SLSKD = {"download_source.mode": "soulseek", "soulseek.slskd_url": "http://slskd:5030", "soulseek.api_key": "k"}


def test_slskd_not_used_and_not_set_is_skipped():
    r = sc.check_slskd_connection(make_ctx({"download_source.mode": "youtube"}))
    assert r["status"] == sc.SKIPPED


def test_slskd_used_but_no_url():
    r = sc.check_slskd_connection(make_ctx({"download_source.mode": "soulseek"}))
    assert r["status"] == sc.ERROR and "no slskd address" in r["detail"]


def test_hybrid_with_soulseek_counts_as_used():
    assert sc.soulseek_in_use(make_ctx({"download_source.mode": "hybrid", "download_source.hybrid_order": ["youtube", "soulseek"]}))
    assert not sc.soulseek_in_use(make_ctx({"download_source.mode": "hybrid", "download_source.hybrid_order": ["youtube"]}))


def test_slskd_reachable_and_logged_in():
    http = FakeHttp({"/api/v0/session": FakeResp(200, {}),
                     "/api/v0/server": FakeResp(200, {"isConnected": True, "isLoggedIn": True})})
    r = sc.check_slskd_connection(make_ctx(SLSKD, http=http))
    assert r["status"] == sc.OK and "logged in" in r["detail"]
    assert all(c[1].get("X-API-Key") == "k" for c in http.calls)


def test_slskd_not_logged_in_to_soulseek():
    http = FakeHttp({"/api/v0/session": FakeResp(200, {}),
                     "/api/v0/server": FakeResp(200, {"isConnected": True, "isLoggedIn": False})})
    r = sc.check_slskd_connection(make_ctx(SLSKD, http=http))
    assert r["status"] == sc.WARNING and "isn't logged in" in r["detail"]


def test_slskd_wrong_key():
    r = sc.check_slskd_connection(make_ctx(SLSKD, http=FakeHttp({"/api/v0/session": FakeResp(401)})))
    assert r["status"] == sc.ERROR and "rejected" in r["detail"] and "API key" in r["fix"]


def test_slskd_missing_key():
    cfg = dict(SLSKD, **{"soulseek.api_key": ""})
    r = sc.check_slskd_connection(make_ctx(cfg, http=FakeHttp({"/api/v0/session": FakeResp(401)})))
    assert r["status"] == sc.ERROR and "no API key" in r["detail"]


def test_slskd_timeout():
    http = FakeHttp({"/api/v0/session": requests.exceptions.ReadTimeout("slow")})
    r = sc.check_slskd_connection(make_ctx(SLSKD, http=http))
    assert r["status"] == sc.ERROR and "didn't answer" in r["detail"]


def test_slskd_unreachable_in_container_mentions_service_name():
    http = FakeHttp({"/api/v0/session": requests.exceptions.ConnectionError("refused")})
    r = sc.check_slskd_connection(make_ctx(SLSKD, http=http, in_container=True))
    assert r["status"] == sc.ERROR and "can't reach slskd" in r["detail"]
    assert "http://slskd:5030" in r["fix"]


def test_slskd_localhost_rewritten_in_container():
    cfg = dict(SLSKD, **{"soulseek.slskd_url": "http://localhost:5030"})
    http = FakeHttp({"/api/v0/session": requests.exceptions.ConnectionError("refused")})
    sc.check_slskd_connection(make_ctx(cfg, http=http, in_container=True))
    assert http.calls[0][0].startswith("http://host.docker.internal:5030")


def test_slskd_not_slskd():
    r = sc.check_slskd_connection(make_ctx(SLSKD, http=FakeHttp({"/api/v0/session": FakeResp(404)})))
    assert r["status"] == sc.ERROR and "doesn't look like slskd" in r["detail"]


def test_slskd_broken_but_unused_is_only_a_warning():
    cfg = dict(SLSKD, **{"download_source.mode": "youtube"})
    http = FakeHttp({"/api/v0/session": requests.exceptions.ConnectionError("refused")})
    assert sc.check_slskd_connection(make_ctx(cfg, http=http))["status"] == sc.WARNING


def test_slskd_reuses_the_live_clients_check_connection():
    calls = []

    class Client:
        base_url = "http://slskd:5030"
        api_key = "k"

        async def check_connection(self):
            calls.append(1)
            return True

    http = FakeHttp({"/api/v0/session": FakeResp(200, {})})
    ctx = make_ctx(SLSKD, http=http, soulseek_client=lambda: Client(),
                   run_coroutine=lambda coro, timeout: asyncio.run(coro))
    r = sc.check_slskd_connection(ctx)
    assert r["status"] == sc.OK and calls == [1]
    assert not any(c[0].endswith("/server") for c in http.calls)


def test_slskd_stale_client_is_not_trusted():
    class Client:
        base_url = "http://old-host:5030"
        api_key = "k"

        async def check_connection(self):  # pragma: no cover - must not be called
            raise AssertionError("stale client used")

    http = FakeHttp({"/api/v0/session": FakeResp(200, {}),
                     "/api/v0/server": FakeResp(200, {"isConnected": True, "isLoggedIn": True})})
    ctx = make_ctx(SLSKD, http=http, soulseek_client=lambda: Client(),
                   run_coroutine=lambda coro, timeout: asyncio.run(coro))
    assert sc.check_slskd_connection(ctx)["status"] == sc.OK


# ---------------------------------------------------------------------------
# slskd download folder
# ---------------------------------------------------------------------------

def fake_slskd(slskd_downloads, slskd_incomplete=None, *, listing=True, report_path=None):
    """An slskd whose downloads directory is a real folder: the listing
    endpoint lists what is actually in it, like slskd does."""

    def lister(folder):
        def _list(url, headers, params):
            names = sorted(os.listdir(folder))
            return FakeResp(200, {"name": str(folder),
                                  "files": [{"name": n, "fullName": os.path.join(str(folder), n)}
                                            for n in names if os.path.isfile(os.path.join(folder, n))],
                                  "directories": [{"name": os.path.join(str(folder), n)}
                                                  for n in names if os.path.isdir(os.path.join(folder, n))]})
        return _list

    routes = {"/api/v0/options": FakeResp(200, {"directories": {
        "downloads": report_path or str(slskd_downloads),
        "incomplete": str(slskd_incomplete or ""),
    }})}
    if listing:
        routes["/api/v0/files/downloads/directories"] = lister(slskd_downloads)
        if slskd_incomplete:
            routes["/api/v0/files/incomplete/directories"] = lister(slskd_incomplete)
    return FakeHttp(routes)


def dl_cfg(local):
    return dict(SLSKD, **{"soulseek.download_path": str(local)})


def test_shared_download_folder_confirmed_by_marker(dirs):
    http = fake_slskd(dirs["downloads"], report_path="/app/downloads")
    r = sc.check_slskd_download_folder(make_ctx(dl_cfg(dirs["downloads"]), http=http, in_container=True))
    assert r["status"] == sc.OK and "same download folder" in r["detail"]
    assert os.listdir(dirs["downloads"]) == [], "marker file must be removed"


def test_different_download_folder_detected(dirs, tmp_path):
    slskd_dir = tmp_path / "slskd-downloads"
    slskd_dir.mkdir()
    http = fake_slskd(slskd_dir, report_path="/app/downloads")
    r = sc.check_slskd_download_folder(make_ctx(dl_cfg(dirs["downloads"]), http=http, in_container=True))
    assert r["status"] == sc.ERROR
    assert "never find them" in r["detail"]
    assert "same left-hand side" in r["fix"]
    assert os.listdir(dirs["downloads"]) == []


def test_slskd_writing_to_a_subfolder_works(dirs):
    sub = dirs["downloads"] / "soulseek"
    sub.mkdir()
    (sub / "Some Album").mkdir()
    http = fake_slskd(sub, report_path="/data/downloads/soulseek")
    r = sc.check_slskd_download_folder(make_ctx(dl_cfg(dirs["downloads"]), http=http, in_container=True))
    assert r["status"] == sc.OK and "sub-folder" in r["detail"]


def test_slskd_writing_to_an_empty_subfolder_works(dirs):
    sub = dirs["downloads"] / "soulseek"
    sub.mkdir()
    http = fake_slskd(sub, report_path="/data/downloads/soulseek")
    r = sc.check_slskd_download_folder(make_ctx(dl_cfg(dirs["downloads"]), http=http, in_container=True))
    assert r["status"] == sc.OK and str(sub) in r["detail"]
    assert os.listdir(sub) == [] and os.listdir(dirs["downloads"]) == ["soulseek"]


def test_soulsync_reading_slskd_incomplete_folder(dirs, tmp_path):
    complete = tmp_path / "complete"
    complete.mkdir()
    http = fake_slskd(complete, dirs["downloads"])
    r = sc.check_slskd_download_folder(make_ctx(dl_cfg(dirs["downloads"]), http=http, in_container=True))
    assert r["status"] == sc.ERROR and "incomplete folder" in r["detail"]


def test_no_listing_native_same_path_is_ok(dirs):
    cfg = dict(dl_cfg(dirs["downloads"]), **{"soulseek.slskd_url": "http://localhost:5030"})
    http = fake_slskd(dirs["downloads"], listing=False)
    assert sc.check_slskd_download_folder(make_ctx(cfg, http=http))["status"] == sc.OK


def test_no_listing_native_different_path_is_error(dirs, tmp_path):
    other = tmp_path / "elsewhere"
    other.mkdir()
    cfg = dict(dl_cfg(dirs["downloads"]), **{"soulseek.slskd_url": "http://127.0.0.1:5030"})
    http = fake_slskd(other, listing=False)
    r = sc.check_slskd_download_folder(make_ctx(cfg, http=http))
    assert r["status"] == sc.ERROR and str(other) in r["fix"]


def test_no_listing_in_container_same_name_is_skipped(dirs):
    http = fake_slskd(dirs["downloads"], listing=False)
    r = sc.check_slskd_download_folder(make_ctx(dl_cfg(dirs["downloads"]), http=http, in_container=True))
    assert r["status"] == sc.SKIPPED and "couldn't confirm" in r["detail"]


def test_no_listing_in_container_different_name_is_warning(dirs):
    http = fake_slskd(dirs["downloads"], listing=False, report_path="/downloads")
    r = sc.check_slskd_download_folder(make_ctx(dl_cfg(dirs["downloads"]), http=http, in_container=True))
    assert r["status"] == sc.WARNING


def test_download_folder_check_skipped_when_slskd_unreachable(dirs):
    http = FakeHttp({"/api/v0/options": requests.exceptions.ConnectionError("down")})
    r = sc.check_slskd_download_folder(make_ctx(dl_cfg(dirs["downloads"]), http=http))
    assert r["status"] == sc.SKIPPED and "slskd connection first" in r["detail"]


def test_download_folder_check_skipped_without_reported_dir(dirs):
    http = FakeHttp({"/api/v0/options": FakeResp(200, {"soulseek": {}})})
    r = sc.check_slskd_download_folder(make_ctx(dl_cfg(dirs["downloads"]), http=http, in_container=True))
    assert r["status"] == sc.SKIPPED
    assert os.listdir(dirs["downloads"]) == []


# ---------------------------------------------------------------------------
# media server
# ---------------------------------------------------------------------------

def test_media_server_standalone_skipped():
    out = sc.check_media_server(make_ctx({"active_media_server": "soulsync"}))
    assert [r["status"] for r in out] == [sc.SKIPPED, sc.SKIPPED]


def test_media_server_not_configured_skipped():
    out = sc.check_media_server(make_ctx({"active_media_server": "plex"}))
    assert out[0]["status"] == sc.SKIPPED and "No media server" in out[0]["detail"]


PLEX = {"active_media_server": "plex", "plex.base_url": "http://plex:32400", "plex.token": "t"}


def plex_sections(*locations, kind="artist"):
    return FakeResp(200, {"MediaContainer": {"Directory": [
        {"type": kind, "title": "Music", "Location": [{"path": p} for p in locations]}]}})


def test_plex_library_includes_transfer(dirs):
    cfg = dict(PLEX, **{"soulseek.transfer_path": str(dirs["library"])})
    http = FakeHttp({"/library/sections": plex_sections(str(dirs["library"]))})
    conn, lib = sc.check_media_server(make_ctx(cfg, http=http))
    assert conn["status"] == sc.OK and lib["status"] == sc.OK
    assert http.calls[0][1]["X-Plex-Token"] == "t"


def test_plex_bad_token():
    http = FakeHttp({"/library/sections": FakeResp(401)})
    conn, lib = sc.check_media_server(make_ctx(PLEX, http=http))
    assert conn["status"] == sc.ERROR and "rejected the token" in conn["detail"]
    assert lib["status"] == sc.SKIPPED


def test_plex_timeout():
    http = FakeHttp({"/library/sections": requests.exceptions.ConnectTimeout("slow")})
    conn, _ = sc.check_media_server(make_ctx(PLEX, http=http))
    assert conn["status"] == sc.ERROR and "didn't answer" in conn["detail"]


def test_plex_without_music_library():
    http = FakeHttp({"/library/sections": plex_sections("/movies", kind="movie")})
    _, lib = sc.check_media_server(make_ctx(PLEX, http=http))
    assert lib["status"] == sc.WARNING and "no music library" in lib["detail"]


JELLY = {"active_media_server": "jellyfin", "jellyfin.base_url": "http://localhost:8096", "jellyfin.api_key": "j"}


def test_jellyfin_mismatch_native_is_warning(dirs):
    cfg = dict(JELLY, **{"soulseek.transfer_path": str(dirs["library"])})
    http = FakeHttp({"/Library/VirtualFolders": FakeResp(200, [{"Name": "Music", "CollectionType": "music",
                                                                "Locations": ["/srv/other-music"]}])})
    conn, lib = sc.check_media_server(make_ctx(cfg, http=http))
    assert conn["status"] == sc.OK
    assert lib["status"] == sc.WARNING and "won't pick up new downloads" in lib["detail"]
    assert "Token=" in http.calls[0][1].get("Authorization", "")


def test_jellyfin_mismatch_in_container_cannot_be_decided(dirs):
    cfg = dict(JELLY, **{"soulseek.transfer_path": "/app/Transfer"})
    http = FakeHttp({"/Library/VirtualFolders": FakeResp(200, [{"CollectionType": "music", "Locations": ["/music"]}])})
    _, lib = sc.check_media_server(make_ctx(cfg, http=http, in_container=True))
    assert lib["status"] == sc.SKIPPED and "/music" in lib["detail"]


def test_windows_media_server_path_matches_raw_setting():
    cfg = dict(JELLY, **{"soulseek.transfer_path": "E:/Music"})
    http = FakeHttp({"/Library/VirtualFolders": FakeResp(200, [{"CollectionType": "music", "Locations": ["E:\\Music"]}])})
    ctx = make_ctx(cfg, http=http, in_container=True, resolve_path=lambda raw: "/host/mnt/e/Music")
    _, lib = sc.check_media_server(ctx)
    assert lib["status"] == sc.OK


NAVI = {"active_media_server": "navidrome", "navidrome.base_url": "http://nd:4533",
        "navidrome.username": "u", "navidrome.password": "p"}


def test_navidrome_ok_but_path_unknown():
    http = FakeHttp({"/rest/ping": FakeResp(200, {"subsonic-response": {"status": "ok", "version": "1.16.1"}})})
    conn, lib = sc.check_media_server(make_ctx(NAVI, http=http))
    assert conn["status"] == sc.OK and "1.16.1" in conn["detail"]
    assert lib["status"] == sc.SKIPPED
    assert "p" not in (http.calls[0][2] or {}).values(), "the password must not be sent in clear"


def test_navidrome_wrong_password():
    http = FakeHttp({"/rest/ping": FakeResp(200, {"subsonic-response": {"status": "failed",
                                                                         "error": {"code": 40, "message": "Wrong"}}})})
    conn, _ = sc.check_media_server(make_ctx(NAVI, http=http))
    assert conn["status"] == sc.ERROR and "username and password" in conn["fix"]


# ---------------------------------------------------------------------------
# runner
# ---------------------------------------------------------------------------

def full_cfg(dirs):
    return {"soulseek.download_path": str(dirs["downloads"]), "soulseek.transfer_path": str(dirs["library"]),
            "import.staging_path": str(dirs["staging"]), "download_source.mode": "youtube",
            "active_media_server": "soulsync"}


def test_full_run_shape_and_summary(dirs):
    report = sc.run_setup_check(make_ctx(full_cfg(dirs)))
    assert set(report) >= {"status", "summary", "checks", "scope", "ran_at", "duration_ms"}
    assert report["status"] == sc.OK
    assert sum(report["summary"].values()) == len(report["checks"])
    ids = by_id(report)
    assert {"folder.downloads", "folder.transfer", "folder.staging", "folders.layout", "system.user",
            "slskd.connection", "slskd.download_folder", "media_server.connection", "media_server.library_path"} <= set(ids)
    for c in report["checks"]:
        assert c["status"] in sc.STATUSES and c["detail"]
        if c["status"] in (sc.WARNING, sc.ERROR):
            assert c["fix"], f"{c['id']} has a problem but no fix text"


def test_local_scope_skips_network_checks(dirs):
    http = FakeHttp()
    report = sc.run_setup_check(make_ctx(dict(full_cfg(dirs), **SLSKD), http=http), include_network=False)
    assert report["scope"] == "local"
    assert "slskd.connection" not in by_id(report)
    assert http.calls == []


def test_a_crashing_check_does_not_sink_the_run(dirs, monkeypatch):
    def boom(ctx):
        raise RuntimeError("kaboom")
    monkeypatch.setattr(sc, "check_run_user", boom)
    report = sc.run_setup_check(make_ctx(full_cfg(dirs)))
    ids = by_id(report)
    assert ids["system.user"]["status"] == sc.SKIPPED and "kaboom" in ids["system.user"]["detail"]
    assert ids["folder.transfer"]["status"] == sc.OK


def test_a_hanging_check_is_reported_not_waited_for(dirs, monkeypatch):
    def hang(ctx):
        time.sleep(5)
    monkeypatch.setattr(sc, "check_run_user", hang)
    started = time.monotonic()
    report = sc.run_setup_check(make_ctx(full_cfg(dirs)), deadline_s=0.5)
    assert time.monotonic() - started < 3
    r = by_id(report)["system.user"]
    assert r["status"] == sc.WARNING and "didn't finish" in r["detail"]


def test_unreadable_settings_reported(monkeypatch):
    def broken(ctx):
        raise RuntimeError("config locked")
    monkeypatch.setattr(sc, "folder_specs", broken)
    report = sc.run_setup_check(make_ctx())
    assert report["status"] == sc.ERROR and report["checks"][0]["id"] == "settings"


def test_debug_summary_lists_only_problems(dirs, tmp_path):
    cfg = dict(full_cfg(dirs), **{"import.staging_path": str(tmp_path / "missing")})
    out = sc.debug_summary(make_ctx(cfg))
    assert out["scope"] == "local" and out["status"] == sc.ERROR
    assert {"id": "folder.staging", "status": sc.ERROR} in out["problems"]
    assert all(p["status"] in (sc.WARNING, sc.ERROR) for p in out["problems"])


def test_overrides_apply_for_one_run(dirs, tmp_path):
    class CM:
        def get(self, key, default=None):
            return full_cfg(dirs).get(key, default)

    ctx = sc.build_context(CM(), overrides={"soulseek.transfer_path": str(tmp_path / "typed")}, http=FakeHttp(),
                           env={}, read_mountinfo=lambda: "")
    assert ctx.cfg("soulseek.transfer_path") == str(tmp_path / "typed")
    assert ctx.cfg("soulseek.download_path") == str(dirs["downloads"])


# ---------------------------------------------------------------------------
# endpoint
# ---------------------------------------------------------------------------

@pytest.fixture
def api_client(monkeypatch):
    from api import setup_check as api_mod
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(api_mod.create_blueprint())
    seen = {}

    def fake_run(include_network=True, **_kw):
        seen["include_network"] = include_network
        return {"status": sc.WARNING, "summary": {"ok": 1, "warning": 1, "error": 0, "skipped": 0},
                "checks": [sc.make_result("a", "A", sc.OK, "fine"), sc.make_result("b", "B", sc.WARNING, "hm", "do x")],
                "scope": "all" if include_network else "local", "ran_at": 1.0, "duration_ms": 3}

    monkeypatch.setattr(sc, "run_setup_check", fake_run)
    return app.test_client(), seen


def test_endpoint_refuses_non_admin(api_client, monkeypatch):
    client, seen = api_client
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: False)
    resp = client.get("/api/setup/check")
    assert resp.status_code == 403
    assert seen == {}, "the checks must not run for a non-admin"


def test_endpoint_shape_for_admin(api_client, monkeypatch):
    client, seen = api_client
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: True)
    resp = client.get("/api/setup/check")
    assert resp.status_code == 200
    assert resp.headers["Cache-Control"] == "no-store"
    body = resp.get_json()
    assert body["success"] is True and body["status"] == sc.WARNING
    assert body["summary"]["warning"] == 1
    assert {"id", "title", "status", "detail", "fix"} <= set(body["checks"][1])
    assert seen["include_network"] is True


def test_endpoint_local_scope(api_client, monkeypatch):
    client, seen = api_client
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: True)
    assert client.get("/api/setup/check?scope=local").get_json()["scope"] == "local"
    assert seen["include_network"] is False


def test_endpoint_reports_a_runner_failure(api_client, monkeypatch):
    client, _ = api_client
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: True)

    def boom(**_kw):
        raise RuntimeError("nope")
    monkeypatch.setattr(sc, "run_setup_check", boom)
    resp = client.get("/api/setup/check")
    assert resp.status_code == 500 and resp.get_json()["success"] is False


def test_feature_probe_audiobooks_never_creates_the_database(tmp_path, monkeypatch):
    from api import setup_check as api_mod
    db_path = tmp_path / "audiobooks.db"
    monkeypatch.setenv("AUDIOBOOK_DATABASE_PATH", str(db_path))
    assert api_mod.feature_in_use("audiobooks") is False
    assert not db_path.exists()


# ---------------------------------------------------------------------------
# wired into the real app
# ---------------------------------------------------------------------------

def test_real_app_serves_a_local_report_to_admin():
    web_server = pytest.importorskip("web_server")
    resp = web_server.app.test_client().get("/api/setup/check?scope=local")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["success"] is True and body["scope"] == "local"
    assert {"folder.downloads", "folder.transfer", "folders.layout", "system.user"} <= {c["id"] for c in body["checks"]}
