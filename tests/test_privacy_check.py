"""Privacy check (core/privacy_check.py, GET /api/setup/privacy).

Gluetun's control server, slskd and the torrent client are fakes answering by
URL, so every state (up, down, no port, a port nobody listens on, a service
outside the VPN, a kill switch that didn't hold) runs without a VPN.
"""

from __future__ import annotations

import json

import pytest
import requests
from flask import Flask

from core import privacy_check as pc
from core import setup_check as sc

GLUETUN = "http://gluetun:8000"
SLSKD = "http://gluetun:5030"
QBIT = "http://gluetun:8080"
VPN_IP = "185.65.134.10"
HOME_IP = "81.2.69.160"


class FakeResp:
    def __init__(self, status=200, data=None):
        self.status_code = status
        self._data = data
        self.content = json.dumps(data).encode() if data is not None else b""

    def json(self):
        return self._data


class FakeHttp:
    def __init__(self, routes):
        self.routes = dict(routes)
        self.calls = []

    def get(self, url, headers=None, params=None, timeout=None):
        assert timeout is not None, "every request carries a timeout"
        self.calls.append((url, dict(headers or {})))
        for prefix, value in self.routes.items():
            if url == prefix:
                if isinstance(value, BaseException):
                    raise value
                return value
        return FakeResp(404, {"error": "not found"})


def gluetun_routes(*, status="running", ip=VPN_IP, country="Netherlands", city="Amsterdam", port=51234,
                   base=GLUETUN):
    return {
        f"{base}/v1/vpn/status": FakeResp(200, {"status": status}),
        f"{base}/v1/publicip/ip": FakeResp(200, {"public_ip": ip if status == "running" else "",
                                                 "country": country, "city": city}),
        f"{base}/v1/portforward": FakeResp(200, {"port": port or 0, "ports": [port] if port else []}),
    }


def slskd_routes(*, listen=51234, logged_in=True, integration=True, ready=True, base=SLSKD):
    opts = {"soulseek": {"listenPort": listen}}
    if integration:
        opts["integrations"] = {"vpn": {"enabled": True, "portForwarding": True,
                                       "gluetun": {"url": "http://127.0.0.1:8000", "apiKey": "*****"}}}
    return {
        f"{base}/api/v0/options": FakeResp(200, opts),
        f"{base}/api/v0/application": FakeResp(200, {"vpn": {"isReady": ready, "isConnected": ready}}),
        f"{base}/api/v0/server": FakeResp(200, {"isConnected": logged_in, "isLoggedIn": logged_in}),
    }


SAME_HOST = {"gluetun": ["172.20.0.5"], "slskd": ["172.20.0.5"], "qbittorrent": ["172.20.0.5"]}
OWN_HOSTS = {"gluetun": ["172.20.0.5"], "slskd": ["172.20.0.9"], "qbittorrent": ["172.20.0.5"]}


def make_ctx(*, routes, cfg=None, hosts=SAME_HOST, torrent_port=51234, home=None, home_calls=None):
    config = {
        "privacy.gluetun_url": GLUETUN,
        "privacy.gluetun_api_key": "k3y",
        "download_source.mode": "soulseek",
        "soulseek.slskd_url": SLSKD,
        "soulseek.api_key": "slsk",
        "torrent_client.type": "qbittorrent",
        "torrent_client.url": QBIT,
    }
    config.update(cfg or {})

    def resolve(host):
        if host not in hosts:
            raise OSError("no such host")
        return hosts[host]

    def fetch_home():
        if home_calls is not None:
            home_calls.append(1)
        if isinstance(home, BaseException):
            raise home
        return home or HOME_IP

    return sc.SetupCheckContext(get=lambda k, d=None: config.get(k, d), http=FakeHttp(routes), env={},
                                read_mountinfo=lambda: "", resolve_host=resolve, home_ip_fetch=fetch_home,
                                torrent_listen_port=lambda kind: torrent_port)


@pytest.fixture(autouse=True)
def _fresh_home_cache():
    pc.forget_home_address()
    yield
    pc.forget_home_address()


def rows(report):
    return {r["id"]: r for r in report["rows"]}


# ---------------------------------------------------------------------------
# the states
# ---------------------------------------------------------------------------

def test_up_with_port_and_both_listening_is_protected():
    ctx = make_ctx(routes={**gluetun_routes(), **slskd_routes()})
    report = pc.run_privacy_check(ctx)
    assert report["state"] == pc.PROTECTED and report["tone"] == sc.OK
    assert report["headline"] == ("Soulseek and torrents go through Proton VPN (Netherlands) · port 51234 forwarded · "
                                  "if the VPN drops, they stop")
    r = rows(report)
    assert r["privacy.vpn"]["status"] == sc.OK
    assert r["privacy.port"]["status"] == sc.OK and "slskd and qBittorrent listen on it" in r["privacy.port"]["detail"]
    assert r["privacy.kill_switch"]["status"] == sc.OK
    assert "leaves Soulseek" in r["privacy.kill_switch"]["detail"]
    assert report["vpn"]["forwarded_port"] == 51234
    assert report["addresses"]["vpn"] == VPN_IP


def test_vpn_down_says_downloads_are_stopped():
    ctx = make_ctx(routes={**gluetun_routes(status="stopped"), **slskd_routes(logged_in=False, ready=False)})
    report = pc.run_privacy_check(ctx)
    assert report["state"] == pc.VPN_DOWN and report["tone"] == sc.ERROR
    assert report["headline"] == "VPN is down: Soulseek and torrents are stopped until it's back"
    r = rows(report)
    assert r["privacy.vpn"]["status"] == sc.ERROR and "'stopped'" in r["privacy.vpn"]["detail"]
    assert r["privacy.port"]["status"] == sc.SKIPPED
    assert r["privacy.address"]["status"] == sc.SKIPPED


def test_running_without_a_public_address_reads_as_connecting():
    routes = gluetun_routes()
    routes[f"{GLUETUN}/v1/publicip/ip"] = FakeResp(200, {"public_ip": ""})
    report = pc.run_privacy_check(make_ctx(routes={**routes, **slskd_routes(logged_in=False)}))
    assert report["state"] == pc.VPN_DOWN
    assert "hasn't found its public address" in rows(report)["privacy.vpn"]["detail"]


def test_no_forwarded_port_degrades_clearly():
    ctx = make_ctx(routes={**gluetun_routes(port=None), **slskd_routes(listen=50300)})
    report = pc.run_privacy_check(ctx)
    assert report["state"] == pc.NO_PORT and report["tone"] == sc.WARNING
    assert report["headline"] == "Connected, no forwarded port: downloads work but fewer people can reach you"
    port = rows(report)["privacy.port"]
    assert port["status"] == sc.WARNING and "Plus or higher" in port["fix"]
    assert rows(report)["privacy.kill_switch"]["status"] == sc.OK


def test_a_port_nobody_listens_on_is_a_mismatch():
    ctx = make_ctx(routes={**gluetun_routes(port=51234), **slskd_routes(listen=50300)}, torrent_port=6881)
    report = pc.run_privacy_check(ctx)
    assert report["state"] == pc.PORT_MISMATCH and report["tone"] == sc.WARNING
    port = rows(report)["privacy.port"]
    assert "slskd listens on 50300" in port["detail"] and "qBittorrent listens on 6881" in port["detail"]
    assert "SLSKD_VPN" in port["fix"] and "Bypass authentication" in port["fix"]
    assert "51234" in report["headline"]


def test_only_slskd_mismatched_names_only_slskd():
    ctx = make_ctx(routes={**gluetun_routes(), **slskd_routes(listen=50300)})
    port = rows(pc.run_privacy_check(ctx))["privacy.port"]
    assert "slskd listens on 50300" in port["detail"] and "qBittorrent" not in port["detail"]
    assert "Bypass authentication" not in port["fix"]


def test_slskd_in_its_own_container_is_not_using_the_vpn():
    ctx = make_ctx(routes={**gluetun_routes(), **slskd_routes(integration=False, base="http://slskd:5030")},
                   cfg={"soulseek.slskd_url": "http://slskd:5030", "torrent_client.type": ""}, hosts=OWN_HOSTS)
    report = pc.run_privacy_check(ctx)
    assert report["state"] == pc.NO_VPN and report["tone"] == sc.ERROR
    assert report["headline"] == "Not using a VPN: Soulseek shows your home IP"
    assert rows(report)["privacy.address"]["status"] == sc.ERROR
    assert rows(report)["privacy.kill_switch"]["status"] == sc.ERROR


def test_one_service_outside_names_it():
    ctx = make_ctx(routes={**gluetun_routes(), **slskd_routes(integration=False, base="http://slskd:5030")},
                   cfg={"soulseek.slskd_url": "http://slskd:5030", "torrent_client.url": "http://qbittorrent:8080"},
                   hosts=OWN_HOSTS)
    report = pc.run_privacy_check(ctx)
    assert report["headline"] == "Soulseek doesn't go through the VPN: it shows your home IP"


def test_vpn_down_but_slskd_still_signed_in_is_a_leak():
    ctx = make_ctx(routes={**gluetun_routes(status="stopped"), **slskd_routes(logged_in=True, ready=False)})
    report = pc.run_privacy_check(ctx)
    assert report["state"] == pc.LEAK and report["tone"] == sc.ERROR
    ks = rows(report)["privacy.kill_switch"]
    assert ks["status"] == sc.ERROR and "docker compose stop slskd" in ks["fix"]


def test_slskd_reaching_gluetun_on_loopback_proves_it_is_inside():
    # SYNCHRO.S reaches slskd through the Docker host, which proves nothing,
    # but slskd's own integration talks to Gluetun at 127.0.0.1
    base = "http://192.168.1.20:5030"
    ctx = make_ctx(routes={**gluetun_routes(), **slskd_routes(base=base)},
                   cfg={"soulseek.slskd_url": base, "torrent_client.type": ""}, hosts={"gluetun": ["172.20.0.5"]})
    report = pc.run_privacy_check(ctx)
    assert report["state"] == pc.PROTECTED and report["tone"] == sc.OK
    assert report["services"][0]["inside"] is True
    assert report["headline"].startswith("Soulseek goes through Proton VPN (Netherlands)")
    assert report["headline"].endswith("if the VPN drops, it stops")


def test_an_address_that_proves_nothing_leaves_the_kill_switch_unconfirmed():
    base = "http://host.docker.internal:5030"
    ctx = make_ctx(routes={**gluetun_routes(), **slskd_routes(integration=False, base=base)},
                   cfg={"soulseek.slskd_url": base, "torrent_client.type": ""})
    report = pc.run_privacy_check(ctx)
    assert report["state"] == pc.PROTECTED and report["tone"] == sc.WARNING
    assert report["headline"].endswith("kill switch not confirmed")
    assert rows(report)["privacy.kill_switch"]["status"] == sc.WARNING


def test_gluetun_unreachable():
    down = requests.exceptions.ConnectionError("refused")
    routes = {f"{GLUETUN}/v1/vpn/status": down, f"{SLSKD}/api/v0/options": down}
    report = pc.run_privacy_check(make_ctx(routes=routes))
    assert report["state"] == pc.UNREACHABLE and report["tone"] == sc.ERROR
    assert "slskd isn't answering either" in rows(report)["privacy.vpn"]["detail"]


def test_something_else_at_the_address():
    routes = {f"{GLUETUN}/v1/vpn/status": FakeResp(200, {"hello": "world"}), **slskd_routes()}
    report = pc.run_privacy_check(make_ctx(routes=routes))
    assert report["state"] == pc.UNREACHABLE
    assert "isn't Gluetun's control server" in rows(report)["privacy.vpn"]["detail"]


@pytest.mark.parametrize("route", ["/v1/vpn/status", "/v1/publicip/ip", "/v1/portforward"])
def test_a_refused_key_is_said_not_misread_as_down(route):
    routes = {**gluetun_routes(), **slskd_routes()}
    routes[f"{GLUETUN}{route}"] = FakeResp(401, None)
    report = pc.run_privacy_check(make_ctx(routes=routes))
    assert report["state"] == pc.REFUSED and report["tone"] == sc.WARNING
    assert "GLUETUN_API_KEY" in rows(report)["privacy.vpn"]["fix"]


def test_the_key_is_sent_as_x_api_key():
    ctx = make_ctx(routes={**gluetun_routes(), **slskd_routes()})
    pc.run_privacy_check(ctx)
    sent = [h for url, h in ctx.http.calls if url.startswith(GLUETUN)]
    assert sent and all(h.get("X-API-Key") == "k3y" for h in sent)


def test_not_set_up_says_how_and_asks_nothing():
    ctx = make_ctx(routes={}, cfg={"privacy.gluetun_url": ""})
    report = pc.run_privacy_check(ctx)
    assert report["state"] == pc.NOT_SET_UP and report["configured"] is False
    assert "home IP" in report["rows"][0]["detail"] and "gluetun:8000" in report["rows"][0]["fix"]
    assert ctx.http.calls == []


# ---------------------------------------------------------------------------
# the home address
# ---------------------------------------------------------------------------

def test_home_same_as_vpn_address_is_a_leak():
    ctx = make_ctx(routes={**gluetun_routes(), **slskd_routes()}, cfg={"privacy.home_ip_lookup": True}, home=VPN_IP)
    report = pc.run_privacy_check(ctx)
    assert report["state"] == pc.LEAK
    assert rows(report)["privacy.address"]["status"] == sc.ERROR


def test_home_different_is_said():
    ctx = make_ctx(routes={**gluetun_routes(), **slskd_routes()}, cfg={"privacy.home_ip_lookup": True})
    report = pc.run_privacy_check(ctx)
    assert report["state"] == pc.PROTECTED
    assert "different from your home connection's" in rows(report)["privacy.address"]["detail"]
    assert report["addresses"]["home"] == HOME_IP and report["addresses"]["home_lookup"] is True


@pytest.mark.gauntlet
def test_home_lookup_never_runs_when_off():
    calls = []
    ctx = make_ctx(routes={**gluetun_routes(), **slskd_routes()}, home_calls=calls)
    report = pc.run_privacy_check(ctx)
    assert calls == []
    assert report["addresses"]["home"] is None and report["addresses"]["home_lookup"] is False
    assert "isn't looked up" in rows(report)["privacy.address"]["detail"]


@pytest.mark.gauntlet
def test_home_lookup_is_one_call_an_hour():
    calls = []
    clock = [1000.0]
    for _ in range(3):
        pc.home_address(True, fetch=lambda: calls.append(1) or HOME_IP, now=lambda: clock[0])
    assert len(calls) == 1
    clock[0] += pc.HOME_IP_TTL_S + 1
    assert pc.home_address(True, fetch=lambda: calls.append(1) or HOME_IP, now=lambda: clock[0]).ip == HOME_IP
    assert len(calls) == 2


def test_home_lookup_failure_retries_after_five_minutes():
    calls = []
    clock = [1000.0]

    def boom():
        calls.append(1)
        raise OSError("offline")
    first = pc.home_address(True, fetch=boom, now=lambda: clock[0])
    assert first.ip == "" and first.error
    pc.home_address(True, fetch=boom, now=lambda: clock[0] + 60)
    assert len(calls) == 1
    pc.home_address(True, fetch=boom, now=lambda: clock[0] + pc.HOME_IP_RETRY_S + 1)
    assert len(calls) == 2


def test_home_lookup_rejects_garbage():
    got = pc.home_address(True, fetch=lambda: "<html>", now=lambda: 1.0)
    assert got.ip == "" and got.error


def test_home_lookup_uses_the_outbound_guard_once(monkeypatch):
    seen = []

    def fake_guarded_json(method, url, **kw):
        seen.append((method, url, kw.get("max_bytes")))
        return 200, {"ip": HOME_IP}
    monkeypatch.setattr("core.security.outbound.guarded_json", fake_guarded_json)
    assert pc.home_address(True).ip == HOME_IP
    assert pc.home_address(True).ip == HOME_IP
    assert seen == [("GET", pc.HOME_IP_SERVICE, 4096)]


@pytest.mark.gauntlet
def test_ip_addresses_never_appear_in_row_text():
    """Rows go into the copyable setup-check report and the Assistant's
    summary; only the admin-only privacy route carries addresses."""
    for ctx in (
        make_ctx(routes={**gluetun_routes(), **slskd_routes()}, cfg={"privacy.home_ip_lookup": True}),
        make_ctx(routes={**gluetun_routes(), **slskd_routes()}, cfg={"privacy.home_ip_lookup": True}, home=VPN_IP),
        make_ctx(routes={**gluetun_routes(status="stopped"), **slskd_routes()}),
    ):
        pc.forget_home_address()
        report = pc.run_privacy_check(ctx)
        text = json.dumps(report["rows"]) + report["headline"]
        assert VPN_IP not in text and HOME_IP not in text


# ---------------------------------------------------------------------------
# the setup check and the settings
# ---------------------------------------------------------------------------

def test_setup_check_runs_privacy_rows_only_when_configured():
    ctx = make_ctx(routes={**gluetun_routes(), **slskd_routes()})
    tasks, _ = sc._tasks(ctx, include_network=True)
    assert any(t.category == pc.CATEGORY for t in tasks)
    local, _ = sc._tasks(ctx, include_network=False)
    assert not any(t.category == pc.CATEGORY for t in local)
    unset = make_ctx(routes={}, cfg={"privacy.gluetun_url": ""})
    tasks, _ = sc._tasks(unset, include_network=True)
    assert not any(t.category == pc.CATEGORY for t in tasks)


def test_check_rows_are_setup_check_results():
    ctx = make_ctx(routes={**gluetun_routes(), **slskd_routes()})
    out = pc.check_rows(ctx)
    assert {r["id"] for r in out} == {"privacy.vpn", "privacy.address", "privacy.port", "privacy.kill_switch"}
    assert all(r["category"] == "privacy" and r["status"] in sc.STATUSES for r in out)


@pytest.mark.parametrize("raw,expected", [
    ("http://gluetun:8000", "http://gluetun:8000"),
    ("  http://gluetun:8000/ ", "http://gluetun:8000"),
    ("https://10.0.0.2:8000", "https://10.0.0.2:8000"),
    ("", ""),
    (None, ""),
    ("gluetun:8000", None),
    ("ftp://gluetun:8000", None),
    ("http://user:pw@gluetun:8000", None),
    ("http://gluetun:8000/v1/vpn", None),
    ("http://gluetun:8000?x=1", None),
    ("http://glu tun:8000", None),
    ("http://gluetun:99999", None),
])
def test_clean_control_url(raw, expected):
    assert pc.clean_control_url(raw) == expected


def test_settings_state_never_holds_the_key():
    ctx = make_ctx(routes={})
    state = pc.settings_state(ctx)
    assert state["api_key_set"] is True and "k3y" not in json.dumps(state)


# ---------------------------------------------------------------------------
# the routes
# ---------------------------------------------------------------------------

class FakeConfig:
    def __init__(self, data=None):
        self.data = dict(data or {})
        self.cleared = []

    def get(self, key, default=None):
        return self.data.get(key, default)

    def set(self, key, value):
        self.data[key] = value

    def clear_secret(self, key):
        self.cleared.append(key)
        self.data.pop(key, None)
        return True


@pytest.fixture
def api(monkeypatch):
    from api import setup_check as api_mod
    app = Flask(__name__)
    app.config["TESTING"] = True
    app.register_blueprint(api_mod.create_blueprint())
    cfg = FakeConfig({"privacy.gluetun_api_key": "old"})
    monkeypatch.setattr("core.settings.config_manager", cfg)
    monkeypatch.setitem(sc._DEFAULTS, "config_manager", cfg)
    ran = []

    def fake_run(ctx=None):
        ran.append(1)
        return {"state": pc.PROTECTED, "tone": sc.OK, "headline": "fine", "rows": [], "configured": True,
                "addresses": {"vpn": VPN_IP}}
    monkeypatch.setattr(pc, "run_privacy_check", fake_run)
    return app.test_client(), cfg, ran


@pytest.mark.gauntlet
def test_privacy_routes_refuse_non_admin(api, monkeypatch):
    client, cfg, ran = api
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: False)
    assert client.get("/api/setup/privacy").status_code == 403
    resp = client.put("/api/setup/privacy/settings", json={"gluetun_url": "http://evil:8000"})
    assert resp.status_code == 403
    assert ran == [] and "privacy.gluetun_url" not in cfg.data


def test_privacy_route_for_admin(api, monkeypatch):
    client, _, ran = api
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: True)
    resp = client.get("/api/setup/privacy")
    assert resp.status_code == 200 and resp.headers["Cache-Control"] == "no-store"
    body = resp.get_json()
    assert body["success"] is True and body["state"] == pc.PROTECTED and ran == [1]


def test_save_settings(api, monkeypatch):
    client, cfg, _ = api
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: True)
    resp = client.put("/api/setup/privacy/settings",
                      json={"gluetun_url": "http://gluetun:8000/", "api_key": " newkey ", "home_ip_lookup": True})
    assert resp.status_code == 200
    body = resp.get_json()
    assert cfg.data["privacy.gluetun_url"] == "http://gluetun:8000"
    assert cfg.data["privacy.gluetun_api_key"] == "newkey"
    assert cfg.data["privacy.home_ip_lookup"] is True
    assert body["settings"]["api_key_set"] is True and "newkey" not in resp.get_data(as_text=True)


def test_save_settings_clears_the_key_on_empty(api, monkeypatch):
    client, cfg, _ = api
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: True)
    assert client.put("/api/setup/privacy/settings", json={"api_key": ""}).status_code == 200
    assert cfg.cleared == ["privacy.gluetun_api_key"]


@pytest.mark.parametrize("body,field", [
    ({"gluetun_url": "gluetun:8000"}, "gluetun_url"),
    ({"gluetun_url": 5}, "gluetun_url"),
    ({"api_key": "has space"}, "api_key"),
    ({"api_key": 12}, "api_key"),
    ({"home_ip_lookup": "yes"}, "home_ip_lookup"),
])
def test_save_settings_refuses_bad_values(api, monkeypatch, body, field):
    client, cfg, _ = api
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: True)
    resp = client.put("/api/setup/privacy/settings", json=body)
    assert resp.status_code == 400 and resp.get_json()["field"] == field
    assert cfg.data == {"privacy.gluetun_api_key": "old"}


def test_save_settings_needs_json_and_a_size(api, monkeypatch):
    client, _, _ = api
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: True)
    assert client.put("/api/setup/privacy/settings", data="gluetun_url=x",
                      content_type="application/x-www-form-urlencoded").status_code == 400
    big = json.dumps({"api_key": "a" * 5000})
    assert client.put("/api/setup/privacy/settings", data=big,
                      content_type="application/json").status_code == 413


def test_turning_the_lookup_off_forgets_the_cached_address(api, monkeypatch):
    client, _, _ = api
    monkeypatch.setattr("core.profile_context.is_admin_request", lambda: True)
    pc.home_address(True, fetch=lambda: HOME_IP, now=lambda: 1.0)
    assert pc._home_cache
    client.put("/api/setup/privacy/settings", json={"home_ip_lookup": False})
    assert not pc._home_cache


# ---------------------------------------------------------------------------
# the torrent clients' listening port
# ---------------------------------------------------------------------------

class _Resp:
    def __init__(self, status, data):
        self.status_code, self._data, self.ok = status, data, 200 <= status < 300

    def json(self):
        return self._data


def test_qbittorrent_listen_port(monkeypatch):
    from core.torrent_clients.qbittorrent import QBittorrentAdapter
    a = QBittorrentAdapter.__new__(QBittorrentAdapter)
    monkeypatch.setattr(a, "_call", lambda m, p, **kw: _Resp(200, {"listen_port": 51234}), raising=False)
    assert a.listen_port() == 51234
    monkeypatch.setattr(a, "_call", lambda m, p, **kw: _Resp(200, {"listen_port": 0}), raising=False)
    assert a.listen_port() is None
    monkeypatch.setattr(a, "_call", lambda m, p, **kw: None, raising=False)
    assert a.listen_port() is None


def test_transmission_listen_port(monkeypatch):
    from core.torrent_clients.transmission import TransmissionAdapter
    a = TransmissionAdapter.__new__(TransmissionAdapter)
    monkeypatch.setattr(a, "_rpc", lambda method, args: {"peer-port": 51413}, raising=False)
    assert a.listen_port() == 51413
    monkeypatch.setattr(a, "_rpc", lambda method, args: None, raising=False)
    assert a.listen_port() is None


def test_deluge_listen_port(monkeypatch):
    from core.torrent_clients.deluge import DelugeAdapter
    a = DelugeAdapter.__new__(DelugeAdapter)
    monkeypatch.setattr(a, "_ensure_session_sync", lambda: object(), raising=False)
    monkeypatch.setattr(a, "_rpc_sync", lambda method, params: [6881, 6891], raising=False)
    assert a.listen_port() == 6881
