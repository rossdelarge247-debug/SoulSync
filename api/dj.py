"""The library's DJ data: BPM, key (Camelot) and energy (BACKLOG "DJ area",
stage 1). Code: core/dj/.

GET  /api/library/dj/status
    The analysis: settings, how far through the library it is, the running
    sweep or the last one, and whether this profile may start or stop it.
POST /api/library/dj/start  (admins)
    Start a sweep now (also lifts a Stop's hold on the automatic sweeps).
    202 with the sweep; 409 when one runs or every track is done. With
    ``{track_id}`` ("analyse it now", 17b) that track goes first, or next
    when a sweep already runs (202 then too, ``queued: true``).
POST /api/library/dj/stop   (admins)
    Stop the sweep; automatic sweeps wait for a restart or a Start.
POST /api/library/dj/tracks
    ``{track_ids: [...]}`` (up to 500) -> ``{tracks: {id: dj}}``: the track
    rows' BPM and key, for any page that lists library tracks.
GET  /api/library/dj/browse
    Library → Tracks: tracks with a file, ``bpm_min``, ``bpm_max``, ``key``
    (a Camelot code or any key spelling; ``8A:mix`` adds the keys that mix
    with it), ``q``, ``sort`` (bpm | key | energy | title | artist | recent),
    ``page``, ``limit`` (50, at most 200). ``keys`` in the answer is what the
    key filter covered, in the count line's order ("8A, 7A, 9A or 8B").
GET  /api/library/dj/mixes/<track_id>
    "Mixes well with…": the same key, ±1 on the Camelot wheel or the relative
    major/minor, at a BPM within ±6% (half and double time count);
    ``within`` (percent, 1–12) widens or narrows the tempo window.

Every route needs a profile and reads the caller's library scope, like the
other library routes.
"""

from __future__ import annotations

from typing import Any, Optional

from flask import Blueprint, jsonify, request

from core.profile_context import admin_only, get_current_profile_id
from utils.logging_config import get_logger

logger = get_logger("api.dj")

bp = Blueprint("library_dj", __name__)

get_database = None
fix_art_url = None


def configure(*, get_database_, fix_art_url_=None) -> None:
    global get_database, fix_art_url
    get_database = get_database_
    fix_art_url = fix_art_url_


def _no_profile():
    return jsonify({"success": False, "error": "profile_required"}), 401


def _float(name: str) -> Optional[float]:
    raw = request.args.get(name)
    if raw in (None, ""):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if 0 < value < 1000 else None


def _int(name: str, default: int) -> int:
    try:
        return int(request.args.get(name) or default)
    except (TypeError, ValueError):
        return default


def _no_store(payload: Any, status: int = 200):
    response = jsonify(payload)
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    return response


@bp.route("/api/library/dj/status", methods=["GET"])
def dj_status():
    if get_current_profile_id() is None:
        return _no_profile()
    from core.dj import store, worker
    from core.profile_context import is_admin_request

    database = get_database()
    try:
        counts = store.counts(database, worker.analyzer_version())
        job = worker.public_state(database)
    except Exception as exc:  # noqa: BLE001
        logger.error("DJ status failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    admin = bool(is_admin_request())
    return _no_store({"success": True, "settings": worker.settings_state(), "counts": counts, "job": job,
                      "held": worker.JOB.held, "analyzer_version": worker.analyzer_version(),
                      "can_start": admin, "can_stop": admin})


@bp.route("/api/library/dj/start", methods=["POST"])
@admin_only
def dj_start():
    from core.dj import worker

    database = get_database()
    body = request.get_json(silent=True) or {}
    first = body.get("track_id") if isinstance(body, dict) else None
    first = str(first)[:128] if isinstance(first, (str, int)) and str(first) else None
    if first is not None and worker.JOB.prioritise(first):
        return _no_store({"success": True, "queued": True, "job": worker.public_state(database)}, 202)
    try:
        state = worker.JOB.start(database, get_current_profile_id() or 1, manual=True, first=first)
    except worker.JobRunning as exc:
        if first is not None and worker.JOB.prioritise(first):
            return _no_store({"success": True, "queued": True, "job": worker.public_state(database)}, 202)
        return jsonify({"success": False, "error": str(exc)}), 409
    if state is None:
        return jsonify({"success": False, "error": "Every track already has its BPM, key and energy."}), 409
    return _no_store({"success": True, "job": worker.public_state(database)}, 202)


@bp.route("/api/library/dj/stop", methods=["POST"])
@admin_only
def dj_stop():
    from core.dj import worker

    if not worker.JOB.stop(by_person=True):
        return jsonify({"success": False, "error": "Nothing is working out BPM, key and energy right now."}), 409
    return jsonify({"success": True})


@bp.route("/api/library/dj/tracks", methods=["POST"])
def dj_tracks():
    if get_current_profile_id() is None:
        return _no_profile()
    body = request.get_json(silent=True) or {}
    ids = body.get("track_ids")
    if not isinstance(ids, list):
        return jsonify({"success": False, "error": "track_ids must be a list"}), 400
    if len(ids) > 500:
        return jsonify({"success": False, "error": "At most 500 tracks at a time"}), 400
    from core.dj import store

    try:
        tracks = store.lookup(get_database(), [str(t) for t in ids if isinstance(t, (str, int))])
    except Exception as exc:  # noqa: BLE001
        logger.error("DJ lookup failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    return jsonify({"success": True, "tracks": tracks})


@bp.route("/api/library/dj/browse", methods=["GET"])
def dj_browse():
    if get_current_profile_id() is None:
        return _no_profile()
    from core.dj import store

    bpm_min, bpm_max = _float("bpm_min"), _float("bpm_max")
    if bpm_min is not None and bpm_max is not None and bpm_min > bpm_max:
        bpm_min, bpm_max = bpm_max, bpm_min
    try:
        page = store.browse(get_database(), bpm_min=bpm_min, bpm_max=bpm_max,
                            key=(request.args.get("key") or "")[:12], q=(request.args.get("q") or "")[:200],
                            sort=request.args.get("sort") or "bpm", page=_int("page", 1), limit=_int("limit", 50),
                            fix_art=fix_art_url)
    except Exception as exc:  # noqa: BLE001
        logger.error("DJ browse failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    return jsonify({"success": True, **page, "bpm_min": bpm_min, "bpm_max": bpm_max,
                    "key": request.args.get("key") or ""})


@bp.route("/api/library/dj/mixes/<track_id>", methods=["GET"])
def dj_mixes(track_id: str):
    if get_current_profile_id() is None:
        return _no_profile()
    from core.dj import store

    try:
        within = _float("within")
        tolerance = within / 100 if within is not None else store.BPM_TOLERANCE
        result = store.mixes_with(get_database(), str(track_id)[:128], limit=_int("limit", 50),
                                  fix_art=fix_art_url, tolerance=tolerance)
    except Exception as exc:  # noqa: BLE001
        logger.error("Mixes well with failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    if result.get("track") is None:
        return jsonify({"success": False, "error": "That track isn't in your library"}), 404
    return jsonify({"success": True, **result})


def create_blueprint():
    return bp


__all__ = ["bp", "configure", "create_blueprint"]
