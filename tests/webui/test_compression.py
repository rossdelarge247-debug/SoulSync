"""Response compression policy (core/webui/compression.py).

What must be compressed (page shell, JS, CSS, JSON, SVG, static files) and,
just as important, what must go out byte-for-byte: 206 partials and anything
with a Content-Range (audio seeking), streamed bodies (SSE, generators), audio
and other binary types.
"""

from __future__ import annotations

import gzip
import json

import pytest

pytest.importorskip("flask_compress")
import brotli  # noqa: E402  (installed with flask-compress)
from flask import Flask, Response, send_from_directory, stream_with_context  # noqa: E402

from core.webui.compression import (  # noqa: E402
    CompressedBodyCache,
    COMPRESSION_ENV,
    init_compression,
)

BIG_HTML = "<!doctype html><title>x</title>" + "<p>soulsync</p>" * 400
BIG_JSON = {"items": [{"id": i, "name": f"track {i}"} for i in range(200)]}
BR = {"Accept-Encoding": "gzip, deflate, br, zstd"}
GZIP = {"Accept-Encoding": "gzip, deflate"}


@pytest.fixture
def static_dir(tmp_path):
    (tmp_path / "app.js").write_text("console.log('soulsync');\n" * 400)
    (tmp_path / "style.css").write_text("body { color: red; }\n" * 400)
    (tmp_path / "icon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'>" + "<g/>" * 400 + "</svg>")
    (tmp_path / "song.flac").write_bytes(b"fLaC" + bytes(range(256)) * 64)
    return tmp_path


@pytest.fixture
def app(static_dir):
    app = Flask(__name__, static_folder=str(static_dir), static_url_path="/static")
    compress = init_compression(app, enabled=True)
    assert compress is not None
    app.extensions["test_compress"] = compress

    @app.route("/")
    def index():
        return BIG_HTML

    @app.route("/api/items")
    def items():
        return BIG_JSON

    @app.route("/api/tiny")
    def tiny():
        return {"ok": True}

    @app.route("/stream/audio")
    def audio():
        # same shape as web_server._serve_audio_file_with_range's range branch
        data = (static_dir / "song.flac").read_bytes()

        def generate():
            yield data[0:4096]

        response = Response(generate(), status=206, mimetype="audio/flac", direct_passthrough=True)
        response.headers["Content-Range"] = f"bytes 0-4095/{len(data)}"
        response.headers["Accept-Ranges"] = "bytes"
        response.headers["Content-Length"] = "4096"
        return response

    @app.route("/stream/whole")
    def whole_audio():
        return send_from_directory(static_dir, "song.flac", mimetype="audio/flac")

    @app.route("/api/events")
    def events():
        def generate():
            for i in range(50):
                yield f"data: {json.dumps({'n': i, 'pad': 'x' * 40})}\n\n"

        return Response(stream_with_context(generate()), content_type="text/event-stream")

    @app.route("/api/streamed-json")
    def streamed_json():
        def generate():
            yield "["
            yield ",".join(json.dumps({"n": i, "pad": "x" * 40}) for i in range(100))
            yield "]"

        return Response(generate(), mimetype="application/json")

    @app.route("/api/partial-json")
    def partial_json():
        body = json.dumps(BIG_JSON)
        response = Response(body[:2000], status=206, mimetype="application/json")
        response.headers["Content-Range"] = f"bytes 0-1999/{len(body)}"
        return response

    return app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.mark.parametrize("path, mimetype", [
    ("/", "text/html"),
    ("/api/items", "application/json"),
    ("/static/app.js", "text/javascript"),
    ("/static/style.css", "text/css"),
    ("/static/icon.svg", "image/svg+xml"),
])
def test_text_responses_are_brotli_compressed(client, path, mimetype):
    plain = client.get(path)
    response = client.get(path, headers=BR)

    assert response.status_code == 200
    assert response.mimetype == mimetype
    assert response.headers["Content-Encoding"] == "br"
    assert "Accept-Encoding" in response.headers["Vary"]
    assert int(response.headers["Content-Length"]) == len(response.data) < len(plain.data)
    assert brotli.decompress(response.data) == plain.data


@pytest.mark.parametrize("path", ["/", "/api/items", "/static/app.js"])
def test_gzip_when_the_client_has_no_brotli(client, path):
    plain = client.get(path)
    response = client.get(path, headers=GZIP)

    assert response.headers["Content-Encoding"] == "gzip"
    assert gzip.decompress(response.data) == plain.data


@pytest.mark.parametrize("path", ["/", "/static/app.js"])
def test_identity_when_the_client_asks_for_nothing(client, path):
    response = client.get(path)

    assert "Content-Encoding" not in response.headers
    assert response.headers["Vary"] == "Accept-Encoding"


def test_small_bodies_are_left_alone(client):
    response = client.get("/api/tiny", headers=BR)
    assert "Content-Encoding" not in response.headers


def test_compressed_static_file_drops_accept_ranges_and_tags_the_etag(client):
    plain = client.get("/static/app.js")
    response = client.get("/static/app.js", headers=BR)

    assert plain.headers["Accept-Ranges"] == "bytes"
    assert "Accept-Ranges" not in response.headers
    assert response.headers["ETag"] == plain.headers["ETag"][:-1] + ':br"'

    revalidated = client.get("/static/app.js", headers={**BR, "If-None-Match": response.headers["ETag"]})
    assert revalidated.status_code == 304


def test_range_request_on_a_static_file_is_not_compressed(client, static_dir):
    response = client.get("/static/app.js", headers={**BR, "Range": "bytes=0-9"})

    assert response.status_code == 206
    assert "Content-Encoding" not in response.headers
    assert response.headers["Content-Range"].startswith("bytes 0-9/")
    assert response.data == (static_dir / "app.js").read_bytes()[:10]


def test_audio_range_response_is_untouched(client, static_dir):
    response = client.get("/stream/audio", headers={**BR, "Range": "bytes=0-4095"})

    assert response.status_code == 206
    assert "Content-Encoding" not in response.headers
    assert response.headers["Content-Range"].startswith("bytes 0-4095/")
    assert response.headers["Accept-Ranges"] == "bytes"
    assert response.data == (static_dir / "song.flac").read_bytes()[:4096]


def test_whole_audio_file_is_untouched(client, static_dir):
    response = client.get("/stream/whole", headers=BR)

    assert response.status_code == 200
    assert "Content-Encoding" not in response.headers
    assert response.data == (static_dir / "song.flac").read_bytes()


def test_partial_json_is_not_compressed(client):
    response = client.get("/api/partial-json", headers=BR)

    assert response.status_code == 206
    assert "Content-Encoding" not in response.headers


@pytest.mark.parametrize("path", ["/api/events", "/api/streamed-json"])
def test_streamed_responses_are_not_compressed_or_buffered(app, client, path):
    response = client.get(path, headers=BR, buffered=False)
    try:
        assert "Content-Encoding" not in response.headers
        assert response.is_streamed
        first = next(response.response)
        assert first.startswith(b"data: ") or first == b"["
    finally:
        response.close()


def test_non_get_requests_are_not_compressed(client):
    response = client.post("/api/items", headers=BR)
    assert response.status_code == 405
    assert "Content-Encoding" not in response.headers


def test_runs_after_hooks_registered_later(static_dir):
    """Registered first, so it runs last: a later hook that rewrites the body
    (like the URL-base rewrite of the page shell) sees plain text."""
    app = Flask(__name__, static_folder=str(static_dir), static_url_path="/static")
    init_compression(app, enabled=True)

    @app.route("/")
    def index():
        return BIG_HTML

    @app.after_request
    def rewrite(response):
        response.set_data(response.get_data(as_text=True).replace("soulsync", "rewritten"))
        return response

    response = app.test_client().get("/", headers=BR)
    assert response.headers["Content-Encoding"] == "br"
    assert b"rewritten" in brotli.decompress(response.data)


def test_page_shell_and_static_bodies_are_compressed_once(app, client):
    cache = app.extensions["test_compress"].cache
    assert isinstance(cache, CompressedBodyCache)

    for _ in range(3):
        assert client.get("/", headers=BR).headers["Content-Encoding"] == "br"
        assert client.get("/static/app.js", headers=BR).headers["Content-Encoding"] == "br"
    assert (cache.misses, cache.hits) == (2, 4)

    # gzip is a separate entry; API JSON is never cached
    client.get("/static/app.js", headers=GZIP)
    client.get("/api/items", headers=BR)
    assert (cache.misses, cache.hits) == (3, 4)
    assert len(cache._entries) == 3


def test_cache_is_keyed_by_body_not_path(static_dir):
    app = Flask(__name__, static_folder=str(static_dir), static_url_path="/static")
    init_compression(app, enabled=True)
    pages = iter([BIG_HTML, BIG_HTML.replace("soulsync", "changed!")])

    @app.route("/")
    def index():
        return next(pages)

    client = app.test_client()
    first = brotli.decompress(client.get("/", headers=BR).data)
    second = brotli.decompress(client.get("/", headers=BR).data)
    assert first != second
    assert b"changed!" in second


def test_cache_evicts_least_recently_used_entries():
    cache = CompressedBodyCache(max_bytes=10)
    cache.set("br;a", b"12345")
    cache.set("br;b", b"12345")
    assert cache.get("br;a") == b"12345"  # a is now the most recent
    cache.set("br;c", b"12345")

    assert cache.get("br;b") is None
    assert cache.get("br;a") == b"12345"
    assert cache.size == 10


def test_cache_ignores_empty_keys_and_oversized_values():
    cache = CompressedBodyCache(max_bytes=10)
    cache.set("br;", b"123")
    cache.set("br;big", b"x" * 11)

    assert cache.get("br;") is None
    assert cache.get("br;big") is None
    assert cache.size == 0


def test_can_be_switched_off_with_the_environment(monkeypatch, static_dir):
    monkeypatch.setenv(COMPRESSION_ENV, "0")
    app = Flask(__name__, static_folder=str(static_dir), static_url_path="/static")
    assert init_compression(app) is None

    @app.route("/")
    def index():
        return BIG_HTML

    assert "Content-Encoding" not in app.test_client().get("/", headers=BR).headers
