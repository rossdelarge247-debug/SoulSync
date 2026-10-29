"""Analyse on demand, and each track's progress (api/dj.py's ``/analyse``
and ``/progress``).

A track a person needs now (added to a mix set, queued with DJ mix, opened
in the Mix tab, picked in the lab, or "Analyse these") jumps the sweep's
queue: ``ask`` checks which of the caller's tracks need analysis (no BPM,
key and energy at this analyzer version, or no beat grid at this
``GRID_VERSION``) and puts them in the job's asked-for line
(core/dj/worker.py ``DjAnalysisJob.ask``), at most
``worker.PRIORITY_PER_PROFILE`` a profile, with at most one request a
second a profile (``RateLimit``). The line is in memory: a restart empties
it (the automatic sweeps still reach every track).

``progress`` says, for tracks of the caller's library, where each one is:

* ``done``: analysed (a track whose beat grid found no beat is done too);
* ``working``: being analysed now, with its ``step`` and ``percent`` (from
  real points in the analysis, core/dj/progress.py);
* ``queued``: in line, ``position`` 1 being next; ``asked_for`` when it's in
  the asked-for line rather than the sweep's own order;
* ``waiting``: with ``reason``: what the sweep waits for (``drive_away``,
  ``download``, ``import``, ``drive_move``, ``tag_write``; asked-for tracks
  only ever wait for the first and the last two), or ``held`` (a person
  pressed Stop), ``off`` (analysis is switched off) or ``not_queued`` (the
  next sweep reaches it); ``position`` when it's in line;
* ``failed``: with ``reason`` ``too_long``, ``unreachable``, ``error`` or
  ``no_grid`` (its BPM, key and energy are known but its beat grid failed).

Every entry also says whether the track is **ready to mix** (``ready``: a
beat grid at this ``GRID_VERSION`` for this file) and whether it has **BPM
and key** (``bpm_key``); a done track that can't be beat-matched says why
(``beat``: ``no_beat``, ``unsure``, ``too_short`` or ``not_4_4``), and one too long to
analyse says how long it is (``duration``, seconds) (Brief A, 31a).

Plus the sweep's own state: running or not, how far, what it waits for, and
the track it's on (named only when that track is in the caller's library),
with how long each of its steps took (HANDOFF 326); when the next automatic
sweep comes; who stopped it (named to admins). With ``line`` the line in
order, with why each track is in it (HANDOFF 325): a member sees the tracks
it asked for and a count of the rest; an admin sees every track in its
library and who asked.
"""

from __future__ import annotations

import threading
import time
from contextlib import closing
from typing import Any, Dict, Iterable, List, Optional

from utils.logging_config import get_logger

logger = get_logger("dj.ondemand")

#: how many track ids one request may name (an album, a playlist, a set)
MAX_IDS = 500
#: one request a second a profile for asking (the progress reads aren't limited)
ASK_EVERY_SECONDS = 1.0

#: the sweep's waits a track can be shown waiting for
WAITS = ("drive_away", "download", "import", "drive_move", "tag_write")

#: the six steps a person sees (31a, 31b); the tag write is part of energy's
SHOWN_STEPS = ("read", "tempo", "key", "energy", "grid", "phrases")
_SHOWN_OF = {"read": "read", "tempo": "tempo", "key": "key", "energy": "energy", "tags": "energy",
             "grid": "grid", "phrases": "phrases"}
#: how many of the line's tracks the popover names (the rest are counted)
LINE_SHOWN = 8
#: the line is read from the library this many at a time, at most this often a poll
LINE_BATCH = 100
LINE_BATCHES = 4


class RateLimit:
    """At most one ask a second a profile: ``allow(profile)`` is False (and
    takes nothing) when the profile asked less than a second ago."""

    def __init__(self, every: float = ASK_EVERY_SECONDS, clock=time.monotonic) -> None:
        self._every = float(every)
        self._clock = clock
        self._lock = threading.Lock()
        self._last: Dict[int, float] = {}

    def allow(self, profile_id: int) -> bool:
        now = self._clock()
        with self._lock:
            last = self._last.get(int(profile_id))
            if last is not None and now - last < self._every:
                return False
            self._last[int(profile_id)] = now
            if len(self._last) > 1000:
                # profiles that asked long ago don't need remembering
                self._last = {p: t for p, t in self._last.items() if now - t < self._every}
            return True


ASK_LIMIT = RateLimit()


def _rows(database, ids: List[str]) -> Dict[str, Dict[str, Any]]:
    """The caller's library tracks among ``ids`` that have a file, with
    their DJ and grid rows' states (the DJ routes' scope, store._scope)."""
    from core.dj.store import _scope

    wanted = list(dict.fromkeys(str(i) for i in ids if i not in (None, "")))[:MAX_IDS]
    out: Dict[str, Dict[str, Any]] = {}
    if not wanted:
        return out
    where, params = _scope(database)
    with closing(database._get_connection()) as conn:
        for start in range(0, len(wanted), 250):
            chunk = wanted[start:start + 250]
            marks = ",".join("?" * len(chunk))
            # "?" placeholders and the library scope's fixed fragment are
            # formatted in; every value is a bound parameter
            rows = conn.execute(  # nosemgrep: sqlalchemy-execute-raw-query
                f"SELECT t.id AS tid, t.title AS title, t.duration AS duration, "
                f"COALESCE(NULLIF(t.track_artist, ''), ar.name) AS artist, d.status AS d_status, "
                f"d.dj_analyzer_version AS d_version, d.source_sig AS d_sig, "
                f"g.status AS g_status, g.grid_version AS g_version, g.source_sig AS g_sig, "
                f"g.reason AS g_reason, g.meter AS g_meter, g.beat_confidence AS g_conf "
                f"FROM tracks t LEFT JOIN track_dj d ON d.track_id = t.id "
                f"LEFT JOIN track_grid g ON g.track_id = t.id "
                f"LEFT JOIN artists ar ON ar.id = t.artist_id "
                f"WHERE t.id IN ({marks}) AND {where} AND t.file_path IS NOT NULL AND t.file_path != ''",
                chunk + params).fetchall()
            for r in rows:
                out[str(r["tid"])] = dict(r)
    return out


def classify(row: Dict[str, Any], dj_version: int) -> Dict[str, Any]:
    """One track's analysis from its rows: ``{"needs": bool, "failed":
    reason | None}``. ``needs`` means asking for it does something: no DJ
    data at this version, no grid at this ``GRID_VERSION`` (or one for
    another file), or a file that wasn't there (asked for, it's looked for
    again). A track that failed (an error, too long, a beat grid that failed)
    isn't asked again: it would fail the same way."""
    from core.dj.grid import GRID_VERSION

    d_status = row.get("d_status")
    d_current = d_status is not None and int(row.get("d_version") or 0) >= int(dj_version)
    if not d_current or d_status in ("stale", "analyzing"):
        return {"needs": True, "failed": None}
    if d_status == "unreachable":
        return {"needs": True, "failed": "unreachable"}
    if d_status == "error":
        return {"needs": False, "failed": "error"}
    if d_status == "skipped":
        return {"needs": False, "failed": "too_long"}
    g_status = row.get("g_status")
    g_current = g_status is not None and int(row.get("g_version") or 0) >= GRID_VERSION
    if not g_current or g_status in ("stale", "analyzing"):
        return {"needs": True, "failed": None}
    if g_status in ("done", "none") and row.get("g_sig") != row.get("d_sig"):
        return {"needs": True, "failed": None}  # the grid is another file's
    if g_status == "unreachable":
        return {"needs": True, "failed": "unreachable"}
    if g_status == "skipped":
        return {"needs": False, "failed": "too_long"}
    if g_status == "error":
        return {"needs": False, "failed": "no_grid"}
    return {"needs": False, "failed": None}


def readiness(row: Dict[str, Any]) -> Dict[str, Any]:
    """Ready to mix (31a): a beat grid at this ``GRID_VERSION`` for this
    file that the planner would beat-match (core/dj/grid.py
    ``beatmatch_problem``, the planner's own rule: a steady enough beat, in
    4/4). ``{ready, bpm_key, beat}``: ``bpm_key`` when BPM and key are known
    (stage 1's data, whatever the grid); ``beat`` why a track whose grid was
    looked for can't be beat-matched (``no_beat``: none found; ``unsure``:
    a grid found but too unsure to beat-match on; ``too_short``;
    ``not_4_4``, also a meter not worked out), else None."""
    from core.dj.grid import GRID_VERSION, beatmatch_problem

    g_status = row.get("g_status")
    g_current = (g_status in ("done", "none") and int(row.get("g_version") or 0) >= GRID_VERSION
                 and row.get("g_sig") == row.get("d_sig"))
    beat = None
    if g_current and g_status == "none":
        beat = "too_short" if row.get("g_reason") == "too_short" else "no_beat"
    elif g_current:
        problem = beatmatch_problem(row.get("g_conf"), row.get("g_meter"))
        if problem:
            beat = "unsure" if problem == "low_confidence" else "not_4_4"
    return {"ready": bool(g_current and g_status == "done" and beat is None),
            "bpm_key": row.get("d_status") == "done", "beat": beat}


def _seconds(duration: Any) -> Optional[int]:
    """A track's length in whole seconds (``tracks.duration`` is in ms)."""
    try:
        ms = float(duration)
    except (TypeError, ValueError):
        return None
    return int(round(ms / 1000.0)) if ms > 0 else None


#: the failures "Try again" (an admin's, 31a state 8) asks about once more
RETRYABLE = ("error", "no_grid")


def _retry(database, track_id: str, failed: str) -> None:
    """Put a failed track back to be analysed: its DJ row (an error) or its
    grid row (a grid that failed; the BPM, key and energy stay)."""
    from core.dj import grid_store, store

    if failed == "error":
        store.requeue(database, track_id, "asked to try again")
    else:
        grid_store.mark(database, track_id, "stale", "asked to try again", version=0)


def ask(database, ids: Iterable[Any], profile_id: int, *, job=None, explicit: bool = True,
        source: Optional[str] = None, set_id: Optional[int] = None, retry: bool = False,
        soon: bool = False, again: bool = False) -> Dict[str, Any]:
    """Put the caller's tracks that need analysis in the asked-for line.
    ``{asked, queued, already_queued, already_done, cant, over_limit, limit,
    yours, started}``: ``asked`` counts the ids in the caller's library,
    ``already_done`` those with nothing to do, ``cant`` those that failed
    and would fail again (or that this run took already and asked again),
    ``over_limit`` those past the profile's room. ``explicit`` is a person's
    own ask (it goes to the front of the line); while a Stop holds the sweeps
    an automatic one raises ``worker.Held``. ``source`` and ``set_id`` say
    why (``worker.SOURCES``). ``retry`` (Try again: an admin's own ask)
    asks again for tracks whose analysis or grid failed. ``again`` (Analyse
    again: an admin's own ask) finds the beat grid again for tracks already
    done too (Ross's report of 28 October: grids judged by an older rule
    said "no steady beat" and couldn't be asked for again), and asks again
    for failed ones as ``retry`` does."""
    from core.dj import worker

    job = job or worker.JOB
    rows = _rows(database, [str(i) for i in ids])
    version = worker.analyzer_version()
    needs: List[str] = []
    again_ids: List[str] = []
    done = cant = 0
    if (retry or again) and not explicit:
        raise ValueError("Try again is a person's own ask")
    # in the order asked (Up next's pair, a set's rows), whatever order the
    # library's rows come back in
    ordered = [t for t in dict.fromkeys(str(i) for i in ids) if t in rows]
    for track_id in ordered:
        row = rows[track_id]
        state = classify(row, version)
        if (retry or again) and state["failed"] in RETRYABLE:
            _retry(database, track_id, state["failed"])
            state = {"needs": True, "failed": None}
        elif again and not state["needs"] and not state["failed"]:
            # done already: its grid is found again when the line takes it
            # (BPM, key and energy stay); one with no room in line keeps it
            again_ids.append(track_id)
            needs.append(track_id)
            continue
        if state["needs"]:
            needs.append(track_id)
        elif state["failed"]:
            cant += 1
        else:
            done += 1
    if soon and not needs:
        # Up next's next pair needs nothing: the earlier pair goes back to
        # its own tier all the same (re-review L10)
        job.set_soon(int(profile_id), [])
    result = job.ask(database, needs, int(profile_id), explicit=explicit, source=source,
                     set_id=set_id, soon=soon, **({"again": again_ids} if again_ids else {})) if needs else {
        "added": [], "already": 0, "over": 0, "yours": job.queue_snapshot([], profile_id)["yours"],
        "limit": worker.PRIORITY_PER_PROFILE, "started": False, "taken": 0}
    # where the first of them now is, for the Added toast's "analysing, 2nd
    # in line" (31b, 31d): its place, or ``working`` when one is being done
    snap = job.queue_snapshot(needs, profile_id) if needs else {"places": {}, "live": None}
    live = snap.get("live") or {}
    working = bool(live) and str(live.get("current") or "") in set(needs)
    places = [place[0] for place in snap["places"].values()]
    return {"asked": len(rows), "queued": len(result["added"]), "already_queued": result["already"],
            "already_done": done, "cant": cant + int(result.get("taken") or 0), "over_limit": result["over"],
            "limit": result["limit"],
            "yours": result["yours"], "started": bool(result["started"]),
            "position": min(places) if places else None, "working": working}


def _step_times(live: Dict[str, Any], now: float) -> Dict[str, Any]:
    """The current track's steps as a person sees them (31b): how long each
    finished one took (``times``, seconds to 0.1), the one it's on and how
    long that has run. The tag write counts as part of energy's step."""
    started: Dict[str, float] = {}
    for step, at in live.get("steps") or []:
        shown = _SHOWN_OF.get(step)
        if shown and shown not in started:
            started[shown] = float(at)
    order = [s for s in SHOWN_STEPS if s in started]
    times: Dict[str, float] = {}
    for i, step in enumerate(order[:-1]):
        times[step] = round(max(0.0, started[order[i + 1]] - started[step]), 1)
    now_step = order[-1] if order else None
    return {"times": times, "now": now_step,
            "elapsed": round(max(0.0, now - started[now_step]), 1) if now_step else None}


def _profile_names(database, ids: Iterable[int]) -> Dict[int, str]:
    wanted = sorted({int(i) for i in ids if i})
    if not wanted:
        return {}
    try:
        with closing(database._get_connection()) as conn:
            marks = ",".join("?" * len(wanted))
            rows = conn.execute(f"SELECT id, name FROM profiles WHERE id IN ({marks})",  # nosemgrep: sqlalchemy-execute-raw-query
                                wanted).fetchall()
    except Exception as exc:  # noqa: BLE001 - unnamed, then
        logger.debug("profile names unreadable: %s", exc)
        return {}
    return {int(r["id"]): str(r["name"]) for r in rows}


def _set_names(database, ids: Iterable[int], profile_id: int) -> Dict[int, str]:
    """The caller's own sets' names among ``ids`` (another's set stays unnamed)."""
    wanted = sorted({int(i) for i in ids if i})
    if not wanted:
        return {}
    try:
        with closing(database._get_connection()) as conn:
            marks = ",".join("?" * len(wanted))
            rows = conn.execute(f"SELECT id, name FROM dj_sets WHERE id IN ({marks}) AND profile_id = ?",  # nosemgrep: sqlalchemy-execute-raw-query
                                wanted + [int(profile_id)]).fetchall()
    except Exception as exc:  # noqa: BLE001 - unnamed, then
        logger.debug("set names unreadable: %s", exc)
        return {}
    return {int(r["id"]): str(r["name"]) for r in rows}


def _line(database, snapshot: Dict[str, Any], profile_id: Optional[int], admin: bool) -> Dict[str, Any]:
    """The line in order as this caller may see it (HANDOFF 325): a member,
    the tracks it asked for itself; an admin, every track in its library
    with who asked. Each says why it's there; the rest are only counted."""
    pid = int(profile_id) if profile_id is not None else None
    eligible = [(position, track_id, front, why)
                for position, (track_id, front, why) in enumerate(snapshot.get("line") or [], start=1)
                if admin or (pid is not None and pid in why)]
    # the caller's library first, a batch at a time, then the first few
    # (an admin's line isn't left empty by tracks of other libraries; L6)
    shown: List[Any] = []
    rows: Dict[str, Dict[str, Any]] = {}
    # at most LINE_BATCHES reads a poll (a long line of other libraries'
    # tracks is only counted past that; re-review L6)
    for start in range(0, min(len(eligible), LINE_BATCH * LINE_BATCHES), LINE_BATCH):
        batch = eligible[start:start + LINE_BATCH]
        found = _rows(database, [c[1] for c in batch])
        rows.update(found)
        shown.extend(c for c in batch if c[1] in found)
        if len(shown) >= LINE_SHOWN:
            break
    shown = shown[:LINE_SHOWN]
    askers = {p for c in shown for p in c[3]}
    names = _profile_names(database, askers - {pid}) if admin else {}
    sets = _set_names(database, [w[1] for c in shown if pid in c[3] for w in [c[3][pid]] if w[1]], pid or 0)
    entries = []
    for position, track_id, front, why in shown:
        if pid is not None and pid in why:
            source, set_id = why[pid]
            by = "you"
            set_name = sets.get(int(set_id)) if set_id else None
        else:
            # an admin sees who asked first (by id: the earliest profile)
            other = min(why)
            source, set_id = why[other]
            by = names.get(other)
            set_name = None
        row = rows[track_id]
        entries.append({"track_id": track_id, "title": row.get("title") or "", "artist": row.get("artist") or "",
                        "position": position, "source": source, "by": by, "set_name": set_name,
                        "front": bool(front)})
    in_line = int(snapshot.get("in_line") or 0)
    return {"line": entries, "line_more": max(0, in_line - len(entries))}


def _wait_detail(database, reason: Optional[str], admin: bool,
                 profile_id: Optional[int] = None) -> Optional[Dict[str, Any]]:
    """What the sweep waits for, counted where that's cheap (31a, state 6):
    how many downloads are left, how many files the import has, the library
    drive's name (admins: members don't see drives). A member's download
    count is their own batches only; the import keeps no owner, so a member
    gets the words without the number."""
    if not reason:
        return None
    detail: Dict[str, Any] = {"count": None, "drive": None}
    try:
        if reason == "download":
            from core.activity.feed import snapshot_live_batches

            left = sum(max(0, int(b.get("total") or 0) - int(b.get("done") or 0) - int(b.get("failed") or 0))
                       for b in snapshot_live_batches().values()
                       if admin or (profile_id is not None and b.get("profile_id") == profile_id))
            detail["count"] = left or None
        elif reason == "import" and admin:
            with closing(database._get_connection()) as conn:
                row = conn.execute("SELECT SUM(total_files) AS n FROM auto_import_history "
                                   "WHERE status IN ('processing', 'scanning')").fetchone()
            detail["count"] = int(row["n"]) if row and row["n"] else None
        elif reason == "drive_away" and admin:
            from core.drives.markers import get_watch

            state = get_watch().peek() or {}
            detail["drive"] = ((state.get("folders") or {}).get("library") or {}).get("drive") or None
    except Exception as exc:  # noqa: BLE001 - the words without the number
        logger.debug("wait detail unreadable: %s", exc)
    return detail


def _sweep(database, snapshot: Dict[str, Any], *, settings: Dict[str, bool], profile_id: Optional[int] = None,
           admin: bool = False, line: bool = False) -> Dict[str, Any]:
    """The sweep's own state for the caller: the track it's on is named only
    when it's in the caller's library."""
    from core.dj import progress as steps
    from core.dj import worker

    live = snapshot["live"]
    held_by = snapshot.get("held_by")
    out: Dict[str, Any] = {"running": live is not None, "held": bool(snapshot.get("held")),
                           "analyze": bool(settings.get("analyze", True)), "in_line": snapshot["in_line"],
                           "yours": snapshot["yours"], "current": None, "waiting": None, "total": 0, "done": 0,
                           "percent": None, "id": None, "left": int(snapshot.get("left") or 0),
                           "next_in": worker.next_sweep_in() if settings.get("analyze", True) else None,
                           # who stopped it: named to admins ("Analysis stopped by Ross"),
                           # "an admin" to members (31d)
                           "held_by": None, "held_by_you": bool(held_by is not None and held_by == profile_id),
                           "waiting_detail": None}
    if out["held"] and admin and held_by is not None:
        out["held_by"] = _profile_names(database, [held_by]).get(int(held_by))
    # yours go first: every one of this profile's tracks is ahead of the rest
    out["yours_first"] = bool(snapshot.get("yours_first"))
    if line:
        out.update(_line(database, snapshot, profile_id, admin))
    if live is None:
        return out
    total = int(live.get("total") or 0)
    finished = sum(int(live.get(k) or 0) for k in ("done", "failed", "unreachable", "skipped"))
    out.update(id=live.get("id"), total=total, done=finished, waiting=live.get("waiting"),
               percent=int(100 * finished / total) if total else None)
    out["waiting_detail"] = _wait_detail(database, live.get("waiting"), admin, profile_id)
    current = live.get("current")
    if current:
        shown: Dict[str, Any] = {"step": live.get("step"),
                                 "percent": steps.percent(live.get("step_mode"), live.get("step")),
                                 "asked_for": bool(live.get("asked_for")), "track_id": None, "title": None,
                                 "artist": None, "mode": live.get("step_mode"), "times": {}, "now": None,
                                 "elapsed": None}
        try:
            mine = _rows(database, [str(current)])
        except Exception as exc:  # noqa: BLE001 - unnamed, then
            logger.debug("current track unreadable: %s", exc)
            mine = {}
        if str(current) in mine:
            shown.update(track_id=str(current), title=mine[str(current)].get("title") or "",
                         artist=mine[str(current)].get("artist") or "",
                         **_step_times(live, time.monotonic()))
        out["current"] = shown
    return out


def progress(database, ids: Iterable[Any], profile_id: Optional[int], *, job=None,
             settings: Optional[Dict[str, bool]] = None, admin: bool = False,
             line: bool = False) -> Dict[str, Any]:
    """``{tracks: {id: entry}, sweep}`` for the caller's tracks among ``ids``
    (others are left out). See the module's words for the entries."""
    from core.dj import progress as steps
    from core.dj import worker

    job = job or worker.JOB
    settings = settings if settings is not None else worker.settings_state()
    rows = _rows(database, [str(i) for i in ids])
    snapshot = job.queue_snapshot(list(rows), profile_id, line=line)
    live = snapshot["live"]
    version = worker.analyzer_version()
    waiting = (live or {}).get("waiting")
    tracks: Dict[str, Dict[str, Any]] = {}
    for track_id, row in rows.items():
        has = readiness(row)
        if live is not None and str(live.get("current") or "") == track_id:
            tracks[track_id] = {"state": "working", "step": live.get("step"),
                                "percent": steps.percent(live.get("step_mode"), live.get("step")) or 0,
                                "mode": live.get("step_mode"), "ready": has["ready"], "bpm_key": has["bpm_key"]}
            continue
        place = snapshot["places"].get(track_id)
        state = classify(row, version)
        # in line to be analysed again (Analyse again) counts as in line too
        again = track_id in (snapshot.get("again") or ())
        if place is not None and (state["needs"] or state["failed"] == "unreachable" or again):
            position, asked_for, yours = place
            # ``yours``: this caller asked for it, so its Cancel does something (L4)
            entry: Dict[str, Any] = {"state": "queued", "position": position, "asked_for": asked_for,
                                     "yours": yours, "ready": has["ready"], "bpm_key": has["bpm_key"]}
            # an asked-for track never waits for a download or an import
            if waiting in WAITS and not (asked_for and waiting in worker.SOFT_WAITS):
                entry.update(state="waiting", reason=waiting)
            tracks[track_id] = entry
            continue
        if state["failed"]:
            failed: Dict[str, Any] = {"state": "failed", "reason": state["failed"], "ready": False,
                                      "bpm_key": has["bpm_key"]}
            if state["failed"] == "too_long":
                failed["duration"] = _seconds(row.get("duration"))
            tracks[track_id] = failed
            continue
        if not state["needs"]:
            done: Dict[str, Any] = {"state": "done", "ready": has["ready"], "bpm_key": has["bpm_key"]}
            if has["beat"]:
                done["beat"] = has["beat"]
            tracks[track_id] = done
            continue
        reason = "off" if not settings.get("analyze", True) else "held" if snapshot.get("held") else "not_queued"
        tracks[track_id] = {"state": "waiting", "reason": reason, "position": None, "asked_for": False,
                            "ready": has["ready"], "bpm_key": has["bpm_key"]}
    return {"tracks": tracks, "sweep": _sweep(database, snapshot, settings=settings, profile_id=profile_id,
                                              admin=admin, line=line)}


def withdraw(ids: Iterable[Any], profile_id: int, *, job=None) -> Dict[str, int]:
    """Cancel (the Mix tab, 31c): this profile's asks for these tracks
    leave the line; a track someone else asked for stays for them."""
    from core.dj import worker

    return (job or worker.JOB).withdraw([str(i) for i in ids], int(profile_id))


def promote(profile_id: int, *, job=None) -> Dict[str, int]:
    """Analyse mine: this profile's tracks in line go to the front."""
    from core.dj import worker

    return (job or worker.JOB).promote(int(profile_id))


__all__ = ["ASK_EVERY_SECONDS", "ASK_LIMIT", "LINE_SHOWN", "MAX_IDS", "RateLimit", "SHOWN_STEPS", "WAITS", "ask",
           "classify", "progress", "promote", "readiness", "withdraw"]
