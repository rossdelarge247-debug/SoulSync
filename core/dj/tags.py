"""BPM and key in the files' own tags, the forms DJ software reads.

=========  ==========================  ==================================
Format     BPM                         Key
=========  ==========================  ==================================
MP3 (ID3)  ``TBPM`` (whole number)     ``TKEY`` ("Am", "F#", "Ebm")
FLAC/Ogg   ``BPM`` (whole number)      ``INITIALKEY`` ("Am")
MP4/M4A    ``tmpo`` (integer atom)     ``----:com.apple.iTunes:initialkey``
=========  ==========================  ==================================

These are the frames SYNCHRO.S's own enrichment already writes (Beatport's
key, Deezer's BPM in core/metadata/source.py), so a file never carries two
spellings. The key is written in the short musical form, which Traktor Pro 3,
Rekordbox, Serato and Mixxx all read; a Camelot "8A" in TKEY is read by some
and shown raw by others, so it is never written. BPM is a whole number
because ID3's TBPM is defined as one.

Writing only fills a gap: a value already in the file stays unless the
person turned on ``library.dj_overwrite_tags``. Saves go through
``core.metadata.common.save_audio_file`` (temp copy, audio checked
byte-for-byte or structurally, atomic replace), like every other tag write.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

from utils.logging_config import get_logger

logger = get_logger("dj.tags")

SUPPORTED = {".mp3", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".mp4"}
MP4_KEY = "----:com.apple.iTunes:initialkey"


def _symbols():
    from mutagen import File as MutagenFile
    from mutagen.flac import FLAC
    from mutagen.id3 import ID3
    from mutagen.mp4 import MP4

    return MutagenFile, FLAC, ID3, MP4


def _first_text(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", "ignore")
    text = str(getattr(value, "text", [value])[0] if hasattr(value, "text") else value).strip()
    return text or None


def _parse_bpm(text) -> Optional[float]:
    try:
        value = float(str(text).strip().replace(",", "."))
    except (TypeError, ValueError):
        return None
    return value if 20 <= value <= 400 else None


def read_dj_tags(path: str) -> Dict[str, Any]:
    """``{"bpm": float | None, "key": str | None, "format": "id3" | "vorbis" | "mp4" | None}``
    from the file's tags. Never raises: an unreadable file reads as empty."""
    out: Dict[str, Any] = {"bpm": None, "key": None, "format": None}
    if not path or os.path.splitext(path)[1].lower() not in SUPPORTED or not os.path.isfile(path):
        return out
    try:
        MutagenFile, _FLAC, ID3, MP4 = _symbols()
        audio = MutagenFile(path)
        if audio is None:
            return out
        tags = audio.tags
        if isinstance(tags, ID3):
            out["format"] = "id3"
            frame = tags.get("TBPM")
            out["bpm"] = _parse_bpm(frame.text[0]) if frame is not None and frame.text else None
            frame = tags.get("TKEY")
            out["key"] = (str(frame.text[0]).strip() or None) if frame is not None and frame.text else None
        elif isinstance(audio, MP4):
            out["format"] = "mp4"
            tmpo = (tags or {}).get("tmpo")
            out["bpm"] = _parse_bpm(tmpo[0]) if tmpo else None
            for name in (MP4_KEY, "----:com.apple.iTunes:KEY", "----:com.apple.iTunes:INITIALKEY"):
                key = _first_text((tags or {}).get(name))
                if key:
                    out["key"] = key
                    break
        elif tags is not None and hasattr(tags, "keys"):
            out["format"] = "vorbis"
            lower = {str(k).lower(): k for k in tags.keys()}
            if "bpm" in lower:
                out["bpm"] = _parse_bpm(_first_text(tags[lower["bpm"]]))
            for name in ("initialkey", "key"):
                if name in lower:
                    key = _first_text(tags[lower[name]])
                    if key:
                        out["key"] = key
                        break
    except Exception as exc:  # noqa: BLE001 - a broken tag is no tag
        logger.debug("couldn't read DJ tags of %s: %s", path, exc)
    return out


def write_dj_tags(path: str, *, bpm: Optional[float] = None, key_name: Optional[str] = None,
                  overwrite: bool = False) -> Dict[str, Any]:
    """Write BPM and/or key into ``path`` where the file has none (or always,
    with ``overwrite``). ``{"written": ["bpm", "key"], "error": None}``; an
    empty list when there was nothing to fill. Never raises."""
    result: Dict[str, Any] = {"written": [], "error": None}
    if not path or os.path.splitext(path)[1].lower() not in SUPPORTED or not os.path.isfile(path):
        result["error"] = "unsupported or missing file"
        return result
    try:
        from types import SimpleNamespace

        from core.metadata.common import save_audio_file

        MutagenFile, FLAC, ID3, MP4 = _symbols()
        current = read_dj_tags(path)
        want_bpm = bpm is not None and float(bpm) > 0 and (overwrite or current["bpm"] is None)
        want_key = bool(key_name) and (overwrite or not current["key"])
        if not want_bpm and not want_key:
            return result
        audio = MutagenFile(path)
        if audio is None:
            result["error"] = "mutagen couldn't open the file"
            return result
        if audio.tags is None and hasattr(audio, "add_tags"):
            audio.add_tags()
        bpm_text = str(int(round(float(bpm)))) if want_bpm else None
        if isinstance(audio.tags, ID3):
            from mutagen.id3 import TBPM, TKEY

            if want_bpm:
                audio.tags.delall("TBPM")
                audio.tags.add(TBPM(encoding=3, text=[bpm_text]))
            if want_key:
                audio.tags.delall("TKEY")
                audio.tags.add(TKEY(encoding=3, text=[key_name]))
        elif isinstance(audio, MP4):
            from mutagen.mp4 import MP4FreeForm

            if want_bpm:
                audio["tmpo"] = [int(bpm_text)]
            if want_key:
                audio[MP4_KEY] = [MP4FreeForm(str(key_name).encode("utf-8"))]
        else:
            if want_bpm:
                audio["BPM"] = [bpm_text]
            if want_key:
                audio["INITIALKEY"] = [key_name]
        if not save_audio_file(audio, SimpleNamespace(ID3=ID3, FLAC=FLAC, File=MutagenFile)):
            result["error"] = "the write would have changed the audio, so the file was left as it was"
            return result
        result["written"] = [name for name, wanted in (("bpm", want_bpm), ("key", want_key)) if wanted]
    except PermissionError:
        result["error"] = "permission denied"
    except Exception as exc:  # noqa: BLE001 - one file never stops the job
        logger.warning("couldn't write BPM and key into %s: %s", path, exc)
        result["error"] = str(exc)[:300]
    return result


__all__ = ["MP4_KEY", "SUPPORTED", "read_dj_tags", "write_dj_tags"]
