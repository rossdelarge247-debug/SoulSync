"""Quarantine explained: grouped by verdict, one song's tries, bulk actions
and the AcoustID re-check (Downloads → Quarantine, design boards 10 and 11).

Every read here comes from the shared quarantine snapshot
(core.imports.quarantine_index), whose entries carry their verdict
(core.imports.quarantine_verdict): no folder walk and no sidecar read per
request. The one exception is a song opened from a link, which reads that
song's few files as they are now (as the existing list's ``?entry=`` does).

Routes (admin only):

* ``GET  /api/quarantine/explained/overview``: counts per verdict with an
  example, AcoustID's state, the re-check's progress, a keep-best in progress.
* ``GET  /api/quarantine/explained/songs?kind=&limit=&offset=``: the songs
  with a try of that verdict, each with all its tries and its best one.
* ``GET  /api/quarantine/explained/song?entry=<id>``: one song's tries.
* ``POST /api/quarantine/explained/bulk/preview`` ``{kind, action}``: a plan
  (``delete`` for cut off / broken, ``keep_best`` for right song / longer
  version) with its counts and a sample. Deletes nothing.
* ``POST /api/quarantine/explained/bulk/confirm`` ``{plan_id, action}``: runs
  exactly that plan (a delete at once; keep-best in the background).
* ``POST /api/quarantine/explained/bulk/cancel``: stops a keep-best between songs.
* ``GET  /api/quarantine/explained/recheck`` and ``POST`` ``{action: start |
  pause | resume | cancel}``: the AcoustID re-check.

The existing quarantine routes (api/quarantine.py) are unchanged; the page
still uses them for one file's Keep, Delete and Play.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any, Dict, List, Optional

from flask import Blueprint, jsonify, request

from core.profile_context import admin_only
from utils.logging_config import get_logger

logger = get_logger("api.quarantine_explained")

bp = Blueprint("quarantine_explained", __name__)

#: AcoustID's availability is checked at most this often (it can look for fpcalc)
_ACOUSTID_TTL = 60.0
_acoustid_cache: Dict[str, Any] = {"at": 0.0, "value": None}
_acoustid_lock = threading.Lock()
_runner = None
_runner_lock = threading.Lock()

#: the order the overview lists verdicts in (boards 10 and 11)
KIND_ORDER = ("right_song", "longer_version", "shorter_or_cut", "cut_off", "broken",
              "different_song", "other")
SETTINGS_URL = "/settings?tab=connections"


def _q():
    """The existing quarantine module, configured at start-up (its folder,
    config and the import pipeline)."""
    from api import quarantine
    return quarantine


def _folder() -> str:
    return _q()._get_quarantine_dir()


def _snapshot():
    from core.imports.quarantine_index import shared_index
    return shared_index().peek(_folder())


def _acoustid_state() -> Dict[str, Any]:
    from core.imports.quarantine_recheck import DbStateStore, key_refused
    now = time.monotonic()
    with _acoustid_lock:
        cached = _acoustid_cache["value"]
        if cached is None or now - _acoustid_cache["at"] >= _ACOUSTID_TTL:
            try:
                from core.acoustid_verification import AcoustIDVerification
                ok, why = AcoustIDVerification().quick_check_available()
            except Exception as exc:  # noqa: BLE001
                ok, why = False, str(exc)
            cached = {"available": bool(ok), "reason": str(why or "")}
            _acoustid_cache.update(at=now, value=cached)
    refused = key_refused(DbStateStore().get())
    return {**cached, "refused": refused, "working": cached["available"] and not refused,
            "settings_url": SETTINGS_URL}


def _runner_instance():
    global _runner
    with _runner_lock:
        if _runner is None:
            from core.imports.quarantine_bulk import KeepBestRunner
            _runner = KeepBestRunner(approve=_approve_entry, delete=_delete_entry,
                                     size_of=_size_of)
        return _runner


def _size_of(name: str) -> Optional[int]:
    try:
        return os.path.getsize(os.path.join(_folder(), name))
    except OSError:
        return None


def _delete_entry(entry_id: str) -> bool:
    from core.imports.quarantine import delete_quarantine_entry
    return bool(delete_quarantine_entry(_folder(), entry_id))


def _approve_entry(entry_id: str) -> bool:
    """Keep one file exactly as the approve route does
    (core.imports.quarantine_approve: the owning task found and completed
    through the verification wrapper, a retry for the track cancelled), run
    here and now, one song at a time. Its siblings are the plan's to delete."""
    from core.imports.quarantine_approve import approve_and_import
    q = _q()
    restore_dir = os.path.join(
        q.docker_resolve_path(q.config_manager.get("soulseek.download_path", "./downloads")),
        "Transfer")
    result = approve_and_import(
        _folder(), entry_id, restore_dir,
        post_process=q._post_process_matched_download,
        post_process_with_verification=q._post_process_matched_download_with_verification,
        download_tasks=q.download_tasks, tasks_lock=q.tasks_lock)
    if result is None:  # an older entry without its import context
        return False
    logger.info("[Quarantine] Kept %s (the best of its song)", entry_id)
    return True


def _not_ready():
    return jsonify({"success": True, "ready": False})


# ── reads ─────────────────────────────────────────────────────────────────


@bp.route("/api/quarantine/explained/overview", methods=["GET"])
@admin_only
def explained_overview():
    try:
        from core.imports.quarantine_bulk import overview
        from core.imports.quarantine_index import count_songs
        from core.imports.quarantine_recheck import needs_recheck, shared_job
        snap = _snapshot()
        acoustid = _acoustid_state()
        recheck = shared_job(_q().config_manager).status()
        runner = _runner_instance()
        if snap is None:
            return jsonify({"success": True, "ready": False, "acoustid": acoustid,
                            "recheck": recheck, "keep_best": runner.snapshot()})
        records = list(snap.records)
        groups = sorted(overview(records),
                        key=lambda g: KIND_ORDER.index(g["kind"]) if g["kind"] in KIND_ORDER else 99)
        return jsonify({
            "success": True, "ready": True, "files": len(records), "songs": count_songs(records),
            "groups": groups, "acoustid": acoustid,
            "recheck": {**recheck, "pending": sum(1 for r in records if needs_recheck(r))},
            "keep_best": runner.snapshot(),
        })
    except Exception as exc:
        logger.error("[Quarantine] overview failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


def _int_arg(name: str, default: int, *, low: int, high: int) -> int:
    raw = request.args.get(name)
    if raw is None or not raw.isdigit():
        return default
    return max(low, min(high, int(raw)))


@bp.route("/api/quarantine/explained/songs", methods=["GET"])
@admin_only
def explained_songs():
    try:
        from core.imports.quarantine_bulk import songs_for_kind
        from core.imports.quarantine_library import annotate_quarantine_library
        kind = request.args.get("kind") or None
        if kind is not None and kind not in KIND_ORDER:
            return jsonify({"success": False, "error": f"unknown kind: {kind}"}), 400
        limit = _int_arg("limit", 25, low=1, high=100)
        offset = _int_arg("offset", 0, low=0, high=10**9)
        snap = _snapshot()
        if snap is None:
            return _not_ready()
        songs = songs_for_kind(list(snap.records), kind)
        window = songs[offset:offset + limit]
        entries = [entry for song in window for entry in song["tries"]]
        annotate_quarantine_library(entries, _folder(), _q().config_manager)
        return jsonify({"success": True, "ready": True, "kind": kind, "total": len(songs),
                        "offset": offset, "limit": limit, "songs": window})
    except Exception as exc:
        logger.error("[Quarantine] songs failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@bp.route("/api/quarantine/explained/song", methods=["GET"])
@admin_only
def explained_song():
    try:
        from core.imports.quarantine_bulk import song_view
        from core.imports.quarantine_index import shared_index
        from core.imports.quarantine_library import annotate_quarantine_library
        entry_id = request.args.get("entry") or ""
        if not entry_id:
            return jsonify({"success": False, "error": "entry is required"}), 400
        # the song as it is now (a person followed a link to it)
        group = shared_index().fresh_group(_folder(), entry_id)
        if not group:
            return jsonify({"success": True, "song": None, "entry": entry_id})
        view = song_view(group[0].group_key or f"id:{entry_id}", list(group))
        annotate_quarantine_library(view["tries"], _folder(), _q().config_manager)
        return jsonify({"success": True, "song": view, "entry": entry_id})
    except Exception as exc:
        logger.error("[Quarantine] song failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


# ── bulk actions ──────────────────────────────────────────────────────────


@bp.route("/api/quarantine/explained/bulk/preview", methods=["POST"])
@admin_only
def explained_bulk_preview():
    from core.imports.quarantine_bulk import (
        GROUP_DELETE_TOOL, KEEP_BEST_TOOL, delete_plan_items, keep_best_plan_items, plan_counts)
    from core.library.action_plans import plan_store
    try:
        payload = request.get_json(silent=True) or {}
        kind = str(payload.get("kind") or "")
        action = str(payload.get("action") or "")
        snap = _snapshot()
        if snap is None:
            return _not_ready()
        records = list(snap.records)
        try:
            if action == "delete":
                items, tool = delete_plan_items(_folder(), records, kind), GROUP_DELETE_TOOL
            elif action == "keep_best":
                items, tool = keep_best_plan_items(records, kind), KEEP_BEST_TOOL
            else:
                return jsonify({"success": False, "error": "action is delete or keep_best"}), 400
        except ValueError as exc:
            return jsonify({"success": False, "error": str(exc)}), 400
        counts = plan_counts(items)
        if not items:
            return jsonify({"success": True, "plan_id": None, "action": action, "kind": kind,
                            **counts, "sample": []})
        plan = plan_store.create(tool, items, meta={"kind": kind, "action": action})
        sample = [i for i in items if i.get("kind") in ("file", "song")][:8]
        return jsonify({"success": True, "plan_id": plan.plan_id, "action": action, "kind": kind,
                        "expires_in_seconds": plan.summary()["expires_in_seconds"],
                        **counts, "sample": sample})
    except Exception as exc:
        logger.error("[Quarantine] bulk preview failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@bp.route("/api/quarantine/explained/bulk/confirm", methods=["POST"])
@admin_only
def explained_bulk_confirm():
    from core.imports.quarantine_bulk import GROUP_DELETE_TOOL, KEEP_BEST_TOOL
    from core.library.action_plans import PlanError, plan_store
    try:
        payload = request.get_json(silent=True) or {}
        action = str(payload.get("action") or "")
        tool = {"delete": GROUP_DELETE_TOOL, "keep_best": KEEP_BEST_TOOL}.get(action)
        if tool is None:
            return jsonify({"success": False, "error": "action is delete or keep_best"}), 400
        runner = _runner_instance()
        if action == "keep_best" and runner.running():
            return jsonify({"success": False, "code": "busy",
                            "error": "Already keeping the best of another group."}), 409
        try:
            plan = plan_store.consume(payload.get("plan_id"), tool)
        except PlanError as exc:
            return jsonify({"success": False, "code": exc.code, "error": exc.message}), 409
        if action == "delete":
            from core.imports.quarantine_bulk import delete_planned
            snap = _snapshot()
            current = ({r.filename: str((r.entry.get("explained") or {}).get("kind") or "other")
                        for r in snap.records} if snap is not None else {})
            result = delete_planned(_folder(), plan.items, current)
            files = result["files_removed"]
            logger.info("[Quarantine] Deleted %s file(s) of %s (planned; %s changed since, "
                        "%s gone or changed size)", files, plan.meta.get("kind"),
                        result["changed"], result["skipped"])
            message = f"Deleted {files} file{'s' if files != 1 else ''}."
            if result["changed"]:
                message += (f" {result['changed']} left: "
                            "AcoustID's re-check put them in another group since.")
            return jsonify({"success": True, **result, "message": message})
        runner.start(plan.items)
        return jsonify({"success": True, "started": True, "songs": len(plan.items)})
    except Exception as exc:
        logger.error("[Quarantine] bulk confirm failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


@bp.route("/api/quarantine/explained/bulk/cancel", methods=["POST"])
@admin_only
def explained_bulk_cancel():
    _runner_instance().cancel()
    return jsonify({"success": True})


# ── the AcoustID re-check ─────────────────────────────────────────────────


@bp.route("/api/quarantine/explained/recheck", methods=["GET", "POST"])
@admin_only
def explained_recheck():
    try:
        from core.imports.quarantine_recheck import shared_job
        job = shared_job(_q().config_manager)
        if request.method == "POST":
            action = str((request.get_json(silent=True) or {}).get("action") or "")
            if action == "start":
                result = job.start()
                if not result.get("started") and result.get("reason") == "acoustid_unavailable":
                    return jsonify({"success": False, "code": "acoustid_unavailable",
                                    "error": result.get("detail") or "AcoustID isn't working"}), 409
            elif action == "pause":
                job.pause()
            elif action == "resume":
                job.resume()
            elif action == "cancel":
                job.cancel()
            else:
                return jsonify({"success": False,
                                "error": "action is start, pause, resume or cancel"}), 400
        return jsonify({"success": True, "recheck": job.status()})
    except Exception as exc:
        logger.error("[Quarantine] re-check failed: %s", exc)
        return jsonify({"success": False, "error": str(exc)}), 500


def create_blueprint() -> Blueprint:
    return bp


__all__ = ["bp", "create_blueprint"]
