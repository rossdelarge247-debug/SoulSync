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
PUT /api/quality/target
    Admin only. Makes a preset the target by writing its ladder into the
    default quality profile (core/quality/presets.py apply_preset), the same
    profile Settings → Quality edits. Answers with the presets payload.
"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from core.profile_context import admin_only, get_current_profile_id
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

@bp.route("/api/quality/target", methods=["PUT"])
@admin_only
def put_quality_target():
    """Body: ``{"preset": "flac", "upgrade_existing": true, "based_on": 1773446400}``.

    ``based_on`` (optional) is the ``current.updated_at`` the dialog showed;
    when the profile was saved since, nothing changes and the answer is
    ``409 target_changed``.
    """
    data = request.get_json(silent=True) or {}
    key = data.get("preset")
    if key not in _presets.PRESET_LADDERS:
        return jsonify({"success": False, "error": "unknown_preset",
                        "message": "Choose MP3 320, FLAC, FLAC 24-bit or Any lossless."}), 400
    based_on = data.get("based_on")
    if based_on is not None:
        try:
            based_on = float(based_on)
        except (TypeError, ValueError):
            return jsonify({"success": False, "error": "bad_based_on",
                            "message": "based_on must be the target's updated_at."}), 400
    try:
        body = _presets.apply_preset(get_database(), key, upgrade_existing=bool(data.get("upgrade_existing")),
                                     based_on=based_on)
    except _presets.TargetChanged:
        return jsonify({"success": False, "error": "target_changed",
                        "message": "The quality target was changed somewhere else while this was open. "
                                   "Nothing was saved."}), 409
    except LookupError as exc:
        logger.error("quality target write failed: %s", exc)
        return jsonify({"success": False, "error": "no_profile",
                        "message": "SoulSync couldn't find its default quality profile, so nothing changed."}), 500
    except Exception as exc:  # noqa: BLE001
        logger.error("quality target write failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "write_failed",
                        "message": "SoulSync couldn't save the target. Nothing changed."}), 500
    # Home's Quality card reads the new bar now, not in 30 seconds
    _summary.clear_cache()
    return jsonify({"success": True, **body})


def create_blueprint():
    return bp


__all__ = ["bp", "configure", "create_blueprint"]
