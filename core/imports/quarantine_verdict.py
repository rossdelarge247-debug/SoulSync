"""What a quarantined download is, in one verdict and one plain sentence.

Most of what lands in quarantine isn't broken: on Ross's install 93% of 2,568
files were held by the integrity check's length leg ("Duration mismatch"),
which compares the file with the length Spotify lists. A different master, a
fade, an extended mix or a radio edit all trip it. The review list only said
"Failed integrity check", so there was nothing to decide with.

Every entry gets one verdict here, from its sidecar alone (no filesystem
access, so the quarantine snapshot can carry it):

* ``right_song``: AcoustID confirmed it, or it plays to the end (or hasn't
  been checked yet) and is within 20% of Spotify's length.
* ``longer_version``: over 20% longer: usually an extended or original mix.
* ``shorter_or_cut``: half to four-fifths of the length: a radio edit, or cut.
* ``cut_off``: under half the length, or it stops before its header says.
* ``broken``: too small to be audio, or unreadable.
* ``different_song``: AcoustID identified another recording.
* ``other``: everything else (a damaged lossless file, a replacement shorter
  than the library copy, a quality rule).

``best`` is chosen per song (``choose_best``): among the tries that are
``right_song`` or ``longer_version`` and don't stop early, AcoustID-confirmed
first, then the higher quality (lossless over any bitrate), then the closest
length.

Structured facts (the sidecar's ``facts``, written by the pipeline and the
AcoustID re-check) win; older sidecars are read from their reason text.
"""

from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

KINDS = ("right_song", "longer_version", "shorter_or_cut", "cut_off", "broken",
         "different_song", "other")
#: the kinds "Keep the best of each" offers, and that can be a song's best
KEEP_KINDS = ("right_song", "longer_version")
#: the kinds "Delete all" offers
DELETE_KINDS = ("cut_off", "broken")

#: what a verdict tag says
LABELS = {
    "best": "Best",
    "right_song": "Right song",
    "longer_version": "Longer version",
    "shorter_or_cut": "Shorter",
    "cut_off": "Cut off",
    "broken": "Broken",
    "different_song": "Different song",
    "other": "Other",
}

_NUM = r"(\d+(?:\.\d+)?)"
_DURATION = re.compile(rf"Duration mismatch: file is {_NUM}s, expected {_NUM}s", re.I)
_DECODED = re.compile(rf"Decoded audio is only {_NUM}s of an expected {_NUM}s", re.I)
_TOO_SMALL = re.compile(r"File too small \((\d+) bytes", re.I)
_IDENTIFIED = re.compile(
    r"file identified as '(?P<title>.*?)' by '(?P<artist>.*?)', expected", re.I)
_MISMATCH_ARTIST = re.compile(
    r"Audio mismatch: '(?P<title>.*?)' by '(?P<artist>.*?)' .{0,3}expected artist not found", re.I)
_VERSION = re.compile(r"Version mismatch: expected \((?P<want>[^)]*)\) but file is \((?P<got>[^)]*)\)",
                      re.I)
_UNREADABLE = ("mutagen could not parse", "could not identify file format",
               "no audio info block")


def fmt_len(seconds: Any) -> str:
    """m:ss (h:mm:ss past an hour); '' when unknown."""
    try:
        total = int(round(float(seconds)))
    except (TypeError, ValueError):
        return ""
    if total < 0:
        return ""
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def _num(value: Any) -> Optional[float]:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out and out >= 0 else None  # not NaN


def _expected_from_context(sidecar: Dict[str, Any]) -> Optional[float]:
    ctx = sidecar.get("context") if isinstance(sidecar.get("context"), dict) else {}
    ti = ctx.get("track_info") if isinstance(ctx.get("track_info"), dict) else {}
    ms = _num(ti.get("duration_ms"))
    return ms / 1000.0 if ms else None


def facts_from(sidecar: Dict[str, Any], size_bytes: Optional[int] = None) -> Dict[str, Any]:
    """The facts about one entry: its sidecar's ``facts`` where it has them,
    read from its reason text where it doesn't."""
    stored = sidecar.get("facts") if isinstance(sidecar.get("facts"), dict) else {}
    reason = str(sidecar.get("quarantine_reason") or "")
    facts: Dict[str, Any] = {
        "check": None, "expected_s": None, "actual_s": None, "decoded_s": None,
        "plays_to_end": None, "acoustid": None, "quality": "", "lossless": None,
        "bitrate_kbps": None, "size_bytes": size_bytes,
    }
    low = reason.lower()
    m = _DURATION.search(reason)
    if m:
        facts.update(check="duration", actual_s=float(m.group(1)), expected_s=float(m.group(2)))
    elif (m := _DECODED.search(reason)):
        facts.update(check="decoded_short", actual_s=float(m.group(1)),
                     expected_s=float(m.group(2)), plays_to_end=False)
    elif (m := _TOO_SMALL.search(reason)):
        facts.update(check="too_small", size_bytes=int(m.group(1)))
    elif any(text in low for text in _UNREADABLE):
        facts["check"] = "unreadable"
    elif "cannot stat file" in low:
        # the disk said no when it was checked: says nothing about the file
        facts["check"] = "stat"
    elif "lossless file holds only" in low:
        facts["check"] = "density"
    elif "flac decode test failed" in low:
        facts["check"] = "decode"
    elif "replacement guard" in low:
        facts["check"] = "replacement"
    elif (m := _IDENTIFIED.search(reason)) or (m := _MISMATCH_ARTIST.search(reason)):
        facts.update(check="acoustid", acoustid={
            "decision": "fail", "title": m.group("title"), "artist": m.group("artist")})
    elif (m := _VERSION.search(reason)):
        facts.update(check="version", acoustid={
            "decision": "fail", "version": m.group("got"), "wanted_version": m.group("want")})
    if facts["expected_s"] is None:
        facts["expected_s"] = _expected_from_context(sidecar)
    ctx = sidecar.get("context") if isinstance(sidecar.get("context"), dict) else {}
    if isinstance(ctx.get("_audio_quality"), str) and ctx.get("_audio_quality"):
        facts["quality"] = ctx["_audio_quality"]
    # the stored facts win
    for key, value in stored.items():
        if value is not None and value != "":
            facts[key] = value
    return facts


def _ratio(facts: Dict[str, Any]) -> Optional[float]:
    actual, expected = _num(facts.get("actual_s")), _num(facts.get("expected_s"))
    if actual is None or not expected:
        return None
    return actual / expected


def _ends(facts: Dict[str, Any]) -> str:
    if facts.get("plays_to_end") is True:
        return " Plays to the end."
    if facts.get("plays_to_end") is None:
        return " Not checked yet whether it plays to the end."
    return ""


def _diff_words(facts: Dict[str, Any]) -> str:
    actual, expected = _num(facts.get("actual_s")), _num(facts.get("expected_s"))
    if actual is None or expected is None:
        return ""
    gap = actual - expected
    if abs(gap) < 1:
        return "the same length as Spotify's"
    span = fmt_len(abs(gap)) if abs(gap) >= 60 else f"{int(round(abs(gap)))} s"
    return f"{span} {'longer' if gap > 0 else 'shorter'} than Spotify's length"


def classify(sidecar: Dict[str, Any], *, size_bytes: Optional[int] = None,
             trigger: Optional[str] = None,
             facts: Optional[Dict[str, Any]] = None) -> Tuple[str, str]:
    """(kind, sentence) for one entry."""
    facts = facts if facts is not None else facts_from(sidecar, size_bytes)
    trigger = str(trigger if trigger is not None else sidecar.get("trigger") or "")
    check = facts.get("check")
    acoustid = facts.get("acoustid") if isinstance(facts.get("acoustid"), dict) else {}
    decision = str(acoustid.get("decision") or "")
    if str(acoustid.get("title") or "").strip() in ("", "?"):
        acoustid = {k: v for k, v in acoustid.items() if k not in ("title", "artist")}
    ratio = _ratio(facts)
    actual, expected = facts.get("actual_s"), facts.get("expected_s")
    size = facts.get("size_bytes")

    if check in ("too_small", "unreadable"):
        if check == "too_small":
            if not size:
                return "broken", "Empty: 0 bytes, nothing to play."
            kb = max(1, int(round(int(size) / 1024)))
            return "broken", f"Only {kb} KB: too small to be a song."
        return "broken", "It couldn't be read as audio: the file is damaged."

    if decision == "fail" and (acoustid.get("title") or acoustid.get("version")):
        if acoustid.get("version"):
            return ("different_song", f"AcoustID heard the {acoustid['version']} version, "
                    f"not the {acoustid.get('wanted_version') or 'one'} you wanted.")
        who = f" by {acoustid['artist']}" if acoustid.get("artist") else ""
        return "different_song", f"AcoustID identified it as “{acoustid['title']}”{who}: another song."

    if facts.get("plays_to_end") is False:
        if actual and expected and ratio is not None and ratio < 0.5 and check == "decoded_short":
            return "cut_off", f"Only {fmt_len(actual)} of a {fmt_len(expected)} song."
        decoded = facts.get("decoded_s") or actual
        return "cut_off", (f"Stops at {fmt_len(decoded)} though the file says it's longer: cut off."
                           if decoded else "Stops before the end: cut off.")

    if check == "density":
        return "other", ("A lossless file with far too little data for its length: damaged, "
                         "or a preview padded out.")
    if check == "decode":
        return "other", "Damaged lossless audio: some of it doesn't decode."
    if check == "replacement":
        return "other", "Shorter than the copy already in your library, so it wasn't swapped in."
    if check == "stat":
        return "other", "The file couldn't be read from the disk when it was checked."

    # the length bands always apply: AcoustID knowing the song says nothing about
    # whether this file is all of it. A confirmation only upgrades the sentence
    # within a band (and breaks ties for the best try).
    confirmed = decision == "pass"
    if ratio is not None:
        if ratio < 0.5:
            if confirmed:
                return "cut_off", (f"AcoustID recognises the song, but this is only "
                                   f"{fmt_len(actual)} of {fmt_len(expected)}: a clip or cut off.")
            return "cut_off", f"Only {fmt_len(actual)} of a {fmt_len(expected)} song."
        if ratio < 0.8:
            pct = int(round(ratio * 100))
            if confirmed:
                return "shorter_or_cut", (f"AcoustID confirms the song, but it's {pct}% of "
                                          "Spotify's length: a radio edit, or cut off. Listen to "
                                          "the end to tell which.")
            return "shorter_or_cut", (f"{pct}% of Spotify's length: a radio "
                                      "edit, or cut off. Listen to the end to tell which.")
        if confirmed:
            diff = _diff_words(facts)
            lead = "AcoustID confirms it's the right song"
            if ratio > 1.2:
                return "longer_version", (f"{lead}, {diff}: an extended or original mix."
                                          + _ends(facts))
            return "right_song", (f"{lead}" + (f", {diff}." if diff else ".") + _ends(facts))
        if ratio <= 1.2:
            return "right_song", (f"Probably the right song, {_diff_words(facts)}: a different "
                                  "master, fade or intro." + _ends(facts))
        diff = _diff_words(facts)
        return "longer_version", (f"{diff[:1].upper()}{diff[1:]}: probably an extended or "
                                  "original mix." + _ends(facts))

    if confirmed:
        # no lengths to compare: the right song, but never a "best" (choose_best)
        return "right_song", "AcoustID confirms it's the right song." + _ends(facts)

    if trigger == "acoustid_unverified":
        return "other", "AcoustID couldn't confirm it, and “require verified” is on."
    if trigger in ("quality", "bit_depth"):
        return "other", "It didn't meet your quality settings."
    if trigger == "silence":
        return "other", "Long silences or audio that stops early."
    return "other", "Held back by a check that didn't say more."


# ── quality and the best try ──────────────────────────────────────────────

_KBPS = re.compile(r"(\d{2,4})\s*(?:k|kbps)?\b", re.I)


def quality_rank(facts: Dict[str, Any]) -> float:
    """Lossless above any bitrate, then the bitrate (0 when unknown)."""
    label = str(facts.get("quality") or "")
    lossless = facts.get("lossless")
    if lossless is None:
        lossless = bool(re.match(r"(flac|alac|wav|aiff|ape|wv)\b", label, re.I))
    if lossless:
        bits = re.search(r"(\d{2})\s*bit", label, re.I)
        return 10000 + (int(bits.group(1)) if bits else 16)
    kbps = _num(facts.get("bitrate_kbps"))
    if kbps:
        return kbps
    if "vbr" in label.lower():
        return 245.0
    m = _KBPS.search(label)
    return float(m.group(1)) if m else 0.0


def choose_best(tries: Iterable[Dict[str, Any]]) -> Optional[str]:
    """The id of a song's best try, or None. Each try is a dict with ``id``,
    ``kind`` and ``facts``."""
    candidates = []
    for t in tries:
        facts = t.get("facts") or {}
        # eligible: a keep kind, not known to stop early, and at least four
        # fifths of Spotify's length (a confirmed clip is still a clip)
        ratio = _ratio(facts)
        if (t.get("kind") not in KEEP_KINDS or facts.get("plays_to_end") is False
                or ratio is None or ratio < 0.8):
            continue
        acoustid = facts.get("acoustid") if isinstance(facts.get("acoustid"), dict) else {}
        confirmed = acoustid.get("decision") == "pass"
        closeness = abs(ratio - 1.0)
        candidates.append(((0 if confirmed else 1), -quality_rank(facts), closeness,
                           str(t.get("id"))))
    if not candidates:
        return None
    return min(candidates)[3]


def song_summary(tries: List[Dict[str, Any]], best_id: Optional[str]) -> str:
    """One sentence for a song's tries ("Probably the right song in 4 of 6
    tries. Spotify lists it at 6:20.")."""
    n = len(tries)
    if not n:
        return ""
    keep = sum(1 for t in tries if t.get("kind") in KEEP_KINDS)
    expected = next((t["facts"].get("expected_s") for t in tries
                     if (t.get("facts") or {}).get("expected_s")), None)
    tail = f" Spotify lists it at {fmt_len(expected)}." if expected else ""
    if keep == n:
        head = "Probably the right song in every try." if n > 1 else "Probably the right song."
    elif keep:
        head = f"Probably the right song in {keep} of {n} tries."
    else:
        kinds = {t.get("kind") for t in tries}
        if kinds <= {"cut_off", "broken"}:
            head = "None of these is the whole song."
        elif kinds == {"different_song"}:
            head = "Every try was another song."
        else:
            head = "Nothing here is clearly the right song: listen before you keep one."
    if best_id and keep > 1:
        head += " The best is marked."
    return head + tail


def explain(sidecar: Dict[str, Any], size_bytes: Optional[int] = None) -> Dict[str, Any]:
    """What the list entry carries (``entry["explained"]``)."""
    facts = facts_from(sidecar, size_bytes)
    kind, text = classify(sidecar, size_bytes=size_bytes, facts=facts)
    acoustid = facts.get("acoustid") if isinstance(facts.get("acoustid"), dict) else None
    return {
        "kind": kind,
        "label": LABELS[kind],
        "text": text,
        "length": fmt_len(facts.get("actual_s")),
        "spotify_length": fmt_len(facts.get("expected_s")),
        "expected_s": facts.get("expected_s"),
        "actual_s": facts.get("actual_s"),
        "plays_to_end": facts.get("plays_to_end"),
        "acoustid": ({k: acoustid.get(k) for k in ("decision", "score", "title", "artist",
                                                     "checked_at") if acoustid.get(k) is not None}
                     if acoustid else None),
        "quality": facts.get("quality") or "",
        "quality_rank": quality_rank(facts),
        "check": facts.get("check"),
    }


__all__ = ["DELETE_KINDS", "KEEP_KINDS", "KINDS", "LABELS", "choose_best", "classify", "explain",
           "facts_from", "fmt_len", "quality_rank", "song_summary"]
