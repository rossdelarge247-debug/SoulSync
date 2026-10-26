"""Matching a tracklist to the library, in plain code (boards 22f–22i).

Each line becomes one of four states:

* **owned:** a library track with this title and version by a credited
  artist, or the same MusicBrainz recording when both sides have its id;
* **version:** the same song by the same artist, but another cut ("Signal
  Fire (Dub)" in the mix, the Original Mix in the library);
* **missing:** nothing in the library is that song;
* **id:** the tracklist itself doesn't know the track ("ID – ID"). IDs are
  never counted in "You own 14 of 22".

How sure (HANDOFF 245): a title is compared as its song and its version
separately (``tracklist.split_title``): "feat." credits, "Original Mix"
and bracket spellings fold away, and the artists must share a credited
name. Owned needs the song and the version to agree (confidence 1.0, or
0.9 when the song's spelling is only close); Another version needs the
song to agree exactly and the version to differ (0.8). A close spelling
with a different version is too unsure to call a version, so it reads
Missing: owning it is easy to check, a wrong "you have it" isn't.
"""

from __future__ import annotations

from contextlib import closing
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional

from core.dj import store as dj_store
from core.sets.tracklist import artists_match, fold, split_title
from core.text.normalize import normalize_for_comparison

#: how close two spellings of a song must be to count as the same when
#: they aren't equal once folded
CLOSE_SPELLING = 0.9
#: the most tracklist lines matched in one request
MAX_MATCH_LINES = 500
#: library candidates looked at per line
_CANDIDATES = 200
_LITTLE_WORDS = {"the", "a", "an", "le", "la", "el", "die", "der", "de", "i", "in", "on", "of"}


def _candidates(conn, where: str, params: List[Any], base_key: str, base_title: str) -> List[Dict[str, Any]]:
    """Library tracks with a file whose title starts like the song's."""
    if not base_key:
        return []

    def like(words: str) -> str:
        # the song's first word as a prefix (two when the first is a little
        # word like "The"), so a close spelling later in the title is still
        # found; LIKE's own wildcards escaped
        parts = words.split(" ")
        head = " ".join(parts[:2]) if parts[0].lower() in _LITTLE_WORDS else parts[0]
        return head.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"

    rows = conn.execute(
        f"{dj_store._track_select()} WHERE {where} AND t.file_path IS NOT NULL AND t.file_path != '' "
        f"AND (t.title LIKE ? ESCAPE '\\' OR t.title_norm LIKE ? ESCAPE '\\') LIMIT ?",
        list(params) + [like(base_title or base_key), like(normalize_for_comparison(base_title) or base_key),
                        _CANDIDATES]).fetchall()
    return [dict(r) for r in rows]


def _by_mbids(conn, where: str, params: List[Any], mbids: List[str]) -> Dict[str, Dict[str, Any]]:
    if not mbids:
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for start in range(0, len(mbids), 200):
        chunk = mbids[start:start + 200]
        try:
            rows = conn.execute(
                f"{dj_store._track_select().replace('d.* FROM', 'd.*, t.musicbrainz_recording_id AS mbid FROM')} "
                f"WHERE {where} AND t.file_path IS NOT NULL AND t.file_path != '' "
                f"AND t.musicbrainz_recording_id IN ({','.join('?' * len(chunk))})",
                list(params) + chunk).fetchall()
        except Exception:  # noqa: BLE001 - an old library without the column: titles only
            return out
        for row in rows:
            out.setdefault(str(row["mbid"]), dict(row))
    return out


def _shape(row: Dict[str, Any], fix_art=None) -> Dict[str, Any]:
    shaped = dj_store._shape_track(row, fix_art)
    shaped.pop("file_path", None)
    return shaped


def _judge(line: Dict[str, Any], rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """The best library row for one line, and how it relates."""
    want = split_title(line.get("title"))
    best: Optional[Dict[str, Any]] = None
    for row in rows:
        if not artists_match(line.get("artist"), row.get("artist_name")):
            continue
        have = split_title(row.get("title"))
        exact = have["key"] == want["key"]
        close = exact or SequenceMatcher(None, have["key"], want["key"]).ratio() >= CLOSE_SPELLING
        if not close:
            continue
        same_cut = have["version_key"] == want["version_key"]
        if same_cut:
            found = {"state": "owned", "row": row, "confidence": 1.0 if exact else 0.9}
        elif exact:
            found = {"state": "version", "row": row, "confidence": 0.8,
                     "have": have["version"] or "the original", "want_version": want["version"] or "the original"}
        else:
            continue
        rank = (found["state"] == "owned", found["confidence"])
        if best is None or rank > (best["state"] == "owned", best["confidence"]):
            best = found
    return best or {"state": "missing", "row": None, "confidence": 0.0}


def match_lines(database, lines: List[Dict[str, Any]], *, fix_art=None) -> List[Dict[str, Any]]:
    """Each tracklist line (``{"artist", "title", "at"?, "mbid"?, "kind"?}``)
    matched against the caller's library (``core.dj.store._scope``: another
    profile's library is never read). Lines come back in order with
    ``state``, ``track`` (the library track or None), ``confidence``,
    ``have`` and ``want_version`` for Another version, and ``matched_by``."""
    lines = list(lines)[:MAX_MATCH_LINES]
    where, params = dj_store._scope(database)
    out: List[Dict[str, Any]] = []
    with closing(database._get_connection()) as conn:
        mbids = [str(line["mbid"]) for line in lines if line.get("mbid")]
        by_mbid = _by_mbids(conn, where, params, list(dict.fromkeys(mbids)))
        for line in lines:
            row = {"artist": str(line.get("artist") or "")[:300], "title": str(line.get("title") or "")[:300],
                   "at": str(line.get("at") or "")[:16], "mbid": line.get("mbid") or None,
                   "raw": line.get("raw"), "note": line.get("note") or "", "n": line.get("n")}
            if line.get("kind") == "id" or (fold(row["artist"]) == "id" and fold(row["title"]) == "id"):
                out.append({**row, "state": "id", "track": None, "confidence": 0.0, "matched_by": None})
                continue
            if row["mbid"] and str(row["mbid"]) in by_mbid:
                out.append({**row, "state": "owned", "track": _shape(by_mbid[str(row["mbid"])], fix_art),
                            "confidence": 1.0, "matched_by": "musicbrainz"})
                continue
            song = split_title(row["title"])
            found = _judge(row, _candidates(conn, where, params, song["key"], song["base"]))
            item = {**row, "state": found["state"],
                    "track": _shape(found["row"], fix_art) if found.get("row") else None,
                    "confidence": found["confidence"], "matched_by": "title" if found.get("row") else None}
            if found["state"] == "version":
                item["have"] = found["have"]
                item["want_version"] = found["want_version"]
            out.append(item)
    return out


def counts(rows: List[Dict[str, Any]]) -> Dict[str, int]:
    """"You own 14 of 22": owned, version and missing; IDs aside and not in
    ``of``."""
    owned = sum(1 for r in rows if r["state"] == "owned")
    version = sum(1 for r in rows if r["state"] == "version")
    missing = sum(1 for r in rows if r["state"] == "missing")
    ids = sum(1 for r in rows if r["state"] == "id")
    return {"owned": owned, "version": version, "missing": missing, "ids": ids, "of": owned + version + missing}


__all__ = ["CLOSE_SPELLING", "MAX_MATCH_LINES", "counts", "match_lines"]
