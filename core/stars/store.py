"""Stars (BACKLOG "Star tracks and mix sets"; boards 28a–28d).

A star is plain (not a rating), belongs to one profile and stays in
SYNCHRO.S: nothing here is written to Plex, Jellyfin or Navidrome. Every read
and write takes the caller's profile id and filters on it, admins included,
so no profile ever sees another's stars. The table is made by
``MusicDatabase._add_track_stars_table``.

Only a library track with its file present can be starred: it must be in
the caller's library scope (``core.dj.store._scope``, the same rule as the DJ
and Sets routes) with a file path. A starred track whose file later goes
missing keeps its star (it shows as File missing) and can be unstarred; it
can't be starred again until its file is back.
"""

from __future__ import annotations

import time
from contextlib import closing
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from core.dj.store import _scope
from utils.logging_config import get_logger

logger = get_logger("stars.store")

#: the most ids one request may name (a page of rows, or a selection)
MAX_IDS = 500
#: the longest track id kept (library ids are short; Jellyfin's are GUIDs)
MAX_ID = 128
#: the most stars one profile keeps
MAX_STARS = 100_000
#: the most title-and-artist pairs one status lookup may resolve (playlists)
MAX_SONGS = 500


class StarError(ValueError):
    """What was sent can't be starred; ``str()`` is safe to show."""


def clean_ids(raw: Any, limit: int = MAX_IDS) -> List[str]:
    """Track ids from a request: strings or whole numbers, trimmed, capped,
    first seen first. Raises StarError for a body that isn't a list or is
    too long."""
    if not isinstance(raw, list):
        raise StarError("track_ids must be a list")
    if len(raw) > limit:
        raise StarError(f"At most {limit} tracks at a time")
    out: Dict[str, None] = {}
    for item in raw:
        if isinstance(item, bool) or not isinstance(item, (str, int)):
            continue
        text = str(item).strip()
        if text and len(text) <= MAX_ID:
            out.setdefault(text, None)
    return list(out)


def _chunks(items: Sequence[Any], size: int = 250) -> Iterable[Sequence[Any]]:
    for start in range(0, len(items), size):
        yield items[start:start + size]


def _in_scope(conn, ids: Sequence[str], where: str, params: Sequence[Any]) -> Dict[str, bool]:
    """``{id: has_file}`` for the ids in the caller's library scope (an id
    that isn't there is left out)."""
    found: Dict[str, bool] = {}
    for chunk in _chunks(list(ids)):
        rows = conn.execute(
            f"SELECT t.id AS id, (t.file_path IS NOT NULL AND t.file_path != '') AS has_file "
            f"FROM tracks t WHERE t.id IN ({','.join('?' * len(chunk))}) AND {where}",
            list(chunk) + list(params)).fetchall()
        for row in rows:
            found[str(row["id"])] = bool(row["has_file"])
    return found


def _starred(conn, profile_id: int, ids: Sequence[str]) -> set:
    out = set()
    for chunk in _chunks(list(ids)):
        # only "?" placeholders are formatted in; the ids are bound parameters
        rows = conn.execute(  # nosemgrep: sqlalchemy-execute-raw-query
            f"SELECT track_id FROM track_stars WHERE profile_id = ? AND track_id IN ({','.join('?' * len(chunk))})",
            [int(profile_id)] + list(chunk)).fetchall()
        out.update(str(r["track_id"]) for r in rows)
    return out


def status(database, profile_id: int, ids: Sequence[str]) -> Dict[str, Dict[str, bool]]:
    """For each id: ``starred`` (this profile's star) and ``can_star`` (a
    track in the caller's library with its file present). A row shows the
    star when either is true; an id outside the caller's library that this
    profile starred earlier still reads as starred, so it can be taken off.
    Two queries per 250 ids, never one per row."""
    ids = list(dict.fromkeys(str(i) for i in ids))[:MAX_IDS]
    if not ids:
        return {}
    where, params = _scope(database)
    with closing(database._get_connection()) as conn:
        present = _in_scope(conn, ids, where, params)
        starred = _starred(conn, profile_id, ids)
    return {i: {"starred": i in starred, "can_star": present.get(i, False)} for i in ids}


def _low(text: Any) -> str:
    return " ".join(str(text or "").split()).lower()


def resolve_songs(database, songs: Sequence[Dict[str, Any]]) -> List[Optional[str]]:
    """Title-and-artist pairs (a playlist's rows) matched to the caller's
    library tracks with a file, by the same rule Export to Traktor uses for a
    playlist: the same title and artist, ignoring case. None where nothing
    matches. One query per 250 distinct titles."""
    pairs = [(_low(s.get("title")), _low(s.get("artist"))) for s in songs[:MAX_SONGS]]
    titles = sorted({t for t, _a in pairs if t})
    found: Dict[Tuple[str, str], str] = {}
    if titles:
        where, params = _scope(database)
        with closing(database._get_connection()) as conn:
            for chunk in _chunks(titles):
                rows = conn.execute(
                    f"SELECT t.id AS id, LOWER(t.title) AS title, "
                    f"LOWER(COALESCE(NULLIF(t.track_artist, ''), ar.name)) AS artist "
                    f"FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id "
                    f"WHERE {where} AND t.file_path IS NOT NULL AND t.file_path != '' "
                    f"AND LOWER(t.title) IN ({','.join('?' * len(chunk))}) ORDER BY t.id",
                    list(params) + list(chunk)).fetchall()
                for row in rows:
                    found.setdefault((_low(row["title"]), _low(row["artist"])), str(row["id"]))
    return [found.get(pair) if pair[0] and pair[1] else None for pair in pairs]


def star(database, profile_id: int, ids: Sequence[str]) -> Dict[str, Any]:
    """Star each id that's a library track of the caller's with its file
    present. Returns ``{"starred": [...], "left_out": [{"id", "reason"}]}``;
    the reasons are ``not_in_library`` and ``file_missing``. Starring a
    starred track again changes nothing."""
    ids = list(dict.fromkeys(str(i) for i in ids))[:MAX_IDS]
    if not ids:
        return {"starred": [], "left_out": []}
    where, params = _scope(database)
    now = time.time()
    with closing(database._get_connection()) as conn:
        present = _in_scope(conn, ids, where, params)
        ok = [i for i in ids if present.get(i)]
        left = [{"id": i, "reason": "file_missing" if i in present else "not_in_library"}
                for i in ids if not present.get(i)]
        if ok:
            have = conn.execute("SELECT COUNT(*) FROM track_stars WHERE profile_id = ?",
                                (int(profile_id),)).fetchone()[0]
            new = [i for i in ok if i not in _starred(conn, profile_id, ok)]
            if have + len(new) > MAX_STARS:
                raise StarError(f"A profile can keep {MAX_STARS:,} stars")
            conn.executemany(
                "INSERT OR IGNORE INTO track_stars (profile_id, track_id, starred_at) VALUES (?, ?, ?)",
                [(int(profile_id), i, now) for i in ok])
            conn.commit()
    return {"starred": ok, "left_out": left}


def unstar(database, profile_id: int, ids: Sequence[str]) -> List[str]:
    """Take this profile's star off each id (only its own rows are touched;
    a track whose file is missing can be unstarred). Returns the ids that
    were starred."""
    ids = list(dict.fromkeys(str(i) for i in ids))[:MAX_IDS]
    if not ids:
        return []
    with closing(database._get_connection()) as conn:
        had = _starred(conn, profile_id, ids)
        for chunk in _chunks(list(had)):
            # only "?" placeholders are formatted in; the ids are bound parameters
            conn.execute(  # nosemgrep: sqlalchemy-execute-raw-query
                f"DELETE FROM track_stars WHERE profile_id = ? AND track_id IN ({','.join('?' * len(chunk))})",
                [int(profile_id)] + list(chunk))
        conn.commit()
    return [i for i in ids if i in had]


def count(database, profile_id: int) -> Dict[str, int]:
    """The Starred chip's number: this profile's starred tracks that are in
    the caller's library (``count``), and how many of them have no file now
    (``missing``)."""
    where, params = _scope(database)
    with closing(database._get_connection()) as conn:
        row = conn.execute(
            f"SELECT COUNT(*) AS n, SUM(CASE WHEN t.file_path IS NULL OR t.file_path = '' THEN 1 ELSE 0 END) "
            f"AS missing FROM track_stars s JOIN tracks t ON t.id = s.track_id AND {where} "
            f"WHERE s.profile_id = ?", list(params) + [int(profile_id)]).fetchone()
    return {"count": int(row["n"] or 0), "missing": int(row["missing"] or 0)}


def starred_among(database, profile_id: int, ids: Iterable[Any]) -> set:
    """Which of ``ids`` this profile starred (Export to Traktor's rating)."""
    wanted = list(dict.fromkeys(str(i) for i in ids if i not in (None, "")))
    if not wanted:
        return set()
    with closing(database._get_connection()) as conn:
        return _starred(conn, profile_id, wanted)


__all__ = ["MAX_IDS", "MAX_SONGS", "StarError", "clean_ids", "count", "resolve_songs", "star",
           "starred_among", "status", "unstar"]
