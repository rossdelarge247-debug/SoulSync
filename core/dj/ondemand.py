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

Plus the sweep's own state: running or not, how far, what it waits for, and
the track it's on (named only when that track is in the caller's library).
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
                f"SELECT t.id AS tid, t.title AS title, d.status AS d_status, "
                f"d.dj_analyzer_version AS d_version, d.source_sig AS d_sig, "
                f"g.status AS g_status, g.grid_version AS g_version, g.source_sig AS g_sig "
                f"FROM tracks t LEFT JOIN track_dj d ON d.track_id = t.id "
                f"LEFT JOIN track_grid g ON g.track_id = t.id "
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


def ask(database, ids: Iterable[Any], profile_id: int, *, job=None) -> Dict[str, Any]:
    """Put the caller's tracks that need analysis in the asked-for line.
    ``{asked, queued, already_queued, already_done, cant, over_limit, limit,
    yours, started}``: ``asked`` counts the ids in the caller's library,
    ``already_done`` those with nothing to do, ``cant`` those that failed
    and would fail again, ``over_limit`` those past the profile's room."""
    from core.dj import worker

    job = job or worker.JOB
    rows = _rows(database, [str(i) for i in ids])
    version = worker.analyzer_version()
    needs: List[str] = []
    done = cant = 0
    for track_id, row in rows.items():
        state = classify(row, version)
        if state["needs"]:
            needs.append(track_id)
        elif state["failed"]:
            cant += 1
        else:
            done += 1
    result = job.ask(database, needs, int(profile_id)) if needs else {
        "added": [], "already": 0, "over": 0, "yours": job.queue_snapshot([], profile_id)["yours"],
        "limit": worker.PRIORITY_PER_PROFILE, "started": False}
    return {"asked": len(rows), "queued": len(result["added"]), "already_queued": result["already"],
            "already_done": done, "cant": cant, "over_limit": result["over"], "limit": result["limit"],
            "yours": result["yours"], "started": bool(result["started"])}


def _sweep(database, snapshot: Dict[str, Any], *, settings: Dict[str, bool]) -> Dict[str, Any]:
    """The sweep's own state for the caller: the track it's on is named only
    when it's in the caller's library."""
    from core.dj import progress as steps

    live = snapshot["live"]
    out: Dict[str, Any] = {"running": live is not None, "held": bool(snapshot.get("held")),
                           "analyze": bool(settings.get("analyze", True)), "in_line": snapshot["in_line"],
                           "yours": snapshot["yours"], "current": None, "waiting": None, "total": 0, "done": 0,
                           "percent": None, "id": None}
    if live is None:
        return out
    total = int(live.get("total") or 0)
    finished = sum(int(live.get(k) or 0) for k in ("done", "failed", "unreachable", "skipped"))
    out.update(id=live.get("id"), total=total, done=finished, waiting=live.get("waiting"),
               percent=int(100 * finished / total) if total else None)
    current = live.get("current")
    if current:
        shown: Dict[str, Any] = {"step": live.get("step"),
                                 "percent": steps.percent(live.get("step_mode"), live.get("step")),
                                 "asked_for": bool(live.get("asked_for")), "track_id": None, "title": None}
        try:
            mine = _rows(database, [str(current)])
        except Exception as exc:  # noqa: BLE001 - unnamed, then
            logger.debug("current track unreadable: %s", exc)
            mine = {}
        if str(current) in mine:
            shown.update(track_id=str(current), title=mine[str(current)].get("title") or "")
        out["current"] = shown
    return out


def progress(database, ids: Iterable[Any], profile_id: Optional[int], *, job=None,
             settings: Optional[Dict[str, bool]] = None) -> Dict[str, Any]:
    """``{tracks: {id: entry}, sweep}`` for the caller's tracks among ``ids``
    (others are left out). See the module's words for the entries."""
    from core.dj import progress as steps
    from core.dj import worker

    job = job or worker.JOB
    settings = settings if settings is not None else worker.settings_state()
    rows = _rows(database, [str(i) for i in ids])
    snapshot = job.queue_snapshot(list(rows), profile_id)
    live = snapshot["live"]
    version = worker.analyzer_version()
    waiting = (live or {}).get("waiting")
    tracks: Dict[str, Dict[str, Any]] = {}
    for track_id, row in rows.items():
        if live is not None and str(live.get("current") or "") == track_id:
            tracks[track_id] = {"state": "working", "step": live.get("step"),
                                "percent": steps.percent(live.get("step_mode"), live.get("step")) or 0}
            continue
        place = snapshot["places"].get(track_id)
        state = classify(row, version)
        if place is not None and (state["needs"] or state["failed"] == "unreachable"):
            position, asked_for = place
            entry: Dict[str, Any] = {"state": "queued", "position": position, "asked_for": asked_for}
            # an asked-for track never waits for a download or an import
            if waiting in WAITS and not (asked_for and waiting in worker.SOFT_WAITS):
                entry.update(state="waiting", reason=waiting)
            tracks[track_id] = entry
            continue
        if state["failed"]:
            tracks[track_id] = {"state": "failed", "reason": state["failed"]}
            continue
        if not state["needs"]:
            tracks[track_id] = {"state": "done"}
            continue
        reason = "off" if not settings.get("analyze", True) else "held" if snapshot.get("held") else "not_queued"
        tracks[track_id] = {"state": "waiting", "reason": reason, "position": None, "asked_for": False}
    return {"tracks": tracks, "sweep": _sweep(database, snapshot, settings=settings)}


__all__ = ["ASK_EVERY_SECONDS", "ASK_LIMIT", "MAX_IDS", "RateLimit", "WAITS", "ask", "classify", "progress"]
