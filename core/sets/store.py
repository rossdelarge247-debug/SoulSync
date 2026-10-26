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
    return " ".join(str(value or "").split())[:limit]


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
            "playlist_id": row.get("playlist_id"), "created_at": row.get("created_at"),
            "updated_at": row.get("updated_at")}


def list_sets(database, profile_id: int) -> List[Dict[str, Any]]:
    """Your sets, newest change first, each with what the row shows: how
    many tracks play, their length, and the energy line's points."""
    with closing(database._get_connection()) as conn:
        sets = [dict(r) for r in conn.execute(
            "SELECT * FROM dj_sets WHERE profile_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
            (int(profile_id), MAX_SETS)).fetchall()]
        rows_by_set = {s["id"]: _rows_of(conn, s["id"]) for s in sets}
    ids = [r["track_id"] for rows in rows_by_set.values() for r in rows if r.get("track_id")]
    tracks = {t["id"]: t for t in traktor.tracks_by_ids(database, list(dict.fromkeys(ids))[:traktor.MAX_TRACKS])}
    out = []
    for s in sets:
        rows = rows_by_set[s["id"]]
        playing = [tracks[r["track_id"]] for r in rows if r.get("track_id") in tracks]
        out.append({**_public_set(s),
                    "tracks": len(playing), "lines": sum(1 for r in rows if r["state"] != "id"),
                    "owned": sum(1 for r in rows if r["state"] == "owned"),
                    "seconds": sum(int(t.get("duration_ms") or 0) for t in playing) // 1000,
                    "energy": [((t.get("dj") or {}).get("energy")) for t in playing][:200]})
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
        state = row.get("state") or "owned"
        if row.get("track_id") and track is None:
            # it was in the library when it was added; it isn't now (or isn't
            # this profile's): shown as missing, never silently dropped
            state = "missing"
        out.append({**_row_out({**row, "line_at": row.get("line_at") or row.get("at")}),
                    "state": state, "track": track})
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


def _library_only(database, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """A track id the caller's library doesn't have becomes a plain line,
    so a set can never point at another profile's track."""
    ids = [r["track_id"] for r in rows if r.get("track_id")]
    found = {t["id"]: t for t in traktor.tracks_by_ids(database, list(dict.fromkeys(ids)))}
    out = []
    for row in rows:
        track = found.get(row["track_id"] or "")
        if row["track_id"] and track is None:
            row = {**row, "track_id": None, "state": "missing" if row["state"] != "id" else "id"}
        if track is not None:
            row = {**row, "artist": row["artist"] or track.get("artist_name"),
                   "title": row["title"] or track.get("title")}
        out.append(row)
    return out


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
            "source_meta, created_at, updated_at) VALUES (?, ?, ?, 'saved', ?, ?, ?, ?, ?, ?, ?)",
            (int(profile_id), name, kind, _text(body.get("shape"), 40) or None, source,
             _text(body.get("source_id"), 255) or None, _source_url(source, body.get("source_url")),
             json.dumps(_meta(body.get("source_meta"))), now, now))
        set_id = int(cur.lastrowid)
        _write_rows(conn, set_id, rows)
        conn.commit()
    return set_id


def update_set(database, profile_id: int, set_id: Any, body: Dict[str, Any]) -> bool:
    """Change a saved set's name and/or rows. False when it isn't yours."""
    with closing(database._get_connection()) as conn:
        row = _own(conn, profile_id, set_id)
        if row is None:
            return False
        name = clean_name(body["name"]) if "name" in body else row["name"]
        rows = _library_only(database, clean_rows(body["tracks"])) if "tracks" in body else None
        if rows is not None and not rows:
            raise SetError("A set needs at least one track")
        conn.execute("UPDATE dj_sets SET name = ?, updated_at = ? WHERE id = ? AND profile_id = ?",
                     (name, time.time(), row["id"], int(profile_id)))
        if rows is not None:
            _write_rows(conn, row["id"], rows)
        conn.commit()
    return True


def set_playlist(database, profile_id: int, set_id: int, playlist_id: Optional[int]) -> None:
    with closing(database._get_connection()) as conn:
        conn.execute("UPDATE dj_sets SET playlist_id = ? WHERE id = ? AND profile_id = ?",
                     (playlist_id, int(set_id), int(profile_id)))
        conn.commit()


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

def playlist_tracks(database, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The set's playing tracks in order, in the user playlist's shape."""
    ids = [r["track_id"] for r in rows if r.get("track_id")]
    found = {t["id"]: t for t in traktor.tracks_by_ids(database, list(dict.fromkeys(ids)))}
    out = []
    for row in rows:
        track = found.get(row.get("track_id") or "")
        if track is None:
            continue
        out.append({"track_name": track.get("title") or row.get("title") or "",
                    "artist_name": track.get("artist_name") or row.get("artist") or "",
                    "album_name": track.get("album_title") or "", "duration_ms": track.get("duration_ms") or 0})
    return out


def keep_playlist(database, profile_id: int, set_id: int, name: str, rows: List[Dict[str, Any]],
                  playlist_id: Optional[int]) -> Optional[int]:
    """Make the set's playlist, or bring it in line with the set; its id.
    A playlist that's gone (deleted on the Playlists page) is made again.
    Best effort: a failure here never loses the set."""
    from core.playlists import user_playlists as up

    tracks = [t for t in playlist_tracks(database, rows) if t["track_name"] and t["artist_name"]]
    try:
        playlist = None
        if playlist_id:
            found = database.get_mirrored_playlist(int(playlist_id), profile_id=int(profile_id))
            playlist = found if up.is_user_playlist(found) else None
        if playlist is None:
            new_id = up.create_playlist(database, int(profile_id), name)
            playlist = database.get_mirrored_playlist(new_id, profile_id=int(profile_id))
            if tracks:
                up.add_tracks(database, playlist, tracks, allow_duplicates=True)
        else:
            up.replace_tracks(database, playlist, tracks)
        new = int(playlist["id"])
        if new != playlist_id:
            set_playlist(database, profile_id, set_id, new)
        return new
    except Exception as exc:  # noqa: BLE001 - the set is saved either way
        logger.warning("Sets: couldn't keep set %s's playlist: %s", set_id, exc)
        return playlist_id


__all__ = ["KINDS", "MAX_ROWS", "MAX_SETS", "SetError", "alternatives", "clean_rows", "create_set",
           "delete_set", "get_set", "keep_playlist", "list_sets", "update_set", "view"]
