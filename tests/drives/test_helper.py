"""The Docker step's helper (core/drives/compose_tool.py, core/drives/helper.py)
against a real copy of Ross's Mac compose file in a temp folder: dry run,
apply, the backup, the YAML still parsing with every key and value (and the
comments), and undo putting the original back byte for byte. There's no
Docker daemon here, so ``docker`` is a shim on PATH that logs its calls and
hands ``docker compose config`` to the real binary when there is one."""

from __future__ import annotations

import os
import shutil
import subprocess
import time

import pytest
import yaml

from core.drives import compose_tool as C
from core.drives import helper as H

FIXTURE = os.path.join(os.path.dirname(__file__), "fixtures", "ross-mac-compose.yml")
REAL_DOCKER = shutil.which("docker")


def _ross():
    with open(FIXTURE, "rb") as f:
        return f.read()


@pytest.fixture
def folder(tmp_path):
    """~/SoulSync with Ross's compose file, the helper saved as curl saves it,
    and a docker shim first on PATH."""
    home = tmp_path / "SoulSync"
    home.mkdir()
    (home / "docker-compose.yml").write_bytes(_ross())
    (home / H.SCRIPT_NAME).write_text(H.script())
    shim = tmp_path / "bin"
    shim.mkdir()
    real = "exec %s \"$@\"" % REAL_DOCKER if REAL_DOCKER else "exit 0"
    (shim / "docker").write_text(
        "#!/bin/sh\n"
        'echo "docker $*" >> "$SHIM_LOG"\n'
        'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then echo "Docker Compose version shim"; exit 0; fi\n'
        'case " $* " in *" config "*) ' + real + ';; esac\n'
        "exit 0\n")
    (shim / "docker").chmod(0o755)
    log = tmp_path / "docker.log"
    env = {**os.environ, "PATH": f"{shim}:{os.environ['PATH']}", "SHIM_LOG": str(log)}
    return {"home": home, "env": env, "log": log, "tmp": tmp_path}


def _run(folder, *args, stdin=""):
    return subprocess.run(["sh", H.SCRIPT_NAME, "--platform", "mac", *args], cwd=folder["home"], env=folder["env"],
                          input=stdin, capture_output=True, text=True, timeout=60)


def _calls(folder):
    return folder["log"].read_text().splitlines() if folder["log"].exists() else []


def _flatten(node, prefix=""):
    """Every (path, value) leaf of a YAML document."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield from _flatten(v, f"{prefix}/{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _flatten(v, f"{prefix}[{i}]")
    else:
        yield prefix, node


# ── the plan, on Ross's file ─────────────────────────────────────────────────

def test_it_finds_the_services_that_mount_the_music_folders():
    plan = C.plan(_ross().decode(), "mac")
    assert plan["app"] == "soulsync"
    by = {c["service"]: c for c in plan["changes"]}
    assert set(by) == {"soulsync", "slskd"}
    assert by["soulsync"]["add"] == ["/Volumes:/Volumes", "./slskd:/slskd-config"]
    assert by["slskd"]["add"] == ["/Volumes:/Volumes"]
    # no Plex service in this compose file: said, not an error
    assert "plex" in plan["missing_media"] and plan["slskd_config"] == "./slskd"


def test_applying_only_adds_lines_and_keeps_everything_else():
    before = _ross().decode()
    after = C.apply(before, C.plan(before, "mac"))
    old, new = yaml.safe_load(before), yaml.safe_load(after)
    # every key and value that was there is still there
    new_leaves = dict(_flatten(new))
    for path, value in _flatten(old):
        if "/volumes[" in path:
            continue
        assert new_leaves[path] == value, path
    assert new["services"]["soulsync"]["volumes"] == old["services"]["soulsync"]["volumes"] + [
        "/Volumes:/Volumes", "./slskd:/slskd-config"]
    assert new["services"]["slskd"]["volumes"] == old["services"]["slskd"]["volumes"] + ["/Volumes:/Volumes"]
    assert new["volumes"] == old["volumes"]
    # every line of the original survives in order, comments included
    kept = [line for line in after.splitlines() if line in before.splitlines()]
    assert kept == before.splitlines()
    assert "# your music, downloads and the import folder" in after
    added = [line for line in C.diff_lines(before, after) if line.startswith("+ ")]
    assert added == ["+       - /Volumes:/Volumes", "+       - ./slskd:/slskd-config", "+       - /Volumes:/Volumes"]


def test_running_it_twice_changes_nothing_the_second_time():
    once = C.apply(_ross().decode(), C.plan(_ross().decode(), "mac"))
    plan = C.plan(once, "mac")
    assert plan["nothing_to_do"]
    assert C.apply(once, plan) == once


def test_linux_adds_mnt_and_media():
    text = _ross().decode()
    after = C.apply(text, C.plan(text, "linux"))
    vols = yaml.safe_load(after)["services"]["slskd"]["volumes"]
    assert vols[-2:] == ["/mnt:/mnt", "/media:/media"]


def test_a_media_server_in_the_file_gets_the_line_too():
    text = _ross().decode() + ""
    text = text.replace("volumes:\n  soulsync_data:", "  plex:\n    image: plexinc/pms-docker\n    volumes:\n"
                        "      - ./music:/data/music\n\nvolumes:\n  soulsync_data:")
    plan = C.plan(text, "mac")
    assert {c["service"] for c in plan["changes"]} == {"soulsync", "slskd", "plex"}
    assert yaml.safe_load(C.apply(text, plan))["services"]["plex"]["volumes"][-1] == "/Volumes:/Volumes"


def test_a_service_without_volumes_gains_the_key():
    text = ("services:\n  soulsync:\n    image: x/soulsync\n    volumes:\n      - ./music:/app/Transfer\n"
            "  plex:\n    image: plexinc/pms-docker\n    network_mode: host\n")
    out = C.apply(text, C.plan(text, "mac"))
    assert yaml.safe_load(out)["services"]["plex"] == {"image": "plexinc/pms-docker", "network_mode": "host",
                                                       "volumes": ["/Volumes:/Volumes"]}


def test_long_syntax_volumes_are_read():
    text = ("services:\n  app:\n    image: soulsync\n    volumes:\n      - type: bind\n        source: ./music\n"
            "        target: /app/Transfer\n  slskd:\n    image: slskd/slskd\n    volumes:\n      - type: bind\n"
            "        source: ./slskd\n        target: /app\n")
    plan = C.plan(text, "mac")
    out = yaml.safe_load(C.apply(text, plan))
    assert out["services"]["app"]["volumes"][-1] == "./slskd:/slskd-config"
    assert out["services"]["slskd"]["volumes"][-1] == "/Volumes:/Volumes"


@pytest.mark.parametrize("text,words", [
    ("services:\n  app:\n    image: soulsync\n    volumes: [./music:/app/Transfer]\n", "on one line"),
    ("x: &d\n  image: soulsync\nservices:\n  app:\n    <<: *d\n    environment:\n      - A=1\n"
     "  other:\n    image: soulsync\n    volumes:\n      - ./music:/app/Transfer\n", None),
    ("services:\n\tapp:\n", "tabs"),
    ("version: '3'\n", "no “services:”"),
])
def test_shapes_it_wont_edit_are_refused(text, words):
    if words is None:
        # the merge-key service shares no music folder and isn't a known role: left alone
        plan = C.plan(text, "mac")
        assert [c["service"] for c in plan["changes"]] == ["other"]
        return
    with pytest.raises(C.Unsupported, match=words):
        C.apply(text, C.plan(text, "mac"))


def test_a_merge_key_service_that_needs_the_line_is_refused():
    text = ("x-base: &base\n  volumes:\n    - ./music:/music\nservices:\n  app:\n    image: soulsync\n"
            "    volumes:\n      - ./music:/app/Transfer\n  slskd:\n    image: slskd/slskd\n    <<: *base\n")
    with pytest.raises(C.Unsupported, match="merge"):
        C.apply(text, C.plan(text, "mac"))


def test_crlf_files_keep_their_line_endings():
    text = _ross().decode().replace("\n", "\r\n")
    out = C.apply(text, C.plan(text, "mac"))
    assert "\n" not in out.replace("\r\n", "")
    assert yaml.safe_load(out)["services"]["slskd"]["volumes"][-1] == "/Volumes:/Volumes"


# ── the slskd.yml edits share the editor ─────────────────────────────────────

SLSKD_YML = """# debug: false
directories:
  incomplete: /app/incomplete   # where partial files go
shares:
  directories:
    - /music
  filters:
    - \\.ini$
soulseek:
  username: ross
"""


def test_slskd_shares_downloads_and_filter_are_set_keeping_comments():
    from core.drives.services import plan_slskd_config
    change = plan_slskd_config(SLSKD_YML, share_old="/music", share_new="/Volumes/Music HD/SYNCHRO.S/Library",
                               current_shares=["/music"], downloads_new="/Volumes/Music HD/SYNCHRO.S/Downloads",
                               skip_appledouble=True)
    out = change["text"]
    data = yaml.safe_load(out)
    assert data["shares"]["directories"] == ["/Volumes/Music HD/SYNCHRO.S/Library"]
    assert data["shares"]["filters"] == ["\\.ini$", "/\\._[^/]*$", "/\\.synchros-[^/]*$"]
    assert data["directories"] == {"incomplete": "/app/incomplete", "downloads": "/Volumes/Music HD/SYNCHRO.S/Downloads"}
    assert data["soulseek"] == {"username": "ross"}
    assert "# where partial files go" in out and out.startswith("# debug: false")
    assert change["changed"] == ["shares", "filters", "synchros_filter", "downloads"]


def test_slskd_yml_without_shares_gains_them():
    from core.drives.services import plan_slskd_config
    out = plan_slskd_config("# all commented out\n# shares:\n#   directories: []\n", share_old="/music",
                            share_new="/Volumes/X/Library", current_shares=["/music"], downloads_new=None,
                            skip_appledouble=False)["text"]
    assert yaml.safe_load(out) == {"shares": {"directories": ["/Volumes/X/Library"],
                                              "filters": ["/\\.synchros-[^/]*$"]}}
    assert out.startswith("# all commented out")


def test_scalars_keep_their_comment_and_new_keys_land_in_their_block():
    out = C.set_scalar(SLSKD_YML, ["directories", "incomplete"], "/Volumes/X/incomplete")
    assert "  incomplete: /Volumes/X/incomplete  # where partial files go" in out
    assert yaml.safe_load(out)["directories"]["incomplete"] == "/Volumes/X/incomplete"
    assert C.scalar("D:\\:/drives/d") == "'D:\\:/drives/d'"
    assert C.scalar("/Volumes:/Volumes") == "/Volumes:/Volumes"


# ── the script, end to end with a docker shim ────────────────────────────────

def test_the_dry_run_shows_the_lines_and_changes_nothing(folder):
    r = _run(folder, "--dry-run")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "soulsync:  + - /Volumes:/Volumes" in r.stdout and "slskd:  + - /Volumes:/Volumes" in r.stdout
    assert "Plex isn't in this file" in r.stdout
    assert (folder["home"] / "docker-compose.yml").read_bytes() == _ross()
    assert not (folder["home"] / C.BACKUP_NAME).exists()
    assert not any("up -d" in c for c in _calls(folder))


def test_no_means_nothing_changes(folder):
    r = _run(folder, stdin="n\n")
    assert "Go ahead? (y/n)" in r.stdout and "Nothing changed." in r.stdout
    assert (folder["home"] / "docker-compose.yml").read_bytes() == _ross()
    assert not any("up -d" in c for c in _calls(folder))


def test_yes_keeps_a_copy_edits_validates_restarts_and_says_done(folder):
    r = _run(folder, stdin="y\n")
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.rstrip().endswith("Done. Go back to SYNCHRO.S.")
    home = folder["home"]
    assert (home / C.BACKUP_NAME).read_bytes() == _ross()
    new = (home / "docker-compose.yml").read_text()
    data = yaml.safe_load(new)
    assert data["services"]["soulsync"]["volumes"][-2:] == ["/Volumes:/Volumes", "./slskd:/slskd-config"]
    assert data["services"]["slskd"]["volumes"][-1] == "/Volumes:/Volumes"
    assert "# Keep this file in ~/SoulSync" in new
    calls = _calls(folder)
    assert any(c.startswith("docker compose -f .docker-compose.drives-new.") and c.endswith(".yml config -q")
               for c in calls)
    # no -f: Docker reads its own set of files (an override, COMPOSE_FILE)
    assert calls[-1] == "docker compose up -d"
    assert not [p for p in os.listdir(home) if p.startswith(".docker-compose.drives-new")]
    if REAL_DOCKER:
        # docker compose itself reads the changed file
        out = subprocess.run([REAL_DOCKER, "compose", "-f", "docker-compose.yml", "config", "--format", "json"],
                             cwd=home, capture_output=True, text=True)
        assert out.returncode == 0, out.stderr


def test_undo_puts_the_original_back_byte_for_byte(folder):
    assert _run(folder, stdin="y\n").returncode == 0
    r = _run(folder, "--undo", stdin="y\n")
    assert r.returncode == 0, r.stdout + r.stderr
    assert (folder["home"] / "docker-compose.yml").read_bytes() == _ross()
    assert not (folder["home"] / C.BACKUP_NAME).exists()
    assert "back as it was" in r.stdout
    assert _calls(folder)[-1] == "docker compose up -d"


def test_undo_without_a_copy_says_so(folder):
    r = _run(folder, "--undo", "--yes")
    assert r.returncode == 4 and "nothing to put back" in r.stdout


def test_a_second_run_keeps_the_first_copy(folder):
    assert _run(folder, stdin="y\n").returncode == 0
    r = _run(folder, stdin="y\n")
    assert "already lets SYNCHRO.S see your drives" in r.stdout
    assert (folder["home"] / C.BACKUP_NAME).read_bytes() == _ross()


def test_the_wrong_folder_says_where_to_go(folder, tmp_path):
    (folder["home"] / "docker-compose.yml").unlink()
    r = _run(folder, "--yes")
    assert r.returncode == 2 and "There's no docker-compose.yml" in r.stdout


def test_without_python_it_says_how_to_get_it(folder, tmp_path):
    bare = tmp_path / "bare"
    bare.mkdir()
    for tool in ("sh", "cat", "mktemp", "rm", "uname"):
        found = shutil.which(tool)
        if found:
            os.symlink(found, bare / tool)
    os.symlink(folder["tmp"] / "bin" / "docker", bare / "docker")
    env = {**folder["env"], "PATH": str(bare)}
    r = subprocess.run([str(bare / "sh"), H.SCRIPT_NAME], cwd=folder["home"], env=env, capture_output=True, text=True)
    assert r.returncode == 10
    assert "needs python3" in r.stdout and "Nothing changed" in r.stdout
    assert (folder["home"] / "docker-compose.yml").read_bytes() == _ross()


def test_docker_refusing_the_file_changes_nothing(folder):
    shim = folder["tmp"] / "bin" / "docker"
    shim.write_text('#!/bin/sh\necho "docker $*" >> "$SHIM_LOG"\n'
                    'if [ "$2" = "version" ]; then exit 0; fi\n'
                    'case " $* " in *" config "*) echo "invalid compose project"; exit 1;; esac\nexit 0\n')
    r = _run(folder, stdin="y\n")
    assert r.returncode == 8 and "Docker didn't accept the changed file" in r.stdout
    assert (folder["home"] / "docker-compose.yml").read_bytes() == _ross()
    assert not (folder["home"] / C.BACKUP_NAME).exists()


# ── the one-use token and the command ────────────────────────────────────────

def test_a_token_works_once():
    tokens = H.HelperTokens()
    minted = tokens.mint(1)
    assert len(minted["token"]) >= 40
    assert tokens.state()["state"] == "live"
    assert tokens.consume(minted["token"]) is True
    assert tokens.consume(minted["token"]) is False
    assert tokens.state() == {"state": "used"}


def test_a_token_expires_and_a_new_one_retires_the_old():
    now = [1000.0]
    tokens = H.HelperTokens(ttl=600, clock=lambda: now[0])
    first = tokens.mint(1)
    second = tokens.mint(1)
    assert tokens.consume(first["token"]) is False
    now[0] += 601
    assert tokens.state() == {"state": "expired"}
    assert tokens.consume(second["token"]) is False


@pytest.mark.parametrize("bad", [None, "", "x" * 500, 42, "not-the-token"])
def test_wrong_tokens_are_refused(bad):
    tokens = H.HelperTokens()
    tokens.mint(1)
    assert tokens.consume(bad) is False


def test_tokens_are_kept_only_as_hashes():
    tokens = H.HelperTokens()
    minted = tokens.mint(1)
    assert minted["token"] not in repr(tokens._live)


def test_the_command_and_its_folder():
    cmd = H.command("http://192.168.1.20:8008", "TOKEN", "~/SoulSync")
    assert cmd == ("cd ~/SoulSync && curl -fsSL 'http://192.168.1.20:8008/api/drives/helper.sh?t=TOKEN' "
                   f"-o drives-helper.sh && echo '{H.script_sha256()}  drives-helper.sh' | shasum -a 256 -c - "
                   "&& sh drives-helper.sh")
    assert H.command("http://h", "T", "~/My Music/SoulSync").startswith('cd ~/"My Music/SoulSync" && ')
    assert H.undo_command("~/SoulSync") == "cd ~/SoulSync && sh drives-helper.sh --undo"
    assert H.clean_compose_folder("") == "~/SoulSync"
    for bad in ("~/x; rm -rf /", "$(reboot)", "~/a`b`", "relative/path", "~/../etc", 'a"b'):
        with pytest.raises(ValueError):
            H.clean_compose_folder(bad)


def test_the_script_carries_the_tool_verbatim():
    script = H.script()
    with open(C.__file__) as f:
        assert f.read().rstrip("\n") in script
    assert script.startswith("#!/bin/sh")
    assert "xcode-select" in script and "--undo" in script


def test_the_script_runs_in_well_under_a_minute(folder):
    started = time.monotonic()
    _run(folder, "--dry-run")
    assert time.monotonic() - started < 30


@pytest.mark.parametrize("base", ['http://h"; rm -rf ~; echo "', "http://h/$(id)", "http://h/`id`", "ftp://h",
                                  "http://h/a b", "http://h/?x=1", "http://h:8008'"])
def test_the_command_refuses_an_address_with_shell_characters(base):
    with pytest.raises(ValueError):
        H.command(base, "TOKEN", "~/SoulSync")


def test_the_commands_checksum_matches_the_served_script(tmp_path):
    (tmp_path / H.SCRIPT_NAME).write_text(H.script())
    cmd = H.command("http://[::1]:8008/synchros", "T-1_x", "~/SoulSync", "linux")
    assert "'http://[::1]:8008/synchros/api/drives/helper.sh?t=T-1_x'" in cmd
    check = cmd.split(" && ")[2]
    assert check.endswith("| sha256sum -c -")
    if shutil.which("sha256sum"):
        ok = subprocess.run(["sh", "-c", check], cwd=tmp_path, capture_output=True, text=True)
        assert ok.returncode == 0, ok.stdout + ok.stderr
        (tmp_path / H.SCRIPT_NAME).write_text(H.script() + "echo tampered\n")
        bad = subprocess.run(["sh", "-c", check], cwd=tmp_path, capture_output=True, text=True)
        assert bad.returncode != 0


OVERRIDE = "services:\n  soulsync:\n    environment:\n      - EXTRA=1\n"


def test_an_override_file_is_checked_with_the_edit_and_kept_at_the_restart(folder):
    (folder["home"] / "docker-compose.override.yml").write_text(OVERRIDE)
    r = _run(folder, stdin="y\n")
    assert r.returncode == 0, r.stdout + r.stderr
    calls = _calls(folder)
    check = next(c for c in calls if c.endswith("config -q"))
    assert check.startswith("docker compose -f .docker-compose.drives-new.")
    assert check.endswith(" -f docker-compose.override.yml config -q")
    assert calls[-1] == "docker compose up -d"
    assert (folder["home"] / "docker-compose.override.yml").read_text() == OVERRIDE


def test_compose_file_is_respected(folder):
    home = folder["home"]
    (home / "docker-compose.yml").rename(home / "base.yml")
    (home / "extra.yml").write_text(OVERRIDE)
    env = {**folder["env"], "COMPOSE_FILE": "base.yml:extra.yml"}
    r = subprocess.run(["sh", H.SCRIPT_NAME, "--platform", "mac"], cwd=home, env=env, input="y\n",
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "/Volumes:/Volumes" in (home / "base.yml").read_text()
    assert (home / "extra.yml").read_text() == OVERRIDE
    calls = _calls(folder)
    assert next(c for c in calls if c.endswith("config -q")).endswith(" -f extra.yml config -q")
    assert calls[-1] == "docker compose up -d"


def test_compose_file_whose_first_file_isnt_synchros_is_refused_clearly(folder):
    home = folder["home"]
    (home / "first.yml").write_text("services:\n  other:\n    image: nginx\n")
    env = {**folder["env"], "COMPOSE_FILE": "first.yml:docker-compose.yml"}
    r = subprocess.run(["sh", H.SCRIPT_NAME, "--platform", "mac", "--yes"], cwd=home, env=env,
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 7 and "COMPOSE_FILE is set" in r.stdout and "first file" in r.stdout
    assert (home / "docker-compose.yml").read_bytes() == _ross()


def test_undo_refuses_after_the_file_was_edited_since(folder):
    assert _run(folder, stdin="y\n").returncode == 0
    path = folder["home"] / "docker-compose.yml"
    edited = path.read_text() + "# my own change\n"
    path.write_text(edited)
    r = _run(folder, "--undo", "--yes")
    assert r.returncode == 12 and "changed since the helper edited it" in r.stdout
    assert path.read_text() == edited
    assert (folder["home"] / C.BACKUP_NAME).exists()


def test_each_run_keeps_its_own_before_copy(folder):
    assert _run(folder, stdin="y\n").returncode == 0
    path = folder["home"] / "docker-compose.yml"
    # the person takes the lines out again by hand, then runs the helper again
    path.write_bytes(_ross().replace(b"# Keep this file", b"# Keep my file"))
    assert _run(folder, stdin="y\n").returncode == 0
    assert (folder["home"] / C.BACKUP_NAME).read_bytes() == _ross().replace(b"# Keep this file", b"# Keep my file")
    assert _run(folder, "--undo", "--yes").returncode == 0
    assert b"# Keep my file" in path.read_bytes()


def test_writes_never_follow_a_planted_link(folder, tmp_path):
    outside = tmp_path / "outside.txt"
    outside.write_text("keep")
    home = folder["home"]
    os.symlink(str(outside), str(home / C.BACKUP_NAME))
    r = _run(folder, stdin="y\n")
    assert r.returncode == 0, r.stdout + r.stderr
    assert outside.read_text() == "keep"
    assert not os.path.islink(home / C.BACKUP_NAME)
