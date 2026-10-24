"""Keys in Camelot notation and which keys and tempos mix (core/dj/camelot.py)."""

from __future__ import annotations

import pytest

from core.dj import camelot

# the whole wheel: Camelot code -> the short name the tags use
WHEEL = {
    "1A": "Abm", "1B": "B", "2A": "Ebm", "2B": "F#", "3A": "Bbm", "3B": "C#",
    "4A": "Fm", "4B": "Ab", "5A": "Cm", "5B": "Eb", "6A": "Gm", "6B": "Bb",
    "7A": "Dm", "7B": "F", "8A": "Am", "8B": "C", "9A": "Em", "9B": "G",
    "10A": "Bm", "10B": "D", "11A": "F#m", "11B": "A", "12A": "C#m", "12B": "E",
}


@pytest.mark.parametrize("code,name", sorted(WHEEL.items()))
def test_the_wheel_both_ways(code, name):
    assert camelot.parse_key(code)["name"] == name
    assert camelot.parse_key(name)["camelot"] == code


@pytest.mark.parametrize("spelling", ["A minor", "Am", "a min", "A-", "8A", "08A", "8a", "1m", "A Minor"])
def test_every_spelling_of_a_minor(spelling):
    key = camelot.parse_key(spelling)
    assert key["camelot"] == "8A" and key["name"] == "Am" and key["long"] == "A minor"


@pytest.mark.parametrize("spelling,code", [("G#m", "1A"), ("Abm", "1A"), ("G♯ minor", "1A"), ("Db", "3B"),
                                           ("C# major", "3B"), ("1d", "8B"), ("6m", "1A"), ("Bbm", "3A"),
                                           ("F#", "2B"), ("Gb", "2B"), ("Cmaj", "8B"), ("E", "12B")])
def test_sharps_flats_and_open_key(spelling, code):
    assert camelot.parse_key(spelling)["camelot"] == code


@pytest.mark.parametrize("junk", [None, "", "H", "13A", "0B", "Am7", "unknown", "x" * 40, 120])
def test_not_a_key(junk):
    assert camelot.parse_key(junk) is None


def test_long_names_use_the_proper_signs():
    assert camelot.parse_key("F#m")["long"] == "F♯ minor"
    assert camelot.parse_key("Bb")["long"] == "B♭ major"


def test_compatible_keys_wrap_round_the_wheel():
    assert camelot.compatible_keys("8A") == {"8A": "same", "9A": "up", "7A": "down", "8B": "relative"}
    assert camelot.compatible_keys("12B") == {"12B": "same", "1B": "up", "11B": "down", "12A": "relative"}
    assert camelot.compatible_keys("1A") == {"1A": "same", "2A": "up", "12A": "down", "1B": "relative"}
    assert camelot.compatible_keys("nope") == {}


@pytest.mark.parametrize("a,b,relation", [(128, 128, "same"), (128, 124, "same"), (128, 135, "same"),
                                          (128, 64, "half"), (128, 66, "half"), (87, 174, "double"),
                                          (174, 87, "half")])
def test_bpm_relation_inside_six_percent(a, b, relation):
    assert camelot.bpm_relation(a, b)[0] == relation


@pytest.mark.parametrize("a,b", [(128, 137), (128, 119), (128, 100), (128, 0), (0, 128), (128, None)])
def test_bpm_relation_outside(a, b):
    assert camelot.bpm_relation(a, b) is None


def test_bpm_windows_cover_half_and_double():
    windows = camelot.bpm_windows(100)
    assert windows[0] == pytest.approx((94, 106))
    assert windows[1] == pytest.approx((47, 53))
    assert windows[2] == pytest.approx((188, 212))


@pytest.mark.parametrize("raw,folded", [(128.04, 128.0), (240, 120), (45, 90), (29, 116), (0, None),
                                        (None, None), ("x", None)])
def test_fold_bpm(raw, folded):
    assert camelot.fold_bpm(raw) == folded
