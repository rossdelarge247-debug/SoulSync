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
