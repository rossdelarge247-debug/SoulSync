"""Internet radio's routes (docs/design/CONTRACTS.md, "Internet radio").

Everyone with a profile:
GET    /api/radio/stations                        built-in picks by kind, Favourites (incl. your links)
GET    /api/radio/stations/<id>                   one station, with what's playing and Heard counts
GET    /api/radio/stations/<id>/logo              its logo, fetched and cached by the server
POST   /api/radio/favourites/<id>                 favourite (per profile)
DELETE /api/radio/favourites/<id>
GET    /api/radio/directory                       Radio Browser search (?q=&codec=&min_bitrate=&country=&page=)
GET    /api/radio/directory/countries
POST   /api/radio/play                            {station_id, stream_id?, force_relay?} -> {play_url, mode, session_id}
POST   /api/radio/stop                            {session_id}
GET    /api/radio/relay/<session_id>              the audio, when relayed
GET    /api/radio/now-playing                     ?station_id=&session_id=
GET    /api/radio/heard                           ?station_id=&days=&missing=1
POST   /api/radio/heard/<id>/want                 add one to Wanted
GET    /api/radio/stations/<id>/auto-add          the numbers the confirm shows
PUT    /api/radio/stations/<id>/auto-add          {enabled}; turning it on needs download rights
GET    /api/radio/stations/<id>/shows             shows with tracklists
GET    /api/radio/shows/<id>                      one tracklist
POST   /api/radio/shows/<id>/want                 {position}: one row to Wanted
POST   /api/radio/shows/<id>/want-missing         add the ones you don't have
POST   /api/radio/scan                            {session_id}: Scan now -> {scan_id}
GET    /api/radio/scan/<scan_id>                  the scan: listening | identified | not_found | failed

Admins:
GET    /api/radio/links                           your stream links
POST   /api/radio/links/check                     {url}: listen to a link from this server
POST   /api/radio/links                           {url, name, kind, logo_url?}: add (needs a passing check)
POST   /api/radio/links/<id>/check
DELETE /api/radio/links/<id>
GET    /api/radio/settings, PUT /api/radio/settings
POST   /api/radio/scan/test                       {service}: does AcoustID / AudD / ACRCloud accept the key

The whole prefix answers 409 module_disabled while the module is off
(web_server._enforce_module_switches). The server fetches only stations it
resolved itself: a built-in pick, a directory station looked up by its uuid,
or an admin's checked link. The only routes that take an address from a
request are the admin link check and add.
"""

from __future__ import annotations

import json
import time
from typing import Any, Callable, Dict, List, Optional

from flask import Blueprint, Response, jsonify, request, send_file

from core.internet_radio import directory, feeds, logos, net, setup_rows, store
from core.internet_radio import settings as radio_settings
from core.internet_radio import stations as st
from core.internet_radio.hub import Busy, HubDeps, hub, track_key
from core.internet_radio.relay import RESPONSE_HEADERS, StreamError, check_link, open_stream, relay_chunks
from core.internet_radio.scan import ScanDeps, ScanManager, ScanRefused, check_service
from core.internet_radio.scan_providers import LABELS as SCAN_LABELS
from core.internet_radio.watcher import Watcher
from core.profile_context import admin_only, get_current_profile_id, is_admin_request
from core.security.outbound import check_url
from utils.logging_config import get_logger

logger = get_logger("api.radio")

bp = Blueprint("radio", __name__)

# injected by configure()
get_database: Callable[[], Any] = lambda: None  # noqa: E731
config_manager = None
_library_presence: Callable[[int, List[Dict[str, str]]], List[Dict[str, Any]]] = lambda _p, tracks: [  # noqa: E731
    {"in_library": False, "in_wishlist": False} for _ in tracks]
_add_to_wanted: Callable[[int, Dict[str, Any]], Dict[str, Any]] = lambda _p, _h: {  # noqa: E731
    "ok": False, "skipped": False, "message": "Adding to Wanted isn't available."}
_download_denied: Callable[[Optional[int]], Optional[str]] = lambda _pid: None  # noqa: E731
_actor_name: Callable[[], str] = lambda: "admin"  # noqa: E731
watcher = Watcher(hub)
scanner = ScanManager(hub)

MAX_HEARD = 200
HEARD_DAYS = (1, 7, 30, 90, 365)


def configure(*, get_database_, config_manager_, library_presence_=None, add_to_wanted_=None,
              download_denied_=None, emit_event_=None, fingerprint_=None, fingerprint_available_=None,
              radio_automation_profiles_=None, actor_name_=None) -> None:
    global get_database, config_manager, _library_presence, _add_to_wanted, _download_denied, _actor_name
    get_database = get_database_
    config_manager = config_manager_
    if library_presence_ is not None:
        _library_presence = library_presence_
    if add_to_wanted_ is not None:
        _add_to_wanted = add_to_wanted_
    if download_denied_ is not None:
        _download_denied = download_denied_
    if actor_name_ is not None:
        _actor_name = actor_name_

    def library_check(pid: int, artist: str, title: str) -> Dict[str, Any]:
        rows = _library_presence(pid, [{"name": title, "artist": artist}]) or [{}]
        return rows[0] if rows else {}

    # a radio automation saved or turned on starts the watcher straight away
    from core.automation import api as automation_api
    automation_api.set_radio_watcher_wake(_wake_watcher)

    hub.configure(HubDeps(
        get_database=get_database_, config=config_manager_, library_check=library_check,
        add_to_wanted=lambda pid, heard: _add_to_wanted(pid, heard),
        emit_event=emit_event_ or (lambda _t, _d: None),
        can_download=lambda pid: _download_denied(pid) is None,
        fingerprint=fingerprint_, fingerprint_available=fingerprint_available_ or default_fingerprint_available,
        radio_automation_profiles=radio_automation_profiles_ or (lambda: []),
        resolve_station=resolve_station))
    scanner.configure(ScanDeps(
        get_database=get_database_, config=config_manager_, find_fpcalc=setup_rows.find_fpcalc,
        acoustid_refused=_acoustid_refused,
        open_stream=lambda url: open_stream(url, want_titles=False, read_timeout=8)))


def _acoustid_refused() -> bool:
    last = setup_rows.last("radio.acoustid")
    return bool(last and last.get("status") == "error")


def default_fingerprint_available():
    if not radio_settings.acoustid_key(config_manager):
        return False, "There's no AcoustID key."
    if not setup_rows.find_fpcalc():
        return False, "fpcalc isn't installed."
    last = setup_rows.last("radio.acoustid")
    if last and last.get("status") == "error":
        return False, "AcoustID refused the key."
    return True, ""


def start_watcher() -> None:
    """Module on, or boot: allow the watcher, and start it only if a station
    is already watched (auto-add, or a radio automation's favourites)."""
    watcher.enable()
    watcher.ensure()


def _wake_watcher() -> None:
    try:
        watcher.ensure()
    except Exception as exc:  # noqa: BLE001 - never fail a request over the watcher
        logger.debug("radio watcher didn't start: %s", exc)


def stop_watcher() -> None:
    """Module off: stop the watcher and end every listening session."""
    watcher.stop()
    hub.reset()
    scanner.reset()


# ── helpers ──────────────────────────────────────────────────────────────────

def _pid() -> Optional[int]:
    pid = get_current_profile_id()
    return int(pid) if pid is not None else None


def _need_profile():
    return jsonify({"success": False, "error": "profile_required", "message": "Pick a profile first."}), 401


def _err(status: int, code: str, message: str):
    return jsonify({"success": False, "error": code, "message": message}), status


def _db():
    return get_database()


def _settings() -> Dict[str, Any]:
    return radio_settings.read(config_manager)


def link_station(link: Dict[str, Any]) -> Optional[st.Station]:
    stream = st.make_stream({"id": "main", "url": link.get("url"), "codec": link.get("codec") or "",
                             "bitrate_kbps": link.get("bitrate_kbps") or 0,
                             "direct": bool(link.get("allows_direct"))})
    if stream is None:
        return None
    kind = link.get("kind") if link.get("kind") in st.KINDS else "eclectic"
    return st.Station(id=f"link-{int(link['id'])}", name=str(link.get("name") or "Your link"), kind=kind,
                      source="your_link", streams=[stream], genre=st.KIND_LABELS.get(kind, ""),
                      logo_url=str(link.get("logo_url") or ""),
                      sends_titles=None if link.get("sends_titles") is None else bool(link.get("sends_titles")),
                      added_by=str(link.get("added_by") or ""), note="Added by an admin")


def _snapshot(station: st.Station) -> Dict[str, Any]:
    """A directory station as the server looked it up (kept with a favourite)."""
    return {"id": station.id, "name": station.name, "kind": station.kind, "genre": station.genre,
            "country": station.country, "homepage": station.homepage, "tags": station.tags,
            "logo_url": station.logo_url,
            "streams": [{"id": s.id, "url": s.url, "codec": s.codec, "bitrate_kbps": s.bitrate_kbps}
                        for s in station.streams]}


def _from_snapshot(data: Dict[str, Any]) -> Optional[st.Station]:
    streams = [s for s in (st.make_stream(x, i) for i, x in enumerate(data.get("streams") or [])) if s]
    if not streams or not directory.is_directory_id(str(data.get("id") or "")):
        return None
    for s in streams:
        s.direct = False
    return st.Station(id=str(data["id"]), name=str(data.get("name") or "Station"),
                      kind=data.get("kind") if data.get("kind") in st.KINDS else "eclectic", source="directory",
                      streams=streams, genre=str(data.get("genre") or ""), country=str(data.get("country") or ""),
                      homepage=str(data.get("homepage") or ""), tags=list(data.get("tags") or [])[:8],
                      logo_url=directory._favicon(data.get("logo_url")))


def resolve_station(station_id: str) -> Optional[st.Station]:
    """A station the server may fetch, from one of its three sources."""
    sid = str(station_id or "").strip()
    if not sid or len(sid) > 80:
        return None
    if sid.startswith("link-"):
        try:
            link = store.get_link(_db(), int(sid[5:]))
        except (ValueError, TypeError):
            return None
        return link_station(link) if link else None
    if sid.startswith("rb-"):
        if not directory.is_directory_id(sid):
            return None
        try:
            found = directory.lookup(sid)
            if found is not None:
                return found
        except directory.DirectoryError:
            pass
        snap = store.station_snapshot(_db(), sid)
        return _from_snapshot(snap) if snap else None
    return st.builtin_station(sid)


def _public(station: st.Station, pid: int, favs: Optional[set] = None) -> Dict[str, Any]:
    db = _db()
    favs = favs if favs is not None else set(store.favourite_ids(db, pid))
    return st.public_station(station, favourite=station.id in favs or station.source == "your_link",
                             auto_add=store.auto_add_enabled(db, pid, station.id),
                             prefer_lossless=_settings()["prefer_lossless"])


def _my_session(pid: int) -> Optional[Dict[str, Any]]:
    with hub._lock:  # noqa: SLF001 - a read of the hub's own table
        for s in hub._sessions.values():  # noqa: SLF001
            if s.profile_id == pid and not s.ended:
                return {"session_id": s.id, "station_id": s.station_id, "mode": s.mode, "stream_id": s.stream.id}
    return None


# ── stations ─────────────────────────────────────────────────────────────────

@bp.route("/api/radio/stations", methods=["GET"])
def list_stations():
    _wake_watcher()  # picks up a radio automation made since boot
    pid = _pid()
    if pid is None:
        return _need_profile()
    db = _db()
    favs = set(store.favourite_ids(db, pid))
    builtin = st.builtin_stations()
    kinds = []
    for meta in st.kinds_meta():
        kinds.append({**meta, "stations": [_public(s, pid, favs) for s in builtin if s.kind == meta["kind"]]})
    favourites = []
    for row in store.favourite_rows(db, pid):
        sid = row["station_id"]
        station = st.builtin_station(sid)
        if station is None and sid.startswith("rb-") and row.get("station_json"):
            try:
                station = _from_snapshot(json.loads(row["station_json"]))
            except ValueError:
                station = None
        if station is None and sid.startswith("link-"):
            continue  # links come below, for everyone
        if station is not None:
            favourites.append(_public(station, pid, favs))
    for link in store.list_links(db):
        ls = link_station(link)
        if ls is not None:
            item = _public(ls, pid, favs)
            item["link_ok"] = link.get("check_ok") is None or bool(link.get("check_ok"))
            favourites.append(item)
    counts = store.count_heard(db, pid, since=int(time.time()) - _settings()["keep_heard_days"] * 86400)
    return jsonify({"success": True, "favourites": favourites, "kinds": kinds,
                    "heard_count": counts["identified"], "session": _my_session(pid),
                    "identification": _settings()["identification"], "is_admin": bool(is_admin_request())})


@bp.route("/api/radio/stations/<station_id>", methods=["GET"])
def get_station(station_id):
    pid = _pid()
    if pid is None:
        return _need_profile()
    station = resolve_station(station_id)
    if station is None:
        return _err(404, "not_found", "That station isn't in the list, the directory or your links.")
    out = _public(station, pid)
    out["note"] = station.note
    session = _my_session(pid)
    db = _db()
    today = store.day_start()
    return jsonify({"success": True, "station": out,
                    "now_playing": hub.now_playing(station, pid),
                    "session": session if session and session["station_id"] == station.id else None,
                    "heard_today": store.count_heard(db, pid, since=today, station_id=station.id),
                    "identification": _settings()["identification"], "is_admin": bool(is_admin_request()),
                    "can_download": _download_denied(pid) is None, "scan": scanner.availability()})


@bp.route("/api/radio/stations/<station_id>/logo", methods=["GET"])
def station_logo(station_id):
    """A station's logo from our own origin (HANDOFF 55). Only a station the
    server resolved itself (built-in, directory by uuid, an admin's link), and
    only its own logo address: nothing here takes an address from the request.
    404 when there's none or it couldn't be used; the page shows the letters."""
    pid = _pid()
    if pid is None:
        return _need_profile()
    station = resolve_station(station_id)
    if station is None or not station.logo_url:
        return _err(404, "no_logo", "This station has no logo.")
    found = logos.logo_for(station.logo_url)
    if not found:
        return _err(404, "no_logo", "This station's logo couldn't be fetched.")
    path, mime = found
    response = send_file(path, mimetype=mime, conditional=True, max_age=86400)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    response.headers["Content-Disposition"] = f"inline; filename=logo{logos.MIME_EXT[mime]}"
    response.headers["Cache-Control"] = "private, max-age=86400"
    return response


@bp.route("/api/radio/favourites/<station_id>", methods=["POST", "DELETE"])
def favourite(station_id):
    pid = _pid()
    if pid is None:
        return _need_profile()
    db = _db()
    if request.method == "DELETE":
        store.remove_favourite(db, pid, station_id)
        return jsonify({"success": True, "favourite": False})
    station = resolve_station(station_id)
    if station is None:
        return _err(404, "not_found", "That station isn't in the list, the directory or your links.")
    store.add_favourite(db, pid, station.id, _snapshot(station) if station.source == "directory" else None)
    _wake_watcher()
    return jsonify({"success": True, "favourite": True})


@bp.route("/api/radio/directory", methods=["GET"])
def search_directory():
    pid = _pid()
    if pid is None:
        return _need_profile()
    args = request.args
    try:
        min_bitrate = int(args.get("min_bitrate") or 0)
        page = int(args.get("page") or 1)
    except ValueError:
        return _err(400, "bad_request", "Minimum bitrate and page are numbers.")
    try:
        results, more = directory.search(args.get("q") or "", codec=args.get("codec") or "",
                                         min_bitrate=min_bitrate, country=args.get("country") or "", page=page)
    except directory.DirectoryError as exc:
        return _err(502, "directory_unavailable", str(exc))
    favs = set(store.favourite_ids(_db(), pid))
    return jsonify({"success": True, "results": [_public(s, pid, favs) for s in results], "more": more,
                    "page": max(1, page), "total": (max(1, page) - 1) * directory.PAGE_SIZE + len(results)})


@bp.route("/api/radio/directory/countries", methods=["GET"])
def directory_countries():
    if _pid() is None:
        return _need_profile()
    try:
        return jsonify({"success": True, "countries": directory.countries()})
    except directory.DirectoryError as exc:
        return _err(502, "directory_unavailable", str(exc))


# ── playing ──────────────────────────────────────────────────────────────────

@bp.route("/api/radio/play", methods=["POST"])
def play():
    pid = _pid()
    if pid is None:
        return _need_profile()
    body = request.get_json(silent=True) or {}
    station = resolve_station(str(body.get("station_id") or ""))
    if station is None:
        return _err(404, "not_found", "That station isn't in the list, the directory or your links.")
    cfg = _settings()
    stream = st.pick_stream(station, str(body.get("stream_id") or "") or None, cfg["prefer_lossless"])
    if stream is None:
        return _err(404, "no_stream", "That stream isn't offered by this station.")
    direct = (stream.direct and stream.url.lower().startswith("https://") and station.has_now_playing
              and cfg["relay"] == "when_needed" and not body.get("force_relay"))
    mode = "direct" if direct else "relay"
    try:
        sess = hub.start_session(pid, station, stream, mode)
    except Busy:
        return jsonify({"success": False, "error": "busy",
                        "message": "Two stations are already playing through this server, which is as many as it "
                                   "relays at once. Try again when one stops."}), 409
    _wake_watcher()
    play_url = stream.url if direct else f"/api/radio/relay/{sess.id}"
    return jsonify({"success": True, "play_url": play_url, "mode": mode, "session_id": sess.id,
                    "station": _public(station, pid), "stream": {"id": stream.id, "label": stream.label(),
                                                                 "codec": stream.codec,
                                                                 "bitrate_kbps": stream.bitrate_kbps,
                                                                 "lossless": stream.lossless}})


@bp.route("/api/radio/stop", methods=["POST"])
def stop():
    pid = _pid()
    if pid is None:
        return _need_profile()
    body = request.get_json(silent=True) or {}
    ended = hub.end_session(str(body.get("session_id") or ""), pid)
    return jsonify({"success": True, "stopped": ended})


@bp.route("/api/radio/relay/<session_id>", methods=["GET"])
def relay(session_id):
    pid = _pid()
    if pid is None:
        return _need_profile()
    sess = hub.claim_relay(session_id, pid)
    if sess is None:
        return _err(404, "no_session", "That listening session has ended. Press Play again.")
    try:
        resp, kind = open_stream(sess.stream.url)
    except StreamError as exc:
        hub.relay_closed(sess.id)
        return _err(502, "stream_failed", str(exc))
    out = Response(relay_chunks(hub, sess, resp, kind), status=200, mimetype=kind, direct_passthrough=True)
    for k, v in RESPONSE_HEADERS.items():
        out.headers[k] = v
    return out


@bp.route("/api/radio/now-playing", methods=["GET"])
def now_playing():
    pid = _pid()
    if pid is None:
        return _need_profile()
    station = resolve_station(request.args.get("station_id") or "")
    if station is None:
        return _err(404, "not_found", "That station isn't in the list, the directory or your links.")
    sid = request.args.get("session_id")
    active = hub.touch(sid, pid) if sid else False
    data = hub.now_playing(station, pid)
    data["session_active"] = active
    data["heard_id"] = None
    data["added_at"] = None
    if data.get("state") == "identified" and data.get("track"):
        key = track_key(data["track"]["artist"], data["track"]["title"])
        row = store.find_heard(_db(), pid, station.id, key, int(time.time()) - 6 * 3600)
        if row:
            data["heard_id"] = row["id"]
            data["added_at"] = row.get("added_at")
    data["scan"] = scanner.availability()
    return jsonify({"success": True, **data})


# ── Scan now ─────────────────────────────────────────────────────────────────

@bp.route("/api/radio/scan", methods=["POST"])
def scan_start():
    """Listen to about ten seconds of the profile's station and identify it.
    Anyone who can listen can scan; one at a time and a few a minute each."""
    pid = _pid()
    if pid is None:
        return _need_profile()
    body = request.get_json(silent=True) or {}
    sess = hub.get_session(str(body.get("session_id") or ""), pid)
    if sess is None:
        return _err(404, "no_session", "Play the station first: Scan now listens to what's playing.")
    station = resolve_station(sess.station_id)
    if station is None:
        return _err(404, "not_found", "That station isn't in the list, the directory or your links.")
    try:
        scan = scanner.start(pid, sess, station)
    except ScanRefused as exc:
        out = jsonify({"success": False, "error": exc.code, "message": exc.message,
                       "retry_after": exc.retry_after})
        out.status_code = exc.status
        if exc.retry_after:
            out.headers["Retry-After"] = str(exc.retry_after)
        return out
    out = jsonify({"success": True, "scan_id": scan.id, **scan.public(time.time())})
    out.status_code = 202
    return out


@bp.route("/api/radio/scan/<scan_id>", methods=["GET"])
def scan_read(scan_id):
    pid = _pid()
    if pid is None:
        return _need_profile()
    scan = scanner.get(scan_id, pid)
    if scan is None:
        return _err(404, "not_found", "That scan has finished and been put away. Press Scan now again.")
    return jsonify({"success": True, **scan.public(time.time())})


# ── heard ────────────────────────────────────────────────────────────────────

def _heard_items(pid: int, rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    named = [r for r in rows if r.get("identified") and r.get("artist") and r.get("title")]
    checks: Dict[str, Dict[str, Any]] = {}
    unique: Dict[str, Dict[str, str]] = {}
    for r in named:
        unique.setdefault(track_key(r["artist"], r["title"]), {"name": r["title"], "artist": r["artist"]})
    if unique:
        keys = list(unique)
        try:
            results = _library_presence(pid, [unique[k] for k in keys]) or []
        except Exception as exc:  # noqa: BLE001 - unknown reads as "not in your library"
            logger.debug("heard library check failed: %s", exc)
            results = []
        for k, res in zip(keys, results, strict=False):
            checks[k] = res or {}
    from core.internet_radio.hub import judge_quality
    db = _db()
    out = []
    for r in rows:
        item = {"id": r["id"], "heard_at": r["heard_at"], "station_id": r["station_id"],
                "station_name": r["station_name"], "artist": r.get("artist") or None,
                "title": r.get("title") or None, "release": r.get("release") or None,
                "source": r.get("source"), "added_at": r.get("added_at"),
                "added_by_auto_add": bool(r.get("added_by_auto")), "duration_s": r.get("duration_s"),
                "reason": r.get("reason"), "below_target": None, "track_id": None}
        if not r.get("identified"):
            item["state"] = "not_identified"
        elif not r.get("artist"):
            item["state"] = "cant_match"
        else:
            res = checks.get(track_key(r["artist"], r["title"])) or {}
            if res.get("in_library"):
                item["state"] = "in_library"
                item["track_id"] = res.get("track_id")
                item["below_target"] = judge_quality(db, str(res.get("file_path") or ""), res.get("bitrate"))
            elif res.get("in_wishlist"):
                item["state"] = "added_by_auto_add" if r.get("added_by_auto") else "on_wanted"
            else:
                item["state"] = "not_added"
        out.append(item)
    return out


@bp.route("/api/radio/heard", methods=["GET"])
def heard():
    pid = _pid()
    if pid is None:
        return _need_profile()
    keep = _settings()["keep_heard_days"]
    try:
        days = int(request.args.get("days") or keep)
    except ValueError:
        days = keep
    days = max(1, min(days, keep))
    since = int(time.time()) - days * 86400
    station_id = request.args.get("station_id") or None
    rows = store.list_heard(_db(), pid, station_id=station_id, since=since, limit=MAX_HEARD)
    items = _heard_items(pid, rows)
    missing = sum(1 for i in items if i["state"] == "not_added")
    if request.args.get("missing") in ("1", "true"):
        items = [i for i in items if i["state"] == "not_added"]
    return jsonify({"success": True, "items": items, "days": days, "keep_days": keep,
                    "counts": {"total": len(rows), "not_in_library": missing,
                               "identified": sum(1 for r in rows if r.get("identified")),
                               "not_identified": sum(1 for r in rows if not r.get("identified"))}})


@bp.route("/api/radio/heard/<int:heard_id>/want", methods=["POST"])
def heard_want(heard_id):
    pid = _pid()
    if pid is None:
        return _need_profile()
    db = _db()
    row = store.get_heard(db, heard_id)
    if row is None or int(row["profile_id"]) != pid:
        return _err(404, "not_found", "That isn't in your Heard on radio list.")
    if not row.get("identified") or not row.get("artist") or not row.get("title"):
        return _err(400, "cant_match", "This one can't be matched: there's no artist to search for.")
    result = _add_to_wanted(pid, {"artist": row["artist"], "title": row["title"], "release": row.get("release"),
                                  "station_id": row["station_id"], "station_name": row["station_name"],
                                  "auto": False}) or {}
    if not result.get("ok") and not result.get("skipped"):
        return _err(502, "add_failed", result.get("message") or "It couldn't be added to Wanted. Try again.")
    if result.get("ok") and not result.get("skipped"):
        store.mark_heard_added(db, heard_id)
    hub.forget_library(pid, row["artist"], row["title"])
    item = _heard_items(pid, [store.get_heard(db, heard_id)])[0]
    return jsonify({"success": True, "item": item, "skipped": bool(result.get("skipped")),
                    "message": result.get("message") or ""})


# ── auto-add ─────────────────────────────────────────────────────────────────

def _auto_add_numbers(pid: int, station: st.Station) -> Dict[str, Any]:
    db = _db()
    yesterday = store.station_identified_keys(db, station.id, store.day_start(days_ago=1), store.day_start())
    have = 0
    if yesterday:
        try:
            res = _library_presence(pid, [{"name": t["title"], "artist": t["artist"]} for t in yesterday]) or []
        except Exception:  # noqa: BLE001
            res = []
        have = sum(1 for r in res if (r or {}).get("in_library") or (r or {}).get("in_wishlist"))
    limit = _settings()["daily_limit"]
    rest = max(0, len(yesterday) - have)
    return {"enabled": store.auto_add_enabled(db, pid, station.id), "identified_yesterday": len(yesterday),
            "already_have": have, "would_add": min(rest, limit), "would_add_without_limit": rest,
            "daily_limit": limit, "added_today": store.auto_added_since(db, pid, station.id, store.day_start()),
            "can_download": _download_denied(pid) is None, "has_now_playing": station.has_now_playing}


@bp.route("/api/radio/stations/<station_id>/auto-add", methods=["GET", "PUT"])
def auto_add(station_id):
    pid = _pid()
    if pid is None:
        return _need_profile()
    station = resolve_station(station_id)
    if station is None:
        return _err(404, "not_found", "That station isn't in the list, the directory or your links.")
    if request.method == "PUT":
        body = request.get_json(silent=True) or {}
        if not isinstance(body.get("enabled"), bool):
            return _err(400, "bad_request", "Say whether auto-add is on or off.")
        if body["enabled"]:
            denied = _download_denied(pid)
            if denied:
                return _err(403, "no_download_rights",
                            "Auto-add needs download rights, and this profile doesn't have them. Ask an admin.")
            if not _settings()["identification"]:
                return _err(409, "identification_off", "Track identification is off in Settings → Radio.")
        store.set_auto_add(_db(), pid, station.id, station.name, body["enabled"],
                           _snapshot(station) if station.source == "directory" else None)
        if body["enabled"]:
            _wake_watcher()
    return jsonify({"success": True, **_auto_add_numbers(pid, station)})


# ── tracklists ───────────────────────────────────────────────────────────────

def _station_shows(station: st.Station) -> List[Dict[str, Any]]:
    tl = station.tracklists or {}
    if tl.get("type") == "kexp":
        shows = feeds.fetch_kexp_shows()
        for show in shows:
            store.upsert_show(_db(), show_id=show["id"], station_id=station.id, title=show["title"],
                              aired_at=int(show["aired_at"]) if show.get("aired_at") else None, ended_at=None,
                              ref=show["ref"])
        return [store.get_show(_db(), s["id"]) for s in shows]
    if tl.get("type") == "nts":
        return store.list_shows(_db(), station.id, int(time.time()) - 7 * 86400)
    return []


def _tracks_for(show: Dict[str, Any]) -> List[Dict[str, Any]]:
    tracks = show.get("tracks")
    fresh = show.get("fetched_at") and time.time() - show["fetched_at"] < feeds.SHOWS_TTL
    if tracks is None or not fresh:
        tracks = feeds.fetch_tracks(show)
        store.save_show_tracks(_db(), show["id"], tracks)
    return tracks or []


def _track_rows(pid: int, tracks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    matchable = [(i, t) for i, t in enumerate(tracks) if t.get("artist") and t.get("title")]
    results: Dict[int, Dict[str, Any]] = {}
    if matchable:
        try:
            res = _library_presence(pid, [{"name": t["title"], "artist": t["artist"]} for _, t in matchable]) or []
        except Exception:  # noqa: BLE001
            res = []
        for (i, _t), r in zip(matchable, res, strict=False):
            results[i] = r or {}
    from core.internet_radio.hub import judge_quality
    db = _db()
    rows = []
    for i, t in enumerate(tracks):
        row = {"position": i + 1, "time": t.get("time"), "artist": t.get("artist") or None,
               "title": t.get("title") or None, "release": t.get("release") or None, "below_target": None,
               "track_id": None}
        if not t.get("artist") or not t.get("title"):
            row["state"] = "cant_match"
        else:
            r = results.get(i) or {}
            if r.get("in_library"):
                row["state"] = "in_library"
                row["track_id"] = r.get("track_id")
                row["below_target"] = judge_quality(db, str(r.get("file_path") or ""), r.get("bitrate"))
            elif r.get("in_wishlist"):
                row["state"] = "on_wanted"
            else:
                row["state"] = "not_added"
        rows.append(row)
    return rows


@bp.route("/api/radio/stations/<station_id>/shows", methods=["GET"])
def station_shows(station_id):
    pid = _pid()
    if pid is None:
        return _need_profile()
    station = resolve_station(station_id)
    if station is None:
        return _err(404, "not_found", "That station isn't in the list, the directory or your links.")
    if not station.has_tracklists:
        return jsonify({"success": True, "shows": [], "publishes": False})
    try:
        shows = [s for s in _station_shows(station) if s]
    except net.FetchError as exc:
        return _err(502, "feed_unavailable", f"{station.name}'s tracklists couldn't be read: {exc}")
    out = []
    for i, show in enumerate(shows[:8]):
        item = {"id": show["id"], "title": show["title"], "aired_at": show.get("aired_at"),
                "ended_at": show.get("ended_at"), "track_count": None, "missing_count": None}
        if i < 3:  # counts for the first few; the rest load when opened
            try:
                rows = _track_rows(pid, _tracks_for(show))
                item["track_count"] = len(rows)
                item["missing_count"] = sum(1 for r in rows if r["state"] == "not_added")
            except net.FetchError:
                pass
        out.append(item)
    return jsonify({"success": True, "shows": out, "publishes": True})


def _show_or_404(show_id: str):
    show = store.get_show(_db(), show_id)
    if show is None:
        return None, _err(404, "not_found", "That show's tracklist isn't available.")
    return show, None


@bp.route("/api/radio/shows/<path:show_id>", methods=["GET"])
def show_tracklist(show_id):
    pid = _pid()
    if pid is None:
        return _need_profile()
    show, err = _show_or_404(show_id)
    if err:
        return err
    station = resolve_station(show["station_id"])
    try:
        rows = _track_rows(pid, _tracks_for(show))
    except net.FetchError as exc:
        return _err(502, "feed_unavailable", f"The tracklist couldn't be read: {exc}")
    return jsonify({"success": True, "show": {"id": show["id"], "title": show["title"],
                                              "aired_at": show.get("aired_at"), "ended_at": show.get("ended_at"),
                                              "station_id": show["station_id"],
                                              "station_name": station.name if station else show["station_id"],
                                              "fetched_at": show.get("fetched_at"),
                                              "homepage": station.homepage if station else None},
                    "tracks": rows})


@bp.route("/api/radio/shows/<path:show_id>/want", methods=["POST"])
def show_want_one(show_id):
    """One tracklist row to Wanted, by its position in the station's list."""
    pid = _pid()
    if pid is None:
        return _need_profile()
    show, err = _show_or_404(show_id)
    if err:
        return err
    body = request.get_json(silent=True) or {}
    try:
        position = int(body.get("position"))
    except (TypeError, ValueError):
        return _err(400, "bad_request", "Say which track.")
    try:
        rows = _track_rows(pid, _tracks_for(show))
    except net.FetchError as exc:
        return _err(502, "feed_unavailable", f"The tracklist couldn't be read: {exc}")
    row = next((r for r in rows if r["position"] == position), None)
    if row is None:
        return _err(404, "not_found", "That track isn't in this tracklist.")
    if row["state"] == "cant_match":
        return _err(400, "cant_match", "This one can't be matched: there's no artist to search for.")
    station = resolve_station(show["station_id"])
    result = _add_to_wanted(pid, {"artist": row["artist"], "title": row["title"], "release": row.get("release"),
                                  "station_id": show["station_id"], "station_name": station.name if station else "",
                                  "auto": False}) or {}
    if not result.get("ok") and not result.get("skipped"):
        return _err(502, "add_failed", result.get("message") or "It couldn't be added to Wanted. Try again.")
    hub.forget_library(pid, row["artist"], row["title"])
    fresh = _track_rows(pid, _tracks_for(show))
    return jsonify({"success": True, "track": next((r for r in fresh if r["position"] == position), row),
                    "skipped": bool(result.get("skipped")), "message": result.get("message") or ""})


@bp.route("/api/radio/shows/<path:show_id>/want-missing", methods=["POST"])
def show_want_missing(show_id):
    pid = _pid()
    if pid is None:
        return _need_profile()
    show, err = _show_or_404(show_id)
    if err:
        return err
    station = resolve_station(show["station_id"])
    try:
        rows = _track_rows(pid, _tracks_for(show))
    except net.FetchError as exc:
        return _err(502, "feed_unavailable", f"The tracklist couldn't be read: {exc}")
    added, skipped = 0, 0
    for row in rows:
        if row["state"] != "not_added":
            skipped += 1
            continue
        result = _add_to_wanted(pid, {"artist": row["artist"], "title": row["title"], "release": row.get("release"),
                                      "station_id": show["station_id"],
                                      "station_name": station.name if station else "", "auto": False}) or {}
        if result.get("ok") and not result.get("skipped"):
            added += 1
        else:
            skipped += 1
    return jsonify({"success": True, "added": added, "skipped": skipped})


# ── your stream links (admins) ───────────────────────────────────────────────

def _public_link(link: Dict[str, Any]) -> Dict[str, Any]:
    return {"id": link["id"], "station_id": f"link-{link['id']}", "name": link["name"], "url": link["url"],
            "kind": link["kind"], "codec": link.get("codec") or "", "bitrate_kbps": link.get("bitrate_kbps") or 0,
            "sends_titles": None if link.get("sends_titles") is None else bool(link["sends_titles"]),
            "check_ok": None if link.get("check_ok") is None else bool(link["check_ok"]),
            "checked_at": link.get("checked_at"), "check_error": link.get("check_error"),
            "added_by": link.get("added_by"), "added_at": link.get("added_at"),
            "logo_url": link.get("logo_url") or None}


def _checked(url: str) -> Dict[str, Any]:
    ok, reason = check_url(url)
    if not ok:
        return {"ok": False, "error": reason, "codec": "", "bitrate_kbps": 0, "sends_titles": False,
                "allows_direct": False, "answered_in_s": None}
    return check_link(url)


def _check_logo(url: str) -> Optional[str]:
    """None when an admin's logo address is usable, else the sentence to show.
    Checked the way a stream link is (an http(s) address on the internet), and
    then fetched once: it has to be a PNG, JPEG, GIF, WebP or ICO image of at
    most 512 KB, which also puts it in the cache."""
    ok, reason = logos.check_source(url)
    if ok:
        ok, reason = check_url(url)
    if not ok:
        return reason
    try:
        data, mime = logos.fetch(url)
    except logos.LogoError as exc:
        return str(exc)
    try:
        logos._store(url, data, mime)  # noqa: SLF001 - the check's fetch is the first cache fill
    except OSError:
        pass
    return None


@bp.route("/api/radio/links", methods=["GET"])
@admin_only
def list_links():
    return jsonify({"success": True, "links": [_public_link(x) for x in store.list_links(_db())]})


@bp.route("/api/radio/links/check", methods=["POST"])
@admin_only
def check_new_link():
    body = request.get_json(silent=True) or {}
    url = str(body.get("url") or "").strip()
    if not url or len(url) > 2000:
        return _err(400, "bad_request", "Paste a stream link first.")
    return jsonify({"success": True, **_checked(url)})


@bp.route("/api/radio/links", methods=["POST"])
@admin_only
def add_link():
    body = request.get_json(silent=True) or {}
    url = str(body.get("url") or "").strip()
    name = " ".join(str(body.get("name") or "").split())[:80]
    kind = str(body.get("kind") or "")
    if not url or len(url) > 2000:
        return _err(400, "bad_request", "Paste a stream link first.")
    if not name:
        return _err(400, "bad_request", "Give the station a name.")
    if kind not in st.KINDS:
        return _err(400, "bad_request", "Choose a kind.")
    logo_url = str(body.get("logo_url") or "").strip()
    if logo_url:
        error = _check_logo(logo_url)
        if error:
            return _err(400, "logo_failed", error)
    result = _checked(url)
    if not result.get("ok"):
        return _err(400, "check_failed", str(result.get("error") or "This link didn't pass the check."))
    link_id = store.add_link(_db(), name=name, url=url, kind=kind, codec=str(result.get("codec") or ""),
                             bitrate_kbps=int(result.get("bitrate_kbps") or 0),
                             sends_titles=bool(result.get("sends_titles")),
                             allows_direct=bool(result.get("allows_direct")), added_by=_actor_name(),
                             logo_url=logo_url or None)
    return jsonify({"success": True, "link": _public_link(store.get_link(_db(), link_id))})


@bp.route("/api/radio/links/<int:link_id>/check", methods=["POST"])
@admin_only
def recheck_link(link_id):
    link = store.get_link(_db(), link_id)
    if link is None:
        return _err(404, "not_found", "That link isn't there any more.")
    result = _checked(link["url"])
    store.record_link_check(_db(), link_id, ok=bool(result.get("ok")), error=result.get("error"),
                            codec=str(result.get("codec") or ""), bitrate_kbps=int(result.get("bitrate_kbps") or 0),
                            sends_titles=result.get("sends_titles") if result.get("ok") else None)
    return jsonify({"success": True, **result, "link": _public_link(store.get_link(_db(), link_id))})


@bp.route("/api/radio/links/<int:link_id>", methods=["DELETE"])
@admin_only
def delete_link(link_id):
    if not store.remove_link(_db(), link_id):
        return _err(404, "not_found", "That link isn't there any more.")
    return jsonify({"success": True})


@bp.route("/api/radio/links/<int:link_id>", methods=["PUT"])
@admin_only
def update_link(link_id):
    """Change a link's logo (HANDOFF 66): ``{logo_url}``, checked and fetched
    the way adding a link checks it; an empty one goes back to the letters."""
    body = request.get_json(silent=True) or {}
    if store.get_link(_db(), link_id) is None:
        return _err(404, "not_found", "That link isn't there any more.")
    if "logo_url" not in body:
        return _err(400, "bad_request", "Send the logo address.")
    raw = body.get("logo_url")
    if raw is not None and not isinstance(raw, str):
        return _err(400, "bad_request", "The logo address is text.")
    logo_url = (raw or "").strip()
    if len(logo_url) > 2000:
        return _err(400, "logo_failed", "That address is too long to be a logo's.")
    if logo_url:
        error = _check_logo(logo_url)
        if error:
            return _err(400, "logo_failed", error)
    store.set_link_logo(_db(), link_id, logo_url or None)
    return jsonify({"success": True, "link": _public_link(store.get_link(_db(), link_id))})


# ── settings (admins) ────────────────────────────────────────────────────────

def _identification_status() -> Dict[str, Any]:
    fp = setup_rows.find_fpcalc()
    key = radio_settings.acoustid_key(config_manager)
    last = setup_rows.last("radio.acoustid")
    if not key:
        acoustid = {"state": "missing", "detail": "No AcoustID key", "checked_at": None}
    elif last and last.get("status") == "ok":
        acoustid = {"state": "ok", "detail": "AcoustID answered", "checked_at": last.get("checked_at")}
    elif last and last.get("status") == "error":
        acoustid = {"state": "refused", "detail": "AcoustID refused the key", "checked_at": last.get("checked_at")}
    elif last:
        acoustid = {"state": "unreachable", "detail": "AcoustID didn't answer", "checked_at": last.get("checked_at")}
    else:
        acoustid = {"state": "untested", "detail": "Not checked yet", "checked_at": None}
    return {"fpcalc": {"found": bool(fp), "detail": "fpcalc found" if fp else "fpcalc not installed"},
            "acoustid": acoustid}


def _settings_payload() -> Dict[str, Any]:
    db = _db()
    rows = store.auto_add_rows(db)
    return {"success": True, "settings": radio_settings.public(config_manager),
            "status": _identification_status(),
            "auto_add": {"stations": [{"station_id": r["station_id"], "station_name": r["station_name"],
                                       "profile_id": r["profile_id"]} for r in rows],
                         "added_this_week": store.added_this_week(db)},
            "links": [_public_link(x) for x in store.list_links(db)],
            "scan": _scan_status(db), "is_admin": True}


def _scan_status(db) -> Dict[str, Any]:
    """Scan now's services for Settings → Radio: which are ready, in the order
    a scan asks them, and this month's requests. Never the keys."""
    services = radio_settings.scan_services_public(config_manager)
    try:
        usage = store.scan_usage(db)
    except Exception:  # noqa: BLE001 - no counts beats no settings
        usage = {}
    ready = {"acoustid": bool(radio_settings.acoustid_key(config_manager)) and bool(setup_rows.find_fpcalc()),
             "audd": services["audd_ready"], "acrcloud": services["acrcloud_ready"]}
    return {"order": ["acoustid", "audd", "acrcloud"], "labels": dict(SCAN_LABELS), "ready": ready,
            "usage": {k: usage.get(k, {"requests": 0, "found": 0}) for k in ("acoustid", "audd", "acrcloud")},
            "services": _scan_service_states(db, ready),
            "month": time.strftime("%B"), "available": scanner.availability()}


def _scan_service_states(db, ready: Dict[str, bool]) -> Dict[str, Dict[str, Any]]:
    """Each service's tag and the date its key was saved (11c): ``ready``,
    ``not_set_up``, ``refused`` (the service refused the key at its last answer)
    or ``no_requests_left`` (said so this month). ``set_at`` is when the key was
    saved through Settings → Radio, or null when that isn't known (a key saved
    before this was recorded, or AcoustID's saved elsewhere). Never a key."""
    try:
        known = store.scan_key_states(db)
    except Exception:  # noqa: BLE001 - no dates beats no settings
        known = {}
    month = store.month_key()
    out: Dict[str, Dict[str, Any]] = {}
    for name in ("acoustid", "audd", "acrcloud"):
        row = known.get(name) or {}
        last = row.get("state")
        if name == "acoustid" and radio_settings.acoustid_key(config_manager):
            # Setup check also asks AcoustID; the newer answer counts
            check = setup_rows.last("radio.acoustid")
            if check and (check.get("checked_at") or 0) >= (row.get("state_at") or 0) and (
                    row.get("set_at") is None or (check.get("checked_at") or 0) >= row["set_at"]):
                last = "bad_key" if check.get("status") == "error" else "ok"
        if not ready.get(name):
            state = "not_set_up"
        elif last == "bad_key":
            state = "refused"
        elif last == "out_of_credit" and row.get("state_at") and store.month_key(row["state_at"]) == month:
            state = "no_requests_left"
        else:
            state = "ready"
        out[name] = {"state": state, "set_at": row.get("set_at")}
    return out


def _member_settings_payload() -> Dict[str, Any]:
    """Settings → Radio for a member (11c): Scan now's rows and their tags only.
    No settings, keys, dates or counts."""
    status = _scan_status(_db())
    return {"success": True, "is_admin": False,
            "scan": {"order": status["order"], "labels": status["labels"],
                     "services": {k: {"state": v["state"]} for k, v in status["services"].items()}}}


@bp.route("/api/radio/settings", methods=["GET"])
def get_settings():
    if not is_admin_request():
        if _pid() is None:
            return _need_profile()
        # members see Scan now's rows and tags (11c), nothing else
        return jsonify(_member_settings_payload())
    return jsonify(_settings_payload())


@bp.route("/api/radio/settings", methods=["PUT"])
@admin_only
def put_settings():
    try:
        _, saved, removed = radio_settings.save_with_changes(config_manager, request.get_json(silent=True))
    except radio_settings.SettingsError as exc:
        return _err(400, "bad_request", str(exc))
    try:
        for name in saved:
            store.record_scan_key_saved(_db(), name)
        for name in removed:
            store.forget_scan_key(_db(), name)
    except Exception as exc:  # noqa: BLE001 - the keys are saved; a missing date isn't worth failing for
        logger.debug("scan key date not recorded: %s", exc)
    return jsonify(_settings_payload())


@bp.route("/api/radio/scan/test", methods=["POST"])
@admin_only
def scan_test():
    """Ask one service whether it accepts the saved key. AcoustID's check is
    free; AudD's and ACRCloud's send one second of silence (one request)."""
    body = request.get_json(silent=True) or {}
    service = str(body.get("service") or "")
    if service not in SCAN_LABELS:
        return _err(400, "bad_request", "Test AcoustID, AudD or ACRCloud.")
    result = check_service(config_manager, service, fpcalc=setup_rows.find_fpcalc())
    if result["spends"] and result["state"] not in ("missing", "offline"):
        try:
            store.bump_scan_usage(_db(), service)
        except Exception as exc:  # noqa: BLE001
            logger.debug("test not counted: %s", exc)
    try:
        store.record_scan_key_answer(_db(), service, result["state"])
    except Exception as exc:  # noqa: BLE001
        logger.debug("test answer not recorded: %s", exc)
    status = _scan_status(_db())
    return jsonify({"success": True, "service": service, **result, "usage": status["usage"],
                    "services": status["services"]})


def create_blueprint() -> Blueprint:
    return bp


__all__ = ["bp", "configure", "create_blueprint", "resolve_station", "start_watcher", "stop_watcher", "watcher",
           "scanner"]
