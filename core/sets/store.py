"""Saved sets (Library → Sets, "Your sets") and the views the page draws.

A set belongs to one profile. Every read and write here takes the caller's
profile id and filters on it, admins included, so nobody sees or changes
another profile's sets (an id that isn't yours reads exactly like one that
doesn't exist). The tables are made by ``MusicDatabase._add_dj_sets_tables``.

A set's rows are its whole tracklist in order: library tracks, and for a
famous mix the lines that aren't in the library (Missing) or aren't known
(ID). Only rows with a library track play, export and count in the steps.

"Save as mix" keeps a set here and as a normal user playlist of its library
tracks (``core.playlists.user_playlists``), so Play, sync and the phone's
planner work on it like any playlist. Deleting a set leaves the playlist.

Drafts aren't stored here: until HANDOFF 246 is settled they live in the
browser that made them.
"""

from __future__ import annotations

import json
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
            "transition": _text(item.get("transition"), 40) or None,
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
            "transition": row.get("transition"), "mbid": row.get("mbid"), "raw": row.get("raw")}


# ── the page's view: tracks, steps, the meta line ─────────────────────────────

def view(database, rows: List[Dict[str, Any]], *, fix_art=None) -> Dict[str, Any]:
    """What the set's page draws for ``rows`` (``clean_rows``' shape, or a
    saved set's): each row with its library track (or None: missing, an ID,
    or no longer in the caller's library), the step from each playing row
    to the next playing one, and the meta line's numbers."""
    ids = [r["track_id"] for r in rows if r.get("track_id")]
    found = {t["id"]: t for t in traktor.tracks_by_ids(database, list(dict.fromkeys(ids)), fix_art)}
    out = []
    for row in rows:
        track = found.get(row.get("track_id") or "")
        if track is not None:
            track = {k: v for k, v in track.items() if k != "file_path"}
        # a row whose track can't be reached now keeps its state and its id
        # (it comes back when the file does); the page shows it as missing
        out.append({**_row_out({**row, "line_at": row.get("line_at") or row.get("at")}),
                    "state": row.get("state") or "owned", "track": track,
                    "unreachable": bool(row.get("track_id")) and track is None})
    playing = [i for i, r in enumerate(out) if r["track"] is not None]
    after: List[Optional[Dict[str, Any]]] = [None] * len(out)
    for a, b in zip(playing, playing[1:], strict=False):
        after[a] = set_steps.step(out[a]["track"].get("dj"), out[b]["track"].get("dj"))
    used = [{"duration_ms": out[i]["track"].get("duration_ms"), "dj": out[i]["track"].get("dj"),
             "locked": out[i]["locked"]} for i in playing]
    return {"rows": out, "steps": after,
            "summary": set_steps.summary(used, [s for s in after if s is not None])}


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

    def __init__(self, current: int):
        super().__init__("stale")
        self.current = current


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


def update_set(database, profile_id: int, set_id: Any, body: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Change a saved set's name and/or rows. None when it isn't yours.

    ``revision`` (optional, an integer the page counts up with each save)
    keeps autosaves in order: one at or below the set's revision is older
    than what's stored and raises StaleRevision, changing nothing.
    ``{"revision", "tracks_changed"}``: whether the playing tracks or their
    order changed, which is when the playlist follows."""
    with closing(database._get_connection()) as conn:
        row = _own(conn, profile_id, set_id)
        if row is None:
            return None
        current = int(row.get("revision") or 0)
        revision = body.get("revision")
        if isinstance(revision, int) and not isinstance(revision, bool):
            if revision <= current:
                raise StaleRevision(current)
            new_revision = revision
        else:
            new_revision = current + 1
        name = clean_name(body["name"]) if "name" in body else row["name"]
        old_rows = _rows_of(conn, row["id"])
        rows = None
        if "tracks" in body:
            held = {r["track_id"] for r in old_rows if r.get("track_id")}
            rows = _library_only(database, clean_rows(body["tracks"]), keep=held)
            if not rows:
                raise SetError("A set needs at least one track")
        conn.execute("UPDATE dj_sets SET name = ?, updated_at = ?, revision = ? WHERE id = ? AND profile_id = ?",
                     (name, time.time(), new_revision, row["id"], int(profile_id)))
        if rows is not None:
            _write_rows(conn, row["id"], rows)
        conn.commit()
    changed = rows is not None and _track_list(rows) != _track_list(old_rows)
    return {"revision": new_revision, "tracks_changed": changed}


def _set_playlist_fields(database, profile_id: int, set_id: int, **fields: Any) -> None:
    allowed = {"playlist_id", "playlist_hash", "playlist_state"}
    cols = [k for k in fields if k in allowed]
    if not cols:
        return
    with closing(database._get_connection()) as conn:
        conn.execute(f"UPDATE dj_sets SET {', '.join(c + ' = ?' for c in cols)} WHERE id = ? AND profile_id = ?",
                     [fields[c] for c in cols] + [int(set_id), int(profile_id)])
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


# ── the playlist "Save as mix" keeps ──────────────────────────────────────────
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


def make_playlist(database, profile_id: int, set_id: int, name: str, rows: List[Dict[str, Any]]) -> Optional[int]:
    """A new playlist of the set's tracks, followed from now on ("Save as
    mix", and "Make a new playlist from this set"). Best effort."""
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


def clear_playlist_state(database, profile_id: int, set_id: int) -> None:
    """"Not now": the set stops saying its playlist went its own way."""
    _set_playlist_fields(database, profile_id, set_id, playlist_state=None)


__all__ = ["KINDS", "MAX_ROWS", "MAX_SETS", "SetError", "StaleRevision", "alternatives", "clean_rows",
           "clear_playlist_state", "create_set", "delete_set", "follow_playlist", "get_set", "list_sets",
           "make_playlist", "saved_famous", "update_set", "view"]
