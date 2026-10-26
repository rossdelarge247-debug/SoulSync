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
    Each track says whether the caller starred it (``starred``);
    ``starred=1`` (the Starred filter) keeps only the caller's starred
    tracks, a starred one whose file is gone included (``file_missing``).
GET  /api/library/dj/mixes/<track_id>
    "Mixes well with…": the same key, ±1 on the Camelot wheel or the relative
    major/minor, at a BPM within ±6% (half and double time count);
    ``within`` (percent, 1–12) widens or narrows the tempo window.
    The Mix tab (29a) adds ``rank=mix`` (its order: a starred boost, not
    played recently, style closeness; core/dj/ranking.py), ``set_id`` (one
    of the caller's sets: its tracks left out, its energy direction
    followed; implies ``rank=mix``), ``wide=1`` (10% and any key) and
    ``limit`` (5 by default then). Without them the answer is as before.
POST /api/library/dj/mixes/<track_id>/vibe
    Vibe (29a): the ranked top 20 re-ordered for feel by the AI provider
    (core/dj/vibe.py); 403 with ``code`` when the AI is off for this profile
    or at its limit, 429 ``busy``. Counts against the profile's AI usage.
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
    source: playlist | tracks | mixes, playlist_id | track_ids (≤ 1000, with
    an optional name and ``left_out``: a set's lines that aren't in the
    library, ``[{title, artist}]``) | track_id (+ within), overwrite?}``. ``preview`` answers the counts, the
    Mac path, what was left out and why; ``download`` answers the ``.nml`` as
    an attachment; ``save`` (admins) writes it into the export folder (409
    ``exists`` unless ``overwrite``, with ``exists_at``). For admins the
    preview's ``folder.exists_at`` is when a file of that name already in the
    export folder was written (else null). A track the caller starred is
    written with Traktor's top rating (``RANKING="255"``); the preview's
    ``starred`` counts them. Code: core/dj/traktor.py.

Every route needs a profile and reads the caller's library scope, like the
other library routes.
"""

from __future__ import annotations

import math
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
    text = str(raw).strip()
    # "nan" (any case) would compare false with everything: refuse it outright
    if text.lower().lstrip("+-") in ("nan", "inf", "infinity"):
        return None
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) and 0 < value < 1000 else None


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
                            fix_art=fix_art_url, profile_id=int(get_current_profile_id()),
                            starred=request.args.get("starred") in ("1", "true"))
    except Exception as exc:  # noqa: BLE001
        logger.error("DJ browse failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    return jsonify({"success": True, **page, "bpm_min": bpm_min, "bpm_max": bpm_max,
                    "key": request.args.get("key") or ""})


def _mix_ranked() -> bool:
    """The Mix tab's order was asked for (``rank=mix``, or a ``set_id``)."""
    return request.args.get("rank") == "mix" or bool(request.args.get("set_id"))


def _set_id_arg() -> Optional[int]:
    raw = (request.args.get("set_id") or "").strip()
    if not raw or not raw.isdigit() or len(raw) > 15:
        return None
    return int(raw)


@bp.route("/api/library/dj/mixes/<track_id>", methods=["GET"])
def dj_mixes(track_id: str):
    if get_current_profile_id() is None:
        return _no_profile()
    from core.dj import store

    try:
        within = _float("within")
        tolerance = within / 100 if within is not None else store.BPM_TOLERANCE
        if _mix_ranked():
            from core.dj import ranking

            result = ranking.rank(get_database(), str(track_id)[:128], profile_id=int(get_current_profile_id()),
                                  set_id=_set_id_arg(), limit=_int("limit", ranking.TAB_LIMIT),
                                  wide=request.args.get("wide") in ("1", "true"), tolerance=tolerance,
                                  fix_art=fix_art_url)
        else:
            result = store.mixes_with(get_database(), str(track_id)[:128], limit=_int("limit", 50),
                                      fix_art=fix_art_url, tolerance=tolerance)
    except Exception as exc:  # noqa: BLE001
        logger.error("Mixes well with failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    if result.get("track") is None:
        return jsonify({"success": False, "error": "That track isn't in your library"}), 404
    return jsonify({"success": True, **result})


#: Vibe's request body: a set id and a flag fit in far less
MAX_VIBE_BODY = 4 * 1024
#: tests swap the provider here (core.ai.assistant.default_provider_factory when None)
vibe_provider_factory = None

_VIBE_STATUS = {"not_configured": 403, "members_not_allowed": 403, "key_refused": 403, "cap_reached": 403,
                "busy": 429, "rate_limited": 429, "offline": 503}


@bp.route("/api/library/dj/mixes/<track_id>/vibe", methods=["POST"])
def dj_mixes_vibe(track_id: str):
    """Vibe (29a): the Mix tab's top 20 re-ranked for feel by the AI.
    ``{set_id?, wide?, limit?}``; answers the ranked route's shape with the
    AI's order and ``vibe: {line}``. Counts against the profile's AI usage."""
    pid = get_current_profile_id()
    if pid is None:
        return _no_profile()
    body, refused = _read_json_capped(MAX_VIBE_BODY)
    if refused is not None:
        return refused
    if body is None:
        body = {}
    if not isinstance(body, dict):
        return jsonify({"success": False, "error": "Send it as JSON"}), 400
    from core.dj import ranking, vibe
    from core.settings import config_manager

    raw_set = body.get("set_id")
    set_id = raw_set if isinstance(raw_set, int) and not isinstance(raw_set, bool) and raw_set > 0 else None
    raw_limit = body.get("limit")
    limit = raw_limit if isinstance(raw_limit, int) and not isinstance(raw_limit, bool) else ranking.TAB_LIMIT
    limit = max(1, min(vibe.TOP, limit))
    database = get_database()
    try:
        found = ranking.rank(database, str(track_id)[:128], profile_id=int(pid), set_id=set_id, limit=vibe.TOP,
                             wide=body.get("wide") is True, fix_art=fix_art_url)
    except Exception as exc:  # noqa: BLE001
        logger.error("Vibe's ranking failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    if found.get("track") is None:
        return jsonify({"success": False, "error": "That track isn't in your library"}), 404
    heading = (found.get("set") or {}).get("direction")
    try:
        answer = vibe.rerank(database, config_manager, profile_id=int(pid), is_admin=_is_admin(),
                             seed=found["track"], candidates=found["matches"], heading=heading,
                             provider_factory=vibe_provider_factory)
    except vibe.VibeError as exc:
        return jsonify({"success": False, "code": exc.code, "error": exc.message}), _VIBE_STATUS.get(exc.code, 502)
    except Exception as exc:  # noqa: BLE001
        logger.error("Vibe failed: %s", type(exc).__name__)
        return jsonify({"success": False, "code": "provider_error",
                        "error": "The AI couldn't order these. Code's order stands."}), 502
    return _no_store({"success": True, **found, "matches": answer["matches"][:limit],
                      "vibe": {"line": answer["line"], "usage": answer["usage"]}})


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


#: the card's fields that name folders on the server or the Mac: admins only
_ADMIN_ONLY_FIELDS = ("mac_path", "mac_path_from_helper", "library_folder", "export_folder", "export_folder_on_mac")


def _traktor_state() -> dict:
    """The card's state. A member sees whether things are set, not where: the
    folder fields go to admins only."""
    from core.dj import traktor

    state = traktor.settings_state()
    admin = bool(_is_admin())
    if not admin:
        state = {k: v for k, v in state.items() if k not in _ADMIN_ONLY_FIELDS}
        full = traktor.settings_state()
        state["mac_path_set"] = bool(full["mac_path"] or full["mac_path_from_helper"])
        state["mac_path_from_helper_set"] = bool(full["mac_path_from_helper"])
    return {**state, "can_edit": admin}


def _read_json_capped(limit: int):
    """The JSON body, read with a hard limit even when it comes chunked (no
    Content-Length): at most ``limit + 1`` bytes are ever read. ``(body,
    None)`` or ``(None, response)``; a body that isn't JSON reads as None."""
    import json

    too_big = (jsonify({"success": False, "error": "That request is too big"}), 413)
    if request.content_length is not None and request.content_length > limit:
        return None, too_big
    raw = request.stream.read(limit + 1)
    if len(raw) > limit:
        return None, too_big
    if not request.is_json or not raw:
        return None, None
    try:
        return json.loads(raw), None
    except ValueError:
        return None, None


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

    body, refused = _read_json_capped(MAX_EXPORT_BODY)
    if refused is not None:
        return refused
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
        # a set's lines that aren't in the library (Missing, IDs), named in
        # the dialog's Left out box: words only, nothing is looked up for them
        extra = body.get("left_out")
        if isinstance(extra, list):
            for line in extra[:traktor.MAX_TRACKS]:
                if isinstance(line, dict):
                    missing.append((None, traktor.xml_text(str(line.get("title") or ""), 300).strip(),
                                    traktor.xml_text(str(line.get("artist") or ""), 300).strip()))
        name = body.get("name") if isinstance(body.get("name"), str) else ""
        name = traktor.xml_text(name, 200).strip() or f"SYNCHRO.S tracks {time.strftime('%Y-%m-%d')}"
        return name, [(t, t["title"], t["artist_name"]) for t in tracks] + missing, 0
    if source == "mixes":
        seed = body.get("track_id")
        if not isinstance(seed, (str, int)) or not str(seed):
            return jsonify({"success": False, "error": "track_id is needed"}), 400
        raw_within = body.get("within")
        within = float(raw_within) if isinstance(raw_within, (int, float)) and not isinstance(raw_within, bool) else 6.0
        if not math.isfinite(within):
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


def _starred_count(database, entries) -> int:
    """How many of the export's tracks the caller starred (rated in Traktor)."""
    try:
        from core.stars import store as stars

        return len(stars.starred_among(database, int(get_current_profile_id()),
                                       [e["track"].get("id") for e in entries]))
    except Exception as exc:  # noqa: BLE001 - the count is a nicety
        logger.debug("starred count unreadable: %s", exc)
        return 0


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
    body, refused = _read_json_capped(MAX_EXPORT_BODY)
    if refused is not None:
        return refused
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
        preview = {
            "success": True, "name": name, "filename": filename, "counts": planned["counts"],
            # the caller's own first track, as the Mac sees it
            "example_path": entries[0]["mac_path"] if entries else None,
            "left_out": planned["left_out"][:50], "reasons": reasons,
            "keys": sum(1 for e in entries if traktor.confident_key(e["track"].get("dj"))),
            "starred": _starred_count(database, entries),
            "can_edit": admin,
            "folder": {"state": state["export_folder_state"], "shown": None, "can_save": False,
                       "exists_at": None},
        }
        if admin:
            # where things are on the server and the Mac: admins only
            preview["mac_path"] = state["mac_path"] or state["mac_path_from_helper"] or None
            preview["library_folder"] = state["library_folder"]
            can_save = state["export_folder_state"] == "ok"
            preview["folder"] = {"state": state["export_folder_state"],
                                 "shown": state["export_folder_on_mac"] or state["export_folder"] or None,
                                 "can_save": can_save,
                                 # a file of this name there already: when it was written (234)
                                 "exists_at": traktor.existing_export(state["export_folder"], filename)
                                 if can_save else None}
        return _no_store(preview)
    if not planned["entries"]:
        return jsonify({"success": False, "error": "None of these tracks can go to Traktor."}), 409
    try:
        from core.stars import store as stars

        starred = stars.starred_among(database, int(get_current_profile_id()),
                                      [e["track"].get("id") for e in planned["entries"]])
    except Exception as exc:  # noqa: BLE001 - the file is right without ratings
        logger.warning("Traktor export: couldn't read stars: %s", exc)
        starred = set()
    data = traktor.build_nml(name, planned["entries"], starred=starred)
    if action == "download":
        return _attachment(data, filename)
    if not admin:
        return jsonify({"success": False, "error": "Only an admin can save into the export folder."}), 403
    folder = config_manager.get(traktor.SETTING_EXPORT_FOLDER, "") or ""
    try:
        traktor.save_to_folder(folder, filename, data, overwrite=body.get("overwrite") is True)
    except FileExistsError:
        return jsonify({"success": False, "exists": True, "filename": filename,
                        "exists_at": traktor.existing_export(folder, filename),
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
