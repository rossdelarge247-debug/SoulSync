"""Scan now (core/internet_radio/scan.py, scan_providers.py, the scan routes in
api/radio.py): the chain's order and stopping at the first match, each
service's answers and errors, the ACRCloud host check, keys kept out of every
answer and log, the limits, members and admins, the module switch, temporary
files, and a scan never running on a relay's thread. Every network call,
ffmpeg and fpcalc are faked."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import tempfile
import threading
import time

import pytest

import api.radio as radio_api
from core.internet_radio import relay, scan_providers, store
from core.internet_radio import settings as radio_settings
from core.internet_radio.hub import hub
from core.internet_radio.scan import (NOT_FOUND_WORDS, PER_PROFILE_PER_MINUTE, ScanDeps, ScanManager,
                                      check_service)
from core.internet_radio.stations import builtin_station
from core.security.outbound import OutboundBlocked
from core.settings import ConfigManager

AUDD = "auddTOKEN1234567890abcdef"
ACR_KEY = "acrKEY0123456789abcdef"
ACR_SECRET = "acrSECRETzyxwvu9876543210"
ACOUSTID = "acoustKEY123"
HOST = "identify-eu-west-1.acrcloud.com"
SECRETS = (AUDD, ACR_KEY, ACR_SECRET, ACOUSTID)


class Resp:
    def __init__(self, body, status=200):
        self.status_code = status
        self._raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.closed = False

    def iter_content(self, chunk_size=None):
        yield self._raw

    def close(self):
        self.closed = True


class Net:
    """Stands in for the guarded request: answers by host, records each call."""

    def __init__(self):
        self.calls = []
        self.answers = {}

    def __call__(self, method, url, **kw):
        self.calls.append({"method": method, "url": url, **kw})
        for prefix, answer in self.answers.items():
            if url.startswith(prefix):
                if isinstance(answer, BaseException):
                    raise answer
                return (answer if isinstance(answer, Resp) else Resp(answer)), url
        raise AssertionError(f"unexpected request to {url}")

    def hosts(self):
        return [c["url"].split("/")[2] for c in self.calls]


class Proc:
    def __init__(self, returncode=0, stdout=b""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = b""


def fake_run(argv, **kw):
    """ffmpeg writes a WAV; fpcalc prints a fingerprint."""
    if "ffmpeg" in argv[0]:
        with open(argv[-1], "wb") as fh:
            fh.write(b"RIFF" + b"\x00" * 40000)
        return Proc()
    return Proc(stdout=json.dumps({"duration": 10.0, "fingerprint": "AQAAfake"}).encode())


class Upstream:
    def __init__(self, chunks=(b"\xff\xfb" * 8192,) * 40, ctype="audio/mpeg"):
        self.status_code = 200
        self.headers = {"content-type": ctype}
        self.chunks = list(chunks)
        self.closed = False
        self.read = 0

    def iter_content(self, chunk_size=None):
        for c in self.chunks:
            self.read += 1
            yield c

    def close(self):
        self.closed = True


@pytest.fixture
def net(monkeypatch):
    n = Net()
    monkeypatch.setattr(scan_providers, "guarded_request", n)
    return n


@pytest.fixture
def opened():
    return []


@pytest.fixture
def scanner(app, db, config, opened, monkeypatch, tmp_path):
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))

    def open_stream(url):
        up = Upstream()
        opened.append((url, up))
        return up, "audio/mpeg"
    radio_api.scanner.configure(ScanDeps(get_database=lambda: db, config=config, find_fpcalc=lambda: "/bin/fpcalc",
                                         find_ffmpeg=lambda: "/bin/ffmpeg", open_stream=open_stream, run=fake_run))
    radio_api.scanner.reset()
    radio_api.scanner.run_inline(True)
    yield radio_api.scanner
    radio_api.scanner.run_inline(False)
    radio_api.scanner.reset()


def keys(config, acoustid=True, audd=True, acr=True):
    if acoustid:
        config.set("acoustid.api_key", ACOUSTID)
    if audd:
        config.set("radio.audd_api_token", AUDD)
    if acr:
        config.set("radio.acrcloud_host", HOST)
        config.set("radio.acrcloud_access_key", ACR_KEY)
        config.set("radio.acrcloud_access_secret", ACR_SECRET)


def play(client, station="somafm-dronezone"):
    return client.post("/api/radio/play", json={"station_id": station}).get_json()["session_id"]


ACOUSTID_NONE = {"status": "ok", "results": []}
ACOUSTID_HIT = {"status": "ok", "results": [{"id": "x", "score": 0.91, "recordings": [
    {"id": "r", "title": "Harbour Light", "artists": [{"name": "Pale Harbour"}],
     "releasegroups": [{"title": "Lantern"}]}]}]}
AUDD_HIT = {"status": "success", "result": {"artist": "Tidewater", "title": "Night Ferry", "album": "Dub"}}
AUDD_NONE = {"status": "success", "result": None}
ACR_HIT = {"status": {"code": 0, "msg": "Success"}, "metadata": {"music": [
    {"title": "Low Tide", "artists": [{"name": "Kelp"}], "album": {"name": "Shore"}, "score": 88}]}}
ACR_NONE = {"status": {"code": 1001, "msg": "No result"}}


# ── the chain ────────────────────────────────────────────────────────────────

def test_chain_runs_in_order_and_stops_at_the_first_match(client, scanner, net, config, db, events, monkeypatch):
    keys(config)
    monkeypatch.setattr(hub.deps, "radio_automation_profiles", lambda: [1])
    net.answers = {scan_providers.ACOUSTID_URL: ACOUSTID_NONE, scan_providers.AUDD_URL: AUDD_HIT,
                   f"https://{HOST}": ACR_HIT}
    sid = play(client)
    r = client.post("/api/radio/scan", json={"session_id": sid})
    assert r.status_code == 202
    body = client.get(f"/api/radio/scan/{r.get_json()['scan_id']}").get_json()
    assert body["state"] == "identified" and body["source"] == "scan_audd" and body["source_label"] == "AudD"
    assert body["track"] == {"artist": "Tidewater", "title": "Night Ferry", "release": "Dub"}
    assert net.hosts() == ["api.acoustid.org", "api.audd.io"]  # ACRCloud never asked
    assert body["asked"] == ["acoustid", "audd"]
    row = store.get_heard(db, body["heard_id"])
    assert row["source"] == "scan_audd" and row["profile_id"] == 1 and row["title"] == "Night Ferry"
    assert body["library"]["in_library"] is False and body["on_wanted"] is False
    assert events and events[-1][0] == "radio_track_heard" and events[-1][1]["source"] == "scan_audd"
    np = client.get("/api/radio/now-playing?station_id=somafm-dronezone").get_json()
    assert np["state"] == "identified" and np["source"] == "scan_audd"
    assert store.scan_usage(db) == {"acoustid": {"requests": 1, "found": 0}, "audd": {"requests": 1, "found": 1}}


def test_acoustid_match_stops_the_paid_services(client, scanner, net, config):
    keys(config)
    net.answers = {scan_providers.ACOUSTID_URL: ACOUSTID_HIT}
    body = client.post("/api/radio/scan", json={"session_id": play(client)}).get_json()
    assert body["state"] == "identified" and body["source"] == "scan_acoustid"
    assert body["track"]["release"] == "Lantern" and net.hosts() == ["api.acoustid.org"]


def test_acoustid_is_skipped_without_a_key_and_the_paid_ones_without_theirs(client, scanner, net, config):
    keys(config, acoustid=False, audd=False)
    net.answers = {f"https://{HOST}": ACR_HIT}
    body = client.post("/api/radio/scan", json={"session_id": play(client)}).get_json()
    assert body["source"] == "scan_acrcloud" and body["track"]["artist"] == "Kelp"
    assert net.hosts() == [HOST]


def test_a_failing_service_doesnt_stop_the_next(client, scanner, net, config):
    keys(config)
    net.answers = {scan_providers.ACOUSTID_URL: {"status": "error", "error": {"code": 4, "message": "invalid API key"}},
                   scan_providers.AUDD_URL: {"status": "error", "error": {"error_code": 902, "error_message": "limit"}},
                   f"https://{HOST}": ACR_HIT}
    body = client.post("/api/radio/scan", json={"session_id": play(client)}).get_json()
    assert body["state"] == "identified" and body["source"] == "scan_acrcloud"


def test_nothing_found_is_calm(client, scanner, net, config):
    keys(config)
    net.answers = {scan_providers.ACOUSTID_URL: ACOUSTID_NONE, scan_providers.AUDD_URL: AUDD_NONE,
                   f"https://{HOST}": ACR_NONE}
    body = client.post("/api/radio/scan", json={"session_id": play(client)}).get_json()
    assert body["state"] == "not_found" and body["reason"] == NOT_FOUND_WORDS and body["provider_error"] is None


def test_every_service_failing_is_failed_in_plain_words(client, scanner, net, config):
    keys(config, acoustid=False, acr=False)
    net.answers = {scan_providers.AUDD_URL: {"status": "error", "error": {"error_code": 900, "error_message": "x"}}}
    body = client.post("/api/radio/scan", json={"session_id": play(client)}).get_json()
    assert body["state"] == "failed" and body["provider_error"]["kind"] == "bad_key"
    assert body["reason"] == "AudD refused the key. An admin can check it in Settings → Radio."


def test_low_acoustid_scores_arent_a_match(client, scanner, net, config):
    keys(config, audd=False, acr=False)
    weak = {"status": "ok", "results": [{"score": 0.5, "recordings": [{"title": "T", "artists": [{"name": "A"}]}]}]}
    net.answers = {scan_providers.ACOUSTID_URL: weak}
    assert client.post("/api/radio/scan", json={"session_id": play(client)}).get_json()["state"] == "not_found"


def test_a_scan_never_auto_adds(client, scanner, net, config, db, library):
    keys(config, acoustid=False, acr=False)
    store.set_auto_add(db, 1, "somafm-dronezone", "Drone Zone", True)
    net.answers = {scan_providers.AUDD_URL: AUDD_HIT}
    client.post("/api/radio/scan", json={"session_id": play(client)})
    assert library.added == []


# ── each service's answers ───────────────────────────────────────────────────

@pytest.mark.parametrize("answer,status,kind", [
    ({"status": "error", "error": {"error_code": 900, "error_message": "Wrong API token"}}, 200, "bad_key"),
    ({"status": "error", "error": {"error_code": 901, "error_message": "limit"}}, 200, "out_of_credit"),
    ({"status": "error", "error": {"error_code": 902, "error_message": "limit reached"}}, 200, "out_of_credit"),
    ({"status": "error", "error": {"error_code": 300, "error_message": "fp"}}, 200, "bad_audio"),
    ({"status": "error", "error": {"error_code": 999, "error_message": "?"}}, 200, "provider_error"),
    (b"slow down", 429, "rate_limited"),
    (b"<html>", 502, "offline"),
])
def test_audd_errors(net, tmp_path, answer, status, kind):
    clip = tmp_path / "c.wav"
    clip.write_bytes(b"RIFF")
    net.answers = {scan_providers.AUDD_URL: Resp(answer, status)}
    out = scan_providers.audd(str(clip), AUDD)
    assert out.status == "error" and out.error == kind and AUDD not in out.message
    call = net.calls[0]
    assert call["method"] == "POST" and call["max_redirects"] == 0 and call["data"] == {"api_token": AUDD}
    assert call["files"]["file"][1] == b"RIFF" and call["timeout"] == scan_providers.TIMEOUT


@pytest.mark.parametrize("code,kind", [(3001, "bad_key"), (3014, "bad_key"), (3003, "out_of_credit"),
                                       (3015, "rate_limited"), (2004, "bad_audio"), (3000, "offline"),
                                       (3999, "provider_error")])
def test_acrcloud_errors(net, tmp_path, code, kind):
    clip = tmp_path / "c.wav"
    clip.write_bytes(b"RIFF")
    net.answers = {f"https://{HOST}": {"status": {"code": code, "msg": "x"}}}
    out = scan_providers.acrcloud(str(clip), {"host": HOST, "access_key": ACR_KEY, "access_secret": ACR_SECRET})
    assert out.error == kind and ACR_SECRET not in out.message


def test_acrcloud_signs_the_request_and_uses_the_score(net, tmp_path):
    clip = tmp_path / "c.wav"
    clip.write_bytes(b"RIFFDATA")
    net.answers = {f"https://{HOST}": ACR_HIT}
    out = scan_providers.acrcloud(str(clip), {"host": HOST, "access_key": ACR_KEY, "access_secret": ACR_SECRET},
                                  now=lambda: 1761130000)
    assert out.matched and out.artist == "Kelp" and out.release == "Shore" and out.score == 0.88
    call = net.calls[0]
    assert call["url"] == f"https://{HOST}/v1/identify" and call["max_redirects"] == 0
    data = call["data"]
    to_sign = f"POST\n/v1/identify\n{ACR_KEY}\naudio\n1\n1761130000"
    want = base64.b64encode(hmac.new(ACR_SECRET.encode(), to_sign.encode(), hashlib.sha1).digest()).decode()
    assert data["signature"] == want and data["timestamp"] == "1761130000" and data["sample_bytes"] == "8"
    assert ACR_SECRET not in json.dumps(data)  # the secret signs; it's never sent
    low = {"status": {"code": 0}, "metadata": {"music": [{"title": "X", "artists": [{"name": "Y"}], "score": 40}]}}
    net.answers = {f"https://{HOST}": low}
    assert scan_providers.acrcloud(str(clip), {"host": HOST, "access_key": ACR_KEY,
                                               "access_secret": ACR_SECRET}).status == "no_match"


@pytest.mark.parametrize("answer,kind", [
    ({"status": "error", "error": {"code": 4, "message": "invalid API key"}}, "bad_key"),
    ({"status": "error", "error": {"code": 14, "message": "too many requests"}}, "rate_limited"),
    ({"status": "error", "error": {"code": 3, "message": "invalid fingerprint"}}, "bad_audio"),
])
def test_acoustid_errors(net, tmp_path, answer, kind):
    net.answers = {scan_providers.ACOUSTID_URL: answer}
    out = scan_providers.acoustid(str(tmp_path / "c.wav"), ACOUSTID, "/bin/fpcalc", run=fake_run)
    assert out.error == kind and net.calls[0]["data"]["client"] == ACOUSTID


def test_network_failures_read_as_offline_and_blocked_as_an_error(net, tmp_path):
    clip = tmp_path / "c.wav"
    clip.write_bytes(b"RIFF")
    net.answers = {scan_providers.AUDD_URL: ConnectionError("refused")}
    assert scan_providers.audd(str(clip), AUDD).error == "offline"
    net.answers = {scan_providers.AUDD_URL: OutboundBlocked("That address is on a private or local network.")}
    assert scan_providers.audd(str(clip), AUDD).error == "provider_error"


def test_fpcalc_failing_is_a_clip_problem_not_a_request(net, tmp_path):
    out = scan_providers.acoustid(str(tmp_path / "c.wav"), ACOUSTID, "/bin/fpcalc",
                                  run=lambda *a, **k: Proc(returncode=2))
    assert out.error == "bad_audio" and net.calls == []


# ── the ACRCloud host can't be turned into an SSRF lever ─────────────────────

@pytest.mark.parametrize("host,ok", [
    ("identify-eu-west-1.acrcloud.com", True), ("https://identify-us-west-2.acrcloud.com/", True),
    ("IDENTIFY-AP-SOUTHEAST-1.ACRCLOUD.COM", True), ("acrcloud.com", False), ("evil.com", False),
    ("identify.acrcloud.com.evil.com", False), ("identify.acrcloud.com:8080", False),
    ("identify.acrcloud.com/v1/identify", False), ("http://identify.acrcloud.com", False),
    ("user@identify.acrcloud.com", False), ("127.0.0.1", False), ("169.254.169.254", False),
    ("identify.acrcloud.com?x=1", False), ("identify.acrcloud.com#x", False), ("identifyacrcloud.com", False),
    ("identify.acrcloud.com\n", True), ("identify.acrcloud.com\nevil.com", False), ("-x.acrcloud.com", False),
    ("localhost", False), ("[::1]", False), (None, False), (42, False),
])
def test_acrcloud_host_check(host, ok):
    assert (radio_settings.acrcloud_host(host) is not None) is ok


def test_a_bad_host_isnt_saved(client, config):
    r = client.put("/api/radio/settings", json={"acrcloud_host": "169.254.169.254", "audd_api_token": AUDD})
    assert r.status_code == 400 and "acrcloud.com" in r.get_json()["message"]
    assert config.get("radio.acrcloud_host", "") == "" and config.get("radio.audd_api_token", "") == ""


def test_a_tampered_stored_host_is_never_fetched(net, tmp_path, config):
    clip = tmp_path / "c.wav"
    clip.write_bytes(b"RIFF")
    out = scan_providers.acrcloud(str(clip), {"host": "metadata.google.internal", "access_key": ACR_KEY,
                                              "access_secret": ACR_SECRET})
    assert out.error == "bad_key" and net.calls == []
    config.set("radio.acrcloud_host", "10.0.0.5")
    config.set("radio.acrcloud_access_key", ACR_KEY)
    config.set("radio.acrcloud_access_secret", ACR_SECRET)
    assert radio_settings.acrcloud_credentials(config) is None


def test_provider_requests_go_through_the_outbound_guard(monkeypatch, tmp_path):
    """No stand-in for the guard here: a private address is refused before
    any connection, so the real guarded_request is what the providers call."""
    import core.security.outbound as outbound
    monkeypatch.setattr(outbound, "resolve", lambda host, port: ["10.0.0.7"])
    clip = tmp_path / "c.wav"
    clip.write_bytes(b"RIFF")
    out = scan_providers.audd(str(clip), AUDD)
    assert out.error == "provider_error"  # refused by the guard, nothing sent
    assert scan_providers.guarded_request is outbound.guarded_request


def test_a_body_never_follows_a_redirect():
    from core.security.outbound import guarded_request
    with pytest.raises(ValueError):
        guarded_request("POST", "https://api.audd.io/", data={"api_token": "x"})


# ── keys stay on the server ──────────────────────────────────────────────────

def test_keys_are_write_only_and_redacted_everywhere(client, config, scanner, net, caplog):
    body = client.put("/api/radio/settings", json={"audd_api_token": AUDD, "acrcloud_host": HOST,
                                                   "acrcloud_access_key": ACR_KEY,
                                                   "acrcloud_access_secret": ACR_SECRET}).get_json()
    assert body["settings"]["scan_services"]["audd_ready"] and body["settings"]["scan_services"]["acrcloud_ready"]
    assert config.get("radio.audd_api_token") == AUDD
    for path in radio_settings.SCAN_SECRET_PATHS:
        assert path in ConfigManager._SENSITIVE_PATHS
    from api.settings import _SENSITIVE_KEYS, _redact_sensitive
    assert set(radio_settings.SCAN_SECRET_PATHS) <= _SENSITIVE_KEYS
    red = _redact_sensitive({"radio": {"audd_api_token": AUDD, "acrcloud_host": HOST, "acrcloud_access_key": ACR_KEY,
                                       "acrcloud_access_secret": ACR_SECRET, "daily_limit": 50}})
    assert red["radio"]["daily_limit"] == 50 and not any(s in json.dumps(red) for s in SECRETS + (HOST,))
    masked = config.redacted_config()
    assert not any(s in json.dumps(masked) for s in (AUDD, ACR_KEY, ACR_SECRET, HOST))
    # every answer a browser can get
    keys(config)
    caplog.set_level(logging.DEBUG)
    net.answers = {scan_providers.ACOUSTID_URL: {"status": "error", "error": {"code": 4, "message": "bad"}},
                   scan_providers.AUDD_URL: {"status": "error", "error": {"error_code": 900, "error_message": AUDD}},
                   f"https://{HOST}": {"status": {"code": 3014, "msg": "invalid signature"}}}
    texts = [json.dumps(client.get("/api/radio/settings").get_json()),
             json.dumps(client.get("/api/radio/stations/somafm-dronezone").get_json())]
    sid = play(client)
    texts.append(json.dumps(client.get(f"/api/radio/now-playing?station_id=somafm-dronezone&session_id={sid}")
                            .get_json()))
    texts.append(json.dumps(client.post("/api/radio/scan", json={"session_id": sid}).get_json()))
    for service in ("acoustid", "audd", "acrcloud"):
        texts.append(json.dumps(client.post("/api/radio/scan/test", json={"service": service}).get_json()))
    texts.append(caplog.text)
    for text in texts:
        for secret in SECRETS:
            assert secret not in text


def test_keys_are_encrypted_at_rest(tmp_path):
    cm = ConfigManager.__new__(ConfigManager)
    cm.database_path = tmp_path / "db" / "x.db"
    cm.config_path = tmp_path / "config.json"
    cm._fernet = None
    stored = cm._encrypt_sensitive({"radio": {"audd_api_token": AUDD, "acrcloud_access_secret": ACR_SECRET}})
    assert AUDD not in json.dumps(stored) and ACR_SECRET not in json.dumps(stored)
    assert cm._decrypt_sensitive(stored)["radio"]["audd_api_token"] == AUDD


def test_debug_info_reads_no_scan_key():
    import inspect

    import core.debug_info as debug_info
    source = inspect.getsource(debug_info)
    assert "audd" not in source and "acrcloud" not in source


def test_removing_a_service_clears_its_keys(client, config):
    keys(config)
    body = client.put("/api/radio/settings", json={"remove": ["acrcloud"]}).get_json()
    assert not body["settings"]["scan_services"]["acrcloud_ready"] and body["settings"]["scan_services"]["audd_ready"]
    assert config.get("radio.acrcloud_access_secret", "") == ""
    assert client.put("/api/radio/settings", json={"remove": ["everything"]}).status_code == 400
    # an empty field leaves the saved token alone
    client.put("/api/radio/settings", json={"audd_api_token": ""})
    assert config.get("radio.audd_api_token") == AUDD


# ── who can scan, and how often ──────────────────────────────────────────────

def test_members_can_scan_but_not_test_or_see_settings(client, scanner, net, config, who):
    keys(config, acoustid=False, acr=False)
    net.answers = {scan_providers.AUDD_URL: AUDD_NONE}
    who["pid"], who["admin"] = 2, False
    r = client.post("/api/radio/scan", json={"session_id": play(client)})
    assert r.status_code == 202
    assert client.post("/api/radio/scan/test", json={"service": "audd"}).status_code == 403
    assert client.get("/api/radio/settings").status_code == 403
    scan_id = r.get_json()["scan_id"]
    who["pid"] = 3
    assert client.get(f"/api/radio/scan/{scan_id}").status_code == 404  # someone else's


def test_scanning_needs_your_own_live_session(client, scanner, config, who):
    keys(config)
    sid = play(client)
    who["pid"] = 2
    assert client.post("/api/radio/scan", json={"session_id": sid}).status_code == 404
    assert client.post("/api/radio/scan", json={}).get_json()["error"] == "no_session"


def test_no_service_and_identification_off_refuse_with_a_reason(client, scanner, config):
    sid = play(client)
    r = client.post("/api/radio/scan", json={"session_id": sid})
    assert r.status_code == 409 and r.get_json()["error"] == "no_scan_service"
    np = client.get(f"/api/radio/now-playing?station_id=somafm-dronezone&session_id={sid}").get_json()
    assert np["scan"]["available"] is False and "Settings → Radio" in np["scan"]["reason"]
    keys(config)
    config.set("radio.identification", False)
    assert client.post("/api/radio/scan", json={"session_id": sid}).get_json()["error"] == "identification_off"


def test_a_few_scans_a_minute_per_profile(client, scanner, net, config):
    keys(config, acoustid=False, acr=False)
    net.answers = {scan_providers.AUDD_URL: AUDD_NONE}
    sid = play(client)
    for _ in range(PER_PROFILE_PER_MINUTE):
        assert client.post("/api/radio/scan", json={"session_id": sid}).status_code == 202
    r = client.post("/api/radio/scan", json={"session_id": sid})
    assert r.status_code == 429 and r.get_json()["error"] == "rate_limited" and int(r.headers["Retry-After"]) > 0
    assert len(net.calls) == PER_PROFILE_PER_MINUTE


def test_one_scan_at_a_time_per_profile_and_two_across_the_server(config, db):
    keys(config, acoustid=False, acr=False)
    gate = threading.Event()

    def slow_open(url):
        gate.wait(5)
        return Upstream(chunks=[]), "audio/mpeg"
    mgr = ScanManager(hub)
    mgr.configure(ScanDeps(get_database=lambda: db, config=config, find_fpcalc=lambda: None,
                           find_ffmpeg=lambda: None, open_stream=slow_open, run=fake_run))
    from core.internet_radio.scan import ScanRefused
    st = builtin_station("kexp")
    hub.reset()
    try:
        s1 = hub.start_session(1, st, st.streams[0], "direct")
        mgr.start(1, s1, st)
        with pytest.raises(ScanRefused) as exc:
            mgr.start(1, s1, st)
        assert exc.value.code == "scan_running"
        s2 = hub.start_session(2, st, st.streams[0], "direct")
        mgr.start(2, s2, st)
        s3 = hub.start_session(3, st, st.streams[0], "direct")
        with pytest.raises(ScanRefused) as exc:
            mgr.start(3, s3, st)
        assert exc.value.code == "busy"
    finally:
        gate.set()
        hub.reset()
    deadline = time.time() + 5
    while mgr.running_count() and time.time() < deadline:
        time.sleep(0.05)
    assert mgr.running_count() == 0


def test_the_scan_routes_belong_to_the_module(config):
    from core.modules import disabled_module_for_path
    config.set("modules.radio.enabled", False)
    for path in ("/api/radio/scan", "/api/radio/scan/abc", "/api/radio/scan/test"):
        assert disabled_module_for_path(path, config) == "radio"


def test_turning_the_module_off_forgets_scans(client, scanner, net, config):
    keys(config, acoustid=False, acr=False)
    net.answers = {scan_providers.AUDD_URL: AUDD_NONE}
    scan_id = client.post("/api/radio/scan", json={"session_id": play(client)}).get_json()["scan_id"]
    radio_api.stop_watcher()
    assert client.get(f"/api/radio/scan/{scan_id}").status_code == 404


# ── capture ──────────────────────────────────────────────────────────────────

def test_a_direct_session_opens_one_short_capped_read(client, scanner, net, config, opened):
    keys(config, acoustid=False, acr=False)
    net.answers = {scan_providers.AUDD_URL: AUDD_NONE}
    client.post("/api/radio/scan", json={"session_id": play(client)})  # SomaFM plays direct
    assert len(opened) == 1
    url, up = opened[0]
    assert url == builtin_station("somafm-dronezone").streams[0].url or url.startswith("https://ice")
    assert up.closed and up.read < len(up.chunks)  # stopped once it had enough


def test_direct_capture_is_capped_in_bytes(scanner, config, db, monkeypatch):
    from core.internet_radio import scan as scan_mod
    monkeypatch.setattr(scan_mod, "CAPTURE_MAX_BYTES", 100_000)
    st = builtin_station("kexp")
    sess = hub.start_session(1, st, st.streams[0], "direct")
    big = Upstream(chunks=[b"x" * 60_000] * 50)
    scanner.deps.open_stream = lambda url: (big, "audio/mpeg")
    s = scan_mod.Scan(id="t", profile_id=1, station_id=st.id, station_name=st.name, session_id=sess.id,
                      created_at=0, target=10**9)
    got, _ = scanner._capture_direct(s, sess)
    assert len(got[0]) <= 100_000 and big.closed and big.read <= 3


def test_temporary_files_are_removed(client, scanner, net, config, tmp_path):
    keys(config, acoustid=False, acr=False)
    net.answers = {scan_providers.AUDD_URL: AUDD_HIT}
    client.post("/api/radio/scan", json={"session_id": play(client)})
    net.answers = {scan_providers.AUDD_URL: ConnectionError("down")}
    client.post("/api/radio/scan", json={"session_id": play(client)})
    scanner.deps.run = lambda argv, **kw: (_ for _ in ()).throw(OSError("no ffmpeg"))
    client.post("/api/radio/scan", json={"session_id": play(client)})
    assert [p for p in os.listdir(tmp_path) if p.startswith("soulsync-scan-")] == []


def test_a_relayed_station_is_tapped_not_opened_again_and_the_relay_never_waits(app, client, config, db, net,
                                                                                tmp_path, monkeypatch):
    """The relay only copies audio into the tap; identification runs on a scan
    thread, and the relay keeps passing audio on throughout."""
    keys(config, acoustid=False, acr=False)
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    threads = []

    def answer(method, url, **kw):
        threads.append(threading.current_thread().name)
        return Resp(AUDD_HIT), url
    monkeypatch.setattr(scan_providers, "guarded_request", answer)
    opened = []
    radio_api.scanner.configure(ScanDeps(get_database=lambda: db, config=config, find_fpcalc=lambda: None,
                                         find_ffmpeg=lambda: "/bin/ffmpeg", run=fake_run,
                                         open_stream=lambda url: opened.append(url) or (Upstream(), "audio/mpeg")))
    radio_api.scanner.reset()
    radio_api.scanner.run_inline(False)
    st = builtin_station("dublab")
    sess = hub.start_session(1, st, st.streams[0], "relay")
    hub.claim_relay(sess.id, 1)
    feeding = threading.Event()

    def chunks():
        for _ in range(4000):
            feeding.wait(0.002)
            yield b"\xff\xfb" * 512
    up = Upstream()
    up.iter_content = lambda chunk_size=None: chunks()
    gen = relay.relay_chunks(hub, sess, up, "audio/mpeg")
    next(gen)  # the relay is live
    scan = radio_api.scanner.start(1, sess, st)
    relay_thread = threading.current_thread().name
    passed = 0
    for _ in gen:
        passed += 1
        if radio_api.scanner.get(scan.id, 1).state != "listening":
            break
    deadline = time.time() + 5
    while radio_api.scanner.get(scan.id, 1).state == "listening" and time.time() < deadline:
        time.sleep(0.02)
    out = radio_api.scanner.get(scan.id, 1)
    assert out.state == "identified" and out.via == "relay" and opened == []
    assert threads and all(t.startswith("radio-scan") for t in threads) and relay_thread not in threads
    assert passed > 0 and hub.tap_count() == 0
    sess.stop.set()
    list(gen)
    radio_api.scanner.reset()


def test_an_ogg_tap_keeps_the_stream_headers(app):
    st = builtin_station("dublab")
    sess = hub.start_session(1, st, st.streams[0], "relay")
    hub.claim_relay(sess.id, 1)
    up = Upstream(chunks=[b"OggS-head", b"more"] + [b"a" * 100] * 3, ctype="application/ogg")
    gen = relay.relay_chunks(hub, sess, up, "application/ogg")
    next(gen)
    tap = hub.add_tap(st.id, 150)
    assert tap.kind == "application/ogg" and tap.head.startswith(b"OggS-head")
    list(gen)
    assert tap.done.is_set() and len(tap.buf) == 150


def test_a_tap_fails_when_its_relay_ends(app):
    st = builtin_station("dublab")
    sess = hub.start_session(1, st, st.streams[0], "relay")
    hub.claim_relay(sess.id, 1)
    sess.audio_kind = "audio/mpeg"
    tap = hub.add_tap(st.id, 10**6)
    hub.relay_closed(sess.id)
    assert tap.failed and tap.done.is_set() and hub.add_tap(st.id, 10) is None


# ── Settings → Radio ─────────────────────────────────────────────────────────

def test_settings_show_scan_services_and_this_months_usage(client, config, db):
    keys(config, acr=False)
    store.bump_scan_usage(db, "audd", found=True)
    store.bump_scan_usage(db, "audd")
    body = client.get("/api/radio/settings").get_json()
    scan = body["scan"]
    assert scan["order"] == ["acoustid", "audd", "acrcloud"]
    assert scan["ready"]["audd"] and not scan["ready"]["acrcloud"]
    assert scan["usage"]["audd"] == {"requests": 2, "found": 1} and scan["usage"]["acrcloud"]["requests"] == 0


def test_service_tests(net, config):
    keys(config)
    net.answers = {scan_providers.ACOUSTID_URL: {"status": "error", "error": {"code": 3, "message": "fp"}},
                   scan_providers.AUDD_URL: AUDD_NONE, f"https://{HOST}": {"status": {"code": 2004}}}
    assert check_service(config, "acoustid") == {"ok": True, "state": "ok", "message": "AcoustID accepted the key.",
                                                 "spends": False}
    assert check_service(config, "audd")["ok"] and check_service(config, "audd")["spends"]
    assert check_service(config, "acrcloud")["ok"]
    net.answers[f"https://{HOST}"] = {"status": {"code": 3001}}
    out = check_service(config, "acrcloud")
    assert out["ok"] is False and out["state"] == "bad_key"
    config.clear_secret("radio.audd_api_token")
    assert check_service(config, "audd")["state"] == "missing"
