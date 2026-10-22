"""Reading stream titles (ICY) and stations' now-playing feeds."""

from __future__ import annotations

import pytest

from core.internet_radio import feeds
from core.internet_radio.icy import IcyReader, extract_stream_title, parse_stream_title


@pytest.mark.parametrize("raw,artist,title", [
    ("Pale Harbour - Harbour Light", "Pale Harbour", "Harbour Light"),
    ("Tidewater – Night Ferry (Dub)", "Tidewater", "Night Ferry (Dub)"),
    ("  Saltmarsh  -  Static Bloom  ", "Saltmarsh", "Static Bloom"),
    ("Amina Lawal - Kites Over Kano - single", "Amina Lawal", "Kites Over Kano"),
    ("AC/DC - Back In Black", "AC/DC", "Back In Black"),
    ("Sault - Wildfires", "Sault", "Wildfires"),
])
def test_titles_that_name_a_track(raw, artist, title):
    parsed = parse_stream_title(raw, station_name="NTS 1")
    assert parsed.is_track, parsed.reason
    assert (parsed.artist, parsed.title) == (artist, title)


@pytest.mark.parametrize("raw", [
    "",
    "   ",
    "NTS 1",                                   # the station's own name
    "The Breakfast Show with Flo",             # a show, no separator
    "Charlie Bones",                           # a presenter
    "Station ID - Jingle",                     # a jingle
    "NTS 1 - Live from London",                # the station as the "artist"
    "Unknown - Track 1",                       # no artist
    "Moxie - DJ Mix",                          # a mix
    "--",
    "Advertisement - Commercial break",
])
def test_titles_that_are_not_tracks_say_not_identified(raw):
    parsed = parse_stream_title(raw, station_name="NTS 1")
    assert not parsed.is_track
    assert parsed.reason


def test_extract_stream_title_reads_utf8_and_latin1():
    assert extract_stream_title(b"StreamTitle='Bj\xc3\xb6rk - J\xc3\xb3ga';StreamUrl='';\x00\x00") == "Björk - Jóga"
    assert extract_stream_title(b"StreamTitle='Bj\xf6rk - J\xf3ga';") == "Björk - Jóga"
    assert extract_stream_title(b"StreamUrl='x';") is None


def _icy_stream(metaint, blocks):
    """audio blocks of `metaint` bytes, each followed by a metadata block."""
    out = b""
    for audio, meta in blocks:
        assert len(audio) == metaint
        if meta is None:
            out += audio + b"\x00"
        else:
            body = meta.encode()
            pad = (16 - len(body) % 16) % 16
            body += b"\x00" * pad
            out += audio + bytes([len(body) // 16]) + body
    return out


@pytest.mark.parametrize("chunk", [1, 7, 16, 1000])
def test_icy_reader_strips_metadata_whatever_the_chunking(chunk):
    stream = _icy_stream(16, [(b"A" * 16, "StreamTitle='One - Two';"), (b"B" * 16, None),
                              (b"C" * 16, "StreamTitle='Three - Four';")])
    titles = []
    reader = IcyReader(16, on_title=titles.append)
    audio = b"".join(reader.feed(stream[i:i + chunk]) for i in range(0, len(stream), chunk))
    assert audio == b"A" * 16 + b"B" * 16 + b"C" * 16
    assert titles == ["One - Two", "Three - Four"]


def test_icy_reader_without_metaint_passes_everything():
    reader = IcyReader(None)
    assert reader.feed(b"abc") == b"abc"


def test_a_title_callback_that_raises_never_breaks_the_audio():
    stream = _icy_stream(4, [(b"AAAA", "StreamTitle='a - b';"), (b"BBBB", None)])

    def boom(_t):
        raise RuntimeError("x")
    assert IcyReader(4, on_title=boom).feed(stream) == b"AAAABBBB"


# ── feeds ────────────────────────────────────────────────────────────────────

def test_somafm_feed():
    r = feeds.read_somafm({"songs": [{"title": "Harbour Light", "artist": "Pale Harbour", "album": "Lantern",
                                      "date": "1761130000"}]})
    assert r.is_track and (r.artist, r.title, r.release) == ("Pale Harbour", "Harbour Light", "Lantern")
    assert feeds.read_somafm({"nope": 1}) is None


def test_radioparadise_feed_and_breaks():
    r = feeds.read_radioparadise({"artist": "Sault", "title": "Wildfires", "album": "Untitled (Black Is)",
                                  "cover": "https://img.radioparadise.com/x.jpg"})
    assert r.is_track and r.art_url.startswith("https://")
    assert feeds.read_radioparadise({"artist": "Commercial-free", "title": "Listener supported"}).is_track is False
    # art over http isn't passed on
    assert feeds.read_radioparadise({"artist": "a", "title": "b", "cover": "http://x/y.jpg"}).art_url == ""


def test_kexp_feed_tracks_and_airbreaks():
    r = feeds.read_kexp({"results": [{"play_type": "trackplay", "artist": "Khruangbin", "song": "Maria También",
                                      "album": "Con Todo El Mundo", "airdate": "2026-10-22T10:00:00-07:00",
                                      "show": 123}]})
    assert r.is_track and r.show["id"] == "kexp:123"
    br = feeds.read_kexp({"results": [{"play_type": "airbreak", "airdate": "2026-10-22T10:05:00-07:00"}]})
    assert br.is_track is False and "talking" in br.reason


def test_nts_feed_is_a_show_with_its_episode():
    data = {"results": [{"channel_name": "1", "now": {
        "broadcast_title": "The Breakfast Show with Flo", "start_timestamp": "2026-10-22T08:00:00Z",
        "end_timestamp": "2026-10-22T10:00:00Z",
        "embeds": {"details": {"show_alias": "flo", "episode_alias": "flo-22nd-october-2026"}}}}]}
    r = feeds.read_nts(data, "1")
    assert r.is_track is False and "Breakfast Show" in r.reason
    assert r.show["id"] == "nts:flo/flo-22nd-october-2026"
    assert feeds.read_nts(data, "2") is None


def test_radiofrance_feed_reads_only_songs():
    song = {"now": {"firstLine": {"title": "Kites"}, "secondLine": {"title": "Amina Lawal"},
                    "song": {"release": {"title": "Kites EP"}}}}
    r = feeds.read_radiofrance(song)
    assert r.is_track and (r.artist, r.title, r.release) == ("Amina Lawal", "Kites", "Kites EP")
    assert feeds.read_radiofrance({"now": {"firstLine": {"title": "Club Jazzafip"}}}).is_track is False
    assert feeds.read_radiofrance([]) is None


def test_tracklist_readers():
    shows = feeds.read_kexp_shows({"results": [{"id": 9, "program_name": "The Morning Show",
                                                "host_names": ["John Richards"], "start_time": "2026-10-22T06:00:00Z"}]})
    assert shows[0]["id"] == "kexp:9" and "John Richards" in shows[0]["title"]
    tracks = feeds.read_kexp_tracks({"results": [
        {"play_type": "trackplay", "artist": "B", "song": "2", "airdate": "2026-10-22T06:10:00Z"},
        {"play_type": "airbreak", "airdate": "2026-10-22T06:05:00Z"},
        {"play_type": "trackplay", "artist": "A", "song": "1", "airdate": "2026-10-22T06:01:00Z"}]})
    assert [t["artist"] for t in tracks] == ["A", "B"]
    nts = feeds.read_nts_tracks({"results": [{"artist": "", "title": "Untitled (white label)", "offset": 600}]},
                                1761120000.0)
    assert nts[0]["artist"] == "" and nts[0]["time"] == 1761120600.0
