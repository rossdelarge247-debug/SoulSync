"""The Docker step's helper script and its one-use token (boards 14c, 14d).

An admin opens the Docker step; SYNCHRO.S mints a token and shows one line to
paste into the computer's Terminal::

    cd ~/SoulSync && curl -fsSL 'http://<this address>/api/drives/helper.sh?t=<token>' -o drives-helper.sh && echo '<sha256>  drives-helper.sh' | shasum -a 256 -c - && sh drives-helper.sh

(``sha256sum -c -`` on Linux.) The address is checked against a strict set
of URL characters and quoted for the shell, and the script only runs when it
is byte for byte the one SYNCHRO.S serves.

The script is saved (so ``sh drives-helper.sh --undo`` works later, and so its
question can be answered from the keyboard, which a piped script can't) and
run. It carries :mod:`core.drives.compose_tool` verbatim and runs it with the
computer's ``python3``.

The token is the only credential the script route takes (curl has no
session): 32 random bytes, kept only as a SHA-256 hash, good for one fetch
within ``TOKEN_TTL_SECONDS``, compared in constant time, and minting a new one
retires the old. Tokens are never logged.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import shlex
import threading
import time
from typing import Callable, Dict, Optional

TOKEN_TTL_SECONDS = 10 * 60
TOKEN_BYTES = 32
SCRIPT_NAME = "drives-helper.sh"
DEFAULT_COMPOSE_FOLDER = "~/SoulSync"
_FOLDER_OK = re.compile(r"^[A-Za-z0-9 _./~@+-]{1,300}$")
#: SYNCHRO.S's own address as the browser used it: a scheme, a host (a name,
#: an IPv4 or a bracketed IPv6 address), an optional port and a plain path
_BASE_OK = re.compile(r"^https?://(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~/-]*)?$")


def _hash(token: str) -> bytes:
    return hashlib.sha256(token.encode("utf-8")).digest()


class HelperTokens:
    """One live token at a time; one fetch each."""

    def __init__(self, *, ttl: int = TOKEN_TTL_SECONDS, clock: Callable[[], float] = time.time) -> None:
        self.ttl = int(ttl)
        self._clock = clock
        self._lock = threading.Lock()
        self._live: Optional[Dict[str, object]] = None

    def mint(self, profile_id: int) -> Dict[str, object]:
        token = secrets.token_urlsafe(TOKEN_BYTES)
        now = self._clock()
        with self._lock:
            self._live = {"hash": _hash(token), "expires": now + self.ttl, "used": False,
                          "profile_id": int(profile_id), "minted": now}
        return {"token": token, "expires_at": int(now + self.ttl)}

    def consume(self, token: object) -> bool:
        """True once for the live token, inside its time; never again."""
        if not isinstance(token, str) or not token or len(token) > 200:
            return False
        given = _hash(token)
        with self._lock:
            live = self._live
            if live is None:
                # still compare, so a missing token takes as long as a wrong one
                hmac.compare_digest(given, b"\0" * 32)
                return False
            match = hmac.compare_digest(given, live["hash"])  # type: ignore[arg-type]
            if not match or live["used"] or self._clock() > float(live["expires"]):  # type: ignore[arg-type]
                return False
            live["used"] = True
            return True

    def state(self) -> Dict[str, object]:
        """For the step: whether the live token has been fetched or expired."""
        with self._lock:
            live = self._live
            if live is None:
                return {"state": "none"}
            if live["used"]:
                return {"state": "used"}
            if self._clock() > float(live["expires"]):  # type: ignore[arg-type]
                return {"state": "expired"}
            return {"state": "live", "expires_at": int(float(live["expires"]))}  # type: ignore[arg-type]

    def revoke(self) -> None:
        with self._lock:
            self._live = None


TOKENS = HelperTokens()


def clean_compose_folder(value: object) -> str:
    """The install's folder as typed, or ValueError: plain characters only,
    since it goes into a command the person pastes into a shell."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return DEFAULT_COMPOSE_FOLDER
    if not isinstance(value, str):
        raise ValueError("Write the folder as a path, like ~/SoulSync.")
    text = value.strip()
    if not _FOLDER_OK.match(text) or ".." in text.split("/"):
        raise ValueError("Use letters, numbers, spaces and / . _ - ~ only, like ~/SoulSync.")
    if not (text.startswith("~") or text.startswith("/")):
        raise ValueError("Start the folder with ~/ or /, like ~/SoulSync.")
    return text


def _shell_folder(folder: str) -> str:
    """``folder`` for ``cd``: ``~/`` left bare so the shell expands it, the
    rest quoted."""
    if folder == "~":
        return "~"
    if folder.startswith("~/"):
        rest = folder[2:]
        return "~/" + (f'"{rest}"' if rest and not re.fullmatch(r"[A-Za-z0-9_./-]+", rest) else rest)
    return f'"{folder}"' if not re.fullmatch(r"[A-Za-z0-9_./-]+", folder) else folder


def clean_base_url(value: object) -> str:
    """SYNCHRO.S's address for the command, or ValueError: it goes into a
    line the person pastes into a shell, so only plain URL characters."""
    if not isinstance(value, str) or len(value) > 500:
        raise ValueError("SYNCHRO.S's address can't go into a command.")
    text = value.strip().rstrip("/")
    if not _BASE_OK.match(text):
        raise ValueError("SYNCHRO.S's address has characters that can't go into a command. Open SYNCHRO.S "
                         "by its plain address (like http://192.168.1.20:8008) and try again.")
    return text


def script_sha256() -> str:
    return hashlib.sha256(script().encode("utf-8")).hexdigest()


def command(base_url: str, token: str, folder: str, platform: str = "mac", *, names: bool = False) -> str:
    """The line to paste (Mac and Linux): fetch the script, check it is the
    one SYNCHRO.S serves (``shasum`` on a Mac, ``sha256sum`` on Linux), run it.
    With ``names`` it runs ``--names``: only the folders' host hints."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", token or ""):
        raise ValueError("bad token")
    url = f"{clean_base_url(base_url)}/api/drives/helper.sh?t={token}"
    check = "shasum -a 256 -c -" if platform == "mac" else "sha256sum -c -"
    return (f"cd {_shell_folder(folder)} && curl -fsSL {shlex.quote(url)} -o {SCRIPT_NAME} && "
            f"echo '{script_sha256()}  {SCRIPT_NAME}' | {check} && sh {SCRIPT_NAME}" + (" --names" if names else ""))


def undo_command(folder: str) -> str:
    return f"cd {_shell_folder(folder)} && sh {SCRIPT_NAME} --undo"


def _tool_source() -> str:
    path = os.path.join(os.path.dirname(__file__), "compose_tool.py")
    with open(path, encoding="utf-8") as f:
        return f.read()


SCRIPT_TEMPLATE = r"""#!/bin/sh
# SYNCHRO.S drives helper.
# Lets SYNCHRO.S, slskd and your media server see this computer's drives, so
# SYNCHRO.S can move your music to another drive. Your music isn't touched.
#
# Run it in the folder with docker-compose.yml:
#   sh drives-helper.sh            shows the lines it adds and asks first
#   sh drives-helper.sh --dry-run  only shows them
#   sh drives-helper.sh --undo     puts docker-compose.before-drives.yml back
#                                  (only while the file is as the helper left it)
#   sh drives-helper.sh --names    only tells SYNCHRO.S your folders' names on
#                                  this computer (no change to the set-up file)
#
# It keeps a copy of your set-up file as docker-compose.before-drives.yml
# before it changes a line, edits the file with a small Python program (below,
# readable) rather than sed, checks the result with `docker compose config`
# (together with docker-compose.override.yml or COMPOSE_FILE's files), and
# restarts with `docker compose up -d`.
set -u

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker isn't installed on this computer, or isn't on its PATH. Nothing changed."
  exit 3
fi

PY=""
for c in python3 python; do
  p=$(command -v "$c" 2>/dev/null) || continue
  if [ "$(uname)" = "Darwin" ] && [ "$p" = "/usr/bin/$c" ] && ! xcode-select -p >/dev/null 2>&1; then
    # macOS's own python3 is only a stub until the Command Line Tools are installed
    continue
  fi
  if "$p" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)' >/dev/null 2>&1; then
    PY="$p"
    break
  fi
done
if [ -z "$PY" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    echo "This helper needs python3, which comes with Apple's Command Line Tools."
    echo "Run:  xcode-select --install   (step 1 of the Mac guide), then paste the command again."
  else
    echo "This helper needs python3. Install it (for example: sudo apt install python3), then run it again."
  fi
  echo "Nothing changed. You can also add the lines by hand: SYNCHRO.S shows them under “See the lines it adds”."
  exit 10
fi

TMP=$(mktemp "${TMPDIR:-/tmp}/synchros-drives.XXXXXX") || { echo "Couldn't make a temporary file. Nothing changed."; exit 11; }
trap 'rm -f "$TMP"' EXIT INT TERM
cat > "$TMP" <<'SYNCHROS_DRIVES_TOOL'
__TOOL__
SYNCHROS_DRIVES_TOOL
"$PY" "$TMP" "$@"
"""


def script() -> str:
    """The helper script, with the compose tool in it."""
    tool = _tool_source()
    if "SYNCHROS_DRIVES_TOOL" in tool:
        raise RuntimeError("the tool's source can't hold the heredoc's end word")
    return SCRIPT_TEMPLATE.replace("__TOOL__", tool.rstrip("\n"))


__all__ = ["DEFAULT_COMPOSE_FOLDER", "HelperTokens", "SCRIPT_NAME", "TOKENS", "TOKEN_TTL_SECONDS",
           "clean_base_url", "clean_compose_folder", "command", "script", "script_sha256", "undo_command"]
