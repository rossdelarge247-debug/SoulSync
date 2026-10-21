"""Basic download-source file search — flat list of file results sorted by quality.

Used by the basic search UI on the Search page and by ``/api/search``.

``run_basic_search`` replaced ``run_basic_soulseek_search`` so the caller
can target any active download source (not just slskd). The old name is
kept as a thin alias for backwards compat with any callers outside this
module.
"""

from __future__ import annotations

import inspect
import logging
import threading
import time
from typing import Callable, Iterator, Optional

logger = logging.getLogger(__name__)


def _quality_score(result) -> float:
    """Read ``result.quality_score`` as a plain float.

    ``quality_score`` is a ``@property`` on both ``SearchResult`` and
    ``AlbumResult``, so it is NOT in ``__dict__`` and does not survive the
    ``__dict__.copy()`` serialisation below — it has to be read off the
    object and written onto the dict explicitly. Without this the score
    reaches neither the sort here nor the browser, which is why the Quality
    sort and the quality term of the frontend's relevance score both did
    nothing.

    Defensive because the property computes: it calls ``.lower()`` on
    ``quality``/``dominant_quality``, which a source is free to leave None.
    A single odd result must not take down the whole search.
    """
    try:
        return float(result.quality_score)
    except Exception as exc:  # noqa: BLE001 - one bad result must not kill a search
        logger.debug("quality_score unavailable for %r: %s", type(result).__name__, exc)
        return 0.0


def run_basic_search(
    query: str,
    download_orchestrator,
    run_async: Callable,
    *,
    source: Optional[str] = None,
) -> list[dict]:
    """Search ``source`` (or the active/first hybrid source) for ``query``.

    Returns dicts with ``result_type`` set to ``"album"`` or ``"track"``
    and sorted by ``quality_score`` descending. Empty list on any failure.

    Parameters
    ----------
    source:
        Optional source name to override the orchestrator's default selection.
        Must be a canonical name from ``DownloadPluginRegistry`` (e.g.
        ``"soulseek"``, ``"tidal"``, ``"qobuz"``). When ``None``, behaviour
        is unchanged from before: orchestrator.search() picks the active
        source (single mode) or the first in chain (hybrid).
    """
    tracks, albums = run_async(_search_call(query, download_orchestrator, source)())
    return serialize_results(tracks, albums)


def _search_call(query: str, download_orchestrator, source: Optional[str]):
    """The coroutine factory for one basic search: ``factory(progress_callback=None)``.

    Shared by ``run_basic_search`` and ``stream_basic_search`` so both route a
    query the same way: a pasted SoundCloud link always goes to SoundCloud, a
    named ``source`` goes straight to that client, and anything else goes
    through the orchestrator (single-source mode, or the hybrid chain).
    """
    # A pasted SoundCloud link only resolves on the SoundCloud source (its
    # share URL carries the access token; no other source can find an
    # unlisted track) — force the route no matter which source is selected,
    # the same way manual search does (#865). The user just pastes the link.
    forced_soundcloud = False
    try:
        from core.soundcloud_client import is_soundcloud_url
        if is_soundcloud_url(query):
            source = 'soundcloud'
            forced_soundcloud = True
    except Exception as exc:   # noqa: BLE001 - routing sugar must never kill a search
        logger.debug("soundcloud URL routing skipped: %s", exc)

    target = download_orchestrator
    if source and download_orchestrator:
        # Target a specific source: resolve the client and call search()
        # directly instead of going through the orchestrator chain.
        try:
            client = download_orchestrator.client(source)
        except Exception as exc:
            logger.warning("basic search: could not resolve client for %r: %s", source, exc)
            client = None

        if client is None:
            if forced_soundcloud:
                # a SoundCloud URL can ONLY resolve on SoundCloud — falling
                # back would search the raw URL as text and silently return
                # nothing. Say what's wrong instead (parity with manual search).
                raise ValueError("SoundCloud isn't connected — enable it in "
                                 "Settings to resolve a SoundCloud link.")
            logger.warning("basic search: no client for source %r — falling back to orchestrator", source)
        else:
            logger.info("basic search: targeting %r for %r", source, query)
            target = client

    def factory(progress_callback=None):
        if progress_callback is not None and _accepts_progress(target.search):
            return target.search(query, progress_callback=progress_callback)
        return target.search(query)

    return factory


def _accepts_progress(search) -> bool:
    try:
        return 'progress_callback' in inspect.signature(search).parameters
    except (TypeError, ValueError):
        return False


def serialize_results(tracks, albums) -> list[dict]:
    """Search results as the browser gets them: dicts tagged with
    ``result_type`` and ``quality_score``, best quality first."""
    processed_albums = []
    for album in albums or []:
        album_dict = album.__dict__.copy()
        album_dict['tracks'] = [
            dict(track.__dict__, quality_score=_quality_score(track)) for track in album.tracks
        ]
        album_dict['result_type'] = 'album'
        album_dict['quality_score'] = _quality_score(album)
        processed_albums.append(album_dict)

    processed_tracks = []
    for track in tracks or []:
        track_dict = track.__dict__.copy()
        track_dict['result_type'] = 'track'
        track_dict['quality_score'] = _quality_score(track)
        processed_tracks.append(track_dict)

    return sorted(
        processed_albums + processed_tracks,
        key=lambda x: x.get('quality_score', 0),
        reverse=True,
    )


def _file_count(tracks, albums) -> int:
    return len(tracks or []) + sum(len(getattr(a, 'tracks', None) or []) for a in albums or [])


def stream_basic_search(
    query: str,
    download_orchestrator,
    run_async: Callable,
    *,
    source: Optional[str] = None,
    min_interval: float = 1.0,
    poll: float = 0.25,
) -> Iterator[dict]:
    """``run_basic_search``, reporting results while the search still runs.

    Yields ``{"type": "progress", "files", "users", "results"}`` as the source
    reports what it has so far (Soulseek does, about once a second; other
    sources answer once), no more often than every ``min_interval`` seconds,
    then one ``{"type": "done", "files", "users", "results"}`` with the final
    list, or ``{"type": "error", "error"}`` with a sentence for the user.

    ``files`` counts every file, including the tracks inside a folder;
    ``users`` is how many Soulseek users answered (``None`` when the source
    doesn't say).

    The search itself runs on its own thread, so a slow network never stops
    the progress lines; the source calls back on the shared event loop and
    only the newest snapshot is kept.
    """
    try:
        factory = _search_call(query, download_orchestrator, source)
    except ValueError as exc:
        yield {"type": "error", "error": str(exc)}
        return

    lock = threading.Lock()
    latest: dict = {}
    changed = threading.Event()
    finished = threading.Event()
    outcome: dict = {}

    def on_progress(*args):
        if len(args) < 2:
            return
        with lock:
            latest['tracks'] = list(args[0] or [])
            latest['albums'] = list(args[1] or [])
            latest['users'] = args[2] if len(args) > 2 and isinstance(args[2], int) else None
            latest['seq'] = latest.get('seq', 0) + 1
        changed.set()

    def run():
        try:
            outcome['result'] = run_async(factory(progress_callback=on_progress))
        except Exception as exc:  # noqa: BLE001 - reported to the browser as one line
            outcome['error'] = exc
        finally:
            finished.set()
            changed.set()

    threading.Thread(target=run, daemon=True, name='basic-search-stream').start()

    sent_seq = 0
    last_sent = 0.0
    while True:
        changed.wait(poll)
        changed.clear()
        if finished.is_set():
            break
        with lock:
            seq = latest.get('seq', 0)
            snapshot = dict(latest)
        now = time.monotonic()
        if seq > sent_seq and now - last_sent >= min_interval:
            sent_seq, last_sent = seq, now
            yield {
                "type": "progress",
                "files": _file_count(snapshot['tracks'], snapshot['albums']),
                "users": snapshot['users'],
                "results": serialize_results(snapshot['tracks'], snapshot['albums']),
            }

    if 'error' in outcome:
        exc = outcome['error']
        logger.error("basic search stream failed: %s", exc)
        yield {"type": "error", "error": str(exc) if isinstance(exc, ValueError) else "The search failed."}
        return
    tracks, albums = outcome.get('result') or ([], [])
    with lock:
        users = latest.get('users')
    yield {
        "type": "done",
        "files": _file_count(tracks, albums),
        "users": users,
        "results": serialize_results(tracks, albums),
    }


# Backwards-compat alias for any callers that haven't been updated yet.
run_basic_soulseek_search = run_basic_search
