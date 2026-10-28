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
        time=c.time, monotonic=c.time, sleep=c.sleep, strftime=time.strftime, localtime=time.localtime))
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
        assert sc._flush_persist()  # the writer thread has stored it
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
        assert sc.spotify_background_wait(headroom=0) > 3500  # jobs look here between items
        before = clock.now
        with pytest.raises(sc.SpotifyRateLimitError):
            sc._gate_before_request("search_tracks")  # waits a while, never an hour
        assert clock.now - before <= sc._BACKGROUND_MAX_WAIT + gate.BACKGROUND_WAIT_STEP * 1.25

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
            get_authorize_url=lambda: "https://accounts.spotify.com/authorize?client_id=id",
            redirect_uri=None)))
        monkeypatch.setattr(web_server, "get_spotify_client", lambda: fake)
        monkeypatch.setattr(web_server, "add_activity_item", lambda *a, **k: None)
        monkeypatch.setattr("os.path.exists", lambda p: p == "/.dockerenv")  # in Docker
        web_server.app.config["TESTING"] = True

        def go(uri, host="127.0.0.1:8008"):
            # the URI the client was built with (what the sign-in sends)
            fake.sp.auth_manager.redirect_uri = uri
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


# ── the independent review's findings (gauntlet review of 94ee570f) ──────


def _ok_body():
    track = {"id": "t1", "name": "Song", "artists": [{"name": "Band", "id": "a1"}],
             "album": {"name": "Album", "id": "al1", "images": [], "artists": [{"name": "Band"}]},
             "duration_ms": 1000}
    return {"id": "p1", "name": "Road Trip", "owner": {"display_name": "Ross"}, "images": [],
            "public": False, "collaborative": False, "snapshot_id": "s",
            "tracks": {"total": 1}, "items": [{"track": track}], "next": None, "total": 1}


@gauntlet
class TestPoolThreadsAndTheSlot:
    """H1: a pool thread a web request waits on is that person's request, and
    no background job holds the background slot while it waits for budget."""

    @pytest.fixture
    def waiting_background_job(self, fake_spotify):
        _FakeSpotify.status, _FakeSpotify.headers_out, _FakeSpotify.body = 200, {}, {"ok": True}
        for _ in range(sc._background_hourly_budget()):
            sc._background_counter.add()  # the hourly share is spent
        url = fake_spotify + "me"
        job = threading.Thread(target=lambda: _swallow(lambda: sc.GatedSpotifySession().get(url)), daemon=True)
        job.start()
        time.sleep(0.3)  # it's waiting for budget now
        yield url
        sc.cancel_spotify_waits()
        job.join(15)
        assert not job.is_alive()

    def test_a_pool_thread_of_a_web_request_answers_within_two_seconds(self, waiting_background_job):
        from concurrent.futures import ThreadPoolExecutor
        from flask import Flask

        url = waiting_background_job
        with Flask(__name__).test_request_context("/api/match/suggestions", method="POST"):
            fetch = sc.spotify_context(lambda: sc.GatedSpotifySession().get(url).status_code)
            with ThreadPoolExecutor(1) as pool:
                started = time.monotonic()
                assert pool.submit(fetch).result(timeout=5) == 200
                assert time.monotonic() - started < 2.0

    def test_a_job_a_person_waits_for_isnt_held_behind_the_waiting_job(self, waiting_background_job):
        url = waiting_background_job
        out = []

        def person_job():
            with sc.spotify_person_job():
                out.append(sc.GatedSpotifySession().get(url).status_code)

        started = time.monotonic()
        t = threading.Thread(target=person_job)
        t.start()
        t.join(5)
        assert out == [200] and time.monotonic() - started < 2.0

    def test_a_background_request_gives_up_instead_of_waiting_an_hour(self, clock, monkeypatch):
        monkeypatch.setattr(sc, "_background_hourly_budget", lambda: 60)
        for _ in range(60):
            sc._background_counter.add()
        before = clock.now
        with pytest.raises(sc.SpotifyRateLimitError):
            sc._gate_before_request("get_album")
        assert clock.now - before <= sc._BACKGROUND_MAX_WAIT + gate.BACKGROUND_WAIT_STEP * 1.25


def _swallow(fn):
    try:
        fn()
    except Exception:  # noqa: BLE001 - the waiting job is cancelled at teardown
        pass


@pytest.fixture
def sign_in(monkeypatch):
    """Both callbacks with a recording token exchange: which manager got the code."""
    import web_server
    used = []

    class _Global:
        def __init__(self, **kw):
            self.kw = kw

        def get_access_token(self, code, check_cache=True):
            assert check_cache is False
            used.append(("account", code))
            return {"access_token": "fresh"}

    class _Profile:
        redirect_uri = "http://127.0.0.1:8888/callback"

        def get_access_token(self, code, check_cache=True):
            assert check_cache is False
            used.append(("profile", code))
            return {"access_token": "theirs"}

    signed_in = types.SimpleNamespace(is_spotify_authenticated=lambda: True, _invalidate_auth_cache=lambda: None)
    monkeypatch.setattr("core.spotify_client.make_spotify_oauth", lambda **kw: _Global(**kw))
    monkeypatch.setattr(web_server, "_profile_spotify_oauth", lambda pid: _Profile())
    monkeypatch.setattr(web_server.metadata_registry, "clear_cached_profile_spotify_client", lambda pid: None)
    monkeypatch.setattr(web_server.metadata_registry, "get_spotify_client_for_profile", lambda pid: signed_in)
    monkeypatch.setattr(web_server.config_manager, "get_spotify_config",
                        lambda: {"client_id": "id", "client_secret": "s",
                                 "redirect_uri": "http://127.0.0.1:8888/callback"})
    monkeypatch.setattr(web_server, "clear_cached_metadata_client", lambda *a: None)
    monkeypatch.setattr(web_server, "add_activity_item", lambda *a, **k: None)
    monkeypatch.setattr(web_server, "get_spotify_client", lambda: signed_in)
    monkeypatch.setattr(web_server, "spotify_enrichment_worker", None)
    web_server.app.config["TESTING"] = True

    from http.server import HTTPServer
    server = HTTPServer(("127.0.0.1", 0), web_server._make_spotify_callback_handler())
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def via(callback, query):
        if callback == "8008":
            r = web_server.app.test_client().get(f"/callback?{query}")
            return r.status_code, r.get_data(as_text=True)
        r = requests.get(f"http://127.0.0.1:{server.server_port}/callback?{query}", timeout=10,
                         proxies={"http": None, "https": None})
        return r.status_code, r.text

    yield via, used
    server.shutdown()
    server.server_close()


@gauntlet
class TestCallbacksRouteSignIns:
    """H2, L2: a profile's sign-in goes to that profile, on either callback."""

    @pytest.mark.parametrize("callback", ["8008", "8888"])
    def test_a_profile_sign_in_goes_to_the_profile(self, sign_in, callback):
        via, used = sign_in
        status, page = via(callback, "code=abc&state=profile_2")
        assert status == 200 and "personal Spotify account is now connected" in page
        assert used == [("profile", "abc")]  # never the account's token

    @pytest.mark.parametrize("callback", ["8008", "8888"])
    def test_the_accounts_sign_in_goes_to_the_account(self, sign_in, callback):
        via, used = sign_in
        status, page = via(callback, "code=xyz")
        assert status == 200 and "You can close this window" in page
        assert used == [("account", "xyz")]

    @pytest.mark.parametrize("callback", ["8008", "8888"])
    def test_signing_in_during_a_pause_says_so(self, sign_in, callback):
        via, used = sign_in
        sc._set_global_rate_limit(3600, "get_saved_tracks", has_real_header=True)
        status, page = via(callback, "code=xyz")
        assert status == 200 and "Spotify is connected" in page and "wait until" in page
        status, page = via(callback, "code=abc&state=profile_2")
        assert status == 200 and "Your personal Spotify account is connected" in page
        assert used == [("account", "xyz"), ("profile", "abc")]

    def test_a_profile_without_an_app_is_never_the_accounts_sign_in(self, sign_in, monkeypatch):
        import web_server
        via, used = sign_in
        monkeypatch.setattr(web_server, "_profile_spotify_oauth", lambda pid: None)
        status, _page = via("8888", "code=abc&state=profile_3")
        assert status == 400 and used == []


@gauntlet
class TestPlaylistLoadsAsAJob:
    """M1: a playlist's tracks load in a job; the page answers at once and polls."""

    def test_the_page_answers_at_once_and_the_job_finishes(self, web):
        http, _client = web
        _FakeSpotify.status, _FakeSpotify.headers_out, _FakeSpotify.body = 200, {}, _ok_body()
        started = time.monotonic()
        first = http.get("/api/spotify/playlist/p1?async=1")
        assert first.status_code == 202 and time.monotonic() - started < 1.0
        job_id = first.get_json()["job_id"]
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            state = http.get(f"/api/spotify/playlist-load/{job_id}").get_json()
            if state["status"] in ("complete", "error"):
                break
            time.sleep(0.05)
        assert state["status"] == "complete", state
        assert state["playlist"]["name"] == "Road Trip" and len(state["playlist"]["tracks"]) == 1

    def test_while_paused_the_page_says_so_without_a_job(self, web):
        http, _client = web
        sc._set_global_rate_limit(3600, "get_playlist_by_id", has_real_header=True)
        r = http.get("/api/spotify/playlist/p1?async=1")
        assert r.status_code == 429 and r.get_json()["error"].startswith("Spotify asked us to wait until")
        assert _FakeSpotify.hits == 0


@gauntlet
class TestStoredStateWriter:
    """M2: storing never happens in the thread that got the 429; latest wins."""

    def test_a_slow_store_doesnt_hold_the_429s_thread(self, monkeypatch):
        writes = []

        def slow_set(value):
            time.sleep(1.0)
            writes.append(value)

        monkeypatch.setattr(sc, "_state_store_set", slow_set)
        started = time.monotonic()
        sc._set_global_rate_limit(3600, "search_tracks", has_real_header=True)
        assert time.monotonic() - started < 0.3
        assert sc._flush_persist(5) and writes and writes[-1]["retry_after"] == 3600

    def test_the_newer_pause_is_stored_last(self, monkeypatch):
        box = {}
        gate_open = threading.Event()

        def held_set(value):
            gate_open.wait(5)
            box["v"] = value

        monkeypatch.setattr(sc, "_state_store_set", held_set)
        first, older, newer = sc._next_store_seq(), sc._next_store_seq(), sc._next_store_seq()
        sc._persist({"until": 1}, seq=first)  # being written
        time.sleep(0.1)
        sc._persist({"until": 3}, seq=newer)
        sc._persist({"until": 2}, seq=older)  # taken earlier, arrives later
        gate_open.set()
        assert sc._flush_persist(5)
        assert box["v"] == {"until": 3}


@gauntlet
class TestGoneEndpoints:
    """M3: only a refusal about the endpoint marks it gone."""

    def _err(self, status, msg):
        return spotipy.SpotifyException(status, -1, msg)

    def test_a_404_or_one_id_never_marks_it(self):
        assert not sc._note_gone_endpoint("artist_top_tracks", self._err(404, "Not found"), "a")
        assert not sc._note_gone_endpoint("artist_top_tracks", self._err(403, "Forbidden"), "a")
        assert not sc._note_gone_endpoint("artist_top_tracks", self._err(403, "Forbidden"), "a")
        assert not sc._endpoint_gone("artist_top_tracks")

    def test_three_different_ids_mark_it(self):
        for item in ("a", "b"):
            assert not sc._note_gone_endpoint("artist_top_tracks", self._err(403, "Forbidden"), item)
        assert sc._note_gone_endpoint("artist_top_tracks", self._err(403, "Forbidden"), "c")
        assert sc._endpoint_gone("artist_top_tracks")

    def test_the_endpoints_own_words_mark_it_at_once(self):
        assert sc._note_gone_endpoint("audio_features", self._err(403, "This endpoint is deprecated"), "t")

    def test_a_whole_app_refusal_never_marks_it(self):
        for item in "abcd":
            assert not sc._note_gone_endpoint(
                "artists_batch", self._err(403, "Check settings on developer.spotify.com/dashboard, "
                                                "the user may not be registered."), item)
            assert not sc._note_gone_endpoint(
                "artists_batch", self._err(403, "Active premium subscription required for the owner of the app."), item)
        assert not sc._endpoint_gone("artists_batch")

    def test_forgotten_for_another_app_or_a_new_sign_in(self):
        sc._note_gone_endpoint("audio_features", self._err(403, "deprecated"), "t")
        sc.set_active_client_id("app-1")
        sc._note_gone_endpoint("audio_features", self._err(403, "deprecated"), "t")
        sc.set_active_client_id("app-2")
        assert not sc._endpoint_gone("audio_features")
        sc._note_gone_endpoint("audio_features", self._err(403, "deprecated"), "t")
        sc.forget_gone_endpoints()
        assert not sc._endpoint_gone("audio_features")


@gauntlet
class TestPausedPlaylistsAnswer:
    """M4: a pause part way isn't "these are all your playlists"."""

    def test_a_pause_part_way_is_raised_not_a_partial_list(self, fake_spotify):
        client = _client_for(fake_spotify)
        _FakeSpotify.status, _FakeSpotify.headers_out = 200, {}
        page = {"items": [{"id": f"p{i}", "name": f"P{i}", "owner": {"display_name": "R"}, "public": False,
                           "collaborative": False, "items": {"total": 1}} for i in range(50)],
                "next": "more", "total": 120}
        _FakeSpotify.body = page

        class _Then429(_FakeSpotify):
            pass

        calls = {"n": 0}
        real_get = sc.GatedSpotifySession.request

        def second_page_429(self, method, url, *a, **k):
            calls["n"] += 1
            if calls["n"] == 2:
                _FakeSpotify.status, _FakeSpotify.headers_out = 429, {"Retry-After": "3600"}
            return real_get(self, method, url, *a, **k)

        import unittest.mock as um
        with um.patch.object(sc.GatedSpotifySession, "request", second_page_429):
            with pytest.raises(sc.SpotifyRateLimitError):
                client.get_user_playlists_metadata_only()

    def test_after_a_restart_the_stored_list_is_shown_while_paused(self, web, monkeypatch):
        import web_server
        http, client = web
        _FakeSpotify.status, _FakeSpotify.headers_out, _FakeSpotify.body = 200, {}, {
            "items": [{"id": "p1", "name": "Sunday", "owner": {"display_name": "Ross"}, "public": False,
                       "collaborative": False, "items": {"total": 3}}], "next": None, "total": 1}
        client.get_user_playlists_metadata_only()
        assert sc._flush_persist()
        fresh = _client_for(client.sp.prefix)  # a new process: nothing in memory
        monkeypatch.setattr(web_server, "get_spotify_client_for_profile", lambda *a, **k: fresh)
        sc._set_global_rate_limit(3600, "get_user_playlists_metadata_only", has_real_header=True)
        r = http.get("/api/spotify/playlists")
        assert r.status_code == 200 and r.headers.get("X-Spotify-Stale") == "1"
        assert [p["id"] for p in r.get_json()] == ["p1"]


@gauntlet
class TestRetryAfterBounds:
    """M5: whatever the header says, the pause is at most a day and answers."""

    @pytest.mark.parametrize("value", ["-5", "0", "nan", "inf", "-inf", "1e400", "abc", "86400",
                                       "999999999999", "Wed, 21 Oct 2099 07:28:00 GMT"])
    def test_any_header(self, clock, value):
        sc.parse_retry_after(value)  # never raises
        response = types.SimpleNamespace(status_code=429, headers={"Retry-After": value})
        sc._gate_after_response(response, "search_tracks")
        info = sc._get_rate_limit_info()
        assert info is not None and 0 < info["remaining_seconds"] <= 24 * 3600
        assert sc.describe_pause_until(info).startswith("Spotify")
        sc._reset_for_tests()

    def test_a_stored_pause_from_a_garbled_header_is_cut_to_a_day(self, clock, monkeypatch):
        monkeypatch.setattr(sc, "_state_store_get", lambda: {"until": clock.now + 10 ** 12, "source": "spotify"})
        sc._state_loaded = False
        assert sc._get_rate_limit_info()["remaining_seconds"] <= 24 * 3600


class TestRedirectUriEdges:
    """L1: the URI the sign-in actually sends, guarded."""

    def test_a_port_that_isnt_a_number(self):
        assert "port" in gate.redirect_uri_problem("http://localhost:abc/callback")

    def test_quotes_are_not_part_of_it(self):
        assert gate.redirect_uri_problem('"http://127.0.0.1:8888/callback"') is None

    def test_a_profiles_sign_in_is_checked_too(self, monkeypatch):
        import web_server
        from core.security import session_profile as _sp
        _resolve = _sp.resolve_session_profile
        monkeypatch.setattr(_sp, "resolve_session_profile", lambda **kw: _resolve(**{**kw, "profile_count": 1}))
        monkeypatch.setattr(web_server, "_profile_spotify_oauth", lambda pid: types.SimpleNamespace(
            redirect_uri="http://localhost:8888/callback", get_authorize_url=lambda: pytest.fail("sent to Spotify")))
        web_server.app.config["TESTING"] = True
        r = web_server.app.test_client().get("/auth/spotify?profile_id=2")
        assert r.status_code == 400 and "http://127.0.0.1:8888/callback" in r.get_data(as_text=True)


@gauntlet
class TestRefreshWithRotation:
    """L3: threads waiting on a refresh share it even when the token rotates."""

    def test_rotated_refresh_token_threads_share_one_refresh(self):
        endpoint = _TokenEndpoint(_response(200, {"access_token": "new", "refresh_token": "R2",
                                                  "expires_in": 3600, "token_type": "Bearer"}))
        original = endpoint.post

        def slow_post(*a, **k):
            time.sleep(0.3)
            return original(*a, **k)

        endpoint.post = slow_post
        auth = _oauth(_Cache(dict(EXPIRED)), endpoint)
        out = []
        threads = [threading.Thread(target=lambda: out.append(auth.get_access_token(as_dict=False)))
                   for _ in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(5)
        assert out == ["new"] * 6
        assert len(endpoint.posts) == 1


@gauntlet
class TestPausePerApp:
    """L4: a profile's own app has its own pause; a new app starts a new ladder."""

    def test_another_apps_429_doesnt_pause_the_account(self, clock):
        sc.set_active_client_id("shared-app")
        response = types.SimpleNamespace(status_code=429, headers={"Retry-After": "600"})
        sc._gate_after_response(response, "search_tracks", client_id="own-app")
        assert not sc._is_globally_rate_limited()
        with pytest.raises(sc.SpotifyRateLimitError):
            sc._gate_before_request("search_tracks", client_id="own-app")
        sc._gate_before_request("search_tracks", client_id="shared-app")  # goes

    def test_a_new_app_starts_the_estimate_ladder_afresh(self, clock):
        sc.set_active_client_id("app-1")
        sc._set_global_rate_limit(None, "x")
        clock.now = sc._rate_limit_until + 10
        sc.set_active_client_id("app-2")
        sc._set_global_rate_limit(None, "x")
        assert sc._get_rate_limit_info()["retry_after"] == 600  # not 1200


@gauntlet
class TestLoadUnderTheLock:
    """L6: a pause seen while the stored one loads isn't overwritten by it."""

    def test_the_later_end_wins(self, clock, monkeypatch):
        monkeypatch.setattr(sc, "_state_store_get", lambda: {"until": clock.now + 100, "source": "spotify",
                                                             "retry_after": 100})
        sc._state_loaded = False
        sc._set_global_rate_limit(3600, "search_tracks", has_real_header=True)
        assert sc._get_rate_limit_info()["remaining_seconds"] == 3600

    def test_an_older_stored_pause_doesnt_replace_a_newer_one(self, clock, monkeypatch):
        sc._set_global_rate_limit(3600, "search_tracks", has_real_header=True)
        monkeypatch.setattr(sc, "_state_store_get", lambda: {"until": clock.now + 100, "source": "spotify"})
        sc._state_loaded = False
        assert sc._get_rate_limit_info()["remaining_seconds"] == 3600


@gauntlet
class TestBusy:
    """L7: a person's request that can't get budget within 2 s answers busy."""

    def test_busy_within_two_seconds(self, clock, monkeypatch):
        from flask import Flask
        sc._bucket.drain()
        monkeypatch.setattr(sc, "_get_base_api_interval", lambda: 20.0)  # a token every 20 s
        with Flask(__name__).test_request_context("/api/search"):
            with pytest.raises(sc.SpotifyBusyError):
                sc._gate_before_request("search_tracks")
        assert sum(clock.slept) <= gate.INTERACTIVE_MAX_WAIT
