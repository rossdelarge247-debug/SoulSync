"""Setup check: the folder, permission and connection mistakes that cost
people an evening, found in one pass.

Most support threads about "downloads finish but nothing shows up" come down
to a handful of setup mistakes: slskd writing to a folder SoulSync can't see,
a Transfer folder that was never mapped out of the container, a share mounted
for the wrong user, two settings pointing at the same folder. Each of those is
quick to detect and slow to find by hand, so this module looks for all of them
and says, in plain language, what is wrong and what to do about it.

Every check is independent and returns one or more results shaped
``{id, title, status, detail, fix, category}`` where ``status`` is one of
ok / warning / error / skipped:

* ``error``   something that is set up is broken (downloads will fail or vanish)
* ``warning`` it works, but there is a real risk or a likely mistake
* ``skipped`` the check does not apply, or could not be decided (``detail`` says why)

Rules every check follows:

* Fast: network calls carry short timeouts and the whole run has a deadline;
  a check that does not finish in time is reported, not waited for.
* Side-effect free apart from the write test (and the slskd marker file),
  which create a small file and delete it straight away. Nothing is created,
  chowned or reconfigured on the user's behalf, so a missing folder is still
  missing on the next run.
* Never fatal: an exception inside one check becomes a ``skipped`` result for
  that check; the others still run.

The I/O seams (config, HTTP, disk usage, mount table, user ids, feature
probes) all live on :class:`SetupCheckContext` so tests can drive every
branch without real servers or a real full disk.
"""

from __future__ import annotations

import errno
import hashlib
import ipaddress
import os
import re
import secrets
import shutil
import socket
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlparse

from utils.logging_config import get_logger

logger = get_logger("setup_check")

OK = "ok"
WARNING = "warning"
ERROR = "error"
SKIPPED = "skipped"
STATUSES = (OK, WARNING, ERROR, SKIPPED)
_SEVERITY = {SKIPPED: -1, OK: 0, WARNING: 1, ERROR: 2}

# Below this much free space a folder gets a warning. The download folder
# additionally fails outright under soulseek.min_free_disk_gb, because that is
# the floor at which core.disk_guard starts refusing downloads.
LOW_SPACE_GB = 2.0
DEFAULT_DOWNLOAD_FLOOR_GB = 5.0

# (connect, read) seconds for every HTTP call. A healthy slskd / Plex answers
# these endpoints in milliseconds; anything slower is worth reporting anyway.
HTTP_TIMEOUT: Tuple[float, float] = (3.05, 5.0)
SLSKD_LOGIN_TIMEOUT_S = 8.0
DEFAULT_DEADLINE_S = 25.0
LOCAL_DEADLINE_S = 6.0

# Where each setting is changed in the UI, for the fix text. These follow what
# the Settings page shows: tab → section → sub-tab or tile.
_MUSIC_FOLDERS_SETTING = "Settings → Library → Folders → Music"
_SLSKD_SETTING = "Settings → Sources → Download Sources → Soulseek"
_MEDIA_SERVER_SETTING = "Settings → Connections → Server Connections"

_CONTAINER_ROOT = "/"
_CIFS_TYPES = frozenset({"cifs", "smb3", "smbfs"})
_NFS_TYPES = frozenset({"nfs", "nfs4"})
_NETWORK_TYPES = _CIFS_TYPES | _NFS_TYPES | frozenset({"fuse.sshfs", "fuse.rclone", "9p"})

_PODCAST_DEFAULTS = frozenset({"/app/podcasts", "./podcasts", "podcasts"})
_AUDIOBOOK_DEFAULTS = frozenset({"/app/audiobooks", "./audiobooks", "audiobooks"})

_WRITE_PROBE_PREFIX = ".soulsync-setup-check-"
# Not a dotfile: slskd (.NET) skips hidden files when it lists a directory,
# and the whole point of the marker is that slskd lists it.
_MARKER_PREFIX = "soulsync-setup-check-"


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

def make_result(check_id: str, title: str, status: str, detail: str, fix: str = "",
                category: str = "", **data: Any) -> Dict[str, Any]:
    """One check result. ``data`` carries machine-readable extras (paths,
    free space) for a UI that wants more than the sentence."""
    if status not in STATUSES:
        raise ValueError(f"unknown status {status!r}")
    out: Dict[str, Any] = {
        "id": check_id,
        "title": title,
        "status": status,
        "detail": detail,
        "fix": fix or "",
        "category": category,
    }
    clean = {k: v for k, v in data.items() if v is not None}
    if clean:
        out["data"] = clean
    return out


def worst_status(statuses: Iterable[str]) -> str:
    """error > warning > ok. ``skipped`` never decides the overall status;
    a run where everything was skipped reads as ok."""
    worst = OK
    for s in statuses:
        if _SEVERITY.get(s, 0) > _SEVERITY[worst]:
            worst = s
    return worst


def summarize(results: Sequence[Mapping[str, Any]]) -> Dict[str, int]:
    counts = {s: 0 for s in STATUSES}
    for r in results:
        counts[r.get("status", SKIPPED)] = counts.get(r.get("status", SKIPPED), 0) + 1
    return counts


class _Findings:
    """Collects several problems about one thing (a folder) into one result:
    the worst status wins, the sentences are joined in order."""

    def __init__(self) -> None:
        self.items: List[Tuple[str, str, str]] = []

    def add(self, status: str, detail: str, fix: str = "") -> None:
        self.items.append((status, detail, fix))

    @property
    def status(self) -> str:
        return worst_status(s for s, _, _ in self.items) if self.items else OK

    def problems(self) -> List[Tuple[str, str, str]]:
        return [i for i in self.items if i[0] in (WARNING, ERROR)]

    def joined(self) -> Tuple[str, str]:
        probs = self.problems()
        detail = " ".join(d for _, d, _ in probs)
        fixes: List[str] = []
        for _, _, f in probs:
            if f and f not in fixes:
                fixes.append(f)
        return detail, " ".join(fixes)


# ---------------------------------------------------------------------------
# Context (every I/O seam)
# ---------------------------------------------------------------------------

def _default_resolve_path(raw: str) -> str:
    """Canonical absolute form of a configured folder, the same way the rest of
    the app resolves it (Docker-hosted Windows drives mapped to /host/mnt/<x>,
    ``~`` expanded, made absolute)."""
    try:
        from core.imports.paths import config_root_path
        return config_root_path(raw)
    except Exception:  # noqa: BLE001 - the import chain is heavy; fall back to the same rule
        raw = str(raw or "").strip()
        if not raw:
            return ""
        if os.path.exists("/.dockerenv") and len(raw) >= 3 and raw[1] == ":" and raw[0].isalpha():
            return f"/host/mnt/{raw[0].lower()}{raw[2:].replace(chr(92), '/')}"
        return os.path.abspath(os.path.expanduser(raw))


def _default_mountinfo() -> str:
    with open("/proc/self/mountinfo", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def _detect_container(env: Mapping[str, str]) -> bool:
    return (os.path.exists("/.dockerenv") or os.path.exists("/run/.containerenv")
            or str(env.get("SOULSYNC_IN_DOCKER", "")).lower() in ("1", "true", "yes"))


def _default_run_coroutine(coro, timeout: float):
    from utils.async_helpers import run_async
    return run_async(coro, timeout=timeout)


@dataclass
class SetupCheckContext:
    """Everything a check reads from the outside world."""

    get: Callable[[str, Any], Any]
    in_container: bool = False
    resolve_path: Callable[[str], str] = _default_resolve_path
    disk_usage: Callable[[str], Any] = shutil.disk_usage
    read_mountinfo: Optional[Callable[[], str]] = _default_mountinfo
    getuid: Optional[Callable[[], int]] = getattr(os, "getuid", None)
    getgid: Optional[Callable[[], int]] = getattr(os, "getgid", None)
    env: Mapping[str, str] = field(default_factory=lambda: dict(os.environ))
    http: Any = None  # requests-like: .get(url, headers=, params=, timeout=)
    # {'movies_path': ..., 'tv_path': ..., 'youtube_path': ...} from video.db
    video_paths: Optional[Callable[[], Mapping[str, str]]] = None
    # feature name ('podcasts' | 'audiobooks') -> has the user got data for it
    feature_in_use: Optional[Callable[[str], bool]] = None
    # the live SoulseekClient, so its own check_connection() can be reused
    soulseek_client: Optional[Callable[[], Any]] = None
    run_coroutine: Callable[[Any, float], Any] = _default_run_coroutine
    _mounts: Optional[List[Tuple[str, str, str, str]]] = field(default=None, repr=False)

    def cfg(self, key: str, default: Any = None) -> Any:
        try:
            value = self.get(key, default)
        except Exception:  # noqa: BLE001 - an unreadable key reads as unset
            return default
        return default if value is None else value

    def cfg_str(self, key: str, default: str = "") -> str:
        value = self.cfg(key, default)
        return str(value).strip() if value is not None else ""

    def mounts(self) -> List[Tuple[str, str, str, str]]:
        if self._mounts is None:
            text = ""
            if self.read_mountinfo is not None:
                try:
                    text = self.read_mountinfo() or ""
                except Exception:  # noqa: BLE001 - no mount table (Windows, macOS, locked /proc)
                    text = ""
            self._mounts = parse_mountinfo(text)
        return self._mounts


def build_context(config_manager=None, *, overrides: Optional[Mapping[str, Any]] = None,
                  **seams: Any) -> SetupCheckContext:
    """A context over the live config (or ``config_manager``), with the boot-time
    defaults from :func:`configure`. ``overrides`` replaces individual dotted
    keys for one run (for example a folder typed into the wizard but not saved)."""
    cm = config_manager or _DEFAULTS.get("config_manager")
    if cm is None:
        from core.settings import config_manager as cm  # noqa: PLC0415 - lazy: keeps imports light
    overrides = dict(overrides or {})

    def _get(key: str, default: Any = None) -> Any:
        if key in overrides:
            return overrides[key]
        return cm.get(key, default)

    env = seams.pop("env", None)
    if env is None:
        env = dict(os.environ)
    http = seams.pop("http", None)
    if http is None:
        import requests
        http = requests
    kwargs: Dict[str, Any] = {
        "get": _get,
        "env": env,
        "http": http,
        "in_container": _detect_container(env),
        "video_paths": _DEFAULTS.get("video_paths"),
        "feature_in_use": _DEFAULTS.get("feature_in_use"),
        "soulseek_client": _DEFAULTS.get("soulseek_client"),
    }
    kwargs.update(seams)
    return SetupCheckContext(**kwargs)


_DEFAULTS: Dict[str, Any] = {}


def configure(*, config_manager=None, video_paths=None, feature_in_use=None, soulseek_client=None) -> None:
    """Boot-time wiring from web_server (the live config, the video.db reader,
    the feature probes and the orchestrator's slskd client)."""
    _DEFAULTS.update({
        "config_manager": config_manager,
        "video_paths": video_paths,
        "feature_in_use": feature_in_use,
        "soulseek_client": soulseek_client,
    })


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

_OCTAL_ESCAPE = re.compile(r"\\([0-7]{3})")


def _unescape_mount(field_value: str) -> str:
    return _OCTAL_ESCAPE.sub(lambda m: chr(int(m.group(1), 8)), field_value)


def parse_mountinfo(text: str) -> List[Tuple[str, str, str, str]]:
    """``[(mount_point, fstype, source, root), ...]`` from /proc/self/mountinfo.
    ``root`` is the folder of the source filesystem that is mounted, which for
    a Docker volume is ``.../volumes/<name>/_data``."""
    out = []
    for line in (text or "").splitlines():
        left, sep, right = line.partition(" - ")
        if not sep:
            continue
        lf, rf = left.split(), right.split()
        if len(lf) < 5 or not rf:
            continue
        out.append((_unescape_mount(lf[4]), rf[0], rf[1] if len(rf) > 1 else "", _unescape_mount(lf[3])))
    return out


# An anonymous Docker/Podman volume: the image's VOLUME line created it because
# nothing was mapped there. Named volumes have a name instead of 64 hex digits.
_ANON_VOLUME = re.compile(r"(?:^|/)volumes/[0-9a-f]{64}/_data/?$")


def is_anonymous_volume(mount: Optional[Sequence[str]]) -> bool:
    return bool(mount and len(mount) > 3 and _ANON_VOLUME.search(mount[3] or ""))


def mount_for(path: str, mounts: Sequence[Tuple[str, ...]]) -> Optional[Tuple[str, ...]]:
    """The mount entry a path lives on (longest mount point that contains it).
    The last matching entry wins on ties, as later mounts shadow earlier ones."""
    best = None
    for entry in mounts:
        mp = entry[0]
        if _is_inside(path, mp, allow_equal=True):
            if best is None or len(mp) >= len(best[0]):
                best = entry
    return best


def _norm(path: str) -> str:
    p = os.path.normpath(str(path or ""))
    return os.path.normcase(p)


def _canonical(path: str) -> str:
    try:
        return _norm(os.path.realpath(path))
    except (OSError, ValueError):
        return _norm(path)


def _is_inside(child: str, parent: str, *, allow_equal: bool = False) -> bool:
    c, p = _norm(child), _norm(parent)
    if c == p:
        return allow_equal
    if p == os.sep or p.endswith(os.sep):
        return c.startswith(p)
    return c.startswith(p + os.sep)


def _same_dir(a: str, b: str) -> bool:
    """Same folder: same canonical path, or the same directory reached through
    two different mounts (a bind mount keeps device and inode)."""
    if _canonical(a) == _canonical(b):
        return True
    try:
        sa, sb = os.stat(a), os.stat(b)
    except (OSError, ValueError):
        return False
    return (sa.st_dev, sa.st_ino) == (sb.st_dev, sb.st_ino)


def _is_local_host(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    if host in ("localhost", socket.gethostname().lower()):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _resolve_url(ctx: SetupCheckContext, url: str) -> str:
    """The same rewrite web_server.docker_resolve_url and the slskd client do:
    inside a container ``localhost`` is the container itself."""
    url = str(url or "").strip().rstrip("/")
    if ctx.in_container and "localhost" in url:
        url = url.replace("localhost", "host.docker.internal")
    return url


def _fmt_gb(value: float) -> str:
    return f"{value:.1f} GB" if value < 10 else f"{value:.0f} GB"


def _user_ids(ctx: SetupCheckContext) -> Tuple[Optional[int], Optional[int]]:
    try:
        uid = ctx.getuid() if ctx.getuid else None
        gid = ctx.getgid() if ctx.getgid else None
    except Exception:  # noqa: BLE001
        return None, None
    return uid, gid


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

@dataclass
class HttpResult:
    status: Optional[int] = None
    data: Any = None
    error: str = ""       # human text
    kind: str = ""        # '' | timeout | unreachable | ssl | bad_url


def http_get(ctx: SetupCheckContext, url: str, *, headers: Optional[Mapping[str, str]] = None,
             params: Optional[Mapping[str, Any]] = None) -> HttpResult:
    """GET with the module timeout. Never raises; network failures come back
    classified so a check can say *which* thing went wrong."""
    import requests
    try:
        resp = ctx.http.get(url, headers=dict(headers or {}), params=params, timeout=HTTP_TIMEOUT)
    except (requests.exceptions.InvalidURL, requests.exceptions.MissingSchema,
            requests.exceptions.InvalidSchema) as exc:
        return HttpResult(error=str(exc), kind="bad_url")
    except requests.exceptions.Timeout as exc:
        return HttpResult(error=str(exc), kind="timeout")
    except requests.exceptions.SSLError as exc:
        return HttpResult(error=str(exc), kind="ssl")
    except requests.exceptions.RequestException as exc:
        return HttpResult(error=str(exc), kind="unreachable")
    data = None
    try:
        if (getattr(resp, "content", b"") or b"").strip():
            data = resp.json()
    except Exception:  # noqa: BLE001 - not JSON; status code still tells the story
        data = None
    return HttpResult(status=int(resp.status_code), data=data)


def _pick(obj: Any, *names: str) -> Any:
    """First present key, tolerating slskd's camelCase/PascalCase drift."""
    if not isinstance(obj, Mapping):
        return None
    for n in names:
        if n in obj and obj[n] not in (None, ""):
            return obj[n]
    lowered = {str(k).lower(): v for k, v in obj.items()}
    for n in names:
        v = lowered.get(n.lower())
        if v not in (None, ""):
            return v
    return None


# ---------------------------------------------------------------------------
# Folder checks
# ---------------------------------------------------------------------------

@dataclass
class FolderSpec:
    id: str
    title: str
    raw: str
    role: str                 # downloads | transfer | staging | music_extra | music_videos | podcasts | audiobooks | video
    setting: str              # where the user changes it
    required: bool = True     # empty => error (else skipped)
    must_write: bool = True   # write failure => error (else warning)
    space_floor_gb: float = 0.0   # error below this (download floor); 0 = none


def _soulseek_floor(ctx: SetupCheckContext) -> float:
    try:
        return max(0.0, float(ctx.cfg("soulseek.min_free_disk_gb", DEFAULT_DOWNLOAD_FLOOR_GB)))
    except (TypeError, ValueError):
        return DEFAULT_DOWNLOAD_FLOOR_GB


def _feature_used(ctx: SetupCheckContext, name: str) -> bool:
    if ctx.feature_in_use is None:
        return False
    try:
        return bool(ctx.feature_in_use(name))
    except Exception:  # noqa: BLE001 - a broken probe means "can't tell", not "in use"
        logger.debug("feature probe %s failed", name, exc_info=True)
        return False


def folder_specs(ctx: SetupCheckContext) -> Tuple[List[FolderSpec], List[Dict[str, Any]]]:
    """The folders to check, plus a ``skipped`` result for each optional feature
    that isn't set up (so the UI can say why it isn't listed)."""
    specs: List[FolderSpec] = [
        FolderSpec("folder.downloads", "Download folder", ctx.cfg_str("soulseek.download_path", "./downloads"),
                   "downloads", _MUSIC_FOLDERS_SETTING, space_floor_gb=_soulseek_floor(ctx)),
        FolderSpec("folder.transfer", "Music library folder", ctx.cfg_str("soulseek.transfer_path", "./Transfer"),
                   "transfer", _MUSIC_FOLDERS_SETTING),
        FolderSpec("folder.staging", "Import folder", ctx.cfg_str("import.staging_path", "./Staging"),
                   "staging", _MUSIC_FOLDERS_SETTING, required=False),
    ]
    skipped: List[Dict[str, Any]] = []

    extra = ctx.cfg("library.music_paths", []) or []
    if isinstance(extra, str):
        extra = [extra]
    for i, p in enumerate(p for p in extra if isinstance(p, str) and p.strip()):
        specs.append(FolderSpec(f"folder.music_extra.{i}", "Extra music folder", p.strip(), "music_extra",
                                _MUSIC_FOLDERS_SETTING, required=False, must_write=False))

    mv = ctx.cfg_str("library.music_videos_path", "")
    if mv:
        specs.append(FolderSpec("folder.music_videos", "Music videos folder", mv, "music_videos",
                                _MUSIC_FOLDERS_SETTING, required=False))

    podcasts = ctx.cfg_str("podcasts.download_path", "") or ctx.cfg_str("library.podcasts_path", "")
    if podcasts and (podcasts not in _PODCAST_DEFAULTS or _feature_used(ctx, "podcasts")):
        specs.append(FolderSpec("folder.podcasts", "Podcasts folder", podcasts, "podcasts",
                                "Settings → Library → Folders → Podcasts", required=False))
    else:
        skipped.append(make_result("folder.podcasts", "Podcasts folder", SKIPPED,
                                   "You don't seem to use podcasts yet, so the podcasts folder wasn't checked.",
                                   category="folders"))

    books = ctx.cfg_str("library.audiobooks_path", "") or ctx.cfg_str("audiobooks.download_path", "")
    if books and (books not in _AUDIOBOOK_DEFAULTS or _feature_used(ctx, "audiobooks")):
        specs.append(FolderSpec("folder.audiobooks", "Audiobooks folder", books, "audiobooks",
                                "Settings → Library → Folders → Audiobooks", required=False))
    else:
        skipped.append(make_result("folder.audiobooks", "Audiobooks folder", SKIPPED,
                                   "You don't seem to use audiobooks yet, so the audiobooks folder wasn't checked.",
                                   category="folders"))

    video: Mapping[str, str] = {}
    if ctx.video_paths is not None:
        try:
            video = ctx.video_paths() or {}
        except Exception:  # noqa: BLE001 - video.db unreadable: report it as not set up
            logger.debug("video paths unreadable", exc_info=True)
            video = {}
    labels = (("movies_path", "Movies folder"), ("tv_path", "TV shows folder"), ("youtube_path", "YouTube folder"))
    any_video = False
    for key, title in labels:
        p = str(video.get(key) or "").strip()
        if p:
            any_video = True
            specs.append(FolderSpec(f"folder.video.{key[:-5]}", title, p, "video",
                                    "Settings → Library → Folders → Video", required=False))
    if not any_video:
        skipped.append(make_result("folder.video", "Video folders", SKIPPED,
                                   "No movie, TV or YouTube folders are set, so the video side wasn't checked.",
                                   category="folders"))
    return specs, skipped


def _ownership_sentence(path: str, uid: Optional[int], gid: Optional[int]) -> str:
    try:
        st = os.stat(path)
    except OSError:
        return ""
    if uid is None:
        return ""
    return (f" The folder belongs to user {st.st_uid} (group {st.st_gid}); "
            f"SYNCHRO.S runs as user {uid} (group {gid}).")


def _permission_fix(ctx: SetupCheckContext, path: str, fstype: str) -> str:
    uid, gid = _user_ids(ctx)
    who = f"{uid}:{gid}" if uid is not None else "the SYNCHRO.S user"
    if fstype in _CIFS_TYPES:
        return ("This folder is on a network share (SMB/CIFS). On a share, who may write is decided by how the share is "
                "mounted on the server, not by chown. Remount it for SYNCHRO.S's user, e.g. add "
                f"uid={uid},gid={gid},file_mode=0664,dir_mode=0775 to the mount options (in /etc/fstab or your "
                "NAS/Unraid share settings), then restart SYNCHRO.S.")
    if fstype in _NFS_TYPES:
        return (f"This folder is on an NFS share. On the NAS, let user {uid} write to the export (check the folder's "
                "owner and the root_squash/all_squash options), then remount it and restart SYNCHRO.S.")
    if ctx.in_container:
        return (f"On your server, give SYNCHRO.S's user access to the folder you mapped to {path}, e.g. "
                f"`sudo chown -R {who} /path/on/your/server`. Or set PUID and PGID in docker-compose to the folder's "
                "owner and recreate the container.")
    return f"Give the user SYNCHRO.S runs as write access, e.g. `sudo chown -R {who} {path}`."


def _probe_write(path: str) -> Tuple[bool, bool, Optional[OSError]]:
    """(created, deleted, error): create a tiny hidden file and delete it."""
    try:
        fd, name = tempfile.mkstemp(prefix=_WRITE_PROBE_PREFIX, suffix=".tmp", dir=path)
    except OSError as exc:
        return False, False, exc
    try:
        try:
            os.write(fd, b"ok")
        finally:
            os.close(fd)
    except OSError as exc:
        try:
            os.unlink(name)
        except OSError:
            pass
        return False, False, exc
    try:
        os.unlink(name)
    except OSError as exc:
        return True, False, exc
    return True, True, None


def check_folder(ctx: SetupCheckContext, spec: FolderSpec) -> Dict[str, Any]:
    """Exists, is a folder, readable, writable (create + delete a temp file),
    enough free space, and (in a container) actually mapped from the host."""
    cat = "folders"
    if not spec.raw:
        if spec.required:
            return make_result(spec.id, spec.title, ERROR, f"No {spec.title.lower()} is set.",
                               f"Set it in {spec.setting}.", cat)
        return make_result(spec.id, spec.title, SKIPPED, f"No {spec.title.lower()} is set, so there's nothing to check.",
                           category=cat)

    path = ctx.resolve_path(spec.raw) or spec.raw
    shown = path if _norm(path) == _norm(spec.raw) else f"{path} (set as '{spec.raw}')"
    data = {"path": path, "configured": spec.raw}
    mount = mount_for(os.path.realpath(path), ctx.mounts()) if ctx.mounts() else None
    fstype = mount[1] if mount else ""
    if fstype:
        data["fstype"] = fstype

    if not os.path.exists(path):
        if ctx.in_container:
            fix = (f"Map a folder from your server to it: add a line like `- /path/on/your/server:{path}` under "
                   f"SoulSync's volumes in docker-compose and recreate the container (docker compose up -d). "
                   f"Or change it in {spec.setting} to a folder that's already mapped.")
            if path.startswith("/host/mnt/") and spec.raw[1:2] == ":":
                letter = spec.raw[0].lower()
                fix = (f"SYNCHRO.S turned the Windows path '{spec.raw}' into {path}. Mount that drive into the container "
                       f"at /host/mnt/{letter} (e.g. `- /mnt/{letter}:/host/mnt/{letter}:rw` in docker-compose, see "
                       f"Support/DOCKER.md) and recreate the container, or use a container path in {spec.setting}.")
        else:
            fix = (f"Create the folder or correct the path in {spec.setting}. If it's on a USB drive or network share, "
                   "make sure that is mounted.")
        return make_result(spec.id, spec.title, ERROR, f"The {spec.title.lower()} {shown} doesn't exist.", fix, cat, **data)

    if not os.path.isdir(path):
        return make_result(spec.id, spec.title, ERROR, f"{shown} is a file, not a folder.",
                           f"Point the setting in {spec.setting} at a folder.", cat, **data)

    uid, gid = _user_ids(ctx)
    try:
        with os.scandir(path) as it:
            next(it, None)
    except PermissionError:
        return make_result(spec.id, spec.title, ERROR,
                           f"SYNCHRO.S isn't allowed to open {shown} to see what's in it.{_ownership_sentence(path, uid, gid)}",
                           _permission_fix(ctx, path, fstype), cat, **data)
    except OSError as exc:
        return make_result(spec.id, spec.title, ERROR,
                           f"SYNCHRO.S couldn't read {shown}: {exc.strerror or exc}. A drive or network share may have dropped.",
                           "Check that the drive or share is connected and mounted, then run the check again.", cat, **data)

    f = _Findings()
    write_status = ERROR if spec.must_write else WARNING
    created, deleted, err = _probe_write(path)
    if not created:
        code = getattr(err, "errno", None)
        if code == errno.EROFS:
            f.add(write_status, f"{shown} is read-only, so SYNCHRO.S can't save anything there.",
                  ("Remove ':ro' from the end of its line in docker-compose and recreate the container. "
                   if ctx.in_container else "") + "If it's a network share or disk, remount it read-write.")
        elif code == errno.ENOSPC:
            f.add(ERROR, f"The drive holding {shown} is full.", "Free up space or move the folder to a bigger drive.")
        elif code in (errno.EACCES, errno.EPERM):
            extra = "" if spec.must_write else " That's fine for a library you only want SYNCHRO.S to read, but tag fixes and re-organizing won't work there."
            f.add(write_status, f"SYNCHRO.S can't create files in {shown} (permission denied).{_ownership_sentence(path, uid, gid)}{extra}",
                  _permission_fix(ctx, path, fstype))
        else:
            f.add(write_status, f"SYNCHRO.S couldn't create a test file in {shown}: {getattr(err, 'strerror', None) or err}.",
                  _permission_fix(ctx, path, fstype))
    elif not deleted:
        f.add(WARNING, f"SYNCHRO.S can create files in {shown} but can't delete them, so files moved out of it would leave copies behind.",
              _permission_fix(ctx, path, fstype))

    free_gb = None
    try:
        free_gb = ctx.disk_usage(path).free / 1024 ** 3
        data["free_gb"] = round(free_gb, 2)
    except (OSError, AttributeError, TypeError, ValueError):
        free_gb = None
    if free_gb is not None:
        if spec.space_floor_gb and free_gb < spec.space_floor_gb:
            f.add(ERROR, f"Only {_fmt_gb(free_gb)} is free on the drive holding {shown}, below your "
                         f"{spec.space_floor_gb:g} GB minimum, so SYNCHRO.S is refusing new downloads.",
                  "Free up space on that drive, move the download folder to a bigger drive, or lower "
                  f"'Minimum free disk space' in {_MUSIC_FOLDERS_SETTING}.")
        elif free_gb < LOW_SPACE_GB:
            f.add(WARNING, f"Only {_fmt_gb(free_gb)} is free on the drive holding {shown}.",
                  "Free up space or move the folder to a bigger drive before it fills up.")

    if ctx.in_container and mount is not None:
        lose = ERROR if spec.role == "transfer" else WARNING
        map_fix = (f"Map a real folder to it: add `- /path/on/your/server:{path}` under SoulSync's volumes in "
                   "docker-compose (or the container's path settings on Unraid/Synology) and recreate the container.")
        if mount[0] == _CONTAINER_ROOT:
            f.add(lose, f"{path} is stored inside the SoulSync container, not in a folder mapped from your server. "
                        "Anything saved there is deleted when the container is updated or recreated, and other apps "
                        "(slskd, Plex, Jellyfin, Navidrome) can't see it.", map_fix)
        elif is_anonymous_volume(mount):
            f.add(lose, f"{path} is an unnamed Docker volume that SoulSync's image created because no folder was mapped "
                        "there. Other apps (slskd, Plex, Jellyfin, Navidrome) can't see it, and it is easy to lose: "
                        "re-creating the container from scratch starts a new, empty one.", map_fix)

    if spec.role == "transfer" and not ctx.in_container:
        raw = spec.raw.strip()
        if raw in ("", ".") or raw.startswith("./") or raw.startswith(".\\"):
            f.add(WARNING, f"The music library folder is still the default ('{raw}'), inside SYNCHRO.S's install folder "
                           f"({path}), so every finished download lands on the disk SYNCHRO.S is installed on.",
                  f"Point it at your real music folder in {spec.setting}.")

    if f.problems():
        detail, fix = f.joined()
        return make_result(spec.id, spec.title, f.status, detail, fix, cat, **data)

    bits = [f"{shown} exists and SYNCHRO.S can read and write it"]
    if free_gb is not None:
        bits.append(f"{_fmt_gb(free_gb)} free")
    detail = "; ".join(bits) + "."
    if fstype in _NETWORK_TYPES:
        detail += f" It's on a network share ({fstype})."
    return make_result(spec.id, spec.title, OK, detail, "", cat, **data)


# ---------------------------------------------------------------------------
# Folder layout (dangerous overlaps)
# ---------------------------------------------------------------------------

def check_folder_layout(ctx: SetupCheckContext, specs: Sequence[FolderSpec]) -> Dict[str, Any]:
    """Download, music library and import folders must be separate.

    What each overlap breaks, from how the code uses the folders:

    * the download folder is swept: empty folders are removed and old loose
      audio files reaped (``_sweep_empty_download_directories``,
      ``sweep_orphaned_download_audio``), and finished downloads are searched
      for recursively under it;
    * Auto-Import moves whatever lands in the import folder into the library;
    * Deep Scan walks the library and moves files it doesn't know into the
      import folder.

    An import folder *inside* the download folder is deliberately allowed: it's
    the common Unraid single-share layout, and the sweeps protect configured
    roots since #976.
    """
    cid, title, cat = "folders.layout", "Folder layout", "folders"
    by_role: Dict[str, Tuple[str, str]] = {}
    for s in specs:
        if s.raw and s.role in ("downloads", "transfer", "staging"):
            by_role[s.role] = (s.title.lower(), ctx.resolve_path(s.raw))
    if "downloads" not in by_role or "transfer" not in by_role:
        return make_result(cid, title, SKIPPED, "The download and music library folders aren't both set, so their layout wasn't checked.",
                           category=cat)

    d = by_role["downloads"][1]
    t = by_role["transfer"][1]
    s = by_role.get("staging", ("", ""))[1]
    f = _Findings()
    separate = "Use folders that sit side by side, for example /downloads, /music and /import, never one inside another."

    if _same_dir(t, d):
        f.add(ERROR, f"The download folder and the music library folder are the same folder ({t}). Raw downloads would land "
                     "straight in your library, and the clean-up that removes leftover files and empty folders from the "
                     "download folder would run on your library.", separate)
    elif _is_inside(_canonical(t), _canonical(d)):
        f.add(ERROR, f"The music library folder ({t}) is inside the download folder ({d}). SYNCHRO.S clears empty folders "
                     "and leftover files out of the download folder and searches it for finished downloads, so it would "
                     "reach into your library.", separate)
    elif _is_inside(_canonical(d), _canonical(t)):
        f.add(ERROR, f"The download folder ({d}) is inside the music library folder ({t}). Your media server would index "
                     "half-finished, untagged downloads, and Deep Scan would treat them as unknown library files.", separate)

    if s:
        if _same_dir(s, t):
            f.add(ERROR, f"The import folder and the music library folder are the same folder ({s}). Auto-Import moves files "
                         "from the import folder into the library and Deep Scan moves unknown library files into the import "
                         "folder, so with one folder they work against each other.", separate)
        elif _is_inside(_canonical(t), _canonical(s)):
            f.add(ERROR, f"The music library folder ({t}) is inside the import folder ({s}), so Auto-Import would try to "
                         "import your whole library again.", separate)
        elif _is_inside(_canonical(s), _canonical(t)):
            f.add(WARNING, f"The import folder ({s}) is inside the music library folder ({t}). Your media server will show "
                           "files that haven't been imported yet, and Deep Scan treats them as unknown library files.", separate)
        if _same_dir(s, d):
            f.add(ERROR, f"The import folder and the download folder are the same folder ({s}). Auto-Import would grab "
                         "downloads that are still being written, and the download clean-up would run in the import folder.",
                  separate)
        elif _is_inside(_canonical(d), _canonical(s)):
            f.add(ERROR, f"The download folder ({d}) is inside the import folder ({s}), so Auto-Import would grab downloads "
                         "that are still being written.", separate)

    for spec in specs:
        if spec.role in ("audiobooks", "podcasts", "video") and spec.raw:
            p = ctx.resolve_path(spec.raw)
            if _same_dir(p, t) or _is_inside(_canonical(p), _canonical(t)):
                f.add(WARNING, f"The {spec.title.lower()} ({p}) is inside the music library folder ({t}). Your media "
                               "server's music library will pick these files up as albums.",
                      f"Give the {spec.title.lower()} its own folder outside the music library.")

    if f.problems():
        detail, fix = f.joined()
        return make_result(cid, title, f.status, detail, fix, cat, downloads=d, transfer=t, staging=s or None)
    parts = ["download", "music library"] + (["import"] if s else [])
    return make_result(cid, title, OK, f"Your {', '.join(parts[:-1])} and {parts[-1]} folders are separate folders.",
                       "", cat, downloads=d, transfer=t, staging=s or None)


# ---------------------------------------------------------------------------
# Running user
# ---------------------------------------------------------------------------

def check_run_user(ctx: SetupCheckContext) -> Dict[str, Any]:
    cid, title, cat = "system.user", "User SYNCHRO.S runs as", "system"
    uid, gid = _user_ids(ctx)
    if uid is None:
        return make_result(cid, title, SKIPPED, "User IDs don't apply on this operating system.", category=cat)
    puid, pgid = str(ctx.env.get("PUID", "")).strip(), str(ctx.env.get("PGID", "")).strip()
    if uid == 0:
        why = " (PUID is set to 0)" if puid == "0" else ""
        fix = ("Set PUID and PGID in docker-compose to your own user's IDs (run `id` on the server to see them, often "
               "1000), then recreate the container." if ctx.in_container else "Run SYNCHRO.S as a normal user, not root.")
        return make_result(cid, title, WARNING,
                           f"SYNCHRO.S is running as root{why}. Files it creates belong to root, so Plex, slskd or your own "
                           "account may not be able to change or delete them.", fix, cat, uid=uid, gid=gid)
    if ctx.in_container and (puid or pgid):
        mismatches = []
        if puid.isdigit() and int(puid) != uid:
            mismatches.append(f"PUID is {puid} but SYNCHRO.S runs as user {uid}")
        if pgid.isdigit() and gid is not None and int(pgid) != gid:
            mismatches.append(f"PGID is {pgid} but SYNCHRO.S runs as group {gid}")
        if mismatches:
            return make_result(cid, title, WARNING,
                               "; ".join(mismatches) + ". Files will be owned by a different user than you asked for. "
                               "A `user:` line in docker-compose or a rootless setup usually causes this.",
                               f"Remove the `user:` line so PUID/PGID decide the user, or set PUID/PGID to {uid}/{gid}.",
                               cat, uid=uid, gid=gid, puid=puid or None, pgid=pgid or None)
        return make_result(cid, title, OK, f"SYNCHRO.S runs as user {uid}, group {gid}, matching PUID/PGID.", "", cat,
                           uid=uid, gid=gid)
    return make_result(cid, title, OK, f"SYNCHRO.S runs as user {uid}, group {gid}.", "", cat, uid=uid, gid=gid)


# ---------------------------------------------------------------------------
# slskd
# ---------------------------------------------------------------------------

def soulseek_in_use(ctx: SetupCheckContext) -> bool:
    mode = ctx.cfg_str("download_source.mode", "soulseek").lower()
    if mode == "soulseek":
        return True
    if mode == "hybrid":
        order = ctx.cfg("download_source.hybrid_order", []) or []
        if not order:
            order = [ctx.cfg_str("download_source.hybrid_primary", "soulseek"),
                     ctx.cfg_str("download_source.hybrid_secondary", "youtube")]
        return "soulseek" in [str(o).lower() for o in order]
    return False


def _slskd_headers(ctx: SetupCheckContext) -> Dict[str, str]:
    key = ctx.cfg_str("soulseek.api_key", "")
    return {"X-API-Key": key} if key else {}


def _slskd_unreachable(ctx: SetupCheckContext, url: str, res: HttpResult) -> Tuple[str, str]:
    if res.kind == "bad_url":
        return (f"The slskd address '{url}' isn't a valid web address.",
                f"Use the full address including http://, e.g. http://slskd:5030, in {_SLSKD_SETTING}.")
    if res.kind == "timeout":
        return (f"slskd at {url} didn't answer within {HTTP_TIMEOUT[1]:g} seconds.",
                "Check that slskd is running and not overloaded, and that the address and port are right.")
    if ctx.in_container:
        fix = ("Check that slskd is running. Inside a container 'localhost' means the SoulSync container itself (SYNCHRO.S "
               "tries host.docker.internal instead); if slskd is in the same docker-compose file, use its service name, "
               "e.g. http://slskd:5030. The port must be slskd's web port (5030 unless you changed it).")
    else:
        fix = "Check that slskd is running and that the address and port (5030 unless you changed it) are right."
    return f"SYNCHRO.S can't reach slskd at {url}.", fix


def _parse_server_state(state: Any) -> Optional[bool]:
    """Same reading of slskd's server state as SoulseekClient.check_connection."""
    if isinstance(state, Mapping) and any(k in state for k in ("isConnected", "IsConnected", "isLoggedIn", "IsLoggedIn")):
        connected = state.get("isConnected") or state.get("IsConnected", False)
        logged_in = state.get("isLoggedIn") or state.get("IsLoggedIn", False)
        return bool(connected and logged_in)
    return None


def slskd_logged_in(ctx: SetupCheckContext, url: str) -> Optional[bool]:
    """Is slskd logged in to the Soulseek network? Reuses the live client's
    ``check_connection()`` when it points at the same slskd; otherwise reads
    the same server-state endpoints directly. None = couldn't tell."""
    client = None
    if ctx.soulseek_client is not None:
        try:
            client = ctx.soulseek_client()
        except Exception:  # noqa: BLE001
            client = None
    if (client is not None and getattr(client, "base_url", None)
            and str(client.base_url).rstrip("/") == url.rstrip("/")
            and (getattr(client, "api_key", "") or "") == ctx.cfg_str("soulseek.api_key", "")):
        try:
            return bool(ctx.run_coroutine(client.check_connection(), SLSKD_LOGIN_TIMEOUT_S))
        except Exception:  # noqa: BLE001 - fall through to the direct read
            logger.debug("client check_connection failed in setup check", exc_info=True)
    for endpoint in ("server", "server/state"):
        res = http_get(ctx, f"{url}/api/v0/{endpoint}", headers=_slskd_headers(ctx))
        if res.kind:
            return None
        parsed = _parse_server_state(res.data) if res.status == 200 else None
        if parsed is not None:
            return parsed
    return None


def check_slskd_connection(ctx: SetupCheckContext) -> Dict[str, Any]:
    cid, title, cat = "slskd.connection", "slskd connection", "downloads"
    used = soulseek_in_use(ctx)
    raw = ctx.cfg_str("soulseek.slskd_url", "")
    if not raw:
        if used:
            return make_result(cid, title, ERROR, "Soulseek is one of your download sources, but no slskd address is set.",
                               f"Enter slskd's address and API key in {_SLSKD_SETTING} (e.g. http://slskd:5030 when "
                               "both run in the same docker-compose file).", cat)
        return make_result(cid, title, SKIPPED, "Soulseek isn't one of your download sources, so there's no slskd connection to check.",
                           category=cat)
    url = _resolve_url(ctx, raw)
    # Not used: still worth reporting a broken connection, but it isn't breaking downloads.
    bad = ERROR if used else WARNING
    note = "" if used else " (Soulseek isn't currently one of your download sources.)"
    data = {"url": url}

    res = http_get(ctx, f"{url}/api/v0/session", headers=_slskd_headers(ctx))
    if res.kind:
        detail, fix = _slskd_unreachable(ctx, url, res)
        return make_result(cid, title, bad, detail + note, fix, cat, **data)
    if res.status in (401, 403):
        if not ctx.cfg_str("soulseek.api_key", ""):
            detail = f"slskd is running at {url} but SYNCHRO.S has no API key for it."
        else:
            detail = f"slskd is running at {url} but rejected SYNCHRO.S's API key."
        return make_result(cid, title, bad, detail + note,
                           f"Make sure the API key in {_SLSKD_SETTING} matches one configured in slskd (the "
                           "SLSKD_API_KEY setting or the api_keys section of slskd.yml), then save.", cat, **data)
    if res.status != 200:
        return make_result(cid, title, bad,
                           f"Something answered at {url}, but it doesn't look like slskd (HTTP {res.status}).{note}",
                           "Check the address: it should be slskd's web address with nothing after the port, e.g. "
                           "http://slskd:5030.", cat, **data)

    logged_in = slskd_logged_in(ctx, url)
    if logged_in is False:
        return make_result(cid, title, WARNING,
                           f"slskd at {url} accepted the API key, but it isn't logged in to the Soulseek network, so "
                           "searches and downloads won't work right now.",
                           "Open slskd's web page and check its status. Make sure the Soulseek username and password in "
                           "slskd's settings are right; slskd reconnects by itself after a network drop.", cat, **data)
    if logged_in is None:
        return make_result(cid, title, OK, f"Connected to slskd at {url} and the API key works (couldn't tell whether "
                                           "slskd is logged in to the Soulseek network).", "", cat, **data)
    return make_result(cid, title, OK, f"Connected to slskd at {url}; the API key works and slskd is logged in to the "
                                       "Soulseek network.", "", cat, **data)


def _json_mentions(obj: Any, name: str, _depth: int = 0) -> bool:
    """Does any string in a JSON document name ``name`` (as a file name)?
    Shape-agnostic on purpose: slskd's listing format has moved between
    versions, and all we need is whether our marker is in it."""
    if _depth > 6:
        return False
    if isinstance(obj, str):
        return os.path.basename(obj.replace("\\", "/")) == name
    if isinstance(obj, Mapping):
        return any(_json_mentions(v, name, _depth + 1) for v in obj.values())
    if isinstance(obj, (list, tuple)):
        return any(_json_mentions(v, name, _depth + 1) for v in obj)
    return False


def _top_level_names(listing: Any) -> List[str]:
    """Names of the files and folders at the top of a slskd directory listing."""
    items: List[Any] = []
    if isinstance(listing, Mapping):
        for key in ("files", "directories"):
            v = _pick(listing, key)
            if isinstance(v, list):
                items.extend(v)
    elif isinstance(listing, list):
        items = listing
    names = []
    for it in items:
        n = _pick(it, "name", "fullName", "filename") if isinstance(it, Mapping) else it
        if isinstance(n, str) and n.strip():
            base = os.path.basename(n.replace("\\", "/").rstrip("/"))
            if base and not base.startswith(_MARKER_PREFIX):
                names.append(base)
    return names


def _locate_slskd_root(local: str, names: Sequence[str]) -> Optional[str]:
    """Where slskd's downloads folder sits inside SoulSync's download folder,
    judged by its top-level entries: '' for the folder itself, a sub-folder
    name, or None. SoulSync searches sub-folders for finished downloads, so
    slskd writing to a sub-folder of SoulSync's download folder works."""
    wanted = set(names)
    if not wanted:
        return None
    need = max(1, len(wanted) // 2)

    def hits(folder: str) -> int:
        try:
            present = set(os.listdir(folder))
        except OSError:
            return 0
        return len(wanted & present)

    if hits(local) >= need:
        return ""
    try:
        subs = sorted(e.name for e in os.scandir(local) if e.is_dir(follow_symlinks=False))[:100]
    except OSError:
        return None
    for sub in subs:
        if hits(os.path.join(local, sub)) >= need:
            return sub
    return None


@contextmanager
def _marker_in(folder: str):
    """A uniquely named marker file in ``folder`` for the duration of the block."""
    name = f"{_MARKER_PREFIX}{uuid.uuid4().hex[:12]}.txt"
    path = os.path.join(folder, name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("SoulSync setup check. Safe to delete.\n")
    try:
        yield name
    finally:
        try:
            os.unlink(path)
        except OSError:
            logger.warning("setup check could not remove its marker file %s", path)


def check_slskd_download_folder(ctx: SetupCheckContext) -> Dict[str, Any]:
    """Is the folder slskd downloads into the folder SoulSync reads?

    slskd reports its downloads directory (GET /api/v0/options), but that path
    is as *slskd* sees it, usually in another container, so comparing strings
    proves little. The decisive test: put a marker file in SoulSync's download
    folder and ask slskd to list its downloads directory
    (GET /api/v0/files/downloads/directories). When that endpoint isn't there
    (older slskd) the paths are compared, which is only conclusive when both
    run on the same machine outside containers.
    """
    cid, title, cat = "slskd.download_folder", "slskd and SYNCHRO.S share the download folder", "downloads"
    if not soulseek_in_use(ctx):
        return make_result(cid, title, SKIPPED, "Soulseek isn't one of your download sources.", category=cat)
    raw_url = ctx.cfg_str("soulseek.slskd_url", "")
    if not raw_url:
        return make_result(cid, title, SKIPPED, "No slskd address is set (see the slskd connection check).", category=cat)
    raw_local = ctx.cfg_str("soulseek.download_path", "./downloads")
    local = ctx.resolve_path(raw_local) if raw_local else ""
    if not local:
        return make_result(cid, title, SKIPPED, "SYNCHRO.S has no download folder set (see the download folder check).",
                           category=cat)
    url = _resolve_url(ctx, raw_url)
    headers = _slskd_headers(ctx)

    opts = http_get(ctx, f"{url}/api/v0/options", headers=headers)
    if opts.kind or opts.status in (401, 403):
        return make_result(cid, title, SKIPPED, "SYNCHRO.S couldn't talk to slskd, so this couldn't be checked; fix the slskd "
                                                "connection first.", category=cat)
    dirs = _pick(opts.data, "directories") if opts.status == 200 else None
    slskd_dl = str(_pick(dirs, "downloads") or "").strip()
    slskd_inc = str(_pick(dirs, "incomplete") or "").strip()
    data = {"soulsync_path": local, "slskd_path": slskd_dl or None, "slskd_incomplete_path": slskd_inc or None}
    slskd_says = f"{slskd_dl} (as slskd sees it)" if slskd_dl else "its downloads folder"

    if ctx.in_container:
        mismatch_fix = (f"Map the same folder on your server into both containers. In docker-compose, give slskd "
                        f"`- /path/on/your/server:{slskd_dl or '/app/downloads'}` and SYNCHRO.S "
                        f"`- /path/on/your/server:{local}` (the same left-hand side), then recreate both containers.")
    else:
        mismatch_fix = (f"Set SYNCHRO.S's Download Folder ({_MUSIC_FOLDERS_SETTING}) to slskd's downloads folder"
                        + (f" ({slskd_dl})" if slskd_dl else "") + f", or change slskd's downloads directory to {local}.")

    # 1. Marker file: decisive when slskd can list its downloads folder.
    if os.path.isdir(local):
        listing_url = f"{url}/api/v0/files/downloads/directories"
        try:
            with _marker_in(local) as marker:
                listing = http_get(ctx, listing_url, headers=headers)
                if listing.status == 200:
                    if _json_mentions(listing.data, marker):
                        return make_result(cid, title, OK,
                                           f"slskd and SYNCHRO.S use the same download folder (slskd calls it "
                                           f"{slskd_dl or 'its downloads folder'}, SYNCHRO.S calls it {local}).", "", cat, **data)
                    def sub_ok(folder: str) -> Dict[str, Any]:
                        return make_result(cid, title, OK, f"slskd downloads into {folder}, a sub-folder of SYNCHRO.S's "
                                           "download folder. That works, because SYNCHRO.S also looks in sub-folders.",
                                           "", cat, **data)

                    where = _locate_slskd_root(local, _top_level_names(listing.data))
                    if where:
                        return sub_ok(os.path.join(local, where))
                    if where == "":
                        return make_result(cid, title, OK, f"slskd and SYNCHRO.S use the same download folder ({local}).",
                                           "", cat, **data)
                    # slskd's folder may be a still-empty sub-folder (e.g. slskd writes to
                    # /data/downloads/soulseek while SoulSync reads /data/downloads).
                    sub = os.path.basename(slskd_dl.replace("\\", "/").rstrip("/")) if slskd_dl else ""
                    if sub and os.path.isdir(os.path.join(local, sub)):
                        with _marker_in(os.path.join(local, sub)) as inner:
                            again = http_get(ctx, listing_url, headers=headers)
                            if again.status == 200 and _json_mentions(again.data, inner):
                                return sub_ok(os.path.join(local, sub))
                    inc = http_get(ctx, f"{url}/api/v0/files/incomplete/directories", headers=headers)
                    if inc.status == 200 and _json_mentions(inc.data, marker):
                        return make_result(cid, title, ERROR,
                                           f"SYNCHRO.S's download folder ({local}) is slskd's incomplete folder, where unfinished "
                                           f"downloads wait. Finished downloads are moved out of it to {slskd_says}, so SYNCHRO.S "
                                           "would never see them.",
                                           f"Point SYNCHRO.S's Download Folder at slskd's downloads folder instead ({_MUSIC_FOLDERS_SETTING})"
                                           + (" and map that folder into the SoulSync container." if ctx.in_container else "."),
                                           cat, **data)
                    return make_result(cid, title, ERROR,
                                       f"slskd saves downloads to {slskd_says}, which is not the folder SYNCHRO.S reads ({local}): "
                                       "a test file SYNCHRO.S put in its download folder didn't show up in slskd's. Downloads would "
                                       "finish in slskd and SYNCHRO.S would never find them.", mismatch_fix, cat, **data)
        except OSError:
            # can't write there: the download folder check says why; fall back to comparing paths
            logger.debug("marker write failed in %s", local, exc_info=True)

    # 2. Path comparison (slskd can't list files, or SoulSync's folder is unusable).
    if not slskd_dl:
        return make_result(cid, title, SKIPPED,
                           "slskd didn't report its download folder (it may be an older version, or the API key may not be "
                           "allowed to read slskd's settings), so this couldn't be checked.",
                           f"Check by hand that the folder slskd downloads into is the same folder as SYNCHRO.S's download "
                           f"folder ({local}).", cat, **data)
    same_machine = not ctx.in_container and _is_local_host(url)
    if same_machine:
        if _same_dir(slskd_dl, local):
            return make_result(cid, title, OK, f"slskd saves downloads to {slskd_dl}, which is SYNCHRO.S's download folder.",
                               "", cat, **data)
        if slskd_inc and _same_dir(slskd_inc, local):
            return make_result(cid, title, ERROR,
                               f"SYNCHRO.S's download folder ({local}) is slskd's incomplete folder; finished downloads are "
                               f"moved to {slskd_dl}, so SYNCHRO.S would never see them.", mismatch_fix, cat, **data)
        if _is_inside(_canonical(slskd_dl), _canonical(local)):
            return make_result(cid, title, OK, f"slskd downloads into {slskd_dl}, a sub-folder of SYNCHRO.S's download folder. "
                                               "That works, because SYNCHRO.S also looks in sub-folders.", "", cat, **data)
        return make_result(cid, title, ERROR,
                           f"slskd saves downloads to {slskd_dl}, but SYNCHRO.S reads {local}. Downloads would finish in slskd "
                           "and SYNCHRO.S would never find them.", mismatch_fix, cat, **data)
    if _norm(slskd_dl) == _norm(local):
        return make_result(cid, title, SKIPPED,
                           f"slskd and SYNCHRO.S both call the download folder {local}, which usually means they share it, "
                           "but this slskd version can't list its files, so SYNCHRO.S couldn't confirm it.",
                           "Make sure both containers map the same folder on your server to this path.", cat, **data)
    return make_result(cid, title, WARNING,
                       f"slskd saves downloads to {slskd_dl} (as slskd sees it) and SYNCHRO.S reads {local} (as SYNCHRO.S sees "
                       "it). That's fine only if both are the same folder on your server, and SYNCHRO.S couldn't confirm it "
                       "because this slskd version can't list its files.", mismatch_fix, cat, **data)


# ---------------------------------------------------------------------------
# Media server
# ---------------------------------------------------------------------------

def _probe_media_server(ctx: SetupCheckContext, name: str, url: str, cfg: Mapping[str, Any]
                        ) -> Tuple[str, str, Optional[List[str]], str]:
    """(failure_kind, failure_text, music_library_paths, server_text).
    failure_kind '' means connected; paths None means the server can't tell."""
    if name == "plex":
        res = http_get(ctx, f"{url}/library/sections",
                       headers={"X-Plex-Token": str(cfg.get("token") or ""), "Accept": "application/json"})
        if res.kind:
            return res.kind, res.error, None, ""
        if res.status in (401, 403):
            return "auth", "rejected the token", None, ""
        if res.status != 200 or not isinstance(res.data, Mapping):
            return "other", f"HTTP {res.status}", None, ""
        sections = _pick(res.data.get("MediaContainer") or {}, "Directory") or []
        paths: List[str] = []
        for sec in sections if isinstance(sections, list) else []:
            if str(_pick(sec, "type") or "").lower() != "artist":
                continue
            for loc in _pick(sec, "Location") or []:
                p = _pick(loc, "path") if isinstance(loc, Mapping) else loc
                if isinstance(p, str) and p and p not in paths:
                    paths.append(p)
        return "", "", paths, ""
    if name == "jellyfin":
        # the shared helper sends both headers jellyfin 10.x and 12 accept (#1250)
        from core.jellyfin_client import jellyfin_auth_headers  # noqa: PLC0415 - lazy: keeps imports light
        res = http_get(ctx, f"{url}/Library/VirtualFolders", headers=jellyfin_auth_headers(str(cfg.get("api_key") or "")))
        if res.kind:
            return res.kind, res.error, None, ""
        if res.status in (401, 403):
            return "auth", "rejected the API key", None, ""
        if res.status != 200 or not isinstance(res.data, list):
            return "other", f"HTTP {res.status}", None, ""
        paths = []
        for lib in res.data:
            if str(_pick(lib, "CollectionType") or "").lower() != "music":
                continue
            for p in _pick(lib, "Locations") or []:
                if isinstance(p, str) and p and p not in paths:
                    paths.append(p)
        return "", "", paths, ""
    if name == "navidrome":
        password = str(cfg.get("password") or "")
        salt = secrets.token_hex(3)
        params = {"u": str(cfg.get("username") or ""), "t": hashlib.md5((password + salt).encode()).hexdigest(),  # noqa: S324 - Subsonic auth scheme
                  "s": salt, "v": "1.16.1", "c": "soulsync", "f": "json"}
        res = http_get(ctx, f"{url}/rest/ping", params=params)
        if res.kind:
            return res.kind, res.error, None, ""
        if res.status != 200 or not isinstance(res.data, Mapping):
            return "other", f"HTTP {res.status}", None, ""
        body = res.data.get("subsonic-response") or {}
        if body.get("status") != "ok":
            err = body.get("error") or {}
            if err.get("code") in (40, 41, 42, 43, 44):
                return "auth", "rejected the username or password", None, ""
            return "other", str(err.get("message") or "unexpected answer"), None, ""
        return "", "", None, str(body.get("version") or "")
    return "other", "unknown server", None, ""


def _path_variants(p: str) -> str:
    q = str(p or "").replace("\\", "/").rstrip("/")
    if re.match(r"^[A-Za-z]:", q):
        q = q.lower()
    return q or "/"


def _contains(parent: str, child: str) -> bool:
    a, b = _path_variants(parent), _path_variants(child)
    return b == a or b.startswith(a.rstrip("/") + "/")


_MEDIA_CAT = "media_server"
_MEDIA_CONN_ID, _MEDIA_CONN_TITLE = "media_server.connection", "Media server connection"
_MEDIA_LIB_ID, _MEDIA_LIB_TITLE = "media_server.library_path", "Media server sees the music library folder"


def _chosen_media_server(ctx: SetupCheckContext) -> Tuple[Any, Dict[str, Any]]:
    """(descriptor or None, its settings) for Settings' active_media_server.
    Settings only, no network."""
    from core.media_server import specs as server_specs

    desc = server_specs.describe(ctx.cfg_str("active_media_server", "plex").lower())
    if desc is None:
        return None, {}
    return desc, {f.key: ctx.cfg(f"{desc.config_section}.{f.key}", f.default) for f in desc.fields}


def _no_library_chosen(desc: Any, cfg: Mapping[str, Any]) -> bool:
    """Neither Standalone nor a set-up Plex, Jellyfin or Navidrome. Downloads
    then never reach the Library page: imports record them only for a
    configured server or Standalone (core/imports/side_effects.py)."""
    if desc is None:
        return True
    return desc.is_external and not desc.is_configured(cfg)


def _no_library_results() -> List[Dict[str, Any]]:
    return [
        make_result(_MEDIA_CONN_ID, "Where your library lives", WARNING,
                    "No library is chosen, so downloads won't appear on the Library page.",
                    f"Choose Standalone in {_MEDIA_SERVER_SETTING} to let SYNCHRO.S keep the library itself, "
                    "or connect Plex, Jellyfin or Navidrome.", _MEDIA_CAT),
        make_result(_MEDIA_LIB_ID, _MEDIA_LIB_TITLE, SKIPPED, "Couldn't check, because no library is chosen.",
                    category=_MEDIA_CAT),
    ]


def check_library_choice(ctx: SetupCheckContext) -> List[Dict[str, Any]]:
    """The settings-only part of the media server check, for the local scope
    (the navigation's Setup check dot, debug info): the no-library warning, or
    nothing when a library is chosen."""
    desc, cfg = _chosen_media_server(ctx)
    return _no_library_results() if _no_library_chosen(desc, cfg) else []


def check_media_server(ctx: SetupCheckContext) -> List[Dict[str, Any]]:
    cat = _MEDIA_CAT
    conn_id, conn_title = _MEDIA_CONN_ID, _MEDIA_CONN_TITLE
    lib_id, lib_title = _MEDIA_LIB_ID, _MEDIA_LIB_TITLE

    desc, cfg = _chosen_media_server(ctx)
    if _no_library_chosen(desc, cfg):
        return _no_library_results()
    if not desc.is_external:
        msg = "You use SYNCHRO.S's own library (no Plex, Jellyfin or Navidrome), so there's no media server to check."
        return [make_result(conn_id, conn_title, SKIPPED, msg, category=cat),
                make_result(lib_id, lib_title, SKIPPED, msg, category=cat)]

    label = desc.display_name
    url = _resolve_url(ctx, str(cfg.get("base_url") or ""))
    kind, why, paths, version = _probe_media_server(ctx, desc.name, url, cfg)
    data = {"server": desc.name, "url": url}
    if kind:
        if kind == "auth":
            key_name = {"plex": "X-Plex-Token", "jellyfin": "API key", "navidrome": "username and password"}.get(desc.name, "credentials")
            conn = make_result(conn_id, conn_title, ERROR, f"{label} at {url} is running but {why}.",
                               f"Re-enter the {key_name} in {_MEDIA_SERVER_SETTING} and press "
                               f"{'Connect' if desc.name == 'plex' else 'Test'}.", cat, **data)
        elif kind == "bad_url":
            conn = make_result(conn_id, conn_title, ERROR, f"The {label} address '{url}' isn't a valid web address.",
                               f"Use the full address including http://, in {_MEDIA_SERVER_SETTING}.", cat, **data)
        elif kind in ("timeout", "unreachable", "ssl"):
            what = (f"didn't answer within {HTTP_TIMEOUT[1]:g} seconds" if kind == "timeout" else "can't be reached")
            fix = f"Check that {label} is running and that the address in {_MEDIA_SERVER_SETTING} is right."
            if ctx.in_container:
                fix += " Inside a container 'localhost' means the SoulSync container itself; use the server's LAN IP or its container name."
            conn = make_result(conn_id, conn_title, ERROR, f"{label} at {url} {what}.", fix, cat, **data)
        else:
            conn = make_result(conn_id, conn_title, ERROR, f"Something answered at {url}, but not like {label} does ({why}).",
                               f"Check the {label} address in {_MEDIA_SERVER_SETTING}.", cat, **data)
        return [conn, make_result(lib_id, lib_title, SKIPPED, f"Couldn't check, because SYNCHRO.S can't talk to {label}.",
                                  category=cat)]

    extra = f" (version {version})" if version else ""
    conn = make_result(conn_id, conn_title, OK, f"Connected to {label} at {url}{extra}.", "", cat, **data)

    raw_t = ctx.cfg_str("soulseek.transfer_path", "./Transfer")
    transfer = ctx.resolve_path(raw_t) if raw_t else ""
    if paths is None:
        return [conn, make_result(lib_id, lib_title, SKIPPED,
                                  f"{label} doesn't report where its music folder is, so SYNCHRO.S can't compare it with its "
                                  f"music library folder ({transfer}).",
                                  f"Make sure {label}'s music folder is the folder SYNCHRO.S saves finished music to.", cat)]
    if not paths:
        return [conn, make_result(lib_id, lib_title, WARNING,
                                  f"{label} has no music library, so nothing SYNCHRO.S downloads will show up there.",
                                  f"Add a music library in {label} that points at the folder SYNCHRO.S saves finished music to "
                                  f"({transfer}, or wherever that folder is mapped on your server).", cat,
                                  transfer=transfer)]
    lib_data = {"transfer": transfer, "library_paths": paths}
    candidates = [c for c in (transfer, raw_t) if c]
    if any(_contains(p, c) for p in paths for c in candidates):
        return [conn, make_result(lib_id, lib_title, OK,
                                  f"{label}'s music library ({', '.join(paths)}) includes SYNCHRO.S's music library folder.",
                                  "", cat, **lib_data)]
    if any(_contains(c, p) for p in paths for c in candidates):
        return [conn, make_result(lib_id, lib_title, WARNING,
                                  f"{label}'s music library ({', '.join(paths)}) only covers part of SYNCHRO.S's music library "
                                  f"folder ({transfer}), so some downloads won't show up.",
                                  f"Point {label}'s music library at {transfer} itself.", cat, **lib_data)]
    if ctx.in_container or not _is_local_host(url):
        return [conn, make_result(lib_id, lib_title, SKIPPED,
                                  f"{label} sees its music library at {', '.join(paths)}; SYNCHRO.S saves finished music to "
                                  f"{transfer}. They run separately, so one folder can have a different name in each, and "
                                  "SYNCHRO.S can't tell whether these are the same.",
                                  f"Make sure the folder mapped to {transfer} in SYNCHRO.S is the same folder on your server "
                                  f"that {label}'s music library uses.", cat, **lib_data)]
    return [conn, make_result(lib_id, lib_title, WARNING,
                              f"{label}'s music library is {', '.join(paths)}, but SYNCHRO.S saves finished music to {transfer}, "
                              f"so {label} won't pick up new downloads.",
                              f"Add {transfer} to {label}'s music library, or set SYNCHRO.S's Music Library Folder "
                              f"({_MUSIC_FOLDERS_SETTING}) to one of {label}'s library folders.", cat, **lib_data)]


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

@dataclass
class _Task:
    id: str
    title: str
    category: str
    fn: Callable[[], Any]
    network: bool = False


def _tasks(ctx: SetupCheckContext, include_network: bool) -> Tuple[List[_Task], List[Dict[str, Any]]]:
    specs, skipped = folder_specs(ctx)
    tasks = [_Task(s.id, s.title, "folders", (lambda s=s: check_folder(ctx, s))) for s in specs]
    tasks.append(_Task("folders.layout", "Folder layout", "folders", lambda: check_folder_layout(ctx, specs)))
    tasks.append(_Task("system.user", "User SYNCHRO.S runs as", "system", lambda: check_run_user(ctx)))
    if include_network:
        tasks += [
            _Task("slskd.connection", "slskd connection", "downloads", lambda: check_slskd_connection(ctx), True),
            _Task("slskd.download_folder", "slskd and SYNCHRO.S share the download folder", "downloads",
                  lambda: check_slskd_download_folder(ctx), True),
            _Task(_MEDIA_CONN_ID, _MEDIA_CONN_TITLE, _MEDIA_CAT, lambda: check_media_server(ctx), True),
        ]
    else:
        # settings only, so it's cheap enough here; the Setup check dot polls
        # this scope and should show that downloads can't reach the Library
        tasks.append(_Task(_MEDIA_CONN_ID, _MEDIA_CONN_TITLE, _MEDIA_CAT, lambda: check_library_choice(ctx)))
    tasks += _radio_tasks(ctx, include_network)
    return tasks, skipped


def _radio_tasks(ctx: SetupCheckContext, include_network: bool) -> List[_Task]:
    """fpcalc and the AcoustID key, while the Internet radio module is on
    (core/internet_radio/setup_rows.py)."""
    from core.modules import is_enabled
    if not is_enabled("radio", _ModulesConfig(ctx)):
        return []
    from core.internet_radio import setup_rows
    key = ctx.cfg_str("acoustid.api_key")
    return [
        _Task("radio.fpcalc", "Chromaprint (fpcalc) for radio", "radio",
              lambda: setup_rows.check_fpcalc(make_result, key_set=bool(key))),
        _Task("radio.acoustid", "AcoustID key for radio", "radio",
              lambda: setup_rows.check_acoustid(make_result, key, network=include_network), include_network),
    ]


class _ModulesConfig:
    """The context's settings in the shape core.modules reads."""

    def __init__(self, ctx: SetupCheckContext) -> None:
        self._ctx = ctx

    def get(self, key: str, default: Any = None) -> Any:
        return self._ctx.cfg(key, default)


def _run_tasks(tasks: Sequence[_Task], deadline_s: float) -> List[Dict[str, Any]]:
    """Each check on its own daemon thread, all bounded by one deadline: a hung
    NFS stat or a server that accepts and never answers can't stall the run."""
    slots: List[Optional[List[Dict[str, Any]]]] = [None] * len(tasks)

    def run(i: int, task: _Task) -> None:
        try:
            out = task.fn()
            slots[i] = list(out) if isinstance(out, (list, tuple)) else [out]
        except Exception as exc:  # noqa: BLE001 - one broken check must not sink the run
            logger.warning("setup check %s failed: %s", task.id, exc, exc_info=True)
            slots[i] = [make_result(task.id, task.title, SKIPPED,
                                    f"This check couldn't run because of an internal error ({type(exc).__name__}: {exc}).",
                                    "This is probably a SYNCHRO.S bug; please report it with your debug info.", task.category)]

    threads = []
    for i, task in enumerate(tasks):
        th = threading.Thread(target=run, args=(i, task), name=f"setup-check-{task.id}", daemon=True)
        th.start()
        threads.append(th)
    end = time.monotonic() + deadline_s
    for th in threads:
        th.join(max(0.0, end - time.monotonic()))

    results: List[Dict[str, Any]] = []
    for i, task in enumerate(tasks):
        got = slots[i]
        if got is None:
            hint = ("a server may be slow or not answering" if task.network
                    else "a drive or network share may be hanging")
            results.append(make_result(task.id, task.title, WARNING,
                                       f"This check didn't finish within {deadline_s:g} seconds; {hint}.",
                                       "Check that your drives, shares and servers respond, then run the check again.",
                                       task.category))
        else:
            results.extend(got)
    return results


def run_setup_check(ctx: Optional[SetupCheckContext] = None, *, include_network: bool = True,
                    deadline_s: Optional[float] = None) -> Dict[str, Any]:
    """Run every check. Returns ``{status, summary, checks, ran_at, duration_ms, scope}``."""
    started = time.monotonic()
    ctx = ctx or build_context()
    try:
        tasks, skipped = _tasks(ctx, include_network)
    except Exception as exc:  # noqa: BLE001 - config unreadable: report rather than raise
        logger.warning("setup check could not read settings: %s", exc, exc_info=True)
        tasks, skipped = [], [make_result("settings", "Settings", ERROR, f"SYNCHRO.S couldn't read its settings ({exc}).",
                                          "Restart SYNCHRO.S; if this keeps happening, report it with your debug info.",
                                          "system")]
    deadline = deadline_s if deadline_s is not None else (DEFAULT_DEADLINE_S if include_network else LOCAL_DEADLINE_S)
    checks = _run_tasks(tasks, deadline) + skipped
    return {
        "status": worst_status(c["status"] for c in checks),
        "summary": summarize(checks),
        "checks": checks,
        "scope": "all" if include_network else "local",
        "ran_at": time.time(),
        "duration_ms": int((time.monotonic() - started) * 1000),
    }


def debug_summary(ctx: Optional[SetupCheckContext] = None) -> Dict[str, Any]:
    """Local checks only (folders, layout, user, whether a library is chosen):
    cheap enough for debug-info, which must not wait on slskd or a media server."""
    report = run_setup_check(ctx, include_network=False, deadline_s=LOCAL_DEADLINE_S)
    return {
        "status": report["status"],
        "summary": report["summary"],
        "scope": report["scope"],
        "problems": [{"id": c["id"], "status": c["status"]} for c in report["checks"]
                     if c["status"] in (WARNING, ERROR)],
    }


__all__ = [
    "OK", "WARNING", "ERROR", "SKIPPED", "STATUSES",
    "SetupCheckContext", "FolderSpec", "build_context", "configure",
    "check_folder", "check_folder_layout", "check_run_user", "check_slskd_connection",
    "check_slskd_download_folder", "check_media_server", "check_library_choice", "folder_specs",
    "run_setup_check", "debug_summary", "summarize", "worst_status", "make_result",
    "parse_mountinfo", "mount_for", "is_anonymous_volume", "soulseek_in_use", "slskd_logged_in",
    "remember_report", "last_report",
]


# ── the last full run, for the Automation Assistant ─────────────────────────
# The Assistant tells an admin what Setup check last said without running it
# again (a full run probes slskd and the media server). Only what's needed is
# kept: the summary and the checks that weren't OK.
_last_report: Optional[Dict[str, Any]] = None


def remember_report(report: Mapping[str, Any]) -> None:
    global _last_report
    try:
        _last_report = {
            "ran_at": float(report.get("ran_at") or time.time()),
            "scope": report.get("scope"),
            "summary": dict(report.get("summary") or {}),
            "problems": [
                {"title": c.get("title"), "status": c.get("status"), "detail": c.get("detail")}
                for c in report.get("checks") or [] if c.get("status") in ("warning", "error")
            ][:12],
        }
    except Exception as exc:  # noqa: BLE001 - a cache that can't be kept is just empty
        logger.debug("setup check report not kept: %s", exc)


def last_report(max_age_seconds: float = 24 * 3600) -> Optional[Dict[str, Any]]:
    """The last full run's summary and problems, when it's recent enough."""
    report = _last_report
    if not report or time.time() - report["ran_at"] > max_age_seconds:
        return None
    return dict(report)
