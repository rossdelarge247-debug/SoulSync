"""How much of the library already meets a quality target, without reading files.

Backs the "Set a quality target" dialog (``GET /api/quality/presets``) and the
Quality card on Home (core/targets/summary.py). The Quality Check scanner
probes every file for its real bit depth and sample rate, which takes minutes
on a big library; these numbers come from what the database already holds for
each track: the file extension (format) and the stored bitrate. They are
judged by the same ``AudioQuality.matches_target`` rules the download pipeline
uses, so where bit depth or sample rate is unknown the same kbps heuristics
apply (a FLAC counts as 24-bit at 1450 kbps or more). ``.m4a``/``.mp4`` files
count as ALAC at 500 kbps or more, AAC below.

One aggregate query (tracks grouped by extension and bitrate), cached for
``CACHE_TTL_SECONDS`` per database and library scope.
"""

from __future__ import annotations

import json
import threading
import time
from contextlib import closing
from typing import Any, Dict, Iterable, List, Optional, Tuple

from core.quality.lossless import LOSSLESS_FORMATS
from core.quality.model import AudioQuality, QualityTarget
from core.quality.source_map import AUDIO_EXTENSIONS, format_from_extension

# library make-up changes slowly; the aggregate reads every track row
CACHE_TTL_SECONDS = 600
ALAC_MIN_KBPS = 500

PRESETS: Tuple[Dict[str, Any], ...] = (
    {"key": "mp3_320", "name": "MP3 320", "target_name": "MP3 320 or better", "estimated": False},
    {"key": "flac", "name": "FLAC", "target_name": "FLAC or better", "estimated": False},
    {"key": "flac_24", "name": "FLAC 24-bit", "target_name": "FLAC 24-bit or better", "estimated": True},
    {"key": "lossless", "name": "Any lossless", "target_name": "Any lossless", "estimated": False},
)

_FLAC_24 = QualityTarget(label="FLAC 24-bit", format="flac", bit_depth=24)
_UNTIL_CUTOFF = ("until_cutoff", "until_top")

_cache: Dict[tuple, Tuple[float, List[tuple]]] = {}
_cache_lock = threading.Lock()


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()


# The extension, for the 3- and 4-letter ones every audio format here uses.
# Cheaper per row than one LIKE per known extension; unknown ones map to
# 'unknown' in Python.
_EXT_SQL = ("CASE WHEN substr(file_path, -4, 1) = '.' THEN lower(substr(file_path, -3)) "
            "WHEN substr(file_path, -5, 1) = '.' THEN lower(substr(file_path, -4)) ELSE '' END")


def library_quality_groups(database, *, scope: Any = "current") -> List[tuple]:
    """``[(extension, bitrate_kbps, track_count), ...]`` for library tracks that
    have a file path, in the caller's library scope (core/library_scope.py)."""
    if scope == "current":
        scope_sql, scope_params = database._current_scope_sql("owner_profile_id")
    else:
        scope_sql, scope_params = database._owner_scope_sql(scope, "owner_profile_id")
    key = (str(getattr(database, "database_path", "")), scope_sql, tuple(scope_params))
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_TTL_SECONDS:
            return hit[1]
    with closing(database._get_connection()) as conn:
        rows = conn.execute(
            f"SELECT {_EXT_SQL} AS ext, COALESCE(bitrate, 0) AS br, COUNT(*) AS n FROM tracks "
            f"WHERE file_path IS NOT NULL AND file_path != '' AND {scope_sql} GROUP BY ext, br",
            scope_params).fetchall()
    groups = [(r["ext"] or "", int(r["br"] or 0), int(r["n"])) for r in rows]
    with _cache_lock:
        _cache[key] = (now, groups)
    return groups


def audio_quality(ext: str, bitrate: int) -> AudioQuality:
    fmt = format_from_extension(ext) if ext and f".{ext}" in AUDIO_EXTENSIONS else "unknown"
    if fmt == "aac" and ext in ("m4a", "mp4") and bitrate >= ALAC_MIN_KBPS:
        fmt = "alac"
    return AudioQuality(format=fmt, bitrate=bitrate or None)


def meets_preset(key: str, aq: AudioQuality) -> bool:
    lossless = aq.format in LOSSLESS_FORMATS
    if key == "mp3_320":
        return lossless or (aq.format != "unknown" and (aq.bitrate or 0) >= 320)
    if key == "flac":
        return aq.format == "flac"
    if key == "flac_24":
        return aq.format == "flac" and aq.matches_target(_FLAC_24)
    if key == "lossless":
        return lossless
    return False


def meets_targets(aq: AudioQuality, targets: Iterable[QualityTarget]) -> bool:
    return any(aq.matches_target(t) for t in targets)


def count(groups: List[tuple], predicate) -> Tuple[int, int]:
    """(tracks meeting ``predicate(AudioQuality)``, all tracks)."""
    meeting = total = 0
    for ext, br, n in groups:
        total += n
        if predicate(audio_quality(ext, br)):
            meeting += n
    return meeting, total


# ── the current target ────────────────────────────────────────────────────────

def _bar_targets(targets: List[QualityTarget], policy: str, cutoff: int) -> List[QualityTarget]:
    """The targets a track must reach to count as meeting the profile: all of
    them, or down to the cutoff when the profile upgrades until a cutoff (the
    same bar core/quality/upgrades.py applies)."""
    if policy in _UNTIL_CUTOFF and targets:
        return targets[:max(0, min(cutoff, len(targets) - 1)) + 1]
    return targets


def preset_for(targets: List[QualityTarget]) -> Optional[str]:
    """Which preset a profile's acceptable targets amount to, if any."""
    if not targets:
        return None
    formats = {(t.format or "").lower() for t in targets}
    if formats == {"flac"}:
        return "flac_24" if all((t.bit_depth or 0) >= 24 for t in targets) else "flac"
    if formats <= set(LOSSLESS_FORMATS) and len(formats) > 1:
        return "lossless"
    lowest = targets[-1]
    if (lowest.format or "").lower() == "mp3" and lowest.min_bitrate == 320 and all(
            (t.format or "").lower() in LOSSLESS_FORMATS or (t.min_bitrate or 0) >= 320 for t in targets):
        return "mp3_320"
    return None


def target_name(targets: List[QualityTarget]) -> str:
    preset = preset_for(targets)
    if preset:
        return next(p["target_name"] for p in PRESETS if p["key"] == preset)
    if not targets:
        return "Any quality"
    lowest = targets[-1]
    fmt = (lowest.format or "").upper()
    if fmt and lowest.min_bitrate:
        return f"{fmt} {lowest.min_bitrate} or better"
    if fmt == "FLAC" and (lowest.bit_depth or 0) >= 24:
        return "FLAC 24-bit or better"
    return f"{fmt or lowest.label or 'Any quality'} or better"


def current_target(database) -> Dict[str, Any]:
    """The default quality profile as a target: its acceptable targets, the
    preset they match, a name for the UI and when the profile was last saved."""
    from core.activity.common import parse_utc
    row = None
    try:
        with closing(database._get_connection()) as conn:
            row = conn.execute(
                "SELECT id, name, ranked_targets, upgrade_policy, upgrade_cutoff_index, updated_at "
                "FROM quality_profiles WHERE is_default = 1 ORDER BY id LIMIT 1").fetchone()
    except Exception:  # noqa: BLE001 - no table yet: fall back below
        row = None
    if row is not None:
        try:
            raw = json.loads(row["ranked_targets"] or "[]")
        except (TypeError, ValueError):
            raw = []
        profile = {"id": row["id"], "name": row["name"], "ranked_targets": raw,
                   "upgrade_policy": row["upgrade_policy"], "upgrade_cutoff_index": row["upgrade_cutoff_index"]}
        updated_at = parse_utc(row["updated_at"])
    else:
        profile = database.get_quality_profile() or {}
        updated_at = None
    from core.quality.selection import targets_from_profile
    targets, _fallback = targets_from_profile(profile)
    try:
        cutoff = int(profile.get("upgrade_cutoff_index") or 0)
    except (TypeError, ValueError):
        cutoff = 0
    bar = _bar_targets(targets, profile.get("upgrade_policy") or "acceptable", cutoff)
    return {
        "quality_profile_id": profile.get("id"),
        "quality_profile_name": profile.get("name"),
        "preset": preset_for(bar),
        "name": target_name(bar),
        "targets": bar,
        "updated_at": updated_at,
    }


def preset_counts(database) -> Dict[str, Any]:
    """The dialog's numbers: each preset's tracks meeting it, out of the
    library, plus the current target."""
    groups = library_quality_groups(database)
    total = sum(n for _e, _b, n in groups)
    unknown = sum(n for e, _b, n in groups if audio_quality(e, _b).format == "unknown")
    presets = []
    for p in PRESETS:
        meeting, _ = count(groups, lambda aq, k=p["key"]: meets_preset(k, aq))
        presets.append({"key": p["key"], "name": p["name"], "meeting": meeting, "total": total,
                        "estimated": p["estimated"]})
    current = current_target(database)
    current.pop("targets", None)
    return {"total": total, "unknown_format": unknown, "presets": presets, "current": current}


# ── one artist's albums against the target ──────────────────────────────────

_FORMAT_NAMES = {"flac": "FLAC", "alac": "ALAC", "wav": "WAV", "dsf": "DSD", "mp3": "MP3",
                 "aac": "AAC", "ogg": "OGG", "opus": "Opus", "wma": "WMA"}


def quality_label(aq: AudioQuality) -> str:
    """What a file is, the way the artist page's cards say it: "FLAC",
    "MP3 320", "AAC 256". Lossless formats leave the bitrate out."""
    name = _FORMAT_NAMES.get(aq.format)
    if not name:
        return "Unknown format"
    if aq.format in LOSSLESS_FORMATS or not aq.bitrate:
        return name
    return f"{name} {aq.bitrate}"


def artist_album_quality(database, artist_id) -> Optional[Dict[str, Any]]:
    """Each of a library artist's albums against the current quality target.

    For the artist page's "Below quality target" tag: per album, how many of
    its tracks with a file are below the default quality profile's bar, judged
    by the same extension + stored bitrate rules as ``preset_counts`` (no file
    reads), plus the formats it holds, most tracks first. Albums are the
    artist's own rows (``albums.artist_id``) in the caller's library scope;
    tracks without a file are left out. ``None`` when the artist isn't in the
    library.
    """
    scope_sql, scope_params = database._current_scope_sql("t.owner_profile_id")
    with closing(database._get_connection()) as conn:
        artist = conn.execute("SELECT id FROM artists WHERE id = ?", (artist_id,)).fetchone()
        if artist is None:
            return None
        rows = conn.execute(
            f"SELECT al.id AS album_id, al.title AS title, {_EXT_SQL.replace('file_path', 't.file_path')} AS ext, "
            f"COALESCE(t.bitrate, 0) AS br, COUNT(*) AS n FROM albums al "
            f"JOIN tracks t ON t.album_id = al.id "
            f"WHERE al.artist_id = ? AND t.file_path IS NOT NULL AND t.file_path != '' AND {scope_sql} "
            f"GROUP BY al.id, ext, br ORDER BY al.id",
            [artist["id"], *scope_params]).fetchall()
    current = current_target(database)
    targets = current.pop("targets", [])
    albums: Dict[Any, Dict[str, Any]] = {}
    for row in rows:
        album = albums.setdefault(row["album_id"], {
            "id": row["album_id"], "title": row["title"] or "", "tracks": 0, "below_target": 0,
            "_formats": {}})
        aq = audio_quality(row["ext"] or "", int(row["br"] or 0))
        n = int(row["n"])
        album["tracks"] += n
        # a profile with no targets imposes nothing, so nothing is below it
        if targets and not meets_targets(aq, targets):
            album["below_target"] += n
        label = quality_label(aq)
        album["_formats"][label] = album["_formats"].get(label, 0) + n
    out = []
    for album in albums.values():
        formats = album.pop("_formats")
        album["formats"] = [label for label, _n in sorted(formats.items(), key=lambda kv: (-kv[1], kv[0]))]
        out.append(album)
    return {
        "artist_id": artist["id"],
        "target": {k: current.get(k) for k in ("name", "preset", "quality_profile_id", "quality_profile_name")},
        "tracks": sum(a["tracks"] for a in out),
        "below_target": sum(a["below_target"] for a in out),
        "albums": out,
    }


__all__ = ["PRESETS", "CACHE_TTL_SECONDS", "clear_cache", "library_quality_groups", "audio_quality",
           "meets_preset", "meets_targets", "count", "preset_for", "target_name", "current_target",
           "preset_counts", "quality_label", "artist_album_quality"]
