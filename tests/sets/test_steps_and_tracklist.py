"""Plain code under Library → Sets: the step between two tracks (Smooth,
Jump, Not known yet, with the Mixes panel's words), reading a pasted
tracklist and a MixesDB page, and splitting a title into song and version."""

from __future__ import annotations

import pytest

from core.sets import steps, tracklist


def dj(bpm, key):
    return {"bpm": bpm, "key": key}


@pytest.mark.parametrize("a,b,kind,reason", [
    (dj(118, "6A"), dj(119, "7A"), "smooth", "6A → 7A, +1 BPM"),
    (dj(119, "7A"), dj(120, "7A"), "smooth", "7A → 7A, +1 BPM · same key"),
    (dj(122, "8A"), dj(122, "8B"), "smooth", "8A → 8B, same BPM · relative major"),
    (dj(122, "8B"), dj(122, "8A"), "smooth", "8B → 8A, same BPM · relative minor"),
    (dj(120, "12A"), dj(121, "1A"), "smooth", "12A → 1A, +1 BPM"),
    (dj(119, "6A"), dj(121, "8A"), "jump", "6A → 8A, +2 BPM · 2 steps on the wheel: mix on a break"),
    (dj(120, "7A"), dj(122, "8B"), "jump", "7A → 8B, +2 BPM · 2 steps on the wheel: mix on a break"),
    (dj(120, "8A"), dj(124, "8A"), "jump", "8A → 8A, +4 BPM: mix on a break"),
    (dj(124, "8A"), dj(121, "9A"), "smooth", "8A → 9A, −3 BPM"),
    (dj(124, "8A"), dj(62, "8A"), "smooth", "8A → 8A, double time · same key"),
])
def test_steps_say_why(a, b, kind, reason):
    got = steps.step(a, b)
    assert (got["kind"], got["reason"]) == (kind, reason)


def test_a_side_not_worked_out_is_never_guessed_smooth():
    assert steps.step(dj(None, "8A"), dj(120, "8A"))["kind"] == "unknown"
    assert steps.step(dj(120, None), dj(120, "8A"))["reason"] == "key not worked out yet"
    assert steps.step(None, dj(120, "8A"))["reason"] == "BPM and key not worked out yet"


def test_wheel_steps():
    assert steps.wheel_steps("8A", "8A") == 0
    assert steps.wheel_steps("1A", "12A") == 1
    assert steps.wheel_steps("8A", "9B") == 2
    assert steps.wheel_steps("3A", "9A") == 6
    assert steps.wheel_steps("8A", "Am") is None


def test_summary_counts_the_meta_line():
    rows = [{"duration_ms": 300000, "dj": dj(118, "6A"), "locked": True},
            {"duration_ms": 360000, "dj": dj(127, "7A"), "locked": False}]
    found = steps.summary(rows, steps.steps_between(r["dj"] for r in rows))
    assert found == {"tracks": 2, "seconds": 660, "bpm_min": 118, "bpm_max": 127, "smooth": 0, "jumps": 1,
                     "unknown": 0, "locked": 1}


PASTE = """Tracklist:
01. Kestrel Row - Harbour Light
02. ines varga — copper sky [Lumen]
03) Okan Dere ft. Mira - Sand Script (Extended)
04. ID - ID
05. Tidewater - Night Ferry (Saltmarsh rmx)
06. the one with the vocals lol
07. Vela Sund /// Gravity Well
08. 1:02:30 rework of the opener
09. Okan D. – S�nd Scr�pt II
[27] 808 State - Pacific State
"""


def test_a_paste_is_read_line_by_line():
    read = tracklist.read_paste(PASTE)
    kinds = [(line["kind"], line.get("artist"), line.get("title")) for line in read["lines"]]
    assert kinds == [
        ("track", "Kestrel Row", "Harbour Light"),
        ("track", "ines varga", "copper sky"),
        ("track", "Okan Dere ft. Mira", "Sand Script (Extended)"),
        ("id", "ID", "ID"),
        ("track", "Tidewater", "Night Ferry (Saltmarsh Remix)"),
        ("unread", None, None),
        ("track", "Vela Sund", "Gravity Well"),
        ("unread", None, None),
        ("unread", None, None),
        ("track", "808 State", "Pacific State"),
    ]
    whys = [line["why"] for line in read["lines"] if line["kind"] == "unread"]
    assert whys == ["A comment, not a track", "A time and a note, no artist or title", "Some letters are damaged"]
    assert read["lines"][4]["note"] == '"rmx" read as Remix'
    assert read["lines"][6]["note"] == 'Read from "///"'
    assert read["lines"][-1]["at"] == "27:00"


@pytest.mark.gauntlet
def test_a_paste_is_data_and_has_a_size():
    """Pasted text is only ever split and read: markup, links and control
    characters come back as plain text, and the paste and its lines are
    capped."""
    hostile = ("<script>alert(1)</script> - http://169.254.169.254/latest\n"
               "{{template}} - [[Link|x]]\x00\x1b[31m\n" + "A - B\n" * (tracklist.MAX_LINES + 50))
    read = tracklist.read_paste(hostile)
    assert read["cut"] is True and read["count"] == tracklist.MAX_LINES
    first = read["lines"][0]
    assert first["artist"] == "<script>alert(1)</script>" and first["title"] == "http://169.254.169.254/latest"
    assert "\x00" not in read["lines"][1]["raw"] and "\x1b" not in read["lines"][1]["raw"]
    long_line = tracklist.read_line("A - " + "x" * 5000)
    assert len(long_line["raw"]) <= 300
    assert len(tracklist.read_paste("A - B\n" * 50000)["lines"]) == tracklist.MAX_LINES


@pytest.mark.parametrize("title,base,version", [
    ("Signal Fire (Dub)", "Signal Fire", "Dub"),
    ("Night Ferry (Saltmarsh Remix)", "Night Ferry", "Saltmarsh Remix"),
    ("Night Ferry (Saltmarsh rmx)", "Night Ferry", "Saltmarsh Remix"),
    ("Sand Script (feat. Mira) [Extended Mix]", "Sand Script", "Extended Mix"),
    ("Sand Script feat. Mira", "Sand Script", ""),
    ("Harbour Light (Original Mix)", "Harbour Light", ""),
    ("Harbour Light - Original Mix", "Harbour Light", ""),
    ("Harbour Light - Dub Mix", "Harbour Light", "Dub Mix"),
    ("Rock-A-Bye", "Rock-A-Bye", ""),
    ("Live Forever", "Live Forever", ""),
    ("Glasshouse (Interlude)", "Glasshouse", ""),
])
def test_titles_split_into_song_and_version(title, base, version):
    got = tracklist.split_title(title)
    assert (got["base"], got["version"]) == (base, version)


def test_artists_compare_by_credited_name():
    assert tracklist.artists_match("Okan Dere feat. Mira", "Okan Dere")
    assert tracklist.artists_match("The Kestrel Row", "Kestrel Row")
    assert tracklist.artists_match("Ines Varga & Lumen Fold", "Lumen Fold")
    assert not tracklist.artists_match("Ines Varga", "Ines Vargas")


def test_a_mixesdb_page_gives_its_tracklist_lines():
    wikitext = ("Intro text\n== Tracklist ==\n# [00] [[Pale Harbour]] - Lantern Room [[[Label:Glass|Glass]]]\n"
                "# [04] {{tl|x}}[[Ines Varga]] - Copper Sky\n#\n== Notes ==\n# [99] not a track\n")
    assert tracklist.wikitext_lines(wikitext) == ["[00] Pale Harbour - Lantern Room [Glass]", "[04] Ines Varga - Copper Sky"]
    line = tracklist.read_line("[04] Ines Varga - Copper Sky")
    assert (line["at"], line["artist"], line["title"]) == ("04:00", "Ines Varga", "Copper Sky")


@pytest.mark.gauntlet
@pytest.mark.parametrize("link,title", [
    ("https://www.mixesdb.com/w/2019-05-12_-_Saltmarsh_-_Essential_Mix", "2019-05-12 - Saltmarsh - Essential Mix"),
    ("https://www.mixes.wiki/w/2019-05-12_-_Saltmarsh", "2019-05-12 - Saltmarsh"),
    ("https://www.mixesdb.com/db/index.php?title=Some_Mix&action=edit", "Some Mix"),
    ("https://evil.example/w/2019-05-12", None),
    ("https://www.mixesdb.com.evil.example/w/x", None),
    ("http://127.0.0.1/w/x", None),
    ("file:///etc/passwd", None),
    ("https://www.mixesdb.com/w/a|b", None),
    ("https://www.mixesdb.com/w/", None),
])
def test_a_pasted_link_is_only_read_for_its_page_title(link, title):
    """A MixesDB link names a page; it's never fetched itself, and a link to
    any other host names nothing."""
    from core.sets.sources import MIXESDB_LINK_HOSTS

    assert tracklist.page_title_from_link(link, MIXESDB_LINK_HOSTS) == title


@pytest.mark.gauntlet
@pytest.mark.parametrize("line", [
    "=" * 100_000,
    "== " + "=" * 100_000 + " ==",
    "# " + "[[" * 50_000,
    "# " + "[[" * 50_000 + "]]",
    "# " + "[[[" * 30_000 + "|" * 1000,
    "# " + "[http://" * 20_000,
    "# " + "[https://a " * 20_000,
    "# " + "{{" * 50_000,
    "# " + "<" * 100_000,
])
def test_a_hostile_mixesdb_line_is_read_in_linear_time(line):
    """A MixesDB page is someone else's text, and Python's re holds the GIL:
    a line that makes a pattern backtrack would freeze the whole server.
    Lines are cut before anything reads them, and headings and links are
    scanned, so a 100 KB line of "=" or "[[" costs well under 100 ms."""
    import time

    page = "== Tracklist ==\n" + line + "\n# [00] Pale Harbour - Lantern Room\n"
    started = time.perf_counter()
    lines = tracklist.wikitext_lines(page)
    assert time.perf_counter() - started < 0.1
    assert lines[-1] == "[00] Pale Harbour - Lantern Room"
    started = time.perf_counter()
    for text in lines:
        tracklist.read_line(text)
    assert time.perf_counter() - started < 0.1


def test_links_are_reduced_by_scanning():
    assert tracklist.wikitext_lines(
        "== Tracklist ==\n# [[A|Pale Harbour]] - [[Lantern]] [[[Label:Glass|Glass]]] "
        "[https://www.discogs.com/x on Discogs] [not a link] [[ open\n"
    ) == ["Pale Harbour - Lantern [Glass] on Discogs [not a link] [[ open"]
    # a heading needs the same number of = on both sides
    assert tracklist.wikitext_lines("== Tracklist =\n# A - B\n") == ["A - B"]
