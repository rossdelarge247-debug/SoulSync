"""Library → Albums, Genres and Artists (boards 7a–7g): the release index and
what the grid does with a selection.

GET  /api/library/releases
    The albums grid: your albums and your artists' albums you don't have, each
    with its library state, genres and Wanted state. Params ``show``
    (all | library | missing | below), ``genre``, ``q`` (title, artist or
    genre), ``sort`` (recent | artist | title | year | genre), ``page``,
    ``limit`` (50, at most 200). Answers the page plus ``show_counts`` (with
    the genre and text filter applied), ``genres`` (counts with the show and
    text filter applied), ``totals``, ``missing_summary`` (what "Select all N
    missing" would pick) and, with a genre, ``genre_summary`` (board 7b).
GET  /api/library/genres
    The Genres tab: one tile per genre. ``show`` (all | gaps), ``sort``
    (albums | name), ``q``.
GET  /api/library/artist-index
    The Artists grid: releases, in-library counts and following state per
    library artist. ``show`` (all | following | incomplete), ``genre``, ``q``,
    ``sort`` (name | recent | missing), ``page``, ``limit``.
POST /api/library/releases/summary
    The confirm's numbers (7d) for a selection: ``release_ids`` and/or
    ``filter`` + ``exclude_ids`` (core/library/release_index.resolve_selection).
POST /api/library/artists/follow
    ``{artist_ids: [library artist ids]}``: follow each (the watchlist, per
    profile). Answers ``{followed, already_following, no_id}``.
POST /api/library/albums/upgrade  (admins)
    The genre line's "Upgrade the N below target": applies the pending
    quality-upgrade findings for those albums' tracks (each better copy goes
    on Wanted), as the Apply Quality Upgrades automation does.
GET  /api/library/missing-releases
POST /api/library/missing-releases/start  (admins)
POST /api/library/missing-releases/stop   (admins)
    Look for releases you don't have: a background job that fetches the
    discography of every library artist the metadata cache lists nothing for
    (core/library/missing_releases.py), shown in Activity.

POST /api/library/albums/remove-preview  (admins)
POST /api/library/albums/remove          (admins, ``{plan_id}``)
    Remove from library, through Preview then confirm: the albums' files go to
    the recycle bin and their rows leave the library.

The bulk add itself is ``POST /api/wishlist/bulk`` with ``action: "add"``
(api/wishlist_routes.py), which calls :func:`bulk_add` here.

Every read and write is the acting profile's (``acting_profile_id``) in the
caller's library scope, like the other library and Wanted routes.
"""

from __future__ import annotations

import os
import shutil
from typing import Any, Dict, List, Optional, Tuple

from flask import Blueprint, jsonify, request

from core.library import release_index as _index
from core.profile_context import admin_only, get_current_profile_id
from utils.logging_config import get_logger

logger = get_logger("api.library_index")

bp = Blueprint("library_index", __name__)

get_database = None
fix_art_url = None
resolve_library_path = None
transfer_folder = None
bulk_fix_findings = None

REMOVE_TOOL = "library_album_remove"


def configure(*, get_database_, fix_art_url_=None, resolve_library_path_=None, transfer_folder_=None,
              bulk_fix_findings_=None) -> None:
    """``fix_art_url_(url)`` makes stored art loadable; ``resolve_library_path_
    (path)`` finds a track's file on this machine; ``transfer_folder_()`` is
    the library folder the recycle bin sits in; ``bulk_fix_findings_(ids)``
    applies Library Maintenance findings (None while it isn't running)."""
    global get_database, fix_art_url, resolve_library_path, transfer_folder, bulk_fix_findings
    get_database = get_database_
    fix_art_url = fix_art_url_
    resolve_library_path = resolve_library_path_
    transfer_folder = transfer_folder_
    bulk_fix_findings = bulk_fix_findings_


def _profile(body: Optional[Dict[str, Any]] = None) -> Optional[int]:
    from api.helpers import acting_profile_id
    if get_current_profile_id() is None:
        return None
    requested = (body or {}).get("profile_id") if body else request.args.get("profile_id")
    return acting_profile_id(request, requested)


def _index_for(pid: int):
    return _index.get_index(get_database(), pid, fix_art=fix_art_url)


def _no_profile():
    return jsonify({"success": False, "error": "profile_required"}), 401


@bp.route("/api/library/releases", methods=["GET"])
def get_releases():
    pid = _profile()
    if pid is None:
        return _no_profile()
    try:
        index = _index_for(pid)
        a = request.args
        body = _index.album_page(index, show=a.get("show"), genre=a.get("genre"), q=a.get("q"),
                                 sort=a.get("sort"), page=a.get("page"), limit=a.get("limit"))
    except Exception as exc:  # noqa: BLE001
        logger.error("releases index failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    return jsonify({"success": True, **body, "built_ms": index.built_ms})


@bp.route("/api/library/genres", methods=["GET"])
def get_genres():
    pid = _profile()
    if pid is None:
        return _no_profile()
    try:
        index = _index_for(pid)
        a = request.args
        body = _index.genre_tiles(index, show=a.get("show"), sort=a.get("sort"), q=a.get("q"))
    except Exception as exc:  # noqa: BLE001
        logger.error("genres index failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    return jsonify({"success": True, **body})


@bp.route("/api/library/artist-index", methods=["GET"])
def get_artist_index():
    pid = _profile()
    if pid is None:
        return _no_profile()
    try:
        index = _index_for(pid)
        a = request.args
        body = _index.artist_page(index, show=a.get("show"), genre=a.get("genre"), q=a.get("q"),
                                  sort=a.get("sort"), page=a.get("page"), limit=a.get("limit"))
    except Exception as exc:  # noqa: BLE001
        logger.error("artist index failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    return jsonify({"success": True, **body})


def _selection(body: Dict[str, Any], pid: int) -> Tuple[Any, List[Dict[str, Any]], List[str], Optional[tuple]]:
    """(index, releases, unknown ids, error response or None)."""
    if not isinstance(body.get("release_ids") or [], list):
        return None, [], [], (jsonify({"success": False, "error": "release_ids must be a list"}), 400)
    if not body.get("release_ids") and not isinstance(body.get("filter"), dict):
        return None, [], [], (jsonify({"success": False, "error": "Choose some albums first"}), 400)
    index = _index_for(pid)
    releases, unknown = _index.resolve_selection(index, body)
    if len(releases) > _index.MAX_SELECTION:
        return index, releases, unknown, (jsonify({
            "success": False, "error": "too_many",
            "count": len(releases), "max": _index.MAX_SELECTION,
            "message": f"That's {len(releases):,} albums. Add up to {_index.MAX_SELECTION} at a time: "
                       "pick a genre or an artist to narrow it."}), 400)
    return index, releases, unknown, None


@bp.route("/api/library/releases/summary", methods=["POST"])
def post_selection_summary():
    body = request.get_json(silent=True) or {}
    pid = _profile(body)
    if pid is None:
        return _no_profile()
    try:
        index, releases, unknown, error = _selection(body, pid)
        if error:
            return error
        try:
            sample = max(1, min(_index.MAX_SELECTION, int(body.get("sample") or 4)))
        except (TypeError, ValueError):
            sample = 4
        summary = _index.selection_summary(index, releases, sample=sample)
    except Exception as exc:  # noqa: BLE001
        logger.error("selection summary failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    return jsonify({"success": True, **summary, "unknown_ids": unknown})


def _quality(value: Any) -> Tuple[Optional[int], Optional[tuple]]:
    """``"target"`` / missing -> None (the default profile, the target);
    otherwise a quality profile id that must exist."""
    if value in (None, "", "target"):
        return None, None
    try:
        qid = int(value)
    except (TypeError, ValueError):
        return None, (jsonify({"success": False, "error": "unknown_quality",
                               "message": "Pick one of your quality profiles, or the quality target."}), 400)
    if not get_database().quality_profile_exists(qid):
        return None, (jsonify({"success": False, "error": "unknown_quality",
                               "message": "That quality profile doesn't exist any more."}), 400)
    return qid, None


def _asks_first(pid: int) -> bool:
    from core.permissions import profile_can_download
    try:
        return not profile_can_download(get_database().get_profile(pid))
    except Exception:  # noqa: BLE001
        return False


def bulk_add(body: Dict[str, Any]):
    """``POST /api/wishlist/bulk`` with ``action: "add"``: put a selection of
    releases on Wanted. Body: the selection (``release_ids`` and/or ``filter``
    + ``exclude_ids``), ``quality`` (``"target"`` or a quality profile id) and
    ``follow_artists`` (also follow the selection's artists). Answers
    ``{added, already_wanted, already_have, failed, refused, tracks_added,
    asks_first, followed, results}``."""
    from core.library.bulk_wanted import add_releases
    pid = _profile(body)
    if pid is None:
        return _no_profile()
    quality_id, error = _quality(body.get("quality"))
    if error:
        return error
    try:
        index, releases, unknown, error = _selection(body, pid)
        if error:
            return error
        result = add_releases(get_database(), releases, profile_id=pid, quality_profile_id=quality_id)
        followed = None
        if body.get("follow_artists"):
            artist_ids = list({r["artist_id"] for r in releases if r["artist_id"] is not None})
            followed = follow_artists(artist_ids, pid)
    except Exception as exc:  # noqa: BLE001
        logger.error("bulk add to Wanted failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't add them to Wanted"}), 500
    finally:
        _index.clear_cache()
    return jsonify({"success": True, **result, "unknown_ids": unknown, "asks_first": _asks_first(pid),
                    "followed": followed})


def follow_artists(artist_ids: List[Any], pid: int) -> Dict[str, int]:
    """Follow library artists for a profile, each on the first source the
    library has an id for (the active discovery source first)."""
    from core.watchlist.source_picker import SOURCE_ID_COLUMNS, pick_artist_id_for_watchlist
    database = get_database()
    try:
        from core.metadata.registry import get_primary_source
        active = get_primary_source()
    except Exception:  # noqa: BLE001
        active = None
    out = {"followed": 0, "already_following": 0, "no_id": 0}
    ids = [a for a in artist_ids if a not in (None, "")][:500]
    if not ids:
        return out
    columns = ", ".join(sorted({c for _s, c in SOURCE_ID_COLUMNS}))
    conn = database._get_connection()
    try:
        marks = ",".join("?" * len(ids))
        rows = conn.execute(f"SELECT id, name, thumb_url, {columns} FROM artists WHERE id IN ({marks})",
                            [str(i) for i in ids]).fetchall()
    finally:
        conn.close()
    for row in rows:
        artist = dict(row)
        source_id, source = pick_artist_id_for_watchlist(artist, active)
        if not source_id:
            out["no_id"] += 1
            continue
        if database.is_artist_in_watchlist(source_id, profile_id=pid, artist_name=artist.get("name")):
            out["already_following"] += 1
            continue
        if database.add_artist_to_watchlist(source_id, artist.get("name") or "", profile_id=pid, source=source):
            out["followed"] += 1
            if artist.get("thumb_url"):
                try:
                    database.update_watchlist_artist_image(source_id, artist["thumb_url"])
                except Exception as exc:  # noqa: BLE001
                    logger.debug("watchlist image update failed: %s", exc)
    return out


@bp.route("/api/library/artists/follow", methods=["POST"])
def post_follow_artists():
    body = request.get_json(silent=True) or {}
    pid = _profile(body)
    if pid is None:
        return _no_profile()
    ids = body.get("artist_ids")
    if not isinstance(ids, list) or not ids:
        return jsonify({"success": False, "error": "artist_ids required"}), 400
    try:
        result = follow_artists(ids, pid)
    except Exception as exc:  # noqa: BLE001
        logger.error("follow artists failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't follow them"}), 500
    finally:
        _index.clear_cache()
    return jsonify({"success": True, **result})


# ── Upgrade what's below the target ──────────────────────────────────────────


@bp.route("/api/library/albums/upgrade", methods=["POST"])
@admin_only
def upgrade_albums():
    """``{album_ids}`` (or a selection): the genre line's "Upgrade the N below
    target" (7b). Applies the Quality Upgrade Finder's pending findings for
    those albums' tracks, as the Apply Quality Upgrades automation does: each
    better copy goes on Wanted. Albums whose tracks have no finding yet are
    counted, not guessed at."""
    from core.quality.upgrades import pending_upgrades_for_tracks
    body = request.get_json(silent=True) or {}
    pid = _profile(body) or 1
    album_ids = _album_ids(body, pid)
    if not album_ids:
        return jsonify({"success": False, "error": "Choose albums you have first"}), 400
    database = get_database()
    conn = database._get_connection()
    try:
        marks = ",".join("?" * len(album_ids))
        rows = conn.execute(f"SELECT id, album_id FROM tracks WHERE album_id IN ({marks}) AND file_path IS NOT NULL",
                            [str(a) for a in album_ids]).fetchall()
    finally:
        conn.close()
    pending = pending_upgrades_for_tracks(database, [r["id"] for r in rows])
    finding_ids = sorted({int(p["finding_id"]) for p in pending.values() if p.get("finding_id") is not None})
    with_findings = {str(r["album_id"]) for r in rows if str(r["id"]) in pending}
    result = {"fixed": 0, "failed": 0}
    if finding_ids:
        if bulk_fix_findings is None:
            return jsonify({"success": False, "error": "maintenance_off",
                            "message": "Library Maintenance isn't running, so nothing could be queued."}), 503
        result = bulk_fix_findings(finding_ids) or result
    _index.clear_cache()
    return jsonify({"success": True, "queued": int(result.get("fixed") or 0), "failed": int(result.get("failed") or 0),
                    "albums": len(album_ids), "albums_with_upgrades": len(with_findings),
                    "albums_without": len(album_ids) - len(with_findings)})


# ── Remove from library (Preview, then confirm) ──────────────────────────────


def _album_ids(body: Dict[str, Any], pid: int) -> List[Any]:
    ids: List[Any] = [a for a in body.get("album_ids") or [] if a not in (None, "")]
    if body.get("release_ids") or isinstance(body.get("filter"), dict):
        index = _index_for(pid)
        releases, _unknown = _index.resolve_selection(index, body)
        ids.extend(r["album_id"] for r in releases if r.get("album_id") is not None)
    seen = []
    for a in ids:
        if str(a) not in [str(s) for s in seen]:
            seen.append(a)
    return seen[:_index.MAX_SELECTION]


@bp.route("/api/library/albums/remove-preview", methods=["POST"])
@admin_only
def remove_preview():
    """The plan: every file of the chosen albums, which goes to the recycle bin."""
    from core.library.action_plans import plan_store
    body = request.get_json(silent=True) or {}
    pid = _profile(body) or 1
    album_ids = _album_ids(body, pid)
    if not album_ids:
        return jsonify({"success": False, "error": "Choose albums you have first"}), 400
    database = get_database()
    conn = database._get_connection()
    try:
        marks = ",".join("?" * len(album_ids))
        rows = conn.execute(
            f"SELECT t.id AS track_id, t.title AS track, t.file_path, t.file_size, al.id AS album_id, "
            f"al.title AS album, ar.name AS artist FROM tracks t JOIN albums al ON al.id = t.album_id "
            f"LEFT JOIN artists ar ON ar.id = al.artist_id WHERE al.id IN ({marks}) ORDER BY ar.name, al.title, "
            f"t.disc_number, t.track_number", [str(a) for a in album_ids]).fetchall()
    finally:
        conn.close()
    items = []
    albums = set()
    for row in rows:
        albums.add(str(row["album_id"]))
        path = row["file_path"] or ""
        local = resolve_library_path(path) if (resolve_library_path and path) else path
        size = row["file_size"]
        if size in (None, 0) and local and os.path.isfile(local):
            try:
                size = os.path.getsize(local)
            except OSError:
                size = None
        items.append({
            "path": local or path,
            "action": "recycle" if path else "forget",
            "reason": f"{row['artist'] or 'Unknown artist'} · {row['album']}",
            "size": size or 0,
            "album_id": row["album_id"],
            "track_id": row["track_id"],
        })
    plan = plan_store.create(REMOVE_TOOL, items, meta={"albums": len(albums), "album_ids": sorted(albums)})
    return jsonify({"success": True, **plan.summary()})


@bp.route("/api/library/albums/remove", methods=["POST"])
@admin_only
def remove_confirm():
    from core.library.action_plans import PlanError, plan_store
    body = request.get_json(silent=True) or {}
    try:
        plan = plan_store.consume(body.get("plan_id"), REMOVE_TOOL)
    except PlanError as exc:
        return jsonify({"success": False, "code": exc.code, "error": exc.message}), 409
    moved, skipped, errors = 0, 0, []
    folder = transfer_folder() if transfer_folder else ""
    deleted_root = None
    if folder:
        from core.repair_jobs.base import deleted_quarantine_root
        deleted_root = deleted_quarantine_root(folder)
    from core.library.deleted_quarantine import record_deleted_entry
    from core.library.duplicate_cleaner import _recycle_dest
    for item in plan.items:
        path = item.get("path")
        if item.get("action") != "recycle" or not path:
            continue
        if not os.path.isfile(path):
            skipped += 1
            continue
        if not deleted_root:
            errors.append({"path": path, "error": "No library folder is set, so there's no recycle bin"})
            continue
        dest = _recycle_dest(deleted_root, folder, path)
        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.move(path, dest)
        except OSError as exc:
            errors.append({"path": path, "error": str(exc)})
            continue
        record_deleted_entry(deleted_root, dest, path, "library-remove")
        moved += 1
    failed_albums = {str(i.get("album_id")) for i in plan.items if i.get("path") in {e["path"] for e in errors}}
    album_ids = [a for a in plan.meta.get("album_ids") or [] if a not in failed_albums]
    removed = 0
    if album_ids:
        database = get_database()
        conn = database._get_connection()
        try:
            marks = ",".join("?" * len(album_ids))
            conn.execute(f"DELETE FROM tracks WHERE album_id IN ({marks})", album_ids)
            removed = conn.execute(f"DELETE FROM albums WHERE id IN ({marks})", album_ids).rowcount
            conn.commit()
        finally:
            conn.close()
    _index.clear_cache()
    logger.warning("[Library] Removed %s album(s): %s file(s) to the recycle bin, %s already gone, %s failed",
                   removed, moved, skipped, len(errors))
    return jsonify({"success": True, "albums_removed": removed, "files_moved": moved, "skipped": skipped,
                    "errors": errors[:20], "kept_albums": len(failed_albums)})


# ── Look for releases you don't have (HANDOFF 68) ───────────────────────────

def _missing_job():
    from core.library import missing_releases
    return missing_releases


@bp.route("/api/library/missing-releases", methods=["GET"])
def get_missing_releases():
    """The running job or the last run, how many artists the cache lists
    nothing for, and whether this profile may start one (admins)."""
    pid = _profile()
    if pid is None:
        return _no_profile()
    from core.profile_context import is_admin_request
    jobs = _missing_job()
    try:
        candidates = len(_index.artists_without_releases(_index_for(pid)))
        state = jobs.public_state(get_database())
    except Exception as exc:  # noqa: BLE001
        logger.error("missing releases state failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    response = jsonify({"success": True, "job": state, "candidates": candidates,
                        "can_start": bool(is_admin_request())})
    response.headers["Cache-Control"] = "no-store"
    return response


@bp.route("/api/library/missing-releases/start", methods=["POST"])
@admin_only
def start_missing_releases():
    """Start fetching the discography of every library artist the metadata
    cache lists nothing for, in the background (Activity shows it)."""
    pid = _profile() or 1
    jobs = _missing_job()
    from core.library_scope import current_library_scope, reset_library_scope, set_library_scope
    database = get_database()
    artists = _index.artists_without_releases(_index_for(pid))
    if not artists:
        return jsonify({"success": False, "error": "Every artist in your library already has its releases listed."}), 409
    scope = current_library_scope()

    def on_finish(state):
        token = set_library_scope(scope)
        try:
            return jobs.count_found(database, pid, state["checked"], fix_art=fix_art_url)
        finally:
            reset_library_scope(token)

    try:
        jobs.JOB.start(database, pid, artists, on_finish=on_finish)
    except jobs.JobRunning as exc:
        return jsonify({"success": False, "error": str(exc)}), 409
    return jsonify({"success": True, "job": jobs.public_state(database)}), 202


@bp.route("/api/library/missing-releases/stop", methods=["POST"])
@admin_only
def stop_missing_releases():
    jobs = _missing_job()
    if not jobs.JOB.stop():
        return jsonify({"success": False, "error": "Nothing is looking for releases right now."}), 409
    return jsonify({"success": True})


def create_blueprint():
    return bp


__all__ = ["REMOVE_TOOL", "bp", "bulk_add", "configure", "create_blueprint", "follow_artists"]
