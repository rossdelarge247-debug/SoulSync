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
  and drop swap need it; cut and echo out don't.

**No crossfade** (Ross, 27 October: "we either mix auto or manual or
nothing"). When a pair can't be beat-matched the plan takes Design's 302
move, the one rule (HANDOFF "Dev, step 2 … of 28 October"), on what each
track's grid can be trusted with (``ready to mix``: core/dj/grid.py
``beatmatch_problem``):

* the outgoing track is ready to mix: **a cut on its last phrase**
  (``status: cut``): the last phrase line at or before the end of its
  mix-out region; the player starts the next track from its start there.
  An outgoing track whose ending wasn't analysed (only its first 10
  minutes) plays on instead: its last phrase would be counted on an
  estimated grid;
* only the incoming track is ready to mix (the outgoing one has no beat
  found, too short, a beat not steady enough, a BPM set by hand its grid
  doesn't match): **an echo out into it** (``status: ok``, ``style:
  echo_out``, ``out.bar: None``), placed by time a second before the
  outgoing track's end, never by bar count; the incoming track comes in on
  its own first downbeat;
* neither, a track not in 4/4 on either side (304), an outgoing track too
  long to analyse, unreadable or missing, or a length not known: **plays
  straight on** (``status: play_on``): the outgoing track plays to its end
  and the next one starts, as with no transition.

Nothing without a reliable grid is ever cut by counting bars at a BPM (the
review's M4: that cut ambient and classical endings early). One album's
tracks in their order (the same album, the next track number) play on too,
so an album stays gapless; that's not a failure and has no fallback words.
A style that needs no beat-match (cut, echo out) chosen by a person keeps
its style while the outgoing track is ready to mix. ``fallback`` keeps the
move and the short reason (``{kind: cut | echo_out | play_on, code,
reason}``); the browser says it in Design's words ("Couldn't beat-match:
cutting on the phrase · the tempos are 9.7% apart"); nothing says
"crossfade".

A long blend whose bars don't fit before the outgoing track's outro ends
becomes a short blend of 8 bars, saying so (``shortened: "the outro is
short"``; 303). An unsure "one" keeps its style, with ``unsure_bars`` and the
note (304).

**Auto** follows BACKLOG and 26a: a compatible key (the same, ±1 on the
wheel or the relative major/minor) and a BPM within 3% give a long blend (32
bars); compatible within 8%, or a key nobody knows, a short blend (8); a key
clash a cut (both with steady drums) or else echo out; a pair that can't be
beat-matched (a gap over 8%, a grid that can't be trusted), 302's move.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

from core.dj.camelot import compatible_keys, parse_key
from core.dj.grid import BEAT_CONFIDENT as _GRID_BEAT_CONFIDENT
from core.dj.grid import Grid, beatmatch_problem

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
#: below these the grid or the downbeat isn't trusted (the beat's rule is
#: core/dj/grid.py's, shared with "ready to mix")
BEAT_CONFIDENT = _GRID_BEAT_CONFIDENT
DOWNBEAT_CONFIDENT = 0.3

STYLE_WORDS = {"long_blend": "Long blend", "short_blend": "Short blend", "bass_swap": "Bass swap", "cut": "Cut",
               "echo_out": "Echo out", "filter_sweep": "Filter sweep", "drop_swap": "Drop swap",
               "auto": "Auto"}


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
    problem = beatmatch_problem(grid.get("confidence"), down.get("meter"))
    if problem == "low_confidence":
        return "low_confidence", f"{name} has no steady beat"
    if problem == "not_4_4":
        return "not_4_4", f"{name} isn't in 4/4"
    return None


_NO_GRID_WORDS = {"too_long": "is too long to analyse", "unreachable": "can't be opened",
                  "error": "couldn't be analysed",
                  "bpm_mismatch": "has a BPM set by hand that its beat grid doesn't match"}


def _no_grid(track: Dict[str, Any], name: str) -> Tuple[str, str]:
    """Why an analysed track has no grid, as the fallback's code and words."""
    reason = track.get("reason") or "no_beat"
    words = _NO_GRID_WORDS.get(reason, "has no steady beat")
    return ("no_beat" if reason in ("no_beat", "too_short") else reason), f"{name} {words}"


class _Phrases:
    """A track's phrases as ``(bar, level)``: the stored ones (at most a few
    dozen: they cover the analysed 10 minutes), carried on every 8 bars from
    the last section change past them. The carried-on ones are worked out by
    arithmetic, never listed, so a track's stated length costs nothing."""

    def __init__(self, track: Dict[str, Any]) -> None:
        stored = sorted((int(p["bar"]), int(p.get("level") or 8)) for p in track.get("phrases") or [])
        self.stored = stored or [(0, 32)]
        self.anchor = max((int(p["bar"]) for p in track.get("phrases") or [] if p.get("section")),
                          default=self.stored[0][0])
        self.last = self.stored[-1][0]

    def level(self, bar: int) -> int:
        for b, lv in self.stored:
            if b == bar:
                return lv
        k = bar - self.anchor
        return 32 if k % 32 == 0 else 16 if k % 16 == 0 else 8

    def latest(self, limit: int) -> Optional[Tuple[int, int]]:
        """The last phrase at or before bar ``limit``."""
        if limit > self.last:
            bar = self.anchor + 8 * ((limit - self.anchor) // 8)
            if bar > self.last:
                return bar, self.level(bar)
        found = [p for p in self.stored if p[0] <= limit]
        return found[-1] if found else None

    def first(self, start: int, limit: int) -> Optional[Tuple[int, int]]:
        """The first phrase from bar ``start`` to bar ``limit``."""
        found = [p for p in self.stored if start <= p[0] <= limit]
        if found:
            return found[0]
        low = max(start, self.last + 1)
        bar = self.anchor + 8 * (-((self.anchor - low) // 8))  # the first on the 8-bar line at or after low
        return (bar, self.level(bar)) if bar <= limit else None


#: a track longer than this is never analysed (core/dj/worker.py MAX_SECONDS:
#: "too long to analyse"), so a stated length past it isn't believed
MAX_TRACK_SECONDS = 30 * 60.0


def _length(track: Dict[str, Any]) -> Optional[float]:
    """The track's length in seconds, as far as it can be believed: the
    library's ``tracks.duration`` is whatever the file or server said, so it
    is kept to MAX_TRACK_SECONDS, and to the analysed length (plus a
    second) when the whole track was analysed."""
    try:
        duration = float(track.get("duration_s") or 0)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(duration) or duration <= 0:
        return None
    duration = min(duration, MAX_TRACK_SECONDS)
    analysed = track.get("analysed_s")
    if analysed and not track.get("truncated"):
        try:
            duration = min(duration, float(analysed) + 1.0)
        except (TypeError, ValueError):
            pass
    return duration


def _end_bar(track: Dict[str, Any], grid: Grid) -> Tuple[int, bool]:
    """The last bar the outgoing track can mix through, and whether it's
    known (False: past the analysed part, from the track's length)."""
    region = track.get("mix_out")
    if region and not track.get("truncated"):
        return int(region["end_bar"]), True
    duration = _length(track)
    if duration:
        return int(math.floor(grid.bar_at(duration - 0.05))), False
    return int(track.get("bars") or 0), not track.get("truncated")


def _first_section(track: Dict[str, Any], kind: str, last: bool = False) -> Optional[Dict[str, Any]]:
    found = [s for s in track.get("sections") or [] if s.get("kind") == kind]
    if not found:
        return None
    return found[-1] if last else found[0]


def _out_point(track: Dict[str, Any], grid: Grid, style: str, bars: int) -> Dict[str, Any]:
    """Where the outgoing track's mix starts: a phrase boundary."""
    end_bar, known = _end_bar(track, grid)
    phrases = _Phrases(track)
    region = track.get("mix_out")
    region_start = int(region["start_bar"]) if region and known else None
    if style == "drop_swap":
        breakdown = _first_section(track, "breakdown", last=True)
        if breakdown is not None:
            bar = int(breakdown["start_bar"])
            return {"bar": bar, "level": phrases.level(bar), "in_outro": False, "known": True,
                    "confidence": float(breakdown.get("confidence") or 0.5)}
    limit = end_bar - bars  # the last bar a window of ``bars`` can start on
    latest = phrases.latest(limit)
    if latest is None:
        latest = (max(0, end_bar - max(bars, 1)), 8)
    bar, level = latest
    if style in ("cut", "echo_out") and region_start is not None:
        # on the outro's first phrase: the outgoing track's own ending is skipped
        first = phrases.first(region_start, limit)
        if first is not None:
            bar, level = first
    in_outro = region_start is not None and bar >= region_start
    # the window reaches into the outro (a long blend starts before it and
    # ends with it): the outro's confidence; a window that never does, less
    reaches = region_start is not None and bar + max(bars, 1) > region_start
    confidence = float(region["confidence"]) if reaches else 0.3
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


def _auto(tempo: Optional[Dict[str, Any]], key: str, in_t) -> Tuple[str, str]:
    """Auto's style for a pair that can be beat-matched, and its reason
    (BACKLOG, 26a). A pair that can't takes 302's move (``_fallback``)."""
    gap = abs(tempo["gap"]) if tempo else 1.0
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


#: Design's 302 moves, as the sentence's middle ("Couldn't beat-match:
#: cutting on the phrase · the tempos are 9.7% apart")
MOVE_WORDS = {"cut": "cutting on the phrase", "echo_out": "echo out", "play_on": "plays straight on"}

#: an outgoing track with no grid to trust for these can still be echoed
#: out by time into a ready incoming one; the rest (too long to analyse,
#: unreadable, missing) play straight on: the decks couldn't read them either
_ECHO_CODES = ("no_beat", "low_confidence", "bpm_mismatch")
#: the echo out without a grid going out starts this long before its end
ECHO_END_S = 1.0


def _couldnt(kind: str, reason: str) -> str:
    return f"Couldn't beat-match: {MOVE_WORDS[kind]} · {reason}"


def _play_on(code: str, reason: str, base: Dict[str, Any], *, failed: bool = True) -> Dict[str, Any]:
    """No transition: the outgoing track plays to its end and the next one
    starts. Never a crossfade, and never a cut by bar count. ``failed``:
    302's "plays straight on" (a pair that couldn't be beat-matched), not
    an album played in its order."""
    why = _couldnt("play_on", reason) if failed else f"Plays straight on: {reason}"
    return {**base, "status": "play_on", "style": None, "bars": None, "beatmatch": False,
            "why": why, "fallback": {"kind": "play_on", "code": code, "reason": reason},
            "note": None, "length_s": 0.0, "confidence": 0.0}


def _fallback(out_t: Dict[str, Any], in_t: Dict[str, Any], out_grid: Optional[Grid], in_grid: Optional[Grid],
              out_problem, in_problem, tempo_problem, base: Dict[str, Any]) -> Dict[str, Any]:
    """Design's 302, the one rule for a pair that can't be beat-matched: the
    outgoing track ready to mix, a cut on its last phrase; only the incoming
    one, an echo out into it; neither, straight on. Not 4/4 on either side
    plays straight on (304)."""
    out_name = _name(out_t, "This track")
    for problem in (out_problem, in_problem):
        if problem is not None and problem[0] == "not_4_4":
            return _play_on(problem[0], problem[1], base)
    if out_problem is None and out_grid is not None:
        code, reason = in_problem or tempo_problem or ("tempo_gap", "a tempo isn't known")
        end_bar, known = _end_bar(out_t, out_grid)
        last = _Phrases(out_t).latest(end_bar) if known else None
        if last is None or last[0] <= 0:
            # its ending wasn't analysed: no phrase there to trust
            return _play_on("end_not_analysed", f"the end of {out_name} wasn't analysed", base)
        bar, level = last
        start = round(out_grid.bar(bar), 3)
        region = out_t.get("mix_out") or {}
        return {**base, "status": "cut", "style": "cut", "label": STYLE_WORDS["cut"], "bars": None,
                "beatmatch": False, "why": _couldnt("cut", reason),
                "fallback": {"kind": "cut", "code": code, "reason": reason}, "note": None,
                "out": {"start": start, "end": start, "bar": int(bar), "end_bar": int(bar), "phrase_level": int(level),
                        "in_outro": bool(region) and bar >= int(region.get("start_bar") or 0),
                        "confidence": round(float(region.get("confidence") or 0.5), 2)},
                # the player starts the next track from its start (no decks)
                "in": {"start": 0.0, "bar": None, "how": "start", "confidence": 0.2},
                "length_s": 0.0, "confidence": 0.5}
    if out_problem is not None and out_problem[0] in _ECHO_CODES and in_grid is not None and in_problem is None:
        length = _length(out_t)
        if length and length > ECHO_END_S + 4:
            in_pt = _in_point(in_t, in_grid, "echo_out", DEFAULT_BARS["echo_out"])
            start = round(length - ECHO_END_S, 3)
            return {**base, "status": "ok", "style": "echo_out", "label": STYLE_WORDS["echo_out"],
                    "bars": DEFAULT_BARS["echo_out"], "beatmatch": False, "why": _couldnt("echo_out", out_problem[1]),
                    "fallback": {"kind": "echo_out", "code": out_problem[0], "reason": out_problem[1]},
                    "note": None,
                    # by time, at the outgoing track's end: never a bar counted on a grid it hasn't got
                    "out": {"start": start, "end": start, "bar": None, "end_bar": None, "phrase_level": None,
                            "in_outro": True, "confidence": 0.3},
                    "in": {"start": round(in_grid.bar(in_pt["bar"]), 3), "bar": in_pt["bar"], "how": in_pt["how"],
                           "confidence": round(in_pt["confidence"], 2)},
                    "length_s": 0.0, "confidence": 0.3}
    code, reason = out_problem or in_problem or tempo_problem
    return _play_on(code, reason, base)


def _album_in_order(out_t: Dict[str, Any], in_t: Dict[str, Any]) -> bool:
    """One album's tracks one after the other in its own order: track n into
    n + 1 on the same disc, or a disc's last track into the next disc's first
    (a disc not known is disc 1)."""
    a, b = out_t.get("album_id"), in_t.get("album_id")
    if a in (None, "") or str(a) != str(b if b is not None else ""):
        return False
    try:
        n, m = int(out_t.get("track_number")), int(in_t.get("track_number"))
        d = int(out_t.get("disc_number") or 1)
        e = int(in_t.get("disc_number") or 1)
    except (TypeError, ValueError):
        return False
    if n <= 0:
        return False
    if d == e:
        return m == n + 1
    if e != d + 1 or m != 1:
        return False
    try:
        last = int(out_t.get("disc_last"))
    except (TypeError, ValueError):
        return False
    return n == last


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
    if _album_in_order(out_t, in_t):
        # an album played in its order stays gapless: no transition at all
        return {**_play_on("album_in_order", "one album's tracks in their order", base, failed=False),
                "styles": []}
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
    fallback = None
    shortened = None
    if beat_ok is not None and (style == "auto" or style in NEEDS_BEATMATCH or out_problem is not None):
        # a pair that can't be beat-matched: Design's 302 move (a cut on the
        # outgoing track's last phrase, an echo out into the incoming one, or
        # straight on); a person's cut or echo out stays theirs while the
        # outgoing track is ready to mix
        return _fallback(out_t, in_t, out_grid, in_grid, out_problem, in_problem, tempo_problem, base)
    if style == "auto":
        chosen, why = _auto(tempo, key, in_t)
        why = f"{base['pair']}: {why}"
    else:
        chosen, why = style, None
        if available[style] is not None:
            # a drop swap without a drop: Auto's choice instead, saying why
            chosen, auto_why = _auto(tempo, key, in_t)
            why = f"{STYLE_WORDS[style]}: {available[style]}, so {STYLE_WORDS[chosen].lower()} ({auto_why})"
    length = 0 if chosen == "cut" else (bars if (bars and style == chosen) else DEFAULT_BARS[chosen])
    if chosen == "long_blend" and length > DEFAULT_BARS["short_blend"]:
        # 303: a long blend starts on the latest phrase that leaves its bars
        # before the outro ends ("both fine"); where they don't fit before
        # it (a short track), it becomes a short blend and says so, rather
        # than shrinking in silence
        end_bar, _ = _end_bar(out_t, out_grid)
        if end_bar - length < 0 or _Phrases(out_t).latest(end_bar - length) is None:
            chosen, length = "short_blend", DEFAULT_BARS["short_blend"]
            shortened = "the outro is short"
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
    unsure = bool(beatmatch and down_conf < DOWNBEAT_CONFIDENT)
    if unsure:
        # 304: it keeps its style; the chip shows the warning dot and this
        note = "Not sure where the bars start: the phrases may not line up."
    elif not out_pt["known"]:
        note = f"Only the first 10 minutes of {out_name} were analysed: its ending is estimated."
    return {**base, "status": "ok", "style": chosen, "label": STYLE_WORDS[chosen], "bars": length or None,
            "beatmatch": beatmatch, "why": why, "fallback": fallback, "note": note,
            "shortened": shortened, "unsure_bars": unsure,
            "out": {"start": round(start, 3), "end": round(end, 3), "bar": out_pt["bar"],
                    "end_bar": out_pt["bar"] + length, "phrase_level": out_pt["level"],
                    "in_outro": out_pt["in_outro"], "confidence": out_pt["confidence"]},
            "in": {"start": round(in_start, 3), "bar": in_pt["bar"], "how": in_pt["how"],
                   "confidence": round(in_pt["confidence"], 2)},
            "length_s": round(end - start, 3), "confidence": confidence}


__all__ = ["BARS", "CLOSE_GAP", "DEFAULT_BARS", "MAX_GAP", "MOVE_WORDS", "NEEDS_BEATMATCH", "PlanError", "STYLES",
           "key_relation", "plan", "tempo_relation"]
