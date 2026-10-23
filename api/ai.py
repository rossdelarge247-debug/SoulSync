"""The Automation Assistant's routes (docs/design/CONTRACTS.md, "The Assistant").

GET  /api/ai/status                      everyone: can this profile use it, and why not
GET  /api/ai/settings                    admins: Settings → AI (the key is write-only)
PUT  /api/ai/settings                    admins
POST /api/ai/test                        admins: test a key without spending tokens
POST /api/ai/assistant                   the conversation, as server-sent events
GET  /api/ai/suggestion                  the list's suggestion card (worked out locally)
POST /api/ai/suggestion/<key>/dismiss    "Not now", per profile

The Assistant writes drafts only: nothing here saves, runs, enables or tests
an automation, or sends a notification. Wired in web_server.py beside the
automation routes.
"""

from __future__ import annotations

import os

from flask import Blueprint, Response, jsonify, request

from core.ai import assistant as ai_assistant
from core.ai import config as ai_config
from core.ai import store
from core.ai import suggestions as ai_suggestions
from core.automation import blocks as _blocks
from core.profile_context import admin_only, get_current_profile_id, is_admin_request
from utils.logging_config import get_logger

logger = get_logger("api.ai")

bp = Blueprint("ai", __name__)

# injected by configure()
get_database = None
config_manager = None
docker_resolve_path = None
provider_factory = ai_assistant.default_provider_factory

SCRIPT_EXTENSIONS = {".sh", ".py", ".bat", ".ps1", ".rb", ".pl", ".js"}


def configure(*, get_database_, config_manager_, docker_resolve_path_=None, provider_factory_=None) -> None:
    global get_database, config_manager, docker_resolve_path, provider_factory
    get_database = get_database_
    config_manager = config_manager_
    docker_resolve_path = docker_resolve_path_ or (lambda p: p)
    if provider_factory_ is not None:
        provider_factory = provider_factory_


def _actor() -> str:
    """Who did it, for "added by ross": the profile's name."""
    pid = get_current_profile_id()
    try:
        profile = get_database().get_profile(int(pid)) if pid is not None else None
    except Exception:  # noqa: BLE001
        profile = None
    return str((profile or {}).get("name") or ("admin" if pid == 1 else f"profile {pid}"))


def _list_scripts():
    """Script names in the scripts folder, as /api/scripts lists them."""
    path = docker_resolve_path(config_manager.get("scripts.path", "./scripts")) if config_manager else None
    if not path or not os.path.isdir(path):
        return []
    names = []
    for name in sorted(os.listdir(path)):
        full = os.path.join(path, name)
        if os.path.isfile(full) and (os.path.splitext(name)[1].lower() in SCRIPT_EXTENSIONS
                                     or os.access(full, os.X_OK)):
            names.append(name)
    return names


@bp.route("/api/ai/status", methods=["GET"])
def ai_status():
    pid = get_current_profile_id()
    if pid is None:
        return jsonify({"success": False, "error": "profile_required"}), 401
    try:
        return jsonify(ai_assistant.status(config_manager, get_database(), is_admin=bool(is_admin_request())))
    except Exception as exc:  # noqa: BLE001
        logger.error("AI status failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read the Assistant's settings."}), 500


def _settings_payload():
    database = get_database()
    status = ai_assistant.status(config_manager, database, is_admin=True)
    usage = dict(status.get("usage") or {})
    # per profile, for the table Settings → AI shows once everyone may use it
    # (HANDOFF 39); admins only, as this whole payload is
    if usage:
        usage["profiles"] = store.profile_usage(database, usage.get("month"))
    return {"success": True, "settings": ai_config.public_settings(config_manager),
            "usage": usage or None, **ai_config.catalogue()}


@bp.route("/api/ai/settings", methods=["GET"])
@admin_only
def get_ai_settings():
    try:
        return jsonify(_settings_payload())
    except Exception as exc:  # noqa: BLE001
        logger.error("AI settings read failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read Settings → AI."}), 500


@bp.route("/api/ai/settings", methods=["PUT"])
@admin_only
def put_ai_settings():
    body = request.get_json(silent=True)
    try:
        ai_config.save_settings(config_manager, body, actor=_actor())
    except ai_config.SettingsError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        logger.error("AI settings save failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't save Settings → AI. Nothing was changed."}), 500
    return jsonify(_settings_payload())


@bp.route("/api/ai/test", methods=["POST"])
@admin_only
def test_ai_key():
    """Test the key in the body (a new one, not saved yet) or the saved one.
    Only a test of the saved key changes its status line."""
    body = request.get_json(silent=True) or {}
    posted = body.get("api_key") if isinstance(body, dict) else None
    key = posted.strip() if isinstance(posted, str) and posted.strip() else ai_config.api_key(config_manager)
    if not key:
        return jsonify({"ok": False, "message": "Add an API key first."}), 400
    model = ai_config.MODELS.get(str(body.get("model") or ""), None) if isinstance(body, dict) else None
    model_id = model["id"] if model else ai_config.model_id(config_manager)
    try:
        ok, message = provider_factory(key, model_id).test_key()
    except Exception as exc:  # noqa: BLE001
        logger.warning("AI key test failed unexpectedly: %s", type(exc).__name__)
        ok, message = False, "The test didn't run. Try again."
    saved = key == ai_config.api_key(config_manager)
    key_status = (ai_config.record_key_test(config_manager, ok=ok, message=message, actor=_actor())
                  if saved else None)
    return jsonify({"ok": ok, "message": message, "saved_key": saved, "key_status": key_status})


@bp.route("/api/ai/assistant", methods=["POST"])
def ai_assistant_stream():
    pid = get_current_profile_id()
    if pid is None:
        return jsonify({"success": False, "error": "profile_required"}), 401
    admin = bool(is_admin_request())
    database = get_database()
    st = ai_assistant.status(config_manager, database, is_admin=admin)
    if st["reason"] in ("not_configured", "members_not_allowed", "key_refused"):
        return jsonify({"success": False, "error": st["reason"], "reason": st["reason"]}), 403
    try:
        req = ai_assistant.parse_request(request.get_json(silent=True), profile_id=int(pid),
                                         is_admin=admin, actor=_actor())
    except ai_assistant.RequestError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    blocks = _blocks.blocks_for_scope("music")
    events = ai_assistant.run(req, database=database, config=config_manager, blocks=blocks,
                              list_scripts=_list_scripts if admin else None,
                              provider_factory=provider_factory)
    response = Response(events, mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Accel-Buffering"] = "no"   # a reverse proxy mustn't hold events back
    return response


@bp.route("/api/ai/suggestion", methods=["GET"])
def ai_suggestion():
    pid = get_current_profile_id()
    if pid is None:
        return jsonify({"success": False, "error": "profile_required"}), 401
    admin = bool(is_admin_request())
    database = get_database()
    try:
        if not ai_assistant.status(config_manager, database, is_admin=admin)["can_use"]:
            return jsonify({"success": True, "suggestion": None})
        item = ai_suggestions.pick(database, profile_id=int(pid), is_admin=admin)
    except Exception as exc:  # noqa: BLE001
        logger.error("AI suggestion failed: %s", exc, exc_info=True)
        return jsonify({"success": True, "suggestion": None})
    return jsonify({"success": True, "suggestion": item})


@bp.route("/api/ai/suggestion/<key>/dismiss", methods=["POST"])
def ai_dismiss_suggestion(key):
    pid = get_current_profile_id()
    if pid is None:
        return jsonify({"success": False, "error": "profile_required"}), 401
    if not ai_suggestions.valid_key(key):
        return jsonify({"success": False, "error": "Unknown suggestion"}), 404
    ok = store.dismiss(get_database(), int(pid), key)
    return jsonify({"success": ok}), (200 if ok else 500)


def create_blueprint() -> Blueprint:
    return bp
