"""The outbound guard every radio fetch goes through (core/security/outbound.py):
private, loopback, link-local, metadata and multicast addresses are refused,
before DNS, after DNS, on every redirect, and again on the connected socket,
which is what stops a name whose answer changes between the check and the
connection (DNS rebinding). No test here reaches the internet."""

from __future__ import annotations

import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from core.security import outbound
from core.security.outbound import OutboundBlocked, check_url, guarded_request, is_public_ip

PUBLIC = "93.184.216.34"


@pytest.mark.parametrize("addr,public", [
    ("93.184.216.34", True),
    ("2606:2800:220:1:248:1893:25c8:1946", True),
    ("127.0.0.1", False),
    ("10.0.0.5", False),
    ("172.16.3.4", False),
    ("192.168.1.1", False),
    ("169.254.169.254", False),        # the cloud metadata address
    ("100.64.0.1", False),             # carrier-grade NAT
    ("0.0.0.0", False),
    ("224.0.0.251", False),            # multicast
    ("::1", False),
    ("fe80::1", False),
    ("fd00::1", False),
    ("::ffff:127.0.0.1", False),       # IPv4-mapped loopback
    ("::ffff:169.254.169.254", False),
    ("2002:7f00:1::", False),          # 6to4 wrapping 127.0.0.1
    ("ff02::1", False),
    ("not an ip", False),
])
def test_is_public_ip(addr, public):
    assert is_public_ip(addr) is public


@pytest.mark.parametrize("url", [
    "http://localhost/stream",
    "http://radio.local/stream",
    "http://box.lan:8000/",
    "http://intranet.internal/x",
    "ftp://example.com/stream",
    "file:///etc/passwd",
    "http://user:pass@example.com/",
    "",
])
def test_check_url_refuses_local_names_and_schemes_without_dns(url):
    calls = []
    ok, reason = check_url(url, resolver=lambda h, p: calls.append(h) or [PUBLIC])
    assert ok is False and reason
    assert calls == []


@pytest.mark.parametrize("answer", [["127.0.0.1"], ["192.168.0.10"], ["169.254.169.254"], [PUBLIC, "10.0.0.1"],
                                    ["::ffff:10.1.2.3"], []])
def test_check_url_refuses_names_that_resolve_privately(answer):
    ok, reason = check_url("https://stream.example.com/live", resolver=lambda h, p: answer)
    assert ok is False
    assert "private" in reason or "resolve" in reason


def test_check_url_accepts_a_public_name():
    assert check_url("https://stream.example.com:8443/live", resolver=lambda h, p: [PUBLIC]) == (True, "")


class FakeResp:
    def __init__(self, status=200, headers=None):
        self.status_code = status
        self.headers = headers or {}
        self.closed = False

    def close(self):
        self.closed = True


class FakeSession:
    def __init__(self, pages):
        self.pages = pages
        self.fetched = []

    def request(self, method, url, **kw):
        assert kw["allow_redirects"] is False, "redirects are walked by hand"
        self.fetched.append(url)
        return self.pages[url]


def test_redirect_to_a_private_address_is_refused():
    sess = FakeSession({"https://a.example.com/s": FakeResp(302, {"location": "http://192.168.1.1/admin"})})
    with pytest.raises(OutboundBlocked):
        guarded_request("GET", "https://a.example.com/s", session=sess,
                        resolver=lambda h, p: [h] if h[0].isdigit() else [PUBLIC])
    assert sess.fetched == ["https://a.example.com/s"]


def test_redirect_to_a_name_that_resolves_to_metadata_is_refused():
    sess = FakeSession({"https://a.example.com/s": FakeResp(301, {"location": "http://meta.example.net/latest"})})
    dns = {"a.example.com": [PUBLIC], "meta.example.net": ["169.254.169.254"]}
    with pytest.raises(OutboundBlocked):
        guarded_request("GET", "https://a.example.com/s", session=sess, resolver=lambda h, p: dns[h])
    assert sess.fetched == ["https://a.example.com/s"]


def test_public_redirects_are_followed_and_capped():
    pages = {f"https://h{i}.example.com/": FakeResp(302, {"location": f"https://h{i + 1}.example.com/"})
             for i in range(6)}
    sess = FakeSession(pages)
    with pytest.raises(OutboundBlocked, match="too many"):
        guarded_request("GET", "https://h0.example.com/", session=sess, resolver=lambda h, p: [PUBLIC])
    assert len(sess.fetched) == outbound.MAX_REDIRECTS + 1

    pages = {"https://h0.example.com/": FakeResp(302, {"location": "/next"}),
             "https://h0.example.com/next": FakeResp(200, {"content-type": "audio/mpeg"})}
    resp, final = guarded_request("GET", "https://h0.example.com/", session=FakeSession(pages),
                                  resolver=lambda h, p: [PUBLIC])
    assert final == "https://h0.example.com/next" and resp.status_code == 200


# ── the pinned connection (DNS rebinding) ────────────────────────────────────

class _Hits(BaseHTTPRequestHandler):
    hits = []

    def do_GET(self):  # noqa: N802
        _Hits.hits.append(self.path)
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.end_headers()
        self.wfile.write(b"x")

    def log_message(self, *a):
        pass


@pytest.fixture
def local_server():
    _Hits.hits = []
    server = HTTPServer(("127.0.0.1", 0), _Hits)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server.server_address[1]
    server.shutdown()
    server.server_close()


def test_rebinding_between_the_check_and_the_connection_is_refused(local_server, monkeypatch):
    """The check sees a public answer; the connection's own lookup gets a
    loopback one. The pinned connection resolves for itself and refuses."""
    answers = iter([[PUBLIC], ["127.0.0.1"], ["127.0.0.1"], ["127.0.0.1"]])
    monkeypatch.setattr(outbound, "resolve", lambda host, port: next(answers))
    with pytest.raises(OutboundBlocked):
        guarded_request("GET", f"http://rebind.example.com:{local_server}/stream", timeout=(2, 2))
    assert _Hits.hits == []


def test_a_connection_that_lands_on_a_private_peer_is_closed_unused(local_server, monkeypatch):
    """Every lookup says public, but the socket ends up on 127.0.0.1 (a
    network-level redirect): the peer check refuses before a byte is sent."""
    monkeypatch.setattr(outbound, "resolve", lambda host, port: [PUBLIC])
    from urllib3.util import connection as u3conn
    real = u3conn.create_connection
    monkeypatch.setattr(u3conn, "create_connection",
                        lambda addr, *a, **kw: real(("127.0.0.1", local_server), *a, **kw))
    with pytest.raises(OutboundBlocked):
        guarded_request("GET", f"http://public.example.com:{local_server}/stream", timeout=(2, 2))
    assert _Hits.hits == []


def test_the_session_ignores_proxy_settings_from_the_environment(monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9")
    assert outbound.guarded_session().trust_env is False


def test_resolve_returns_nothing_for_a_bad_name(monkeypatch):
    def boom(*a, **kw):
        raise socket.gaierror("no")
    monkeypatch.setattr(socket, "getaddrinfo", boom)
    assert outbound.resolve("nope.invalid", 80) == []
