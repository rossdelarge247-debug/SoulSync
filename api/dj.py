"""The library's DJ data: BPM, key (Camelot) and energy (BACKLOG "DJ area",
stage 1). Code: core/dj/.

GET  /api/library/dj/status
    The analysis: settings, how far through the library it is, the running
    sweep or the last one, and whether this profile may start or stop it.
POST /api/library/dj/start  (admins)
    Start a sweep now (also lifts a Stop's hold on the automatic sweeps).
    202 with the sweep; 409 when one runs or every track is done. With
    ``{track_id}`` ("analyse it now", 17b; Brief A's Move up) that track
    goes to the very front of the asked-for line (202, ``queued: true``),
    starting a run for the line alone when none runs: never a full sweep,
    and a Stop's hold stays; 409 ``nothing_to_move`` when it needs no
    analysis; one a second (429).
POST /api/library/dj/stop   (admins)
    Stop the sweep; automatic sweeps wait for a restart or a Start.
POST /api/library/dj/tracks
    ``{track_ids: [...]}`` (up to 500) -> ``{tracks: {id: dj}}``: the track
    rows' BPM and key, for any page that lists library tracks.
GET  /api/library/dj/browse
    Library → Tracks: tracks with a file, ``bpm_min``, ``bpm_max``, ``key``
    (a Camelot code or any key spelling; ``8A:mix`` adds the keys that mix
    with it), ``q``, ``sort`` (bpm | key | energy | title | artist | recent),
    ``page``, ``limit`` (50, at most 200). ``keys`` in the answer is what the
    key filter covered, in the count line's order ("8A, 7A, 9A or 8B").
    Each track says whether the caller starred it (``starred``);
    ``starred=1`` (the Starred filter) keeps only the caller's starred
    tracks, a starred one whose file is gone included (``file_missing``).
GET  /api/library/dj/mixes/<track_id>
    "Mixes well with…": the same key, ±1 on the Camelot wheel or the relative
    major/minor, at a BPM within ±6% (half and double time count);
    ``within`` (percent, 1–12) widens or narrows the tempo window.
    The Mix tab (29a) adds ``rank=mix`` (its order: a starred boost, not
    played recently, style closeness; core/dj/ranking.py), ``set_id`` (one
    of the caller's sets: its tracks left out, its energy direction
    followed; implies ``rank=mix``), ``wide=1`` (10% and any key),
    ``exclude`` (ids to leave out: More like this leaves out the playing
    track), ``set_at`` (while the set plays: the number Add puts tracks
    after; the direction is read from the tracks up to it) and ``limit``
    (5 by default then). Without them the answer is as before.
GET  /api/library/dj/grid/<track_id>
    Auto-mix stage A: the track's beat grid (BPM, the first beat and the
    period, or its beats when the tempo drifts), downbeats, phrases,
    sections, the mix-in and mix-out regions, loudness and how sure each is
    (core/dj/grid_store.py ``public``); ``analyzed: false`` with ``reason``
    (``not_analyzed`` …) when there's none yet. 404 outside the library.
POST /api/library/dj/grids
    ``{track_ids: [...]}`` (up to 50, body at most 8 KB; a queue's tracks)
    -> ``{grids: {id: grid}}``, the same shape without drifting tracks' beat
    lists unless ``beats: true``. Ids outside the library are left out.
GET  /api/library/dj/plan?from=<id>&to=<id>&style=&bars=
    The pair planner (core/dj/planner.py): where the outgoing track's mix
    starts (a phrase in its outro), where the incoming one starts (its
    intro's downbeat), the tempo ratio, whether it can be beat-matched, Auto's
    pick and why, or Design's 302 move for a pair that can't be beat-matched
    (a cut on the outgoing track's last phrase, an echo out into the
    incoming one, or straight on) with its reason, never a crossfade; ``waiting``
    while either isn't analysed. ``style`` one of auto (the default),
    long_blend, short_blend, bass_swap, cut, echo_out, filter_sweep,
    drop_swap; ``bars`` 2, 4, 8, 16 or 32.
GET  /api/library/dj/window/<track_id>?start=&dur=&rate=
    Auto-mix stage B: a stretch of the track as 16-bit stereo WAV for the
    browser's two-deck engine (core/dj/window.py; ``dur`` 0.05 to 180 s,
    ``rate`` 44100 or 48000), on the analysis's timeline. 429 while two
    windows are decoding, or one of the caller's.
POST /api/library/dj/mixes/<track_id>/vibe
    Vibe (29a): the ranked top 20 re-ordered for feel by the AI provider
    (core/dj/vibe.py); 403 with ``code`` when the AI is off for this profile
    or at its limit, 429 ``busy``. Counts against the profile's AI usage.
POST /api/library/dj/analyse
    Analyse on demand (any profile, its own library's tracks): ``{track_ids:
    [...]}`` (up to 500) or ``{playlist_id}`` (its rows matched to the
    library). Those that need analysis go in the asked-for line in front of
    the sweep (at most 200 a profile) and a sweep starts for them when none
    runs (core/dj/ondemand.py). ``reason``: ``asked`` (a person's own ask:
    it goes to the front of the line, before what pages asked for) or
    ``auto`` (the default: a page asking for what it shows); while a
    person's Stop holds the sweeps an automatic ask is 409 ``held``.
    ``source`` says why (``asked``, ``set`` with the caller's ``set_id``,
    ``up_next``, ``mix``, ``lab``, ``dj_now``, ``page``), for the line's
    words (Brief A, HANDOFF 325). ``{mine: true, reason: "asked"}`` is
    Analyse mine: the caller's tracks already in line go to the front.
    ``{track_ids, cancel: true}`` takes the caller's own asks for them out
    of the line (the Mix tab's Cancel). ``retry: true`` with ``reason:
    "asked"`` (admins; 403 otherwise) asks again for tracks whose analysis
    or beat grid failed (Try again); ``again: true`` likewise (admins, a
    person's ask) finds the beat grid again for tracks already analysed too
    (Analyse again). JSON
    only, body at most 64 KB; one request a second a profile (429
    ``rate_limited`` with ``Retry-After``); 409 ``off`` while analysis is
    switched off.
POST /api/library/dj/progress
    ``{track_ids: [...], line?: true}`` (up to 500; may be empty) ->
    ``{tracks: {id: {state, …}}, sweep}``: where each of the caller's
    tracks is (``done``, ``queued`` with its place, ``working`` with its
    step and percent, ``waiting`` with why, ``failed`` with why; each with
    ``ready`` and ``bpm_key``) and the sweep's own state (with each step's
    time for the track it's on, when the next sweep comes, who stopped it;
    with ``line`` the line in order, as far as the caller may see it).
    JSON only, body at most 64 KB. Cheap enough to poll every second or two.
GET  /api/library/dj/traktor/settings
    The Settings → Library → Traktor Pro 3 card (21b): the Mac path for the
    library folder, the export folder and its state, Traktor's collection
    (said, not read yet), ``can_edit`` for admins.
PUT  /api/library/dj/traktor/settings  (admins)
    ``{mac_path?, export_folder?}``; an empty string clears one. 400 with a
    sentence for a path that isn't a Mac folder, or an export folder outside
    the configured folders, missing or not writable.
POST /api/library/dj/traktor/export
    "Export to Traktor…" (21a). ``{action: preview | download | save,
    source: playlist | tracks | mixes, playlist_id | track_ids (≤ 1000, with
    an optional name and ``left_out``: a set's lines that aren't in the
    library, ``[{title, artist}]``) | track_id (+ within), overwrite?}``. ``preview`` answers the counts, the
    Mac path, what was left out and why; ``download`` answers the ``.nml`` as
    an attachment; ``save`` (admins) writes it into the export folder (409
    ``exists`` unless ``overwrite``, with ``exists_at``). For admins the
    preview's ``folder.exists_at`` is when a file of that name already in the
    export folder was written (else null). A track the caller starred is
    written with Traktor's top rating (``RANKING="255"``); the preview's
    ``starred`` counts them. Code: core/dj/traktor.py.
POST /api/library/dj/bpm
    Double BPM / Halve BPM (an admin, any track in its scope; a member, the
    tracks of its own library only, 403 ``shared`` for shared ones; one
    change a second a profile, 429 ``rate_limited``):
    ``{track_ids: [...] (up to 500), action: double | halve | reset}``. The
    BPM shown is doubled or halved and kept as the person's (``bpm_source``
    ``override``), which no later analysis undoes; each track's grid
    follows at once. ``reset`` goes back to the measured BPM (the grid is
    found again). -> ``{changed: {id: bpm | null}, skipped: {id: reason},
    tracks: {id: dj}}``; 404 when none of the ids is in the caller's
    library. JSON only, body at most 64 KB. Code: core/dj/store.py
    ``set_tempo``.

Every route needs a profile and reads the caller's library scope, like the
other library routes.
"""

from __future__ import annotations

import math
import os
import re
import time
from typing import Any, Optional

from flask import Blueprint, jsonify, request

from core.profile_context import admin_only, get_current_profile_id
from utils.logging_config import get_logger

logger = get_logger("api.dj")

bp = Blueprint("library_dj", __name__)

get_database = None
fix_art_url = None


def configure(*, get_database_, fix_art_url_=None) -> None:
    global get_database, fix_art_url
    get_database = get_database_
    fix_art_url = fix_art_url_


def _no_profile():
    return jsonify({"success": False, "error": "profile_required"}), 401


def _float(name: str) -> Optional[float]:
    raw = request.args.get(name)
    if raw in (None, ""):
        return None
    text = str(raw).strip()
    # "nan" (any case) would compare false with everything: refuse it outright
    if text.lower().lstrip("+-") in ("nan", "inf", "infinity"):
        return None
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) and 0 < value < 1000 else None


def _int(name: str, default: int) -> int:
    try:
        return int(request.args.get(name) or default)
    except (TypeError, ValueError):
        return default


def _no_store(payload: Any, status: int = 200):
    response = jsonify(payload)
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    return response


@bp.route("/api/library/dj/status", methods=["GET"])
def dj_status():
    if get_current_profile_id() is None:
        return _no_profile()
    from core.dj import store, worker

    database = get_database()
    try:
        counts = store.counts(database, worker.analyzer_version())
        from core.dj import grid_store

        grids = grid_store.counts(database)
        job = worker.public_state(database)
    except Exception as exc:  # noqa: BLE001
        logger.error("DJ status failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    admin = bool(_is_admin())
    if job and not admin and job.get("current") is not None:
        # the track being worked on may be another profile's: admins only
        # (the progress route names it only for a caller whose library holds it)
        job = {**job, "current": None}
    return _no_store({"success": True, "settings": worker.settings_state(), "counts": counts, "grids": grids,
                      "job": job,
                      "held": worker.JOB.held, "analyzer_version": worker.analyzer_version(),
                      "can_start": admin, "can_stop": admin})


@bp.route("/api/library/dj/start", methods=["POST"])
@admin_only
def dj_start():
    from core.dj import worker

    database = get_database()
    body = request.get_json(silent=True) or {}
    first = body.get("track_id") if isinstance(body, dict) else None
    first = str(first)[:128] if isinstance(first, (str, int)) and str(first) else None
    if first is not None:
        return _move_up(database, first)
    try:
        state = worker.JOB.start(database, get_current_profile_id() or 1, manual=True)
    except worker.JobRunning as exc:
        return jsonify({"success": False, "error": str(exc)}), 409
    if state is None:
        return jsonify({"success": False, "error": "Every track already has its BPM, key and energy."}), 409
    return _no_store({"success": True, "job": worker.public_state(database)}, 202)


def _move_up(database, track_id: str):
    """An admin's Analyse now / Move up for one track: in line at the very
    front, read "you asked". With nothing running it starts a run for the
    asked-for line only: never a full sweep, and a Stop's hold stays (the
    Brief A review's L5). One a second, as asking is."""
    from core.dj import ondemand, worker

    pid = int(get_current_profile_id() or 1)
    if not ondemand.ASK_LIMIT.allow(pid):
        response = jsonify({"success": False, "code": "rate_limited",
                            "error": "One request a second: try again in a moment."})
        response.status_code = 429
        response.headers["Retry-After"] = "1"
        return response
    if not worker.settings_state().get("analyze", True):
        return jsonify({"success": False, "code": "off",
                        "error": "Working out BPM, key and energy is off in Settings → Library."}), 409
    try:
        result = ondemand.ask(database, [track_id], pid, explicit=True, source="asked")
    except Exception as exc:  # noqa: BLE001
        logger.error("Move up failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    if not (result["queued"] or result["already_queued"]):
        words = ("That track is analysed already." if result["already_done"]
                 else f"You have {result['limit']:,} tracks in line, the most at once: "
                      "Move up waits until some are done." if result["over_limit"]
                 else "That track couldn't be analysed: Try again asks for it." if result["cant"]
                 else "That track isn't in your library.")
        code = "over_limit" if result["over_limit"] and not result["already_done"] else "nothing_to_move"
        return jsonify({"success": False, "code": code, "error": words}), 409
    worker.JOB.prioritise(track_id, pid)
    return _no_store({"success": True, "queued": True, "job": worker.public_state(database)}, 202)


@bp.route("/api/library/dj/stop", methods=["POST"])
@admin_only
def dj_stop():
    from core.dj import worker

    if not worker.JOB.stop(by_person=True, profile_id=get_current_profile_id()):
        return jsonify({"success": False, "error": "Nothing is working out BPM, key and energy right now."}), 409
    return jsonify({"success": True})


@bp.route("/api/library/dj/tracks", methods=["POST"])
def dj_tracks():
    if get_current_profile_id() is None:
        return _no_profile()
    body = request.get_json(silent=True) or {}
    ids = body.get("track_ids")
    if not isinstance(ids, list):
        return jsonify({"success": False, "error": "track_ids must be a list"}), 400
    if len(ids) > 500:
        return jsonify({"success": False, "error": "At most 500 tracks at a time"}), 400
    from core.dj import store

    try:
        tracks = store.lookup(get_database(), [str(t) for t in ids if isinstance(t, (str, int))])
    except Exception as exc:  # noqa: BLE001
        logger.error("DJ lookup failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    return jsonify({"success": True, "tracks": tracks})


@bp.route("/api/library/dj/browse", methods=["GET"])
def dj_browse():
    if get_current_profile_id() is None:
        return _no_profile()
    from core.dj import store

    bpm_min, bpm_max = _float("bpm_min"), _float("bpm_max")
    if bpm_min is not None and bpm_max is not None and bpm_min > bpm_max:
        bpm_min, bpm_max = bpm_max, bpm_min
    try:
        page = store.browse(get_database(), bpm_min=bpm_min, bpm_max=bpm_max,
                            key=(request.args.get("key") or "")[:12], q=(request.args.get("q") or "")[:200],
                            sort=request.args.get("sort") or "bpm", page=_int("page", 1), limit=_int("limit", 50),
                            fix_art=fix_art_url, profile_id=int(get_current_profile_id()),
                            starred=request.args.get("starred") in ("1", "true"))
    except Exception as exc:  # noqa: BLE001
        logger.error("DJ browse failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    return jsonify({"success": True, **page, "bpm_min": bpm_min, "bpm_max": bpm_max,
                    "key": request.args.get("key") or ""})


def _mix_ranked() -> bool:
    """The Mix tab's order was asked for (``rank=mix``, or a ``set_id``)."""
    return request.args.get("rank") == "mix" or request.args.get("set_id") not in (None, "")


def _whole_arg(name: str) -> Optional[int]:
    """A positive whole number from the query, ASCII digits only (``²`` and
    other Unicode digits are no number, gauntlet L2); None otherwise."""
    raw = (request.args.get(name) or "").strip()
    if not re.fullmatch(r"[0-9]{1,15}", raw):
        return None
    value = int(raw)
    return value if value > 0 else None


def _set_id_arg() -> Optional[int]:
    return _whole_arg("set_id")


def _body_whole(value: Any) -> Optional[int]:
    """A positive whole number from a JSON body (never a bool), or None."""
    if isinstance(value, bool) or not isinstance(value, int) or not 0 < value < 10 ** 15:
        return None
    return value


def _exclude_arg() -> list:
    """``exclude``: up to 50 comma-separated track ids to leave out."""
    raw = (request.args.get("exclude") or "")[:6500]
    return [x.strip()[:128] for x in raw.split(",") if x.strip()][:50]


@bp.route("/api/library/dj/mixes/<track_id>", methods=["GET"])
def dj_mixes(track_id: str):
    if get_current_profile_id() is None:
        return _no_profile()
    from core.dj import store

    try:
        within = _float("within")
        tolerance = within / 100 if within is not None else store.BPM_TOLERANCE
        if _mix_ranked():
            from core.dj import ranking

            result = ranking.rank(get_database(), str(track_id)[:128], profile_id=int(get_current_profile_id()),
                                  set_id=_set_id_arg(), limit=_whole_arg("limit") or ranking.TAB_LIMIT,
                                  wide=request.args.get("wide") in ("1", "true"), tolerance=tolerance,
                                  fix_art=fix_art_url, exclude=_exclude_arg(), set_at=_whole_arg("set_at"))
        else:
            result = store.mixes_with(get_database(), str(track_id)[:128], limit=_int("limit", 50),
                                      fix_art=fix_art_url, tolerance=tolerance)
    except Exception as exc:  # noqa: BLE001
        logger.error("Mixes well with failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    if result.get("track") is None:
        return jsonify({"success": False, "error": "That track isn't in your library"}), 404
    return jsonify({"success": True, **result})


# ── Auto-mix stage A: grids and the pair planner ──────────────────────────────

#: the batch form's body: 50 ids fit in far less
MAX_GRIDS_BODY = 8 * 1024
#: and its cap
MAX_GRIDS = 50


def _track_for_plan(entry: dict, track_id: str, *, with_beats: bool = True) -> dict:
    """A scoped row (grid_store.scoped_rows) as the planner's track: the
    public grid with the DJ data's BPM and key, the length and the title."""
    from core.dj import grid_store

    shaped = grid_store.public_entry(entry, track_id, with_beats=with_beats)
    return {**shaped, "dj_bpm": entry.get("bpm"), "key": entry.get("key"), "duration_s": entry.get("duration_s"),
            "title": entry.get("title"), "album_id": entry.get("album_id"),
            "track_number": entry.get("track_number"), "disc_number": entry.get("disc_number"),
            "disc_last": entry.get("disc_last")}


@bp.route("/api/library/dj/grid/<track_id>", methods=["GET"])
def dj_grid(track_id: str):
    if get_current_profile_id() is None:
        return _no_profile()
    from core.dj import grid_store

    tid = str(track_id)[:128]
    try:
        found = grid_store.scoped_rows(get_database(), [tid])
    except Exception as exc:  # noqa: BLE001
        logger.error("DJ grid failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    if tid not in found:
        return jsonify({"success": False, "error": "That track isn't in your library"}), 404
    return jsonify({"success": True, "grid": grid_store.public_entry(found[tid], tid)})


@bp.route("/api/library/dj/grids", methods=["POST"])
def dj_grids():
    if get_current_profile_id() is None:
        return _no_profile()
    body, refused = _read_json_capped(MAX_GRIDS_BODY)
    if refused is not None:
        return refused
    if not isinstance(body, dict) or not isinstance(body.get("track_ids"), list):
        return jsonify({"success": False, "error": "track_ids must be a list"}), 400
    raw = body["track_ids"]
    if len(raw) > MAX_GRIDS:
        return jsonify({"success": False, "error": f"At most {MAX_GRIDS} tracks at a time"}), 400
    ids = list(dict.fromkeys(str(t)[:128] for t in raw
                             if isinstance(t, (str, int)) and not isinstance(t, bool) and str(t)))
    from core.dj import grid_store

    try:
        found = grid_store.scoped_rows(get_database(), ids)
    except Exception as exc:  # noqa: BLE001
        logger.error("DJ grids failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    with_beats = body.get("beats") is True
    return jsonify({"success": True, "grids": {i: grid_store.public_entry(found[i], i, with_beats=with_beats)
                                               for i in ids if i in found}})


@bp.route("/api/library/dj/plan", methods=["GET"])
def dj_plan():
    if get_current_profile_id() is None:
        return _no_profile()
    from core.dj import grid_store, planner

    out_id = (request.args.get("from") or "").strip()[:128]
    in_id = (request.args.get("to") or "").strip()[:128]
    if not out_id or not in_id:
        return jsonify({"success": False, "error": "from and to are needed"}), 400
    style = (request.args.get("style") or "auto").strip()
    if style not in planner.STYLES:
        return jsonify({"success": False, "error": "style must be one of " + ", ".join(planner.STYLES)}), 400
    bars = None
    if request.args.get("bars") not in (None, ""):
        bars = _whole_arg("bars")
        if bars not in planner.BARS:
            return jsonify({"success": False, "error": "bars must be 2, 4, 8, 16 or 32"}), 400
    try:
        found = grid_store.scoped_rows(get_database(), [out_id, in_id])
        if out_id not in found or in_id not in found:
            return jsonify({"success": False, "error": "That track isn't in your library"}), 404
        result = planner.plan(_track_for_plan(found[out_id], out_id), _track_for_plan(found[in_id], in_id),
                              style=style, bars=bars)
    except planner.PlanError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        logger.error("DJ plan failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    return jsonify({"success": True, "from": out_id, "to": in_id, "plan": result})


@bp.route("/api/library/dj/window/<track_id>", methods=["GET"])
def dj_window(track_id: str):
    """Auto-mix stage B: a stretch of one library track as 16-bit stereo WAV
    for the browser's two-deck engine (core/dj/window.py): ``start`` and
    ``dur`` in seconds (0.05 to 180), ``rate`` 44100 or 48000. On the
    analysis's timeline, so the grid's seconds and the samples agree. 404
    outside the caller's library or when the file can't be opened, 429 while
    two windows are decoding or one of the caller's is."""
    if get_current_profile_id() is None:
        return _no_profile()
    from core.dj import grid_store, store, window

    tid = str(track_id)[:128]
    try:
        start, dur, rate = window.parse_args(request.args.get("start"), request.args.get("dur"),
                                             request.args.get("rate"))
    except ValueError as exc:
        return jsonify({"success": False, "error": str(exc)}), 400
    try:
        found = grid_store.scoped_rows(get_database(), [tid])
        row = store.track_row(get_database(), tid) if tid in found else None
    except Exception as exc:  # noqa: BLE001
        logger.error("DJ window failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    if row is None:
        return jsonify({"success": False, "error": "That track isn't in your library"}), 404
    # past the track's known end there's nothing to decode: say so rather
    # than have ffmpeg read the whole file for an empty window
    length = found[tid].get("duration_s")
    if length and start >= float(length) + 1.0:
        return jsonify({"success": False, "error": "start is past the track's end"}), 400
    from core.sample.worker import resolve_track_file

    path = resolve_track_file(str(row.get("file_path") or "")) if row.get("file_path") else None
    if not path:
        return jsonify({"success": False, "error": "SYNCHRO.S can't open that track's file"}), 404
    try:
        data = window.decode(path, start, dur, rate, owner=get_current_profile_id())
    except window.Busy:
        response = jsonify({"success": False, "error": "busy"})
        response.status_code = 429
        response.headers["Retry-After"] = "1"
        return response
    except FileNotFoundError:
        return jsonify({"success": False, "error": "SYNCHRO.S can't open that track's file"}), 404
    except window.WindowError as exc:
        return jsonify({"success": False, "error": f"Couldn't decode that track: {exc}"}), 422
    from flask import Response

    # sent in pieces from the one buffer, never copied whole again
    response = Response(window.chunks(data), mimetype="audio/wav", direct_passthrough=True)
    response.headers["Content-Length"] = str(len(data))
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["X-Window-Start"] = f"{start:.6f}"
    response.headers["X-Window-Rate"] = str(rate)
    return response


#: Vibe's request body: a set id and a flag fit in far less
MAX_VIBE_BODY = 4 * 1024
#: tests swap the provider here (core.ai.assistant.default_provider_factory when None)
vibe_provider_factory = None

_VIBE_STATUS = {"not_configured": 403, "members_not_allowed": 403, "key_refused": 403, "cap_reached": 403,
                "busy": 429, "rate_limited": 429, "offline": 503}


@bp.route("/api/library/dj/mixes/<track_id>/vibe", methods=["POST"])
def dj_mixes_vibe(track_id: str):
    """Vibe (29a): the Mix tab's top 20 re-ranked for feel by the AI.
    ``{set_id?, set_at?, wide?, limit?, exclude?}`` (JSON only); answers the ranked route's shape with the
    AI's order and ``vibe: {line}``. Counts against the profile's AI usage."""
    pid = get_current_profile_id()
    if pid is None:
        return _no_profile()
    body, refused = _read_json_capped(MAX_VIBE_BODY)
    if refused is not None:
        return refused
    # JSON only (gauntlet M1): a form or text/plain POST from another site
    # needs no preflight, and each request here spends AI usage
    if not request.is_json or not isinstance(body, dict):
        return jsonify({"success": False, "error": "Send it as JSON"}), 400
    from core.dj import ranking, vibe
    from core.settings import config_manager

    set_id = _body_whole(body.get("set_id"))
    set_at = _body_whole(body.get("set_at"))
    limit = max(1, min(vibe.TOP, _body_whole(body.get("limit")) or ranking.TAB_LIMIT))
    raw_exclude = body.get("exclude")
    exclude = ([str(x)[:128] for x in raw_exclude if isinstance(x, (str, int)) and not isinstance(x, bool)][:50]
               if isinstance(raw_exclude, list) else [])
    database = get_database()
    try:
        found = ranking.rank(database, str(track_id)[:128], profile_id=int(pid), set_id=set_id, limit=vibe.TOP,
                             wide=body.get("wide") is True, fix_art=fix_art_url, exclude=exclude, set_at=set_at)
    except Exception as exc:  # noqa: BLE001
        logger.error("Vibe's ranking failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    if found.get("track") is None:
        return jsonify({"success": False, "error": "That track isn't in your library"}), 404
    heading = (found.get("set") or {}).get("direction")
    try:
        answer = vibe.rerank(database, config_manager, profile_id=int(pid), is_admin=_is_admin(),
                             seed=found["track"], candidates=found["matches"], heading=heading,
                             provider_factory=vibe_provider_factory)
    except vibe.VibeError as exc:
        return jsonify({"success": False, "code": exc.code, "error": exc.message}), _VIBE_STATUS.get(exc.code, 502)
    except Exception as exc:  # noqa: BLE001
        logger.error("Vibe failed: %s", type(exc).__name__)
        return jsonify({"success": False, "code": "provider_error",
                        "error": "The AI couldn't order these. Code's order stands."}), 502
    return _no_store({"success": True, **found, "matches": answer["matches"][:limit],
                      "vibe": {"line": answer["line"], "usage": answer["usage"]}})


# ── Analyse on demand, and each track's progress ─────────────────────────────

#: the body of /analyse and /progress: 500 ids fit well under it
MAX_ANALYSE_BODY = 64 * 1024


def _ids_from(body: dict):
    """``track_ids`` from a JSON body: a list of up to 500 ids, or a 400."""
    from core.dj import ondemand

    raw = body.get("track_ids")
    if not isinstance(raw, list):
        return None, (jsonify({"success": False, "error": "track_ids must be a list"}), 400)
    if len(raw) > ondemand.MAX_IDS:
        return None, (jsonify({"success": False, "error": f"At most {ondemand.MAX_IDS} tracks at a time"}), 400)
    return list(dict.fromkeys(str(t)[:128] for t in raw
                              if isinstance(t, (str, int)) and not isinstance(t, bool) and str(t))), None


@bp.route("/api/library/dj/analyse", methods=["POST"])
def dj_analyse():
    """Analyse on demand: the caller's tracks that need it jump the queue."""
    pid = get_current_profile_id()
    if pid is None:
        return _no_profile()
    body, refused = _read_json_capped(MAX_ANALYSE_BODY)
    if refused is not None:
        return refused
    # JSON only: a form or text/plain POST from another site needs no preflight
    if not request.is_json or not isinstance(body, dict):
        return jsonify({"success": False, "error": "Send it as JSON"}), 400
    from core.dj import ondemand, worker

    database = get_database()
    # a person's own ask ("Analyse these", a lab pick, Analyse now) or a
    # page's automatic one (what it shows): only the first passes a Stop
    reason = body.get("reason", "auto")
    if reason not in ("asked", "auto"):
        return jsonify({"success": False, "error": "reason must be asked or auto"}), 400
    # why the tracks are in line, for the line's words (HANDOFF 325)
    source = body.get("source")
    if source is not None and source not in worker.SOURCES:
        return jsonify({"success": False, "error": "source isn't one SYNCHRO.S knows"}), 400
    set_id = body.get("set_id")
    if set_id is not None and (isinstance(set_id, bool) or not isinstance(set_id, int)
                               or not 0 < set_id < 10 ** 15):
        return jsonify({"success": False, "error": "set_id must be a set's number"}), 400
    mine = body.get("mine") is True
    if mine and reason != "asked":
        return jsonify({"success": False, "error": "Analyse mine is a person's own ask"}), 400
    # Cancel (the Mix tab): the caller's own asks for these tracks leave the line
    cancel = body.get("cancel") is True
    # Try again (an admin's): tracks whose analysis or grid failed are asked again
    retry = body.get("retry") is True
    if retry and (reason != "asked" or not _is_admin()):
        return jsonify({"success": False, "error": "Only an admin can ask for a failed track again"}), 403
    # Analyse again (an admin's): a track already analysed has its beat grid found again
    again = body.get("again") is True
    if again and (reason != "asked" or not _is_admin()):
        return jsonify({"success": False, "error": "Only an admin can ask for a track to be analysed again"}), 403
    # Up next's next transition (the next two with Auto mix on): first in line
    soon = body.get("soon") is True
    if soon and source != "up_next":
        return jsonify({"success": False, "error": "soon is Up next's"}), 400
    if soon and (mine or cancel or "playlist_id" in body):
        # two tracks named by id, never a playlist's rows (re-review L10)
        return jsonify({"success": False, "error": "soon names Up next's two tracks by id"}), 400
    playlist = None
    if mine:
        ids: list = []
    elif "playlist_id" in body:
        playlist = body.get("playlist_id")
        if isinstance(playlist, bool) or not isinstance(playlist, int) or not 0 < playlist < 10 ** 15:
            return jsonify({"success": False, "error": "playlist_id is needed"}), 400
        ids: list = []
    else:
        ids, bad = _ids_from(body)
        if bad is not None:
            return bad
    if soon and len(ids) > worker.SOON_PER_PROFILE:
        return jsonify({"success": False,
                        "error": f"Up next's next transition is {worker.SOON_PER_PROFILE} tracks at most"}), 400
    # the limit before any reading (a playlist's rows are read next)
    if not ondemand.ASK_LIMIT.allow(int(pid)):
        response = jsonify({"success": False, "code": "rate_limited",
                            "error": "One request a second: try again in a moment."})
        response.status_code = 429
        response.headers["Retry-After"] = "1"
        return response
    if cancel:
        # a Cancel works whatever the setting (review L4)
        if "playlist_id" in body or mine:
            return jsonify({"success": False, "error": "Cancel names its tracks"}), 400
        gone = ondemand.withdraw(ids, int(pid))
        return _no_store({"success": True, **gone}, 200)
    if not worker.settings_state().get("analyze", True):
        return jsonify({"success": False, "code": "off",
                        "error": "Working out BPM, key and energy is off in Settings → Library."}), 409
    if mine:
        # Analyse mine: the caller's own tracks in line go first
        moved = ondemand.promote(int(pid))
        return _no_store({"success": True, "asked": 0, "queued": 0, "already_queued": moved["yours"],
                          "already_done": 0, "cant": 0, "over_limit": 0, "limit": worker.PRIORITY_PER_PROFILE,
                          "yours": moved["yours"], "moved": moved["moved"], "started": False,
                          "position": None, "working": False}, 202)
    if playlist is not None:
        from core.dj import traktor

        try:
            found = traktor.playlist_tracks(database, playlist, None if _is_admin() else pid)
        except Exception as exc:  # noqa: BLE001
            logger.error("Analyse: playlist unreadable: %s", exc, exc_info=True)
            return jsonify({"success": False, "error": "Couldn't read your library"}), 500
        if found is None:
            return jsonify({"success": False, "error": "Playlist not found"}), 404
        ids = list(dict.fromkeys(str(t["id"]) for t, _title, _artist in found["rows"] if t))[:ondemand.MAX_IDS]
    try:
        result = ondemand.ask(database, ids, int(pid), explicit=reason == "asked", source=source, set_id=set_id,
                              retry=retry, soon=soon, again=again)
    except worker.Held:
        return jsonify({"success": False, "code": "held",
                        "error": "Working out BPM, key and energy is stopped; ask for these to go on."}), 409
    except Exception as exc:  # noqa: BLE001
        logger.error("Analyse on demand failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    return _no_store({"success": True, **result}, 202)


@bp.route("/api/library/dj/progress", methods=["POST"])
def dj_progress():
    """Where each of the caller's tracks is in the analysis, and the sweep."""
    pid = get_current_profile_id()
    if pid is None:
        return _no_profile()
    body, refused = _read_json_capped(MAX_ANALYSE_BODY)
    if refused is not None:
        return refused
    if not request.is_json or not isinstance(body, dict):
        return jsonify({"success": False, "error": "Send it as JSON"}), 400
    ids, bad = _ids_from(body)
    if bad is not None:
        return bad
    from core.dj import ondemand

    try:
        answer = ondemand.progress(get_database(), ids, int(pid), admin=bool(_is_admin()),
                                   line=body.get("line") is True)
    except Exception as exc:  # noqa: BLE001
        logger.error("DJ progress failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    return _no_store({"success": True, **answer})


# ── Export to Traktor (stage 2a) ──────────────────────────────────────────────

#: the largest export request body (a thousand ids fit in well under this)
MAX_EXPORT_BODY = 64 * 1024

_FOLDER_WORDS = {
    "invalid": "That isn't a folder path SYNCHRO.S can use.",
    "outside": "The export folder has to be inside one of your music folders or Downloads.",
    "missing": "SYNCHRO.S can't find that folder. Make it first, or check the drive is connected.",
    "not_writable": "SYNCHRO.S can't write in that folder.",
    "unset": "No export folder is set, so exports download in the browser.",
}


def _is_admin() -> bool:
    from core.profile_context import is_admin_request

    return bool(is_admin_request())


#: the card's fields that name folders on the server or the Mac: admins only
_ADMIN_ONLY_FIELDS = ("mac_path", "mac_path_from_helper", "library_folder", "export_folder", "export_folder_on_mac")


def _traktor_state() -> dict:
    """The card's state. A member sees whether things are set, not where: the
    folder fields go to admins only."""
    from core.dj import traktor

    state = traktor.settings_state()
    admin = bool(_is_admin())
    if not admin:
        state = {k: v for k, v in state.items() if k not in _ADMIN_ONLY_FIELDS}
        full = traktor.settings_state()
        state["mac_path_set"] = bool(full["mac_path"] or full["mac_path_from_helper"])
        state["mac_path_from_helper_set"] = bool(full["mac_path_from_helper"])
    return {**state, "can_edit": admin}


def _read_json_capped(limit: int):
    """The JSON body, read with a hard limit even when it comes chunked (no
    Content-Length): at most ``limit + 1`` bytes are ever read. ``(body,
    None)`` or ``(None, response)``; a body that isn't JSON reads as None."""
    import json

    too_big = (jsonify({"success": False, "error": "That request is too big"}), 413)
    if request.content_length is not None and request.content_length > limit:
        return None, too_big
    raw = request.stream.read(limit + 1)
    if len(raw) > limit:
        return None, too_big
    if not request.is_json or not raw:
        return None, None
    try:
        return json.loads(raw), None
    except ValueError:
        return None, None


@bp.route("/api/library/dj/traktor/settings", methods=["GET"])
def traktor_settings():
    if get_current_profile_id() is None:
        return _no_profile()
    try:
        state = _traktor_state()
    except Exception as exc:  # noqa: BLE001
        logger.error("Traktor settings failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read the Traktor settings"}), 500
    return _no_store({"success": True, **state})


@bp.route("/api/library/dj/traktor/settings", methods=["PUT"])
@admin_only
def traktor_settings_save():
    from core.dj import traktor
    from core.settings import config_manager

    body, refused = _read_json_capped(MAX_EXPORT_BODY)
    if refused is not None:
        return refused
    if not isinstance(body, dict):
        return jsonify({"success": False, "error": "Send the settings as JSON"}), 400
    updates = {}
    if "mac_path" in body:
        raw = body.get("mac_path")
        if raw in (None, ""):
            updates[traktor.SETTING_MAC_PATH] = ""
        else:
            mac = traktor.valid_mac_path(raw) if isinstance(raw, str) else None
            if not mac:
                return jsonify({"success": False, "field": "mac_path",
                                "error": "Type the folder as the Mac names it, starting with /, "
                                         "like /Volumes/Music HD/SoulSync/Transfer."}), 400
            updates[traktor.SETTING_MAC_PATH] = mac
    if "export_folder" in body:
        raw = body.get("export_folder")
        if raw in (None, ""):
            updates[traktor.SETTING_EXPORT_FOLDER] = ""
        else:
            raw = raw.strip() if isinstance(raw, str) else None
            real, state = traktor.check_export_folder(raw)
            if real is None:
                return jsonify({"success": False, "field": "export_folder",
                                "error": _FOLDER_WORDS.get(state, _FOLDER_WORDS["invalid"])}), 400
            updates[traktor.SETTING_EXPORT_FOLDER] = os.path.normpath(raw)
    for key, value in updates.items():
        config_manager.set(key, value)
    return _no_store({"success": True, **_traktor_state()})


def _export_items(database, body: dict):
    """``(name, items, over)`` for the request's source, or a response tuple."""
    from core.dj import store, traktor

    source = body.get("source")
    if source == "tracks":
        ids = body.get("track_ids")
        if not isinstance(ids, list) or not ids:
            return jsonify({"success": False, "error": "track_ids must be a list of tracks"}), 400
        if len(ids) > traktor.MAX_TRACKS:
            return jsonify({"success": False, "error": "At most 1,000 tracks at a time"}), 400
        clean = [str(t)[:128] for t in ids if isinstance(t, (str, int)) and str(t)]
        tracks = traktor.tracks_by_ids(database, clean)
        found = {t["id"] for t in tracks}
        missing = [(None, "", "") for i in dict.fromkeys(clean) if i not in found]
        # a set's lines that aren't in the library (Missing, IDs), named in
        # the dialog's Left out box: words only, nothing is looked up for them
        extra = body.get("left_out")
        if isinstance(extra, list):
            for line in extra[:traktor.MAX_TRACKS]:
                if isinstance(line, dict):
                    missing.append((None, traktor.xml_text(str(line.get("title") or ""), 300).strip(),
                                    traktor.xml_text(str(line.get("artist") or ""), 300).strip()))
        name = body.get("name") if isinstance(body.get("name"), str) else ""
        name = traktor.xml_text(name, 200).strip() or f"SYNCHRO.S tracks {time.strftime('%Y-%m-%d')}"
        return name, [(t, t["title"], t["artist_name"]) for t in tracks] + missing, 0
    if source == "mixes":
        seed = body.get("track_id")
        if not isinstance(seed, (str, int)) or not str(seed):
            return jsonify({"success": False, "error": "track_id is needed"}), 400
        raw_within = body.get("within")
        within = float(raw_within) if isinstance(raw_within, (int, float)) and not isinstance(raw_within, bool) else 6.0
        if not math.isfinite(within):
            within = 6.0
        within = min(store.MAX_TOLERANCE * 100, max(1.0, within))
        found = traktor.mixes_tracks(database, str(seed)[:128], tolerance=within / 100)
        if found is None:
            return jsonify({"success": False, "error": "That track isn't in your library"}), 404
        return found["name"], [(t, t["title"], t["artist_name"]) for t in found["tracks"]], 0
    if source == "playlist":
        raw = body.get("playlist_id")
        try:
            playlist_id = int(raw)
        except (TypeError, ValueError):
            return jsonify({"success": False, "error": "playlist_id is needed"}), 400
        if isinstance(raw, bool) or playlist_id <= 0:
            return jsonify({"success": False, "error": "playlist_id is needed"}), 400
        owner = None if _is_admin() else get_current_profile_id()
        found = traktor.playlist_tracks(database, playlist_id, owner)
        if found is None:
            return jsonify({"success": False, "error": "Playlist not found"}), 404
        return found["name"], found["rows"], found["over"]
    return jsonify({"success": False, "error": "source must be playlist, tracks or mixes"}), 400


def _starred_count(database, entries) -> int:
    """How many of the export's tracks the caller starred (rated in Traktor)."""
    try:
        from core.stars import store as stars

        return len(stars.starred_among(database, int(get_current_profile_id()),
                                       [e["track"].get("id") for e in entries]))
    except Exception as exc:  # noqa: BLE001 - the count is a nicety
        logger.debug("starred count unreadable: %s", exc)
        return 0


def _attachment(data: bytes, filename: str):
    from urllib.parse import quote

    from flask import Response

    from core.dj import traktor

    response = Response(data, mimetype="application/octet-stream")
    response.headers["Content-Disposition"] = (
        f'attachment; filename="{traktor.ascii_filename(filename)}"; '
        f"filename*=UTF-8''{quote(filename, safe='')}")
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@bp.route("/api/library/dj/traktor/export", methods=["POST"])
def traktor_export():
    if get_current_profile_id() is None:
        return _no_profile()
    body, refused = _read_json_capped(MAX_EXPORT_BODY)
    if refused is not None:
        return refused
    if not isinstance(body, dict):
        return jsonify({"success": False, "error": "Send the export as JSON"}), 400
    action = body.get("action") or "preview"
    if action not in ("preview", "download", "save"):
        return jsonify({"success": False, "error": "action must be preview, download or save"}), 400
    from core.dj import traktor
    from core.settings import config_manager

    database = get_database()
    try:
        gathered = _export_items(database, body)
        if not isinstance(gathered[0], str):
            return gathered
        name, items, over = gathered
        resolve = None
        try:
            from core.sample.worker import resolve_track_file as resolve
        except Exception:  # noqa: BLE001 - stored paths only
            resolve = None
        paths = traktor.MacPaths(traktor.library_root(), config_manager.get(traktor.SETTING_MAC_PATH, "") or None,
                                 to_host=traktor._load_to_host(), resolve=resolve)
        planned = traktor.plan(items, paths, over=over)
    except Exception as exc:  # noqa: BLE001
        logger.error("Traktor export failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't read your library"}), 500
    filename = traktor.safe_filename(name)
    admin = bool(_is_admin())
    if action == "preview":
        state = traktor.settings_state()
        reasons: dict = {}
        for left in planned["left_out"]:
            reasons[left["reason"]] = reasons.get(left["reason"], 0) + 1
        entries = planned["entries"]
        preview = {
            "success": True, "name": name, "filename": filename, "counts": planned["counts"],
            # the caller's own first track, as the Mac sees it
            "example_path": entries[0]["mac_path"] if entries else None,
            "left_out": planned["left_out"][:50], "reasons": reasons,
            "keys": sum(1 for e in entries if traktor.confident_key(e["track"].get("dj"))),
            "starred": _starred_count(database, entries),
            "can_edit": admin,
            "folder": {"state": state["export_folder_state"], "shown": None, "can_save": False,
                       "exists_at": None},
        }
        if admin:
            # where things are on the server and the Mac: admins only
            preview["mac_path"] = state["mac_path"] or state["mac_path_from_helper"] or None
            preview["library_folder"] = state["library_folder"]
            can_save = state["export_folder_state"] == "ok"
            preview["folder"] = {"state": state["export_folder_state"],
                                 "shown": state["export_folder_on_mac"] or state["export_folder"] or None,
                                 "can_save": can_save,
                                 # a file of this name there already: when it was written (234)
                                 "exists_at": traktor.existing_export(state["export_folder"], filename)
                                 if can_save else None}
        return _no_store(preview)
    if not planned["entries"]:
        return jsonify({"success": False, "error": "None of these tracks can go to Traktor."}), 409
    try:
        from core.stars import store as stars

        starred = stars.starred_among(database, int(get_current_profile_id()),
                                      [e["track"].get("id") for e in planned["entries"]])
    except Exception as exc:  # noqa: BLE001 - the file is right without ratings
        logger.warning("Traktor export: couldn't read stars: %s", exc)
        starred = set()
    data = traktor.build_nml(name, planned["entries"], starred=starred)
    if action == "download":
        return _attachment(data, filename)
    if not admin:
        return jsonify({"success": False, "error": "Only an admin can save into the export folder."}), 403
    folder = config_manager.get(traktor.SETTING_EXPORT_FOLDER, "") or ""
    try:
        traktor.save_to_folder(folder, filename, data, overwrite=body.get("overwrite") is True)
    except FileExistsError:
        return jsonify({"success": False, "exists": True, "filename": filename,
                        "exists_at": traktor.existing_export(folder, filename),
                        "error": f"{filename} is already in the export folder."}), 409
    except traktor.ExportFolderError as exc:
        return jsonify({"success": False, "folder_state": exc.state,
                        "error": _FOLDER_WORDS.get(exc.state, _FOLDER_WORDS["invalid"])}), 409
    except (OSError, ValueError) as exc:
        logger.error("Traktor export save failed: %s", exc)
        return jsonify({"success": False, "error": "SYNCHRO.S couldn't write the file into the export folder."}), 500
    state = traktor.settings_state()
    return _no_store({"success": True, "saved": True, "filename": filename,
                      "folder": state["export_folder_on_mac"] or state["export_folder"],
                      "counts": planned["counts"]})


# ── Double BPM / Halve BPM ───────────────────────────────────────────────────

#: the BPM route's body: 500 ids fit well under it
MAX_BPM_BODY = 64 * 1024
#: one change a second a profile, as /analyse (its own count, so the two
#: don't hold each other up)
_BPM_LIMIT = None


def _bpm_limit():
    global _BPM_LIMIT
    if _BPM_LIMIT is None:
        from core.dj import ondemand

        _BPM_LIMIT = ondemand.RateLimit()
    return _BPM_LIMIT


@bp.route("/api/library/dj/bpm", methods=["POST"])
def dj_bpm():
    """Double, halve, confirm ("BPM is right") or reset the BPM of the
    caller's own tracks."""
    pid = get_current_profile_id()
    if pid is None:
        return _no_profile()
    body, refused = _read_json_capped(MAX_BPM_BODY)
    if refused is not None:
        return refused
    # JSON only: a form or text/plain POST from another site needs no preflight
    if not request.is_json or not isinstance(body, dict):
        return jsonify({"success": False, "error": "Send it as JSON"}), 400
    from core.dj import store

    action = body.get("action")
    if not isinstance(action, str) or action not in store.TEMPO_ACTIONS:
        return jsonify({"success": False, "error": "action must be double, halve, confirm or reset"}), 400
    raw = body.get("track_ids")
    if not isinstance(raw, list) or not raw:
        return jsonify({"success": False, "error": "track_ids must be a list"}), 400
    if len(raw) > store.MAX_TEMPO_TRACKS:
        return jsonify({"success": False, "error": f"At most {store.MAX_TEMPO_TRACKS} tracks at a time"}), 400
    ids = list(dict.fromkeys(str(t)[:128] for t in raw
                             if isinstance(t, (str, int)) and not isinstance(t, bool) and str(t)))
    if not _bpm_limit().allow(int(pid)):
        response = jsonify({"success": False, "code": "rate_limited",
                            "error": "One change a second: try again in a moment."})
        response.status_code = 429
        response.headers["Retry-After"] = "1"
        return response
    database = get_database()
    try:
        result = store.set_tempo(database, ids, action, profile_id=int(pid), is_admin=bool(_is_admin()))
        if not result["found"]:
            return jsonify({"success": False, "error": "That track isn't in your library"}), 404
        if not result["changed"] and result["skipped"] and all(
                why in ("shared", "not_yours") for why in result["skipped"].values()):
            return jsonify({"success": False, "code": "shared",
                            "error": "Only an admin can change the BPM of a track in the shared library."}), 403
        tracks = store.lookup(database, list(result["changed"]))
    except Exception as exc:  # noqa: BLE001
        logger.error("Setting the BPM failed: %s", exc, exc_info=True)
        return jsonify({"success": False, "error": "Couldn't change the BPM"}), 500
    return _no_store({"success": True, "changed": result["changed"], "skipped": result["skipped"],
                      "tracks": tracks})


def create_blueprint():
    return bp


__all__ = ["bp", "configure", "create_blueprint"]
