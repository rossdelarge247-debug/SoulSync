"""slskd and the media servers, repointed at the drive move's switch.

**slskd.** Its shared folders (``shares.directories``), its filters
(``shares.filters``) and its download folder (``directories.downloads``) live
in ``slskd.yml``. slskd's API can read and write that file only with remote
configuration on *and* a signed-in session (``OptionsController`` takes JWT
only, never the API key SYNCHRO.S holds). So the Docker step's helper gives
SYNCHRO.S slskd's config folder (``<slskd's /app>:/slskd-config``), and the
switch edits ``slskd.yml`` there with the comment-keeping block editor. slskd
watches the file and applies new shares at once; SYNCHRO.S then asks it to
rescan (``PUT /api/v0/shares``, which the API key may do). YAML outranks
``SLSKD_SHARED_DIR`` (slskd loads the file after the environment). A new
download folder needs slskd to restart, which its API allows only for a
signed-in admin: the Check step asks for slskd's sign-in once when Downloads
moves, and only the session token it gives is kept (encrypted) for the switch.

**Media servers.** Plex (``PUT /library/sections/<id>`` through plexapi's
``addLocations`` / ``removeLocations``) and Jellyfin
(``/Library/VirtualFolders/Paths``) can gain a folder in the Music library and
lose the old one later, so play counts carry over: the switch adds the new
folder and keeps the old until the old copies are removed. Navidrome reads its
music folder from its own settings (``ND_MUSICFOLDER``), not its API, so the
move says how to change it.

Every call that can refuse raises :class:`ServiceRefused` with a sentence.
"""

from __future__ import annotations

import os
import time
from typing import Any, Callable, Dict, List, Optional

from core.drives import compose_tool as yaml_blocks
from utils.logging_config import get_logger

logger = get_logger("drives.services")

SLSKD_CONFIG_DIR_ENV = "SOULSYNC_SLSKD_CONFIG_DIR"
SLSKD_CONFIG_DIR = "/slskd-config"
APPLEDOUBLE_FILTER = r"/\._[^/]*$"
TIMEOUT = 15


class ServiceRefused(RuntimeError):
    """A service didn't take the change; ``str(exc)`` says which and why."""


# ── slskd ─────────────────────────────────────────────────────────────────────

def _requests():
    import requests
    return requests


class Slskd:
    """slskd through its config file and its API. ``client`` is the app's
    SoulseekClient (base_url, api_key); ``http`` is ``requests`` (tests pass a
    fake); ``sleep`` waits."""

    def __init__(self, client: Any = None, *, config_dir: Optional[str] = None, http: Any = None,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self._client = client
        self._dir = config_dir
        self._http = http
        self._sleep = sleep

    # -- where --

    @property
    def http(self):
        return self._http or _requests()

    def client(self):
        if self._client is None:
            from core.soulseek_client import get_shared_soulseek_client
            self._client = get_shared_soulseek_client()
        return self._client

    def configured(self) -> bool:
        try:
            c = self.client()
            return bool(getattr(c, "base_url", None))
        except Exception:  # noqa: BLE001
            return False

    def config_dir(self) -> str:
        return self._dir or os.environ.get(SLSKD_CONFIG_DIR_ENV) or SLSKD_CONFIG_DIR

    def config_path(self) -> Optional[str]:
        """``slskd.yml`` in the folder the helper mounted, when it's there."""
        path = os.path.join(self.config_dir(), "slskd.yml")
        try:
            if os.path.isfile(path) and not os.path.islink(path):
                return path
        except OSError:
            pass
        return None

    def can_edit(self) -> bool:
        path = self.config_path()
        return bool(path) and os.access(path, os.W_OK)

    # -- the API --

    def _url(self, endpoint: str) -> str:
        return f"{self.client().base_url.rstrip('/')}/api/v0/{endpoint}"

    def _headers(self, token: Optional[str] = None) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        else:
            key = getattr(self.client(), "api_key", "") or ""
            if key:
                headers["X-API-Key"] = key
        return headers

    def options(self) -> Optional[Dict[str, Any]]:
        try:
            r = self.http.get(self._url("options"), headers=self._headers(), timeout=TIMEOUT)
            return r.json() if r.status_code == 200 else None
        except Exception as exc:  # noqa: BLE001
            logger.debug("slskd options unreadable: %s", exc)
            return None

    def shared_directories(self) -> List[str]:
        opts = self.options() or {}
        shares = opts.get("shares") or {}
        dirs = shares.get("directories") or []
        return [str(d) for d in dirs] if isinstance(dirs, list) else []

    def share_count(self) -> Optional[int]:
        try:
            r = self.http.get(self._url("application"), headers=self._headers(), timeout=TIMEOUT)
            if r.status_code != 200:
                return None
            shares = (r.json() or {}).get("shares") or {}
            files = shares.get("files")
            return int(files) if files is not None else None
        except Exception as exc:  # noqa: BLE001
            logger.debug("slskd share count unreadable: %s", exc)
            return None

    def listed_shares(self) -> List[str]:
        """The local folders slskd's last scan shared."""
        try:
            r = self.http.get(self._url("shares"), headers=self._headers(), timeout=TIMEOUT)
            if r.status_code != 200:
                return []
            out = []
            for shares in (r.json() or {}).values():
                for share in shares if isinstance(shares, list) else []:
                    if isinstance(share, dict) and share.get("localPath") and not share.get("isExcluded"):
                        out.append(str(share["localPath"]))
            return out
        except Exception as exc:  # noqa: BLE001
            logger.debug("slskd shares unreadable: %s", exc)
            return []

    def scanning(self) -> bool:
        try:
            r = self.http.get(self._url("application"), headers=self._headers(), timeout=TIMEOUT)
            return bool(((r.json() or {}).get("shares") or {}).get("scanning")) if r.status_code == 200 else False
        except Exception:  # noqa: BLE001
            return False

    def rescan(self) -> None:
        try:
            r = self.http.put(self._url("shares"), headers=self._headers(), timeout=TIMEOUT)
        except Exception as exc:  # noqa: BLE001
            raise ServiceRefused(f"slskd didn't answer when asked to rescan what it shares ({type(exc).__name__}).") from None
        if r.status_code not in (200, 201, 204):
            raise ServiceRefused(f"slskd refused to rescan what it shares (HTTP {r.status_code}).")

    def sign_in(self, username: str, password: str) -> str:
        """A session token for slskd's admin, from its own sign-in."""
        try:
            r = self.http.post(self._url("session"), json={"username": username, "password": password},
                               headers={"Content-Type": "application/json"}, timeout=TIMEOUT)
        except Exception as exc:  # noqa: BLE001
            raise ServiceRefused(f"slskd didn't answer ({type(exc).__name__}).") from None
        if r.status_code != 200:
            raise ServiceRefused("slskd didn't accept that user name and password.")
        token = (r.json() or {}).get("token")
        if not token:
            raise ServiceRefused("slskd didn't hand back a session.")
        return str(token)

    def restart(self, token: str, *, wait: float = 120.0) -> None:
        """Restart slskd (it needs one to use a new download folder) and wait
        until it answers again."""
        try:
            r = self.http.put(self._url("application"), headers=self._headers(token), timeout=TIMEOUT)
        except Exception as exc:  # noqa: BLE001
            raise ServiceRefused(f"slskd didn't answer when asked to restart ({type(exc).__name__}).") from None
        if r.status_code not in (200, 201, 204):
            raise ServiceRefused(f"slskd refused to restart (HTTP {r.status_code}); its sign-in may have expired.")
        deadline = time.time() + wait
        self._sleep(3)
        while time.time() < deadline:
            try:
                r = self.http.get(self._url("application"), headers=self._headers(), timeout=5)
                if r.status_code == 200:
                    return
            except Exception:  # noqa: BLE001,S110 - it's still restarting
                pass
            self._sleep(2)
        raise ServiceRefused("slskd didn't come back after its restart.")

    # -- the file --

    def read_config(self) -> str:
        path = self.config_path()
        if not path:
            raise ServiceRefused("SYNCHRO.S can't reach slskd's settings file (slskd.yml); the Docker step's "
                                 "helper adds that.")
        with open(path, "rb") as f:
            return f.read().decode("utf-8")

    def write_config(self, text: str) -> None:
        path = self.config_path()
        if not path:
            raise ServiceRefused("SYNCHRO.S can't reach slskd's settings file (slskd.yml).")
        tmp = path + ".synchros-tmp"
        try:
            with open(tmp, "wb") as f:
                f.write(text.encode("utf-8"))
                f.flush()
                os.fsync(f.fileno())
            try:
                os.chmod(tmp, os.stat(path).st_mode & 0o7777)
            except OSError:
                pass
            os.replace(tmp, path)
        except OSError as exc:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise ServiceRefused(f"SYNCHRO.S couldn't write slskd.yml ({exc.strerror or exc}).") from None


def plan_slskd_config(text: str, *, share_old: Optional[str], share_new: Optional[str],
                      current_shares: List[str], downloads_new: Optional[str],
                      skip_appledouble: bool) -> Dict[str, Any]:
    """The new slskd.yml text and what changed. ``current_shares`` is what
    slskd shares now (its API); ``share_old`` is the folder in it that is the
    library (slskd's own path for it), replaced by ``share_new``."""
    out = text
    changed: List[str] = []
    if share_new:
        dirs = list(current_shares)
        if share_old and share_old in dirs:
            dirs = [share_new if d == share_old else d for d in dirs]
        elif share_new not in dirs:
            dirs = [share_new] + [d for d in dirs if d != share_old]
        out = yaml_blocks.set_seq(out, ["shares", "directories"], dirs)
        changed.append("shares")
    if skip_appledouble:
        filters = yaml_blocks.get_seq(out, ["shares", "filters"])
        if APPLEDOUBLE_FILTER not in filters:
            out = yaml_blocks.set_seq(out, ["shares", "filters"], filters + [APPLEDOUBLE_FILTER])
            changed.append("filters")
    if downloads_new:
        out = yaml_blocks.set_scalar(out, ["directories", "downloads"], downloads_new)
        changed.append("downloads")
    return {"text": out, "changed": changed}


def library_share_in(slskd_dirs: List[str], hint: Optional[str] = None) -> Optional[str]:
    """Which of slskd's shared folders is the library: the one the setting
    names, else the only one, else one called music / library / transfer."""
    if hint and hint in slskd_dirs:
        return hint
    plain = [d for d in slskd_dirs if not d.startswith(("-", "!"))]
    if len(plain) == 1:
        return plain[0]
    for name in ("music", "library", "transfer"):
        for d in plain:
            if os.path.basename(d.rstrip("/")).lower() == name:
                return d
    return None


# ── media servers ─────────────────────────────────────────────────────────────

class MediaServer:
    """What the move asks of a media server. The base is "nothing to do"
    (SYNCHRO.S's own player, or none set up)."""

    name = "none"
    label = ""
    api = False

    def can_see(self, path: str) -> Optional[bool]:
        return None

    def locations(self) -> List[str]:
        return []

    def add_location(self, path: str) -> None:
        return None

    def remove_location(self, path: str) -> None:
        return None

    def rescan(self) -> None:
        return None


class PlexServer(MediaServer):
    name = "plex"
    label = "Plex"
    api = True

    def __init__(self, client: Any) -> None:
        self._client = client

    def _section(self):
        c = self._client
        if not c.ensure_connection() or not c.server:
            raise ServiceRefused("Plex didn't answer.")
        section = getattr(c, "music_library", None)
        if section is None:
            sections = [s for s in c.server.library.sections() if s.type == "artist"]
            if not sections:
                raise ServiceRefused("Plex has no Music library.")
            section = sections[0]
        return section

    def can_see(self, path: str) -> Optional[bool]:
        try:
            c = self._client
            if not c.ensure_connection() or not c.server:
                return None
            c.server.browse(path, includeFiles=False)
            return True
        except Exception as exc:  # noqa: BLE001 - Plex says not found for a folder it can't see
            logger.debug("Plex can't browse %s: %s", path, type(exc).__name__)
            return False

    def locations(self) -> List[str]:
        try:
            section = self._section()
            section.reload()
            return [str(p) for p in (section.locations or [])]
        except ServiceRefused:
            return []
        except Exception as exc:  # noqa: BLE001
            logger.debug("Plex locations unreadable: %s", exc)
            return []

    def add_location(self, path: str) -> None:
        try:
            self._section().addLocations(path)
        except ServiceRefused:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ServiceRefused(f"Plex didn't add the folder to its Music library ({type(exc).__name__}).") from None

    def remove_location(self, path: str) -> None:
        try:
            self._section().removeLocations(path)
        except ServiceRefused:
            raise
        except Exception as exc:  # noqa: BLE001
            raise ServiceRefused(f"Plex didn't remove the old folder from its Music library ({type(exc).__name__}).") from None

    def rescan(self) -> None:
        try:
            self._section().update()
        except Exception as exc:  # noqa: BLE001 - a scan request is a nicety
            logger.debug("Plex scan request failed: %s", exc)


class JellyfinServer(MediaServer):
    name = "jellyfin"
    label = "Jellyfin"
    api = True

    def __init__(self, client: Any, http: Any = None) -> None:
        self._client = client
        self._http = http

    @property
    def http(self):
        return self._http or _requests()

    def _base(self):
        c = self._client
        if hasattr(c, "ensure_connection"):
            c.ensure_connection()
        if not getattr(c, "base_url", None) or not getattr(c, "api_key", None):
            raise ServiceRefused("Jellyfin isn't set up.")
        from core.jellyfin_client import jellyfin_auth_headers
        return c.base_url.rstrip("/"), {**jellyfin_auth_headers(c.api_key), "Content-Type": "application/json"}

    def _library(self) -> Dict[str, Any]:
        base, headers = self._base()
        r = self.http.get(f"{base}/Library/VirtualFolders", headers=headers, timeout=TIMEOUT)
        if r.status_code != 200:
            raise ServiceRefused(f"Jellyfin didn't list its libraries (HTTP {r.status_code}).")
        folders = r.json() or []
        wanted = str(getattr(self._client, "music_library_id", "") or "")
        music = [f for f in folders if str(f.get("CollectionType") or "").lower() == "music"]
        for f in music:
            if wanted and str(f.get("ItemId")) == wanted:
                return f
        if not music:
            raise ServiceRefused("Jellyfin has no Music library.")
        return music[0]

    def can_see(self, path: str) -> Optional[bool]:
        try:
            base, headers = self._base()
            r = self.http.post(f"{base}/Environment/ValidatePath", headers=headers,
                               json={"Path": path, "ValidateWritable": False, "IsFile": False}, timeout=TIMEOUT)
            return r.status_code in (200, 204)
        except ServiceRefused:
            return None
        except Exception:  # noqa: BLE001
            return None

    def locations(self) -> List[str]:
        try:
            return [str(p) for p in (self._library().get("Locations") or [])]
        except Exception:  # noqa: BLE001
            return []

    def add_location(self, path: str) -> None:
        base, headers = self._base()
        lib = self._library()
        r = self.http.post(f"{base}/Library/VirtualFolders/Paths", headers=headers, params={"refreshLibrary": "true"},
                           json={"Name": lib.get("Name"), "PathInfo": {"Path": path}}, timeout=TIMEOUT)
        if r.status_code not in (200, 204):
            raise ServiceRefused(f"Jellyfin didn't add the folder to its Music library (HTTP {r.status_code}).")

    def remove_location(self, path: str) -> None:
        base, headers = self._base()
        lib = self._library()
        r = self.http.delete(f"{base}/Library/VirtualFolders/Paths", headers=headers,
                             params={"name": lib.get("Name"), "path": path, "refreshLibrary": "true"}, timeout=TIMEOUT)
        if r.status_code not in (200, 204):
            raise ServiceRefused(f"Jellyfin didn't remove the old folder (HTTP {r.status_code}).")


class NavidromeServer(MediaServer):
    """Navidrome's music folder is its own setting, not its API."""

    name = "navidrome"
    label = "Navidrome"
    api = False


def media_server(active: Optional[str], clients: Dict[str, Any]) -> MediaServer:
    if active == "plex" and clients.get("plex") is not None:
        return PlexServer(clients["plex"])
    if active == "jellyfin" and clients.get("jellyfin") is not None:
        return JellyfinServer(clients["jellyfin"])
    if active == "navidrome":
        return NavidromeServer()
    return MediaServer()


def old_location(locations: List[str], sample_paths: List[str]) -> Optional[str]:
    """Which of the media server's folders is the library: the only one, or
    the one most of the library's stored (server) paths are under."""
    if len(locations) == 1:
        return locations[0]
    best, hits = None, 0
    for loc in locations:
        prefix = loc.rstrip("/") + "/"
        n = sum(1 for p in sample_paths if str(p).startswith(prefix))
        if n > hits:
            best, hits = loc, n
    return best if hits else None


__all__ = ["APPLEDOUBLE_FILTER", "JellyfinServer", "MediaServer", "NavidromeServer", "PlexServer", "ServiceRefused",
           "Slskd", "library_share_in", "media_server", "old_location", "plan_slskd_config"]
