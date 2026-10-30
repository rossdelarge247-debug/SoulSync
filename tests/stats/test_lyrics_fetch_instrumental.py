"""POST /api/lyrics/fetch (api/stats.py) says when LRCLIB marks a track
instrumental, for the Visuals' lyrics layer's "Instrumental" state (27g)."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from flask import Flask


class _Api:
    def __init__(self, result):
        self.result = result

    def get_lyrics(self, **_kw):
        return self.result

    def search_lyrics(self, **_kw):
        return [self.result] if self.result else []


@pytest.fixture
def post(monkeypatch):
    import api.stats as stats
    import core.lyrics_client as lc

    app = Flask(__name__)
    app.register_blueprint(stats.bp)

    def go(result, body=None):
        monkeypatch.setattr(lc, "lyrics_client", SimpleNamespace(api=_Api(result)))
        return app.test_client().post(
            "/api/lyrics/fetch",
            json=body or {"title": "Night Ferry", "artist": "Tidewater", "album": "Lantern", "duration": 200},
        ).get_json()

    return go


def test_an_instrumental_says_so(post):
    out = post(SimpleNamespace(synced_lyrics=None, plain_lyrics=None, instrumental=True))
    assert out["instrumental"] is True
    assert out["success"] is False
    assert out["synced"] is None and out["plain"] is None


def test_words_are_never_instrumental(post):
    out = post(SimpleNamespace(synced_lyrics="[00:01.00] Hold the lantern low", plain_lyrics="Hold the lantern low",
                               instrumental=True))
    assert out["instrumental"] is False
    assert out["success"] is True and out["source"] == "lrclib"


def test_an_ordinary_hit_is_not_instrumental(post):
    out = post(SimpleNamespace(synced_lyrics=None, plain_lyrics="Hold the lantern low"))
    assert out["instrumental"] is False
    assert out["plain"] == "Hold the lantern low"


def test_title_and_artist_are_still_required(post):
    out = post(None, body={"title": "", "artist": ""})
    assert out["success"] is False and "instrumental" not in out
