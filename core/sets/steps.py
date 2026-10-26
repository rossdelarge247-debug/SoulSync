"""The step from one track to the next in a set: Smooth, Jump or Not known
yet, with the reason in the Mixes panel's words ("8A → 9A, +2 BPM",
"relative major", "2 steps on the wheel: mix on a break").

The rules (board 22c): a step is a **jump** when the tempo moves more than
3 BPM or the key moves two or more steps round the Camelot wheel. One step
is ±1 on the wheel or the relative major/minor (the keys "Mixes well with"
already treats as compatible, ``core.dj.camelot.compatible_keys``); a
number and a letter together are two. Half and double time count as the
same tempo, as they do in "Mixes well with". A step whose BPM or key isn't
known on either side is **Not known yet**, never guessed as smooth.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Tuple

from core.dj.camelot import camelot_parts

#: a step is a jump when the tempo moves more than this many BPM
JUMP_BPM = 3.0
#: ... or the key moves this many steps round the wheel, or more
JUMP_STEPS = 2


def wheel_steps(a: str, b: str) -> Optional[int]:
    """Steps round the Camelot wheel from ``a`` to ``b``: 0 for the same key,
    1 for ±1 or the relative major/minor, 2 for ±1 and the other letter,
    and so on. None when either isn't a Camelot code."""
    pa, pb = camelot_parts(a), camelot_parts(b)
    if not pa or not pb:
        return None
    apart = abs(pa[0] - pb[0]) % 12
    apart = min(apart, 12 - apart)
    return apart + (0 if pa[1] == pb[1] else 1)


def tempo_step(a: float, b: float) -> Tuple[float, str]:
    """``(diff, how)``: the BPM change from ``a`` to ``b`` and whether it's
    at the ``same`` tempo or played ``double`` or ``half`` time (whichever
    lands closest)."""
    best = (b - a, "same")
    for factor, how in ((0.5, "half"), (2.0, "double")):
        diff = b * factor - a
        if abs(diff) < abs(best[0]) - 1e-9:
            best = (diff, how)
    return best


def bpm_words(diff: float, how: str) -> str:
    """"+2 BPM", "−1 BPM", "same BPM"; "double time" when it's played at
    double or half time."""
    if how == "half":
        return "half time"
    if how == "double":
        return "double time"
    rounded = int(round(diff))
    if rounded == 0:
        return "same BPM"
    return f"{'+' if rounded > 0 else '−'}{abs(rounded)} BPM"


def _num(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def step(left: Optional[Dict[str, Any]], right: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """The step from ``left`` to ``right`` (each a track's DJ data: ``bpm``
    and ``key``, as ``core.dj.store.public`` shapes it, or None).

    ``{"kind": "smooth" | "jump" | "unknown", "reason": str, "steps": n,
    "bpm_diff": d}``. ``reason`` never repeats the kind word; the page puts
    the word first."""
    left = left or {}
    right = right or {}
    a_bpm, b_bpm = _num(left.get("bpm")), _num(right.get("bpm"))
    a_key, b_key = left.get("key"), right.get("key")
    turns = wheel_steps(a_key, b_key) if a_key and b_key else None
    if a_bpm is None or b_bpm is None or turns is None:
        missing = []
        if a_bpm is None or b_bpm is None:
            missing.append("BPM")
        if turns is None:
            missing.append("key")
        return {"kind": "unknown", "reason": f"{' and '.join(missing)} not worked out yet",
                "steps": turns, "bpm_diff": None}
    diff, how = tempo_step(a_bpm, b_bpm)
    tempo = bpm_words(diff, how)
    keys = f"{a_key} → {b_key}"
    jump_key = turns >= JUMP_STEPS
    jump_bpm = abs(diff) > JUMP_BPM
    if jump_key:
        reason = f"{keys}, {tempo} · {turns} steps on the wheel: mix on a break"
    elif jump_bpm:
        reason = f"{keys}, {tempo}: mix on a break"
    else:
        reason = f"{keys}, {tempo}"
        if turns == 0:
            reason += " · same key"
        elif str(a_key)[-1] != str(b_key)[-1]:
            reason += " · relative major" if str(b_key).upper().endswith("B") else " · relative minor"
    return {"kind": "jump" if jump_key or jump_bpm else "smooth", "reason": reason, "steps": turns,
            "bpm_diff": round(diff, 1)}


def steps_between(djs: Iterable[Optional[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """The step after each track but the last."""
    rows = list(djs)
    return [step(rows[i], rows[i + 1]) for i in range(len(rows) - 1)]


def summary(rows: List[Dict[str, Any]], steps: List[Dict[str, Any]]) -> Dict[str, Any]:
    """The meta line's numbers: tracks, seconds, BPM range, smooth / jump /
    not known steps and locked rows. ``rows`` carry ``duration_ms``,
    ``dj`` and ``locked``."""
    bpms = [b for b in (_num((r.get("dj") or {}).get("bpm")) for r in rows) if b]
    seconds = sum(int(r.get("duration_ms") or 0) for r in rows) // 1000
    return {
        "tracks": len(rows),
        "seconds": seconds,
        "bpm_min": round(min(bpms)) if bpms else None,
        "bpm_max": round(max(bpms)) if bpms else None,
        "smooth": sum(1 for s in steps if s["kind"] == "smooth"),
        "jumps": sum(1 for s in steps if s["kind"] == "jump"),
        "unknown": sum(1 for s in steps if s["kind"] == "unknown"),
        "locked": sum(1 for r in rows if r.get("locked")),
    }


__all__ = ["JUMP_BPM", "JUMP_STEPS", "bpm_words", "step", "steps_between", "summary", "tempo_step",
           "wheel_steps"]
