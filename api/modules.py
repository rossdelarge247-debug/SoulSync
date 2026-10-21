"""Module switches API (core/modules.py).

  - GET /api/modules:         every module, its display name, short
                              description, enabled state, restart_required (with
                              a reason) and the shell page ids it owns. Open to
                              every signed-in profile: the shell hides a turned-
                              off module's nav entries for everyone.
  - PUT /api/modules/<name>:  {"enabled": true|false}. Admin-only. Saves the
                              switch and applies it to the running process
                              (starts or stops the module's workers); answers
                              with the module's new state.

These paths sit outside every module's API prefix, so they keep answering
while a module is off. The general POST /api/settings save does not write
``modules.*``: it would skip the start/stop step.

The page shell also gets each module's on/off state and pages when it renders
(``initial_modules``), so the sidebar can hide a turned-off module's entries
before first paint and a bookmarked module page knows straight away that it is
off, without waiting for GET /api/modules.
"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from core import modules
from core.profile_context import admin_only
from utils.logging_config import get_logger

logger = get_logger("modules.api")

bp = Blueprint("modules_api", __name__)


def create_blueprint():
    return bp


@bp.app_context_processor
def _inject_initial_modules():
    """The switches as the page shell renders: name, display name, on/off and
    pages only. The shell renders before sign-in, so descriptions and restart
    reasons stay behind GET /api/modules."""
    try:
        states = modules.list_modules()
    except Exception as exc:  # noqa: BLE001 - never break the page over this
        logger.debug("module states for the page shell failed: %s", exc)
        states = []
    return {"initial_modules": [
        {"name": s["name"], "display_name": s["display_name"],
         "enabled": s["enabled"], "pages": s["pages"]}
        for s in states
    ]}


@bp.route("/api/modules", methods=["GET"])
def list_modules():
    return jsonify({"success": True, "modules": modules.list_modules()})


@bp.route("/api/modules/<name>", methods=["PUT"])
@admin_only
def update_module(name):
    if name not in modules.MODULES:
        return jsonify({"success": False, "error": "unknown_module",
                        "message": f"There is no module called {name!r}."}), 404
    data = request.get_json(silent=True)
    enabled = data.get("enabled") if isinstance(data, dict) else None
    if not isinstance(enabled, bool):
        return jsonify({"success": False, "error": "invalid_request",
                        "message": 'Send {"enabled": true} or {"enabled": false}.'}), 400
    state = modules.set_enabled(name, enabled)
    return jsonify({"success": True, "module": state})
