"""What the player's readout says about a library file (GET /api/library/tracks/<id>/details).

"FLAC 24/96 · 2,304 kbps" needs the format, the bitrate, the bit depth and the
sample rate. The library already stores the bitrate (the scan writes it); bit
depth and sample rate are read from the file with mutagen the first time the
player asks, and kept on the track row with the file's signature, so the next
ask (and anyone else's) is a plain row read until the file is replaced.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

from core.playback.peaks import file_signature
from utils.logging_config import get_logger

logger = get_logger("playback.audio_details")

# the columns the readout keeps on tracks (MusicDatabase migration)
TRACK_COLUMNS = (
    ("bit_depth", "INTEGER"),
    ("sample_rate", "INTEGER"),
    # "<size>:<mtime_ns>" of the file the two above were read from
    ("audio_probe_sig", "TEXT"),
)

FORMAT_NAMES = {
    "flac": "FLAC", "alac": "ALAC", "wav": "WAV", "aiff": "AIFF", "dsf": "DSD", "mp3": "MP3",
    "aac": "AAC", "ogg": "OGG", "opus": "Opus", "wma": "WMA", "ape": "APE", "wv": "WavPack",
}

_EXTENSION_FORMATS = {
    ".flac": "flac", ".mp3": "mp3", ".m4a": "aac", ".mp4": "aac", ".aac": "aac", ".alac": "alac",
    ".ogg": "ogg", ".oga": "ogg", ".opus": "opus", ".wav": "wav", ".wave": "wav", ".aif": "aiff",
    ".aiff": "aiff", ".aifc": "aiff", ".wma": "wma", ".ape": "ape", ".wv": "wv", ".dsf": "dsf",
    ".dff": "dsf",
}


def ensure_track_columns(cursor) -> None:
    """Add the readout's columns to tracks when they're missing."""
    cursor.execute("PRAGMA table_info(tracks)")
    have = {row[1] for row in cursor.fetchall()}
    for name, kind in TRACK_COLUMNS:
        if name not in have:
            cursor.execute(f"ALTER TABLE tracks ADD COLUMN {name} {kind}")
            logger.info("Added %s column to tracks table", name)


def format_key(path: Optional[str]) -> Optional[str]:
    """flac / mp3 / aac / ... from the extension, None when it isn't audio."""
    if not path:
        return None
    return _EXTENSION_FORMATS.get(os.path.splitext(str(path))[1].lower())


def probe(path: str) -> Dict[str, Any]:
    """Read the stream's facts with mutagen: format, bit depth (lossless only),
    sample rate, bitrate in kbps, length. Missing facts are None; a file
    mutagen can't open gives all None and never raises."""
    out: Dict[str, Any] = {"format": format_key(path), "bit_depth": None, "sample_rate": None,
                           "bitrate_kbps": None, "duration_s": None}
    try:
        from mutagen import File as MutagenFile

        audio = MutagenFile(path)
    except Exception as exc:  # noqa: BLE001 - an unreadable file just has no facts
        logger.debug("mutagen couldn't open %s: %s", path, exc)
        return out
    info = getattr(audio, "info", None) if audio is not None else None
    if info is None:
        return out
    lossless = False
    try:
        from core.imports.file_integrity import is_lossless_audio

        lossless = bool(is_lossless_audio(audio))
    except Exception:  # noqa: BLE001
        lossless = False
    if type(audio).__name__ == "MP4":
        codec = str(getattr(info, "codec", "") or "").lower()
        out["format"] = "alac" if codec.startswith("alac") else "aac"
    elif type(audio).__name__ == "DSF":
        lossless = True
    rate = getattr(info, "sample_rate", None)
    out["sample_rate"] = int(rate) if isinstance(rate, (int, float)) and rate > 0 else None
    bits = getattr(info, "bits_per_sample", None)
    # an AAC .m4a reports 16 bits like ALAC does; only lossless has a bit depth
    if lossless and isinstance(bits, (int, float)) and bits > 0:
        out["bit_depth"] = int(bits)
    bitrate = getattr(info, "bitrate", None)
    if isinstance(bitrate, (int, float)) and bitrate > 0:
        out["bitrate_kbps"] = int(round(bitrate / 1000))
    length = getattr(info, "length", None)
    if isinstance(length, (int, float)) and length > 0:
        out["duration_s"] = round(float(length), 3)
    return out


def format_label(key: Optional[str]) -> Optional[str]:
    return FORMAT_NAMES.get(key or "") if key else None


def track_row(db, track_id: str) -> Optional[Dict[str, Any]]:
    """The track, its album and artist, in the caller's library scope (a
    track in another profile's own library is None, like an unknown id)."""
    scope_sql, scope_params = db._current_scope_sql("t.owner_profile_id")
    conn = db._get_connection()
    try:
        cols = {row[1] for row in conn.execute("PRAGMA table_info(tracks)").fetchall()}
        probed = ", ".join(
            f"t.{name}" if name in cols else f"NULL AS {name}" for name, _ in TRACK_COLUMNS)
        disc = "t.disc_number" if "disc_number" in cols else "NULL AS disc_number"
        owner = "t.owner_profile_id" if "owner_profile_id" in cols else "NULL AS owner_profile_id"
        row = conn.execute(
            f"""
            SELECT t.id, t.title, t.file_path, t.bitrate, t.duration, t.track_number, {disc},
                   t.album_id, t.artist_id, {owner}, {probed},
                   al.title AS album_title, al.year AS album_year, al.thumb_url AS album_thumb,
                   ar.name AS artist_name,
                   COALESCE(NULLIF(al.track_count, 0),
                            (SELECT COUNT(*) FROM tracks t2 WHERE t2.album_id = t.album_id)) AS album_track_count
            FROM tracks t
            LEFT JOIN albums al ON al.id = t.album_id
            LEFT JOIN artists ar ON ar.id = t.artist_id
            WHERE t.id = ? AND {scope_sql}
            """,
            [str(track_id), *scope_params],
        ).fetchone()
    finally:
        conn.close()
    return dict(row) if row is not None else None


def _remember(db, track_id: str, facts: Dict[str, Any], sig: str) -> None:
    conn = db._get_connection()
    try:
        conn.execute(
            "UPDATE tracks SET bit_depth = ?, sample_rate = ?, audio_probe_sig = ? WHERE id = ?",
            (facts.get("bit_depth"), facts.get("sample_rate"), sig, str(track_id)),
        )
        conn.commit()
    except Exception as exc:  # noqa: BLE001 - the readout works without the memo
        logger.debug("couldn't keep audio facts for track %s: %s", track_id, exc)
    finally:
        conn.close()


def details_for(db, row: Dict[str, Any], path: Optional[str], *,
                streamed_from: Optional[str] = None) -> Dict[str, Any]:
    """The readout for one track row. ``path`` is the file on this machine
    (None when it isn't here); ``streamed_from`` names the media server the
    player streams it from in that case ("Navidrome")."""
    track_id = str(row.get("id"))
    key = format_key(path or row.get("file_path"))
    bitrate = row.get("bitrate")
    bit_depth = row.get("bit_depth")
    sample_rate = row.get("sample_rate")
    duration_ms = row.get("duration")
    duration_s = round(duration_ms / 1000, 3) if isinstance(duration_ms, (int, float)) and duration_ms else None

    on_disk = bool(path and os.path.isfile(path))
    if on_disk:
        sig = file_signature(path)
        if sig and sig != row.get("audio_probe_sig"):
            facts = probe(path)
            bit_depth, sample_rate = facts.get("bit_depth"), facts.get("sample_rate")
            key = facts.get("format") or key
            if not bitrate and facts.get("bitrate_kbps"):
                bitrate = facts["bitrate_kbps"]
            if not duration_s and facts.get("duration_s"):
                duration_s = facts["duration_s"]
            _remember(db, track_id, facts, sig)
        elif key == "aac" and bit_depth:
            # remembered from an earlier probe that read it as ALAC
            key = "alac"

    if on_disk:
        path_label = "Library"
    elif streamed_from:
        path_label = f"Library (streamed from {streamed_from})"
    else:
        path_label = "Library"

    return {
        "track_id": track_id,
        "format": format_label(key),
        "format_key": key,
        "bitrate_kbps": int(bitrate) if isinstance(bitrate, (int, float)) and bitrate > 0 else None,
        "bit_depth": int(bit_depth) if bit_depth else None,
        "sample_rate": int(sample_rate) if sample_rate else None,
        "duration_s": duration_s,
        "path_label": path_label,
        "on_disk": on_disk,
        "title": row.get("title"),
        "artist": row.get("artist_name"),
        "artist_id": row.get("artist_id"),
        "album": row.get("album_title"),
        "album_id": row.get("album_id"),
        "year": row.get("album_year"),
        "track_number": row.get("track_number"),
        "disc_number": row.get("disc_number"),
        "album_track_count": row.get("album_track_count"),
    }


__all__ = ["TRACK_COLUMNS", "FORMAT_NAMES", "ensure_track_columns", "format_key", "probe",
           "format_label", "track_row", "details_for"]
