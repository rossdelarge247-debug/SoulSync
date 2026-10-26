"""Reading tracklists by code: a pasted tracklist (boards 22h, 22i), a
MixesDB page's wiki text, and the parts of a title matching needs (the
song, its version, its featured artists).

Pasted text is data: it's split into lines and each line is read with
plain string rules, never evaluated, fetched or passed on. What can't be
read as "Artist – Title" comes back with why, so the person can type it or
leave it out.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

#: the most text a paste may hold (a three-hour mix is a few KB)
MAX_PASTE_CHARS = 64 * 1024
#: the most lines read from one paste or one page
MAX_LINES = 500
#: a line longer than this is cut before it's read
MAX_LINE_CHARS = 300

# ── words ─────────────────────────────────────────────────────────────────────

try:  # the library's own folding when it's there (é → e, ø → o)
    from unidecode import unidecode as _unidecode
except Exception:  # noqa: BLE001 - plain accent folding instead
    _unidecode = None


def fold(text: Any) -> str:
    """Lower case, accents folded, punctuation dropped, spaces collapsed:
    the form two spellings of one name are compared in."""
    value = str(text or "")
    if _unidecode is not None:
        value = _unidecode(value)
    else:
        value = "".join(c for c in unicodedata.normalize("NFKD", value) if not unicodedata.combining(c))
    value = value.lower().replace("&", " and ")
    value = re.sub(r"[^\w\s]", " ", value)
    return " ".join(value.split())


_FEAT_WORDS = r"(?:feat\.?|ft\.?|featuring|with)"
_FEAT_TAIL = re.compile(rf"\s+{_FEAT_WORDS}\s+.*$", re.I)
_FEAT_BRACKET = re.compile(rf"\s*[(\[]\s*{_FEAT_WORDS}\s+[^)\]]*[)\]]", re.I)
_BRACKETS = re.compile(r"[(\[]([^)\]]*)[)\]]")
_DASH_TAIL = re.compile(r"\s+[-–—]\s+(.+)$")

#: words that make a bracket or a dash tail a version ("Dub", "Saltmarsh
#: Remix"); the same idea as core/text/title_match's recording markers
_VERSION_WORDS = {
    "remix", "mix", "rmx", "dub", "edit", "version", "rework", "vip", "extended", "radio", "club",
    "instrumental", "acapella", "live", "bootleg", "remaster", "remastered", "reprise", "vocal", "mashup",
}
#: a version that is the plain record: "Original Mix" is the track itself
_PLAIN_VERSIONS = {"original mix", "original", "original version", "album version", "main mix"}


def _tidy_version(text: str) -> str:
    """"saltmarsh rmx" -> "saltmarsh Remix": the abbreviation spelled out."""
    return re.sub(r"\brmx\b", "Remix", text.strip(), flags=re.I)


def split_title(title: Any) -> Dict[str, str]:
    """``{"base", "version", "key", "version_key"}`` for a track title:
    "Night Ferry (Saltmarsh Remix)" -> base "Night Ferry", version
    "Saltmarsh Remix". Featured artists are dropped ("Sand Script (feat.
    Mira)"), "Original Mix" counts as no version, and ``key`` /
    ``version_key`` are the folded forms used for comparing."""
    text = " ".join(str(title or "")[:MAX_LINE_CHARS * 2].split())[:MAX_LINE_CHARS]
    text = _FEAT_BRACKET.sub("", text)
    version = ""
    for inner in _BRACKETS.findall(text):
        words = set(fold(inner).split())
        if words & _VERSION_WORDS:
            version = inner.strip()
    base = _BRACKETS.sub("", text)
    tail = _DASH_TAIL.search(base)
    if tail and set(fold(tail.group(1)).split()) & _VERSION_WORDS:
        version = version or tail.group(1).strip()
        base = base[:tail.start()]
    base = _FEAT_TAIL.sub("", base).strip(" -–—")
    if fold(version) in _PLAIN_VERSIONS:
        version = ""
    version = _tidy_version(version)
    return {"base": base or text, "version": version, "key": fold(base or text),
            "version_key": fold(version)}


_ARTIST_SPLIT = re.compile(rf"\s+(?:{_FEAT_WORDS}|vs\.?|x|and|&)\s+|\s*[,/;&]\s*", re.I)


def artist_keys(artist: Any) -> List[str]:
    """Each credited name, folded: "Okan Dere feat. Mira" -> ["okan dere",
    "mira"]. A leading "The" is dropped."""
    out = []
    for part in _ARTIST_SPLIT.split(str(artist or "")[:MAX_LINE_CHARS]):
        key = fold(part)
        if key.startswith("the "):
            key = key[4:]
        if key and key not in out:
            out.append(key)
    return out


def artists_match(a: Any, b: Any) -> bool:
    """Whether two credits share a name ("Okan Dere feat. Mira" and "Okan
    Dere")."""
    left, right = artist_keys(a), artist_keys(b)
    return bool(left and right and set(left) & set(right))


# ── one line ──────────────────────────────────────────────────────────────────

# "01.", "1)", "# 3:" before a line; never a bare number ("808 State")
_INDEX = re.compile(r"^\s*(?:#\s*)?\d{1,3}\s*[.)]\s*|^\s*#\s*\d{1,3}\s*:?\s+")
# "[00:00]", "(1:02:30)", "[27]" (MixesDB's minutes), or a bare "1:02:30 "
_TIME = re.compile(r"^\s*[\[(]((?:\d{1,2}:)?\d{1,3}:\d{2}|\d{1,3})[\])]\s*|^\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s+")
_SEPARATOR = re.compile(r"\s+(?:-{1,2}|–|—|/{2,3}|~)\s+|\s*[–—]\s*")
_LABEL_TAIL = re.compile(r"\s*\[[^\]]*\]\s*$")
_ID_WORDS = {"id", "?", "??", "???", "unknown", "unknown artist", "unknown title", "tba", "untitled"}
_HEADINGS = re.compile(r"^(?:track\s*list(?:ing)?|tracklist|set\s*list|setlist|tracks)\s*:?\s*$", re.I)


def _clean(text: str) -> str:
    text = "".join(c for c in text if c == "\t" or unicodedata.category(c)[0] != "C")
    return " ".join(text.split())[:MAX_LINE_CHARS]


def _damaged(text: str) -> bool:
    return "�" in text or sum(1 for c in text if unicodedata.category(c) == "So") > 3


def _time_words(raw: str) -> str:
    """"[27]" -> "27:00", "1:02:30" stays: the line's time as shown."""
    raw = raw.strip()
    if ":" not in raw:
        return f"{int(raw):02d}:00" if raw.isdigit() else ""
    return raw


def read_line(raw: Any) -> Optional[Dict[str, Any]]:
    """One line of a tracklist: ``{"kind": "track", "artist", "title",
    "at", "note"}``, ``{"kind": "id", ...}`` for an unidentified track ("ID
    – ID"), ``{"kind": "unread", "why"}``, or None for a blank line.
    ``note`` says what was read differently ("rmx" read as Remix)."""
    text = _clean(str(raw or ""))
    if not text:
        return None
    if _HEADINGS.match(text):
        return None
    at = ""
    rest = text
    for _ in range(2):  # "01. [00:00] Artist - Title" and "[00:00] 01. Artist - Title"
        moved = False
        m = _TIME.match(rest)
        if m and not at:
            at = _time_words(m.group(1) or m.group(2) or "")
            rest = rest[m.end():]
            moved = True
        m = _INDEX.match(rest)
        if m:
            rest = rest[m.end():]
            moved = True
        if not moved:
            break
    rest = rest.strip()
    if not rest:
        return None
    if _damaged(rest):
        return {"kind": "unread", "raw": text, "at": at, "why": "Some letters are damaged"}
    m = _SEPARATOR.search(rest)
    if not m:
        if fold(rest) in _ID_WORDS:
            return {"kind": "id", "artist": "ID", "title": "ID", "at": at, "raw": text, "note": ""}
        why = "A time and a note, no artist or title" if at else "A comment, not a track"
        return {"kind": "unread", "raw": text, "at": at, "why": why}
    artist = rest[:m.start()].strip(" -")
    title = _LABEL_TAIL.sub("", rest[m.end():]).strip(" -")
    if not artist or not title:
        return {"kind": "unread", "raw": text, "at": at, "why": "Only half a line: no artist or no title"}
    if fold(artist) in _ID_WORDS or fold(title) in _ID_WORDS:
        return {"kind": "id", "artist": "ID" if fold(artist) in _ID_WORDS else artist,
                "title": "ID" if fold(title) in _ID_WORDS else title, "at": at, "raw": text, "note": ""}
    note = ""
    tidy = re.sub(r"\brmx\b\.?", "Remix", title, flags=re.I)
    if tidy != title:
        note = '"rmx" read as Remix'
        title = tidy
    if m.group(0).strip() not in ("-", "–", "—", "--", ""):
        note = note or f'Read from "{m.group(0).strip()}"'
    return {"kind": "track", "artist": artist, "title": title, "at": at, "raw": text, "note": note}


def read_paste(text: Any) -> Dict[str, Any]:
    """A pasted tracklist: ``{"lines": [...], "count": n, "cut": bool}``.
    Each line is ``read_line``'s answer with ``n``, its line number in the
    paste. Text over MAX_PASTE_CHARS is refused by the route before this;
    lines past MAX_LINES are left out and ``cut`` says so."""
    value = str(text or "")[:MAX_PASTE_CHARS]
    out: List[Dict[str, Any]] = []
    cut = False
    for number, raw in enumerate(value.splitlines(), start=1):
        line = read_line(raw)
        if line is None:
            continue
        if len(out) >= MAX_LINES:
            cut = True
            break
        line["n"] = number
        out.append(line)
    return {"lines": out, "count": len(out), "cut": cut}


# ── a MixesDB page ────────────────────────────────────────────────────────────

#: a wiki text line longer than this is cut before anything reads it, so no
#: pattern ever runs over a long line (a page is someone else's text)
MAX_WIKI_LINE = 1000
_TEMPLATE = re.compile(r"\{\{[^{}]*\}\}")
_TAGS = re.compile(r"<[^>]{0,200}>")


def _heading(line: str) -> Optional[str]:
    """"== Tracklist ==" -> "Tracklist", by counting the equals signs at
    each end (no pattern: a long run of "=" stays linear)."""
    if not line.startswith("="):
        return None
    lead = len(line) - len(line.lstrip("="))
    trail = len(line) - len(line.rstrip("="))
    if lead == len(line) or lead != trail:
        return None
    return line[lead:len(line) - trail].strip()


def _unlink(text: str) -> str:
    """Wiki links reduced to their words, by scanning, never by a pattern:
    "[[Pale Harbour]]" -> "Pale Harbour", "[[Label:Glass|Glass]]" ->
    "Glass", "[[[Label:Glass|Glass]]]" -> "[Glass]". Linear in the line,
    however many "[[" it holds."""
    out: List[str] = []
    i = 0
    close = -1
    while True:
        a = text.find("[[", i)
        if a < 0:
            break
        if close < a + 2:
            close = text.find("]]", a + 2)
        if close < 0:
            break
        inner = text[a + 2:close]
        label = inner.startswith("[")
        if label:
            inner = inner[1:]
        if "[" in inner:
            # another opener before the close: the link starts later
            out.append(text[i:a + 1])
            i = a + 1
            continue
        words = inner.split("|", 1)[-1]
        out.append(text[i:a])
        out.append(f"[{words}]" if label else words)
        i = close + 2
        if label and text.startswith("]", i):
            i += 1
    out.append(text[i:])
    return "".join(out)


def _unextlink(text: str) -> str:
    """"[https://… Discogs]" -> "Discogs", "[https://…]" -> "": external
    links reduced to their words by scanning (linear)."""
    out: List[str] = []
    i = 0
    while True:
        a = text.find("[", i)
        if a < 0:
            break
        rest = text[a + 1:a + 9].lower()
        if not (rest.startswith("http://") or rest.startswith("https://") or rest.startswith("//")):
            out.append(text[i:a + 1])
            i = a + 1
            continue
        b = text.find("]", a + 1)
        if b < 0:
            break
        inner = text[a + 1:b].split(None, 1)
        out.append(text[i:a])
        out.append(inner[1] if len(inner) > 1 else "")
        i = b + 1
    out.append(text[i:])
    return "".join(out)


def wikitext_lines(wikitext: Any) -> List[str]:
    """The tracklist lines of a MixesDB page's wiki text: the numbered and
    bulleted lines ("# [00] Artist - Title [Label]") under its Tracklist
    heading, links and templates reduced to their words. Every line is cut
    to MAX_WIKI_LINE characters first, and headings and links are read by
    scanning, so a hostile page costs time in proportion to its size."""
    text = str(wikitext or "")[:512 * 1024]
    out: List[str] = []
    in_list = False
    seen_heading = False
    for raw in text.splitlines():
        line = raw[:MAX_WIKI_LINE].strip()
        title = _heading(line)
        if title is not None:
            title = title.lower()
            seen_heading = True
            in_list = "tracklist" in title or "track list" in title
            continue
        if seen_heading and not in_list:
            continue
        if not line or line[0] not in "#*":
            continue
        line = line.lstrip("#*: ").strip()
        for _ in range(3):
            line = _TEMPLATE.sub("", line)
        line = _unlink(line)
        line = _unextlink(line)
        line = _TAGS.sub("", line).replace("'''", "").replace("''", "")
        line = line.strip()
        if line:
            out.append(line)
        if len(out) >= MAX_LINES:
            break
    return out


def page_title_from_link(link: Any, hosts: Tuple[str, ...]) -> Optional[str]:
    """The wiki page a pasted MixesDB link names ("https://www.mixesdb.com/w/
    2019-05-12_-_Saltmarsh_-_Essential_Mix" -> "2019-05-12 - Saltmarsh -
    Essential Mix"), or None when it isn't a link to one of ``hosts``.
    The link itself is never fetched: the title goes to the wiki's API."""
    from urllib.parse import parse_qs, unquote, urlsplit

    value = str(link or "").strip()
    if len(value) > 2000:
        return None
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("http", "https") or host not in hosts:
        return None
    title = ""
    if parts.path.startswith("/w/"):
        title = parts.path[3:]
    elif parts.path.endswith("/index.php"):
        title = (parse_qs(parts.query).get("title") or [""])[0]
    title = unquote(title).replace("_", " ").strip()
    if not title or len(title) > 255 or any(c in title for c in "#<>[]{}|"):
        return None
    return title


__all__ = ["MAX_LINES", "MAX_PASTE_CHARS", "artist_keys", "artists_match", "fold", "page_title_from_link",
           "read_line", "read_paste", "split_title", "wikitext_lines"]
