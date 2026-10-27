"""The pair planner (auto-mix stage A): how one analysed track hands over to
the next. Pure code on two tracks' grids (core/dj/grid_store.public's shape),
no audio, so it's cheap enough to run for every pair in Up next.

For a pair and a style (26a's: long blend, short blend, bass swap, cut, echo
out, filter sweep, drop swap, or auto) and a length in bars, it works out:

* **where the outgoing track's mix starts:** a phrase boundary in its outro
  (its mix-out region), late enough that the mix ends where the outro does;
  echo out and cut go at the outro's first phrase; drop swap at the last
  breakdown;
* **where the incoming track starts:** its intro's first downbeat with
  steady drums (its mix-in region), or for drop swap the bar that lands its
  drop as the window ends;
* **the tempo ratio:** the incoming track's playback rate to match the
  outgoing one (half and double time count), and whether a plain speed
  change will do (within 3%) or it needs a time-stretch;
* **whether it can be beat-matched:** not over about an 8% gap, nor when
  either grid isn't confident (or isn't 4/4). Blends, bass swap, filter sweep
  and drop swap need it, and fall back to a crossfade with the reason; cut
  and echo out don't.

**Auto** follows BACKLOG and 26a: a compatible key (the same, ±1 on the
wheel or the relative major/minor) and a BPM within 3% give a long blend (32
bars); compatible within 8%, or a key nobody knows, a short blend (8); a key
clash a cut (both with steady drums) or else echo out; a gap over 8%, or a
grid that can't be trusted, echo out.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from core.dj.camelot import compatible_keys, parse_key
from core.dj.grid import Grid

STYLES = ("auto", "long_blend", "short_blend", "bass_swap", "cut", "echo_out", "filter_sweep", "drop_swap")
BARS = (2, 4, 8, 16, 32)
#: each style's length when none is chosen (cut has none: it's on the one)
DEFAULT_BARS = {"long_blend": 32, "short_blend": 8, "bass_swap": 16, "cut": 0, "echo_out": 4,
                "filter_sweep": 16, "drop_swap": 16}
#: the styles that play both tracks together, so the beats must line up
NEEDS_BEATMATCH = ("long_blend", "short_blend", "bass_swap", "filter_sweep", "drop_swap")
#: tempo gaps (fractions): past MAX_GAP no beat-match; within CLOSE_GAP a
#: long blend, and a plain speed change will do
MAX_GAP = 0.08
CLOSE_GAP = 0.03
#: below these the grid or the downbeat isn't trusted
BEAT_CONFIDENT = 0.5
DOWNBEAT_CONFIDENT = 0.3
#: a crossfade's length when there's nothing to line up (26h: 6 s)
CROSSFADE_S = 6.0

STYLE_WORDS = {"long_blend": "Long blend", "short_blend": "Short blend", "bass_swap": "Bass swap", "cut": "Cut",
               "echo_out": "Echo out", "filter_sweep": "Filter sweep", "drop_swap": "Drop swap",
               "crossfade": "Crossfade", "auto": "Auto"}


class PlanError(ValueError):
    """A style or length that isn't one."""


def _grid(track: Dict[str, Any]) -> Optional[Grid]:
    g = (track.get("grid") or {}) if track.get("analyzed") else {}
    if not g.get("period"):
        return None
    return Grid(kind=g.get("kind") or "constant", period=float(g["period"]), first_beat=float(g.get("first_beat") or 0),
                downbeat_index=int((track.get("downbeats") or {}).get("beat_index") or 0), beats=g.get("beats"))


def _name(track: Dict[str, Any], fallback: str) -> str:
    return str(track.get("title") or "").strip() or fallback


def tempo_relation(from_bpm: Optional[float], to_bpm: Optional[float]) -> Optional[Dict[str, Any]]:
    """How the incoming tempo sits against the outgoing one: ``{relation
    (same | half | double), gap (signed fraction after halving or doubling),
    rate (the incoming track's playback rate to match), speed_change_ok}``."""
    try:
        a, b = float(from_bpm), float(to_bpm)
    except (TypeError, ValueError):
        return None
    if not (a > 0 and b > 0 and math.isfinite(a) and math.isfinite(b)):
        return None
    best = None
    for relation, factor in (("same", 1.0), ("half", 2.0), ("double", 0.5)):
        eff = b * factor
        gap = (eff - a) / a
        if best is None or abs(gap) < abs(best[1]):
            best = (relation, gap, eff)
    relation, gap, eff = best
    return {"relation": relation, "gap": gap, "gap_pct": round(gap * 100, 1), "rate": round(a / eff, 5),
            "speed_change_ok": abs(gap) <= CLOSE_GAP}


def key_relation(from_key: Optional[str], to_key: Optional[str]) -> str:
    """``same``, ``up``, ``down``, ``relative`` (they mix), ``clash``, or
    ``unknown`` when either isn't known."""
    a, b = parse_key(from_key) if from_key else None, parse_key(to_key) if to_key else None
    if not a or not b:
        return "unknown"
    return compatible_keys(a["camelot"]).get(b["camelot"], "clash")


def _trust(track: Dict[str, Any], name: str) -> Optional[Tuple[str, str]]:
    """Why this track's grid can't be beat-matched, or None."""
    if not track.get("analyzed"):
        return None
    grid = track.get("grid") or {}
    down = track.get("downbeats") or {}
    if float(grid.get("confidence") or 0) < BEAT_CONFIDENT:
        return "low_confidence", f"{name} has no steady beat"
    if down.get("meter") not in (None, "4/4"):
        return "not_4_4", f"{name} isn't in 4/4"
    return None


_NO_GRID_WORDS = {"too_long": "is too long to analyse", "unreachable": "can't be opened",
                  "error": "couldn't be analysed"}


def _no_grid(track: Dict[str, Any], name: str) -> Tuple[str, str]:
    """Why an analysed track has no grid, as the fallback's code and words."""
    reason = track.get("reason") or "no_beat"
    words = _NO_GRID_WORDS.get(reason, "has no steady beat")
    return ("no_beat" if reason in ("no_beat", "too_short") else reason), f"{name} {words}"


def _phrase_bars(track: Dict[str, Any], grid: Grid, end_bar: int) -> List[Tuple[int, int]]:
    """``[(bar, level)]``: the phrases, carried on every 8 bars past the
    analysed part (a track over 10 minutes) up to ``end_bar``."""
    out = [(int(p["bar"]), int(p.get("level") or 8)) for p in track.get("phrases") or []]
    if not out:
        out = [(0, 32)]
    last_anchor = max((p["bar"] for p in track.get("phrases") or [] if p.get("section")), default=out[0][0])
    bar = out[-1][0] + 8
    while bar <= end_bar:
        k = bar - last_anchor
        out.append((bar, 32 if k % 32 == 0 else 16 if k % 16 == 0 else 8))
        bar += 8
    return out


def _end_bar(track: Dict[str, Any], grid: Grid) -> Tuple[int, bool]:
    """The last bar the outgoing track can mix through, and whether it's
    known (False: past the analysed part, from the track's length)."""
    region = track.get("mix_out")
    if region and not track.get("truncated"):
        return int(region["end_bar"]), True
    duration = track.get("duration_s")
    if duration:
        return int(math.floor(grid.bar_at(float(duration) - 0.05))), False
    return int(track.get("bars") or 0), not track.get("truncated")


def _first_section(track: Dict[str, Any], kind: str, last: bool = False) -> Optional[Dict[str, Any]]:
    found = [s for s in track.get("sections") or [] if s.get("kind") == kind]
    if not found:
        return None
    return found[-1] if last else found[0]


def _out_point(track: Dict[str, Any], grid: Grid, style: str, bars: int) -> Dict[str, Any]:
    """Where the outgoing track's mix starts: a phrase boundary."""
    end_bar, known = _end_bar(track, grid)
    phrases = _phrase_bars(track, grid, end_bar)
    region = track.get("mix_out")
    region_start = int(region["start_bar"]) if region and known else None
    if style == "drop_swap":
        breakdown = _first_section(track, "breakdown", last=True)
        bar = int(breakdown["start_bar"]) if breakdown else None
        level = next((lv for b, lv in phrases if b == bar), 8)
        if bar is not None:
            return {"bar": bar, "level": level, "in_outro": False, "known": True,
                    "confidence": float(breakdown.get("confidence") or 0.5)}
    fits = [(b, lv) for b, lv in phrases if b + bars <= end_bar]
    if not fits:
        fits = [(max(0, end_bar - max(bars, 1)), 8)]
    if style in ("cut", "echo_out") and region_start is not None:
        # on the outro's first phrase: the outgoing track's own ending is skipped
        at_or_after = [(b, lv) for b, lv in fits if b >= region_start]
        bar, level = at_or_after[0] if at_or_after else fits[-1]
    else:
        # the latest phrase that still fits: the mix ends where the outro does
        bar, level = fits[-1]
    in_outro = region_start is not None and bar >= region_start
    confidence = float(region["confidence"]) if (region and in_outro) else 0.3
    if not known:
        confidence = min(confidence, 0.4)
    return {"bar": int(bar), "level": int(level), "in_outro": bool(in_outro), "known": known,
            "confidence": round(confidence, 2)}


def _in_point(track: Dict[str, Any], grid: Grid, style: str, bars: int) -> Dict[str, Any]:
    """Where the incoming track starts: its intro's first downbeat with steady
    drums, moved back onto its phrase when that's a bar or two before; for
    drop swap, ``bars`` before its drop."""
    region = track.get("mix_in") or {}
    if style == "drop_swap":
        drop = _first_section(track, "drop")
        if drop:
            bar = max(0, int(drop["start_bar"]) - bars)
            return {"bar": bar, "how": "drop", "confidence": float(drop.get("confidence") or 0.5)}
    bar = int(region.get("start_bar") or 0)
    phrases = sorted(int(p["bar"]) for p in track.get("phrases") or [])
    before = [b for b in phrases if b <= bar]
    if before and bar - before[-1] <= 2:
        bar = before[-1]
    return {"bar": bar, "how": region.get("how") or "start", "confidence": float(region.get("confidence") or 0.2)}


def _availability(out_t, in_t, beat_ok: Optional[Tuple[str, str]]) -> Dict[str, Optional[str]]:
    """Each style: None when the pair can do it, else why not (26a's picker
    lists it disabled with this)."""
    why: Dict[str, Optional[str]] = {}
    out_name, in_name = _name(out_t, "this track"), _name(in_t, "the next track")
    for style in STYLES[1:]:
        reason = None
        if style in NEEDS_BEATMATCH and beat_ok is not None:
            reason = beat_ok[1]
        if style == "drop_swap" and reason is None:
            if not _first_section(in_t, "drop"):
                reason = f"no drop found in {in_name}"
            elif not _first_section(out_t, "breakdown"):
                reason = f"no breakdown found in {out_name}"
        why[style] = reason
    return why


def _auto(tempo: Optional[Dict[str, Any]], key: str, in_problem, in_t) -> Tuple[str, str]:
    """Auto's style for a pair whose outgoing grid can be trusted, and its
    reason (BACKLOG, 26a)."""
    if in_problem is not None:
        return "echo_out", in_problem[1]
    gap = abs(tempo["gap"]) if tempo else 1.0
    if gap > MAX_GAP:
        return "echo_out", "the tempos are too far apart to beat-match"
    if key == "clash":
        drums = (in_t.get("mix_in") or {}).get("how") in ("intro", "beat_only")
        return ("cut", "the keys clash") if drums else ("echo_out", "the keys clash")
    if key == "unknown":
        return "short_blend", "a key isn't known yet"
    if gap <= CLOSE_GAP:
        return "long_blend", "the keys mix and the tempo is close"
    return "short_blend", "the keys mix; the tempo needs stretching"


def _pair_words(out_t, in_t, tempo) -> str:
    """"9A → 4B, +1 BPM" (Sets' step words)."""
    keys = f"{out_t.get('key') or '?'} → {in_t.get('key') or '?'}"
    if tempo and out_t.get("bpm") and in_t.get("bpm"):
        diff = round(float(in_t["bpm"]) * {"same": 1, "half": 2, "double": 0.5}[tempo["relation"]] - float(out_t["bpm"]))
        return f"{keys}, {'+' if diff >= 0 else '−'}{abs(diff)} BPM"
    return keys


def _crossfade(out_t, in_t, code: str, reason: str, base: Dict[str, Any]) -> Dict[str, Any]:
    """A plain crossfade: no beats to line up. It starts at the outgoing
    track's outro when one is known, else 6 s before its end."""
    start = None
    region = out_t.get("mix_out") if out_t.get("analyzed") else None
    if region and not out_t.get("truncated"):
        start = float(region["start"])
    elif out_t.get("duration_s"):
        start = max(0.0, float(out_t["duration_s"]) - CROSSFADE_S)
    in_start = 0.0
    if in_t.get("analyzed") and in_t.get("mix_in"):
        in_start = float(in_t["mix_in"]["start"])
    return {**base, "status": "crossfade", "style": "crossfade", "bars": None, "beatmatch": False,
            "why": f"Couldn't beat-match: {reason}", "fallback": {"kind": "crossfade", "code": code, "reason": reason},
            "out": {"start": round(start, 3) if start is not None else None, "bar": None, "end": None,
                    "in_outro": bool(region), "confidence": 0.3},
            "in": {"start": round(in_start, 3), "bar": None, "how": "crossfade", "confidence": 0.3},
            "length_s": CROSSFADE_S, "confidence": 0.3}


def plan(out_t: Dict[str, Any], in_t: Dict[str, Any], *, style: str = "auto",
         bars: Optional[int] = None) -> Dict[str, Any]:
    """The handover from ``out_t`` to ``in_t``. Each track is its public
    grid (core/dj/grid_store.public) plus ``bpm``, ``key``, ``duration_s``
    and ``title`` (any may be missing). Raises PlanError for a style or
    length that isn't one."""
    if style not in STYLES:
        raise PlanError("style must be one of " + ", ".join(STYLES))
    if bars is not None and (isinstance(bars, bool) or bars not in BARS):
        raise PlanError("bars must be 2, 4, 8, 16 or 32")
    out_name, in_name = _name(out_t, "This track"), _name(in_t, "The next track")
    out_bpm = out_t.get("bpm") or out_t.get("dj_bpm")
    in_bpm = in_t.get("bpm") or in_t.get("dj_bpm")
    tempo = tempo_relation(out_bpm, in_bpm)
    key = key_relation(out_t.get("key"), in_t.get("key"))
    base: Dict[str, Any] = {
        "requested": style, "chosen_by": "auto" if style == "auto" else "yours",
        "tempo": ({"from_bpm": out_bpm, "to_bpm": in_bpm, "relation": tempo["relation"],
                   "gap_pct": tempo["gap_pct"], "rate": tempo["rate"], "speed_change_ok": tempo["speed_change_ok"]}
                  if tempo else None),
        "key": {"from": out_t.get("key"), "to": in_t.get("key"), "relation": key},
        "pair": _pair_words(out_t, in_t, tempo),
    }
    for track, which in ((out_t, "from"), (in_t, "to")):
        if not track.get("analyzed") and track.get("reason") in (None, "not_analyzed", "analyzing"):
            return {**base, "status": "waiting", "style": None, "waiting_for": which,
                    "reason": track.get("reason") or "not_analyzed", "why": "Waiting for the analysis",
                    "styles": []}
    out_grid, in_grid = _grid(out_t), _grid(in_t)
    # what stands in the way: a grid that can't be trusted (either track), a
    # tempo gap too wide; the styles that play both tracks need neither
    out_problem = _no_grid(out_t, out_name) if out_grid is None else _trust(out_t, out_name)
    in_problem = _no_grid(in_t, in_name) if in_grid is None else _trust(in_t, in_name)
    tempo_problem = None
    if tempo is None or abs(tempo["gap"]) > MAX_GAP:
        tempo_problem = ("tempo_gap", f"the tempos are {abs(tempo['gap_pct']):g}% apart" if tempo
                         else "a tempo isn't known")
    beat_ok = out_problem or in_problem or tempo_problem
    available = _availability(out_t, in_t, beat_ok)
    base["styles"] = [{"style": s, "label": STYLE_WORDS[s], "available": available[s] is None,
                       "why": available[s]} for s in STYLES[1:]]
    if out_problem is not None:
        # nowhere to put the one: whatever the style, a plain crossfade
        return _crossfade(out_t, in_t, out_problem[0], out_problem[1], base)
    if style == "auto":
        chosen, why = _auto(tempo, key, in_problem, in_t)
        why = f"{base['pair']}: {why}"
    else:
        chosen, why = style, None
        if available[style] is not None:
            if style in NEEDS_BEATMATCH and beat_ok is not None:
                return _crossfade(out_t, in_t, beat_ok[0], beat_ok[1], base)
            # a drop swap without a drop: Auto's choice instead, saying why
            chosen, auto_why = _auto(tempo, key, in_problem, in_t)
            why = f"{STYLE_WORDS[style]}: {available[style]}, so {STYLE_WORDS[chosen].lower()} ({auto_why})"
    length = 0 if chosen == "cut" else (bars if (bars and style != "auto") else DEFAULT_BARS[chosen])
    out_pt = _out_point(out_t, out_grid, chosen, length)
    if in_grid is not None:
        in_pt = _in_point(in_t, in_grid, chosen, max(length, 1))
        in_start = in_grid.bar(in_pt["bar"])
    else:
        in_pt, in_start = {"bar": None, "how": "start", "confidence": 0.2}, 0.0
    start = out_grid.bar(out_pt["bar"])
    end = out_grid.bar(out_pt["bar"] + length)
    beatmatch = beat_ok is None and chosen in NEEDS_BEATMATCH
    down_conf = min(float((out_t.get("downbeats") or {}).get("confidence") or 0),
                    float((in_t.get("downbeats") or {}).get("confidence") or 0) if in_grid else 1.0)
    beat_conf = min(float((out_t.get("grid") or {}).get("confidence") or 0),
                    float((in_t.get("grid") or {}).get("confidence") or 0) if in_grid else 1.0)
    confidence = round(min(beat_conf, max(down_conf, 0.1) if beatmatch else 1.0, out_pt["confidence"] + 0.3,
                           in_pt["confidence"] + 0.3, 1.0), 2)
    note = None
    if beatmatch and down_conf < DOWNBEAT_CONFIDENT:
        note = "Not sure where the bars start: the phrases may not line up."
    elif not out_pt["known"]:
        note = f"Only the first 10 minutes of {out_name} were analysed: its ending is estimated."
    return {**base, "status": "ok", "style": chosen, "label": STYLE_WORDS[chosen], "bars": length or None,
            "beatmatch": beatmatch, "why": why, "fallback": None, "note": note,
            "out": {"start": round(start, 3), "end": round(end, 3), "bar": out_pt["bar"],
                    "end_bar": out_pt["bar"] + length, "phrase_level": out_pt["level"],
                    "in_outro": out_pt["in_outro"], "confidence": out_pt["confidence"]},
            "in": {"start": round(in_start, 3), "bar": in_pt["bar"], "how": in_pt["how"],
                   "confidence": round(in_pt["confidence"], 2)},
            "length_s": round(end - start, 3), "confidence": confidence}


__all__ = ["BARS", "CLOSE_GAP", "DEFAULT_BARS", "MAX_GAP", "NEEDS_BEATMATCH", "PlanError", "STYLES", "key_relation",
           "plan", "tempo_relation"]
