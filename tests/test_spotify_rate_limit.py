"""Spotify rate limits: obey Spotify's Retry-After exactly, estimate sensibly
without one, and ease back in afterwards.

Reported by Ross: one 429 on get_artist_albums produced a 4-hour pause,
"no Retry-After header, using 14400s default". The header was there; spotipy
2.26's urllib3 Retry (status_forcelist includes 429, and retries=0 still
counts a forcelisted status as retryable) swallowed the response and raised a
header-less "Max Retries" error, which the client mapped to 4 hours.

Hermetic: the spotipy tests talk to a throwaway HTTP server on 127.0.0.1.
"""

from __future__ import annotations

import threading
import time as real_time
import types
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
import requests
import spotipy
from urllib3.exceptions import MaxRetryError, ResponseError

import core.spotify_client as sc


# ── helpers ──────────────────────────────────────────────────────────────


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
        time=c.time, monotonic=c.time, sleep=c.sleep, strftime=real_time.strftime, localtime=real_time.localtime))
    sc._clear_rate_limit()
    yield c
    sc._clear_rate_limit()


def _spotify_error(status=429, headers=None, msg="rate limited"):
    return spotipy.SpotifyException(status, -1, msg, headers=headers)


class _Handler(BaseHTTPRequestHandler):
    status = 429
    headers_out = {"Retry-After": "120"}
    hits = 0

    def do_GET(self):  # noqa: N802 - http.server API
        type(self).hits += 1
        body = b'{"error": {"status": %d, "message": "API rate limit exceeded"}}' % self.status
        self.send_response(self.status)
        for key, value in self.headers_out.items():
            self.send_header(key, value)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


@pytest.fixture
def server(monkeypatch):
    for var in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    httpd = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    _Handler.status, _Handler.headers_out, _Handler.hits = 429, {"Retry-After": "120"}, 0
    yield f"http://127.0.0.1:{httpd.server_port}/v1/"
    httpd.shutdown()
    httpd.server_close()


# ── the root cause, against real spotipy + urllib3 ──────────────────────


class TestSpotipyKeepsTheHeader:
    def test_spotipys_own_session_loses_retry_after(self, server):
        # The construction the client used before: retries=0 with spotipy's
        # default status_forcelist (429 included) and its own session.
        sp = spotipy.Spotify(auth="token", retries=0, requests_timeout=5)
        sp.prefix = server
        with pytest.raises(spotipy.SpotifyException) as info:
            sp.artist_albums("abc")
        assert info.value.http_status == 429
        assert "Max Retries" in info.value.msg
        assert not info.value.headers
        assert sc.retry_after_from_exception(info.value) is None

    def test_make_spotipy_client_passes_retry_after_through(self, server):
        sp = sc.make_spotipy_client(auth="token", requests_timeout=5)
        sp.prefix = server
        with pytest.raises(spotipy.SpotifyException) as info:
            sp.artist_albums("abc")
        assert info.value.http_status == 429
        assert info.value.headers.get("Retry-After") == "120"
        assert sc.retry_after_from_exception(info.value) == 120
        assert _Handler.hits == 1  # one request, no hidden retries

    def test_a_server_error_is_not_mislabelled_as_a_rate_limit(self, server):
        _Handler.status, _Handler.headers_out = 503, {}
        sp = sc.make_spotipy_client(auth="token", requests_timeout=5)
        sp.prefix = server
        with pytest.raises(spotipy.SpotifyException) as info:
            sp.artist_albums("abc")
        assert info.value.http_status == 503
        assert not sc.is_rate_limit_error(info.value)


# ── reading Retry-After ──────────────────────────────────────────────────


class TestRetryAfterExtraction:
    def test_spotify_exception_with_header(self):
        assert sc.retry_after_from_exception(_spotify_error(headers={"Retry-After": "42"})) == 42

    def test_header_name_case_does_not_matter(self):
        assert sc.retry_after_from_exception(_spotify_error(headers={"retry-after": "7"})) == 7
        ci = requests.structures.CaseInsensitiveDict({"RETRY-AFTER": "9"})
        assert sc.retry_after_from_exception(_spotify_error(headers=ci)) == 9

    def test_429_without_header(self):
        assert sc.retry_after_from_exception(_spotify_error(headers={})) is None
        assert sc.retry_after_from_exception(_spotify_error(headers=None)) is None

    def test_max_retry_error(self):
        err = MaxRetryError(None, "/v1/artists/x/albums", ResponseError("too many 429 error responses"))
        assert sc.retry_after_from_exception(err) is None
        spotipy_err = _spotify_error(msg="/v1/artists/x/albums:\n Max Retries")
        assert sc.retry_after_from_exception(spotipy_err) is None

    def test_requests_http_error_response_headers(self):
        resp = requests.Response()
        resp.status_code = 429
        resp.headers["Retry-After"] = "30"
        assert sc.retry_after_from_exception(requests.HTTPError(response=resp)) == 30

    def test_header_found_along_the_cause_chain(self):
        try:
            try:
                raise _spotify_error(headers={"Retry-After": "15"})
            except spotipy.SpotifyException as inner:
                raise RuntimeError("wrapped") from inner
        except RuntimeError as outer:
            assert sc.retry_after_from_exception(outer) == 15

    def test_http_date_and_garbage(self):
        assert sc.parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT", now=1445412480 - 90) == 90
        assert sc.parse_retry_after("soon") is None
        assert sc.parse_retry_after("") is None
        assert sc.parse_retry_after("2.2") == 3


# ── the pause ────────────────────────────────────────────────────────────


class TestPauseLength:
    def test_real_header_is_obeyed_exactly(self, clock):
        sc._detect_and_set_rate_limit(_spotify_error(headers={"Retry-After": "720"}), "get_artist_albums")
        info = sc._get_rate_limit_info()
        assert info["retry_after"] == 720
        assert info["remaining_seconds"] == 720
        assert info["source"] == "spotify"
        assert info["trigger"] == "checking an artist's albums"

    def test_long_real_header_is_obeyed_exactly(self, clock):
        sc._detect_and_set_rate_limit(_spotify_error(headers={"Retry-After": "21600"}), "search_tracks")
        assert sc._get_rate_limit_info()["retry_after"] == 21600  # longer than our 4h cap

    def test_no_header_starts_with_a_short_estimate(self, clock):
        sc._detect_and_set_rate_limit(_spotify_error(headers={}), "get_artist_albums")
        info = sc._get_rate_limit_info()
        assert info["retry_after"] == 600
        assert info["source"] == "estimate"
        assert info["estimate_step"] == 1

    def test_max_retries_is_no_longer_four_hours(self, clock):
        sc._detect_and_set_rate_limit(_spotify_error(msg="/v1/x:\n Max Retries"), "get_artist_albums")
        assert sc._get_rate_limit_info()["retry_after"] == 600

    def test_non_429_does_nothing(self, clock):
        assert not sc._detect_and_set_rate_limit(_spotify_error(status=404), "get_album")
        assert sc._get_rate_limit_info() is None


class TestEscalationLadder:
    def test_ladder_values(self):
        assert [sc.estimated_pause_seconds(n) for n in range(1, 8)] == [
            600, 1200, 2400, 4800, 9600, 14400, 14400]

    def _limit(self):
        sc._detect_and_set_rate_limit(_spotify_error(headers={}), "get_artist")

    def _wait_out(self, clock, extra=0):
        clock.now = sc._rate_limit_until + extra

    def test_repeats_within_an_hour_of_the_last_pause_escalate(self, clock):
        lengths = []
        for _ in range(7):
            self._limit()
            lengths.append(sc._get_rate_limit_info()["retry_after"])
            self._wait_out(clock, extra=1800)  # cooldown passes, then limited again
        assert lengths == [600, 1200, 2400, 4800, 9600, 14400, 14400]

    def test_a_quiet_hour_resets_the_ladder(self, clock):
        self._limit()
        self._wait_out(clock, extra=1800)
        self._limit()
        assert sc._get_rate_limit_info()["retry_after"] == 1200
        self._wait_out(clock, extra=sc._ESCALATION_WINDOW + 1)
        self._limit()
        assert sc._get_rate_limit_info()["retry_after"] == 600

    def test_stragglers_during_a_pause_do_not_escalate(self, clock):
        self._limit()
        clock.now += 5
        self._limit()
        self._limit()
        info = sc._get_rate_limit_info()
        assert info["retry_after"] == 600 and info["estimate_step"] == 1

    def test_try_again_now_keeps_the_history(self, clock):
        self._limit()
        sc._clear_rate_limit(keep_history=True)
        assert sc._get_rate_limit_info() is None
        # a person's requests go now; background jobs still cool down first
        # (they used to fire at once, into a limit that was often still on)
        assert sc._get_post_ban_cooldown_remaining() == 600
        self._limit()
        assert sc._get_rate_limit_info()["retry_after"] == 1200

    def test_disconnect_forgets_the_history(self, clock):
        self._limit()
        sc._clear_rate_limit()
        self._limit()
        assert sc._get_rate_limit_info()["retry_after"] == 600

    def test_real_header_never_escalates(self, clock):
        for _ in range(3):
            sc._detect_and_set_rate_limit(_spotify_error(headers={"Retry-After": "90"}), "get_album")
            assert sc._get_rate_limit_info()["retry_after"] == 90
            self._wait_out(clock, extra=60)


# ── after the pause ──────────────────────────────────────────────────────


class TestPostPause:
    def test_cooldown_length_follows_the_pause(self):
        assert sc.post_ban_cooldown_length(5) == 60
        assert sc.post_ban_cooldown_length(600) == 600
        assert sc.post_ban_cooldown_length(14400) == 1800

    def test_pacing_eases_back_to_normal(self):
        base = 0.35
        assert sc.post_ban_pacing_interval(None, 600, base) == base
        assert sc.post_ban_pacing_interval(0, 600, base) == 2.0
        assert sc.post_ban_pacing_interval(599, 600, base) == 2.0
        mid = sc.post_ban_pacing_interval(600 + sc._POST_BAN_RAMP / 2, 600, base)
        assert base < mid < 2.0
        assert sc.post_ban_pacing_interval(600 + sc._POST_BAN_RAMP, 600, base) == base
        # a slower configured interval is never sped up
        assert sc.post_ban_pacing_interval(0, 600, 3.0) == 3.0

    def test_first_calls_after_a_pause_are_slow_and_jittered(self, clock, monkeypatch):
        monkeypatch.setattr(sc, "_get_base_api_interval", lambda: 0.35)
        sc._detect_and_set_rate_limit(_spotify_error(headers={"Retry-After": "600"}), "get_artist")
        assert sc._get_min_api_interval() == 0.35  # paused: nothing calls anyway
        clock.now = sc._rate_limit_until + 1
        samples = {round(sc._get_min_api_interval(), 6) for _ in range(20)}
        assert all(2.0 <= s <= 3.0 for s in samples)
        assert len(samples) > 1  # jitter, so threads don't fire in lockstep
        clock.now = sc._rate_limit_until + 600 + sc._POST_BAN_RAMP + 1
        assert sc._get_min_api_interval() == 0.35

    def test_cooldown_counts_from_when_the_pause_ended(self, clock):
        sc._detect_and_set_rate_limit(_spotify_error(headers={}), "get_artist")
        assert sc._get_post_ban_cooldown_remaining() == 0  # still paused
        clock.now = sc._rate_limit_until + 100
        assert sc._get_post_ban_cooldown_remaining() == 500
        assert sc._is_in_post_ban_cooldown()

    def _client(self, monkeypatch, probe_calls):
        client = sc.SpotifyClient.__new__(sc.SpotifyClient)
        client.sp = types.SimpleNamespace(auth_manager=types.SimpleNamespace(
            cache_handler=types.SimpleNamespace(get_cached_token=lambda: {"access_token": "x"})))
        client._auth_cache_lock = threading.Lock()
        client._auth_cached_result = None
        client._auth_cache_time = 0
        client._AUTH_CACHE_TTL = 60

        class _Probe:
            def current_user(self):
                probe_calls.append(1)
                return {"id": "me"}

        monkeypatch.setattr(sc, "make_spotipy_client", lambda *a, **k: _Probe())
        monkeypatch.setattr("core.boot_phase.is_boot_phase", lambda: False)
        return client

    def test_background_jobs_wait_out_the_cooldown(self, clock, monkeypatch):
        calls = []
        client = self._client(monkeypatch, calls)
        sc._detect_and_set_rate_limit(_spotify_error(headers={"Retry-After": "300"}), "get_artist")
        assert client.is_spotify_authenticated() is False  # paused
        clock.now = sc._rate_limit_until + 10
        assert client.is_spotify_authenticated() is False  # background, cooling down
        assert calls == []
        clock.now = sc._rate_limit_until + 301
        assert client.is_spotify_authenticated() is True
        assert calls == [1]

    def test_a_persons_request_may_go_ahead_after_the_pause(self, clock, monkeypatch):
        from flask import Flask

        calls = []
        client = self._client(monkeypatch, calls)
        sc._detect_and_set_rate_limit(_spotify_error(headers={"Retry-After": "300"}), "get_artist")
        clock.now = sc._rate_limit_until + 10
        with Flask(__name__).test_request_context("/api/search"):
            assert client.is_spotify_authenticated() is True
        assert calls == [1]


# ── the decorator ────────────────────────────────────────────────────────


class TestDecorator:
    def _decorated(self, errors):
        calls = []

        @sc.rate_limited
        def get_artist_albums():
            calls.append(1)
            if errors:
                raise errors.pop(0)
            return "ok"

        return get_artist_albums, calls

    @pytest.fixture(autouse=True)
    def _quiet(self, monkeypatch):
        monkeypatch.setattr(sc, "_get_base_api_interval", lambda: 0.0)

    def test_long_retry_after_pauses_exactly_and_raises(self, clock):
        fn, calls = self._decorated([_spotify_error(headers={"Retry-After": "3600"})])
        with pytest.raises(sc.SpotifyRateLimitError):
            fn()
        info = sc._get_rate_limit_info()
        assert info["retry_after"] == 3600 and info["source"] == "spotify"
        assert calls == [1]

    def test_short_retry_after_pauses_everyone_and_nobody_sleeps(self, clock):
        # A short Retry-After used to be slept through in the caller's own
        # thread, up to three times: in a web request that held one of
        # gunicorn's 8 threads for up to three minutes.
        fn, calls = self._decorated([_spotify_error(headers={"Retry-After": "2"})])
        with pytest.raises(sc.SpotifyRateLimitError):
            fn()
        assert calls == [1]
        assert clock.slept == []
        info = sc._get_rate_limit_info()
        assert info["retry_after"] == 2 and info["source"] == "spotify"

    def test_no_header_pauses_on_the_estimate_at_once(self, clock):
        fn, calls = self._decorated([_spotify_error(headers={})])
        with pytest.raises(sc.SpotifyRateLimitError):
            fn()
        assert calls == [1]
        assert clock.slept == []
        info = sc._get_rate_limit_info()
        assert info["retry_after"] == 600 and info["source"] == "estimate"

    def test_a_server_error_is_retried_by_background_jobs_only(self, clock):
        from flask import Flask

        fn, calls = self._decorated([_spotify_error(status=503, msg="bad gateway")])
        assert fn() == "ok"  # background: waits a moment and tries again
        assert calls == [1, 1] and len(clock.slept) == 1 and 2 <= clock.slept[0] <= 3

        fn, calls = self._decorated([_spotify_error(status=503, msg="bad gateway")])
        clock.slept.clear()
        with Flask(__name__).test_request_context("/api/x"):
            with pytest.raises(spotipy.SpotifyException):
                fn()  # a person's request answers at once
        assert calls == [1] and clock.slept == []


# ── which feature ────────────────────────────────────────────────────────


class TestTriggerWords:
    def test_endpoint_words(self):
        assert sc.describe_rate_limit_trigger("get_artist_albums") == "checking an artist's albums"
        assert sc.describe_rate_limit_trigger("mystery") == "a Spotify request"
        assert sc.describe_rate_limit_trigger(None) == "a Spotify request"

    def test_the_running_job_is_named(self, clock):
        with sc.spotify_feature("the watchlist scan"):
            sc._detect_and_set_rate_limit(_spotify_error(headers={}), "get_artist_albums")
        info = sc._get_rate_limit_info()
        assert info["feature"] == "the watchlist scan"
        assert info["trigger"] == "checking an artist's albums for the watchlist scan"
        assert sc.current_spotify_feature() is None

    def test_feature_works_as_a_decorator(self):
        @sc.spotify_feature("background enrichment")
        def job():
            return sc.current_spotify_feature()

        assert job() == "background enrichment"
        assert sc.current_spotify_feature() is None


# ── the enrichment worker ────────────────────────────────────────────────


class TestWorkerPauses:
    def _worker(self, monkeypatch, *, rate_limited=False, cooldown=0):
        from core import spotify_worker as sw

        w = sw.SpotifyWorker.__new__(sw.SpotifyWorker)
        w.should_stop = False
        w.paused = False
        w._stop_event = threading.Event()
        w.current_item = None
        w.processed = []
        w.client = types.SimpleNamespace(
            is_rate_limited=lambda: rate_limited,
            get_rate_limit_info=lambda: {"remaining_seconds": 500} if rate_limited else None,
            get_post_ban_cooldown_remaining=lambda: cooldown,
            is_spotify_metadata_available=lambda: False if rate_limited else True,
            _free_available=lambda: False,
            _free_active=lambda: False,
        )
        w._is_daily_budget_exhausted = lambda: False
        w._get_next_item = lambda: {"type": "artist", "id": 1, "name": "x"}
        w._process_item = lambda item: w.processed.append(item)
        w.inter_item_sleep = 0
        sleeps = []

        def fake_sleep(event, seconds):
            sleeps.append(seconds)
            w.should_stop = True

        monkeypatch.setattr(sw, "interruptible_sleep", fake_sleep)
        return w, sleeps

    def test_worker_sleeps_while_paused(self, monkeypatch):
        w, sleeps = self._worker(monkeypatch, rate_limited=True)
        w._run()
        assert w.processed == []
        assert sleeps == [60]

    def test_worker_waits_out_the_cooldown(self, monkeypatch):
        w, sleeps = self._worker(monkeypatch, cooldown=45)
        w._run()
        assert w.processed == []
        assert sleeps == [45]

    def test_worker_resumes_after(self, monkeypatch):
        w, sleeps = self._worker(monkeypatch)
        w._increment_daily_budget = lambda: None
        w._run()
        assert len(w.processed) == 1
