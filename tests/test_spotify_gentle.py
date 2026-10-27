"""Spotify throttling of 27 October (Ross: "spotify just won't connect /
throttle constantly", then "things hang for ages in the UI").

Against a fake Spotify on 127.0.0.1 (real spotipy, real requests, real
sockets) and fake clocks:

- one 429 with Retry-After pauses every thread, and nothing else is sent;
- a web request never sleeps on Spotify: with Spotify answering 429 and
  Retry-After 3600, a page answers within a second, eight at once too;
- the pause survives a restart, and belongs to the app that earned it;
- the request budget: a person's requests go first, background work has an
  hourly share and leaves the last tokens to people;
- a failed token refresh backs off, and a refresh token Spotify refuses is
  never retried; the callback exchanges the new code instead of refreshing
  the old token;
- the redirect URI rules (127.0.0.1, not localhost; https otherwise).

Outbound-request behaviour, so the gate's tests are marked ``gauntlet``.
"""

from __future__ import annotations

import json
import threading
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
import requests
import spotipy

import core.spotify_client as sc
from core import spotify_gate as gate

gauntlet = pytest.mark.gauntlet


# ── a fake Spotify ───────────────────────────────────────────────────────


class _FakeSpotify(BaseHTTPRequestHandler):
    status = 429
    headers_out = {"Retry-After": "3600"}
    body = {"error": {"status": 429, "message": "API rate limit exceeded"}}
    hits = 0
    lock = threading.Lock()

    def do_GET(self):  # noqa: N802 - http.server API
        with type(self).lock:
            type(self).hits += 1
        payload = json.dumps(self.body).encode()
        self.send_response(self.status)
        for key, value in self.headers_out.items():
            self.send_header(key, value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


@pytest.fixture
def fake_spotify(monkeypatch):
    for var in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _FakeSpotify)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    _FakeSpotify.status, _FakeSpotify.hits = 429, 0
    _FakeSpotify.headers_out = {"Retry-After": "3600"}
    _FakeSpotify.body = {"error": {"status": 429, "message": "API rate limit exceeded"}}
    yield f"http://127.0.0.1:{httpd.server_port}/v1/"
    httpd.shutdown()
    httpd.server_close()


def _client_for(prefix: str) -> sc.SpotifyClient:
    """A SpotifyClient talking to the fake, signed in (auth cached)."""
    client = sc.SpotifyClient.__new__(sc.SpotifyClient)
    client.sp = sc.make_spotipy_client(auth="token")
    client.sp.prefix = prefix
    client.user_id = "me"
    client._auth_cache_lock = threading.Lock()
    client._auth_cached_result = True
    client._auth_cache_time = time.time()
    client._AUTH_CACHE_TTL = 900
    client._short_cache = {}
    return client


class _Clock:
    def __init__(self, start=1_000_000.0):
        self.now = start
        self.slept = []

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


@pytest.fixture
def clock(monkeypatch):
    c = _Clock()
    monkeypatch.setattr(sc, "time", types.SimpleNamespace(
        time=c.time, sleep=c.sleep, strftime=time.strftime, localtime=time.localtime))
    sc._reset_for_tests()
    yield c
    sc._reset_for_tests()


# ── one 429, every thread ────────────────────────────────────────────────


@gauntlet
class TestOne429PausesEveryone:
    def test_retry_after_across_threads_sends_nothing_more(self, fake_spotify):
        client = _client_for(fake_spotify)
        errors = []

        def job():
            try:
                client.sp.artist_albums("abc")
            except Exception as e:  # noqa: BLE001 - recorded for the assert
                errors.append(e)

        threads = [threading.Thread(target=job) for _ in range(12)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)

        assert _FakeSpotify.hits == 1  # background requests go one at a time
        info = sc._get_rate_limit_info()
        assert info["source"] == "spotify" and 3590 <= info["remaining_seconds"] <= 3600
        assert len(errors) == 12
        assert sum(isinstance(e, sc.SpotifyRateLimitError) for e in errors) == 11
        # and later calls of any kind aren't sent at all
        with pytest.raises(sc.SpotifyRateLimitError):
            client.sp.current_user_saved_tracks(limit=50)
        assert _FakeSpotify.hits == 1

    def test_a_swallowed_429_still_pauses(self, fake_spotify):
        # get_saved_tracks catches every error and returns []: before the gate
        # its 429 set no pause, so the next call went straight out again.
        client = _client_for(fake_spotify)
        assert client.get_saved_tracks() == []
        assert sc._is_globally_rate_limited()
        assert client.get_saved_tracks() == []
        assert client.get_user_playlists_metadata_only() == []
        assert _FakeSpotify.hits == 1

    def test_a_short_retry_after_is_a_short_pause_not_a_sleep(self, fake_spotify):
        _FakeSpotify.headers_out = {"Retry-After": "30"}
        client = _client_for(fake_spotify)
        started = time.monotonic()
        # it used to sleep 31 s in this thread, up to three times, then retry
        assert client.get_artist_albums("abc", skip_cache=True) == []
        assert time.monotonic() - started < 1.0
        assert sc._get_rate_limit_info()["retry_after"] == 30
        assert _FakeSpotify.hits == 1


# ── a page never waits on Spotify ────────────────────────────────────────


@pytest.fixture
def web(monkeypatch, fake_spotify):
    from core.security import session_profile as _sp
    _resolve = _sp.resolve_session_profile
    client = _client_for(fake_spotify)
    monkeypatch.setattr(_sp, "resolve_session_profile",
                        lambda **kw: _resolve(**{**kw, "profile_count": 1}))
    import web_server
    monkeypatch.setattr(web_server, "get_spotify_client_for_profile", lambda *a, **k: client)
    monkeypatch.setattr(web_server, "add_activity_item", lambda *a, **k: None)
    web_server.app.config["TESTING"] = True
    return web_server.app.test_client(), client


@gauntlet
class TestPagesAnswerAtOnce:
    def test_a_page_answers_within_a_second_when_spotify_says_wait_an_hour(self, web):
        http, _client = web
        started = time.monotonic()
        first = http.get("/api/spotify/playlists")
        assert time.monotonic() - started < 1.0
        assert first.status_code in (200, 429)
        assert _FakeSpotify.hits == 1

        started = time.monotonic()
        second = http.get("/api/spotify/playlists")
        assert time.monotonic() - started < 1.0
        assert second.status_code == 429
        body = second.get_json()
        assert body["rate_limited"] is True
        assert body["error"].startswith("Spotify asked us to wait until ")
        assert _FakeSpotify.hits == 1  # nothing sent while paused

    def test_eight_pages_at_once_all_answer_within_a_second(self, web):
        http, _client = web
        http.get("/api/spotify/playlists")  # the 429 that starts the pause
        times, codes = [], []

        def load(path):
            started = time.monotonic()
            r = http.get(path)
            times.append(time.monotonic() - started)
            codes.append(r.status_code)

        paths = ["/api/spotify/playlists", "/api/spotify/playlist/37i9dQZF1DX0XUsuxWHRQd",
                 "/api/spotify/playlist/spotify:liked-songs"] * 3
        threads = [threading.Thread(target=load, args=(p,)) for p in paths[:8]]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        assert len(times) == 8 and max(times) < 1.0
        assert set(codes) == {429}
        assert _FakeSpotify.hits == 1

    def test_while_paused_the_last_list_is_shown(self, web):
        http, client = web
        _FakeSpotify.status, _FakeSpotify.headers_out = 200, {}
        _FakeSpotify.body = {"items": [{"id": "p1", "name": "Sunday", "owner": {"display_name": "Ross"},
                                        "public": False, "collaborative": False,
                                        "items": {"total": 3}}],
                             "next": None, "total": 1}
        assert [p.id for p in client.get_user_playlists_metadata_only()] == ["p1"]
        sc._set_global_rate_limit(3600, "get_user_playlists_metadata_only", has_real_header=True)
        r = http.get("/api/spotify/playlists")
        assert r.status_code == 200
        assert [p["id"] for p in r.get_json()] == ["p1"]


# ── the pause survives a restart ─────────────────────────────────────────


@gauntlet
class TestRestart:
    @pytest.fixture
    def store(self, monkeypatch):
        box = {}
        monkeypatch.setattr(sc, "_state_store_get", lambda: box.get("v"))
        monkeypatch.setattr(sc, "_state_store_set", lambda v: box.__setitem__("v", v))
        return box

    def _restart(self):
        sc._reset_for_tests()
        sc._state_loaded = False  # a new process reads what the last one stored

    def test_spotifys_wait_carries_over(self, clock, store):
        sc.set_active_client_id("app-1")
        sc._set_global_rate_limit(54000, "get_saved_tracks", has_real_header=True)  # 15 hours
        clock.now += 600
        self._restart()
        sc.set_active_client_id("app-1")
        info = sc._get_rate_limit_info()
        assert info["source"] == "spotify"
        assert info["remaining_seconds"] == 54000 - 600
        assert sc._is_globally_rate_limited()

    def test_background_still_cools_down_after_a_restart(self, clock, store):
        sc._set_global_rate_limit(1200, "get_artist", has_real_header=True)
        clock.now += 1300  # the pause ended while it was down
        self._restart()
        assert not sc._is_globally_rate_limited()
        assert sc._get_post_ban_cooldown_remaining() == 1100  # 1200 s cooldown, 100 s gone

    def test_another_app_is_not_paused_by_it(self, clock, store):
        sc.set_active_client_id("app-1")
        sc._set_global_rate_limit(3600, "search_tracks", has_real_header=True)
        self._restart()
        sc.set_active_client_id("app-2")
        assert not sc._is_globally_rate_limited()
        sc.set_active_client_id("app-1")
        assert sc._is_globally_rate_limited()

    def test_signing_in_again_keeps_spotifys_wait(self, clock, store):
        sc._set_global_rate_limit(3600, "search_tracks", has_real_header=True)
        assert sc.release_pause_after_sign_in() is True
        assert sc._is_globally_rate_limited()

    def test_signing_in_again_clears_our_own_estimate_but_background_cools_down(self, clock, store):
        sc._set_global_rate_limit(None, "search_tracks", has_real_header=False)
        assert sc.release_pause_after_sign_in() is False
        assert not sc._is_globally_rate_limited()
        assert sc._get_post_ban_cooldown_remaining() == 600

    def test_the_enrichment_budget_survives_a_restart(self, monkeypatch):
        from datetime import date
        from core import spotify_worker as sw
        from core.settings import config_manager
        box = {}
        monkeypatch.setattr(config_manager, "get", lambda key, default=None: box.get(key, default))
        monkeypatch.setattr(config_manager, "set", lambda key, value: box.__setitem__(key, value))
        w = sw.SpotifyWorker.__new__(sw.SpotifyWorker)
        w.daily_budget, w._daily_items_processed, w._daily_date = 500, 0, date.today()
        for _ in range(30):
            w._increment_daily_budget()
        again = sw.SpotifyWorker.__new__(sw.SpotifyWorker)
        again.daily_budget, again._daily_items_processed, again._daily_date = 500, 0, date.today()
        again._load_daily_budget()
        assert again._daily_items_processed == 30


# ── the budget ───────────────────────────────────────────────────────────


@gauntlet
class TestBudget:
    def test_bucket_keeps_the_last_tokens_for_people(self):
        now = [0.0]
        b = gate.TokenBucket(rate=lambda: 1.0, now=lambda: now[0], capacity=15, reserve=5, start=15)
        assert [b.take(False) for _ in range(10)] == [0.0] * 10
        assert b.take(False) > 0  # background stops at the reserve
        assert [b.take(True) for _ in range(5)] == [0.0] * 5  # a person may use it
        assert b.take(True) == pytest.approx(1.0)
        now[0] += 1.0
        assert b.take(True) == 0.0

    def test_a_restart_doesnt_open_with_a_burst(self):
        now = [0.0]
        b = gate.TokenBucket(rate=lambda: 1.0, now=lambda: now[0], capacity=15, reserve=5)
        assert b.take(False) == pytest.approx(1.0)  # starts at the reserve

    def test_background_has_an_hourly_share(self, clock, monkeypatch):
        monkeypatch.setattr(sc, "_background_hourly_budget", lambda: 60)
        monkeypatch.setattr(sc, "_get_base_api_interval", lambda: 0.05)
        for _ in range(60):
            sc._gate_before_request("search_tracks")
        assert sc._background_counter.count() == 60
        before = clock.now
        sc._gate_before_request("search_tracks")  # waits for the oldest to age out
        assert clock.now - before >= 3500

    def test_a_person_never_waits_more_than_two_seconds(self, clock):
        from flask import Flask
        sc._bucket.drain()
        with Flask(__name__).test_request_context("/api/search"):
            sc._gate_before_request("search_tracks")  # one token comes in a second
            for _ in range(3):
                try:
                    sc._gate_before_request("search_tracks")
                except sc.SpotifyBusyError:
                    break
        assert max(clock.slept) <= gate.INTERACTIVE_MAX_WAIT

    def test_a_person_is_refused_at_once_while_paused(self, clock):
        from flask import Flask
        sc._set_global_rate_limit(3600, "get_artist", has_real_header=True)
        with Flask(__name__).test_request_context("/api/artist"):
            with pytest.raises(sc.SpotifyRateLimitError):
                sc._gate_before_request("get_artist")
        assert clock.slept == []

    def test_background_waits_in_jittered_steps(self, clock, monkeypatch):
        sc._bucket.drain()
        monkeypatch.setattr(sc, "_get_base_api_interval", lambda: 20.0)  # a token every 20 s
        sc._gate_before_request("get_album")
        assert all(s <= gate.BACKGROUND_WAIT_STEP * 1.25 for s in clock.slept)
        assert len(clock.slept) >= 3


# ── token refresh ────────────────────────────────────────────────────────


class _Cache(spotipy.CacheHandler):
    def __init__(self, token):
        self.token = token
        self.saved = []

    def get_cached_token(self):
        return self.token

    def save_token_to_cache(self, token_info):
        self.saved.append(token_info)
        self.token = token_info


def _response(status, body):
    r = requests.Response()
    r.status_code = status
    r._content = json.dumps(body).encode()
    r.headers["Content-Type"] = "application/json"
    r.url = "https://accounts.spotify.com/api/token"
    return r


class _TokenEndpoint:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.posts = []

    def post(self, url, data=None, **kwargs):
        self.posts.append(dict(data or {}))
        return self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]


def _oauth(cache, endpoint):
    auth = sc.make_spotify_oauth("id", "secret", "http://127.0.0.1:8888/callback", cache_handler=cache)
    auth._session = endpoint
    return auth


EXPIRED = {"access_token": "old", "refresh_token": "R1", "expires_at": 0,
           "scope": sc.SPOTIFY_OAUTH_SCOPE, "expires_in": 3600, "token_type": "Bearer"}


@gauntlet
class TestRefresh:
    def test_a_refused_refresh_token_is_never_retried(self, clock):
        endpoint = _TokenEndpoint(_response(400, {"error": "invalid_grant",
                                                  "error_description": "Refresh token revoked"}))
        auth = _oauth(_Cache(dict(EXPIRED)), endpoint)
        for _ in range(5):
            with pytest.raises(sc.SpotifySignInExpired):
                auth.get_access_token(as_dict=False)
            clock.now += 7200
        assert len(endpoint.posts) == 1
        assert sc.spotify_sign_in_expired(auth.cache_handler)

    def test_a_failed_refresh_backs_off(self, clock):
        endpoint = _TokenEndpoint(_response(503, {"error": "server_error"}),
                                  _response(200, {"access_token": "new", "expires_in": 3600,
                                                  "token_type": "Bearer"}))
        auth = _oauth(_Cache(dict(EXPIRED)), endpoint)
        with pytest.raises(spotipy.SpotifyOauthError):
            auth.get_access_token(as_dict=False)
        with pytest.raises(spotipy.SpotifyOauthError):
            auth.get_access_token(as_dict=False)  # within the minute: not sent
        assert len(endpoint.posts) == 1
        clock.now += 61
        assert auth.get_access_token(as_dict=False) == "new"
        assert len(endpoint.posts) == 2

    def test_threads_needing_a_refresh_share_one(self, clock):
        endpoint = _TokenEndpoint(_response(200, {"access_token": "new", "expires_in": 3600,
                                                  "token_type": "Bearer"}))
        cache = _Cache(dict(EXPIRED))
        auth = _oauth(cache, endpoint)
        results = []
        threads = [threading.Thread(target=lambda: results.append(auth.get_access_token(as_dict=False)))
                   for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)
        assert results == ["new"] * 6
        assert len(endpoint.posts) == 1

    def test_the_callback_exchanges_the_new_code(self, clock):
        # With the cache checked, spotipy refreshed the OLD token instead; a
        # dead refresh token failed every sign-in until Disconnect.
        endpoint = _TokenEndpoint(_response(200, {"access_token": "fresh", "refresh_token": "R2",
                                                  "expires_in": 3600, "token_type": "Bearer"}))
        auth = _oauth(_Cache(dict(EXPIRED)), endpoint)
        token = auth.get_access_token("THE-CODE", check_cache=False)
        assert token["access_token"] == "fresh"
        assert [p["grant_type"] for p in endpoint.posts] == ["authorization_code"]

    def test_never_the_interactive_sign_in(self):
        auth = _oauth(_Cache(None), _TokenEndpoint(_response(200, {})))
        started = time.monotonic()
        with pytest.raises(sc.SpotifySignInExpired):
            auth.get_access_token(as_dict=False)  # spotipy would bind :8888 and wait
        assert time.monotonic() - started < 1.0


@gauntlet
class TestCallbackWhilePaused:
    def test_signing_in_during_a_pause_says_so(self, monkeypatch):
        import web_server

        class _Auth:
            def __init__(self, **kw):
                pass

            def get_access_token(self, code, check_cache=True):
                assert check_cache is False
                return {"access_token": "fresh"}

        monkeypatch.setattr("core.spotify_client.make_spotify_oauth", lambda **kw: _Auth())
        monkeypatch.setattr(web_server.config_manager, "get_spotify_config",
                            lambda: {"client_id": "id", "client_secret": "s",
                                     "redirect_uri": "http://127.0.0.1:8888/callback"})
        monkeypatch.setattr(web_server, "clear_cached_metadata_client", lambda *a: None)
        monkeypatch.setattr(web_server, "add_activity_item", lambda *a, **k: None)
        probe = types.SimpleNamespace(is_spotify_authenticated=lambda: pytest.fail("asked Spotify"),
                                      _invalidate_auth_cache=lambda: None)
        monkeypatch.setattr(web_server, "get_spotify_client", lambda: probe)
        sc._set_global_rate_limit(3600, "get_saved_tracks", has_real_header=True)
        web_server.app.config["TESTING"] = True
        r = web_server.app.test_client().get("/callback?code=abc")
        page = r.get_data(as_text=True)
        assert r.status_code == 200
        assert "Spotify is connected" in page and "Spotify asked us to wait until" in page
        assert sc._is_globally_rate_limited()  # signing in doesn't lift Spotify's wait


# ── redirect URIs ────────────────────────────────────────────────────────


class TestRedirectUri:
    @pytest.mark.parametrize("uri", [
        "http://127.0.0.1:8888/callback",
        "http://[::1]:8888/callback",
        "https://music.example.com/callback",
        "https://nas.tail1234.ts.net/callback",
    ])
    def test_accepted(self, uri):
        assert gate.redirect_uri_problem(uri) is None

    def test_localhost_is_refused_with_the_fix(self):
        problem = gate.redirect_uri_problem("http://localhost:8888/callback")
        assert "localhost" in problem and "http://127.0.0.1:8888/callback" in problem

    @pytest.mark.parametrize("uri", ["http://192.168.1.20:8888/callback", "http://nas.local:8888/callback"])
    def test_plain_http_off_this_computer_is_refused(self, uri):
        assert "https://" in gate.redirect_uri_problem(uri)

    @pytest.mark.parametrize("uri", ["", None, "127.0.0.1:8888/callback", "ftp://x/callback"])
    def test_malformed(self, uri):
        assert gate.redirect_uri_problem(uri)

    @pytest.mark.parametrize("host,loop", [("127.0.0.1:8008", True), ("localhost:8008", True),
                                           ("[::1]:8008", True), ("192.168.1.20:8008", False),
                                           ("soulsync.local", False)])
    def test_loopback_browser(self, host, loop):
        assert gate.is_loopback_host(host) is loop

    def test_the_default_is_the_one_spotify_accepts(self):
        from core.settings import config_manager
        default = config_manager._get_default_config()["spotify"]["redirect_uri"]
        assert default == gate.LOOPBACK_REDIRECT_URI
        assert gate.redirect_uri_problem(default) is None

    @pytest.fixture
    def auth_route(self, monkeypatch):
        import web_server
        from core.security import session_profile as _sp
        _resolve = _sp.resolve_session_profile
        monkeypatch.setattr(_sp, "resolve_session_profile",
                            lambda **kw: _resolve(**{**kw, "profile_count": 1}))
        fake = types.SimpleNamespace(sp=types.SimpleNamespace(auth_manager=types.SimpleNamespace(
            get_authorize_url=lambda: "https://accounts.spotify.com/authorize?client_id=id")))
        monkeypatch.setattr(web_server, "get_spotify_client", lambda: fake)
        monkeypatch.setattr(web_server, "add_activity_item", lambda *a, **k: None)
        monkeypatch.setattr("os.path.exists", lambda p: p == "/.dockerenv")  # in Docker
        web_server.app.config["TESTING"] = True

        def go(uri, host="127.0.0.1:8008"):
            monkeypatch.setattr(web_server.config_manager, "get_spotify_config",
                                lambda: {"client_id": "id", "client_secret": "s", "redirect_uri": uri})
            return web_server.app.test_client().get("/auth/spotify", headers={"Host": host})
        return go

    def test_a_mac_browser_goes_straight_to_spotify(self, auth_route):
        r = auth_route("http://127.0.0.1:8888/callback")
        assert r.status_code == 302
        assert r.headers["Location"].startswith("https://accounts.spotify.com/authorize")

    def test_localhost_is_caught_before_spotify_refuses_it(self, auth_route):
        r = auth_route("http://localhost:8888/callback")
        assert r.status_code == 400
        assert "http://127.0.0.1:8888/callback" in r.get_data(as_text=True)
