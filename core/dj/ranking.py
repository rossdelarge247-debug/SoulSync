"""The Mix tab's order for "Mixes well with" (BACKLOG "Star tracks and mix
sets", "The expanded player's Mix tab"; board 29a). All code, no AI.

``core.dj.store.mixes_with`` finds what mixes (the key rule and the tempo
window) and orders it by key, then tempo. The Mix tab asks for a few more
things, each a small push up or down from that order, so harmonic fit still
leads and the others decide among near-equals:

- **the working set** (``set_id``): its tracks are left out, and the energy
  of its last few tracks says which way it's heading; a match that keeps
  going that way moves up, one that turns back moves down;
- **a starred boost**: the caller's starred tracks move up a little
  ("starred first among equals", 29a's foot);
- **not played recently**: a track the caller's listening history has in
  the last two days moves well down, in the last week a little;
- **style closeness**: the genres the two tracks' artists and albums share
  (as a share of all their genres), and the same artist, move a match up.

Each match keeps the store's fields and gains ``reason`` ("Same key · +2%
BPM · energy ↑1", the step's words), ``reason_short`` (the phone's line,
29c) and ``signals`` (what moved it). Nothing here is sent anywhere.
"""

from __future__ import annotations

import json
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set

from core.dj import store as dj_store
from utils.logging_config import get_logger

logger = get_logger("dj.ranking")

#: how many matches the tab shows (29a)
TAB_LIMIT = 5
#: the most the route ranks and returns
MAX_LIMIT = 50
#: "Widen the search" (29d): this tempo window, and any key
WIDE_TOLERANCE = 0.10

#: the pushes, in the store's order units (one key-rank step is 10)
STARRED_BOOST = 4.0
PLAYED_TODAY = 8.0       # played in the last two days
PLAYED_THIS_WEEK = 3.0   # in the last seven
STYLE_WEIGHT = 5.0       # times the share of genres in common
SAME_ARTIST = 1.0
WITH_THE_SET = 3.0       # energy keeps going the set's way
AGAINST_THE_SET = 3.0    # ... or turns back (plus one per step)

RECENT_DAYS = 7
TODAY_DAYS = 2

_KEY_RANK = {"same": 0, "relative": 1, "up": 2, "down": 2, "other": 3}
_BPM_RANK = {"same": 0, "half": 1, "double": 1}


# ── words ─────────────────────────────────────────────────────────────────────

def _pct(value: float) -> str:
    n = round(abs(value), 1)
    return str(int(n)) if float(n).is_integer() else f"{n:.1f}"


def key_words(relation: str, match_key: Optional[str], seed_key: Optional[str]) -> Dict[str, str]:
    """The key part of a reason, long and short."""
    if relation == "same":
        return {"long": "Same key", "short": "same key"}
    if relation in ("up", "down"):
        return {"long": "One step on the wheel", "short": "step"}
    if relation == "relative":
        major = str(match_key or "").upper().endswith("B")
        word = "Relative major" if major else "Relative minor"
        return {"long": word, "short": word.lower()}
    from core.sets.steps import wheel_steps

    steps = wheel_steps(seed_key or "", match_key or "")
    if steps:
        return {"long": f"{steps} steps on the wheel", "short": f"{steps} steps"}
    return {"long": "Another key", "short": "other key"}


def bpm_words(relation: str, diff_pct: float) -> Dict[str, str]:
    """"+2% BPM", "same BPM", "half time"; short "+2%"."""
    if relation == "half":
        return {"long": "half time", "short": "half time"}
    if relation == "double":
        return {"long": "double time", "short": "double time"}
    if abs(diff_pct) < 0.05:
        return {"long": "same BPM", "short": ""}
    sign = "+" if diff_pct > 0 else "−"
    return {"long": f"{sign}{_pct(diff_pct)}% BPM", "short": f"{sign}{_pct(diff_pct)}%"}


def energy_words(delta: Optional[int]) -> Dict[str, str]:
    """"energy ↑1", "energy ↓2", "same energy"; short "↑1" (nothing when the same)."""
    if delta is None:
        return {"long": "", "short": ""}
    if delta == 0:
        return {"long": "same energy", "short": ""}
    arrow = "↑" if delta > 0 else "↓"
    return {"long": f"energy {arrow}{abs(delta)}", "short": f"{arrow}{abs(delta)}"}


def reasons(match: Dict[str, Any], seed_dj: Dict[str, Any]) -> Dict[str, str]:
    """``{"reason", "reason_short"}`` for one match against the seed."""
    other = match.get("dj") or {}
    k = key_words(match.get("key_relation") or "", other.get("key"), seed_dj.get("key"))
    b = bpm_words(match.get("bpm_relation") or "same", float(match.get("bpm_diff_pct") or 0.0))
    e = energy_words(energy_delta(seed_dj, other))
    return {"reason": " · ".join(p for p in (k["long"], b["long"], e["long"]) if p),
            "reason_short": " · ".join(p for p in (k["short"], b["short"], e["short"]) if p)}


def energy_delta(seed_dj: Dict[str, Any], other_dj: Dict[str, Any]) -> Optional[int]:
    a, b = seed_dj.get("energy"), (other_dj or {}).get("energy")
    if a is None or b is None:
        return None
    try:
        return int(b) - int(a)
    except (TypeError, ValueError):
        return None


# ── what the ranking reads ────────────────────────────────────────────────────

def set_tracks(database, profile_id: int, set_id: Any, at: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """The caller's set: its id, name, the library track ids it holds (in
    order) and the energies its direction is read from: the set's last
    tracks, or with ``at`` (while the set plays, the number Add puts tracks
    after) the tracks up to that one, where the next join is (gauntlet L6).
    None when it isn't the caller's."""
    from core.sets import store as sets_store

    saved = sets_store.get_set(database, int(profile_id), set_id)
    if saved is None:
        return None
    ids = [str(r["track_id"]) for r in saved["rows"] if r.get("track_id")]
    upto = ids[:at] if at and 0 < at <= len(ids) else ids
    energies: List[Optional[int]] = []
    if upto:
        found = dj_store.lookup(database, upto[-200:])
        energies = [(found.get(i) or {}).get("energy") for i in upto[-200:]]
    return {"id": saved["id"], "name": saved["name"], "ids": ids, "energies": energies}


def direction(energies: Sequence[Optional[int]], window: int = 4) -> Optional[str]:
    """Which way a set's energy is heading: "up", "down" or "steady", from the
    last ``window`` tracks whose energy is known (the first and last of
    them, at least one step apart); None with fewer than two known."""
    known = [int(e) for e in energies if e is not None][-window:]
    if len(known) < 2:
        return None
    change = known[-1] - known[0]
    if change >= 1:
        return "up"
    if change <= -1:
        return "down"
    return "steady"


def _stamp(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def recent_plays(database, profile_id: int, ids: Iterable[str], *,
                 now: Optional[datetime] = None) -> Dict[str, str]:
    """Of ``ids``, the library tracks in the caller's listening history in the
    last week: id -> "today" (the last two days) or "this_week". The
    profile's own pile, as Listening history reads it."""
    wanted = {str(i) for i in ids}
    if not wanted:
        return {}
    from core.listening_scope import listening_owner

    owner = listening_owner(database, profile_id)
    now = now or datetime.now(timezone.utc).replace(tzinfo=None)
    since = _stamp(now - timedelta(days=RECENT_DAYS))
    today = _stamp(now - timedelta(days=TODAY_DAYS))
    out: Dict[str, str] = {}
    try:
        with closing(database._get_connection()) as conn:
            rows = conn.execute(
                "SELECT db_track_id, MAX(played_at) FROM listening_history "
                "WHERE +profile_id = ? AND db_track_id IS NOT NULL AND played_at >= ? GROUP BY db_track_id",
                (int(owner), since)).fetchall()
    except Exception as exc:  # noqa: BLE001 - no history reads as nothing played
        logger.debug("listening history unreadable for the Mix tab: %s", exc)
        return {}
    for tid, last in rows:
        key = str(tid)
        if key in wanted:
            out[key] = "today" if str(last or "") >= today else "this_week"
    return out


def _genre_list(raw: Any) -> List[str]:
    if not raw:
        return []
    value: Any = raw
    if isinstance(raw, str):
        text = raw.strip()
        if text.startswith("["):
            try:
                value = json.loads(text)
            except ValueError:
                value = []
        else:
            value = text.split(",")
    if not isinstance(value, list):
        return []
    out = []
    for g in value:
        name = g.get("name") if isinstance(g, dict) else g
        if isinstance(name, str) and name.strip():
            out.append(name.strip().lower()[:60])
    return out[:30]


def styles(database, ids: Iterable[str]) -> Dict[str, Dict[str, Any]]:
    """Each track's artist and genres (its artist's and its album's), for
    style closeness. Library rows only."""
    ids = list(dict.fromkeys(str(i) for i in ids))
    out: Dict[str, Dict[str, Any]] = {}
    if not ids:
        return out
    with closing(database._get_connection()) as conn:
        for start in range(0, len(ids), 250):
            chunk = ids[start:start + 250]
            # "?" placeholders only are formatted in; every value is bound
            rows = conn.execute(  # nosemgrep: sqlalchemy-execute-raw-query
                f"SELECT t.id, t.artist_id, ar.genres, al.genres FROM tracks t "
                f"LEFT JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id "
                f"WHERE t.id IN ({','.join('?' * len(chunk))})", chunk).fetchall()
            for tid, artist_id, artist_genres, album_genres in rows:
                genres = set(_genre_list(artist_genres)) | set(_genre_list(album_genres))
                out[str(tid)] = {"artist_id": str(artist_id) if artist_id is not None else None,
                                 "genres": genres}
    return out


def closeness(seed: Optional[Dict[str, Any]], other: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """``{"share": 0..1, "shared": [genres], "same_artist": bool}``."""
    if not seed or not other:
        return {"share": 0.0, "shared": [], "same_artist": False}
    a, b = seed["genres"], other["genres"]
    both = a & b
    share = len(both) / len(a | b) if (a or b) else 0.0
    same = bool(seed.get("artist_id")) and seed.get("artist_id") == other.get("artist_id")
    return {"share": round(share, 3), "shared": sorted(both)[:2], "same_artist": same}


# ── the order ─────────────────────────────────────────────────────────────────

def _base(match: Dict[str, Any]) -> float:
    """The store's own order as a number: key rank, tempo rank, closeness."""
    return (_KEY_RANK.get(match.get("key_relation") or "", 3) * 10
            + _BPM_RANK.get(match.get("bpm_relation") or "", 1) * 4
            + min(12.0, abs(float(match.get("bpm_diff_pct") or 0.0))) / 2)


def energy_push(heading: Optional[str], delta: Optional[int]) -> float:
    """How far the set's direction moves a match (negative is up)."""
    if delta is None:
        return 0.0
    if heading == "up":
        return -WITH_THE_SET if delta > 0 else (0.0 if delta == 0 else AGAINST_THE_SET + abs(delta))
    if heading == "down":
        return -WITH_THE_SET if delta < 0 else (0.0 if delta == 0 else AGAINST_THE_SET + abs(delta))
    if heading == "steady":
        return float(abs(delta))
    # no set, or one too short to say: a gentle preference for a small change
    return abs(delta) * 0.5


def rank(database, track_id: str, *, profile_id: int, set_id: Any = None, limit: int = TAB_LIMIT,
         wide: bool = False, tolerance: Optional[float] = None, fix_art=None,
         now: Optional[datetime] = None, exclude: Iterable[str] = (),
         set_at: Optional[int] = None) -> Dict[str, Any]:
    """The Mix tab's answer for one track: what ``mixes_with`` answers, with
    the matches in the tab's order, ``limit`` of them, and ``set`` (the set
    followed: id, name, its ``direction``, how many of its tracks were left
    out) when ``set_id`` is one of the caller's. ``wide`` is "Widen the
    search": 10% and any key. ``exclude`` leaves tracks out too (More like
    this leaves out the playing one)."""
    started = time.monotonic()
    tol = WIDE_TOLERANCE if wide else (tolerance if tolerance is not None else dj_store.BPM_TOLERANCE)
    found = dj_store.mixes_with(database, str(track_id), limit=200, fix_art=fix_art, tolerance=tol,
                                any_key=wide)
    found["ranked"] = "mix"
    found["wide"] = bool(wide)
    the_set = set_tracks(database, profile_id, set_id, set_at) if set_id not in (None, "") else None
    found["set"] = None
    if found.get("track") is None:
        return found
    if the_set is not None:
        found["set"] = {"id": the_set["id"], "name": the_set["name"],
                        "direction": direction(the_set["energies"]), "left_out": 0}
    if found.get("reason") == "not_analyzed":
        return found
    seed_dj = (found["track"].get("dj") or {})
    matches = list(found.get("matches") or [])
    left_out = 0
    heading = None
    if the_set is not None:
        held = set(the_set["ids"])
        kept = [m for m in matches if m["id"] not in held]
        left_out = len(matches) - len(kept)
        matches = kept
        heading = direction(the_set["energies"])
        found["set"]["left_out"] = left_out
    skip = {str(i) for i in exclude}
    if skip:
        matches = [m for m in matches if m["id"] not in skip]
    ids = [m["id"] for m in matches]
    starred: Set[str] = set()
    try:
        from core.stars.store import starred_among

        starred = starred_among(database, int(profile_id), ids)
    except Exception as exc:  # noqa: BLE001 - the order stands without the boost
        logger.debug("stars unreadable for the Mix tab: %s", exc)
    played = recent_plays(database, int(profile_id), ids, now=now)
    style = styles(database, ids + [str(track_id)])
    seed_style = style.get(str(track_id))
    scored = []
    for index, match in enumerate(matches):
        delta = energy_delta(seed_dj, match.get("dj") or {})
        close = closeness(seed_style, style.get(match["id"]))
        recent = played.get(match["id"])
        score = _base(match)
        score += energy_push(heading, delta)
        if match["id"] in starred:
            score -= STARRED_BOOST
        if recent == "today":
            score += PLAYED_TODAY
        elif recent == "this_week":
            score += PLAYED_THIS_WEEK
        score -= STYLE_WEIGHT * close["share"]
        if close["same_artist"]:
            score -= SAME_ARTIST
        match = {**match, **reasons(match, seed_dj), "starred": match["id"] in starred,
                 "signals": {"starred": match["id"] in starred, "played": recent, "energy_delta": delta,
                             "style": close["share"], "shared_genres": close["shared"],
                             "same_artist": close["same_artist"]}}
        scored.append((round(score, 3), index, match))
    scored.sort(key=lambda s: (s[0], s[1]))
    limit = max(1, min(MAX_LIMIT, int(limit or TAB_LIMIT)))
    found["matches"] = [m for _s, _i, m in scored[:limit]]
    found["total"] = len(scored)
    found["reason"] = None if scored else "none"
    logger.debug("Mix tab ranked %d matches in %.0f ms", len(scored), (time.monotonic() - started) * 1000)
    return found


__all__ = ["MAX_LIMIT", "TAB_LIMIT", "WIDE_TOLERANCE", "bpm_words", "closeness", "direction", "energy_delta",
           "energy_push", "energy_words", "key_words", "rank", "reasons", "recent_plays", "set_tracks",
           "styles"]
