"""Privacy check: do Soulseek and torrents go through the VPN?

The optional VPN set-up (``docker-compose.vpn.yml``, ``Support/VPN.md``) runs
slskd and the torrent client inside Gluetun's network: Gluetun holds the VPN
(Proton VPN over WireGuard), its firewall is the kill switch, and Proton's
forwarded port becomes slskd's and the torrent client's listening port.

This module answers, in plain words, the four questions a person has about
that set-up:

* Is the VPN up? (Gluetun's control server, ``GET /v1/vpn/status`` and
  ``GET /v1/publicip/ip``, which is empty while the tunnel is down.)
* Which address do peers see, and is it different from the home address?
  (Gluetun's public IP; the home address only when the person turned on the
  one outside look-up, :data:`HOME_IP_SERVICE`, cached for an hour.)
* Is a port forwarded, and do slskd and the torrent client listen on it?
  (``GET /v1/portforward``; slskd's ``GET /api/v0/options``; the torrent
  client's own preferences.)
* Is the kill switch on? Gluetun doesn't report its firewall, so this is
  proved from where slskd and the torrent client are: only when SYNCHRO.S
  reaches them and Gluetun by Docker service names that lead to one container
  on its own Docker network are they known to be inside Gluetun's network,
  with no other way out. Anything else (a LAN address, a name with a dot, the
  Docker host, slskd's own Gluetun integration on its own) is "not confirmed",
  never green. If slskd still looks signed in to Soulseek while the VPN is
  down, in two reads a few seconds apart, the check says to check it.

It runs only when Gluetun's control address is set (``privacy.gluetun_url``).
Every request has a short timeout, nothing is changed anywhere, and IP
addresses appear only in :func:`run_privacy_check`'s ``addresses`` (served
admin-only), never in a row's sentence, so a copied setup-check report or the
Assistant's summary doesn't carry them.
"""

from __future__ import annotations

import ipaddress
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple
from urllib.parse import urlparse

from utils.logging_config import get_logger

logger = get_logger("privacy_check")

CATEGORY = "privacy"

SETTING_URL = "privacy.gluetun_url"
SETTING_KEY = "privacy.gluetun_api_key"
SETTING_HOME_LOOKUP = "privacy.home_ip_lookup"
SETTING_VPN_NAME = "privacy.vpn_name"
DEFAULT_VPN_NAME = "Proton VPN"

#: The one outside service asked, and only when the person turned it on:
#: ipify answers with the address the request came from and nothing else.
HOME_IP_SERVICE = "https://api.ipify.org?format=json"
HOME_IP_TTL_S = 3600.0
HOME_IP_RETRY_S = 300.0

#: The whole privacy run (four sources at once) ends within this.
DEADLINE_S = 15.0

_SETUP_HINT = ("Run slskd (and your torrent client) through the VPN with the VPN file (Support/VPN.md), then set "
               "Gluetun's control address here, e.g. `http://gluetun:8000`, with the GLUETUN_API_KEY from your "
               "`.env`.")

# State names the web app keys on.
NOT_SET_UP = "not_set_up"
UNREACHABLE = "unreachable"
REFUSED = "refused"
VPN_DOWN = "vpn_down"
LEAK = "leak"
NO_VPN = "not_using_vpn"
NO_PORT = "no_port"
PORT_MISMATCH = "port_mismatch"
SERVICE_DOWN = "service_unreachable"
NOT_CONFIRMED = "not_confirmed"
PROTECTED = "protected"

_TORRENT_NAMES = {"qbittorrent": "qBittorrent", "transmission": "Transmission", "deluge": "Deluge",
                  "aria2": "aria2"}
_HOST_GATEWAYS = frozenset({"localhost", "host.docker.internal", "gateway.docker.internal",
                            "host-gateway", "docker.for.mac.localhost"})


# ---------------------------------------------------------------------------
# What was read
# ---------------------------------------------------------------------------

@dataclass
class Gluetun:
    url: str
    reachable: bool = False
    refused: bool = False          # 401/403: the key is wrong or the route isn't allowed
    error: str = ""
    status: str = ""               # running | stopped | starting | crashed | ...
    public_ip: str = ""
    country: str = ""
    city: str = ""
    ports: List[int] = field(default_factory=list)
    port_read: bool = False

    @property
    def up(self) -> bool:
        return self.reachable and self.status == "running" and bool(self.public_ip)

    @property
    def port(self) -> Optional[int]:
        return self.ports[0] if self.ports else None


@dataclass
class Service:
    """slskd or the torrent client, as far as the check could see it."""
    key: str                       # slskd | torrent
    name: str                      # slskd | qBittorrent | ...
    url: str
    reachable: Optional[bool] = None
    listen_port: Optional[int] = None
    inside: Optional[bool] = None  # in Gluetun's network: True / False / None (can't tell)
    how: str = ""                  # how ``inside`` was decided
    logged_in: Optional[bool] = None          # slskd only: signed in to Soulseek
    vpn_integration: Optional[bool] = None    # slskd only: its own Gluetun integration is on
    vpn_ready: Optional[bool] = None          # slskd only: what that integration says
    integration_loopback: bool = False        # slskd only: the integration reaches Gluetun at 127.0.0.1
    kind: str = ""                            # torrent only: qbittorrent | transmission | ...


@dataclass
class HomeAddress:
    enabled: bool
    ip: str = ""
    checked_at: Optional[float] = None
    error: str = ""


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _port(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    try:
        port = int(value)
    except (TypeError, ValueError):
        return None
    return port if 0 < port < 65536 else None


def _valid_ip(value: Any) -> str:
    try:
        return str(ipaddress.ip_address(str(value).strip()))
    except ValueError:
        return ""


def clean_control_url(raw: Any) -> Optional[str]:
    """Gluetun's control address as typed, or None when it isn't one: http or
    https, a host, an optional port, nothing after it (no path, query or
    user name). An empty value is ``""`` (not set)."""
    text = str(raw or "").strip().rstrip("/")
    if not text:
        return ""
    if len(text) > 200 or any(c.isspace() for c in text):
        return None
    try:
        parsed = urlparse(text)
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        return None
    if port is not None and not 0 < port < 65536:
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


def _default_resolve(host: str) -> List[str]:
    infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    return sorted({str(i[4][0]) for i in infos})


def _names(services: Sequence[Service]) -> str:
    return " and ".join(s.name for s in services)


# ---------------------------------------------------------------------------
# The home address (one outside call, cached, only when turned on)
# ---------------------------------------------------------------------------

_home_lock = threading.Lock()
_home_cache: Dict[str, Any] = {}


def _fetch_home_ip() -> str:
    from core.security.outbound import guarded_json
    status, data = guarded_json("GET", HOME_IP_SERVICE, timeout=(3.05, 5.0), max_bytes=4096)
    if status != 200 or not isinstance(data, dict):
        raise RuntimeError(f"the address service answered HTTP {status}")
    ip = _valid_ip(data.get("ip"))
    if not ip:
        raise RuntimeError("the address service sent something that isn't an address")
    return ip


def home_address(enabled: bool, fetch: Optional[Callable[[], str]] = None,
                 now: Optional[Callable[[], float]] = None) -> HomeAddress:
    """The home connection's public address, asked of :data:`HOME_IP_SERVICE`
    at most once an hour (once every five minutes after a failure), and never
    when the look-up is off."""
    if not enabled:
        return HomeAddress(enabled=False)
    clock = now or time.time
    with _home_lock:
        cached = dict(_home_cache)
    t = clock()
    if cached:
        ttl = HOME_IP_TTL_S if cached.get("ip") else HOME_IP_RETRY_S
        if t - cached["at"] < ttl:
            return HomeAddress(True, cached.get("ip", ""), cached["at"], cached.get("error", ""))
    try:
        ip = (fetch or _fetch_home_ip)()
        entry = {"ip": _valid_ip(ip), "at": t, "error": ""}
        if not entry["ip"]:
            entry["error"] = "the address service sent something that isn't an address"
    except Exception as exc:  # noqa: BLE001 - offline, blocked, garbled: all "couldn't tell"
        logger.info("home address look-up failed: %s", exc)
        entry = {"ip": "", "at": t, "error": "the address service didn't answer"}
    with _home_lock:
        _home_cache.clear()
        _home_cache.update(entry)
    return HomeAddress(True, entry["ip"], entry["at"], entry["error"])


def forget_home_address() -> None:
    with _home_lock:
        _home_cache.clear()


# ---------------------------------------------------------------------------
# Reading Gluetun, slskd and the torrent client
# ---------------------------------------------------------------------------

#: Gluetun's answers are a few dozen bytes; anything bigger isn't Gluetun.
GLUETUN_MAX_BYTES = 16 * 1024
_KNOWN_STATUSES = frozenset({"running", "stopped", "starting", "stopping", "crashed", "completed"})


def _gluetun_get(ctx, url: str, headers: Dict[str, str]):
    """``(status, data, kind)`` for one control-server GET: redirects are not
    followed (the key would go with them), the body is capped, and network
    failures come back as a kind, like the setup check's ``http_get``."""
    import json

    import requests

    from core import setup_check as sc
    try:
        resp = ctx.http.get(url, headers=dict(headers), timeout=sc.HTTP_TIMEOUT, allow_redirects=False,
                            stream=True)
    except requests.exceptions.Timeout:
        return None, None, "timeout"
    except (requests.exceptions.InvalidURL, requests.exceptions.MissingSchema,
            requests.exceptions.InvalidSchema):
        return None, None, "bad_url"
    except requests.exceptions.RequestException:
        return None, None, "unreachable"
    try:
        status = int(resp.status_code)
        reader = getattr(resp, "iter_content", None)
        if callable(reader):
            chunks, total = [], 0
            for chunk in reader(chunk_size=4096):
                total += len(chunk or b"")
                if total > GLUETUN_MAX_BYTES:
                    return status, None, "too_large"
                chunks.append(chunk or b"")
            body = b"".join(chunks)
        else:
            body = getattr(resp, "content", b"") or b""
            if len(body) > GLUETUN_MAX_BYTES:
                return status, None, "too_large"
    except Exception:  # noqa: BLE001 - the answer broke off
        return None, None, "unreachable"
    finally:
        closer = getattr(resp, "close", None)
        if callable(closer):
            closer()
    try:
        data = json.loads(body.decode("utf-8", errors="replace")) if body.strip() else None
    except ValueError:
        data = None
    return status, data, ""


def read_gluetun(ctx, url: str) -> Gluetun:
    g = Gluetun(url=url)
    key = ctx.cfg_str(SETTING_KEY, "")
    headers = {"X-API-Key": key} if key else {}

    status, data, kind = _gluetun_get(ctx, f"{url}/v1/vpn/status", headers)
    if kind and kind != "too_large":
        g.error = kind
        return g
    if status in (401, 403):
        g.reachable, g.refused = True, True
        return g
    if kind or status != 200 or not isinstance(data, dict) or "status" not in data:
        g.error = "not_gluetun"
        return g
    g.reachable = True
    raw = str(data.get("status") or "").strip().lower()
    g.status = raw if raw in _KNOWN_STATUSES else "unknown"

    status, data, _kind = _gluetun_get(ctx, f"{url}/v1/publicip/ip", headers)
    if status in (401, 403):
        g.refused = True
    elif status == 200 and isinstance(data, dict):
        g.public_ip = _valid_ip(data.get("public_ip"))
        g.country = _plain(data.get("country"))
        g.city = _plain(data.get("city"))

    status, data, _kind = _gluetun_get(ctx, f"{url}/v1/portforward", headers)
    if status in (401, 403):
        g.refused = True
    elif status == 200 and isinstance(data, dict):
        g.port_read = True
        ports = data.get("ports")
        found = [p for p in (_port(x) for x in ports) if p] if isinstance(ports, list) else []
        if not found and _port(data.get("port")):
            found = [_port(data.get("port"))]
        g.ports = found[:5]
    return g


def _plain(value: Any) -> str:
    """A place name as Gluetun gives it, kept short and printable."""
    text = "".join(c for c in str(value or "") if c.isprintable())
    return text.strip()[:60]


def _default_local_networks() -> List[ipaddress.IPv4Network]:
    """The networks SYNCHRO.S's own container sits on (Linux's routing table:
    the routes with no gateway). Inside Docker that's the compose network."""
    nets: List[ipaddress.IPv4Network] = []
    try:
        with open("/proc/net/route", encoding="ascii", errors="replace") as fh:
            next(fh, None)
            for line in fh:
                parts = line.split()
                if len(parts) < 8 or parts[0] == "lo" or parts[2] != "00000000" or parts[1] == "00000000":
                    continue
                dest = ipaddress.IPv4Address(int(parts[1], 16).to_bytes(4, "little"))
                mask = ipaddress.IPv4Address(int(parts[7], 16).to_bytes(4, "little"))
                nets.append(ipaddress.IPv4Network(f"{dest}/{mask}", strict=False))
    except (OSError, ValueError):
        return []
    return nets


def _is_service_name(host: str) -> bool:
    """A Docker service or container name: one label, not an address."""
    return bool(host) and "." not in host and not _is_ip(host) and host not in _HOST_GATEWAYS


def _same_network(ctx, service_url: str, gluetun_url: str) -> Tuple[Optional[bool], str]:
    """Is the service at ``service_url`` inside Gluetun's network, judged from
    the two addresses SYNCHRO.S uses?

    True only when both are Docker service names (one label, not an address)
    that lead to the same private address on a network SYNCHRO.S's own
    container is on: then they are one container's network. False when both
    are such names and lead to different containers there. Anything else (a
    LAN address, a name with a dot, the Docker host, a NAS publishing both
    ports) proves nothing either way: None."""
    a = (urlparse(service_url).hostname or "").lower()
    b = (urlparse(gluetun_url).hostname or "").lower()
    if not _is_service_name(a) or not _is_service_name(b):
        return None, "an address that could be any machine's"
    resolve = getattr(ctx, "resolve_host", None) or _default_resolve
    local = getattr(ctx, "local_networks", None) or _default_local_networks
    try:
        ips_a, ips_b = set(resolve(a)), set(resolve(b))
        nets = list(local())
    except Exception:  # noqa: BLE001 - a name that doesn't resolve says nothing either way
        return None, "the name didn't resolve"

    def on_docker_network(ip: str) -> bool:
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return False
        return addr.is_private and not addr.is_loopback and any(addr in n for n in nets)

    ours_a = {ip for ip in ips_a if on_docker_network(ip)}
    ours_b = {ip for ip in ips_b if on_docker_network(ip)}
    if not ours_a or not ours_b or ours_a != ips_a or ours_b != ips_b:
        return None, "not on SYNCHRO.S's Docker network"
    if ours_a & ours_b:
        return True, "same container as Gluetun"
    return False, "its own container, not Gluetun's"


def _is_ip(host: str) -> bool:
    return bool(_valid_ip(host))


def _is_loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def read_slskd(ctx, gluetun_url: str) -> Optional[Service]:
    from core import setup_check as sc
    s = slskd_placeholder(ctx)
    if s is None:
        return None
    url = s.url
    headers = sc._slskd_headers(ctx)

    opts = sc.http_get(ctx, f"{url}/api/v0/options", headers=headers)
    if opts.kind:
        s.reachable = False
    elif opts.status == 200 and isinstance(opts.data, dict):
        s.reachable = True
        soulseek = sc._pick(opts.data, "soulseek") or {}
        s.listen_port = _port(sc._pick(soulseek, "listenPort", "listen_port"))
        vpn = sc._pick(sc._pick(opts.data, "integration", "integrations") or {}, "vpn") or {}
        if isinstance(vpn, dict) and vpn:
            s.vpn_integration = bool(sc._pick(vpn, "enabled"))
            glu = sc._pick(vpn, "gluetun") or {}
            glu_host = (urlparse(str(sc._pick(glu, "url") or "")).hostname or "").lower()
            s.integration_loopback = bool(s.vpn_integration and (glu_host == "localhost" or _is_loopback(glu_host)))
    else:
        s.reachable = False

    if s.reachable:
        app = sc.http_get(ctx, f"{url}/api/v0/application", headers=headers)
        if app.status == 200 and isinstance(app.data, dict):
            vpn_state = sc._pick(app.data, "vpn")
            if isinstance(vpn_state, dict):
                s.vpn_ready = bool(sc._pick(vpn_state, "isReady"))
        s.logged_in = sc.slskd_logged_in(ctx, url)

    # Only the network proves where slskd is. Its own Gluetun integration at
    # 127.0.0.1 is supporting evidence, never proof: slskd on the host (or with
    # network_mode: host) and Gluetun publishing 8000 looks just the same.
    s.inside, s.how = _same_network(ctx, url, gluetun_url)
    if s.inside is None and s.integration_loopback:
        s.how = "slskd's own Gluetun integration answers, but that doesn't show where its traffic goes"
    return s


def slskd_placeholder(ctx) -> Optional[Service]:
    from core import setup_check as sc
    raw = ctx.cfg_str("soulseek.slskd_url", "")
    if not raw or not sc.soulseek_in_use(ctx):
        return None
    return Service(key="slskd", name="slskd", url=sc._resolve_url(ctx, raw))


def torrent_placeholder(ctx) -> Optional[Service]:
    client_type = ctx.cfg_str("torrent_client.type", "").lower()
    url = ctx.cfg_str("torrent_client.url", "")
    if not client_type or not url:
        return None
    from core import setup_check as sc
    url = sc._resolve_url(ctx, url if "://" in url else f"http://{url}")
    return Service(key="torrent", name=_TORRENT_NAMES.get(client_type, client_type), url=url, kind=client_type)


def services_configured(ctx) -> bool:
    """Is Soulseek or a torrent client set up, so there's something to check?"""
    return slskd_placeholder(ctx) is not None or torrent_placeholder(ctx) is not None


def _default_torrent_listen_port(client_type: str) -> Optional[int]:
    from core.torrent_clients import adapter_for_type
    adapter = adapter_for_type(client_type)
    reader = getattr(adapter, "listen_port", None)
    return reader() if callable(reader) else None


def read_torrent(ctx, gluetun_url: str) -> Optional[Service]:
    s = torrent_placeholder(ctx)
    if s is None:
        return None
    reader = getattr(ctx, "torrent_listen_port", None) or _default_torrent_listen_port
    # the adapters answer None both for "not reachable" and "can't say";
    # either way the port reads as unknown, which is never green
    s.reachable = True
    try:
        s.listen_port = _port(reader(s.kind))
    except Exception as exc:  # noqa: BLE001 - a client that can't be read is "couldn't tell"
        logger.debug("torrent listen port unreadable: %s", exc)
    s.inside, s.how = _same_network(ctx, s.url, gluetun_url)
    return s


# ---------------------------------------------------------------------------
# The verdict
# ---------------------------------------------------------------------------

@dataclass
class Facts:
    gluetun: Optional[Gluetun]
    services: List[Service]
    home: HomeAddress
    vpn_name: str = DEFAULT_VPN_NAME
    #: slskd looked signed in to Soulseek while the VPN was down, in two reads
    #: a few seconds apart (one read alone is only "check again")
    leak_confirmed: bool = False
    #: it looked signed in once and not on the second read
    leak_glimpse: bool = False


def _where(g: Gluetun) -> str:
    return f" ({g.country})" if g.country else ""


def _verb(services: Sequence[Service], one: str, many: str) -> str:
    return many if len(services) != 1 else one


def verdict(f: Facts) -> Dict[str, Any]:
    """``{state, tone, headline, rows}`` from what was read. Pure: every
    branch is driven by the tests without a network.

    Green ("protected") only when everything was seen: the VPN up with an
    address, a forwarded port both services listen on, and both proved inside
    Gluetun's network. Anything SYNCHRO.S couldn't see is amber, never green."""
    from core import setup_check as sc
    mk = sc.make_result
    rows: List[Dict[str, Any]] = []
    g = f.gluetun
    services = f.services
    subject = _names(services) if services else "Soulseek and torrents"

    if g is None:
        rows.append(mk("privacy.vpn", "VPN for Soulseek and torrents", sc.SKIPPED,
                       "The privacy check isn't set up, so SYNCHRO.S can't tell whether Soulseek and torrents go "
                       "through a VPN. Without one, they show your home IP to everyone they connect to.",
                       _SETUP_HINT, CATEGORY))
        return {"state": NOT_SET_UP, "tone": sc.SKIPPED, "rows": rows,
                "headline": "The privacy check isn't set up"}

    if not g.reachable:
        slskd = next((s for s in services if s.key == "slskd"), None)
        also = (" slskd isn't answering either: if Gluetun is stopped, slskd is stopped too."
                if slskd is not None and slskd.reachable is False else "")
        if g.error == "timeout":
            detail = f"Gluetun's control server at {g.url} didn't answer in time."
        elif g.error == "not_gluetun":
            detail = f"Something answered at {g.url}, but it isn't Gluetun's control server."
        else:
            detail = f"SYNCHRO.S can't reach Gluetun's control server at {g.url}."
        rows.append(mk("privacy.vpn", "VPN for Soulseek and torrents", sc.ERROR, detail + also,
                       "Check that the gluetun container is running (`docker compose ps`) and that the address is "
                       "Gluetun's control port, 8000 unless you changed it, e.g. `http://gluetun:8000`.", CATEGORY))
        return {"state": UNREACHABLE, "tone": sc.ERROR, "rows": rows,
                "headline": "Can't reach Gluetun, the VPN container"}

    if g.refused:
        rows.append(mk("privacy.vpn", "VPN for Soulseek and torrents", sc.WARNING,
                       "Gluetun answered but refused SYNCHRO.S's key for part of the check, so the VPN couldn't be "
                       "checked.",
                       "Copy GLUETUN_API_KEY from your `.env` into the key field here. If you set up Gluetun's "
                       "control server yourself, allow `GET /v1/vpn/status`, `GET /v1/publicip/ip` and "
                       "`GET /v1/portforward` for that key.", CATEGORY))
        return {"state": REFUSED, "tone": sc.WARNING, "rows": rows,
                "headline": "Gluetun refused SYNCHRO.S's key"}

    outside = [s for s in services if s.inside is False]
    unsure = [s for s in services if s.inside is None]
    inside = [s for s in services if s.inside is True]
    unreachable = [s for s in services if s.reachable is not True]
    slskd = next((s for s in services if s.key == "slskd"), None)
    suspect = f.leak_glimpse or (not g.up and slskd is not None and slskd.inside is not False
                                 and slskd.logged_in is True)
    leaked = suspect and f.leak_confirmed

    # -- the VPN row
    if g.up:
        rows.append(mk("privacy.vpn", "VPN", sc.OK, f"{f.vpn_name} is connected{_where(g)}.", "", CATEGORY,
                       vpn_status=g.status))
    else:
        state = g.status or "unknown"
        said = ("Gluetun is connecting and hasn't found its public address yet" if state == "running"
                else f"Gluetun says '{state}'")
        rows.append(mk("privacy.vpn", "VPN", sc.ERROR, f"{f.vpn_name} isn't connected ({said}).",
                       "Gluetun reconnects by itself. If it stays down, open its log (`docker compose logs gluetun`) "
                       "and check WIREGUARD_PRIVATE_KEY and SERVER_COUNTRIES in your `.env`; see Support/VPN.md, "
                       "\"If the card is red\".", CATEGORY, vpn_status=state))

    # -- the address peers see
    if outside:
        many = len(outside) > 1
        rows.append(mk("privacy.address", "The address peers see", sc.ERROR,
                       f"{_names(outside)} {'run' if many else 'runs'} in {'their' if many else 'its'} own container, "
                       "outside Gluetun's network, so peers see your home IP.",
                       "Start SYNCHRO.S with the VPN file (`docker compose up -d` after adding the `COMPOSE_FILE` line "
                       "to `.env`), then point SYNCHRO.S at slskd and qBittorrent by their names, `http://slskd:5030` "
                       "and `http://qbittorrent:8080`, which the VPN file gives Gluetun.", CATEGORY))
    elif not g.up:
        rows.append(mk("privacy.address", "The address peers see", sc.SKIPPED,
                       "Not checked while the VPN is down.", "", CATEGORY))
    elif f.home.enabled and f.home.ip and f.home.ip == g.public_ip:
        rows.append(mk("privacy.address", "The address peers see", sc.ERROR,
                       "Gluetun's public address is the same as your home connection's, so peers see your home IP.",
                       "Restart Gluetun with the services that share it (`docker compose restart`) and run the check "
                       "again. If it stays the same, a VPN app on this computer may be carrying Docker's traffic; see "
                       "Support/VPN.md.", CATEGORY, compared=True))
    elif f.home.enabled and f.home.ip:
        rows.append(mk("privacy.address", "The address peers see", sc.OK,
                       f"Gluetun's address{_where(g)} is different from your home connection's.",
                       "", CATEGORY, compared=True))
    else:
        why = ("Your home address isn't looked up, so it wasn't compared; turn on \"Compare with my home IP\" to "
               "check." if not f.home.enabled else "Your home address couldn't be looked up just now, so it wasn't "
               "compared.")
        rows.append(mk("privacy.address", "The address peers see", sc.OK,
                       f"Gluetun's address is the VPN's{_where(g)}. {why}", "", CATEGORY, compared=False))

    # -- the forwarded port (its number stays in data: rows go into copied reports)
    port = g.port
    reachable = [s for s in services if s.reachable is True]
    mismatched = [s for s in reachable if port and s.listen_port and s.listen_port != port]
    unread = [s for s in reachable if s.listen_port is None]
    listen_data = {s.key: s.listen_port for s in services}
    if not g.up:
        rows.append(mk("privacy.port", "Forwarded port", sc.SKIPPED, "Not checked while the VPN is down.", "",
                       CATEGORY))
    elif not port:
        rows.append(mk("privacy.port", "Forwarded port", sc.WARNING,
                       "No port is forwarded. Downloads work, but fewer people can reach you, so some uploads and "
                       "searches from people behind firewalls won't connect.",
                       "Port forwarding needs a paid Proton VPN plan (Plus or higher), a WireGuard key made with "
                       "NAT-PMP (Port Forwarding) on, and PORT_FORWARDING=true in your `.env`; see Support/VPN.md.",
                       CATEGORY, listen_ports=listen_data))
    elif unreachable or mismatched or unread:
        parts, fixes = [], []
        for s in mismatched:
            parts.append(f"{s.name} isn't listening on it")
        for s in unread:
            parts.append(f"SYNCHRO.S couldn't read {s.name}'s listening port")
        for s in unreachable:
            parts.append(f"SYNCHRO.S can't reach {s.name}")
        if any(s.key == "slskd" for s in mismatched):
            fixes.append("slskd follows the port by itself when its VPN integration is on (SLSKD_VPN and "
                         "SLSKD_VPN_PORT_FORWARDING, set by the VPN file; slskd 0.25 or later).")
        if any(s.key == "torrent" for s in mismatched):
            fixes.append("qBittorrent follows it through Gluetun's port command, which needs \"Bypass authentication "
                         "for clients on localhost\" ticked in qBittorrent's Web UI options. Other torrent clients: "
                         "set the port by hand.")
        if unreachable:
            fixes.append(_RESTART_HINT)
        rows.append(mk("privacy.port", "Forwarded port", sc.WARNING,
                       "A port is forwarded, but " + "; ".join(parts) + ", so fewer people may reach you.",
                       " ".join(fixes), CATEGORY, port=port, listen_ports=listen_data))
    else:
        listening = [s for s in services if s.listen_port == port]
        tail = (f" and {_names(listening)} {_verb(listening, 'listens', 'listen')} on it" if listening else "")
        rows.append(mk("privacy.port", "Forwarded port", sc.OK, f"A port is forwarded{tail}.", "",
                       CATEGORY, port=port, listen_ports=listen_data))

    # -- the kill switch
    if leaked:
        rows.append(mk("privacy.kill_switch", "Kill switch", sc.ERROR,
                       "slskd still looks signed in to Soulseek while the VPN is down, in two checks a few seconds "
                       "apart: check it.",
                       "Stop slskd now (`docker compose stop slskd`). Check that slskd has "
                       "`network_mode: \"service:gluetun\"` and no `ports:` of its own, and that Gluetun's firewall "
                       "isn't turned off (FIREWALL_ENABLED_DISABLING_IT_SHOOTS_YOU_IN_YOUR_FOOT).", CATEGORY))
    elif outside:
        many = len(outside) > 1
        rows.append(mk("privacy.kill_switch", "Kill switch", sc.ERROR,
                       f"{_names(outside)} {'aren' if many else 'isn'}'t behind Gluetun, so nothing stops "
                       f"{'them' if many else 'it'} if the VPN drops.",
                       "Run it with `network_mode: \"service:gluetun\"` (the VPN file does this).", CATEGORY))
    elif suspect:
        rows.append(mk("privacy.kill_switch", "Kill switch", sc.WARNING,
                       "slskd looked signed in to Soulseek for a moment while the VPN is down. It may just be "
                       "catching up.", "Run the check again in a minute.", CATEGORY))
    elif unreachable:
        rows.append(mk("privacy.kill_switch", "Kill switch", sc.WARNING,
                       f"SYNCHRO.S can't reach {_names(unreachable)}, so it can't confirm the kill switch.",
                       _RESTART_HINT, CATEGORY))
    elif unsure or not services:
        who = _names(unsure) if unsure else "slskd and the torrent client"
        rows.append(mk("privacy.kill_switch", "Kill switch", sc.WARNING,
                       f"SYNCHRO.S can't prove that {who} {_verb(unsure, 'is', 'are')} inside Gluetun's network from "
                       "the address it uses, so it can't confirm the kill switch.",
                       "Point SYNCHRO.S at them by the names the VPN file gives Gluetun: `http://slskd:5030` for slskd "
                       "and `http://qbittorrent:8080` for qBittorrent (or `http://gluetun:…`). A LAN address, the "
                       "Docker host or a name with a dot can't show which network a service is on.", CATEGORY))
    else:
        extra = (" slskd also leaves Soulseek whenever Gluetun says the VPN is down."
                 if slskd is not None and slskd.vpn_integration else "")
        rows.append(mk("privacy.kill_switch", "Kill switch", sc.OK,
                       f"{_names(inside)} {_verb(inside, 'shares', 'share')} Gluetun's network, and Gluetun's "
                       "firewall only lets traffic out through the VPN: if the VPN drops, "
                       f"{_verb(inside, 'it has', 'they have')} no connection.{extra}", "", CATEGORY))

    # -- the headline
    if leaked:
        state, tone = LEAK, sc.ERROR
        headline = "slskd still looks signed in to Soulseek while the VPN is down: check it"
    elif outside and len(outside) == len(services):
        state, tone = NO_VPN, sc.ERROR
        headline = f"Not using a VPN: {subject} {_verb(services, 'shows', 'show')} your home IP"
    elif outside:
        state, tone = NO_VPN, sc.ERROR
        headline = (f"{_names(outside)} {_verb(outside, 'doesn', 'don')}'t go through the VPN: "
                    f"{_verb(outside, 'it shows', 'they show')} your home IP")
    elif not g.up:
        state, tone = VPN_DOWN, sc.ERROR
        headline = f"VPN is down: {subject} {_verb(services, 'is', 'are')} stopped until it's back"
    elif any(r["id"] == "privacy.address" and r["status"] == sc.ERROR for r in rows):
        state, tone = LEAK, sc.ERROR
        headline = f"{subject} {_verb(services, 'shows', 'show')} your home IP: the VPN's address is your home's"
    elif unreachable:
        state, tone = SERVICE_DOWN, sc.WARNING
        names = _names(unreachable)
        headline = (f"SYNCHRO.S can't reach {names}: if Gluetun was restarted on its own, restart "
                    f"{_verb(unreachable, 'it', 'them')} too")
    elif not port:
        state, tone = NO_PORT, sc.WARNING
        headline = "Connected, no forwarded port: downloads work but fewer people can reach you"
    elif mismatched:
        state, tone = PORT_MISMATCH, sc.WARNING
        headline = (f"Connected, but {_names(mismatched)} {_verb(mismatched, 'isn', 'aren')}'t listening on "
                    f"forwarded port {port}: fewer people can reach you")
    elif unread or unsure or not services:
        state, tone = NOT_CONFIRMED, sc.WARNING
        what = ("kill switch not confirmed" if (unsure or not services)
                else f"couldn't read {_names(unread)}'s listening port")
        headline = " · ".join([f"{subject} {_verb(services, 'goes', 'go')} through {f.vpn_name}{_where(g)}",
                               f"port {port} forwarded", what])
    else:
        state, tone = PROTECTED, sc.OK
        headline = " · ".join([f"{subject} {_verb(services, 'goes', 'go')} through {f.vpn_name}{_where(g)}",
                               f"port {port} forwarded",
                               f"if the VPN drops, {_verb(services, 'it stops', 'they stop')}"])
    return {"state": state, "tone": tone, "headline": headline, "rows": rows}


_RESTART_HINT = ("If Gluetun was restarted on its own, the services in its network lost their connection: run "
                 "`docker compose up -d --force-recreate slskd qbittorrent` (leave out qbittorrent if you don't run "
                 "it), then check again.")


# ---------------------------------------------------------------------------
# Running it
# ---------------------------------------------------------------------------

#: How long to wait before reading slskd and Gluetun again when slskd looks
#: signed in while the VPN is down (a sign-out can take a moment).
LEAK_RECHECK_S = 4.0
_sleep = time.sleep


def _timed_out(placeholder: Optional[Service]) -> Optional[Service]:
    if placeholder is not None:
        placeholder.reachable = None
        placeholder.inside = None
        placeholder.how = "didn't answer in time"
    return placeholder


def gather(ctx) -> Facts:
    """Read everything at once, each source on its own thread with the setup
    check's timeouts, and stop waiting at :data:`DEADLINE_S`: a source that
    hasn't answered by then reads as "couldn't tell", never as fine."""
    raw_url = ctx.cfg_str(SETTING_URL, "")
    url = clean_control_url(raw_url)
    home_on = bool(ctx.cfg(SETTING_HOME_LOOKUP, False))
    vpn_name = ctx.cfg_str(SETTING_VPN_NAME, "") or DEFAULT_VPN_NAME
    if not url:
        return Facts(gluetun=None, services=[], home=HomeAddress(enabled=home_on), vpn_name=vpn_name)
    from core import setup_check as sc
    url = sc._resolve_url(ctx, url)
    fetch = getattr(ctx, "home_ip_fetch", None)
    pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="privacy-check")
    end = time.monotonic() + DEADLINE_S
    try:
        fut_g = pool.submit(read_gluetun, ctx, url)
        fut_s = pool.submit(read_slskd, ctx, url)
        fut_t = pool.submit(read_torrent, ctx, url)
        fut_h = pool.submit(home_address, home_on, fetch)

        def result(fut, default):
            try:
                return fut.result(timeout=max(0.0, end - time.monotonic()))
            except Exception as exc:  # noqa: BLE001 - late or failed reads as "couldn't tell"
                logger.warning("privacy check source failed or was late: %s", type(exc).__name__)
                return default

        g = result(fut_g, Gluetun(url=url, error="timeout"))
        slskd = result(fut_s, _timed_out(slskd_placeholder(ctx)))
        torrent = result(fut_t, _timed_out(torrent_placeholder(ctx)))
        home = result(fut_h, HomeAddress(enabled=home_on, error="the address service didn't answer"))
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

    leak_confirmed = leak_glimpse = False
    if slskd is not None and slskd.logged_in is True and g.reachable and not g.up:
        # one read alone could be slskd catching up: read both again a few
        # seconds later, inside the same deadline
        def again():
            _sleep(LEAK_RECHECK_S)
            return read_gluetun(ctx, url), sc.slskd_logged_in(ctx, slskd.url)

        pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="privacy-recheck")
        try:
            g2, still = pool.submit(again).result(timeout=max(0.0, end - time.monotonic()))
            leak_confirmed = bool(still is True and g2.reachable and not g2.up)
            if still is not True:
                slskd.logged_in = still
                leak_glimpse = True
        except Exception as exc:  # noqa: BLE001 - no second read in time: not confirmed
            logger.info("privacy check: no second read in time (%s)", type(exc).__name__)
        finally:
            pool.shutdown(wait=False, cancel_futures=True)
    services = [s for s in (slskd, torrent) if s is not None]
    return Facts(gluetun=g, services=services, home=home, vpn_name=vpn_name, leak_confirmed=leak_confirmed,
                 leak_glimpse=leak_glimpse)


def check_rows(ctx) -> List[Dict[str, Any]]:
    """The privacy rows for the setup check (category ``privacy``)."""
    return verdict(gather(ctx))["rows"]


def run_privacy_check(ctx=None) -> Dict[str, Any]:
    """The card's whole answer: the verdict plus what was seen. Holds IP
    addresses, so it's served admin-only."""
    from core import setup_check as sc
    ctx = ctx or sc.build_context()
    started = time.monotonic()
    facts = gather(ctx)
    out = verdict(facts)
    g = facts.gluetun
    out.update({
        "configured": g is not None,
        "services_configured": services_configured(ctx),
        "settings": settings_state(ctx),
        "vpn": None if g is None else {
            "reachable": g.reachable, "status": g.status or None, "up": g.up, "name": facts.vpn_name,
            "country": g.country or None, "city": g.city or None, "forwarded_port": g.port,
        },
        "services": [{"key": s.key, "name": s.name, "reachable": s.reachable, "listen_port": s.listen_port,
                      "inside": s.inside, "how": s.how or None, "signed_in": s.logged_in} for s in facts.services],
        "addresses": {
            "vpn": (g.public_ip or None) if g is not None else None,
            "home": facts.home.ip or None,
            "home_lookup": facts.home.enabled,
            "home_checked_at": facts.home.checked_at,
            "home_error": facts.home.error or None,
            "home_service": HOME_IP_SERVICE,
        },
        "ran_at": time.time(),
        "duration_ms": int((time.monotonic() - started) * 1000),
    })
    return out


def settings_state(ctx) -> Dict[str, Any]:
    """The privacy settings as the card shows them (the key only as set or not)."""
    return {
        "gluetun_url": ctx.cfg_str(SETTING_URL, ""),
        "api_key_set": bool(ctx.cfg_str(SETTING_KEY, "")),
        "home_ip_lookup": bool(ctx.cfg(SETTING_HOME_LOOKUP, False)),
        "home_ip_service": HOME_IP_SERVICE,
    }


__all__ = [
    "CATEGORY", "SETTING_URL", "SETTING_KEY", "SETTING_HOME_LOOKUP", "SETTING_VPN_NAME", "HOME_IP_SERVICE",
    "Gluetun", "Service", "HomeAddress", "Facts", "clean_control_url", "home_address", "forget_home_address",
    "read_gluetun", "read_slskd", "read_torrent", "verdict", "gather", "check_rows", "run_privacy_check",
    "settings_state", "services_configured",
]
