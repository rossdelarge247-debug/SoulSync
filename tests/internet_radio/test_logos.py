"""Station logos (HANDOFF 55): fetched by the server, cached on disk and served
from our own origin, so the browser never loads a station's host, and
without the route ever becoming an open image proxy.

Nothing here touches the network: the fetches are fakes, or refused by the
outbound guard before any connection.
"""

from __future__ import annotations

import json
import struct
import zlib

import pytest

import api.radio as radio_api
from core.internet_radio import directory, logos, store
from core.internet_radio import stations as st
from core.internet_radio.stations import Station, Stream


def _png(w=4, h=4) -> bytes:
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    raw = b"".join(b"\x00" + b"\x00\x00\x00" * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


PNG = _png()
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>'


class Resp:
    def __init__(self, body=b"", status=200, ctype="image/png", length=None):
        self.status_code = status
        self.headers = {"Content-Type": ctype} if ctype else {}
        if length is not None:
            self.headers["Content-Length"] = str(length)
        self._body = body
        self.closed = False

    def iter_content(self, size):
        for i in range(0, len(self._body), size):
            yield self._body[i:i + size]

    def close(self):
        self.closed = True


class Fetcher:
    def __init__(self, resp=None):
        self.resp = resp or Resp(PNG)
        self.calls = []

    def __call__(self, method, url, **kw):
        self.calls.append((method, url, kw))
        if isinstance(self.resp, BaseException):
            raise self.resp
        return self.resp, url


@pytest.fixture(autouse=True)
def logo_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("SOULSYNC_RADIO_LOGO_DIR", str(tmp_path / "logos"))
    logos.reset_for_tests()
    yield tmp_path / "logos"
    logos.reset_for_tests()


# ── what counts as a logo ──

def test_only_raster_images_by_their_first_bytes():
    assert logos.sniff(PNG) == "image/png"
    assert logos.sniff(b"\xff\xd8\xff\xe0rest") == "image/jpeg"
    assert logos.sniff(b"GIF89a....") == "image/gif"
    assert logos.sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    assert logos.sniff(b"\x00\x00\x01\x00\x01\x00") == "image/x-icon"
    for bad in (SVG, b"<?xml version='1.0'?><svg/>", b"<!doctype html><html>", b"", b"%PDF-1.7",
                b"\x00\x00\x01\x00\x00\x00"):
        assert logos.sniff(bad) is None


def test_a_good_png_is_fetched_through_the_guard_with_a_cap():
    f = Fetcher()
    data, mime = logos.fetch("https://logos.example.com/a.png", request=f)
    assert (data, mime) == (PNG, "image/png")
    method, url, kw = f.calls[0]
    assert (method, url, kw["stream"]) == ("GET", "https://logos.example.com/a.png", True)
    assert f.resp.closed


@pytest.mark.parametrize("resp, words", [
    (Resp(SVG, ctype="image/svg+xml"), "SVG"),
    (Resp(SVG, ctype="image/png"), "isn't a PNG"),          # the host lies; the bytes decide
    (Resp(b"<html>hi</html>", ctype="text/html"), "isn't an image"),
    (Resp(PNG, status=404), "404"),
    (Resp(b"\x89PNG\r\n\x1a\n" + b"x" * (logos.MAX_BYTES + 10)), "512 KB"),
    (Resp(PNG, length=logos.MAX_BYTES + 1), "512 KB"),
])
def test_anything_else_is_refused(resp, words):
    with pytest.raises(logos.LogoError) as err:
        logos.fetch("https://logos.example.com/a", request=Fetcher(resp))
    assert words in str(err.value)


def test_a_huge_canvas_is_refused():
    pytest.importorskip("PIL")
    with pytest.raises(logos.LogoError):
        logos.fetch("https://logos.example.com/big.png", request=Fetcher(Resp(_png(5000, 1))))


@pytest.mark.parametrize("url", ["http://127.0.0.1/logo.png", "http://192.168.1.2/l.png",
                                 "http://169.254.169.254/latest/meta-data", "http://localhost/l.png",
                                 "file:///etc/passwd", "ftp://x.example.com/l.png",
                                 "https://user:pw@logos.example.com/l.png", "javascript:alert(1)"])
def test_private_and_odd_addresses_are_refused_before_any_connection(url):
    with pytest.raises(logos.LogoError):
        logos.fetch(url)   # the real outbound guard


# ── the cache ──

def test_cached_on_disk_and_asked_for_once(logo_dir):
    f = Fetcher()
    path, mime = logos.logo_for("https://logos.example.com/a.png", request=f)
    assert path.read_bytes() == PNG and mime == "image/png" and str(path).startswith(str(logo_dir))
    meta = json.loads(path.with_suffix(".json").read_text())
    assert meta["url"] == "https://logos.example.com/a.png"
    assert logos.logo_for("https://logos.example.com/a.png", request=f)[0] == path
    assert len(f.calls) == 1


def test_a_failed_logo_isnt_asked_for_again_for_a_while():
    f = Fetcher(Resp(SVG, ctype="image/svg+xml"))
    assert logos.logo_for("https://logos.example.com/s.svg", request=f) is None
    assert logos.logo_for("https://logos.example.com/s.svg", request=f) is None
    assert len(f.calls) == 1


def test_the_cache_keeps_under_its_size(logo_dir, monkeypatch):
    for i in range(5):
        logos.logo_for(f"https://logos.example.com/{i}.png", request=Fetcher())
    assert len(list(logo_dir.glob("*.img"))) == 5
    logos.prune(limit=len(PNG) * 2)
    assert len(list(logo_dir.glob("*.img"))) == 2
    assert len(list(logo_dir.glob("*.json"))) == 2


# ── where logos come from ──

def test_built_in_logos_are_https_only_and_every_one_parses():
    picks = st.builtin_stations()
    with_logo = [s for s in picks if s.logo_url]
    assert len(with_logo) >= 20
    assert all(s.logo_url.startswith("https://") for s in with_logo)
    assert all(not s.logo_url.lower().endswith(".svg") for s in with_logo)
    assert st.builtin_logo("http://x.example.com/l.png") == ""
    assert st.builtin_logo("javascript:alert(1)") == ""


def test_the_page_only_ever_gets_our_own_address():
    s = Station(id="nts-1", name="NTS 1", kind="eclectic", source="built_in",
                streams=[Stream(id="m", url="https://stream.example.com/a")],
                logo_url="https://www.nts.live/apple-touch-icon.png")
    out = st.public_station(s)
    assert out["logo_url"].startswith("/api/radio/stations/nts-1/logo?v=")
    assert "nts.live" not in json.dumps(out)
    s.logo_url = ""
    assert st.public_station(s)["logo_url"] == ""


def test_directory_favicons_are_kept_for_the_server_to_fetch():
    entry = {"stationuuid": "12345678-1234-1234-1234-123456789abc", "name": "Lowlands",
             "url_resolved": "https://s.example.com/live", "codec": "MP3", "bitrate": 128,
             "favicon": "http://lowlands.example.com/favicon.png"}
    assert directory.station_from_entry(entry).logo_url == "http://lowlands.example.com/favicon.png"
    entry["favicon"] = "data:image/svg+xml,<svg/>"
    assert directory.station_from_entry(entry).logo_url == ""


# ── the route ──

def test_the_route_serves_a_known_stations_logo_with_nosniff(client, monkeypatch):
    fetched = []
    monkeypatch.setattr(logos, "fetch", lambda url, request=None: fetched.append(url) or (PNG, "image/png"))
    r = client.get("/api/radio/stations/nts-1/logo?v=x")
    assert r.status_code == 200
    assert r.mimetype == "image/png" and r.data == PNG
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert "sandbox" in r.headers["Content-Security-Policy"]
    assert fetched == [st.builtin_station("nts-1").logo_url]


def test_the_route_is_no_open_proxy(client, monkeypatch):
    fetched = []
    monkeypatch.setattr(logos, "fetch", lambda url, request=None: fetched.append(url) or (PNG, "image/png"))
    # an address in the request is never used: only a station's own logo
    for path in ("/api/radio/stations/nts-1/logo?url=https://evil.example.com/x.png",
                 "/api/radio/stations/https%3A%2F%2Fevil.example.com%2Fx.png/logo",
                 "/api/radio/stations/not-a-station/logo",
                 "/api/radio/stations/fip/logo"):          # a built-in pick without a logo
        r = client.get(path)
        assert r.status_code in (200, 404)
    assert all("evil" not in u for u in fetched)
    assert set(fetched) <= {st.builtin_station("nts-1").logo_url}


def test_the_route_needs_a_profile(client, who):
    who["pid"] = None
    assert client.get("/api/radio/stations/nts-1/logo").status_code == 401


def test_a_logo_that_cant_be_used_is_a_404(client, monkeypatch):
    def refuse(url, request=None):
        raise logos.LogoError("nope")
    monkeypatch.setattr(logos, "fetch", refuse)
    assert client.get("/api/radio/stations/kexp/logo").status_code == 404


# ── an admin's link ──

def _passing(monkeypatch):
    monkeypatch.setattr(radio_api, "check_url", lambda url: (True, ""))
    monkeypatch.setattr(radio_api, "check_link", lambda url: {"ok": True, "codec": "MP3", "bitrate_kbps": 320,
                                                              "sends_titles": True, "allows_direct": False})


def test_a_link_takes_an_optional_logo_checked_the_same_way(client, db, monkeypatch):
    _passing(monkeypatch)
    monkeypatch.setattr(logos, "fetch", lambda url, request=None: (PNG, "image/png"))
    link = client.post("/api/radio/links", json={"url": "https://x.example.com/live.mp3", "name": "Lowlands",
                                                 "kind": "electronic",
                                                 "logo_url": "https://x.example.com/logo.png"}).get_json()["link"]
    assert link["logo_url"] == "https://x.example.com/logo.png"
    favs = client.get("/api/radio/stations").get_json()["favourites"]
    mine = next(s for s in favs if s["id"] == f"link-{link['id']}")
    assert mine["logo_url"].startswith(f"/api/radio/stations/link-{link['id']}/logo?v=")
    r = client.get(mine["logo_url"])
    assert r.status_code == 200 and r.data == PNG
    # and without one, as before
    plain = client.post("/api/radio/links", json={"url": "https://x.example.com/b.mp3", "name": "Plain",
                                                  "kind": "world"}).get_json()["link"]
    assert plain["logo_url"] is None


def test_a_bad_logo_address_stops_the_add(client, db, monkeypatch):
    _passing(monkeypatch)

    def svg(url, request=None):
        raise logos.LogoError("SVG logos can't be used: PNG, JPEG, GIF, WebP or ICO only.")
    monkeypatch.setattr(logos, "fetch", svg)
    r = client.post("/api/radio/links", json={"url": "https://x.example.com/live.mp3", "name": "X",
                                              "kind": "world", "logo_url": "https://x.example.com/l.svg"})
    assert r.status_code == 400 and "SVG" in r.get_json()["message"]
    monkeypatch.setattr(radio_api, "check_url", lambda url: (False, "That address is on a private or local network.")
                        if "192.168" in url else (True, ""))
    r = client.post("/api/radio/links", json={"url": "https://x.example.com/live.mp3", "name": "X",
                                              "kind": "world", "logo_url": "http://192.168.1.4/l.png"})
    assert r.status_code == 400 and "private" in r.get_json()["message"]
    assert store.list_links(db) == []


def test_members_cant_add_a_logo(client, who):
    who["pid"], who["admin"] = 2, False
    r = client.post("/api/radio/links", json={"url": "https://x.example.com/s", "name": "X", "kind": "world",
                                              "logo_url": "https://x.example.com/l.png"})
    assert r.status_code == 403



# ── Change logo… (HANDOFF 66) ──

def _link(client, monkeypatch):
    _passing(monkeypatch)
    return client.post("/api/radio/links", json={"url": "https://x.example.com/live.mp3", "name": "Lowlands",
                                                 "kind": "electronic"}).get_json()["link"]


def test_a_links_logo_can_be_changed_through_the_same_check(client, db, monkeypatch):
    link = _link(client, monkeypatch)
    fetched = []
    monkeypatch.setattr(logos, "fetch", lambda url, request=None: fetched.append(url) or (PNG, "image/png"))
    r = client.put(f"/api/radio/links/{link['id']}", json={"logo_url": "https://x.example.com/new.png"})
    assert r.status_code == 200 and r.get_json()["link"]["logo_url"] == "https://x.example.com/new.png"
    assert fetched == ["https://x.example.com/new.png"]
    favs = client.get("/api/radio/stations").get_json()["favourites"]
    mine = next(s for s in favs if s["id"] == f"link-{link['id']}")
    assert mine["logo_url"].startswith(f"/api/radio/stations/link-{link['id']}/logo?v=")
    # empty goes back to the letters
    r = client.put(f"/api/radio/links/{link['id']}", json={"logo_url": ""})
    assert r.get_json()["link"]["logo_url"] is None
    assert store.get_link(db, link["id"])["logo_url"] is None


def test_a_bad_logo_changes_nothing(client, db, monkeypatch):
    link = _link(client, monkeypatch)
    monkeypatch.setattr(logos, "fetch", lambda url, request=None: (PNG, "image/png"))
    client.put(f"/api/radio/links/{link['id']}", json={"logo_url": "https://x.example.com/ok.png"})

    def svg(url, request=None):
        raise logos.LogoError("SVG logos can't be used: PNG, JPEG, GIF, WebP or ICO only.")
    monkeypatch.setattr(logos, "fetch", svg)
    r = client.put(f"/api/radio/links/{link['id']}", json={"logo_url": "https://x.example.com/l.svg"})
    assert r.status_code == 400 and r.get_json()["error"] == "logo_failed" and "SVG" in r.get_json()["message"]
    # the outbound guard refuses before anything is fetched
    monkeypatch.setattr(radio_api, "check_url", lambda url: (False, "That address is on a private or local network."))
    r = client.put(f"/api/radio/links/{link['id']}", json={"logo_url": "http://192.168.1.4/l.png"})
    assert r.status_code == 400 and "private" in r.get_json()["message"]
    assert store.get_link(db, link["id"])["logo_url"] == "https://x.example.com/ok.png"
    assert client.put(f"/api/radio/links/{link['id']}", json={"logo_url": 5}).status_code == 400
    assert client.put(f"/api/radio/links/{link['id']}", json={}).status_code == 400
    assert client.put("/api/radio/links/999", json={"logo_url": ""}).status_code == 404


def test_built_in_stations_have_no_logo_override(client):
    # only links have a PUT; a built-in's id isn't a link's number
    assert client.put("/api/radio/links/nts-1", json={"logo_url": "https://x.example.com/l.png"}).status_code in (
        404, 405)
