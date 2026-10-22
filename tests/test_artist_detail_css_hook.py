"""What a source artist must not be offered, and the stylesheet's dead container.

The React artist page used to wear the `.artist-detail-page` class so that a
block of rules in style.css applied to it -- among them the ones that hide
Artist Radio, Enhance Quality, the enrichment rings and the library view for a
SOURCE artist (one that isn't in the library). Nothing tied the class to the
rules, which is how a source artist once ended up offering Artist Radio and
Enhance Quality: the hiding rules had stopped applying.

The Artist page (webui/src/routes/artist-detail/-ui/artist-page.tsx) no longer
renders that markup or that class: it is styled by its own CSS module, and the
hides are decided in the page itself, so there is no stylesheet pairing left to
keep attached. What still matters is the behaviour, pinned below against the
page's source, and that no rule names the vanilla page's long-gone container.
"""

from __future__ import annotations

import re
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_ARTIST = _ROOT / "webui/src/routes/artist-detail"


def _without_comments(css: str) -> str:
    """A selector named only in prose is not a rule.

    Without this the dead-container check matches from inside a `/* ... */`
    explaining the history straight through to the next rule's `{`, and reports
    a rule that does not exist.
    """
    return re.sub(r"/\*.*?\*/", " ", css, flags=re.S)


_CSS = _without_comments(
    (_ROOT / "webui/static/style.css").read_text(encoding="utf-8", errors="replace")
)
_PAGE = (_ARTIST / "-ui/artist-page.tsx").read_text(encoding="utf-8")
_DIALOGS = (_ARTIST / "-ui/artist-dialogs.tsx").read_text(encoding="utf-8")
_TRACKS = (_ARTIST / "-ui/tracks-tab.tsx").read_text(encoding="utf-8")


def test_a_source_artist_is_not_offered_artist_radio():
    assert re.search(r"!sourceOnly && payload\s*\?\s*\[\{\s*key: 'radio'", _PAGE), (
        "Play artist radio must stay behind the library-artist check: a source artist "
        "has no library tracks to make a radio from"
    )


def test_a_source_artist_is_not_offered_enhance_quality():
    # "Find better copies…" is the old Enhance Quality, and it needs a library id
    assert re.search(r"libraryArtistId && \(libraryTracks \?\? 0\) > 0\s*\?\s*\[\{\s*key: 'better'", _PAGE)


def test_a_source_artist_gets_no_enrichment_rings_or_library_tools():
    assert re.search(r"!sourceOnly \? \(\s*<div[^>]*>\s*<EnrichmentCoverage", _DIALOGS)
    # the library's tag and file tools open only for an admin on a library artist
    assert "if (manage && isAdmin && libraryArtistId)" in _TRACKS


def test_no_rule_still_names_the_deleted_container():
    """`#artist-detail-page` was the vanilla page's div. It is gone.

    A rule naming it matches nothing, and — worse — reads as live styling for
    anyone maintaining this file.
    """
    dead = [
        rule.strip()[:80]
        for rule in re.findall(r"[^}\n][^}]*#artist-detail-page[^{]*\{", _CSS)
    ]
    assert not dead, f"rules still scoped to the deleted container: {dead}"
