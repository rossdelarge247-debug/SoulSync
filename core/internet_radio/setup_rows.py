"""Setup check's two radio rows, shown while the Internet radio module is on.

- ``radio.fpcalc``: is Chromaprint's ``fpcalc`` installed (the fingerprint
  fallback needs it). Looked for on the PATH and in SoulSync's own ``bin``,
  without downloading it.
- ``radio.acoustid``: is an AcoustID key set, and (in a full run) does
  AcoustID accept it.

The last result is kept for Settings → Radio's status line.
"""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

_BIN_DIR = Path(__file__).resolve().parent.parent.parent / "bin"
_SETTING = "Settings → Radio → Track identification"

_last: Dict[str, Dict[str, Any]] = {}


def find_fpcalc() -> Optional[str]:
    found = shutil.which("fpcalc") or shutil.which("fpcalc.exe")
    if found:
        return found
    for name in ("fpcalc", "fpcalc.exe"):
        local = _BIN_DIR / name
        if local.exists() and os.access(local, os.X_OK):
            return str(local)
    return None


def _remember(row: Dict[str, Any]) -> Dict[str, Any]:
    _last[row["id"]] = {"status": row["status"], "detail": row["detail"], "checked_at": time.time()}
    return row


def check_fpcalc(make_result: Callable[..., Dict[str, Any]], *, finder: Callable[[], Optional[str]] = find_fpcalc,
                 key_set: bool = True) -> Dict[str, Any]:
    """Missing fpcalc is a warning once an AcoustID key says fingerprints
    are wanted; before that it's only noted (skipped), so turning radio on
    doesn't add a warning for an optional fallback."""
    path = finder()
    if path:
        return _remember(make_result("radio.fpcalc", "Chromaprint (fpcalc) for radio", "ok",
                                     "fpcalc is installed, so radio can fingerprint a track nothing else names.",
                                     "", "radio", path=path))
    return _remember(make_result(
        "radio.fpcalc", "Chromaprint (fpcalc) for radio", "warning" if key_set else "skipped",
        "fpcalc isn't installed, so radio can't fingerprint tracks. Stations' own feeds and stream titles still work.",
        "Install Chromaprint (the fpcalc command; libchromaprint-tools on Debian and Ubuntu), or use the Docker "
        "image, which includes it.", "radio"))


def check_acoustid(make_result: Callable[..., Dict[str, Any]], key: str, *, network: bool,
                   tester: Optional[Callable[[str], tuple]] = None) -> Dict[str, Any]:
    if not key:
        return _remember(make_result(
            "radio.acoustid", "AcoustID key for radio", "skipped",
            "No AcoustID key is set, so radio doesn't fingerprint tracks. Stations' own feeds and stream "
            "titles still name what's playing.",
            f"Get a free application key at acoustid.org and add it in {_SETTING}.", "radio"))
    if not network:
        return make_result("radio.acoustid", "AcoustID key for radio", "ok",
                           "An AcoustID key is set. A full check asks AcoustID whether it accepts it.", "", "radio")
    if tester is None:
        def tester(k):
            from core.acoustid_client import AcoustIDClient
            return AcoustIDClient(api_key=k).test_api_key()
    try:
        ok, message = tester(key)
    except Exception as exc:  # noqa: BLE001 - an error is a finding, not a crash
        ok, message = False, f"The check failed ({exc})."
    if ok:
        return _remember(make_result("radio.acoustid", "AcoustID key for radio", "ok",
                                     "AcoustID answered and accepted the key.", "", "radio"))
    lowered = str(message or "").lower()
    if "invalid" in lowered:
        return _remember(make_result("radio.acoustid", "AcoustID key for radio", "error",
                                     "AcoustID refused the key.",
                                     f"Use an application key from acoustid.org/new-application in {_SETTING}.",
                                     "radio"))
    return _remember(make_result("radio.acoustid", "AcoustID key for radio", "warning",
                                 f"AcoustID didn't answer: {message}", "Run the check again later.", "radio"))


def last(check_id: str) -> Optional[Dict[str, Any]]:
    return dict(_last[check_id]) if check_id in _last else None


def forget() -> None:
    _last.clear()


__all__ = ["find_fpcalc", "check_fpcalc", "check_acoustid", "last", "forget"]
