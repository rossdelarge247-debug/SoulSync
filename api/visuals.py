"""The Visuals overlay's routes (board 10a; docs/design/CONTRACTS.md, "Visuals").

GET /api/visuals/presets?family=milkdrop&set=curated|all&keep=&q=&author=
    MilkDrop's index: ``{family, set, total, count, presets: [{key, name,
    author, full_name, size, source, curated}], kept: [...], authors: [{name,
    key, count}], own: {...}, bundled, curated, uncurated}``, A–Z by name.
    Bundled presets come from the build's copy of ``butterchurn-presets``;
    ``source: "own"`` ones from the admin's folder (core/visuals/presets.py).
    ``set`` is ``curated`` by default: the curated packs and your own (HANDOFF
    101); ``all`` adds every other bundled preset ("Every preset"). In the
    curated set, the profile's favourites and the presets ``keep`` names
    (comma-separated keys, Recent's) that the set leaves out come back in
    ``kept``. The browser asks once, when the MilkDrop family is first opened,
    and again when "Every preset" changes; ``q`` and ``author`` filter here
    too, for anything else that asks.

GET /api/visuals/presets/<key>
    One preset, fetched when it's picked and kept by the browser: a bundled
    preset's Butterchurn JSON, or one of your own as its ``.milk`` text
    (``text/plain``, converted in the browser). Unknown keys are 404.

GET /api/visuals/favourites?family=milkdrop
PUT /api/visuals/favourites/<family>/<key>
DELETE /api/visuals/favourites/<family>/<key>
    The signed-in profile's stars (``{family, keys}``, newest first;
    ``{success, favourite}`` after a change).

GET /api/visuals/settings · PUT /api/visuals/settings (admins)
    Where your own presets live: ``{own: {configured, count, problem,
    truncated, too_big, read_at}, own_presets_dir}`` (the folder only for admins); PUT
    ``{own_presets_dir: "/music/milkdrop"}`` (or ``""`` for none) after the
    folder is checked.

Every route needs a profile.
"""

from __future__ import annotations

import os
from typing import Any, Callable, Optional

from flask import Blueprint, Response, jsonify, request, send_file

from core.profile_context import get_current_profile_id, is_admin_request
from core.visuals import favourites as fav
from core.visuals import presets as P
from utils.logging_config import get_logger

logger = get_logger("api.visuals")

bp = Blueprint("visuals", __name__)

CONFIG_KEY = "visuals.own_presets_dir"
# a preset is fetched once and kept: the key names its content until the next build
PRESET_MAX_AGE = 7 * 24 * 3600
# how many keys ``keep`` may name (Recent holds 20)
KEEP_MAX = 50

get_database: Optional[Callable[[], Any]] = None
_config_manager: Any = None
_resolve_path: Optional[Callable[[str], str]] = None
_static_dir: Optional[str] = None


def configure(*, get_database_, config_manager_, static_dir_, docker_resolve_path_=None) -> None:
    global get_database, _config_manager, _resolve_path, _static_dir
    get_database = get_database_
    _config_manager = config_manager_
    _static_dir = static_dir_
    _resolve_path = docker_resolve_path_


def _profile_required():
    return jsonify({"success": False, "error": "profile_required"}), 401


def _configured_folder() -> str:
    try:
        raw = _config_manager.get(CONFIG_KEY, "") if _config_manager is not None else ""
    except Exception:  # noqa: BLE001 - unreadable config is "not set up"
        raw = ""
    raw = str(raw or "").strip()
    if not raw:
        return ""
    if _resolve_path is not None:
        try:
            return str(_resolve_path(raw) or "")
        except Exception:  # noqa: BLE001
            return raw
    return raw


def _family_arg(value: Any) -> Optional[str]:
    family = str(value or P.FAMILY_MILKDROP).strip().lower()
    return family if family in P.FAMILIES else None


def _bad_family():
    return jsonify({"success": False, "error": "bad_family",
                    "message": "Only MilkDrop has a preset list."}), 400


@bp.route("/api/visuals/presets", methods=["GET"])
def list_presets():
    if get_current_profile_id() is None:
        return _profile_required()
    if _family_arg(request.args.get("family")) is None:
        return _bad_family()
    set_name = str(request.args.get("set") or P.SET_CURATED).strip().lower()
    if set_name not in P.SETS:
        return jsonify({"success": False, "error": "bad_set",
                        "message": "Ask for the curated presets or all of them."}), 400
    q = str(request.args.get("q") or "")[:200]
    author = str(request.args.get("author") or "")[:200]
    keep: list = []
    if set_name == P.SET_CURATED:
        keep = [k for k in str(request.args.get("keep") or "")[:2000].split(",")
                if P.BUNDLED_KEY_RE.match(k.strip())][:KEEP_MAX]
        keep.extend(_favourite_keys())
    try:
        body = P.build_index(_static_dir or "", _configured_folder(), q=q, author=author,
                             set_name=set_name, keep=keep)
    except Exception as exc:  # noqa: BLE001
        logger.error("visuals preset index failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "index_failed",
                        "message": "The preset list couldn't be read. Try again."}), 500
    body["success"] = True
    return jsonify(body)


def _favourite_keys() -> list:
    """The signed-in profile's MilkDrop stars, for ``kept`` (none if unreadable)."""
    pid = get_current_profile_id()
    if pid is None or get_database is None:
        return []
    try:
        conn = get_database()._get_connection()
    except Exception:  # noqa: BLE001 - the list still answers
        return []
    try:
        return list(fav.list_keys(conn, pid, P.FAMILY_MILKDROP))
    except Exception:  # noqa: BLE001
        return []
    finally:
        conn.close()


@bp.route("/api/visuals/presets/<key>", methods=["GET"])
def get_preset(key):
    if get_current_profile_id() is None:
        return _profile_required()
    not_found = (jsonify({"success": False, "error": "not_found",
                          "message": "That preset isn't here any more."}), 404)
    if P.BUNDLED_KEY_RE.match(key or ""):
        path = P.bundled_file(_static_dir or "", key)
        if not path:
            return not_found
        response = send_file(path, mimetype="application/json", conditional=True, max_age=PRESET_MAX_AGE)
        response.headers["Cache-Control"] = f"private, max-age={PRESET_MAX_AGE}"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response
    if P.OWN_KEY_RE.match(key or ""):
        text = P.read_own(_configured_folder(), key)
        if text is None:
            return not_found
        response = Response(text, mimetype="text/plain")
        response.charset = "utf-8"
        response.headers["Cache-Control"] = "private, max-age=3600"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Preset-Format"] = "milk"
        return response
    return not_found


@bp.route("/api/visuals/favourites", methods=["GET"])
def list_favourites():
    pid = get_current_profile_id()
    if pid is None:
        return _profile_required()
    family = _family_arg(request.args.get("family"))
    if family is None:
        return _bad_family()
    conn = get_database()._get_connection()
    try:
        keys = fav.list_keys(conn, pid, family)
    finally:
        conn.close()
    return jsonify({"success": True, "family": family, "keys": keys})


def _change_favourite(family: str, key: str, star: bool):
    pid = get_current_profile_id()
    if pid is None:
        return _profile_required()
    conn = get_database()._get_connection()
    try:
        result = (fav.add if star else fav.remove)(conn, pid, family, key)
    except fav.FavouriteError as exc:
        status = 409 if exc.code == "too_many" else 400
        return jsonify({"success": False, "error": exc.code, "message": exc.message}), status
    finally:
        conn.close()
    return jsonify({"success": True, "family": family, "key": key, "favourite": result})


@bp.route("/api/visuals/favourites/<family>/<key>", methods=["PUT"])
def add_favourite(family, key):
    return _change_favourite(family, key, True)


@bp.route("/api/visuals/favourites/<family>/<key>", methods=["DELETE"])
def remove_favourite(family, key):
    return _change_favourite(family, key, False)


def _settings_body() -> dict:
    folder = _configured_folder()
    listing = P.own_listing(folder)
    body = {
        "success": True,
        "admin": is_admin_request(),
        "own": {**listing.summary(), "configured": bool(folder)},
    }
    if body["admin"]:
        try:
            body["own_presets_dir"] = str(_config_manager.get(CONFIG_KEY, "") or "")
        except Exception:  # noqa: BLE001
            body["own_presets_dir"] = ""
    return body


@bp.route("/api/visuals/settings", methods=["GET"])
def get_settings():
    if get_current_profile_id() is None:
        return _profile_required()
    return jsonify(_settings_body())


@bp.route("/api/visuals/settings", methods=["PUT"])
def put_settings():
    if get_current_profile_id() is None:
        return _profile_required()
    if not is_admin_request():
        return jsonify({"success": False, "error": "admin_only",
                        "message": "Only an admin can choose the presets folder."}), 403
    data = request.get_json(silent=True) or {}
    raw = data.get("own_presets_dir")
    if raw is None or not isinstance(raw, str):
        return jsonify({"success": False, "error": "bad_request",
                        "message": "Say which folder, or an empty one for none."}), 400
    raw = raw.strip()
    if len(raw) > 1024:
        return jsonify({"success": False, "error": "bad_path", "message": "That path is too long."}), 400
    if raw:
        resolved = raw
        if _resolve_path is not None:
            try:
                resolved = str(_resolve_path(raw) or raw)
            except Exception:  # noqa: BLE001
                resolved = raw
        if not os.path.isabs(resolved):
            return jsonify({"success": False, "error": "bad_path",
                            "message": "Use the folder's full path, like /music/milkdrop."}), 400
        if not os.path.isdir(resolved):
            return jsonify({"success": False, "error": "missing",
                            "message": "SYNCHRO.S can't find that folder."}), 400
        if not os.access(resolved, os.R_OK | os.X_OK):
            return jsonify({"success": False, "error": "unreadable",
                            "message": "SYNCHRO.S can't read that folder."}), 400
    _config_manager.set(CONFIG_KEY, raw)
    P.clear_caches()
    return jsonify(_settings_body())


def create_blueprint():
    return bp


__all__ = ["CONFIG_KEY", "KEEP_MAX", "bp", "configure", "create_blueprint"]
