"""The player's three reads (board 6a; docs/design/CONTRACTS.md, "The player").

GET /api/library/tracks/<id>/peaks
    ``{peaks, duration_s}``: 200 bar heights from 0 to 1 for the waveform. The
    first ask for a file answers ``202 {pending: true}`` and works them out in
    the background (core/playback/peaks.py, one decode at a time); ask again.
    A file that can't be drawn answers 200 with ``peaks: null`` and a
    ``reason`` (not_on_disk, not_audio, unreadable) so the player stops asking.

GET /api/library/tracks/<id>/details
    ``{format, bitrate_kbps, bit_depth, sample_rate, path_label, ...}`` for the
    tray's readout, plus the record's album line and the quality tag
    (``quality.at_target``). Bit depth and sample rate are read from the file
    once and kept on the track (core/playback/audio_details.py).

GET /api/player/recent?limit=20
    ``{items: [...]}``: the player's own plays (listening history rows the web
    player wrote), newest first, in the caller's listening pile, for the
    tray's Recent tab, with the profile's podcast and audiobook plays among
    them; each item has a ``kind``. Consecutive repeats of one track show once.

GET/PUT /api/player/progress, POST /api/player/progress/lookup, GET/POST /api/player/plays
    Podcasts and audiobooks: where the profile got to, and its plays of them
    (core/playback/spoken.py). Always the session's own profile.

GET /api/library/listening-history, GET /api/library/listening-history/counts
    Library → Listening history: the Music kind (every source in the caller's
    listening pile, with the format and length read from the library track)
    and the plays per kind and range (core/playback/history.py).

All three need a profile. Tracks are read in the caller's library scope (a
track in someone else's own library is a 404), files are found through the
playback resolver (core.sample.worker.resolve_track_file, the same choke point
Sample Studio and playback use: the request names an id, never a path), and a
profile limited to clean tracks gets 403 for an explicit one, like playing it
(api/content_guard.py).
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from flask import Blueprint, jsonify, request

from core.profile_context import get_current_profile_id
from utils.logging_config import get_logger

logger = get_logger("api.player")

bp = Blueprint("player", __name__)

get_database: Optional[Callable[[], Any]] = None
_resolve_track_file: Optional[Callable[[str], Optional[str]]] = None
_streamed_from: Optional[Callable[[], Optional[str]]] = None
_image_url: Optional[Callable[[Optional[str]], Optional[str]]] = None

RECENT_DEFAULT = 20
RECENT_MAX = 50


def configure(*, get_database_, resolve_track_file_=None, streamed_from_=None, image_url_=None) -> None:
    """``resolve_track_file_(stored_path)`` finds the file on this machine;
    ``streamed_from_()`` names the media server a missing file streams from
    ("Navidrome"), or None; ``image_url_(url)`` makes stored art browser-safe."""
    global get_database, _resolve_track_file, _streamed_from, _image_url
    get_database = get_database_
    _resolve_track_file = resolve_track_file_
    _streamed_from = streamed_from_
    _image_url = image_url_


def _resolve(stored: Optional[str]) -> Optional[str]:
    if not stored:
        return None
    resolver = _resolve_track_file
    if resolver is None:
        from core.sample.worker import resolve_track_file as resolver
    try:
        return resolver(stored)
    except Exception as exc:  # noqa: BLE001 - unresolvable is "not on this machine"
        logger.debug("couldn't resolve %s: %s", stored, exc)
        return None


def _profile_required():
    return jsonify({"success": False, "error": "profile_required"}), 401


def _track_or_error(track_id: str):
    """(row, None) or (None, error response)."""
    from core.playback.audio_details import track_row
    from core.sample.ids import track_key

    try:
        key = track_key(track_id)
    except ValueError:
        return None, (jsonify({"success": False, "error": "bad_track_id"}), 400)
    try:
        row = track_row(get_database(), key)
    except Exception as exc:  # noqa: BLE001
        logger.error("player track lookup failed for %s: %s", track_id, exc, exc_info=True)
        return None, (jsonify({"success": False, "error": "lookup_failed"}), 500)
    if row is None:
        return None, (jsonify({"success": False, "error": "not_found",
                               "message": "That track isn't in your library."}), 404)
    return row, None


def _duration_s(row: Dict[str, Any]) -> Optional[float]:
    ms = row.get("duration")
    return round(ms / 1000, 3) if isinstance(ms, (int, float)) and ms > 0 else None


@bp.route("/api/library/tracks/<track_id>/peaks", methods=["GET"])
def get_track_peaks(track_id):
    if get_current_profile_id() is None:
        return _profile_required()
    row, error = _track_or_error(track_id)
    if error:
        return error
    from core.playback import peaks as _peaks

    path = _resolve(row.get("file_path"))
    try:
        result = _peaks.peaks_for_track(get_database(), str(row["id"]), path, _duration_s(row))
    except Exception as exc:  # noqa: BLE001
        logger.error("waveform lookup failed for %s: %s", track_id, exc, exc_info=True)
        return jsonify({"success": False, "error": "lookup_failed"}), 500
    if result["state"] == "pending":
        response = jsonify({"success": True, "pending": True, "retry_after": 2})
        response.status_code = 202
        response.headers["Retry-After"] = "2"
        response.headers["Cache-Control"] = "no-store"
        return response
    body = {"success": True, "peaks": result.get("peaks"), "duration_s": result.get("duration_s")}
    if result["state"] == "failed":
        body["reason"] = result.get("reason")
    response = jsonify(body)
    # ready peaks only change when the file does, and the url names the track
    response.headers["Cache-Control"] = "private, max-age=300" if result["state"] == "ready" else "no-store"
    return response


def _quality_for(row: Dict[str, Any], details: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """{"at_target": bool, "target_name": str} against the current quality
    target, judged like the artist page's tag (extension + stored bitrate)."""
    from core.quality import presets as _presets

    path = row.get("file_path") or ""
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    try:
        current = _presets.current_target(get_database())
    except Exception as exc:  # noqa: BLE001 - no tag beats a wrong one
        logger.debug("quality target unreadable: %s", exc)
        return None
    targets = current.get("targets") or []
    if not targets or not ext:
        return None
    aq = _presets.audio_quality(ext, int(details.get("bitrate_kbps") or 0))
    if aq.format == "unknown":
        return None
    return {"at_target": bool(_presets.meets_targets(aq, targets)), "target_name": current.get("name")}


@bp.route("/api/library/tracks/<track_id>/details", methods=["GET"])
def get_track_details(track_id):
    if get_current_profile_id() is None:
        return _profile_required()
    row, error = _track_or_error(track_id)
    if error:
        return error
    from core.playback.audio_details import details_for

    path = _resolve(row.get("file_path"))
    streamed = None
    if not path and _streamed_from is not None:
        try:
            streamed = _streamed_from()
        except Exception:  # noqa: BLE001
            streamed = None
    try:
        details = details_for(get_database(), row, path, streamed_from=streamed)
    except Exception as exc:  # noqa: BLE001
        logger.error("track details failed for %s: %s", track_id, exc, exc_info=True)
        return jsonify({"success": False, "error": "details_failed"}), 500
    details["quality"] = _quality_for(row, details)
    thumb = row.get("album_thumb")
    details["image_url"] = (_image_url(thumb) if _image_url else thumb) if thumb else None
    return jsonify({"success": True, **details})


def _recent_rows(db, owner: int, limit: int, hide_explicit: bool) -> List[Dict[str, Any]]:
    from core.listening_scope import owner_clause
    from core.playback.play_log import WEB_PLAYER_SOURCE

    conn = db._get_connection()
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(tracks)").fetchall()}
        al_cols = {row[1] for row in conn.execute("PRAGMA table_info(albums)").fetchall()}
        t_explicit = "t.explicit" if "explicit" in cols else "NULL"
        a_explicit = "al.explicit" if "explicit" in al_cols else "NULL"
        rows = conn.execute(
            f"""
            SELECT lh.title, lh.artist, lh.album, lh.played_at, lh.duration_ms,
                   t.id AS track_id, t.file_path, t.artist_id, t.album_id, t.bitrate,
                   t.duration AS track_duration, al.thumb_url,
                   {t_explicit} AS t_explicit, {a_explicit} AS a_explicit
            FROM listening_history lh
            -- CAST keeps tracks' primary key usable (see core/stats/queries.py)
            LEFT JOIN tracks t ON t.id = CAST(lh.db_track_id AS TEXT)
            LEFT JOIN albums al ON al.id = t.album_id
            WHERE {owner_clause(owner, 'lh')} AND lh.server_source = ?
            ORDER BY lh.played_at DESC, lh.id DESC
            LIMIT ?
            """,
            (WEB_PLAYER_SOURCE, limit * 3),
        ).fetchall()
    finally:
        conn.close()

    from core.content_filter import is_explicit
    from core.playback.audio_details import format_key, format_label

    items: List[Dict[str, Any]] = []
    last_key = None
    for r in rows:
        if hide_explicit and (is_explicit(r["t_explicit"]) or is_explicit(r["a_explicit"])):
            continue
        key = (r["track_id"] or "", (r["title"] or "").lower(), (r["artist"] or "").lower())
        if key == last_key:
            continue
        last_key = key
        duration_ms = r["track_duration"] or r["duration_ms"] or 0
        thumb = r["thumb_url"]
        items.append({
            "kind": "music",
            "track_id": r["track_id"],
            "title": r["title"],
            "artist": r["artist"],
            "album": r["album"],
            "played_at": r["played_at"],
            "file_path": r["file_path"],
            "artist_id": r["artist_id"],
            "album_id": r["album_id"],
            "bitrate": r["bitrate"],
            "duration_s": round(duration_ms / 1000, 3) if duration_ms else None,
            "format": format_label(format_key(r["file_path"])),
            "image_url": (_image_url(thumb) if _image_url else thumb) if thumb else None,
        })
        if len(items) >= limit:
            break
    return items


def _spoken_recent(db, pid: int, limit: int) -> List[Dict[str, Any]]:
    from core.playback import spoken

    try:
        return spoken.recent_plays(db, pid, spoken.KINDS, limit)
    except Exception as exc:  # noqa: BLE001 - music's Recent still shows
        logger.debug("spoken-word recent failed: %s", exc)
        return []


def _merge_recent(music: List[Dict[str, Any]], spoken_items: List[Dict[str, Any]], limit: int):
    """Newest first across kinds (both stamps are UTC 'YYYY-MM-DD HH:MM:SS')."""
    merged = sorted(music + spoken_items, key=lambda i: str(i.get("played_at") or ""), reverse=True)
    return merged[:limit]


@bp.route("/api/player/recent", methods=["GET"])
def get_player_recent():
    pid = get_current_profile_id()
    if pid is None:
        return _profile_required()
    try:
        limit = int(request.args.get("limit", RECENT_DEFAULT))
    except (TypeError, ValueError):
        limit = RECENT_DEFAULT
    limit = max(1, min(RECENT_MAX, limit))
    try:
        from core.content_filter import current_restrictions
        from core.listening_scope import listening_owner

        db = get_database()
        hide = bool(current_restrictions().get("hide_explicit"))
        items = _recent_rows(db, listening_owner(db, pid), limit, hide)
        # every kind (HANDOFF 46): episodes and audiobooks are this profile's own
        items = _merge_recent(items, _spoken_recent(db, int(pid), limit), limit)
    except Exception as exc:  # noqa: BLE001
        logger.error("player recent failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't load what you played recently"}), 500
    response = jsonify({"success": True, "items": items})
    response.headers["Cache-Control"] = "no-store"
    return response


# ── podcasts and audiobooks (HANDOFF 46) ────────────────────────────────────
# Where this profile got to in an episode or an audiobook, and its plays of
# them. The profile is always the session's own: a header, query or body
# profile id is never read, so nobody reaches another profile's rows.

def _spoken_error(exc):
    return jsonify({"success": False, "error": str(exc)}), 400


@bp.route("/api/player/progress", methods=["GET"])
def get_spoken_progress():
    """One item's progress (``?kind=&id=``), for the player starting it."""
    from core.playback import spoken

    pid = get_current_profile_id()
    if pid is None:
        return _profile_required()
    try:
        items = spoken.get_progress(get_database(), int(pid), request.args.get("kind"),
                                    [request.args.get("id") or ""])
    except spoken.SpokenError as exc:
        return _spoken_error(exc)
    response = jsonify({"success": True, "items": items})
    response.headers["Cache-Control"] = "no-store"
    return response


@bp.route("/api/player/progress/lookup", methods=["POST"])
def lookup_spoken_progress():
    """Progress for a page of items (``{kind, ids: [...]}``, up to 100): a POST
    because episode ids are often whole addresses, too long for a query."""
    from core.playback import spoken

    pid = get_current_profile_id()
    if pid is None:
        return _profile_required()
    body = request.get_json(silent=True) or {}
    ids = body.get("ids") if isinstance(body, dict) else None
    if not isinstance(ids, list) or not ids:
        return jsonify({"success": False, "error": "Send the ids to look up."}), 400
    if len(ids) > spoken.MAX_IDS:
        return jsonify({"success": False, "error": f"Ask for {spoken.MAX_IDS} items or fewer."}), 400
    try:
        items = spoken.get_progress(get_database(), int(pid), body.get("kind"), [str(i) for i in ids])
    except spoken.SpokenError as exc:
        return _spoken_error(exc)
    response = jsonify({"success": True, "items": items})
    response.headers["Cache-Control"] = "no-store"
    return response


@bp.route("/api/player/progress", methods=["PUT", "POST"])
def put_spoken_progress():
    """PUT from the player while it plays; POST is the same, for
    navigator.sendBeacon when the page is closing."""
    from core.playback import spoken

    pid = get_current_profile_id()
    if pid is None:
        return _profile_required()
    body = request.get_json(silent=True, force=True)
    if not isinstance(body, dict):
        return jsonify({"success": False, "error": "Send the item and its position."}), 400
    try:
        progress = spoken.save_progress(get_database(), int(pid), body.get("kind"), body.get("media_id"),
                                        body.get("position_s"), body.get("duration_s"),
                                        ended=bool(body.get("ended")))
    except spoken.SpokenError as exc:
        return _spoken_error(exc)
    return jsonify({"success": True, "progress": progress})


@bp.route("/api/player/plays", methods=["POST"])
def log_spoken_play():
    from core.playback import spoken

    pid = get_current_profile_id()
    if pid is None:
        return _profile_required()
    try:
        play_id = spoken.log_play(get_database(), int(pid), request.get_json(silent=True) or {})
    except spoken.SpokenError as exc:
        return _spoken_error(exc)
    return jsonify({"success": True, "play_id": play_id})


@bp.route("/api/player/plays", methods=["GET"])
def list_spoken_plays():
    """Library → Listening history's Podcasts and Audiobooks. With ``range``
    (today, 7d, 30d, all), a page of that range: ``tz``, ``q`` and ``offset``
    apply, and the answer adds ``total`` and ``days``."""
    from core.playback import history, spoken

    pid = get_current_profile_id()
    if pid is None:
        return _profile_required()
    a = request.args
    try:
        limit = int(a.get("limit", 50))
    except (TypeError, ValueError):
        limit = 50
    try:
        if "range" not in a:
            items = spoken.recent_plays(get_database(), int(pid), [a.get("kind")], limit)
            body = {"items": items}
        else:
            range_key = history.clean_range(a.get("range"))
            tz = history.clean_tz(a.get("tz"))
            try:
                offset = max(0, int(a.get("offset", 0)))
            except (TypeError, ValueError):
                offset = 0
            body = spoken.plays_page(get_database(), int(pid), [a.get("kind")], limit=limit, offset=offset,
                                     since=history.since_stamp(range_key, tz), q=a.get("q") or "", tz=tz,
                                     with_total=True)
            body.update({"range": range_key, "offset": offset})
    except spoken.SpokenError as exc:
        return _spoken_error(exc)
    response = jsonify({"success": True, **body})
    response.headers["Cache-Control"] = "no-store"
    return response


# ── Library → Listening history (board 13a, HANDOFF 64) ────────────────────

def _hide_explicit() -> bool:
    from core.content_filter import current_restrictions

    try:
        return bool(current_restrictions().get("hide_explicit"))
    except Exception:  # noqa: BLE001 - unreadable restrictions: the guard decides elsewhere
        return False


@bp.route("/api/library/listening-history", methods=["GET"])
def get_listening_history():
    """The Music kind: every play in the caller's listening pile, newest
    first (``range``, ``tz``, ``q``, ``offset``, ``limit``)."""
    from core.playback import history

    pid = get_current_profile_id()
    if pid is None:
        return _profile_required()
    a = request.args
    try:
        body = history.music_page(get_database(), int(pid), range_key=a.get("range"), tz=a.get("tz"),
                                  q=a.get("q"), offset=a.get("offset"), limit=a.get("limit"),
                                  hide_explicit=_hide_explicit(), image_url=_image_url)
    except Exception as exc:  # noqa: BLE001
        logger.error("listening history failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't load what you played"}), 500
    response = jsonify({"success": True, **body})
    response.headers["Cache-Control"] = "no-store"
    return response


@bp.route("/api/library/listening-history/counts", methods=["GET"])
def get_listening_history_counts():
    """Plays per kind (music, podcast, audiobook) and per range, in one ask."""
    from core.playback import history

    pid = get_current_profile_id()
    if pid is None:
        return _profile_required()
    try:
        counts = history.counts(get_database(), int(pid), tz=request.args.get("tz"),
                                hide_explicit=_hide_explicit())
    except Exception as exc:  # noqa: BLE001
        logger.error("listening history counts failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't count what you played"}), 500
    response = jsonify({"success": True, "counts": counts})
    response.headers["Cache-Control"] = "no-store"
    return response


def create_blueprint():
    return bp


__all__ = ["bp", "configure", "create_blueprint", "RECENT_DEFAULT", "RECENT_MAX"]
