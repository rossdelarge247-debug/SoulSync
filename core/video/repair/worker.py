"""Video Library Maintenance worker — the music RepairWorker, cloned.

Same contract end to end: a single background thread that drains a force-run
queue first (manual "Run Now" works even when the master toggle is off), then
— when enabled — runs the stalest due job; findings dedup across runs; approve
== fix == resolved (per-finding-type dispatch to the owning job's ``fix``);
live per-job progress states pushed over ONE socket event
('video:repair:progress', payload {job_id: state}) throttled to ~1/s.

Per-job config lives in the video settings table (not the JSON config file):
  video_repair.master_enabled            -> bool
  video_repair.jobs.<job_id>             -> {"enabled", "interval_hours", "settings"}
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Callable, Optional

from core.video.repair import get_all_jobs
from core.video.repair.base import JobCancelled, JobContext, JobResult
from utils.logging_config import get_logger

logger = get_logger("video.repair")

# Fixing these moves or deletes the user's files: Watched Cleanup recycles (or,
# with recycling off, deletes) the movie's files and Naming Conformance renames
# them. A bulk run that includes either must come with a confirmed preview
# (core.library.action_plans), like the music side's DESTRUCTIVE_FINDING_TYPES.
# Every other fix only changes the wishlist, the library record or the download
# queue, and still runs straight away.
FILE_TOUCHING_FINDING_TYPES = frozenset({"watched_cleanup", "naming_mismatch"})

# Action-plan tool name for a confirmed video bulk fix.
VIDEO_REPAIR_BULK_FIX_TOOL = "video_repair_bulk_fix"

# What each other fix does, in plain words, for the preview's "What happens".
_PLAIN_EFFECTS = {
    "missing_episodes": "Adds the missing episodes to the wishlist",
    "incomplete_collection": "Adds the missing films to the wishlist",
    "quality_upgrade": "Searches for a better copy and queues it. The current file stays until the better one is imported",
    "broken_file": "Searches for a new copy and queues it",
    "metadata_gap": "Re-queues the details and artwork",
    "stale_wishlist": "Removes the entry from the wishlist",
    "youtube_mass_missing": "Raises a finding for each missing video",
    "missing_subtitles": "Queues the missing subtitles",
}

_MASTER_KEY = "video_repair.master_enabled"
_JOB_KEY = "video_repair.jobs.%s"
_LOG_LINES = 40          # rolling per-job log shown in the progress panel
_IDLE_SLEEP = 30.0       # scheduler tick


class VideoRepairWorker:
    def __init__(self, db):
        self.db = db
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._wake = threading.Event()          # run_job_now pokes the scheduler awake
        self._cancel_current = threading.Event()
        self._paused = False
        self._force_queue: list = []
        self._lock = threading.Lock()
        self._current_job_id: Optional[str] = None
        self._states: dict = {}          # job_id -> progress state (music shape)
        self._emit: Optional[Callable] = None
        self._last_emit = 0.0

    # ── config ────────────────────────────────────────────────────────────────
    def master_enabled(self) -> bool:
        v = self.db.get_setting(_MASTER_KEY)
        return str(v).lower() in ("1", "true", "yes")

    def set_master(self, enabled: bool) -> None:
        self.db.set_setting(_MASTER_KEY, "1" if enabled else "0")

    def job_config(self, job_id: str) -> dict:
        cls = get_all_jobs().get(job_id)
        if not cls:
            return {}
        cfg = {"enabled": cls.default_enabled,
               "interval_hours": cls.default_interval_hours,
               "settings": dict(cls.default_settings or {})}
        raw = self.db.get_setting(_JOB_KEY % job_id)
        if raw:
            try:
                saved = json.loads(raw) if isinstance(raw, str) else dict(raw)
                cfg["enabled"] = bool(saved.get("enabled", cfg["enabled"]))
                cfg["interval_hours"] = int(saved.get("interval_hours", cfg["interval_hours"]))
                cfg["settings"].update(saved.get("settings") or {})
            except (ValueError, TypeError):
                logger.warning("repair: bad saved config for %s — using defaults", job_id)
        return cfg

    def set_job_config(self, job_id: str, *, enabled=None, interval_hours=None,
                       settings=None) -> dict:
        cfg = self.job_config(job_id)
        if not cfg:
            return {}
        if enabled is not None:
            cfg["enabled"] = bool(enabled)
        if interval_hours is not None:
            cfg["interval_hours"] = max(1, int(interval_hours))
        if isinstance(settings, dict):
            cfg["settings"].update(settings)
        self.db.set_setting(_JOB_KEY % job_id, json.dumps(cfg))
        return cfg

    # ── lifecycle ─────────────────────────────────────────────────────────────
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        try:
            self.db.repair_sweep_stale_runs()   # a process death mid-run must not wedge the scheduler
        except Exception:   # noqa: BLE001
            logger.debug("stale-run sweep failed", exc_info=True)
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="video-repair-worker",
                                        daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        self._cancel_current.set()
        self._wake.set()

    def pause(self) -> None:
        self._paused = True

    def resume(self) -> None:
        self._paused = False

    def run_job_now(self, job_id: str) -> bool:
        if job_id not in get_all_jobs():
            return False
        with self._lock:
            if job_id == self._current_job_id or job_id in self._force_queue:
                return True   # already queued/running — idempotent
            self._force_queue.append(job_id)
        self._wake.set()   # start immediately — never wait out the idle tick
        return True

    def stop_current_job(self, job_id: str) -> dict:
        with self._lock:
            if job_id in self._force_queue:
                self._force_queue.remove(job_id)
                return {"success": True, "outcome": "dequeued"}
            if self._current_job_id == job_id:
                self._cancel_current.set()
                return {"success": True, "outcome": "cancelling"}
        return {"success": False, "error": "not running"}

    def _run(self) -> None:
        # #1289 item 12: the worker no longer picks jobs by staleness —
        # scheduling lives in the automation engine now. This loop is a pure
        # executor: it drains the force-run queue (Run Now clicks + automation
        # triggers) and sleeps otherwise.
        logger.info("video repair worker started")
        while not self._stop_event.is_set():
            if self._paused:
                self._stop_event.wait(2.0)
                continue
            job_id = None
            with self._lock:
                if self._force_queue:
                    job_id = self._force_queue.pop(0)
            if job_id:
                try:
                    self._run_job(job_id, forced=True)
                except Exception:   # noqa: BLE001 - the scheduler must survive any job
                    logger.exception("repair job %s crashed", job_id)
            else:
                self._wake.wait(_IDLE_SLEEP)   # a Run Now click ends the nap instantly
                self._wake.clear()

    # ── one job ───────────────────────────────────────────────────────────────
    def _run_job(self, job_id: str, forced: bool = False) -> None:
        cls = get_all_jobs().get(job_id)
        if not cls:
            return
        job = cls()
        cfg = self.job_config(job_id)
        self._cancel_current.clear()
        with self._lock:
            self._current_job_id = job_id
        state = {"status": "running", "display_name": cls.display_name, "progress": 0,
                 "phase": "starting", "current_item": None, "processed": 0, "total": 0,
                 "log": [], "started_at": time.time(), "finished_at": None}
        self._states[job_id] = state
        self._emit_progress(force=True)
        result = JobResult()
        run_id = self.db.repair_record_job_start(job_id)

        def create_finding(**kw) -> bool:
            ok = self.db.repair_create_finding(job_id, **kw)
            if ok:
                result.findings_created += 1
                self._log(state, "found", kw.get("title") or "")
                try:      # 'Maintenance Finding Raised' automation trigger
                    from core.video.download_events import publish
                    publish("video_repair_finding_created", {
                        "job_id": job_id, "finding_type": kw.get("finding_type") or "",
                        "severity": kw.get("severity") or "info",
                        "title": kw.get("title") or ""})
                except Exception:   # noqa: BLE001 - events never disturb the scan
                    logger.exception("repair finding event publish failed")
            else:
                result.findings_skipped_dedup += 1
            return ok

        def update_progress(processed=None, total=None, phase=None, current_item=None):
            if processed is not None:
                state["processed"] = processed
            if total is not None:
                state["total"] = total
            if phase is not None:
                state["phase"] = phase
            if current_item is not None:
                state["current_item"] = current_item
            if state["total"]:
                state["progress"] = min(100, round(100 * state["processed"] / state["total"]))
            self._emit_progress()

        ctx = JobContext(db=self.db, settings=cfg.get("settings") or {},
                         stop_event=self._cancel_current,
                         create_finding=create_finding, update_progress=update_progress)
        try:
            total = 0
            try:
                total = int(job.estimate_scope(ctx) or 0)
            except Exception:   # noqa: BLE001 - scope is a nicety
                pass
            if total:
                update_progress(total=total)
            r = job.scan(ctx) or result
            # merge: jobs may return their own tallies for scanned/errors
            result.scanned = r.scanned or result.scanned
            result.errors = r.errors or result.errors
            result.auto_fixed = r.auto_fixed or result.auto_fixed
            state["status"] = "finished"   # music progress vocabulary: running|finished|error
            state["phase"] = "done"
            self._log(state, "info", f"scanned {result.scanned}, "
                      f"{result.findings_created} new findings")
        except JobCancelled:
            state["status"] = "cancelled"
            state["phase"] = "cancelled"
            self._log(state, "warn", "stopped by user")
        except Exception as e:   # noqa: BLE001 - record, never kill the scheduler
            logger.exception("repair job %s failed", job_id)
            result.errors += 1
            state["status"] = "error"
            state["phase"] = "error"
            self._log(state, "error", str(e))
        finally:
            state["finished_at"] = time.time()
            state["progress"] = 100 if state["status"] == "finished" else state["progress"]
            self.db.repair_record_job_finish(
                run_id, items_scanned=result.scanned,
                findings_created=result.findings_created,
                auto_fixed=result.auto_fixed, errors=result.errors)
            try:      # 'Maintenance Scan Done' automation trigger
                from core.video.download_events import publish
                publish("video_repair_scan_completed", {
                    "job_id": job_id, "job_name": cls.display_name,
                    "status": state["status"], "scanned": result.scanned,
                    "findings_created": result.findings_created,
                    "errors": result.errors})
            except Exception:   # noqa: BLE001 - events never disturb the scheduler
                logger.exception("repair scan event publish failed")
            with self._lock:
                self._current_job_id = None
            self._emit_progress(force=True)

    @staticmethod
    def _log(state: dict, kind: str, text: str) -> None:
        state["log"].append({"type": kind, "text": text})
        del state["log"][:-_LOG_LINES]

    # ── findings ops (approve == fix == resolved) ─────────────────────────────
    def _job_for_finding_type(self, finding_type: str):
        for cls in get_all_jobs().values():
            if finding_type in (cls.finding_types or ()):
                return cls
        return None

    def fix_finding(self, finding_id: int, fix_action=None) -> dict:
        f = self.db.repair_get_finding(finding_id)
        if not f:
            return {"success": False, "error": "finding not found"}
        if f["status"] != "pending":
            return {"success": False, "error": "already handled"}
        cls = self._job_for_finding_type(f["finding_type"])
        if not cls:
            return {"success": False, "error": f"no fixer for {f['finding_type']}"}
        if fix_action is not None:
            details = dict(f.get("details") or {})
            details["_fix_action"] = fix_action
            self.db.repair_set_finding_details(finding_id, details)
            f["details"] = details
        ctx = JobContext(db=self.db, settings=self.job_config(cls.job_id).get("settings") or {})
        try:
            res = cls().fix(ctx, f, fix_action) or {"success": False, "error": "no result"}
        except Exception as e:   # noqa: BLE001 - a fix failure is a result, not a crash
            logger.exception("fix failed for finding %s", finding_id)
            res = {"success": False, "error": str(e)}
        if res.get("success"):
            self.db.repair_set_finding_status(finding_id, "resolved",
                                              action=res.get("action") or "fixed")
        return res

    def resolve_finding(self, finding_id: int, action=None) -> bool:
        return self.db.repair_set_finding_status(finding_id, "resolved",
                                                 action=action or "resolved")

    def dismiss_finding(self, finding_id: int) -> bool:
        return self.db.repair_set_finding_status(finding_id, "dismissed")

    def bulk_update_findings(self, ids, action: str) -> int:
        status = "dismissed" if action == "dismiss" else "resolved"
        return self.db.repair_bulk_update_findings(ids, status)

    def _bulk_targets(self, job_id=None, severity=None, ids=None) -> list:
        """The pending findings a bulk fix with these filters acts on: the
        chosen ids, or the first 200 pending of a job / severity."""
        if ids:
            targets = [self.db.repair_get_finding(i) for i in ids]
            return [t for t in targets if t and t["status"] == "pending"]
        return self.db.repair_get_findings(job_id=job_id, status="pending",
                                           severity=severity, limit=200)["items"]

    # ── preview, then confirm, for bulk fixes that move or delete files ──────
    def _fix_effect(self, finding: dict, fix_action, settings: dict, base_dirs) -> dict:
        """What fixing one finding would do: ``effect`` (a sentence),
        ``effect_kind`` (move / recycle / delete / library / write / none),
        the file it touches, its size and ``files`` (how many files it moves,
        recycles or deletes; a rename's sidecars aside). Reads only; mirrors
        the fixers."""
        ftype = finding.get("finding_type") or ""
        d = finding.get("details") or {}
        if ftype == "watched_cleanup":
            return self._watched_cleanup_effect(d, settings, base_dirs)
        if ftype == "naming_mismatch":
            want = os.path.basename(str(d.get("expected_path") or "")) or "the template's name"
            return {"effect": f"Renames the file to {want}, with its sidecars. Nothing is deleted",
                    "effect_kind": "move", "path": d.get("current_path") or "",
                    "size": int(d.get("size_bytes") or 0), "files": 1}
        if ftype == "youtube_ghost":
            text = ("Forgets the download record, so the video can be fetched again"
                    if fix_action == "forget" else "Marks the download as deleted in your history")
            return {"effect": text, "effect_kind": "library", "path": "", "size": 0, "files": 0}
        if ftype in ("duplicate_movie", "duplicate_episode"):
            return {"effect": "Nothing: choose the copy to keep by hand", "effect_kind": "none",
                    "path": "", "size": 0, "files": 0}
        return {"effect": _PLAIN_EFFECTS.get(ftype, "Applies the fix"), "effect_kind": "write",
                "path": "", "size": 0, "files": 0}

    def _watched_cleanup_effect(self, d: dict, settings: dict, base_dirs) -> dict:
        from core.video import recycle
        from core.video.path_resolver import resolve_video_file_path
        files = []
        if d.get("movie_id") is not None:
            try:
                files = self.db.movie_file_paths(d["movie_id"]) or []
            except Exception:   # noqa: BLE001 - the finding's own path still says enough
                files = []
        if not files and d.get("relative_path"):
            files = [{"relative_path": d["relative_path"], "size_bytes": d.get("size_bytes")}]
        located = []
        for f in files:
            real = resolve_video_file_path(f.get("relative_path"), base_dirs,
                                           size_bytes=f.get("size_bytes"))
            if real:
                located.append((real, int(f.get("size_bytes") or 0)))
        what = "file" if len(located) <= 1 else f"{len(located)} files"
        if not located:
            return {"effect": "Can't find the file on disk, so nothing is deleted and this fix fails",
                    "effect_kind": "none", "path": d.get("relative_path") or "",
                    "size": int(d.get("size_bytes") or 0), "files": 0}
        size = sum(s for _p, s in located)
        if not settings.get("recycle_deletes", True):
            return {"effect": (f"Deletes the movie's {what} permanently (recycling is off) and "
                               "marks the movie as not in your library"),
                    "effect_kind": "delete", "path": located[0][0], "size": size, "files": len(located)}
        if any(recycle.trash_dir_for(p, settings, self.db) is None for p, _s in located):
            return {"effect": (f"Deletes the movie's {what} permanently: it is outside every "
                               "library folder, so it can't go to the recycle bin"),
                    "effect_kind": "delete", "path": located[0][0], "size": size, "files": len(located)}
        return {"effect": (f"Moves the movie's {what} to the recycle bin and marks the movie "
                           "as not in your library"),
                "effect_kind": "recycle", "path": located[0][0], "size": size, "files": len(located)}

    def preview_bulk_fix(self, job_id=None, severity=None, ids=None, fix_action=None) -> dict:
        """What a bulk fix with these filters WOULD do, finding by finding,
        recorded as a plan. Changes nothing.

        Returns the plan summary (``plan_id``, ``total``, ``sample`` items with
        ``path`` / ``reason`` / ``effect`` / ``effect_kind`` / ``files``) plus
        ``destructive`` (how many move or delete a file), ``by_effect`` (fixes
        per effect), ``files_by_effect`` (the files those fixes move, recycle
        or delete), ``per_type`` and ``recycle_deletes``. ``total == 0`` and no plan id
        when nothing matches."""
        from core.library.action_plans import plan_store
        from core.video import organization
        from core.video.path_resolver import video_base_dirs
        targets = self._bulk_targets(job_id=job_id, severity=severity, ids=ids)
        settings = organization.load(self.db)
        recycle_on = bool(settings.get("recycle_deletes", True))
        base_dirs = video_base_dirs(self.db) if any(
            t.get("finding_type") == "watched_cleanup" for t in targets) else []
        items = []
        for f in targets:
            ftype = f.get("finding_type") or ""
            effect = self._fix_effect(f, fix_action, settings, base_dirs)
            items.append({
                "finding_id": f["id"], "finding_type": ftype,
                "path": effect["path"], "size": effect["size"],
                "action": fix_action or "fix", "reason": f.get("title") or ftype,
                "effect": effect["effect"], "effect_kind": effect["effect_kind"],
                "files": int(effect.get("files") or 0),
                "destructive": effect["effect_kind"] in ("move", "recycle", "delete"),
            })
        if not items:
            return {"total": 0, "plan_id": None, "destructive": 0, "per_type": {}, "by_effect": {},
                    "files_by_effect": {}, "recycle_deletes": recycle_on, "counts": {},
                    "by_reason": {}, "sample": [], "truncated": False}
        plan = plan_store.create(VIDEO_REPAIR_BULK_FIX_TOOL, items, meta={
            "ids": [i["finding_id"] for i in items], "fix_action": fix_action})
        summary = plan.summary()
        per_type: dict = {}
        by_effect: dict = {}
        files_by_effect: dict = {}
        for item in items:
            per_type[item["finding_type"]] = per_type.get(item["finding_type"], 0) + 1
            by_effect[item["effect_kind"]] = by_effect.get(item["effect_kind"], 0) + 1
            if item["files"]:
                files_by_effect[item["effect_kind"]] = files_by_effect.get(item["effect_kind"], 0) + item["files"]
        summary.update(per_type=per_type, by_effect=by_effect, files_by_effect=files_by_effect,
                       recycle_deletes=recycle_on, destructive=sum(1 for i in items if i["destructive"]))
        return summary

    def bulk_fix_needs_plan(self, job_id=None, severity=None, ids=None) -> bool:
        """True when this selection includes a fix that moves or deletes
        files, so a bulk run of it must come with a confirmed preview."""
        return any(t.get("finding_type") in FILE_TOUCHING_FINDING_TYPES
                   for t in self._bulk_targets(job_id=job_id, severity=severity, ids=ids))

    @staticmethod
    def consume_bulk_fix_plan(plan_id) -> dict:
        """The finding ids and action a confirmed preview authorised. Raises
        ``PlanError`` for a missing / used / expired / other tool's plan."""
        from core.library.action_plans import plan_store
        plan = plan_store.consume(plan_id, VIDEO_REPAIR_BULK_FIX_TOOL)
        return {"ids": list(plan.meta.get("ids") or []), "fix_action": plan.meta.get("fix_action")}

    def bulk_fix_findings(self, job_id=None, severity=None, ids=None, fix_action=None) -> dict:
        targets = self._bulk_targets(job_id=job_id, severity=severity, ids=ids)
        fixed, failed, errors = 0, 0, []
        for f in targets:
            res = self.fix_finding(f["id"], fix_action)
            if res.get("success"):
                fixed += 1
            else:
                failed += 1
                if res.get("error"):
                    errors.append(f"#{f['id']}: {res['error']}")
        return {"success": failed == 0, "fixed": fixed, "failed": failed,
                "total": len(targets), "errors": errors[:10]}

    # ── read/aggregate (API surface) ──────────────────────────────────────────
    def get_all_job_info(self) -> list:
        out = []
        counts = self.db.repair_counts().get("by_job", {})
        for job_id, cls in sorted(get_all_jobs().items()):
            cfg = self.job_config(job_id)
            last = self.db.repair_last_run(job_id)
            next_run = None
            if last and last.get("finished_at") and cfg.get("enabled"):
                next_run = f"{cfg['interval_hours']}h after last run"
            out.append({
                "job_id": job_id, "display_name": cls.display_name,
                "description": cls.description, "help_text": cls.help_text,
                "icon": cls.icon, "auto_fix": cls.auto_fix,
                "enabled": cfg.get("enabled", False),
                "interval_hours": cfg.get("interval_hours"),
                "settings": cfg.get("settings") or {},
                "default_settings": dict(cls.default_settings or {}),
                "setting_options": dict(cls.setting_options or {}),
                "last_run": last, "next_run": next_run,
                "is_running": self._current_job_id == job_id,
                "pending_findings_count": counts.get(job_id, 0),
                # #1289 item 12: video has no Tools UI for repair jobs yet;
                # automation_id is null until one exists. The schedule still
                # runs via the seeded system automation rows.
                "automation_id": None,
            })
        return out

    def get_stats(self) -> dict:
        counts = self.db.repair_counts()
        return {"enabled": self.master_enabled(), "running": self._current_job_id is not None,
                "paused": self._paused, "idle": self._current_job_id is None,
                "current_job": self._current_job_id,
                "findings_pending": counts.get("pending", 0),
                "progress": self.progress_snapshot()}

    def progress_snapshot(self) -> dict:
        """{job_id: state} for jobs that ran this process (page-load seed)."""
        return {k: dict(v) for k, v in self._states.items()}

    # ── live progress ─────────────────────────────────────────────────────────
    def set_emitter(self, fn) -> None:
        self._emit = fn

    def _emit_progress(self, force: bool = False) -> None:
        if self._emit is None:
            return
        now = time.monotonic()
        if not force and (now - self._last_emit) < 1.0:
            return
        self._last_emit = now
        try:
            self._emit("video:repair:progress", self.progress_snapshot())
        except Exception:   # noqa: BLE001 - progress is a nicety
            logger.debug("repair progress emit failed", exc_info=True)


# ── module singleton (created by the API layer; emitter wired by web_server) ──
_worker: Optional[VideoRepairWorker] = None
_worker_lock = threading.Lock()


def get_video_repair_worker(db=None) -> VideoRepairWorker:
    global _worker
    if _worker is None:
        with _worker_lock:
            if _worker is None:
                if db is None:
                    from database.video_database import VideoDatabase
                    db = VideoDatabase()
                _worker = VideoRepairWorker(db)
    return _worker


def set_repair_progress_emitter(fn) -> None:
    get_video_repair_worker().set_emitter(fn)
