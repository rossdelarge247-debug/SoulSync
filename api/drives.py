"""Your music's drives: whether they're connected, the Folders card, the
Docker step's helper, and moving your music to another drive (boards 14a–14t).

Every route is admins only except ``GET /api/drives/status``, which every
signed-in profile reads (the "Your library's drive isn't connected" Notice is
for everyone; members get it without paths and without "Check again"), and
``GET /api/drives/helper.sh``, which curl fetches with no session: its one-use
token is the credential (core/drives/helper.py).

GET  /api/drives/status                 the three folders' drive state (everyone)
POST /api/drives/status/check           look again now
GET  /api/drives/folders                the Folders card (14a)
GET  /api/drives/docker                 the Docker step (14c): platform, folder, the lines
POST /api/drives/docker/command         mint the one-use command
GET  /api/drives/docker/check           Check again (14d): restarted? sees the drives?
GET  /api/drives/helper.sh?t=<token>    the helper script (token only)
GET  /api/drives/browse?path=           folders under a drive, for Browse…
GET  /api/drives/move                   the move (the open one, else the last) + Choose's overview
POST /api/drives/move                   the open move, or a new draft
PUT  /api/drives/move/<id>/choice       what moves and where (14b)
POST /api/drives/move/<id>/check        the checks (14e)
POST /api/drives/move/<id>/slskd-session  slskd's sign-in, once, when Downloads moves
POST /api/drives/move/<id>/plan         the plan (14f)
POST /api/drives/move/<id>/start        start copying (14g)
POST /api/drives/move/stop              Stop and undo (Activity's Stop; also /<id>/stop)
POST /api/drives/move/<id>/resume       carry on after a failure (14j)
POST /api/drives/move/<id>/recopy       copy the files that didn't match again
POST /api/drives/move/<id>/skip-unreadable  carry on without unreadable files
POST /api/drives/move/<id>/remove-preview   Remove the old copies… (14i, the Safe action)
POST /api/drives/move/<id>/remove       … with ``{plan_id}``
POST /api/drives/move/<id>/switch-back  Switch back to the old drive
POST /api/drives/move/<id>/leave        leave a draft

Every POST, PUT and DELETE here takes a JSON body (``Content-Type:
application/json``) and is refused from another site (``Origin`` or
``Sec-Fetch-Site``, when the browser sends them). The slow parts of Choose and
Check (folder sizes, the write test) run in the background; the page reads
``overview.measuring`` and ``checks.running`` until they're done.
"""

from __future__ import annotations

import os
import uuid
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlsplit

from flask import Blueprint, Response, jsonify, request

from core.drives import disks, helper, markers
from core.drives import move as moving
from core.profile_context import admin_only, get_current_profile_id, is_admin_request
from utils.logging_config import get_logger

logger = get_logger("api.drives")

bp = Blueprint("drives", __name__)

#: a new one each time SYNCHRO.S starts, so Check again can tell a restart
BOOT_ID = uuid.uuid4().hex

_deps: Dict[str, Any] = {}
JOB: Optional[moving.MoveJob] = None
SIZES = disks.SizeCache(skip=moving.SKIP_NAMES)


def configure(*, get_database_: Callable[[], Any], config_manager_: Any, slskd_: Callable[[], Any] = lambda: None,
              media_: Callable[[], Any] = lambda: None, busy_: Callable[[], list] = lambda: [],
              pause_workers_: Callable[[], None] = lambda: None, resume_workers_: Callable[[], None] = lambda: None,
              after_switch_: Callable[[], None] = lambda: None, media_label_: Callable[[], str] = lambda: "",
              slskd_configured_: Callable[[], bool] = lambda: False) -> moving.MoveJob:
    """Wire the routes to the app. Returns the move job."""
    global JOB
    _deps.update(get_database=get_database_, config=config_manager_, media_label=media_label_,
                 slskd_configured=slskd_configured_)

    def encrypt(s: str) -> str:
        fn = getattr(config_manager_, "_encrypt_value", None)
        return fn(s) if fn else s

    def decrypt(s: str) -> str:
        fn = getattr(config_manager_, "_decrypt_value", None)
        return fn(s) if fn else s

    deps = moving.Deps(database=get_database_, config=lambda: config_manager_, platform=_guessed_platform,
                       slskd=slskd_, media=media_, busy=busy_, pause_workers=pause_workers_,
                       resume_workers=resume_workers_, after_switch=after_switch_, encrypt=encrypt, decrypt=decrypt,
                       drive_watch=markers.get_watch)
    JOB = moving.MoveJob(deps)
    return JOB


def _config():
    return _deps["config"]


def _guessed_platform() -> str:
    try:
        lib = markers.folder_paths(_config())["library"]
    except Exception:  # noqa: BLE001
        lib = None
    return disks.guess_platform(lib)


def _platform() -> str:
    saved = _config().get("drives.platform", "") or ""
    return saved if saved in disks.PLATFORMS else _guessed_platform()


def _job() -> moving.MoveJob:
    if JOB is None:
        raise RuntimeError("drives aren't configured")
    return JOB


def _no_store(resp):
    resp.headers["Cache-Control"] = "no-store"
    return resp


def _refused(exc: moving.MoveError):
    body = {"success": False, "error": str(exc)}
    if getattr(exc, "code", None):
        body["code"] = exc.code
    return jsonify(body), exc.status


def _same_site() -> bool:
    """Whether a request comes from SYNCHRO.S's own pages, by what the
    browser says (requests without the headers, like the tests', pass)."""
    site = request.headers.get("Sec-Fetch-Site")
    if site and site not in ("same-origin", "none"):
        return False
    origin = request.headers.get("Origin")
    if origin:
        if origin == "null":
            return False
        try:
            parts = urlsplit(origin)
        except ValueError:
            return False
        hosts = {(request.host or "").lower()}
        hosts.update(h.strip().lower() for h in (request.headers.get("X-Forwarded-Host") or "").split(",") if h.strip())
        if parts.netloc.lower() not in hosts:
            return False
    return True


@bp.before_request
def _guard_writes():
    """Changes only from SYNCHRO.S's own pages, as JSON."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return None
    if not _same_site():
        return jsonify({"success": False, "error": "That came from another site, so nothing changed."}), 403
    if request.mimetype != "application/json":
        return jsonify({"success": False, "error": "Send this as JSON."}), 415
    return None


def _label(path: str) -> str:
    return disks.drive_label(path, _platform())


# ── the drive state (everyone) ────────────────────────────────────────────────

def _status_payload(state: Dict[str, Any], *, admin: bool) -> Dict[str, Any]:
    folders = {}
    for role, f in state["folders"].items():
        item = {"role": role, "label": f["label"], "connected": f["connected"], "last_seen": f["last_seen"],
                "drive": _label(f["path"]) if f.get("path") else None}
        if admin:
            item["path"] = f["path"]
            item["reason"] = f["reason"]
        folders[role] = item
    out = {"success": True, "checked_at": state["checked_at"], "interval": state["interval"],
           "library_away": state["library_away"], "away": state["away"], "folders": folders,
           "can_check": admin, "boot_id": BOOT_ID}
    if admin and JOB is not None:
        try:
            current = JOB.store.current()
            if current:
                out["move"] = {"id": current["id"], "status": current["status"],
                               "promise": moving.promise(current, JOB.home_label())}
            out["reminder"] = JOB.reminder()
        except Exception as exc:  # noqa: BLE001 - the drive state still answers
            logger.debug("move summary unreadable: %s", exc)
    return out


@bp.route("/api/drives/status", methods=["GET"])
def get_status():
    if get_current_profile_id() is None:
        return jsonify({"success": False, "error": "profile_required"}), 401
    state = markers.get_watch().state()
    return _no_store(jsonify(_status_payload(state, admin=bool(is_admin_request()))))


@bp.route("/api/drives/status/check", methods=["POST"])
@admin_only
def post_status_check():
    markers.get_watch().forget_expectations()
    state = markers.get_watch().check_now()
    return _no_store(jsonify(_status_payload(state, admin=True)))


# ── the Folders card (14a) ────────────────────────────────────────────────────

def _readers(role: str) -> str:
    media = _deps.get("media_label", lambda: "")() or ""
    slskd = bool(_deps.get("slskd_configured", lambda: False)())
    if role == "library":
        who = "Library" + (f" and {media}" if media else "")
        return f"Your music. {who} read it" + ("; slskd shares it." if slskd else ".")
    if role == "downloads":
        return "Files arriving from Soulseek, before they're checked."
    return "Albums waiting to be imported."


def _albums() -> Optional[int]:
    try:
        from contextlib import closing
        with closing(_deps["get_database"]()._get_connection()) as conn:
            return int(conn.execute("SELECT COUNT(*) FROM albums").fetchone()[0])
    except Exception:  # noqa: BLE001
        return None


def _folder_rows(wait: bool = False):
    paths = markers.folder_paths(_config())
    rows = []
    for role in markers.ROLES:
        path = paths[role]
        size = SIZES.get(path, wait=wait)
        rows.append({"role": role, "label": markers.LABELS[role], "path": path, "drive": _label(path),
                     "holds": _readers(role), "files": size["files"] if size else None,
                     "bytes": size["bytes"] if size else None})
    return rows


@bp.route("/api/drives/folders", methods=["GET"])
@admin_only
def get_folders():
    rows = _folder_rows()
    lib = rows[0]["path"]
    space = disks.usage(lib) or {}
    total, free = space.get("total"), space.get("free")
    pct = round((1 - free / total) * 100, 1) if total and free is not None else None
    tone = "danger" if pct is not None and pct > 98 else "warning" if pct is not None and pct > 90 else None
    current = None
    try:
        move = _job().store.current()
        current = {"id": move["id"], "status": move["status"]} if move else None
    except Exception:  # noqa: BLE001
        current = None
    return _no_store(jsonify({"success": True, "folders": rows,
                              "drive": {"label": _label(lib), "free": free, "total": total, "percent": pct,
                                        "tone": tone},
                              "move": current, "platform": _platform()}))


# ── the Docker step (14c, 14d, 14m) ───────────────────────────────────────────

def _lines(platform: str) -> Dict[str, Any]:
    """What the helper adds, for "See the lines it adds" and the by-hand way."""
    return {"mounts": list(disks.MOUNT_LINES.get(platform, ())), "slskd_config": "./slskd:/slskd-config"}


def _drives_view():
    plat = _platform()
    home = markers.folder_paths(_config())["library"]
    found = disks.list_drives(plat, home=home)
    return plat, found


@bp.route("/api/drives/docker", methods=["GET"])
@admin_only
def get_docker():
    plat, found = _drives_view()
    folder = _config().get("drives.compose_folder", "") or helper.DEFAULT_COMPOSE_FOLDER
    return _no_store(jsonify({
        "success": True, "platform": plat, "guessed": _guessed_platform(), "compose_folder": folder,
        "roots": list(disks.drives_roots(plat)), "visible_roots": disks.visible_roots(plat),
        "drives": found, "boot_id": BOOT_ID, "lines": _lines(plat), "token": helper.TOKENS.state(),
        "undo": helper.undo_command(folder), "windows_ready": False}))


@bp.route("/api/drives/docker/command", methods=["POST"])
@admin_only
def post_docker_command():
    body = request.get_json(silent=True) or {}
    try:
        folder = helper.clean_compose_folder(body.get("folder", _config().get("drives.compose_folder", "")))
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc), "field": "folder"}), 400
    plat = body.get("platform")
    if plat is not None:
        if plat not in disks.PLATFORMS:
            return jsonify({"success": False, "error": "Choose Mac, Linux or Windows."}), 400
        _config().set("drives.platform", plat)
    # the address this browser used (with SOULSYNC_URL_BASE, if set): the
    # Terminal on the same computer reaches SYNCHRO.S the same way
    try:
        base = helper.clean_base_url(request.url_root)
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    _config().set("drives.compose_folder", folder)
    minted = helper.TOKENS.mint(get_current_profile_id() or 1)
    plat = _platform()
    return _no_store(jsonify({"success": True, "command": helper.command(base, minted["token"], folder, plat),
                              "undo": helper.undo_command(folder), "expires_at": minted["expires_at"],
                              "platform": plat, "lines": _lines(plat), "compose_folder": folder}))


@bp.route("/api/drives/docker/check", methods=["GET"])
@admin_only
def get_docker_check():
    plat, found = _drives_view()
    return _no_store(jsonify({"success": True, "boot_id": BOOT_ID, "drives": found,
                              "visible": bool([d for d in found if d.get("offered")]) or bool(found),
                              "roots": list(disks.drives_roots(plat)), "token": helper.TOKENS.state(),
                              "platform": plat}))


@bp.route("/api/drives/helper.sh", methods=["GET"])
def get_helper_script():
    if not helper.TOKENS.consume(request.args.get("t")):
        return Response("echo 'This command has expired or was used already. Go back to SYNCHRO.S and copy it "
                        "again.'\nexit 1\n", status=403, mimetype="text/x-shellscript")
    resp = Response(helper.script(), mimetype="text/x-shellscript")
    resp.headers["Content-Disposition"] = f'attachment; filename="{helper.SCRIPT_NAME}"'
    resp.headers["Cache-Control"] = "no-store"
    return resp


@bp.route("/api/drives/browse", methods=["GET"])
@admin_only
def get_browse():
    """Folders one level under ``path``, which must be on a drive SYNCHRO.S
    can see; links aren't listed or followed."""
    from core.drives.paths import resolve_existing, within
    roots = list(disks.drives_roots(_platform()))
    raw = request.args.get("path") or ""
    if not raw:
        return jsonify({"success": True, "path": None, "folders": [
            {"name": d["name"], "path": d["path"]} for d in disks.list_drives(_platform()) if d.get("offered")]})
    real = resolve_existing(raw)
    if not raw.startswith("/") or ".." in raw.split("/") or not any(within(real, r) for r in roots) \
            or not os.path.isdir(real):
        return jsonify({"success": False, "error": "That folder isn't on a drive SYNCHRO.S can see."}), 400
    out = []
    try:
        for entry in sorted(os.scandir(real), key=lambda e: e.name.lower()):
            if entry.name.startswith(".") or entry.is_symlink():
                continue
            if entry.is_dir(follow_symlinks=False):
                out.append({"name": entry.name, "path": os.path.join(raw.rstrip("/"), entry.name)})
            if len(out) >= 500:
                break
    except OSError:
        return jsonify({"success": False, "error": "SYNCHRO.S couldn't read that folder."}), 400
    return jsonify({"success": True, "path": raw, "folders": out})


# ── the move ──────────────────────────────────────────────────────────────────

def _overview() -> Dict[str, Any]:
    plat, found = _drives_view()
    # sizes come from the background measure; the page asks again while
    # ``measuring`` (a big library takes a while to walk)
    rows = _folder_rows(wait=False)
    albums = _albums()
    for r in rows:
        if r["role"] == "library" and albums is not None:
            r["albums"] = albums
    lib = rows[0]["path"]
    space = disks.usage(lib) or {}
    return {"folders": rows, "drives": found, "home_label": _label(lib), "home_free": space.get("free"),
            "platform": plat, "visible": bool(found), "roots": list(disks.drives_roots(plat)),
            "measuring": any(r["files"] is None for r in rows)}


def _move_payload(move, *, overview: bool = False) -> Dict[str, Any]:
    job = _job()
    out = {"success": True, "move": moving.public(job, move, admin=True), "boot_id": BOOT_ID,
           "running": job.running()}
    if overview:
        out["overview"] = _overview()
    return out


@bp.route("/api/drives/move", methods=["GET"])
@admin_only
def get_move():
    job = _job()
    move = job.store.current()
    if move is None:
        latest = job.store.latest()
        if latest and latest["status"] in ("stopped", "removed", "switched_back") \
                and (latest.get("finished_at") or 0) > (job.deps.clock() - 3600):
            move = latest
    draft = move is None or move["status"] == "draft"
    return _no_store(jsonify(_move_payload(move, overview=draft)))


@bp.route("/api/drives/move", methods=["POST"])
@admin_only
def post_move():
    move = _job().draft(get_current_profile_id() or 1)
    return _no_store(jsonify(_move_payload(move, overview=move["status"] == "draft")))


def _act(fn):
    try:
        move = fn()
    except moving.MoveError as exc:
        return _refused(exc)
    return _no_store(jsonify(_move_payload(move, overview=bool(move) and move["status"] == "draft")))


@bp.route("/api/drives/move/<int:move_id>/choice", methods=["PUT"])
@admin_only
def put_choice(move_id: int):
    body = request.get_json(silent=True) or {}
    return _act(lambda: _job().set_choice(move_id, body))


@bp.route("/api/drives/move/<int:move_id>/check", methods=["POST"])
@admin_only
def post_check(move_id: int):
    return _act(lambda: _job().check(move_id, background=True))


@bp.route("/api/drives/move/<int:move_id>/slskd-session", methods=["POST"])
@admin_only
def post_slskd_session(move_id: int):
    body = request.get_json(silent=True) or {}
    return _act(lambda: _job().slskd_sign_in(move_id, str(body.get("username") or "")[:200],
                                             str(body.get("password") or "")[:500], background=True))


@bp.route("/api/drives/move/<int:move_id>/plan", methods=["POST"])
@admin_only
def post_plan(move_id: int):
    return _act(lambda: _job().plan(move_id))


@bp.route("/api/drives/move/<int:move_id>/start", methods=["POST"])
@admin_only
def post_start(move_id: int):
    body = request.get_json(silent=True) or {}
    checksum = body.get("checksum")
    return _act(lambda: _job().start(move_id, checksum=None if checksum is None else bool(checksum)))


@bp.route("/api/drives/move/stop", methods=["POST"])
@bp.route("/api/drives/move/<int:move_id>/stop", methods=["POST"])
@admin_only
def post_stop(move_id: Optional[int] = None):
    return _act(lambda: _job().stop(move_id))


def _carry_on_sign_in():
    """slskd's sign-in for carrying on after a failure, when Downloads moves
    (the session was forgotten at the failure)."""
    body = request.get_json(silent=True) or {}
    return str(body.get("username") or "")[:200] or None, str(body.get("password") or "")[:500]


@bp.route("/api/drives/move/<int:move_id>/resume", methods=["POST"])
@admin_only
def post_resume(move_id: int):
    user, password = _carry_on_sign_in()
    return _act(lambda: _job().resume(move_id, username=user, password=password))


@bp.route("/api/drives/move/<int:move_id>/recopy", methods=["POST"])
@admin_only
def post_recopy(move_id: int):
    user, password = _carry_on_sign_in()
    return _act(lambda: _job().recopy(move_id, username=user, password=password))


@bp.route("/api/drives/move/<int:move_id>/skip-unreadable", methods=["POST"])
@admin_only
def post_skip_unreadable(move_id: int):
    user, password = _carry_on_sign_in()
    return _act(lambda: _job().skip_unreadable(move_id, username=user, password=password))


@bp.route("/api/drives/move/<int:move_id>/remove-preview", methods=["POST"])
@admin_only
def post_remove_preview(move_id: int):
    from core.library.action_plans import plan_store
    try:
        summary = _job().remove_preview(move_id, plan_store)
    except moving.MoveError as exc:
        return _refused(exc)
    return _no_store(jsonify({"success": True, **summary}))


@bp.route("/api/drives/move/<int:move_id>/remove", methods=["POST"])
@admin_only
def post_remove(move_id: int):
    from core.library.action_plans import PlanError, plan_store
    body = request.get_json(silent=True) or {}
    try:
        result = _job().remove_confirm(move_id, body.get("plan_id"), plan_store)
    except PlanError as exc:
        return jsonify({"success": False, "error": exc.message, "code": exc.code}), 409
    except moving.MoveError as exc:
        return _refused(exc)
    return _no_store(jsonify({"success": True, **result, **_move_payload(_job().store.row(move_id))}))


@bp.route("/api/drives/move/<int:move_id>/switch-back", methods=["POST"])
@admin_only
def post_switch_back(move_id: int):
    body = request.get_json(silent=True) or {}
    username = str(body.get("username") or "")[:200] or None
    password = str(body.get("password") or "")[:500]
    return _act(lambda: _job().switch_back(move_id, username=username, password=password))


@bp.route("/api/drives/move/<int:move_id>/leave", methods=["POST"])
@admin_only
def post_leave(move_id: int):
    return _act(lambda: _job().leave(move_id))


@bp.route("/api/drives/plan-list/<plan_id>", methods=["GET"])
@admin_only
def get_plan_list(plan_id: str):
    """The full list behind a Remove the old copies… preview, as text."""
    from core.library.action_plans import PlanError, plan_store
    try:
        plan = plan_store.peek(plan_id, moving.REMOVE_TOOL)
    except PlanError as exc:
        return jsonify({"success": False, "error": exc.message, "code": exc.code}), 409
    body = "\n".join(f"{i['path']}\t{i['size']}" for i in plan.items) + "\n"
    resp = Response(body, mimetype="text/plain")
    resp.headers["Content-Disposition"] = 'attachment; filename="old-copies.txt"'
    return resp


def create_blueprint():
    return bp


__all__ = ["BOOT_ID", "bp", "configure", "create_blueprint"]
