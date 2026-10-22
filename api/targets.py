"""Home's targets and the quality-target dialog's numbers.

GET /api/targets/summary
    The four targets in fixed order (wanted, mirrored, followed, quality); see
    core/targets/summary.py for where each number comes from. Profile-scoped
    (Wanted, mirrors, followed artists, automations) and library-scoped
    (quality). Never probes slskd: it reads the check /status already caches.

GET /api/quality/presets
    For each preset (mp3_320, flac, flac_24, lossless) how many library tracks
    already meet it, out of how many, plus the current target (the default
    quality profile) and when that profile was last saved.

GET /api/quality/artist/<artist_id>
    One library artist's albums against the current target: per album, its
    tracks with a file, how many are below the target, and the formats held.
    The artist page's "Below quality target" tag. Read-only, any profile.
"""

from __future__ import annotations

from flask import Blueprint, jsonify

from core.profile_context import get_current_profile_id
from core.quality import presets as _presets
from core.targets import summary as _summary
from utils.logging_config import get_logger

logger = get_logger("api.targets")

bp = Blueprint("targets", __name__)

get_database = None
download_source_state = None


def configure(*, get_database_, download_source_state_=None) -> None:
    """``download_source_state_()`` returns the cached check of the download
    source: ``{"connected": bool, "checked_at": unix seconds, "source": mode}``."""
    global get_database, download_source_state
    get_database = get_database_
    download_source_state = download_source_state_


@bp.route("/api/targets/summary", methods=["GET"])
def get_targets_summary():
    pid = get_current_profile_id()
    if pid is None:
        return jsonify({"success": False, "error": "profile_required"}), 401
    try:
        data = _summary.build_summary(get_database(), int(pid), download_source=download_source_state)
    except Exception as exc:  # noqa: BLE001
        logger.error("targets summary failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't work out your targets"}), 500
    response = jsonify({"success": True, **data})
    response.headers["Cache-Control"] = "no-store"
    return response


@bp.route("/api/quality/presets", methods=["GET"])
def get_quality_presets():
    if get_current_profile_id() is None:
        return jsonify({"success": False, "error": "profile_required"}), 401
    try:
        data = _presets.preset_counts(get_database())
    except Exception as exc:  # noqa: BLE001
        logger.error("quality preset counts failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't count your library's quality"}), 500
    return jsonify({"success": True, **data})


@bp.route("/api/quality/artist/<artist_id>", methods=["GET"])
def get_artist_quality(artist_id):
    if get_current_profile_id() is None:
        return jsonify({"success": False, "error": "profile_required"}), 401
    try:
        data = _presets.artist_album_quality(get_database(), artist_id)
    except Exception as exc:  # noqa: BLE001
        logger.error("artist quality failed for %s: %s", artist_id, exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't check this artist's quality"}), 500
    if data is None:
        return jsonify({"success": False, "error": "Artist not found in the library"}), 404
    return jsonify({"success": True, **data})


def create_blueprint():
    return bp


__all__ = ["bp", "configure", "create_blueprint"]
