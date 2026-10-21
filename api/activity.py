"""The Activity feed (core/activity/feed.py).

GET /api/activity
    Query: ``range`` (today | 7d | 30d, default 7d), ``kind`` (all | download
    | import | automation | sync | safety | needs_you), ``limit`` (1-200,
    default 50), ``before`` (``next_before`` from the previous page, or unix
    seconds), ``since`` (unix seconds; overrides the range start, e.g. the
    browser's own midnight for "today", at most 31 days back).

    Scoped like the histories it reads: downloads and imports are the shared
    library's; auto-import rows need the Import page; automation runs are the
    profile's automations plus the system ones; mirror runs and playlist syncs
    are the profile's; preview outcomes are admins' or the previewer's.

    Response::

        {"success": true, "range": "7d", "since": 1792000000, "kind": "all",
         "items": [{"id", "time", "kind", "status", "title", "detail", "link",
                    "needs_you", "has_log"?, "retry_at"?, "ref"?}, ...],
         "next_before": "…" | null,
         "counts": {"download": n, "import": n, "automation": n, "sync": n,
                    "safety": n, "needs_you": n},
         "running_count": n, "needs_you": [item, ...], "generated_at": 1792570000}

    Reading the feed also records any preview that has expired since the last
    look (core/activity/safety_log.py), so it shows up without waiting.

GET /api/activity/status
    The navigation badges, cheap enough to poll from every page:
    ``{"success", "running_count", "needs_you_count", "generated_at"}``. Same
    visibility as the feed; builds no list and no per-kind counts.

GET /api/activity/log/<item_id>
    The full log of one automation run (``automation:<run id>``) or mirror run
    (``mirror:<run id>``) the viewer can see: ``{"success", "id", "log_lines"}``.

POST /api/activity/dismiss
    ``{"id": "safety:<n>"}`` closes an expired preview the viewer can see, so
    it leaves "Needs you". Everything else in "Needs you" clears when the
    thing itself is dealt with.
"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from core.activity import feed as _feed
from core.activity import safety_log
from core.permissions import page_denied
from core.profile_context import get_current_profile_id, is_admin_request
from utils.logging_config import get_logger

logger = get_logger("api.activity")

bp = Blueprint("activity", __name__)

get_database = None


def configure(*, get_database_, record_plan_events: bool = True) -> None:
    global get_database
    get_database = get_database_
    if record_plan_events:
        safety_log.install(lambda: get_database())


def _viewer():
    pid = get_current_profile_id()
    if pid is None:
        return None
    admin = bool(is_admin_request())
    can_imports = True
    if not admin:
        profile = get_database().get_profile(int(pid)) or {}
        can_imports = not page_denied("/api/auto-import", profile.get("allowed_pages"), False)
    return _feed.Viewer(profile_id=int(pid), is_admin=admin, can_see_imports=can_imports)


def _no_profile():
    return jsonify({"success": False, "error": "profile_required"}), 401


def _int_arg(name, default=None):
    raw = request.args.get(name)
    if raw in (None, ""):
        return default
    try:
        return int(float(raw))
    except (ValueError, OverflowError) as exc:
        raise ValueError(f"{name} must be a number") from exc


@bp.route("/api/activity", methods=["GET"])
def get_activity():
    viewer = _viewer()
    if viewer is None:
        return _no_profile()
    _sweep_plans()
    try:
        data = _feed.build_feed(
            get_database(), viewer,
            range_key=(request.args.get("range") or _feed.DEFAULT_RANGE).strip().lower(),
            kind=(request.args.get("kind") or "").strip().lower() or None,
            limit=_int_arg("limit", _feed.DEFAULT_LIMIT),
            before=request.args.get("before"),
            since=_int_arg("since"),
        )
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        logger.error("activity feed failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't load activity"}), 500
    response = jsonify({"success": True, **data})
    response.headers["Cache-Control"] = "no-store"
    return response


def _sweep_plans() -> None:
    try:
        from core.library.action_plans import plan_store
        plan_store.sweep()
    except Exception as exc:  # noqa: BLE001 - recording expiries is best-effort
        logger.debug("plan sweep failed: %s", exc)


@bp.route("/api/activity/status", methods=["GET"])
def get_activity_status():
    viewer = _viewer()
    if viewer is None:
        return _no_profile()
    _sweep_plans()
    try:
        data = _feed.build_status(get_database(), viewer)
    except Exception as exc:  # noqa: BLE001
        logger.error("activity status failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't load activity"}), 500
    response = jsonify({"success": True, **data})
    response.headers["Cache-Control"] = "no-store"
    return response


@bp.route("/api/activity/log/<item_id>", methods=["GET"])
def get_activity_log(item_id):
    viewer = _viewer()
    if viewer is None:
        return _no_profile()
    lines = _feed.get_log(get_database(), viewer, item_id)
    if lines is None:
        return jsonify({"success": False, "error": "No log for that item"}), 404
    return jsonify({"success": True, "id": item_id, "log_lines": lines})


@bp.route("/api/activity/dismiss", methods=["POST"])
def dismiss_activity_item():
    viewer = _viewer()
    if viewer is None:
        return _no_profile()
    item_id = str((request.get_json(silent=True) or {}).get("id") or "")
    prefix, _, raw = item_id.partition(":")
    if prefix != "safety" or not raw.isdigit():
        return jsonify({"success": False, "error": "Only expired previews can be dismissed; "
                                                   "everything else clears when it's dealt with."}), 400
    if not safety_log.dismiss(get_database(), int(raw), profile_id=viewer.profile_id, is_admin=viewer.is_admin):
        return jsonify({"success": False, "error": "Nothing to dismiss with that id"}), 404
    return jsonify({"success": True, "id": item_id})


def create_blueprint():
    return bp


__all__ = ["bp", "configure", "create_blueprint"]
