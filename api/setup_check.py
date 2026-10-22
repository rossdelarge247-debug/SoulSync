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
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import closing

from flask import Blueprint, jsonify, request

from core import setup_check
from core.profile_context import admin_only
from utils.logging_config import get_logger

logger = get_logger("api.setup_check")

SETUP_CHECK_PATH = "/api/setup/check"

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
    response = jsonify({"success": True, **report})
    response.headers["Cache-Control"] = "no-store"
    return response


def create_blueprint():
    return bp


__all__ = ["SETUP_CHECK_PATH", "configure", "create_blueprint", "feature_in_use", "video_paths_from_db"]
