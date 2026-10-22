"""Fetching an address somebody else chose, without reaching the local network.

Chat's link previews were the first server-side fetch of an outside address
(``api/chat.py``): they resolve the name, refuse it unless every address is on
the internet, and walk redirects by hand so each hop is checked again. This is
that guard, shared, with the gap it left closed: the name was resolved once for
the check and again by the HTTP stack to connect, so a name whose answer
changed between the two (DNS rebinding) could still reach a private address.

Here the connection itself is pinned. :func:`guarded_session` mounts adapters
whose connections resolve the host themselves, refuse it unless every address
is public, connect only to those addresses, and check the socket's peer again
once it's connected. Proxies from the environment are ignored (a proxy would
make the peer the proxy, and could reach the LAN on our behalf).

Used by Internet radio (``core/internet_radio``) for station streams, the
station directory and now-playing feeds. :func:`is_public_ip` is chat's test,
which chat now imports from here.
"""

from __future__ import annotations

import ipaddress
import socket
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

from utils.logging_config import get_logger

logger = get_logger("security.outbound")

#: how many redirects a fetch follows; each hop is checked again
MAX_REDIRECTS = 3

_BLOCKED_NAMES = ("localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback")
_BLOCKED_SUFFIXES = (".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet",
                     ".onion", ".home.arpa", ".localdomain")
_REDIRECT_CODES = (301, 302, 303, 307, 308)


class OutboundBlocked(Exception):
    """The address isn't one this server will fetch. ``str()`` is safe to show."""


def is_public_ip(addr: str) -> bool:
    """True only for a routable internet address.

    ``is_global`` is False for loopback, private ranges, link-local (which
    covers the cloud metadata address 169.254.169.254), carrier-grade NAT,
    reserved and unspecified addresses; multicast is refused on top. An
    IPv4-mapped IPv6 address is judged as the IPv4 address it carries.
    """
    try:
        ip = ipaddress.ip_address(str(addr).split("%", 1)[0])
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    # 6to4 and Teredo wrap an IPv4 address too; judge the address inside
    sixtofour = getattr(ip, "sixtofour", None)
    if sixtofour is not None and not is_public_ip(str(sixtofour)):
        return False
    teredo = getattr(ip, "teredo", None)
    if teredo is not None and not is_public_ip(str(teredo[1])):
        return False
    return bool(ip.is_global) and not ip.is_multicast


def resolve(host: str, port: int) -> List[str]:
    """Every address the name answers with ([] when it doesn't resolve)."""
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError, ValueError, OSError):
        return []
    out: List[str] = []
    for info in infos:
        addr = info[4][0]
        if addr not in out:
            out.append(addr)
    return out


def _host_refused(host: str) -> Optional[str]:
    host = (host or "").strip().rstrip(".").lower()
    if not host:
        return "That link has no host."
    if host in _BLOCKED_NAMES or host.endswith(_BLOCKED_SUFFIXES):
        return "That address is on a private or local network."
    return None


def check_url(url: str, *, resolver: Optional[Callable[[str, int], List[str]]] = None) -> Tuple[bool, str]:
    """(ok, reason). The reason is a sentence safe to show a person.

    http or https only; the host must not be a local name; every address it
    resolves to must be public (a name that answers with a public and a
    private address is a rebinding trick, not a misconfiguration).
    """
    raw = str(url or "").strip()
    if not raw:
        return False, "No link was given."
    try:
        parsed = urlparse(raw)
        port = parsed.port
    except ValueError:
        return False, "That isn't a link."
    if (parsed.scheme or "").lower() not in ("http", "https"):
        return False, "Only http and https links can be used."
    if parsed.username or parsed.password:
        return False, "Links with a user name or password in them can't be used."
    reason = _host_refused(parsed.hostname or "")
    if reason:
        return False, reason
    host = (parsed.hostname or "").strip().rstrip(".")
    addrs = (resolver or resolve)(host, port or (443 if parsed.scheme.lower() == "https" else 80))
    if not addrs:
        return False, f"{host} doesn't resolve to an address."
    if not all(is_public_ip(a) for a in addrs):
        return False, "That address is on a private or local network."
    return True, ""


# ── the pinned transport ─────────────────────────────────────────────────────

def _make_adapter():
    import requests
    from urllib3.connection import HTTPConnection, HTTPSConnection
    from urllib3.connectionpool import HTTPConnectionPool, HTTPSConnectionPool
    from urllib3.exceptions import NewConnectionError
    from urllib3.util import connection as u3conn

    class _PinnedMixin:
        """Resolve, refuse anything private, connect to the vetted addresses
        only, then check the connected peer once more."""

        def _new_conn(self):  # type: ignore[override]
            host = self._dns_host  # type: ignore[attr-defined]
            reason = _host_refused(host)
            if reason:
                raise OutboundBlocked(reason)
            addrs = resolve(host, self.port)  # type: ignore[attr-defined]
            if not addrs:
                raise NewConnectionError(self, f"Couldn't resolve {host}")  # type: ignore[arg-type]
            if not all(is_public_ip(a) for a in addrs):
                raise OutboundBlocked("That address is on a private or local network.")
            last: Optional[BaseException] = None
            for addr in addrs:
                try:
                    sock = u3conn.create_connection(
                        (addr, self.port), self.timeout,  # type: ignore[attr-defined]
                        source_address=self.source_address,  # type: ignore[attr-defined]
                        socket_options=self.socket_options)  # type: ignore[attr-defined]
                except OSError as exc:
                    last = exc
                    continue
                try:
                    peer = sock.getpeername()[0]
                except OSError:
                    peer = ""
                if not is_public_ip(peer):
                    sock.close()
                    raise OutboundBlocked("That address is on a private or local network.")
                return sock
            raise NewConnectionError(self, f"Couldn't connect to {host}: {last}")  # type: ignore[arg-type]

    class _PinnedHTTP(_PinnedMixin, HTTPConnection):
        pass

    class _PinnedHTTPS(_PinnedMixin, HTTPSConnection):
        pass

    class _PoolHTTP(HTTPConnectionPool):
        ConnectionCls = _PinnedHTTP

    class _PoolHTTPS(HTTPSConnectionPool):
        ConnectionCls = _PinnedHTTPS

    class _Adapter(requests.adapters.HTTPAdapter):
        def init_poolmanager(self, *args, **kwargs):
            super().init_poolmanager(*args, **kwargs)
            self.poolmanager.pool_classes_by_scheme = {"http": _PoolHTTP, "https": _PoolHTTPS}
            self.poolmanager.key_fn_by_scheme = dict(self.poolmanager.key_fn_by_scheme)

    return _Adapter


_ADAPTER_CLS = None


def guarded_session():
    """A requests session that can only connect to public addresses."""
    import requests
    global _ADAPTER_CLS
    if _ADAPTER_CLS is None:
        _ADAPTER_CLS = _make_adapter()
    session = requests.Session()
    session.trust_env = False  # no proxies from the environment
    session.max_redirects = MAX_REDIRECTS
    adapter = _ADAPTER_CLS(max_retries=0)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


def _unwrap_blocked(exc: BaseException) -> Optional[OutboundBlocked]:
    """requests wraps what the connection raises; find our refusal inside."""
    seen = set()
    cur: Optional[BaseException] = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        if isinstance(cur, OutboundBlocked):
            return cur
        for arg in getattr(cur, "args", ()) or ():
            if isinstance(arg, OutboundBlocked):
                return arg
            reason = getattr(arg, "reason", None)
            if isinstance(reason, OutboundBlocked):
                return reason
        reason = getattr(cur, "reason", None)
        if isinstance(reason, OutboundBlocked):
            return reason
        cur = cur.__cause__ or cur.__context__
    return None


def guarded_request(method: str, url: str, *, headers: Optional[Dict[str, str]] = None,
                    params: Optional[Dict[str, str]] = None, timeout=(5, 10), stream: bool = False,
                    max_redirects: int = MAX_REDIRECTS, session=None,
                    resolver: Optional[Callable[[str, int], List[str]]] = None):
    """``(response, final_url)`` for a checked address, redirects walked by hand.

    Every hop goes through :func:`check_url` and the pinned transport; more
    than ``max_redirects`` hops is refused. Raises :class:`OutboundBlocked`
    for a refused address, ``requests`` exceptions for network failures.
    """
    sess = session or guarded_session()
    current = url
    for hop in range(max_redirects + 1):
        ok, reason = check_url(current, resolver=resolver)
        if not ok:
            raise OutboundBlocked(reason)
        try:
            resp = sess.request(method, current, headers=headers, params=params if hop == 0 else None,
                                timeout=timeout, stream=stream, allow_redirects=False)
        except OutboundBlocked:
            raise
        except Exception as exc:  # noqa: BLE001 - re-raise ours unwrapped, the rest as they are
            blocked = _unwrap_blocked(exc)
            if blocked is not None:
                raise blocked from None
            raise
        if resp.status_code in _REDIRECT_CODES:
            location = resp.headers.get("location")
            resp.close()
            if not location:
                raise OutboundBlocked("The address redirected without saying where.")
            current = urljoin(current, location)
            continue
        return resp, current
    raise OutboundBlocked("The address redirected too many times.")


__all__ = ["OutboundBlocked", "MAX_REDIRECTS", "is_public_ip", "resolve", "check_url",
           "guarded_session", "guarded_request"]
