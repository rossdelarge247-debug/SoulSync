"""What the checks can say about a file before it's quarantined, or after.

A length mismatch against Spotify's listing is the integrity check's commonest
failure and usually not a broken download. Before such a file is held, two
more things are measured so the review can say what it is:

* **Does it play to the end?** The decoded length (ffmpeg) against the length
  the file's header declares. A truncated transfer stops early; a different
  edit plays its whole (different) length.
* **Is it the right song?** AcoustID, when it's configured and usable.

The file is still quarantined (Ross's Q10: a confirmed, complete file with a
different length is held, marked "Right song, different edit", Keep
recommended). These facts go in the sidecar's ``facts``
(core.imports.quarantine_verdict reads them). The AcoustID re-check of what's
already held (core.imports.quarantine_recheck) writes the same facts.

Nothing here raises: a measurement that can't run is left out.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Callable, Dict, Optional

from utils.logging_config import get_logger

logger = get_logger("imports.quarantine_facts")


def plays_to_end(header_s: Any, decoded_s: Any) -> Optional[bool]:
    """True when the decoded audio runs to the length the header declares
    (within 3%, at least 2 s); None when either is unknown."""
    try:
        header, decoded = float(header_s or 0), float(decoded_s or 0)
    except (TypeError, ValueError):
        return None
    if header <= 0 or decoded <= 0:
        return None
    return decoded >= header - max(2.0, header * 0.03)


def audio_facts(file_path: str, *, decode: bool = True,
                probe: Optional[Callable[[str], float]] = None) -> Dict[str, Any]:
    """Quality, size, the header's length and (``decode``) the decoded
    length and whether it plays to the end."""
    import os

    facts: Dict[str, Any] = {}
    try:
        facts["size_bytes"] = os.path.getsize(file_path)
    except OSError:
        return facts
    header_s = None
    try:
        from mutagen import File as MutagenFile
        audio = MutagenFile(file_path)
        info = getattr(audio, "info", None)
        if info is not None:
            header_s = float(getattr(info, "length", 0) or 0) or None
            bitrate = int(getattr(info, "bitrate", 0) or 0)
            if bitrate:
                facts["bitrate_kbps"] = int(round(bitrate / 1000))
            from core.imports.file_integrity import is_lossless_audio
            facts["lossless"] = bool(is_lossless_audio(audio))
    except Exception as exc:  # noqa: BLE001 - unreadable: the size is all we know
        logger.debug("audio facts: mutagen failed for %s: %s", file_path, exc)
    if header_s:
        facts["actual_s"] = round(header_s, 1)
    try:
        from core.imports.file_ops import get_audio_quality_string
        quality = get_audio_quality_string(file_path)
        if quality:
            facts["quality"] = quality
    except Exception as exc:  # noqa: BLE001
        logger.debug("audio facts: quality failed for %s: %s", file_path, exc)
    if decode and header_s:
        if probe is None:
            from core.imports.file_integrity import probe_decoded_duration as probe
        decoded = probe(file_path) or 0.0
        if decoded > 0:
            facts["decoded_s"] = round(decoded, 1)
            facts["plays_to_end"] = plays_to_end(header_s, decoded)
    return facts


def acoustid_expected(context: Dict[str, Any]) -> tuple:
    """(title, artist, expected_s) the AcoustID check compares against: the
    same reading as the pipeline's own AcoustID step."""
    from core.imports.context import (
        extract_artist_name,
        get_import_clean_artist,
        get_import_clean_title,
        get_import_context_artist,
        get_import_original_search,
        get_import_track_info,
        normalize_import_context,
    )
    context = normalize_import_context(context)
    track_info = get_import_track_info(context)
    original_search = get_import_original_search(context)
    title = get_import_clean_title(context, default=original_search.get("title", ""))
    artist = ""
    artists = track_info.get("artists", [])
    if artists:
        first = artists[0]
        artist = first.get("name", "") if isinstance(first, dict) else (
            first if isinstance(first, str) else "")
    if not artist:
        artist = (extract_artist_name(get_import_context_artist(context))
                  or get_import_clean_artist(context, default=""))
    try:
        expected_s = (int(track_info.get("duration_ms") or 0) / 1000.0) or None
    except (TypeError, ValueError):
        expected_s = None
    return title, artist, expected_s


def acoustid_facts(file_path: str, title: str, artist: str, expected_s: Optional[float], *,
                   verifier: Any = None) -> Optional[Dict[str, Any]]:
    """AcoustID's answer as facts: ``decision`` (pass / fail / skip / error),
    ``score``, the recording it heard (``title``/``artist``) when it isn't the
    expected one, and ``invalid_key`` when the key was refused. None when
    AcoustID isn't usable here or there's nothing to compare against."""
    if not (title and artist):
        return None
    try:
        if verifier is None:
            from core.acoustid_verification import AcoustIDVerification
            verifier = AcoustIDVerification()
        available, _why = verifier.quick_check_available()
        if not available:
            return None
        probe: Dict[str, Any] = {}
        result, message = verifier.verify_audio_file(
            file_path, title, artist, probe, expected_duration_s=expected_s)
    except Exception as exc:  # noqa: BLE001 - no answer is not a verdict
        logger.debug("acoustid facts failed for %s: %s", file_path, exc)
        return None
    decision = getattr(result, "value", str(result))
    out: Dict[str, Any] = {"decision": decision, "message": str(message or "")[:300],
                           "checked_at": datetime.now().isoformat(timespec="seconds")}
    score = probe.get("_acoustid_best_score")
    if isinstance(score, (int, float)):
        out["score"] = round(float(score), 3)
    outcome = probe.get("_acoustid_decision")
    if decision == "fail" and outcome is not None:
        heard_title = str(getattr(outcome, "matched_title", "") or "")
        if heard_title and heard_title != "?":
            out["title"] = heard_title
            out["artist"] = str(getattr(outcome, "matched_artist", "") or "")
    if probe.get("_acoustid_invalid_key"):
        out["invalid_key"] = True
    return out


def integrity_facts(checks: Dict[str, Any], expected_ms: Any = None) -> Dict[str, Any]:
    """The integrity check's own measurements as facts (no file access)."""
    facts: Dict[str, Any] = {}
    if checks.get("size_bytes") is not None:
        facts["size_bytes"] = checks["size_bytes"]
    if checks.get("actual_length_s"):
        facts["actual_s"] = round(float(checks["actual_length_s"]), 1)
    if checks.get("expected_length_s"):
        facts["expected_s"] = round(float(checks["expected_length_s"]), 1)
    elif expected_ms:
        try:
            facts["expected_s"] = round(int(expected_ms) / 1000.0, 1)
        except (TypeError, ValueError):
            pass
    if checks.get("decoded_length_s"):
        facts["decoded_s"] = round(float(checks["decoded_length_s"]), 1)
    if checks.get("length_check") == "mismatch":
        facts["check"] = "duration"
    return facts


def duration_failure_facts(file_path: str, checks: Dict[str, Any], context: Dict[str, Any],
                           expected_ms: Any = None, *, verifier: Any = None,
                           probe: Optional[Callable[[str], float]] = None) -> Dict[str, Any]:
    """For a file whose only failed check is its length: does it play to the
    end, and is it the right song (AcoustID). Then it's quarantined anyway."""
    facts = integrity_facts(checks, expected_ms)
    facts.update(audio_facts(file_path, probe=probe))
    facts["check"] = "duration"
    try:
        title, artist, expected_s = acoustid_expected(context)
    except Exception as exc:  # noqa: BLE001
        logger.debug("acoustid expected track unreadable: %s", exc)
        title = artist = ""
        expected_s = None
    answer = acoustid_facts(file_path, title, artist, expected_s or facts.get("expected_s"),
                            verifier=verifier)
    if answer is not None:
        facts["acoustid"] = answer
        if answer.get("invalid_key"):
            try:
                from core.imports.quarantine_recheck import note_key_refused
                note_key_refused()
            except Exception as exc:  # noqa: BLE001
                logger.debug("couldn't note the refused AcoustID key: %s", exc)
    return facts


__all__ = ["acoustid_expected", "acoustid_facts", "audio_facts", "duration_failure_facts",
           "integrity_facts", "plays_to_end"]
