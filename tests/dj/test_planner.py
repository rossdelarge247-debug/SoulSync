"""The pair planner (core/dj/planner.py) on synthetic grids: where the
outgoing track's mix starts and the incoming one comes in, the tempo ratio,
Auto's pick, and the crossfade fallback with its reason. No audio: each
track is a stored grid row shaped by core/dj/grid_store.public, as the
route gives it."""

from __future__ import annotations

import json

import pytest

from core.dj import grid_store, planner
from core.dj.grid import GRID_VERSION, phrases_from

#: a club track: 16 bars of drums, a groove, a breakdown, the drop, 16 bars out
CLUB = [["intro", 0, 16, 0.9], ["main", 16, 48, 0.5], ["breakdown", 48, 64, 0.8], ["drop", 64, 96, 0.8],
        ["outro", 96, 112, 0.9]]


def _row(bpm=124.0, *, first=0.5, sections=None, conf=0.86, dconf=0.9, meter="4/4", beats=None, truncated=False,
         mix_in=(0, 16, 0.9, "intro"), mix_out=(96, 112, 0.9, "outro"), downbeat_index=0, status="done"):
    sections = CLUB if sections is None else sections
    bars = sections[-1][2] if sections else 64
    changes = [s[1] for s in sections[1:]]
    return {"grid_version": GRID_VERSION, "status": status, "kind": "beats" if beats else "constant", "bpm": bpm,
            "period": 60.0 / bpm, "first_beat": first if not beats else beats[0], "downbeat_index": downbeat_index,
            "first_downbeat": first, "beat_confidence": conf, "downbeat_confidence": dconf, "meter": meter,
            "bars": bars, "beats_ms": grid_store.encode_beats(beats),
            "phrases_json": json.dumps(phrases_from(changes, bars)), "sections_json": json.dumps(sections),
            "mix_json": json.dumps({"in": list(mix_in) if mix_in else None,
                                    "out": list(mix_out) if mix_out else None}),
            "analysed_s": 240.0, "truncated": int(truncated), "level_db": -9.0, "replaygain_db": None}


def _track(row, *, key="8A", title="Night Ferry", duration_s=None, tid="1", dj_bpm=None):
    shaped = grid_store.public(row, tid)
    return {**shaped, "key": key, "title": title, "duration_s": duration_s,
            "dj_bpm": dj_bpm if dj_bpm is not None else (row or {}).get("bpm")}


def _bar(bpm, first, bar):
    return first + bar * 4 * 60.0 / bpm


# ── Auto ─────────────────────────────────────────────────────────────────────

def test_auto_compatible_key_and_close_tempo_is_a_long_blend_ending_with_the_outro():
    out = _track(_row(124.0), key="8A")
    incoming = _track(_row(126.0, first=0.2), key="9A", title="Static Bloom", tid="2")
    p = planner.plan(out, incoming)
    assert p["status"] == "ok" and p["style"] == "long_blend" and p["bars"] == 32 and p["chosen_by"] == "auto"
    assert p["beatmatch"] is True and p["fallback"] is None
    # the latest phrase that leaves 32 bars before the outro ends (bar 112)
    assert p["out"]["bar"] == 80 and p["out"]["end_bar"] == 112
    assert p["out"]["start"] == pytest.approx(_bar(124.0, 0.5, 80), abs=1e-3)
    assert p["out"]["end"] == pytest.approx(_bar(124.0, 0.5, 112), abs=1e-3)
    assert p["length_s"] == pytest.approx(32 * 4 * 60 / 124.0, abs=1e-3)
    # the incoming track comes in on its intro's first downbeat
    assert p["in"]["bar"] == 0 and p["in"]["start"] == pytest.approx(0.2, abs=1e-3) and p["in"]["how"] == "intro"
    assert p["tempo"]["relation"] == "same" and p["tempo"]["rate"] == pytest.approx(124 / 126, abs=1e-4)
    assert p["tempo"]["speed_change_ok"] is True and p["tempo"]["gap_pct"] == 1.6
    assert p["key"]["relation"] == "up"
    assert p["why"] == "8A → 9A, +2 BPM: the keys mix and the tempo is close"


def test_auto_a_wider_gap_with_compatible_keys_is_a_short_blend():
    p = planner.plan(_track(_row(124.0)), _track(_row(130.0), key="8B", tid="2"))
    assert p["style"] == "short_blend" and p["bars"] == 8 and p["beatmatch"] is True
    assert p["out"]["bar"] == 104  # the outro's last phrase: 8 bars to its end
    assert p["tempo"]["speed_change_ok"] is False and p["tempo"]["gap_pct"] == 4.8


def test_auto_a_key_clash_cuts_when_the_next_track_has_drums_and_echoes_out_when_it_hasnt():
    clash = planner.plan(_track(_row(124.0), key="9A"), _track(_row(125.0), key="4B", title="Brass Tide", tid="2"))
    assert clash["style"] == "cut" and clash["bars"] is None and clash["beatmatch"] is False
    assert clash["out"]["bar"] == 96 and clash["out"]["in_outro"] is True  # on the outro's first phrase
    assert clash["why"] == "9A → 4B, +1 BPM: the keys clash"
    soft = planner.plan(_track(_row(124.0), key="9A"),
                        _track(_row(125.0, mix_in=(0, 8, 0.1, "edge")), key="4B", tid="2"))
    assert soft["style"] == "echo_out" and soft["bars"] == 4 and soft["out"]["bar"] == 96


def test_auto_a_big_tempo_gap_echoes_out():
    p = planner.plan(_track(_row(124.0)), _track(_row(140.0), tid="2"))
    assert p["status"] == "ok" and p["style"] == "echo_out" and p["beatmatch"] is False
    assert "too far apart" in p["why"]
    assert p["tempo"]["gap_pct"] == 12.9


def test_auto_an_unknown_key_is_a_short_blend():
    p = planner.plan(_track(_row(124.0), key=None), _track(_row(124.0), tid="2"))
    assert p["style"] == "short_blend" and p["key"]["relation"] == "unknown"


def test_half_and_double_time_match():
    p = planner.plan(_track(_row(124.0)), _track(_row(62.5), tid="2"))
    assert p["tempo"]["relation"] == "half" and p["tempo"]["rate"] == pytest.approx(124 / 125, abs=1e-4)
    assert p["style"] == "long_blend"


# ── the styles ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("style,bars,out_bar,length", [
    ("long_blend", None, 80, 32),
    ("short_blend", None, 104, 8),
    ("short_blend", 16, 96, 16),
    ("bass_swap", None, 96, 16),
    ("filter_sweep", 32, 80, 32),
    ("echo_out", None, 96, 4),
    ("echo_out", 8, 96, 8),
    ("cut", None, 96, 0),
])
def test_each_style_starts_on_a_phrase_and_fits_before_the_end(style, bars, out_bar, length):
    p = planner.plan(_track(_row(124.0)), _track(_row(124.0), tid="2"), style=style, bars=bars)
    assert p["style"] == style and p["chosen_by"] == "yours"
    assert p["out"]["bar"] == out_bar and p["out"]["end_bar"] == out_bar + length <= 112
    assert p["bars"] == (length or None)
    phrase_bars = {ph["bar"] for ph in _track(_row(124.0))["phrases"]}
    assert p["out"]["bar"] in phrase_bars


def test_drop_swap_lands_the_next_drop_as_the_breakdown_ends():
    p = planner.plan(_track(_row(124.0)), _track(_row(124.0, first=0.1), tid="2"), style="drop_swap")
    assert p["style"] == "drop_swap" and p["bars"] == 16
    assert p["out"]["bar"] == 48  # the outgoing breakdown
    assert p["in"]["bar"] == 64 - 16 and p["in"]["how"] == "drop"  # 16 bars before its drop at 64
    assert p["in"]["start"] == pytest.approx(_bar(124.0, 0.1, 48), abs=1e-3)


def test_drop_swap_without_a_drop_is_listed_unavailable_and_falls_to_autos_pick():
    no_drop = [["intro", 0, 16, 0.9], ["main", 16, 48, 0.5], ["outro", 48, 64, 0.9]]
    incoming = _track(_row(124.0, sections=no_drop, mix_out=(48, 64, 0.9, "outro")), title="Brass Tide", tid="2")
    p = planner.plan(_track(_row(124.0)), incoming, style="drop_swap")
    styles = {s["style"]: s for s in p["styles"]}
    assert styles["drop_swap"]["available"] is False and styles["drop_swap"]["why"] == "no drop found in Brass Tide"
    assert styles["long_blend"]["available"] is True
    assert p["style"] == "long_blend" and p["requested"] == "drop_swap"
    assert p["why"].startswith("Drop swap: no drop found in Brass Tide, so long blend")


# ── falling back to a crossfade ──────────────────────────────────────────────

def test_a_blend_over_an_eight_percent_gap_crossfades_and_says_why():
    p = planner.plan(_track(_row(124.0)), _track(_row(136.0), tid="2"), style="long_blend")
    assert p["status"] == "crossfade" and p["style"] == "crossfade" and p["beatmatch"] is False
    assert p["fallback"] == {"kind": "crossfade", "code": "tempo_gap", "reason": "the tempos are 9.7% apart"}
    assert p["why"] == "Couldn't beat-match: the tempos are 9.7% apart"
    # it still starts at the outgoing outro
    assert p["out"]["start"] == pytest.approx(_bar(124.0, 0.5, 96), abs=1e-3)
    styles = {s["style"]: s for s in p["styles"]}
    assert styles["cut"]["available"] and styles["echo_out"]["available"]
    assert not styles["long_blend"]["available"]


def test_eight_percent_is_still_a_match_and_just_over_is_not():
    assert planner.plan(_track(_row(100.0)), _track(_row(107.9), tid="2"), style="short_blend")["status"] == "ok"
    assert planner.plan(_track(_row(100.0)), _track(_row(108.2), tid="2"),
                        style="short_blend")["status"] == "crossfade"


def test_a_low_confidence_grid_crossfades_with_the_tracks_name():
    p = planner.plan(_track(_row(124.0)), _track(_row(124.0, conf=0.35), title="Sand Script", tid="2"),
                     style="short_blend")
    assert p["status"] == "crossfade" and p["fallback"]["code"] == "low_confidence"
    assert p["fallback"]["reason"] == "Sand Script has no steady beat"
    # Auto echoes out instead: the outgoing grid is fine
    auto = planner.plan(_track(_row(124.0)), _track(_row(124.0, conf=0.35), title="Sand Script", tid="2"))
    assert auto["style"] == "echo_out" and auto["why"].endswith("Sand Script has no steady beat")


def test_an_outgoing_track_without_a_grid_always_crossfades():
    none_row = {"grid_version": GRID_VERSION, "status": "none", "reason": "no_beat", "beat_confidence": 0.1}
    p = planner.plan(_track(none_row, title="Ambient One", duration_s=200.0), _track(_row(124.0), tid="2"))
    assert p["status"] == "crossfade" and p["fallback"]["reason"] == "Ambient One has no steady beat"
    assert p["out"]["start"] == pytest.approx(194.0)  # 6 s before its end
    too_long = {"grid_version": GRID_VERSION, "status": "skipped", "reason": "too long to analyse"}
    q = planner.plan(_track(_row(124.0)), _track(too_long, title="A Mix", tid="2"), style="cut")
    assert q["status"] == "ok" and q["style"] == "cut"  # the outgoing grid is enough for a cut
    r = planner.plan(_track(_row(124.0)), _track(too_long, title="A Mix", tid="2"), style="long_blend")
    assert r["fallback"]["reason"] == "A Mix is too long to analyse"


def test_not_four_four_crossfades():
    p = planner.plan(_track(_row(150.0, meter="not_4_4", dconf=0.1), title="Sweet Waltz"),
                     _track(_row(150.0), tid="2"))
    assert p["status"] == "crossfade" and p["fallback"]["code"] == "not_4_4"
    assert p["fallback"]["reason"] == "Sweet Waltz isn't in 4/4"


def test_a_track_not_analysed_yet_waits():
    p = planner.plan(_track(_row(124.0)), _track(None, tid="2"))
    assert p["status"] == "waiting" and p["waiting_for"] == "to" and p["reason"] == "not_analyzed"
    stale = dict(_row(124.0), grid_version=GRID_VERSION - 1)
    assert planner.plan(_track(stale), _track(_row(124.0), tid="2"))["waiting_for"] == "from"
    analyzing = {"grid_version": GRID_VERSION, "status": "analyzing"}
    assert planner.plan(_track(_row(124.0)), _track(analyzing, tid="2"))["reason"] == "analyzing"


# ── the edges ────────────────────────────────────────────────────────────────

def test_an_uncertain_downbeat_still_plans_and_says_so():
    p = planner.plan(_track(_row(124.0, dconf=0.1)), _track(_row(124.0), tid="2"))
    assert p["status"] == "ok" and p["note"].startswith("Not sure where the bars start")
    assert p["confidence"] <= 0.1


def test_a_long_track_only_partly_analysed_is_planned_from_its_length():
    # 10 minutes analysed of a 12-minute track at 120 BPM (2 s a bar): no
    # outro is known, the phrases carry on to the end
    first = [["intro", 0, 16, 0.9], ["main", 16, 300, 0.5]]
    row = _row(120.0, first=0.0, sections=first, truncated=True, mix_out=None)
    p = planner.plan(_track(row, duration_s=720.0), _track(_row(120.0), tid="2"), style="short_blend")
    assert p["status"] == "ok" and p["out"]["end_bar"] <= 359
    assert p["out"]["bar"] == 344 and p["out"]["start"] == pytest.approx(688.0)
    assert p["note"].startswith("Only the first 10 minutes")
    assert p["out"]["confidence"] <= 0.4


def test_a_drifting_grid_puts_bars_on_its_beats():
    beats = [0.3 + i * 0.5 + (i * i) * 2e-5 for i in range(112 * 4 + 1)]  # slowly slowing
    p = planner.plan(_track(_row(120.0, beats=beats)), _track(_row(120.0), tid="2"), style="short_blend")
    assert p["out"]["start"] == pytest.approx(beats[104 * 4], abs=2e-3)
    assert p["out"]["end"] == pytest.approx(beats[112 * 4], abs=2e-3)


def test_a_pickup_bar_moves_the_in_point_back_onto_its_phrase():
    # its drums start a bar after its phrase (bar 1, the phrase at 0)
    p = planner.plan(_track(_row(124.0)), _track(_row(124.0, mix_in=(1, 16, 0.8, "intro")), tid="2"))
    assert p["in"]["bar"] == 0


def test_styles_and_lengths_are_checked():
    a, b = _track(_row(124.0)), _track(_row(124.0), tid="2")
    with pytest.raises(planner.PlanError):
        planner.plan(a, b, style="scratch")
    for bad in (3, 64, True, 0):
        with pytest.raises(planner.PlanError):
            planner.plan(a, b, style="short_blend", bars=bad)


def test_tempo_and_key_relations():
    assert planner.tempo_relation(None, 120) is None
    assert planner.tempo_relation(120, float("nan")) is None
    assert planner.tempo_relation(170, 87)["relation"] == "half"
    assert planner.tempo_relation(87, 172)["relation"] == "double"
    assert planner.key_relation("8A", "8B") == "relative"
    assert planner.key_relation("8A", "7A") == "down"
    assert planner.key_relation("Am", "Em") == "up"  # any spelling
    assert planner.key_relation("8A", "2B") == "clash"
    assert planner.key_relation(None, "8A") == "unknown"


def test_the_styles_match_the_sets_transitions():
    from core.sets.store import TRANSITION_BARS, TRANSITION_STYLES

    assert planner.STYLES == TRANSITION_STYLES
    assert planner.BARS == TRANSITION_BARS
