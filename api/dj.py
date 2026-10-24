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
GET  /api/library/dj/traktor/settings
    The Settings → Library → Traktor Pro 3 card (21b): the Mac path for the
    library folder, the export folder and its state, Traktor's collection
    (said, not read yet), ``can_edit`` for admins.
PUT  /api/library/dj/traktor/settings  (admins)
    ``{mac_path?, export_folder?}``; an empty string clears one. 400 with a
    sentence for a path that isn't a Mac folder, or an export folder outside
    the configured folders, missing or not writable.
POST /api/library/dj/traktor/export
    "Export to Traktor…" (21a). ``{action: preview | download | save,
    source: playlist | tracks | mixes, playlist_id | track_ids (≤ 1000) |
    track_id (+ within), overwrite?}``. ``preview`` answers the counts, the
    Mac path, what was left out and why; ``download`` answers the ``.nml`` as
    an attachment; ``save`` (admins) writes it into the export folder (409
    ``exists`` unless ``overwrite``). Code: core/dj/traktor.py.

Every route needs a profile and reads the caller's library scope, like the
other library routes.
"""

from __future__ import annotations

import os
import time
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

    database = get_database()
    try:
        counts = store.counts(database, worker.analyzer_version())
        job = worker.public_state(database)
    except Exception as exc:  # noqa: BLE001
        logger.error("DJ status failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    admin = bool(_is_admin())
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


# ── Export to Traktor (stage 2a) ──────────────────────────────────────────────

#: the largest export request body (a thousand ids fit in well under this)
MAX_EXPORT_BODY = 64 * 1024

_FOLDER_WORDS = {
    "invalid": "That isn't a folder path SYNCHRO.S can use.",
    "outside": "The export folder has to be inside one of your music folders or Downloads.",
    "missing": "SYNCHRO.S can't find that folder. Make it first, or check the drive is connected.",
    "not_writable": "SYNCHRO.S can't write in that folder.",
    "unset": "No export folder is set, so exports download in the browser.",
}


def _is_admin() -> bool:
    from core.profile_context import is_admin_request

    return bool(is_admin_request())


def _traktor_state() -> dict:
    from core.dj import traktor

    return {**traktor.settings_state(), "can_edit": bool(_is_admin())}


@bp.route("/api/library/dj/traktor/settings", methods=["GET"])
def traktor_settings():
    if get_current_profile_id() is None:
        return _no_profile()
    try:
        state = _traktor_state()
    except Exception as exc:  # noqa: BLE001
        logger.error("Traktor settings failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read the Traktor settings"}), 500
    return _no_store({"success": True, **state})


@bp.route("/api/library/dj/traktor/settings", methods=["PUT"])
@admin_only
def traktor_settings_save():
    from core.dj import traktor
    from core.settings import config_manager

    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"success": False, "error": "Send the settings as JSON"}), 400
    updates = {}
    if "mac_path" in body:
        raw = body.get("mac_path")
        if raw in (None, ""):
            updates[traktor.SETTING_MAC_PATH] = ""
        else:
            mac = traktor.valid_mac_path(raw) if isinstance(raw, str) else None
            if not mac:
                return jsonify({"success": False, "field": "mac_path",
                                "error": "Type the folder as the Mac names it, starting with /, "
                                         "like /Volumes/Music HD/SoulSync/Transfer."}), 400
            updates[traktor.SETTING_MAC_PATH] = mac
    if "export_folder" in body:
        raw = body.get("export_folder")
        if raw in (None, ""):
            updates[traktor.SETTING_EXPORT_FOLDER] = ""
        else:
            raw = raw.strip() if isinstance(raw, str) else None
            real, state = traktor.check_export_folder(raw)
            if real is None:
                return jsonify({"success": False, "field": "export_folder",
                                "error": _FOLDER_WORDS.get(state, _FOLDER_WORDS["invalid"])}), 400
            updates[traktor.SETTING_EXPORT_FOLDER] = os.path.normpath(raw)
    for key, value in updates.items():
        config_manager.set(key, value)
    return _no_store({"success": True, **_traktor_state()})


def _export_items(database, body: dict):
    """``(name, items, over)`` for the request's source, or a response tuple."""
    from core.dj import store, traktor

    source = body.get("source")
    if source == "tracks":
        ids = body.get("track_ids")
        if not isinstance(ids, list) or not ids:
            return jsonify({"success": False, "error": "track_ids must be a list of tracks"}), 400
        if len(ids) > traktor.MAX_TRACKS:
            return jsonify({"success": False, "error": "At most 1,000 tracks at a time"}), 400
        clean = [str(t)[:128] for t in ids if isinstance(t, (str, int)) and str(t)]
        tracks = traktor.tracks_by_ids(database, clean)
        found = {t["id"] for t in tracks}
        missing = [(None, "", "") for i in dict.fromkeys(clean) if i not in found]
        name = body.get("name") if isinstance(body.get("name"), str) else ""
        name = traktor.xml_text(name, 200).strip() or f"SYNCHRO.S tracks {time.strftime('%Y-%m-%d')}"
        return name, [(t, t["title"], t["artist_name"]) for t in tracks] + missing, 0
    if source == "mixes":
        seed = body.get("track_id")
        if not isinstance(seed, (str, int)) or not str(seed):
            return jsonify({"success": False, "error": "track_id is needed"}), 400
        try:
            within = float(body.get("within") or 6)
        except (TypeError, ValueError):
            within = 6.0
        within = min(store.MAX_TOLERANCE * 100, max(1.0, within))
        found = traktor.mixes_tracks(database, str(seed)[:128], tolerance=within / 100)
        if found is None:
            return jsonify({"success": False, "error": "That track isn't in your library"}), 404
        return found["name"], [(t, t["title"], t["artist_name"]) for t in found["tracks"]], 0
    if source == "playlist":
        raw = body.get("playlist_id")
        try:
            playlist_id = int(raw)
        except (TypeError, ValueError):
            return jsonify({"success": False, "error": "playlist_id is needed"}), 400
        if isinstance(raw, bool) or playlist_id <= 0:
            return jsonify({"success": False, "error": "playlist_id is needed"}), 400
        owner = None if _is_admin() else get_current_profile_id()
        found = traktor.playlist_tracks(database, playlist_id, owner)
        if found is None:
            return jsonify({"success": False, "error": "Playlist not found"}), 404
        return found["name"], found["rows"], found["over"]
    return jsonify({"success": False, "error": "source must be playlist, tracks or mixes"}), 400


def _attachment(data: bytes, filename: str):
    from urllib.parse import quote

    from flask import Response

    from core.dj import traktor

    response = Response(data, mimetype="application/octet-stream")
    response.headers["Content-Disposition"] = (
        f'attachment; filename="{traktor.ascii_filename(filename)}"; '
        f"filename*=UTF-8''{quote(filename, safe='')}")
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@bp.route("/api/library/dj/traktor/export", methods=["POST"])
def traktor_export():
    if get_current_profile_id() is None:
        return _no_profile()
    if request.content_length is not None and request.content_length > MAX_EXPORT_BODY:
        return jsonify({"success": False, "error": "That request is too big"}), 413
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify({"success": False, "error": "Send the export as JSON"}), 400
    action = body.get("action") or "preview"
    if action not in ("preview", "download", "save"):
        return jsonify({"success": False, "error": "action must be preview, download or save"}), 400
    from core.dj import traktor
    from core.settings import config_manager

    database = get_database()
    try:
        gathered = _export_items(database, body)
        if not isinstance(gathered[0], str):
            return gathered
        name, items, over = gathered
        resolve = None
        try:
            from core.sample.worker import resolve_track_file as resolve
        except Exception:  # noqa: BLE001 - stored paths only
            resolve = None
        paths = traktor.MacPaths(traktor.library_root(), config_manager.get(traktor.SETTING_MAC_PATH, "") or None,
                                 to_host=traktor._load_to_host(), resolve=resolve)
        planned = traktor.plan(items, paths, over=over)
    except Exception as exc:  # noqa: BLE001
        logger.error("Traktor export failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    filename = traktor.safe_filename(name)
    admin = bool(_is_admin())
    if action == "preview":
        state = traktor.settings_state()
        reasons: dict = {}
        for left in planned["left_out"]:
            reasons[left["reason"]] = reasons.get(left["reason"], 0) + 1
        entries = planned["entries"]
        return _no_store({
            "success": True, "name": name, "filename": filename, "counts": planned["counts"],
            "example_path": entries[0]["mac_path"] if entries else None,
            "mac_path": state["mac_path"] or state["mac_path_from_helper"] or None,
            "library_folder": state["library_folder"],
            "left_out": planned["left_out"][:50], "reasons": reasons,
            "keys": sum(1 for e in entries if traktor.confident_key(e["track"].get("dj"))),
            "can_edit": admin,
            "folder": {"state": state["export_folder_state"],
                       "shown": state["export_folder_on_mac"] or state["export_folder"] or None,
                       "can_save": admin and state["export_folder_state"] == "ok"},
        })
    if not planned["entries"]:
        return jsonify({"success": False, "error": "None of these tracks can go to Traktor."}), 409
    data = traktor.build_nml(name, planned["entries"])
    if action == "download":
        return _attachment(data, filename)
    if not admin:
        return jsonify({"success": False, "error": "Only an admin can save into the export folder."}), 403
    folder = config_manager.get(traktor.SETTING_EXPORT_FOLDER, "") or ""
    try:
        traktor.save_to_folder(folder, filename, data, overwrite=body.get("overwrite") is True)
    except FileExistsError:
        return jsonify({"success": False, "exists": True, "filename": filename,
                        "error": f"{filename} is already in the export folder."}), 409
    except traktor.ExportFolderError as exc:
        return jsonify({"success": False, "folder_state": exc.state,
                        "error": _FOLDER_WORDS.get(exc.state, _FOLDER_WORDS["invalid"])}), 409
    except (OSError, ValueError) as exc:
        logger.error("Traktor export save failed: %s", exc)
        return jsonify({"success": False, "error": "SYNCHRO.S couldn't write the file into the export folder."}), 500
    state = traktor.settings_state()
    return _no_store({"success": True, "saved": True, "filename": filename,
                      "folder": state["export_folder_on_mac"] or state["export_folder"],
                      "counts": planned["counts"]})


def create_blueprint():
    return bp


__all__ = ["bp", "configure", "create_blueprint"]
