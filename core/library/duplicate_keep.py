"""Choosing which copy of a duplicate track to keep.

The keeper is the highest-quality copy, and **format/lossless is the primary
criterion**: a lossless FLAC must beat a lossy MP3 regardless of the recorded
bitrate number — a FLAC whose bitrate the library scan never populated (a
common gap) still has to win over a 282 kbps MP3. Only *within* the same format
tier do bitrate, then duration, then track number break the tie.

This was lifted out of the repair worker so the deletion path and the UI's
"Keep Best" recommendation rank identically (previously both ranked by bitrate
first, which kept the MP3 when the FLAC's bitrate was missing), and so the
ranking is unit-testable in isolation.
"""

from __future__ import annotations

import os
from typing import Dict, List, Optional, Tuple

# Format quality rank by file extension (higher = better). Mirrors
# ``album_matching.default_quality_rank`` so lossless always outranks lossy.
_FORMAT_RANK = {
    ".flac": 10, ".wav": 9, ".aiff": 9, ".aif": 9, ".ape": 8,
    ".m4a": 7, ".ogg": 6, ".opus": 6, ".mp3": 5, ".aac": 5, ".wma": 3,
}


def format_rank_for_path(file_path: Optional[str]) -> int:
    """Quality rank for a file by extension (higher = better, unknown = 1)."""
    if not file_path:
        return 1
    ext = os.path.splitext(str(file_path))[1].lower()
    return _FORMAT_RANK.get(ext, 1)


def duplicate_keep_sort_key(track: Dict) -> Tuple[int, int, int, float, int]:
    """Sort key for picking the keeper — the higher tuple wins.

    Order of precedence: in a server playlist, then format/lossless tier, then
    bitrate, then duration, then track number (a real number over a
    placeholder ``01``). format over bitrate makes FLAC beat MP3 even when the
    FLAC's bitrate is 0/missing in the DB.

    the playlist copy wins over quality: deleting it drops the song from that
    playlist, so bulk "keep best" would quietly break playlists (discord,
    jadux). ``playlists`` is set by the duplicate detector.
    """
    return (
        1 if track.get("playlists") else 0,
        format_rank_for_path(track.get("file_path")),
        track.get("bitrate") or 0,
        track.get("duration") or 0,
        track.get("track_number") or 0,
    )


def keeper_problem(path: Optional[str]) -> Optional[str]:
    """Why ``path`` cannot be trusted as the surviving copy of a duplicate
    group, or ``None`` when it can.

    Every tool that removes "the other copies" asks this first (#1210: the
    cleaner removed the only copy there was). The keeper must be a regular
    file, non-empty, and readable right now — a dangling path, a zero-byte
    stub or a permission-denied file would leave the user with nothing.
    """
    if not path:
        return 'no copy to keep was found'
    try:
        if not os.path.isfile(path):
            return 'the copy being kept is missing'
        if os.path.getsize(path) <= 0:
            return 'the copy being kept is an empty file'
        with open(path, 'rb') as handle:
            handle.read(1)
    except OSError as exc:
        return f'the copy being kept cannot be read ({exc.strerror or exc})'
    return None


def pick_duplicate_to_keep(tracks: List[Dict]) -> Optional[Dict]:
    """Return the copy to keep from a duplicate group (highest sort key), or
    ``None`` if the group is empty."""
    if not tracks:
        return None
    return max(tracks, key=duplicate_keep_sort_key)
