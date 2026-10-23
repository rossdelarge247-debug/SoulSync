"""Scan now's identification services: AcoustID, AudD and ACRCloud.

Each takes a short clip on disk (about 10 seconds, mono WAV when ffmpeg is
there) and answers with a :class:`ProviderResult`: a match, no match, or an
error in plain words. Nothing here is called except when a person presses
Scan now (and the admin's Test buttons in Settings → Radio); the paid services
are never used by the automatic identification.

Every request goes through the outbound guard
(``core/security/outbound.py``): public addresses only, TLS verified, no
redirects followed for a request with a body, timeouts on connect and read,
the answer capped. AcoustID's lookup is the shared one in
``core/acoustid_api.py``, which the download identifier uses too. The hosts are fixed here (AcoustID's and AudD's API
hosts); ACRCloud's is the admin's project host, accepted only under
``acrcloud.com`` (:func:`core.internet_radio.settings.acrcloud_host`).

Keys go in the request body only. They are never logged, never put in a
message, and never sent anywhere but their own service.

What each service says is mapped from its documented answers as known when
this was written (the build sandbox couldn't reach the providers' docs or
APIs): see the notes on each function.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import io
import json
import subprocess
import time
import wave
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from core import acoustid_api
from core.internet_radio.net import USER_AGENT
from core.internet_radio.settings import acrcloud_host
from core.security.outbound import RequestFailed, guarded_json, guarded_request
from utils.logging_config import get_logger

logger = get_logger("internet_radio.scan")

ACOUSTID_URL = acoustid_api.ACOUSTID_URL
AUDD_URL = "https://api.audd.io/"
ACRCLOUD_PATH = "/v1/identify"

ACOUSTID_MIN_SCORE = 0.7     # the rule the automatic fingerprint already uses
ACRCLOUD_MIN_SCORE = 70      # ACRCloud scores 0-100
TIMEOUT = (5, 25)            # connect, read
MAX_ANSWER_BYTES = 512 * 1024
FPCALC_SECONDS = 10

LABELS = {"acoustid": "AcoustID", "audd": "AudD", "acrcloud": "ACRCloud"}
ERROR_KINDS = ("bad_key", "out_of_credit", "rate_limited", "offline", "bad_audio", "provider_error")


@dataclass
class ProviderResult:
    provider: str
    status: str                      # match | no_match | error
    artist: str = ""
    title: str = ""
    release: str = ""
    score: Optional[float] = None    # 0-1
    error: Optional[str] = None      # one of ERROR_KINDS
    message: str = ""                # a sentence safe to show; never a key

    @property
    def matched(self) -> bool:
        return self.status == "match"


def error_words(provider: str, kind: Optional[str]) -> str:
    label = LABELS.get(provider, provider)
    return {
        "bad_key": f"{label} refused the key. An admin can check it in Settings → Radio.",
        "out_of_credit": f"{label} says this account has no requests left for now.",
        "rate_limited": f"{label} is getting too many requests. Try again in a minute.",
        "offline": f"{label} didn't answer. It may be down, or this server can't reach it.",
        "bad_audio": f"{label} couldn't read the clip.",
    }.get(kind or "", f"{label} answered with an error.")


def _error(provider: str, kind: str) -> ProviderResult:
    return ProviderResult(provider=provider, status="error", error=kind, message=error_words(provider, kind))


# ── the request ──────────────────────────────────────────────────────────────

class _Failed(Exception):
    def __init__(self, kind: str, status: Optional[int] = None):
        super().__init__(kind)
        self.kind = kind
        self.status = status


_HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}
_FAILED = {"blocked": "provider_error", "offline": "offline", "too_large": "provider_error"}


def _answer(status: int, parsed: Any) -> Any:
    """The parsed answer, or :class:`_Failed` from the status when it isn't one."""
    if parsed is None:
        if status == 429:
            raise _Failed("rate_limited", status)
        if status in (401, 403):
            raise _Failed("bad_key", status)
        if status >= 500:
            raise _Failed("offline", status)
        raise _Failed("provider_error", status)
    if status == 429:
        raise _Failed("rate_limited", status)
    return parsed


def _post(url: str, *, data: Dict[str, str], files: Optional[Dict[str, Any]] = None) -> Any:
    """POST a form, return the parsed JSON. Raises :class:`_Failed`."""
    try:
        status, parsed = guarded_json("POST", url, data=data, files=files, timeout=TIMEOUT, headers=_HEADERS,
                                      max_bytes=MAX_ANSWER_BYTES, max_redirects=0, request=guarded_request)
    except RequestFailed as exc:
        raise _Failed(_FAILED.get(exc.kind, "offline")) from None
    return _answer(status, parsed)


def _acoustid_lookup(key: str, duration: int, fp: str, meta: str) -> Any:
    """AcoustID's lookup, through the one path everything uses (``core/acoustid_api.py``)."""
    try:
        status, parsed = acoustid_api.lookup(key, duration, fp, meta=meta, timeout=TIMEOUT, headers=_HEADERS,
                                             request=guarded_request)
    except RequestFailed as exc:
        raise _Failed(_FAILED.get(exc.kind, "offline")) from None
    return _answer(status, parsed)


def _clip(path: str) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


def _mime(path: str) -> str:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return {"wav": "audio/wav", "mp3": "audio/mpeg", "aac": "audio/aac", "m4a": "audio/mp4",
            "ogg": "audio/ogg", "opus": "audio/ogg", "flac": "audio/flac"}.get(ext, "application/octet-stream")


def silent_wav(seconds: float = 1.0, rate: int = 8000) -> bytes:
    """A short silent clip for the Test buttons (no file to ship)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * int(rate * seconds))
    return buf.getvalue()


# ── AcoustID ─────────────────────────────────────────────────────────────────
#
# fpcalc (Chromaprint) makes the fingerprint; the lookup is AcoustID's v2 API
# (POST client, duration, fingerprint, meta). Its error codes: 4 invalid API
# key, 6 invalid user key, 17 unknown application, 14 too many requests, 13
# and 5 service trouble, 3 and 8 a bad fingerprint or duration.

_ACOUSTID_ERRORS = {4: "bad_key", 6: "bad_key", 17: "bad_key", 14: "rate_limited", 13: "offline", 5: "offline",
                    3: "bad_audio", 8: "bad_audio"}


def fingerprint(path: str, fpcalc: str, *, run: Callable[..., Any] = subprocess.run) -> Optional[Dict[str, Any]]:
    """``{duration, fingerprint}`` from fpcalc, or None."""
    try:
        proc = run([fpcalc, "-json", "-length", str(FPCALC_SECONDS), path], capture_output=True, timeout=20,
                   check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    if getattr(proc, "returncode", 1) != 0:
        return None
    try:
        out = json.loads((proc.stdout or b"").decode("utf-8", errors="replace"))
    except ValueError:
        return None
    fp, duration = out.get("fingerprint"), out.get("duration")
    if not isinstance(fp, str) or not fp or not isinstance(duration, (int, float)) or duration <= 0:
        return None
    return {"fingerprint": fp, "duration": duration}


def _acoustid_error(body: Dict[str, Any]) -> str:
    err = body.get("error") if isinstance(body.get("error"), dict) else {}
    try:
        code = int(err.get("code") or 0)
    except (TypeError, ValueError):
        code = 0
    kind = _ACOUSTID_ERRORS.get(code)
    if kind:
        return kind
    msg = str(err.get("message") or "").lower()
    if "key" in msg or "client" in msg:
        return "bad_key"
    if "rate" in msg or "too many" in msg:
        return "rate_limited"
    return "provider_error"


def acoustid(path: str, key: str, fpcalc: str, *, run: Callable[..., Any] = subprocess.run) -> ProviderResult:
    fp = fingerprint(path, fpcalc, run=run)
    if fp is None:
        return _error("acoustid", "bad_audio")
    try:
        body = _acoustid_lookup(key, int(round(fp["duration"])), fp["fingerprint"],
                                "recordings releasegroups compress")
    except _Failed as exc:
        return _error("acoustid", exc.kind)
    if not isinstance(body, dict):
        return _error("acoustid", "provider_error")
    if body.get("status") != "ok":
        return _error("acoustid", _acoustid_error(body))
    best: Optional[ProviderResult] = None
    for result in body.get("results") or []:
        if not isinstance(result, dict):
            continue
        try:
            score = float(result.get("score") or 0)
        except (TypeError, ValueError):
            continue
        for rec in result.get("recordings") or []:
            if not isinstance(rec, dict) or not rec.get("title") or not rec.get("artists"):
                continue
            artist = "".join(str(a.get("name") or "") + str(a.get("joinphrase") or "")
                             for a in rec["artists"] if isinstance(a, dict)).strip()
            groups = [g for g in rec.get("releasegroups") or [] if isinstance(g, dict) and g.get("title")]
            if artist and (best is None or score > (best.score or 0)):
                best = ProviderResult(provider="acoustid", status="match", artist=artist, title=str(rec["title"]),
                                      release=str(groups[0]["title"]) if groups else "", score=score)
    if best is None or (best.score or 0) < ACOUSTID_MIN_SCORE:
        return ProviderResult(provider="acoustid", status="no_match", score=best.score if best else None)
    return best


def acoustid_test(key: str) -> ProviderResult:
    """Is the key accepted? A lookup with a made-up fingerprint: AcoustID
    checks the key first (error 4), then refuses the fingerprint. Free."""
    try:
        body = _acoustid_lookup(key, 187, "AQADtMkWaYkSZRGO", "recordings")
    except _Failed as exc:
        return _error("acoustid", exc.kind)
    if isinstance(body, dict) and body.get("status") != "ok":
        kind = _acoustid_error(body)
        if kind in ("bad_key", "rate_limited", "offline"):
            return _error("acoustid", kind)
    return ProviderResult(provider="acoustid", status="no_match", message="AcoustID accepted the key.")


# ── AudD ─────────────────────────────────────────────────────────────────────
#
# POST https://api.audd.io/ with api_token and the clip as "file". Success is
# {"status": "success", "result": {artist, title, album, ...}} or
# "result": null for no match; an error is {"status": "error", "error":
# {"error_code", "error_message"}}. Codes: 900 a wrong token, 901 and 902 the
# request limit reached, 300/400/500/700 a clip it couldn't use. The standard
# answer has no score, so a named result is taken as the match.

_AUDD_ERRORS = {900: "bad_key", 901: "out_of_credit", 902: "out_of_credit", 300: "bad_audio", 400: "bad_audio",
                500: "bad_audio", 700: "bad_audio"}


def _audd_error(body: Dict[str, Any]) -> str:
    err = body.get("error") if isinstance(body.get("error"), dict) else {}
    try:
        code = int(err.get("error_code") or 0)
    except (TypeError, ValueError):
        code = 0
    kind = _AUDD_ERRORS.get(code)
    if kind:
        return kind
    msg = str(err.get("error_message") or "").lower()
    if "limit" in msg:
        return "out_of_credit"
    if "token" in msg:
        return "bad_key"
    return "provider_error"


def _audd_call(token: str, clip: bytes, name: str, mime: str) -> Any:
    return _post(AUDD_URL, data={"api_token": token}, files={"file": (name, clip, mime)})


def audd(path: str, token: str) -> ProviderResult:
    try:
        body = _audd_call(token, _clip(path), "scan." + path.rsplit(".", 1)[-1], _mime(path))
    except OSError:
        return _error("audd", "bad_audio")
    except _Failed as exc:
        return _error("audd", exc.kind)
    if not isinstance(body, dict):
        return _error("audd", "provider_error")
    if body.get("status") != "success":
        return _error("audd", _audd_error(body))
    result = body.get("result")
    if not isinstance(result, dict) or not result.get("artist") or not result.get("title"):
        return ProviderResult(provider="audd", status="no_match")
    return ProviderResult(provider="audd", status="match", artist=str(result["artist"]), title=str(result["title"]),
                          release=str(result.get("album") or ""), score=None)


def audd_test(token: str) -> ProviderResult:
    """Sends one second of silence; AudD checks the token before the audio.
    Uses one request of the account's allowance."""
    try:
        body = _audd_call(token, silent_wav(), "test.wav", "audio/wav")
    except _Failed as exc:
        return _error("audd", exc.kind)
    if isinstance(body, dict) and body.get("status") != "success":
        kind = _audd_error(body)
        if kind in ("bad_key", "out_of_credit", "rate_limited", "provider_error"):
            return _error("audd", kind)
    return ProviderResult(provider="audd", status="no_match", message="AudD accepted the token.")


# ── ACRCloud ─────────────────────────────────────────────────────────────────
#
# POST https://<project host>/v1/identify, multipart: the clip as "sample",
# sample_bytes, access_key, data_type "audio", signature_version "1",
# timestamp, and signature = base64(HMAC-SHA1(secret, "POST\n/v1/identify\n"
# + access_key + "\naudio\n1\n" + timestamp)). The answer's status.code: 0 a
# result (metadata.music, each with a 0-100 score), 1001 no result, 2004 a
# clip it couldn't fingerprint, 3001 a bad access key, 3014 a bad signature
# (a wrong secret), 3003 the account's limit, 3015 too many requests a second.

_ACR_ERRORS = {3001: "bad_key", 3014: "bad_key", 3003: "out_of_credit", 3015: "rate_limited", 2004: "bad_audio",
               2000: "bad_audio", 2001: "bad_audio", 3000: "offline"}


def acrcloud_signature(access_key: str, secret: str, timestamp: str) -> str:
    to_sign = "\n".join(("POST", ACRCLOUD_PATH, access_key, "audio", "1", timestamp))
    digest = hmac.new(secret.encode("utf-8"), to_sign.encode("utf-8"), hashlib.sha1).digest()
    return base64.b64encode(digest).decode("ascii")


def _acr_call(creds: Dict[str, str], clip: bytes, name: str, mime: str, now: Callable[[], float]) -> Any:
    host = acrcloud_host(creds.get("host") or "")
    if host is None:  # never trust what's stored: it must still be an ACRCloud host
        raise _Failed("bad_key")
    timestamp = str(int(now()))
    data = {"access_key": creds["access_key"], "data_type": "audio", "signature_version": "1",
            "signature": acrcloud_signature(creds["access_key"], creds["access_secret"], timestamp),
            "sample_bytes": str(len(clip)), "timestamp": timestamp}
    return _post(f"https://{host}{ACRCLOUD_PATH}", data=data, files={"sample": (name, clip, mime)})


def _acr_code(body: Any) -> Optional[int]:
    status = body.get("status") if isinstance(body, dict) else None
    if not isinstance(status, dict):
        return None
    try:
        return int(status.get("code"))
    except (TypeError, ValueError):
        return None


def acrcloud(path: str, creds: Dict[str, str], *, now: Callable[[], float] = time.time) -> ProviderResult:
    try:
        body = _acr_call(creds, _clip(path), "scan." + path.rsplit(".", 1)[-1], _mime(path), now)
    except OSError:
        return _error("acrcloud", "bad_audio")
    except _Failed as exc:
        return _error("acrcloud", exc.kind)
    code = _acr_code(body)
    if code is None:
        return _error("acrcloud", "provider_error")
    if code == 1001:
        return ProviderResult(provider="acrcloud", status="no_match")
    if code != 0:
        return _error("acrcloud", _ACR_ERRORS.get(code, "provider_error"))
    music = ((body.get("metadata") or {}).get("music") or []) if isinstance(body.get("metadata"), dict) else []
    best = None
    for item in music:
        if not isinstance(item, dict) or not item.get("title"):
            continue
        artists = ", ".join(str(a.get("name")) for a in item.get("artists") or []
                            if isinstance(a, dict) and a.get("name"))
        try:
            score = float(item.get("score") or 0)
        except (TypeError, ValueError):
            score = 0.0
        if artists and (best is None or score > best[0]):
            album = item.get("album") if isinstance(item.get("album"), dict) else {}
            best = (score, artists, str(item["title"]), str(album.get("name") or ""))
    if best is None or best[0] < ACRCLOUD_MIN_SCORE:
        return ProviderResult(provider="acrcloud", status="no_match", score=(best[0] / 100) if best else None)
    return ProviderResult(provider="acrcloud", status="match", artist=best[1], title=best[2], release=best[3],
                          score=best[0] / 100)


def acrcloud_test(creds: Dict[str, str], *, now: Callable[[], float] = time.time) -> ProviderResult:
    """Sends one second of silence: "no result" or "couldn't fingerprint"
    mean the host, key and secret were accepted. Uses one request."""
    try:
        body = _acr_call(creds, silent_wav(), "test.wav", "audio/wav", now)
    except _Failed as exc:
        return _error("acrcloud", exc.kind)
    code = _acr_code(body)
    if code is None:
        return _error("acrcloud", "provider_error")
    if code in (0, 1001, 2004, 2000, 2001):
        return ProviderResult(provider="acrcloud", status="no_match", message="ACRCloud accepted the project's keys.")
    return _error("acrcloud", _ACR_ERRORS.get(code, "provider_error"))


__all__ = ["ProviderResult", "LABELS", "ERROR_KINDS", "error_words", "acoustid", "acoustid_test", "audd",
           "audd_test", "acrcloud", "acrcloud_test", "acrcloud_signature", "fingerprint", "silent_wav",
           "ACOUSTID_MIN_SCORE", "ACRCLOUD_MIN_SCORE", "ACOUSTID_URL", "AUDD_URL"]
