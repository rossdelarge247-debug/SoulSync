"""The computer's own names for the music folders (Design's 125, Dev's 160):
the drives helper writes ``.synchros-host.json`` beside each folder's marker
(core/drives/compose_tool.py), and SYNCHRO.S reads it as untrusted display
text (core/drives/host_paths.py), trusting it only while its marker id
matches. The helper runs against a copy of Ross's Mac compose file."""

from __future__ import annotations

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


@pytest.fixture(autouse=True)
def _fresh_cache():
    HP.forget()
    yield
    HP.forget()


def _hint(folder, *, marker_id=None, **over):
    body = {"v": 1, "host_path": "/Users/ross/SoulSync/music", "volume": "Macintosh HD", "os": "mac",
            "marker_id": marker_id or markers.marker_id(str(folder)), "written_at": 1761300000}
    body.update(over)
    (folder / HP.HINT_NAME).write_text(json.dumps(body))
    return body


@pytest.fixture
def marked(tmp_path):
    folder = tmp_path / "Transfer"
    folder.mkdir()
    assert markers.write_marker(str(folder), "library")
    return folder


# ── the marker's id ──────────────────────────────────────────────────────────

def test_a_marker_carries_an_id_that_survives_being_written_again(marked):
    first = markers.marker_id(str(marked))
    assert first and markers.MARKER_ID.match(first)
    assert markers.write_marker(str(marked), "library")
    assert markers.marker_id(str(marked)) == first
    # another role at the same folder is another folder as far as hints go
    assert markers.write_marker(str(marked), "staging")
    assert markers.marker_id(str(marked)) != first


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


# ── reading a hint: untrusted data ───────────────────────────────────────────

def test_a_hint_for_this_marker_is_read(marked):
    _hint(marked)
    assert HP.read_hint(str(marked)) == {"host_path": "/Users/ross/SoulSync/music", "volume": "Macintosh HD",
                                         "os": "mac", "marker_id": markers.marker_id(str(marked)),
                                         "written_at": 1761300000}


@pytest.mark.parametrize("over", [
    {"v": 2}, {"v": True}, {"v": "1"},
    {"host_path": "Users/ross"}, {"host_path": "/Users/../etc"}, {"host_path": "/Users/ross\n/x"},
    {"host_path": "//server/share"}, {"host_path": "/x/\u202egnp.exe"}, {"host_path": "/" + "a" * 2000},
    {"host_path": ["/x"]}, {"volume": ""}, {"volume": "a/b"}, {"volume": "\x07bell"}, {"volume": None},
    {"os": "windows"}, {"marker_id": "A" * 32}, {"marker_id": "abc"}, {"written_at": True},
    {"written_at": 0}, {"written_at": "1761300000"}, {"extra": "field"},
])
def test_a_hint_that_isnt_exactly_the_schema_is_ignored(marked, over):
    _hint(marked, **over)
    assert HP.read_hint(str(marked)) is None


@pytest.mark.parametrize("raw", [b"", b"[]", b"null", b"{", "{\"v\": 1}".encode(), b"\xff\xfe",
                                 b"[" * 5000 + b"]" * 5000])
def test_junk_is_ignored(marked, raw):
    (marked / HP.HINT_NAME).write_bytes(raw)
    assert HP.read_hint(str(marked)) is None


def test_a_hint_over_the_size_cap_is_ignored(marked):
    body = _hint(marked)
    (marked / HP.HINT_NAME).write_text(json.dumps(body) + " " * HP.HINT_MAX_BYTES)
    assert HP.read_hint(str(marked)) is None


def test_a_hint_that_is_a_link_or_a_folder_is_ignored(marked, tmp_path):
    elsewhere = tmp_path / "elsewhere.json"
    elsewhere.write_text(json.dumps({"v": 1, "host_path": "/x", "volume": "X", "os": "mac",
                                     "marker_id": markers.marker_id(str(marked)), "written_at": 1}))
    os.symlink(elsewhere, marked / HP.HINT_NAME)
    assert HP.read_hint(str(marked)) is None
    os.unlink(marked / HP.HINT_NAME)
    (marked / HP.HINT_NAME).mkdir()
    assert HP.read_hint(str(marked)) is None


@pytest.mark.gauntlet
def test_a_forged_or_mismatched_hint_is_ignored(marked, tmp_path, monkeypatch):
    """A hint written for another marker (a folder SYNCHRO.S marked afresh, a
    hint copied from elsewhere, or one made up) never names the folder."""
    _hint(marked, marker_id="0" * 32, host_path="/Users/someone/else")
    assert HP.read_hint(str(marked)) is None
    assert HP.folder_host(str(marked), "mac") is None
    assert HP.public_fields(str(marked), "mac") == {"host_path": None, "volume": None, "host_source": None}
    monkeypatch.setattr(markers, "folder_paths", lambda config=None: {"library": str(marked)})
    monkeypatch.setattr(HP, "current_platform", lambda config=None: "mac")
    assert HP.to_host(str(marked / "A" / "b.flac")) is None
    # no marker at all: no hint is trusted either
    os.unlink(marked / markers.MARKER_NAME)
    _hint(marked, marker_id="0" * 32)
    HP.forget()
    assert HP.read_hint(str(marked)) is None
    # SYNCHRO.S marks the folder afresh: the old hint stops counting
    assert markers.write_marker(str(marked), "library")
    assert HP.read_hint(str(marked)) is None


# ── to_host: the stable function for other features ──────────────────────────

@pytest.fixture
def mapped(marked, tmp_path, monkeypatch):
    dl = tmp_path / "downloads"
    dl.mkdir()
    monkeypatch.setattr(markers, "folder_paths", lambda config=None: {
        "library": str(marked), "downloads": str(dl), "staging": str(tmp_path / "nope")})
    monkeypatch.setattr(HP, "current_platform", lambda config=None: "mac")
    _hint(marked)
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


def test_to_host_reads_each_folder_once_for_a_long_export(mapped, monkeypatch):
    calls = []
    real = HP.read_hint
    monkeypatch.setattr(HP, "read_hint", lambda folder: calls.append(folder) or real(folder))
    for i in range(500):
        assert HP.to_host(str(mapped / f"{i}.flac")) == f"/Users/ross/SoulSync/music/{i}.flac"
    assert len(calls) == 1


# ── the helper writes the hints ──────────────────────────────────────────────

@pytest.fixture
def soulsync(tmp_path):
    """~/SoulSync with Ross's compose file and the three folders, marked."""
    home = tmp_path / "SoulSync"
    home.mkdir()
    with open(FIXTURE, "rb") as f:
        (home / "docker-compose.yml").write_bytes(f.read())
    ids = {}
    for name, role in (("music", "library"), ("downloads", "downloads"), ("staging", "staging")):
        (home / name).mkdir()
        markers.write_marker(str(home / name), role)
        ids[name] = markers.marker_id(str(home / name))
    return {"home": home, "ids": ids, "tmp": tmp_path}


def test_the_helper_names_rosss_three_folders(soulsync):
    home = soulsync["home"]
    text = (home / "docker-compose.yml").read_text()
    mounts = C.music_mounts(text, str(home))
    assert [(m["target"], m["host_path"]) for m in mounts] == [
        ("/app/Transfer", str(home / "music")), ("/app/downloads", str(home / "downloads")),
        ("/app/Staging", str(home / "staging"))]
    out = C.write_host_hints(text, str(home), "mac", clock=lambda: 1761300000)
    assert [r["ok"] for r in out] == ["1", "1", "1"]
    for name in ("music", "downloads", "staging"):
        data = json.loads((home / name / HP.HINT_NAME).read_text())
        assert data == {"v": 1, "host_path": str(home / name), "volume": "Macintosh HD", "os": "mac",
                        "marker_id": soulsync["ids"][name], "written_at": 1761300000}
        assert oct(os.stat(home / name / HP.HINT_NAME).st_mode & 0o777) == "0o644"
        # and SYNCHRO.S trusts what the helper wrote
        assert HP.read_hint(str(home / name))["host_path"] == str(home / name)
    assert not [p for p in os.listdir(home / "music") if p.endswith(".tmp")]


def test_a_folder_synchros_hasnt_marked_is_skipped_and_said(soulsync):
    home = soulsync["home"]
    os.unlink(home / "staging" / markers.MARKER_NAME)
    out = C.write_host_hints((home / "docker-compose.yml").read_text(), str(home), "mac")
    assert out[2]["ok"] == "" and "hasn't marked" in out[2]["words"]
    assert not (home / "staging" / HP.HINT_NAME).exists()


def test_a_named_volume_or_a_variable_isnt_named(tmp_path):
    text = ("services:\n  soulsync:\n    image: soulsync\n    volumes:\n      - music:/app/Transfer\n"
            "      - ${MUSIC}/dl:/app/downloads\n")
    out = C.write_host_hints(text, str(tmp_path), "linux")
    assert [r["ok"] for r in out] == ["", ""]


def test_a_linked_folder_is_left_alone(soulsync):
    home = soulsync["home"]
    real = soulsync["tmp"] / "real-music"
    real.mkdir()
    os.rename(home / "music", soulsync["tmp"] / "old")
    os.symlink(real, home / "music")
    out = C.write_host_hints((home / "docker-compose.yml").read_text(), str(home), "mac")
    assert "is a link" in out[0]["words"] and not (real / HP.HINT_NAME).exists()


def test_volume_names(monkeypatch):
    assert C.volume_name("/Volumes/Music HD/SoulSync", "mac") == "Music HD"
    monkeypatch.setattr(C.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(
        a, 0, stdout=b'<?xml version="1.0"?><plist version="1.0"><dict><key>VolumeName</key>'
                     b'<string>Macintosh HD - Data</string></dict></plist>'))
    assert C.volume_name("/Users/ross/SoulSync/music", "mac") == "Macintosh HD"
    assert C.volume_name("/", "linux") == "this computer's disk"


@pytest.mark.gauntlet
def test_a_link_planted_at_the_hints_temp_path_is_not_followed(soulsync, monkeypatch):
    """Someone who can write in the music folder plants links where the hint's
    temporary file and the hint itself would go; the helper writes neither
    through them."""
    home = soulsync["home"]
    folder = home / "music"
    victim = soulsync["tmp"] / "victim.txt"
    victim.write_text("keep me")
    import itertools
    names = itertools.chain(["planted1"], (f"fresh{i}" for i in itertools.count()))
    monkeypatch.setattr(tempfile, "_get_candidate_names", lambda: names)
    planted = folder / f"{HP.HINT_NAME}.planted1.tmp"
    os.symlink(victim, planted)
    os.symlink(victim, folder / HP.HINT_NAME)
    out = C.write_host_hints((home / "docker-compose.yml").read_text(), str(home), "mac")
    assert out[0]["ok"] == "1"
    assert victim.read_text() == "keep me"
    assert os.path.islink(planted) and os.readlink(planted) == str(victim)
    # the hint replaced the link with a regular file of its own
    assert not os.path.islink(folder / HP.HINT_NAME)
    assert json.loads((folder / HP.HINT_NAME).read_text())["marker_id"] == soulsync["ids"]["music"]


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


def test_names_dry_run_writes_nothing(script_home):
    r = _sh(script_home, "--names", "--dry-run")
    assert r.returncode == 0 and "would name" in r.stdout
    assert not (script_home["home"] / "music" / HP.HINT_NAME).exists()


def test_the_normal_run_writes_the_hints_too(script_home):
    r = _sh(script_home, stdin="y\n")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Your folders' names on this computer" in r.stdout
    assert HP.read_hint(str(script_home["home"] / "music"))["volume"] == "Macintosh HD"


def test_the_command_can_ask_for_names_only():
    cmd = H.command("http://192.168.1.20:8008", "TOKEN", "~/SoulSync", names=True)
    assert cmd.endswith("&& sh drives-helper.sh --names")
    assert not H.command("http://h", "T", "~/SoulSync").endswith("--names")


def test_the_hint_is_never_copied_by_a_move():
    from core.drives import move as M
    assert HP.HINT_NAME in M.SKIP_NAMES
