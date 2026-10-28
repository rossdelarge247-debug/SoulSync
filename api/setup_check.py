"""GET /api/setup/check - run the setup check (core/setup_check.py).

Admin-only: the results name folders, server addresses and the user SoulSync
runs as, the same class of detail as /api/debug-info. Read-only apart from the
check's own temp-file write test.

Query: ``scope=local`` runs only the on-disk checks (folders, folder layout,
running user) plus the settings-only "is a library chosen" warning, and skips
talking to slskd and the media server; the default runs all.

Response (always 200 when the run itself worked, whatever it found)::

    {"success": true, "status": "ok|warning|error",
     "summary": {"ok": n, "warning": n, "error": n, "skipped": n},
     "checks": [{"id", "title", "status", "detail", "fix", "category", "data"?}, ...],
     "scope": "all|local", "ran_at": <unix time>, "duration_ms": n}

GET /api/setup/privacy - the privacy check alone (core/privacy_check.py): is
the VPN up, which address peers see, the forwarded port, the kill switch.
Admin-only: it holds the VPN's and the home connection's IP addresses.

PUT /api/setup/privacy/settings - Gluetun's control address and key, and
whether the home address may be looked up (one call to an outside service,
cached for an hour). Admin-only, JSON, 4 KB at most. The key is never sent
back, only whether one is set.
"""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import closing

from flask import Blueprint, jsonify, request

from core import setup_check
from core.profile_context import admin_only
from utils.logging_config import get_logger

logger = get_logger("api.setup_check")

SETUP_CHECK_PATH = "/api/setup/check"
PRIVACY_PATH = "/api/setup/privacy"
PRIVACY_SETTINGS_PATH = "/api/setup/privacy/settings"
PRIVACY_BODY_LIMIT = 4096

bp = Blueprint("setup_check", __name__)


def video_paths_from_db():
    """The video library folders as the video Downloads settings store them,
    including the legacy single transfer folder that becomes Movies."""
    from api.video import get_video_db
    db = get_video_db()
    out = {k: db.get_setting(k) or "" for k in ("movies_path", "tv_path", "youtube_path")}
    if not out["movies_path"]:
        out["movies_path"] = db.get_setting("transfer_path") or ""
    return out


def feature_in_use(name: str) -> bool:
    """Has the user got any data for an optional feature? Decides whether its
    folder is checked when the folder is still the shipped default."""
    if name == "podcasts":
        from database.music_database import get_database
        with closing(get_database()._get_connection()) as conn:
            return conn.execute("SELECT 1 FROM watchlist_podcasts LIMIT 1").fetchone() is not None
    if name == "audiobooks":
        from core.audiobook_database import resolve_db_path
        path = resolve_db_path()
        if not os.path.exists(path):
            return False
        # read-only: the check must not create the audiobook database
        with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)) as conn:
            for table in ("audiobook_wishlist", "audiobook_library"):
                try:
                    if conn.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone():  # noqa: S608 - fixed table names
                        return True
                except sqlite3.Error:
                    continue
        return False
    return False


def configure(*, config_manager_, soulseek_client_getter=None, video_paths_getter=video_paths_from_db,
              feature_probe=feature_in_use):
    setup_check.configure(config_manager=config_manager_, video_paths=video_paths_getter,
                          feature_in_use=feature_probe, soulseek_client=soulseek_client_getter)


@bp.route(SETUP_CHECK_PATH, methods=["GET"])
@admin_only
def run_setup_check():
    scope = (request.args.get("scope") or "all").strip().lower()
    try:
        report = setup_check.run_setup_check(include_network=(scope != "local"))
    except Exception as exc:  # noqa: BLE001 - the runner already contains per-check failures
        logger.error("setup check failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": str(exc)}), 500
    if scope != "local":
        # the Assistant quotes the last full run rather than probing again
        setup_check.remember_report(report)
    response = jsonify({"success": True, **report})
    response.headers["Cache-Control"] = "no-store"
    return response


def _no_store(payload, status=200):
    response = jsonify(payload)
    response.headers["Cache-Control"] = "no-store"
    return response, status


@bp.route(PRIVACY_PATH, methods=["GET"])
@admin_only
def run_privacy_check():
    from core import privacy_check
    try:
        report = privacy_check.run_privacy_check()
    except Exception as exc:  # noqa: BLE001 - the check contains its own failures; this is a bug
        logger.error("privacy check failed: %s", exc, exc_info=True)
        return _no_store({"success": False, "error": "The privacy check couldn't run"}, 500)
    return _no_store({"success": True, **report})


def _read_json_capped(limit: int):
    """``(body, None)`` or ``(None, response)``; reads at most ``limit + 1``
    bytes even without a Content-Length."""
    too_big = _no_store({"success": False, "error": "That request is too big"}, 413)
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


@bp.route(PRIVACY_SETTINGS_PATH, methods=["PUT"])
@admin_only
def save_privacy_settings():
    from core import privacy_check
    from core.settings import config_manager

    body, refused = _read_json_capped(PRIVACY_BODY_LIMIT)
    if refused is not None:
        return refused
    if not isinstance(body, dict):
        return _no_store({"success": False, "error": "Send the settings as JSON"}, 400)
    # everything is checked before anything is written: a 400 changes nothing
    updates = {}
    clear_key = False
    if "gluetun_url" in body:
        raw = body.get("gluetun_url")
        url = privacy_check.clean_control_url(raw) if isinstance(raw, (str, type(None))) else None
        if url is None:
            return _no_store({"success": False, "field": "gluetun_url",
                              "error": "Type Gluetun's control address with http:// and its port, like "
                                       "http://gluetun:8000, with nothing after the port."}, 400)
        updates[privacy_check.SETTING_URL] = url
    if "api_key" in body:
        key = body.get("api_key")
        key = key.strip() if isinstance(key, str) else None
        if key is None or len(key) > 256 or any(not 33 <= ord(c) <= 126 for c in key):
            return _no_store({"success": False, "field": "api_key",
                              "error": "The key is the GLUETUN_API_KEY from your .env: letters and numbers, "
                                       "no spaces."}, 400)
        if key:
            updates[privacy_check.SETTING_KEY] = key
        else:
            clear_key = True
    if "home_ip_lookup" in body:
        if not isinstance(body.get("home_ip_lookup"), bool):
            return _no_store({"success": False, "field": "home_ip_lookup", "error": "home_ip_lookup is true or false"},
                             400)
        updates[privacy_check.SETTING_HOME_LOOKUP] = body["home_ip_lookup"]
    if clear_key:
        try:
            config_manager.clear_secret(privacy_check.SETTING_KEY)
        except KeyError:
            pass
    for key, value in updates.items():
        config_manager.set(key, value)
    if updates.get(privacy_check.SETTING_HOME_LOOKUP) is False:
        privacy_check.forget_home_address()
    return _no_store({"success": True, "settings": privacy_check.settings_state(setup_check.build_context())})


def create_blueprint():
    return bp


__all__ = ["SETUP_CHECK_PATH", "PRIVACY_PATH", "PRIVACY_SETTINGS_PATH", "configure", "create_blueprint", "feature_in_use", "video_paths_from_db"]
