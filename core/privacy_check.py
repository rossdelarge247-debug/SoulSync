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
  proved from where slskd and the torrent client are: inside Gluetun's network
  (slskd talking to Gluetun at 127.0.0.1, or both answering at one address),
  they have no other way out. If the VPN is down and slskd is still signed in
  to Soulseek, the kill switch didn't hold, and the check says so.

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


def _subject(services: Sequence[Service]) -> Tuple[str, bool]:
    """("Soulseek and torrents", plural) for the services in use."""
    names = []
    if any(s.key == "slskd" for s in services):
        names.append("Soulseek")
    if any(s.key == "torrent" for s in services):
        names.append("torrents")
    if not names:
        return "Soulseek and torrents", True
    text = " and ".join(names)
    return text[0].upper() + text[1:], len(names) > 1 or names == ["torrents"]


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

def read_gluetun(ctx, url: str) -> Gluetun:
    from core import setup_check as sc
    g = Gluetun(url=url)
    key = ctx.cfg_str(SETTING_KEY, "")
    headers = {"X-API-Key": key} if key else {}

    res = sc.http_get(ctx, f"{url}/v1/vpn/status", headers=headers)
    if res.kind:
        g.error = res.kind
        return g
    if res.status in (401, 403):
        g.reachable, g.refused = True, True
        return g
    if res.status != 200 or not isinstance(res.data, dict) or "status" not in res.data:
        g.error = "not_gluetun"
        return g
    g.reachable = True
    g.status = str(res.data.get("status") or "").strip().lower()

    ip = sc.http_get(ctx, f"{url}/v1/publicip/ip", headers=headers)
    if ip.status in (401, 403):
        g.refused = True
    elif ip.status == 200 and isinstance(ip.data, dict):
        g.public_ip = _valid_ip(ip.data.get("public_ip"))
        g.country = str(ip.data.get("country") or "").strip()[:60]
        g.city = str(ip.data.get("city") or "").strip()[:60]

    pf = sc.http_get(ctx, f"{url}/v1/portforward", headers=headers)
    if pf.status in (401, 403):
        g.refused = True
    elif pf.status == 200 and isinstance(pf.data, dict):
        g.port_read = True
        ports = pf.data.get("ports")
        found = [p for p in (_port(x) for x in ports) if p] if isinstance(ports, list) else []
        if not found and _port(pf.data.get("port")):
            found = [_port(pf.data.get("port"))]
        g.ports = found
    return g


def _same_network(ctx, service_url: str, gluetun_url: str) -> Tuple[Optional[bool], str]:
    """Is the service at ``service_url`` inside Gluetun's network, judged from
    the two addresses SYNCHRO.S uses? True when both names lead to the same
    container; False when both are plain container names (``slskd``,
    ``gluetun``) that lead to different containers; None otherwise (a LAN
    address or the Docker host could be either)."""
    a = (urlparse(service_url).hostname or "").lower()
    b = (urlparse(gluetun_url).hostname or "").lower()
    if not a or not b:
        return None, ""
    loopbackish = {h for h in (a, b) if h in _HOST_GATEWAYS or _is_loopback(h)}
    if loopbackish:
        return None, "the Docker host's address could reach either"
    if a == b:
        return True, "same address as Gluetun"
    resolve = getattr(ctx, "resolve_host", None) or _default_resolve
    try:
        ips_a, ips_b = set(resolve(a)), set(resolve(b))
    except Exception:  # noqa: BLE001 - a name that doesn't resolve says nothing either way
        return None, "the name didn't resolve"
    if ips_a and ips_a & ips_b:
        return True, "same address as Gluetun"
    if ips_a and ips_b and "." not in a and "." not in b and not _is_ip(a) and not _is_ip(b):
        return False, "its own container, not Gluetun's"
    return None, "a different address from Gluetun's"


def _is_ip(host: str) -> bool:
    return bool(_valid_ip(host))


def _is_loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def read_slskd(ctx, gluetun_url: str) -> Optional[Service]:
    from core import setup_check as sc
    raw = ctx.cfg_str("soulseek.slskd_url", "")
    if not raw or not sc.soulseek_in_use(ctx):
        return None
    url = sc._resolve_url(ctx, raw)
    s = Service(key="slskd", name="slskd", url=url)
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
            if s.vpn_integration and (glu_host == "localhost" or _is_loopback(glu_host)):
                s.how = "slskd reaches Gluetun at its own 127.0.0.1"
    else:
        s.reachable = opts.status is not None and opts.status < 500

    if s.reachable:
        app = sc.http_get(ctx, f"{url}/api/v0/application", headers=headers)
        if app.status == 200 and isinstance(app.data, dict):
            vpn_state = sc._pick(app.data, "vpn")
            if isinstance(vpn_state, dict):
                s.vpn_ready = bool(sc._pick(vpn_state, "isReady"))
        s.logged_in = sc.slskd_logged_in(ctx, url)

    if s.how and s.vpn_ready:
        # slskd's own Gluetun integration talks to Gluetun at 127.0.0.1, which
        # only answers inside Gluetun's network
        s.inside = True
    else:
        s.inside, s.how = _same_network(ctx, url, gluetun_url)
    return s


def _default_torrent_listen_port(client_type: str) -> Optional[int]:
    from core.torrent_clients import adapter_for_type
    adapter = adapter_for_type(client_type)
    reader = getattr(adapter, "listen_port", None)
    return reader() if callable(reader) else None


def read_torrent(ctx, gluetun_url: str) -> Optional[Service]:
    client_type = ctx.cfg_str("torrent_client.type", "").lower()
    url = ctx.cfg_str("torrent_client.url", "")
    if not client_type or not url:
        return None
    from core import setup_check as sc
    url = sc._resolve_url(ctx, url if "://" in url else f"http://{url}")
    s = Service(key="torrent", name=_TORRENT_NAMES.get(client_type, client_type), url=url)
    reader = getattr(ctx, "torrent_listen_port", None) or _default_torrent_listen_port
    try:
        s.listen_port = _port(reader(client_type))
    except Exception as exc:  # noqa: BLE001 - a client that can't be read is "couldn't tell"
        logger.debug("torrent listen port unreadable: %s", exc)
    s.inside, s.how = _same_network(ctx, url, gluetun_url)
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


def _where(g: Gluetun) -> str:
    return f" ({g.country})" if g.country else ""


def verdict(f: Facts) -> Dict[str, Any]:
    """``{state, tone, headline, rows}`` from what was read. Pure: every
    branch is driven by the tests without a network."""
    from core import setup_check as sc
    mk = sc.make_result
    subject, plural = _subject(f.services)
    are, go, show = ("are", "go", "show") if plural else ("is", "goes", "shows")
    rows: List[Dict[str, Any]] = []
    g = f.gluetun

    if g is None:
        rows.append(mk("privacy.vpn", "VPN for Soulseek and torrents", sc.SKIPPED,
                       "The privacy check isn't set up, so SYNCHRO.S can't tell whether Soulseek and torrents go "
                       "through a VPN. Without one, they show your home IP to everyone they connect to.",
                       _SETUP_HINT, CATEGORY))
        return {"state": NOT_SET_UP, "tone": sc.SKIPPED, "rows": rows,
                "headline": "The privacy check isn't set up"}

    if not g.reachable:
        slskd = next((s for s in f.services if s.key == "slskd"), None)
        also = (" slskd isn't answering either: if Gluetun is stopped, Soulseek and torrents are stopped too."
                if slskd is not None and slskd.reachable is False else "")
        detail = (f"SYNCHRO.S can't reach Gluetun's control server at {g.url}." if g.error != "not_gluetun" else
                  f"Something answered at {g.url}, but it isn't Gluetun's control server.") + also
        rows.append(mk("privacy.vpn", "VPN for Soulseek and torrents", sc.ERROR, detail,
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

    outside = [s for s in f.services if s.inside is False]
    unsure = [s for s in f.services if s.inside is None]
    inside = [s for s in f.services if s.inside is True]
    slskd = next((s for s in f.services if s.key == "slskd"), None)
    leaked = (not g.up and slskd is not None and slskd.inside is not False and slskd.logged_in is True)

    # -- the VPN row
    if g.up:
        rows.append(mk("privacy.vpn", "VPN", sc.OK,
                       f"{f.vpn_name} is connected{_where(g)}.", "", CATEGORY, vpn_status=g.status))
    else:
        state = g.status or "unknown"
        said = ("Gluetun is connecting and hasn't found its public address yet" if state == "running"
                else f"Gluetun says '{state}'")
        rows.append(mk("privacy.vpn", "VPN", sc.ERROR,
                       f"{f.vpn_name} isn't connected ({said}).",
                       "Gluetun reconnects by itself. If it stays down, open its log (`docker compose logs gluetun`) "
                       "and check WIREGUARD_PRIVATE_KEY and SERVER_COUNTRIES in your `.env`; see Support/VPN.md, "
                       "\"If the card is red\".", CATEGORY, vpn_status=state))

    # -- the address peers see
    if outside:
        rows.append(mk("privacy.address", "The address peers see", sc.ERROR,
                       f"{_names(outside)} {'run' if len(outside) > 1 else 'runs'} in {'their' if len(outside) > 1 else 'its'} "
                       "own container, outside Gluetun's network, so peers see your home IP.",
                       "Start SYNCHRO.S with the VPN file (`docker compose up -d` after adding "
                       "`COMPOSE_FILE=docker-compose.yml:docker-compose.vpn.yml` to `.env`), then point SYNCHRO.S at "
                       "slskd and the torrent client through Gluetun, e.g. `http://gluetun:5030`.", CATEGORY))
    elif not g.up:
        rows.append(mk("privacy.address", "The address peers see", sc.SKIPPED,
                       "Not checked while the VPN is down.", "", CATEGORY))
    elif f.home.enabled and f.home.ip and f.home.ip == g.public_ip:
        rows.append(mk("privacy.address", "The address peers see", sc.ERROR,
                       "Gluetun's public address is the same as your home connection's, so peers see your home IP.",
                       "Restart Gluetun (`docker compose restart gluetun`) and run the check again. If it stays the "
                       "same, a VPN app on this computer may be carrying Docker's traffic; see Support/VPN.md.",
                       CATEGORY, compared=True))
    elif f.home.enabled and f.home.ip:
        rows.append(mk("privacy.address", "The address peers see", sc.OK,
                       f"Peers see the VPN's address{_where(g)}, which is different from your home connection's.",
                       "", CATEGORY, compared=True))
    else:
        why = ("Your home address isn't looked up, so it wasn't compared; turn on \"Compare with my home IP\" to "
               "check." if not f.home.enabled else "Your home address couldn't be looked up just now, so it wasn't "
               "compared.")
        rows.append(mk("privacy.address", "The address peers see", sc.OK,
                       f"Peers see the VPN's address{_where(g)}. {why}", "", CATEGORY, compared=False))

    # -- the forwarded port
    port = g.port
    mismatched = [s for s in f.services if port and s.listen_port and s.listen_port != port]
    unread = [s for s in f.services if s.listen_port is None]
    if not g.up:
        rows.append(mk("privacy.port", "Forwarded port", sc.SKIPPED, "Not checked while the VPN is down.", "",
                       CATEGORY))
    elif not port:
        rows.append(mk("privacy.port", "Forwarded port", sc.WARNING,
                       "No port is forwarded. Downloads work, but fewer people can reach you, so some uploads and "
                       "searches from people behind firewalls won't connect.",
                       "Port forwarding needs a paid Proton VPN plan (Plus or higher), a WireGuard key made with "
                       "NAT-PMP (Port Forwarding) on, and PORT_FORWARDING=true in your `.env`; see Support/VPN.md.",
                       CATEGORY))
    elif mismatched:
        names = ", ".join(f"{s.name} listens on {s.listen_port}" for s in mismatched)
        fixes = []
        if any(s.key == "slskd" for s in mismatched):
            fixes.append("slskd follows the port by itself when its VPN integration is on (SLSKD_VPN and "
                         "SLSKD_VPN_PORT_FORWARDING, set by the VPN file; slskd 0.25 or later).")
        if any(s.key == "torrent" for s in mismatched):
            fixes.append("qBittorrent follows it through Gluetun's port command, which needs \"Bypass authentication "
                         "for clients on localhost\" ticked in qBittorrent's Web UI options. Other torrent clients: "
                         "set the port by hand.")
        rows.append(mk("privacy.port", "Forwarded port", sc.WARNING,
                       f"Port {port} is forwarded, but {names}, so fewer people can reach you.",
                       " ".join(fixes), CATEGORY, port=port))
    else:
        listening = [s for s in f.services if s.listen_port == port]
        tail = (f" and {_names(listening)} {'listen' if len(listening) > 1 else 'listens'} on it" if listening else "")
        unknown = (f" SYNCHRO.S couldn't read {_names(unread)}'s listening port." if unread else "")
        rows.append(mk("privacy.port", "Forwarded port", sc.OK, f"Port {port} is forwarded{tail}.{unknown}", "",
                       CATEGORY, port=port))

    # -- the kill switch
    if leaked:
        rows.append(mk("privacy.kill_switch", "Kill switch", sc.ERROR,
                       "The VPN is down, but slskd is still signed in to Soulseek, so it's using another connection.",
                       "Stop slskd now (`docker compose stop slskd`). Check that slskd has "
                       "`network_mode: \"service:gluetun\"` and no `ports:` of its own, and that Gluetun's firewall "
                       "isn't turned off (FIREWALL_ENABLED_DISABLING_IT_SHOOTS_YOU_IN_YOUR_FOOT).", CATEGORY))
    elif outside:
        rows.append(mk("privacy.kill_switch", "Kill switch", sc.ERROR,
                       f"{_names(outside)} {'aren' if len(outside) > 1 else 'isn'}'t behind Gluetun, so nothing stops "
                       f"{'them' if len(outside) > 1 else 'it'} if the VPN drops.",
                       "Run it with `network_mode: \"service:gluetun\"` (the VPN file does this).", CATEGORY))
    elif unsure or not f.services:
        who = _names(unsure) if unsure else "slskd and the torrent client"
        rows.append(mk("privacy.kill_switch", "Kill switch", sc.WARNING,
                       f"SYNCHRO.S can't tell whether {who} {'are' if len(unsure) != 1 else 'is'} inside Gluetun's "
                       "network from the address it uses, so it can't confirm the kill switch.",
                       "Point SYNCHRO.S at them through Gluetun's name, e.g. `http://gluetun:5030` for slskd and "
                       "`http://gluetun:8080` for qBittorrent, and turn on slskd's VPN integration (the VPN file "
                       "does both).", CATEGORY))
    else:
        extra = (" slskd also leaves Soulseek whenever Gluetun says the VPN is down."
                 if slskd is not None and slskd.vpn_integration else "")
        rows.append(mk("privacy.kill_switch", "Kill switch", sc.OK,
                       f"{_names(inside)} {'share' if len(inside) > 1 else 'shares'} Gluetun's network, and Gluetun's "
                       "firewall only lets traffic out through the VPN: if the VPN drops, "
                       f"{'they have' if len(inside) > 1 else 'it has'} no connection.{extra}", "", CATEGORY))

    # -- the headline
    if leaked:
        state, tone = LEAK, sc.ERROR
        headline = "The VPN is down and Soulseek is still connected: it shows your home IP"
    elif outside and len(outside) == len(f.services):
        state, tone = NO_VPN, sc.ERROR
        headline = f"Not using a VPN: {subject} {show} your home IP"
    elif outside:
        state, tone = NO_VPN, sc.ERROR
        o_subject, o_plural = _subject(outside)
        headline = f"{o_subject} {'don' if o_plural else 'doesn'}'t go through the VPN: {'they show' if o_plural else 'it shows'} your home IP"
    elif not g.up:
        state, tone = VPN_DOWN, sc.ERROR
        headline = f"VPN is down: {subject} {are} stopped until it's back"
    elif any(r["id"] == "privacy.address" and r["status"] == sc.ERROR for r in rows):
        state, tone = LEAK, sc.ERROR
        headline = f"{subject} {show} your home IP: the VPN's address is your home's"
    elif not port:
        state, tone = NO_PORT, sc.WARNING
        headline = "Connected, no forwarded port: downloads work but fewer people can reach you"
    elif mismatched:
        state, tone = PORT_MISMATCH, sc.WARNING
        headline = f"Connected, but port {port} isn't the one {_names(mismatched)} {'listen' if len(mismatched) > 1 else 'listens'} on: fewer people can reach you"
    else:
        state = PROTECTED
        parts = [f"{subject} {go} through {f.vpn_name}{_where(g)}", f"port {port} forwarded"]
        if unsure or not f.services:
            tone = sc.WARNING
            parts.append("kill switch not confirmed")
        else:
            tone = sc.OK
            parts.append(f"if the VPN drops, {'they' if plural else 'it'} {'stop' if plural else 'stops'}")
        headline = " · ".join(parts)
    return {"state": state, "tone": tone, "headline": headline, "rows": rows}


# ---------------------------------------------------------------------------
# Running it
# ---------------------------------------------------------------------------

def gather(ctx) -> Facts:
    """Read everything at once (each source on its own thread, each request
    with the setup check's timeouts)."""
    raw_url = ctx.cfg_str(SETTING_URL, "")
    url = clean_control_url(raw_url)
    home_on = bool(ctx.cfg(SETTING_HOME_LOOKUP, False))
    vpn_name = ctx.cfg_str(SETTING_VPN_NAME, "") or DEFAULT_VPN_NAME
    if not url:
        return Facts(gluetun=None, services=[], home=HomeAddress(enabled=home_on), vpn_name=vpn_name)
    from core import setup_check as sc
    url = sc._resolve_url(ctx, url)
    fetch = getattr(ctx, "home_ip_fetch", None)
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix="privacy-check") as pool:
        fut_g = pool.submit(read_gluetun, ctx, url)
        fut_s = pool.submit(read_slskd, ctx, url)
        fut_t = pool.submit(read_torrent, ctx, url)
        fut_h = pool.submit(home_address, home_on, fetch)
        end = time.monotonic() + DEADLINE_S

        def result(fut, default):
            try:
                return fut.result(timeout=max(0.0, end - time.monotonic()))
            except Exception as exc:  # noqa: BLE001 - one source failing reads as "couldn't tell"
                logger.warning("privacy check source failed: %s", exc)
                return default

        g = result(fut_g, Gluetun(url=url, error="timeout"))
        services = [s for s in (result(fut_s, None), result(fut_t, None)) if s is not None]
        home = result(fut_h, HomeAddress(enabled=home_on, error="the address service didn't answer"))
    return Facts(gluetun=g, services=services, home=home, vpn_name=vpn_name)


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
        "settings": settings_state(ctx),
        "vpn": None if g is None else {
            "reachable": g.reachable, "status": g.status or None, "up": g.up, "name": facts.vpn_name,
            "country": g.country or None, "city": g.city or None, "forwarded_port": g.port,
        },
        "services": [{"key": s.key, "name": s.name, "listen_port": s.listen_port, "inside": s.inside,
                      "how": s.how or None, "signed_in": s.logged_in} for s in facts.services],
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
    "settings_state",
]
