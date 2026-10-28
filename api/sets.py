"""Library → Sets (BACKLOG "Famous mixes and AI set suggestions", Sets 1;
CONTRACTS.md "Sets"). Code: core/sets/.

GET    /api/sets                     Your sets.
POST   /api/sets                     Save as mix set: a new set, and its playlist.
GET    /api/sets/<id>                One of your sets, with its view.
PUT    /api/sets/<id>                Change a saved set's name or tracks (its playlist follows while
                                     it still holds what the set wrote), from `base_revision`, which
                                     is required: the save applies only while the set is still at it
                                     (409 stale; without one, 409 stale with reason "reload").
POST   /api/sets/<id>/playlist       {action: new | dismiss}: a new playlist from the set, or stop
                                     saying its playlist went its own way.
DELETE /api/sets/<id>                Remove a set; its playlist stays.
POST   /api/sets/<id>/tracks         {track_ids, again?, after?}: "Add to mix set…", at the end
                                     (or after ``after: {track_id, number}``, the Mix tab while a
                                     set plays); only library tracks with their file, one the set
                                     holds skipped unless ``again``; the playlist follows.
POST   /api/sets/holding             {track_ids}: the picker's sets, newest change first, with
                                     the number the next track takes and where these already are.
GET    /api/sets/working             The Mix tab's working set (one per profile), or null.
PUT    /api/sets/working             {set_id | null}: choose one of your sets, or none.
POST   /api/sets/working/start       {name, track_ids}: a new mix set of these, made the working set
                                     ({id, tracks: how many went in, working}).
POST   /api/sets/view                Rows -> library tracks, steps and the meta line (drafts).
GET    /api/sets/swap                Alternatives that fit both neighbours (Swap).
GET    /api/sets/sources             Each tracklist source's set-up state.
GET    /api/sets/famous/search?q=    Famous mixes from MixesDB, MusicBrainz and Discogs.
POST   /api/sets/famous/open         One mix's tracklist, matched to your library.
POST   /api/sets/match               Tracklist lines matched to your library ("Type it…").
POST   /api/sets/paste               A pasted tracklist read by code and matched.
POST   /api/sets/wanted              Tracks onto Wanted ("Add N missing", "Want the Dub"), each
                                     keyed by a SHA-256 of its artist and title.
POST   /api/sets/wanted/remove       Take back a "Want the Dub" still waiting on Wanted.

Every route needs a profile. Sets are the caller's own (admins included):
another profile's set reads as missing. Library reads use the caller's
library scope, like the DJ routes. Bodies are read with a hard size cap.
"""

from __future__ import annotations

from typing import Any, Optional

from flask import Blueprint, jsonify, request

from api.dj import _read_json_capped
from core.profile_context import get_current_profile_id
from utils.logging_config import get_logger

logger = get_logger("api.sets")

bp = Blueprint("sets", __name__)

get_database = None
fix_art_url = None

#: a set of 500 rows is well under this
MAX_BODY = 256 * 1024
#: a pasted tracklist: the text cap (core.sets.tracklist.MAX_PASTE_CHARS, in
#: characters) at up to 6 bytes each once in JSON (a \uXXXX escape; a raw
#: UTF-8 character is at most 4), plus room for the rest of the body. The
#: text itself is then capped in characters.
MAX_PASTE_BODY = 64 * 1024 * 6 + 8 * 1024


def configure(*, get_database_, fix_art_url_=None) -> None:
    global get_database, fix_art_url
    get_database = get_database_
    fix_art_url = fix_art_url_


def create_blueprint():
    return bp


def _profile() -> Optional[int]:
    pid = get_current_profile_id()
    return int(pid) if pid is not None else None


def _no_profile():
    return jsonify({"success": False, "error": "profile_required"}), 401


def _bad(message: str, status: int = 400):
    return jsonify({"success": False, "error": message}), status


def _ok(payload: dict, status: int = 200):
    response = jsonify({"success": True, **payload})
    response.status_code = status
    response.headers["Cache-Control"] = "no-store"
    return response


def _body(limit: int = MAX_BODY):
    body, refused = _read_json_capped(limit)
    if refused is not None:
        return None, refused
    if not isinstance(body, dict):
        return None, _bad("Send it as JSON")
    return body, None


def _failed(what: str, exc: Exception):
    logger.error("Sets: %s failed: %s", what, exc, exc_info=True)
    return _bad("Couldn't read your sets just now", 500)


# ── your sets ─────────────────────────────────────────────────────────────────

@bp.route("/api/sets", methods=["GET"])
def list_sets():
    pid = _profile()
    if pid is None:
        return _no_profile()
    from core.sets import store

    try:
        return _ok({"sets": store.list_sets(get_database(), pid)})
    except Exception as exc:  # noqa: BLE001
        return _failed("list", exc)


@bp.route("/api/sets", methods=["POST"])
def create_set():
    pid = _profile()
    if pid is None:
        return _no_profile()
    body, refused = _body()
    if refused is not None:
        return refused
    from core.sets import store

    database = get_database()
    try:
        set_id = store.create_set(database, pid, body)
        saved = store.get_set(database, pid, set_id)
        playlist_id = store.make_playlist(database, pid, set_id, saved["name"], saved["rows"])
    except store.SetError as exc:
        return _bad(str(exc))
    except Exception as exc:  # noqa: BLE001
        return _failed("save", exc)
    return _ok({"id": set_id, "playlist_id": playlist_id}, 201)


@bp.route("/api/sets/<int:set_id>", methods=["GET"])
def get_set(set_id: int):
    pid = _profile()
    if pid is None:
        return _no_profile()
    from core.sets import store

    database = get_database()
    try:
        found = store.get_set(database, pid, set_id)
        if found is None:
            return _bad("That set isn't one of yours", 404)
        rows = [{**r, "line_at": r.get("at")} for r in found.pop("rows")]
        return _ok({"set": found, **store.view(database, rows, fix_art=fix_art_url)})
    except Exception as exc:  # noqa: BLE001
        return _failed("read", exc)


@bp.route("/api/sets/<int:set_id>", methods=["PUT"])
def update_set(set_id: int):
    pid = _profile()
    if pid is None:
        return _no_profile()
    body, refused = _body()
    if refused is not None:
        return refused
    from core.sets import store

    database = get_database()
    try:
        done = store.update_set(database, pid, set_id, body)
        if done is None:
            return _bad("That set isn't one of yours", 404)
        if done["tracks_changed"]:
            # the rows read again under the sync's lock (store.follow_latest)
            state = store.follow_latest(database, pid, set_id)
        else:
            state = (store.get_set(database, pid, set_id) or {}).get("playlist_state")
    except store.StaleRevision as exc:
        # the set moved on since the page's base (or the save had no base):
        # nothing changed; the page reads the set again
        body = {"success": False, "stale": True, "revision": exc.current,
                "error": "A newer change to this set is already saved."}
        if exc.reason:
            body["reason"] = exc.reason
            body["error"] = "This page is out of date. Reload it to keep editing the set."
        return jsonify(body), 409
    except store.SetError as exc:
        return _bad(str(exc))
    except Exception as exc:  # noqa: BLE001
        return _failed("update", exc)
    return _ok({"id": set_id, "revision": done["revision"], "playlist_state": state})


@bp.route("/api/sets/<int:set_id>/playlist", methods=["POST"])
def set_playlist(set_id: int):
    pid = _profile()
    if pid is None:
        return _no_profile()
    body, refused = _body(1024)
    if refused is not None:
        return refused
    from core.sets import store

    database = get_database()
    try:
        saved = store.get_set(database, pid, set_id)
        if saved is None:
            return _bad("That set isn't one of yours", 404)
        if body.get("action") == "dismiss":
            store.clear_playlist_state(database, pid, set_id)
            return _ok({"playlist_id": saved.get("playlist_id")})
        if body.get("action") != "new":
            return _bad("action must be new or dismiss")
        # a new playlist only for a set whose playlist no longer follows it
        # (changed elsewhere or deleted), or that has none: one set can't
        # make playlists without end
        if (saved.get("playlist_id") and not saved.get("playlist_state")
                and store.has_own_playlist(database, pid, saved["playlist_id"])):
            return jsonify({"success": False, "following": True, "playlist_id": saved["playlist_id"],
                            "error": "This set already has a playlist that follows it."}), 409
        playlist_id = store.make_playlist(database, pid, set_id, saved["name"], saved["rows"])
    except Exception as exc:  # noqa: BLE001
        return _failed("playlist", exc)
    if playlist_id is None:
        return _bad("The playlist wasn't made. Try again in a moment.", 500)
    return _ok({"playlist_id": playlist_id})


@bp.route("/api/sets/<int:set_id>", methods=["DELETE"])
def delete_set(set_id: int):
    pid = _profile()
    if pid is None:
        return _no_profile()
    from core.sets import store

    try:
        if not store.delete_set(get_database(), pid, set_id):
            return _bad("That set isn't one of yours", 404)
    except Exception as exc:  # noqa: BLE001
        return _failed("delete", exc)
    return _ok({"deleted": set_id})


# ── "Add to mix set…" (28a, 28b) ──────────────────────────────────────────────

def _track_ids(body):
    from core.stars import store as stars

    try:
        ids = stars.clean_ids(body.get("track_ids"))
    except stars.StarError as exc:
        return None, _bad(str(exc))
    if not ids:
        return None, _bad("track_ids must name at least one track")
    return ids, None


@bp.route("/api/sets/<int:set_id>/tracks", methods=["POST"])
def add_tracks(set_id: int):
    pid = _profile()
    if pid is None:
        return _no_profile()
    body, refused = _body(64 * 1024)
    if refused is not None:
        return refused
    ids, refused = _track_ids(body)
    if refused is not None:
        return refused
    from core.sets import store

    database = get_database()
    try:
        after = body.get("after") if isinstance(body.get("after"), dict) else None
        done = store.append_tracks(database, pid, set_id, ids, again=body.get("again") is True, after=after)
        if done is None:
            return _bad("That set isn't one of yours", 404)
        if done["tracks_changed"]:
            state = store.follow_latest(database, pid, set_id)
        saved = store.get_set(database, pid, set_id) or {}
        if not done["tracks_changed"]:
            state = saved.get("playlist_state")
    except store.SetError as exc:
        return _bad(str(exc))
    except Exception as exc:  # noqa: BLE001
        return _failed("add", exc)
    return _ok({"id": set_id, "name": saved.get("name", ""), "added": done["added"], "already": done["already"],
                "left_out": done["left_out"], "revision": done["revision"], "playlist_state": state,
                "placed": done["placed"]})


# ── the working set (the Mix tab, 29a) ────────────────────────────────────────

@bp.route("/api/sets/working", methods=["GET"])
def working_get():
    pid = _profile()
    if pid is None:
        return _no_profile()
    from core.sets import working

    try:
        return _ok({"working": working.get(get_database(), pid)})
    except Exception as exc:  # noqa: BLE001
        return _failed("working", exc)


@bp.route("/api/sets/working", methods=["PUT"])
def working_put():
    pid = _profile()
    if pid is None:
        return _no_profile()
    body, refused = _body(1024)
    if refused is not None:
        return refused
    from core.sets import working

    raw = body.get("set_id")
    database = get_database()
    try:
        if raw is None:
            working.clear(database, pid)
            return _ok({"working": None})
        if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0:
            return _bad("set_id must be one of your sets, or null")
        chosen = working.choose(database, pid, raw)
    except Exception as exc:  # noqa: BLE001
        return _failed("working", exc)
    if chosen is None:
        return _bad("That set isn't one of yours", 404)
    return _ok({"working": chosen})


@bp.route("/api/sets/working/start", methods=["POST"])
def working_start():
    """A new mix set holding these tracks, made the working set (29d's "New
    mix set", and A or Add with no working set yet)."""
    pid = _profile()
    if pid is None:
        return _no_profile()
    body, refused = _body(64 * 1024)
    if refused is not None:
        return refused
    ids, refused = _track_ids(body)
    if refused is not None:
        return refused
    from core.sets import store, working

    database = get_database()
    try:
        set_id = working.start(database, pid, body.get("name"), ids)
        saved = store.get_set(database, pid, set_id)
    except store.SetError as exc:
        return _bad(str(exc))
    except Exception as exc:  # noqa: BLE001
        return _failed("start", exc)
    # how many went in (tracks not in the library, or without a file, don't)
    count = len(saved["rows"]) if saved else 0
    return _ok({"id": set_id, "tracks": count, "working": working.get(database, pid)}, 201)


@bp.route("/api/sets/holding", methods=["POST"])
def holding():
    pid = _profile()
    if pid is None:
        return _no_profile()
    body, refused = _body(64 * 1024)
    if refused is not None:
        return refused
    ids, refused = _track_ids(body)
    if refused is not None:
        return refused
    from core.sets import store

    try:
        return _ok({"sets": store.holding(get_database(), pid, ids)})
    except Exception as exc:  # noqa: BLE001
        return _failed("holding", exc)


# ── the draft's view and Swap ─────────────────────────────────────────────────

@bp.route("/api/sets/view", methods=["POST"])
def view():
    pid = _profile()
    if pid is None:
        return _no_profile()
    body, refused = _body()
    if refused is not None:
        return refused
    from core.sets import store

    try:
        rows = store.clean_rows(body.get("tracks"))
        return _ok(store.view(get_database(), rows, fix_art=fix_art_url))
    except store.SetError as exc:
        return _bad(str(exc))
    except Exception as exc:  # noqa: BLE001
        return _failed("view", exc)


def _arg_id(name: str) -> Optional[str]:
    value = (request.args.get(name) or "").strip()
    return value[:128] or None


@bp.route("/api/sets/swap", methods=["GET"])
def swap():
    pid = _profile()
    if pid is None:
        return _no_profile()
    from core.sets import store

    exclude = [x.strip()[:128] for x in (request.args.get("exclude") or "").split(",") if x.strip()][:500]
    try:
        limit = int(request.args.get("limit") or 8)
    except ValueError:
        limit = 8
    try:
        found = store.alternatives(get_database(), before=_arg_id("before"), after=_arg_id("after"),
                                   current=_arg_id("current"), exclude=exclude, limit=limit, fix_art=fix_art_url)
    except Exception as exc:  # noqa: BLE001
        return _failed("swap", exc)
    return _ok(found)


# ── famous mixes ──────────────────────────────────────────────────────────────

@bp.route("/api/sets/sources", methods=["GET"])
def sources_state():
    if _profile() is None:
        return _no_profile()
    from core.sets import sources

    return _ok({"sources": sources.states()})


def _saved_matches(database, pid: int, query: str) -> list:
    """Your saved famous mixes whose name has the words, so a mix whose
    source is down still opens (22r)."""
    from core.sets import store

    return store.saved_famous(database, pid, query.split())


@bp.route("/api/sets/famous/search", methods=["GET"])
def famous_search():
    pid = _profile()
    if pid is None:
        return _no_profile()
    from core.sets import sources

    query = " ".join((request.args.get("q") or "").split())[:sources.MAX_QUERY]
    if not query:
        return _bad("Type what to look for")
    try:
        found = sources.search(query, profile_id=pid)
        saved = _saved_matches(get_database(), pid, query)
    except Exception as exc:  # noqa: BLE001
        return _failed("search", exc)
    return _ok({"query": query, "results": found["results"], "saved": saved, "sources": found["sources"]})


@bp.route("/api/sets/famous/open", methods=["POST"])
def famous_open():
    pid = _profile()
    if pid is None:
        return _no_profile()
    body, refused = _body(8 * 1024)
    if refused is not None:
        return refused
    from core.sets import matching, sources

    source = body.get("source")
    mix_id = body.get("id")
    if source not in sources.SOURCES or not isinstance(mix_id, str) or not mix_id.strip():
        return _bad("source and id are needed")
    try:
        mix = sources.open_mix(source, mix_id, profile_id=pid)
    except LookupError:
        return _bad(f"{sources.SOURCE_NAMES[source]} isn't searched", 409)
    except sources.SourceBusy as exc:
        name = sources.SOURCE_NAMES[source]
        said = (f"You've opened several mixes from {name} just now. Try again in a minute."
                if exc.why == "profile" else f"{name} is busy right now. Try again in a minute.")
        return jsonify({"success": False, "limited": source, "why": exc.why, "error": said}), 429
    except sources.SourceDown:
        return jsonify({"success": False, "down": source, "source_name": sources.SOURCE_NAMES[source],
                        "error": f"{sources.SOURCE_NAMES[source]} can't be reached"}), 503
    except Exception as exc:  # noqa: BLE001
        return _failed("open", exc)
    if not mix.get("found"):
        return _bad("That mix isn't there any more", 404)
    try:
        rows = matching.match_lines(get_database(), mix["lines"], fix_art=fix_art_url)
    except Exception as exc:  # noqa: BLE001
        return _failed("match", exc)
    meta = {k: mix.get(k) for k in ("source", "id", "title", "artist", "date", "edited", "url", "kind", "seconds")}
    return _ok({"mix": meta, "rows": rows, "counts": matching.counts(rows)})


@bp.route("/api/sets/match", methods=["POST"])
def match():
    pid = _profile()
    if pid is None:
        return _no_profile()
    body, refused = _body()
    if refused is not None:
        return refused
    from core.sets import matching

    lines = body.get("lines")
    if not isinstance(lines, list) or len(lines) > matching.MAX_MATCH_LINES:
        return _bad(f"lines must be a list of at most {matching.MAX_MATCH_LINES}")
    clean = [line for line in lines if isinstance(line, dict)]
    try:
        rows = matching.match_lines(get_database(), clean, fix_art=fix_art_url)
    except Exception as exc:  # noqa: BLE001
        return _failed("match", exc)
    return _ok({"rows": rows, "counts": matching.counts(rows)})


@bp.route("/api/sets/paste", methods=["POST"])
def paste():
    pid = _profile()
    if pid is None:
        return _no_profile()
    body, refused = _body(MAX_PASTE_BODY)
    if refused is not None:
        return refused
    from core.sets import matching, tracklist

    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        return _bad("Paste the tracklist first")
    if len(text) > tracklist.MAX_PASTE_CHARS:
        return _bad("That's longer than a tracklist can be (64,000 characters)", 413)
    read = tracklist.read_paste(text)
    readable = [line for line in read["lines"] if line["kind"] in ("track", "id")]
    unread = [line for line in read["lines"] if line["kind"] == "unread"]
    try:
        rows = matching.match_lines(get_database(), readable, fix_art=fix_art_url)
    except Exception as exc:  # noqa: BLE001
        return _failed("paste", exc)
    return _ok({"rows": rows, "unread": unread, "counts": matching.counts(rows), "lines": read["count"],
                "cut": read["cut"]})


@bp.route("/api/sets/wanted", methods=["POST"])
def wanted():
    pid = _profile()
    if pid is None:
        return _no_profile()
    body, refused = _body(64 * 1024)
    if refused is not None:
        return refused
    from core.sets import wanted as sets_wanted

    items: Any = body.get("tracks")
    if not isinstance(items, list) or not items:
        return _bad("tracks must be a list")
    if len(items) > sets_wanted.MAX_ITEMS:
        return _bad(f"At most {sets_wanted.MAX_ITEMS} tracks at a time")
    name = body.get("set_name") if isinstance(body.get("set_name"), str) else ""
    try:
        result = sets_wanted.add(get_database(), pid, [i for i in items if isinstance(i, dict)], set_name=name)
    except Exception as exc:  # noqa: BLE001
        return _failed("wanted", exc)
    return _ok(result)


@bp.route("/api/sets/wanted/remove", methods=["POST"])
def wanted_remove():
    """Use yours again after Want the Dub: this set's want of the Wanted row
    that choice added is taken back, if the row is still waiting (not
    downloaded). The row goes only when no other set wants it too.
    ``set_name`` is required."""
    pid = _profile()
    if pid is None:
        return _no_profile()
    body, refused = _body(8 * 1024)
    if refused is not None:
        return refused
    from core.sets import wanted as sets_wanted

    name = body.get("set_name") if isinstance(body.get("set_name"), str) else ""
    if not name.strip():
        return _bad("set_name is needed")
    try:
        removed = sets_wanted.remove(get_database(), pid, body.get("artist"), body.get("title"), set_name=name)
    except Exception as exc:  # noqa: BLE001
        return _failed("wanted remove", exc)
    return _ok({"removed": removed})


__all__ = ["bp", "configure", "create_blueprint"]
