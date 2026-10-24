"""The computer's own names for the music folders (Design's 125, Dev's 160):
the drives helper writes one ``host-paths.json`` into SYNCHRO.S's settings
folder, keyed by each music folder's marker id (core/drives/compose_tool.py),
and SYNCHRO.S reads it as untrusted display text (core/drives/host_paths.py),
trusting an entry only while its key is the folder's current marker id.
Nothing is written into the music folders, which slskd may share. The helper
runs against a copy of Ross's Mac compose file."""

from __future__ import annotations

import itertools
import json
import os
import subprocess
import tempfile

import pytest

from core.drives import compose_tool as C
from core.drives import helper as H
from core.drives import host_paths as HP
from core.drives import markers

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "ross-mac-compose.yml")


def _entry(**over):
    body = {"host_path": "/Users/ross/SoulSync/music", "volume": "Macintosh HD", "os": "mac",
            "written_at": 1761300000}
    body.update(over)
    return body


def _write_hints(folders, *, v=1, extra=None):
    """The hints file where SYNCHRO.S reads it (the conftest's settings folder)."""
    body = {"v": v, "folders": folders}
    body.update(extra or {})
    with open(HP.hints_file(), "w") as f:
        json.dump(body, f)
    HP.forget()


def _name(folder, **over):
    _write_hints({markers.marker_id(str(folder)): _entry(**over)})


@pytest.fixture
def marked(tmp_path):
    folder = tmp_path / "Transfer"
    folder.mkdir()
    assert markers.write_marker(str(folder), "library")
    return folder


# ── the marker ───────────────────────────────────────────────────────────────

def test_a_marker_carries_an_id_that_survives_being_written_again(marked):
    first = markers.marker_id(str(marked))
    assert first and markers.MARKER_ID.match(first)
    assert markers.write_marker(str(marked), "library")
    assert markers.marker_id(str(marked)) == first
    # another role at the same folder is another folder as far as hints go
    assert markers.write_marker(str(marked), "staging")
    assert markers.marker_id(str(marked)) != first


def test_the_marker_names_nothing_about_the_computer(marked):
    """slskd may share the library's root, marker and all: it holds only what
    SYNCHRO.S needs to recognise the folder."""
    data = markers.read_marker(str(marked))
    assert set(data) == {"app", "role", "about", "created", "id"}
    assert "/" not in json.dumps({k: v for k, v in data.items() if k != "about"})


def test_the_watch_gives_an_old_marker_an_id(install):
    lib = install["roots"]["library"]
    with open(os.path.join(lib, markers.MARKER_NAME), "w") as f:
        json.dump({"app": "SYNCHRO.S", "role": "library", "about": "x", "created": 5}, f)
    assert markers.marker_id(lib) is None
    watch = markers.DriveWatch(config_getter=lambda: install["config"], database_getter=lambda: install["db"])
    state = watch.check_now()
    assert state["folders"]["library"]["connected"]
    data = markers.read_marker(lib)
    assert markers.MARKER_ID.match(data["id"]) and data["created"] == 5 and data["role"] == "library"


def test_a_marker_that_is_a_link_or_huge_has_no_id(tmp_path):
    folder = tmp_path / "f"
    folder.mkdir()
    real = tmp_path / "real.json"
    real.write_text(json.dumps({"id": "a" * 32}))
    os.symlink(real, folder / markers.MARKER_NAME)
    assert markers.marker_id(str(folder)) is None
    os.unlink(folder / markers.MARKER_NAME)
    (folder / markers.MARKER_NAME).write_text(json.dumps({"id": "a" * 32, "pad": "x" * 5000}))
    assert markers.marker_id(str(folder)) is None


# ── reading the hints file: untrusted data ───────────────────────────────────

def test_the_hints_file_lives_in_synchros_settings_folder(monkeypatch):
    monkeypatch.delenv(HP.HINTS_FILE_ENV)
    from core.settings import config_manager
    assert HP.hints_file() == str(config_manager.config_path.parent / "host-paths.json")


@pytest.mark.gauntlet
def test_the_hints_file_is_read_with_the_trust_rules(marked):
    """An entry names a folder only while it is keyed by that folder's marker
    id right now, in a file that is exactly the schema."""
    _name(marked)
    assert HP.read_hint(str(marked)) == {**_entry(), "marker_id": markers.marker_id(str(marked))}
    assert HP.folder_host(str(marked), "mac") == {"host_path": "/Users/ross/SoulSync/music",
                                                   "volume": "Macintosh HD", "source": "hint"}
    # one bad entry refuses the whole file
    _write_hints({markers.marker_id(str(marked)): _entry(), "0" * 32: _entry(host_path="relative")})
    assert HP.read_hint(str(marked)) is None
    # a link in place of the file is never followed
    real = os.path.join(os.path.dirname(HP.hints_file()), "elsewhere.json")
    with open(real, "w") as f:
        json.dump({"v": 1, "folders": {markers.marker_id(str(marked)): _entry()}}, f)
    os.unlink(HP.hints_file())
    os.symlink(real, HP.hints_file())
    HP.forget()
    assert HP.read_hint(str(marked)) is None
    # nor a folder of that name, nor a file over the cap
    os.unlink(HP.hints_file())
    os.mkdir(HP.hints_file())
    HP.forget()
    assert HP.read_hint(str(marked)) is None
    os.rmdir(HP.hints_file())
    _write_hints({markers.marker_id(str(marked)): _entry()}, extra={})
    with open(HP.hints_file(), "a") as f:
        f.write(" " * HP.HINTS_MAX_BYTES)
    HP.forget()
    assert HP.read_hint(str(marked)) is None


@pytest.mark.parametrize("over", [
    {"host_path": "Users/ross"}, {"host_path": "/Users/../etc"}, {"host_path": "/Users/ross\n/x"},
    {"host_path": "//server/share"}, {"host_path": "/x/\u202egnp.exe"}, {"host_path": "/" + "a" * 2000},
    {"host_path": ["/x"]}, {"volume": ""}, {"volume": "a/b"}, {"volume": "\x07bell"}, {"volume": None},
    {"os": "windows"}, {"written_at": True}, {"written_at": 0}, {"written_at": "1761300000"}, {"extra": "field"},
])
def test_an_entry_that_isnt_exactly_the_schema_is_ignored(marked, over):
    _name(marked, **over)
    assert HP.read_hint(str(marked)) is None


@pytest.mark.parametrize("raw", [b"", b"[]", b"null", b"{", b'{"v": 1}', b'{"v": 2, "folders": {}}',
                                 b'{"v": true, "folders": {}}', b'{"v": 1, "folders": []}',
                                 b'{"v": 1, "folders": {}, "x": 1}', b'{"v": 1, "folders": {"ABC": {}}}',
                                 b"\xff\xfe", b"[" * 5000 + b"]" * 5000])
def test_junk_is_ignored(marked, raw):
    with open(HP.hints_file(), "wb") as f:
        f.write(raw)
    HP.forget()
    assert HP.read_hint(str(marked)) is None


def test_too_many_folders_is_ignored(marked):
    folders = {f"{i:032x}": _entry() for i in range(HP.HINTS_MAX_FOLDERS)}
    folders[markers.marker_id(str(marked))] = _entry()
    _write_hints(folders)
    assert HP.read_hint(str(marked)) is None


@pytest.mark.gauntlet
def test_a_forged_or_mismatched_hint_is_ignored(marked, monkeypatch):
    """An entry for another marker (a folder SYNCHRO.S marked afresh, one
    copied from elsewhere, or one made up) never names the folder; neither
    does an older build's .synchros-host.json inside the folder."""
    _write_hints({"0" * 32: _entry(host_path="/Users/someone/else")})
    assert HP.read_hint(str(marked)) is None
    assert HP.folder_host(str(marked), "mac") is None
    assert HP.public_fields(str(marked), "mac") == {"host_path": None, "volume": None, "host_source": None}
    monkeypatch.setattr(markers, "folder_paths", lambda config=None: {"library": str(marked)})
    monkeypatch.setattr(HP, "current_platform", lambda config=None: "mac")
    assert HP.to_host(str(marked / "A" / "b.flac")) is None
    # an older build's hint beside the marker, even a well-formed one, is never read
    (marked / HP.LEGACY_HINT_NAME).write_text(json.dumps({
        "v": 1, "host_path": "/Users/x", "volume": "X", "os": "mac", "marker_id": markers.marker_id(str(marked)),
        "written_at": 1}))
    HP.forget()
    assert HP.read_hint(str(marked)) is None and HP.to_host(str(marked / "a.flac")) is None
    # a trusted entry stops counting once SYNCHRO.S marks the folder afresh
    _name(marked)
    assert HP.read_hint(str(marked)) is not None
    os.unlink(marked / markers.MARKER_NAME)
    assert markers.write_marker(str(marked), "library")
    HP.forget()
    assert HP.read_hint(str(marked)) is None


# ── to_host: the stable function for other features ──────────────────────────

@pytest.fixture
def mapped(marked, tmp_path, monkeypatch):
    dl = tmp_path / "downloads"
    dl.mkdir()
    monkeypatch.setattr(markers, "folder_paths", lambda config=None: {
        "library": str(marked), "downloads": str(dl), "staging": str(tmp_path / "nope")})
    monkeypatch.setattr(HP, "current_platform", lambda config=None: "mac")
    _name(marked)
    return marked


def test_to_host_maps_a_library_file(mapped):
    assert HP.to_host(str(mapped / "Saltmarsh" / "Lantern" / "01 Tide.flac")) == \
        "/Users/ross/SoulSync/music/Saltmarsh/Lantern/01 Tide.flac"
    assert HP.to_host(str(mapped)) == "/Users/ross/SoulSync/music"
    assert HP.to_host(str(mapped) + "/") == "/Users/ross/SoulSync/music"


@pytest.mark.parametrize("bad", ["relative/a.flac", "", None, 42, "/x/../etc/passwd", "/a\x00b"])
def test_to_host_refuses_odd_paths(mapped, bad):
    assert HP.to_host(bad) is None


def test_to_host_without_a_hint_or_outside_every_folder_is_none(mapped, tmp_path):
    assert HP.to_host(str(tmp_path / "downloads" / "a.flac")) is None
    assert HP.to_host(str(tmp_path / "Transfer-2" / "a.flac")) is None  # a prefix isn't a parent
    assert HP.to_host("/etc/hosts") is None


def test_the_drives_folder_is_the_same_path_inside_and_out(monkeypatch):
    monkeypatch.setattr(markers, "folder_paths", lambda config=None: {})
    monkeypatch.setattr(HP, "current_platform", lambda config=None: "mac")
    assert HP.to_host("/Volumes/Music HD/SYNCHRO.S/Library/a.flac") == "/Volumes/Music HD/SYNCHRO.S/Library/a.flac"
    assert HP.folder_host("/Volumes/Music HD/SYNCHRO.S/Library", "mac") == {
        "host_path": "/Volumes/Music HD/SYNCHRO.S/Library", "volume": "Music HD", "source": "same"}
    assert HP.folder_host("/drives/d/SYNCHRO.S/Library", "windows") == {
        "host_path": "D:\\SYNCHRO.S\\Library", "volume": "D:", "source": "same"}
    assert HP.folder_host("/Volumes", "mac") is None
    # with the drives folders overridden, nothing says they're mounted at the same path
    monkeypatch.setenv("SOULSYNC_DRIVES_ROOTS", "/Volumes")
    assert HP.to_host("/Volumes/Music HD/a.flac") is None


def test_to_host_reads_the_file_once_for_a_long_export(mapped, monkeypatch):
    calls = []
    real = HP.read_hints
    monkeypatch.setattr(HP, "read_hints", lambda path=None: calls.append(path) or real(path))
    for i in range(500):
        assert HP.to_host(str(mapped / f"{i}.flac")) == f"/Users/ross/SoulSync/music/{i}.flac"
    assert len(calls) == 1


# ── the helper writes the hints file ─────────────────────────────────────────

@pytest.fixture
def soulsync(tmp_path, monkeypatch):
    """~/SoulSync with Ross's compose file, its settings folder and the three
    music folders, marked; SYNCHRO.S reads the hints from that settings folder."""
    home = tmp_path / "SoulSync"
    home.mkdir()
    (home / "config").mkdir()
    with open(FIXTURE, "rb") as f:
        (home / "docker-compose.yml").write_bytes(f.read())
    ids = {}
    for name, role in (("music", "library"), ("downloads", "downloads"), ("staging", "staging")):
        (home / name).mkdir()
        markers.write_marker(str(home / name), role)
        ids[name] = markers.marker_id(str(home / name))
    monkeypatch.setenv(HP.HINTS_FILE_ENV, str(home / "config" / HP.HINTS_NAME))
    HP.forget()
    return {"home": home, "ids": ids, "tmp": tmp_path, "file": home / "config" / HP.HINTS_NAME}


def _music_files(home):
    return sorted(p for name in ("music", "downloads", "staging") for p in os.listdir(home / name))


def test_the_helper_names_rosss_three_folders_in_the_settings_folder(soulsync):
    home = soulsync["home"]
    text = (home / "docker-compose.yml").read_text()
    assert [(m["target"], m["host_path"]) for m in C.music_mounts(text, str(home))] == [
        ("/app/Transfer", str(home / "music")), ("/app/downloads", str(home / "downloads")),
        ("/app/Staging", str(home / "staging"))]
    assert C.config_folder(text, str(home)) == str(home / "config")
    out = C.write_host_hints(text, str(home), "mac", clock=lambda: 1761300000)
    assert [r["ok"] for r in out] == ["1", "1", "1"]
    data = json.loads(soulsync["file"].read_text())
    assert data == {"v": 1, "folders": {
        soulsync["ids"][name]: {"host_path": str(home / name), "volume": "Macintosh HD", "os": "mac",
                                "written_at": 1761300000} for name in ("music", "downloads", "staging")}}
    assert oct(os.stat(soulsync["file"]).st_mode & 0o777) == "0o644"
    for name in ("music", "downloads", "staging"):
        # and SYNCHRO.S trusts what the helper wrote
        assert HP.read_hint(str(home / name))["host_path"] == str(home / name)
    assert not [p for p in os.listdir(home / "config") if p.endswith(".tmp")]


@pytest.mark.gauntlet
def test_no_host_hint_is_ever_written_inside_a_music_folder(soulsync):
    """slskd shares the library's root: the computer's paths stay in
    SYNCHRO.S's settings folder, and an older helper's .synchros-host.json
    (a file or a link) is deleted, never what a link points at."""
    home = soulsync["home"]
    target = soulsync["tmp"] / "keep.txt"
    target.write_text("keep me")
    (home / "music" / HP.LEGACY_HINT_NAME).write_text("{}")
    os.symlink(target, home / "downloads" / HP.LEGACY_HINT_NAME)
    (home / "staging" / HP.LEGACY_HINT_NAME).mkdir()  # not a file: left alone
    before = {n: sorted(os.listdir(home / n)) for n in ("music", "downloads", "staging")}
    out = C.write_host_hints((home / "docker-compose.yml").read_text(), str(home), "mac")
    assert [r["ok"] for r in out] == ["1", "1", "1"]
    assert sorted(os.listdir(home / "music")) == [markers.MARKER_NAME]
    assert sorted(os.listdir(home / "downloads")) == [markers.MARKER_NAME]
    assert sorted(os.listdir(home / "staging")) == before["staging"]
    assert target.read_text() == "keep me"
    # a second run adds nothing to the music folders either
    C.write_host_hints((home / "docker-compose.yml").read_text(), str(home), "mac")
    assert _music_files(home) == sorted([markers.MARKER_NAME] * 3 + [HP.LEGACY_HINT_NAME])


def test_entries_for_other_folders_are_kept_and_replaced_when_named_again(soulsync):
    home = soulsync["home"]
    soulsync["file"].write_text(json.dumps({"v": 1, "folders": {
        "f" * 32: _entry(host_path="/Users/ross/Old", written_at=5),
        soulsync["ids"]["music"]: _entry(host_path="/Users/ross/stale", written_at=5)}}))
    C.write_host_hints((home / "docker-compose.yml").read_text(), str(home), "mac", clock=lambda: 9)
    folders = json.loads(soulsync["file"].read_text())["folders"]
    assert folders["f" * 32]["host_path"] == "/Users/ross/Old"
    assert folders[soulsync["ids"]["music"]] == _entry(host_path=str(home / "music"), written_at=9)


def test_without_a_settings_folder_mount_nothing_is_written_and_it_says_so(soulsync):
    home = soulsync["home"]
    text = (home / "docker-compose.yml").read_text().replace("      - ./config:/app/config\n", "")
    out = C.write_host_hints(text, str(home), "mac")
    assert out[-1] == {"label": "SYNCHRO.S's settings folder", "ok": "",
                       "words": "there's no bind mount for SYNCHRO.S's settings folder (/app/config) in the file"}
    assert not any(r["ok"] for r in out)
    assert not soulsync["file"].exists()


def test_a_linked_settings_folder_is_left_alone(soulsync):
    home = soulsync["home"]
    real = soulsync["tmp"] / "real-config"
    real.mkdir()
    os.rmdir(home / "config")
    os.symlink(real, home / "config")
    out = C.write_host_hints((home / "docker-compose.yml").read_text(), str(home), "mac")
    assert "is a link" in out[-1]["words"] and not os.listdir(real)


def test_a_folder_synchros_hasnt_marked_is_skipped_and_said(soulsync):
    home = soulsync["home"]
    os.unlink(home / "staging" / markers.MARKER_NAME)
    out = C.write_host_hints((home / "docker-compose.yml").read_text(), str(home), "mac")
    assert out[2]["ok"] == "" and "hasn't marked" in out[2]["words"]
    assert len(json.loads(soulsync["file"].read_text())["folders"]) == 2


def test_a_named_volume_or_a_variable_isnt_named(tmp_path):
    text = ("services:\n  soulsync:\n    image: soulsync\n    volumes:\n      - music:/app/Transfer\n"
            "      - ${MUSIC}/dl:/app/downloads\n")
    out = C.write_host_hints(text, str(tmp_path), "linux")
    assert [r["ok"] for r in out] == ["", ""]


def test_a_linked_music_folder_is_left_alone(soulsync):
    home = soulsync["home"]
    real = soulsync["tmp"] / "real-music"
    real.mkdir()
    os.rename(home / "music", soulsync["tmp"] / "old")
    os.symlink(real, home / "music")
    out = C.write_host_hints((home / "docker-compose.yml").read_text(), str(home), "mac")
    assert "is a link" in out[0]["words"] and not os.listdir(real)


def test_volume_names(monkeypatch):
    assert C.volume_name("/Volumes/Music HD/SoulSync", "mac") == "Music HD"
    monkeypatch.setattr(C.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(
        a, 0, stdout=b'<?xml version="1.0"?><plist version="1.0"><dict><key>VolumeName</key>'
                     b'<string>Macintosh HD - Data</string></dict></plist>'))
    assert C.volume_name("/Users/ross/SoulSync/music", "mac") == "Macintosh HD"
    assert C.volume_name("/", "linux") == "this computer's disk"


@pytest.mark.gauntlet
def test_a_link_planted_at_the_hints_temp_path_is_not_followed(soulsync, monkeypatch):
    """Someone who can write in the settings folder plants links where the
    hints file's temporary file and the file itself would go; the helper
    writes through neither."""
    home = soulsync["home"]
    config = home / "config"
    victim = soulsync["tmp"] / "victim.txt"
    victim.write_text("keep me")
    names = itertools.chain(["planted1"], (f"fresh{i}" for i in itertools.count()))
    monkeypatch.setattr(tempfile, "_get_candidate_names", lambda: names)
    planted = config / f"{HP.HINTS_NAME}.planted1.tmp"
    os.symlink(victim, planted)
    os.symlink(victim, soulsync["file"])
    out = C.write_host_hints((home / "docker-compose.yml").read_text(), str(home), "mac")
    assert [r["ok"] for r in out] == ["1", "1", "1"]
    assert victim.read_text() == "keep me"
    assert os.path.islink(planted) and os.readlink(planted) == str(victim)
    # the file replaced the link with a regular file of its own
    assert not os.path.islink(soulsync["file"])
    assert set(json.loads(soulsync["file"].read_text())["folders"]) == set(soulsync["ids"].values())


# ── the script: --names only writes the hints ────────────────────────────────

@pytest.fixture
def script_home(soulsync):
    home = soulsync["home"]
    (home / H.SCRIPT_NAME).write_text(H.script())
    shim = soulsync["tmp"] / "bin"
    shim.mkdir()
    (shim / "docker").write_text('#!/bin/sh\necho "docker $*" >> "$SHIM_LOG"\nexit 0\n')
    (shim / "docker").chmod(0o755)
    log = soulsync["tmp"] / "docker.log"
    env = {**os.environ, "PATH": f"{shim}:{os.environ['PATH']}", "SHIM_LOG": str(log)}
    return {**soulsync, "env": env, "log": log}


def _sh(ctx, *args, stdin=""):
    return subprocess.run(["sh", H.SCRIPT_NAME, "--platform", "mac", *args], cwd=ctx["home"], env=ctx["env"],
                          input=stdin, capture_output=True, text=True, timeout=60)


def test_names_writes_the_hints_and_changes_nothing_else(script_home):
    home = script_home["home"]
    before = (home / "docker-compose.yml").read_bytes()
    r = _sh(script_home, "--names")
    assert r.returncode == 0, r.stdout + r.stderr
    assert f"Library: {home / 'music'} (on Macintosh HD)" in r.stdout
    assert "Done. SYNCHRO.S shows these names within a minute." in r.stdout
    assert (home / "docker-compose.yml").read_bytes() == before
    assert not (home / C.BACKUP_NAME).exists()
    calls = script_home["log"].read_text().splitlines() if script_home["log"].exists() else []
    assert not any("up -d" in c or "config" in c for c in calls)
    for name in ("music", "downloads", "staging"):
        assert HP.read_hint(str(home / name))["host_path"] == str(home / name)
    assert _music_files(home) == [markers.MARKER_NAME] * 3


def test_names_dry_run_writes_nothing(script_home):
    r = _sh(script_home, "--names", "--dry-run")
    assert r.returncode == 0 and "would name" in r.stdout
    assert f"in {script_home['file']}" in r.stdout
    assert not script_home["file"].exists()


def test_the_normal_run_writes_the_hints_too(script_home):
    r = _sh(script_home, stdin="y\n")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Your folders' names on this computer" in r.stdout
    assert HP.read_hint(str(script_home["home"] / "music"))["volume"] == "Macintosh HD"
    assert _music_files(script_home["home"]) == [markers.MARKER_NAME] * 3


def test_the_command_can_ask_for_names_only():
    cmd = H.command("http://192.168.1.20:8008", "TOKEN", "~/SoulSync", names=True)
    assert cmd.endswith("&& sh drives-helper.sh --names")
    assert not H.command("http://h", "T", "~/SoulSync").endswith("--names")


def test_an_older_builds_hint_is_never_copied_by_a_move():
    from core.drives import move as M
    assert HP.LEGACY_HINT_NAME in M.SKIP_NAMES
