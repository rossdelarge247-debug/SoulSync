"""Saved sets (Library → Sets, "Your sets") and the views the page draws.

A set belongs to one profile. Every read and write here takes the caller's
profile id and filters on it, admins included, so nobody sees or changes
another profile's sets (an id that isn't yours reads exactly like one that
doesn't exist). The tables are made by ``MusicDatabase._add_dj_sets_tables``.

A set's rows are its whole tracklist in order: library tracks, and for a
famous mix the lines that aren't in the library (Missing) or aren't known
(ID). Only rows with a library track play, export and count in the steps.

"Save as mix set" keeps a set here and as a normal user playlist of its library
tracks (``core.playlists.user_playlists``), so Play, sync and the phone's
planner work on it like any playlist. Deleting a set leaves the playlist.

Drafts aren't stored here: until HANDOFF 246 is settled they live in the
browser that made them.
"""

from __future__ import annotations

import json
import threading
import time
from contextlib import closing
from typing import Any, Dict, List, Optional

from core.dj import store as dj_store
from core.dj import traktor
from core.sets import steps as set_steps
from utils.logging_config import get_logger

logger = get_logger("sets.store")

KINDS = ("hand", "famous", "suggested")
STATES = ("owned", "version", "missing", "id")
SOURCES = ("mixesdb", "musicbrainz", "discogs", "paste")
#: the most rows a set may hold
MAX_ROWS = 500
#: the most sets one profile keeps
MAX_SETS = 500
MAX_NAME = 200


#: a step's transition styles (26a's picker), "auto" first: auto-mix picks
#: (not built yet, so an auto step only says "Auto")
TRANSITION_STYLES = ("auto", "long_blend", "short_blend", "bass_swap", "cut", "echo_out", "filter_sweep",
                     "drop_swap")
#: a transition's lengths in bars (26a: 2 · 4 · 8 · 16 · 32)
TRANSITION_BARS = (2, 4, 8, 16, 32)
#: what a row without a chosen style reads as
AUTO = {"style": "auto", "bars": None}


class SetError(ValueError):
    """What the person sent can't be a set; ``str()`` is safe to show."""


def _text(value: Any, limit: int) -> str:
    """Display text from a request: control and format characters (NUL,
    the bidi overrides, zero-width marks) dropped, spaces collapsed, cut."""
    from core.sets.tracklist import clean_text

    return clean_text(value, limit)


def clean_name(value: Any) -> str:
    name = _text(value, MAX_NAME)
    if not name:
        raise SetError("Give the set a name")
    return name


def clean_transition(value: Any) -> Optional[str]:
    """A row's transition as it's stored: ``{"style", "bars"}`` as compact
    JSON, or None for auto with no length (the default). A style that isn't
    26a's reads as auto; a length that isn't 2, 4, 8, 16 or 32 bars is
    dropped, and a cut has none. A plain style name (an older page) is
    taken too."""
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("{"):
            try:
                value = json.loads(text[:200])
            except ValueError:
                value = {}
        else:
            value = {"style": text}
    if not isinstance(value, dict):
        return None
    style = value.get("style") if value.get("style") in TRANSITION_STYLES else "auto"
    bars = value.get("bars")
    if isinstance(bars, bool) or bars not in TRANSITION_BARS or style == "cut":
        bars = None
    if style == "auto" and bars is None:
        return None
    return json.dumps({"style": style, "bars": bars}, separators=(",", ":"))


def read_transition(stored: Any) -> Dict[str, Any]:
    """A stored transition as the page takes it: ``{"style", "bars"}``,
    auto when there's none."""
    cleaned = clean_transition(stored)
    return json.loads(cleaned) if cleaned else dict(AUTO)


def clean_rows(raw: Any) -> List[Dict[str, Any]]:
    """The rows a page sent, checked and cut to size. A row needs a library
    track id or an artist and a title."""
    if not isinstance(raw, list):
        raise SetError("tracks must be a list")
    if len(raw) > MAX_ROWS:
        raise SetError(f"A set can hold at most {MAX_ROWS} tracks")
    rows = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        track_id = item.get("track_id")
        track_id = _text(track_id, 128) if isinstance(track_id, (str, int)) and not isinstance(track_id, bool) else ""
        artist, title = _text(item.get("artist"), 300), _text(item.get("title"), 300)
        if not track_id and not (artist and title):
            continue
        state = item.get("state") if item.get("state") in STATES else ("owned" if track_id else "missing")
        if state in ("owned", "version") and not track_id:
            raise SetError("A row marked as yours needs its library track")
        rows.append({
            "track_id": track_id or None, "artist": artist or None, "title": title or None,
            "line_at": _text(item.get("at") or item.get("line_at"), 16) or None,
            "state": state,
            "want": "wanted" if item.get("want") == "wanted" else "yours",
            "version": _text(item.get("version") or item.get("want_version"), 120) or None,
            "locked": 1 if item.get("locked") is True else 0,
            "note": _text(item.get("note"), 500) or None,
            "transition": clean_transition(item.get("transition")),
            "mbid": _text(item.get("mbid"), 40) or None,
            "raw": _text(item.get("raw"), 300) or None,
        })
    return rows


def _meta(raw: Any) -> Dict[str, Any]:
    """The mix's own details kept with a famous set: title, artist, date,
    length, when the source last changed it."""
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Any] = {}
    for key, limit in (("title", 255), ("artist", 300), ("date", 20), ("edited", 40), ("kind", 10)):
        if raw.get(key):
            out[key] = _text(raw[key], limit)
    for key in ("seconds", "lines"):
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 10 ** 7:
            out[key] = value
    return out


def _source_url(source: Optional[str], url: Any) -> Optional[str]:
    """Only a link to the source's own site is kept (shown as "open it
    there"); anything else is dropped."""
    text = _text(url, 500)
    prefixes = {"mixesdb": ("https://www.mixesdb.com/w/", "https://www.mixes.wiki/w/"),
                "musicbrainz": ("https://musicbrainz.org/release/",),
                "discogs": ("https://www.discogs.com/release/",)}.get(source or "", ())
    return text if text and text.startswith(prefixes) else None


# ── reading ───────────────────────────────────────────────────────────────────

def _rows_of(conn, set_id: int) -> List[Dict[str, Any]]:
    return [dict(r) for r in conn.execute(
        "SELECT * FROM dj_set_tracks WHERE set_id = ? ORDER BY position", (int(set_id),)).fetchall()]


def _own(conn, profile_id: int, set_id: Any) -> Optional[Dict[str, Any]]:
    try:
        sid = int(set_id)
    except (TypeError, ValueError):
        return None
    row = conn.execute("SELECT * FROM dj_sets WHERE id = ? AND profile_id = ?", (sid, int(profile_id))).fetchone()
    return dict(row) if row else None


def _public_set(row: Dict[str, Any]) -> Dict[str, Any]:
    try:
        meta = json.loads(row.get("source_meta") or "{}")
    except ValueError:
        meta = {}
    return {"id": row["id"], "name": row["name"], "kind": row["kind"], "status": row["status"],
            "shape": row.get("shape"), "source": row.get("source"), "source_id": row.get("source_id"),
            "source_url": row.get("source_url"), "source_meta": meta if isinstance(meta, dict) else {},
            "playlist_id": row.get("playlist_id"), "playlist_state": row.get("playlist_state"),
            "revision": int(row.get("revision") or 0), "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at")}


def list_sets(database, profile_id: int) -> List[Dict[str, Any]]:
    """Your sets, newest change first, each with what the row shows: how
    many tracks play, their length, and the energy line's points. Two
    queries whatever the number of sets or tracks: the sets, then every
    row of them joined to the caller's library."""
    where, params = dj_store._scope(database)
    with closing(database._get_connection()) as conn:
        sets = [dict(r) for r in conn.execute(
            "SELECT * FROM dj_sets WHERE profile_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
            (int(profile_id), MAX_SETS)).fetchall()]
        rows = conn.execute(
            f"SELECT st.set_id AS set_id, st.state AS state, t.id AS tid, t.duration AS duration, "
            f"d.energy AS energy FROM dj_set_tracks st JOIN dj_sets s ON s.id = st.set_id "
            f"LEFT JOIN tracks t ON t.id = st.track_id AND {where} "
            f"AND t.file_path IS NOT NULL AND t.file_path != '' "
            f"LEFT JOIN track_dj d ON d.track_id = t.id "
            f"WHERE s.profile_id = ? ORDER BY st.set_id, st.position",
            list(params) + [int(profile_id)]).fetchall()
    per: Dict[int, Dict[str, Any]] = {}
    for r in rows:
        agg = per.setdefault(r["set_id"], {"tracks": 0, "lines": 0, "owned": 0, "ms": 0, "energy": []})
        if r["state"] != "id":
            agg["lines"] += 1
        if r["state"] == "owned":
            agg["owned"] += 1
        if r["tid"] is not None:
            agg["tracks"] += 1
            agg["ms"] += int(r["duration"] or 0)
            if len(agg["energy"]) < 200:
                agg["energy"].append(r["energy"])
    out = []
    for s in sets:
        agg = per.get(s["id"], {"tracks": 0, "lines": 0, "owned": 0, "ms": 0, "energy": []})
        out.append({**_public_set(s), "tracks": agg["tracks"], "lines": agg["lines"], "owned": agg["owned"],
                    "seconds": agg["ms"] // 1000, "energy": agg["energy"]})
    return out


def saved_famous(database, profile_id: int, words: List[str], limit: int = 5) -> List[Dict[str, Any]]:
    """Your saved famous mixes whose name has every word (Famous mix's
    search lists them, so a mix opens while its source is down). One query."""
    words = [w.lower() for w in words if w][:12]
    if not words:
        return []
    with closing(database._get_connection()) as conn:
        found = conn.execute(
            "SELECT s.id, s.name, s.source, s.source_id, "
            "(SELECT COUNT(*) FROM dj_set_tracks st WHERE st.set_id = s.id AND st.state != 'id') AS lines "
            "FROM dj_sets s WHERE s.profile_id = ? AND s.kind = 'famous' ORDER BY s.updated_at DESC LIMIT ?",
            (int(profile_id), MAX_SETS)).fetchall()
    out = []
    for r in found:
        name = (r["name"] or "").lower()
        if all(w in name for w in words):
            out.append({"source": "saved", "id": str(r["id"]), "title": r["name"], "from": r["source"],
                        "tracks": int(r["lines"] or 0), "kind": "saved", "source_id": r["source_id"]})
        if len(out) >= limit:
            break
    return out


def get_set(database, profile_id: int, set_id: Any) -> Optional[Dict[str, Any]]:
    with closing(database._get_connection()) as conn:
        row = _own(conn, profile_id, set_id)
        if row is None:
            return None
        rows = _rows_of(conn, row["id"])
    return {**_public_set(row), "rows": [_row_out(r) for r in rows]}


def _row_out(row: Dict[str, Any]) -> Dict[str, Any]:
    return {"track_id": row.get("track_id"), "artist": row.get("artist"), "title": row.get("title"),
            "at": row.get("line_at"), "state": row.get("state"), "want": row.get("want") or "yours",
            "version": row.get("version"), "locked": bool(row.get("locked")), "note": row.get("note"),
            "transition": read_transition(row.get("transition")), "mbid": row.get("mbid"), "raw": row.get("raw")}


# ── the page's view: tracks, steps, the meta line ─────────────────────────────

def view(database, rows: List[Dict[str, Any]], *, fix_art=None) -> Dict[str, Any]:
    """What the set's page draws for ``rows`` (``clean_rows``' shape, or a
    saved set's): each row with its library track (or None: missing, an ID,
    or no longer in the caller's library), the step from each playing row
    to the next playing one, and the meta line's numbers."""
    ids = [r["track_id"] for r in rows if r.get("track_id")]
    found = {t["id"]: t for t in traktor.tracks_by_ids(database, list(dict.fromkeys(ids)), fix_art)}
    gone = _without_file(database, [i for i in dict.fromkeys(ids) if i not in found], fix_art)
    out = []
    for row in rows:
        track = found.get(row.get("track_id") or "")
        if track is not None:
            track = {k: v for k, v in track.items() if k != "file_path"}
        # a row whose track can't be reached now keeps its state and its id
        # (it comes back when the file does); the page shows it as File
        # missing (28e), with its values when the library still has its row
        out.append({**_row_out({**row, "line_at": row.get("line_at") or row.get("at")}),
                    "state": row.get("state") or "owned", "track": track,
                    "unreachable": bool(row.get("track_id")) and track is None,
                    "gone_track": gone.get(row.get("track_id") or "") if track is None else None})
    playing = [i for i, r in enumerate(out) if r["track"] is not None]
    after: List[Optional[Dict[str, Any]]] = [None] * len(out)
    for a, b in zip(playing, playing[1:], strict=False):
        after[a] = set_steps.step(out[a]["track"].get("dj"), out[b]["track"].get("dj"))
    used = [{"duration_ms": out[i]["track"].get("duration_ms"), "dj": out[i]["track"].get("dj"),
             "locked": out[i]["locked"]} for i in playing]
    return {"rows": out, "steps": after,
            "summary": set_steps.summary(used, [s for s in after if s is not None])}


def _without_file(database, ids: List[str], fix_art=None) -> Dict[str, Dict[str, Any]]:
    """The caller's library tracks among ``ids`` whose file isn't there now:
    their title, artist and values, for a set's File missing row (28e). The
    caller's library scope only, like every read here; no file path."""
    if not ids:
        return {}
    where, params = dj_store._scope(database)
    out: Dict[str, Dict[str, Any]] = {}
    with closing(database._get_connection()) as conn:
        for start in range(0, len(ids), 250):
            chunk = ids[start:start + 250]
            # a fixed SELECT, "?" placeholders and the library scope's fixed
            # fragment are formatted in; every value is a bound parameter
            rows = conn.execute(  # nosemgrep: sqlalchemy-execute-raw-query
                f"{dj_store._track_select()} WHERE t.id IN ({','.join('?' * len(chunk))}) AND {where}",
                list(chunk) + list(params)).fetchall()
            for r in rows:
                shaped = dj_store._shape_track(r, fix_art)
                out[shaped["id"]] = {k: v for k, v in shaped.items() if k != "file_path"}
    return out


# ── Swap: alternatives that fit both neighbours ───────────────────────────────

def alternatives(database, *, before: Optional[str], after: Optional[str], current: Optional[str],
                 exclude: List[str], limit: int = 8, fix_art=None) -> Dict[str, Any]:
    """Tracks that could take a row's place (board 22c's Swap): found by
    "Mixes well with" from the track before and the track after, ranked by
    how many sides are smooth, then in Mixes well with's own order (no AI).
    With no neighbours, the row's own matches. ``exclude`` keeps tracks
    already in the set out."""
    skip = set(exclude) | ({current} if current else set())
    seeds = [s for s in (before, after) if s] or ([current] if current else [])
    order: Dict[str, int] = {}
    tracks: Dict[str, Dict[str, Any]] = {}
    sides: Dict[str, Dict[str, Any]] = {}
    for seed in seeds:
        found = dj_store.mixes_with(database, seed, limit=200, fix_art=fix_art)
        if found.get("track") is not None:
            sides[seed] = found["track"]
        for rank, match in enumerate(found.get("matches") or []):
            if match["id"] in skip:
                continue
            tracks.setdefault(match["id"], match)
            order[match["id"]] = min(order.get(match["id"], 10 ** 6), rank)
    rows = []
    for tid, track in tracks.items():
        into = set_steps.step(sides[before].get("dj"), track.get("dj")) if before in sides else None
        out_of = set_steps.step(track.get("dj"), sides[after].get("dj")) if after in sides else None
        jumps = sum(1 for s in (into, out_of) if s and s["kind"] != "smooth")
        clean = {k: v for k, v in track.items() if k != "file_path"}
        rows.append({"track": clean, "into": into, "out_of": out_of, "jumps": jumps, "rank": order[tid]})
    rows.sort(key=lambda r: (r["jumps"], r["rank"], r["track"]["title"].lower()))
    return {"alternatives": rows[:max(1, min(25, int(limit)))], "total": len(rows),
            "before": sides.get(before) if before else None, "after": sides.get(after) if after else None}


# ── writing ───────────────────────────────────────────────────────────────────

def _write_rows(conn, set_id: int, rows: List[Dict[str, Any]]) -> None:
    conn.execute("DELETE FROM dj_set_tracks WHERE set_id = ?", (int(set_id),))
    conn.executemany(
        "INSERT INTO dj_set_tracks (set_id, position, track_id, artist, title, line_at, state, want, version, "
        "locked, note, transition, mbid, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(int(set_id), i, r["track_id"], r["artist"], r["title"], r["line_at"], r["state"], r["want"], r["version"],
          r["locked"], r["note"], r["transition"], r["mbid"], r["raw"]) for i, r in enumerate(rows)])


def _library_only(database, rows: List[Dict[str, Any]], keep: Optional[set] = None) -> List[Dict[str, Any]]:
    """A track id the caller's library doesn't have becomes a plain line, so
    a set can never point at another profile's track. Ids in ``keep`` (the
    ones the set already held) are kept as they are: a track that's briefly
    unreachable (a server switch, a rescan, a file being moved) mustn't be
    dropped by an unrelated edit; the view shows it as missing meanwhile."""
    keep = keep or set()
    ids = [r["track_id"] for r in rows if r.get("track_id") and r["track_id"] not in keep]
    found = {t["id"]: t for t in traktor.tracks_by_ids(database, list(dict.fromkeys(ids)))}
    out = []
    for row in rows:
        tid = row["track_id"]
        if tid and tid not in keep:
            track = found.get(tid)
            if track is None:
                row = {**row, "track_id": None, "state": "missing" if row["state"] != "id" else "id"}
            else:
                row = {**row, "artist": row["artist"] or track.get("artist_name"),
                       "title": row["title"] or track.get("title")}
        out.append(row)
    return out


class StaleRevision(Exception):
    """An autosave older than one already applied (``current`` is the
    revision the set has)."""

    def __init__(self, current: int, reason: Optional[str] = None):
        super().__init__("stale")
        self.current = current
        #: "reload": the save had no base revision (a page from before
        #: compare-and-set); it's refused and the page must read the set again
        self.reason = reason


def create_set(database, profile_id: int, body: Dict[str, Any]) -> int:
    """Save a set (``{name, kind, tracks, source?, source_id?, source_url?,
    source_meta?, shape?}``); its id."""
    name = clean_name(body.get("name"))
    rows = _library_only(database, clean_rows(body.get("tracks")))
    if not rows:
        raise SetError("A set needs at least one track")
    kind = body.get("kind") if body.get("kind") in KINDS else "hand"
    source = body.get("source") if body.get("source") in SOURCES else None
    now = time.time()
    with closing(database._get_connection()) as conn:
        have = conn.execute("SELECT COUNT(*) FROM dj_sets WHERE profile_id = ?", (int(profile_id),)).fetchone()[0]
        if have >= MAX_SETS:
            raise SetError(f"You can keep {MAX_SETS} sets; remove one first")
        cur = conn.execute(
            "INSERT INTO dj_sets (profile_id, name, kind, status, shape, source, source_id, source_url, "
            "source_meta, created_at, updated_at, revision) VALUES (?, ?, ?, 'saved', ?, ?, ?, ?, ?, ?, ?, 0)",
            (int(profile_id), name, kind, _text(body.get("shape"), 40) or None, source,
             _text(body.get("source_id"), 255) or None, _source_url(source, body.get("source_url")),
             json.dumps(_meta(body.get("source_meta"))), now, now))
        set_id = int(cur.lastrowid)
        _write_rows(conn, set_id, rows)
        conn.commit()
    return set_id


def _track_list(rows: List[Dict[str, Any]]) -> List[Any]:
    return [r.get("track_id") for r in rows if r.get("track_id")]


#: the highest revision a page may send (JavaScript's largest exact integer)
MAX_REVISION = 2 ** 53
def _check_base(base: Any) -> None:
    """A base revision must be a whole number in 0..2**53 - 1 (the set's
    next is one more, and stays within JavaScript's exact integers)."""
    if isinstance(base, bool) or not isinstance(base, int):
        raise SetError("The base revision must be a whole number")
    if base < 0 or base >= MAX_REVISION:
        raise SetError("The base revision is out of range")


def _revision_of(conn, profile_id: int, set_id: int) -> Optional[int]:
    found = conn.execute("SELECT revision FROM dj_sets WHERE id = ? AND profile_id = ?",
                         (int(set_id), int(profile_id))).fetchone()
    return None if found is None else int(found[0] or 0)


def update_set(database, profile_id: int, set_id: Any, body: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Change a saved set's name and/or rows. None when it isn't yours.

    ``base_revision`` (what the page sends): the revision the page last read
    or had confirmed. The write happens only while the stored revision still
    equals it, in one conditional UPDATE, and the set's revision becomes that
    plus one. Anything else in between (an add from another tab or device, a
    save from another window) moved the revision on, so the save raises
    StaleRevision with the stored one and changes nothing: the page stops
    and says so, never writing over what it hasn't seen.

    **A save needs ``base_revision``.** One without it (an older page's,
    which counted ``revision`` up itself, or no revision at all) could write
    over a change it never saw, so it raises StaleRevision with ``reason``
    "reload" and changes nothing.
    Returns ``{"revision", "tracks_changed"}``: whether the playing tracks or
    their order changed, which is when the playlist follows."""
    base = body.get("base_revision")
    if base is not None:
        _check_base(base)
    name = clean_name(body["name"]) if "name" in body else None
    cleaned = clean_rows(body["tracks"]) if "tracks" in body else None
    with closing(database._get_connection()) as conn:
        row = _own(conn, profile_id, set_id)
        if row is None:
            return None
        sid = int(row["id"])
        if base is None:
            raise StaleRevision(int(row.get("revision") or 0), reason="reload")
        try:
            # applied only while nothing has changed the set since the page's
            # base: compare and set, in one statement
            cur = conn.execute(
                "UPDATE dj_sets SET name = COALESCE(?, name), updated_at = ?, revision = revision + 1 "
                "WHERE id = ? AND profile_id = ? AND revision = ?",
                (name, time.time(), sid, int(profile_id), base))
            if cur.rowcount != 1:
                conn.rollback()
                now = _revision_of(conn, profile_id, sid)
                if now is None:
                    return None
                raise StaleRevision(now)
            # this transaction now holds the write lock: what it reads from
            # here on is what it replaces
            new_revision = _revision_of(conn, profile_id, sid)
            old_rows = _rows_of(conn, sid)
            rows = None
            if cleaned is not None:
                held = {r["track_id"] for r in old_rows if r.get("track_id")}
                rows = _library_only(database, cleaned, keep=held)
                if not rows:
                    raise SetError("A set needs at least one track")
                _write_rows(conn, sid, rows)
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
    changed = rows is not None and _track_list(rows) != _track_list(old_rows)
    return {"revision": new_revision, "tracks_changed": changed}


# ── "Add to mix set…" (28a, 28b) ─────────────────────────────────────────────

def _numbers(rows: List[Dict[str, Any]]) -> Dict[str, List[int]]:
    """Each library track's numbers in a set, as the set's page numbers its
    rows: every row that holds a library track counts (one whose file is
    missing keeps its number), tracklist lines that aren't in the library
    don't."""
    out: Dict[str, List[int]] = {}
    n = 0
    for row in rows:
        if row.get("track_id"):
            n += 1
            out.setdefault(str(row["track_id"]), []).append(n)
    return out


def holding(database, profile_id: int, track_ids: List[str]) -> List[Dict[str, Any]]:
    """The picker's list (28a): your sets, newest change first, each with
    the number the next track takes (``next``) and where each of
    ``track_ids`` already is (``holds``: id -> its numbers). Two queries
    whatever the number of sets."""
    wanted = set(track_ids)
    with closing(database._get_connection()) as conn:
        sets = [dict(r) for r in conn.execute(
            "SELECT id, name, kind, updated_at FROM dj_sets WHERE profile_id = ? "
            "ORDER BY updated_at DESC, id DESC LIMIT ?", (int(profile_id), MAX_SETS)).fetchall()]
        rows = conn.execute(
            "SELECT st.set_id AS set_id, st.track_id AS track_id FROM dj_set_tracks st "
            "JOIN dj_sets s ON s.id = st.set_id WHERE s.profile_id = ? ORDER BY st.set_id, st.position",
            (int(profile_id),)).fetchall()
    per: Dict[int, List[Dict[str, Any]]] = {}
    for r in rows:
        per.setdefault(r["set_id"], []).append({"track_id": r["track_id"]})
    out = []
    for s in sets:
        numbers = _numbers(per.get(s["id"], []))
        out.append({"id": s["id"], "name": s["name"], "kind": s["kind"], "updated_at": s["updated_at"],
                    "next": sum(len(v) for v in numbers.values()) + 1,
                    "rows": len(per.get(s["id"], [])),
                    "holds": {tid: numbers[tid] for tid in wanted if tid in numbers}})
    return out


def _insert_at(rows: List[Dict[str, Any]], after: Optional[Dict[str, Any]]) -> Optional[int]:
    """The row index ``after`` names (``{"track_id", "number"}``: the playing
    track and its number in the set, the Mix tab's "Add" while a set plays):
    the row with that number when it still holds that track, else the
    track's first row; None (the end) when the set doesn't hold it."""
    if not isinstance(after, dict):
        return None
    tid = after.get("track_id")
    if not isinstance(tid, (str, int)) or isinstance(tid, bool) or not str(tid):
        return None
    tid = str(tid)
    number = after.get("number")
    n = 0
    first = None
    for index, row in enumerate(rows):
        if not row.get("track_id"):
            continue
        n += 1
        if str(row["track_id"]) != tid:
            continue
        if isinstance(number, int) and not isinstance(number, bool) and number == n:
            return index
        if first is None:
            first = index
    return first


#: what a row's transition becomes when its next track changes under it: Auto,
#: with the picker's starting length (it described another join)
RESET_TRANSITION = {"style": "auto", "bars": 16}


def insert_keeping_locked(rows: List[Dict[str, Any]], at: int,
                          fresh: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """``rows`` with ``fresh`` put after index ``at``, the way the set's page
    moves rows (``moveRow``): **locked rows keep their places**. Rows up to
    ``at`` stay; after it, each locked row keeps its index and the unlocked
    ones, the fresh first, fill the free places in order (gauntlet L5)."""
    total = len(rows) + len(fresh)
    out: List[Optional[Dict[str, Any]]] = [None] * total
    for i in range(min(at + 1, len(rows))):
        out[i] = rows[i]
    queue: List[Dict[str, Any]] = list(fresh)
    for i in range(at + 1, len(rows)):
        if rows[i].get("locked"):
            out[i] = rows[i]
        else:
            queue.append(rows[i])
    k = 0
    for i in range(total):
        if out[i] is None:
            out[i] = queue[k]
            k += 1
    return [r for r in out if r is not None]


def placed_as(at: int, indexes: List[int], total: int) -> str:
    """Where ``insert_keeping_locked`` really put the new rows (at
    ``indexes`` of ``total``), asked to go after row ``at`` (gauntlet L9):
    ``after`` (together, straight after it), ``later`` (together, but past
    locked rows that keep their places after it), ``end`` (together at the
    set's end, past them), or ``split`` (locked rows between them)."""
    if not indexes:
        return "after"
    together = indexes == list(range(indexes[0], indexes[0] + len(indexes)))
    if together and indexes[0] == at + 1:
        return "after"
    if together and indexes[-1] == total - 1:
        return "end"
    return "later" if together else "split"


def _next_rows(rows: List[Dict[str, Any]]) -> Dict[int, Optional[Dict[str, Any]]]:
    """Each row (by identity) -> the next row holding a library track, or None."""
    out: Dict[int, Optional[Dict[str, Any]]] = {}
    following: Optional[Dict[str, Any]] = None
    for row in reversed(rows):
        out[id(row)] = following
        if row.get("track_id"):
            following = row
    return out


def reset_changed_joins(before: List[Dict[str, Any]], after: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """``after`` with the transition reset to Auto (RESET_TRANSITION) on every
    row whose next track changed from one track to another: its style and
    length described a join that isn't there any more (gauntlet L5). The
    next rows are compared by their track, not as rows: a new row holding the
    track that already came next keeps the join (L8). A row that had no next
    track (the last), or no chosen transition, is left."""
    was, now = _next_rows(before), _next_rows(after)
    reset = clean_transition(RESET_TRANSITION)
    out = []
    for row in after:
        old_next = was.get(id(row))
        new_next = now.get(id(row))
        # the next *track* decides (gauntlet L8): the same track added again
        # straight after a row that already led into it is the same join
        if (row.get("transition") and old_next is not None
                and str((new_next or {}).get("track_id") or "") != str(old_next.get("track_id") or "")):
            row = {**row, "transition": reset}
        out.append(row)
    return out


def append_tracks(database, profile_id: int, set_id: Any, track_ids: List[str], *,
                  again: bool = False, after: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """Add library tracks to the end of one of your sets ("Add to mix
    set…"). None when the set isn't yours.

    ``after`` (``{"track_id", "number"}``, the Mix tab while a set plays,
    29b) puts them straight after that row instead (locked rows keep their
    places, and a row whose next track changes has its transition reset to
    Auto: ``insert_keeping_locked``, ``reset_changed_joins``); ``placed``
    says where they really went (``placed_as``): "after", "later" or
    "split" when locked rows came first or between them, or "end" (also
    when the set no longer holds that track, or without ``after``).

    Only tracks in the caller's library with their file present go in (the
    downloaded-only rule); the rest are ``left_out``. A track the set already
    holds is skipped (``already``) unless ``again`` ("Add again", "Add all
    6"). The set's revision moves on by one in the same transaction, like a
    save without a revision, so an open page's older autosave is refused
    rather than undoing this. Returns ``{"added": [{"track_id", "number"}],
    "already": [...], "left_out": [{"id", "reason"}], "revision",
    "tracks_changed"}``."""
    ids = list(dict.fromkeys(str(i) for i in track_ids if i not in (None, "")))
    found = {t["id"]: t for t in traktor.tracks_by_ids(database, ids)}
    left_out = []
    if ids:
        missing = [i for i in ids if i not in found]
        if missing:
            where, params = dj_store._scope(database)
            with closing(database._get_connection()) as conn:
                # "?" placeholders and the library scope's fixed fragment are
                # formatted in; every value is a bound parameter
                known = {str(r[0]) for r in conn.execute(  # nosemgrep: sqlalchemy-execute-raw-query
                    f"SELECT t.id FROM tracks t WHERE t.id IN ({','.join('?' * len(missing))}) AND {where}",
                    list(missing) + list(params)).fetchall()}
            left_out = [{"id": i, "reason": "file_missing" if i in known else "not_in_library"} for i in missing]
    with closing(database._get_connection()) as conn:
        row = _own(conn, profile_id, set_id)
        if row is None:
            return None
        sid = int(row["id"])
        try:
            cur = conn.execute("UPDATE dj_sets SET updated_at = ?, revision = revision + 1 "
                               "WHERE id = ? AND profile_id = ?", (time.time(), sid, int(profile_id)))
            if cur.rowcount != 1:
                conn.rollback()
                return None
            # this transaction holds the write lock: the rows read here are
            # the ones the new tracks follow
            old_rows = _rows_of(conn, sid)
            numbers = _numbers(old_rows)
            already = [i for i in ids if i in found and i in numbers]
            adding = [i for i in ids if i in found and (again or i not in numbers)]
            if len(old_rows) + len(adding) > MAX_ROWS:
                raise SetError(f"A set can hold at most {MAX_ROWS} tracks")
            next_number = sum(len(v) for v in numbers.values()) + 1
            at = _insert_at(old_rows, after) if after is not None else None
            # nothing added: where they would have gone
            where = "after" if at is not None else "end"
            added = []
            if adding and at is not None:
                fresh = [{"track_id": tid, "artist": found[tid].get("artist_name") or None,
                          "title": found[tid].get("title") or None, "line_at": None, "state": "owned",
                          "want": "yours", "version": None, "locked": 0, "note": None, "transition": None,
                          "mbid": None, "raw": None} for tid in adding]
                placed = insert_keeping_locked(old_rows, at, fresh)
                _write_rows(conn, sid, reset_changed_joins(old_rows, placed))
                fresh_ids = {id(r) for r in fresh}
                where = placed_as(at, [i for i, r in enumerate(placed) if id(r) in fresh_ids], len(placed))
                n = 0
                for r in placed:
                    if r.get("track_id"):
                        n += 1
                        if id(r) in fresh_ids:
                            added.append({"track_id": r["track_id"], "number": n})
                conn.commit()
            elif adding:
                where = "end"
                conn.executemany(
                    "INSERT INTO dj_set_tracks (set_id, position, track_id, artist, title, state, want, locked) "
                    "VALUES (?, ?, ?, ?, ?, 'owned', 'yours', 0)",
                    [(sid, len(old_rows) + k, tid, found[tid].get("artist_name") or None,
                      found[tid].get("title") or None) for k, tid in enumerate(adding)])
                added = [{"track_id": tid, "number": next_number + k} for k, tid in enumerate(adding)]
                conn.commit()
            else:
                # nothing to add: the revision stays where it was
                conn.rollback()
            revision = _revision_of(conn, profile_id, sid)
        except BaseException:
            conn.rollback()
            raise
    return {"added": added, "already": already, "left_out": left_out, "revision": revision,
            "tracks_changed": bool(added), "placed": where}


#: one fixed statement per playlist field (no SQL is put together at run time)
_PLAYLIST_FIELD_SQL = {
    "playlist_id": "UPDATE dj_sets SET playlist_id = ? WHERE id = ? AND profile_id = ?",
    "playlist_hash": "UPDATE dj_sets SET playlist_hash = ? WHERE id = ? AND profile_id = ?",
    "playlist_state": "UPDATE dj_sets SET playlist_state = ? WHERE id = ? AND profile_id = ?",
}


def _set_playlist_fields(database, profile_id: int, set_id: int, **fields: Any) -> None:
    """Set the playlist fields given (others are left as they are), in one
    transaction."""
    with closing(database._get_connection()) as conn:
        for name, value in fields.items():
            sql = _PLAYLIST_FIELD_SQL.get(name)
            if sql is not None:
                conn.execute(sql, (value, int(set_id), int(profile_id)))
        conn.commit()


def set_playlist(database, profile_id: int, set_id: int, playlist_id: Optional[int]) -> None:
    _set_playlist_fields(database, profile_id, set_id, playlist_id=playlist_id)


def delete_set(database, profile_id: int, set_id: Any) -> bool:
    """Remove one of your sets and its rows; its playlist stays. False when
    it isn't yours (nothing is touched)."""
    with closing(database._get_connection()) as conn:
        row = _own(conn, profile_id, set_id)
        if row is None:
            return False
        conn.execute("DELETE FROM dj_set_tracks WHERE set_id = ?", (row["id"],))
        conn.execute("DELETE FROM dj_sets WHERE id = ? AND profile_id = ?", (row["id"], int(profile_id)))
        conn.commit()
    return True


# ── the playlist "Save as mix set" keeps ──────────────────────────────────────
#
# The set writes its playlist and remembers a hash of what it wrote. Later
# edits to the set's tracks bring the playlist along only while it still
# holds exactly that: once someone changes it on the Playlists page it stops
# following the set (``playlist_state`` "changed"), and a playlist that was
# deleted is never made again behind the person's back ("deleted"). The set
# says so once and offers "Make a new playlist from this set".

def playlist_tracks(database, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The set's tracks in order, in the user playlist's shape. A track the
    set holds but that's briefly unreachable keeps its place by the set's own
    artist and title."""
    ids = [r["track_id"] for r in rows if r.get("track_id")]
    found = {t["id"]: t for t in traktor.tracks_by_ids(database, list(dict.fromkeys(ids)))}
    out = []
    for row in rows:
        if not row.get("track_id"):
            continue
        track = found.get(row["track_id"]) or {}
        out.append({"track_name": track.get("title") or row.get("title") or "",
                    "artist_name": track.get("artist_name") or row.get("artist") or "",
                    "album_name": track.get("album_title") or "", "duration_ms": track.get("duration_ms") or 0})
    return [t for t in out if t["track_name"] and t["artist_name"]]


def _playlist_hash(database, playlist_id: int) -> str:
    """What a playlist holds, in order, as a short hash (its songs' keys)."""
    import hashlib

    from core.playlists import user_playlists as up

    keys = [list(up.track_key(t)) for t in database.get_mirrored_playlist_tracks(int(playlist_id))]
    return hashlib.sha256(json.dumps(keys).encode("utf-8")).hexdigest()


def _own_playlist(database, profile_id: int, playlist_id: Optional[int]):
    from core.playlists import user_playlists as up

    if not playlist_id:
        return None
    found = database.get_mirrored_playlist(int(playlist_id), profile_id=int(profile_id))
    return found if up.is_user_playlist(found) else None


def has_own_playlist(database, profile_id: int, playlist_id: Optional[int]) -> bool:
    """Whether ``playlist_id`` is still one of the profile's own playlists."""
    return _own_playlist(database, profile_id, playlist_id) is not None


def make_playlist(database, profile_id: int, set_id: int, name: str, rows: List[Dict[str, Any]]) -> Optional[int]:
    """A new playlist of the set's tracks, followed from now on ("Save as
    mix set", and "Make a new playlist from this set"). Best effort."""
    from core.playlists import user_playlists as up

    try:
        new_id = up.create_playlist(database, int(profile_id), name)
        playlist = database.get_mirrored_playlist(new_id, profile_id=int(profile_id))
        tracks = playlist_tracks(database, rows)
        if tracks:
            up.add_tracks(database, playlist, tracks, allow_duplicates=True)
        _set_playlist_fields(database, profile_id, set_id, playlist_id=int(new_id),
                             playlist_hash=_playlist_hash(database, new_id), playlist_state=None)
        return int(new_id)
    except Exception as exc:  # noqa: BLE001 - the set is saved either way
        logger.warning("Sets: couldn't make set %s's playlist: %s", set_id, exc)
        return None


def follow_playlist(database, profile_id: int, set_id: int, rows: List[Dict[str, Any]]) -> Optional[str]:
    """After the set's tracks changed: bring its playlist along, or let it go.
    Returns the playlist's state afterwards: None (following, or there is
    none), "changed" or "deleted"."""
    from core.playlists import user_playlists as up

    with closing(database._get_connection()) as conn:
        row = _own(conn, profile_id, set_id)
    if row is None or not row.get("playlist_id"):
        return row.get("playlist_state") if row else None
    try:
        playlist = _own_playlist(database, profile_id, row["playlist_id"])
        if playlist is None:
            _set_playlist_fields(database, profile_id, set_id, playlist_id=None, playlist_hash=None,
                                 playlist_state="deleted")
            return "deleted"
        if row.get("playlist_hash") and _playlist_hash(database, playlist["id"]) != row["playlist_hash"]:
            _set_playlist_fields(database, profile_id, set_id, playlist_id=None, playlist_hash=None,
                                 playlist_state="changed")
            return "changed"
        up.replace_tracks(database, playlist, playlist_tracks(database, rows))
        _set_playlist_fields(database, profile_id, set_id, playlist_hash=_playlist_hash(database, playlist["id"]))
        return None
    except Exception as exc:  # noqa: BLE001 - the set is saved either way
        logger.warning("Sets: couldn't bring set %s's playlist along: %s", set_id, exc)
        return None


#: one playlist sync at a time (the app runs one worker process, with threads)
_FOLLOW_LOCK = threading.Lock()


def follow_latest(database, profile_id: int, set_id: int) -> Optional[str]:
    """``follow_playlist`` with the set's rows read again under a lock, so of
    two changes at once (two adds, an add and a save) the last sync to run
    always writes the newest rows: a sync never writes rows another change
    has already replaced. Returns what follow_playlist does."""
    with _FOLLOW_LOCK:
        saved = get_set(database, profile_id, set_id)
        if saved is None:
            return None
        return follow_playlist(database, profile_id, set_id, saved["rows"])


def clear_playlist_state(database, profile_id: int, set_id: int) -> None:
    """"Not now": the set stops saying its playlist went its own way."""
    _set_playlist_fields(database, profile_id, set_id, playlist_state=None)


__all__ = ["RESET_TRANSITION", "insert_keeping_locked", "placed_as", "reset_changed_joins", "KINDS", "MAX_ROWS", "MAX_SETS", "TRANSITION_BARS", "TRANSITION_STYLES", "SetError", "StaleRevision",
           "alternatives", "append_tracks", "clean_rows", "clean_transition", "clear_playlist_state", "create_set",
           "delete_set", "follow_latest", "follow_playlist", "get_set", "holding", "list_sets", "make_playlist", "read_transition",
           "saved_famous", "update_set", "view"]
