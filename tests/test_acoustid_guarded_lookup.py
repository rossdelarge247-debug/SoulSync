"""AcoustID lookups go through the outbound guard, and the key is never logged.

The download identifier (AcoustIDClient, used by the radio's automatic
fingerprint too) and Scan now share one lookup path, ``core/acoustid_api.py``,
which sends every request through ``guarded_request``: the fixed host
api.acoustid.org over https, no redirects, timeouts, a capped answer.
"""

from __future__ import annotations

import logging
import sys
import types

import pytest

import core.acoustid_api as acoustid_api
import core.acoustid_client as acc
import core.security.outbound as outbound
from core.acoustid_client import AcoustIDClient
from core.internet_radio import fingerprint as radio_fingerprint
from core.internet_radio import scan_providers

KEY = "Zq7SecretAppKey42"
PREFIXES = (KEY, KEY[:8], KEY[:4], KEY[-4:])

HIT = {"status": "ok", "results": [{"id": "r1", "score": 0.93, "recordings": [
    {"id": "mbid-1", "title": "Harbour Light", "duration": 201, "artists": [{"name": "Pale Harbour"}]}]}]}


class Resp:
    def __init__(self, payload=None, status=200, raw=None):
        import json
        self.status_code = status
        self.body = raw if raw is not None else json.dumps(payload).encode()
        self.closed = False

    def iter_content(self, chunk_size=None):
        for i in range(0, len(self.body), chunk_size or 1024):
            yield self.body[i:i + (chunk_size or 1024)]

    def close(self):
        self.closed = True


class Guard:
    """Stands in for guarded_request and records each call."""

    def __init__(self, answer):
        self.answer = answer
        self.calls = []

    def __call__(self, method, url, **kw):
        self.calls.append({"method": method, "url": url, **kw})
        if isinstance(self.answer, BaseException):
            raise self.answer
        return self.answer, url


@pytest.fixture(autouse=True)
def _no_pacing(monkeypatch):
    monkeypatch.setattr(acoustid_api, "REQUEST_INTERVAL", 0)


@pytest.fixture
def fake_pyacoustid(monkeypatch):
    fake = types.ModuleType("acoustid")
    for name in ("WebServiceError", "NoBackendError", "FingerprintGenerationError"):
        setattr(fake, name, type(name, (Exception,), {}))
    fake.fingerprint_file = lambda path: (201.7, b"AQAAfake")

    def _no_network(*a, **k):
        raise AssertionError("pyacoustid's own HTTP lookup must not be used")
    fake.match = fake.lookup = _no_network
    monkeypatch.setitem(sys.modules, "acoustid", fake)
    monkeypatch.setattr(acc, "ACOUSTID_AVAILABLE", True)
    return fake


@pytest.fixture
def guard(monkeypatch):
    g = Guard(Resp(HIT))
    monkeypatch.setattr(outbound, "guarded_request", g)
    return g


@pytest.fixture
def logs(caplog):
    """The AcoustID loggers don't propagate to the root, so listen on them directly."""
    caplog.set_level(logging.DEBUG)
    attached = [logging.getLogger("soulsync.acoustid"), logging.getLogger("soulsync")]
    for lg in attached:
        lg.addHandler(caplog.handler)
    yield caplog
    for lg in attached:
        lg.removeHandler(caplog.handler)


def _client():
    c = AcoustIDClient()
    c._api_key = KEY
    return c


def _audio(tmp_path):
    f = tmp_path / "a.bin"
    f.write_bytes(b"not audio")
    return str(f)


def _assert_no_key(text):
    for part in PREFIXES:
        assert part not in text


# ── requests go through the guard ────────────────────────────────────────────

def test_client_lookup_goes_through_the_guard(tmp_path, fake_pyacoustid, guard):
    res = _client().lookup_with_status(_audio(tmp_path))
    assert res["status"] == "ok" and res["best_score"] == 0.93
    assert res["recordings"] == [{"mbid": "mbid-1", "title": "Harbour Light", "artist": "Pale Harbour",
                                  "score": 0.93, "duration": 201}]
    (call,) = guard.calls
    assert call["method"] == "POST" and call["url"] == "https://api.acoustid.org/v2/lookup"
    assert call["max_redirects"] == 0 and call["stream"] is True and call["timeout"] == acoustid_api.TIMEOUT
    # the key in the body only; the duration truncated as pyacoustid did; bytes fingerprint decoded
    assert call["data"] == {"client": KEY, "duration": "201", "fingerprint": "AQAAfake", "meta": "recordings",
                            "format": "json"}
    assert KEY not in call["url"] and not call.get("params")


def test_key_test_goes_through_the_guard(guard):
    guard.answer = Resp({"status": "error", "error": {"code": 3, "message": "invalid fingerprint"}})
    assert _client().test_api_key() == (True, "AcoustID API key is valid")
    (call,) = guard.calls
    assert call["url"] == acoustid_api.ACOUSTID_URL and call["data"]["client"] == KEY
    assert call["timeout"] == (5, 10)


def test_scan_now_and_the_radio_fingerprint_share_the_path(tmp_path, monkeypatch, fake_pyacoustid, guard):
    calls = []
    real = acoustid_api.lookup

    def spy(*a, **k):
        calls.append(k.get("meta"))
        return real(*a, **k)
    monkeypatch.setattr(acoustid_api, "lookup", spy)
    # Scan now hands its own module's guarded_request reference (what its tests replace)
    monkeypatch.setattr(scan_providers, "guarded_request", guard)
    run = lambda argv, **kw: types.SimpleNamespace(returncode=0, stdout=b'{"duration": 10.0, "fingerprint": "AQ"}')
    out = scan_providers.acoustid(_audio(tmp_path), KEY, "/bin/fpcalc", run=run)
    assert out.matched and out.title == "Harbour Light"
    radio = radio_fingerprint.lookup(_audio(tmp_path), client_factory=_client)
    assert radio == {"status": "ok", "artist": "Pale Harbour", "title": "Harbour Light", "release": ""}
    assert calls == ["recordings releasegroups compress", "recordings"]
    assert [c["url"] for c in guard.calls] == [acoustid_api.ACOUSTID_URL] * 2


def test_the_real_guard_refuses_a_private_address(tmp_path, monkeypatch, fake_pyacoustid):
    """No stand-in: api.acoustid.org resolving to the LAN is refused before any connection."""
    monkeypatch.setattr(outbound, "resolve", lambda host, port: ["10.0.0.7"])
    res = _client().lookup_with_status(_audio(tmp_path))
    assert res["status"] == "error" and res["invalid_key"] is False
    assert "outbound guard" in res["error"]


def test_the_answer_is_capped(tmp_path, monkeypatch, fake_pyacoustid, guard):
    monkeypatch.setattr(acoustid_api, "MAX_ANSWER_BYTES", 100)
    guard.answer = Resp(raw=b"{" + b" " * 500 + b"}")
    res = _client().lookup_with_status(_audio(tmp_path))
    assert res["status"] == "error" and "too large" in res["error"]
    assert guard.answer.closed


# ── error mapping unchanged ──────────────────────────────────────────────────

@pytest.mark.parametrize("payload,invalid", [
    ({"status": "error", "error": {"code": 4, "message": "invalid API key"}}, True),
    ({"status": "error", "error": {"code": 6, "message": "invalid user API key"}}, True),
    ({"status": "error", "error": {"code": 5, "message": "internal error"}}, False),
    ({"status": "error", "error": {"code": 14, "message": "too many requests"}}, False),
])
def test_api_errors_map_as_before(tmp_path, fake_pyacoustid, guard, payload, invalid):
    guard.answer = Resp(payload)
    res = _client().lookup_with_status(_audio(tmp_path))
    err = payload["error"]
    assert res == {"status": "error", "recordings": [], "invalid_key": invalid,
                   "error": f"AcoustID API error (code {err['code']}): {err['message']}"}


def test_no_match_and_network_failure(tmp_path, fake_pyacoustid, guard):
    guard.answer = Resp({"status": "ok", "results": []})
    assert _client().lookup_with_status(_audio(tmp_path))["status"] == "no_match"
    import requests
    guard.answer = requests.exceptions.ConnectionError("down")
    res = _client().lookup_with_status(_audio(tmp_path))
    assert res["status"] == "error" and res["invalid_key"] is False
    assert res["error"] == "AcoustID API error: HTTP request failed"
    guard.answer = Resp(raw=b"<html>busy</html>", status=503)
    res = _client().lookup_with_status(_audio(tmp_path))
    assert res["status"] == "error" and res["error"] == "AcoustID API error: response is not valid JSON"


def test_fingerprint_failures_never_reach_the_network(tmp_path, fake_pyacoustid, guard):
    def boom(path):
        raise fake_pyacoustid.FingerprintGenerationError("fpcalc exited with status 3")
    fake_pyacoustid.fingerprint_file = boom
    assert _client().lookup_with_status(_audio(tmp_path))["status"] == "fingerprint_error"
    assert guard.calls == []


def test_key_test_mapping(guard):
    import requests
    guard.answer = Resp({"status": "error", "error": {"code": 4, "message": "invalid API key"}})
    ok, msg = _client().test_api_key()
    assert ok is False and msg.startswith("Invalid AcoustID API key")
    guard.answer = Resp({"status": "ok", "results": []})
    assert _client().test_api_key() == (True, "AcoustID API key is valid")
    guard.answer = requests.exceptions.ReadTimeout("slow")
    assert _client().test_api_key() == (False, "AcoustID API timeout - try again later")
    guard.answer = requests.exceptions.ConnectionError("refused")
    ok, msg = _client().test_api_key()
    assert ok is False and msg.startswith("Network error:")


# ── no key in the logs ───────────────────────────────────────────────────────

def test_no_part_of_the_key_is_logged(tmp_path, fake_pyacoustid, guard, logs):
    import requests
    client = _client()
    client.lookup_with_status(_audio(tmp_path))
    guard.answer = Resp({"status": "error", "error": {"code": 4, "message": "invalid API key"}})
    client.lookup_with_status(_audio(tmp_path))
    guard.answer = requests.exceptions.ConnectionError(f"failed for client={KEY}")
    client.lookup_with_status(_audio(tmp_path))
    client.test_api_key()
    guard.answer = Resp({"status": "ok"})  # "results not included"
    client.lookup_with_status(_audio(tmp_path))
    assert "Fingerprinting and looking up" in logs.text  # the loggers were heard
    _assert_no_key(logs.text)


def test_no_module_logs_a_key_prefix():
    """The f"{key[:8]}..." previews are gone from every logger call."""
    import pathlib
    import re
    root = pathlib.Path(__file__).resolve().parent.parent
    pattern = re.compile(r"(log\w*|print)\b[^\n]*\b\w*(api_key|secret|client_id|code_verifier|code_challenge|"
                         r"auth_code)\w*\)?\[:\d+\]")
    hits = []
    for path in [root / "web_server.py", *(root / "core").rglob("*.py"), *(root / "api").rglob("*.py")]:
        for n, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            if pattern.search(line):
                hits.append(f"{path.relative_to(root)}:{n}")
    assert hits == []
