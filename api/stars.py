"""Stars (BACKLOG "Star tracks and mix sets"; boards 28a–28d; CONTRACTS.md
"Stars"). Code: core/stars/store.py.

POST /api/stars              {track_ids: [...]} (up to 500): star them. Only
                             library tracks in the caller's scope with their
                             file present; the rest come back in left_out
                             with a reason (not_in_library | file_missing).
POST /api/stars/remove       {track_ids: [...]}: take the caller's star off.
GET  /api/stars/count        The Starred chip's number (and how many of them
                             have no file now).
POST /api/stars/status       {track_ids?: [...], songs?: [{title, artist}]}
                             (up to 500 each): for a page of rows at once,
                             whether each is starred and whether it can be
                             (a library track with its file). ``songs`` are a
                             playlist's rows, matched to library tracks first.

Every route needs a profile. Stars are the caller's own, admins included:
no route reads or changes another profile's. Bodies are read with a hard
size cap. Tracks the Starred filter lists come from
``GET /api/library/dj/browse?starred=1`` (api/dj.py).
"""

from __future__ import annotations

from typing import Optional

from flask import Blueprint, jsonify

from api.dj import _read_json_capped
from core.profile_context import get_current_profile_id
from utils.logging_config import get_logger

logger = get_logger("api.stars")

bp = Blueprint("stars", __name__)

get_database = None

#: 500 ids of up to 128 characters, or 500 title-and-artist pairs, fit well under this
MAX_BODY = 192 * 1024


def configure(*, get_database_) -> None:
    global get_database
    get_database = get_database_


def create_blueprint():
    return bp


def _profile() -> Optional[int]:
    pid = get_current_profile_id()
    return int(pid) if pid is not None else None


def _bad(message: str, status: int = 400):
    return jsonify({"success": False, "error": message}), status


def _ok(payload: dict):
    response = jsonify({"success": True, **payload})
    response.headers["Cache-Control"] = "no-store"
    return response


def _body():
    body, refused = _read_json_capped(MAX_BODY)
    if refused is not None:
        return None, refused
    if not isinstance(body, dict):
        return None, _bad("Send it as JSON")
    return body, None


def _failed(what: str, exc: Exception):
    logger.error("Stars: %s failed: %s", what, exc, exc_info=True)
    return _bad("Couldn't read your stars just now", 500)


def _ids_from(body):
    from core.stars import store

    try:
        ids = store.clean_ids(body.get("track_ids"))
    except store.StarError as exc:
        return None, _bad(str(exc))
    if not ids:
        return None, _bad("track_ids must name at least one track")
    return ids, None


@bp.route("/api/stars", methods=["POST"])
def star():
    pid = _profile()
    if pid is None:
        return _bad("profile_required", 401)
    body, refused = _body()
    if refused is not None:
        return refused
    ids, refused = _ids_from(body)
    if refused is not None:
        return refused
    from core.stars import store

    try:
        done = store.star(get_database(), pid, ids)
        counted = store.count(get_database(), pid)
    except store.StarError as exc:
        return _bad(str(exc))
    except Exception as exc:  # noqa: BLE001
        return _failed("star", exc)
    if not done["starred"]:
        reason = done["left_out"][0]["reason"] if done["left_out"] else "not_in_library"
        said = ("Its file isn't on this computer, so it can't be starred."
                if reason == "file_missing" else "Only tracks in your library can be starred.")
        return jsonify({"success": False, "error": said, "left_out": done["left_out"]}), 409
    return _ok({**done, **counted})


@bp.route("/api/stars/remove", methods=["POST"])
def unstar():
    pid = _profile()
    if pid is None:
        return _bad("profile_required", 401)
    body, refused = _body()
    if refused is not None:
        return refused
    ids, refused = _ids_from(body)
    if refused is not None:
        return refused
    from core.stars import store

    try:
        removed = store.unstar(get_database(), pid, ids)
        counted = store.count(get_database(), pid)
    except Exception as exc:  # noqa: BLE001
        return _failed("unstar", exc)
    return _ok({"unstarred": removed, **counted})


@bp.route("/api/stars/count", methods=["GET"])
def count():
    pid = _profile()
    if pid is None:
        return _bad("profile_required", 401)
    from core.stars import store

    try:
        return _ok(store.count(get_database(), pid))
    except Exception as exc:  # noqa: BLE001
        return _failed("count", exc)


@bp.route("/api/stars/status", methods=["POST"])
def status():
    pid = _profile()
    if pid is None:
        return _bad("profile_required", 401)
    body, refused = _body()
    if refused is not None:
        return refused
    from core.stars import store

    raw_ids = body.get("track_ids", [])
    raw_songs = body.get("songs", [])
    if not isinstance(raw_songs, list) or len(raw_songs) > store.MAX_SONGS:
        return _bad(f"songs must be a list of at most {store.MAX_SONGS}")
    try:
        ids = store.clean_ids(raw_ids)
    except store.StarError as exc:
        return _bad(str(exc))
    songs = [s if isinstance(s, dict) else {} for s in raw_songs]
    database = get_database()
    try:
        matched = store.resolve_songs(database, songs) if songs else []
        # looked up apart, so 500 ids and 500 songs never cut each other off
        found = store.status(database, pid, ids) if ids else {}
        found_songs = store.status(database, pid, [m for m in matched if m]) if matched else {}
    except Exception as exc:  # noqa: BLE001
        return _failed("status", exc)
    tracks = {i: found.get(i, {"starred": False, "can_star": False}) for i in ids}
    found = {**found_songs, **found}
    return _ok({"tracks": tracks,
                "songs": [{"track_id": m, **(found.get(m) if m else {"starred": False, "can_star": False})}
                          for m in matched]})


__all__ = ["bp", "configure", "create_blueprint"]
