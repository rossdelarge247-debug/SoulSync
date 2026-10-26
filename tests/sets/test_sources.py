"""Famous mixes' sources (core/sets/sources.py): MixesDB's wiki API,
MusicBrainz's DJ-mix releases and Discogs. No network: the HTTP get and the
MusicBrainz client are stand-ins. The ``gauntlet`` tests are the outbound
rules: fixed hosts only (a pasted link is never fetched), no redirects,
timeouts and a size cap on every answer."""

from __future__ import annotations

import json

import pytest
import requests

from core.sets import sources


class Answer:
    def __init__(self, status=200, body=b"", chunks=None):
        self.status_code = status
        self._body = body
        self._chunks = chunks
        self.closed = False

    def iter_content(self, size):
        if self._chunks is not None:
            yield from self._chunks
            return
        for i in range(0, len(self._body), size):
            yield self._body[i:i + size]

    def close(self):
        self.closed = True


WIKI_SEARCH = {"query": {"search": [{"title": "2019-05-12 - Saltmarsh - Essential Mix", "timestamp": "2026-10-10T10:00:00Z"},
                                    {"title": "Category:Saltmarsh"}]}}
WIKI_PAGE = {"query": {"pages": [{"title": "2019-05-12 - Saltmarsh - Essential Mix", "revisions": [{
    "timestamp": "2026-10-10T10:00:00Z",
    "slots": {"main": {"content": "== Tracklist ==\n# [00] Pale Harbour - Foghorn Study\n# [04] ID - ID\n"}}}]}]}}
DISCOGS_SEARCH = {"results": [{"id": 4242, "title": "Saltmarsh - DJ-Kicks", "year": "2023"}, {"id": "bad"}]}
DISCOGS_RELEASE = {"id": 4242, "title": "DJ-Kicks", "year": 2023, "artists": [{"name": "Saltmarsh"}],
                   "tracklist": [{"type_": "heading", "title": "CD1"},
                                 {"type_": "track", "title": "Copper Sky", "artists": [{"name": "Ines Varga"}]},
                                 {"type_": "track", "title": "Intro"}]}


class FakeMB:
    def __init__(self, fail=False):
        self.fail = fail
        self.calls = []

    def search_dj_mixes(self, query, limit=8):
        self.calls.append(("search", query))
        if self.fail:
            raise requests.ConnectionError("no")
        return [{"id": "11111111-2222-3333-4444-555555555555", "title": "fabric 104: Saltmarsh", "date": "2020-01-01",
                 "artist-credit": [{"name": "Saltmarsh"}], "media": [{"track-count": 24}]}]

    def get_dj_mix_release(self, mbid):
        self.calls.append(("open", mbid))
        return {"id": mbid, "title": "fabric 104", "artist-credit": [{"name": "Saltmarsh"}], "media": [{"tracks": [
            {"title": "Copper Sky", "length": 250000, "artist-credit": [{"name": "Ines Varga"}],
             "recording": {"id": "mb-copper"}},
            {"title": "Night Ferry", "length": 300000, "artist-credit": [{"name": "Tidewater"}],
             "recording": {"id": "mb-night"}}]}]}


@pytest.fixture
def net(monkeypatch, cfg):
    calls = []
    routes = {}

    def fake_get(url, params=None, headers=None, timeout=None, allow_redirects=True, stream=False):
        calls.append({"url": url, "params": params, "headers": headers, "timeout": timeout,
                      "allow_redirects": allow_redirects, "stream": stream})
        for prefix, answer in routes.items():
            if url.startswith(prefix):
                result = answer(url, params) if callable(answer) else answer
                if isinstance(result, Exception):
                    raise result
                return result
        raise AssertionError(f"unexpected request {url}")

    monkeypatch.setattr(sources, "_http_get", fake_get)
    monkeypatch.setattr(sources, "MIN_INTERVAL", {"mixesdb": 0.0, "discogs": 0.0})
    mb = FakeMB()
    monkeypatch.setattr(sources, "_mb_client", mb)
    sources.clear_cache()
    cfg.data.update({sources.SETTING_MIXESDB: True, "discogs.token": "tok"})

    def wiki(url, params):
        return Answer(body=json.dumps(WIKI_SEARCH if params.get("list") == "search" else WIKI_PAGE).encode())

    routes[sources.MIXESDB_API] = wiki
    routes[f"{sources.DISCOGS_API}/database/search"] = Answer(body=json.dumps(DISCOGS_SEARCH).encode())
    routes[f"{sources.DISCOGS_API}/releases/"] = Answer(body=json.dumps(DISCOGS_RELEASE).encode())
    return type("Net", (), {"calls": calls, "routes": routes, "mb": mb, "cfg": cfg})


def test_search_asks_every_source_together(client, net):
    body = client.get("/api/sets/famous/search?q=saltmarsh").get_json()
    assert body["sources"] == {"mixesdb": {"state": "ok"}, "musicbrainz": {"state": "ok"}, "discogs": {"state": "ok"}}
    got = [(r["source"], r["title"], r.get("date")) for r in body["results"]]
    assert got == [("mixesdb", "Saltmarsh - Essential Mix", "2019-05-12"),
                   ("musicbrainz", "fabric 104: Saltmarsh", "2020-01-01"),
                   ("discogs", "Saltmarsh - DJ-Kicks", "2023")]
    discogs = next(c for c in net.calls if c["url"].startswith(sources.DISCOGS_API))
    assert discogs["headers"]["Authorization"] == "Discogs token=tok"
    assert discogs["headers"]["User-Agent"].startswith("SoulSync/")
    # a second look is the cache's
    before = len(net.calls)
    client.get("/api/sets/famous/search?q=saltmarsh")
    assert len(net.calls) == before and len(net.mb.calls) == 1


def test_sources_not_set_up_are_said_not_searched(client, net):
    net.cfg.data.update({sources.SETTING_MIXESDB: False, "discogs.token": ""})
    body = client.get("/api/sets/famous/search?q=saltmarsh").get_json()
    assert body["sources"]["mixesdb"] == {"state": "off", "why": "terms"}
    assert body["sources"]["discogs"] == {"state": "off", "why": "token"}
    assert net.calls == [] and [r["source"] for r in body["results"]] == ["musicbrainz"]
    assert client.get("/api/sets/sources").get_json()["sources"]["discogs"]["state"] == "off"


def test_one_source_down_leaves_the_others(client, net):
    net.routes[sources.MIXESDB_API] = requests.ConnectTimeout("slow")
    body = client.get("/api/sets/famous/search?q=saltmarsh").get_json()
    assert body["sources"]["mixesdb"] == {"state": "down"}
    assert {r["source"] for r in body["results"]} == {"musicbrainz", "discogs"}
    net.mb.fail = True
    sources.clear_cache()
    net.routes[f"{sources.DISCOGS_API}/database/search"] = Answer(status=503)
    body = client.get("/api/sets/famous/search?q=fabric").get_json()
    assert {k: v["state"] for k, v in body["sources"].items()} == {"mixesdb": "down", "musicbrainz": "down",
                                                                   "discogs": "down"}
    assert body["results"] == []


def test_saved_famous_mixes_come_back_in_a_search(client, net):
    client.post("/api/sets", json={"name": "Saltmarsh at Dekmantel 2021", "kind": "famous", "source": "mixesdb",
                                   "source_id": "x", "tracks": [{"track_id": "1"}]})
    body = client.get("/api/sets/famous/search?q=saltmarsh dekmantel").get_json()
    assert [(s["title"], s["from"], s["tracks"]) for s in body["saved"]] == [("Saltmarsh at Dekmantel 2021", "mixesdb", 1)]


def test_opening_a_mix_matches_it(client, net):
    body = client.post("/api/sets/famous/open", json={"source": "mixesdb",
                                                      "id": "2019-05-12 - Saltmarsh - Essential Mix"}).get_json()
    assert body["mix"]["title"] == "Saltmarsh - Essential Mix"
    assert body["mix"]["url"] == "https://www.mixesdb.com/w/2019-05-12_-_Saltmarsh_-_Essential_Mix"
    assert [(r["state"], r["at"]) for r in body["rows"]] == [("owned", "00:00"), ("id", "04:00")]
    mb = client.post("/api/sets/famous/open", json={"source": "musicbrainz",
                                                    "id": "11111111-2222-3333-4444-555555555555"}).get_json()
    assert [(r["title"], r["at"], r["state"], r["matched_by"]) for r in mb["rows"]] == [
        ("Copper Sky", "00:00", "owned", "musicbrainz"), ("Night Ferry", "04:10", "owned", "title")]
    dc = client.post("/api/sets/famous/open", json={"source": "discogs", "id": "4242"}).get_json()
    assert [(r["artist"], r["title"]) for r in dc["rows"]] == [("Ines Varga", "Copper Sky"), ("Saltmarsh", "Intro")]


def test_opening_a_mix_whose_source_is_down(client, net):
    net.routes[sources.MIXESDB_API] = requests.ConnectionError("down")
    res = client.post("/api/sets/famous/open", json={"source": "mixesdb", "id": "x"})
    assert res.status_code == 503 and res.get_json()["down"] == "mixesdb"
    assert client.post("/api/sets/famous/open", json={"source": "nope", "id": "x"}).status_code == 400
    net.cfg.data["discogs.token"] = ""
    assert client.post("/api/sets/famous/open", json={"source": "discogs", "id": "4242"}).status_code == 409


@pytest.mark.gauntlet
def test_only_fixed_hosts_are_ever_asked(client, net):
    """Whatever is typed or pasted, every request goes to MixesDB's API or
    Discogs' API; a pasted link is read for its page title and that title
    is sent as a parameter. A link to anywhere else is a plain search."""
    link = "https://www.mixesdb.com/w/2019-05-12_-_Saltmarsh_-_Essential_Mix"
    body = client.get(f"/api/sets/famous/search?q={link}").get_json()
    assert [r["id"] for r in body["results"]] == ["2019-05-12 - Saltmarsh - Essential Mix"]
    for evil in ("http://169.254.169.254/latest/meta-data", "https://evil.example/w/x", "file:///etc/passwd"):
        client.get("/api/sets/famous/search", query_string={"q": evil})
    client.post("/api/sets/famous/open", json={"source": "discogs", "id": "../../users/me"})
    client.post("/api/sets/famous/open", json={"source": "discogs", "id": "https://evil.example/"})
    client.post("/api/sets/famous/open", json={"source": "musicbrainz", "id": "../../x"})
    assert net.calls
    for call in net.calls:
        assert call["url"] == sources.MIXESDB_API or call["url"] in (
            f"{sources.DISCOGS_API}/database/search", f"{sources.DISCOGS_API}/releases/4242"), call["url"]
        assert call["allow_redirects"] is False and call["stream"] is True
        assert call["timeout"] == (sources.CONNECT_TIMEOUT, sources.READ_TIMEOUT)
    assert ("open", "../../x") in net.mb.calls  # the client itself refuses a non-MBID
    with pytest.raises(ValueError):
        sources._get_json("discogs", "https://evil.example/x", {})


@pytest.mark.gauntlet
def test_a_redirect_or_a_huge_answer_is_a_source_down(net):
    """A redirect is never followed, and an answer over the cap is cut off
    while it streams, not read whole."""
    net.routes[sources.MIXESDB_API] = Answer(status=302)
    with pytest.raises(sources.SourceDown):
        sources._get_json("mixesdb", sources.MIXESDB_API, {})
    endless = Answer(chunks=(b"x" * 65536 for _ in range(10 ** 6)))
    net.routes[sources.MIXESDB_API] = endless
    with pytest.raises(sources.SourceDown, match="too big"):
        sources._get_json("mixesdb", sources.MIXESDB_API, {})
    assert endless.closed
    net.routes[sources.MIXESDB_API] = Answer(body=b"<html>not json")
    with pytest.raises(sources.SourceDown):
        sources._get_json("mixesdb", sources.MIXESDB_API, {})


def test_the_musicbrainz_client_refuses_what_isnt_an_mbid(monkeypatch):
    from core.musicbrainz_client import MusicBrainzClient

    client = MusicBrainzClient()
    monkeypatch.setattr(client, "_get", lambda *a, **k: (_ for _ in ()).throw(AssertionError("fetched")))
    assert client.get_dj_mix_release("../../x") is None
    assert client.get_dj_mix_release("https://evil.example/") is None
    assert client.search_dj_mixes("   ") == []
